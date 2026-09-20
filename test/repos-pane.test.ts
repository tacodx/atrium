import { test, expect } from 'bun:test'
import { createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ReposPane,
  deriveReposPaneState,
  relativeCommitTime,
  stateLabel,
  type RepoRow,
  type ReposPaneState,
} from '../web/src/panes/ReposPane'
import { postReposAction } from '../web/src/lib/api'
import type { ProviderStatus } from '../src/core/wire'
import type { RepoWire, ReposWire } from '../src/providers/repos/index'
import { makeRepoIn } from './fixtures/gitrepo'
import { openSession } from './fixtures/ws'

// Elements are built with createElement and rendered with renderToStaticMarkup:
// no DOM, no jsdom, no new dependency, and the file stays `.ts` as the scoping
// doc specifies.
//
// Every fixture constant below is a literal. Nothing is derived from $HOME
// (design spec SS10 rule 1) and nothing is derived from the clock — NOW_MS is a
// fixed instant, so the relative-time assertions are machine-independent.

const ROOT = join(import.meta.dir, '..')

const NOW_MS = Date.UTC(2026, 8, 14, 12, 0, 0)
const NOW_S = NOW_MS / 1000

// `echo`'s and `foxtrot`'s `branch` and `lastCommitAt` keys are GENUINELY
// ABSENT, not present-and-undefined: the provider omits them, and a fixture
// that spelled them out as undefined would hide a `=== null` bug in the pane.
//
// Three of these eight repos exist only to make a stated property FAIL when it
// is broken, each measured green without them:
//
//  - `golf` shares `alpha`'s lastCommitAt and is listed BEFORE it while sorting
//    AFTER it by name, and `foxtrot` does the same against `echo` on the undated
//    side. Array.prototype.sort is stable, so a comparator whose tie-break
//    became `return 0` would leave both pairs in this listed order — which is
//    the only reason test 7's equality can see the tie-break at all (M20). Both
//    pairs are needed: the spec names the undated-vs-undated tie explicitly.
//  - `hotel`'s last commit sits on the staleness boundary EXACTLY, which is the
//    only fixture the strict `>` in isStale decides (M19).
//
// `dropped` carries a second row whose reason is NOT 'ambiguous', because with
// one already-ambiguous row the `.filter` in the derivation could be deleted
// outright and stay green (M21). That the 'timed-out' row reaches no surface at
// all is Lens B's M-5, carried to Task 10, not asserted here.
const READY_WIRE: ReposWire = {
  staleDays: 30,
  scannedAt: NOW_MS,
  errors: [],
  dropped: [
    { id: 'd1', name: 'ambig', reason: 'ambiguous' },
    { id: 'd2', name: 'slowpoke', reason: 'timed-out' },
  ],
  repos: [
    {
      id: 'golf', path: '/fixtures/golf', name: 'golf', bare: false, origin: 'top-level',
      metaStatus: 'ok', branch: 'main', repoState: 'clean',
      lastCommitAt: NOW_S - 7200, uncommittedCount: 0,
    },
    {
      id: 'alpha', path: '/fixtures/alpha', name: 'alpha', bare: false, origin: 'top-level',
      metaStatus: 'ok', branch: 'main', repoState: 'clean',
      lastCommitAt: NOW_S - 7200, uncommittedCount: 0,
    },
    {
      id: 'bravo', path: '/fixtures/bravo', name: 'bravo', bare: false, origin: 'top-level',
      metaStatus: 'ok', branch: 'feat/x', repoState: 'rebasing', rebaseProgress: { current: 2, total: 5 },
      lastCommitAt: NOW_S - 90 * 86400, uncommittedCount: 3,
    },
    {
      id: 'charlie', path: '/fixtures/charlie', name: 'charlie', bare: false, origin: 'top-level',
      metaStatus: 'ok', branch: 'main', repoState: 'clean',
      lastCommitAt: NOW_S - 120 * 86400, uncommittedCount: 0,
    },
    {
      id: 'delta', path: '/fixtures/delta', name: 'delta', bare: false, origin: 'top-level',
      metaStatus: 'ok', branch: 'main', repoState: 'clean',
      lastCommitAt: NOW_S - 3600, uncommittedCount: 12,
    },
    {
      id: 'hotel', path: '/fixtures/hotel', name: 'hotel', bare: false, origin: 'top-level',
      metaStatus: 'ok', branch: 'main', repoState: 'clean',
      lastCommitAt: NOW_S - 30 * 86400, uncommittedCount: 1,
    },
    {
      id: 'foxtrot', path: '/fixtures/foxtrot', name: 'foxtrot', bare: false, origin: 'top-level',
      metaStatus: 'ok', repoState: 'empty', uncommittedCount: 0,
    },
    {
      id: 'echo', path: '/fixtures/echo', name: 'echo', bare: false, origin: 'top-level',
      metaStatus: 'ok', repoState: 'empty', uncommittedCount: 4,
    },
  ],
}

