import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, statSync, existsSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startServer, BOOT_HANDOFF_TTL_MS } from '../src/server/serve'

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

// The six servers below never read back handoff.json or endpoint.json, so they
// were written with no `env` at all — which resolved them through the
// DEVELOPER'S REAL $XDG_RUNTIME_DIR. Measured on the pre-fix tree with a live
// server's two files planted there: `bun test test/serve.test.ts` overwrote
// both with this process's own (so the pid-ownership guard in cleanup matched),
// then DELETED them on stop(), and forced the directory 0755 -> 0700. The
// visible consequence is `atrium open --print-url` exiting 69 against a server
// that is still running, with no way to authenticate a new browser profile
// until it restarts. Task 4 Step 10 states the rule; it was applied to the ten
// new tests below and not to the six older ones above them.
//
// One shared directory is enough precisely because none of the six inspects
// what it writes. Every test that DOES inspect takes its own scratch dir.
const SHARED_RD = mkdtempSync(join(tmpdir(), 'atrium-shared-rd-'))
afterAll(() => rmSync(SHARED_RD, { recursive: true, force: true }))

test('/healthz is unauthenticated but still gated', async () => {
  const s = await startServer({ port: 7391, env: { XDG_RUNTIME_DIR: SHARED_RD } })
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
  const s = await startServer({ port: 7392, env: { XDG_RUNTIME_DIR: SHARED_RD } })
  const res = await fetch('http://127.0.0.1:7392/api/state', { headers: { host: '127.0.0.1:7392' } })
  expect(res.status).toBe(401)
  s.stop()
})

