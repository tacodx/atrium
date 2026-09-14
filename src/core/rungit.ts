import { execFile } from 'node:child_process'
import { resolve, join, dirname } from 'node:path'
import { mkdirSync, mkdtempSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'

/**
 * An empty directory Atrium owns. Pointing core.hooksPath here is stronger
 * than /dev/null: git treats it as a real but hook-free directory.
 *
 * Created LAZILY, at a STABLE per-user path. The first version called
 * mkdtempSync at module import, which meant one /tmp/atrium-nohooks-XXXXXX per
 * process start whether or not git was ever run — 74 of them had accumulated
 * on the author's machine from test runs alone by the final review. mkdirSync
 * is idempotent, so calling this per invocation also self-heals the directory
 * if systemd-tmpfiles removes it under a long-running user service.
 *
 * $XDG_RUNTIME_DIR is preferred because it is already 0700 and per-user, so a
 * predictable name inside it cannot be pre-created by anyone else. A stable
 * name directly under a world-writable /tmp can be, which would hand another
 * local user the hooks directory git is pointed at — the very vector this
 * exists to close — so the /tmp form is uid-suffixed AND verified (owned by
 * us, not group/other-writable, not a symlink), reverting to an unpredictable
 * mkdtemp name if that verification does not hold.
 */
let hooksDir: string | undefined

function stableHooksDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, 'atrium', 'nohooks')
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown'
  return join(tmpdir(), `atrium-nohooks-${uid}`)
}

export function emptyHooksDir(): string {
  const candidate = hooksDir ?? stableHooksDir()
  try {
    mkdirSync(candidate, { recursive: true, mode: 0o700 })
    // mkdirSync's `mode` applies only when it actually creates the directory,
    // so an already-existing one keeps whatever mode and owner it had. Check.
    const st = lstatSync(candidate)
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    const ours = st.isDirectory() && (uid === undefined || st.uid === uid) && (st.mode & 0o022) === 0
    if (!ours) throw new Error(`refusing to use a hooks directory we do not exclusively own: ${candidate}`)
    hooksDir = candidate
  } catch {
    hooksDir = mkdtempSync(join(tmpdir(), 'atrium-nohooks-'))
  }
  return hooksDir
}

/**
 * The git binary, resolved from the AMBIENT PATH — never assumed to sit at a
 * fixed location. The child's own env is a from-scratch allowlist (see
 * gitEnvFor), and that allowlist used to hardcode PATH=/usr/bin:/bin: on NixOS
 * /usr/bin does not exist, so every git call returned code 'ENOENT', and
 * Homebrew, MacPorts and any user-local git were invisible. For a project that
 * will be open-sourced, nothing may be hardcoded to one machine's layout.
 *
 * Resolved per call rather than once at import: it is a handful of stat calls
 * against the cost of spawning git, it keeps this module free of import-time
 * side effects, and it is what lets the test suite point runGit at a recording
 * wrapper by setting PATH — which is how the argv this file builds is asserted
 * at all.
 */
const FHS_GIT = '/usr/bin/git'

export function resolveGit(searchPath: string | undefined = process.env.PATH): string {
  // Last resort only when the binary is not on PATH at all: an absolute path
  // that is about to fail with a real, inspectable ENOENT rather than a bare
  // name resolved against an env we deliberately do not carry.
  return Bun.which('git', searchPath === undefined ? undefined : { PATH: searchPath }) ?? FHS_GIT
}

/**
 * Command-line -c beats repo-local config. This is NOT a blocklist of dangerous
 * values — blocklists are never viable here, because git's long-option
 * abbreviation means --upload-p= executes exactly as --upload-pack= does.
 * It is a fixed set of settings that git would otherwise read from an
 * attacker-controlled .git/config AND RUN THROUGH A SHELL. Spec §8.6.
 */
function hardening(): string[] {
  return [
    '--no-pager',
    // Spec §7.1 mandates this on the git provider's very first metadata call.
    // It is a PRE-subcommand global option: `git -C <repo> status
    // --no-optional-locks` exits 129, "unknown option" (measured, git 2.55.0),
    // and runGit's contract makes args[0] the subcommand — so there is no
    // position a CALLER could put it in. It belongs here or nowhere. Valid
    // globally for every subcommand the provider needs (status, log, diff,
    // rev-parse, check-ignore, ls-files all exit 0 with it) and composes with
    // the -c prefix below; re-measured with the full prefix before adding it.
    '--no-optional-locks',
    '-c', 'core.fsmonitor=',
    '-c', `core.hooksPath=${emptyHooksDir()}`,
    '-c', 'core.sshCommand=',
    '-c', 'core.askPass=',
    '-c', 'core.editor=false',
    '-c', 'core.pager=cat',
    '-c', 'protocol.ext.allow=never',
    // deliberately NOT '-c diff.external=' — see the comment on
    // DIFF_PRODUCING_SUBCOMMANDS just below for why that looked right and was wrong.
  ]
}

/**
 * `diff.external` and `.gitattributes`-driven `diff.<driver>.textconv` are two
 * SEPARATE repo-controlled execution vectors on any diff-producing command.
 * Neither can be closed from hardening()'s global `-c` prefix:
 *
 * - `-c diff.external=` (this file's first shipped attempt) does not disable
 *   external diff — it makes git treat external diff as CONFIGURED to the
 *   empty program, which fails to exec and makes `git diff` exit 128
 *   ("external diff died") on every repository with a real change, hostile or
 *   benign. Confirmed empirically; this was a real, shipped bug (task-5 fix
 *   round 2). It is not "fixed but strict" — it is broken.
 * - Simply deleting that `-c` reopens `diff.external` AND leaves `textconv`
 *   open too, since textconv was never addressed by it at all.
 *
 * The actual fix is `--no-ext-diff --no-textconv`, and those flags are
 * SUBCOMMAND-scoped, not global: they are valid only immediately after a
 * diff-producing subcommand. `git status --no-ext-diff` exits 129 ("unknown
 * option"), confirmed empirically — so they cannot go in the `-c`-based
 * hardening() prefix, which is shared by every subcommand `runGit` might run.
 * Kept deliberately small and explicit rather than trying to enumerate every
 * git subcommand that can produce a diff.
 */
