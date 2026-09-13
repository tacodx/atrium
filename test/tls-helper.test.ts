import { test, expect } from 'bun:test'
import { resolveDualStack } from '../src/net/tls-connect'

test('picks a reachable address when the first candidate is blackholed', async () => {
  const lookup = async () => [
    { address: '2001:db8::1', family: 6 },   // documentation prefix, always unroutable
    { address: '93.184.216.34', family: 4 },
  ]
  const probe = async (addr: string) => addr !== '2001:db8::1'

  const out = await resolveDualStack('imap.example.com', 993, { lookup, probe })

  expect(out.host).toBe('93.184.216.34')
  expect(out.servername).toBe('imap.example.com')
})

test('servername is always the hostname, never the resolved ip', async () => {
  const lookup = async () => [{ address: '10.0.0.1', family: 4 }]
  const probe = async () => true

  const out = await resolveDualStack('mail.example.org', 993, { lookup, probe })

  expect(out.servername).toBe('mail.example.org')
  expect(out.host).toBe('10.0.0.1')
})
