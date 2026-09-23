import { test, expect } from 'bun:test'
import { lookup } from 'node:dns/promises'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { resolveDualStack } from '../src/net/tls-connect'

// Opt-in, live: ATRIUM_LIVE_TLS=1 enables a module-level plain TCP sample and
// two tests, all opening real sockets to imap.gmail.com:993: T1
// (resolveDualStack's serial probes, then one handshake) and T2 (one bare
// handshake). CI never sets the variable, and
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

// The state of a plain TCP connect to `address` at SAMPLE_MS, and its final
// outcome within 2000 ms. SAMPLE_MS sits above the runtime's 250 ms default
// because the sample and T2 are separate connects: a refusal that lands near
// the timer could fall on either side of 250 ms in T2's own run, and a refusal
// before the timer is error-driven fallback (which works), not the bug. Skipping
// in that band avoids a red T2 that reads as a fixed bun when it was not.
const SAMPLE_MS = 400
type ConnectState = 'pending' | 'connected' | `error:${string}`

async function sampleConnect(address: string, port: number): Promise<{ atSample: ConnectState; final: ConnectState; ms: number }> {
  const t0 = performance.now()
  const sock = netConnect({ host: address, port })
  let state: ConnectState = 'pending'
  try {
    const settled = new Promise<void>((resolve) => {
      sock.once('connect', () => { state = 'connected'; resolve() })
      sock.once('error', (e: NodeJS.ErrnoException) => { state = `error:${e.code ?? 'unknown'}`; resolve() })
    })
    const deadline = Bun.sleep(2000)
    await Bun.sleep(SAMPLE_MS)
    const atSample: ConnectState = state
    await Promise.race([settled, deadline])
    return { atSample, final: state, ms: Math.round(performance.now() - t0) }
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
    // Still pending at the sample, and not a first address that failed before
    // the runtime's default 250 ms attempt timer (that shape falls back by
    // error and works) — so a cut SAMPLE_MS margin still refuses it.
    trap = s.atSample === 'pending' && !(s.final.startsWith('error:') && s.ms < 250)
    trapLine = `tls-live: first AAAA ${v6.address}: at ${SAMPLE_MS} ms ${s.atSample}; final ${s.final} at ${s.ms} ms; trap=${trap}`
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
  const t0 = performance.now()
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
    const ms = Math.round(performance.now() - t0)
    // Which reading applies when this goes red: the sampled trap facts say
    // whether the first address really was pending at the timer (the bug's
    // precondition), and the elapsed ms says which fallback a success took —
    // ~timer+handshake (a few hundred ms) means the timer-driven path now works
    // on this bun; ~refusal+handshake (~1 s here) means the first address
    // failed before the timer and the fallback was error-driven.
    const why =
      `${trapLine}. If the trap held and the handshake succeeded in ~timer+handshake (a few hundred ms), ` +
      'this bun tries the next address after the timer: raise engines.bun, move the CI pin and the ' +
      'verify-gate literals, delete resolveDualStack. A success at ~refusal+handshake (~1 s here) means the ' +
      'first address failed before the timer and the fallback was error-driven, not a fix. ' +
      `A bare tls.connect got ${first.kind}` +
      (first.kind === 'error' ? ` (${first.err.code})` : '') +
      ` over ${sock.remoteFamily ?? '-'} ${sock.remoteAddress ?? '-'} after ${ms} ms`
    expect(first.kind, why).toBe('error')
    expect(first.kind === 'error' ? first.err.code : undefined, why).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
    expect(sock.getPeerCertificate(), why).toBeNull()
  } finally {
    sock.destroy()
  }
}, 10_000)
