import type { ProviderStatus } from '../../../src/core/wire'
import type { ReposWire, RepoWire, RepoState, ReposErrorCode } from '../../../src/providers/repos/index'

// The repos pane: one pure derivation plus one pure component, so both are
// testable with react-dom/server under `bun test` with no DOM and no jsdom.
// Nothing here fetches, subscribes, or holds module state — main.tsx owns the
// socket, the store and the token.
//
// The two imports above are TYPE-ONLY and must stay that way: a value import
// from the server tree drags node:child_process into the browser bundle.
// The wire shapes are never re-declared locally — a second declaration is how
// the pane and the provider drift apart.
//
// Ruling D: Tailwind utility classes only. No inline style prop, no inline
// stylesheet, no markup injected as a raw HTML string. The shipped CSP is
// default-src 'self' with no style-src and no 'unsafe-inline', the failure is
// silent in the browser, and scripts/assert-package.ts uses fetch so it can
// structurally never observe a CSP violation. The test/repos-pane.test.ts test
// 'the pane source contains no injection sink and no value import from src/'
// greps this file's source text for those three sinks.
//
// SS8.7 plus Ruling F: repo names, branch names, absolute paths and the
// `reason` string are all attacker-controlled or raw exception text. They
// reach the DOM only as React children or as plain string attributes. `reason`
// in particular is display-only: never parsed, never used to build a URL or a
// path, never an action target.

export interface RepoRow extends RepoWire {}

/**
 * What discovery could not show, as COUNTS only. A dropped row's `name` is
 * basename(path) of a directory anyone can create (SS8.7) — for a probe root,
 * the operator's username — so no name and no path is carried here.
 * worktree / submodule / vendored are deliberately NOT counted: each is a
 * measured verdict that the candidate is not a project, and a count would be
 * a permanent line on every machine that has a worktree. timed-out and
 * invalid are counted: a slow disk or a broken .git pointer must not make a
 * repo vanish without a word (ADR 0002, "Measured — the timedOut channel").
 *
 * `invalid` includes one deliberate verdict the wire cannot tell apart: an
 * extraRoot that is a subdirectory of a repository is dropped as invalid by
 * the gate's containment check (it is not a repository root; the repository
 * itself surfaces). It is counted like any other invalid drop, which is why
 * the invalid note is neutral grey and names both causes, never amber.
 */
export interface ScanDiagnostics {
  timedOut: number
  invalid: number
  /** A MULTISET count per closed-set code; every code present, 0 when absent. */
  errors: Record<ReposErrorCode, number>
}

export type ReposPaneState =
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'empty'; droppedAmbiguous: string[]; diagnostics: ScanDiagnostics }
  | { kind: 'ready'; needsAttention: RepoRow[]; recent: RepoRow[]; droppedAmbiguous: string[]; diagnostics: ScanDiagnostics }

export interface ReposPaneInput {
  hasSnapshot: boolean
  providers: Record<string, ProviderStatus>
  nowMs: number
}

const MS_PER_DAY = 86_400_000

/**
 * The branch ORDER is the specification, and two of its steps are mandatory
 * mutation rows:
 *
 *  - step 3 distinguishes `unavailable` (the provider ran and failed) from
 *    `empty` (the provider ran and found nothing). Collapsing them reports a
 *    broken scan as "you have no repositories", which is the exact defect
 *    shape this project has shipped before (M1).
 *  - the provider id is the literal 'repos' (Ruling A). There is no `git` key
 *    anywhere in this file (M10).
 *
 * Absent, not null, throughout: the provider omits an unknown optional field
 * entirely, so every optional read here is `=== undefined`.
 */
