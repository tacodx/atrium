import { test, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepo, makeMaliciousRepo, makeSingleVectorRepo, wasPwned } from './fixtures/gitrepo'
import { runGit } from '../src/core/rungit'

test('a hostile repo cannot execute anything through status, diff, or log — and diff still works', async () => {
  const { dir, marker } = makeMaliciousRepo()

  await runGit(dir, ['status', '--porcelain=v2', '--branch'])
  const { code, stdout } = await runGit(dir, ['diff'])
  // NOT just "diff didn't pwn us" — diff must actually have run and produced
  // the real change. A version of this fixture shipped once where `diff` had
  // nothing to diff, so diff.external/textconv were never invoked at all and
  // this assertion passed for the wrong reason (task-5 fix-round report,
  // Important 3). code 0 + real content proves the vectors were exercised,
  // not skipped.
  expect(code).toBe(0)
  expect(stdout).toContain('modified')
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
  const dir = mkdtempSync(join(tmpdir(), 'atrium-empty-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } })

  const { code, stderr } = await runGit(dir, ['log', '-1', '--format=%ct'])
  expect(code).not.toBe(0)
  expect(stderr).toContain('does not have any commits yet')   // caller tolerates this
})

/**
 * Per-vector isolation. A combined fixture proves only "at least one vector
 * is blocked" when green — it cannot tell "all five closed" apart from "four
 * closed, one open," because a single surviving vector creates the same
 * marker a fully-open fixture would. Each of these plants exactly ONE vector
 * against a fresh repo and drives the specific git subcommand that vector
 * requires, so each is a measured, independent fact instead of an inference
 * from one shared boolean. (task-5 fix-round report has the full reasoning,
 * including the diff.external regression this exact gap let through once.)
 */
test('vector: core.fsmonitor is blocked on status', async () => {
  const { dir, marker } = makeSingleVectorRepo('fsmonitor')
  const { code } = await runGit(dir, ['status', '--porcelain=v2', '--branch'])
  expect(code).toBe(0)
  expect(wasPwned(marker)).toBe(false)
})

test('vector: diff.external is blocked via --no-ext-diff, and diff still produces real output', async () => {
  const { dir, marker } = makeSingleVectorRepo('diffExternal')
  const { code, stdout } = await runGit(dir, ['diff'])
  expect(code).toBe(0)   // NOT 128 — `-c diff.external=` made this exit 128 on every repo with a real change; that was the bug.
  expect(stdout).toContain('modified')
  expect(wasPwned(marker)).toBe(false)
})

test('vector: .gitattributes textconv driver is blocked via --no-textconv, and diff still produces real output', async () => {
  const { dir, marker } = makeSingleVectorRepo('textconv')
  const { code, stdout } = await runGit(dir, ['diff'])
  expect(code).toBe(0)
  expect(stdout).toContain('modified')
  expect(wasPwned(marker)).toBe(false)
})

test('vector: repo-local core.hooksPath is blocked on status', async () => {
  const { dir, marker } = makeSingleVectorRepo('hooksPath')
  const { code } = await runGit(dir, ['status', '--porcelain=v2', '--branch'])
  expect(code).toBe(0)
  expect(wasPwned(marker)).toBe(false)
})

test('vector: a bare .git/hooks/post-index-change fires with zero config entries, and is blocked', async () => {
  const { dir, marker } = makeSingleVectorRepo('bareHook')
  const { code } = await runGit(dir, ['status', '--porcelain=v2', '--branch'])
  expect(code).toBe(0)
  expect(wasPwned(marker)).toBe(false)
})

/**
 * "No source file calls git outside runGit" — a TRIPWIRE, not a proof. A prior
 * version of this test matched only `execFile.*['"]git['"]` and was defeated
 * by a reviewer using six unremarkable variants: a variable-held binary name,
 * an import alias, `Bun.spawn`, a multi-line call, a template literal, and
 * `spawnSync`. It will never be airtight — static text matching can't chase
 * every rename — but it should catch the ordinary, unthinking ways a future
 * contributor reaches for git without going through `runGit`. Two layers:
 *
 * 1. ANY import of `node:child_process` (or `child_process`) outside
 *    rungit.ts is flagged, regardless of local alias or what's later done
 *    with it — this is what actually defeats "variable-held binary name" and
 *    "import alias": neither evasion changes the import statement itself.
 * 2. ANY `Bun.spawn`/`Bun.spawnSync` call outside rungit.ts is flagged,
 *    regardless of argument shape (array literal, template literal, a
 *    variable, multi-line) — `Bun.spawn` is a global, not an import, so layer
 *    1 can't see it; this layer doesn't need to see the argument at all.
 *
 * Together these do not depend on spotting the literal string "git" at a call
 * site, which is exactly what a variable-held name or an alias defeats.
 *
 * Allowlist, besides rungit.ts itself: `src/core/actions.ts` (Task 7). That
 * file is the OTHER, deliberate `execFile` call site the design review
 * settled on — the general `exec` action primitive (open an editor, open a
 * terminal) that every provider's non-git actions go through, per its own
 * doc comment: "execFile(cmd, args[]) with NO shell ... NOT sufficient for
 * git, where the injection is in the callee's own config (see runGit, §8.6).
 * This is the general rule for every other exec action." It is still
 * execFile-only (no shell), so the project-wide "no shell, ever" invariant
 * holds; this allowlist entry only narrows what this specific git-focused
 * tripwire checks, it does not exempt actions.ts from that invariant.
 */
test('no source file calls git outside runGit (tripwire, not a proof)', () => {
  const CHILD_PROCESS_IMPORT = /\bfrom\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)/
  const BUN_SPAWN_CALL = /\bBun\.(?:spawn|spawnSync)\s*\(/
  const ALLOWED = new Set([join('src', 'core', 'rungit.ts'), join('src', 'core', 'actions.ts')])

  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      const st = statSync(p)
      if (st.isDirectory()) out.push(...walk(p))
      else if (entry.endsWith('.ts')) out.push(p)
    }
    return out
  }

  const offenders: string[] = []
  for (const file of walk('src')) {
    if (ALLOWED.has(file)) continue
    const content = readFileSync(file, 'utf8')
    if (CHILD_PROCESS_IMPORT.test(content)) offenders.push(`${file}: imports node:child_process`)
    if (BUN_SPAWN_CALL.test(content)) offenders.push(`${file}: calls Bun.spawn/Bun.spawnSync`)
  }
  expect(offenders).toEqual([])
})
