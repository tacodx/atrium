import { redeemHandoff } from './api'

// Token acquisition. Pure logic behind an injected-deps interface: no
// module-scope access to window, document, localStorage, location or history
// anywhere in this file — every browser touch lives inside browserSessionDeps(),
// which only main.tsx calls — so this module is importable under `bun test`
// with no DOM (test/client-wire.test.ts tests 9-11).

export const TOKEN_STORAGE_KEY = 'atrium.token'
// The mint produces 43 base64url characters from 32 random bytes; the range
// is deliberately wider than 43 so a future token length is not a client
// change. Anything outside it is never sent to the server (test 11, M15).
export const HANDOFF_RE = /^[A-Za-z0-9_-]{16,256}$/

export interface SessionDeps {
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
  getHash(): string
  clearHash(): void
  redeem(handoff: string): Promise<string | null>
}

/** Strips a single leading `#` and returns the value only if it matches HANDOFF_RE. */
export function parseHandoff(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  return HANDOFF_RE.test(raw) ? raw : null
}

/**
 * Runs in exactly this order, and the order is the specification:
 *
 * 1. parse the fragment;
 * 2. if it carries a handoff, SCRUB THE FRAGMENT FIRST, then redeem it, and
 *    store + return the session token if redemption succeeded;
 * 3. otherwise fall back to the stored token (may be null).
 *
 * Scrubbing before the network call is §8.3's requirement, not a nicety: the
 * fragment must not survive a failed or slow redemption in the address bar,
 * browser history or a subsequent referrer (test 9, M13).
 *
 * A fresh handoff BEATS a stored token: sessionToken is regenerated on every
 * startServer, so after `systemctl --user restart atrium` the stored token is
 * dead, and a stored-first ordering would strand the user on a token that can
 * only ever 401 (test 10, M14).
 */
export async function acquireToken(deps: SessionDeps): Promise<string | null> {
  const hash = deps.getHash()
  const handoff = parseHandoff(hash)
  if (handoff !== null) {
    deps.clearHash()
    const t = await deps.redeem(handoff)
    if (t !== null) {
      deps.storage.setItem(TOKEN_STORAGE_KEY, t)
      return t
    }
  } else if (hash !== '' && hash !== '#') {
    // A fragment that is not a handoff is scrubbed too (test 11 pins it) and
    // never redeemed: nothing that fails HANDOFF_RE is ever sent to the server.
    deps.clearHash()
  }
  return deps.storage.getItem(TOKEN_STORAGE_KEY)
}

export function clearToken(deps: Pick<SessionDeps, 'storage'>): void {
  deps.storage.removeItem(TOKEN_STORAGE_KEY)
}

/** The only place this module touches the browser. The replacement URL never includes location.hash. */
export function browserSessionDeps(): SessionDeps {
  return {
    storage: localStorage,
    getHash: () => location.hash,
    clearHash: () => history.replaceState(null, '', location.pathname + location.search),
    redeem: redeemHandoff,
  }
}
