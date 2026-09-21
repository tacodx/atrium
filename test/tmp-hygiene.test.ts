import { test, expect } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import * as ts from 'typescript'

// Carry-forward P3: a test file that makes temp dirs must remove them.
//
// Measured before the fix: each test file run ALONE in a fresh TMPDIR, 18 of
// 19 left nothing and test/rungit.test.ts left 23. The full suite hid 10 of
// them, because bun 1.3.11 runs every file in ONE process and gitrepo.ts's
// `created` list is module-level, so a later file's afterAll(cleanupFixtures)
// drained rungit's fixtures too. Single-file runs — exactly how mutation runs
// happen — got no such help, which is what built the host's /tmp/atrium-*.
//
// So the check runs the file in a CHILD `bun test` whose TMPDIR is a fresh,
// empty directory, and requires that directory to be empty afterwards.
// XDG_RUNTIME_DIR is scoped too, so rungit's stable per-user hooks dir (which
// src/core/rungit.ts creates on purpose, and is not litter) lands there and
// not in TMPDIR on a host where XDG_RUNTIME_DIR is unset. The child runs
// `bun test` on a file that binds no port.
const FILES: readonly string[] = ['./test/rungit.test.ts']

const ROOT = join(import.meta.dir, '..')

// Anti-vacuity, OUTSIDE the loop: an empty FILES registers no per-file test
// at all, and the file would pass with nothing checked.
test('the hygiene list names the file that leaked', () => {
  expect(FILES).toEqual(['./test/rungit.test.ts'])
})

for (const file of FILES) {
  test(`${file} leaves nothing behind in a fresh TMPDIR`, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'atrium-tmpcheck-'))
    const rd = mkdtempSync(join(tmpdir(), 'atrium-tmpcheck-rd-'))
    const env = { ...process.env, TMPDIR: tmp, XDG_RUNTIME_DIR: rd }
    try {
      // Positive control: this env really does move a child's tmpdir(). Without
      // it, dropping TMPDIR above leaves `tmp` empty and the check below passes.
      const probe = Bun.spawnSync([process.execPath, '-e', 'console.log(require("node:os").tmpdir())'], { env })
      expect(new TextDecoder().decode(probe.stdout).trim()).toBe(tmp)
      const r = Bun.spawnSync([process.execPath, 'test', file], { env, cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
      const out = new TextDecoder().decode(r.stderr)
      // The child really ran the file's tests and they passed: an empty TMPDIR
      // from a child that never started proves nothing.
      expect(r.exitCode).toBe(0)
      expect(Number(/(\d+) pass/.exec(out)?.[1] ?? 0)).toBeGreaterThan(0)
      expect(readdirSync(tmp)).toEqual([])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(rd, { recursive: true, force: true })
    }
  }, 30_000)
}

// The check above only sees tmpdir(). A temp dir made under a hard-coded
// /tmp prefix bypasses TMPDIR entirely and would leak where nothing looks, so
// no test source may hand mkdtemp a /tmp path. Recursive over test/, fixtures
// included. An AST rule, not a text shape: ANY string literal whose text
// starts with /tmp, ANYWHERE inside a mkdtemp/mkdtempSync call's arguments
// (bare or as a member call), is an offender — so `path.join('/tmp', …)`,
// `resolve('/tmp', …)` and a template literal are all seen, where the old
// regex saw only a quoted '/tmp…' or join('/tmp'….
function testSources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...testSources(p))
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const MKDTEMP = new Set(['mkdtemp', 'mkdtempSync'])

/** Every mkdtemp call in `src`, and the ones whose argument subtree holds a /tmp literal (by line). */
function mkdtempScan(file: string, src: string): { calls: number; offenders: string[] } {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
  let calls = 0
  const offenders: string[] = []
  const tmpLiteral = (n: ts.Node): boolean => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text.startsWith('/tmp')) return true
    if (ts.isTemplateExpression(n) && n.head.text.startsWith('/tmp')) return true
    return ts.forEachChild(n, (c) => (tmpLiteral(c) ? true : undefined)) ?? false
  }
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const e = n.expression
      const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : undefined
      if (name !== undefined && MKDTEMP.has(name)) {
        calls += 1
        if (n.arguments.some(tmpLiteral)) offenders.push(`${relative(ROOT, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return { calls, offenders }
}

test('no test source hands mkdtemp a hard-coded /tmp prefix', () => {
  const files = testSources(join(ROOT, 'test'))
  let calls = 0
  const offenders: string[] = []
  for (const f of files) {
    const r = mkdtempScan(f, readFileSync(f, 'utf8'))
    calls += r.calls
    offenders.push(...r.offenders)
  }
  // Anti-vacuity: the walk reached the fixtures and saw real mkdtemp calls.
  expect(files.map((f) => relative(ROOT, f))).toContain('test/fixtures/gitrepo.ts')
  expect(calls).toBeGreaterThan(10)
  expect(offenders).toEqual([])
})

// The scan itself: every spelling of a /tmp prefix inside a mkdtemp call is
// seen, and a tmpdir()-based one, or a /tmp literal outside mkdtemp, is not.
test('the mkdtemp scan sees a /tmp literal at any depth of the arguments', () => {
  const offends = (src: string) => mkdtempScan(join(ROOT, 'test', 'probe.ts'), src).offenders.length
  for (const src of [
    "mkdtempSync('/tmp/atrium-exec-')",
    "mkdtempSync(path.join('/tmp', 'atrium-exec-'))",
    "mkdtempSync(join('/tmp', 'atrium-exec-'))",
    "mkdtempSync(resolve('/tmp', 'a', 'b'))",
    'mkdtempSync(`/tmp/atrium-${n}-`)',
    'mkdtempSync(`/tmp/atrium-`)',
    "fs.mkdtempSync('/tmp' + '/atrium-')",
    "await mkdtemp(join(String('/tmp'), 'x'))",
    "await fsp.mkdtemp('/tmp/x', 'utf8')",
  ]) expect([src, offends(src)]).toEqual([src, 1])
  for (const src of [
    "mkdtempSync(join(tmpdir(), 'atrium-exec-'))",
    "const d = '/tmp/x'",
    "somethingElse(join('/tmp', 'x'))",
  ]) expect([src, offends(src)]).toEqual([src, 0])
})
