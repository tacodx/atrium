import { test, expect } from 'bun:test'
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as ts from 'typescript'

// Task 10. These read package.json and .github/workflows/ci.yml by relative
// path: `bun test` runs with the repo root as cwd (test/rungit.test.ts's
// walk('src') relies on the same thing).
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>
  engines: Record<string, string>
}
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')

const STAGES = ['build', 'assert:package', 'test', 'typecheck']

test('verify chains build, the packaging assertion, the test run and typecheck, in that order', () => {
  const verify = pkg.scripts.verify
  expect(typeof verify).toBe('string')
  if (typeof verify !== 'string') throw new Error('scripts.verify is not a string')
  const stages = verify.split('&&').map((s) => s.trim().replace(/^bun run /, ''))
  // Exact equality, not toContain: a missing stage and a reordered chain must
  // both fail. build before assert:package is the part that matters — the
  // packaging assertion consumes ./atrium and ./web-dist, which build produces.
  expect(stages).toEqual(STAGES)
})

test('every stage named in verify is a real script', () => {
  for (const stage of STAGES) expect(Object.keys(pkg.scripts)).toContain(stage)
  // Not hollow: a stage that exists but does nothing passes the line above.
  expect(pkg.scripts.test).toBe('bun test')
  expect(pkg.scripts['assert:package']).toContain('scripts/assert-package.ts')
  // Fix round F3: `"typecheck": "true"` or `"build": "true"` kept every test
  // here green, and verify and CI then passed without running tsc or building
  // anything. Read-only pins; this file may not edit the scripts it checks.
  expect(pkg.scripts.typecheck).toContain('tsc --noEmit')
  // Fix round 2, item C: `… && tsc --noEmit || true` (or `; true`) kept the
  // line above green while `bun run typecheck` printed TS2322 and exited 0.
  // tsc must be the last command and nothing may swallow its exit code: no
  // `||`, no `;`, and no `&` that is not part of `&&`.
  const typecheck = pkg.scripts.typecheck ?? ''
  expect(typecheck.trimEnd()).toMatch(/(^|&&\s*)tsc --noEmit$/)
  expect(typecheck).not.toContain('||')
  expect(typecheck).not.toContain(';')
  expect(typecheck.replaceAll('&&', '')).not.toContain('&')
  expect(pkg.scripts.build).toContain('build:web')
  expect(pkg.scripts.build).toContain('build:server')
  expect(pkg.scripts['build:web']).toContain('vite build')
  expect(pkg.scripts['build:server']).toContain('bun build --compile')
})

// Fix round 3, item B2: the shape rules above explain WHY each script matters,
// in their failure messages; this is what makes them un-evadable. Every round
// of Task 10a found another way to hollow a script past a contains/ends-with
// rule (`vite build || true`, a `pretest` lifecycle hook, …), so the whole
// object is pinned exactly. Every entry is in verify's chain, directly or via
// a sub-script (gen:assets through build:server). Deliberate friction: any
// edit to package.json's scripts fails here until this literal is updated in
// the same commit.
test('package.json scripts are exactly the reviewed verify chain', () => {
  expect(pkg.scripts).toEqual({
    'build:web': 'vite build',
    'gen:assets': 'bun run scripts/gen-assets.ts',
    'build:server': 'bun run gen:assets && bun build --compile --outfile=atrium src/index.ts',
    build: 'bun run build:web && bun run build:server',
    test: 'bun test',
    typecheck: 'bun run scripts/gen-assets.ts --allow-empty && tsc --noEmit',
    'assert:package': 'bun run scripts/assert-package.ts ./atrium ./web-dist',
    verify: 'bun run build && bun run assert:package && bun run test && bun run typecheck',
  })
})

test('CI runs the verify gate, not a bare test run', () => {
  const run = workflow.match(/^\s*-\s*run:\s*bun run verify\s*$/m)
  expect(run).not.toBeNull()
  // Either of these lets a red `verify` pass the job, so presence alone is not
  // enough: the step must also be unconditional and allowed to fail the job.
  expect(workflow).not.toMatch(/continue-on-error/)
  expect(workflow).not.toMatch(/^\s*(-\s*)?if:/m)
})