const FAILING_SNAPSHOT: Record<string, ProviderStatus> = {
  repos: {
    schedules: {
      discovery: {
        lastSuccessAt: null,
        consecutiveFailures: 3,
        lastErrorMessage: 'ENOENT: no such file or directory',
      },
    },
  },
}

const EMPTY_SNAPSHOT: Record<string, ProviderStatus> = {
  repos: {
    data: { repos: [], dropped: [], errors: [], scannedAt: NOW_MS, staleDays: 30 },
    schedules: {},
  },
}

type ReadyState = Extract<ReposPaneState, { kind: 'ready' }>

function derive(providers: Record<string, ProviderStatus>, hasSnapshot = true): ReposPaneState {
  return deriveReposPaneState({ hasSnapshot, providers, nowMs: NOW_MS })
}

function readyFrom(wire: ReposWire): ReadyState {
  const s = derive({ repos: { data: wire, schedules: {} } })
  if (s.kind !== 'ready') throw new Error(`expected a ready state, got ${s.kind}`)
  return s
}

function render(state: ReposPaneState): string {
  return renderToStaticMarkup(createElement(ReposPane, { state, nowMs: NOW_MS, onAction: () => {} }))
}

// --- The action-button walk ---------------------------------------------------
//
// No DOM library and no new dependency. `ReposPane` and `RepoGroup` are pure
// function components with no hooks, so calling `node.type(node.props)` IS the
// whole render, and the tree it returns still carries the real onClick
// closures. Walking it is therefore a genuine click on every action button —
// which renderToStaticMarkup structurally cannot give, because it throws the
// handlers away and keeps only the attributes.

type AnyProps = Record<string, unknown>

interface ActionButton {
  /** `data-repo` of the enclosing row, inherited down the walk. */
  repoPath: string | undefined
  actionId: string
  click: () => void
}

function collectActionButtons(node: unknown, repoPath: string | undefined, out: ActionButton[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectActionButtons(child, repoPath, out)
    return
  }
  // Bound to a local first: a type predicate narrows a REFERENCE, never a cast
  // expression, so inlining the assertion leaves `node` unknown under tsc.
  const candidate = node as {} | null | undefined
  if (!isValidElement<AnyProps>(candidate)) return
  const props = candidate.props
  if (typeof candidate.type === 'function') {
    collectActionButtons((candidate.type as (p: AnyProps) => unknown)(props), repoPath, out)
    return
  }
  // A Fragment's type is a symbol: it carries no data-repo and no data-action,
  // so it falls through to the children walk below, which is correct.
  const rowPath = typeof props['data-repo'] === 'string' ? props['data-repo'] : repoPath
  const actionId = props['data-action']
  if (typeof actionId === 'string') {
    const onClick = props['onClick']
    if (typeof onClick !== 'function') throw new Error(`data-action="${actionId}" carries no onClick`)
    out.push({ repoPath: rowPath, actionId, click: onClick as () => void })
  }
  collectActionButtons(props['children'], rowPath, out)
}

function actionButtonsOf(
  state: ReposPaneState,
  onAction: (actionId: string, path: string) => void,
): ActionButton[] {
  const out: ActionButton[] = []
  collectActionButtons(createElement(ReposPane, { state, nowMs: NOW_MS, onAction }), undefined, out)
  return out
}

// --- Derivation cases ---------------------------------------------------------

