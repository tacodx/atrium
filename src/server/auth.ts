function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

export interface AuthOptions { ttlMs?: number }

/**
 * A handoff carries its OWN ttl, not the factory's. The boot handoff must
 * outlive `createAuth`'s 60s default by days (see BOOT_HANDOFF_TTL_MS in
 * src/server/serve.ts for why), while anything minted without an explicit
 * window keeps the short one. Storing the ttl per entry is what lets both be
 * true at once — a single closure-level ttl cannot express it.
 */
interface HandoffEntry { issuedAt: number; ttlMs: number }

/**
 * Token transport. NOT a cookie: RFC 6265 §8.5 gives cookies no port isolation,
 * so a session cookie is sent to every other service on loopback, and a page
 * from another localhost port is same-site — SameSite=Strict would not apply.
 *
 * localStorage, NOT sessionStorage: sessionStorage is per-tab, which breaks
 * §9's open-a-tab-on-login (every launch would land unauthenticated).
 * Residual, accepted: localStorage persists the bearer to the browser profile
 * on disk, surviving reboot and profile sync. Spec §8.3.
 */
export function createAuth(opts: AuthOptions = {}) {
  const defaultTtlMs = opts.ttlMs ?? 60_000
  const sessionToken = randomToken()
  const handoffs = new Map<string, HandoffEntry>()   // token -> {issuedAt, ttlMs}

  return {
    sessionToken,

    mintHandoff(now: number, ttlMs: number = defaultTtlMs): string {
      // The ONLY sweep. consumeHandoff deletes exactly the one token it was
      // handed, so without this an expired handoff that is never redeemed
      // stays in the map for the process's lifetime. Today there is exactly
      // one production mint site (startServer's boot handoff), so this never
      // fires in production — it is exercised directly in test/auth.test.ts
      // rather than claimed as covered. Deleting from a Map while iterating
      // it is well-defined in JS.
      for (const [t, e] of handoffs) {
        if (now - e.issuedAt > e.ttlMs) handoffs.delete(t)
      }
      const t = randomToken()
      handoffs.set(t, { issuedAt: now, ttlMs })
      return t
    },

    consumeHandoff(token: string, now: number): boolean {
      const e = handoffs.get(token)
      if (e === undefined) return false
      handoffs.delete(token)                      // single-use, even when expired
      // The ENTRY's ttl, never defaultTtlMs: a handoff minted with an explicit
      // window must be judged by that window on the way back in.
      return now - e.issuedAt <= e.ttlMs
    },

    verifyBearer(req: Request): boolean {
      const h = req.headers.get('authorization')
      if (!h?.startsWith('Bearer ')) return false
      return h.slice(7) === sessionToken
    },

    // Called on the FIRST frame only. The socket must have been sent zero
    // state before this returns true; close 1008 on false.
    authenticateSocket(frame: string): boolean {
      try {
        const msg = JSON.parse(frame)
        return msg?.type === 'auth' && msg?.token === sessionToken
      } catch { return false }
    },
  }
}
