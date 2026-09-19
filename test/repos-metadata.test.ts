import { test, expect, afterAll } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanupFixtures, makeScanRoot, makeRepoIn, makeZeroByteGitFile, startMergeConflict,
  startCherryPickConflict, startBranchRebaseConflict, addUntrackedFiles, makeEnoentGitShim,
  makeRecordingGitShim, readShimLog,
} from './fixtures/gitrepo.ts'
import { resolveGit, runGit } from '../src/core/rungit.ts'
import { reposConfigSchema, type ReposConfig } from '../src/providers/repos/config.ts'
import { createReposProvider, reposToClient, type ReposData, type RepoEntry } from '../src/providers/repos/index.ts'

// Every test builds its own makeScanRoot() and passes it as deps.homeDir; none
// reads $HOME (§10 rule 1). Every fixture git call runs under CLEAN_ENV (§10
// rule 2). Tests that shim process.env.PATH restore it in a finally, and
// capture resolveGit() BEFORE shadowing PATH so the shim execs the real
// binary. afterAll drains the tracked temp dirs (carry-forward P3).
afterAll(cleanupFixtures)

const ctx = (schedule: string, signal: AbortSignal = new AbortController().signal) => ({ schedule, signal })
const defaults = () => reposConfigSchema.parse(undefined)

/** discovery then metadata, returning the provider for further passes. */
async function readRoot(root: string, cfg: ReposConfig = defaults()) {
  const p = createReposProvider({ homeDir: root })
  await p.fetch(cfg, ctx('discovery'))
  const data = await p.fetch(cfg, ctx('metadata'))
  return { p, cfg, data }
}

function byName(data: ReposData, name: string): RepoEntry {
  const r = data.repos.find((x) => x.name === name)
  if (r === undefined) throw new Error(`fixture repo ${name} not surfaced`)
  return r
}

/** The argv after runGit's `-C <abs>`: the subcommand and everything that follows. */
function tail(argv: string[]): string[] {
  const i = argv.indexOf('-C')
  return i === -1 ? argv : argv.slice(i + 2)
}

// --- Edge shapes ---------------------------------------------------------------------

// M1 (classifyState row 6 deleted → 'clean'), M1b (branching on log's exit
// code → unavailable).
test('an empty repo reports state "empty" with no lastCommitAt, and is not an error', async () => {
  const root = makeScanRoot()
  makeRepoIn(root, 'empty', { empty: true })
  const { data } = await readRoot(root)
  const r = byName(data, 'empty')
  expect(r.metaStatus).toBe('ok')
  expect(r.repoState).toBe('empty')
  expect(r.lastCommitAt).toBeUndefined()
  expect(r.branch).toBe('main')
  expect(r.uncommittedCount).toBe(0)
  expect(r.metaReason).toBeUndefined()
})

// M4 (the bare gate removed: status runs, exits 128, the repo reads as git-error).
test('a bare repo is unavailable with reason "bare", and status is never run on it', async () => {
  const realGit = resolveGit()
  const root = makeScanRoot()
  makeRepoIn(root, 'mirror.git', { bare: true })
  const p = createReposProvider({ homeDir: root })
  const cfg = defaults()
  await p.fetch(cfg, ctx('discovery'))
  const log = join(root, 'argv.log')
  const saved = process.env.PATH
  let data: ReposData
  try {
    process.env.PATH = makeRecordingGitShim(realGit, log)
    data = await p.fetch(cfg, ctx('metadata'))
  } finally {
    process.env.PATH = saved
  }
  const r = byName(data, 'mirror.git')
  expect(r.metaStatus).toBe('unavailable')
  expect(r.metaReason).toBe('bare')
  expect(r.branch).toBeUndefined()
  expect(r.repoState).toBeUndefined()
  expect(r.uncommittedCount).toBeUndefined()
  const calls = readShimLog(log)
  expect(calls.some((a) => a.includes('rev-parse'))).toBe(true)   // the shim really was in the path
  expect(calls.some((a) => a.includes('status'))).toBe(false)
})

