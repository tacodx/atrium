import { test, expect } from 'bun:test'
import { createRegistry } from '../src/core/registry'
import { createScheduler, type ProviderStatus } from '../src/core/scheduler'
import { makeFixtureProvider, type FixtureProvider } from './fixtures/provider'

function schedulerFor(p: FixtureProvider<any>) {
  const r = createRegistry()
  r.register(p)
  return createScheduler(r, { config: { [p.id]: {} } })
}

/**
 * The shared shape for the four ordering tests: schedule `a` runs on start and
 * takes 30ms, schedule `b` runs on start and is instant. Whether `b` observes
 * `a` as finished is the whole question — firing both in one tick means a
 * provider's cheap pass starts before its slow cold pass has produced anything
 * for it to work from.
 */
function orderedFixture() {
  const order: string[] = []
  let aFinished = false
  let bSawAFinished: boolean | undefined

  const p = makeFixtureProvider({
    schedules: [
      { name: 'a', intervalMs: 3_600_000, runOnStart: true },
      { name: 'b', intervalMs: 3_600_000, runOnStart: true },
    ],
    fetch: async (_cfg, ctx) => {
      if (ctx.schedule === 'a') {
        order.push('a-start')
        await Bun.sleep(30)
        aFinished = true
        order.push('a-end')
        return {}
      }
      order.push('b-start')
      bSawAFinished = aFinished
      return {}
    },
  })

  return { p, order, sawAFinished: () => bSawAFinished }
}

test('runNow rejects an unknown schedule name', async () => {
  // Only the provider was validated before, so a typo started a run under a
  // key nothing else ever reads — a provider that looks like it is polling and
  // is not.
  const p = makeFixtureProvider()
  const s = schedulerFor(p)

  let err: unknown
  try {
    await s.runNow('fx', 'discvoery')
  } catch (e) {
    err = e
  }
  expect((err as Error | undefined)?.message).toMatch(/unknown schedule "discvoery" for provider "fx"/)
  expect(p.fetchCount).toBe(0)
})

test('runOnStart schedules run in declaration order, each awaited before the next', async () => {
  const { p, order, sawAFinished } = orderedFixture()
  const s = schedulerFor(p)

  await s.start()
  s.stop()

  expect(order).toEqual(['a-start', 'a-end', 'b-start'])
  expect(sawAFinished()).toBe(true)
})

test('intervals and watchers are installed only after the runOnStart pass completes', async () => {
  const { p } = orderedFixture()
  const s = schedulerFor(p)

  const started = s.start()           // deliberately not awaited yet
  await Bun.sleep(5)                  // a's 30ms fetch is still in flight
  expect(p.watchInstalled).toBe(false)

  await started
  expect(p.watchInstalled).toBe(true)
  s.stop()
})

test('stop() during the runOnStart pass cancels the remaining schedules', async () => {
  const { p, order } = orderedFixture()
  const s = schedulerFor(p)

  const started = s.start()
  await Bun.sleep(5)
  s.stop()
  await started

  // a was already in flight and finishes; b never starts, and no sources are
  // installed for a pass that was cancelled.
  expect(order).toEqual(['a-start', 'a-end'])
  expect(p.watchInstalled).toBe(false)
})

test('a start() cancelled mid-pass installs no sources for the generation that replaced it', async () => {
  const { p } = orderedFixture()
  const s = schedulerFor(p)

  const first = s.start()
  await Bun.sleep(5)
  s.stop()
  const second = s.start()            // the replacing generation
  await second
  await first                         // the cancelled one resumes here

  // watchCalls is the observable proxy for "one set of sources": the timer
  // array is not reachable from outside. The `started` boolean alone cannot
  // catch this — `second` has already set it back to true by the time `first`
  // resumes.
  expect(p.watchCalls).toBe(1)
  s.stop()
})

