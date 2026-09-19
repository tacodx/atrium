import { test, expect } from 'bun:test'
import { acquireToken, TOKEN_STORAGE_KEY } from '../web/src/lib/session'
import type { SessionDeps } from '../web/src/lib/session'
import { connect } from '../web/src/lib/socket'
import type { SocketDeps } from '../web/src/lib/socket'
import { createStore } from '../web/src/lib/store'
import type { ServerFrame } from '../src/core/wire'

// No server, no ports, no DOM — every dependency is injected. These exist
// because the scoping doc specifies the ORDERING and FAILURE HANDLING of the
// client modules explicitly, and an ordering requirement with no test is a
// comment. Numbered 9-16 to match the plan's Task 6 test list; test 19 is
// the fix round's addition and has no number in that list.

// ---- session (tests 9-11) ---------------------------------------------------

function memoryStorage(seed: Record<string, string> = {}): SessionDeps['storage'] & { dump(): Record<string, string> } {
  const m = new Map(Object.entries(seed))
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v) },
    removeItem: (k) => { m.delete(k) },
    dump: () => Object.fromEntries(m),
  }
}

test('acquireToken scrubs the fragment before it POSTs the handoff', async () => {
  const calls: string[] = []
  const storage = memoryStorage()
  const deps: SessionDeps = {
    storage,
    getHash: () => '#' + 'a'.repeat(43),
    clearHash: () => { calls.push('clearHash') },
    redeem: async () => { calls.push('redeem'); return 'fresh-token' },
  }
  const token = await acquireToken(deps)
  // §8.3: the fragment must not survive a failed or slow redemption in the
  // address bar, history or a referrer. MUTATION M13: swap deps.clearHash()
  // and `await deps.redeem(handoff)` in acquireToken.
  expect(calls).toEqual(['clearHash', 'redeem'])
  expect(token).toBe('fresh-token')
  expect(storage.getItem(TOKEN_STORAGE_KEY)).toBe('fresh-token')
})

test('a fresh handoff in the fragment beats a stored token', async () => {
  // sessionToken is regenerated on every startServer, so every
  // `systemctl --user restart atrium` strands a stored token — this is the
  // common path, not an edge case. MUTATION M14: read the stored token first
  // and return early when it is non-null.
  const storage = memoryStorage({ [TOKEN_STORAGE_KEY]: 'stale-token' })
  const deps: SessionDeps = {
    storage,
    getHash: () => '#' + 'b'.repeat(43),
    clearHash: () => {},
    redeem: async () => 'fresh-token',
  }
  expect(await acquireToken(deps)).toBe('fresh-token')
  expect(storage.getItem(TOKEN_STORAGE_KEY)).toBe('fresh-token')
})

test('a malformed fragment is never sent to the server', async () => {
  const redeemed: string[] = []
  let cleared = 0
  const storage = memoryStorage({ [TOKEN_STORAGE_KEY]: 'stored' })
  const deps: SessionDeps = {
    storage,
    getHash: () => '#<script>alert(1)</script>',
    clearHash: () => { cleared++ },
    redeem: async (h) => { redeemed.push(h); return 'should-not-happen' },
  }
  const token = await acquireToken(deps)
  // MUTATION M15: delete the HANDOFF_RE.test(...) guard in parseHandoff —
  // redeem is then called with the script string.
  expect(redeemed).toEqual([])
  expect(redeemed.length).toBe(0)
  expect(cleared).toBe(1)               // a junk fragment is still scrubbed
  expect(token).toBe('stored')
})

// ---- socket (tests 12-13) ---------------------------------------------------

interface FakeSocket extends WebSocket {
  sent: string[]
  fire(type: 'open' | 'close' | 'message', ev?: unknown): void
}

function fakeSocketFactory() {
  const created: FakeSocket[] = []
  const createSocket = (): WebSocket => {
    const listeners = new Map<string, Array<(ev: unknown) => void>>()
    const fake = {
      sent: [] as string[],
      addEventListener(type: string, fn: (ev: unknown) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), fn])
      },
      send(data: string) { fake.sent.push(data) },
      close() {},
      fire(type: string, ev: unknown = {}) { for (const fn of listeners.get(type) ?? []) fn(ev) },
    } as unknown as FakeSocket
    created.push(fake)
    return fake
  }
  return { created, createSocket }
}

function fakeTimers() {
  const delays: number[] = []
  const pending: Array<() => void> = []
  return {
    delays,
    setTimer: (fn: () => void, ms: number) => { delays.push(ms); pending.push(fn); return pending.length },
    clearTimer: () => {},
    /** Runs every scheduled callback (which may schedule more), until none remain. */
    drain() { while (pending.length) pending.shift()!() },
    /** Runs exactly one scheduled callback. */
    step() { const fn = pending.shift(); if (!fn) throw new Error('no pending timer'); fn() },
  }
}

function socketDeps(over: Partial<SocketDeps>): SocketDeps {
  return {
    url: 'ws://example.invalid/ws',
    token: () => 'tok',
    onFrame: () => {},
    onOpen: () => {},
    onClose: () => {},
    onAuthFailure: () => {},
    createSocket: () => { throw new Error('createSocket not injected') },
    setTimer: () => { throw new Error('setTimer not injected') },
    clearTimer: () => {},
    random: () => 0.5,
    ...over,
  }
}