// M8 (detached checked before rebase → 'detached', branch undefined), M9
// (branchHead assigned unconditionally → '(detached)').
test('a mid-rebase repo recovers its real branch and never renders as detached', async () => {
  const root = makeScanRoot()
  startBranchRebaseConflict(makeRepoIn(root, 'rb'), 'feature', 'merge')
  const { data } = await readRoot(root)
  const r = byName(data, 'rb')
  expect(r.metaStatus).toBe('ok')
  expect(r.repoState).toBe('rebasing')
  expect(r.branch).toBe('feature')
  expect(r.branch).not.toBe('(detached)')
  expect(r.rebaseProgress).toEqual({ current: 1, total: 1 })
})

// M8 again, on the apply backend.
test('a mid-rebase repo on the apply backend recovers head-name too', async () => {
  const root = makeScanRoot()
  startBranchRebaseConflict(makeRepoIn(root, 'ra'), 'feat', 'apply')
  const { data } = await readRoot(root)
  const r = byName(data, 'ra')
  expect(r.repoState).toBe('rebasing')
  expect(r.branch).toBe('feat')
  expect(r.rebaseProgress).toEqual({ current: 1, total: 1 })
})

test('a mid-merge repo reports "merging" and keeps its branch', async () => {
  const root = makeScanRoot()
  startMergeConflict(makeRepoIn(root, 'mg'))
  const { data } = await readRoot(root)
  const r = byName(data, 'mg')
  expect(r.repoState).toBe('merging')
  expect(r.branch).toBe('main')
})

test('a mid-cherry-pick repo reports "cherry-picking"', async () => {
  const root = makeScanRoot()
  startCherryPickConflict(makeRepoIn(root, 'cp'))
  const { data } = await readRoot(root)
  expect(byName(data, 'cp').repoState).toBe('cherry-picking')
})

// M11 (-uall dropped → 1). Also M10's collateral (git exits 129 → git-error).
test('-uall reports 47 untracked files, not 8', async () => {
  const root = makeScanRoot()
  addUntrackedFiles(makeRepoIn(root, 'u'), 47)
  const { data } = await readRoot(root)
  const r = byName(data, 'u')
  expect(r.metaStatus).toBe('ok')
  expect(r.uncommittedCount).toBe(47)
  // Independent of state: 47 uncommitted files on a branch with no operation
  // in progress is still 'clean'.
  expect(r.repoState).toBe('clean')
})

// M13 (setUnavailable stops deleting the previous values).
test('a repo whose .git vanished between passes is unavailable with reason "gone"', async () => {
  const root = makeScanRoot()
  const repo = makeRepoIn(root, 'gone')
  const { p, cfg, data: first } = await readRoot(root)
  expect(byName(first, 'gone').metaStatus).toBe('ok')
  expect(byName(first, 'gone').uncommittedCount).toBe(0)
  rmSync(join(repo, '.git'), { recursive: true, force: true })
  const second = await p.fetch(cfg, ctx('metadata'))
  const r = byName(second, 'gone')
  expect(r.metaStatus).toBe('unavailable')
  expect(r.metaReason).toBe('gone')
  expect(r.uncommittedCount).toBeUndefined()
  expect(r.branch).toBeUndefined()
  expect(r.metaCheckedAt).toBeUndefined()
})

// M17 (the typeof narrowing dropped; see the mutation record for which
// direction this pins).
test('a non-numeric git exit code is git-error, not a crash', async () => {
  const root = makeScanRoot()
  const repo = makeRepoIn(root, 'x')
  const p = createReposProvider({ homeDir: root })
  const cfg = defaults()
  await p.fetch(cfg, ctx('discovery'))
  const saved = process.env.PATH
  try {
    process.env.PATH = makeEnoentGitShim()
    // Sanity first, so the test cannot pass vacuously: the shim really does
    // produce the string code.
    const direct = await runGit(repo, ['rev-parse', '--absolute-git-dir'])
    expect(typeof direct.code).toBe('string')
    expect(direct.timedOut).toBe(false)
    const data = await p.fetch(cfg, ctx('metadata'))   // resolves, never rejects
    const r = byName(data, 'x')
    expect(r.metaStatus).toBe('unavailable')
    expect(r.metaReason).toBe('git-error')
  } finally {
    process.env.PATH = saved
  }
})

