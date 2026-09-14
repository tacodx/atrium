import { test, expect, describe, beforeEach } from 'bun:test'
import { createAuth } from '../src/server/auth'

describe('handoff token', () => {
  let auth: ReturnType<typeof createAuth>
  beforeEach(() => { auth = createAuth({ ttlMs: 60_000 }) })

  test('a freshly minted token is accepted once', () => {
    const t = auth.mintHandoff(1000)
    expect(auth.consumeHandoff(t, 1000)).toBe(true)
  })

  test('the same token is rejected on second use', () => {
    const t = auth.mintHandoff(1000)
    auth.consumeHandoff(t, 1000)
    expect(auth.consumeHandoff(t, 1000)).toBe(false)   // single-use
  })

  test('a token past its ttl is rejected', () => {
    const t = auth.mintHandoff(1000)
    expect(auth.consumeHandoff(t, 1000 + 60_001)).toBe(false)
  })

  test('an unknown token is rejected', () => {
    expect(auth.consumeHandoff('not-a-real-token', 1000)).toBe(false)
  })

  test('tokens are 32 bytes of csprng, base64url', () => {
    const t = auth.mintHandoff(1000)
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(t).not.toBe(auth.mintHandoff(1000))
  })

  test('an expired token is consumed, not merely rejected', () => {
    const t = auth.mintHandoff(1000)
    // Expired: rejected, AND removed from the map.
    expect(auth.consumeHandoff(t, 1000 + 60_001)).toBe(false)
    // Now replay it at a moment when it WOULD still be within its TTL.
    // Correct implementation: already deleted, so still false.
    // Conditional-delete bug: still in the map and inside the TTL -> true.
    expect(auth.consumeHandoff(t, 1000)).toBe(false)
  })
})

describe('websocket first-frame auth', () => {
  // The browser WS API cannot set headers, and a non-browser local process
  // forges Origin trivially: a raw handshake with a forged Host and no Origin
  // returned 101. Zero state before auth is the control. Spec §8.4.
  let auth: ReturnType<typeof createAuth>
  beforeEach(() => { auth = createAuth({ ttlMs: 60_000 }) })

  test('accepts a correct first frame', () => {
    const frame = JSON.stringify({ type: 'auth', token: auth.sessionToken })
    expect(auth.authenticateSocket(frame)).toBe(true)
  })

  test('rejects a wrong token', () => {
    expect(auth.authenticateSocket(JSON.stringify({ type: 'auth', token: 'wrong' }))).toBe(false)
  })

  test('rejects a first frame that is not an auth frame', () => {
    expect(auth.authenticateSocket(JSON.stringify({ type: 'subscribe' }))).toBe(false)
  })

  test('rejects malformed json', () => {
    expect(auth.authenticateSocket('{not json')).toBe(false)
  })
})

describe('bearer verification', () => {
  let auth: ReturnType<typeof createAuth>
  beforeEach(() => { auth = createAuth({ ttlMs: 60_000 }) })

  test('accepts the session token', () => {
    const req = new Request('http://127.0.0.1:7373/api/state', {
      headers: { authorization: `Bearer ${auth.sessionToken}` },
    })
    expect(auth.verifyBearer(req)).toBe(true)
  })

  test('rejects a missing header, a wrong scheme, and a wrong token', () => {
    // Typed rather than inferred: the inferred union of `{}` with the other
    // two is `{ authorization?: undefined } | { authorization: string }`,
    // which is not a HeadersInit under noUncheckedIndexedAccess.
    const cases: Record<string, string>[] = [{}, { authorization: auth.sessionToken }, { authorization: 'Bearer nope' }]
    for (const headers of cases) {
      expect(auth.verifyBearer(new Request('http://127.0.0.1:7373/api/state', { headers }))).toBe(false)
    }
  })
})
