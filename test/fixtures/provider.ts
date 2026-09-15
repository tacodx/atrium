import type { DetectResult, Disposable, FetchCtx, Provider, Schedule } from '../../src/core/contract'

/**
 * The deterministic push seam. Every later task's scheduler- and serve-level
 * tests build their provider here, so the names below are contractual — a test
 * in a later task that renames one of them has broken the seam, not fixed it.
 *
 * The property that makes it a *seam* rather than a stub is `emit()`: it hands
 * the scheduler's own emit callback back to the test, so a watch-driven test
 * can push exactly once at a moment it chose, instead of sleeping past a timer
 * and hoping. `emit()` before the scheduler has installed watch() THROWS,
 * because a silent no-op there is precisely the flake this exists to prevent —
 * the test would pass with a count of 0 and prove nothing.
 */
export interface FixtureProviderOptions<Data = unknown> {
  /** default 'fx' */
  id?: string
  /** default [{ name: 'poll', intervalMs: 3_600_000, runOnStart: false }] */
  schedules?: Schedule[]
  /** default true; false omits the watch member entirely */
  withWatch?: boolean
  /** when set, watch() throws new Error(<value>) instead of installing */
  watchThrows?: string
  /** default async () => ({ ok: true } as Data) */
  fetch?(cfg: unknown, ctx: FetchCtx<Data>): Promise<Data>
  /** default { parse: (x: unknown) => x } */
  configSchema?: { parse(x: unknown): unknown }
  /** default async () => ({ kind: 'nothing-to-detect' }) */
  detect?(): Promise<DetectResult<any>>
  /** default [] */
  actions?: Provider<any, any>['actions']
  /**
   * The redaction member a later task makes required on the contract, declared
   * HERE so a test can replace it. The default is an explicit allowlist over
   * the default Data and NEVER identity: an identity default would make every
   * redaction and redaction-ordering property in the later tasks undetectable
   * by construction, because a passing test could not tell a working redaction
   * seam from a missing one.
   */
  toClient?(data: Data): unknown
}

export interface FixtureProvider<Data = unknown> extends Provider<any, Data> {
  /** Calls the scheduler's emit callback. Throws if watch() is not installed. */
  emit(): void
  /** What the next default fetch() resolves to. */
  setData(d: Data): void
  /**
   * What toClient() returns next, INCLUDING a value JSON.stringify throws on
   * (a circular one). Overrides the opts.toClient default once called.
   */
  setWire(v: unknown): void
  /** Resolves once the scheduler has installed watch(); rejects on timeout. */
  waitForWatch(timeoutMs?: number): Promise<void>
  toClient(data: Data): unknown
  readonly calls: ReadonlyArray<{ schedule: string; cfg: unknown; previous: unknown }>
  /** === calls.length */
  readonly fetchCount: number
  countFor(scheduleName: string): number
  /** How many times the scheduler called watch(). */
  readonly watchCalls: number
  /** True once watch() has returned a Disposable. */
  readonly watchInstalled: boolean
  /** How many times the returned Disposable was closed. */
  readonly closeCalls: number
}

const DEFAULT_SCHEDULES: Schedule[] = [{ name: 'poll', intervalMs: 3_600_000, runOnStart: false }]

// An allowlist over the default Data ({ ok: true }), deliberately not identity.
const defaultToClient = (data: unknown): unknown => ({ ok: (data as { ok?: unknown } | null | undefined)?.ok })

export function makeFixtureProvider<Data = unknown>(
  opts: FixtureProviderOptions<Data> = {},
): FixtureProvider<Data> {
  const id = opts.id ?? 'fx'
  const schedules = opts.schedules ?? DEFAULT_SCHEDULES.map(s => ({ ...s }))

  const calls: Array<{ schedule: string; cfg: unknown; previous: unknown }> = []
  let emitFn: (() => void) | undefined
  let watchCalls = 0
  let closeCalls = 0
  let data: Data | undefined
  let hasData = false
  let wire: unknown
  let hasWire = false

  const provider: FixtureProvider<Data> = {
    id,
    configSchema: opts.configSchema ?? { parse: (x: unknown) => x },
    detect: opts.detect ?? (async () => ({ kind: 'nothing-to-detect' })),
    schedules,
    actions: opts.actions ?? [],

    fetch: async (cfg, ctx) => {
      calls.push({ schedule: ctx.schedule, cfg, previous: ctx.previous })
      if (opts.fetch) return opts.fetch(cfg, ctx)
      if (hasData) return data as Data
      return { ok: true } as Data
    },

    toClient: (d: Data) => (hasWire ? wire : (opts.toClient ?? defaultToClient)(d)),

    emit() {
      if (!emitFn) {
        throw new Error(`fixture provider "${id}": emit() called before the scheduler installed watch()`)
      }
      emitFn()
    },

    setData(d: Data) { data = d; hasData = true },
    setWire(v: unknown) { wire = v; hasWire = true },

    async waitForWatch(timeoutMs = 1000): Promise<void> {
      const deadline = Date.now() + timeoutMs
      while (!emitFn) {
        if (Date.now() >= deadline) {
          throw new Error(`fixture provider "${id}": watch() was not installed within ${timeoutMs}ms`)
        }
        await Bun.sleep(1)
      }
    },

    get calls() { return calls },
    get fetchCount() { return calls.length },
    countFor(scheduleName: string) { return calls.filter(c => c.schedule === scheduleName).length },
    get watchCalls() { return watchCalls },
    get watchInstalled() { return emitFn !== undefined },
    get closeCalls() { return closeCalls },
  }

  if (opts.withWatch ?? true) {
    provider.watch = (_cfg: unknown, emit: () => void): Disposable => {
      // Counted before the throw: watchCalls means "how many times the
      // scheduler called watch()", which is the question the generation test
      // asks, and it is asked precisely of a watch that may not install.
      watchCalls++
      if (opts.watchThrows !== undefined) throw new Error(opts.watchThrows)
      emitFn = emit
      return { close() { closeCalls++ } }
    }
  }

  return provider
}
