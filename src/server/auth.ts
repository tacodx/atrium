function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

export interface AuthOptions { ttlMs?: number }

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
  const ttlMs = opts.ttlMs ?? 60_000
  const sessionToken = randomToken()
  const handoffs = new Map<string, number>()   // token -> issuedAt

  return {
    sessionToken,

    mintHandoff(now: number): string {
      const t = randomToken()
      handoffs.set(t, now)
      return t
    },

    consumeHandoff(token: string, now: number): boolean {
      const issued = handoffs.get(token)
      if (issued === undefined) return false
      handoffs.delete(token)                      // single-use, even when expired
      return now - issued <= ttlMs
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
