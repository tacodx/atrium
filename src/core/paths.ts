import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, unlinkSync } from 'node:fs'

export interface ExecContext { isCompiled: boolean; execPath: string; mainPath: string }

/**
 * NEVER build this from __dirname, import.meta.path/dir, or process.argv[1]:
 * inside a compiled binary those are /$bunfs/root/… paths that do not exist on
 * disk, and process.argv[0] is the bare string "bun". Spec §9.
 */
export function buildExecLine(ctx: ExecContext): string {
  return ctx.isCompiled ? ctx.execPath : `${ctx.execPath} ${ctx.mainPath}`
}

// Extracted so the actual detection — the part that breaks, and the part a
// compiled binary can't self-test by running its own test suite — has a unit
// test independent of the ambient `import.meta.path` it normally reads.
export function isCompiledPath(p: string): boolean {
  return p.startsWith('/$bunfs/')
}

export function currentExecContext(): ExecContext {
  return {
    isCompiled: isCompiledPath(import.meta.path),
    execPath: process.execPath,
    mainPath: Bun.main,
  }
}

export function configDir(env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'atrium')
}

// $XDG_RUNTIME_DIR does not exist on macOS or Windows; fall back to the config
// dir so every launcher has one place to look. A stale file left by a crashed
// instance is intended to be caught by a future consumer (`atrium open` /
// `doctor`) checking whether `pid` is still alive — that consumer does not
// exist yet, so treat this as documented future work, not present behavior.
export function endpointPath(env = process.env): string {
  const base = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'atrium') : configDir(env)
  return join(base, 'endpoint.json')
}

/**
 * Deletes `path` only if the `pid` recorded in it matches `expectedPid`.
 *
 * Two concurrent instances (deliberately unsupported for v1 — see the module
 * comment above) share this single path: instance B starting on a different
 * port overwrites instance A's file, which is a known, carried-forward gap.
 * The half of that this function closes is the destructive half — B's own
 * shutdown must never delete a file that, by then, describes A rather than B.
 * A missing file, an unreadable/unparsable one, or one with no numeric `pid`
 * are all treated the same as "not ours": nothing to remove, nothing to
 * throw about.
 *
 * Returns whether a removal happened, for testability.
 */
export function removeEndpointIfOwned(path: string, expectedPid: number): boolean {
  let owner: unknown
  try {
    owner = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
  const ownerPid = (owner as { pid?: unknown } | null)?.pid
  if (ownerPid !== expectedPid) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}
