import { execFile } from 'node:child_process'
import { resolve, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

// An empty directory Atrium owns. Pointing core.hooksPath here is stronger than
// /dev/null: git treats it as a real but hook-free directory.
const EMPTY_HOOKS = mkdtempSync(join(tmpdir(), 'atrium-nohooks-'))

/**
 * Command-line -c beats repo-local config. This is NOT a blocklist of dangerous
 * values — blocklists are never viable here, because git's long-option
 * abbreviation means --upload-p= executes exactly as --upload-pack= does.
 * It is a fixed set of settings that git would otherwise read from an
 * attacker-controlled .git/config AND RUN THROUGH A SHELL. Spec §8.6.
 */
const HARDENING = [
  '--no-pager',
  '-c', 'core.fsmonitor=',
  '-c', `core.hooksPath=${EMPTY_HOOKS}`,
  '-c', 'core.sshCommand=',
  '-c', 'core.askPass=',
  '-c', 'core.editor=false',
  '-c', 'core.pager=cat',
  '-c', 'protocol.ext.allow=never',
  // deliberately NOT '-c diff.external=' — see the comment on
  // DIFF_PRODUCING_SUBCOMMANDS just below for why that looked right and was wrong.
]

/**
 * `diff.external` and `.gitattributes`-driven `diff.<driver>.textconv` are two
 * SEPARATE repo-controlled execution vectors on any diff-producing command.
 * Neither can be closed from HARDENING's global `-c` prefix:
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
 * HARDENING prefix, which is shared by every subcommand `runGit` might run.
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
function childEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/nonexistent',
    LANG: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
}

/**
 * `code` is `number` for a normal git exit (including a nonzero one, e.g.
 * `128`) but can be the STRING `'ENOENT'` (or another errno name) when the
 * child process never started at all — e.g. `git` absent from the hardcoded
 * `PATH`. Node's own `ExecFileException.code` is typed `number | string` for
 * exactly this reason; widened here to match, deliberately. Callers must
 * narrow (e.g. `typeof code === 'number'`) before doing exit-code arithmetic,
 * rather than this file casting the string case away.
 */
export interface GitResult { stdout: string; stderr: string; code: number | string }

/** THE ONLY PATH TO GIT. test/rungit.test.ts greps src/ to enforce that. */
export function runGit(repoPath: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<GitResult> {
  const abs = resolve(repoPath)
  const argv = [...HARDENING, '-C', abs, ...withDiffSafety(args)]

  return new Promise((res) => {
    execFile('git', argv, {
      env: childEnv(),
      timeout: opts.timeoutMs ?? 5000,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      // err.code is already number | string per Node's own ExecFileException
      // type — no cast needed, and none should be added (see GitResult above).
      res({ stdout, stderr, code: err ? (err.code ?? 1) : 0 })
    })
  })
}
