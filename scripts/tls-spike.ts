// TLS spike: the handshake measurement behind docs/decisions/0001-bun-version.md's
// 2026-09-23 TLS measurement, whose summary table this script printed.
//
// It opens REAL sockets to imap.gmail.com:993 — one TLS handshake per probe,
// eighteen probes in all — and needs a network. Every probe exercises the same
// bare `tls.connect` from a different angle (default happy-eyeballs, disabled,
// IPv4 only, a custom lookup ordering the addresses each way, a longer attempt
// timer, each address pinned) and then the repo's workaround, resolveDualStack.
// Under bun 1.3.11 behind a network that refuses IPv6 slowly (Mullvad with IPv6
// off) the bare rows fail with ERR_TLS_CERT_ALTNAME_INVALID and a NULL peer
// certificate at ~255-280 ms; under node 22 they succeed. One JSON line per
// handshake, then the summary table.
//
// Run it under both runtimes; node is the control:
//   bun scripts/tls-spike.ts
//   node scripts/tls-spike.ts
//
// Deliberately NOT in package.json's scripts: it is a measurement, not a gate,
// and test/verify-gate.test.ts pins that object exactly. ADR 0001's earlier
// "throwaway probe" is why its TLS row stayed unreproducible for a year; this
// file exists so the table can be regenerated from the tree.
import { lookup } from 'node:dns/promises'
import { connect as tlsConnect } from 'node:tls'
import { resolveDualStack } from '../src/net/tls-connect.ts'

const HOST = 'imap.gmail.com'
const PORT = 993
const runtime = typeof (globalThis as any).Bun !== 'undefined'
  ? `bun ${(globalThis as any).Bun.version}` : `node ${process.version}`

type Result = Record<string, unknown>

function handshake(label: string, opts: Record<string, unknown>, timeoutMs = 8000): Promise<Result> {
  const t0 = performance.now()
  return new Promise((resolve) => {
    let settled = false
    let greeting = ''
    let greetTimer: ReturnType<typeof setTimeout> | undefined
    const sock = tlsConnect({ port: PORT, ...opts } as any)
    const finish = (r: Result) => {
      if (settled) return
      settled = true
      clearTimeout(timer); if (greetTimer) clearTimeout(greetTimer)
      try { sock.destroy() } catch {}
      resolve({ runtime, label, ms: Math.round(performance.now() - t0), ...r })
    }
    const timer = setTimeout(() => finish({ outcome: 'timeout', remoteAddress: sock.remoteAddress ?? null, remoteFamily: sock.remoteFamily ?? null }), timeoutMs)
    const snapshot = (): Result => {
      const cert: any = sock.getPeerCertificate()
      const keys = cert ? Object.keys(cert) : []
      return {
        remoteAddress: sock.remoteAddress ?? null,
        remoteFamily: sock.remoteFamily ?? null,
        authorized: sock.authorized,
        authorizationError: (sock as any).authorizationError?.code ?? (sock as any).authorizationError ?? null,
        protocol: sock.getProtocol(),
        certKeys: keys.length,
        certNonEmpty: keys.length > 0,
        certSubjectCN: cert?.subject?.CN ?? null,
        certIssuerCN: cert?.issuer?.CN ?? null,
        certValidTo: cert?.valid_to ?? null,
        certSANsIncludeHost: typeof cert?.subjectaltname === 'string' && cert.subjectaltname.includes(HOST),
      }
    }
    sock.once('secureConnect', () => {
      const snap = snapshot()
      sock.on('data', (d: Buffer) => {
        greeting += d.toString()
        if (greeting.includes('\n')) finish({ outcome: 'ok', ...snap, greeting: greeting.trim().slice(0, 80) })
      })
      greetTimer = setTimeout(() => finish({ outcome: 'ok-no-greeting', ...snap }), 3000)
    })
    sock.once('error', (e: any) => {
      // The certificate at the error is recorded as null-or-not, separately
      // from its key count. The first version of this script folded the two
      // (`c ? Object.keys(c).length : 0`) and reported bun's null as "0 keys";
      // the record's pre-flight correction 1 is the measurement that caught it.
      let certIsNull: boolean | string = 'n/a'
      let certKeys: number | null | string = 'n/a'
      try {
        const c: any = sock.getPeerCertificate()
        certIsNull = c === null
        certKeys = c ? Object.keys(c).length : null
      } catch (x: any) {
        certIsNull = 'threw:' + x.code
        certKeys = 'threw:' + x.code
      }
      finish({ outcome: 'error', code: e.code ?? null, message: String(e.message).slice(0, 160), remoteAddress: sock.remoteAddress ?? null, remoteFamily: sock.remoteFamily ?? null, pending: sock.pending, certIsNull, certKeys })
    })
  })
}

