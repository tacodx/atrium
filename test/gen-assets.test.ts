import { test, expect } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Carry-forward P2. `./web-dist` is gitignored, so on a fresh clone the walk
// used to hit readdirSync's ENOENT before the friendly message could fire, and
// `bun run typecheck` — which needs src/generated-assets.ts to exist at all,
// because src/server/routes.ts imports it — died with a stack trace.
//
// Both tests write ONLY inside their own mkdtemp scratch directory. Neither
// may be allowed to fall back to the default OUT: clobbering the real
// src/generated-assets.ts from a test would corrupt every other test file's
// view of the asset manifest.

async function runGenAssets(args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn([process.execPath, 'run', 'scripts/gen-assets.ts', ...args], {
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [stderr, stdout, code] = await Promise.all([
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
    proc.exited,
  ])
  return { code, stderr, stdout }
}

test('a missing web-dist fails with the friendly message, not an ENOENT stack trace', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'atrium-genassets-'))
  try {
    const out = join(scratch, 'out.ts')
    const r = await runGenAssets([join(scratch, 'nope'), out])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('did you run the vite build first')
    expect(r.stderr).not.toContain('ENOENT')
    expect(existsSync(out)).toBe(false)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('--allow-empty writes a stub manifest so a fresh clone can typecheck', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'atrium-genassets-'))
  try {
    const out = join(scratch, 'out.ts')
    // The flag goes FIRST on purpose: it pins that flags are filtered out of
    // the positional arguments rather than counted as DIST.
    const r = await runGenAssets(['--allow-empty', join(scratch, 'nope'), out])
    expect(r.code).toBe(0)
    expect(existsSync(out)).toBe(true)
    expect(readFileSync(out, 'utf8')).toContain('export const ASSET_PATHS')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
