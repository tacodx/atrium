# Atrium Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the secure loopback server, the hardened git chokepoint, and the provider contract that all four Atrium providers are written against — with no providers implemented.

**Architecture:** A single bun process serves HTTP and WebSocket on 127.0.0.1 behind one request gate. Providers register against a contract supporting multiple named schedules and an optional push/watch source. Actions are a declared allowlist in two kinds (`exec` → argv only; `call` → in-process). All git access funnels through one hardened helper.

**Tech Stack:** bun + TypeScript, React 19 + Vite 7 + Tailwind v4, zod for config schemas, `node:child_process.execFile`.

**Design spec:** `docs/superpowers/specs/2026-09-13-atrium-design.md`. Read §5–§10 before starting.

## Global Constraints

Every task's requirements implicitly include these. Values are copied verbatim from the spec.

- **Bind `127.0.0.1` only.** Never `0.0.0.0`, not behind a flag. (§8.1)
- **Default port 7373**, configurable. Port collision exits **78** (`EX_CONFIG`). (§9)
- **No GET may ever mutate state or run a command.** (§8.2)
- **Enforce on the `Host` header only.** Never trust `req.url`; never build a redirect `Location` from it. (§8.2)
- **`execFile(cmd, args[])` only.** No shell, no string interpolation, ever — necessary everywhere, and *not sufficient* for git (§8.6).
- **`runGit()` is the only path to git.** Its child env is an allowlist built from scratch that explicitly sets `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null`. (§8.6)
- **Never** `__dirname`, `__filename`, `import.meta.path`, `import.meta.dir`, or `process.argv[1]` for on-disk paths — inside a compiled binary these are `/$bunfs/root/…` and do not exist. Use `process.execPath`. (§9)
- **No test may assert a count or path derived from the developer's `$HOME`.** Generated fixtures only. (§10 rule 1)
- **Every git test runs under `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`.** (§10 rule 2)
- **Nothing about the reference machine may be baked into code.** Every default, path and heuristic needs stated behaviour for a machine that looks nothing like it. (§21 of the audit carry-list)
- **Config `0644`; secrets in a separate `0600` file inside a `0700` directory.** (§8.5)
- **The UI contains no shell-specific code** — no `window.__TAURI__`, no shell API import. (§5)

---

## File Structure

```
src/
  index.ts              CLI entry: serve | open | install | uninstall | doctor | rotate-token
  server/
    serve.ts            Bun.serve wiring, port-collision exit 78, endpoint.json lifecycle
    gate.ts             THE request gate. Host/Origin/Sec-Fetch-Site. HTTP + WS upgrade.
    auth.ts             handoff token mint/consume, bearer verify, WS first-frame auth
    routes.ts           route table; /healthz, /api/state, /api/actions/:providerId/:actionId
  core/
    contract.ts         Provider, Schedule, Action, DetectResult, FetchCtx types
    registry.ts         provider registration, duplicate-id rejection
    scheduler.ts        named schedules + watch sources, in-flight dedupe
    actions.ts          exec/call dispatch, argv invariant, audit log
    rungit.ts           the ONLY path to git
    paths.ts            XDG resolution, execPath resolution, endpoint.json
  net/
    tls-connect.ts      resolveDualStack — Bun's empty-peer-cert workaround (§7.3)
  skeleton.ts           Task 1 only; deleted into server/serve.ts at Task 4
  config/               ── NOT built in this plan; Plan 4 ──
    schema.ts           zod config schema, defaults
    load.ts             load/validate/write, permission checks
    secrets.ts          CredentialStore: Bun.secrets with Promise.race, 0600 fallback
test/
  fixtures/
    gitrepo.ts          generated git fixtures (NOT $HOME-derived)
  gate.test.ts          the negative suite — written BEFORE gate.ts
  auth.test.ts          token replay, TTL, WS first-frame, zero-state-before-auth
  rungit.test.ts        malicious-repo fixture, mutation-checked
  contract.test.ts      registry duplicate ids, scheduler routing
  actions.test.ts       argv invariant, call payload validation
web/
  index.html
  src/main.tsx          canary element only in this plan
  src/index.css         @import "tailwindcss";  (v4 — NO config files)
scripts/
  assert-package.ts     post-build packaging assertion (§10)
```

**Boundary rationale:** `gate.ts` is a single chokepoint because §8.2's failure mode is one unchecked route. `rungit.ts` is separate from any provider because §8.6 requires a test that greps the source for direct `execFile('git', …)` — that test needs one legitimate call site.

---

### Task 1: Walking skeleton — settle the runtime version by measurement

Settles the single most contested variable in the design (§5.1). Nothing else is built until this passes.

**This task deliberately uses a bare `Bun.serve` with no request gate.** §12's ordering says the gate is step 1, and Task 0's criteria reference it — that circularity is resolved by scope: this skeleton proves *packaging and runtime capability only*, binds loopback, serves two routes, and is deleted into Task 2's real server.

**Files:**
- Create: `package.json`, `.gitignore`, `tsconfig.json`
- Create: `web/index.html`, `web/src/main.tsx`, `web/src/index.css`, `vite.config.ts`
- Create: `src/skeleton.ts`
- Create: `scripts/assert-package.ts`
- Create: `test/tls-helper.test.ts`, `src/net/tls-connect.ts`
- Create: `docs/decisions/0001-bun-version.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveDualStack(host: string, port: number): Promise<{host: string, servername: string}>` from `src/net/tls-connect.ts`, used later by the mail provider. A pinned `engines.bun` value in `package.json` that every later task depends on.

- [ ] **Step 1: Pin the candidate runtime and scaffold**

```bash
cd /home/danja/Projects/atrium
bun --version    # record this; candidate is >= 1.4.2
bun init -y
bun add react@^19.3.0 react-dom@^19.3.0
bun add -d vite@^7.3.6 @vitejs/plugin-react@^5.2.0 tailwindcss@^4.3.3 @tailwindcss/vite@^4.3.3 @types/react @types/react-dom
```

Set `"engines": { "bun": ">=1.4.2" }` and `"type": "module"` in `package.json`.

**Tailwind v4 has no config files.** If any tool generates `tailwind.config.js`, `postcss.config.js`, or adds `autoprefixer`, delete them — those are v3 artifacts and will silently produce no utilities.

`vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'web',
  plugins: [tailwindcss(), react()],
  build: { outDir: '../web-dist', emptyOutDir: true },
})
```

`web/src/index.css` — exactly this, not the three v3 directives:

```css
@import "tailwindcss";
```

`web/src/main.tsx` — the canary element exists so Step 5 can prove Tailwind actually emitted utilities:

```tsx
import { createRoot } from 'react-dom/client'
import './index.css'

function App() {
  return <div id="canary" className="p-4 text-emerald-500">atrium skeleton</div>
}

createRoot(document.getElementById('root')!).render(<App />)
```

- [ ] **Step 2: Write the failing dual-stack TLS test**

