import { test, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, chmodSync, writeFileSync, symlinkSync } from 'node:fs'
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

// Plan 2 T1. A timed-out runGit reports `code: 1`, which is the SAME value a
// successful-but-negative probe returns — `check-ignore -q` exits 1 on a miss.
// §7.1's classifier reads "not exit 0" as "not ignored", so without a separate
// channel every timed-out probe would classify as ambiguous and drop the repo.
// Both halves are asserted here: the collision is real, and `timedOut` splits it.
test('a timed-out git is reported as timedOut, not as a bare exit 1 indistinguishable from a real miss', async () => {
  const sleepBin = Bun.which('sleep')
  expect(sleepBin).not.toBeNull()          // no vacuous pass if the shim cannot block
  const dir = mkdtempSync(join(tmpdir(), 'atrium-slowgit-'))
  writeFileSync(join(dir, 'git'), `#!/bin/sh\nexec ${sleepBin} 5\n`, { mode: 0o755 })

  const timed = await (async () => {
    const saved = process.env.PATH
    process.env.PATH = dir
    try { return await runGit(tmpdir(), ['status', '--porcelain=v2', '--branch'], { timeoutMs: 250 }) }
    finally { process.env.PATH = saved }
  })()

  expect(timed.code).toBe(1)               // the collision itself: NOT distinguishable on code alone
  expect(timed.timedOut).toBe(true)

  const repo = makeRepo()
  const miss = await runGit(repo, ['check-ignore', '-q', '--', 'not-ignored.txt'])
  expect(miss.code).toBe(1)                // the same code, through the real binary
  expect(miss.timedOut).toBe(false)
})

// Fix round 1, Important 1. The test above constrains `timedOut` only as "true
// on a timeout, false on a plain exit 1" — and EVERY wrong derivation in the
// obvious family agrees with the correct one on exactly those two points:
// `err?.signal != null`, `err?.code === null` and `typeof err?.code !== 'number'`
// all pass it. A crashed child is the case that separates them, because it is
// the one shape with a signal set and `killed` false. T8 builds its per-repo
// backoff on this field, so a derivation that calls a crash a timeout retries a
// process that will die exactly the same way every time. No timing dependency
// here: the shim kills itself immediately (measured ~11ms).
test('a crashed git is NOT a timeout: killed by an external signal, same exit code, timedOut false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atrium-crashgit-'))
  writeFileSync(join(dir, 'git'), '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 })

  const crashed = await (async () => {
    const saved = process.env.PATH
    process.env.PATH = dir
    try { return await runGit(tmpdir(), ['status', '--porcelain=v2', '--branch']) }
    finally { process.env.PATH = saved }
  })()

  // Measured: err.code is null and err.signal is 'SIGKILL', so the `?? 1`
  // fallback reports 1 — the SAME code as a timeout and as a real miss. The
  // whole point of the field is that code cannot tell these three apart.
  expect(crashed.code).toBe(1)
  // `killed` is false here: this process never called kill(), the child did.
  expect(crashed.timedOut).toBe(false)
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

// The other half of moving to a STABLE path: a predictable name is only safe
// while nobody else can have created it. $XDG_RUNTIME_DIR is 0700 and per-user
// so nobody can, but the /tmp fallback is world-writable, and a directory
// another local user pre-created is a directory another local user controls —
// i.e. they choose git's hooksPath, which is the exact vector this points away
// from. These drive the refusal through a REAL child process, because the
// check reads the environment and memoises, so one process cannot exercise
// both outcomes.
function hooksDirUnder(runtimeDir: string): string {
  const script = join(mkdtempSync(join(tmpdir(), 'atrium-probe-')), 'probe.ts')
  writeFileSync(script, `import { emptyHooksDir } from '${join(process.cwd(), 'src/core/rungit.ts')}'\nconsole.log(emptyHooksDir())\n`)
  const r = Bun.spawnSync([process.execPath, 'run', script], { env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir } })
  return new TextDecoder().decode(r.stdout).trim()
}

