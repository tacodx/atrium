import { test, expect, describe, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, configFilePath, ConfigError, CONFIG_FILENAME } from '../src/core/config'
import { createScheduler } from '../src/core/scheduler'
import { createRegistry } from '../src/core/registry'
import { startServer } from '../src/server/serve'
import type { Provider } from '../src/core/contract'

// Every test in this file runs against a generated scratch config dir, never
// the developer's real ~/.config/atrium/config.json (spec §10 rule 1), and the
// dirs are removed afterwards rather than left in /tmp (carry-forward P3).
// NO TEST IN THIS FILE MAY CALL loadConfig() WITH NO ARGUMENT.
const made: string[] = []
function scratchConfig(contents?: string): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'atrium-config-'))
  made.push(dir)
  mkdirSync(join(dir, 'atrium'), { recursive: true })
  if (contents !== undefined) writeFileSync(join(dir, 'atrium', CONFIG_FILENAME), contents)
  return { XDG_CONFIG_HOME: dir }
}
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

// A LOCAL provider double, deliberately not test/fixtures/provider.ts.
//
// The reason is narrower than "the fixture is another task's": the fixture's
// configSchema IS a specified option, so most of the tests below could use it.
// What it cannot do is Test 11 — its watch() names its first parameter `_cfg`,
// discards it, and exposes no accessor for it, so a watch-receives-the-parsed-
// value assertion written against the fixture could only count watchCalls and
// would stay green under the very mutation it exists to catch. Keeping all
// eight scheduler-level tests on one shape is the cheaper half of that.
//
// CARRY-FORWARD for Task 5: this is an additional provider stub. When
// `toClient` becomes a required contract member, this helper needs it too.
const provider = (id: string, overrides: Partial<Provider<any, any>> = {}): Provider<any, any> => ({
  id,
  configSchema: { parse: (x: any) => x } as any,
  detect: async () => ({ kind: 'nothing-to-detect' }),
  schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: false }],
  fetch: async () => ({}),
  actions: [],
  ...overrides,
})

// The transform is MANDATORY wherever a test claims fetch/watch/configFor sees
// the parsed value. The three existing stub providers use `{ parse: x => x }`,
// and against an identity parse the parsed and the raw value are the SAME
// OBJECT, so a raw-passthrough implementation is undetectable by construction.
// A {parse: x => x} fixture in Tests 8/9/11 would be a test that cannot fail —
// measured, not assumed: see the fixture check in the task report.
const transform = { parse: (raw: any) => ({ staleDays: Number(raw?.staleDays ?? 0) * 2, marker: 'PARSED' }) }
const RAW = { staleDays: 7, marker: 'RAW' }
const PARSED = { staleDays: 14, marker: 'PARSED' }

