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

  // --- Task 4: per-mint ttl, and the sweep that keeps the map from growing. ---

  test('a handoff minted with an explicit ttl outlives the default ttl', () => {
    // Ten minutes is far past createAuth's 60s default above, so this passes
    // only if the PER-MINT ttl is the one stored and the one compared.
    // MUTATION: store `ttlMs: defaultTtlMs` instead of the argument.
    const t = auth.mintHandoff(1000, 604_800_000)
    expect(auth.consumeHandoff(t, 1000 + 600_000)).toBe(true)
  })

  test('minting sweeps handoffs that expired before the new mint', () => {
    const stale = auth.mintHandoff(1000)                 // default 60s window
    auth.mintHandoff(1000 + 60_001)                      // one past it: triggers the sweep
    // Replayed at a moment when `stale` WOULD still be inside its own window.
    // That is what makes this detect the SWEEP rather than the ttl comparison —
    // the same trick 'an expired token is consumed, not merely rejected' uses.
    // MUTATION: delete the sweep loop from mintHandoff.
    expect(auth.consumeHandoff(stale, 1000)).toBe(false)
  })

  test('a live handoff is not swept by a later mint', () => {
    const live = auth.mintHandoff(1000)
    auth.mintHandoff(30_000)                             // still inside live's window
    // Paired with the case above: without this one, `handoffs.clear()` would
    // satisfy the sweep test.
    // MUTATION: replace the sweep loop with handoffs.clear().
    expect(auth.consumeHandoff(live, 30_000)).toBe(true)
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
    // The second entry is a BARE token with no scheme at all, so until the
    // fourth was added the title's "wrong scheme" case did not exist (Plan 2
    // carry-forward M8). `Basic <the real session token>` is the one a
    // scheme-agnostic verifyBearer — `h.split(' ')[1] === sessionToken` —
    // would wrongly accept; entries 1-3 pass under that mutant too.
    const cases: Record<string, string>[] = [
      {},
      { authorization: auth.sessionToken },
      { authorization: 'Bearer nope' },
      { authorization: `Basic ${auth.sessionToken}` },
    ]
    for (const headers of cases) {
      expect(auth.verifyBearer(new Request('http://127.0.0.1:7373/api/state', { headers }))).toBe(false)
    }
  })
})