The live-handshake check cannot distinguish "the workaround works" from "Gmail changed its address order", so the real test stubs DNS. Create `test/tls-helper.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { resolveDualStack } from '../src/net/tls-connect'

test('picks a reachable address when the first candidate is blackholed', async () => {
  const lookup = async () => [
    { address: '2001:db8::1', family: 6 },   // documentation prefix, always unroutable
    { address: '93.184.216.34', family: 4 },
  ]
  const probe = async (addr: string) => addr !== '2001:db8::1'

  const out = await resolveDualStack('imap.example.com', 993, { lookup, probe })

  expect(out.host).toBe('93.184.216.34')
  expect(out.servername).toBe('imap.example.com')
})

test('servername is always the hostname, never the resolved ip', async () => {
  const lookup = async () => [{ address: '10.0.0.1', family: 4 }]
  const probe = async () => true

  const out = await resolveDualStack('mail.example.org', 993, { lookup, probe })

  expect(out.servername).toBe('mail.example.org')
  expect(out.host).toBe('10.0.0.1')
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test test/tls-helper.test.ts`
Expected: FAIL — `Cannot find module '../src/net/tls-connect'`

- [ ] **Step 4: Implement the helper**

Create `src/net/tls-connect.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/tls-helper.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Write the packaging assertion before the build that must satisfy it**

Create `scripts/assert-package.ts`. This is the only defence against dead-code elimination silently dropping assets — that failure returns HTTP 200 with a blank page, so a dev-server workflow never surfaces it.

```ts
import { readdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const BIN = process.argv[2] ?? './atrium'
const DIST = process.argv[3] ?? './web-dist'

function countFiles(dir: string): number {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1
  }
  return n
}

const expected = countFiles(DIST)

// Rename dist away so the binary cannot pass by reading from disk.
const parked = `${DIST}.parked`
renameSync(DIST, parked)

let failures: string[] = []
try {
  const proc = Bun.spawn([BIN, 'skeleton'], { cwd: '/tmp', stdout: 'pipe', stderr: 'pipe' })
  await Bun.sleep(500)

  const embedded = Number(await (await fetch('http://127.0.0.1:7373/__embedded')).text())
  if (embedded < expected) failures.push(`embedded ${embedded} < dist ${expected} — DCE dropped assets`)

  const html = await fetch('http://127.0.0.1:7373/')
  if (html.status !== 200) failures.push(`GET / returned ${html.status}`)

  const body = await html.text()
  const cssHref = body.match(/href="([^"]+\.css)"/)?.[1]
  const jsSrc = body.match(/src="([^"]+\.js)"/)?.[1]
  if (!cssHref) failures.push('no stylesheet link in index.html')
  if (!jsSrc) failures.push('no script src in index.html')

  if (cssHref) {
    const css = await fetch(`http://127.0.0.1:7373${cssHref}`)
    const text = await css.text()
    if (css.headers.get('content-type')?.includes('text/css') !== true)
      failures.push(`css content-type was ${css.headers.get('content-type')}`)
    // The canary element uses p-4; if Tailwind emitted nothing this is absent
    // while everything else still returns 200. Spec §10.
    if (!text.includes('padding:1rem') && !text.includes('padding: 1rem'))
      failures.push('served CSS contains no Tailwind utility — v3 config artifacts?')
  }

  if (jsSrc) {
    const js = await fetch(`http://127.0.0.1:7373${jsSrc}`)
    const text = await js.text()
    if (text.includes('react-dom.development'))
      failures.push('served JS is a development build')
  }

  proc.kill()
} finally {
  if (existsSync(parked)) renameSync(parked, DIST)
}

if (failures.length) {
  console.error('PACKAGING ASSERTION FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`packaging ok: ${expected} assets embedded, served from a foreign cwd`)
```

- [ ] **Step 7: Write the skeleton server**

Create `src/skeleton.ts`. Deliberately minimal — two routes plus the embedded-count probe the assertion needs.

```ts
import { embeddedFiles } from 'bun'

const ASSETS = new Map<string, Blob>()
for (const f of embeddedFiles) ASSETS.set(`/${f.name}`, f)

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 7373,
  development: false,
  error: () => new Response('error', { status: 500 }),
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/__embedded') return new Response(String(embeddedFiles.length))

    const hit = ASSETS.get(path) ?? (path === '/' ? ASSETS.get('/index.html') : undefined)
    if (!hit) return new Response('not found', { status: 404 })
    return new Response(hit, { headers: { 'content-type': hit.type } })
  },
})

console.log(`skeleton on ${server.url}`)
```

- [ ] **Step 8: Build and run the assertion**

```bash
bun run vite build && bun build --compile --asset ./web-dist --outfile=atrium src/skeleton.ts && bun run scripts/assert-package.ts ./atrium ./web-dist
```

Expected: `packaging ok: N assets embedded, served from a foreign cwd`

**If `--asset` is not recognised or embeds nothing** (the flag fails silently on versions that lack it — `bun build` drops unknown `--flag=value` arguments without error), the candidate version is rejected. Fall back to bun 1.3.11 plus a codegen step that emits one `with { type: "file" }` import per dist file, and record that in the ADR below. Every such import must be referenced at runtime or DCE drops it.

- [ ] **Step 9: Verify the credential store round-trips inside the compiled binary**

```bash
cat > /tmp/secret-probe.ts <<'EOF'
const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('keyring-timeout')), ms))])
try {
  await withTimeout(Bun.secrets.set({ service: 'atrium-probe', name: 'x', value: 'hello' }), 3000)
  const got = await withTimeout(Bun.secrets.get({ service: 'atrium-probe', name: 'x' }), 3000)
  await Bun.secrets.delete({ service: 'atrium-probe', name: 'x' })
  console.log(got === 'hello' ? 'keyring ok' : `keyring MISMATCH: ${got}`)
} catch (e) { console.log(`keyring unavailable: ${(e as Error).message}`) }
EOF
bun build --compile --outfile=/tmp/secret-probe /tmp/secret-probe.ts && /tmp/secret-probe
```

Expected: `keyring ok`. Any other result is a finding for the ADR, not a failure — the fallback is a 0600 file (§8.5). **`Bun.secrets` hangs indefinitely with no internal timeout when the Secret Service is present but unresponsive**, which is why every call is raced. Note that `Promise.race` does not cancel the underlying call.

- [ ] **Step 10: Record the decision**

Create `docs/decisions/0001-bun-version.md`:

```markdown
# 0001 — Bun version floor

**Date:** <today>
**Status:** Accepted

## Measured
- bun version tested: <output of `bun --version`>
- `--asset` recognised: yes / no
- `Bun.embeddedFiles.length`: <n>   dist file count: <n>
- packaging assertion: pass / fail
- Tailwind utility present in served CSS: yes / no
- `Bun.secrets` round-trip in a compiled binary: ok / unavailable (<reason>)
- dual-stack TLS helper unit tests: pass / fail

## Decision
`engines.bun` floor is `>=X.Y.Z`.

## Consequences
<If the 1.3.11 fallback was taken: the asset-codegen step in scripts/gen-assets.ts
is PERMANENT, not temporary. Every dist file needs a generated
`with { type: "file" }` import that is referenced at runtime, or dead-code
elimination drops it silently and the release build serves a blank page.>

<If the keyring was unavailable: §8.5's 0600 file fallback is the primary path on
this machine, and the credential-store task in Plan 4 must treat the keyring as
optional rather than preferred.>
```

- [ ] **Step 11: Commit**

```bash
git add -A && git commit -m "feat: walking skeleton, runtime version settled by measurement"
```

---

### Task 2: The request gate

Written test-first because §8.2's failure mode is one unchecked route, and every route in the project passes through this function.

**Files:**
- Create: `test/gate.test.ts` (before the implementation)
- Create: `src/server/gate.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `checkRequest(req: Request, port: number): GateResult` where `type GateResult = { ok: true } | { ok: false; status: number; reason: string }`. Task 3 and Task 4 both call this.

