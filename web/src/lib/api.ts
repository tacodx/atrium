import { SESSION_PATH, STATE_PATH } from '../../../src/core/wire'
import type { WireSnapshot } from '../../../src/core/wire'
import { TOKEN_STORAGE_KEY } from './session'

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

/**
 * The repos pane's action entry point. The plan pins this SIGNATURE —
 * (actionId, path) — and pins that main.tsx passes it straight through as the
 * pane's `onAction`, which is why the token is not a parameter: main.tsx holds
 * the token only inside its useEffect closure, never in state, so a
 * pane-facing signature could not carry one. Reported in the task-9 report as
 * a cross-task interface gap rather than patched by widening the signature.
 *
 * The token is therefore read from storage AT CALL TIME. TOKEN_STORAGE_KEY is
 * imported from ./session rather than re-spelled: two copies of a storage key
 * is how a signed-in page starts reading an empty slot. The read lives inside
 * the body, so this module still has no module-scope browser access (see the
 * note at the top of this file) and stays importable under `bun test`.
 *
 * No second fetch implementation: this delegates to postAction above. With no
 * stored token it resolves without a fetch — there is nothing to authenticate
 * with, and the request could only ever 401.
 */
export async function postReposAction(actionId: string, path: string): Promise<void> {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY)
  if (token === null) return
  await postAction(token, 'repos', actionId, { path })
}
