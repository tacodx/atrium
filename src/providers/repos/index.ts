import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { runGit } from '../../core/rungit.ts'
import type { FetchCtx, Provider } from '../../core/contract.ts'
import { reposConfigSchema, type ReposConfig } from './config.ts'

/**
 * The repos provider, discovery half (Task 7): walk the configured roots,
 * find repository candidates, put each through a validity gate built on
 * `rev-parse --absolute-git-dir`'s EXIT CODE plus a gitdir-vs-candidate
 * containment comparison, then run each survivor through a five-row,
 * first-match-wins classifier (worktree → submodule → vendored → container →
 * ambiguous). Dropped candidates are reported in Data, never silently
 * discarded. Per-repo metadata and the exec actions are Task 8's.
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

/** `path` and `gitDir` are absolute and realpath-resolved; `name` is `basename(path)`. */
export interface RepoEntry {
  id: string
  path: string
  name: string
  gitDir: string
  bare: boolean
  origin: 'top-level' | 'container-child'
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
const CLASSIFY_CONCURRENCY = 8
const MAX_SCAN_DEPTH = 8
const PRUNE_DIR_NAMES = new Set(['node_modules'])

// --- C. The walker -------------------------------------------------------------

interface ScanState {
  candidates: Set<string>
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
    const real = safeRealpath(dir)
    if (real !== undefined) state.candidates.add(real)
    // A bare repo's objects/ and refs/ subtrees are not projects. A non-bare
    // candidate IS descended into: nested repos are the whole point of the
    // container rule.
    if (bare) return
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
  const state: ScanState = { candidates: new Set(), errors: [] }
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
async function gate(candidate: string, timeoutMs: number): Promise<Verdict> {
  const r = await runGit(candidate, ['rev-parse', '--absolute-git-dir'], { timeoutMs })
  if (r.timedOut) return { kind: 'dropped', path: candidate, reason: 'timed-out' }
  if (!isCodeZero(r.code)) return { kind: 'dropped', path: candidate, reason: 'invalid' }

  const raw = r.stdout.trim()
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
  const candidates = [...scan.candidates].sort()

  // One bad repository must never abort the scan: a candidate that throws
  // anything unexpected is recorded on the closed-set channel and dropped.
  const verdicts = await mapBounded(candidates, CLASSIFY_CONCURRENCY, signal, async (c): Promise<Verdict> => {
    try {
      return await gate(c, deps.classifyTimeoutMs)
    } catch {
      errors.push('candidate-error')
      return { kind: 'dropped', path: c, reason: 'invalid' }
    }
  })

  const valid: GateResult[] = []
  for (const v of verdicts) {
    if (v === undefined) continue
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
    })
  })

  return { repos: repos.sort(byPath), dropped: dropped.sort(byPath), errors }
}


// --- G. Redaction ----------------------------------------------------------------

/**
 * The wire types. Task 8 EXTENDS `RepoWire` with its metadata fields and
 * extends the allowlist to match; Task 9 imports both interfaces type-only.
 */
export interface RepoWire { id: string; path: string; name: string; bare: boolean; origin: 'top-level' | 'container-child' }
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
 * `name` only. No raw git stdout/stderr is ever stored on an entry, so
 * nothing but parsed scalars can reach here.
 */
export function reposToClient(data: ReposData): ReposWire {
  return {
    repos: data.repos.map((r) => ({ id: r.id, path: r.path, name: r.name, bare: r.bare, origin: r.origin })),
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
  // `lastCfg` is set at the top of fetch; Task 8's action layer reads it
  // through a getter (exec actions get no cfg).
  const table = new Map<string, RepoEntry>()
  let dropped: DroppedCandidate[] = []
  let errors: ReposErrorCode[] = []
  let scannedAt = 0
  let lastCfg: ReposConfig | undefined

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
   * debt; this rule plus test 25 is what stands in for it. The default
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
        table.clear()
        for (const r of outcome.repos) table.set(r.path, r)
        dropped = outcome.dropped
        errors = outcome.errors
        scannedAt = Date.now()
        return buildData(cfg)
      }
      case 'metadata':
        // Task 8 replaces this branch body with the per-repo metadata pass.
        return buildData(cfg)
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
    actions: [], // Task 8 fills this.
  }
  return provider
}
