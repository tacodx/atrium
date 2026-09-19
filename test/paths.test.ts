import { test, expect, describe } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { buildExecLine, isCompiledPath, removeEndpointIfOwned, endpointPath, handoffPath } from '../src/core/paths'

test('a compiled binary uses its own absolute path', () => {
  const line = buildExecLine({ isCompiled: true, execPath: '/usr/local/bin/atrium', mainPath: '/$bunfs/root/index.ts' })
  expect(line).toBe('/usr/local/bin/atrium')
  expect(line).not.toContain('$bunfs')
})

test('a script run uses the runtime plus the script path', () => {
  const line = buildExecLine({ isCompiled: false, execPath: '/home/u/.bun/bin/bun', mainPath: '/home/u/atrium/src/index.ts' })
  expect(line).toBe('/home/u/.bun/bin/bun /home/u/atrium/src/index.ts')
})

test('never emits a /$bunfs path in either branch', () => {
  for (const isCompiled of [true, false]) {
    const line = buildExecLine({ isCompiled, execPath: '/real/path', mainPath: '/$bunfs/root/x.ts' })
    if (isCompiled) expect(line).not.toContain('$bunfs')
  }
})

// Review finding 4: the actual /$bunfs/ detection is the part that breaks —
// inside a compiled binary import.meta.path is a /$bunfs/root/… path that
// does not exist on disk — and it had no test of its own. buildExecLine's
// pure logic above was already covered; this is the predicate it composes.
describe('isCompiledPath', () => {
  test('recognizes a /$bunfs/ path as compiled', () => {
    expect(isCompiledPath('/$bunfs/root/index.ts')).toBe(true)
  })

  test('recognizes an ordinary absolute path as not compiled', () => {
    expect(isCompiledPath('/home/u/atrium/src/index.ts')).toBe(false)
  })
})

// The boot handoff must land in the ONE directory startServer chmods to 0700
// on every boot. `~/.config` itself is 0755 (§8.5), so "next to endpoint.json"
// is not a tidiness preference — it is the whole of the file's protection.
//
// Synthetic env objects only: the plan forbids any assertion derived from
// $HOME, and the mutation the FIRST of these guards against (`handoffPath`
// ignoring XDG_RUNTIME_DIR and resolving through configDir) would otherwise
// make the expected value depend on the developer's home directory.
//
// Singular on purpose. Measured under that mutation: `bun test
// test/paths.test.ts` is 10 pass / 1 fail and the sibling test below is the
// only red one. The fallback test supplies no XDG_RUNTIME_DIR, so the mutated
// expression is exactly the one it already expects — it stays GREEN, and it
// therefore names a mutation of its own.
describe('handoffPath', () => {
  test('handoffPath and endpointPath are siblings in the runtime directory', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' } as NodeJS.ProcessEnv
    expect(handoffPath(env)).toBe('/run/user/1000/atrium/handoff.json')
    // MUTATION: `handoffPath` returning join(configDir(env), 'handoff.json')
    // unconditionally turns both of these red.
    expect(dirname(handoffPath(env))).toBe(dirname(endpointPath(env)))
  })

  test('handoffPath falls back to the config dir when XDG_RUNTIME_DIR is unset', () => {
    // $XDG_RUNTIME_DIR does not exist on macOS or Windows. MUTATION: drop the
    // fallback — `runtimeDir` returning join(env.XDG_RUNTIME_DIR!, 'atrium'),
    // the tidy-up TypeScript itself nudges you toward and that a Linux-only CI
    // never notices, because the variable is always set there. Measured,
    // scoped: 10 pass / 1 fail, `TypeError: The "paths[0]" property must be of
    // type string, got undefined`.
    //
    // Two config tests reach the same branch through startServer (their env is
    // XDG_CONFIG_HOME only) and so redden on a mutation that THROWS — but they
    // assert nothing about the resolved path, so a fallback quietly rewritten
    // to some other valid directory would leave them green. This is the only
    // test that pins the VALUE in the unset case.
    const env = { XDG_CONFIG_HOME: '/home/u/.config' } as NodeJS.ProcessEnv
    expect(handoffPath(env)).toBe('/home/u/.config/atrium/handoff.json')
    expect(dirname(handoffPath(env))).toBe(dirname(endpointPath(env)))
  })
})

// Review finding 2: two concurrent instances share one endpoint.json path.
// The destructive half of that (a shutting-down instance deleting a file that
// by then describes a *different* process) must be impossible. These tests
// exercise removeEndpointIfOwned directly, in a scratch directory — never a
// path derived from the developer's $HOME.
describe('removeEndpointIfOwned', () => {
  function scratchFile(contents: unknown): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'atrium-endpoint-'))
    const file = join(dir, 'endpoint.json')
    writeFileSync(file, JSON.stringify(contents))
    return { dir, file }
  }

  test('removes the file when the recorded pid matches', () => {
    const { dir, file } = scratchFile({ url: 'http://127.0.0.1:7373/', pid: 4242, nonce: 'n' })
    try {
      expect(removeEndpointIfOwned(file, 4242)).toBe(true)
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('leaves the file alone when the recorded pid does NOT match — the destructive case', () => {
    const { dir, file } = scratchFile({ url: 'http://127.0.0.1:7373/', pid: 4242, nonce: 'n' })
    try {
      // A different instance (different port, different pid) would otherwise
      // delete a file that by now describes someone else. That must not happen.
      expect(removeEndpointIfOwned(file, 9999)).toBe(false)
      expect(existsSync(file)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('does nothing, and does not throw, when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atrium-endpoint-'))
    try {
      expect(removeEndpointIfOwned(join(dir, 'does-not-exist.json'), 4242)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('does nothing, and does not throw, when the file is not valid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atrium-endpoint-'))
    const file = join(dir, 'endpoint.json')
    writeFileSync(file, 'not json')
    try {
      expect(removeEndpointIfOwned(file, 4242)).toBe(false)
      expect(existsSync(file)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
