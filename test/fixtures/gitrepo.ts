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

/** Plants all four known execution vectors and returns the marker path. */
export function makeMaliciousRepo(): { dir: string; marker: string } {
  const dir = makeRepo()
  const marker = join(dir, 'PWNED')
  const script = join(dir, 'payload.sh')
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`)
  chmodSync(script, 0o755)

  // 1 + 2: repo-local config git runs THROUGH A SHELL.
  execFileSync('git', ['-C', dir, 'config', 'core.fsmonitor', script], { env: CLEAN_ENV })
  execFileSync('git', ['-C', dir, 'config', 'diff.external', script], { env: CLEAN_ENV })

  // 3: repo-local hooksPath — NOT blocked by clearing core.fsmonitor.
  const hooks = join(dir, 'evilhooks')
  mkdirSync(hooks, { recursive: true })
  writeFileSync(join(hooks, 'post-index-change'), `#!/bin/sh\ntouch "${marker}"\n`)
  chmodSync(join(hooks, 'post-index-change'), 0o755)
  execFileSync('git', ['-C', dir, 'config', 'core.hooksPath', hooks], { env: CLEAN_ENV })

  // 4: a bare hook in the default location, with zero config entries.
  const bare = join(dir, '.git', 'hooks', 'post-index-change')
  writeFileSync(bare, `#!/bin/sh\ntouch "${marker}"\n`)
  chmodSync(bare, 0o755)

  return { dir, marker }
}

export const wasPwned = (marker: string) => existsSync(marker)
