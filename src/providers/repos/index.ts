import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { runGit } from '../../core/rungit.ts'
import type { FetchCtx, Provider } from '../../core/contract.ts'
import { reposConfigSchema, type ReposConfig } from './config.ts'
import { createReposActions } from './actions.ts'

// Re-exported under the plan's names; declared in config.ts because the
// defaults live there and config.ts cannot import this module (cycle).
export { METADATA_CONCURRENCY_DEFAULT, METADATA_CONCURRENCY_MAX, METADATA_TIMEOUT_MS_DEFAULT } from './config.ts'

/**
 * The repos provider, discovery half (Task 7): walk the configured roots,
 * find repository candidates, put each through a validity gate built on
 * `rev-parse --absolute-git-dir`'s EXIT CODE plus a gitdir-vs-candidate
 * containment comparison, then run each survivor through a five-row,
 * first-match-wins classifier (worktree → submodule → vendored → container →
 * ambiguous). Dropped candidates are reported in Data, never silently
 * discarded. Metadata half (Task 8): the `metadata` schedule walks the
 * closure-held table with bounded concurrency, a per-repo timeout and a
 * timeout-keyed backoff, reading branch / state / uncommitted count / last
 * commit time off three exactly-specified call shapes. The three exec actions
 * are in ./actions.ts and validate their target against the same table.
 *
 * Everything reaches the git binary through runGit — never child_process,
 * never Bun.spawn, never a quoted binary name (test/rungit.test.ts scans the
 * raw text of every file under src/, comments included).
 */

// --- B. Types and identity ---------------------------------------------------

export type DropReason = 'worktree' | 'submodule' | 'vendored' | 'ambiguous' | 'invalid' | 'timed-out'

/**
 * A CLOSED SET. Nothing derived from a caught exception, and no path, ever
 * enters this channel (§7.4's closed-set rule, contract-wide since Task 5).
 */
export type ReposErrorCode = 'root-missing' | 'root-unreadable' | 'candidate-error'

/**
 * `'clean'` means "on a branch with no operation in progress" and says
 * NOTHING about `uncommittedCount`: a repo can be `clean` with 47 uncommitted
 * files. The name invites the opposite reading; Task 9's "needs attention"
 * rule depends on the two being independent.
 */
export type RepoState =
  | 'clean' | 'detached' | 'rebasing' | 'merging'
  | 'cherry-picking' | 'reverting' | 'bisecting' | 'empty'

export type RepoMetaStatus = 'ok' | 'stale' | 'unavailable'
/** A CLOSED SET: never a caught exception, never a stderr string. */
export type RepoUnavailableReason = 'timeout' | 'bare' | 'gone' | 'git-error'

/**
 * `path` and `gitDir` are absolute and realpath-resolved; `name` is `basename(path)`.
 *
 * INVARIANT: `metaCheckedAt !== undefined` if and only if the entry currently
 * carries readable metadata. `metaStatus: 'unavailable'` DELETES `branch`,
 * `repoState`, `rebaseProgress`, `uncommittedCount`, `lastCommitAt` and
 * `metaCheckedAt` — §7.4's rule applied per repo: an unavailable repo emits no
 * branch, no count, no time. Not zero, not null: absent. `'stale'` keeps every
 * previously-read field as-is.
 */
export interface RepoEntry {
  id: string
  path: string
  name: string
  gitDir: string
  bare: boolean
  origin: 'top-level' | 'container-child'
  branch?: string                                  // never the literal '(detached)'
  repoState?: RepoState
  rebaseProgress?: { current: number; total: number }
  uncommittedCount?: number
  lastCommitAt?: number                            // unix SECONDS, from %ct
  /**
   * A repo that discovery has surfaced but the metadata pass has not yet read
   * is `unavailable` with no `metaReason`: there is nothing to show, and the
   * reason set is closed (no "pending" code). The first metadata cycle
   * replaces it.
   */
  metaStatus: RepoMetaStatus
  metaReason?: RepoUnavailableReason               // present only when metaStatus === 'unavailable'
  metaCheckedAt?: number                           // Date.now() ms of the last successful read
}

export interface DroppedCandidate { id: string; path: string; name: string; reason: DropReason }

/**
 * `staleDays` is copied from `cfg` at fetch time so Task 9's pane can apply
 * the "needs attention" rule without a second config channel — `toClient`
 * receives only `Data`.
 */
export interface ReposData {
  repos: RepoEntry[]
  dropped: DroppedCandidate[]
  errors: ReposErrorCode[]
  scannedAt: number
  staleDays: number
}

/**
 * The test seam. Without an injectable home the suite could only assert
 * against the developer's real $HOME (§10 rule 1). Test-only knobs live here,
 * never in config.
 */
