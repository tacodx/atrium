import { join } from 'node:path'
import { homedir } from 'node:os'

export interface ExecContext { isCompiled: boolean; execPath: string; mainPath: string }

/**
 * NEVER build this from __dirname, import.meta.path/dir, or process.argv[1]:
 * inside a compiled binary those are /$bunfs/root/… paths that do not exist on
 * disk, and process.argv[0] is the bare string "bun". Spec §9.
 */
export function buildExecLine(ctx: ExecContext): string {
  return ctx.isCompiled ? ctx.execPath : `${ctx.execPath} ${ctx.mainPath}`
}

export function currentExecContext(): ExecContext {
  return {
    isCompiled: import.meta.path.startsWith('/$bunfs/'),
    execPath: process.execPath,
    mainPath: Bun.main,
  }
}

export function configDir(env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'atrium')
}

// $XDG_RUNTIME_DIR does not exist on macOS or Windows; fall back to the config
// dir so every launcher has one place to look. Stale files after a crash are
// detected by checking whether `pid` is still alive.
export function endpointPath(env = process.env): string {
  const base = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'atrium') : configDir(env)
  return join(base, 'endpoint.json')
}