const DIFF_PRODUCING_SUBCOMMANDS = new Set(['diff', 'log', 'show', 'format-patch'])

/** Inserts the diff-safety flags right after args[0] when it names one of the
 * subcommands above; otherwise returns args unchanged (most subcommands, e.g.
 * `status`, reject these flags outright). */
function withDiffSafety(args: string[]): string[] {
  const [subcommand, ...rest] = args
  if (!subcommand || !DIFF_PRODUCING_SUBCOMMANDS.has(subcommand)) return args
  return [subcommand, '--no-ext-diff', '--no-textconv', ...rest]
}

/**
 * This prefix deliberately does NOT include a `--` before the caller's `args`.
 * The correct position for `--` is `git <subcommand> [options] -- <pathspecs>`,
 * and `args[0]` here is the subcommand itself — `runGit` has no way to know
 * where that subcommand's own options end and its pathspecs begin. Inserting
 * `--` unconditionally between `-C <abs>` and `args` would produce
 * `git -C /path -- status`, which is simply invalid.
 *
 * That knowledge belongs to the caller, which is the only code that knows its
 * own argument shape. Consequence, stated plainly: any caller forwarding a
 * repository-controlled value (a branch name, a file path from a listing,
 * anything not typed by the operator) as a positional argument MUST supply its
 * own `--` before it inside `args` (e.g. `runGit(dir, ['log', '--',
 * untrustedPath])`). Without it, a value beginning with a dash is read as a
 * flag by git, not as the pathspec it looks like — the same class of injection
 * this hardening prefix exists to close off, just one layer up, in the
 * caller's own argv construction.
 */

/**
 * The child env is an ALLOWLIST built from scratch, and it explicitly SETS
 * GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM. A blanket "scrub all GIT_*" would
 * delete the two variables that make the security tests honest — this machine's
 * ~/.gitconfig redirects core.hooksPath, which would silently make the hook
 * test pass here while every other user stayed exploitable. Spec §8.6, §10.
 */
export function gitEnvFor(gitBin: string): NodeJS.ProcessEnv {
  return {
    // Derived from the binary we actually resolved, not from an assumed FHS
    // layout and not from the ambient PATH: still a one-directory allowlist,
    // but one that exists on whatever machine this is.
    PATH: dirname(gitBin),
    HOME: process.env.HOME ?? '/nonexistent',
    LANG: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
}

/**
 * `code` is `number` for a normal git exit (including a nonzero one, e.g.
 * `128`) but can be the STRING `'ENOENT'` (or another errno name) when the
 * child process never started at all — e.g. no git binary anywhere on the
 * ambient PATH, so resolveGit() fell back to a path that does not exist. Node's own `ExecFileException.code` is typed `number | string` for
 * exactly this reason; widened here to match, deliberately. Callers must
 * narrow (e.g. `typeof code === 'number'`) before doing exit-code arithmetic,
 * rather than this file casting the string case away.
 *
 * `timedOut` exists because `code` alone cannot tell a timeout from a real
 * failure. Measured on bun 1.3.11: when execFile's timeout option fires, the
 * error it hands back carries `code === null`, `killed === true` and
 * `signal === 'SIGTERM'`, so the `err.code ?? 1` fallback below reports
 * `code: 1` — indistinguishable from a child that genuinely exited 1. That
 * collision is load-bearing for the repo classifier in spec §7.1, whose
 * container row surfaces a child only when a check-ignore -q probe exits 0,
 * and whose ordinary miss is exit 1: with no separate channel a timed-out
 * probe reads as "not ignored", falls through to the ambiguous row, and the
 * repo is silently dropped from the dashboard instead of being retried.
 *
 * The derivation reads `killed`, NOT `signal`. `killed` is true only when this
 * process called kill(), and the timeout option below is the only thing here
 * that does. A child killed by an EXTERNAL signal — the OOM killer, a SIGSEGV
 * — reports `killed: false` with `signal` set (measured: a self-SIGKILL gives
 * `code: null`, `killed: false`, `signal: SIGKILL`), and that is a crash, not
 * a timeout; deriving from `signal` instead would mislabel it. TRIPWIRE: if an
 * AbortSignal is ever added to the execFile options below, `killed` becomes
 * true on abort as well, and this derivation must be revisited.
 */
export interface GitResult { stdout: string; stderr: string; code: number | string; timedOut: boolean }

/** THE ONLY PATH TO GIT. test/rungit.test.ts greps src/ to enforce that. */
export function runGit(repoPath: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<GitResult> {
  const abs = resolve(repoPath)
  const gitBin = resolveGit()
  const argv = [...hardening(), '-C', abs, ...withDiffSafety(args)]

  return new Promise((res) => {
    execFile(gitBin, argv, {
      env: gitEnvFor(gitBin),
      timeout: opts.timeoutMs ?? 5000,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      // err.code is already number | string per Node's own ExecFileException
      // type — no cast needed, and none should be added (see GitResult above).
      res({ stdout, stderr, code: err ? (err.code ?? 1) : 0, timedOut: err?.killed === true })
    })
  })
}