export interface ReposProviderDeps { homeDir?: string; classifyTimeoutMs?: number }

/**
 * Deterministic, so tests compute the expected id rather than reading it back.
 * A stable client-side handle (React key, row correlation across refreshes).
 * NOT what Task 8's action target validation keys on — that keys on the
 * absolute `path`, which is a key of the closure `table` map.
 */
export function repoId(absPath: string): string {
  return createHash('sha256').update(absPath).digest('hex').slice(0, 16)
}

export const DISCOVERY_INTERVAL_MS = 600_000
export const METADATA_INTERVAL_MS = 30_000
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 5_000
/** Backoff ceiling in metadata cycles (30 s each → ~16 min). */
export const MAX_SKIP_CYCLES = 32
const CLASSIFY_CONCURRENCY = 8
const MAX_SCAN_DEPTH = 8
const PRUNE_DIR_NAMES = new Set(['node_modules'])

// --- C. The walker -------------------------------------------------------------

interface ScanState {
  candidates: Set<string>
  /**
   * Roots that are NOT structurally candidates (no .git, not bare-shaped) but
   * are still put through the gate. An operator-named extraRoot such as
   * `/home/u/proj/src` has no .git of its own yet rev-parse exits 0 there
   * with the ANCESTOR's gitdir (measured), and the containment comparison is
   * what must drop it — so the gate has to see it. A probe root whose
   * rev-parse exits non-zero is simply a directory of projects (or $HOME
   * itself, 128 for every non-yadm user) and is not reported: it is not a
   * broken repository, and a `dropped` row naming every user's home would be
   * a factual wrong answer on every dashboard.
   */
  probes: Set<string>
  errors: ReposErrorCode[]
}

function safeRealpath(p: string): string | undefined {
  try { return realpathSync(p) } catch { return undefined }
}

function isBareShape(dir: string): boolean {
  return existsSync(join(dir, 'HEAD')) && existsSync(join(dir, 'objects')) && existsSync(join(dir, 'refs'))
}

/**
 * Depth-first, lstat semantics, NEVER following symlinks: `Dirent.isDirectory()`
 * is false for a symlink-to-directory, so only real directories are entered.
 * That is the cycle guard and the $HOME-escape guard in one.
 */
function walkDir(dir: string, depth: number, cfg: ReposConfig, state: ScanState, signal: AbortSignal): void {
  if (signal.aborted) return

  const bare = !existsSync(join(dir, '.git')) && isBareShape(dir)
  if (existsSync(join(dir, '.git')) || bare) {
    state.candidates.add(dir)
    // A bare repo's objects/ and refs/ subtrees are not projects. A non-bare
    // candidate IS descended into: nested repos are the whole point of the
    // container rule.
    if (bare) return
  } else if (depth === 0) {
    state.probes.add(dir)
  }

  if (depth >= MAX_SCAN_DEPTH) return

  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    state.errors.push('root-unreadable')
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const n = entry.name
    if (n === '.git') continue
    // §7.1 Rule 1 as a prune: repos under a dot-directory, and repos whose own
    // basename starts with a dot, are not discovered unless opted in. Roots
    // are exempt (see scanRoots) because extraRoots is the documented escape
    // hatch for chezmoi/yadm/~/.dotfiles users.
    if (n.startsWith('.') && cfg.includeDotPaths === false) continue
    if (PRUNE_DIR_NAMES.has(n)) continue
    walkDir(join(dir, n), depth + 1, cfg, state, signal)
  }
}

function scanRoots(roots: string[], cfg: ReposConfig, signal: AbortSignal): ScanState {
  const state: ScanState = { candidates: new Set(), probes: new Set(), errors: [] }
  const seen = new Set<string>()
  for (const root of roots) {
    if (signal.aborted) break
    // A root that does not exist, or whose realpath cannot be resolved, is
    // reported and skipped — discovery must not throw for it.
    const real = safeRealpath(root)
    if (real === undefined || !existsSync(real)) { state.errors.push('root-missing'); continue }
    if (seen.has(real)) continue
    seen.add(real)
    walkDir(real, 0, cfg, state, signal)
  }
  return state
}

// --- D. The validity gate ------------------------------------------------------

interface GateResult {
  path: string
  gitDir: string
  bare: boolean
}

type Verdict =
  | { kind: 'valid'; entry: GateResult }
  | { kind: 'dropped'; path: string; reason: DropReason }
  | { kind: 'skip' } // a probe root that is not inside any repository (see ScanState.probes)
  | { kind: 'probe-error' } // a probe root the gate could not measure: counted, never named

