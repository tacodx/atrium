// src/core/wire.ts — NO imports. Types and string constants only.
//
// This is the single wire-protocol definition, imported as VALUES by both the
// bun server (src/server/serve.ts) and the React UI (web/src/main.tsx via
// web/src/lib/*). Vite bundles it into the browser build from outside its
// `root: 'web'`, so an `import` of anything here — a `node:` module above all —
// would break the production bundle at release time while the unit suite,
// which runs under bun where `node:` imports resolve fine, stayed green.
// test/ws-protocol.test.ts test 8 is the tripwire for that.

/** Bun pub/sub topic every authenticated socket joins. Zero-state invariant §8.4. */
export const STATE_TOPIC = 'state'
/**
 * Per-provider narrowing topic. It can never collide with STATE_TOPIC by construction, not by
 * any constraint on the id: providerTopic always prefixes `state:`, and `state:<anything>` is
 * never the string `state`. registry.register() enforces no id charset at all — ids are
 * unconstrained there — so nothing else would hold this.
 */
export function providerTopic(providerId: string): string { return `${STATE_TOPIC}:${providerId}` }

export const WS_PATH = '/ws'
export const SESSION_PATH = '/api/session'
export const STATE_PATH = '/api/state'

/**
 * A STRUCTURAL COPY of the scheduler's per-schedule health record
 * (`ScheduleHealth` in src/core/scheduler.ts). It is copied rather than imported
 * because this file must have zero imports — see Test 8 and the Vite note above.
 * `src/server/serve.ts` imports both declarations and carries a one-line compile
 * assertion that keeps them from drifting; if you change either shape, change both.
 */
export interface ScheduleHealth {
  lastSuccessAt: number | null
  consecutiveFailures: number
  lastErrorMessage: string | null
}

/**
 * One provider's status. Structural copy of the scheduler's `ProviderStatus`.
 * `data` is the value `toClient()` produced and is ABSENT until the provider's
 * first successful run. `schedules` is keyed by SCHEDULE NAME, nested under the
 * provider — never a flat `${providerId}:${scheduleName}` key.
 */
export interface ProviderStatus {
  data?: unknown
  schedules: Record<string, ScheduleHealth>
}

/** The body of GET /api/state and the payload of the `snapshot` frame — the same shape, by design. */
export type WireSnapshot = Record<string, ProviderStatus>

// The `auth` variant is not a free choice: createAuth().authenticateSocket
// (src/server/auth.ts) parses the frame and requires exactly
// `msg.type === 'auth' && msg.token === sessionToken`.
//
// There is deliberately no `refresh` / `run` / `dispatch` client frame, now or
// as a "just in case" union member. POST /api/actions/:providerId/:actionId
// already carries the Host/Origin gate, the bearer check and dispatch's static
// allowlist; a WS frame that triggered runNow would run subprocesses through a
// path with none of that. Actions go over HTTP, always.
export type ClientFrame =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; providerId: string }
  | { type: 'unsubscribe'; providerId: string }

export type ServerFrame =
  | { type: 'ready' }
  | { type: 'snapshot'; providers: WireSnapshot }
  | { type: 'update'; providerId: string; status: ProviderStatus }
  | { type: 'error'; code: WireErrorCode; message: string }

export type WireErrorCode = 'bad-frame' | 'unknown-frame-type' | 'unknown-provider' | 'unserializable'

export const WIRE_ERROR_CODES: readonly WireErrorCode[] =
  ['bad-frame', 'unknown-frame-type', 'unknown-provider', 'unserializable']

/**
 * Fixed messages, one per code. A wire error value is ALWAYS one of these — never a caught
 * exception's `.message`, never an echo of client input. Same closed-set rule Task 5 wrote for
 * provider status values.
 */
export const WIRE_ERROR_MESSAGES: Record<WireErrorCode, string> = {
  'bad-frame': 'malformed frame',
  'unknown-frame-type': 'unsupported frame type',
  'unknown-provider': 'unknown provider',
  'unserializable': 'payload could not be serialized',
}
