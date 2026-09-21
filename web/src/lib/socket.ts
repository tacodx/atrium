import type { ClientFrame, ServerFrame } from '../../../src/core/wire'

// WebSocket client: auth frame first, capped jittered reconnect backoff, and
// on a 1008 close clear out and stop. Pure logic behind an injected-deps
// interface — no module-scope access to window, WebSocket, setTimeout or
// Math.random; browserSocketDeps() is the one place the globals are read, and
// only main.tsx calls it (test/client-wire.test.ts tests 12-13).

export const RECONNECT_BASE_MS = 500
export const RECONNECT_CAP_MS = 15_000

export interface SocketDeps {
  url: string
  token(): string | null
  onFrame(frame: ServerFrame): void
  onOpen(): void
  onClose(): void
  onAuthFailure(): void
  createSocket(url: string): WebSocket
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  random(): number
}

export interface SocketHandle { close(): void }

export function connect(deps: SocketDeps): SocketHandle {
  let attempt = 0
  let disposed = false
  let timer: unknown = undefined
  let live: WebSocket | null = null

  const open = () => {
    timer = undefined
    if (disposed) return
    const token = deps.token()
    if (token === null) return            // nothing to authenticate with: do not open at all
    const ws = deps.createSocket(deps.url)
    live = ws

    ws.addEventListener('open', () => {
      // The auth frame is the FIRST frame, always (§8.4; test 12 asserts it).
      const auth: ClientFrame = { type: 'auth', token }
      ws.send(JSON.stringify(auth))
    })

    ws.addEventListener('message', (ev) => {
      let parsed: unknown
      try { parsed = JSON.parse(String((ev as MessageEvent).data)) } catch { return }   // never throw into the handler
      // JSON.parse succeeds on `null`, `42` and `"str"` as well, and onFrame
      // ends at store.apply, which reads frame.type — so a body of `null`
      // raises a TypeError INSIDE the WebSocket event listener, the one thing
      // the parse try/catch exists to prevent. Only a non-null object gets
      // past here (test 19, M24).
      if (typeof parsed !== 'object' || parsed === null) return
      const frame = parsed as ServerFrame
      if (frame.type === 'ready') {
        attempt = 0
        deps.onOpen()
      }
      deps.onFrame(frame)
    })

    ws.addEventListener('close', (ev) => {
      if (live === ws) live = null
      deps.onClose()
      if (disposed) return
      // 1008 is the server's code for a bad first frame AND for the
      // auth-window timeout; both mean the stored token is worthless. Stop
      // permanently — no reconnect, ever (test 12, M16). The caller wires
      // onAuthFailure to clearToken plus a re-render into the signed-out
      // prompt. It does NOT re-read the fragment: acquireToken scrubbed it
      // before redeeming, so there is nothing left to read (ADR 0002 Ruling G).
      if ((ev as CloseEvent).code === 1008) {
        disposed = true
        deps.onAuthFailure()
        return
      }
      // The cap is applied BEFORE the jitter (test 13, M17).
      const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt)
      const sleep = delay * (0.5 + deps.random() * 0.5)
      timer = deps.setTimer(open, sleep)
      attempt++
    })
  }

  open()

  return {
    close() {
      disposed = true
      if (timer !== undefined) { deps.clearTimer(timer); timer = undefined }
      live?.close()
      live = null
    },
  }
}

/** Fills createSocket / setTimer / clearTimer / random from the browser globals. Only main.tsx calls this. */
export function browserSocketDeps(
  partial: Omit<SocketDeps, 'createSocket' | 'setTimer' | 'clearTimer' | 'random'>,
): SocketDeps {
  return {
    ...partial,
    createSocket: (url) => new WebSocket(url),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    random: () => Math.random(),
  }
}
