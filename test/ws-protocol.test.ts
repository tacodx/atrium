import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startServer } from '../src/server/serve'
import { STATE_TOPIC, WIRE_ERROR_CODES, WIRE_ERROR_MESSAGES } from '../src/core/wire'
import type { ServerFrame, WireErrorCode } from '../src/core/wire'
import { makeFixtureProvider } from './fixtures/provider'
import { connectWs, openSession } from './fixtures/ws'

// Port allocation (Task 6 brief, G1 — the plan's table said 7412-7421, but
// Task 4's fix round already put a test on 7412): tests 1-7 take 7413-7419,
// test 17 takes 7420, test 18 takes 7421. Test 8 binds nothing. No spare.

type Server = Awaited<ReturnType<typeof startServer>>

// Every server test writes endpoint.json and handoff.json, so every one gets
// its own scratch XDG_RUNTIME_DIR and removes it in `finally` — never the
// developer's real one (test/serve.test.ts explains what that did once).
function runtimeScratch(): string {
  return mkdtempSync(join(tmpdir(), 'atrium-ws-rd-'))
}

interface Socket {
  sock: WebSocket
  /** Raw text of every frame received, in arrival order. */
  frames: string[]
  closes: number[]
}

async function openSocket(port: number, onOpen?: (s: Socket) => void): Promise<Socket> {
  const sock = connectWs(`ws://127.0.0.1:${port}/ws`, `http://127.0.0.1:${port}`)
  const s: Socket = { sock, frames: [], closes: [] }
  sock.addEventListener('message', (e) => s.frames.push(String(e.data)))
  sock.addEventListener('close', (e) => s.closes.push(e.code))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for open')), 4000)
    sock.addEventListener('open', () => { clearTimeout(timer); onOpen?.(s); resolve() })
    sock.addEventListener('error', () => { clearTimeout(timer); reject(new Error('socket errored before open')) })
  })
  return s
}