test('CI runs on its own: push and pull_request triggers under on:', () => {
  // Fix round F4: replacing the triggers with `on: workflow_dispatch:` kept
  // every test green, and CI would then never run unless started by hand.
  // Block form only: the `on:` key at column 0, its triggers indented under it
  // up to the next column-0 key. Any other shape fails closed.
  const block = workflow.match(/^on:[ \t]*\n((?:[ \t]+.*\n|[ \t]*\n)*)/m)
  expect(block).not.toBeNull()
  expect(block![1]).toMatch(/^[ \t]+push:/m)
  expect(block![1]).toMatch(/^[ \t]+pull_request:/m)
})

test('CI pins bun to the engines floor', () => {
  // Line-anchored, so a comment or a suffixed version cannot satisfy it.
  const pin = workflow.match(/^\s*bun-version:\s*(['"]?)(\d+\.\d+\.\d+)\1\s*$/m)
  const floor = (pkg.engines.bun ?? '').match(/^>=\s*(\d+\.\d+\.\d+)$/)
  // The anti-vacuity step: scripts/assert-package.ts records this project
  // already shipping a gate that went vacuous when its regex stopped matching.
  expect(pin).not.toBeNull()
  expect(floor).not.toBeNull()
  expect(pin![2]).toBe(floor![1]!)
  // Fix round F4: a SECOND setup-bun step with a flow-style
  // `with: { bun-version: latest }` after the pinned one passed the
  // line-anchored match above, and the later step wins. Exactly one of each.
  expect(workflow.match(/oven-sh\/setup-bun/g) ?? []).toHaveLength(1)
  expect(workflow.match(/bun-version/g) ?? []).toHaveLength(1)
})

// Fix round 3, item B3: the CI tests above are regexes over text, and each
// round found YAML they never looked at — a step-level `shell: bash {0}` (which
// drops -e/pipefail), a second setup-bun step spelled with YAML escapes
// ("oven-sh\/setup-bun", "bun\x2dversion") that no substring count sees. They
// stay for their messages; the whole file is pinned exactly here. Only a
// trailing newline is normalised. Deliberate friction: any edit to ci.yml
// fails here until this literal is updated in the same commit.
const CI_YML = [
  'name: verify',
  'on:',
  '  push:',
  "    branches: ['**']",
  '  pull_request:',
  'jobs:',
  '  verify:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v5',
  '      - uses: oven-sh/setup-bun@v2',
  '        with:',
  '          bun-version: 1.3.11',
  '      - run: bun install --frozen-lockfile',
  '      - run: bun run verify',
].join('\n')

test('.github/workflows/ci.yml is exactly the reviewed workflow', () => {
  expect(workflow.replace(/\n$/, '')).toBe(CI_YML)
})

// --- Task 10a (7): every server spawn is hermetic. ---
//
// A `serve` child that inherits the developer's HOME scans their real home
// for repos on start, and one that inherits XDG_RUNTIME_DIR / XDG_CONFIG_HOME
// reads their config and overwrites (then, on exit, deletes) the runtime
// files of a server they are actually running. This walks the TypeScript AST
// of every file under test/ and scripts/, finds each Bun.spawn / Bun.spawnSync
// whose argv array literal contains the element 'serve', resolves its `env`
// (inline literal, or a shorthand `env` hoisted into a `const`), and requires
// HOME, XDG_RUNTIME_DIR and XDG_CONFIG_HOME each to be SET, after any spread,
// to a value that traces back to mkdtempSync. An absent HOME is not scoping:
// homedir() falls back to the passwd entry.
//
// Deliberately out of scope: test/serve-providers.test.ts's two children run
// test/fixtures/*-probe.ts, which call startServer in-process with fixture
// providers (no 'serve' argv); the in-process startServer calls throughout
// the suite (they cannot change homedir()); and the `atrium open` children,
// which are not servers. test/rungit.test.ts's first hooks-dir probe writes
// the real runtime dir's nohooks/ on purpose — that is what it tests.

type Site = { where: string; call: ts.CallExpression; sf: ts.SourceFile }

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsFilesUnder(p))
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

function serverSpawns(): Site[] {
  const sites: Site[] = []
  for (const file of [...tsFilesUnder('test'), ...tsFilesUnder('scripts')]) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        /^Bun\.spawn(Sync)?$/.test(n.expression.getText(sf)) &&
        n.arguments[0] !== undefined &&
        ts.isArrayLiteralExpression(n.arguments[0]) &&
        n.arguments[0].elements.some((el) => ts.isStringLiteralLike(el) && el.text === 'serve')
      ) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
        sites.push({ where: `${file}:${line}`, call: n, sf })
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return sites
}

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression
  return e
}

