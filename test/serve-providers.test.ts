import { test, expect } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
    // Not decoration: exit 0 alone is also what a child that never started the
    // scheduler produces, so on its own this test would pass under a serve.ts
    // that dropped `void scheduler.start()`. The count is what makes the name
    // ("a process WITH A REGISTERED PROVIDER exits") true.
    const out = await new Response(proc.stdout).text()
    expect(out).toMatch(/fetches=[1-9]/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('SIGTERM stops the scheduler, not just the endpoint file', async () => {
  // The handlers call shutdown(), not the bare cleanup() that only unlinks
  // endpoint.json. That difference is invisible to an exit code — both spellings
  // reach process.exit(0) in the same tick — so this watches the watcher close()
  // that scheduler.stop() performs on the way out. Measured: reverting the two
  // handlers to cleanup() leaves the child exiting 0 with no marker.
  const scratch = mkdtempSync(join(tmpdir(), 'atrium-serveprov-'))
  const marker = join(scratch, 'marker.log')
  try {
    const proc = Bun.spawn(
      [process.execPath, 'run', 'test/fixtures/sigterm-probe.ts', '7433', marker],
      { env: { ...process.env, XDG_RUNTIME_DIR: scratch }, stderr: 'pipe', stdout: 'pipe' },
    )

    const deadline = Date.now() + 5000
    while (!(existsSync(marker) && readFileSync(marker, 'utf8').includes('ready'))) {
      if (Date.now() > deadline) {
        proc.kill('SIGKILL')
        throw new Error('sigterm-probe never reported ready')
      }
      await Bun.sleep(10)
    }

    proc.kill('SIGTERM')
    const code = await Promise.race([proc.exited, Bun.sleep(5000).then(() => 'timeout' as const)])
    if (code === 'timeout') {
      proc.kill('SIGKILL')
      throw new Error('sigterm-probe ignored SIGTERM — the handler is gone, or it no longer exits')
    }

    expect(code).toBe(0)                                            // the handler ran, rather than the default disposition
    expect(readFileSync(marker, 'utf8')).toMatch(/scheduler-stopped/) // and it went through shutdown(), not cleanup()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
