import { test, expect, describe } from 'bun:test'
import { createRegistry } from '../src/core/registry'
import { createScheduler } from '../src/core/scheduler'
import type { Provider } from '../src/core/contract'

const stub = (id: string, overrides: Partial<Provider<any, any>> = {}): Provider<any, any> => ({
  id,
  configSchema: { parse: (x: any) => x } as any,
  detect: async () => ({ kind: 'nothing-to-detect' }),
  schedules: [{ name: 'poll', intervalMs: 1000, runOnStart: false }],
  fetch: async () => ({ ok: true }),
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
})
