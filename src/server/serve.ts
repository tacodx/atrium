import { mkdirSync, chmodSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { embeddedFiles } from 'bun'
import { checkRequest } from './gate'
import { createAuth } from './auth'
import { endpointPath, removeEndpointIfOwned, buildExecLine, currentExecContext } from '../core/paths'
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

  const cleanup = () => { removeEndpointIfOwned(ep, process.pid) }
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
