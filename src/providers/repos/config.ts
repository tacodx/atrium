/**
 * The four `repos.*` config keys, parsed by hand. No zod: `configSchema` is
 * the structural duck type `{ parse(x: unknown): Cfg }` from src/core/contract.ts.
 *
 * `parse` TRANSFORMS. It never returns its input: a `{ parse: x => x }` shape
 * is exactly the stub that made Plan 1's config coverage undetectable, and it
 * is what mutation M9 of Task 7 reinstates to prove the tests notice.
 *
 * Every field is REQUIRED on the parsed value — defaulting happens here, so no
 * consumer ever writes `cfg.staleDays ?? 30`. Unknown keys are REJECTED by
 * name: a typo such as `staledays`, or a stale `git.staleDays` block copied
 * under `repos`, would otherwise fall back to a default in complete silence
 * (defect class 2 of the plan's defect list).
 */
export interface ReposConfig {
  staleDays: number
  extraRoots: string[]
  includeDotPaths: boolean
  treatAsContainer: string[]
}

/** `staleDays` 30 is fixed by spec §7.1. */
export const REPOS_CONFIG_DEFAULTS: ReposConfig = {
  staleDays: 30,
  extraRoots: [],
  includeDotPaths: false,
  treatAsContainer: [],
}

const KNOWN_KEYS: ReadonlySet<string> = new Set(['staleDays', 'extraRoots', 'includeDotPaths', 'treatAsContainer'])

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function absolutePathArray(v: unknown, key: string): string[] {
  if (!Array.isArray(v) || !v.every((e): e is string => typeof e === 'string' && e.startsWith('/'))) {
    throw new Error(`repos config: ${key} must be an array of absolute paths`)
  }
  // A fresh array, so the parsed value never aliases the raw config record.
  return [...v]
}

/**
 * Returns a FRESH object every call (a `parse(undefined)` result is never the
 * shared `REPOS_CONFIG_DEFAULTS` instance), so two providers cannot alias one
 * mutable default. The result is not frozen here: Task 3 owns the
 * frozen-vs-mutable ruling for the config record as a whole; this provider
 * simply never mutates `cfg`.
 */
export const reposConfigSchema: { parse(x: unknown): ReposConfig } = {
  parse(x: unknown): ReposConfig {
    if (x === undefined || x === null) return { ...REPOS_CONFIG_DEFAULTS, extraRoots: [], treatAsContainer: [] }
    if (!isPlainObject(x)) throw new Error('repos config: expected an object')

    for (const key of Object.keys(x)) {
      if (!KNOWN_KEYS.has(key)) throw new Error(`repos config: unknown key "${key}"`)
    }

    const out: ReposConfig = { ...REPOS_CONFIG_DEFAULTS, extraRoots: [], treatAsContainer: [] }

    if ('staleDays' in x) {
      const v = x.staleDays
      if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) {
        throw new Error('repos config: staleDays must be a positive finite number')
      }
      out.staleDays = v
    }
    if ('includeDotPaths' in x) {
      const v = x.includeDotPaths
      if (typeof v !== 'boolean') throw new Error('repos config: includeDotPaths must be a boolean')
      out.includeDotPaths = v
    }
    if ('extraRoots' in x) out.extraRoots = absolutePathArray(x.extraRoots, 'extraRoots')
    if ('treatAsContainer' in x) out.treatAsContainer = absolutePathArray(x.treatAsContainer, 'treatAsContainer')

    return out
  },
}
