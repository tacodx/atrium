import { test, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { makeRepo, makeMaliciousRepo, makeSingleVectorRepo, wasPwned } from './fixtures/gitrepo'
import { runGit, resolveGit, gitEnvFor, emptyHooksDir } from '../src/core/rungit'

test('a hostile repo cannot execute anything through status, diff, or log — and diff still works', async () => {
  const { dir, marker } = makeMaliciousRepo()

  await runGit(dir, ['status', '--porcelain=v2', '--branch'])
  const { code, stdout } = await runGit(dir, ['diff'])
  // NOT just "diff didn't pwn us" — diff must actually have run and produced
  // the real change. A version of this fixture shipped once where `diff` had
  // nothing to diff, so diff.external/textconv were never invoked at all and
  // this assertion passed for the wrong reason (task-5 fix-round report,
  // Important 3). code 0 + real content proves the vectors were exercised,
  // not skipped.
  expect(code).toBe(0)
  expect(stdout).toContain('modified')
  await runGit(dir, ['log', '-1', '--format=%ct'])

  expect(wasPwned(marker)).toBe(false)
})

test('reads real metadata from a benign repo', async () => {
  const dir = makeRepo()
  const { stdout, code } = await runGit(dir, ['status', '--porcelain=v2', '--branch'])
  expect(code).toBe(0)
  expect(stdout).toContain('# branch.head main')
})

test('a repo path beginning with a dash is not read as a flag', async () => {
  const dir = makeRepo()
  const { code } = await runGit(dir, ['status', '--porcelain=v2'])
  expect(code).toBe(0)   // -C takes an absolute resolved path, never a bare name
})

test('an empty repo is tolerated, not an error state', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'atrium-empty-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } })

  const { code, stderr } = await runGit(dir, ['log', '-1', '--format=%ct'])
  expect(code).not.toBe(0)
  expect(stderr).toContain('does not have any commits yet')   // caller tolerates this
})

/**
 * Per-vector isolation. A combined fixture proves only "at least one vector
 * is blocked" when green — it cannot tell "all five closed" apart from "four
 * closed, one open," because a single surviving vector creates the same
 * marker a fully-open fixture would. Each of these plants exactly ONE vector
 * against a fresh repo and drives the specific git subcommand that vector
 * requires, so each is a measured, independent fact instead of an inference
 * from one shared boolean. (task-5 fix-round report has the full reasoning,
 * including the diff.external regression this exact gap let through once.)
 */
test('vector: core.fsmonitor is blocked on status', async () => {
  const { dir, marker } = makeSingleVectorRepo('fsmonitor')
  const { code } = await runGit(dir, ['status', '--porcelain=v2', '--branch'])
  expect(code).toBe(0)
  expect(wasPwned(marker)).toBe(false)
})

test('vector: diff.external is blocked via --no-ext-diff, and diff still produces real output', async () => {
  const { dir, marker } = makeSingleVectorRepo('diffExternal')
  const { code, stdout } = await runGit(dir, ['diff'])
  expect(code).toBe(0)   // NOT 128 — `-c diff.external=` made this exit 128 on every repo with a real change; that was the bug.
  expect(stdout).toContain('modified')
  expect(wasPwned(marker)).toBe(false)
})

test('vector: .gitattributes textconv driver is blocked via --no-textconv, and diff still produces real output', async () => {
  const { dir, marker } = makeSingleVectorRepo('textconv')
  const { code, stdout } = await runGit(dir, ['diff'])
  expect(code).toBe(0)
  expect(stdout).toContain('modified')
  expect(wasPwned(marker)).toBe(false)
})

test('vector: repo-local core.hooksPath is blocked on status', async () => {
  const { dir, marker } = makeSingleVectorRepo('hooksPath')
  const { code } = await runGit(dir, ['status', '--porcelain=v2', '--branch'])
  expect(code).toBe(0)
  expect(wasPwned(marker)).toBe(false)
})

test('vector: a bare .git/hooks/post-index-change fires with zero config entries, and is blocked', async () => {
  const { dir, marker } = makeSingleVectorRepo('bareHook')
  const { code } = await runGit(dir, ['status', '--porcelain=v2', '--branch'])
  expect(code).toBe(0)
  expect(wasPwned(marker)).toBe(false)
})

// --- What runGit actually hands the binary ---------------------------------
//
// Final review I8 + I9. Both are one-line changes, and both were invisible to
// every prior test because nothing ever looked at the argv or the env runGit
// builds — the suite only ever observed git's OUTPUT. This installs a
// recording wrapper named `git` in a scratch directory, points the ambient
// PATH at it, and reads back exactly what the child was given. It is also the
// off-FHS case in miniature: the wrapper is the only git on PATH and it lives
// nowhere near /usr/bin.

