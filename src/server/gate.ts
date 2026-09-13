export type GateResult = { ok: true } | { ok: false; status: number; reason: string }

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * The single chokepoint. Every route AND the WebSocket upgrade pass through here.
 * Spec §8.2. Do not add a bypass — one unchecked route is full RCE, which is
 * exactly how MCP Inspector (CVE-2025-49596) and Nuxt Devtools
 * (CVE-2024-23657) were compromised.
 */
export function checkRequest(req: Request, port: number): GateResult {
  // Exact, case-insensitive, port-inclusive. NEVER endsWith/includes:
  // evil.localhost:7373 resolves to loopback in Chrome and Firefox (RFC 6761).
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const host = req.headers.get('host')?.toLowerCase()
  if (!host || !hosts.has(host)) {
    return { ok: false, status: 403, reason: `host:${host ?? 'absent'}` }
  }

  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  const origin = req.headers.get('origin')?.toLowerCase()
  if (origin !== undefined && origin !== null) {
    // 'null' is a real value: sandboxed iframe, data: URL, cross-origin redirect.
    if (!origins.has(origin)) return { ok: false, status: 403, reason: `origin:${origin}` }
  } else if (MUTATING.has(req.method)) {
    // A cross-origin no-cors GET carries no Origin at all, so absent is only
    // survivable because no GET may mutate state (§8.2).
    return { ok: false, status: 403, reason: 'origin:absent-on-mutating' }
  }

  const sfs = req.headers.get('sec-fetch-site')
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
    return { ok: false, status: 403, reason: `sec-fetch-site:${sfs}` }
  }

  return { ok: true }
}