// The nearest `const/let name = …` visible from `from`: the innermost
// enclosing block or file that declares it before `from`.
function declOf(name: string, from: ts.Node): ts.VariableDeclaration | undefined {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue
    let found: ts.VariableDeclaration | undefined
    for (const st of scope.statements) {
      if (st.pos > from.pos) break
      if (!ts.isVariableStatement(st)) continue
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) found = d
      }
    }
    if (found) return found
  }
  return undefined
}

function fnDecl(name: string, sf: ts.SourceFile): ts.FunctionDeclaration | undefined {
  return sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name)
}

// Every `return` of a function body, not descending into nested functions
// (their returns are not this function's).
function returnsOf(body: ts.Node): ts.ReturnStatement[] {
  const out: ts.ReturnStatement[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isReturnStatement(n)) out.push(n)
    if (ts.isFunctionLike(n)) return
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(body, visit)
  return out
}

// Does control never run off the end of this statement? Conservative: only a
// return, a throw, a block ending in one, or an if/else both of whose arms
// end in one. Anything else (loops, switch, try) counts as reachable.
function terminates(st: ts.Statement | undefined): boolean {
  if (st === undefined) return false
  if (ts.isReturnStatement(st) || ts.isThrowStatement(st)) return true
  if (ts.isBlock(st)) return terminates(st.statements.at(-1))
  if (ts.isIfStatement(st)) return st.elseStatement !== undefined && terminates(st.thenStatement) && terminates(st.elseStatement)
  return false
}

// The helper a call invokes, if it is a top-level function declaration in
// this file, with its returned expressions. undefined for anything else, and
// for a helper with a bare `return;`, no return at all, or a body whose end
// is reachable (fix round 2, item D: `if (…) return mkdtempSync(…)` alone
// falls through to undefined, and Bun then omits HOME): fail closed.
function helperReturns(e: ts.Expression, sf: ts.SourceFile): ts.Expression[] | undefined {
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return undefined
  const f = fnDecl(e.expression.text, sf)
  if (f?.body === undefined || !terminates(f.body)) return undefined
  const rets = returnsOf(f.body)
  if (rets.length === 0 || rets.some((r) => r.expression === undefined)) return undefined
  return rets.map((r) => r.expression!)
}

// An identifier chased back through `const x = …` to the expression it holds.
function resolved(expr: ts.Expression, depth = 0): ts.Expression {
  const e = unwrap(expr)
  if (depth > 8 || !ts.isIdentifier(e)) return e
  const init = declOf(e.text, e)?.initializer
  return init === undefined ? e : resolved(init, depth + 1)
}

// Does this expression evaluate to a directory made by mkdtempSync — directly,
// through a variable, through a helper function every one of whose returns is
// such a directory, or through a property of an object such a helper returns
// (config.test.ts's `scratchConfig(...).XDG_CONFIG_HOME`)?
//
// Fix round F2: the property case used to accept ANY property of a helper
// that merely called mkdtempSync somewhere. scratchConfig returns only
// { XDG_CONFIG_HOME }, so `HOME: env.HOME!` was accepted — the value is
// undefined, Bun omits the key, and the child's homedir() is the real home.
// The property name is now resolved against the helper's returned object
// literal(s), and must be set there from a temp-dir value. The direct-call
// case had the same looseness (`HOME: scratchConfig()` passed an object) and
// now requires every return to be a temp dir.
function isTempDir(expr: ts.Expression, sf: ts.SourceFile, depth = 0): boolean {
  if (depth > 8) return false
  const e = unwrap(expr)
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    if (e.expression.text === 'mkdtempSync') return true
    const rets = helperReturns(e, sf)
    return rets !== undefined && rets.every((r) => isTempDir(r, sf, depth + 1))
  }
  if (ts.isIdentifier(e)) {
    const d = declOf(e.text, e)
    return d?.initializer !== undefined && isTempDir(d.initializer, sf, depth + 1)
  }
  if (ts.isPropertyAccessExpression(e)) {
    const rets = helperReturns(resolved(e.expression), sf)
    return rets !== undefined && rets.every((r) => propIsTempDir(unwrap(r), e.name.text, sf, depth + 1))
  }
  return false
}

