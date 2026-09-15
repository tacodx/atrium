// NOT a test file — `bun test` only collects `*.test.ts`. Spawned as a child
// process by test/serve-providers.test.ts.
//
// Sibling of exit-probe.ts, asking the other half of the teardown question.
// exit-probe covers the `server.stop()` path; this covers the SIGTERM path,
// where the difference between the shipped `shutdown()` and a bare `cleanup()`
// is ONLY that the scheduler is quiesced — and `process.exit(0)` lands in the
// same tick, so neither the exit code nor any timer is observable afterwards.
// The one thing that IS observable is the watcher close() that scheduler.stop()
// performs on the way out, so the probe writes a marker from inside it.
import { appendFileSync } from 'node:fs'
import { startServer } from '../../src/server/serve'
import { makeFixtureProvider } from './provider'

const port = Number(process.argv[2])
const marker = process.argv[3]!

const p = makeFixtureProvider({ schedules: [{ name: 'poll', intervalMs: 20, runOnStart: true }] })
// Wrapped here rather than added as a fixture option: the fixture's member list
// is contractual for the later tasks, and this probe is the only thing that has
// ever needed a side effect on close.
const innerWatch = p.watch!
p.watch = (cfg, emit) => {
  const d = innerWatch(cfg, emit)
  return { close() { appendFileSync(marker, 'scheduler-stopped\n'); d.close() } }
}

await startServer({ port, providers: [p], config: { fx: {} } })
// Not a sleep: the watcher is installed only after the runOnStart pass, and
// startServer deliberately does not await that. Signalling ready before it is
// installed would let the parent's SIGTERM arrive while `watchers` is still
// empty, and the probe would report a failure that is really a race.
await p.waitForWatch(3000)
appendFileSync(marker, 'ready\n')

// No exit of our own: the signal handler is the subject under test.
await new Promise(() => {})