export function deriveReposPaneState(input: ReposPaneInput): ReposPaneState {
  if (!input.hasSnapshot) return { kind: 'loading' }

  const entry = input.providers['repos']
  // Registered but not yet run: the scheduler creates no entry until a
  // provider has either succeeded or failed.
  if (entry === undefined) return { kind: 'loading' }

  if (entry.data === undefined) {
    // No successful run yet. A failure record on ANY schedule is what turns
    // this into `unavailable`; Object.values preserves Object.keys order, so
    // the first recorded failure wins deterministically.
    for (const health of Object.values(entry.schedules)) {
      if (health.consecutiveFailures > 0) {
        return { kind: 'unavailable', reason: health.lastErrorMessage ?? 'provider failed' }
      }
    }
    return { kind: 'loading' }
  }

  const wire = entry.data as ReposWire
  // NAMES, not paths: a dropped candidate deliberately carries no path on
  // the wire, because it is not an action target (SS7.1). Derived BEFORE the
  // zero-repo branch: an all-ambiguous scan is not "no repositories found".
  const droppedAmbiguous = wire.dropped.filter((d) => d.reason === 'ambiguous').map((d) => d.name)
  const diagnostics = scanDiagnostics(wire)
  if (wire.repos.length === 0) return { kind: 'empty', droppedAmbiguous, diagnostics }

  // (a) The connective is `&&`, never `||`: an old clean repo is finished, not
  //     rotting (SS7.1, M2).
  // (b) An ABSENT lastCommitAt is never stale, however many uncommitted files
  //     the repo has — an empty repo has no commit to age, and a repo whose
  //     metadata is unavailable carries no count anybody could trust. The
  //     `?? 0` exists for the same reason (M3).
  // (c) Strict `>`, seconds->ms on lastCommitAt, days->ms on staleDays.
  const isStale = (r: RepoWire) =>
    r.lastCommitAt !== undefined && input.nowMs - r.lastCommitAt * 1000 > wire.staleDays * MS_PER_DAY
  const needsAttention = (r: RepoWire) => isStale(r) && (r.uncommittedCount ?? 0) > 0

  // Recent-first: descending lastCommitAt, an undated repo after every dated
  // one, ties (including two undated repos) on name ascending. One comparator
  // for both groups, so the ordering test pins both (M4).
  const byRecency = (a: RepoWire, b: RepoWire): number => {
    const at = a.lastCommitAt
    const bt = b.lastCommitAt
    if (at !== bt) {
      if (at === undefined) return 1
      if (bt === undefined) return -1
      return bt - at
    }
    return a.name.localeCompare(b.name)
  }

  // Exactly one group per repo: one pass, one destination.
  const attention: RepoRow[] = []
  const recent: RepoRow[] = []
  for (const r of wire.repos) {
    if (needsAttention(r)) attention.push(r)
    else recent.push(r)
  }
  attention.sort(byRecency)
  recent.sort(byRecency)

  return {
    kind: 'ready',
    needsAttention: attention,
    recent,
    droppedAmbiguous,
    diagnostics,
  }
}

function scanDiagnostics(wire: ReposWire): ScanDiagnostics {
  // Every key spelled out: typed Record<ReposErrorCode, number>, a fourth code
  // is a typecheck failure here, not a silently uncounted one.
  const errors: Record<ReposErrorCode, number> = { 'root-missing': 0, 'root-unreadable': 0, 'candidate-error': 0 }
  // Counted, never de-duplicated: two mistyped extraRoots are two entries.
  for (const code of wire.errors) errors[code] += 1
  return {
    timedOut: wire.dropped.filter((d) => d.reason === 'timed-out').length,
    invalid: wire.dropped.filter((d) => d.reason === 'invalid').length,
    errors,
  }
}

/**
 * Takes the WHOLE repo, not a state value: the provider carries the state as a
 * flat string union with `branch` and `rebaseProgress` as sibling fields.
 *
 * The switch has no `default` branch and ends in a `never` assignment, so a
 * future RepoState member fails `bun run typecheck` instead of silently
 * rendering nothing.
 */