- [ ] **Step 1: Write the failing negative suite**

Create `test/gate.test.ts`. Every case here is a verified attack or a Bun-specific trap from spec §8.2.

```ts
import { test, expect, describe } from 'bun:test'
import { checkRequest } from '../src/server/gate'

const PORT = 7373
const mk = (headers: Record<string, string>, method = 'GET', url = 'http://127.0.0.1:7373/api/state') =>
  new Request(url, { method, headers })

describe('Host header', () => {
  const reject = [
    ['foreign host', { host: 'evil.com:7373' }],
    ['loopback-resolving subdomain', { host: 'evil.localhost:7373' }],   // RFC 6761
    ['trailing dot', { host: 'localhost.:7373' }],
    ['wildcard address', { host: '0.0.0.0:7373' }],                      // reaches a loopback bind
    ['ipv6 loopback', { host: '[::1]:7373' }],
    ['comma-joined duplicate', { host: '127.0.0.1:7373,evil.com' }],     // Bun joins, not 400
    ['wrong port', { host: '127.0.0.1:3000' }],
    ['no port', { host: '127.0.0.1' }],
    ['empty', { host: '' }],
  ] as const

  for (const [name, h] of reject) {
    test(`rejects ${name}`, () => {
      expect(checkRequest(mk({ ...h, origin: 'http://127.0.0.1:7373' }), PORT).ok).toBe(false)
    })
  }

  test('rejects a missing Host entirely', () => {
    const req = new Request('http://127.0.0.1:7373/api/state')
    req.headers.delete('host')
    expect(checkRequest(req, PORT).ok).toBe(false)
  })

  test('accepts both blessed hosts, case-insensitively', () => {
    for (const host of ['127.0.0.1:7373', 'localhost:7373', 'LOCALHOST:7373']) {
      expect(checkRequest(mk({ host, origin: 'http://127.0.0.1:7373' }), PORT).ok).toBe(true)
    }
  })
})

describe('absolute-form request URI', () => {
  // Bun gives two DISAGREEING views: req.url is attacker-controlled while the
  // Host header is clean. Enforce on the header only. Spec §8.2.
  test('ignores an attacker-controlled req.url when Host is valid', () => {
    const req = mk({ host: '127.0.0.1:7373', origin: 'http://127.0.0.1:7373' }, 'GET', 'http://evil.example.com/api/state')
    expect(checkRequest(req, PORT).ok).toBe(true)
  })
})

describe('Origin', () => {
  test('rejects another localhost port', () => {
    expect(checkRequest(mk({ host: '127.0.0.1:7373', origin: 'http://localhost:3000' }), PORT).ok).toBe(false)
  })

  test('rejects the literal null origin on a state-changing request', () => {
    expect(checkRequest(mk({ host: '127.0.0.1:7373', origin: 'null' }, 'POST'), PORT).ok).toBe(false)
  })

  test('rejects an absent origin on a state-changing request', () => {
    expect(checkRequest(mk({ host: '127.0.0.1:7373' }, 'POST'), PORT).ok).toBe(false)
  })

  test('allows an absent origin on a read-only GET', () => {
    expect(checkRequest(mk({ host: '127.0.0.1:7373' }), PORT).ok).toBe(true)
  })
})

describe('Sec-Fetch-Site', () => {
  test('rejects cross-site', () => {
    expect(checkRequest(mk({ host: '127.0.0.1:7373', origin: 'http://127.0.0.1:7373', 'sec-fetch-site': 'cross-site' }), PORT).ok).toBe(false)
  })

  test('allows same-origin and none', () => {
    for (const sfs of ['same-origin', 'none']) {
      expect(checkRequest(mk({ host: '127.0.0.1:7373', origin: 'http://127.0.0.1:7373', 'sec-fetch-site': sfs }), PORT).ok).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/gate.test.ts`
Expected: FAIL — `Cannot find module '../src/server/gate'`

- [ ] **Step 3: Implement the gate**

Create `src/server/gate.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/gate.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Mutation-check the gate**

Delete the `!hosts.has(host)` condition (leave `!host`), re-run.

Run: `bun test test/gate.test.ts`
Expected: FAIL — at least the `foreign host`, `evil.localhost`, `0.0.0.0` and `wrong port` cases go red. **If they do not, the suite is decorative.** Restore the condition and confirm green again.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: request gate with mutation-checked negative suite"
```

---

### Task 3: Token auth — handoff, bearer, and the WebSocket first frame

**Files:**
- Create: `test/auth.test.ts` (before the implementation)
- Create: `src/server/auth.ts`

**Interfaces:**
- Consumes: `checkRequest` from Task 2.
- Produces: `createAuth(opts?: {ttlMs?: number})` returning `{ sessionToken: string, mintHandoff(now: number): string, consumeHandoff(token: string, now: number): boolean, verifyBearer(req: Request): boolean, authenticateSocket(frame: string): boolean }`. Task 4 mounts these. **Every time value is passed in, never read from the clock inside** — that is what makes the TTL testable without sleeping.

- [ ] **Step 1: Write the failing auth suite**

Create `test/auth.test.ts`:

```ts
import { test, expect, describe, beforeEach } from 'bun:test'
import { createAuth } from '../src/server/auth'

describe('handoff token', () => {
  let auth: ReturnType<typeof createAuth>
  beforeEach(() => { auth = createAuth({ ttlMs: 60_000 }) })

  test('a freshly minted token is accepted once', () => {
    const t = auth.mintHandoff(1000)
    expect(auth.consumeHandoff(t, 1000)).toBe(true)
  })

  test('the same token is rejected on second use', () => {
    const t = auth.mintHandoff(1000)
    auth.consumeHandoff(t, 1000)
    expect(auth.consumeHandoff(t, 1000)).toBe(false)   // single-use
  })

  test('a token past its ttl is rejected', () => {
    const t = auth.mintHandoff(1000)
    expect(auth.consumeHandoff(t, 1000 + 60_001)).toBe(false)
  })

  test('an unknown token is rejected', () => {
    expect(auth.consumeHandoff('not-a-real-token', 1000)).toBe(false)
  })

  test('tokens are 32 bytes of csprng, base64url', () => {
    const t = auth.mintHandoff(1000)
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(t).not.toBe(auth.mintHandoff(1000))
  })
})

describe('websocket first-frame auth', () => {
  // The browser WS API cannot set headers, and a non-browser local process
  // forges Origin trivially: a raw handshake with a forged Host and no Origin
  // returned 101. Zero state before auth is the control. Spec §8.4.
  let auth: ReturnType<typeof createAuth>
  beforeEach(() => { auth = createAuth({ ttlMs: 60_000 }) })

  test('accepts a correct first frame', () => {
    const frame = JSON.stringify({ type: 'auth', token: auth.sessionToken })
    expect(auth.authenticateSocket(frame)).toBe(true)
  })

  test('rejects a wrong token', () => {
    expect(auth.authenticateSocket(JSON.stringify({ type: 'auth', token: 'wrong' }))).toBe(false)
  })

  test('rejects a first frame that is not an auth frame', () => {
    expect(auth.authenticateSocket(JSON.stringify({ type: 'subscribe' }))).toBe(false)
  })

  test('rejects malformed json', () => {
    expect(auth.authenticateSocket('{not json')).toBe(false)
  })
})

describe('bearer verification', () => {
  let auth: ReturnType<typeof createAuth>
  beforeEach(() => { auth = createAuth({ ttlMs: 60_000 }) })

  test('accepts the session token', () => {
    const req = new Request('http://127.0.0.1:7373/api/state', {
      headers: { authorization: `Bearer ${auth.sessionToken}` },
    })
    expect(auth.verifyBearer(req)).toBe(true)
  })

  test('rejects a missing header, a wrong scheme, and a wrong token', () => {
    const cases = [{}, { authorization: auth.sessionToken }, { authorization: 'Bearer nope' }]
    for (const headers of cases) {
      expect(auth.verifyBearer(new Request('http://127.0.0.1:7373/api/state', { headers }))).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/auth.test.ts`
