import { readdirSync, statSync, renameSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// Resolved to an absolute path: Bun.spawn resolves a relative executable path
// against the CHILD's cwd (set below to a foreign directory), not the caller's,
// so a relative './atrium' here would ENOENT even on a correctly built binary.
const BIN = resolve(process.argv[2] ?? './atrium')
const DIST = process.argv[3] ?? './web-dist'
// Optional third argument: the port. Default 7373, `atrium serve`'s own
// default, so `bun run assert:package` is unchanged. It exists so
// test/verify-gate.test.ts can drive this script against a decoy listener on
// a port of its own without touching 7373.
const PORT = Number(process.argv[4] ?? 7373)
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`PACKAGING ASSERTION FAILED: bad port argument ${process.argv[4]}`)
  process.exit(1)
}
const BASE = `http://127.0.0.1:${PORT}`
const HOST = `127.0.0.1:${PORT}`

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
// HOME and XDG_RUNTIME_DIR are scoped too (Task 10a). With the operator's
// runtime dir inherited, this child OVERWROTE endpoint.json and handoff.json of
// any running atrium (any port) with its own pid and port, and then — killed —
// DELETED both. Measured: the still-running server was left with neither file,
// so `atrium open --print-url` exited 69, "no handoff file found — is the
// server running?", while it was running. HOME because `serve` scans $HOME for
// repos on start; an absent HOME is not scoping (homedir() falls back to passwd).
const home = mkdtempSync(join(tmpdir(), 'atrium-assert-home-'))
const runtimeDir = mkdtempSync(join(tmpdir(), 'atrium-assert-run-'))

// A fatal condition: the checks below cannot be trusted at all, so it is
// reported on its own rather than alongside the per-asset failures. Thrown
// inside the try so the `finally` still runs — process.exit() would skip it.
class Fatal extends Error {}
let fatal: string | undefined
let childStderr = ''
let proc: ReturnType<typeof Bun.spawn> | undefined

try {
  proc = Bun.spawn([BIN, 'serve', '--port', String(PORT)], {
    cwd: '/tmp',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtimeDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const child = proc
  const stderrText = () => new Response(child.stderr as ReadableStream).text()

  // Poll, never sleep a fixed amount: a fixed wait is flaky on a loaded box
  // and slow on an idle one. /healthz needs the `host` header the gate
  // requires (Task 4 wires `checkRequest` in front of every route).
  // The port is always probed at least once, even if the child has already
  // died: a stub that exits instantly must still be reported as "a foreign
  // listener answered", not merely "exited", when something else is there.
  let health: Record<string, unknown> | undefined
  for (let i = 0; i < 100; i++) {
    try {
      health = await (await fetch(`${BASE}/healthz`, { headers: { host: HOST } })).json()
      break
    } catch {
      if (child.exitCode !== null) break
      await Bun.sleep(50)
    }
  }

  // Task 10a: the /healthz above must belong to the child THIS script spawned.
  // Measured before this check existed: with a healthy atrium already on the
  // port and ./atrium replaced by a stub that exits 1, this script printed
  // "packaging ok" and exited 0 — it had tested somebody else's server. Both
  // halves are needed: the pid match catches a foreign listener that answered
  // first, and the exit check catches a child that died before (or after)
  // anyone answered.
  if (health !== undefined && Number(health.pid) !== child.pid) {
    childStderr = await Promise.race([stderrText(), Bun.sleep(500).then(() => '')])
    throw new Fatal(
      `a foreign listener answered on port ${PORT} (its /healthz pid ${String(health.pid)} is not the ` +
      `spawned binary's pid ${child.pid}) — this run tested nothing; free the port and re-run`,
    )
  }
  if (child.exitCode !== null) {
    childStderr = await stderrText()
    throw new Fatal(
      `the spawned binary exited (code ${child.exitCode}) before it could be tested` +
      (health !== undefined ? ` — and a foreign listener answered on port ${PORT}` : ''),
    )
  }
  if (health === undefined) {
    throw new Fatal('binary never started listening within 5s')
  }

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

  const html = await fetch(`${BASE}/`)
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
    const css = await fetch(`${BASE}${cssHref}`)
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
    const js = await fetch(`${BASE}${jsSrc}`)
    const text = await js.text()
    if (js.status !== 200) failures.push(`GET ${jsSrc} returned ${js.status}`)
    // The CSS branch checked its content-type and this one never did.
    if (/javascript|ecmascript/.test(js.headers.get('content-type') ?? '') !== true)
      failures.push(`js content-type was ${js.headers.get('content-type')}`)
    if (text.includes('react-dom.development'))
      failures.push('served JS is a development build')
  }

} catch (e) {
  if (!(e instanceof Fatal)) throw e
  fatal = e.message
} finally {
  // Kill AND reap before removing the child's runtime dir, so the dir is never
  // deleted under a live process and no orphan is left holding the port.
  if (proc) {
    proc.kill()
    await proc.exited
  }
  if (existsSync(parked)) renameSync(parked, DIST)
  for (const d of [configHome, home, runtimeDir]) rmSync(d, { recursive: true, force: true })
}

if (fatal !== undefined) {
  console.error(`PACKAGING ASSERTION FAILED: ${fatal}`)
  if (childStderr) console.error(childStderr)
  process.exit(1)
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
