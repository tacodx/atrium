import { test, expect, afterAll } from 'bun:test'
import { realpathSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  cleanupFixtures, makeScanRoot, makeRepoIn, writeGitignore, addWorktree, addSubmodule,
  breakGitPointer, makeZeroByteGitFile, makeVendoredChild, startMergeConflict,
  startCherryPickConflict, startRebaseConflict, makeSlowGitShim, commitAll,
} from './fixtures/gitrepo.ts'
import { resolveGit } from '../src/core/rungit.ts'
import { reposConfigSchema, type ReposConfig } from '../src/providers/repos/config.ts'
import { createReposProvider, repoId, reposToClient, type ReposData } from '../src/providers/repos/index.ts'

// Every test builds its own makeScanRoot() and passes it as deps.homeDir. None
// reads $HOME, and nothing here references the developer's home in any form
// (§10 rule 1). afterAll drains the tracked temp dirs (carry-forward P3).
afterAll(cleanupFixtures)

const ctx = (schedule = 'discovery') => ({ schedule, signal: new AbortController().signal })

async function discover(root: string, cfg: ReposConfig = reposConfigSchema.parse(undefined), deps: { classifyTimeoutMs?: number } = {}): Promise<ReposData> {
  return createReposProvider({ homeDir: root, ...deps }).fetch(cfg, ctx())
}

const names = (xs: Array<{ name: string }>) => xs.map((x) => x.name).sort()
const real = (p: string) => realpathSync(p)

// --- Config -------------------------------------------------------------------------

test('parse(undefined) returns the full default config, not undefined', () => {
  const a = reposConfigSchema.parse(undefined)
  const b = reposConfigSchema.parse(undefined)
  expect(a).toEqual({
    staleDays: 30, extraRoots: [], includeDotPaths: false, treatAsContainer: [],
    // Task 8's five keys at their declared defaults (plan step A0).
    metadataConcurrency: 8,
    metadataTimeoutMs: 5000,
    editor: { cmd: 'code', args: ['--', '${path}'] },
    terminal: { cmd: 'konsole', args: ['--separate', '--workdir', '${path}'] },
    claudeTerminal: { cmd: 'konsole', args: ['--separate', '--workdir', '${path}', '-e', 'claude'] },
  })
  expect(b).toEqual(a)
  expect(a).not.toBe(b)
  expect(a.extraRoots).not.toBe(b.extraRoots)
  expect(a.editor.args).not.toBe(b.editor.args)
})

test('parse rejects an unknown key by name', () => {
  expect(() => reposConfigSchema.parse({ staledays: 10 })).toThrow(/unknown key "staledays"/)
})

test('parse rejects a non-positive or non-numeric staleDays', () => {
  expect(() => reposConfigSchema.parse({ staleDays: 0 })).toThrow(/staleDays/)
  expect(() => reposConfigSchema.parse({ staleDays: '30' })).toThrow(/staleDays/)
})

test('parse rejects a relative path in extraRoots', () => {
  expect(() => reposConfigSchema.parse({ extraRoots: ['relative/path'] })).toThrow(/absolute/)
})

// --- Discovery and the validity gate ---------------------------------------------------

test('a plain repo under the scanned root surfaces as top-level', async () => {
  const root = makeScanRoot()
  const proj = makeRepoIn(root, 'proj')
  const data = await discover(root)
  expect(data.repos).toHaveLength(1)
  const r = data.repos[0]!
  expect(r.origin).toBe('top-level')
  expect(r.bare).toBe(false)
  expect(r.path).toBe(real(proj))
  expect(r.name).toBe('proj')
  expect(r.id).toBe(repoId(real(proj)))
  expect(data.dropped).toEqual([])
  expect(data.errors).toEqual([])
})

