import { test, expect, describe } from 'bun:test'
import { createRegistry } from '../src/core/registry'
import { createScheduler } from '../src/core/scheduler'
import type { Provider } from '../src/core/contract'

const SENTINEL = 'atrium-redaction-sentinel-9f2c41'

const stub = (id: string, overrides: Partial<Provider<any, any>> = {}): Provider<any, any> => ({
  id,
  configSchema: { parse: (x: any) => x } as any,
  detect: async () => ({ kind: 'nothing-to-detect' }),
  schedules: [{ name: 'poll', intervalMs: 1000, runOnStart: false }],
  fetch: async () => ({ ok: true }),
  // Deliberately NOT identity. An identity default would make the "redaction
  // above previousByKey" mutation undetectable by every test in this file — the
  // same trap Task 3 records for `{ parse: x => x }` config stubs.
  toClient: () => ({ wire: true }),
  actions: [],
  ...overrides,
})

describe('registry', () => {
  test('rejects a duplicate provider id', () => {
    const r = createRegistry()
    r.register(stub('git'))
    expect(() => r.register(stub('git'))).toThrow(/duplicate/i)
  })

  test('rejects duplicate action ids within a provider', () => {
    const r = createRegistry()
    const p = stub('git', {
      actions: [
        { kind: 'exec', id: 'open', label: 'Open', argv: () => ({ cmd: 'true', args: [] }) },
        { kind: 'exec', id: 'open', label: 'Open again', argv: () => ({ cmd: 'true', args: [] }) },
      ],
    })
    expect(() => r.register(p)).toThrow(/duplicate action/i)
  })

  test('the same action id in two providers is fine — routes are namespaced', () => {
    const r = createRegistry()
    const mk = (id: string) => stub(id, {
      actions: [{ kind: 'exec' as const, id: 'open', label: 'Open', argv: () => ({ cmd: 'true', args: [] }) }],
    })
    r.register(mk('git'))
    expect(() => r.register(mk('obsidian'))).not.toThrow()
  })

  // Three registration-time schedule rules. Each covers a shape that today
  // fails SILENTLY at run time — no throw, no log, just a provider that does
  // not do what it declared — so registration is the last place it can be
  // caught where a caller is still on the stack.

  test('rejects two schedules with the same name in one provider', () => {
    const r = createRegistry()
    const p = stub('fx', {
      schedules: [
        { name: 'poll', intervalMs: 1000, runOnStart: false },
        { name: 'poll', intervalMs: 2000, runOnStart: false },
      ],
    })
    // The two collide on the scheduler's providerId:scheduleName key, so they
    // share previousByKey and inflight, while still registering two timers.
    expect(() => r.register(p)).toThrow(/duplicate schedule name/i)
  })

  test('rejects an intervalMs that setInterval cannot honour', () => {
    // 2_147_483_648 is the measured overflow case: on bun 1.3.11 setInterval
    // warns TimeoutOverflowWarning, clamps the duration to 1 and fires 60
    // times in 120ms, so a provider meaning "effectively never" gets a 1ms hot
    // loop instead. The other three are rejected by Number.isInteger and the
    // positivity check.
    for (const intervalMs of [0, -1, 1.5, 2_147_483_648]) {
      const r = createRegistry()
      const p = stub('fx', { schedules: [{ name: 'poll', intervalMs, runOnStart: false }] })
      expect(() => r.register(p)).toThrow(/positive integer <= 2147483647/)
    }
  })

  test('rejects watch() declared with no schedules', () => {
    const r = createRegistry()
    // The scheduler's watch branch is guarded on schedules[0], so this
    // provider's watcher would never be installed and it would sit inert.
    const watching = stub('fx', { schedules: [], watch: () => ({ close() {} }) })
    expect(() => r.register(watching)).toThrow(/watch\(\) but has no schedules/)

    // The same empty-schedules shape with NO watch stays legal — it is exactly
    // what test/routes.test.ts registers today.
    expect(() => r.register(stub('routes-shape', { schedules: [] }))).not.toThrow()
  })

  test('a provider rejected for an invalid schedule is not registered', () => {
    const r = createRegistry()
    const p = stub('fx', { schedules: [{ name: 'poll', intervalMs: 0, runOnStart: false }] })
    expect(() => r.register(p)).toThrow()
    // Half-registration would be worse than the silent failure the rules
    // exist to prevent: the provider would be serving /api/state and actions
    // with a schedule the scheduler cannot honour.
    expect(r.get('fx')).toBeUndefined()
    expect(r.all()).toEqual([])
  })
})