test('derives loading before the first snapshot frame', () => {
  // A POPULATED providers map, deliberately: with `providers: {}` this test
  // passed on step 2's absent-entry branch, so deleting step 1's hasSnapshot
  // guard entirely was measured green (M18). Handed a snapshot that WOULD
  // derive `ready`, the assertion can only pass through step 1.
  expect(derive({ repos: { data: READY_WIRE, schedules: {} } }, false).kind).toBe('loading')
})

test('derives loading when the snapshot carries no repos entry yet', () => {
  expect(derive({}).kind).toBe('loading')
})

test('derives unavailable from the failure record, never empty', () => {
  const s = derive(FAILING_SNAPSHOT)
  expect(s.kind).toBe('unavailable')
  expect(s.kind === 'unavailable' ? s.reason : undefined).toBe('ENOENT: no such file or directory')
})

test('derives empty only when the provider succeeded with zero repos', () => {
  expect(derive(EMPTY_SNAPSHOT).kind).toBe('empty')
})

test('needs attention requires BOTH staleness and uncommitted changes', () => {
  // A WHOLE-ARRAY equality, never toContain: an OR connective would add
  // charlie (stale, clean) and delta (fresh, dirty) and a containment
  // assertion would not notice.
  expect(readyFrom(READY_WIRE).needsAttention.map((r) => r.name)).toEqual(['bravo'])
})

test('a repo with no commits is never stale, however dirty', () => {
  const s = readyFrom(READY_WIRE)
  expect(s.recent.map((r) => r.name)).toContain('echo')
  expect(s.needsAttention.map((r) => r.name)).not.toContain('echo')
})

test('a repo exactly on the staleness boundary is not yet stale', () => {
  // `hotel`'s last commit is at EXACTLY nowMs - staleDays * MS_PER_DAY, so the
  // strict `>` in isStale is the ONLY thing deciding it, and it carries
  // uncommittedCount 1 so a `>=` moves it into needsAttention rather than
  // merely relabelling it. Without a fixture on the boundary, `>` -> `>=` was
  // measured green (M19). The first assertion pins that the fixture really is
  // on the boundary: nudging that literal later would silently un-pin the rest.
  const hotel = READY_WIRE.repos.find((r) => r.name === 'hotel')!
  expect(hotel.lastCommitAt).toBe(NOW_S - READY_WIRE.staleDays * 86400)
  const s = readyFrom(READY_WIRE)
  expect(s.needsAttention.map((r) => r.name)).not.toContain('hotel')
  expect(s.recent.map((r) => r.name)).toContain('hotel')
})

test('recent is ordered most-recent-first with undated repos last', () => {
  // Both ties are load-bearing, and both are listed in READY_WIRE in the
  // opposite order to the one asserted here: golf before alpha, foxtrot before
  // echo. sort is stable, so a tie-break of `return 0` yields the listed order
  // and this equality sees it (M20).
  expect(readyFrom(READY_WIRE).recent.map((r) => r.name)).toEqual([
    'delta', 'alpha', 'golf', 'hotel', 'charlie', 'echo', 'foxtrot',
  ])
})

test('a repo appears in exactly one group', () => {
  const s = readyFrom(READY_WIRE)
  const all = [...s.needsAttention, ...s.recent].map((r) => r.name)
  expect(all.length).toBe(8)
  expect(new Set(all).size).toBe(8)
})

test('droppedAmbiguous is reported, not discarded', () => {
  const s = readyFrom(READY_WIRE)
  // AMBIGUOUS only. READY_WIRE also drops `slowpoke` with reason 'timed-out',
  // so removing the `.filter(d => d.reason === 'ambiguous')` from the
  // derivation reddens this equality; with one already-ambiguous row it was
  // measured green (M21).
  expect(s.droppedAmbiguous).toEqual(['ambig'])
  const html = render(s)
  expect(html).toContain('1 candidate(s) hidden as ambiguous')
  // The plan asks here for "the rendered markup contains no /fixtures/ string".
  // That is unrealisable and contradicts test 15: every SURFACED repo's row
  // carries data-repo="/fixtures/<name>" by design. The property the plan
  // actually wants is that a DROPPED candidate contributes no path and no row,
  // which is what these two assertions pin.
  expect(html).not.toContain('/fixtures/ambig')
  expect(html.split('data-repo=').length - 1).toBe(8)
})

// --- Presentation cases -------------------------------------------------------

