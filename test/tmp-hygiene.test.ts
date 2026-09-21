import { test, expect } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

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
// no test source may pass mkdtemp a quoted /tmp path. Recursive over test/,
// fixtures included.
function testSources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...testSources(p))
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

test('no test source hands mkdtemp a hard-coded /tmp prefix', () => {
  const files = testSources(join(ROOT, 'test'))
  const HARDCODED = /mkdtemp(?:Sync)?\(\s*(?:join\(\s*)?(['"`])\/tmp(?:\/|\1)/
  let calls = 0
  const offenders: string[] = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    calls += (src.match(/mkdtemp(?:Sync)?\(/g) ?? []).length
    if (HARDCODED.test(src)) offenders.push(relative(ROOT, f))
  }
  // Anti-vacuity: the walk reached the fixtures and saw real mkdtemp calls.
  expect(files.map((f) => relative(ROOT, f))).toContain('test/fixtures/gitrepo.ts')
  expect(calls).toBeGreaterThan(10)
  expect(offenders).toEqual([])
})