test('every response carries the standard security headers', async () => {
  const s = await startServer({ port: 7393, env: { XDG_RUNTIME_DIR: SHARED_RD } })
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
  // XDG_RUNTIME_DIR is scoped for the same reason the six in-process servers
  // above are: this child was the one spawn left inheriting the real one. It
  // is safe only because EADDRINUSE exits 78 before any write, which is a
  // property of the current ordering in startServer, not a rule. Hygiene, no
  // mutation: nothing here reads the runtime dir back.
  const proc = Bun.spawn([process.execPath, 'run', 'src/index.ts', 'serve', '--port', '7394'], {
    env: { ...process.env, XDG_RUNTIME_DIR: SHARED_RD, XDG_CONFIG_HOME: emptyConfigHome() },
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
  const s = await startServer({ port: 7395, env: { XDG_RUNTIME_DIR: SHARED_RD } })
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
  const s = await startServer({ port: 7396, wsAuthTimeoutMs: 150, env: { XDG_RUNTIME_DIR: SHARED_RD } })
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
  const s = await startServer({ port: 7397, env: { XDG_RUNTIME_DIR: SHARED_RD } })
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

// --- Task 4: the auth round trip. ---
//
// Nothing in this repo had ever issued a session token, so no test had ever
// sent a valid bearer or a valid socket auth frame. Measured on the 168-test
// baseline immediately before these landed: `if (!auth.verifyBearer(req))`
// mutated to `if (true)` — reject EVERY bearer — left the suite at 168 pass /
// 0 fail, and `state.authed = true` mutated to `state.authed = false` did too.
// The dangerous directions were already pinned; the HAPPY path was not, which
// makes a change that breaks legitimate access invisible. That is an
// availability regression gap, not an open security hole.
//
// Every server below gets a scratch XDG_RUNTIME_DIR so no test writes a live
// credential into the developer's real runtime directory, and every POST sets
// an explicit `origin` — measured: bun's fetch sends no Origin of its own, and
// gate.ts 403s a non-read method that arrives without one, so a POST without it
// never reaches the route at all.

function runtimeScratch(): string {
  return mkdtempSync(join(tmpdir(), 'atrium-handoff-'))
}

function readHandoffFile(scratch: string): { token: string; port: number; pid: number } {
  return JSON.parse(readFileSync(join(scratch, 'atrium', 'handoff.json'), 'utf8'))
}

function redeem(port: number, handoff: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/session`, {
    method: 'POST',
    headers: {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ handoff }),
  })
}

test('a handoff redeemed at POST /api/session returns a session token that is accepted by /api/state', async () => {
  const scratch = runtimeScratch()
  let s: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    s = await startServer({ port: 7404, env: { XDG_RUNTIME_DIR: scratch } })
    const res = await redeem(7404, readHandoffFile(scratch).token)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.token).toBe('string')

    // This 200 IS the bearer, and it is the one response in the process that
    // carries a credential in its body. The existing `every response carries
    // the standard security headers` test only exercises /healthz, so nothing
    // pinned this route. MUTATION: drop `, { headers }` from the
    // `Response.json` at the end of the /api/session block — the credential
    // then ships with cache-control null and CSP null, cacheable by anything
    // between the page and the server, and the suite stays green without this.
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    // SECURITY_HEADERS defines FOUR; the two above pinned half of them here.
    // Measured: the credential shipping with only cache-control and CSP left
    // the suite at 184/0. MUTATION: replace `{ headers }` on that Response.json
    // with an object carrying only 'cache-control' and 'content-security-policy'
    // — these two lines redden, the two above stay green.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')

    // THE assertion this whole task exists for. MUTATION: the bearer branch to
    // `if (true)`. Nothing else in the suite presents a valid bearer, so
    // without this line rejecting every legitimate client is invisible.
    const state = await fetch('http://127.0.0.1:7404/api/state', {
      headers: { host: '127.0.0.1:7404', authorization: `Bearer ${body.token}` },
    })
    expect(state.status).toBe(200)
  } finally {
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a socket that authenticates stays open and is not re-authenticated on later frames', async () => {
  const scratch = runtimeScratch()
  let s: Awaited<ReturnType<typeof startServer>> | undefined
  let ws: WebSocket | undefined
  try {
    s = await startServer({ port: 7405, wsAuthTimeoutMs: 150, env: { XDG_RUNTIME_DIR: scratch } })
    const token = (await (await redeem(7405, readHandoffFile(scratch).token)).json()).token

    const closes: number[] = []
    const sock = connectWs('ws://127.0.0.1:7405/ws', 'http://127.0.0.1:7405')
    ws = sock
    sock.addEventListener('close', (e) => closes.push(e.code))
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for open')), 4000)
      sock.addEventListener('open', () => { clearTimeout(timer); resolve() })
      sock.addEventListener('error', () => { clearTimeout(timer); reject(new Error('socket errored before open')) })
    })
    sock.send(JSON.stringify({ type: 'auth', token }))

    // THE SECOND FRAME IS THE TEST. The obvious version of this case — "auth,
    // then assert the socket is still open past the 150ms window" — stays GREEN
    // under the very mutation it is written for: with `state.authed = false`
    // the handler still reaches clearTimeout(state.authTimer), so the timeout
    // never fires and the socket never closes. With `authed` still false this
    // second frame is read as another FIRST frame, fails authenticateSocket and
    // closes 1008. Both assertions below must be present; this one is the test.
    await Bun.sleep(50)
    sock.send(JSON.stringify({ type: 'ping' }))
    await Bun.sleep(600)   // comfortably past the 150ms auth window

    expect(closes).toEqual([])
    // toEqual ignores array sparseness and undefined entries (bun 1.3.11), so
    // the length is pinned outright rather than inferred from the line above.
    expect(closes.length).toBe(0)
    expect(sock.readyState).toBe(1)   // WebSocket.OPEN — the literal, per connectWs's comment
  } finally {
    ws?.close()
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('the same handoff is refused on a second redemption', async () => {
  const scratch = runtimeScratch()
  let s: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    s = await startServer({ port: 7406, env: { XDG_RUNTIME_DIR: scratch } })
    const handoff = readHandoffFile(scratch).token

    const first = await redeem(7406, handoff)
    expect(first.status).toBe(200)
    expect(typeof (await first.json()).token).toBe('string')

    // MUTATION: delete `handoffs.delete(token)` from consumeHandoff.
    const second = await redeem(7406, handoff)
    expect(second.status).toBe(401)
    expect(await second.text()).not.toContain('token')
  } finally {
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

// Every header EXCEPT `date`: two responses milliseconds apart can straddle a
// second boundary there, and it says nothing about which path answered.
function nonDateHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {}
  res.headers.forEach((v, k) => { if (k !== 'date') out[k] = v })
  return out
}

test('a malformed body and an unknown handoff get the same 401, byte for byte', async () => {
  const scratch = runtimeScratch()
  let s: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    s = await startServer({ port: 7412, env: { XDG_RUNTIME_DIR: scratch } })

    // Not JSON at all: req.json() throws and the route treats it as a miss.
    const malformed = await fetch('http://127.0.0.1:7412/api/session', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7412',
        origin: 'http://127.0.0.1:7412',
        'content-type': 'application/json',
      },
      body: 'not json at all',
    })
    // Well-formed, and shaped exactly like a real handoff (43-char base64url),
    // so nothing but the map lookup can tell it from one.
    const unknown = await redeem(7412, 'A'.repeat(43))

    expect(malformed.status).toBe(401)
    expect(unknown.status).toBe(401)

    // Unknown, malformed, expired and already-redeemed are ONE answer, which
    // the route asserts in a comment and nothing tested. MUTATION: split the
    // single 401 into two, e.g. replace the `return new Response('unauthorized',
    // ...)` in the /api/session block with
    //   typeof handoff === 'string' ? 'unauthorized: unknown-or-expired handoff'
    //                               : 'unauthorized: malformed'
    // The status stays 401 either way, so the BODY comparison is the assertion
    // that does the work here.
    const malformedText = await malformed.text()
    expect(malformedText).toBe(await unknown.text())
    expect(malformed.status).toBe(unknown.status)

    // "Byte for byte" was status and body only; a header is an oracle exactly
    // as much as a body is. toEqual on the two records pins the set of names
    // AND every value. Measured: a per-path `x-atrium-reason` header left the
    // suite at 184/0. MUTATION: add
    //   'x-atrium-reason': typeof handoff === 'string' ? 'unknown' : 'malformed'
    // to the /api/session 401's headers. The length guard is not a mutation
    // target: a helper that iterated nothing would make both toEqual lines
    // below vacuous, and it measured 6 names on bun 1.3.11.
    const malformedHeaders = nonDateHeaders(malformed)
    expect(Object.keys(malformedHeaders).length).toBeGreaterThan(0)
    expect(nonDateHeaders(unknown)).toEqual(malformedHeaders)

    // THIRD path, consumed LAST so the two probes above ran against an
    // untouched map: redeem the real handoff, then redeem it again. The route
    // lists already-redeemed among its "ONE answer" cases and nothing compared
    // that answer to the others — `the same handoff is refused on a second
    // redemption` checks 401 and the absence of 'token', which a distinct
    // body satisfies. Measured: 184/0 with one. MUTATION: a `redeemed` Set in
    // startServer that answers a second redemption with
    // 'unauthorized: already redeemed' — the body line reddens first.
    const handoff = readHandoffFile(scratch).token
    expect((await redeem(7412, handoff)).status).toBe(200)
    const again = await redeem(7412, handoff)
    expect(again.status).toBe(401)
    expect(await again.text()).toBe(malformedText)
    expect(nonDateHeaders(again)).toEqual(malformedHeaders)
  } finally {
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a GET to /api/session neither issues nor consumes', async () => {
  const scratch = runtimeScratch()
  let s: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    s = await startServer({ port: 7407, env: { XDG_RUNTIME_DIR: scratch } })
    const handoff = readHandoffFile(scratch).token

    // The handoff is deliberately in the QUERY STRING, which §8.3 forbids
    // precisely because a URL lands in logs and shell history. Without it this
    // test is insensitive to the mutation it names: a GET-accepting route that
    // still read only the body would 401 anyway, since req.json() throws on a
    // bodyless GET. MUTATION: drop the `&& req.method === 'POST'` guard AND
    // source the handoff from searchParams.
    const get = await fetch(`http://127.0.0.1:7407/api/session?handoff=${handoff}`, {
      headers: { host: '127.0.0.1:7407' },
    })
    expect(get.status).toBe(401)
    expect(await get.text()).not.toContain('token')

    // Proof the GET consumed nothing: the handoff is still good.
    expect((await redeem(7407, handoff)).status).toBe(200)
  } finally {
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('POST /api/session with no Origin header is rejected by the gate before the route runs', async () => {
  const scratch = runtimeScratch()
  let s: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    s = await startServer({ port: 7408, env: { XDG_RUNTIME_DIR: scratch } })
    const handoff = readHandoffFile(scratch).token

    const noOrigin = await fetch('http://127.0.0.1:7408/api/session', {
      method: 'POST',
      headers: { host: '127.0.0.1:7408' },   // measured: bun's fetch adds no Origin of its own
      body: JSON.stringify({ handoff }),
    })
    // 403 is the GATE's answer, not the route's 401. MUTATION: hoist the
    // /api/session block above the checkRequest call and this becomes 200.
    expect(noOrigin.status).toBe(403)

    // The route never ran, so the handoff was never consumed.
    expect((await redeem(7408, handoff)).status).toBe(200)
  } finally {
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('handoff.json is 0600 even when it pre-existed looser, and holds the handoff, never the session token', async () => {
  const scratch = runtimeScratch()
  let s: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    const dir = join(scratch, 'atrium')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const hp = join(dir, 'handoff.json')
    writeFileSync(hp, '{}')
    chmodSync(hp, 0o644)
    expect(statSync(hp).mode & 0o777).toBe(0o644)   // sanity: the pre-existing looser mode took

    s = await startServer({ port: 7409, env: { XDG_RUNTIME_DIR: scratch } })

    // MUTATION: delete chmodSync(hp, 0o600) from startServer. Measured on bun
    // 1.3.11: writeFileSync's `mode` applies only when it CREATES the file, so
    // rewriting this one with { mode: 0o600 } leaves it at 0644.
    expect(statSync(hp).mode & 0o777).toBe(0o600)

    const written = readHandoffFile(scratch)
    expect(written.pid).toBe(process.pid)
    expect(written.port).toBe(7409)
    expect(written.token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const body = await (await redeem(7409, written.token)).json()
    expect(typeof body.token).toBe('string')
    // The file holds the HANDOFF, never the session token. Both are 43-char
    // base64url, so the regex above cannot tell them apart — this is what does.
    // MUTATION: write auth.sessionToken into handoff.json instead of the mint.
    expect(written.token).not.toBe(body.token)
  } finally {
    s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('stop() removes handoff.json as well as endpoint.json', async () => {
  const scratch = runtimeScratch()
  let s: Awaited<ReturnType<typeof startServer>> | undefined
  let stopped = false
  try {
    s = await startServer({ port: 7410, env: { XDG_RUNTIME_DIR: scratch } })
    const hp = join(scratch, 'atrium', 'handoff.json')
    const ep = join(scratch, 'atrium', 'endpoint.json')
    expect(existsSync(hp)).toBe(true)
    expect(existsSync(ep)).toBe(true)

    s.stop()
    stopped = true

    expect(existsSync(ep)).toBe(false)
    // MUTATION: drop removeEndpointIfOwned(hp, process.pid) from cleanup. A
    // credential left behind by every clean shutdown is the failure this pins.
    expect(existsSync(hp)).toBe(false)
  } finally {
    if (!stopped) s?.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('atrium open --print-url prints the boot handoff from the file and does not mint a new one', async () => {
  const scratch = runtimeScratch()
  const hp = join(scratch, 'atrium', 'handoff.json')
  const env = { ...process.env, XDG_RUNTIME_DIR: scratch, XDG_CONFIG_HOME: emptyConfigHome() }
  const proc = Bun.spawn(
    [process.execPath, 'run', 'src/index.ts', 'serve', '--port', '7411'],
    { env, stderr: 'pipe', stdout: 'pipe' },
  )
  // Both hoisted out of the try so the assertions AFTER the try/finally can
  // see them. Nothing is asserted inside the finally, on purpose: a throw
  // there REPLACES an in-flight exception from the try, so a failed URL
  // assertion or a waitForFile timeout used to surface as the guard's
  // `Expected: > 0 / Received: 0` instead of its own message (measured on the
  // pre-fix shape with waitForFile pointed at a file that never appears). The
  // finally only kills, waits, captures and removes.
  let before = ''
  let sessionToken = ''
  let openErr = ''
  let logs = ''
  try {
    expect(await waitForFile(hp)).toBe(true)
    before = readHandoffFile(scratch).token

    const open = Bun.spawn(
      [process.execPath, 'run', 'src/index.ts', 'open', '--print-url'],
      { env, stderr: 'pipe', stdout: 'pipe' },
    )
    const out = await new Response(open.stdout).text()
    openErr = await new Response(open.stderr).text()
    expect(await open.exited).toBe(0)
    // MUTATION: mint a fresh token in `case 'open'` instead of printing the
    // file's. The token is the whole of the URL that matters.
    expect(out.trim()).toBe(`http://127.0.0.1:7411/#${before}`)

    // `open` READS. The handoff map lives in createAuth's closure inside the
    // SERVER process, so a second process has nothing to mint into; this pins
    // that the reader did not grow a writer.
    expect(readHandoffFile(scratch).token).toBe(before)

    // Redeem against the CHILD so its session token is known to this process.
    // consumeHandoff deletes the map entry, not the file — only cleanup does
    // that — so the file assertion above is unaffected by the order here.
    const body = await (await redeem(7411, before)).json()
    expect(typeof body.token).toBe('string')
    sessionToken = body.token
  } finally {
    proc.kill()
    await proc.exited   // never leave a server squatting machine-global 7411
    logs = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
    rmSync(scratch, { recursive: true, force: true })
  }

  // NOT a vacuity guard. Measured on bun 1.3.11: `expect('x').not.toContain('')`
  // THROWS, because every string contains '' — so an unassigned `before` would
  // not slip through below, it would fail with a message about the empty
  // string. What this guard does is turn that confusing failure into a plain
  // "the handoff was never read" one.
  expect(before.length).toBeGreaterThan(0)
  expect(sessionToken.length).toBeGreaterThan(0)

  // The server process is the ONE place a live handoff exists in memory, and
  // under systemd its stderr IS the persistent journal. Nothing pinned that
  // it stays out of either stream — measured, a log of the mint left the
  // whole suite at 183/0. MUTATION: add
  // console.log(`atrium: boot handoff ${bootHandoff}`) after the mint in
  // startServer. The console.error spelling reddens this too, and that is
  // the one systemd copies into a permanent journal line.
  expect(logs).not.toContain(before)
  // serve.ts's rule names BOTH credentials; the line above pins only the
  // handoff. Measured: a console.error of the session token after the mint
  // left the whole suite at 184/0. MUTATION: add
  // console.error(`atrium: session token ${auth.sessionToken}`) after the
  // mint in startServer — this line, and only this line, reddens.
  expect(logs).not.toContain(sessionToken)

  // `open`'s success path pipes stderr, and nothing read it back — measured,
  // the handoff echoed there left the suite at 184/0. stdout is the URL a
  // launcher consumes; stderr is the journal under systemd, and one is a
  // credential exactly as much as the other. MUTATION: in src/index.ts
  // `case 'open'`, console.error(`atrium: debug: printing handoff ${h.token}`)
  // before the URL console.log.
  expect(openErr).not.toContain(before)
})

// Three mutations, one per assertion group in this test, all run RED then
// GREEN. Each is type-clean, which is the point — a mutation tsc would reject
// is one CI catches anyway:
//   (1) `process.exit(69)` -> `process.exit(1)` in the missing-file branch of
//       src/index.ts's `case 'open'`. EX_UNAVAILABLE is the contract a
//       launcher and a systemd unit key off; a generic 1 says nothing.
//   (2) delete the `if (!argv.includes('--print-url'))` block. `atrium open`
//       with no flag then falls through to reading the handoff file, misses,
//       and exits 69 about a server instead of 64 with a usage line.
//   (3) the missing-file message onto stdout, in two spellings. stdout is what
//       a launcher consumes — `xdg-open "$(atrium open --print-url)"` feeds it
//       straight to a browser — so an error line there becomes a URL argument.
//       `console.error` -> `console.log` reddens the stderr assertion first;
//       ECHOING to both streams leaves stderr correct and reddens the stdout
//       `toBe('')` alone, which is how that assertion was shown to be doing
//       work rather than decorating.
test('atrium open fails cleanly with no server and with no --print-url', async () => {
  const scratch = runtimeScratch()   // deliberately empty: no server ever started here
  const env = { ...process.env, XDG_RUNTIME_DIR: scratch, XDG_CONFIG_HOME: emptyConfigHome() }
  try {
    const missing = Bun.spawn(
      [process.execPath, 'run', 'src/index.ts', 'open', '--print-url'],
      { env, stderr: 'pipe', stdout: 'pipe' },
    )
    const missingOut = await new Response(missing.stdout).text()
    const missingErr = await new Response(missing.stderr).text()
    expect(await missing.exited).toBe(69)          // EX_UNAVAILABLE
    expect(missingErr).toContain('server')
    expect(missingOut).toBe('')                    // nothing to paste into a browser

    const noFlag = Bun.spawn(
      [process.execPath, 'run', 'src/index.ts', 'open'],
      { env, stderr: 'pipe', stdout: 'pipe' },
    )
    const noFlagOut = await new Response(noFlag.stdout).text()
    const noFlagErr = await new Response(noFlag.stderr).text()
    expect(await noFlag.exited).toBe(64)           // EX_USAGE
    expect(noFlagErr).toContain('usage')
    expect(noFlagOut).toBe('')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

// TRIPWIRE, NOT COVERAGE. This can only fail if someone edits the constant. It
// exists because the tempting tidy-up is to drop mintHandoff's second argument
// and inherit createAuth's 60s default, which strands every systemd-started
// user — their handoff is dead before they reach a browser — and nothing else
// in the suite would notice.
test('the boot handoff TTL is long, per the recorded ruling', () => {
  expect(BOOT_HANDOFF_TTL_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000)
})
