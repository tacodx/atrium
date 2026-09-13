import type { Registry } from './registry'
import type { Disposable } from './contract'

export function createScheduler(registry: Registry, opts: { config: Record<string, unknown> }) {
  const last = new Map<string, unknown>()          // providerId -> last Data (display value for snapshot()/onUpdate — whichever schedule most recently produced data)
  const previousByKey = new Map<string, unknown>() // `${providerId}:${scheduleName}` -> that schedule's own last Data (feeds ctx.previous — never another schedule's output)
  const inflight = new Map<string, Promise<unknown>>()
  const timers: ReturnType<typeof setInterval>[] = []
  const watchers: Disposable[] = []
  const listeners = new Set<(id: string, data: unknown) => void>()

  async function runNow(providerId: string, scheduleName: string) {
    const key = `${providerId}:${scheduleName}`
    const existing = inflight.get(key)
    if (existing) return existing                  // share, never stampede

    const p = registry.get(providerId)
    if (!p) throw new Error(`unknown provider: ${providerId}`)

    const ac = new AbortController()
    const run = (async () => {
      const data = await p.fetch(opts.config[providerId] as never, {
        schedule: scheduleName,
        previous: previousByKey.get(key),
        signal: ac.signal,
      })
      previousByKey.set(key, data)
      last.set(providerId, data)
      for (const l of listeners) l(providerId, data)
      return data
    })().finally(() => inflight.delete(key))

    inflight.set(key, run)
    return run
  }

  return {
    runNow,
    onUpdate: (fn: (id: string, data: unknown) => void) => { listeners.add(fn); return () => listeners.delete(fn) },
    snapshot: () => Object.fromEntries(last),

    start() {
      for (const p of registry.all()) {
        for (const s of p.schedules) {
          if (s.runOnStart) void runNow(p.id, s.name)
          timers.push(setInterval(() => void runNow(p.id, s.name), s.intervalMs))
        }
        // Watch emits route into the first declared schedule's fetch (the
        // contract's own doc comment: the interval schedule is the fallback
        // path, so a watch-capable provider is expected to declare one).
        const fallback = p.schedules[0]
        if (p.watch && fallback) {
          watchers.push(p.watch(opts.config[p.id] as never, () => void runNow(p.id, fallback.name)))
        }
      }
    },

    stop() {
      for (const t of timers) clearInterval(t)
      for (const w of watchers) w.close()
      timers.length = 0
      watchers.length = 0
    },
  }
}
