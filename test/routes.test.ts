import { test, expect } from 'bun:test'
import { createRegistry } from '../src/core/registry'
import { createScheduler } from '../src/core/scheduler'
import { handleRoute, serveAsset } from '../src/server/routes'
import type { Provider } from '../src/core/contract'

const HEADERS = { 'x-test': '1' }
const SENTINEL = 'atrium-redaction-sentinel-9f2c41'

const stubProvider = (id: string, actions: Provider<any, any>['actions']): Provider<any, any> => ({
  id,
  configSchema: { parse: (x: any) => x },
  detect: async () => ({ kind: 'nothing-to-detect' }),
  schedules: [],
  fetch: async () => ({}),
  // Never invoked by the tests that pass a plain snapshot into ctx(); it exists
  // so the literal typechecks, and it is not identity because identity in a
  // shared fixture is how the next author learns the wrong pattern.
  toClient: () => ({ wire: true }),
  actions,
})

function ctx(
  registry = createRegistry(),
  snapshot: () => Record<string, unknown> = () => ({}),
  config: Record<string, unknown> = {},
) {
  return { registry, snapshot, configFor: (id: string) => config[id], headers: HEADERS }
}

test('GET /api/state returns the scheduler snapshot as JSON, with the standard headers', async () => {
  const res = await handleRoute(new Request('http://x/api/state'), ctx(createRegistry(), () => ({ git: { ok: true } })))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ git: { ok: true } })
  expect(res.headers.get('x-test')).toBe('1')
})

test('an unrecognized path falls through to 404, not a crash', async () => {
  const res = await handleRoute(new Request('http://x/nope'), ctx())
  expect(res.status).toBe(404)
})

test('POST to an unknown provider/action id is a 400 client error, not a 500', async () => {
  const registry = createRegistry()
  registry.register(stubProvider('git', []))
  const req = new Request('http://x/api/actions/git/nonexistent', { method: 'POST', body: '{}' })
  const res = await handleRoute(req, ctx(registry))
  expect(res.status).toBe(400)
  const body = await res.json()
  expect(body.ok).toBe(false)
  expect(body.error).toMatch(/unknown action/i)
})

test('GET on the action route does not dispatch — no GET may run a command', async () => {
  const registry = createRegistry()
  let ran = false
  registry.register(stubProvider('git', [{ kind: 'call', id: 'open', label: 'Open', run: async () => { ran = true } }]))
  const res = await handleRoute(new Request('http://x/api/actions/git/open'), ctx(registry))
  expect(res.status).toBe(404)
  expect(ran).toBe(false)
})

test('the route is namespaced by provider id — two providers may each declare an action called "open"', async () => {
  const registry = createRegistry()
  let openedA = false
  let openedB = false
  registry.register(stubProvider('a', [{ kind: 'call', id: 'open', label: 'Open', run: async () => { openedA = true } }]))
  registry.register(stubProvider('b', [{ kind: 'call', id: 'open', label: 'Open', run: async () => { openedB = true } }]))

  const res = await handleRoute(
    new Request('http://x/api/actions/b/open', { method: 'POST', body: '{}' }),
    ctx(registry),
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(openedA).toBe(false)
  expect(openedB).toBe(true)
})

// Final review I4, at the route level: the action route is the only thing that
// ever calls dispatch in production, so "a call action gets its config" is only
// true if the config reaches it from HERE. RouteCtx.configFor is what carries
// it; serve.ts fills that in from the scheduler, the one config holder.
test('the action route hands a call action its own provider config', async () => {
  const registry = createRegistry()
  let seen: unknown
  registry.register(stubProvider('obsidian', [{
    kind: 'call', id: 'capture', label: 'Capture', run: async (_t, cfg) => { seen = cfg },
  }]))

  const res = await handleRoute(
    new Request('http://x/api/actions/obsidian/capture', { method: 'POST', body: '{"text":"note"}' }),
    ctx(registry, () => ({}), { obsidian: { vault: '/home/u/vault' }, git: { roots: [] } }),
  )
  expect(res.status).toBe(200)
  expect(seen).toEqual({ vault: '/home/u/vault' })   // its own, not another provider's
})

// Deliberately independent of whether `bun run build:web && bun run
// gen:assets` has been run in this checkout (that generated, gitignored
// module may or may not exist on a given machine — see routes.ts's own
// comment on why the import is dynamic). A path with no plausible dist
// counterpart is never a manifest hit either way, so this holds whether the
// real manifest is loaded or the module is absent and serveAsset falls back
// to an empty one — proving requests are never mapped onto the filesystem as
// a fallback, in both states. The real "does a real dist-relative path serve
// real content" half is proven end to end against the compiled binary by
// scripts/assert-package.ts, the one place a real ASSET_PATHS manifest is
// guaranteed to exist.
test('serveAsset never maps an unmapped request path onto the filesystem', async () => {
  expect(await serveAsset('/etc/passwd', HEADERS)).toBeUndefined()
  expect(await serveAsset('/../../../etc/passwd', HEADERS)).toBeUndefined()
  expect(await serveAsset('/definitely-not-a-real-dist-file-xyz123.js', HEADERS)).toBeUndefined()
})

// Task 5. The one test that reads `.data` off a real /api/state response: a
// real registry, a real createScheduler and a real handleRoute, so the claim is
// about the bytes on the wire, not the in-memory map. M1 (redaction removed
// from the scheduler's write path) reddens the toEqual below on `root`/`token`.
test('GET /api/state serves the redacted client value, not the provider Data', async () => {
  const registry = createRegistry()
  // `satisfies`, not `as`. The plan wrote `as`; an assertion is a conversion,
  // and the review expected a literal minus `toClient` to compile through it.
  // Measured on this tree it does not — tsc reports TS2352 ("neither type
  // sufficiently overlaps", elaborated "Property 'toClient' is missing") —
  // but a cast is still the one spelling a later edit can silence with
  // `as unknown as Provider`, and it reads as a conversion, not a check. Under
  // `satisfies`, deleting `toClient` below fails `bun run typecheck` with
  // TS2345 at this call and TS1360 at the literal, both elaborated "Property
  // 'toClient' is missing … but required in type 'Provider<any, any>'".
  registry.register({
    id: 'repos',
    configSchema: { parse: (x: any) => x },
    detect: async () => ({ kind: 'nothing-to-detect' }),
    schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: false }],
    fetch: async () => ({ root: '/home/someone/src', token: SENTINEL, count: 2 }),
    toClient: (d: any) => ({ count: d.count }),
    actions: [],
  } satisfies Provider<any, any>)

  const s = createScheduler(registry, { config: { repos: {} } })
  await s.runNow('repos', 'poll')

  const res = await handleRoute(new Request('http://x/api/state'), {
    registry,
    snapshot: s.snapshot,
    configFor: s.configFor,
    headers: HEADERS,
  })

  expect(res.status).toBe(200)
  // res.text(), not res.json(): a structural assertion can miss a sentinel
  // hiding in a key name or a nested value.
  const body = await res.text()
  expect(JSON.parse(body).repos.data).toEqual({ count: 2 })   // positive shape, inside
                                                              // Task 2's status envelope
  expect(body).not.toContain(SENTINEL)                        // and the sentinel is gone
})