test('a 0-byte .git file is dropped as invalid and never reaches the classifier', async () => {
  const root = makeScanRoot()
  const zero = makeZeroByteGitFile(root, 'zero')
  const data = await discover(root)
  expect(data.repos).toEqual([])
  expect(data.dropped).toEqual([{ id: repoId(real(zero)), path: real(zero), name: 'zero', reason: 'invalid' }])
  expect(data.errors).toEqual([])

  // M11's instruction: a root holding ONLY a non-repo directory tree yields
  // nothing at all — no repo, no dropped row, no error. Nothing in it is a
  // candidate, so the gate is never consulted for it.
  const plain = makeScanRoot()
  mkdirSync(join(plain, 'a', 'b', 'c'), { recursive: true })
  const nothing = await discover(plain)
  expect(nothing.repos).toEqual([])
  expect(nothing.dropped).toEqual([])
  expect(nothing.errors).toEqual([])
})

test('a dangling gitdir pointer is dropped as invalid', async () => {
  const root = makeScanRoot()
  const gone = makeRepoIn(root, 'gone')
  breakGitPointer(gone)
  const data = await discover(root)
  expect(data.repos).toEqual([])
  expect(data.dropped).toEqual([{ id: repoId(real(gone)), path: real(gone), name: 'gone', reason: 'invalid' }])
})

// The containment-comparison pin: rev-parse --absolute-git-dir walks UP, so a
// plain subdirectory of a repo exits 0 with the ANCESTOR's gitdir.
test('a plain subdirectory named as an extra root is not surfaced as its own repo', async () => {
  const root = makeScanRoot()
  const proj = makeRepoIn(root, 'proj')
  const src = join(proj, 'src')
  mkdirSync(src)
  const data = await discover(root, reposConfigSchema.parse({ extraRoots: [src] }))
  expect(data.repos.map((r) => r.path)).toEqual([real(proj)])
  expect(data.dropped).toContainEqual({ id: repoId(real(src)), path: real(src), name: 'src', reason: 'invalid' })
})

test('a bare repo is discovered and marked bare', async () => {
  const root = makeScanRoot()
  const mirror = makeRepoIn(root, 'mirror.git', { bare: true })
  const data = await discover(root)
  expect(data.repos.map((r) => [r.path, r.bare])).toEqual([[real(mirror), true]])
  expect(data.dropped).toEqual([])
})

test('an empty repo with no commits surfaces as a normal repo', async () => {
  const root = makeScanRoot()
  const fresh = makeRepoIn(root, 'fresh', { empty: true })
  const data = await discover(root)
  expect(data.repos.map((r) => r.path)).toEqual([real(fresh)])
  expect(data.dropped).toEqual([])
  expect(data.errors).toEqual([])
})

// The walker's symlink rule is one guard doing two jobs (cycle guard and
// $HOME-escape guard), and `repos` alone does not pin it: the MUTATION these
// two tests exist to redden is walkDir's `!entry.isDirectory()` entry filter
// replaced by a statSync-based directory check, which FOLLOWS symlinks. Under
// it the link is walked and becomes a candidate of its own; the gate's
// containment comparison then drops it, so `repos` is unchanged and `dropped`
// is the only channel that moves. Hence the empty-`dropped` assertion here.
test('a symlink to a repo inside the root does not produce a second entry', async () => {
  const root = makeScanRoot()
  const proj = makeRepoIn(root, 'proj')
  symlinkSync(proj, join(root, 'link'))
  const data = await discover(root)
  expect(data.repos).toHaveLength(1)
  expect(data.repos[0]!.path).toBe(real(proj))
  expect(data.dropped).toEqual([])
})

// The escape case the rule actually exists for, and the one the test above
// cannot show: the link's target is OUTSIDE the scanned root entirely — its
// own tracked temp root here, standing in for anything the operator never
// named. Under the same statSync mutation the walker leaves the root, and a
// repository nobody asked about is gated and reported. Nothing at all may
// reach Data from out there: no repo, no dropped row, no error, and not the
// outside path in any field of either shape.
test('a symlink pointing out of the scanned root never reaches Data', async () => {
  const root = makeScanRoot()
  const outsideRoot = makeScanRoot()
  const outside = makeRepoIn(outsideRoot, 'secret')
  symlinkSync(outside, join(root, 'escape'))
  const data = await discover(root)
  expect(data.repos).toEqual([])
  expect(data.dropped).toEqual([])
  expect(data.errors).toEqual([])
  expect(JSON.stringify(data)).not.toContain(real(outside))
  expect(JSON.stringify(reposToClient(data))).not.toContain(real(outside))
})

