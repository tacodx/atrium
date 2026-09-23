import { lookup as dnsLookup } from 'node:dns/promises'
import { connect as netConnect } from 'node:net'

export interface Candidate { address: string; family: number }

export interface ResolveDeps {
  lookup?: (host: string) => Promise<Candidate[]>
  probe?: (address: string, port: number) => Promise<boolean>
}

const defaultLookup = async (host: string): Promise<Candidate[]> =>
  (await dnsLookup(host, { all: true })) as Candidate[]

const defaultProbe = (address: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = netConnect({ host: address, port })
    const done = (ok: boolean) => { sock.destroy(); resolve(ok) }
    sock.setTimeout(2000)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })

/**
 * Measured on bun 1.3.11 (docs/decisions/0001-bun-version.md, the 2026-09-23
 * TLS measurement): when the happy-eyeballs attempt timer (250 ms by default)
 * expires while the first resolved address is still connecting, node:tls
 * raises ERR_TLS_CERT_ALTNAME_INVALID on that still-pending socket with a
 * NULL peer certificate and never tries the next address. Fallback driven by
 * a connect error works, and a reachable first address works; node 22 is
 * unaffected, so a contributor testing under node never reproduces this, and
 * the error blames certificates rather than the network.
 *
 * The environment that forces it: a network that refuses or blackholes IPv6
 * slower than 250 ms while DNS answers AAAA first — Mullvad with IPv6 off
 * refuses at ~1 s. This function sidesteps the runtime's selection by probing
 * the candidates serially with a plain TCP connect and pinning the first that
 * answers; the cost there was ~2.1 s per connect before a ~115 ms handshake.
 *
 * Two tests guard the two halves. test/tls-helper.test.ts covers the selection
 * logic with injected fakes and opens no socket. test/tls-live.test.ts, under
 * ATRIUM_LIVE_TLS=1, runs the real handshake through this function (spec
 * §7.3's integration test) and the bug pin: a bare connect on the trap above
 * must still fail this way.
 *
 * Retirement: when that bug pin goes red on bun X, raise `engines.bun` to X,
 * move ci.yml's `bun-version` and the verify-gate literals with it (ADR 0003
 * (b): the pin equals the floor), then delete this function and let the live
 * handshake test keep guarding the certificate.
 */
export async function resolveDualStack(
  host: string,
  port: number,
  deps: ResolveDeps = {},
): Promise<{ host: string; servername: string }> {
  const lookup = deps.lookup ?? defaultLookup
  const probe = deps.probe ?? defaultProbe

  const candidates = await lookup(host)
  for (const c of candidates) {
    if (await probe(c.address, port)) {
      return { host: c.address, servername: host }
    }
  }
  throw new Error(`no reachable address for ${host}:${port} (tried ${candidates.length})`)
}
