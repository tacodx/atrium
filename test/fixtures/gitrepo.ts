import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const CLEAN_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

/**
 * Every temp directory a builder creates is registered here, and
 * `cleanupFixtures()` DRAINS the list (`splice(0)`), so a later file's call
 * cannot delete a directory created after it. Tests create fixtures inside
 * `beforeAll`/test bodies, never at module top level, so the drain stays
 * ordered. Carry-forward P3's `afterAll` cleanup.
 */
const created: string[] = []
function track(dir: string): string { created.push(dir); return dir }

export function cleanupFixtures(): void {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
}

export function makeRepo(): string {
  const dir = track(mkdtempSync(join(tmpdir(), 'atrium-fix-')))
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: CLEAN_ENV })
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  execFileSync('git', ['-C', dir, 'add', '.'], { env: CLEAN_ENV })
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { env: CLEAN_ENV })
  return dir
}

export type Vector = 'fsmonitor' | 'diffExternal' | 'hooksPath' | 'bareHook' | 'textconv'
export const ALL_VECTORS: readonly Vector[] = ['fsmonitor', 'diffExternal', 'hooksPath', 'bareHook', 'textconv']

/**
 * Plants exactly one named vector into an already-created repo. Factored out
 * of `makeMaliciousRepo` so a single vector can be tested in isolation
 * (`makeSingleVectorRepo`) as well as combined (`makeMaliciousRepo`) — a
 * combined pass/fail can only tell you "at least one vector is blocked," not
 * "all five are." Task-5's fix-round report has the full reasoning.
 */
function plantVector(dir: string, marker: string, script: string, vector: Vector): void {
  switch (vector) {
    case 'fsmonitor':
      // repo-local config git runs THROUGH A SHELL.
      execFileSync('git', ['-C', dir, 'config', 'core.fsmonitor', script], { env: CLEAN_ENV })
      return
    case 'diffExternal':
      // repo-local config git runs THROUGH A SHELL, on `git diff`.
      execFileSync('git', ['-C', dir, 'config', 'diff.external', script], { env: CLEAN_ENV })
      return
    case 'hooksPath': {
      // repo-local hooksPath — NOT blocked by clearing core.fsmonitor.
      const hooks = join(dir, 'evilhooks')
      mkdirSync(hooks, { recursive: true })
      writeFileSync(join(hooks, 'post-index-change'), `#!/bin/sh\ntouch "${marker}"\n`)
      chmodSync(join(hooks, 'post-index-change'), 0o755)
      execFileSync('git', ['-C', dir, 'config', 'core.hooksPath', hooks], { env: CLEAN_ENV })
      return
    }
    case 'bareHook': {
      // a bare hook in the default location, with zero config entries.
      const bare = join(dir, '.git', 'hooks', 'post-index-change')
      writeFileSync(bare, `#!/bin/sh\ntouch "${marker}"\n`)
      chmodSync(bare, 0o755)
      return
    }
    case 'textconv':
      // .gitattributes assigning a textconv driver, defined in repo-local
      // config — a vector SEPARATE from diff.external, reachable on `git
      // diff`/`log`/`show` even when diff.external is fully disabled.
      // Honored straight from the working tree; does not need to be committed.
      writeFileSync(join(dir, '.gitattributes'), 'README.md diff=evildriver\n')
      execFileSync('git', ['-C', dir, 'config', 'diff.evildriver.textconv', script], { env: CLEAN_ENV })
      return
  }
}

/**
 * A genuine uncommitted change to the tracked file `diff`/`log -p`/`show`
 * inspect. Without this, `git diff` against an unmodified working tree
 * produces no output at all, and diff.external/textconv are never invoked —
 * the fixture would "pass" a security check for the wrong reason (this
 * shipped once; see task-5 fix-round report, Important 3).
 */
function makeRealDiff(dir: string): void {
  writeFileSync(join(dir, 'README.md'), '# fixture\nmodified\n')
}

/** Builds a repo with exactly ONE vector planted, for isolated per-vector verification. */
export function makeSingleVectorRepo(vector: Vector): { dir: string; marker: string } {
  const dir = makeRepo()
  const marker = join(dir, 'PWNED')
  const script = join(dir, 'payload.sh')
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`)
  chmodSync(script, 0o755)
  plantVector(dir, marker, script, vector)
  makeRealDiff(dir)
  return { dir, marker }
}

/** Plants all five known execution vectors and returns the marker path. */
export function makeMaliciousRepo(): { dir: string; marker: string } {
  const dir = makeRepo()
  const marker = join(dir, 'PWNED')
  const script = join(dir, 'payload.sh')
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`)
  chmodSync(script, 0o755)
  for (const vector of ALL_VECTORS) plantVector(dir, marker, script, vector)
  makeRealDiff(dir)
  return { dir, marker }
}

