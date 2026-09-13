import { test, expect, describe } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildExecLine, isCompiledPath, removeEndpointIfOwned } from '../src/core/paths'

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
