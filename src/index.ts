import { readFileSync } from 'node:fs'
import { startServer } from './server/serve'
import { loadConfig, ConfigError } from './core/config'
import { handoffPath } from './core/paths'

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'serve'

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}

const DEFAULT_PORT = 7373

function checkPort(port: number, source: string): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`invalid port (${source}) — must be an integer from 1 to 65535`)
  }
  return port
}

/**
 * `--port` wins, then the config file's `port` key, then 7373.
 *
 * The config key is read HERE and nowhere else. Before this existed,
 * `startServer`'s EADDRINUSE branch told the user to "change it with the
 * `port` key in your config" and NOTHING in the process ever read that key:
 * `loadConfig` accepted it verbatim, nothing consumed it, and the server
 * rebound the default in silence. Measured end to end before the fix —
 * `{"port": 7999}` in a scratch config with no `--port` flag: server bound
 * 7373, nothing on stderr. That is the plan's own silent-default failure shape
 * (ADR 0002 ruling C), reached by following an instruction Atrium itself
 * prints.
 *
 * A bad value is a ConfigError rather than a fall-back to the default, so it
 * exits 78 down the same path as every other config problem.
 */
function resolvePort(config: Readonly<Record<string, unknown>>): number {
  const fromFlag = flag('port')
  // argv is always a string, so it is coerced. A config value is not:
  // `Number(true)` is 1 and `Number([])` is 0, so coercing there would turn
  // nonsense into a plausible-looking port instead of an error.
  if (fromFlag !== undefined) return checkPort(Number(fromFlag), `--port ${fromFlag}`)
  if (!Object.hasOwn(config, 'port')) return DEFAULT_PORT
  const raw = config.port
  if (typeof raw !== 'number') {
    throw new ConfigError(`invalid config: "port" must be a number, got ${JSON.stringify(raw) ?? typeof raw}`)
  }
  return checkPort(raw, `"port": ${raw} in your config`)
}

switch (cmd) {
  case 'serve': {
    // One try covers ALL THREE failure sources on purpose: loadConfig()'s
    // file-level errors, resolvePort's bad-port errors, and createScheduler's
    // per-provider parse errors are the same class of user-facing problem and
    // deserve the same exit code.
    try {
      // loadConfig() runs FIRST because the port can come out of the config
      // file, so the port cannot be resolved until the file has been read.
      const config = loadConfig()
      const port = resolvePort(config)
      // Providers are registered through ServeConfig.providers; nothing
      // registers one yet — that wiring lands with the repos provider.
      await startServer({ port, config })
    } catch (e) {
      if (e instanceof ConfigError) {
        console.error(`atrium: ${e.message}`)
        if (e.cause instanceof Error) console.error(`atrium: ${e.cause.message}`)
        // EX_CONFIG — same convention as checkPort above and startServer's
        // EADDRINUSE branch in src/server/serve.ts.
        process.exit(78)
      }
      throw e
    }
    break
  }
  case 'open': {
    // `--print-url` is a BOOLEAN flag. The flag() helper above returns the NEXT
    // argv element and is wrong for it; use argv.includes.
    if (!argv.includes('--print-url')) {
      // Actually launching a browser is a later plan's job. This slice ships
      // exactly the one subcommand the handoff file needs a reader for.
      console.error('atrium: usage: atrium open --print-url')
      process.exit(64)   // EX_USAGE, matching the default case below
    }
    // READS the boot handoff; it does NOT mint. `handoffs` lives in the closure
    // createAuth() builds inside startServer, so a separate process has no map
    // to mint into. The only other exit would be an unauthenticated mint route,
    // which would hand the session token to every local process.
    const raw = (() => {
      try { return readFileSync(handoffPath(), 'utf8') } catch { return undefined }
    })()
    if (raw === undefined) {
      console.error('atrium: no handoff file found — is the server running? (start it with `atrium serve`)')
      process.exit(69)   // EX_UNAVAILABLE
    }
    const h = JSON.parse(raw) as { token?: unknown; port?: unknown }
    if (typeof h.token !== 'string' || typeof h.port !== 'number') {
      console.error('atrium: handoff file is malformed; restart the server')
      process.exit(69)
    }
    // The handoff rides in the FRAGMENT: a fragment is never sent to the server,
    // never lands in an access log, and the page strips it from the address bar
    // once it has redeemed it. stdout, never stderr — stderr is the journal
    // under systemd, and this line is a credential.
    console.log(`http://127.0.0.1:${h.port}/#${h.token}`)
    break
  }
  default:
    console.error(`atrium: unknown command "${cmd}"`)
    console.error('usage: atrium serve [--port N] | atrium open --print-url')
    process.exit(64)   // EX_USAGE
}