export function stateLabel(repo: RepoWire): string {
  // An unavailable repo has had repoState deleted along with every other
  // metadata field, so it must label itself rather than guess (M12).
  if (repo.metaStatus === 'unavailable') return `unavailable (${repo.metaReason ?? 'unknown'})`
  if (repo.repoState === undefined) return 'unavailable (unknown)'
  const st: RepoState = repo.repoState
  switch (st) {
    case 'clean':
      return 'clean'
    case 'detached':
      return 'detached'
    case 'merging':
      return 'merging'
    case 'cherry-picking':
      return 'cherry-picking'
    case 'reverting':
      return 'reverting'
    case 'bisecting':
      return 'bisecting'
    case 'empty':
      return 'empty'
    case 'rebasing': {
      // SS7.1: a rebase renders its REAL branch and step, never a bare
      // detached label (M5). rebaseProgress is absent when the rebase state
      // files are unreadable.
      const branch = repo.branch ?? '(unknown branch)'
      const p = repo.rebaseProgress
      return p === undefined ? `rebasing ${branch}` : `rebasing ${branch} ${p.current}/${p.total}`
    }
  }
  const _never: never = st
  return _never
}

// Constructed once at module scope, with the LITERAL locale 'en' — the ambient
// system locale would make every assertion machine-dependent. No new
// dependency: Intl.RelativeTimeFormat is present in bun 1.3.11.
const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

/** `undefined` is an empty repo, not an error (SS7.1). */
export function relativeCommitTime(lastCommitAt: number | undefined, nowMs: number): string {
  if (lastCommitAt === undefined) return 'no commits yet'
  const deltaSec = Math.round(lastCommitAt - nowMs / 1000)
  for (const [unit, secs] of UNITS) {
    if (Math.abs(deltaSec) >= secs) return RTF.format(Math.round(deltaSec / secs), unit)
  }
  return RTF.format(deltaSec, 'second')
}

// Tone, as literal class strings (Ruling D: Tailwind finds utilities by
// scanning source text, so a class built by interpolation is never emitted).
// AMBER is for a failure the operator can act on or that should not persist:
// a missing root (a mistyped extraRoot), a check that threw, a git that timed
// out. GREY is for what may be permanent by design: an unreadable folder
// (root-owned 0700 volumes are common under $HOME), an invalid drop (which
// includes the deliberate containment verdict above), and ambiguous.
const WARN = 'text-xs text-amber-700'
const QUIET = 'text-xs text-gray-500'

// Closed-set wording and tone, one line per code. Typed
// Record<ReposErrorCode, ...>, so a new code fails typecheck (TS2741) instead
// of being counted and never rendered; ERROR_ORDER must list every code too,
// or the assignment below fails. `root-unreadable` is pushed for ANY
// directory the walk cannot list, at any depth — not only a root.
const ERROR_NOTES: Record<ReposErrorCode, { text: string; className: string }> = {
  'root-missing': { text: 'scan root(s) not found — check repos.extraRoots', className: WARN },
  'root-unreadable': { text: 'folder(s) could not be read', className: QUIET },
  'candidate-error': { text: 'candidate(s) could not be checked', className: WARN },
}
const ERROR_ORDER = ['root-missing', 'root-unreadable', 'candidate-error'] as const
const EVERY_CODE_ORDERED: [Exclude<ReposErrorCode, (typeof ERROR_ORDER)[number]>] extends [never] ? true : false = true
void EVERY_CODE_ORDERED

type NoteId = ReposErrorCode | 'timed-out' | 'invalid' | 'ambiguous'
interface ScanNote { id: NoteId; text: string; className: string }

/**
 * Counts and closed-set codes only; `id` is a code, never a name. The ORDER is
 * fixed and pinned: root-missing, root-unreadable, candidate-error, timed-out,
 * invalid, ambiguous — what stopped the scan first, what hid a repo last.
 */
