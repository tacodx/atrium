import { test, expect, describe } from 'bun:test'
import { createRegistry } from '../src/core/registry'
import { dispatch, buildArgv } from '../src/core/actions'
import type { Provider } from '../src/core/contract'

const provider = (actions: Provider<any, any>['actions']): Provider<any, any> => ({
  id: 'git',
  configSchema: { parse: (x: any) => x },
  detect: async () => ({ kind: 'nothing-to-detect' }),
  schedules: [{ name: 'poll', intervalMs: 1000, runOnStart: false }],
  fetch: async () => ({}),
  actions,
})

describe('argv invariant', () => {
  test('every exec action yields an argv array, never a string', () => {
    const p = provider([{
      kind: 'exec', id: 'open', label: 'Open',
      argv: (t: any) => ({ cmd: '/usr/bin/xdg-open', args: [t.path] }),
    }])
    const out = buildArgv(p.actions[0], { path: '/home/u/repo' })
    expect(Array.isArray(out.args)).toBe(true)
    expect(out.cmd).not.toContain(' ')
  })

  test('a path beginning with a dash is passed as an absolute path, not a flag', () => {
    const p = provider([{
      kind: 'exec', id: 'open', label: 'Open',
      argv: (t: any) => ({ cmd: '/usr/bin/xdg-open', args: [t.path] }),
    }])
    const out = buildArgv(p.actions[0], { path: '/tmp/-rf' })
    expect(out.args[0].startsWith('/')).toBe(true)
  })

  test('a shell metacharacter in a target is inert because there is no shell', () => {
    const p = provider([{
      kind: 'exec', id: 'open', label: 'Open',
      argv: (t: any) => ({ cmd: '/bin/echo', args: [t.path] }),
    }])
    const out = buildArgv(p.actions[0], { path: '/tmp/foo; rm -rf ~' })
    expect(out.args).toEqual(['/tmp/foo; rm -rf ~'])   // one argument, not three
  })
})

describe('dispatch', () => {
  test('rejects an unknown action id rather than dispatching dynamically', async () => {
    const r = createRegistry()
    r.register(provider([]))
    await expect(dispatch(r, 'git', 'nonexistent', {})).rejects.toThrow(/unknown action/i)
  })

  test('rejects an unknown provider id', async () => {
    const r = createRegistry()
    r.register(provider([]))
    await expect(dispatch(r, 'nope', 'open', {})).rejects.toThrow(/unknown provider/i)
  })

  test('a call action validates its payload at the boundary', async () => {
    const r = createRegistry()
    r.register(provider([{
      kind: 'call', id: 'capture', label: 'Capture',
      payloadSchema: { parse: (x: any) => { if (typeof x?.text !== 'string') throw new Error('bad payload'); return x } },
      run: async () => {},
    }]))
    await expect(dispatch(r, 'git', 'capture', { text: 123 })).rejects.toThrow(/bad payload/)
    await expect(dispatch(r, 'git', 'capture', { text: 'ok' })).resolves.toBeUndefined()
  })
})
