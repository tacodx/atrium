import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { configDir } from './paths'

/**
 * The config file, and the two rulings this module fixes for the rest of the
 * plan.
 *
 * RULING 1 — NO ZOD, AND NO NEW DEPENDENCY.
 * `package.json`'s `dependencies` are `react` and `react-dom` only, and
 * `contract.ts` types `configSchema` as the structural duck type
 * `{ parse(x: unknown): Cfg }`. Every provider hand-writes its own `.parse`.
 * Plan 1's spec text still mentions zod; that text is stale and a later task
 * reconciles it. Nothing in this codebase validates config through a library.
 *
 * RULING 2 — CONFIG IS FROZEN AND NON-LIVE.
 * `loadConfig` shallow-freezes the top-level record, and `createScheduler`
 * snapshots each provider's parsed value at construction, so there is no
 * reload mechanism in this plan: a config change requires a restart. The
 * freeze is deliberately SHALLOW — nested objects are not deep-frozen, and a
 * `parse` that returns its input by reference hands the provider a mutable
 * object. Providers must treat `cfg` as read-only. First run (`detect()` ->
 * confirm -> persist) is deferred; it will need a writer, and this ruling is
 * what it must be built against.
 *
 * The return type stays `Readonly<Record<string, unknown>>`. That annotation is
 * half of ruling 2 — the runtime freeze is the other half — so widening it to
 * a bare `Record<string, unknown>` to silence a compile error is the wrong
 * direction, and would not fail any test.
 *
 * No top-level side effects: this module is imported by `src/core/scheduler.ts`,
 * which unit tests import constantly. It reads; it never `mkdir`s and never
 * writes.
 */

export const CONFIG_FILENAME = 'config.json'

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConfigError'
  }
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), CONFIG_FILENAME)
}

/** 'an array' / 'null' / the bare typeof, for the top-level rejection message. */
function describe(value: unknown): string {
  if (Array.isArray(value)) return 'an array'
  if (value === null) return 'null'
  return typeof value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, unknown>> {
  const path = configFilePath(env)

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    // A MISSING file is the normal first-run state, not an error. Every OTHER
    // read failure (EACCES, EISDIR, ...) is loud: running on defaults because
    // the user's config file is unreadable is precisely the silent fallback
    // this plan exists to eliminate.
    if ((cause as { code?: string })?.code === 'ENOENT') return Object.freeze({})
    throw new ConfigError(`invalid config: ${path} could not be read`, { cause })
  }

  // `touch config.json` is a plausible user action with no ambiguous meaning.
  // Do not route it through JSON.parse, which throws on ''.
  if (text.trim() === '') return Object.freeze({})

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new ConfigError(`invalid config: ${path} is not valid JSON`, { cause })
  }

  // `typeof null === 'object'` and `typeof [] === 'object'`, so both need their
  // own arm. A top level that is not a record has no provider-id keys to look
  // up, so accepting one would degrade into every provider seeing `undefined`.
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new ConfigError(
      `invalid config: ${path} must contain a JSON object at the top level, got ${describe(value)}`,
    )
  }

  return Object.freeze(value as Record<string, unknown>)
}
