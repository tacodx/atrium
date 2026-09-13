import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const CLEAN_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

export function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atrium-fix-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: CLEAN_ENV })
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  execFileSync('git', ['-C', dir, 'add', '.'], { env: CLEAN_ENV })
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { env: CLEAN_ENV })
  return dir
}

export type Vector = 'fsmonitor' | 'diffExternal' | 'hooksPath' | 'bareHook' | 'textconv'
export const ALL_VECTORS: readonly Vector[] = ['fsmonitor', 'diffExternal', 'hooksPath', 'bareHook', 'textconv']

/**
 * Plants exactly one named vector into an already-created repo. Factored out
 * of `makeMaliciousRepo` so a single vector can be tested in isolation
 * (`makeSingleVectorRepo`) as well as combined (`makeMaliciousRepo`) — a
 * combined pass/fail can only tell you "at least one vector is blocked," not
 * "all five are." Task-5's fix-round report has the full reasoning.
 */
function plantVector(dir: string, marker: string, script: string, vector: Vector): void {
  switch (vector) {
    case 'fsmonitor':
      // repo-local config git runs THROUGH A SHELL.
      execFileSync('git', ['-C', dir, 'config', 'core.fsmonitor', script], { env: CLEAN_ENV })
      return
    case 'diffExternal':
      // repo-local config git runs THROUGH A SHELL, on `git diff`.
      execFileSync('git', ['-C', dir, 'config', 'diff.external', script], { env: CLEAN_ENV })
      return
    case 'hooksPath': {
      // repo-local hooksPath — NOT blocked by clearing core.fsmonitor.
      const hooks = join(dir, 'evilhooks')
      mkdirSync(hooks, { recursive: true })
      writeFileSync(join(hooks, 'post-index-change'), `#!/bin/sh\ntouch "${marker}"\n`)
      chmodSync(join(hooks, 'post-index-change'), 0o755)
      execFileSync('git', ['-C', dir, 'config', 'core.hooksPath', hooks], { env: CLEAN_ENV })
      return
    }
    case 'bareHook': {
      // a bare hook in the default location, with zero config entries.
      const bare = join(dir, '.git', 'hooks', 'post-index-change')
      writeFileSync(bare, `#!/bin/sh\ntouch "${marker}"\n`)
      chmodSync(bare, 0o755)
      return
    }
    case 'textconv':
      // .gitattributes assigning a textconv driver, defined in repo-local
      // config — a vector SEPARATE from diff.external, reachable on `git
      // diff`/`log`/`show` even when diff.external is fully disabled.
      // Honored straight from the working tree; does not need to be committed.
      writeFileSync(join(dir, '.gitattributes'), 'README.md diff=evildriver\n')
      execFileSync('git', ['-C', dir, 'config', 'diff.evildriver.textconv', script], { env: CLEAN_ENV })
      return
  }
}

/**
 * A genuine uncommitted change to the tracked file `diff`/`log -p`/`show`
 * inspect. Without this, `git diff` against an unmodified working tree
 * produces no output at all, and diff.external/textconv are never invoked —
 * the fixture would "pass" a security check for the wrong reason (this
 * shipped once; see task-5 fix-round report, Important 3).
 */
function makeRealDiff(dir: string): void {
  writeFileSync(join(dir, 'README.md'), '# fixture\nmodified\n')
}

/** Builds a repo with exactly ONE vector planted, for isolated per-vector verification. */
export function makeSingleVectorRepo(vector: Vector): { dir: string; marker: string } {
  const dir = makeRepo()
  const marker = join(dir, 'PWNED')
  const script = join(dir, 'payload.sh')
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`)
  chmodSync(script, 0o755)
  plantVector(dir, marker, script, vector)
  makeRealDiff(dir)
  return { dir, marker }
}

/** Plants all five known execution vectors and returns the marker path. */
export function makeMaliciousRepo(): { dir: string; marker: string } {
  const dir = makeRepo()
  const marker = join(dir, 'PWNED')
  const script = join(dir, 'payload.sh')
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`)
  chmodSync(script, 0o755)
  for (const vector of ALL_VECTORS) plantVector(dir, marker, script, vector)
  makeRealDiff(dir)
  return { dir, marker }
}

export const wasPwned = (marker: string) => existsSync(marker)