test('a group- or world-writable hooks directory is refused, not used', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'atrium-hijack-'))
  const hijacked = join(runtimeDir, 'atrium', 'nohooks')
  mkdirSync(hijacked, { recursive: true })
  chmodSync(hijacked, 0o777)                       // what a pre-creating attacker leaves

  const used = hooksDirUnder(runtimeDir)
  expect(used).not.toBe(hijacked)                  // fell back to an unpredictable name
  expect(existsSync(used)).toBe(true)
  expect(statSync(used).mode & 0o022).toBe(0)      // and that one really is ours alone
})

test('a symlink standing in for the hooks directory is refused, not followed', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'atrium-symlink-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'atrium-elsewhere-'))
  mkdirSync(join(runtimeDir, 'atrium'), { recursive: true })
  symlinkSync(elsewhere, join(runtimeDir, 'atrium', 'nohooks'))

  const used = hooksDirUnder(runtimeDir)
  expect(used).not.toBe(join(runtimeDir, 'atrium', 'nohooks'))
  expect(used).not.toBe(elsewhere)
  // Carry-forward P4. Both assertions above pass VACUOUSLY if the probe child
  // fails to start: hooksDirUnder() then returns '', which is neither path.
  // These two make the test fail unless a real, private directory came back.
  expect(existsSync(used)).toBe(true)
  expect(statSync(used).mode & 0o022).toBe(0)
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
 * contributor reaches for git without going through `runGit`. Four layers:
 *
 * 1. ANY import of `node:child_process` (or `child_process`) outside
 *    rungit.ts is flagged, regardless of local alias or what's later done
 *    with it — this is what actually defeats "variable-held binary name" and
 *    "import alias": neither evasion changes the import statement itself.
 * 2. ANY `Bun.spawn`/`Bun.spawnSync` call outside rungit.ts is flagged,
 *    regardless of argument shape (array literal, template literal, a
 *    variable, multi-line) — `Bun.spawn` is a global, not an import, so layer
 *    1 can't see it; this layer doesn't need to see the argument at all.
 * 3. ANY use of `Bun.$`, Bun's shell, in any spelling: the global, a
 *    destructure (`const { $ } = Bun`), or `import { $ } from 'bun'`. Added by
 *    the final whole-branch review, which measured that all four forms passed
 *    every other layer, and `Bun.$` is present in the pinned bun 1.3.11.
 *    Layers 1 and 2 miss it (no import, not spawn) and so does layer 4 (the
 *    backtick content is `git status`, not `git`). The reason this one matters
 *    more than the exotic evasions above: in a Bun codebase Bun.$`git status`
 *    is the IDIOMATIC way to shell out. A tripwire that catches six exotic
 *    evasions and misses the ordinary one has its calibration inverted. This
 *    layer has NO exemption, actions.ts included — that file's own rule is
 *    execFile with no shell, ever.
 * 4. ANY literal reference to a git command or binary — a quoted
 *    `'git'`/`"git"`/`` `git` ``, or a quoted path ending in `.../git`
 *    (`'/usr/bin/git'` and similar) — in EVERY file under src/, not just
 *    actions.ts.
 *
 * Layers 1-3 do not depend on spotting the literal string "git" at a call
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
 * without thinking — silently defeating this tripwire's actual purpose. So it
 * is exempt from layers 1 and 2 ONLY, and layers 3 and 4 still apply to it.
 *
 * WHY LAYER 4 COVERS ALL OF src/ (final review I3): Task 5 built the runGit
 * chokepoint and Task 7 built an unguarded exec path beside it, and neither
 * task's diff contained both halves, so no per-task review could see that a
 * provider writing
 *
 *     { kind: 'exec', id: 'diff', argv: (t) => ({ cmd: 'git', args: [...] }) }
 *
 * in src/providers/git/actions.ts reaches the git binary with NO hardening
 * prefix, NO env allowlist and the full process.env. Scoping the git-literal
 * check to actions.ts by exact path equality meant every OTHER file was
 * checked only by layers 1 and 2, which that declaration passes cleanly.
 * Widening it was measured to be zero-false-positive: applying it to every
 * .ts file under src/ yields exactly one hit, rungit.ts itself, which is
 * skipped. It is necessarily narrower than layers 1-3 (a name built by
 * concatenation still slips past — the same "not a proof" limitation this
 * module already accepts), which is why buildArgv ALSO rejects the git binary
 * at run time, where a name assembled at run time is visible.
 */
const RUNGIT_PATH = join('src', 'core', 'rungit.ts')
const ACTIONS_PATH = join('src', 'core', 'actions.ts')

const CHILD_PROCESS_IMPORT = /\bfrom\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)/
const BUN_SPAWN_CALL = /\bBun\.(?:spawn|spawnSync)\s*\(/
// `Bun.$` as a global, plus `$` pulled out of bun by destructure or by named
// import. Deliberately does NOT flag every `from 'bun'` import — serve.ts
// legitimately imports embeddedFiles from it — only one that names `$`.
const BUN_SHELL = /\bBun\.\$|\{[^}]*\$[^}]*\}\s*(?:from\s+['"]bun['"]|=\s*Bun\b)/
// Backreference to the opening quote so this only matches a quoted string
// whose ENTIRE content is "git" or ends in a path separator then "git" —
// deliberately narrow enough to leave "legit", "digit", ".gitignore", and
// "gitattributes" alone (all real substrings already present in this
// codebase's comments/fixtures) while still catching the bare command name
// and any absolute-path binary name reaching a spawn call.
const GIT_LITERAL = /(['"`])(?:[^'"`]*[\\/])?git\1/i

function scanFile(file: string, content: string): string[] {
  const offenders: string[] = []
  // Layers 3 and 4 apply to every file, actions.ts included.
  if (BUN_SHELL.test(content)) offenders.push(`${file}: uses Bun.$ (a shell)`)
  if (GIT_LITERAL.test(content)) offenders.push(`${file}: references git directly`)
  if (file === ACTIONS_PATH) return offenders
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

// Final review I3. This is the declaration that was invisible: a provider file
// is not actions.ts, so the git-literal layer never ran on it, and it imports
// nothing and calls no spawn, so layers 1 and 2 pass it cleanly. The action
// layer's own runtime guard (buildArgv) is the other half — see
// test/actions.test.ts, "the git chokepoint reaches the action layer".
test('a provider declaring an exec action on the git binary is caught too, not just actions.ts', () => {
  const providerFile = join('src', 'providers', 'repos', 'actions.ts')
  const declaration = `
export const actions = [
  { kind: 'exec', id: 'diff', label: 'Show diff', argv: (t) => ({ cmd: 'git', args: ['-C', t.path, 'diff'] }) },
]
`
  expect(scanFile(providerFile, declaration)).toEqual([`${providerFile}: references git directly`])

  const viaPath = declaration.replace("cmd: 'git'", "cmd: '/usr/bin/git'")
  expect(scanFile(providerFile, viaPath)).toEqual([`${providerFile}: references git directly`])
})

// Final review M1. All four forms passed all three of the previous layers, and
// Bun.$ exists in the pinned 1.3.11 (typeof Bun.$ === 'function').
test('Bun.$, the idiomatic way to shell out in a Bun codebase, is caught in every spelling', () => {
  const file = join('src', 'server', 'routes.ts')
  const forms = [
    'await Bun.$`git status`',
    'await Bun.$`git status`.quiet()',
    "const { $ } = Bun\nawait $`git status`",
    "import { $ } from 'bun'\nawait $`git status`",
  ]
  for (const form of forms) {
    expect(scanFile(file, form)).toContain(`${file}: uses Bun.$ (a shell)`)
  }

  // It is a shell, so it is barred even from actions.ts, whose exemption
  // covers execFile only: "execFile(cmd, args[]) with NO shell".
  expect(scanFile(ACTIONS_PATH, 'await Bun.$`code --wait file`')).toEqual([`${ACTIONS_PATH}: uses Bun.$ (a shell)`])

  // And it must not fire on the ordinary bun imports this codebase really has.
  expect(scanFile(file, "import { embeddedFiles } from 'bun'")).toEqual([])
  expect(scanFile(file, 'const { stdout } = Bun.spawnSync([bin])')).toContain(`${file}: calls Bun.spawn/Bun.spawnSync`)
  expect(scanFile(file, 'const url = `${base}/api/state`')).toEqual([])
})

test('the real src/ tree is clean under all four layers', () => {
  for (const file of walk('src')) {
    if (file === RUNGIT_PATH) continue
    expect(scanFile(file, readFileSync(file, 'utf8'))).toEqual([])
  }
})