test('a cancelled generation does not run its remaining runOnStart schedules', async () => {
  // The post-await generation guard's real job is EARLY EXIT, and that is not
  // the same property as "installs no second set of sources". `a`'s FIRST call
  // is fast and its SECOND is slow, so the cancelled generation gets strictly
  // AHEAD of the generation that replaced it: it finishes `c` while the live
  // generation is still stuck inside `a`, so there is no inflight entry to
  // coalesce on and the fetch is a genuine duplicate. watchCalls cannot see
  // this (it is 1 either way) — countFor('c') is what separates the halves.
  let aCalls = 0
  const p = makeFixtureProvider({
    schedules: [
      { name: 'a', intervalMs: 3_600_000, runOnStart: true },
      { name: 'b', intervalMs: 3_600_000, runOnStart: true },
      { name: 'c', intervalMs: 3_600_000, runOnStart: true },
    ],
    fetch: async (_cfg, ctx) => {
      if (ctx.schedule === 'a') { aCalls++; await Bun.sleep(aCalls === 1 ? 2 : 200); return {} }
      if (ctx.schedule === 'b') { await Bun.sleep(40); return {} }
      await Bun.sleep(2); return {}
    },
  })
  const s = schedulerFor(p)

  const first = s.start()             // generation 1: finishes a, enters b
  await Bun.sleep(10)
  s.stop()
  const second = s.start()            // generation 2: restarts at a, now 200ms
  await second
  await first                         // the cancelled generation resumes here
  await Bun.sleep(20)

  expect(p.countFor('c')).toBe(1)     // only the live generation ran c
  expect(p.watchCalls).toBe(1)        // and only one set of sources was installed
  s.stop()
})

test('a failing fetch is recorded in snapshot(), not swallowed', async () => {
  const p = makeFixtureProvider({ fetch: async () => { throw new Error('boom') } })
  const s = schedulerFor(p)

  let threw = false
  try {
    await s.runNow('fx', 'poll')
  } catch (e) {
    threw = true
    expect((e as Error).message).toBe('boom')
  }
  expect(threw).toBe(true)            // a direct awaiter still sees the failure

  const snap = s.snapshot()
  expect(snap.fx).toBeDefined()
  expect(snap.fx?.data).toBeUndefined()
  expect(snap.fx?.schedules.poll).toEqual({
    lastSuccessAt: null,
    consecutiveFailures: 1,
    lastErrorMessage: 'boom',
  })

  // Freshly allocated on every call: a consumer holding the envelope must not
  // be able to reach through it and mutate the scheduler's own record.
  const handed = snap.fx?.schedules.poll
  if (handed) handed.consecutiveFailures = 99
  expect(s.snapshot().fx?.schedules.poll?.consecutiveFailures).toBe(1)
})

test('consecutive failures accumulate and a success clears the record', async () => {
  let fail = true
  const payload = { v: 42 }
  // toClient is an explicit allowlist naming the one field, so the `.data`
  // assertion below stays a "data arrived" check against the raw payload — the
  // fixture's default allowlist is over { ok }, and would turn { v: 42 } into
  // { ok: undefined }. Not identity, not a spread.
  const p = makeFixtureProvider({
    fetch: async () => { if (fail) throw new Error('boom'); return payload },
    toClient: (d) => ({ v: d.v }),
  })
  const s = schedulerFor(p)

  await s.runNow('fx', 'poll').catch(() => {})
  await s.runNow('fx', 'poll').catch(() => {})
  expect(s.snapshot().fx?.schedules.poll?.consecutiveFailures).toBe(2)

  fail = false
  await s.runNow('fx', 'poll')

  const h = s.snapshot().fx?.schedules.poll
  expect(h?.consecutiveFailures).toBe(0)
  // A stale error message sitting next to fresh data is the exact ambiguity
  // the "unavailable" render has to resolve, so a success must clear it.
  expect(h?.lastErrorMessage).toBeNull()
  expect(typeof h?.lastSuccessAt).toBe('number')
  expect(h?.lastSuccessAt ?? 0).toBeGreaterThan(0)
  expect(s.snapshot().fx?.data).toEqual(payload)
})

test('onUpdate carries the status envelope, and the record is current when it fires', async () => {
  // onUpdate's payload is the only input a later task's `onUpdate -> publish`
  // wire has, and the only thing the UI renders from. Nothing else in the
  // suite registers a listener that inspects its second argument, so all
  // three of "payload reverted to bare Data", "notify() before
  // recordSuccess()" and "failure arm does not notify" would ship green.
  let fail = true
  const payload = { v: 42 }
  // Same allowlist as the test above, for the same reason: `.data` here is a
  // "data arrived" check, not a redaction check (test/contract.test.ts owns those).
  const p = makeFixtureProvider({
    fetch: async () => { if (fail) throw new Error('boom'); return payload },
    toClient: (d) => ({ v: d.v }),
  })
  const s = schedulerFor(p)

  const seen: Array<[string, ProviderStatus]> = []
  s.onUpdate((id, status) => seen.push([id, structuredClone(status)]))

  await s.runNow('fx', 'poll').catch(() => {})     // the failure arm notifies too
  expect(seen.length).toBe(1)
  expect(seen[0]![0]).toBe('fx')
  expect(seen[0]![1].data).toBeUndefined()
  expect(seen[0]![1].schedules.poll).toEqual({
    lastSuccessAt: null, consecutiveFailures: 1, lastErrorMessage: 'boom',
  })

  fail = false
  await s.runNow('fx', 'poll')
  expect(seen.length).toBe(2)
  expect(seen[1]![1].data).toEqual(payload)
  // Fires AFTER recordSuccess: a listener must never see fresh data beside a
  // stale error message — that ambiguity is the whole reason the record is
  // cleared on success, and the snapshot() boundary alone does not pin it.
  expect(seen[1]![1].schedules.poll!.consecutiveFailures).toBe(0)
  expect(seen[1]![1].schedules.poll!.lastErrorMessage).toBeNull()
})