// `obj` is an object literal that sets `key`, after any spread, to a temp dir.
function propIsTempDir(obj: ts.Expression, key: string, sf: ts.SourceFile, depth: number): boolean {
  if (!ts.isObjectLiteralExpression(obj)) return false
  const props = [...obj.properties]
  const lastSpread = props.reduce((acc, p, i) => (ts.isSpreadAssignment(p) ? i : acc), -1)
  const i = props.findLastIndex((p) => p.name !== undefined && p.name.getText(sf) === key)
  if (i < 0 || i < lastSpread) return false
  const p = props[i]!
  const value = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : undefined
  return value !== undefined && isTempDir(value, sf, depth)
}

function envLiteral(site: Site): ts.ObjectLiteralExpression | undefined {
  const opts = site.call.arguments[1]
  if (opts === undefined || !ts.isObjectLiteralExpression(opts)) return undefined
  for (const p of opts.properties) {
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'env') {
      const init = declOf('env', site.call)?.initializer
      return init !== undefined && ts.isObjectLiteralExpression(unwrap(init)) ? (unwrap(init) as ts.ObjectLiteralExpression) : undefined
    }
    if (ts.isPropertyAssignment(p) && p.name.getText(site.sf) === 'env') {
      let init = unwrap(p.initializer)
      if (ts.isIdentifier(init)) {
        const d = declOf(init.text, site.call)?.initializer
        if (d === undefined) return undefined
        init = unwrap(d)
      }
      return ts.isObjectLiteralExpression(init) ? init : undefined
    }
  }
  return undefined
}