describe('loadConfig', () => {
  test('a missing config.json yields an empty object, not a throw', () => {
    const env = scratchConfig()                       // dir created, no file written
    expect(loadConfig(env)).toEqual({})
  })

  test('an empty or whitespace-only config.json yields an empty object', () => {
    for (const contents of ['', '  \n ']) {
      expect(loadConfig(scratchConfig(contents))).toEqual({})
    }
  })

  test('malformed JSON throws ConfigError naming the file path', () => {
    const env = scratchConfig('{ not json')
    const path = join(env.XDG_CONFIG_HOME!, 'atrium', CONFIG_FILENAME)

    expect(() => loadConfig(env)).toThrow(ConfigError)
    expect(() => loadConfig(env)).toThrow(/is not valid JSON/)
    expect(() => loadConfig(env)).toThrow(path)

    let caught: unknown
    try { loadConfig(env) } catch (e) { caught = e }
    // The cause is what lets `atrium serve` print the parser's own message
    // ("Unexpected token n...") under the file-level one.
    expect((caught as ConfigError).cause).toBeInstanceOf(Error)
  })

  test('an unreadable config.json throws ConfigError — it never falls back to defaults', () => {
    const env = scratchConfig()
    const path = join(env.XDG_CONFIG_HOME!, 'atrium', CONFIG_FILENAME)
    // A DIRECTORY, not a chmod-000 file: readFileSync then fails EISDIR
    // deterministically for any uid, where a root-owned CI would still read a
    // 000 file and this test would silently stop testing anything.
    mkdirSync(path)

    expect(() => loadConfig(env)).toThrow(ConfigError)
    expect(() => loadConfig(env)).toThrow(/could not be read/)
    expect(() => loadConfig(env)).toThrow(path)
  })

  test('a non-object top level throws ConfigError', () => {
    for (const contents of ['[]', '"nope"', 'null', '42', 'true']) {
      const env = scratchConfig(contents)
      expect(() => loadConfig(env)).toThrow(ConfigError)
      expect(() => loadConfig(env)).toThrow(/must contain a JSON object/)
    }
  })

  test('the returned record is frozen — config is a snapshot, not a live object', () => {
    const cfg = loadConfig(scratchConfig('{"repos":{"staleDays":7}}'))
    expect(Object.isFrozen(cfg)).toBe(true)
    // The cast is required, not cosmetic: loadConfig's declared return type is
    // Readonly<Record<string, unknown>>, whose index signature is readonly, so
    // the assignment is a COMPILE error before it is ever a TypeError. The
    // readonly annotation is half of the frozen-and-non-live ruling — widening
    // the return type to silence this would pass every test and delete the
    // ruling, so the cast stays and the annotation stays.
    expect(() => { (cfg as Record<string, unknown>).newKey = 1 }).toThrow()
    expect('newKey' in cfg).toBe(false)
  })

  test('reads $XDG_CONFIG_HOME/atrium/config.json', () => {
    const env = scratchConfig('{"demo":{"k":1}}')
    const dir = env.XDG_CONFIG_HOME!
    // Pins that config placement never derives from $HOME when XDG_CONFIG_HOME
    // is set — a $HOME-derived path is a plan-wide prohibition.
    expect(configFilePath({ XDG_CONFIG_HOME: dir })).toBe(join(dir, 'atrium', 'config.json'))
    expect(loadConfig(env)).toEqual({ demo: { k: 1 } })
  })
})