/** Resolves once `s.frames.length >= n`; rejects on the deadline so a missing frame is a red, not a hang. */
async function waitForFrames(s: Socket, n: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (s.frames.length < n) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for frame ${n}; have ${s.frames.length}: ${JSON.stringify(s.frames)}`)
    await Bun.sleep(5)
  }
}

async function pollUntil(cond: () => boolean, timeoutMs: number, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error('pollUntil: deadline passed')
    await Bun.sleep(intervalMs)
  }
}

/**
 * Opens a socket, sends the auth frame, and drains `ready` + `snapshot`. The
 * token comes from ONE openSession per test: the boot handoff is single-use,
 * so a second redemption on the same server is a 401 (test/serve.test.ts
 * pins that), and a test with two sockets shares the one session token.
 */
async function authedSocket(port: number, token: string): Promise<Socket> {
  const s = await openSocket(port)
  s.sock.send(JSON.stringify({ type: 'auth', token }))
  // Drains two frames and asserts nothing about them: test 2 owns the
  // ready-then-snapshot claim, and a helper that re-asserted it would turn
  // every caller red under M2 and blur which test pins the order.
  await waitForFrames(s, 2)
  return s
}

function parsed(raw: string): ServerFrame { return JSON.parse(raw) as ServerFrame }
function updates(s: Socket): ServerFrame[] { return s.frames.map(parsed).filter(f => f.type === 'update') }

async function healthz(port: number): Promise<number> {
  return (await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { host: `127.0.0.1:${port}` } })).status
}

test('an unauthenticated socket is subscribed to nothing and receives nothing, even while updates are being published', async () => {
  const scratch = runtimeScratch()
  const port = 7413
  let s: Server | undefined
  let a: Socket | undefined
  try {
    const fixture = makeFixtureProvider({ id: 'fixture' })
    // 5s auth window so the auth-timeout close cannot race the assertions.
    s = await startServer({ port, wsAuthTimeoutMs: 5000, providers: [fixture], config: {}, env: { XDG_RUNTIME_DIR: scratch } })
    a = await openSocket(port)          // sends nothing

    // The positive, deterministic form of §10's mandated WS-auth-gate check:
    // the publish actually happens during the pre-auth window, so "received
    // zero frames" is a claim about a real opportunity to leak, not about an
    // idle server. MUTATION M1: move ws.subscribe(STATE_TOPIC) into
    // websocket.open — the count is 1 here and A receives the update below.
    // MUTATION M3: move the ready/snapshot sends into open — A receives
    // frames it never authenticated for. A version of this test that only
    // asserted "received zero frames" without publishing anything would stay
    // GREEN under M1; that is why it fires emit() and checks subscriberCount.
    expect(s.subscriberCount(STATE_TOPIC)).toBe(0)
    fixture.emit()
    await Bun.sleep(150)
    expect(a.frames).toEqual([])
    expect(a.frames.length).toBe(0)
    expect(s.subscriberCount(STATE_TOPIC)).toBe(0)
  } finally {
    a?.sock.close()
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('an authenticated socket receives ready then snapshot, in that order, and nothing before its auth frame', async () => {
  const scratch = runtimeScratch()
  const port = 7414
  let s: Server | undefined
  let a: Socket | undefined
  try {
    const fixture = makeFixtureProvider<{ n: number }>({ id: 'fixture', toClient: (d) => ({ n: d.n }) })
    s = await startServer({ port, wsAuthTimeoutMs: 5000, providers: [fixture], config: {}, env: { XDG_RUNTIME_DIR: scratch } })
    // A provider that has neither succeeded nor failed produces no snapshot
    // entry at all, so drive one run first — through emit(), never a
    // runOnStart race — and wait for it to land in /api/state.
    fixture.setData({ n: 1 })
    const token = await openSession(port, scratch)
    fixture.emit()
    await pollUntil(() => fixture.fetchCount >= 1, 1000, 5)
    await Bun.sleep(20)

    let lengthAtAuth = -1
    a = await openSocket(port, (sock) => {
      lengthAtAuth = sock.frames.length
      sock.sock.send(JSON.stringify({ type: 'auth', token }))
    })
    await waitForFrames(a, 2)
    await Bun.sleep(50)                  // nothing else may follow
    expect(a.frames.length).toBe(2)
    // Readability aid, not the pin: this is measured inside the client's own
    // open handler, before any server message can be delivered, so it cannot
    // distinguish where the sends live (M3). Test 1 is the pin.
    expect(lengthAtAuth).toBe(0)
    // MUTATION M2: swap the two ws.send calls in the auth branch.
    expect(parsed(a.frames[0]!).type).toBe('ready')
    const snap = parsed(a.frames[1]!)
    expect(snap.type).toBe('snapshot')
    if (snap.type !== 'snapshot') throw new Error('unreachable')
    expect(typeof snap.providers).toBe('object')
    expect(typeof snap.providers.fixture?.schedules).toBe('object')
    expect(snap.providers.fixture?.data).toEqual({ n: 1 })
    expect(s.subscriberCount(STATE_TOPIC)).toBe(1)
  } finally {
    a?.sock.close()
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('an update frame arrives on the fixture emit, carrying the provider id and the failure record', async () => {
  const scratch = runtimeScratch()
  const port = 7415
  let s: Server | undefined
  let a: Socket | undefined
  try {
    const fixture = makeFixtureProvider<{ n: number }>({ id: 'fixture', toClient: (d) => ({ n: d.n }) })
    s = await startServer({ port, providers: [fixture], config: {}, env: { XDG_RUNTIME_DIR: scratch } })
    const token = await openSession(port, scratch)
    a = await authedSocket(port, token)

    fixture.setData({ n: 2 })
    fixture.emit()
    await waitForFrames(a, 3)
    const frame = parsed(a.frames[2]!)
    expect(frame.type).toBe('update')
    if (frame.type !== 'update') throw new Error('unreachable')
    expect(frame.providerId).toBe('fixture')
    expect(frame.status.data).toEqual(fixture.toClient({ n: 2 }))
    expect(frame.status.data).toEqual({ n: 2 })
    // The whole ProviderStatus, health half included — Task 9's
    // unavailable-vs-zero check has no data otherwise. MUTATION M4: publish
    // `{ data: status.data, schedules: {} }` — the key below is gone.
    const scheduleName = fixture.schedules[0]!.name   // computed, not hardcoded
    expect(typeof frame.status.schedules).toBe('object')
    expect(Object.keys(frame.status.schedules)).toContain(scheduleName)
    const health = frame.status.schedules[scheduleName]!
    expect(Object.keys(health).sort()).toEqual(['consecutiveFailures', 'lastErrorMessage', 'lastSuccessAt'])
  } finally {
    a?.sock.close()
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("a socket that subscribed to one provider does not receive another provider's updates", async () => {
  const scratch = runtimeScratch()
  const port = 7416
  let s: Server | undefined
  let a: Socket | undefined
  try {
    const alpha = makeFixtureProvider({ id: 'alpha' })
    const beta = makeFixtureProvider({ id: 'beta' })
    s = await startServer({ port, providers: [alpha, beta], config: {}, env: { XDG_RUNTIME_DIR: scratch } })
    const token = await openSession(port, scratch)
    a = await authedSocket(port, token)

    // Bandwidth management, NOT an authorization control. The authorization control is test 1: an
    // unauthenticated socket is subscribed to nothing. Never cite this test as an access check.
    a.sock.send(JSON.stringify({ type: 'subscribe', providerId: 'alpha' }))
    await Bun.sleep(50)                  // let the server process the frame
    beta.emit()
    await Bun.sleep(100)
    alpha.emit()
    await pollUntil(() => updates(a!).length >= 1, 2000, 5)
    await Bun.sleep(50)

    // MUTATION M6: make the subscribe handler a no-op — the socket stays on
    // the firehose, collects beta's update too, and the count is 2.
    const ups = updates(a)
    expect(ups.length).toBe(1)
    expect(ups[0]).toMatchObject({ type: 'update', providerId: 'alpha' })
  } finally {
    a?.sock.close()
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('closing one authenticated socket leaves the other subscribed and still receiving updates', async () => {
  const scratch = runtimeScratch()
  const port = 7417
  let s: Server | undefined
  let a: Socket | undefined
  let b: Socket | undefined
  try {
    const fixture = makeFixtureProvider({ id: 'fixture' })
    s = await startServer({ port, providers: [fixture], config: {}, env: { XDG_RUNTIME_DIR: scratch } })
    const token = await openSession(port, scratch)
    a = await authedSocket(port, token)
    b = await authedSocket(port, token)
    // MUTATION M7, the REALISABLE form: replace the two server.publish calls
    // with a loop over a module-scope, never-pruned Set of sockets AND
    // replace `ws.subscribe(STATE_TOPIC)` in the auth branch with
    // `live.add(ws)`. Only then is subscriberCount 0 at both checkpoints.
    // The plan's literal text replaces the publishes ONLY, keeping the
    // subscribe, so it leaves this test green and reddens Test 4 alone
    // (measured; the addendum's M7 row). Bun's own close handling is what
    // prunes the subscription, so this pins topic routing over a hand-rolled
    // socket set. (A "does not throw" assertion would be vacuous: ws.send on
    // a closed socket and server.publish after stop() both return 0 without
    // throwing.)
    expect(s.subscriberCount(STATE_TOPIC)).toBe(2)

    a.sock.close()
    const aFramesAtClose = a.frames.length
    await pollUntil(() => s!.subscriberCount(STATE_TOPIC) === 1, 3000, 50)
    expect(s.subscriberCount(STATE_TOPIC)).toBe(1)

    fixture.emit()
    await waitForFrames(b, 3)
    await Bun.sleep(50)
    expect(updates(b).length).toBe(1)
    expect(a.frames.length).toBe(aFramesAtClose)
    expect(await healthz(port)).toBe(200)
  } finally {
    a?.sock.close()
    b?.sock.close()
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('an unserializable provider payload degrades to an error frame and the socket survives', async () => {
  const scratch = runtimeScratch()
  const port = 7418
  let s: Server | undefined
  let a: Socket | undefined
  let b: Socket | undefined
  try {
    const fixture = makeFixtureProvider({ id: 'fixture' })   // wire value starts as { ok: true }
    s = await startServer({ port, providers: [fixture], config: {}, env: { XDG_RUNTIME_DIR: scratch } })
    const token = await openSession(port, scratch)
    a = await authedSocket(port, token)

    const circular: Record<string, unknown> = { ok: true }
    circular.self = circular
    fixture.setWire(circular)
    // MUTATION M8: bare JSON.stringify at the onUpdate listener's call site —
    // the TypeError escapes the listener and this frame never arrives.
    fixture.emit()
    await waitForFrames(a, 3)
    expect(parsed(a.frames[2]!)).toEqual({
      type: 'error', code: 'unserializable', message: WIRE_ERROR_MESSAGES['unserializable'],
    })

    // The companion path (M9): the circular value is now what snapshot()
    // holds, so a socket that authenticates NOW exercises the auth branch's
    // snapshot send. MUTATION M9: bare JSON.stringify at that call site — the
    // handler throws after `ready` and the error frame never arrives.
    b = await authedSocketExpecting(port, token, 'error')
    expect(parsed(b.frames[1]!)).toEqual({
      type: 'error', code: 'unserializable', message: WIRE_ERROR_MESSAGES['unserializable'],
    })
    b.sock.close()

    fixture.setWire({ ok: true })
    fixture.emit()
    await waitForFrames(a, 4)
    const back = parsed(a.frames[3]!)
    expect(back.type).toBe('update')            // the connection survived
    expect(back).toMatchObject({ type: 'update', providerId: 'fixture', status: { data: { ok: true } } })
    expect(a.closes).toEqual([])
    expect(await healthz(port)).toBe(200)
  } finally {
    a?.sock.close()
    b?.sock.close()
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

/** Like authedSocket, but the second frame is expected to be of `secondType` rather than `snapshot`. */
async function authedSocketExpecting(port: number, token: string, secondType: ServerFrame['type']): Promise<Socket> {
  const s = await openSocket(port)
  s.sock.send(JSON.stringify({ type: 'auth', token }))
  await waitForFrames(s, 2)
  expect(parsed(s.frames[0]!).type).toBe('ready')
  expect(parsed(s.frames[1]!).type).toBe(secondType)
  return s
}

test('post-auth frames are answered with closed-set error codes that never echo client input', async () => {
  const scratch = runtimeScratch()
  const port = 7419
  let s: Server | undefined
  let a: Socket | undefined
  try {
    const fixture = makeFixtureProvider({ id: 'fixture' })
    s = await startServer({ port, providers: [fixture], config: {}, env: { XDG_RUNTIME_DIR: scratch } })
    const token = await openSession(port, scratch)
    a = await openSocket(port)
    a.sock.send(JSON.stringify({ type: 'auth', token }))
    await waitForFrames(a, 2)

    a.sock.send('not json at all')
    await waitForFrames(a, 3)
    // A post-auth auth frame must not re-enter the auth branch and must not
    // close the socket.
    a.sock.send(JSON.stringify({ type: 'auth', token }))
    await waitForFrames(a, 4)
    // MUTATION M11: delete the registry.get(id) check — this reply never arrives.
    a.sock.send(JSON.stringify({ type: 'subscribe', providerId: 'definitely-not-registered' }))
    await waitForFrames(a, 5)
    await Bun.sleep(50)
    expect(a.frames.length).toBe(5)
    expect(a.closes).toEqual([])
    expect(a.closes.length).toBe(0)
    expect(a.sock.readyState).toBe(1)   // WebSocket.OPEN

    const replies = a.frames.slice(2).map(parsed) as Array<{ type: 'error'; code: WireErrorCode; message: string }>
    // MUTATION M10: sendError's message becomes `(e as Error).message` from
    // the JSON.parse catch — the equality below is what forbids an exception
    // message or an echo of the client's bytes.
    expect(replies[0]).toEqual({ type: 'error', code: 'bad-frame', message: WIRE_ERROR_MESSAGES['bad-frame'] })
    expect(replies[1]).toMatchObject({ type: 'error', code: 'unknown-frame-type' })
    expect(replies[2]).toMatchObject({ type: 'error', code: 'unknown-provider' })
    for (const r of replies) {
      expect(r.type).toBe('error')
      expect(WIRE_ERROR_CODES.includes(r.code)).toBe(true)
      expect(r.message).toBe(WIRE_ERROR_MESSAGES[r.code])
      expect(r.message).not.toContain('definitely-not-registered')
      expect(r.message).not.toContain(token)
    }
  } finally {
    a?.sock.close()
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('src/core/wire.ts has no imports, so the UI bundle can take it whole', () => {
  // Vite builds web/ with `root: 'web'` and bundles this file from OUTSIDE
  // that root (verified: vite 7.3.6 transforms it with no config change). A
  // `node:` import here breaks the production bundle at release time, and
  // the unit suite — which runs under bun, where `node:` imports resolve
  // fine — would never notice. MUTATION M12: add `import { join } from
  // 'node:path'` at the top of src/core/wire.ts.
  const src = readFileSync('src/core/wire.ts', 'utf8')
  expect(/^\s*import\b/m.test(src)).toBe(false)
  expect(/\brequire\s*\(/.test(src)).toBe(false)
})