const out: Result[] = []
const run = async (label: string, opts: Record<string, unknown>, n = 1, timeoutMs?: number) => {
  for (let i = 1; i <= n; i++) {
    const r = await handshake(`${label}#${i}`, opts, timeoutMs)
    out.push(r); console.log(JSON.stringify(r))
  }
}

const cands = (await lookup(HOST, { all: true })) as { address: string; family: number }[]
console.log(JSON.stringify({ runtime, lookup: cands }))
const v6 = cands.find((c) => c.family === 6)?.address
const v4 = cands.find((c) => c.family === 4)?.address

// A. bare: hostname in, runtime does its own resolution and address selection
await run('bare', { host: HOST, servername: HOST }, 3)
// B. bare with happy-eyeballs disabled (node honours it; bun: observe)
await run('bare-autoSelectFamily-false', { host: HOST, servername: HOST, autoSelectFamily: false }, 2)
// A2. bare, lookup forced to IPv4 only: does the bare path work when no unreachable address is offered?
await run('bare-family4', { host: HOST, servername: HOST, family: 4 }, 2)
// A3. bare, custom lookup (all:true shape) handing back the addresses v4 first: same happy-eyeballs path, reachable address first
if (v4 && v6) await run('bare-lookup-v4first', { host: HOST, servername: HOST, lookup: (_h: string, _o: unknown, cb: Function) => cb(null, [{ address: v4, family: 4 }, { address: v6, family: 6 }]) }, 2)
// A3b. control for the custom-lookup shape: v6 first, as real DNS orders it — must behave like 'bare' if the hook is honoured
if (v4 && v6) await run('bare-lookup-v6first', { host: HOST, servername: HOST, lookup: (_h: string, _o: unknown, cb: Function) => cb(null, [{ address: v6, family: 6 }, { address: v4, family: 4 }]) }, 2)
// A4. bare, attempt timeout raised past the v6 refusal (~1 s): fallback by error instead of by timer
await run('bare-attemptTimeout-3000', { host: HOST, servername: HOST, autoSelectFamilyAttemptTimeout: 3000 }, 2)
// C. pinned to the first AAAA — expected unreachable under Mullvad IPv6: off
if (v6) await run('pinned-v6', { host: v6, servername: HOST }, 1, 6000)
// D. pinned to the first A
if (v4) await run('pinned-v4', { host: v4, servername: HOST }, 1)
// E. the repo's workaround: resolveDualStack probes candidates with a plain TCP connect and pins the first reachable one
for (let i = 1; i <= 3; i++) {
  const t0 = performance.now()
  try {
    const picked = await resolveDualStack(HOST, PORT)
    const r = await handshake(`resolveDualStack#${i}`, { host: picked.host, servername: picked.servername })
    out.push({ ...r, pickedHost: picked.host, resolveMs: Math.round(performance.now() - t0) })
    console.log(JSON.stringify({ ...r, pickedHost: picked.host }))
  } catch (e: any) {
    const r = { runtime, label: `resolveDualStack#${i}`, outcome: 'resolve-error', message: String(e.message) }
    out.push(r); console.log(JSON.stringify(r))
  }
}

// certAtErr: 'null' when getPeerCertificate() returned null at the error (bun
// 1.3.11's shape), otherwise the key count; '-' for rows that did not error.
console.log('\n== summary ' + runtime + ' ==')
for (const r of out) console.log(
  String(r.label).padEnd(30), String(r.outcome).padEnd(16), String(r.remoteFamily ?? '-').padEnd(5), String(r.remoteAddress ?? '-').padEnd(26),
  'cert:' + String(r.certNonEmpty ?? '-').padEnd(6), 'auth:' + String(r.authorized ?? '-').padEnd(6), 'err:' + String(r.authorizationError ?? r.code ?? '-').padEnd(28),
  'certAtErr:' + String(r.outcome !== 'error' ? '-' : r.certIsNull === true ? 'null' : r.certKeys).padEnd(5), String(r.ms) + 'ms')
