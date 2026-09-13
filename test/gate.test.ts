import { test, expect, describe } from 'bun:test'
import { checkRequest } from '../src/server/gate'

const PORT = 7373
const mk = (headers: Record<string, string>, method = 'GET', url = 'http://127.0.0.1:7373/api/state') =>
  new Request(url, { method, headers })

describe('Host header', () => {
  const reject = [
    ['foreign host', { host: 'evil.com:7373' }],
    ['loopback-resolving subdomain', { host: 'evil.localhost:7373' }],   // RFC 6761
    ['trailing dot', { host: 'localhost.:7373' }],
    ['wildcard address', { host: '0.0.0.0:7373' }],                      // reaches a loopback bind
    ['ipv6 loopback', { host: '[::1]:7373' }],
    ['comma-joined duplicate', { host: '127.0.0.1:7373,evil.com' }],     // Bun joins, not 400
    ['wrong port', { host: '127.0.0.1:3000' }],
    ['no port', { host: '127.0.0.1' }],
    ['empty', { host: '' }],
  ] as const

  for (const [name, h] of reject) {
    test(`rejects ${name}`, () => {
      expect(checkRequest(mk({ ...h, origin: 'http://127.0.0.1:7373' }), PORT).ok).toBe(false)
    })
  }

  test('rejects a missing Host entirely', () => {
    const req = new Request('http://127.0.0.1:7373/api/state')
    req.headers.delete('host')
    expect(checkRequest(req, PORT).ok).toBe(false)
  })

  test('accepts both blessed hosts, case-insensitively', () => {
    for (const host of ['127.0.0.1:7373', 'localhost:7373', 'LOCALHOST:7373']) {
      expect(checkRequest(mk({ host, origin: 'http://127.0.0.1:7373' }), PORT).ok).toBe(true)
    }
  })
})

describe('absolute-form request URI', () => {
  // Bun gives two DISAGREEING views: req.url is attacker-controlled while the
  // Host header is clean. Enforce on the header only. Spec §8.2.
  test('ignores an attacker-controlled req.url when Host is valid', () => {
    const req = mk({ host: '127.0.0.1:7373', origin: 'http://127.0.0.1:7373' }, 'GET', 'http://evil.example.com/api/state')
    expect(checkRequest(req, PORT).ok).toBe(true)
  })
})

describe('Origin', () => {
  test('rejects another localhost port', () => {
    expect(checkRequest(mk({ host: '127.0.0.1:7373', origin: 'http://localhost:3000' }), PORT).ok).toBe(false)
  })

  test('rejects the literal null origin on a state-changing request', () => {
    expect(checkRequest(mk({ host: '127.0.0.1:7373', origin: 'null' }, 'POST'), PORT).ok).toBe(false)
  })

  test('rejects an absent origin on a state-changing request', () => {
    expect(checkRequest(mk({ host: '127.0.0.1:7373' }, 'POST'), PORT).ok).toBe(false)
  })

  test('allows an absent origin on a read-only GET', () => {
    expect(checkRequest(mk({ host: '127.0.0.1:7373' }), PORT).ok).toBe(true)
  })

  test('allows an absent origin on a read-only HEAD', () => {
    expect(checkRequest(mk({ host: '127.0.0.1:7373' }, 'HEAD'), PORT).ok).toBe(true)
  })

  test('rejects an absent origin on OPTIONS', () => {
    expect(checkRequest(mk({ host: '127.0.0.1:7373' }, 'OPTIONS'), PORT).ok).toBe(false)
  })

  test('rejects an absent origin on a non-standard verb (PROPFIND)', () => {
    expect(checkRequest(mk({ host: '127.0.0.1:7373' }, 'PROPFIND'), PORT).ok).toBe(false)
  })

  test('allows a non-standard verb (PROPFIND) WITH a valid origin', () => {
    expect(checkRequest(mk({ host: '127.0.0.1:7373', origin: 'http://127.0.0.1:7373' }, 'PROPFIND'), PORT).ok).toBe(true)
  })
})

describe('Sec-Fetch-Site', () => {
  test('rejects cross-site', () => {
    expect(checkRequest(mk({ host: '127.0.0.1:7373', origin: 'http://127.0.0.1:7373', 'sec-fetch-site': 'cross-site' }), PORT).ok).toBe(false)
  })

  test('allows same-origin and none', () => {
    for (const sfs of ['same-origin', 'none']) {
      expect(checkRequest(mk({ host: '127.0.0.1:7373', origin: 'http://127.0.0.1:7373', 'sec-fetch-site': sfs }), PORT).ok).toBe(true)
    }
  })
})
