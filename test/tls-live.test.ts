import { test, expect } from 'bun:test'
import { lookup } from 'node:dns/promises'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { resolveDualStack } from '../src/net/tls-connect'

// Opt-in, live: ATRIUM_LIVE_TLS=1 enables two tests that open real sockets to
// imap.gmail.com:993 (a plain TCP sample, one handshake through
// resolveDualStack, one bare handshake). CI never sets the variable, and
// `bun test` without it reports both as skipped — test/verify-gate.test.ts
// pins that those two are the suite's only skips. Run them by hand:
//
//   ATRIUM_LIVE_TLS=1 bun test test/tls-live.test.ts
//
// T1 is the integration test spec §7.3 owes: a non-empty, authorized peer
// certificate through the workaround. T2 is the bug pin the workaround exists
// for, and its retirement trigger: it goes red on a bun that keeps the first
// socket's fallback working (docs/decisions/0001-bun-version.md, the
// 2026-09-23 TLS measurement). T2 needs the trap that the measurement found —
// the first AAAA still pending when the runtime's 250 ms attempt timer fires —
// so it samples that state itself below and skips, visibly, when the network
// does not produce it.
const LIVE = process.env.ATRIUM_LIVE_TLS === '1'
const HOST = 'imap.gmail.com'
const PORT = 993

// The state of a plain TCP connect to `address` at 400 ms, and its final
// outcome within 2000 ms. 400 gives a margin over the 250 ms default: a
// refusal landing at 260-390 ms is 'error:…' here, and the bug pin then skips
// rather than run against a fallback that would have worked by error anyway.
type ConnectState = 'pending' | 'connected' | `error:${string}`

async function sampleConnect(address: string, port: number): Promise<{ at400: ConnectState; final: ConnectState; ms: number }> {
  const t0 = performance.now()
  const sock = netConnect({ host: address, port })
  let state: ConnectState = 'pending'
  try {
    const settled = new Promise<void>((resolve) => {
      sock.once('connect', () => { state = 'connected'; resolve() })
      sock.once('error', (e: NodeJS.ErrnoException) => { state = `error:${e.code ?? 'unknown'}`; resolve() })
    })
    const deadline = Bun.sleep(2000)
    await Bun.sleep(400)
    const at400: ConnectState = state
    await Promise.race([settled, deadline])
    return { at400, final: state, ms: Math.round(performance.now() - t0) }
  } finally {
    sock.destroy()
  }
}

let trap = false
let trapLine = 'tls-live: not sampled (ATRIUM_LIVE_TLS unset)'

if (LIVE) {
  const candidates = (await lookup(HOST, { all: true })) as { address: string; family: number }[]
  const v6 = candidates.find((c) => c.family === 6)
  if (v6 === undefined) {
    trapLine = 'tls-live: lookup returned no AAAA; the bug pin cannot run'
  } else {
    const s = await sampleConnect(v6.address, PORT)
    trap = s.at400 === 'pending'
    trapLine = `tls-live: first AAAA ${v6.address}: at 400 ms ${s.at400}; final ${s.final} at ${s.ms} ms; trap=${trap}`
  }
  console.warn(trapLine)
}

// The first line the server sends after the handshake. IMAP greets first, so
// a line arriving at all proves the TLS session carries application data,
// not just a completed handshake.
function firstLine(sock: ReturnType<typeof tlsConnect>): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (d: Buffer) => {
      buf += d.toString()
      const nl = buf.indexOf('\n')
      if (nl >= 0) { sock.off('data', onData); resolve(buf.slice(0, nl).trimEnd()) }
    }
    sock.on('data', onData)
    sock.once('error', reject)
  })
}

test.skipIf(!LIVE)('resolveDualStack then tls.connect to imap.gmail.com:993 yields a non-empty, authorized peer certificate for the host', async () => {
  const picked = await resolveDualStack(HOST, PORT)
  const sock = tlsConnect({ host: picked.host, servername: picked.servername, port: PORT })
  try {
    const cert = await new Promise<ReturnType<typeof sock.getPeerCertificate>>((resolve, reject) => {
      sock.once('secureConnect', () => resolve(sock.getPeerCertificate()))
      sock.once('error', reject)
    })
    expect(cert).not.toBeNull()
    expect(Object.keys(cert).length).toBeGreaterThan(0)
    expect(sock.authorized).toBe(true)
    expect(String(cert.subjectaltname)).toContain(HOST)
    expect(await firstLine(sock)).toMatch(/^\* OK/)
    // The family that answered is part of the result the measurement records.
    console.warn(`tls-live: T1 handshake over ${sock.remoteFamily} to ${sock.remoteAddress} (picked ${picked.host})`)
  } finally {
    sock.destroy()
  }
}, 10_000)

test.skipIf(!LIVE || !trap)('bug pin: on this bun a bare tls.connect whose first address is still pending at the 250 ms attempt timer fails with ERR_TLS_CERT_ALTNAME_INVALID and a null peer certificate — retire resolveDualStack when this goes red on a newer bun', async () => {
  const sock = tlsConnect({ host: HOST, servername: HOST, port: PORT })
  try {
    // First of error / secureConnect, capped under the test's own 10 s so the
    // `finally` runs and a hang reads as this message, not bun's timeout.
    const first = await Promise.race([
      new Promise<{ kind: 'error'; err: NodeJS.ErrnoException } | { kind: 'secureConnect' }>((resolve) => {
        sock.once('error', (err: NodeJS.ErrnoException) => resolve({ kind: 'error', err }))
        sock.once('secureConnect', () => resolve({ kind: 'secureConnect' }))
      }),
      Bun.sleep(9_000).then(() => ({ kind: 'timeout' as const })),
    ])
    // Which reading applies when this goes red: the sampled trap facts say
    // whether the first address really was pending at the timer (the bug's
    // precondition), so a pass by error-driven fallback is not mistaken for
    // the bug being fixed.
    const why =
      `${trapLine}. A bare tls.connect got ${first.kind}` +
      (first.kind === 'error' ? ` (${first.err.code})` : '') +
      ` over ${sock.remoteFamily ?? '-'} ${sock.remoteAddress ?? '-'}. ` +
      'If the trap held and the handshake succeeded, this bun tries the next address after the timer: ' +
      'raise engines.bun, move the CI pin and the verify-gate literals, delete resolveDualStack.'
    expect(first.kind, why).toBe('error')
    expect(first.kind === 'error' ? first.err.code : undefined, why).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
    expect(sock.getPeerCertificate(), why).toBeNull()
  } finally {
    sock.destroy()
  }
}, 10_000)