// --- Timeout and backoff ----------------------------------------------------------------

// M5 (timedOut ignored → git-error and no backoff), M6 (uncommittedCount = 0
// on timeout), M7 (skipCycles never set → status re-run on the second pass).
test('a timing-out repo backs off instead of reporting clean', async () => {
  const realGit = resolveGit()
  const root = makeScanRoot()
  makeRepoIn(root, 'slow')
  const p = createReposProvider({ homeDir: root })
  const cfg = reposConfigSchema.parse({ metadataTimeoutMs: 200 })
  await p.fetch(cfg, ctx('discovery'))
  const log = join(root, 'argv.log')
  const statusCalls = () => readShimLog(log).filter((a) => a.includes('status')).length
  const saved = process.env.PATH
  try {
    process.env.PATH = makeRecordingGitShim(realGit, log, 'status')
    const first = await p.fetch(cfg, ctx('metadata'))
    const r1 = byName(first, 'slow')
    expect(r1.metaStatus).toBe('unavailable')
    expect(r1.metaReason).toBe('timeout')
    expect(r1.uncommittedCount).toBeUndefined()
    expect(r1.branch).toBeUndefined()
    expect(statusCalls()).toBe(1)

    // Second, immediate pass: skipCycles was 1, so the repo is skipped and
    // the shim gains no new status line.
    const second = await p.fetch(cfg, ctx('metadata'))
    expect(byName(second, 'slow').metaReason).toBe('timeout')
    expect(statusCalls()).toBe(1)

    // Third pass: the skip is spent, status is attempted again.
    await p.fetch(cfg, ctx('metadata'))
    expect(statusCalls()).toBe(2)
  } finally {
    process.env.PATH = saved
  }
})

test('a repo that succeeds then times out goes stale, keeping its last good values', async () => {
  const realGit = resolveGit()
  const root = makeScanRoot()
  addUntrackedFiles(makeRepoIn(root, 'st'), 3)
  const cfg = reposConfigSchema.parse({ metadataTimeoutMs: 200 })
  const { p, data: first } = await readRoot(root, cfg)
  const r1 = byName(first, 'st')
  expect(r1.metaStatus).toBe('ok')
  expect(r1.uncommittedCount).toBe(3)
  const checkedAt = r1.metaCheckedAt
  expect(checkedAt).toBeDefined()
  const saved = process.env.PATH
  try {
    process.env.PATH = makeRecordingGitShim(realGit, join(root, 'argv.log'), 'status')
    const second = await p.fetch(cfg, ctx('metadata'))
    const r2 = byName(second, 'st')
    expect(r2.metaStatus).toBe('stale')
    expect(r2.uncommittedCount).toBe(3)
    expect(r2.branch).toBe('main')
    expect(r2.metaReason).toBeUndefined()
    expect(r2.metaCheckedAt).toBe(checkedAt)
  } finally {
    process.env.PATH = saved
  }
})

// --- Call shapes ------------------------------------------------------------------------

