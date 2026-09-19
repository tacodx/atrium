import { readFileSync } from 'node:fs'
import { handoffPath } from '../../src/core/paths'

// THIS FILE is the one place Task 4's handoff filename and body/response key
// names appear in test code: the path comes from `handoffPath`, never a
// filename respelled here (Task 4 writes `handoff.json`, and a second spelling
// in a helper is a silent 401 at setup time), and the value POSTed is the
// parsed `.token`, never the file text, which is a JSON document
// `{ token, port, pid }` that consumeHandoff answers with a 401.

// bun's global WebSocket supports a non-standard second-arg `{ headers }` init
// at runtime — the only way a non-browser client can set Origin on the
// upgrade request (§8.4 test setup below). With this project's DOM lib loaded
// (needed for the web/ frontend), bun-types' declaration merging resolves the
// *type* of the global `WebSocket` to the plain DOM constructor instead
// (whose 2nd param is `protocols: string | string[]`), so tsc rejects the
// object-literal form even though bun executes it correctly — confirmed by
// every test below actually passing.
export function connectWs(url: string, origin: string): WebSocket {
  const Ctor = WebSocket as unknown as new (u: string, opts: { headers: Record<string, string> }) => WebSocket
  return new Ctor(url, { headers: { origin } })
}

/** Reads Task 4's boot handoff FILE and returns its `token` field. */
export function readHandoff(runtimeDir: string): string {
  return JSON.parse(readFileSync(handoffPath({ XDG_RUNTIME_DIR: runtimeDir }), 'utf8')).token as string
}

/**
 * Redeems the boot handoff at POST /api/session and returns the session token.
 * Both `host` and `origin` are required: checkRequest rejects a non-GET that
 * arrives with no Origin header. Throws with the status code on a non-200.
 */
export async function openSession(port: number, runtimeDir: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/session`, {
    method: 'POST',
    headers: {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ handoff: readHandoff(runtimeDir) }),
  })
  if (res.status !== 200) throw new Error(`POST /api/session returned ${res.status}`)
  return ((await res.json()) as { token: string }).token
}