test('relativeCommitTime renders fixed English units and a no-commit case', () => {
  expect(relativeCommitTime(NOW_S - 7200, NOW_MS)).toBe('2 hours ago')
  expect(relativeCommitTime(NOW_S - 90 * 86400, NOW_MS)).toBe('3 months ago')
  expect(relativeCommitTime(undefined, NOW_MS)).toBe('no commits yet')
})

test('a rebasing repo renders its real branch and step, never a bare detached', () => {
  const bravo = READY_WIRE.repos.find((r) => r.name === 'bravo')!
  expect(stateLabel(bravo)).toBe('rebasing feat/x 2/5')
  const html = render(readyFrom(READY_WIRE))
  expect(html).toContain('rebasing feat/x 2/5')
  expect(html).not.toContain('(detached)')
})

test('an unavailable repo labels itself unavailable rather than guessing a state', () => {
  // The exact shape the provider produces for a bare repo: repoState, branch
  // and uncommittedCount are all ABSENT.
  const bare: RepoWire = {
    id: 'bare', path: '/fixtures/bare', name: 'bare', bare: true, origin: 'top-level',
    metaStatus: 'unavailable', metaReason: 'bare',
  }
  expect(stateLabel(bare)).toBe('unavailable (bare)')
})

// --- Render cases -------------------------------------------------------------

test('the three non-populated states render three visibly distinct panes', () => {
  // Ruling F: `reason` is raw exception text on a channel that never passes
  // through toClient. It is display-only, so it must render ESCAPED (M13).
  const REASON = '<script>alert(1)</script> ENOENT'
  const loading = render({ kind: 'loading' })
  const unavailable = render({ kind: 'unavailable', reason: REASON })
  const empty = render({ kind: 'empty' })

  expect(loading).toContain('data-state="loading"')
  expect(loading).toContain('Loading repositories…')

  expect(unavailable).toContain('data-state="unavailable"')
  expect(unavailable).toContain('Repositories unavailable')
  expect(unavailable).toContain('&lt;script&gt;')
  expect(unavailable).not.toContain('<script>')
  expect(unavailable).toContain('ENOENT')

  expect(empty).toContain('data-state="empty"')
  expect(empty).toContain('No repositories found')

  expect(loading).not.toBe(unavailable)
  expect(loading).not.toBe(empty)
  expect(unavailable).not.toBe(empty)
})

test('an attacker-controlled branch name renders escaped', () => {
  const hostile: RepoRow = {
    id: 'h', path: '/fixtures/hostile', name: '<img src=x onerror=alert(1)>', bare: false,
    origin: 'top-level', metaStatus: 'ok', branch: '<script>alert(1)</script>',
    repoState: 'clean', lastCommitAt: NOW_S - 3600, uncommittedCount: 0,
  }
  const html = render({ kind: 'ready', needsAttention: [], recent: [hostile], droppedAmbiguous: [] })
  expect(html).toContain('&lt;script&gt;')
  expect(html).toContain('&lt;img')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('<img ')
})

test('actions are POST buttons, never links or forms', () => {
  const html = render(readyFrom(READY_WIRE))
  expect(html).toContain('data-action="open-editor"')
  expect(html).toContain('data-action="open-terminal"')
  expect(html).toContain('data-action="open-claude"')

  // A bare <button> inside a form defaults to submit, so type="button" is not
  // decoration. React emits attributes in source order, so the marker is
  // immediately after the tag name on every single button.
  const MARKER = '<button type="button"'
  let seen = 0
  for (let i = html.indexOf('<button'); i !== -1; i = html.indexOf('<button', i + 1)) {
    expect(html.slice(i, i + MARKER.length)).toBe(MARKER)
    seen += 1
  }
  expect(seen).toBe(24) // eight repos, three actions each

  expect(html).not.toContain('<a ')
  expect(html).not.toContain('<form')
})

