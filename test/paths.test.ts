import { test, expect } from 'bun:test'
import { buildExecLine } from '../src/core/paths'

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
