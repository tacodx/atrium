import { useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { WS_PATH } from '../../src/core/wire'
import { createStore } from './lib/store'
import { acquireToken, clearToken, browserSessionDeps } from './lib/session'
import { postReposAction } from './lib/api'
import { connect, browserSocketDeps } from './lib/socket'
import type { SocketHandle } from './lib/socket'
import { ReposPane, deriveReposPaneState } from './panes/ReposPane'

const store = createStore()

// Tailwind classes only, no style={{}} anywhere: the CSP ships default-src
// 'self' with no style-src and no 'unsafe-inline' (Ruling D), the failure is
// silent, and scripts/assert-package.ts uses fetch — never a browser — so it
// can structurally never observe a CSP violation.
//
// The padding utility on the root element below (the className on the <div>)
// is LOAD-BEARING: it is the one utility class in the tree, its emitted rule
// `padding:calc(var(--spacing) * 4)` is the only thing satisfying
// scripts/assert-package.ts's "served CSS contains a Tailwind utility" check,
// and dropping it fails the release gate with a message blaming a Tailwind
// config problem that does not exist (mutation M20). This comment deliberately
// does NOT spell the class name: Tailwind v4 scans source text, comments
// included, for candidates — measured: with the name spelled here, removing
// the attribute left the built CSS byte-identical and the gate green.

function App() {
  // THE live-state call site; there is no useAtriumState() wrapper hook. The
  // value is AtriumState, so state.hasSnapshot and state.providers are what
  // the pane derives from.
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  // null = token acquisition in progress; false = no token; true = connected or connecting.
  const [authed, setAuthed] = useState<boolean | null>(null)

  useEffect(() => {
    let handle: SocketHandle | undefined
    let cancelled = false
    void acquireToken(browserSessionDeps()).then((token) => {
      if (cancelled) return
      if (token === null) { setAuthed(false); return }
      setAuthed(true)
      handle = connect(browserSocketDeps({
        url: `ws://${location.host}${WS_PATH}`,
        token: () => token,
        onFrame: store.apply,
        onOpen: () => store.setConnected(true),
        onClose: () => store.setConnected(false),
        onAuthFailure: () => { clearToken(browserSessionDeps()); setAuthed(false) },
      }))
    })
    return () => { cancelled = true; handle?.close() }
  }, [])

  // One Date.now() for both the derivation and the render, so a repo's
  // staleness verdict and its rendered age can never disagree by a tick.
  const nowMs = Date.now()
  const paneState = deriveReposPaneState({
    hasSnapshot: state.hasSnapshot,
    providers: state.providers,
    nowMs,
  })

  return (
    <div className="p-4">
      {authed === false
        ? <p>Not signed in. Run <code>atrium open --print-url</code> and open the printed URL.</p>
        : <ReposPane state={paneState} nowMs={nowMs} onAction={postReposAction} />}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
