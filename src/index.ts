import { startServer } from './server/serve'

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
    await startServer({ port })
    break
  }
  default:
    console.error(`atrium: unknown command "${cmd}"`)
    console.error('usage: atrium serve [--port N]')
    process.exit(64)   // EX_USAGE
}
