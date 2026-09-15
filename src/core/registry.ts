import type { Provider } from './contract'

export function createRegistry() {
  const providers = new Map<string, Provider<any, any>>()

  return {
    register(p: Provider<any, any>) {
      if (providers.has(p.id)) throw new Error(`duplicate provider id: ${p.id}`)
      const ids = new Set<string>()
      for (const a of p.actions) {
        if (ids.has(a.id)) throw new Error(`duplicate action id "${a.id}" in provider "${p.id}"`)
        ids.add(a.id)
      }
      // Three schedule-shape rules, all BEFORE providers.set so a provider that
      // fails one is never half-registered. Each of the three fails SILENTLY at
      // run time today, which is why they are rejected at registration instead
      // of being left to the scheduler.
      const scheduleNames = new Set<string>()
      for (const s of p.schedules) {
        // Two schedules called the same thing collide on the scheduler's
        // `${providerId}:${scheduleName}` key — they would share previousByKey
        // and inflight while still registering two separate timers.
        if (scheduleNames.has(s.name)) {
          throw new Error(`duplicate schedule name "${s.name}" in provider "${p.id}"`)
        }
        scheduleNames.add(s.name)
        // intervalMs goes straight into setInterval. Measured on bun 1.3.11:
        // setInterval(fn, 2_147_483_648) warns TimeoutOverflowWarning, clamps
        // the duration to 1 and fires 60 times in 120ms, while 2_147_483_647
        // fires 0 times in 120ms. A provider that meant "never poll" would get
        // a 1ms hot loop. Number.isInteger is already false for NaN, Infinity
        // and 1.5.
        if (!(Number.isInteger(s.intervalMs) && s.intervalMs > 0 && s.intervalMs <= 2_147_483_647)) {
          throw new Error(
            `invalid intervalMs ${String(s.intervalMs)} for schedule "${s.name}" in provider "${p.id}": must be a positive integer <= 2147483647`,
          )
        }
      }
      // The scheduler's watch branch is guarded by `if (p.watch && fallback)`
      // where fallback is schedules[0], so a watch-capable provider with no
      // schedules never gets its watcher installed and is simply inert. A
      // provider with no schedules and NO watch stays legal — that shape is in
      // use today.
      if (p.watch && p.schedules.length === 0) {
        throw new Error(`provider "${p.id}" declares watch() but has no schedules: watch emits route into schedules[0]`)
      }

      providers.set(p.id, p)
    },
    get: (id: string) => providers.get(id),
    all: () => [...providers.values()],
  }
}

export type Registry = ReturnType<typeof createRegistry>