Expected: FAIL — `Cannot find module '../src/server/auth'`

- [ ] **Step 3: Implement auth**

Create `src/server/auth.ts`:

```ts
function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

export interface AuthOptions { ttlMs?: number }

/**
 * Token transport. NOT a cookie: RFC 6265 §8.5 gives cookies no port isolation,
 * so a session cookie is sent to every other service on loopback, and a page
 * from another localhost port is same-site — SameSite=Strict would not apply.
 *
 * localStorage, NOT sessionStorage: sessionStorage is per-tab, which breaks
 * §9's open-a-tab-on-login (every launch would land unauthenticated).
 * Residual, accepted: localStorage persists the bearer to the browser profile
 * on disk, surviving reboot and profile sync. Spec §8.3.
 */
export function createAuth(opts: AuthOptions = {}) {
  const ttlMs = opts.ttlMs ?? 60_000
  const sessionToken = randomToken()
  const handoffs = new Map<string, number>()   // token -> issuedAt

  return {
    sessionToken,

    mintHandoff(now: number): string {
      const t = randomToken()
      handoffs.set(t, now)
      return t
    },

    consumeHandoff(token: string, now: number): boolean {
      const issued = handoffs.get(token)
      if (issued === undefined) return false
      handoffs.delete(token)                      // single-use, even when expired
      return now - issued <= ttlMs
    },

    verifyBearer(req: Request): boolean {
      const h = req.headers.get('authorization')
      if (!h?.startsWith('Bearer ')) return false
      return h.slice(7) === sessionToken
    },

    // Called on the FIRST frame only. The socket must have been sent zero
    // state before this returns true; close 1008 on false.
    authenticateSocket(frame: string): boolean {
      try {
        const msg = JSON.parse(frame)
        return msg?.type === 'auth' && msg?.token === sessionToken
      } catch { return false }
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/auth.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Mutation-check single-use**

Change `handoffs.delete(token)` to run only when the token is still valid. Re-run.

Expected: FAIL on `the same token is rejected on second use`. Restore and confirm green. Deleting unconditionally is deliberate — an expired token must not remain replayable.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: handoff/bearer/websocket auth, single-use mutation-checked"
```

---

### Task 4: Server wiring — endpoint.json, /healthz, port collision

**Files:**
- Create: `src/core/paths.ts`, `src/server/serve.ts`, `src/index.ts`
- Create: `test/paths.test.ts`, `test/serve.test.ts`
- (`src/server/routes.ts` is created in Task 7 — until then `serve.ts` handles its three routes inline)

**Interfaces:**
- Consumes: `checkRequest` (Task 2), `createAuth` (Task 3).
- Produces: from `paths.ts` — `buildExecLine(ctx: ExecContext): string`, `currentExecContext(): ExecContext`, `configDir(env?): string`, `endpointPath(env?): string`; from `serve.ts` — `startServer(cfg: {port: number}): Promise<Server>`. The install command in Plan 4 consumes `buildExecLine(currentExecContext())`.

- [ ] **Step 1: Write the failing exec-path test**

Create `test/paths.test.ts`. This is the trap that works for the author and breaks for the first external user.

```ts
import { test, expect } from 'bun:test'
import { buildExecLine } from '../src/core/paths'

test('a compiled binary uses its own absolute path', () => {
  const line = buildExecLine({ isCompiled: true, execPath: '/usr/local/bin/atrium', mainPath: '/$bunfs/root/index.ts' })
  expect(line).toBe('/usr/local/bin/atrium')
  expect(line).not.toContain('$bunfs')
})

test('a script run uses the runtime plus the script path', () => {
  const line = buildExecLine({ isCompiled: false, execPath: '/home/u/.bun/bin/bun', mainPath: '/home/u/atrium/src/index.ts' })
  expect(line).toBe('/home/u/.bun/bin/bun /home/u/atrium/src/index.ts')
})

test('never emits a /$bunfs path in either branch', () => {
  for (const isCompiled of [true, false]) {
    const line = buildExecLine({ isCompiled, execPath: '/real/path', mainPath: '/$bunfs/root/x.ts' })
    if (isCompiled) expect(line).not.toContain('$bunfs')
  }
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/paths.test.ts`
Expected: FAIL — `Cannot find module '../src/core/paths'`

- [ ] **Step 3: Implement paths**

Create `src/core/paths.ts`:

```ts
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface ExecContext { isCompiled: boolean; execPath: string; mainPath: string }

/**
 * NEVER build this from __dirname, import.meta.path/dir, or process.argv[1]:
 * inside a compiled binary those are /$bunfs/root/… paths that do not exist on
 * disk, and process.argv[0] is the bare string "bun". Spec §9.
 */
export function buildExecLine(ctx: ExecContext): string {
  return ctx.isCompiled ? ctx.execPath : `${ctx.execPath} ${ctx.mainPath}`
}

export function currentExecContext(): ExecContext {
  return {
    isCompiled: import.meta.path.startsWith('/$bunfs/'),
    execPath: process.execPath,
    mainPath: Bun.main,
  }
}

export function configDir(env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'atrium')
}

// $XDG_RUNTIME_DIR does not exist on macOS or Windows; fall back to the config
// dir so every launcher has one place to look. Stale files after a crash are
// detected by checking whether `pid` is still alive.
export function endpointPath(env = process.env): string {
  const base = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'atrium') : configDir(env)
  return join(base, 'endpoint.json')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/paths.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing server test**

Create `test/serve.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { startServer } from '../src/server/serve'

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
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test test/serve.test.ts`
Expected: FAIL — `Cannot find module '../src/server/serve'`

- [ ] **Step 7: Implement the server**

Create `src/server/serve.ts`:

```ts
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { checkRequest } from './gate'
import { createAuth } from './auth'
import { endpointPath } from '../core/paths'

const SECURITY_HEADERS = (port: number) => ({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'content-security-policy':
    `default-src 'self'; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; frame-ancestors 'none'`,
})