test('a repo reachable through both the home root and an extra root appears once', async () => {
  const root = makeScanRoot()
  const proj = makeRepoIn(root, 'sub/proj')
  const data = await discover(root, reposConfigSchema.parse({ extraRoots: [join(root, 'sub')] }))
  expect(data.repos.map((r) => r.path)).toEqual([real(proj)])
})

test('a repo under a dot-directory is not discovered by default and is discovered with includeDotPaths', async () => {
  const root = makeScanRoot()
  const cfgRepo = makeRepoIn(root, '.dotfiles/cfg')
  const hidden = await discover(root)
  expect(hidden.repos).toEqual([])
  const shown = await discover(root, reposConfigSchema.parse({ includeDotPaths: true }))
  expect(shown.repos.map((r) => r.path)).toEqual([real(cfgRepo)])
})

test('a missing extra root is reported as root-missing and does not abort the scan', async () => {
  const root = makeScanRoot()
  const proj = makeRepoIn(root, 'proj')
  const data = await discover(root, reposConfigSchema.parse({ extraRoots: ['/nonexistent/atrium-test-root'] }))
  expect(data.errors).toContain('root-missing')
  expect(data.repos.map((r) => r.path)).toEqual([real(proj)])
})

test('mid-rebase, mid-merge and mid-cherry-pick repos all surface as ordinary repos', async () => {
  const root = makeScanRoot()
  startMergeConflict(makeRepoIn(root, 'merging'))
  startCherryPickConflict(makeRepoIn(root, 'picking'))
  startRebaseConflict(makeRepoIn(root, 'rebasing'))
  const data = await discover(root)
  expect(names(data.repos)).toEqual(['merging', 'picking', 'rebasing'])
  expect(data.dropped).toEqual([])
})

// --- The classifier -----------------------------------------------------------------

/** §10's literal container fixture: a repo with tracked files of its own whose
 *  .gitignore lists three child directories, each a repo. */
function containerFixture(root: string): string {
  const parent = makeRepoIn(root, 'parent')
  writeGitignore(parent, ['kid1/', 'kid2/', 'kid3/'])
  for (const k of ['kid1', 'kid2', 'kid3']) makeRepoIn(parent, k)
  return parent
}

test('the container regression fixture surfaces the parent and all three ignored children', async () => {
  const root = makeScanRoot()
  containerFixture(root)
  const data = await discover(root)
  expect(data.repos).toHaveLength(4)
  const byName = Object.fromEntries(data.repos.map((r) => [r.name, r.origin]))
  expect(byName).toEqual({ parent: 'top-level', kid1: 'container-child', kid2: 'container-child', kid3: 'container-child' })
  expect(data.dropped).toEqual([])
})

// The row-order pin: worktrees/feat matches BOTH row 1 (worktree → drop) and
// row 4 (ignored → surface). Row 1 must win.
test('a linked worktree inside an ignored directory is dropped as a worktree, not surfaced as a container child', async () => {
  const root = makeScanRoot()
  const repo = makeRepoIn(root, 'repo')
  writeGitignore(repo, ['worktrees/'])
  const wt = addWorktree(repo, 'worktrees/feat', { branch: 'feat' })
  const data = await discover(root)
  expect(data.repos.map((r) => r.path)).toEqual([real(repo)])
  expect(data.dropped).toEqual([{ id: repoId(real(wt)), path: real(wt), name: 'feat', reason: 'worktree' }])
})

test('a detached linked worktree is dropped as a worktree', async () => {
  const root = makeScanRoot()
  const repo = makeRepoIn(root, 'repo')
  const wt = addWorktree(repo, 'wt', { detach: true })
  const data = await discover(root)
  expect(data.repos.map((r) => r.path)).toEqual([real(repo)])
  expect(data.dropped).toEqual([{ id: repoId(real(wt)), path: real(wt), name: 'wt', reason: 'worktree' }])
})