test('clicking an action reports the action id and the repo path', () => {
  const state = readyFrom(READY_WIRE)
  const reported: [string, string][] = []
  const buttons = actionButtonsOf(state, (actionId, path) => {
    reported.push([actionId, path])
  })

  // Derived from the state, not hardcoded: every surfaced row in BOTH groups
  // must contribute its three handlers, so a group the walk never reaches
  // shows up here rather than passing silently.
  const rows = state.needsAttention.length + state.recent.length
  expect(buttons.length).toBe(rows * 3)

  const bravo = buttons.filter((b) => b.repoPath === '/fixtures/bravo')
  expect(bravo.length).toBe(3)
  for (const b of bravo) b.click()

  // A WHOLE-ARRAY equality on what the handler actually reports: the action id
  // first, the ABSOLUTE PATH second. `resolveTarget`
  // (src/providers/repos/actions.ts) validates an action target by exact string
  // equality against a table keyed on absolute realpath, so reporting
  // `repo.name` (M14) 400s all of them server-side, and swapping the pair (M15)
  // does the same — with the error discarded on both sides, which is why this
  // has to be asserted here rather than left to the server.
  expect(reported).toEqual([
    ['open-editor', '/fixtures/bravo'],
    ['open-terminal', '/fixtures/bravo'],
    ['open-claude', '/fixtures/bravo'],
  ])

  // The wiring, kept from the test this replaces.
  expect(typeof postReposAction).toBe('function')
  expect(readFileSync(join(ROOT, 'web/src/main.tsx'), 'utf8')).toContain('onAction={postReposAction}')
})

test('main.tsx still contains the literal p-4 the packaging gate depends on', () => {
  // Standing guard for scripts/assert-package.ts:119-131, whose Tailwind canary
  // is sourced solely from this one class name. Without this test the release
  // gate is the first thing to notice, and it fails with a message blaming a
  // Tailwind configuration problem that does not exist.
  expect(readFileSync(join(ROOT, 'web/src/main.tsx'), 'utf8')).toMatch(/\bp-4\b/)
})

test('the pane source contains no injection sink and no value import from src/', () => {
  const src = readFileSync(join(ROOT, 'web/src/panes/ReposPane.tsx'), 'utf8')
  for (const sink of ['dangerouslySetInnerHTML', 'new URL(', 'style={{']) {
    expect(src).not.toContain(sink)
  }
  // Match the SPECIFIER, not a substring. `l.includes('../src/')` had a
  // reachable bypass, verified by execution: `'../../../src'` with no trailing
  // slash contains no `../src/`, so the line was skipped entirely and the
  // assertion never ran on it — and `src/index.ts` exists, so that very
  // specifier resolves through the provider chain to node:child_process. The
  // half of this tripwire that keeps the server tree out of the browser bundle
  // was therefore itself untested in the direction that matters (M6 and M13
  // both redden this test through the SINK list, not through this line). The
  // form below catches the bypass and still matches the two genuine type
  // imports (M16).
  const fromServerTree = src.split('\n').filter((l) => /from\s+'[^']*(\.\.\/)+src(\/|')/.test(l))
  expect(fromServerTree.length).toBeGreaterThan(0)
  for (const line of fromServerTree) expect(line.startsWith('import type')).toBe(true)
})

test('the action POST carries the token in a header and the path in a body, never in a URL', () => {
  const src = readFileSync(join(ROOT, 'web/src/lib/api.ts'), 'utf8')

  // The token reaches postAction, the provider id is the LITERAL 'repos'
  // (Ruling A), and the target is `{ path }` — the shape resolveTarget reads.
  expect(src).toContain("postAction(token, 'repos', actionId, { path })")
  expect(src).toContain('authorization: `Bearer ${token}`')

  // SS8.3: the token travels in the Authorization header and NEVER in a URL.
  // This is a source grep because nothing else in the repo can observe it — the
  // pane offers no injection seam, and bun defines no `localStorage`, so a
  // behavioural test would have to install that global AND stub fetch. Without
  // these two lines a later move of the token into a query string ships fully
  // green, reopening SS8.3; M17 is exactly that move.
  expect(src).not.toMatch(/token=/)
  expect(src).not.toMatch(/`\/api\/[^`]*\$\{token\}/)

  // The two silences: a throwing localStorage (SecurityError when site data is
  // blocked) is a no-op rather than an unhandledrejection, and postAction's
  // { ok:false, error } — a 400 `unknown repository target` from resolveTarget
  // — is reported rather than dropped. The console is the only surface the
  // pinned `void` signature can reach; a pane-level error channel is T10's.
  expect(src).toMatch(/catch\s*{\s*return\s*}/)
  expect(src).toContain('if (!r.ok) console.error(')
})