describe('createScheduler config parsing', () => {
  test('parses every registered provider exactly once, at construction, before any fetch', async () => {
    const r = createRegistry()
    let aCount = 0
    let bCount = 0
    r.register(provider('a', { configSchema: { parse: (x: any) => { aCount++; return x } } as any }))
    r.register(provider('b', { configSchema: { parse: (x: any) => { bCount++; return x } } as any }))

    const s = createScheduler(r, { config: { a: {}, b: {} } })
    // BEFORE any runNow. A lazy parse would leave both at 0 here.
    expect(aCount).toBe(1)
    expect(bCount).toBe(1)

    await s.runNow('a', 'poll')
    await s.runNow('a', 'poll')
    s.configFor('a')
    s.configFor('b')
    // Still 1: a per-call parse would now read 3 for 'a'.
    expect(aCount).toBe(1)
    expect(bCount).toBe(1)
  })

  test('fetch receives the PARSED value, not the raw one', async () => {
    const r = createRegistry()
    let sawInFetch: unknown
    r.register(provider('demo', {
      configSchema: transform as any,
      fetch: async (cfg: unknown) => { sawInFetch = cfg; return {} },
    }))

    const s = createScheduler(r, { config: { demo: { ...RAW } } })
    await s.runNow('demo', 'poll')

    expect(sawInFetch).toEqual(PARSED)
    expect(sawInFetch).not.toEqual(RAW)
  })

  test('configFor returns the same parsed object fetch received', async () => {
    const r = createRegistry()
    let sawInFetch: unknown
    r.register(provider('demo', {
      configSchema: transform as any,
      fetch: async (cfg: unknown) => { sawInFetch = cfg; return {} },
    }))

    const s = createScheduler(r, { config: { demo: { ...RAW } } })
    await s.runNow('demo', 'poll')

    expect(s.configFor('demo')).toBe(sawInFetch)
    // The identity assertion alone is what test/contract.test.ts already has,
    // and under an identity parse a configFor returning the RAW value still
    // satisfies it. The toEqual is what gives this test teeth.
    expect(s.configFor('demo')).toEqual(PARSED)
  })

  test('a provider with no config section is parsed from undefined, so its schema can supply defaults', async () => {
    const r = createRegistry()
    // An ARRAY, not a sentinel variable: `let sawRaw: unknown` followed by
    // expect(sawRaw).toBeUndefined() passes when parse was NEVER CALLED, which
    // is exactly the mutation this test exists to catch.
    const parseArgs: unknown[] = []
    let sawInFetch: unknown
    r.register(provider('repos', {
      configSchema: { parse: (raw: any) => { parseArgs.push(raw); return { staleDays: raw?.staleDays ?? 30 } } } as any,
      fetch: async (cfg: unknown) => { sawInFetch = cfg; return {} },
    }))

    const s = createScheduler(r, { config: {} })          // no `repos` key at all
    await s.runNow('repos', 'poll')

    expect(parseArgs).toEqual([undefined])                // called ONCE, with undefined
    expect(sawInFetch).toEqual({ staleDays: 30 })
    expect(s.configFor('repos')).toEqual({ staleDays: 30 })
  })

  test('watch receives the PARSED value too', async () => {
    const r = createRegistry()
    const watchCfgs: unknown[] = []
    r.register(provider('demo', {
      configSchema: transform as any,
      watch: (cfg: unknown) => { watchCfgs.push(cfg); return { close() {} } },
    }))

    // runOnStart: false and a 1h interval (the helper's default schedule), so
    // start() installs the watcher and nothing else fires.
    const s = createScheduler(r, { config: { demo: { ...RAW } } })
    try {
      await s.start()
      expect(watchCfgs).toEqual([PARSED])
      expect(watchCfgs[0]).not.toEqual(RAW)
    } finally {
      s.stop()
    }
  })

  test('a rejecting parse throws ConfigError naming the provider, preserving the original error as cause', () => {
    const r = createRegistry()
    const original = new Error('staleDays must be a positive integer')
    r.register(provider('repos', {
      configSchema: { parse: () => { throw original } } as any,
    }))

    let caught: unknown
    // Synchronously, at construction — in front of startServer's exit-78 path
    // rather than behind the scheduler's fire-and-forget error handling.
    expect(() => createScheduler(r, { config: { repos: { staleDays: -1 } } })).toThrow(ConfigError)
    try { createScheduler(r, { config: { repos: { staleDays: -1 } } }) } catch (e) { caught = e }

    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as Error).message).toMatch(/invalid config for provider "repos"/)
    expect((caught as ConfigError).cause).toBe(original)
    expect(((caught as ConfigError).cause as Error).message).toBe('staleDays must be a positive integer')
  })

  test('a config key with no registered provider is still readable through configFor', () => {
    const r = createRegistry()
    r.register(provider('obsidian'))

    const s = createScheduler(r, { config: { obsidian: {}, repos: { staleDays: 9 } } })

    // A second, dedicated home for the property test/contract.test.ts's
    // 'exposes the same per-provider config the fetch side receives' relies on
    // (its configFor('git') / configFor('absent') assertions), so a future
    // refactor of cfgFor meets a test whose title says what it is for.
    expect(s.configFor('repos')).toEqual({ staleDays: 9 })
    expect(s.configFor('absent')).toBeUndefined()
  })

  test('a provider registered after the scheduler was constructed is a loud error, not a silently unparsed config', async () => {
    const r = createRegistry()
    r.register(provider('early'))
    const s = createScheduler(r, { config: { early: {}, late: { k: 1 } } })

    r.register(provider('late'))                          // AFTER construction

    expect(() => s.configFor('late')).toThrow(/registered after the scheduler/)
    await expect(s.runNow('late', 'poll')).rejects.toThrow(/registered after the scheduler/)
  })
})

