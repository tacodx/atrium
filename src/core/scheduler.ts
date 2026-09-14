import type { Registry } from './registry'
import type { Disposable } from './contract'

export function createScheduler(registry: Registry, opts: { config: Record<string, unknown> }) {
  const last = new Map<string, unknown>()          // providerId -> last Data (display value for snapshot()/onUpdate — whichever schedule most recently produced data)
  const previousByKey = new Map<string, unknown>() // `${providerId}:${scheduleName}` -> that schedule's own last Data (feeds ctx.previous — never another schedule's output)
  const inflight = new Map<string, Promise<unknown>>()
  const timers: ReturnType<typeof setInterval>[] = []
  const watchers: Disposable[] = []
  const listeners = new Set<(id: string, data: unknown) => void>()
  const controllers = new Set<AbortController>()
  let started = false

  async function runNow(providerId: string, scheduleName: string) {
    const key = `${providerId}:${scheduleName}`
    const existing = inflight.get(key)
    if (existing) return existing                  // share, never stampede

    const p = registry.get(providerId)
    if (!p) throw new Error(`unknown provider: ${providerId}`)

    const ac = new AbortController()
    controllers.add(ac)
    const run = (async () => {
      const data = await p.fetch(opts.config[providerId] as never, {
        schedule: scheduleName,
        previous: previousByKey.get(key),
        signal: ac.signal,
      })
      // A provider is under no obligation to honour ctx.signal, so a run
      // whose controller stop() already aborted must still not be allowed to
      // mutate state or notify listeners once it does resolve — otherwise a
      // fetch in flight at teardown mutates state and fires onUpdate after
      // the scheduler was supposedly stopped.
      if (!ac.signal.aborted) {
        previousByKey.set(key, data)
        last.set(providerId, data)
        for (const l of listeners) l(providerId, data)
      }
      return data
    })().finally(() => {
      inflight.delete(key)
      controllers.delete(ac)
    })

    inflight.set(key, run)
    return run
  }

  return {
    runNow,
    onUpdate: (fn: (id: string, data: unknown) => void) => { listeners.add(fn); return () => listeners.delete(fn) },
    snapshot: () => Object.fromEntries(last),

    /**
     * The one config holder in the system, so it is also the one place the
     * action layer can get a provider's config from. `fetch` already receives
     * `opts.config[providerId]`; before this existed, `dispatch` had no path
     * to the same value and passed `undefined` to every `call` action's
     * `run(target, cfg)` — unimplementable for all four `call` actions the
     * spec plans. Same lookup, same value, one accessor.
     */
    configFor: (providerId: string): unknown => opts.config[providerId],

    start() {
      // A defensive double-start is a plausible caller mistake, not a
      // programming error worth crashing on — but a second pass through the
      // loop below would register a second timer (and watcher) per schedule,
      // silently doubling every provider's poll rate.
      if (started) return
      started = true
      for (const p of registry.all()) {
        for (const s of p.schedules) {
          // These two call sites are fire-and-forget by construction (nothing
          // here can await a background poll), which makes them the only
          // place a rejection needs to be swallowed. stop() now calls
          // ac.abort(), and the ordinary way a provider honours ctx.signal is
          // passing it straight into a real fetch(url, { signal }), which
          // throws AbortError with no extra provider code — without a
          // .catch() here that throw becomes an unhandled rejection on the
          // process every time stop() lands mid-flight. runNow's own
          // returned promise is left rejecting: a direct `await
          // s.runNow(...)` caller (tests included) must still see failures.
          if (s.runOnStart) void runNow(p.id, s.name).catch(() => {})
          timers.push(setInterval(() => void runNow(p.id, s.name).catch(() => {}), s.intervalMs))
        }
        // Watch emits route into the first declared schedule's fetch (the
        // contract's own doc comment: the interval schedule is the fallback
        // path, so a watch-capable provider is expected to declare one).
        const fallback = p.schedules[0]
        if (p.watch && fallback) {
          watchers.push(p.watch(opts.config[p.id] as never, () => void runNow(p.id, fallback.name).catch(() => {})))
        }
      }
    },

    stop() {
      started = false             // so a later start() re-registers timers/watchers
      for (const t of timers) clearInterval(t)
      for (const w of watchers) w.close()
      for (const ac of controllers) ac.abort()   // best-effort cancellation for providers that honour ctx.signal
      timers.length = 0
      watchers.length = 0
      controllers.clear()
    },
  }
}
