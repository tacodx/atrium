import { SESSION_PATH, STATE_PATH } from '../../../src/core/wire'
import type { WireSnapshot } from '../../../src/core/wire'

// Three same-origin fetch helpers. Every path is relative, the token travels
// in the Authorization header and NEVER in a URL (§8.3). A same-origin browser
// POST sends Origin and Sec-Fetch-Site: same-origin automatically, so all
// three pass checkRequest; the absent-Origin rejection only bites non-browser
// callers. No module-scope browser access: `fetch` is touched at call time.

/** POST /api/session with the handoff; the session token on 200, null on any other status. */
export async function redeemHandoff(handoff: string): Promise<string | null> {
  const res = await fetch(SESSION_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handoff }),
  })
  if (res.status !== 200) return null
  const body = (await res.json()) as { token?: unknown }
  return typeof body.token === 'string' ? body.token : null
}

export async function getState(token: string): Promise<WireSnapshot> {
  const res = await fetch(STATE_PATH, { headers: { authorization: `Bearer ${token}` } })
  if (res.status !== 200) throw new Error(`GET ${STATE_PATH} returned ${res.status}`)
  return (await res.json()) as WireSnapshot
}

/**
 * Exported for Task 9; this task has no call site. Actions go over HTTP,
 * always — there is deliberately no WS frame that triggers work.
 */
export async function postAction(
  token: string,
  providerId: string,
  actionId: string,
  target: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/actions/${providerId}/${actionId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(target),
  })
  if (res.status === 200) return { ok: true }
  return { ok: false, error: `${res.status}` }
}