test('runs the git it resolved from PATH, with --no-optional-locks before the subcommand', async () => {
  const realGit = resolveGit()                       // capture before shadowing PATH
  const repo = makeRepo()                            // build the fixture with the real one
  const dir = mkdtempSync(join(tmpdir(), 'atrium-fakegit-'))
  const log = join(dir, 'argv')
  writeFileSync(
    join(dir, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${log}\nprintf 'PATH=%s\\n' "$PATH" >> ${log}\nexec ${realGit} "$@"\n`,
    { mode: 0o755 },
  )

  const saved = process.env.PATH
  process.env.PATH = dir
  try {
    const { code, stdout } = await runGit(repo, ['status', '--porcelain=v2', '--branch'])
    expect(code).toBe(0)
    expect(stdout).toContain('# branch.head main')   // the wrapper really did exec git
  } finally {
    process.env.PATH = saved
  }

  const recorded = readFileSync(log, 'utf8').split('\n')

  // I9: spec §7.1 mandates it, and a caller cannot supply it — args[0] is the
  // subcommand, and post-subcommand it is exit 129 (measured, git 2.55.0).
  expect(recorded).toContain('--no-optional-locks')
  expect(recorded.indexOf('--no-optional-locks')).toBeLessThan(recorded.indexOf('status'))

  // I8: the child's PATH is derived from the binary actually found, not from
  // a hardcoded /usr/bin:/bin that does not exist on NixOS and hides brew,
  // MacPorts and any user-local git.
  expect(recorded).toContain(`PATH=${dir}`)
})

test('gitEnvFor stays a from-scratch allowlist, with PATH derived from the binary', () => {
  const env = gitEnvFor('/nix/store/1a2b3c-git-2.55.0/bin/git')
  expect(env.PATH).toBe('/nix/store/1a2b3c-git-2.55.0/bin')
  expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')    // §8.6: SET, never merely scrubbed
  expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null')
  expect(env.LANG).toBe('C')
  // The allowlist is the control: anything not named above must be absent.
  expect(Object.keys(env).sort()).toEqual(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'HOME', 'LANG', 'PATH'])
})

test('resolveGit searches the PATH it is given, not a fixed FHS location', () => {
  const realGit = resolveGit()
  const dir = mkdtempSync(join(tmpdir(), 'atrium-whichgit-'))
  symlinkSync(realGit, join(dir, 'git'))
  expect(resolveGit(dir)).toBe(join(dir, 'git'))
  expect(dirname(resolveGit(dir))).not.toBe('/usr/bin')
})

// Final review M3: mkdtempSync at module import left one
// /tmp/atrium-nohooks-XXXXXX behind per process start — 74 had accumulated on
// the author's machine — and created one even when git was never called. Two
// real child processes, because "stable across process starts" is not a claim
// a single process can make about itself.
test('the hook-free directory is one stable per-user path, not one per process start', () => {
  const script = join(mkdtempSync(join(tmpdir(), 'atrium-hooksdir-')), 'probe.ts')
  writeFileSync(script, `import { emptyHooksDir } from '${join(process.cwd(), 'src/core/rungit.ts')}'\nconsole.log(emptyHooksDir())\n`)
  const probe = () => {
    const r = Bun.spawnSync([process.execPath, 'run', script])
    return new TextDecoder().decode(r.stdout).trim()
  }

  const first = probe()
  const second = probe()
  expect(first).toBe(second)
  expect(existsSync(first)).toBe(true)
  expect(readdirSync(first)).toEqual([])             // still hook-free
})

test('the hook-free directory is 0700 and owned by us', () => {
  const st = statSync(emptyHooksDir())
  expect(st.mode & 0o022).toBe(0)                    // not group- or other-writable
  if (typeof process.getuid === 'function') expect(st.uid).toBe(process.getuid())
})

/**
 * "No source file calls git outside runGit" — a TRIPWIRE, not a proof. A prior
 * version of this test matched only `execFile.*['"]git['"]` and was defeated
 * by a reviewer using six unremarkable variants: a variable-held binary name,
 * an import alias, `Bun.spawn`, a multi-line call, a template literal, and
 * `spawnSync`. It will never be airtight — static text matching can't chase
 * every rename — but it should catch the ordinary, unthinking ways a future
 * contributor reaches for git without going through `runGit`. Two layers:
 *
 * 1. ANY import of `node:child_process` (or `child_process`) outside
 *    rungit.ts is flagged, regardless of local alias or what's later done
 *    with it — this is what actually defeats "variable-held binary name" and
 *    "import alias": neither evasion changes the import statement itself.
 * 2. ANY `Bun.spawn`/`Bun.spawnSync` call outside rungit.ts is flagged,
 *    regardless of argument shape (array literal, template literal, a
 *    variable, multi-line) — `Bun.spawn` is a global, not an import, so layer
 *    1 can't see it; this layer doesn't need to see the argument at all.
 *
 * Together these do not depend on spotting the literal string "git" at a call
 * site, which is exactly what a variable-held name or an alias defeats.
 *
 * `src/core/actions.ts` (Task 7) is the OTHER deliberate `execFile` call site
 * the design review settled on — the general `exec` action primitive (open an
 * editor, open a terminal) that every provider's non-git actions go through,
 * per its own doc comment: "execFile(cmd, args[]) with NO shell ... NOT
 * sufficient for git ... This is the general rule for every other exec
 * action." A file-level allowlist entry for it was tried first and rejected
 * on review: exempting it from layers 1/2 entirely would leave the ONE file
 * whose whole job is spawning subprocesses completely unscanned for a git
 * call, which is exactly where a future contributor is likeliest to add one
 * without thinking — silently defeating this tripwire's actual purpose.
 *
 * So `actions.ts` gets a narrower, third layer instead of a blanket
 * exemption: layers 1 and 2 don't apply to it (it legitimately imports
 * `child_process`), but it is still scanned for a literal reference to a
 * `git` command or binary — a quoted `'git'`/`"git"`/`` `git` ``, or a quoted
 * path ending in `.../git` (`'/usr/bin/git'` and similar). This is
 * necessarily narrower than layers 1/2 (a variable built from string
 * concatenation, e.g. `'gi' + 't'`, would still slip past it — the same
 * "not a proof" limitation the module doc already accepts for every other
 * evasion this tripwire can't chase), but it is the correct trade-off named
 * by review: a git-specific check on the one file that needs a
 * child_process/Bun.spawn exemption, not a wholesale exemption from the
 * whole tripwire.
 */
const RUNGIT_PATH = join('src', 'core', 'rungit.ts')
const ACTIONS_PATH = join('src', 'core', 'actions.ts')

const CHILD_PROCESS_IMPORT = /\bfrom\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)/
const BUN_SPAWN_CALL = /\bBun\.(?:spawn|spawnSync)\s*\(/
// Backreference to the opening quote so this only matches a quoted string
// whose ENTIRE content is "git" or ends in a path separator then "git" —
// deliberately narrow enough to leave "legit", "digit", ".gitignore", and
// "gitattributes" alone (all real substrings already present in this
// codebase's comments/fixtures) while still catching the bare command name
// and any absolute-path binary name reaching a spawn call.
const GIT_LITERAL = /(['"`])(?:[^'"`]*[\\/])?git\1/i

function scanFile(file: string, content: string): string[] {
  const offenders: string[] = []
  if (file === ACTIONS_PATH) {
    if (GIT_LITERAL.test(content)) offenders.push(`${file}: references git directly`)
    return offenders
  }
  if (CHILD_PROCESS_IMPORT.test(content)) offenders.push(`${file}: imports node:child_process`)
  if (BUN_SPAWN_CALL.test(content)) offenders.push(`${file}: calls Bun.spawn/Bun.spawnSync`)
  return offenders
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else if (entry.endsWith('.ts')) out.push(p)
  }
  return out
}

test('no source file calls git outside runGit (tripwire, not a proof)', () => {
  const offenders: string[] = []
  for (const file of walk('src')) {
    if (file === RUNGIT_PATH) continue
    offenders.push(...scanFile(file, readFileSync(file, 'utf8')))
  }
  expect(offenders).toEqual([])
})

// --- Pinning the actions.ts precision fix (coordinator fix-round-1 finding) ---
//
// The file-level allowlist that used to exempt actions.ts entirely would have
// let a real `execFile('git', ...)` inside actions.ts pass silently. These
// two tests pin the narrower replacement directly against scanFile/GIT_LITERAL
// — no filesystem mutation needed, since scanFile takes content as a string.
// A real-file mutation check (edit actions.ts, run this suite, revert) is
// recorded in task-7-report.md as the equivalent of the reviewer's own
// attack-the-real-artifact methodology; these are the permanent, automated
// pin of the same distinction.

test('actions.ts: its real, legitimate execFile usage does not trip the git-literal check', () => {
  const real = readFileSync(join('src', 'core', 'actions.ts'), 'utf8')
  expect(scanFile(ACTIONS_PATH, real)).toEqual([])
})

test('actions.ts: a synthetic git invocation is caught even though child_process/Bun.spawn are allowed there', () => {
  const real = readFileSync(join('src', 'core', 'actions.ts'), 'utf8')

  const bareCommand = real + `\nexecFile('git', ['status'], () => {})\n`
  expect(scanFile(ACTIONS_PATH, bareCommand)).toEqual([`${ACTIONS_PATH}: references git directly`])

  const binaryPath = real + `\nexecFile('/usr/bin/git', ['status'], () => {})\n`
  expect(scanFile(ACTIONS_PATH, binaryPath)).toEqual([`${ACTIONS_PATH}: references git directly`])

  const templateLiteral = real + '\nexecFile(`git`, [`status`], () => {})\n'
  expect(scanFile(ACTIONS_PATH, templateLiteral)).toEqual([`${ACTIONS_PATH}: references git directly`])

  // Confirms the narrowing didn't just start matching everything: real
  // substrings already present in this codebase must stay clean.
  expect(scanFile(ACTIONS_PATH, real + `\nconst f = '.gitignore'\n`)).toEqual([])
  expect(scanFile(ACTIONS_PATH, real + `\nconst f = 'legit'\n`)).toEqual([])
})
