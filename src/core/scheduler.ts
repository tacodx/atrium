import type { Registry } from './registry'
import type { Disposable } from './contract'

/**
 * Per-schedule health. Lives here rather than in contract.ts because a
 * provider author never writes one of these — the scheduler is the only
 * producer — and because contract.ts is edited by a later task that must not
 * collide with this file.
 */
export interface ScheduleHealth {
  lastSuccessAt: number | null      // Date.now() of the last non-aborted success; null if never
  consecutiveFailures: number       // reset to 0 by a success
  lastErrorMessage: string | null   // most recent failure's message; null when not currently failing
}

/** What snapshot() and an onUpdate listener both see for one provider. */
export interface ProviderStatus {
  data?: unknown                              // the provider's most recent Data; absent until the first success
  schedules: Record<string, ScheduleHealth>   // schedule name -> that schedule's health
}

export function createScheduler(registry: Registry, opts: { config: Record<string, unknown> }) {
  const last = new Map<string, unknown>()          // providerId -> last Data (display value for snapshot()/onUpdate — whichever schedule most recently produced data)
  const previousByKey = new Map<string, unknown>() // `${providerId}:${scheduleName}` -> that schedule's own last Data (feeds ctx.previous — never another schedule's output)
  const inflight = new Map<string, Promise<unknown>>()
  const timers: ReturnType<typeof setInterval>[] = []
  const watchers: Disposable[] = []
  // providerId -> scheduleName -> record. Nested rather than a flat
  // `${providerId}:${scheduleName}` key because provider ids are unconstrained
  // at registration, so a ':' inside one would make a flat key ambiguous.
  const health = new Map<string, Map<string, ScheduleHealth>>()
  const listeners = new Set<(id: string, status: ProviderStatus) => void>()
  const controllers = new Set<AbortController>()
  let started = false
  // Bumped by every start(). A start() that gets cancelled mid-pass and
  // replaced by a later one must not resume and install a SECOND set of timers
  // and watchers; the `started` boolean alone cannot see that, because the
  // replacing start() has already set it back to true.
  let generation = 0

  function healthFor(providerId: string, scheduleName: string): ScheduleHealth {
    let perSchedule = health.get(providerId)
    if (!perSchedule) {
      perSchedule = new Map<string, ScheduleHealth>()
      health.set(providerId, perSchedule)
    }
    let h = perSchedule.get(scheduleName)
    if (!h) {
      h = { lastSuccessAt: null, consecutiveFailures: 0, lastErrorMessage: null }
      perSchedule.set(scheduleName, h)
    }
    return h
  }

  function recordSuccess(providerId: string, scheduleName: string): void {
    const h = healthFor(providerId, scheduleName)
    h.lastSuccessAt = Date.now()
    h.consecutiveFailures = 0
    // Clearing the message is required, not incidental: the UI renders
    // "unavailable" off this record, and a stale error sitting next to fresh
    // data is exactly the ambiguity it exists to resolve.
    h.lastErrorMessage = null
  }

  function recordFailure(providerId: string, scheduleName: string, err: unknown): void {
    const h = healthFor(providerId, scheduleName)
    h.consecutiveFailures += 1
    h.lastErrorMessage = (err as Error)?.message ?? String(err)
  }

  /**
   * One provider's envelope, freshly allocated — never the live record objects,
   * so a consumer cannot mutate the scheduler's state through it. undefined for
   * a provider that has neither succeeded nor failed.
   *
   * Split out of buildSnapshot() because notify() needs exactly one provider's
   * envelope: building all of them and discarding the rest is free with one
   * provider and O(all providers x all schedules) per poll once there are
   * several and an onUpdate -> publish wire exists.
   */
  function buildStatus(providerId: string): ProviderStatus | undefined {
    const perSchedule = health.get(providerId)
    if (!perSchedule) return undefined
    const schedules: Record<string, ScheduleHealth> = {}
    for (const [name, h] of perSchedule) schedules[name] = { ...h }
    return last.has(providerId)
      ? { data: last.get(providerId), schedules }
      : { schedules }
  }

  /**
   * `health` is the authoritative id set: every non-aborted success and every
   * non-aborted failure writes a health entry, and `last` is only ever written
   * alongside one. A provider that has neither succeeded nor failed produces no
   * entry at all.
   */
  function buildSnapshot(): Record<string, ProviderStatus> {
    const out: Record<string, ProviderStatus> = {}
    for (const providerId of health.keys()) {
      const status = buildStatus(providerId)
      if (status) out[providerId] = status
    }
    return out
  }

  // Listeners get the status envelope, not the bare Data, so an update carries
  // the failure record with it and a consumer never has to re-read snapshot()
  // to find out whether what it just received is fresh or stale.
  function notify(providerId: string): void {
    const status = buildStatus(providerId)
    if (!status) return
    for (const l of listeners) l(providerId, status)
  }

  async function runNow(providerId: string, scheduleName: string) {
    const key = `${providerId}:${scheduleName}`
    const existing = inflight.get(key)
    if (existing) return existing                  // share, never stampede

    const p = registry.get(providerId)
    if (!p) throw new Error(`unknown provider: ${providerId}`)
    // Without this, a typo'd schedule name silently starts a run under a key
    // nothing else ever reads — a provider that appears to be polling and is
    // not. Deliberately below the inflight share check, so the stampede
    // behaviour above is unchanged.
    if (!p.schedules.some(s => s.name === scheduleName)) {
      throw new Error(`unknown schedule "${scheduleName}" for provider "${providerId}"`)
    }

    const ac = new AbortController()
    controllers.add(ac)
    const run = (async () => {
      try {
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
          recordSuccess(providerId, scheduleName)
          notify(providerId)
        }
        return data
      } catch (e) {
        // The SAME abort guard, and it is just as mandatory here: the ordinary
        // way a provider honours ctx.signal is to throw AbortError, so without
        // it every stop() that lands mid-flight records a phantom failure.
        if (!ac.signal.aborted) {
          recordFailure(providerId, scheduleName, e)
          notify(providerId)
        }
        // Re-thrown on purpose. This is the ONE place a failure is recorded;
        // the fire-and-forget call sites keep a bare .catch(() => {}) whose
        // only job is preventing an unhandled rejection, and recording at both
        // would double-count every interval failure. A direct `await
        // s.runNow(...)` caller (tests included) must still see failures.
        throw e
      }
    })().finally(() => {
      inflight.delete(key)
      controllers.delete(ac)
    })

    inflight.set(key, run)
    return run
  }

  /**
   * The interval timers and the watchers — everything that produces work
   * without being asked. Split out of start() because it must run AFTER the
   * runOnStart pass, never before.
   */
  function installSources(): void {
    for (const p of registry.all()) {
      for (const s of p.schedules) {
        timers.push(setInterval(() => void runNow(p.id, s.name).catch(() => {}), s.intervalMs))
      }
      // Watch emits route into the first declared schedule's fetch (the
      // contract's own doc comment: the interval schedule is the fallback
      // path, so a watch-capable provider is expected to declare one).
      const fallback = p.schedules[0]
      if (p.watch && fallback) {
        try {
          watchers.push(p.watch(opts.config[p.id] as never, () => void runNow(p.id, fallback.name).catch(() => {})))
        } catch (e) {
          // A watcher that throws on installation must not escape start(), and
          // therefore must not escape startServer() after the port is already
          // bound. It is recorded against the schedule its emits would have
          // routed into, which is where a reader looking for "why is this
          // provider not updating" will be looking.
          recordFailure(p.id, fallback.name, new Error(`watch() threw: ${(e as Error)?.message ?? String(e)}`))
        }
      }
    }
  }

  return {
    runNow,
    onUpdate: (fn: (providerId: string, status: ProviderStatus) => void) => { listeners.add(fn); return () => listeners.delete(fn) },
    snapshot: buildSnapshot,

    /**
     * The one config holder in the system, so it is also the one place the
     * action layer can get a provider's config from. `fetch` already receives
     * `opts.config[providerId]`; before this existed, `dispatch` had no path
     * to the same value and passed `undefined` to every `call` action's
     * `run(target, cfg)` — unimplementable for all four `call` actions the
     * spec plans. Same lookup, same value, one accessor.
     */
    configFor: (providerId: string): unknown => opts.config[providerId],

    /**
     * Specified to NEVER reject. Four properties, each separately pinned by a
     * test in test/scheduler-lifecycle.test.ts:
     *
     * 1. Each runOnStart schedule is AWAITED before the next one starts, in
     *    registry.all() order (Map insertion order = the order providers were
     *    registered) then p.schedules array order. Firing them all in one tick
     *    means a provider's cheap 30s pass starts before its slow cold
     *    discovery scan has resolved, on every start.
     * 2. `.catch(() => {})` on the awaited call, never a bare await: a bare
     *    await would make start() reject whenever a provider's first fetch
     *    throws, and nothing awaits start(). The failure is still recorded,
     *    inside runNow.
     * 3. The `!started` re-check after each await, so a stop() mid-pass
     *    cancels the schedules that have not run yet.
     * 4. The generation re-check. It appears TWICE — after each await and
     *    again before installSources() — and the two are NOT interchangeable:
     *      - The pre-installSources copy is unreachable with a true condition,
     *        i.e. dead today. There is no await between the last post-await
     *        guard and it (only `continue`s and loop headers over materialised
     *        arrays), and `generation` only ever increases while `started` can
     *        only go false->true in the same synchronous block that bumps it —
     *        so its condition always equals the one just evaluated false.
     *        Measured: deleting it outright leaves the whole suite green. It is
     *        kept as insurance against a future edit introducing an await
     *        there (T3 plausibly could, if config parsing becomes async), not
     *        because it can fire today.
     *      - The post-await copy is load-bearing, and its job is EARLY EXIT:
     *        it stops a cancelled generation from running its remaining
     *        runOnStart schedules. Those do NOT always coalesce with the
     *        replacing generation's runs on `inflight` — a stale generation
     *        that is strictly AHEAD of the live one can complete a schedule
     *        before the live one arrives at it, producing a genuine duplicate
     *        fetch. Pinned by "a cancelled generation does not run its
     *        remaining runOnStart schedules" in test/scheduler-lifecycle.test.ts;
     *        weakening this copy alone turns that test red, weakening the other
     *        alone leaves it green.
     *
     * A defensive double-start is a plausible caller mistake, not a
     * programming error worth crashing on, but a second pass would double
     * every provider's poll rate — hence the `started` guard on entry.
     *
     * NOTE: an async function body runs synchronously up to its first await.
     * A provider set with no runOnStart schedule therefore still gets its
     * timers and watchers installed synchronously inside the start() call,
     * which is what an un-awaited s.start() in an existing test relies on.
     */
    async start(): Promise<void> {
      if (started) return
      started = true
      const gen = ++generation
      for (const p of registry.all()) {
        for (const s of p.schedules) {
          if (!s.runOnStart) continue
          await runNow(p.id, s.name).catch(() => {})
          if (!started || gen !== generation) return
        }
      }
      if (!started || gen !== generation) return
      installSources()
    },

    stop() {
      started = false             // so a later start() re-registers timers/watchers
      for (const t of timers) clearInterval(t)
      for (const w of watchers) w.close()
      for (const ac of controllers) ac.abort()   // best-effort cancellation for providers that honour ctx.signal
      timers.length = 0
      watchers.length = 0
      controllers.clear()
      // `last` and `health` are deliberately NOT cleared: a restart keeps the
      // last known state so the UI does not flash empty.
    },
  }
}

export type Scheduler = ReturnType<typeof createScheduler>