test('a 1008 close clears nothing on the wire and stops reconnecting', () => {
  const sockets = fakeSocketFactory()
  const timers = fakeTimers()
  let authFailures = 0
  connect(socketDeps({
    token: () => 'tok',
    createSocket: sockets.createSocket,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onAuthFailure: () => { authFailures++ },
  }))
  expect(sockets.created.length).toBe(1)
  const ws = sockets.created[0]!
  ws.fire('open')
  // The auth frame is the FIRST frame sent, and nothing precedes it.
  expect(ws.sent.length).toBe(1)
  expect(JSON.parse(ws.sent[0]!)).toEqual({ type: 'auth', token: 'tok' })

  // 1008 is the server's code for a bad first frame AND the auth-window
  // timeout; both mean the stored token is worthless. MUTATION M16: remove
  // the 1008 special case so every close schedules a reconnect — the factory
  // is then called twice after the drain.
  ws.fire('close', { code: 1008 })
  expect(authFailures).toBe(1)
  timers.drain()
  expect(sockets.created.length).toBe(1)
  expect(timers.delays).toEqual([])
})

test('a non-auth close reconnects with a capped, jittered delay', () => {
  const sockets = fakeSocketFactory()
  const timers = fakeTimers()
  connect(socketDeps({
    createSocket: sockets.createSocket,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    random: () => 0.5,
  }))
  // Seven consecutive close(1006) cycles, no `ready` in between (a ready
  // frame resets the attempt counter).
  for (let i = 0; i < 7; i++) {
    const ws = sockets.created[i]!
    ws.fire('close', { code: 1006 })
    if (i < 6) timers.step()            // the reconnect creates socket i+1
  }
  // min(15000, 500 * 2 ** attempt), capped FIRST, then * (0.5 + 0.5 * random()).
  // MUTATION M17: delete the Math.min(RECONNECT_CAP_MS, …) cap — the sixth
  // delay becomes 12000 (500 * 2 ** 5 * 0.75) and the seventh 24000.
  expect(timers.delays).toEqual([375, 750, 1500, 3000, 6000, 11250, 11250])
  expect(sockets.created.length).toBe(7)
})

// ---- store (tests 14-16) ----------------------------------------------------

const snapshotFrame = (providers: unknown): ServerFrame =>
  ({ type: 'snapshot', providers } as ServerFrame)

test('the store hands useSyncExternalStore a stable snapshot identity', () => {
  const store = createStore()
  let fired = 0
  store.subscribe(() => { fired++ })
  // An unmemoized getSnapshot surfaces in React 19 as "Maximum update depth
  // exceeded" — an infinite render loop, not a clear error. MUTATION M18:
  // change getSnapshot to `() => ({ ...state })`.
  const a = store.getSnapshot()
  expect(store.getSnapshot()).toBe(a)
  store.apply({ type: 'update', providerId: 'fx', status: { data: { n: 1 }, schedules: {} } })
  const b = store.getSnapshot()
  expect(b).not.toBe(a)
  expect(store.getSnapshot()).toBe(b)
  expect(fired).toBe(1)
})

test('an update replaces only its own provider entry', () => {
  const store = createStore()
  store.apply(snapshotFrame({ a: { n: 1 }, b: { n: 2 } }))
  const bBefore = store.getSnapshot().providers.b
  store.apply({ type: 'update', providerId: 'a', status: { data: { n: 9 }, schedules: {} } })
  expect(store.getSnapshot().providers.a).toEqual({ data: { n: 9 }, schedules: {} })
  // MUTATION M19: rebuild `providers` from scratch in the update branch
  // instead of copying the existing entries — b is then a new object.
  expect(store.getSnapshot().providers.b).toBe(bBefore)
})

test('a snapshot frame latches hasSnapshot, and a disconnect does not clear it', () => {
  const store = createStore()
  expect(store.getSnapshot().hasSnapshot).toBe(false)
  store.apply(snapshotFrame({}))
  expect(store.getSnapshot().hasSnapshot).toBe(true)
  // Task 9 renders `loading` off this flag, so clearing it on a disconnect
  // flashes a populated pane back to a spinner on every reconnect.
  // MUTATION M21: reset hasSnapshot to false in setConnected(false).
  // The connect step is NOT optional: a fresh store is already disconnected,
  // and setConnected(false) on it is a no-op through the "notify only when
  // something changed" guard — measured, M21 stayed green without it.
  store.setConnected(true)
  expect(store.getSnapshot().connected).toBe(true)
  store.setConnected(false)
  expect(store.getSnapshot().connected).toBe(false)
  expect(store.getSnapshot().hasSnapshot).toBe(true)
})

// ---- socket x store (the fix round's test 19) -------------------------------

test('a junk message body neither throws out of the listener nor moves the store', () => {
  const sockets = fakeSocketFactory()
  const timers = fakeTimers()
  const store = createStore()                       // the REAL store, not a spy
  connect(socketDeps({
    createSocket: sockets.createSocket,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onFrame: (frame) => { store.apply(frame) },
  }))
  const ws = sockets.created[0]!
  ws.fire('open')
  store.apply(snapshotFrame({ a: { data: { n: 1 }, schedules: {} } }))
  const before = store.getSnapshot()

  // Only `not json` makes JSON.parse throw, and the handler's try/catch
  // already covered that one. `null` is the live hazard: it parses, and
  // store.apply(null) reads frame.type — a TypeError raised inside a
  // WebSocket event listener, which the same rule forbids. MUTATION M24:
  // delete `if (typeof parsed !== 'object' || parsed === null) return` from
  // the message handler; the `null` body alone turns this red.
  for (const data of ['null', '42', '"str"', 'not json']) {
    expect(() => ws.fire('message', { data })).not.toThrow()
  }
  expect(store.getSnapshot()).toBe(before)
  expect(store.getSnapshot().providers.a).toEqual({ data: { n: 1 }, schedules: {} })
})
