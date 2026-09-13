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
 * Bun's node:tls returns an EMPTY peer certificate — surfacing as
 * ERR_TLS_CERT_ALTNAME_INVALID — when the first resolved address is unreachable,
 * which happens for any dual-stack host behind a VPN that blocks IPv6.
 * Node 22 is unaffected, so a contributor testing under Node will NEVER
 * reproduce this, and the error blames certificates rather than the network.
 * Spec §7.3. Do not remove without making test/tls-helper.test.ts go red.
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