export const wasPwned = (marker: string) => existsSync(marker)

// --- Discovery fixture builders (Task 7; Task 8 reuses the conflict builders) ---

const IDENTITY = ['-c', 'user.email=t@t', '-c', 'user.name=t']

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...IDENTITY, ...args], { env: CLEAN_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
}

/** A tracked, empty temp directory — every discovery test's `homeDir`. */
export function makeScanRoot(): string {
  return track(mkdtempSync(join(tmpdir(), 'atrium-scan-')))
}

/**
 * `git init -q -b <branch ?? 'main'>` (with `--bare` when `opts.bare`) at
 * `<root>/<rel>`, then unless `opts.empty` one committed `x.txt`. Not tracked
 * separately: it lives under an already-tracked root.
 */
export function makeRepoIn(root: string, rel: string, opts: { bare?: boolean; empty?: boolean; branch?: string } = {}): string {
  const dir = join(root, rel)
  mkdirSync(dir, { recursive: true })
  const initArgs = ['init', '-q', '-b', opts.branch ?? 'main']
  if (opts.bare) initArgs.push('--bare')
  execFileSync('git', [...initArgs, dir], { env: CLEAN_ENV })
  if (!opts.bare && !opts.empty) {
    writeFileSync(join(dir, 'x.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-qm', 'init')
  }
  return dir
}

export function commitAll(repo: string, message: string): void {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', message)
}

export function writeGitignore(repo: string, lines: string[]): void {
  writeFileSync(join(repo, '.gitignore'), lines.map((l) => l + '\n').join(''))
  commitAll(repo, 'gitignore')
}

/** Works even when `rel` is inside a path the repo's own .gitignore covers. */
export function addWorktree(repo: string, rel: string, opts: { detach?: boolean; branch?: string } = {}): string {
  if (opts.detach) git(repo, 'worktree', 'add', '-q', '--detach', rel, 'HEAD')
  else git(repo, 'worktree', 'add', '-q', rel, '-b', opts.branch ?? 'wt')
  return join(repo, rel)
}

export function addSubmodule(parent: string, child: string, rel: string): string {
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, rel)
  commitAll(parent, 'sub')
  return join(parent, rel)
}

/** The dangling-pointer shape: rev-parse exits 128 ("not a git repository: (null)"). */
export function breakGitPointer(dir: string): void {
  rmSync(join(dir, '.git'), { recursive: true, force: true })
  writeFileSync(join(dir, '.git'), 'gitdir: ../.git/modules/gone\n')
}

/** rev-parse exits 128 ("invalid gitfile format"). */
export function makeZeroByteGitFile(root: string, rel: string): string {
  const dir = join(root, rel)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.git'), '')
  return dir
}

/**
 * `<parent>/<rel>/v.txt` committed in the PARENT (so it is tracked), then a
 * repo initialised inside `<parent>/<rel>`. `ls-files -- <rel>` in the parent
 * returns `<rel>/v.txt`; `ls-files -s -- <rel>` shows mode 100644, not 160000.
 */
export function makeVendoredChild(parent: string, rel: string): string {
  const dir = join(parent, rel)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'v.txt'), 'v\n')
  commitAll(parent, 'vendor')
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: CLEAN_ENV })
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'vendored')
  return dir
}

function conflictBase(repo: string): void {
  writeFileSync(join(repo, 'f.txt'), 'line1\n')
  commitAll(repo, 'base')
  git(repo, 'checkout', '-q', '-b', 'side')
  writeFileSync(join(repo, 'f.txt'), 'side\n')
  commitAll(repo, 'side')
  git(repo, 'checkout', '-q', 'main')
  writeFileSync(join(repo, 'f.txt'), 'main\n')
  commitAll(repo, 'main')
}

/** The three conflicting operations all exit 1; the shape they leave is the point. */
function conflictOp(repo: string, args: string[]): void {
  try {
    git(repo, ...args)
  } catch (e) {
    const status = (e as { status?: unknown }).status
    if (status !== 1) throw e
    return
  }
  throw new Error(`fixture: expected ${args[0]} to conflict`)
}

/** Leaves .git/MERGE_HEAD. */
export function startMergeConflict(repo: string): void {
  conflictBase(repo)
  conflictOp(repo, ['merge', 'side'])
}

/** Leaves .git/CHERRY_PICK_HEAD. */
export function startCherryPickConflict(repo: string): void {
  conflictBase(repo)
  conflictOp(repo, ['cherry-pick', 'side'])
}

/** Leaves .git/rebase-merge/ (head-name refs/heads/main, msgnum 1, end 1). */
export function startRebaseConflict(repo: string): void {
  conflictBase(repo)
  conflictOp(repo, ['rebase', 'side'])
}

