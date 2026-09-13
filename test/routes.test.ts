import { test, expect } from 'bun:test'
import { createRegistry } from '../src/core/registry'
import { handleRoute, serveAsset } from '../src/server/routes'
import type { Provider } from '../src/core/contract'

const HEADERS = { 'x-test': '1' }

const stubProvider = (id: string, actions: Provider<any, any>['actions']): Provider<any, any> => ({
  id,
  configSchema: { parse: (x: any) => x },
  detect: async () => ({ kind: 'nothing-to-detect' }),
  schedules: [],
  fetch: async () => ({}),
  actions,
})

function ctx(registry = createRegistry(), snapshot: () => Record<string, unknown> = () => ({})) {
  return { registry, snapshot, headers: HEADERS }
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