// M10 (a caller-supplied --no-optional-locks after the subcommand).
test('the metadata argv is exactly the three declared shapes, with no caller-supplied --no-optional-locks', async () => {
  const realGit = resolveGit()
  const root = makeScanRoot()
  makeRepoIn(root, 'one')
  const p = createReposProvider({ homeDir: root })
  const cfg = defaults()
  await p.fetch(cfg, ctx('discovery'))
  const log = join(root, 'argv.log')
  const saved = process.env.PATH
  let data: ReposData
  try {
    process.env.PATH = makeRecordingGitShim(realGit, log)
    data = await p.fetch(cfg, ctx('metadata'))
  } finally {
    process.env.PATH = saved
  }
  expect(byName(data, 'one').metaStatus).toBe('ok')
  const calls = readShimLog(log)
  expect(calls).toHaveLength(3)

  const status = calls.find((a) => a.includes('status'))
  expect(status).toBeDefined()
  expect(status!.filter((a) => a === '--no-optional-locks')).toHaveLength(1)
  expect(status!.indexOf('--no-optional-locks')).toBeLessThan(status!.indexOf('status'))
  expect(status!.slice(status!.indexOf('status'))).toEqual(['status', '--porcelain=v2', '--branch', '-uall'])

  const revParse = calls.find((a) => a.includes('rev-parse'))
  expect(revParse).toBeDefined()
  expect(tail(revParse!)).toEqual(['rev-parse', '--absolute-git-dir', '--is-bare-repository'])

  const log1 = calls.find((a) => a.includes('log'))
  expect(log1).toBeDefined()
  expect(tail(log1!)).toEqual(['log', '--no-ext-diff', '--no-textconv', '-1', '--format=%ct'])
})

// --- Data and redaction -------------------------------------------------------------------

// M14 (the metadata branch returns only what it read).
test('the metadata branch returns the full merged Data, not a delta', async () => {
  const root = makeScanRoot()
  makeRepoIn(root, 'a')
  makeRepoIn(root, 'b')
  makeZeroByteGitFile(root, 'zero')
  const p = createReposProvider({ homeDir: root })
  const cfg = defaults()
  const first = await p.fetch(cfg, ctx('discovery'))
  expect(first.repos).toHaveLength(2)
  expect(first.dropped).toHaveLength(1)
  const second = await p.fetch(cfg, ctx('metadata'))
  expect(second.repos).toHaveLength(first.repos.length)
  expect(second.repos.map((r) => r.path)).toEqual(first.repos.map((r) => r.path))
  expect(second.dropped).toEqual(first.dropped)
  expect(second.errors).toEqual(first.errors)
  expect(second.scannedAt).toBe(first.scannedAt)
  expect(second.staleDays).toBe(first.staleDays)
})

test('no filename ever reaches the wire — only the count does', async () => {
  const root = makeScanRoot()
  const repo = makeRepoIn(root, 'sent')
  const sentinel = `ATRIUM-SENTINEL-${Math.random().toString(36).slice(2)}`
  writeFileSync(join(repo, `${sentinel}.txt`), 'x\n')
  const { p, data } = await readRoot(root)
  expect(byName(data, 'sent').uncommittedCount).toBe(1)
  expect(JSON.stringify(p.toClient(data))).not.toContain(sentinel)
})

// M12 (`{ ...entry }`), M13.
test('an unavailable repo emits no branch, no count and no time on the wire', async () => {
  const root = makeScanRoot()
  makeRepoIn(root, 'mirror.git', { bare: true })
  const { data } = await readRoot(root)
  const wire = reposToClient(data)
  const w = wire.repos.find((r) => r.name === 'mirror.git')
  expect(w).toBeDefined()
  const obj = w as unknown as Record<string, unknown>
  expect(obj.metaStatus).toBe('unavailable')
  expect(obj.metaReason).toBe('bare')
  for (const k of ['branch', 'uncommittedCount', 'lastCommitAt', 'repoState', 'rebaseProgress']) {
    expect(k in obj).toBe(false)
  }
})

// M12.
test('metaCheckedAt never reaches the wire', async () => {
  const root = makeScanRoot()
  makeRepoIn(root, 'ok')
  const { data } = await readRoot(root)
  const entry = byName(data, 'ok')
  expect(entry.metaStatus).toBe('ok')
  expect(typeof entry.metaCheckedAt).toBe('number')
  const w = reposToClient(data).repos.find((r) => r.name === 'ok') as unknown as Record<string, unknown>
  expect('metaCheckedAt' in w).toBe(false)
  expect(JSON.stringify(reposToClient(data))).not.toContain('metaCheckedAt')
  // And the readable fields ARE there, so the absence above is redaction, not emptiness.
  expect(w.branch).toBe('main')
  expect(w.uncommittedCount).toBe(0)
  expect(typeof w.lastCommitAt).toBe('number')
})