function isCodeZero(code: number | string): boolean {
  // `code` can be the STRING 'ENOENT' when the child never started; narrow
  // before every comparison, never compare a string numerically.
  return typeof code === 'number' && code === 0
}

/**
 * The gate is on the EXIT CODE, not on emptiness: a non-repo directory, a
 * 0-byte .git file and a dangling gitdir pointer all exit 128 (measured,
 * git 2.55.0). Then the containment comparison: `--absolute-git-dir` walks
 * UP, so a plain subdirectory of a repo exits 0 with the ANCESTOR's gitdir.
 * Accept only when the gitdir belongs to this candidate, or the candidate
 * carries a .git FILE (linked worktree / submodule — the classifier decides).
 */
async function gate(candidate: string, timeoutMs: number, probe: boolean): Promise<Verdict> {
  const r = await runGit(candidate, ['rev-parse', '--absolute-git-dir'], { timeoutMs })
  // A `dropped` row carries basename(path), and for the home root that is the
  // operator's username — so the ONE reportable fact about an unmeasurable
  // PROBE ROOT is that it happened. There is no root-specific drop reason and
  // adding one is out of this slice; a timeout and a thrown call are therefore
  // both counted on the closed set and the root is skipped, matching what the
  // non-zero-exit line below already does silently.
  if (r.timedOut) return probe ? { kind: 'probe-error' } : { kind: 'dropped', path: candidate, reason: 'timed-out' }
  if (!isCodeZero(r.code)) return probe ? { kind: 'skip' } : { kind: 'dropped', path: candidate, reason: 'invalid' }

  const raw = r.stdout.trim()
  // Exit 0 with EMPTY stdout, guarded because of what the next line would do
  // with it, not because anything has been seen to produce it: realpathSync('')
  // returns the ATRIUM PROCESS's own cwd (measured on bun 1.3.11), so an empty
  // answer would be compared as though git had named a real directory. No
  // fixture can reach this line — rev-parse --absolute-git-dir on git 2.55.0
  // either prints a path and exits 0 or prints nothing and exits 128 — so it
  // carries no mutation row and is held by inspection alone. The probe split
  // is the one the exit-code line above already makes: a root is never named.
  if (raw === '') return probe ? { kind: 'skip' } : { kind: 'dropped', path: candidate, reason: 'invalid' }
  const gitDir = safeRealpath(raw) ?? raw
  const dotGit = join(candidate, '.git')

  if (gitDir === dotGit) return { kind: 'valid', entry: { path: candidate, gitDir, bare: false } }
  if (gitDir === candidate) return { kind: 'valid', entry: { path: candidate, gitDir, bare: true } }
  if (existsSync(dotGit) && lstatSync(dotGit).isFile()) {
    return { kind: 'valid', entry: { path: candidate, gitDir, bare: false } }
  }
  // A subdirectory of some other repo: this is what stops
  // extraRoots: ['/home/u/proj/src'] from surfacing src as its own repository.
  return { kind: 'dropped', path: candidate, reason: 'invalid' }
}

// --- E. The classifier: five rows, first match wins, in exactly this order ------

type Classification =
  | { kind: 'surface'; origin: RepoEntry['origin'] }
  | { kind: 'drop'; reason: DropReason }

/** The LONGEST valid candidate path that is a strict path prefix of `c`. */
function parentOf(c: string, valid: string[]): string | undefined {
  let best: string | undefined
  for (const p of valid) {
    if (c.startsWith(p + sep) && (best === undefined || p.length > best.length)) best = p
  }
  return best
}

/**
 * Row order is not negotiable. A worktree at worktrees/feat inside a repo
 * whose .gitignore lists worktrees/ matches BOTH row 1 (drop) and row 4
 * (surface): testing check-ignore first surfaces every worktree as a
 * project. Row 2 must precede row 3 for the same reason: a submodule is
 * also tracked, so plain ls-files is non-empty and row 3 would claim it with
 * the wrong reason.
 *
 * Timeout short-circuit: a timed-out check-ignore returns code 1 —
 * byte-identical to a genuine "not ignored" — so without GitResult.timedOut
 * the repo would be silently reclassified as ambiguous and dropped. This is
 * the entire reason Task 1 added that field.
 */
