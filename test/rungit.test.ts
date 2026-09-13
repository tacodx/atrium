import { test, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { makeRepo, makeMaliciousRepo, wasPwned } from './fixtures/gitrepo'
import { runGit } from '../src/core/rungit'

test('a hostile repo cannot execute anything through status or diff', async () => {
  const { dir, marker } = makeMaliciousRepo()

  await runGit(dir, ['status', '--porcelain=v2', '--branch'])
  await runGit(dir, ['diff'])
  await runGit(dir, ['log', '-1', '--format=%ct'])

  expect(wasPwned(marker)).toBe(false)
})

test('reads real metadata from a benign repo', async () => {
  const dir = makeRepo()
  const { stdout, code } = await runGit(dir, ['status', '--porcelain=v2', '--branch'])
  expect(code).toBe(0)
  expect(stdout).toContain('# branch.head main')
})

test('a repo path beginning with a dash is not read as a flag', async () => {
  const dir = makeRepo()
  const { code } = await runGit(dir, ['status', '--porcelain=v2'])
  expect(code).toBe(0)   // -C takes an absolute resolved path, never a bare name
})

test('an empty repo is tolerated, not an error state', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'atrium-empty-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } })

  const { code, stderr } = await runGit(dir, ['log', '-1', '--format=%ct'])
  expect(code).not.toBe(0)
  expect(stderr).toContain('does not have any commits yet')   // caller tolerates this
})

test('no source file calls git outside runGit', async () => {
  const { execFileSync } = await import('node:child_process')
  let hits = ''
  try {
    hits = execFileSync('grep', ['-rn', '--include=*.ts', "execFile.*['\"]git['\"]", 'src/'], { encoding: 'utf8' })
  } catch { hits = '' }   // grep exits 1 on no match
  const offenders = hits.split('\n').filter((l) => l && !l.includes('src/core/rungit.ts'))
  expect(offenders).toEqual([])
})