test('a run still in flight when stop() is called publishes nothing to a socket that was open', async () => {
  const scratch = runtimeScratch()
  const port = 7420
  let s: Server | undefined
  let a: Socket | undefined
  let unhandled: unknown
  const onUnhandledRejection = (reason: unknown) => { unhandled = reason }
  process.on('unhandledRejection', onUnhandledRejection)
  try {
    const fixture = makeFixtureProvider({
      id: 'fixture',
      fetch: async () => { await Bun.sleep(50); return { ok: true } },   // does NOT honour ctx.signal
    })
    s = await startServer({ port, providers: [fixture], config: {}, env: { XDG_RUNTIME_DIR: scratch } })
    const token = await openSession(port, scratch)
    a = await authedSocket(port, token)
    const drained = a.frames.length

    // What this pins is that `scheduler.stop()` runs on the stop path AT ALL,
    // not that it runs first. Task 2's shutdown is `scheduler.stop();
    // cleanup()` and this task's onUpdate -> publish wire is what makes it
    // observable: the run's post-await abort guard is the only thing
    // suppressing a publish after the server has gone. MUTATION M22, the
    // REALISABLE form: `const shutdown = () => { cleanup() }`, with
    // scheduler.stop() deleted — four red, this test among them (measured;
    // the addendum's M22 row). The plan's literal text — originalStop()
    // before scheduler.stop() in the wrapper — reddens nothing, and no test
    // could make it: both calls are synchronous and land in the same tick, so
    // nothing resumes between them and the ORDER is unobservable.
    fixture.emit()                      // starts the ~50ms run
    await Bun.sleep(10)
    s.stop()
    s = undefined                       // already stopped; the finally must not stop it twice
    await Bun.sleep(200)

    expect(a.frames.length).toBe(drained)
    expect(updates(a)).toEqual([])
    expect(unhandled).toBeUndefined()
  } finally {
    process.off('unhandledRejection', onUnhandledRejection)
    a?.sock.close()
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

const SENTINEL = 'atrium-redaction-sentinel-9f2c41'

test('a Data sentinel never reaches a WS update frame', async () => {
  const scratch = runtimeScratch()
  const port = 7421
  let s: Server | undefined
  let a: Socket | undefined
  try {
    const fixture = makeFixtureProvider<{ token: string; n: number }>({
      id: 'fixture',
      fetch: async () => ({ token: SENTINEL, n: 1 }),
      toClient: (d) => ({ n: d.n }),    // allowlist, never identity
    })
    s = await startServer({ port, providers: [fixture], config: {}, env: { XDG_RUNTIME_DIR: scratch } })
    const token = await openSession(port, scratch)
    a = await authedSocket(port, token)
    fixture.emit()
    await waitForFrames(a, 3)
    const frame = parsed(a.frames[2]!)
    expect(frame.type).toBe('update')
    if (frame.type !== 'update') throw new Error('unreachable')

    // The WS half of Task 5's redaction proof. POSITIVE first: the allowlisted
    // value is what crossed. MUTATION M23 (in src/core/scheduler.ts, the one
    // temporary edit this task may make there): `last.set(providerId, data)`
    // instead of the toClient value — `.data` gains `token`, and the sentinel
    // appears in the raw text below.
    expect(frame.status.data).toEqual({ n: 1 })
    // Then on the RAW TEXT of every frame, not the parsed object: the claim is
    // about the bytes on the wire, and a structural assertion can miss a
    // sentinel hiding in a key name.
    for (const raw of a.frames) expect(raw).not.toContain(SENTINEL)

    // What this test does NOT claim (Task 6 brief, G5): the frame is free of
    // the Data sentinel in `.data`. It is NOT free of provider exception
    // text — `schedules.*.lastErrorMessage` carries a failing fetch's
    // `.message` verbatim, outside toClient, to /api/state and now to this
    // frame too. That channel is recorded as an open plan-level ruling
    // (sanitize at recordFailure, or a closed-set code plus a server-side
    // message); scheduler.ts is not this task's, and a wire-side sanitizer
    // would be the second redaction site the plan forbids. Do not read this
    // test as covering it.
  } finally {
    a?.sock.close()
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})
