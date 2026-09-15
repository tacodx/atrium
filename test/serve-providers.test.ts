import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startServer } from '../src/server/serve'
import { makeFixtureProvider } from './fixtures/provider'

// Ports 7430-7433, per the plan-wide port ledger. Every test here writes
// endpoint.json into its own mkdtemp scratch directory via `env`, never the
// developer's real $XDG_RUNTIME_DIR, and removes it in a finally.

test('a registered provider is actually polled by the running server', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'atrium-serveprov-'))
  try {
    const p = makeFixtureProvider({ schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: true }] })
    const s = await startServer({
      port: 7430,
      providers: [p],
      // The marker is the point: an empty {} makes cfg.config reaching
      // createScheduler unobservable, so a serve.ts that passed `{ config: {} }`
      // and dropped cfg on the floor would be indistinguishable from this one.
      config: { fx: { marker: 'threaded' } },
      env: { XDG_RUNTIME_DIR: scratch },
    })
    // The interval is an hour, so the only thing that can have produced a
    // fetch by now is the runOnStart pass — i.e. the scheduler was started.
    await Bun.sleep(20)
    expect(p.fetchCount).toBe(1)
    expect(p.calls[0]?.schedule).toBe('poll')
    expect(p.calls[0]?.cfg).toEqual({ marker: 'threaded' })   // cfg.config really reaches the scheduler
    s.stop()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a duplicate provider id throws before the port binds', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'atrium-serveprov-'))
  try {
    let err: unknown
    try {
      await startServer({
        port: 7431,
        providers: [makeFixtureProvider({ id: 'fx' }), makeFixtureProvider({ id: 'fx' })],
        config: { fx: {} },
        env: { XDG_RUNTIME_DIR: scratch },
      })
    } catch (e) {
      err = e
    }
    expect((err as Error | undefined)?.message).toMatch(/duplicate provider id/i)

    // This half is what pins the POSITION of the registration loop rather than
    // merely the throw: if registration moved below Bun.serve, 7431 would
    // already be taken and this would fail with EADDRINUSE.
    const free = Bun.serve({ hostname: '127.0.0.1', port: 7431, fetch: () => new Response('free') })
    expect(free.port).toBe(7431)
    free.stop()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('server.stop() stops the scheduler', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'atrium-serveprov-'))
  try {
    const p = makeFixtureProvider({ schedules: [{ name: 'poll', intervalMs: 20, runOnStart: false }] })
    const s = await startServer({
      port: 7432,
      providers: [p],
      config: { fx: {} },
      env: { XDG_RUNTIME_DIR: scratch },
    })

    await Bun.sleep(80)
    const before = p.fetchCount
    expect(before).toBeGreaterThan(0)   // the interval really is ticking

    s.stop()
    await Bun.sleep(80)
    expect(p.fetchCount).toBe(before)   // and stopping the server stopped it
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a process with a registered provider exits after stop()', async () => {
  // In-process assertions cannot see this: a live setInterval only keeps a
  // PROCESS alive, and bun's test runner tears the file down regardless. So
  // this spawns a real child whose only job is to start a server with a
  // 20ms-interval provider, stop it, and fall off the end of the script with
  // no explicit process.exit.
  const scratch = mkdtempSync(join(tmpdir(), 'atrium-serveprov-'))
  try {
    const proc = Bun.spawn(
      [process.execPath, 'run', 'test/fixtures/exit-probe.ts', '7433'],
      { env: { ...process.env, XDG_RUNTIME_DIR: scratch }, stderr: 'pipe', stdout: 'pipe' },
    )
    const code = await Promise.race([proc.exited, Bun.sleep(5000).then(() => 'timeout' as const)])
    if (code === 'timeout') {
      proc.kill('SIGKILL')
      throw new Error('exit-probe was still alive after 5s — something is keeping the loop alive')
    }
    expect(code).toBe(0)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