// --- Config: templates and ranges ----------------------------------------------------------

test('template validation rejects the five malformed shapes', () => {
  const bad = (editor: unknown, msg: string) => expect(() => reposConfigSchema.parse({ editor })).toThrow(msg)
  bad({ cmd: '', args: [] }, 'repos.editor.cmd must be a non-empty string')
  bad({ cmd: 'code', args: 'x' }, 'repos.editor.args must be an array of strings')
  bad({ cmd: 'code', args: ['--'] }, 'repos.editor.args must contain exactly one ${path} element')
  bad({ cmd: 'code', args: ['--', '${path}', '${path}'] }, 'repos.editor.args must contain exactly one ${path} element')
  bad({ cmd: 'code', args: ['--workdir=${path}'] }, 'repos.editor.args must not embed ${path} inside a larger argument')
  // The same validator runs for every template key.
  expect(() => reposConfigSchema.parse({ terminal: { cmd: '', args: [] } })).toThrow('repos.terminal.cmd must be a non-empty string')
  expect(() => reposConfigSchema.parse({ claudeTerminal: { cmd: 'k', args: ['--'] } })).toThrow('repos.claudeTerminal.args must contain exactly one ${path} element')
  // And a well-formed template is accepted as a fresh copy.
  const args = ['-n', '${path}']
  const ok = reposConfigSchema.parse({ editor: { cmd: 'vim', args } })
  expect(ok.editor).toEqual({ cmd: 'vim', args: ['-n', '${path}'] })
  expect(ok.editor.args).not.toBe(args)
})

test('a placeholder with no dash-leading literal before it is rejected', () => {
  const re = /must place a literal option \(starting with "-"\) immediately before/
  expect(() => reposConfigSchema.parse({ editor: { cmd: 'code', args: ['${path}'] } })).toThrow(re)
  expect(() => reposConfigSchema.parse({ editor: { cmd: 'code', args: ['open', '${path}'] } })).toThrow(re)
})

test('out-of-range numeric config is rejected, not clamped', () => {
  const c = 'repos.metadataConcurrency must be an integer between 1 and 16'
  const t = 'repos.metadataTimeoutMs must be an integer between 100 and 60000'
  expect(() => reposConfigSchema.parse({ metadataConcurrency: 0 })).toThrow(c)
  expect(() => reposConfigSchema.parse({ metadataConcurrency: 17 })).toThrow(c)
  expect(() => reposConfigSchema.parse({ metadataConcurrency: 8.5 })).toThrow(c)
  expect(() => reposConfigSchema.parse({ metadataTimeoutMs: 50 })).toThrow(t)
  expect(() => reposConfigSchema.parse({ metadataTimeoutMs: 60001 })).toThrow(t)
  expect(reposConfigSchema.parse({ metadataConcurrency: 16, metadataTimeoutMs: 100 })).toMatchObject({ metadataConcurrency: 16, metadataTimeoutMs: 100 })
})

// --- Lifecycle -------------------------------------------------------------------------------

test('an aborted fetch issues no git calls', async () => {
  const realGit = resolveGit()
  const root = makeScanRoot()
  makeRepoIn(root, 'one')
  const p = createReposProvider({ homeDir: root })
  const cfg = defaults()
  await p.fetch(cfg, ctx('discovery'))
  const log = join(root, 'argv.log')
  const ac = new AbortController()
  ac.abort()
  const saved = process.env.PATH
  try {
    process.env.PATH = makeRecordingGitShim(realGit, log)
    const data = await p.fetch(cfg, ctx('metadata', ac.signal))
    expect(data.repos).toHaveLength(1)
  } finally {
    process.env.PATH = saved
  }
  expect(readShimLog(log)).toEqual([])
})
