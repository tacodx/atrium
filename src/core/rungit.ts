import { execFile } from 'node:child_process'
import { resolve, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

// An empty directory Atrium owns. Pointing core.hooksPath here is stronger than
// /dev/null: git treats it as a real but hook-free directory.
const EMPTY_HOOKS = mkdtempSync(join(tmpdir(), 'atrium-nohooks-'))

/**
 * Command-line -c beats repo-local config. This is NOT a blocklist of dangerous
 * values — blocklists are never viable here, because git's long-option
 * abbreviation means --upload-p= executes exactly as --upload-pack= does.
 * It is a fixed set of settings that git would otherwise read from an
 * attacker-controlled .git/config AND RUN THROUGH A SHELL. Spec §8.6.
 */
const HARDENING = [
  '--no-pager',
  '-c', 'core.fsmonitor=',
  '-c', `core.hooksPath=${EMPTY_HOOKS}`,
  '-c', 'core.sshCommand=',
  '-c', 'core.askPass=',
  '-c', 'core.editor=false',
  '-c', 'core.pager=cat',
  '-c', 'diff.external=',
  '-c', 'protocol.ext.allow=never',
]

/**
 * The child env is an ALLOWLIST built from scratch, and it explicitly SETS
 * GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM. A blanket "scrub all GIT_*" would
 * delete the two variables that make the security tests honest — this machine's
 * ~/.gitconfig redirects core.hooksPath, which would silently make the hook
 * test pass here while every other user stayed exploitable. Spec §8.6, §10.
 */
function childEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/nonexistent',
    LANG: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
}

export interface GitResult { stdout: string; stderr: string; code: number }

/** THE ONLY PATH TO GIT. test/rungit.test.ts greps src/ to enforce that. */
export function runGit(repoPath: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<GitResult> {
  const abs = resolve(repoPath)
  const argv = [...HARDENING, '-C', abs, ...args]

  return new Promise((res) => {
    execFile('git', argv, {
      env: childEnv(),
      timeout: opts.timeoutMs ?? 5000,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      res({ stdout, stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 })
    })
  })
}