// The row-2-before-row-3 pin: a submodule is also tracked, so plain ls-files
// is non-empty and row 3 would claim it with the wrong reason.
test('a submodule is dropped with reason submodule, not vendored', async () => {
  const root = makeScanRoot()
  const parent = makeRepoIn(root, 'parent')
  const child = makeRepoIn(root, 'child')
  const sub = addSubmodule(parent, child, 'sub')
  const data = await discover(root)
  expect(names(data.repos)).toEqual(['child', 'parent'])
  expect(data.dropped).toEqual([{ id: repoId(real(sub)), path: real(sub), name: 'sub', reason: 'submodule' }])
})

test('a vendored tracked child is dropped with reason vendored', async () => {
  const root = makeScanRoot()
  const parent = makeRepoIn(root, 'parent')
  const lib = makeVendoredChild(parent, 'vendor/lib')
  const data = await discover(root)
  expect(data.repos.map((r) => r.path)).toEqual([real(parent)])
  expect(data.dropped).toEqual([{ id: repoId(real(lib)), path: real(lib), name: 'lib', reason: 'vendored' }])
})

test('an umbrella with no .gitignore drops its child but reports it as ambiguous', async () => {
  const root = makeScanRoot()
  const umbrella = makeRepoIn(root, 'umbrella')
  const child = makeRepoIn(umbrella, 'child')
  const data = await discover(root)
  expect(data.repos.map((r) => r.path)).toEqual([real(umbrella)])
  expect(data.dropped).toEqual([{ id: repoId(real(child)), path: real(child), name: 'child', reason: 'ambiguous' }])
})

test('treatAsContainer surfaces an otherwise-ambiguous child', async () => {
  const root = makeScanRoot()
  const umbrella = makeRepoIn(root, 'umbrella')
  const child = makeRepoIn(umbrella, 'child')
  const data = await discover(root, reposConfigSchema.parse({ treatAsContainer: [real(umbrella)] }))
  expect(data.repos.map((r) => [r.path, r.origin])).toEqual([[real(umbrella), 'top-level'], [real(child), 'container-child']])
  expect(data.dropped).toEqual([])
})

// §7.1's known classifier limitation, not a bug: an ignored directory that
// holds a clone is indistinguishable from a container's ignored child.
test('a repo gitignoring deps/ that contains a clone surfaces that clone — the documented false positive', async () => {
  const root = makeScanRoot()
  const app = makeRepoIn(root, 'app')
  writeGitignore(app, ['deps/'])
  const clone = makeRepoIn(app, 'deps/clone')
  const data = await discover(root)
  expect(data.repos.map((r) => [r.path, r.origin])).toEqual([[real(app), 'top-level'], [real(clone), 'container-child']])
})

// Rows 2 and 3 hand `rel` to git as a pathspec, and a bare pathspec is a GLOB
// with MAGIC on a leading ':'. Measured on git 2.43.0 and 2.55.0: in a parent
// tracking a plain file a1, `ls-files -- a[1]` prints a1, and `ls-files -- :x`
// looks up x. One pin per row per half (glob, magic): a glob-escape in place
// of :(literal) passes the a[1] pins and fails the :x ones.
function parentTracking(root: string, file: string): string {
  const parent = makeRepoIn(root, 'parent')
  writeFileSync(join(parent, file), 'decoy\n')
  commitAll(parent, 'decoy')
  return parent
}

test('a child in a directory named a[1] is not claimed by a tracked a1 (row 3 is literal)', async () => {
  const root = makeScanRoot()
  const parent = parentTracking(root, 'a1')
  const child = makeRepoIn(parent, 'a[1]')
  const data = await discover(root)
  expect(data.repos.map((r) => r.path)).toEqual([real(parent)])
  expect(data.dropped).toEqual([{ id: repoId(real(child)), path: real(child), name: 'a[1]', reason: 'ambiguous' }])
})

