import { readdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Resolved to an absolute path: Bun.spawn resolves a relative executable path
// against the CHILD's cwd (set below to a foreign directory), not the caller's,
// so a relative './atrium' here would ENOENT even on a correctly built binary.
const BIN = resolve(process.argv[2] ?? './atrium')
const DIST = process.argv[3] ?? './web-dist'

// Explicit, unmissable opt-out. DEFAULT IS STRICT: with this unset, a zero
// asset-embed count or a non-200 `GET /` is a hard failure and exits non-zero,
// exactly as this assertion has always worked. Set only at the call site that
// knows why it's safe to relax right now — Task 4's own verification run does
// this explicitly (see task-4-report.md), because src/index.ts genuinely does
// not reference the generated asset manifest yet and src/server/routes.ts
// (Task 7) is what wires real asset serving in. A warning nobody re-hardens
// is exactly how a control like this dies quietly — its failure mode (HTTP
// 200 serving a blank page, or assets silently dropped by dead-code
// elimination) does not announce itself — so this stays a hard failure by
// default and the relaxation must be named explicitly by whoever invokes it.
// Task 7 is expected to retire the need for this flag entirely.
const ALLOW_UNWIRED_ASSETS = process.env.ATRIUM_ALLOW_UNWIRED_ASSETS === '1'

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

// NOTE (Task 4, measured): src/index.ts's `serve` command is the real server
// (src/server/serve.ts) — it has no static-asset route yet. Serving the built
// SPA is src/server/routes.ts's job (Task 7); until that lands, nothing in
// this entry point's import graph references the generated ASSET_PATHS
// manifest, so `bun build --compile` drops it via dead-code elimination and
// the embedded count is genuinely 0, and `GET /` falls through to the bearer
// check (401) since there is no route for it. The two checks below that
// depend on that wiring (asset-embed count, GET /) are hard failures UNLESS
// ATRIUM_ALLOW_UNWIRED_ASSETS=1 is set (see above) — Task 7 is the
// re-hardening point: once routes.ts actually serves these paths, both checks
// pass on their own with no script edit needed, opt-out or not.
let failures: string[] = []
let relaxed: string[] = []
let embedded = 0

if (ALLOW_UNWIRED_ASSETS) {
  console.warn('RELAXED: asset embedding + GET / unchecked (no routes.ts yet; Task 7 re-hardens)')
}
try {
  const proc = Bun.spawn([BIN, 'serve', '--port', '7373'], { cwd: '/tmp', stdout: 'pipe', stderr: 'pipe' })

  // Poll, never sleep a fixed amount: a fixed wait is flaky on a loaded box
  // and slow on an idle one. /healthz needs the `host` header the gate
  // requires (Task 4 wires `checkRequest` in front of every route).
  let up = false
  for (let i = 0; i < 100; i++) {
    try {
      await fetch('http://127.0.0.1:7373/healthz', { headers: { host: '127.0.0.1:7373' } })
      up = true; break
    } catch { await Bun.sleep(50) }
  }
  if (!up) {
    console.error('PACKAGING ASSERTION FAILED: binary never started listening within 5s')
    console.error(await new Response(proc.stderr).text())
    // process.exit() does not run the `finally` below, so restore the parked
    // dist directory and kill the child here too, or a failed run leaves
    // web-dist permanently renamed and the child process orphaned.
    proc.kill()
    if (existsSync(parked)) renameSync(parked, DIST)
    process.exit(1)
  }

  const health = await (
    await fetch('http://127.0.0.1:7373/healthz', { headers: { host: '127.0.0.1:7373' } })
  ).json()
  embedded = Number(health.assets)
  if (embedded < expected) {
    const msg = `embedded ${embedded} < dist ${expected} — DCE dropped assets`
    if (ALLOW_UNWIRED_ASSETS) relaxed.push(msg); else failures.push(msg)
  }

  // Review finding 4: proves src/core/paths.ts's /$bunfs/ detection end to
  // end, against the real compiled binary — not just the unit-tested pure
  // predicate. The failure mode this guards is silent and severe: a wrong
  // detection produces a systemd ExecStart pointing at a path that does not
  // exist, and nothing about that fails loudly at install time. This is a
  // hard failure regardless of ATRIUM_ALLOW_UNWIRED_ASSETS — it has nothing
  // to do with static asset serving.
  const execLine = String(health.execLine)
  if (execLine.includes('$bunfs')) failures.push(`execLine contains a $bunfs path: ${execLine}`)
  else if (!execLine.startsWith('/')) failures.push(`execLine is not an absolute path: ${execLine}`)
  else if (!existsSync(execLine)) failures.push(`execLine does not exist on disk: ${execLine}`)

  const html = await fetch('http://127.0.0.1:7373/')
  if (html.status !== 200) {
    const msg = `GET / returned ${html.status}`
    if (ALLOW_UNWIRED_ASSETS) relaxed.push(msg); else failures.push(msg)
  }

  const body = await html.text()
  const cssHref = body.match(/href="([^"]+\.css)"/)?.[1]
  const jsSrc = body.match(/src="([^"]+\.js)"/)?.[1]

  if (cssHref) {
    const css = await fetch(`http://127.0.0.1:7373${cssHref}`)
    const text = await css.text()
    if (css.headers.get('content-type')?.includes('text/css') !== true)
      failures.push(`css content-type was ${css.headers.get('content-type')}`)
    // The canary element uses p-4; if Tailwind emitted nothing this is absent
    // while everything else still returns 200. Spec §10.
    // NOTE (measured against tailwindcss@4.3.3, deviation from the brief's literal
    // check): v4's spacing scale emits `padding:calc(var(--spacing) * 4)`, not a
    // literal `padding:1rem`. The literal checks are kept as a fallback in case a
    // future version reverts to fixed values; the calc() form is the actual v4.3.3
    // output and is what proves the utility was really generated.
    const hasUtility =
      text.includes('padding:1rem') ||
      text.includes('padding: 1rem') ||
      /padding:\s*calc\(var\(--spacing\)\s*\*\s*4\)/.test(text)
    if (!hasUtility)
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

for (const r of relaxed) console.warn(`  - ${r}`)

if (failures.length) {
  console.error('PACKAGING ASSERTION FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`packaging ok: ${embedded} of ${expected} assets embedded, served from a foreign cwd`)