describe('scheduler', () => {
  test('routes the schedule name into fetch, so one provider can have two', async () => {
    const seen: string[] = []
    const r = createRegistry()
    r.register(stub('git', {
      schedules: [
        { name: 'discovery', intervalMs: 600_000, runOnStart: true },
        { name: 'metadata', intervalMs: 30_000, runOnStart: true },
      ],
      fetch: async (_cfg, ctx) => { seen.push(ctx.schedule); return {} },
    }))

    const s = createScheduler(r, { config: { git: {} } })
    await s.runNow('git', 'discovery')
    await s.runNow('git', 'metadata')

    expect(seen).toEqual(['discovery', 'metadata'])
  })

  // Final review I4: fetch has always received opts.config[providerId]; the
  // action layer had no path to the same value and handed every `call` action
  // `undefined`. configFor is that path — same map, same lookup, so a provider
  // cannot see one config in fetch() and a different one in an action.
  test('exposes the same per-provider config the fetch side receives', async () => {
    const r = createRegistry()
    let sawInFetch: unknown
    r.register(stub('obsidian', {
      schedules: [{ name: 'poll', intervalMs: 1000, runOnStart: false }],
      fetch: async (cfg) => { sawInFetch = cfg; return {} },
    }))

    const config = { obsidian: { vault: '/home/u/vault' }, git: { roots: ['/src'] } }
    const s = createScheduler(r, { config })
    await s.runNow('obsidian', 'poll')

    expect(s.configFor('obsidian')).toEqual({ vault: '/home/u/vault' })
    expect(s.configFor('obsidian')).toBe(sawInFetch)
    expect(s.configFor('git')).toEqual({ roots: ['/src'] })
    expect(s.configFor('absent')).toBeUndefined()
  })

  test('passes the previous result so a metadata pass can read the discovery list', async () => {
    const r = createRegistry()
    let sawPrevious: unknown = 'unset'
    r.register(stub('git', {
      schedules: [{ name: 'poll', intervalMs: 1000, runOnStart: false }],
      fetch: async (_cfg, ctx) => { sawPrevious = ctx.previous; return { n: 1 } },
    }))

    const s = createScheduler(r, { config: { git: {} } })
    await s.runNow('git', 'poll')
    expect(sawPrevious).toBeUndefined()
    await s.runNow('git', 'poll')
    expect(sawPrevious).toEqual({ n: 1 })
  })

  test('concurrent runs of the same schedule share one in-flight promise', async () => {
    let calls = 0
    const r = createRegistry()
    r.register(stub('slow', {
      fetch: async () => { calls++; await Bun.sleep(50); return {} },
    }))

    const s = createScheduler(r, { config: { slow: {} } })
    await Promise.all([s.runNow('slow', 'poll'), s.runNow('slow', 'poll'), s.runNow('slow', 'poll')])
    expect(calls).toBe(1)
  })

  test('a watch source emits without waiting for the interval', async () => {
    const r = createRegistry()
    let emitted = 0
    r.register(stub('obsidian', {
      schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: false }],
      watch: (_cfg, emit) => { setTimeout(() => emit(), 10); return { close() {} } },
      fetch: async () => { emitted++; return {} },
    }))

    const s = createScheduler(r, { config: { obsidian: {} } })
    s.start()
    await Bun.sleep(60)
    s.stop()
    expect(emitted).toBeGreaterThan(0)
  })

  test('previous is scoped per schedule — a two-schedule provider never sees the other schedule\'s previous', async () => {
    const r = createRegistry()
    const seenDiscoveryPrev: unknown[] = []
    const seenMetadataPrev: unknown[] = []
    r.register(stub('git', {
      schedules: [
        { name: 'discovery', intervalMs: 600_000, runOnStart: false },
        { name: 'metadata', intervalMs: 30_000, runOnStart: false },
      ],
      fetch: async (_cfg, ctx) => {
        if (ctx.schedule === 'discovery') {
          seenDiscoveryPrev.push(ctx.previous)
          return { repos: ['a', 'b'] }
        }
        seenMetadataPrev.push(ctx.previous)
        return { count: seenMetadataPrev.length }
      },
    }))

    const s = createScheduler(r, { config: { git: {} } })
    await s.runNow('git', 'discovery')   // discovery #1: own previous is undefined
    await s.runNow('git', 'metadata')    // metadata #1: own previous is undefined, NOT discovery's repo list
    await s.runNow('git', 'metadata')    // metadata #2: own previous is metadata #1's result
    await s.runNow('git', 'discovery')   // discovery #2: own previous is discovery #1's result, NOT metadata's count

    expect(seenDiscoveryPrev).toEqual([undefined, { repos: ['a', 'b'] }])
    expect(seenMetadataPrev).toEqual([undefined, { count: 1 }])
  })

  test('start() is idempotent — a second call does not register a second timer', async () => {
    const r = createRegistry()
    let fetches = 0
    r.register(stub('poll-provider', {
      schedules: [{ name: 'poll', intervalMs: 20, runOnStart: false }],
      fetch: async () => { fetches++; return {} },
    }))

    const s = createScheduler(r, { config: { 'poll-provider': {} } })
    s.start()
    s.start()               // a defensive double-start must be a no-op
    await Bun.sleep(50)     // one 20ms timer ticks at ~20ms and ~40ms => 2;
                             // a doubled (buggy) timer pair would tick 4 times
    s.stop()

    expect(fetches).toBe(2)
  })

  test('start -> stop -> start works: stop() resets the started flag', async () => {
    const r = createRegistry()
    let fetches = 0
    r.register(stub('poll-provider', {
      schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: true }],
      fetch: async () => { fetches++; return {} },
    }))

    const s = createScheduler(r, { config: { 'poll-provider': {} } })
    s.start()
    await Bun.sleep(5)
    s.stop()
    s.start()               // must actually restart, not be swallowed as a "second" start
    await Bun.sleep(5)
    s.stop()

    expect(fetches).toBe(2)  // one runOnStart fetch per start() cycle
  })

  test('stop() is quiescent — a fetch already in flight does not mutate state or notify after stop', async () => {
    const r = createRegistry()
    r.register(stub('slow', {
      fetch: async () => { await Bun.sleep(30); return { done: true } },
    }))

    const s = createScheduler(r, { config: { slow: {} } })
    let notified = 0
    s.onUpdate(() => { notified++ })

    const inFlight = s.runNow('slow', 'poll')   // kick off, do not await yet
    s.stop()                                     // stop while the fetch is still running
    await inFlight                               // let it actually resolve
    await Bun.sleep(10)                          // give any wrongly-surviving post-await work a chance to run

    expect(s.snapshot()).toEqual({})
    expect(notified).toBe(0)
  })

  test('stop() aborting an in-flight run does not produce an unhandled rejection', async () => {
    const r = createRegistry()
    // Mirrors the ordinary way a provider honours ctx.signal: pass it into a
    // real fetch(url, { signal }), which throws on abort with no extra
    // provider code. Checking ctx.signal.aborted after an await and throwing
    // reproduces that shape without a network call.
    r.register(stub('flaky', {
      schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: true }],
      fetch: async (_cfg, ctx) => {
        await Bun.sleep(20)
        if (ctx.signal.aborted) throw new Error('AbortError')
        return {}
      },
    }))

    let unhandled: unknown
    const onUnhandledRejection = (reason: unknown) => { unhandled = reason }
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      const s = createScheduler(r, { config: { flaky: {} } })
      s.start()                 // runOnStart fires the fire-and-forget internal call
      await Bun.sleep(5)        // let the fetch begin — it sleeps 20ms, so it's in flight
      s.stop()                  // aborts it mid-flight
      await Bun.sleep(40)       // let the provider's own sleep finish and throw

      expect(unhandled).toBeUndefined()
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  // Task 5. The redaction seam, pinned from the scheduler side. Mutations
  // named per assertion below; the /api/state serialization half is in
  // test/routes.test.ts, and the WS-frame half is Task 6's.
  test('the client value is the redacted one — a Data sentinel reaches neither snapshot() nor an onUpdate listener', async () => {
    const r = createRegistry()
    r.register(stub('repos', {
      schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: false }],
      fetch: async () => ({ root: '/home/someone/src', token: SENTINEL, count: 2 }),
      toClient: (d: any) => ({ count: d.count }),      // allowlist, field by field
    }))

    const s = createScheduler(r, { config: { repos: {} } })
    const pushed: unknown[] = []
    s.onUpdate((_id, data) => pushed.push(data))

    const raw = await s.runNow('repos', 'poll')

    // Positive shape FIRST. A negative-only assertion passes just as happily
    // when the value is empty or missing, which is exactly how a redaction test
    // becomes a test that cannot fail.
    //
    // NOTE the envelope: Task 2 made snapshot() return
    // Record<providerId, { data?, schedules }>, and made the onUpdate payload
    // that same per-provider envelope. Assert on `.data`, never on the envelope
    // as a whole — `schedules` carries a live health record.
    //
    // M1 (redaction removed from the write path): both `.data` reads see the
    // raw object and the two toEqual lines go red on `root`/`token`.
    expect((s.snapshot() as any).repos.data).toEqual({ count: 2 })
    expect(pushed).toHaveLength(1)
    expect((pushed[0] as any).data).toEqual({ count: 2 })
    expect(JSON.stringify(s.snapshot())).not.toContain(SENTINEL)
    expect(JSON.stringify(pushed)).not.toContain(SENTINEL)

    // Computed once: the value /api/state serves and the value pushed to the
    // socket are the SAME object, not two independent toClient calls. The
    // identity is on `.data`, because Task 2's snapshot() allocates a fresh
    // envelope per call while `last.get(providerId)` returns the one stored
    // client value — which is exactly the property being pinned.
    //
    // M4 (computed twice — the listener given its own p.toClient(data)): equal
    // but not identical, and only this line goes red.
    expect((pushed[0] as any).data).toBe((s.snapshot() as any).repos.data)

    // runNow's own resolution stays RAW — internal, never serialized. Pins
    // runNow's `return data` in src/core/scheduler.ts.
    //
    // M8 (raw return redacted: `return data` → `return p.toClient(data)`): only
    // this line goes red (Expected the sentinel / Received undefined). The
    // spelling `return wire` is not a runnable mutant: `wire` is scoped to the
    // `if (!ac.signal.aborted)` block, so it is TS2304 under typecheck and a
    // ReferenceError that reddens every test with a successful run.
    expect((raw as any).token).toBe(SENTINEL)
  })

  test('a provider with no toClient fails the run instead of publishing raw Data', async () => {
    const r = createRegistry()
    const p = stub('broken', {
      schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: false }],
      fetch: async () => ({ token: SENTINEL }),
    })
    // A hand-written JS provider, or a future `p.toClient?.(data) ?? data`
    // fallback quietly reintroducing optionality. Either way the run must fail
    // loudly rather than publish Data.
    delete (p as any).toClient

    r.register(p)
    const s = createScheduler(r, { config: { broken: {} } })
    const pushed: unknown[] = []
    s.onUpdate((_id, status) => pushed.push(status))

    // M3 (optionality reintroduced: `toClient?` on the contract and
    // `p.toClient ? p.toClient(data) : data` in the scheduler) and M1 (no call
    // site left at all): the run resolves instead of rejecting, and this line
    // goes red before any of the ones below.
    await expect(s.runNow('broken', 'poll')).rejects.toThrow()

    // No client value was ever published for this provider. Task 2's catch arm
    // DOES record a failure and DOES notify, so `snapshot()` is not `{}` here and
    // `notified` is not 0 — assert the property that actually matters instead:
    // nothing carrying Data reached either wire.
    expect((s.snapshot() as any).broken?.data).toBeUndefined()
    expect((s.snapshot() as any).broken?.schedules.poll?.consecutiveFailures).toBe(1)
    // `every` is vacuously true on an empty array, so the line after this one
    // could never fail on its own. Pin that the catch arm DID notify, so the
    // "nothing carrying Data reached either wire" claim is about one real
    // envelope. M7 (catch-arm `notify(providerId)` removed): this line goes red
    // (Expected 1 / Received 0); test/scheduler-lifecycle.test.ts's `onUpdate
    // carries the status envelope …` goes red with it.
    expect(pushed).toHaveLength(1)
    expect(pushed.every(st => (st as any)?.data === undefined)).toBe(true)
    expect(JSON.stringify(s.snapshot())).not.toContain(SENTINEL)
    expect(JSON.stringify(pushed)).not.toContain(SENTINEL)
  })
})
