// NOT a test file — `bun test` only collects `*.test.ts`, and this is spawned
// as a child process by test/serve-providers.test.ts.
//
// The whole point of the probe is what it does NOT do: there is no explicit
// process.exit(). A server whose stop() also stopped the scheduler leaves no
// live handles behind and the process exits on its own; one uncleared
// setInterval and it stays alive forever. That difference is the assertion.
import { startServer } from '../../src/server/serve'
import { makeFixtureProvider } from './provider'

const port = Number(process.argv[2])
const p = makeFixtureProvider({ schedules: [{ name: 'poll', intervalMs: 20, runOnStart: true }] })

const s = await startServer({ port, providers: [p], config: { fx: {} } })
await Bun.sleep(100)
s.stop()