/**
 * A tracked directory holding an executable named `git` that sleeps 3 s on
 * ONE subcommand and execs the real binary for everything else. Both
 * absolutes are load-bearing: gitEnvFor builds the child's PATH as
 * dirname(gitBin) — this directory, which contains only the shim — so a bare
 * `sleep` would exit 127 in ~12 ms and the run would never time out. `exec`
 * makes /bin/sh replace itself with the sleeper so execFile's SIGTERM reaches
 * it directly and leaves no orphan. Returns the directory to put on
 * process.env.PATH (resolveGit reads PATH on every call).
 */
export function makeSlowGitShim(realGit: string, slowSubcommand: string, sleepBin = Bun.which('sleep')): string {
  if (!sleepBin) throw new Error('makeSlowGitShim: sleep not found on PATH')
  const dir = track(mkdtempSync(join(tmpdir(), 'atrium-shim-')))
  const shim = join(dir, 'git')
  writeFileSync(shim, `#!/bin/sh\ncase " $* " in *" ${slowSubcommand} "*) exec ${sleepBin} 3 ;; esac\nexec ${realGit} "$@"\n`)
  chmodSync(shim, 0o755)
  return dir
}

// --- Metadata fixture builders (Task 8) -------------------------------------------

/**
 * A conflicting rebase of `<branch>` ONTO main, so `rebase-merge/head-name`
 * (or `rebase-apply/head-name` with the apply backend) is
 * `refs/heads/<branch>` and progress is 1 of 1. T7's `startRebaseConflict`
 * rebases main onto side (head-name main); this one is what Task 8's tests 3
 * and 4 assert against.
 */
export function startBranchRebaseConflict(repo: string, branch: string, backend: 'merge' | 'apply'): void {
  writeFileSync(join(repo, 'f.txt'), 'line1\n')
  commitAll(repo, 'base')
  git(repo, 'checkout', '-q', '-b', branch)
  writeFileSync(join(repo, 'f.txt'), 'branch\n')
  commitAll(repo, 'branch')
  git(repo, 'checkout', '-q', 'main')
  writeFileSync(join(repo, 'f.txt'), 'main\n')
  commitAll(repo, 'main')
  git(repo, 'checkout', '-q', branch)
  conflictOp(repo, backend === 'apply' ? ['rebase', '--apply', 'main'] : ['rebase', '--merge', 'main'])
}

/** `n` untracked files under `<repo>/a/b/` — the `-uall` shape (47 with it, 1 without). */
export function addUntrackedFiles(repo: string, n: number): void {
  const dir = join(repo, 'a', 'b')
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `u${i}.txt`), `${i}\n`)
}

/**
 * A tracked directory holding an executable named `git` whose only content is
 * a shebang naming an interpreter that does not exist. execve fails with
 * ENOENT, Node surfaces `err.code === 'ENOENT'`, and runGit passes it through
 * as the STRING `code` — the non-numeric shape test 9 pins. (An empty PATH
 * directory does not work: resolveGit falls back to /usr/bin/git.)
 */
export function makeEnoentGitShim(): string {
  const dir = track(mkdtempSync(join(tmpdir(), 'atrium-shim-')))
  writeFileSync(join(dir, 'git'), '#!/nonexistent/atrium-no-such-sh\n')
  chmodSync(join(dir, 'git'), 0o755)
  return dir
}

/**
 * The recording wrapper test/rungit.test.ts uses, as a builder: appends one
 * line per invocation (`$*`, the argv space-joined) to `logFile`, then execs
 * the real binary. With `slowSubcommand`, an invocation naming that
 * subcommand is recorded and then replaced by a 3 s sleep instead (the
 * makeSlowGitShim shape), so a test can both time a call out AND count how
 * many times it was attempted. Returns the directory to put on PATH.
 */
export function makeRecordingGitShim(realGit: string, logFile: string, slowSubcommand?: string, sleepBin = Bun.which('sleep')): string {
  const dir = track(mkdtempSync(join(tmpdir(), 'atrium-shim-')))
  const shim = join(dir, 'git')
  let body = `#!/bin/sh\nprintf '%s\\n' "$*" >> ${logFile}\n`
  if (slowSubcommand !== undefined) {
    if (!sleepBin) throw new Error('makeRecordingGitShim: sleep not found on PATH')
    body += `case " $* " in *" ${slowSubcommand} "*) exec ${sleepBin} 3 ;; esac\n`
  }
  body += `exec ${realGit} "$@"\n`
  writeFileSync(shim, body)
  chmodSync(shim, 0o755)
  return dir
}

/** Reads a recording shim's log as one argv array per invocation (empty when the log does not exist). */
export function readShimLog(logFile: string): string[][] {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf8').split('\n').filter((l) => l !== '').map((l) => l.split(' '))
}

/** `git checkout --detach`: status reports `# branch.head (detached)` with no operation in progress. */
export function detachHead(repo: string): void {
  git(repo, 'checkout', '-q', '--detach')
}