function scanNotes(droppedAmbiguous: string[], d: ScanDiagnostics): ScanNote[] {
  const notes: ScanNote[] = []
  const add = (id: NoteId, n: number, text: string, className: string) => {
    if (n > 0) notes.push({ id, text: `${n} ${text}`, className })
  }
  for (const code of ERROR_ORDER) add(code, d.errors[code], ERROR_NOTES[code].text, ERROR_NOTES[code].className)
  add('timed-out', d.timedOut, 'candidate(s) hidden: git timed out', WARN)
  add('invalid', d.invalid, 'candidate(s) hidden as invalid (a broken .git, or a scan root inside a repository)', QUIET)
  // Reported, never silently decided (SS7.1), and never actionable: the
  // adopt-a-candidate flow is deferred out of this plan.
  add('ambiguous', droppedAmbiguous.length, 'candidate(s) hidden as ambiguous', QUIET)
  return notes
}

export interface ReposPaneProps {
  state: ReposPaneState
  nowMs: number
  onAction(actionId: string, path: string): void
}

const ACTIONS: readonly (readonly [string, string])[] = [
  ['open-editor', 'Editor'],
  ['open-terminal', 'Terminal'],
  ['open-claude', 'Claude'],
]

interface RepoGroupProps {
  heading: string
  repos: RepoRow[]
  nowMs: number
  onAction(actionId: string, path: string): void
}

/**
 * `type="button"` is not decoration: a bare button inside a form defaults to
 * submit. There is no anchor and no form anywhere in this file — the server
 * dispatches an action only on POST, and a GET on an action path is a 404 with
 * the handler never run (M7).
 */
function RepoGroup(props: RepoGroupProps) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide">{props.heading}</h2>
      <ul className="flex flex-col gap-2">
        {props.repos.map((repo) => (
          <li
            key={repo.id}
            data-repo={repo.path}
            className="flex flex-wrap items-center gap-3 rounded border border-gray-200 p-2"
          >
            <span className="font-medium">{repo.name}</span>
            <span className="text-sm">{repo.branch ?? '—'}</span>
            <span className="text-sm">{stateLabel(repo)}</span>
            <span className="text-sm">{relativeCommitTime(repo.lastCommitAt, props.nowMs)}</span>
            <span className="text-sm">{`${repo.uncommittedCount ?? 0} uncommitted`}</span>
            {ACTIONS.map(([actionId, label]) => (
              <button
                type="button"
                key={actionId}
                data-action={actionId}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
                onClick={() => props.onAction(actionId, repo.path)}
              >
                {label}
              </button>
            ))}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * One root element for every branch. `data-state` is what makes the three
 * non-populated branches mechanically distinguishable; each branch also
 * renders its own distinct human text.
 */
export function ReposPane(props: ReposPaneProps) {
  const state = props.state
  const notes =
    state.kind === 'ready' || state.kind === 'empty' ? scanNotes(state.droppedAmbiguous, state.diagnostics) : []
  return (
    <section data-pane="repos" data-state={state.kind} className="flex flex-col gap-3">
      {state.kind === 'loading' ? <p className="text-sm">Loading repositories…</p> : null}
      {state.kind === 'unavailable' ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Repositories unavailable</p>
          <p className="text-sm">{state.reason}</p>
        </div>
      ) : null}
      {/* A zero-repo scan with anything hidden or any error is NOT "found
          nothing": a mistyped extraRoot must not read as an empty machine. */}
      {state.kind === 'empty' ? (
        <p className="text-sm">{notes.length === 0 ? 'No repositories found' : 'No repositories shown'}</p>
      ) : null}
      {state.kind === 'ready' ? (
        <>
          {state.needsAttention.length > 0 ? (
            <RepoGroup
              heading="Needs attention"
              repos={state.needsAttention}
              nowMs={props.nowMs}
              onAction={props.onAction}
            />
          ) : null}
          <RepoGroup heading="Recent" repos={state.recent} nowMs={props.nowMs} onAction={props.onAction} />
        </>
      ) : null}
      {/* Shared by ready AND empty: a root-missing error with zero repos must
          still say so. */}
      {notes.length > 0 ? (
        <ul data-scan-notes="" className="flex flex-col gap-1">
          {notes.map((n) => (
            <li key={n.id} data-note={n.id} className={n.className}>
              {n.text}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
