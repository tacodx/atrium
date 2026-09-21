import { test, expect, describe, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
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
// CARRY-FORWARD for Task 5 (expanded in fix round 1 / F15): this is an
// additional provider stub — the FOURTH `Provider<…>`-typed factory under
// test/, where Task 5's acceptance sentence says three. The others are
// test/actions.test.ts, test/contract.test.ts and test/routes.test.ts; read
// that sentence as four.
//
// `toClient` is a required contract member (Task 5), so this helper carries
// one, and the substantive rule is not merely "have the member": a `toClient`
// must be an EXPLICIT FIELD-BY-FIELD ALLOWLIST — never identity, never
// `{ ...d }`. A spread satisfies any "toClient exists" check while shipping
// every secret the provider holds, and the allowlist shape is the property
// Task 5's M2 and Task 6's frame tests both depend on. The constant below IS
// that allowlist: the default `fetch` returns `{}`, so the allowlist over this
// Data names zero fields and exposes none, which is neither identity nor a
// spread — do not "fix" it into one.
const provider = (id: string, overrides: Partial<Provider<any, any>> = {}): Provider<any, any> => ({
  id,
  configSchema: { parse: (x: any) => x } as any,
  detect: async () => ({ kind: 'nothing-to-detect' }),
  schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: false }],
  fetch: async () => ({}),
  toClient: () => ({ wire: true }),
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
    const cfg = loadConfig(env)
    expect(cfg).toEqual({})
    // The freeze is asserted HERE and not only in Test 5, because Test 5 covers
    // the PARSED-value return while these two cover the early returns. The
    // brief's M8 mutates all three at once and so is caught by Test 5 alone;
    // narrowed to just the ENOENT and empty-file arms it left the whole suite
    // green — measured, fix round 1 / F9. A missing config file is the
    // documented normal first-run state, so this is the COMMON path.
    expect(Object.isFrozen(cfg)).toBe(true)
  })

  test('an empty or whitespace-only config.json yields an empty object', () => {
    for (const contents of ['', '  \n ']) {
      const cfg = loadConfig(scratchConfig(contents))
      expect(cfg).toEqual({})
      expect(Object.isFrozen(cfg)).toBe(true)          // same narrowed-M8 witness as above
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

  // RENAMED in fix round 1 (was 'a non-object top level throws ConfigError'):
  // the `got X` half is now asserted, so the title says so. Still the test the
  // brief's M10 row names (Test 4).
  test('a non-object top level throws ConfigError naming what it got instead', () => {
    // The `got X` suffix is asserted, not just the sentence in front of it.
    // `describe()` has its own `Array.isArray -> 'an array'` and
    // `=== null -> 'null'` arms precisely because `typeof [] === 'object'` and
    // `typeof null === 'object'`, and those two arms are the two that silently
    // degrade: replacing describe()'s whole body with `return typeof value`
    // turns "[]" into "got object" and "null" into "got object" and left the
    // WHOLE suite green — measured, fix round 1 / NF1. Asserting only
    // /must contain a JSON object/ cannot see that.
    const cases = [
      ['[]', 'an array'],
      ['"nope"', 'string'],
      ['null', 'null'],
      ['42', 'number'],
      ['true', 'boolean'],
    ] as const
    for (const [contents, described] of cases) {
      const env = scratchConfig(contents)
      expect(() => loadConfig(env)).toThrow(ConfigError)
      expect(() => loadConfig(env)).toThrow(`must contain a JSON object at the top level, got ${described}`)
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
    r.register(provider('a', {
      configSchema: { parse: (x: any) => { aCount++; return x } } as any,
      // ADDED in fix round 1 (F8): a watch, so the "exactly once" in this
      // test's title covers all THREE read sites rather than only fetch and
      // configFor. Without a start() in this test, a second parse site inside
      // installSources() was invisible to these counters.
      watch: () => ({ close() {} }),
    }))
    r.register(provider('b', { configSchema: { parse: (x: any) => { bCount++; return x } } as any }))

    const s = createScheduler(r, { config: { a: {}, b: {} } })
    // BEFORE any runNow. A lazy parse would leave both at 0 here.
    expect(aCount).toBe(1)
    expect(bCount).toBe(1)

    await s.runNow('a', 'poll')
    await s.runNow('a', 'poll')
    s.configFor('a')
    s.configFor('b')
    // The third read site: installSources() calls p.watch(cfgFor(p.id)).
    // runOnStart is false and the interval is 1h (the helper's default
    // schedule), so start() installs the watcher and nothing else fires.
    try {
      await s.start()
    } finally {
      s.stop()
    }
    // Still 1: a per-call parse would now read 3 for 'a', and a SECOND parse
    // site inside installSources() would read 2.
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

    // ASSERTED BEFORE any runNow, deliberately. After a runNow, a mutation
    // that skips the parse reddens this test through cfgFor's
    // registered-after-construction throw instead — which is a DIFFERENT
    // property's mutation, and would leave the parse call itself unpinned.
    // Measured: with this assertion below the runNow, the skip-undefined
    // mutation never reaches it.
    //
    // And the length is asserted SEPARATELY, because
    // `expect(parseArgs).toEqual([undefined])` is itself vacuous here:
    // toEqual ignores array sparseness and undefined entries, so in bun 1.3.11
    // `expect([]).toEqual([undefined])` PASSES. Measured with a throwaway
    // probe, not assumed. toStrictEqual also distinguishes them; the explicit
    // length says out loud which half is load-bearing.
    expect(parseArgs.length).toBe(1)                      // called EXACTLY once...
    expect(parseArgs[0]).toBeUndefined()                  // ...with undefined

    await s.runNow('repos', 'poll')
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
      // IDENTITY, not structural equality — added in fix round 1 (F8). The
      // toEqual above is fully satisfied by a SECOND parse site: rewriting the
      // call as `p.watch(p.configSchema.parse(opts.config[p.id]))` produces a
      // correct but freshly-allocated value, which is exactly what this
      // module's own comment declares impossible ("The ONE parse site in the
      // system"). Measured: that mutation left the whole suite green before
      // this line existed, and reddens here with bun's "serializes to the same
      // string" — the literal signature of structurally-equal-but-not-identical.
      expect(watchCfgs[0]).toBe(s.configFor('demo'))
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

  // ADDED in fix round 1 (F6). The complement of the test above, and the reason
  // cfgFor asks `parsed.has(id)` rather than `parsed.get(id) !== undefined`:
  // "parsed to undefined" and "never parsed" are DIFFERENT states, and only the
  // second is an error.
  //
  // MUTATION THIS PINS: in cfgFor, `if (parsed.has(providerId))` ->
  // `if (parsed.get(providerId) !== undefined)`. That is the shape a refactorer
  // naturally reaches for, and under it a correctly-registered, correctly-parsed
  // provider throws the registered-after-construction error instead of serving
  // its config. Measured before this test existed: the mutation left the whole
  // suite green (163 pass / 0 fail).
  test('a provider whose parse returns undefined is a PARSED entry, not an unregistered one', () => {
    const r = createRegistry()
    r.register(provider('quiet', { configSchema: { parse: () => undefined } as any }))
    const s = createScheduler(r, { config: { quiet: { k: 1 } } })

    expect(() => s.configFor('quiet')).not.toThrow()
    expect(s.configFor('quiet')).toBeUndefined()
    // And it is the PARSED undefined, not the raw record leaking out through
    // cfgFor's no-such-provider fallback.
    expect(s.configFor('quiet')).not.toEqual({ k: 1 })

    // The realistic trigger is blander than a schema that returns undefined on
    // purpose: this file's own default stub is `{ parse: x => x }`, so ANY
    // provider with no section in the config file also parses to `undefined`.
    // That is exactly what `startServer({ port, providers: [fx] })` with no
    // `config:` key produces — the shape Tasks 4-9 write constantly.
    const r2 = createRegistry()
    r2.register(provider('plain'))                        // identity parse, no config section
    const s2 = createScheduler(r2, { config: {} })
    expect(() => s2.configFor('plain')).not.toThrow()
    expect(s2.configFor('plain')).toBeUndefined()
  })
})

describe('config reaches the server', () => {
  // RENAMED in fix round 1 (F7). It was
  // 'startServer parses the loaded config before it starts listening', and the
  // "before it starts listening" half was a claim no assertion in it could see:
  // moving the createScheduler call BELOW the Bun.serve try/catch left this
  // test green (measured — whole suite 163 pass / 0 fail under that mutation).
  // What it does pin, precisely and only, is the brief's M13 (serve.ts
  // hardcoding `{ config: {} }`). The ordering half now has its own test
  // directly below.
  test("startServer hands the loaded config to the scheduler's parse loop", async () => {
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

  // ADDED in fix round 1 (F7): the ordering property the test above only
  // claimed in its title.
  //
  // MUTATION THIS PINS: in src/server/serve.ts, replace
  // `const scheduler = createScheduler(...)` with
  // `let scheduler!: ReturnType<typeof createScheduler>` and move the
  // construction BELOW the Bun.serve try/catch. startServer still rejects with
  // a ConfigError, so a rejects.toThrow assertion alone stays green — measured,
  // whole suite 163 pass / 0 fail. The only observable difference is that the
  // port was bound on the way out, and the mutant never unbinds it.
  //
  // 7422 is reused from the test above deliberately: a CORRECT implementation
  // never binds it here, and the test above stops its own server. Staying
  // inside T3's ledger allocation (7422-7423) rather than claiming a new
  // machine-global port.
  test('a provider whose config is rejected fails startServer with the port never bound', async () => {
    const bad = provider('demo', {
      configSchema: { parse: () => { throw new Error('staleDays must be a positive integer') } } as any,
    })

    await expect(
      // Scratch env, so a mutant that gets far enough to write endpoint.json
      // writes it into the scratch dir and never the developer's real one.
      startServer({ port: 7422, providers: [bad], config: { demo: { staleDays: -1 } }, env: scratchConfig() }),
    ).rejects.toThrow(ConfigError)

    let bound: ReturnType<typeof Bun.serve>
    try {
      bound = Bun.serve({ hostname: '127.0.0.1', port: 7422, fetch: () => new Response('free') })
    } catch (e) {
      // Re-thrown with a NAMED cause rather than letting bun's bare
      // "Is port 7422 in use?" stand: under the mutation above it is
      // startServer that left the port bound, and the raw message does not say
      // so. This is the line that goes red.
      throw new Error(`startServer bound port 7422 before rejecting the config — ${(e as Error).message}`)
    }
    try {
      expect(bound.port).toBe(7422)
    } finally {
      bound.stop()
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
          env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, XDG_RUNTIME_DIR: dir },
          stderr: 'pipe',
        },
      )
      // Guarded, because a mutation that makes loadConfig tolerate malformed
      // JSON produces a child that binds and runs FOREVER. Without this the
      // test would die on bun's timeout and leave a live server holding a
      // machine-global port for every later run.
      // 3s, not 5s (tightened in fix round 1): bun's own per-test timeout is
      // also 5000ms, so a 5s guard ties with it and loses — the runner reaps
      // the child with an anonymous "timed out after 5000ms" instead of this
      // named diagnostic firing and SIGKILLing it here. Measured.
      const code = await Promise.race([proc.exited, Bun.sleep(3000).then(() => 'timeout' as const)])
      if (code === 'timeout') {
        proc.kill('SIGKILL')
        throw new Error('atrium serve was still alive after 3s — it did not exit on a malformed config')
      }
      const stderr = await new Response(proc.stderr).text()

      expect(code).toBe(78)                               // EX_CONFIG
      expect(stderr).toContain('not valid JSON')
      expect(stderr).toContain(dir)
      // The discriminator: a config failure, NOT a port failure.
      expect(stderr).not.toContain('already in use')
      // ADDED in fix round 1 (F10). src/index.ts prints the ConfigError's
      // message AND, on a second line, its `cause`'s message — the parser's own
      // "JSON Parse error: ..." — and that second line is what a user actually
      // debugs with. Deleting it left the whole suite green (measured, 163 pass
      // / 0 fail), while test/config.test.ts's Test 3 asserted in a COMMENT
      // that this is what the CLI prints. Counting the lines rather than
      // matching the parser's wording keeps this independent of bun's exact
      // JSON error text.
      expect(stderr.match(/^atrium: /gm) ?? []).toHaveLength(2)
    } finally {
      decoy.stop()
    }
  })

  // --- ADDED in fix round 1 (F12): the config file's `port` key. ---
  //
  // src/server/serve.ts's EADDRINUSE branch prints "Change it with the "port"
  // key in your config, or free the port." That sentence is live and
  // test-pinned (deleting the console.error reddens
  // test/serve.test.ts's 'a port collision exits 78, not a restart loop'), and
  // before this round the advice it gives was INERT: measured end to end, a
  // scratch config containing {"port": 7999} with no --port flag was accepted
  // verbatim by loadConfig, read by nothing, and the server bound 7373 with
  // nothing on stderr. A user following Atrium's own instruction walked into
  // the plan's silent-default failure shape (ADR 0002 ruling C).
  //
  // These three children spawn the real entry point, because the resolution
  // lives in src/index.ts's argv handling and has no in-process seam.
  // XDG_RUNTIME_DIR is scoped to the same scratch dir, so endpoint.json — the
  // observable below — is private to the test and never the developer's real
  // runtime dir.

  async function waitForEndpoint(dir: string): Promise<Record<string, unknown> | undefined> {
    const epPath = join(dir, 'atrium', 'endpoint.json')
    // 3s, NOT 5s: bun's own per-test timeout is 5000ms, so a 5s guard here
    // ties with it and bun's anonymous "timed out after 5000ms" wins the race
    // instead of this file's named diagnostic. Measured under the F12-a
    // mutation in fix round 1.
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (existsSync(epPath)) return JSON.parse(readFileSync(epPath, 'utf8'))
      await Bun.sleep(50)
    }
    return undefined
  }

  test('the config file\'s "port" key is what binds when no --port is given', async () => {
    // MUTATION THIS PINS: delete the `Object.hasOwn(config, 'port')` arm from
    // resolvePort so it always returns DEFAULT_PORT — i.e. restore the
    // pre-fix-round behaviour. The child then binds 7373 and the url assertion
    // below reddens.
    const env = scratchConfig('{"port":7425}')
    const dir = env.XDG_CONFIG_HOME!

    const proc = Bun.spawn(
      [process.execPath, 'run', 'src/index.ts', 'serve'],          // deliberately NO --port
      { env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, XDG_RUNTIME_DIR: dir }, stderr: 'pipe', stdout: 'pipe' },
    )
    try {
      const written = await waitForEndpoint(dir)
      // endpoint.json records the URL the server ACTUALLY bound, so this reads
      // the real bind rather than inferring it from a successful fetch.
      expect(written).toBeDefined()
      expect(String(written!.url)).toContain('7425')
      expect(String(written!.url)).not.toContain('7373')            // not the silent default
    } finally {
      proc.kill('SIGKILL')
      await proc.exited
    }
  })

  test('--port still wins over the config file\'s "port"', async () => {
    // MUTATION THIS PINS: reverse the precedence in resolvePort (check the
    // config key before the flag). Every OTHER spawn test in the suite passes
    // --port against an EMPTY config, so none of them can see it.
    const env = scratchConfig('{"port":7425}')
    const dir = env.XDG_CONFIG_HOME!

    const proc = Bun.spawn(
      [process.execPath, 'run', 'src/index.ts', 'serve', '--port', '7426'],
      { env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, XDG_RUNTIME_DIR: dir }, stderr: 'pipe', stdout: 'pipe' },
    )
    try {
      const written = await waitForEndpoint(dir)
      expect(written).toBeDefined()
      expect(String(written!.url)).toContain('7426')
      expect(String(written!.url)).not.toContain('7425')
    } finally {
      proc.kill('SIGKILL')
      await proc.exited
    }
  })

  test('a nonsense "port" in the config exits 78 rather than silently rebinding the default', async () => {
    // MUTATION THIS PINS: make resolvePort fall back on a bad value —
    // `return typeof raw === 'number' ? raw : DEFAULT_PORT`, or the more
    // tempting `Number(raw) || DEFAULT_PORT`. Under either, the child starts
    // happily on 7373 and runs forever; the guard below turns that into a named
    // failure instead of a bun timeout with a live server left holding a
    // machine-global port.
    const env = scratchConfig('{"port":"not-a-port"}')
    const dir = env.XDG_CONFIG_HOME!

    const proc = Bun.spawn(
      [process.execPath, 'run', 'src/index.ts', 'serve'],          // deliberately NO --port
      { env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, XDG_RUNTIME_DIR: dir }, stderr: 'pipe' },
    )
    // 3s for the same reason as waitForEndpoint above: a 5s race ties with
    // bun's own 5000ms test timeout and loses, so the child is reaped by the
    // runner with an anonymous message instead of being SIGKILLed here with a
    // named one. Measured under the F12-a mutation in fix round 1.
    const code = await Promise.race([proc.exited, Bun.sleep(3000).then(() => 'timeout' as const)])
    if (code === 'timeout') {
      proc.kill('SIGKILL')
      throw new Error('atrium serve was still alive after 3s — it fell back to a default port instead of rejecting a bad one')
    }
    const stderr = await new Response(proc.stderr).text()

    expect(code).toBe(78)                                          // EX_CONFIG
    expect(stderr).toContain('"port" must be a number')
    expect(stderr).toContain('not-a-port')                         // the offending value, named
    // Never started: no endpoint.json, so nothing bound.
    expect(existsSync(join(dir, 'atrium', 'endpoint.json'))).toBe(false)
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
    // UPDATED in fix round 1 (F12): the `serve` case now binds
    // `const config = loadConfig()` on its own line, because the port is
    // resolved OUT of that value, so the old single `config: loadConfig()`
    // pattern no longer describes the shipped shape. BOTH halves are asserted,
    // because either one alone is satisfied by load-validate-drop.
    expect(src).toMatch(/\bconst config = loadConfig\(\)/)
    expect(src).toMatch(/startServer\(\{[^}]*\bconfig\b[^}]*\}\)/)
  })
})