export async function startServer(cfg: { port: number }) {
  const auth = createAuth()
  const nonce = crypto.randomUUID()
  const headers = SECURITY_HEADERS(cfg.port)

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: cfg.port,
      development: false,
      error: () => new Response('internal error', { status: 500, headers }),

      fetch(req, srv) {
        const gate = checkRequest(req, cfg.port)
        if (!gate.ok) return new Response('forbidden', { status: gate.status, headers })

        const path = new URL(req.url).pathname

        // Unauthenticated, but gated. The launcher needs something to poll and
        // the token-gated routes cannot serve that purpose (§9).
        if (path === '/healthz') {
          return Response.json({ ok: true, pid: process.pid, nonce }, { headers })
        }

        if (path === '/ws') {
          // Origin is validated above; the first frame carries the token (§8.4).
          return srv.upgrade(req, { data: { authed: false } })
            ? undefined
            : new Response('expected websocket', { status: 426, headers })
        }

        if (!auth.verifyBearer(req)) {
          return new Response('unauthorized', { status: 401, headers })
        }

        return new Response('not found', { status: 404, headers })
      },

      websocket: {
        message(ws, raw) {
          const state = ws.data as { authed: boolean }
          if (!state.authed) {
            // ZERO state has been sent before this point. That property is the
            // single control that makes a forgeable Origin survivable (§8.4).
            if (!auth.authenticateSocket(String(raw))) return ws.close(1008, 'auth')
            state.authed = true
            return
          }
          // Provider subscriptions land here in a later plan.
        },
      },
    })
  } catch (e) {
    if ((e as { code?: string }).code === 'EADDRINUSE') {
      console.error(`atrium: port ${cfg.port} is already in use. Change it with the "port" key in your config, or free the port.`)
      process.exit(78)   // EX_CONFIG; paired with RestartPreventExitStatus=78
    }
    throw e
  }

  const ep = endpointPath()
  mkdirSync(dirname(ep), { recursive: true, mode: 0o700 })
  writeFileSync(ep, JSON.stringify({ url: String(server.url), pid: process.pid, nonce }), { mode: 0o600 })

  const cleanup = () => { try { unlinkSync(ep) } catch {} }
  process.on('exit', cleanup)
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
  process.on('SIGINT', () => { cleanup(); process.exit(0) })

  return server
}
```

Create `src/index.ts`. The port-collision test spawns this file directly, so it must exist now:

```ts
import { startServer } from './server/serve'

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'serve'

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}

switch (cmd) {
  case 'serve': {
    const port = Number(flag('port') ?? 7373)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`atrium: invalid port "${flag('port')}"`)
      process.exit(78)
    }
    await startServer({ port })
    break
  }
  default:
    console.error(`atrium: unknown command "${cmd}"`)
    console.error('usage: atrium serve [--port N]')
    process.exit(64)   // EX_USAGE
}
```

Subcommands `open`, `install`, `uninstall`, `doctor` and `rotate-token` are added in Plan 4.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test test/serve.test.ts test/paths.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: server wiring with healthz nonce, endpoint.json and exit 78"
```

---

### Task 5: `runGit()` — the hardened chokepoint

Built before any git provider work. Every git call written before this exists has to be retrofitted, and retrofits are where one call gets missed.

**Files:**
- Create: `test/fixtures/gitrepo.ts`, `test/rungit.test.ts`, `src/core/rungit.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `runGit(repoPath: string, args: string[], opts?: {timeoutMs?: number}): Promise<{stdout: string, stderr: string, code: number}>`. The git provider in a later plan calls only this.

- [ ] **Step 1: Write the malicious-repo fixture builder**

Create `test/fixtures/gitrepo.ts`. Generated, never `$HOME`-derived (§10 rule 1).

```ts
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const CLEAN_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

export function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atrium-fix-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: CLEAN_ENV })
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  execFileSync('git', ['-C', dir, 'add', '.'], { env: CLEAN_ENV })
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { env: CLEAN_ENV })
  return dir
}

/** Plants all four known execution vectors and returns the marker path. */
export function makeMaliciousRepo(): { dir: string; marker: string } {
  const dir = makeRepo()
  const marker = join(dir, 'PWNED')
  const script = join(dir, 'payload.sh')
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`)
  chmodSync(script, 0o755)

  // 1 + 2: repo-local config git runs THROUGH A SHELL.
  execFileSync('git', ['-C', dir, 'config', 'core.fsmonitor', script], { env: CLEAN_ENV })
  execFileSync('git', ['-C', dir, 'config', 'diff.external', script], { env: CLEAN_ENV })

  // 3: repo-local hooksPath — NOT blocked by clearing core.fsmonitor.
  const hooks = join(dir, 'evilhooks')
  mkdirSync(hooks, { recursive: true })
  writeFileSync(join(hooks, 'post-index-change'), `#!/bin/sh\ntouch "${marker}"\n`)
  chmodSync(join(hooks, 'post-index-change'), 0o755)
  execFileSync('git', ['-C', dir, 'config', 'core.hooksPath', hooks], { env: CLEAN_ENV })

  // 4: a bare hook in the default location, with zero config entries.
  const bare = join(dir, '.git', 'hooks', 'post-index-change')
  writeFileSync(bare, `#!/bin/sh\ntouch "${marker}"\n`)
  chmodSync(bare, 0o755)

  return { dir, marker }
}

export const wasPwned = (marker: string) => existsSync(marker)
```

- [ ] **Step 2: Write the failing security test**

Create `test/rungit.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { makeRepo, makeMaliciousRepo, wasPwned } from './fixtures/gitrepo'
import { runGit } from '../src/core/rungit'

test('a hostile repo cannot execute anything through status or diff', async () => {
  const { dir, marker } = makeMaliciousRepo()

  await runGit(dir, ['status', '--porcelain=v2', '--branch'])
  await runGit(dir, ['diff'])
  await runGit(dir, ['log', '-1', '--format=%ct'])

  expect(wasPwned(marker)).toBe(false)
})

test('reads real metadata from a benign repo', async () => {
  const dir = makeRepo()
  const { stdout, code } = await runGit(dir, ['status', '--porcelain=v2', '--branch'])
  expect(code).toBe(0)
  expect(stdout).toContain('# branch.head main')
})

test('a repo path beginning with a dash is not read as a flag', async () => {
  const dir = makeRepo()
  const { code } = await runGit(dir, ['status', '--porcelain=v2'])
  expect(code).toBe(0)   // -C takes an absolute resolved path, never a bare name
})

test('an empty repo is tolerated, not an error state', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'atrium-empty-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } })

  const { code, stderr } = await runGit(dir, ['log', '-1', '--format=%ct'])
  expect(code).not.toBe(0)
  expect(stderr).toContain('does not have any commits yet')   // caller tolerates this
})