// --- End-to-end smoke ---------------------------------------------------------

test('the assembled server serves the fixture repos over an authenticated /api/state', async () => {
  const PORT = 7424 // this task's only port, per the plan-wide port ledger
  const BASE = `http://127.0.0.1:${PORT}`
  const HOST = `127.0.0.1:${PORT}`
  const STALE_DAYS = 45 // deliberately NOT the default 30 — see the report

  const fixtureRoot = mkdtempSync(join(tmpdir(), 'atrium-t9-repos-'))
  const home = mkdtempSync(join(tmpdir(), 'atrium-t9-home-'))
  const configHome = mkdtempSync(join(tmpdir(), 'atrium-t9-config-'))
  const runtimeDir = mkdtempSync(join(tmpdir(), 'atrium-t9-run-'))
  const scratch = [fixtureRoot, home, configHome, runtimeDir]
  // The literal stdio types are on the annotation, not inferred: a widened
  // `ReturnType<typeof Bun.spawn>` types `stderr` as a union that includes
  // `number`, which `new Response(...)` rejects.
  let proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | undefined

  try {
    const names = ['smoke-one', 'smoke-two', 'smoke-three']
    for (const n of names) makeRepoIn(fixtureRoot, n)
    mkdirSync(join(configHome, 'atrium'), { recursive: true })
    writeFileSync(
      join(configHome, 'atrium', 'config.json'),
      JSON.stringify({ repos: { extraRoots: [fixtureRoot], staleDays: STALE_DAYS } }),
    )

    // A SUBPROCESS is required, not stylistic: os.homedir() is resolved from
    // $HOME at process start and is not affected by mutating process.env.HOME
    // in-process, so an in-process startServer would run discovery over the
    // developer's real $HOME.
    proc = Bun.spawn([process.execPath, 'run', 'src/index.ts', 'serve', '--port', String(PORT)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtimeDir },
      stdout: 'ignore',
      stderr: 'pipe',
    })

    // Poll, never sleep a fixed amount. /healthz needs the host header the gate
    // requires.
    let up = false
    for (let i = 0; i < 200; i++) {
      try {
        await fetch(`${BASE}/healthz`, { headers: { host: HOST } })
        up = true
        break
      } catch {
        await Bun.sleep(50)
      }
    }
    if (!up) throw new Error(`server never listened: ${await new Response(proc.stderr).text()}`)

    // The handoff comes off disk and travels in the POST BODY, never a query
    // string.
    const token = await openSession(PORT, runtimeDir)

    let body: Record<string, ProviderStatus> = {}
    const deadline = Date.now() + 15_000
    for (;;) {
      const res = await fetch(`${BASE}/api/state`, {
        headers: { host: HOST, authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
      body = (await res.json()) as Record<string, ProviderStatus>
      const wire = body['repos']?.data as ReposWire | undefined
      if (wire?.repos.length === 3) break
      if (Date.now() > deadline) {
        throw new Error(`/api/state never reported 3 repos; last body: ${JSON.stringify(body)}`)
      }
      await Bun.sleep(100)
    }

    const wire = body['repos']!.data as ReposWire
    const realRoot = realpathSync(fixtureRoot)
    expect(wire.repos.map((r) => r.name).sort()).toEqual([...names].sort())
    for (const r of wire.repos) expect(r.path.startsWith(realRoot)).toBe(true)
    // Proves the parsed config reached the provider and toClient carried it.
    // 45, not the default 30, so the assertion cannot pass on a dropped config.
    expect(wire.staleDays).toBe(STALE_DAYS)

    // THE step that makes the seventeen hand-built-fixture tests above
    // non-vacuous: the real wire value, straight from the running binary, fed
    // into this task's own derivation and rendered.
    const state = deriveReposPaneState({ hasSnapshot: true, providers: body, nowMs: Date.now() })
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') throw new Error('unreachable')
    expect(state.recent.length + state.needsAttention.length).toBe(3)
    const html = renderToStaticMarkup(
      createElement(ReposPane, { state, nowMs: Date.now(), onAction: () => {} }),
    )
    for (const n of names) expect(html).toContain(n)
  } finally {
    proc?.kill()
    for (const d of scratch) rmSync(d, { recursive: true, force: true })
  }
}, 30_000)