test('a run aborted by stop() is not counted as a failure', async () => {
  // The ordinary way a provider honours ctx.signal is to throw on abort, so
  // without the guard on the catch arm every stop() that lands mid-flight
  // would record a phantom failure and the UI would show a dead provider.
  const p = makeFixtureProvider({ fetch: async () => { await Bun.sleep(30); throw new Error('boom') } })
  const s = schedulerFor(p)

  const run = s.runNow('fx', 'poll')
  s.stop()

  let threw = false
  try {
    await run
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
  await Bun.sleep(10)

  expect(s.snapshot()).toEqual({})
})

test('a throwing watch() is recorded and start() still resolves', async () => {
  const p = makeFixtureProvider({
    watchThrows: 'nope',
    schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: false }],
  })
  const s = schedulerFor(p)

  // Must resolve, not reject: after a later task starts the scheduler from
  // startServer, a rejection here escapes with the port already bound.
  await s.start()
  s.stop()

  const h = s.snapshot().fx?.schedules.poll
  expect(h?.lastErrorMessage).toMatch(/watch\(\) threw: nope/)
  expect(h?.consecutiveFailures).toBe(1)
})

test('stop() closes every installed watcher', async () => {
  const p = makeFixtureProvider()
  const s = schedulerFor(p)

  await s.start()
  s.stop()

  expect(p.closeCalls).toBe(1)
  // And the fixture stops claiming the watcher is installed once it is closed.
  // A stale `true` here would make a later task's stop/start test assert
  // against state the scheduler had already torn down.
  expect(p.watchInstalled).toBe(false)
})

test('a watch emit routes into the first declared schedule', async () => {
  const p = makeFixtureProvider({
    schedules: [
      { name: 'first', intervalMs: 3_600_000, runOnStart: false },
      { name: 'second', intervalMs: 3_600_000, runOnStart: false },
    ],
  })
  const s = schedulerFor(p)

  await s.start()
  await p.waitForWatch()              // deterministic push seam, never a timer race
  p.emit()
  await Bun.sleep(10)
  s.stop()

  expect(p.countFor('first')).toBe(1)
  expect(p.countFor('second')).toBe(0)

  // The fixture's own guard, asserted directly: if emit() no-opped instead of
  // throwing when the watcher is not installed, the two counts above would
  // both be 0 and this test would pass having proved nothing.
  const never = makeFixtureProvider()
  expect(() => never.emit()).toThrow(/before the scheduler installed/)
})

// Not in the task brief. setData(), setWire() and the non-identity toClient
// default have no consumer in this task — they exist for the redaction and
// wire-protocol tasks that follow — and an unexercised fixture seam is exactly
// the thing that breaks silently three tasks later. One test, so it does not.
test('the fixture seam: setData feeds fetch, setWire overrides toClient, and the default toClient is not identity', async () => {
  const p = makeFixtureProvider<{ ok: boolean; secret?: string }>()

  // An allowlist, never identity: an identity default would make a missing
  // redaction indistinguishable from a working one in every later test.
  expect(p.toClient({ ok: true, secret: 'never-leaves' })).toEqual({ ok: true })

  p.setData({ ok: false })
  const s = schedulerFor(p)
  await s.runNow('fx', 'poll')
  expect(s.snapshot().fx?.data).toEqual({ ok: false })

  // setWire must carry a value JSON.stringify throws on — a later task needs
  // exactly that to prove a serialisation failure is handled.
  const circular: Record<string, unknown> = {}
  circular.self = circular
  p.setWire(circular)
  expect(p.toClient({ ok: true })).toBe(circular)
  expect(() => JSON.stringify(p.toClient({ ok: true }))).toThrow()

  // opts.fetch wins over setData unconditionally, so setData on a provider
  // built with one used to be a SILENT no-op — a later task would have watched
  // its seeded value never arrive and had no idea why. It is now loud.
  const withFetch = makeFixtureProvider<{ ok: boolean }>({ fetch: async () => ({ ok: true }) })
  expect(() => withFetch.setData({ ok: false })).toThrow(/opts\.fetch wins unconditionally/)
})
