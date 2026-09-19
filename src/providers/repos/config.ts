/**
 * The nine `repos.*` config keys, parsed by hand. No zod: `configSchema` is
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
/**
 * §8.8's `{cmd, args[]}` shape for the three exec actions (Task 8). `args`
 * carries exactly one element equal to PATH_PLACEHOLDER, which the action
 * layer swaps for the repository path — see validateTemplate for the rules.
 */
export interface CommandTemplate { cmd: string; args: string[] }

export interface ReposConfig {
  staleDays: number
  extraRoots: string[]
  includeDotPaths: boolean
  treatAsContainer: string[]
  metadataConcurrency: number
  metadataTimeoutMs: number
  editor: CommandTemplate
  terminal: CommandTemplate
  claudeTerminal: CommandTemplate
}

/**
 * A single-quoted TS string, NOT a template literal: the value of this
 * constant is the six characters `${path}`, and substitution is exact-element
 * only (renderTemplate in actions.ts).
 */
export const PATH_PLACEHOLDER = '${path}'

/** §7.1's concurrency range is 8–16; 8 is the floor and the default. */
export const METADATA_CONCURRENCY_DEFAULT = 8
/** Higher values are a config error, never a clamp. */
export const METADATA_CONCURRENCY_MAX = 16
/** Matches runGit's own default so nothing is implicit. */
export const METADATA_TIMEOUT_MS_DEFAULT = 5000

/**
 * `staleDays` 30 is fixed by spec §7.1.
 *
 * The three command templates are STATIC defaults a user edits by hand in
 * config.json. §8.8's "defaulted by probing a small allowlist at first run"
 * is not implemented in this slice: first run (detect → confirm → persist) is
 * deferred by the plan, so nothing here probes PATH for an editor or a
 * terminal. The terminal templates carry `--workdir`, `'${path}'` as TWO
 * elements on purpose — see validateTemplate for why the placeholder may never
 * be embedded inside a larger argument.
 */
export const REPOS_CONFIG_DEFAULTS: Readonly<ReposConfig> = {
  staleDays: 30,
  extraRoots: [],
  includeDotPaths: false,
  treatAsContainer: [],
  metadataConcurrency: METADATA_CONCURRENCY_DEFAULT,
  metadataTimeoutMs: METADATA_TIMEOUT_MS_DEFAULT,
  editor: { cmd: 'code', args: ['--', PATH_PLACEHOLDER] },
  terminal: { cmd: 'konsole', args: ['--separate', '--workdir', PATH_PLACEHOLDER] },
  claudeTerminal: { cmd: 'konsole', args: ['--separate', '--workdir', PATH_PLACEHOLDER, '-e', 'claude'] },
}

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'staleDays', 'extraRoots', 'includeDotPaths', 'treatAsContainer',
  'metadataConcurrency', 'metadataTimeoutMs', 'editor', 'terminal', 'claudeTerminal',
])

/** Every array and every template object is a fresh copy — never a shared default instance. */
function freshDefaults(): ReposConfig {
  const d = REPOS_CONFIG_DEFAULTS
  return {
    ...d,
    extraRoots: [],
    treatAsContainer: [],
    editor: { cmd: d.editor.cmd, args: [...d.editor.args] },
    terminal: { cmd: d.terminal.cmd, args: [...d.terminal.args] },
    claudeTerminal: { cmd: d.claudeTerminal.cmd, args: [...d.claudeTerminal.args] },
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

type TemplateKey = 'editor' | 'terminal' | 'claudeTerminal'

/**
 * The five rules, in this order: `cmd` is a non-empty string; `args` is an
 * array of strings; no element other than an exact `PATH_PLACEHOLDER`
 * `.includes(PATH_PLACEHOLDER)`; exactly one element `=== PATH_PLACEHOLDER`;
 * the element immediately before the placeholder exists and starts with `-`.
 *
 * Substitution is EXACT-ELEMENT ONLY (renderTemplate in actions.ts compares
 * `a === PATH_PLACEHOLDER`, never `String.replace`). A template that embedded
 * the placeholder inside a larger argument (`--workdir=${path}`) would hide
 * the value's boundaries inside one argv element, and the "preceded by a
 * literal option" rule would then stop meaning anything: the option and the
 * operand would be one token, and a repository path beginning with a dash
 * could not be told apart from an option. That is also why the default
 * terminal template is `--workdir`, `'${path}'` as two elements.
 *
 * Deliberately NOT checked here: whether `cmd` names the version-control
 * binary. That is enforced at dispatch time by buildArgv's guard in
 * src/core/actions.ts, and spelling the name in any file under src/ trips
 * layer 4 of the tripwire in test/rungit.test.ts.
 */
function validateTemplate(key: TemplateKey, value: unknown): CommandTemplate {
  const v = isPlainObject(value) ? value : {}
  const cmd = v.cmd
  if (typeof cmd !== 'string' || cmd === '') throw new Error(`repos.${key}.cmd must be a non-empty string`)
  const args = v.args
  if (!Array.isArray(args) || !args.every((a): a is string => typeof a === 'string')) {
    throw new Error(`repos.${key}.args must be an array of strings`)
  }
  // The embed rule runs BEFORE the count: `['--workdir=${path}']` has zero
  // exact elements, and the count message would hide the actual mistake.
  if (args.some((a) => a !== PATH_PLACEHOLDER && a.includes(PATH_PLACEHOLDER))) {
    throw new Error(`repos.${key}.args must not embed ${PATH_PLACEHOLDER} inside a larger argument`)
  }
  const exact = args.filter((a) => a === PATH_PLACEHOLDER).length
  if (exact !== 1) throw new Error(`repos.${key}.args must contain exactly one ${PATH_PLACEHOLDER} element`)
  const before = args[args.indexOf(PATH_PLACEHOLDER) - 1]
  if (before === undefined || !before.startsWith('-')) {
    throw new Error(`repos.${key}.args must place a literal option (starting with "-") immediately before ${PATH_PLACEHOLDER}`)
  }
  return { cmd, args: [...args] }
}

/** Reject out-of-range rather than clamp, so a typo is loud. */
function integerInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
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
    if (x === undefined || x === null) return freshDefaults()
    if (!isPlainObject(x)) throw new Error('repos config: expected an object')

    for (const key of Object.keys(x)) {
      if (!KNOWN_KEYS.has(key)) throw new Error(`repos config: unknown key "${key}"`)
    }

    const out: ReposConfig = freshDefaults()

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

    if ('metadataConcurrency' in x) {
      const v = x.metadataConcurrency
      if (!integerInRange(v, 1, METADATA_CONCURRENCY_MAX)) {
        throw new Error(`repos.metadataConcurrency must be an integer between 1 and ${METADATA_CONCURRENCY_MAX}`)
      }
      out.metadataConcurrency = v
    }
    if ('metadataTimeoutMs' in x) {
      const v = x.metadataTimeoutMs
      if (!integerInRange(v, 100, 60000)) throw new Error('repos.metadataTimeoutMs must be an integer between 100 and 60000')
      out.metadataTimeoutMs = v
    }
    if ('editor' in x) out.editor = validateTemplate('editor', x.editor)
    if ('terminal' in x) out.terminal = validateTemplate('terminal', x.terminal)
    if ('claudeTerminal' in x) out.claudeTerminal = validateTemplate('claudeTerminal', x.claudeTerminal)

    return out
  },
}
