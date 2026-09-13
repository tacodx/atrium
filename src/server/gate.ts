export type GateResult = { ok: true } | { ok: false; status: number; reason: string }

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
  if (origin !== undefined) {
    // 'null' is a real value: sandboxed iframe, data: URL, cross-origin redirect.
    if (!origins.has(origin)) return { ok: false, status: 403, reason: `origin:${origin}` }
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    // Absent Origin is only survivable on read-only methods. The spec states
    // "no GET may ever mutate state" (§8.2), so we use an allowlist of read-only
    // verbs here rather than a blocklist of mutating verbs. This rejects OPTIONS,
    // custom verbs like PROPFIND, or any unknown method without an Origin.
    // This differs intentionally from the brief's sample code (which used a blocklist);
    // the invariant is allowlist-based per the spec prose.
    return { ok: false, status: 403, reason: 'origin:absent-on-non-read-method' }
  }

  const sfs = req.headers.get('sec-fetch-site')
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
    return { ok: false, status: 403, reason: `sec-fetch-site:${sfs}` }
  }

  return { ok: true }
}
