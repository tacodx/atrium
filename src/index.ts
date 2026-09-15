import { startServer } from './server/serve'
import { loadConfig, ConfigError } from './core/config'

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'serve'

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}

switch (cmd) {
  case 'serve': {
    const port = Number(flag('port') ?? 7373)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`atrium: invalid port "${flag('port')}"`)
      process.exit(78)
    }
    // One try covers BOTH failure sources on purpose: loadConfig()'s
    // file-level errors and createScheduler's per-provider parse errors are the
    // same class of user-facing problem and deserve the same exit code.
    try {
      // Providers are registered through ServeConfig.providers; nothing
      // registers one yet — that wiring lands with the repos provider.
      await startServer({ port, config: loadConfig() })
    } catch (e) {
      if (e instanceof ConfigError) {
        console.error(`atrium: ${e.message}`)
        if (e.cause instanceof Error) console.error(`atrium: ${e.cause.message}`)
        // EX_CONFIG — same convention as this file's port validation above and
        // startServer's EADDRINUSE branch in src/server/serve.ts.
        process.exit(78)
      }
      throw e
    }
    break
  }
  default:
    console.error(`atrium: unknown command "${cmd}"`)
    console.error('usage: atrium serve [--port N]')
    process.exit(64)   // EX_USAGE
}