test('a child in a directory named a[1] is not claimed by a submodule at a1 (row 2 is literal)', async () => {
  const root = makeScanRoot()
  const parent = makeRepoIn(root, 'parent')
  const sub = addSubmodule(parent, makeRepoIn(root, 'lib'), 'a1')
  const child = makeRepoIn(parent, 'a[1]')
  const data = await discover(root)
  expect(names(data.repos)).toEqual(['lib', 'parent'])
  expect(data.dropped).toEqual([
    { id: repoId(real(sub)), path: real(sub), name: 'a1', reason: 'submodule' },
    { id: repoId(real(child)), path: real(child), name: 'a[1]', reason: 'ambiguous' },
  ])
})

test('a child in a directory named :x is not claimed by a tracked x (row 3 reads no pathspec magic)', async () => {
  const root = makeScanRoot()
  const parent = parentTracking(root, 'x')
  const child = makeRepoIn(parent, ':x')
  const data = await discover(root)
  expect(data.repos.map((r) => r.path)).toEqual([real(parent)])
  expect(data.dropped).toEqual([{ id: repoId(real(child)), path: real(child), name: ':x', reason: 'ambiguous' }])
})

test('a child in a directory named :x is not claimed by a submodule at x (row 2 reads no pathspec magic)', async () => {
  const root = makeScanRoot()
  const parent = makeRepoIn(root, 'parent')
  const sub = addSubmodule(parent, makeRepoIn(root, 'lib'), 'x')
  const child = makeRepoIn(parent, ':x')
  const data = await discover(root)
  expect(names(data.repos)).toEqual(['lib', 'parent'])
  expect(data.dropped).toEqual([
    { id: repoId(real(child)), path: real(child), name: ':x', reason: 'ambiguous' },
    { id: repoId(real(sub)), path: real(sub), name: 'x', reason: 'submodule' },
  ])
})

// Row 4. check-ignore refuses :(literal) outright (exit 128), so it takes the
// other route: --no-index (a tracked a1 no longer answers for a[1]) and a './'
// prefix (a leading ':' is no longer magic). One pin per half.
test('an ignored child named a[1] surfaces as a container child even though the parent tracks a1', async () => {
  const root = makeScanRoot()
  const parent = parentTracking(root, 'a1')
  writeGitignore(parent, ['/a\\[1\\]/'])
  const child = makeRepoIn(parent, 'a[1]')
  const data = await discover(root)
  expect(data.repos.map((r) => [r.path, r.origin])).toEqual([[real(parent), 'top-level'], [real(child), 'container-child']])
  expect(data.dropped).toEqual([])
})

test('an ignored child named :x surfaces as a container child, not checked as x', async () => {
  const root = makeScanRoot()
  const parent = makeRepoIn(root, 'parent')
  writeGitignore(parent, ['/:x/'])
  const child = makeRepoIn(parent, ':x')
  const data = await discover(root)
  expect(data.repos.map((r) => [r.path, r.origin])).toEqual([[real(parent), 'top-level'], [real(child), 'container-child']])
  expect(data.dropped).toEqual([])
})

// The rows-2-and-3-before-row-4 pins. With --no-index, row 4 no longer asks
// the index, so a tracked child under an ignored directory is "ignored" to it:
// hoisting row 4 above rows 2-3 would surface both of these as container
// children. At HEAD before --no-index the order did not matter.
test('a vendored child under an ignored vendor/ is still dropped as vendored', async () => {
  const root = makeScanRoot()
  const parent = makeRepoIn(root, 'parent')
  const lib = makeVendoredChild(parent, 'vendor/lib')
  writeGitignore(parent, ['vendor/'])
  const data = await discover(root)
  expect(data.repos.map((r) => r.path)).toEqual([real(parent)])
  expect(data.dropped).toEqual([{ id: repoId(real(lib)), path: real(lib), name: 'lib', reason: 'vendored' }])
})

