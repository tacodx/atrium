import { test, expect } from 'bun:test'
import { startServer } from '../src/server/serve'

// bun's global WebSocket supports a non-standard second-arg `{ headers }` init
// at runtime — the only way a non-browser client can set Origin on the
// upgrade request (§8.4 test setup below). With this project's DOM lib loaded
// (needed for the web/ frontend), bun-types' declaration merging resolves the
// *type* of the global `WebSocket` to the plain DOM constructor instead
// (whose 2nd param is `protocols: string | string[]`), so tsc rejects the
// object-literal form even though bun executes it correctly — confirmed by
// every test below actually passing.
function connectWs(url: string, origin: string): WebSocket {
  const Ctor = WebSocket as unknown as new (u: string, opts: { headers: Record<string, string> }) => WebSocket
  return new Ctor(url, { headers: { origin } })
}

test('/healthz is unauthenticated but still gated', async () => {
  const s = await startServer({ port: 7391 })
  const ok = await fetch('http://127.0.0.1:7391/healthz', { headers: { host: '127.0.0.1:7391' } })
  expect(ok.status).toBe(200)
  const body = await ok.json()
  expect(body.nonce).toBeString()          // the launcher proves it reached OUR process
  expect(body.pid).toBe(process.pid)

  const bad = await fetch('http://127.0.0.1:7391/healthz', { headers: { host: 'evil.com:7391' } })
  expect(bad.status).toBe(403)
  s.stop()
})

test('a token-gated route rejects a request with no bearer', async () => {
  const s = await startServer({ port: 7392 })
  const res = await fetch('http://127.0.0.1:7392/api/state', { headers: { host: '127.0.0.1:7392' } })
  expect(res.status).toBe(401)
  s.stop()
})

test('every response carries the standard security headers', async () => {
  const s = await startServer({ port: 7393 })
  const res = await fetch('http://127.0.0.1:7393/healthz', { headers: { host: '127.0.0.1:7393' } })
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  s.stop()
})

test('a port collision exits 78, not a restart loop', async () => {
  const decoy = Bun.serve({ hostname: '127.0.0.1', port: 7394, fetch: () => new Response('squatter') })
  const proc = Bun.spawn([process.execPath, 'run', 'src/index.ts', 'serve', '--port', '7394'], { stderr: 'pipe' })
  const code = await proc.exited
  expect(code).toBe(78)                                        // EX_CONFIG
  expect(await new Response(proc.stderr).text()).toContain('7394')
  decoy.stop()
})

// --- Controller-added requirement (a): verify the WebSocket zero-state contract. ---
//
// The gate only checks Host/Origin on the HTTP upgrade; a non-browser local process
// forges Origin trivially. The one thing that makes that survivable is that a socket
// which hasn't authenticated gets ZERO application data and is closed 1008 the moment
// it's clear it won't authenticate — either because its first frame was wrong, or
// because it never sent one. Both paths are exercised below; a prior reviewer flagged
// this as unverifiable from earlier diffs (Task 3 has no server to connect a socket
// to), so this is where it gets proven.

test('websocket: zero state before auth, and close(1008) on a bad first frame', async () => {
  const s = await startServer({ port: 7395 })
  const received: unknown[] = []
  const closeCode = await new Promise<number>((resolve, reject) => {
    const ws = connectWs('ws://127.0.0.1:7395/ws', 'http://127.0.0.1:7395')
    const timer = setTimeout(() => reject(new Error('timed out waiting for close')), 4000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'wrong-token' })))
    ws.addEventListener('message', (e) => received.push(e.data))
    ws.addEventListener('close', (e) => { clearTimeout(timer); resolve(e.code) })
  })
  expect(received).toEqual([])          // zero application state was ever sent
  expect(closeCode).toBe(1008)
  s.stop()
})

test('websocket: zero state before auth, and close(1008) when no frame is ever sent', async () => {
  // wsAuthTimeoutMs shortened so the test doesn't wait out the real (spec §8.4) 2s window.
  const s = await startServer({ port: 7396, wsAuthTimeoutMs: 150 })
  const received: unknown[] = []
  const closeCode = await new Promise<number>((resolve, reject) => {
    const ws = connectWs('ws://127.0.0.1:7396/ws', 'http://127.0.0.1:7396')
    const timer = setTimeout(() => reject(new Error('timed out waiting for close')), 4000)
    ws.addEventListener('message', (e) => received.push(e.data))
    ws.addEventListener('close', (e) => { clearTimeout(timer); resolve(e.code) })
    // Deliberately send nothing.
  })
  expect(received).toEqual([])
  expect(closeCode).toBe(1008)
  s.stop()
})

// --- Controller-added requirement (b): bound the incoming frame size. ---
//
// Before auth, the only legitimate message is a small JSON auth frame. Nothing limited
// how large a frame an unauthenticated socket could send, so maxPayloadLength caps it.
// This proves an oversized pre-auth frame never reaches our message handler (never gets
// parsed as JSON, never gets a chance to do anything) and the connection does not survive.

test('websocket: an oversized pre-auth frame is rejected, never reaches the app', async () => {
  const s = await startServer({ port: 7397 })
  const received: unknown[] = []
  const ended = await new Promise<'closed' | 'errored'>((resolve, reject) => {
    const ws = connectWs('ws://127.0.0.1:7397/ws', 'http://127.0.0.1:7397')
    const timer = setTimeout(() => reject(new Error('timed out waiting for close/error')), 4000)
    ws.addEventListener('open', () => ws.send('x'.repeat(2 * 1024 * 1024)))   // 2 MiB > 1 MiB cap
    ws.addEventListener('message', (e) => received.push(e.data))
    ws.addEventListener('close', () => { clearTimeout(timer); resolve('closed') })
    ws.addEventListener('error', () => { clearTimeout(timer); resolve('errored') })
  })
  expect(ended === 'closed' || ended === 'errored').toBe(true)
  expect(received).toEqual([])          // never buffered/parsed, so never echoed or acted on
  s.stop()
})
