import { readdirSync, statSync, renameSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// Resolved to an absolute path: Bun.spawn resolves a relative executable path
// against the CHILD's cwd (set below to a foreign directory), not the caller's,
// so a relative './atrium' here would ENOENT even on a correctly built binary.
const BIN = resolve(process.argv[2] ?? './atrium')
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

// src/server/routes.ts (Task 7) serves the built SPA from the generated
// ASSET_PATHS manifest, pre-auth, manifest-only. Both checks below are hard
// failures: a zero (or short) embedded-asset count means DCE dropped the
// manifest, and a non-200 `GET /` means the route isn't actually wired.
const failures: string[] = []
let embedded = 0
let cssHref: string | undefined
let jsSrc: string | undefined

// XDG_CONFIG_HOME is scoped to an empty scratch dir, mirroring
// test/serve.test.ts's `emptyConfigHome` helper. As of Task 3 the binary loads
// $XDG_CONFIG_HOME/atrium/config.json on `serve`, and this spawn passed no
// `env`, so the child inherited the OPERATOR'S real config. That is latent
// today — ~/.config/atrium does not exist, so loadConfig takes its ENOENT path
// — and goes live at Task 7's strict `repos` schema: one schema-rejected key in
// a personal config file would make the binary exit 78 before binding, and this
// script would then report "binary never started listening within 5s",
// pointing at DCE and route wiring rather than at the operator's dotfile.
const configHome = mkdtempSync(join(tmpdir(), 'atrium-assert-config-'))

try {
  const proc = Bun.spawn([BIN, 'serve', '--port', '7373'], {
    cwd: '/tmp',
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
    stdout: 'pipe',
    stderr: 'pipe',
  })

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
    rmSync(configHome, { recursive: true, force: true })
    process.exit(1)
  }

  const health = await (
    await fetch('http://127.0.0.1:7373/healthz', { headers: { host: '127.0.0.1:7373' } })
  ).json()
  embedded = Number(health.assets)
  if (embedded < expected) {
    failures.push(`embedded ${embedded} < dist ${expected} — DCE dropped assets`)
  }

  // Review finding 4: proves src/core/paths.ts's /$bunfs/ detection end to
  // end, against the real compiled binary — not just the unit-tested pure
  // predicate. The failure mode this guards is silent and severe: a wrong
  // detection produces a systemd ExecStart pointing at a path that does not
  // exist, and nothing about that fails loudly at install time.
  const execLine = String(health.execLine)
  if (execLine.includes('$bunfs')) failures.push(`execLine contains a $bunfs path: ${execLine}`)
  else if (!execLine.startsWith('/')) failures.push(`execLine is not an absolute path: ${execLine}`)
  else if (!existsSync(execLine)) failures.push(`execLine does not exist on disk: ${execLine}`)

  const html = await fetch('http://127.0.0.1:7373/')
  if (html.status !== 200) {
    failures.push(`GET / returned ${html.status}`)
  }

  const body = await html.text()
  cssHref = body.match(/href="([^"]+\.css)"/)?.[1]
  jsSrc = body.match(/src="([^"]+\.js)"/)?.[1]

  // Spec §10 requires GET / AND one hashed JS and CSS asset to return 200 with
  // the right content-type. These checks used to sit inside `if (cssHref)` /
  // `if (jsSrc)`, so a regex that failed to match made the requirement VANISH
  // and the script still printed "packaging ok" — measured against a plausible
  // index.html emitting <link rel="modulepreload" href="...js"> instead of
  // <script src="...js">. This project has already shipped one Critical (the
  // diff.external regression) whose root cause was a check passing for the
  // wrong reason; a release gate that can go vacuous is worse than no gate,
  // because it is believed. An unmatched href/src is now a failure.
  if (!cssHref) {
    failures.push('no hashed CSS asset referenced from index.html (href="....css" did not match)')
  } else {
    const css = await fetch(`http://127.0.0.1:7373${cssHref}`)
    const text = await css.text()
    if (css.status !== 200) failures.push(`GET ${cssHref} returned ${css.status}`)
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

  if (!jsSrc) {
    failures.push('no hashed JS asset referenced from index.html (src="....js" did not match)')
  } else {
    const js = await fetch(`http://127.0.0.1:7373${jsSrc}`)
    const text = await js.text()
    if (js.status !== 200) failures.push(`GET ${jsSrc} returned ${js.status}`)
    // The CSS branch checked its content-type and this one never did.
    if (/javascript|ecmascript/.test(js.headers.get('content-type') ?? '') !== true)
      failures.push(`js content-type was ${js.headers.get('content-type')}`)
    if (text.includes('react-dom.development'))
      failures.push('served JS is a development build')
  }

  proc.kill()
} finally {
  if (existsSync(parked)) renameSync(parked, DIST)
  rmSync(configHome, { recursive: true, force: true })
}

if (failures.length) {
  console.error('PACKAGING ASSERTION FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(
  `packaging ok: ${embedded} of ${expected} assets embedded, served from a foreign cwd; ` +
  `hashed CSS (${cssHref}) and JS (${jsSrc}) both served with the right content-type`,
)