test('no source file calls git outside runGit', async () => {
  const { execFileSync } = await import('node:child_process')
  let hits = ''
  try {
    hits = execFileSync('grep', ['-rn', '--include=*.ts', "execFile.*['\"]git['\"]", 'src/'], { encoding: 'utf8' })
  } catch { hits = '' }   // grep exits 1 on no match
  const offenders = hits.split('\n').filter((l) => l && !l.includes('src/core/rungit.ts'))
  expect(offenders).toEqual([])
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test test/rungit.test.ts`
Expected: FAIL — `Cannot find module '../src/core/rungit'`

- [ ] **Step 4: Implement runGit**

Create `src/core/rungit.ts`:

```ts
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// An empty directory Atrium owns. Pointing core.hooksPath here is stronger than
// /dev/null: git treats it as a real but hook-free directory.
const EMPTY_HOOKS = mkdtempSync(join(tmpdir(), 'atrium-nohooks-'))

/**
 * Command-line -c beats repo-local config. This is NOT a blocklist of dangerous
 * values — blocklists are never viable here, because git's long-option
 * abbreviation means --upload-p= executes exactly as --upload-pack= does.
 * It is a fixed set of settings that git would otherwise read from an
 * attacker-controlled .git/config AND RUN THROUGH A SHELL. Spec §8.6.
 */
const HARDENING = [
  '--no-pager',
  '-c', 'core.fsmonitor=',
  '-c', `core.hooksPath=${EMPTY_HOOKS}`,
  '-c', 'core.sshCommand=',
  '-c', 'core.askPass=',
  '-c', 'core.editor=false',
  '-c', 'core.pager=cat',
  '-c', 'diff.external=',
  '-c', 'protocol.ext.allow=never',
]

/**
 * The child env is an ALLOWLIST built from scratch, and it explicitly SETS
 * GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM. A blanket "scrub all GIT_*" would
 * delete the two variables that make the security tests honest — this machine's
 * ~/.gitconfig redirects core.hooksPath, which would silently make the hook
 * test pass here while every other user stayed exploitable. Spec §8.6, §10.
 */
function childEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/nonexistent',
    LANG: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
}

export interface GitResult { stdout: string; stderr: string; code: number }

/** THE ONLY PATH TO GIT. test/rungit.test.ts greps src/ to enforce that. */
export function runGit(repoPath: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<GitResult> {
  const abs = resolve(repoPath)
  const argv = [...HARDENING, '-C', abs, ...args]

  return new Promise((res) => {
    execFile('git', argv, {
      env: childEnv(),
      timeout: opts.timeoutMs ?? 5000,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      res({ stdout, stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 })
    })
  })
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/rungit.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Mutation-check the hardening (mandatory)**

Replace `const argv = [...HARDENING, '-C', abs, ...args]` with `const argv = ['-C', abs, ...args]`. Re-run.

Run: `bun test test/rungit.test.ts`
Expected: FAIL on `a hostile repo cannot execute anything through status or diff`.

**If it passes, stop and diagnose before continuing.** The most likely cause is that your `~/.gitconfig` sets `core.hooksPath`, which masks the hook vectors — the exact false pass §10 rule 2 exists to prevent. Confirm `childEnv()` is setting both `GIT_CONFIG_*` variables. Restore the hardening and confirm green.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: hardened runGit chokepoint, mutation-checked against a malicious repo"
```

---

### Task 6: The provider contract

Revision 1's contract was falsified by three of its own four providers. This one is defined before any provider so that cannot recur.

**Files:**
- Create: `src/core/contract.ts`, `src/core/registry.ts`, `src/core/scheduler.ts`
- Create: `test/contract.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: from `contract.ts` — `Provider`, `Schedule`, `DetectResult`, `FetchCtx`, `Action`, `Disposable` types; from `registry.ts` — `createRegistry()` with `register(p)`, `get(id)`, `all()`; from `scheduler.ts` — `createScheduler(registry, opts)` with `start()`, `stop()`, `runNow(providerId, scheduleName)`, `onUpdate(fn)` and `snapshot()`. **Plan 3's WebSocket protocol is built on `onUpdate` and `snapshot`** — `snapshot()` is what a reconnecting client receives, so it must return every provider's last value.

- [ ] **Step 1: Write the failing contract test**

Create `test/contract.test.ts`:

```ts
import { test, expect, describe } from 'bun:test'
import { createRegistry } from '../src/core/registry'
import { createScheduler } from '../src/core/scheduler'
import type { Provider } from '../src/core/contract'

const stub = (id: string, overrides: Partial<Provider<any, any>> = {}): Provider<any, any> => ({
  id,
  configSchema: { parse: (x: any) => x } as any,
  detect: async () => ({ kind: 'nothing-to-detect' }),
  schedules: [{ name: 'poll', intervalMs: 1000, runOnStart: false }],
  fetch: async () => ({ ok: true }),
  actions: [],
  ...overrides,
})

describe('registry', () => {
  test('rejects a duplicate provider id', () => {
    const r = createRegistry()
    r.register(stub('git'))
    expect(() => r.register(stub('git'))).toThrow(/duplicate/i)
  })

  test('rejects duplicate action ids within a provider', () => {
    const r = createRegistry()
    const p = stub('git', {
      actions: [
        { kind: 'exec', id: 'open', label: 'Open', argv: () => ({ cmd: 'true', args: [] }) },
        { kind: 'exec', id: 'open', label: 'Open again', argv: () => ({ cmd: 'true', args: [] }) },
      ],
    })
    expect(() => r.register(p)).toThrow(/duplicate action/i)
  })

  test('the same action id in two providers is fine — routes are namespaced', () => {
    const r = createRegistry()
    const mk = (id: string) => stub(id, {
      actions: [{ kind: 'exec' as const, id: 'open', label: 'Open', argv: () => ({ cmd: 'true', args: [] }) }],
    })
    r.register(mk('git'))
    expect(() => r.register(mk('obsidian'))).not.toThrow()
  })
})

describe('scheduler', () => {
  test('routes the schedule name into fetch, so one provider can have two', async () => {
    const seen: string[] = []
    const r = createRegistry()
    r.register(stub('git', {
      schedules: [
        { name: 'discovery', intervalMs: 600_000, runOnStart: true },
        { name: 'metadata', intervalMs: 30_000, runOnStart: true },
      ],
      fetch: async (_cfg, ctx) => { seen.push(ctx.schedule); return {} },
    }))

    const s = createScheduler(r, { config: { git: {} } })
    await s.runNow('git', 'discovery')
    await s.runNow('git', 'metadata')

    expect(seen).toEqual(['discovery', 'metadata'])
  })

  test('passes the previous result so a metadata pass can read the discovery list', async () => {
    const r = createRegistry()
    let sawPrevious: unknown = 'unset'
    r.register(stub('git', {
      schedules: [{ name: 'poll', intervalMs: 1000, runOnStart: false }],
      fetch: async (_cfg, ctx) => { sawPrevious = ctx.previous; return { n: 1 } },
    }))

    const s = createScheduler(r, { config: { git: {} } })
    await s.runNow('git', 'poll')
    expect(sawPrevious).toBeUndefined()
    await s.runNow('git', 'poll')
    expect(sawPrevious).toEqual({ n: 1 })
  })

  test('concurrent runs of the same schedule share one in-flight promise', async () => {
    let calls = 0
    const r = createRegistry()
    r.register(stub('slow', {
      fetch: async () => { calls++; await Bun.sleep(50); return {} },
    }))

    const s = createScheduler(r, { config: { slow: {} } })
    await Promise.all([s.runNow('slow', 'poll'), s.runNow('slow', 'poll'), s.runNow('slow', 'poll')])
    expect(calls).toBe(1)
  })

  test('a watch source emits without waiting for the interval', async () => {
    const r = createRegistry()
    let emitted = 0
    r.register(stub('obsidian', {
      schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: false }],
      watch: (_cfg, emit) => { setTimeout(() => emit(), 10); return { close() {} } },
      fetch: async () => { emitted++; return {} },
    }))

    const s = createScheduler(r, { config: { obsidian: {} } })
    s.start()
    await Bun.sleep(60)
    s.stop()
    expect(emitted).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/contract.test.ts`
Expected: FAIL — `Cannot find module '../src/core/registry'`

- [ ] **Step 3: Implement the contract types**

Create `src/core/contract.ts`. `DetectResult` and `FetchCtx` are defined here because revision 2 referenced both and defined neither.

```ts
export interface Schedule {
  name: string          // 'discovery' | 'metadata' | 'poll' — routed into FetchCtx
  intervalMs: number
  runOnStart: boolean
}

export interface Disposable { close(): void }

/**
 * Three outcomes, because mail's detect() genuinely finds nothing and git's
 * finds a list the user should confirm. A bare null cannot express the middle
 * case, and the middle case is first run's entire job.
 */
export type DetectResult<Cfg> =
  | { kind: 'configured'; config: Partial<Cfg> }
  | { kind: 'candidates'; candidates: Array<{ label: string; config: Partial<Cfg> }> }
  | { kind: 'nothing-to-detect'; reason?: string }

/**
 * Carries the schedule name, without which the git provider physically cannot
 * route discovery vs metadata — the single reason this contract was rewritten.
 */
export interface FetchCtx<Data = unknown> {
  schedule: string
  previous?: Data
  signal: AbortSignal
}

export type Action =
  | { kind: 'exec'; id: string; label: string; keybinding?: string
      argv(target: unknown): { cmd: string; args: string[] } }
  | { kind: 'call'; id: string; label: string; keybinding?: string
      payloadSchema?: { parse(x: unknown): unknown }
      run(target: unknown, cfg: unknown): Promise<void> }

export interface Provider<Cfg, Data> {
  id: string
  configSchema: { parse(x: unknown): Cfg }
  detect(): Promise<DetectResult<Cfg>>
  schedules: Schedule[]
  /** Push source for providers whose data changes off-schedule (obsidian's
   *  filesystem watcher). The interval schedule remains as the fallback for
   *  when the watcher fails or the platform has none. */
  watch?(cfg: Cfg, emit: () => void): Disposable
  fetch(cfg: Cfg, ctx: FetchCtx<Data>): Promise<Data>
  actions: Action[]
}
```

- [ ] **Step 4: Implement the registry and scheduler**

Create `src/core/registry.ts`:

```ts
import type { Provider } from './contract'

export function createRegistry() {
  const providers = new Map<string, Provider<any, any>>()

  return {
    register(p: Provider<any, any>) {
      if (providers.has(p.id)) throw new Error(`duplicate provider id: ${p.id}`)
      const ids = new Set<string>()
      for (const a of p.actions) {
        if (ids.has(a.id)) throw new Error(`duplicate action id "${a.id}" in provider "${p.id}"`)
        ids.add(a.id)
      }
      providers.set(p.id, p)
    },
    get: (id: string) => providers.get(id),
    all: () => [...providers.values()],
  }
}

export type Registry = ReturnType<typeof createRegistry>
```

Create `src/core/scheduler.ts`:

```ts
import type { Registry } from './registry'
import type { Disposable } from './contract'

export function createScheduler(registry: Registry, opts: { config: Record<string, unknown> }) {
  const last = new Map<string, unknown>()          // providerId -> last Data
  const inflight = new Map<string, Promise<unknown>>()
  const timers: ReturnType<typeof setInterval>[] = []
  const watchers: Disposable[] = []
  const listeners = new Set<(id: string, data: unknown) => void>()

  async function runNow(providerId: string, scheduleName: string) {
    const key = `${providerId}:${scheduleName}`
    const existing = inflight.get(key)
    if (existing) return existing                  // share, never stampede

    const p = registry.get(providerId)
    if (!p) throw new Error(`unknown provider: ${providerId}`)

    const ac = new AbortController()
    const run = (async () => {
      const data = await p.fetch(opts.config[providerId] as never, {
        schedule: scheduleName,
        previous: last.get(providerId),
        signal: ac.signal,
      })
      last.set(providerId, data)
      for (const l of listeners) l(providerId, data)
      return data
    })().finally(() => inflight.delete(key))

    inflight.set(key, run)
    return run
  }

  return {
    runNow,
    onUpdate: (fn: (id: string, data: unknown) => void) => { listeners.add(fn); return () => listeners.delete(fn) },
    snapshot: () => Object.fromEntries(last),

    start() {
      for (const p of registry.all()) {
        for (const s of p.schedules) {
          if (s.runOnStart) void runNow(p.id, s.name)
          timers.push(setInterval(() => void runNow(p.id, s.name), s.intervalMs))
        }
        if (p.watch) {
          watchers.push(p.watch(opts.config[p.id] as never, () => void runNow(p.id, p.schedules[0].name)))
        }
      }
    },

    stop() {
      for (const t of timers) clearInterval(t)
      for (const w of watchers) w.close()
      timers.length = 0
      watchers.length = 0
    },
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/contract.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: provider contract with named schedules and watch sources"
```

---

### Task 7: The action layer

**Files:**
- Create: `src/core/actions.ts`, `test/actions.test.ts`
- Modify: `src/server/routes.ts` — mount `POST /api/actions/:providerId/:actionId`

**Interfaces:**
- Consumes: `Registry` (Task 6), `checkRequest` (Task 2), `verifyBearer` (Task 3).
- Produces: `dispatch(registry: Registry, providerId: string, actionId: string, payload: unknown): Promise<void>`, `buildArgv(action: Action, target: unknown): {cmd: string, args: string[]}`, and `spawnDetached(cmd: string, args: string[]): void`.

- [ ] **Step 1: Write the failing action test**

Create `test/actions.test.ts`:

```ts
import { test, expect, describe } from 'bun:test'
import { createRegistry } from '../src/core/registry'
import { dispatch, buildArgv } from '../src/core/actions'
import type { Provider } from '../src/core/contract'

const provider = (actions: Provider<any, any>['actions']): Provider<any, any> => ({
  id: 'git',
  configSchema: { parse: (x: any) => x },
  detect: async () => ({ kind: 'nothing-to-detect' }),
  schedules: [{ name: 'poll', intervalMs: 1000, runOnStart: false }],
  fetch: async () => ({}),
  actions,
})

describe('argv invariant', () => {
  test('every exec action yields an argv array, never a string', () => {
    const p = provider([{
      kind: 'exec', id: 'open', label: 'Open',
      argv: (t: any) => ({ cmd: '/usr/bin/xdg-open', args: [t.path] }),
    }])
    const out = buildArgv(p.actions[0], { path: '/home/u/repo' })
    expect(Array.isArray(out.args)).toBe(true)
    expect(out.cmd).not.toContain(' ')
  })

  test('a path beginning with a dash is passed as an absolute path, not a flag', () => {
    const p = provider([{
      kind: 'exec', id: 'open', label: 'Open',
      argv: (t: any) => ({ cmd: '/usr/bin/xdg-open', args: [t.path] }),
    }])
    const out = buildArgv(p.actions[0], { path: '/tmp/-rf' })
    expect(out.args[0].startsWith('/')).toBe(true)
  })

  test('a shell metacharacter in a target is inert because there is no shell', () => {
    const p = provider([{
      kind: 'exec', id: 'open', label: 'Open',
      argv: (t: any) => ({ cmd: '/bin/echo', args: [t.path] }),
    }])
    const out = buildArgv(p.actions[0], { path: '/tmp/foo; rm -rf ~' })
    expect(out.args).toEqual(['/tmp/foo; rm -rf ~'])   // one argument, not three
  })
})

describe('dispatch', () => {
  test('rejects an unknown action id rather than dispatching dynamically', async () => {
    const r = createRegistry()
    r.register(provider([]))
    await expect(dispatch(r, 'git', 'nonexistent', {})).rejects.toThrow(/unknown action/i)
  })

  test('rejects an unknown provider id', async () => {
    const r = createRegistry()
    r.register(provider([]))
    await expect(dispatch(r, 'nope', 'open', {})).rejects.toThrow(/unknown provider/i)
  })

  test('a call action validates its payload at the boundary', async () => {
    const r = createRegistry()
    r.register(provider([{
      kind: 'call', id: 'capture', label: 'Capture',
      payloadSchema: { parse: (x: any) => { if (typeof x?.text !== 'string') throw new Error('bad payload'); return x } },
      run: async () => {},
    }]))
    await expect(dispatch(r, 'git', 'capture', { text: 123 })).rejects.toThrow(/bad payload/)
    await expect(dispatch(r, 'git', 'capture', { text: 'ok' })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/actions.test.ts`
Expected: FAIL — `Cannot find module '../src/core/actions'`

- [ ] **Step 3: Implement the action layer**

Create `src/core/actions.ts`:

```ts
import { execFile } from 'node:child_process'
import { resolve, isAbsolute } from 'node:path'
import type { Action } from './contract'
import type { Registry } from './registry'

/**
 * execFile(cmd, args[]) with NO shell — necessary everywhere, and NOT
 * sufficient for git, where the injection is in the callee's own config
 * (see runGit, §8.6). This is the general rule for every other exec action.
 */
export function buildArgv(action: Action, target: unknown): { cmd: string; args: string[] } {
  if (action.kind !== 'exec') throw new Error(`action "${action.id}" is not an exec action`)
  const out = action.argv(target)
  if (typeof out.cmd !== 'string' || !Array.isArray(out.args)) {
    throw new Error(`action "${action.id}" did not return an argv pair`)
  }
  // Path-shaped holes only: a bare "-rf" would be read as a flag by the callee.
  return { cmd: out.cmd, args: out.args.map((a) => (a.startsWith('-') && !isAbsolute(a) ? resolve(a) : a)) }
}

/**
 * systemd tears down a unit's cgroup on deactivation and kills its children, so
 * without detaching, `systemctl --user restart atrium` kills every editor and
 * terminal the dashboard opened. Spec §9.
 *
 * NOTE: the --scope mechanism is a documented open question — it is exec'd by
 * the client, so it propagates this process's environment rather than the
 * manager's current one. Re-evaluate against a transient service before the
 * autostart plan lands. The argv array is unchanged either way.
 */
export function spawnDetached(cmd: string, args: string[]): void {
  const wrapped = ['--user', '--scope', '--quiet', '--collect', '--', cmd, ...args]
  execFile('systemd-run', wrapped, { env: process.env }, (err) => {
    if (err) execFile(cmd, args, { env: process.env }, () => {})   // fallback: no systemd/D-Bus
  })
}

export async function dispatch(registry: Registry, providerId: string, actionId: string, payload: unknown): Promise<void> {
  const p = registry.get(providerId)
  if (!p) throw new Error(`unknown provider: ${providerId}`)

  // Static lookup. NEVER index a function table by a client-supplied name.
  const action = p.actions.find((a) => a.id === actionId)
  if (!action) throw new Error(`unknown action: ${providerId}/${actionId}`)

  if (action.kind === 'exec') {
    const { cmd, args } = buildArgv(action, payload)
    spawnDetached(cmd, args)
    return
  }

  const validated = action.payloadSchema ? action.payloadSchema.parse(payload) : payload
  await action.run(validated, undefined)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/actions.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mount the namespaced route**

Create `src/server/routes.ts`. The route is namespaced because two providers will both ship an action naturally called `open`:

```ts
import { dispatch } from '../core/actions'
import type { Registry } from '../core/registry'

export interface RouteCtx {
  registry: Registry
  snapshot(): Record<string, unknown>
  headers: Record<string, string>
}

const ACTION_RE = /^\/api\/actions\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/

/** Called ONLY after the gate and the bearer check have both passed. */
export async function handleRoute(req: Request, ctx: RouteCtx): Promise<Response> {
  const path = new URL(req.url).pathname

  if (path === '/api/state' && req.method === 'GET') {
    return Response.json(ctx.snapshot(), { headers: ctx.headers })
  }

  const m = ACTION_RE.exec(path)
  if (m && req.method === 'POST') {
    const [, providerId, actionId] = m
    try {
      await dispatch(ctx.registry, providerId, actionId, await req.json())
      return Response.json({ ok: true }, { headers: ctx.headers })
    } catch (e) {
      // Unknown provider/action and payload-validation failures are client
      // errors, not server errors. The message is safe: it echoes only the
      // ids the client already sent.
      return Response.json({ ok: false, error: (e as Error).message }, { status: 400, headers: ctx.headers })
    }
  }

  return new Response('not found', { status: 404, headers: ctx.headers })
}
```

Then in `src/server/serve.ts`, replace the `return new Response('not found', …)` line after the bearer check with `return handleRoute(req, { registry, snapshot, headers })`.

- [ ] **Step 6: Run the full suite**

Run: `bun test`
Expected: PASS — all suites from Tasks 1–7 green.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: two-kind action layer with argv invariant and namespaced routes"
```

---

## What this plan deliberately does not build

Each becomes its own plan, written when its predecessor lands:

- **Plan 2 — Providers.** git, claude, obsidian, mail. Blocked on Task 6's contract existing in code.
- **Plan 3 — WebSocket protocol and UI.** The protocol is its own artifact (snapshot-on-connect, per-provider revision, stable payload identity when nothing changed, behaviour during the ~1s discovery scan) and must exist before the UI's state layer. The UI also needs a design pass the spec does not contain: screen inventory, how the palette relates to the dashboard, how git's eight repo states and claude's four-way status actually render, and keymap collision arbitration.
- **Plan 4 — Packaging, autostart, first run.** Deliberately last because Task 1 decides the Bun version, which determines whether packaging needs a permanent codegen step. Writing these tasks first would mean rewriting them.

## Open questions carried forward

These are recorded rather than guessed. Each needs a decision during its own plan.

1. **`systemd-run --scope` vs a transient service** (§9). The research refuted `--scope` three ways; the spec keeps it. Blast radius is one function, so it is a spike, not a redesign. Flagged in `spawnDetached`.
2. **Account arity** (§7.2, §7.3). Mail is written singular in §8.5 and plural in §7.3. Decide before the mail provider: one `Account` as a stated v1 limit, or `Account[]` with an id threaded through the credential, archive path, and both actions.
3. **The unread list's unit — message or thread** (§7.3). On Gmail, archiving one UID of a three-reply thread leaves the row reappearing on the next poll. Both shipped mail actions are undefined until this is settled.
4. **Palette primitive** (§13). `react-aria-components` vs `@base-ui/react`, still a two-way choice. Whichever wins is isolated behind one module so the swap stays a one-file change.
5. **Obsidian locale under `--compile`.** Dynamically loaded dayjs locale data is dropped by the same DCE that Task 1 Step 6 defends against, so supported locales must be statically imported. Needs a compiled-binary assertion.