test('a submodule under an ignored mods/ is still dropped as submodule', async () => {
  const root = makeScanRoot()
  const parent = makeRepoIn(root, 'parent')
  const sub = addSubmodule(parent, makeRepoIn(root, 'lib'), 'mods/sub')
  writeGitignore(parent, ['mods/'])
  const data = await discover(root)
  expect(names(data.repos)).toEqual(['lib', 'parent'])
  expect(data.dropped).toEqual([{ id: repoId(real(sub)), path: real(sub), name: 'sub', reason: 'submodule' }])
})

// Closing the space the pre-flight measured (P1), design rule 2: every name
// that misclassified under the bare pathspec AND can exist as a directory,
// each beside the decoy its bare form matches. `:/x` is left out: it needs a
// directory named `:`, and `:x` already pins a leading colon. The four named
// pins above stay; these tables add every other name, one test per row, so a
// hand-rolled escape that covers some metacharacters and not others goes red
// on the names it misses. Measured bare matches (git 2.43.0 and 2.55.0):
//   a[1] -> a1, * -> every entry, ?x -> ax, a\b -> ab (a glob escape),
//   :x -> x, :!x -> every entry but x, :(top)x -> x.
// For `*` and `:!x` the row-2 decoy is a submodule at `+s`, which sorts before
// .gitmodules and x.txt, because row 2 reads only the FIRST ls-files -s line.
const PATHSPEC_NAMES: ReadonlyArray<{ name: string; tracked: string; submodule: string }> = [
  { name: 'a[1]', tracked: 'a1', submodule: 'a1' },
  { name: '*', tracked: 'y', submodule: '+s' },
  { name: '?x', tracked: 'ax', submodule: 'ax' },
  { name: 'a\\b', tracked: 'ab', submodule: 'ab' },
  { name: ':x', tracked: 'x', submodule: 'x' },
  { name: ':!x', tracked: 'y', submodule: '+s' },
  { name: ':(top)x', tracked: 'x', submodule: 'x' },
]

test('the pathspec tables cover every measured directory name, exactly', () => {
  expect(PATHSPEC_NAMES.map((n) => n.name)).toEqual(['a[1]', '*', '?x', 'a\\b', ':x', ':!x', ':(top)x'])
})

// realpath of the PARENT only: bun 1.3.11's realpathSync throws ENOENT on an
// existing directory whose name holds a backslash (measured), so `a\b` is
// joined onto its parent's real path rather than resolved itself.
const childPath = (parent: string, child: string) => join(real(parent), basename(child))

/** How discovery settled `path`: a drop reason, or the surfaced origin. */
function verdict(data: ReposData, path: string): string {
  const d = data.dropped.find((x) => x.path === path)
  const r = data.repos.find((x) => x.path === path)
  return d !== undefined ? d.reason : r !== undefined ? r.origin : '<not found>'
}

test('row 3 is literal for every measured name: a tracked decoy never claims the child', async () => {
  const root = makeScanRoot()
  const got: Record<string, string> = {}
  const children: Array<[string, string]> = []
  PATHSPEC_NAMES.forEach(({ name, tracked }, i) => {
    const parent = makeRepoIn(root, `p${i}`)
    writeFileSync(join(parent, tracked), 'decoy\n')
    commitAll(parent, 'decoy')
    children.push([name, childPath(parent, makeRepoIn(parent, name))])
  })
  const data = await discover(root)
  for (const [name, child] of children) got[name] = verdict(data, child)
  expect(got).toEqual(Object.fromEntries(PATHSPEC_NAMES.map((n) => [n.name, 'ambiguous'])))
})