describe('config reaches the server', () => {
  test('startServer parses the loaded config before it starts listening', async () => {
    const env = scratchConfig('{"demo":{"staleDays":7}}')
    const parseArgs: unknown[] = []
    const p = provider('demo', {
      configSchema: { parse: (raw: any) => { parseArgs.push(raw); return raw } } as any,
    })

    // Same scratch env is handed to startServer, so endpoint.json lands in the
    // scratch dir and never the developer's real $XDG_RUNTIME_DIR.
    const s = await startServer({ port: 7422, providers: [p], config: loadConfig(env), env })
    try {
      // Immediately, with no polling and no sleep: parsing happens
      // synchronously at scheduler construction, so this is deterministic
      // rather than a race.
      expect(parseArgs).toEqual([{ staleDays: 7 }])
    } finally {
      s.stop()
    }
  })

  test('a malformed config.json exits 78 with the path named, before the port is bound', async () => {
    const env = scratchConfig('{ not json')
    const dir = env.XDG_CONFIG_HOME!

    // The decoy is what makes the "before the port is bound" half FALSIFIABLE.
    // The obvious spelling — bind 7423 AFTER the child exits and assert it
    // works — cannot fail: an exited process has already released its listening
    // socket, so that probe binds whether the child validated first, bound
    // first, or died for an unrelated reason. Holding the port for the child's
    // whole lifetime instead means an implementation that bound before
    // validating would exit 78 down startServer's EADDRINUSE branch and print
    // "already in use" rather than the config message.
    const decoy = Bun.serve({ hostname: '127.0.0.1', port: 7423, fetch: () => new Response('decoy') })
    try {
      const proc = Bun.spawn(
        [process.execPath, 'run', 'src/index.ts', 'serve', '--port', '7423'],
        {
          // XDG_RUNTIME_DIR is scoped too: a child that WRONGLY survives config
          // validation would otherwise write endpoint.json into the
          // developer's real runtime dir.
          env: { ...process.env, XDG_CONFIG_HOME: dir, XDG_RUNTIME_DIR: dir },
          stderr: 'pipe',
        },
      )
      // Guarded, because a mutation that makes loadConfig tolerate malformed
      // JSON produces a child that binds and runs FOREVER. Without this the
      // test would die on bun's timeout and leave a live server holding a
      // machine-global port for every later run.
      const code = await Promise.race([proc.exited, Bun.sleep(5000).then(() => 'timeout' as const)])
      if (code === 'timeout') {
        proc.kill('SIGKILL')
        throw new Error('atrium serve was still alive after 5s — it did not exit on a malformed config')
      }
      const stderr = await new Response(proc.stderr).text()

      expect(code).toBe(78)                               // EX_CONFIG
      expect(stderr).toContain('not valid JSON')
      expect(stderr).toContain(dir)
      // The discriminator: a config failure, NOT a port failure.
      expect(stderr).not.toContain('already in use')
    } finally {
      decoy.stop()
    }
  })

  test('src/index.ts threads the loaded config into startServer, not just validates it', () => {
    // A TEXT tripwire, and labelled as one. `loadConfig(); await startServer({
    // port })` — load it, validate it, drop it — passes every other test in
    // this file and the whole suite, because src/index.ts registers no
    // providers until Task 9, so the threaded value has NO runtime observable
    // anywhere. The realistic regression is Task 9's own wiring dropping the
    // `config:` key while adding `providers:`, which would hand the repos
    // provider undefined forever and silently default staleDays to 30.
    //
    // TASK 9: when you wire `providers: [repos]` into this call, REPLACE this
    // test with an end-to-end assertion that the repos provider's fetch
    // received a value derived from a real config file on disk. That is the
    // first point at which this becomes observable at runtime.
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf8')
    expect(src).toMatch(/startServer\(\{[^}]*\bconfig:\s*loadConfig\(\)/)
  })
})
