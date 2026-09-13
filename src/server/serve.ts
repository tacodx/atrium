import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { embeddedFiles } from 'bun'
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
}

export async function startServer(cfg: ServeConfig) {
  const auth = createAuth()
  const nonce = crypto.randomUUID()
  const headers = SECURITY_HEADERS(cfg.port)
  const wsAuthTimeoutMs = cfg.wsAuthTimeoutMs ?? DEFAULT_WS_AUTH_TIMEOUT_MS

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve<WsState>({
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
          return Response.json(
            { ok: true, pid: process.pid, nonce, assets: embeddedFiles.length },
            { headers },
          )
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
  mkdirSync(dirname(ep), { recursive: true, mode: 0o700 })
  writeFileSync(ep, JSON.stringify({ url: String(server.url), pid: process.pid, nonce }), { mode: 0o600 })

  const cleanup = () => { try { unlinkSync(ep) } catch {} }
  process.on('exit', cleanup)
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
  process.on('SIGINT', () => { cleanup(); process.exit(0) })

  // Also clean up on an explicit .stop() that doesn't exit the process — e.g.
  // every test in this suite. `process.on('exit', ...)` alone is not
  // sufficient: measured empirically, bun's test runner does not emit a
  // Node-style 'exit' event when a test file finishes, so relying on it only
  // left a stale endpoint.json under $XDG_RUNTIME_DIR after every `bun test`.
  const originalStop = server.stop.bind(server)
  server.stop = ((closeActiveConnections?: boolean) => {
    cleanup()
    return originalStop(closeActiveConnections)
  }) as typeof server.stop

  return server
}