async function classify(
  entry: GateResult,
  parent: string | undefined,
  containers: ReadonlySet<string>,
  timeoutMs: number,
): Promise<Classification> {
  // Row 1 — linked worktree. A linked worktree's git dir contains a file
  // literally named gitdir; a submodule's (<parent>/.git/modules/<name>)
  // does not. Applies even with no parent repo.
  if (existsSync(join(entry.gitDir, 'gitdir'))) return { kind: 'drop', reason: 'worktree' }

  if (parent === undefined) return { kind: 'surface', origin: 'top-level' }

  // `rel` is repository-derived, so it always follows a `--`.
  const rel = relative(parent, entry.path)

  // Row 2 — submodule: mode 160000 in the parent's index.
  const staged = await runGit(parent, ['ls-files', '-s', '--', rel], { timeoutMs })
  if (staged.timedOut) return { kind: 'drop', reason: 'timed-out' }
  const firstLine = staged.stdout.split('\n')[0] ?? ''
  if (firstLine.split(/\s+/)[0] === '160000') return { kind: 'drop', reason: 'submodule' }

  // Row 3 — vendored: tracked by the parent. Gate on OUTPUT, not exit code:
  // ls-files exits 0 whether or not it matched anything.
  const tracked = await runGit(parent, ['ls-files', '--', rel], { timeoutMs })
  if (tracked.timedOut) return { kind: 'drop', reason: 'timed-out' }
  if (tracked.stdout.trim() !== '') return { kind: 'drop', reason: 'vendored' }

  // Row 4 — container: ignored by the parent (exit 0 = ignored, 1 = not,
  // 128 = not a repository), or the parent is listed in treatAsContainer.
  if (containers.has(parent)) return { kind: 'surface', origin: 'container-child' }
  const ignored = await runGit(parent, ['check-ignore', '-q', '--', rel], { timeoutMs })
  if (ignored.timedOut) return { kind: 'drop', reason: 'timed-out' }
  if (isCodeZero(ignored.code)) return { kind: 'surface', origin: 'container-child' }

  // Row 5 — ambiguous. Reported in Data, never silently decided (§7.1).
  return { kind: 'drop', reason: 'ambiguous' }
}