test('row 2 is literal for every measured name: a submodule decoy never claims the child', async () => {
  const root = makeScanRoot()
  const got: Record<string, string> = {}
  const decoys: Record<string, string> = {}
  const children: Array<[string, string, string]> = []
  PATHSPEC_NAMES.forEach(({ name, submodule }, i) => {
    const parent = makeRepoIn(root, `p${i}`)
    const sub = addSubmodule(parent, makeRepoIn(root, `lib${i}`), submodule)
    children.push([name, childPath(parent, makeRepoIn(parent, name)), real(sub)])
  })
  const data = await discover(root)
  for (const [name, child, sub] of children) {
    got[name] = verdict(data, child)
    decoys[name] = verdict(data, sub)
  }
  // Positive control: every decoy really is a submodule to the classifier.
  expect(decoys).toEqual(Object.fromEntries(PATHSPEC_NAMES.map((n) => [n.name, 'submodule'])))
  expect(got).toEqual(Object.fromEntries(PATHSPEC_NAMES.map((n) => [n.name, 'ambiguous'])))
})

// Row 4: the child is ignored by an escaped, anchored rule, and the parent
// tracks the decoy the bare name matches, so a check-ignore that consults the
// index as a glob, or reads a leading ':' as magic, answers "not ignored".
const gitignoreLiteral = (name: string) => `/${name.replace(/[\\[\]*?]/g, '\\$&')}/`

test('row 4 is literal for every measured name: an ignored child surfaces as a container child', async () => {
  const root = makeScanRoot()
  const got: Record<string, string> = {}
  const children: Array<[string, string]> = []
  PATHSPEC_NAMES.forEach(({ name, tracked }, i) => {
    const parent = makeRepoIn(root, `p${i}`)
    writeFileSync(join(parent, tracked), 'decoy\n')
    commitAll(parent, 'decoy')
    writeGitignore(parent, [gitignoreLiteral(name)])
    children.push([name, childPath(parent, makeRepoIn(parent, name))])
  })
  const data = await discover(root)
  for (const [name, child] of children) got[name] = verdict(data, child)
  expect(got).toEqual(Object.fromEntries(PATHSPEC_NAMES.map((n) => [n.name, 'container-child'])))
})

test('a candidate whose classification git call times out is reported as timed-out, never as ambiguous', async () => {
  const root = makeScanRoot()
  containerFixture(root)
  const savedPath = process.env.PATH
  try {
    // Captured BEFORE PATH changes, so the shim execs the real binary.
    process.env.PATH = makeSlowGitShim(resolveGit(), 'check-ignore')
    const data = await discover(root, undefined, { classifyTimeoutMs: 300 })
    // Positive guard first: a shim that fails to block produces zero timeouts,
    // and the "no ambiguous" half below would then pass for the wrong reason.
    expect(data.dropped.some((d) => d.reason === 'timed-out')).toBe(true)
    const kids = data.dropped.filter((d) => /^kid[123]$/.test(d.name))
    expect(names(kids)).toEqual(['kid1', 'kid2', 'kid3'])
    for (const k of kids) expect(k.reason).toBe('timed-out')
    expect(data.dropped.some((d) => d.reason === 'ambiguous')).toBe(false)
    expect(names(data.repos)).toEqual(['parent'])
  } finally {
    process.env.PATH = savedPath
  }
})

// The second shim test, and the other half of the root-probe rule: a probe
// root that exits non-zero is already skipped silently, but one whose
// rev-parse TIMES OUT used to land in `dropped`, whose rows carry
// basename(path) — for the home root, the operator's username. It belongs on
// the closed-set error channel instead. The root is EMPTY, so the probe is the
// only gate call in the pass and nothing else can supply the error code.
test('a probe root whose rev-parse times out is reported on the closed set, never named in dropped', async () => {
  const root = makeScanRoot()
  const savedPath = process.env.PATH
  try {
    process.env.PATH = makeSlowGitShim(resolveGit(), 'rev-parse')
    const data = await discover(root, undefined, { classifyTimeoutMs: 200 })
    expect(data.dropped).toEqual([])
    expect(data.errors).toContain('candidate-error')
    expect(data.repos).toEqual([])
    expect(JSON.stringify(reposToClient(data))).not.toContain(basename(root))
  } finally {
    process.env.PATH = savedPath
  }
})

// --- Shape and wire contract ------------------------------------------------------------

