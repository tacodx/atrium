import { mkdirSync, chmodSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { embeddedFiles } from 'bun'
import { checkRequest } from './gate'
import { createAuth } from './auth'
import { endpointPath, handoffPath, removeEndpointIfOwned, buildExecLine, currentExecContext } from '../core/paths'
import { createRegistry } from '../core/registry'
import { createScheduler } from '../core/scheduler'
import { handleRoute, serveAsset } from './routes'
import type { Provider } from '../core/contract'

const SECURITY_HEADERS = (port: number) => ({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'content-security-policy':
    `default-src 'self'; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; frame-ancestors 'none'`,
})

// The only pre-auth message a socket may legitimately send is a small JSON
// {type:'auth', token} frame. Bounding it here means an unauthenticated
// connection can never make the process buffer or attempt to parse an
// arbitrarily large payload (controller-added requirement, Task 4).
const WS_MAX_PAYLOAD_BYTES = 1024 * 1024 // 1 MiB

// Spec §8.4: the first frame must arrive within this window or the socket is
// closed 1008. The brief's sample websocket.message handler only closes on a
// *wrong* first frame; a socket that never sends anything would otherwise sit
// open, unauthenticated, forever. That gap is exactly what a previous
// reviewer flagged as unverifiable — this timer is what makes "never sent a
// frame" behave the same as "sent a bad frame."
const DEFAULT_WS_AUTH_TIMEOUT_MS = 2000

/**
 * The boot handoff's TTL. §8.3's ~60s window exists because a handoff
 * delivered in a URL is briefly visible in /proc/<pid>/cmdline, which is
 * world-readable with no hidepid. This handoff is never in a URL until the
 * user's own `atrium open --print-url` puts it there: it is written 0600
 * into the 0700 runtime directory. A 60s window instead means a
 * systemd-started server's handoff is dead before the user reaches a
 * browser. Accepted residual, owner-ruled.
 *
 * Bounded above by the process anyway: `handoffs` is an in-memory Map inside
 * createAuth's closure, so the handoff dies with the server whatever this
 * says. Seven days is a ceiling on a single server's uptime window, not a
 * credential that outlives it.
 */
export const BOOT_HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000   // 604_800_000 — 7 days

interface WsState { authed: boolean; authTimer?: ReturnType<typeof setTimeout> }

export interface ServeConfig {
  port: number
  /** Overrides the spec's 2s WS-auth window; used by tests to avoid a real-time wait. */
  wsAuthTimeoutMs?: number
  /** Overrides process.env for endpoint.json placement; defaults to the real environment. */
  env?: NodeJS.ProcessEnv
  /** Registered in array order, BEFORE the port binds. */
  providers?: Provider<any, any>[]
  /** Raw config record keyed by provider id; handed straight to createScheduler. */
  config?: Record<string, unknown>
}

export async function startServer(cfg: ServeConfig) {
  const auth = createAuth()
  // Providers are registered HERE, ABOVE the Bun.serve try/catch, and the
  // position is load-bearing: registry.register throws on a duplicate provider
  // id, a duplicate action id and an invalid schedule, and that throw has to
  // escape startServer as a rejected promise with the port never bound and
  // endpoint.json never written. It is deliberately outside the try below,
  // which exists only to map EADDRINUSE to exit 78.
  //
  // Everything downstream of the registry was already live before this task:
  // /api/state and POST /api/actions/:providerId/:actionId serve whatever this
  // registry holds, and a `call` action's cfg is read straight out of the
  // scheduler's config. So what changes here is how the registry gets FILLED,
  // not the routes.
  const registry = createRegistry()
  for (const p of cfg.providers ?? []) registry.register(p)
  const scheduler = createScheduler(registry, { config: cfg.config ?? {} })
  const nonce = crypto.randomUUID()
  const startedAt = new Date().toISOString()
  const headers = SECURITY_HEADERS(cfg.port)
  const wsAuthTimeoutMs = cfg.wsAuthTimeoutMs ?? DEFAULT_WS_AUTH_TIMEOUT_MS
  // Task 4 review finding 4: proves the /$bunfs/ detection end to end. Computed
  // once — the exec context cannot change during the process's lifetime — and
  // exposed on /healthz so the packaging assertion can confirm, against the
  // real compiled binary, that this is a real on-disk path with no $bunfs
  // segment (the failure mode this is guarding against is a systemd unit
  // pointing at a path that doesn't exist).
  const execLine = buildExecLine(currentExecContext())

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve<WsState>({
      hostname: '127.0.0.1',
      port: cfg.port,
      development: false,
      error: () => new Response('internal error', { status: 500, headers }),

      async fetch(req, srv) {
        const gate = checkRequest(req, cfg.port)
        if (!gate.ok) return new Response('forbidden', { status: gate.status, headers })

        const path = new URL(req.url).pathname

        // Unauthenticated, but gated. The launcher needs something to poll and
        // the token-gated routes cannot serve that purpose (§9).
        if (path === '/healthz') {
          return Response.json(
            { ok: true, pid: process.pid, nonce, assets: embeddedFiles.length, execLine },
            { headers },
          )
        }

        if (path === '/ws') {
          // Origin is validated above; the first frame carries the token (§8.4).
          return srv.upgrade(req, { data: { authed: false } })
            ? undefined
            : new Response('expected websocket', { status: 426, headers })
        }

        // Static assets, PRE-AUTH and deliberately so: the page itself must
        // load before any token exists, since the handoff token arrives in
        // the URL fragment and is read by the page's own JavaScript. Still
        // behind the Host/Origin gate above. Manifest-only — see routes.ts.
        const asset = await serveAsset(path, headers)
        if (asset) return asset

        // Handoff -> session token. Position is load-bearing in both directions:
        // ABOVE the bearer check, because a client redeeming a handoff has no
        // bearer yet — below it, every request here is a 401 and the route is
        // unreachable. BELOW serveAsset, so the build-time asset manifest keeps
        // first refusal exactly as it does today (that manifest is generated from
        // the real vite dist tree and contains no /api/* key, so nothing can
        // actually shadow this).
        //
        // POST, never GET, for two independent reasons: gate.ts rejects a
        // non-read method that arrives with no Origin header, and §8.3 forbids
        // the token travelling in a URL, where it lands in logs and shell
        // history. A cross-origin form POST is a "simple request" that skips
        // preflight, but it still carries Origin (and Sec-Fetch-Site), both of
        // which the gate above already rejected.
        if (path === '/api/session' && req.method === 'POST') {
          let handoff: unknown
          try {
            handoff = ((await req.json()) as { handoff?: unknown } | null)?.handoff
          } catch {
            handoff = undefined                       // malformed body is just a miss
          }
          if (typeof handoff !== 'string' || !auth.consumeHandoff(handoff, Date.now())) {
            // Byte-identical to the bearer 401 below. Unknown, malformed,
            // expired and already-redeemed are ONE answer: no oracle.
            return new Response('unauthorized', { status: 401, headers })
          }
          // `headers` carries cache-control: no-store, which is why the success
          // response must use it — this body is the bearer.
          return Response.json({ token: auth.sessionToken }, { headers })
        }

        if (!auth.verifyBearer(req)) {
          return new Response('unauthorized', { status: 401, headers })
        }

        return handleRoute(req, {
          registry,
          snapshot: scheduler.snapshot,
          configFor: scheduler.configFor,
          headers,
        })
      },

      websocket: {
        maxPayloadLength: WS_MAX_PAYLOAD_BYTES,

        open(ws) {
          const state = ws.data
          state.authTimer = setTimeout(() => {
            if (!state.authed) ws.close(1008, 'auth timeout')
          }, wsAuthTimeoutMs)
        },

        message(ws, raw) {
          const state = ws.data
          if (!state.authed) {
            // ZERO state has been sent before this point. That property is the
            // single control that makes a forgeable Origin survivable (§8.4).
            if (!auth.authenticateSocket(String(raw))) return ws.close(1008, 'auth')
            state.authed = true
            clearTimeout(state.authTimer)
            return
          }
          // Provider subscriptions land here in a later plan.
        },

        close(ws) {
          clearTimeout(ws.data.authTimer)
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

  const env = cfg.env ?? process.env
  const ep = endpointPath(env)
  const epDir = dirname(ep)
  mkdirSync(epDir, { recursive: true, mode: 0o700 })
  // Task 4 review finding 3: `mkdirSync`'s `mode` only applies when it actually
  // creates the directory — an already-existing directory (a later task's own
  // config-dir setup, once one exists) keeps whatever mode it already had.
  // Spec §8.5 requires this directory be 0700 unconditionally, so assert it
  // every startup rather than only on first creation.
  chmodSync(epDir, 0o700)

  // NOTE (Task 4 review finding 2, deliberately not fully fixed here): two
  // concurrent instances share this one path — v1 assumes a single instance,
  // so instance B starting on a different port still overwrites instance A's
  // file. That overwrite-on-start gap is carried forward to a later plan
  // (`atrium open` is the eventual consumer that cares). What IS fixed is the
  // destructive half: shutdown below only ever removes a file that still
  // names *this* pid, so B's shutdown can no longer delete a file that by
  // then describes A.
  writeFileSync(ep, JSON.stringify({ url: String(server.url), pid: process.pid, nonce, startedAt }), { mode: 0o600 })

  // The ONE mint site. There is deliberately no /api/handoff and no
  // `atrium rotate-token`: an unauthenticated mint route would hand the session
  // token to every local process, and a bearer-gated one is useless to a client
  // that has no bearer. One boot handoff per server start, single-use.
  //
  // NEVER console.log/console.error the handoff or the session token from here.
  // Under systemd that copies a live credential into the persistent journal.
  // The only process that ever prints the handoff is the user's own
  // `atrium open --print-url` (src/index.ts).
  const hp = handoffPath(env)
  const bootHandoff = auth.mintHandoff(Date.now(), BOOT_HANDOFF_TTL_MS)
  writeFileSync(hp, JSON.stringify({ token: bootHandoff, port: cfg.port, pid: process.pid }), { mode: 0o600 })
  // writeFileSync's `mode` is only applied when it CREATES the file.
  // Measured on bun 1.3.11: rewriting an existing 0644 file with { mode: 0o600 }
  // leaves it 0644. This file holds a long-lived credential, so assert the mode
  // every startup — the same reason epDir's 0700 is chmod'd rather than assumed.
  chmodSync(hp, 0o600)

  // Both files, same pid-ownership rule: removeEndpointIfOwned reads only the
  // recorded `.pid`, so it is as correct for handoff.json as for endpoint.json.
  // Extending `cleanup` alone covers every exit path — `shutdown`, both signal
  // handlers and the server.stop wrapper all funnel through it.
  const cleanup = () => {
    removeEndpointIfOwned(ep, process.pid)
    removeEndpointIfOwned(hp, process.pid)
  }
  // INVARIANT: scheduler.stop() runs BEFORE the server closes, everywhere this
  // is used. The post-await abort guard in runNow is the only thing suppressing
  // a notification after the server has gone away, so the scheduler has to be
  // quiesced first — a listener firing into a closed server is a publish on a
  // dead socket. (Not observable from this task: both calls are synchronous and
  // land in the same tick, so nothing can resume between them. It becomes
  // falsifiable once an onUpdate -> publish wire exists.)
  const shutdown = () => { scheduler.stop(); cleanup() }
  // Left as the bare cleanup on purpose: this is a last-resort unlink on a
  // process that is already going away, not a lifecycle hook.
  process.on('exit', cleanup)
  process.on('SIGTERM', () => { shutdown(); process.exit(0) })
  process.on('SIGINT', () => { shutdown(); process.exit(0) })

  // Also clean up on an explicit .stop() that doesn't exit the process — e.g.
  // every test in this suite. `process.on('exit', ...)` alone is not
  // sufficient: measured empirically, bun's test runner does not emit a
  // Node-style 'exit' event when a test file finishes, so relying on it only
  // left a stale endpoint.json under $XDG_RUNTIME_DIR after every `bun test`.
  const originalStop = server.stop.bind(server)
  server.stop = ((closeActiveConnections?: boolean) => {
    shutdown()
    return originalStop(closeActiveConnections)
  }) as typeof server.stop

  // Deliberately NOT awaited: a provider's runOnStart discovery pass must not
  // delay startServer's resolution — endpoint.json is already written and
  // /healthz is already answering. start() is specified never to reject, so
  // the .catch is defence in depth against a future edit inside it rather than
  // a live failure path.
  // A later task inserts scheduler.onUpdate(...) -> server.publish here,
  // BEFORE this line.
  void scheduler.start().catch(() => {})

  return server
}
