import type { ProviderStatus, ServerFrame, WireSnapshot } from '../../../src/core/wire'

// External store for useSyncExternalStore with a CACHED snapshot identity.
// No DOM, no React import: importable under `bun test` (tests 14-16).

export interface AtriumState {
  connected: boolean
  /** True once a `snapshot` frame has been applied. Initial value: false. */
  hasSnapshot: boolean
  providers: WireSnapshot          // Record<providerId, ProviderStatus>
}

export interface Store {
  subscribe(cb: () => void): () => void
  getSnapshot(): AtriumState
  apply(frame: ServerFrame): void
  setConnected(connected: boolean): void
}

// There is no separate `health` member: the failure record lives inside each
// provider's ProviderStatus.schedules, which is where Task 9 reads it from.
//
// `hasSnapshot` is load-bearing, not bookkeeping. Task 9's pane distinguishes
// `loading` from `unavailable` on it, and `connected` cannot stand in: a
// socket can be connected with no snapshot applied yet, and disconnected
// after one. It is set in apply's `snapshot` branch and NEVER reset — in
// particular setConnected(false) leaves it alone, or a reconnect flashes the
// pane back to `loading` (test 16, M21).
export function createStore(): Store {
  let state: AtriumState = { connected: false, hasSnapshot: false, providers: {} }
  const subscribers = new Set<() => void>()

  // A new object is built only here, and only when something changed;
  // subscribers are notified exactly once per applied change.
  const commit = (next: AtriumState) => {
    state = next
    for (const cb of subscribers) cb()
  }

  return {
    subscribe(cb) {
      subscribers.add(cb)
      return () => { subscribers.delete(cb) }
    },

    // Returns the cached reference and never allocates. scheduler.snapshot()
    // returns a fresh Object.fromEntries on every call; an unmemoized
    // passthrough into useSyncExternalStore surfaces in React 19 as "Maximum
    // update depth exceeded" — an infinite render loop, not a clear error
    // (test 14, M18).
    getSnapshot: () => state,

    apply(frame) {
      switch (frame.type) {
        case 'ready':
          return                         // connection state is setConnected's job
        case 'snapshot':
          commit({ ...state, hasSnapshot: true, providers: frame.providers })
          return
        case 'update': {
          // Replace ONLY this provider's entry; every other entry keeps its
          // existing object identity (test 15, M19). A status whose `data`
          // key is missing — normal, JSON.stringify drops undefined and the
          // scheduler omits `data` until the first success — is stored with
          // the key still ABSENT, never coerced to null: Task 9's
          // `entry.data === undefined` branch is what distinguishes
          // `unavailable` from `empty`.
          const status: ProviderStatus = frame.status
          commit({ ...state, providers: { ...state.providers, [frame.providerId]: status } })
          return
        }
        case 'error':
          return                         // dropped; a visible error surface is Task 9's job
      }
    },

    setConnected(connected) {
      if (state.connected === connected) return
      commit({ ...state, connected })
    },
  }
}