/**
 * Bounded concurrency over `items`; stops taking new work once `signal`
 * aborts. Result order is by input index, never by completion order.
 */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<R>,
): Promise<Array<R | undefined>> {
  const out: Array<R | undefined> = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length && !signal.aborted) {
      const i = next++
      const item = items[i]
      if (item === undefined) continue
      out[i] = await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

interface ScanOutcome {
  repos: RepoEntry[]
  dropped: DroppedCandidate[]
  errors: ReposErrorCode[]
}

function droppedEntry(path: string, reason: DropReason): DroppedCandidate {
  return { id: repoId(path), path, name: basename(path), reason }
}

const byPath = <T extends { path: string }>(a: T, b: T): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** The whole discovery pass: walk → gate → classify. Never throws. */
async function discover(cfg: ReposConfig, deps: Required<ReposProviderDeps>, signal: AbortSignal): Promise<ScanOutcome> {
  const roots = [deps.homeDir, ...cfg.extraRoots]
  const scan = scanRoots(roots, cfg, signal)
  const errors: ReposErrorCode[] = [...scan.errors]
  const dropped: DroppedCandidate[] = []
  // Walked paths are already realpath-resolved: every root is, and symlinks
  // are never followed. Sorted ascending: the determinism the tests rely on.
  const candidates = [...new Set([...scan.candidates, ...scan.probes])].sort()

  // One bad repository must never abort the scan: a candidate that throws
  // anything unexpected is recorded on the closed-set channel and dropped.
  const verdicts = await mapBounded(candidates, CLASSIFY_CONCURRENCY, signal, async (c): Promise<Verdict> => {
    try {
      return await gate(c, deps.classifyTimeoutMs, !scan.candidates.has(c))
    } catch {
      if (!scan.candidates.has(c)) return { kind: 'probe-error' }
      errors.push('candidate-error')
      return { kind: 'dropped', path: c, reason: 'invalid' }
    }
  })

  const valid: GateResult[] = []
  for (const v of verdicts) {
    if (v === undefined || v.kind === 'skip') continue
    if (v.kind === 'probe-error') { errors.push('candidate-error'); continue }
    if (v.kind === 'dropped') dropped.push(droppedEntry(v.path, v.reason))
    else valid.push(v.entry)
  }
  const validPaths = valid.map((v) => v.path)

  const containers = new Set<string>()
  for (const t of cfg.treatAsContainer) {
    const real = safeRealpath(t)
    if (real !== undefined) containers.add(real)
  }

  const repos: RepoEntry[] = []
  const classified = await mapBounded(valid, CLASSIFY_CONCURRENCY, signal, async (entry): Promise<Classification> => {
    try {
      return await classify(entry, parentOf(entry.path, validPaths), containers, deps.classifyTimeoutMs)
    } catch {
      errors.push('candidate-error')
      return { kind: 'drop', reason: 'invalid' }
    }
  })
  classified.forEach((c, i) => {
    const entry = valid[i]
    if (c === undefined || entry === undefined) return
    if (c.kind === 'drop') { dropped.push(droppedEntry(entry.path, c.reason)); return }
    repos.push({
      id: repoId(entry.path),
      path: entry.path,
      name: basename(entry.path),
      gitDir: entry.gitDir,
      bare: entry.bare,
      origin: c.origin,
      metaStatus: 'unavailable',
    })
  })

  return { repos: repos.sort(byPath), dropped: dropped.sort(byPath), errors }
}


// --- F2. The metadata pass ------------------------------------------------------

interface StatusV2 { branchHead?: string; initial: boolean; uncommittedCount: number }

/**
 * `status --porcelain=v2 --branch -uall`. Every non-empty line that is not a
 * `# ` header is one entry (`1 `/`2 `/`u `/`? `), and paths are C-quoted so a
 * newline in a filename cannot split a record — line counting is safe
 * (measured). `branchHead` may be the literal `(detached)`; the caller decides.
 */
function parseStatusV2(stdout: string): StatusV2 {
  const out: StatusV2 = { initial: false, uncommittedCount: 0 }
  for (const line of stdout.split('\n')) {
    if (line === '# branch.oid (initial)') { out.initial = true; continue }
    if (line.startsWith('# branch.head ')) { out.branchHead = line.slice('# branch.head '.length); continue }
    if (line === '' || line.startsWith('# ')) continue
    out.uncommittedCount++
  }
  return out
}

// Every state-file read is guarded: a file that disappears between the
// exists check and the read must not throw out of the metadata pass.
function safeExists(p: string): boolean {
  try { return existsSync(p) } catch { return false }
}
function readTrimmed(p: string): string | undefined {
  try { return readFileSync(p, 'utf8').trim() } catch { return undefined }
}
function readInt(p: string): number | undefined {
  const s = readTrimmed(p)
  return s !== undefined && /^\d+$/.test(s) ? Number(s) : undefined
}

/**
 * First match wins, in exactly this order, against the ABSOLUTE gitdir
 * rev-parse returned — never `<repo>/.git`, which is a FILE in a linked
 * worktree (and `rebase-merge/` lives in the per-worktree dir).
 *
 * Rebase precedes detached on purpose: a mid-rebase `status` reports
 * `# branch.head (detached)` (measured), so the reverse order renders every
 * rebase as a bare detached HEAD — which §7.1 forbids by name.
 */
function classifyState(gitDir: string, parsed: StatusV2): RepoState {
  if (safeExists(join(gitDir, 'rebase-merge')) || safeExists(join(gitDir, 'rebase-apply'))) return 'rebasing'
  if (safeExists(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-picking'
  if (safeExists(join(gitDir, 'REVERT_HEAD'))) return 'reverting'
  if (safeExists(join(gitDir, 'MERGE_HEAD'))) return 'merging'
  if (safeExists(join(gitDir, 'BISECT_LOG'))) return 'bisecting'
  if (parsed.initial) return 'empty'
  if (parsed.branchHead === '(detached)') return 'detached'
  return 'clean'
}

/**
 * The string `'(detached)'` is NEVER assigned to `branch`. Mid-rebase the real
 * branch lives only in the state file: `head-name` under `rebase-merge/`
 * (merge backend; progress `msgnum`/`end`) or `rebase-apply/` (apply backend;
 * progress `next`/`last`). A `head-name` that is not `refs/heads/…` (a rebase
 * started from a detached HEAD writes `detached HEAD` there) yields no branch.
 */
function resolveBranch(gitDir: string, state: RepoState, parsed: StatusV2): Pick<RepoEntry, 'branch' | 'rebaseProgress'> {
  if (state === 'rebasing') {
    const merge = join(gitDir, 'rebase-merge')
    const isMerge = safeExists(merge)
    const dir = isMerge ? merge : join(gitDir, 'rebase-apply')
    const head = readTrimmed(join(dir, 'head-name'))
    const branch = head !== undefined && head.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : undefined
    const current = readInt(join(dir, isMerge ? 'msgnum' : 'next'))
    const total = readInt(join(dir, isMerge ? 'end' : 'last'))
    const rebaseProgress = current !== undefined && total !== undefined ? { current, total } : undefined
    return { branch, rebaseProgress }
  }
  return { branch: parsed.branchHead === '(detached)' ? undefined : parsed.branchHead }
}

const META_FIELDS = ['branch', 'repoState', 'rebaseProgress', 'uncommittedCount', 'lastCommitAt', 'metaCheckedAt'] as const

/** Carries the metadata fields of `from` onto `to` when discovery rebuilds the table. */
function carryMeta(from: RepoEntry, to: RepoEntry): void {
  to.metaStatus = from.metaStatus
  if (from.metaReason !== undefined) to.metaReason = from.metaReason
  if (from.branch !== undefined) to.branch = from.branch
  if (from.repoState !== undefined) to.repoState = from.repoState
  if (from.rebaseProgress !== undefined) to.rebaseProgress = from.rebaseProgress
  if (from.uncommittedCount !== undefined) to.uncommittedCount = from.uncommittedCount
  if (from.lastCommitAt !== undefined) to.lastCommitAt = from.lastCommitAt
  if (from.metaCheckedAt !== undefined) to.metaCheckedAt = from.metaCheckedAt
}

// --- G. Redaction ----------------------------------------------------------------

/**
 * The wire types. Task 8 EXTENDS `RepoWire` with its metadata fields and
 * extends the allowlist to match; Task 9 imports both interfaces type-only.
 */
export interface RepoWire {
  id: string; path: string; name: string; bare: boolean; origin: 'top-level' | 'container-child'
  branch?: string                                   // ABSENT when unknown — never null, never ''
  repoState?: RepoState
  rebaseProgress?: { current: number; total: number }
  uncommittedCount?: number
  lastCommitAt?: number                             // unix SECONDS
  metaStatus: RepoMetaStatus
  metaReason?: RepoUnavailableReason
}
export interface DroppedWire { id: string; name: string; reason: DropReason }
export interface ReposWire {
  repos: RepoWire[]
  dropped: DroppedWire[]
  errors: ReposErrorCode[]
  scannedAt: number
  staleDays: number
}

/**
 * An explicit field-by-field ALLOWLIST, never `{ ...data }` with deletions.
 *
 * A surfaced repo's `path` is on the wire ON PURPOSE (settled cross-task
 * ruling): it is the identifier Task 9's action buttons post back and the key
 * Task 8's `resolveTarget` validates against the discovered table, which is
 * the control that makes accepting it safe. Residual, stated plainly:
 * absolute $HOME-relative repository paths reach an authenticated,
 * same-origin client.
 *
 * `gitDir` never crosses this seam, and neither does any DROPPED candidate's
 * path — a dropped candidate is not an action target, so it gets `id` and
 * `name` only. `metaCheckedAt` is internal and stays off the wire. No raw git
 * stdout/stderr is ever stored on an entry, so nothing but parsed scalars can
 * reach here; `metaStatus`/`metaReason` are closed sets of declared codes.
 *
 * Absent-not-null (§7.4 on the wire): an optional field is added only when
 * the entry carries it, so `'branch' in wire` is false for an unavailable
 * repo. Task 9's pane is written against absence.
 */
function repoToWire(r: RepoEntry): RepoWire {
  const w: RepoWire = { id: r.id, path: r.path, name: r.name, bare: r.bare, origin: r.origin, metaStatus: r.metaStatus }
  if (r.branch !== undefined) w.branch = r.branch
  if (r.repoState !== undefined) w.repoState = r.repoState
  if (r.rebaseProgress !== undefined) w.rebaseProgress = { current: r.rebaseProgress.current, total: r.rebaseProgress.total }
  if (r.uncommittedCount !== undefined) w.uncommittedCount = r.uncommittedCount
  if (r.lastCommitAt !== undefined) w.lastCommitAt = r.lastCommitAt
  if (r.metaReason !== undefined) w.metaReason = r.metaReason
  return w
}

export function reposToClient(data: ReposData): ReposWire {
  return {
    repos: data.repos.map(repoToWire),
    dropped: data.dropped.map((d) => ({ id: d.id, name: d.name, reason: d.reason })),
    errors: [...data.errors],
    scannedAt: data.scannedAt,
    staleDays: data.staleDays,
  }
}

// --- F. The provider object --------------------------------------------------------

/**
 * A FACTORY, not a module singleton: each call owns its own repo table, so
 * fixture tests are isolated and "providers are fetch(cfg) → Data, testable
 * against fixtures" survives.
 */
export function createReposProvider(deps: ReposProviderDeps = {}): Provider<ReposConfig, ReposData> {
  const resolved: Required<ReposProviderDeps> = {
    homeDir: deps.homeDir ?? homedir(),
    classifyTimeoutMs: deps.classifyTimeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS,
  }

  // Closure state. `table` is a MAP keyed by absolute realpath, not an array:
  // Task 8's resolveTarget validates an action target by exact string equality
  // against a key of this map, and reads it through a getter — so a discovery
  // pass rebuilds it IN PLACE (clear then set) rather than replacing it.
  // `lastCfg` is set at the top of fetch, BEFORE any await: the exec arm's
  // argv(target) takes no cfg and dispatch passes cfg only to call actions,
  // so a getter over this variable is the only way the action layer sees
  // config. Both schedules are runOnStart, so a fetch has run before any
  // action can be dispatched through a started server.
  const table = new Map<string, RepoEntry>()
  const backoff = new Map<string, { consecutiveTimeouts: number; skipCycles: number }>()
  let dropped: DroppedCandidate[] = []
  let errors: ReposErrorCode[] = []
  let scannedAt = 0
  let lastCfg: ReposConfig | undefined

  function setUnavailable(entry: RepoEntry, reason: RepoUnavailableReason): void {
    entry.metaStatus = 'unavailable'
    entry.metaReason = reason
    for (const f of META_FIELDS) delete entry[f]
    // A timeout's backoff entry was just written by onTimeout; every other
    // reason is a fresh verdict and clears the count.
    if (reason !== 'timeout') backoff.delete(entry.path)
  }

  /** Stale if there is something to keep, else unavailable/timeout. */
  function markNotRead(entry: RepoEntry): void {
    if (entry.metaCheckedAt !== undefined) {
      entry.metaStatus = 'stale'
      delete entry.metaReason
    } else {
      setUnavailable(entry, 'timeout')
    }
  }

  /**
   * After the n-th consecutive timeout: skipCycles = min(2^(n-1), 32) → 1, 2,
   * 4, 8, 16, 32, 32, … A timed-out repo is NEVER written as a successful
   * read: a timed-out runGit returns code 1, byte-identical to several genuine
   * failures — exactly the shape Task 1's `timedOut` exists for.
   */
  function onTimeout(entry: RepoEntry): void {
    const b = backoff.get(entry.path) ?? { consecutiveTimeouts: 0, skipCycles: 0 }
    b.consecutiveTimeouts += 1
    b.skipCycles = Math.min(2 ** (b.consecutiveTimeouts - 1), MAX_SKIP_CYCLES)
    backoff.set(entry.path, b)
    markNotRead(entry)
  }

  /**
   * One repo, three calls, in this order, each through runGit — the only
   * path to the version-control binary (§8.6). No `--no-optional-locks` in
   * any array (runGit's prefix supplies it; after the subcommand it is exit
   * 129). No positional operand, so no `--`. The path reaches git through
   * runGit's own `-C <abs>`; table keys are already absolute.
   */
  async function readOne(entry: RepoEntry, timeoutMs: number): Promise<void> {
    // 1. Backoff gate: no git call this cycle.
    const b = backoff.get(entry.path)
    if (b !== undefined && b.skipCycles > 0) {
      b.skipCycles -= 1
      markNotRead(entry)
      return
    }

    // 2. Gitdir and bareness. Narrow `code` BEFORE comparing: the STRING
    //    'ENOENT' (child never started) is git-error, a numeric non-zero is
    //    gone (deleted / no longer a repo: exit 128, measured).
    const rp = await runGit(entry.path, ['rev-parse', '--absolute-git-dir', '--is-bare-repository'], { timeoutMs })
    if (rp.timedOut) { onTimeout(entry); return }
    if (typeof rp.code !== 'number') { setUnavailable(entry, 'git-error'); return }
    if (rp.code !== 0) { setUnavailable(entry, 'gone'); return }
    const lines = rp.stdout.split('\n')
    const gitDir = (lines[0] ?? '').trim()
    const isBare = (lines[1] ?? '').trim() === 'true'
    if (gitDir === '') { setUnavailable(entry, 'gone'); return }
    // Returns BEFORE status runs: status exits 128 in a bare repo ("must be
    // run in a work tree", measured) and would read as a broken repository.
    if (isBare) { setUnavailable(entry, 'bare'); return }

    // 3. Branch, initial-ness and the uncommitted count.
    const st = await runGit(entry.path, ['status', '--porcelain=v2', '--branch', '-uall'], { timeoutMs })
    if (st.timedOut) { onTimeout(entry); return }
    if (!isCodeZero(st.code)) { setUnavailable(entry, 'git-error'); return }

    // 4. Last commit time. NEVER branch on this exit code for emptiness: an
    //    empty repo's `log -1` exits 128 (measured), and that means only "no
    //    lastCommitAt this cycle" — emptiness is read off status's
    //    `# branch.oid (initial)`.
    const lg = await runGit(entry.path, ['log', '-1', '--format=%ct'], { timeoutMs })
    if (lg.timedOut) { onTimeout(entry); return }
    const ct = Number(lg.stdout.trim())
    const lastCommitAt = isCodeZero(lg.code) && Number.isFinite(ct) ? ct : undefined

    // 5. Assign.
    const parsed = parseStatusV2(st.stdout)
    const repoState = classifyState(gitDir, parsed)
    const { branch, rebaseProgress } = resolveBranch(gitDir, repoState, parsed)
    if (branch !== undefined) entry.branch = branch; else delete entry.branch
    entry.repoState = repoState
    if (rebaseProgress !== undefined) entry.rebaseProgress = rebaseProgress; else delete entry.rebaseProgress
    entry.uncommittedCount = parsed.uncommittedCount
    if (lastCommitAt !== undefined) entry.lastCommitAt = lastCommitAt; else delete entry.lastCommitAt
    entry.metaStatus = 'ok'
    entry.metaCheckedAt = Date.now()
    delete entry.metaReason
    backoff.set(entry.path, { consecutiveTimeouts: 0, skipCycles: 0 })
  }

  /**
   * Surfaced repos only — never the dropped list. Bounded by
   * min(metadataConcurrency, entries); mapBounded re-checks the signal at the
   * top of every worker iteration. The pass NEVER throws: runGit never
   * rejects, every fs read is guarded, and anything unexpected is mapped to
   * the closed-set `git-error` — the scheduler would otherwise serve the
   * exception's text verbatim as lastErrorMessage.
   */
  async function readAll(cfg: ReposConfig, signal: AbortSignal): Promise<void> {
    await mapBounded([...table.values()], cfg.metadataConcurrency, signal, async (entry) => {
      try { await readOne(entry, cfg.metadataTimeoutMs) } catch { setUnavailable(entry, 'git-error') }
    })
  }

  function buildData(cfg: ReposConfig): ReposData {
    return {
      repos: [...table.values()].sort(byPath),
      dropped: [...dropped],
      errors: [...errors],
      scannedAt,
      staleDays: cfg.staleDays,
    }
  }

  /**
   * RULE: every schedule branch returns the FULL merged ReposData. The
   * scheduler's `last` map is keyed by provider id alone, so a branch
   * returning a metadata-only fragment would overwrite the repo list in
   * snapshot() every 30 seconds. Per-schedule keying of `last` is deferred
   * debt; this rule plus T7's test 25 and T8's test 13 stand in for it. The default
   * branch is TOTAL: an unknown schedule name never throws and never returns
   * a partial object.
   *
   * Nothing here throws: a missing or unreadable root, a broken candidate and
   * a timed-out git call are all reported on the closed-set channels
   * (`errors`, `dropped`), never as an exception — whose message the
   * scheduler would otherwise serve verbatim as lastErrorMessage.
   */
  async function fetch(cfg: ReposConfig, ctx: FetchCtx<ReposData>): Promise<ReposData> {
    lastCfg = cfg
    switch (ctx.schedule) {
      case 'discovery': {
        const outcome = await discover(cfg, resolved, ctx.signal)
        if (ctx.signal.aborted) return buildData(cfg)
        // Rebuilt IN PLACE; a repo already in the table keeps its metadata
        // across the rebuild, so a 10-minute discovery does not blank every
        // row until the next 30-second metadata cycle. Backoff entries for
        // repos that vanished are dropped with them.
        const prev = new Map(table)
        table.clear()
        for (const r of outcome.repos) {
          const old = prev.get(r.path)
          if (old !== undefined) carryMeta(old, r)
          table.set(r.path, r)
        }
        for (const k of backoff.keys()) if (!table.has(k)) backoff.delete(k)
        dropped = outcome.dropped
        errors = outcome.errors
        scannedAt = Date.now()
        return buildData(cfg)
      }
      case 'metadata': {
        // Returns the FULL merged Data (see the rule above), never a
        // metadata-only delta. An already-aborted signal issues no git call.
        // Measured wall-clock for one cycle over this task's fixture set:
        // recorded below once the fixtures exist (step "measure").
        if (ctx.signal.aborted) return buildData(cfg)
        await readAll(cfg, ctx.signal)
        return buildData(cfg)
      }
      default:
        return buildData(cfg)
    }
  }

  const provider: Provider<ReposConfig, ReposData> = {
    id: 'repos',
    configSchema: reposConfigSchema,
    // First run (detect → confirm → persist) is deferred by this plan; detect
    // stays a required contract member with no caller.
    detect: async () => ({ kind: 'nothing-to-detect', reason: 'first run is not implemented in this slice' }),
    schedules: [
      { name: 'discovery', intervalMs: DISCOVERY_INTERVAL_MS, runOnStart: true },
      { name: 'metadata', intervalMs: METADATA_INTERVAL_MS, runOnStart: true },
    ],
    fetch,
    toClient: reposToClient,
    // Getters, not values: a snapshot captured here would validate against
    // an empty table (and an undefined config) forever. Only the surfaced
    // table is passed — `dropped` is a separate collection resolveTarget
    // never sees.
    actions: createReposActions({ repos: () => table, config: () => lastCfg }),
  }
  return provider
}
