import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, statSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

// Every `src/index.ts serve` child below inherits this process's environment,
// and `serve` now loads $XDG_CONFIG_HOME/atrium/config.json (Task 3). An
// unscoped child therefore reads the DEVELOPER'S real ~/.config/atrium — which
// the plan forbids ("no test may assert a count or path derived from $HOME")
// and which would, from Task 7's strict repos schema onward, let one typo in a
// personal config file redden three tests whose names are about ports and
// signals. An empty scratch dir makes `loadConfig` take its ENOENT path.
const emptyConfigHomes: string[] = []
function emptyConfigHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'atrium-empty-config-'))
  emptyConfigHomes.push(d)
  return d
}
afterAll(() => { for (const d of emptyConfigHomes) rmSync(d, { recursive: true, force: true }) })

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
  // XDG_CONFIG_HOME is scoped to an empty scratch dir because `serve` now
  // loads $XDG_CONFIG_HOME/atrium/config.json (Task 3). Without it this child
  // reads the DEVELOPER'S real config, and one malformed or schema-rejected
  // file there would turn this test red for a reason its name never mentions.
  const proc = Bun.spawn([process.execPath, 'run', 'src/index.ts', 'serve', '--port', '7394'], {
    env: { ...process.env, XDG_CONFIG_HOME: emptyConfigHome() },
    stderr: 'pipe',
  })
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

// --- Review finding 1: endpoint.json's shape. ---
//
// nonce proves identity (matched against /healthz, so a launcher can tell it
// reached the process it just started rather than a port squatter); startedAt
// supports staleness (a later consumer deciding whether a file left by a
// crashed instance is worth trusting). Both are written; here the shape is
// checked directly against the file rather than inferred from behavior.
// Every test below uses `env` (a scratch directory, never the developer's
// real $HOME or $XDG_RUNTIME_DIR) to write and inspect endpoint.json.

test('endpoint.json records url, pid, nonce, and an ISO-8601 startedAt', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'atrium-endpoint-'))
  try {
    const s = await startServer({ port: 7400, env: { XDG_RUNTIME_DIR: scratch } })
    const epPath = join(scratch, 'atrium', 'endpoint.json')
    const written = JSON.parse(readFileSync(epPath, 'utf8'))
    expect(written.pid).toBe(process.pid)
    expect(typeof written.nonce).toBe('string')
    expect(typeof written.url).toBe('string')
    expect(typeof written.startedAt).toBe('string')
    expect(written.startedAt).toBe(new Date(written.startedAt).toISOString())  // round-trips as ISO-8601
    s.stop()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

// --- Review finding 3: the parent directory's mode must be re-asserted. ---
//
// mkdirSync's `mode` option only applies when it actually creates the
// directory; an already-existing one (as a later task's own config-dir setup
// will leave behind) keeps whatever mode it already had. Spec §8.5 requires
// 0700 unconditionally, so this pre-creates the directory looser and asserts
// startServer tightens it back up regardless.

test('endpoint.json parent directory is forced to 0700 even if it pre-existed looser', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'atrium-endpoint-'))
  try {
    const dir = join(scratch, 'atrium')
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    expect(statSync(dir).mode & 0o777).toBe(0o755)   // sanity: the pre-existing looser mode took

    const s = await startServer({ port: 7401, env: { XDG_RUNTIME_DIR: scratch } })
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    s.stop()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

// --- "Also": SIGTERM/SIGINT cleanup, proven under a real signal to a real process. ---
//
// bun test does not emit a Node-style 'exit' event when a test file finishes
// (see src/server/serve.ts's comment on the `.stop()` wrapper), so a test that
// only calls startServer() in-process and inspects the result cannot tell us
// anything about the SIGTERM/SIGINT handlers — those only run in a process
// that actually receives the signal. These two tests spawn the real compiled
// entry point as a genuine child process, signal it from the OS, and check
// the file on disk afterward.

async function waitForFile(path: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await Bun.sleep(50)
  }
  return false
}

test('SIGTERM removes endpoint.json on a real signal to a real process', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'atrium-endpoint-'))
  const epPath = join(scratch, 'atrium', 'endpoint.json')
  try {
    const proc = Bun.spawn(
      [process.execPath, 'run', 'src/index.ts', 'serve', '--port', '7402'],
      { env: { ...process.env, XDG_RUNTIME_DIR: scratch, XDG_CONFIG_HOME: emptyConfigHome() }, stderr: 'pipe', stdout: 'pipe' },
    )
    expect(await waitForFile(epPath)).toBe(true)   // server actually started and wrote the file

    proc.kill('SIGTERM')
    await proc.exited

    expect(existsSync(epPath)).toBe(false)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('SIGINT removes endpoint.json on a real signal to a real process', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'atrium-endpoint-'))
  const epPath = join(scratch, 'atrium', 'endpoint.json')
  try {
    const proc = Bun.spawn(
      [process.execPath, 'run', 'src/index.ts', 'serve', '--port', '7403'],
      { env: { ...process.env, XDG_RUNTIME_DIR: scratch, XDG_CONFIG_HOME: emptyConfigHome() }, stderr: 'pipe', stdout: 'pipe' },
    )
    expect(await waitForFile(epPath)).toBe(true)

    proc.kill('SIGINT')
    await proc.exited

    expect(existsSync(epPath)).toBe(false)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