const SCOPED = ['HOME', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME']

function unscopedKeys(site: Site): string[] {
  const env = envLiteral(site)
  if (env === undefined) return ['env (absent or unresolvable)']
  // Absent, overridden by a later spread, or not a temp dir: the same rule a
  // helper's returned object is held to (the last duplicate key wins, as in JS).
  return SCOPED.filter((key) => !propIsTempDir(env, key, site.sf, 0))
}

// The loose half of the cross-check below, one entry per hit, by file: every
// Bun.spawn / Bun.spawnSync call whose source text contains the word `serve`
// anywhere (argv spread from a split string, a `sh -c` command line, …), plus
// every quoted 'serve' string outside such a call (argv built in a variable).
// Fix round 2, item B: this used to count quoted 'serve' literals only, so
// `...'serve --port 7445'.split(' ')` and a `sh -c` template line passed.
function looseServeHits(): string[] {
  const self = join('test', 'verify-gate.test.ts')
  const out: string[] = []
  for (const file of [...tsFilesUnder('test'), ...tsFilesUnder('scripts')]) {
    if (file === self) continue
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && /^Bun\.spawn(Sync)?$/.test(n.expression.getText(sf)) && /\bserve\b/.test(n.getText(sf))) {
        out.push(file)
        return
      }
      if (ts.isStringLiteralLike(n) && n.text === 'serve') out.push(file)
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return out.sort()
}

test('every server spawn scopes HOME, XDG_RUNTIME_DIR and XDG_CONFIG_HOME to a temp dir', () => {
  const sites = serverSpawns()
  // Exactly ten, measured in Task 10a: serve.test.ts x4, config.test.ts x4,
  // repos-pane.test.ts x1, scripts/assert-package.ts x1. A matcher that
  // silently stops matching would otherwise pass with nothing to check.
  expect(sites.map((s) => s.where)).toHaveLength(10)
  // Fix round F2, the anti-vacuity cross-check: the strict matcher above only
  // sees Bun.spawn([<array literal containing 'serve'>], …). A server spawn in
  // any other shape — argv built in a variable, spread from a helper — is
  // invisible to it, and the fixed count stays 10. So also count, deliberately
  // loosely, every Bun.spawn call in test/ and scripts/ whose text says
  // `serve`, and every quoted 'serve' outside one (this file excepted: it
  // names both). A spawn the matcher misses still has to spell serve
  // somewhere, and the two counts then disagree. A stray quoted 'serve' that
  // is not a spawn fails this too: fail closed.
  expect(looseServeHits()).toEqual(sites.map((s) => s.where.replace(/:\d+$/, '')).sort())
  const leaks = sites.flatMap((s) => unscopedKeys(s).map((k) => `${s.where}: ${k}`))
  expect(leaks).toEqual([])
})

// --- Task 10a (8): assert:package tests the binary it spawned. ---
//
// Measured before the fix: with a healthy atrium already on the port and the
// binary replaced by a stub that exits 1, the script printed "packaging ok"
// and exited 0. assert-package.ts has two checks against that, and each is
// pinned by its own test below, each able to fail only for its own reason.
// A third test runs the measured scenario itself and pins only its outcome.
//
// Fix round F1: the original single test (stub exits 1, decoy on the port)
// stayed green with the pid check deleted, because the exit check fired
// first and ITS message also mentions "a foreign listener". So neither test
// asserts that shared substring: each asserts a fragment only its own check
// prints. Measured: deleting only the pid block reddens the first test alone;
// deleting only the exit block reddens the second alone.
//
// A temp web-dist is used, never the repo's: the script renames the directory
// it is given. Ports 7442-7445 are in 10a's range (7440-7449).

const DECOY_HTML = '<!doctype html><link rel="stylesheet" href="/assets/a.css"><script type="module" src="/assets/a.js"></script>'

function scratchDist(prefix: string): { dir: string; dist: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const dist = join(dir, 'web-dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), DECOY_HTML)
  writeFileSync(join(dist, 'assets', 'a.css'), '.p-4{padding:1rem}')
  writeFileSync(join(dist, 'assets', 'a.js'), 'export {}')
  return { dir, dist }
}

async function runAssertPackage(stub: string, dist: string, dir: string, port: number) {
  const proc = Bun.spawn([process.execPath, 'run', 'scripts/assert-package.ts', stub, dist, String(port)], {
    env: { ...process.env, HOME: dir, XDG_RUNTIME_DIR: dir, XDG_CONFIG_HOME: dir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await Promise.race([proc.exited, Bun.sleep(4000).then(() => 'timeout' as const)])
  if (code === 'timeout') {
    proc.kill('SIGKILL')
    throw new Error(`assert-package.ts was still running after 4s on port ${port}`)
  }
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { code, stdout, stderr }
}

// Answers every request assert-package.ts makes the way a correct build would,
// so a run against it that is not refused prints "packaging ok".
function convincingDecoy(port: number) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/healthz') return Response.json({ ok: true, pid: process.pid, assets: 3, execLine: process.execPath })
      if (path === '/assets/a.css') return new Response('.p-4{padding:1rem}', { headers: { 'content-type': 'text/css' } })
      if (path === '/assets/a.js') return new Response('export {}', { headers: { 'content-type': 'text/javascript' } })
      return new Response(DECOY_HTML, { headers: { 'content-type': 'text/html;charset=utf-8' } })
    },
  })
}

test('assert:package refuses a /healthz whose pid is not the binary it spawned', async () => {
  // The pid check, isolated: the stub stays ALIVE and never binds (exec, so
  // the spawned pid is sleep's own; assert-package's `finally` kills it), so
  // the exit check cannot fire. The decoy is deliberately CONVINCING — it
  // answers every request the script makes the way a correct build would —
  // so without the pid check the script really does print "packaging ok".
  const PORT = 7443
  const { dir, dist } = scratchDist('atrium-t10a-pid-')
  const stub = join(dir, 'stub')
  writeFileSync(stub, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })

  const decoy = convincingDecoy(PORT)
  try {
    const { code, stdout, stderr } = await runAssertPackage(stub, dist, dir, PORT)
    expect(stdout).not.toContain('packaging ok')
    expect(code).not.toBe(0)
    // Pid-specific: only the pid check prints this. Never 'foreign listener',
    // which the exit check's message also contains.
    expect(stderr).toContain("is not the spawned binary's pid")
    expect(existsSync(dist)).toBe(true)                        // the renamed dist came back
  } finally {
    decoy.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('assert:package reports a spawned binary that exits before it could be tested', async () => {
  // The exit check, isolated: nothing listens on the port, so there is no
  // /healthz and the pid check cannot fire. Without the exit check the script
  // still fails, but as "never started listening" — this pins the diagnosis.
  const PORT = 7444
  const { dir, dist } = scratchDist('atrium-t10a-exit-')
  const stub = join(dir, 'stub')
  writeFileSync(stub, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  try {
    const { code, stdout, stderr } = await runAssertPackage(stub, dist, dir, PORT)
    expect(stdout).not.toContain('packaging ok')
    expect(code).not.toBe(0)
    expect(stderr).toContain('the spawned binary exited (code 1) before it could be tested')
    expect(existsSync(dist)).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Fix round 3, item B1: this ran an exit-1 stub only. Making the pid check
// stand down once the child had exited, and the exit check ignore exit code 0,
// kept every test green while an exit-0 stub with a convincing decoy printed
// "packaging ok" — a compiled `serve` that falls off the end and exits 0 (the
// bug class test/fixtures/exit-probe.ts exists for) with a dev server on 7373.
// With the pid test (stub alive) and the exit test (no listener), the stub
// space {alive, exits 0, exits non-zero} x {decoy, none} is now covered.
for (const [exitCode, PORT] of [[0, 7445], [1, 7442]] as const) {
  test(`assert:package fails the measured scenario: a stub that exits ${exitCode} while a convincing listener answers`, async () => {
    // Fix round 2, item A. The two tests above isolate one check each, so
    // neither runs what Task 10a actually measured: a dead stub AND a live,
    // convincing listener at once. A mutation that makes each check stand down
    // exactly when the other one's isolated test cannot see it (the pid check
    // only while the child is alive, the exit check only when nothing answered)
    // kept both green while this scenario printed "packaging ok". This test pins
    // the OUTCOME only — non-zero exit, no "packaging ok" — and deliberately no
    // message substring: coupling to a message is how the first vacuity hid.
    const { dir, dist } = scratchDist(`atrium-t10a-both${exitCode}-`)
    const stub = join(dir, 'stub')
    writeFileSync(stub, `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o755 })
    const decoy = convincingDecoy(PORT)
    try {
      const { code, stdout } = await runAssertPackage(stub, dist, dir, PORT)
      expect(stdout).not.toContain('packaging ok')
      expect(code).not.toBe(0)
      expect(existsSync(dist)).toBe(true)
    } finally {
      decoy.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

// --- Plan 3 unit 0a: the suite's only skips are test/tls-live.test.ts's two. ---
//
// tls-live's two tests are opt-in (ATRIUM_LIVE_TLS=1) and skip by design, so
// `bun test` always prints "2 skip". A skip count is the only thing that
// separates that from a test silently switched off — a third skip, or a skip
// in another file, reads identically in the summary — and a deleted
// tls-live.test.ts prints "0 skip" and turns nothing red. So the skip shapes
// are counted per file over every test source, fixtures included, this file
// excepted, and the map is pinned exactly. Each needle is assembled from
// parts so this file's own text would not match even if it were scanned.
//
// Convergence rule, as ADR 0003 (a) states it for the spawn scan: a skip
// shape not in this list and not in the tree (`test.if(false)`, a `.skip`
// reached through an alias) is a known limitation, not a reason for another
// round; a shape present in the tree gets added.
const SKIP_SHAPES = [
  ['test', 'skipIf('],
  ['describe', 'skipIf('],
  ['it', 'skipIf('],
  ['', 'skip('],
  ['test', 'todo('],
  ['describe', 'todo('],
].map(([head, tail]) => `${head}.${tail}`)

function skipCounts(): Record<string, number> {
  const self = join('test', 'verify-gate.test.ts')
  const out: Record<string, number> = {}
  for (const file of tsFilesUnder('test').filter((f) => f.endsWith('.ts') && f !== self)) {
    const src = readFileSync(file, 'utf8')
    const n = SKIP_SHAPES.reduce((acc, shape) => acc + src.split(shape).length - 1, 0)
    if (n > 0) out[file] = n
  }
  return out
}

test('the suite skips exactly the two opt-in live TLS tests, and that file exists', () => {
  const live = join('test', 'tls-live.test.ts')
  expect(existsSync(live)).toBe(true)
  expect(skipCounts()).toEqual({ [live]: 2 })
})
