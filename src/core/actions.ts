import { execFile } from 'node:child_process'
import { resolve, isAbsolute } from 'node:path'
import type { Action } from './contract'
import type { Registry } from './registry'

/**
 * execFile(cmd, args[]) with NO shell — necessary everywhere, and NOT
 * sufficient for git, where the injection is in the callee's own config
 * (see runGit, §8.6). This is the general rule for every other exec action.
 */
export function buildArgv(action: Action, target: unknown): { cmd: string; args: string[] } {
  if (action.kind !== 'exec') throw new Error(`action "${action.id}" is not an exec action`)
  const out = action.argv(target)
  if (typeof out.cmd !== 'string' || !Array.isArray(out.args)) {
    throw new Error(`action "${action.id}" did not return an argv pair`)
  }
  // Path-shaped holes only: a bare "-rf" would be read as a flag by the callee.
  return { cmd: out.cmd, args: out.args.map((a) => (a.startsWith('-') && !isAbsolute(a) ? resolve(a) : a)) }
}

/**
 * systemd tears down a unit's cgroup on deactivation and kills its children, so
 * without detaching, `systemctl --user restart atrium` kills every editor and
 * terminal the dashboard opened. Spec §9.
 *
 * NOTE: the --scope mechanism is a documented open question — it is exec'd by
 * the client, so it propagates this process's environment rather than the
 * manager's current one. Re-evaluate against a transient service before the
 * autostart plan lands. The argv array is unchanged either way.
 */
export function spawnDetached(cmd: string, args: string[]): void {
  const wrapped = ['--user', '--scope', '--quiet', '--collect', '--', cmd, ...args]
  execFile('systemd-run', wrapped, { env: process.env }, (err) => {
    if (err) execFile(cmd, args, { env: process.env }, () => {})   // fallback: no systemd/D-Bus
  })
}

export async function dispatch(registry: Registry, providerId: string, actionId: string, payload: unknown): Promise<void> {
  const p = registry.get(providerId)
  if (!p) throw new Error(`unknown provider: ${providerId}`)

  // Static lookup. NEVER index a function table by a client-supplied name.
  const action = p.actions.find((a) => a.id === actionId)
  if (!action) throw new Error(`unknown action: ${providerId}/${actionId}`)

  if (action.kind === 'exec') {
    const { cmd, args } = buildArgv(action, payload)
    spawnDetached(cmd, args)
    return
  }

  const validated = action.payloadSchema ? action.payloadSchema.parse(payload) : payload
  await action.run(validated, undefined)
}