// The stand-in pin for per-schedule keying of the scheduler's `last` map.
test('the metadata schedule returns the full repo list, not a fragment', async () => {
  const root = makeScanRoot()
  makeRepoIn(root, 'proj')
  const p = createReposProvider({ homeDir: root })
  const cfg = reposConfigSchema.parse(undefined)
  const first = await p.fetch(cfg, ctx('discovery'))
  const second = await p.fetch(cfg, ctx('metadata'))
  expect(first.repos).toHaveLength(1)
  expect(second.repos).toEqual(first.repos)
})

test('an unknown schedule name returns the current merged data instead of throwing', async () => {
  const root = makeScanRoot()
  makeRepoIn(root, 'proj')
  const p = createReposProvider({ homeDir: root })
  const cfg = reposConfigSchema.parse(undefined)
  const first = await p.fetch(cfg, ctx('discovery'))
  const odd = await p.fetch(cfg, ctx('nonsense'))
  expect(odd.repos).toEqual(first.repos)
})

test('two provider instances do not share a repo table', async () => {
  const rootA = makeScanRoot()
  const rootB = makeScanRoot()
  const a = makeRepoIn(rootA, 'alpha')
  const b = makeRepoIn(rootB, 'beta')
  const dataA = await discover(rootA)
  const dataB = await discover(rootB)
  // `path` is the realpath-resolved absolute path: the key of the closure
  // table, and the exact string Task 8's resolveTarget compares against.
  expect(dataA.repos.map((r) => r.path)).toEqual([real(a)])
  expect(dataB.repos.map((r) => r.path)).toEqual([real(b)])
})

test('staleDays reaches Data so the pane needs no second config channel', async () => {
  const root = makeScanRoot()
  const data = await discover(root, reposConfigSchema.parse({ staleDays: 7 }))
  expect(data.staleDays).toBe(7)
})

// The asymmetry is deliberate: a surfaced repo's path IS on the wire (it is
// the action target Task 8 validates against the discovered table); a dropped
// candidate's is NOT, because nothing can act on it. gitDir never crosses.
test('reposToClient emits no gitDir and no dropped-candidate path', async () => {
  const root = makeScanRoot()
  const proj = makeRepoIn(root, 'proj')
  const zero = makeZeroByteGitFile(root, 'zero')
  const p = createReposProvider({ homeDir: root })
  const cfg = reposConfigSchema.parse(undefined)
  await p.fetch(cfg, ctx('discovery'))
  const data = await p.fetch(cfg, ctx('metadata'))
  expect(data.repos).toHaveLength(1)
  expect(data.dropped).toHaveLength(1)
  const wire = reposToClient(data)
  expect(wire.repos).toHaveLength(1)
  for (const r of wire.repos) {
    expect(typeof r.path).toBe('string')
    expect(typeof r.name).toBe('string')
    expect(typeof r.id).toBe('string')
    // Task 8 (A0): the metadata fields are on the wire for a readable repo —
    // metaStatus from the closed set, and branch/uncommittedCount when ok.
    expect(['ok', 'stale', 'unavailable']).toContain(r.metaStatus)
    expect(r.metaStatus).toBe('ok')
    expect(r.branch).toBe('main')
    expect(r.uncommittedCount).toBe(0)
  }
  expect(wire.repos[0]!.path).toBe(real(proj))
  expect(wire.dropped).toEqual([{ id: repoId(real(zero)), name: 'zero', reason: 'invalid' }])
  const json = JSON.stringify(wire)
  expect(json).not.toContain('gitDir')
  expect(json).not.toContain(real(zero))
})

test('every error code is a member of the closed set', async () => {
  const root = makeScanRoot()
  makeRepoIn(root, 'proj')
  const data = await discover(root, reposConfigSchema.parse({ extraRoots: ['/nonexistent/atrium-test-root'] }))
  expect(data.errors.length).toBeGreaterThan(0)
  for (const e of data.errors) {
    expect(['root-missing', 'root-unreadable', 'candidate-error']).toContain(e)
    expect(e).not.toContain('/')
  }
})
