import { spawn } from 'node:child_process'
import type { Action } from './contract'
import type { Registry } from './registry'

/**
 * Matches the version-control SUITE by final path segment: the binary, any
 * git-* name (an exec-path helper is the binary, most are symlinks to it, or
 * one of its scripts, or a separate suite program built from the same tree;
 * third-party git-* tools shell back to it), gitk and scalar. Measured:
 * git-receive-pack and scalar -C run a hostile repo's config from a valid
 * repos.* template. A tripwire, not a sandbox (ADR 0002 Ruling I). A regex,
 * never a string compare: rungit.test.ts flags a QUOTED git literal in src/.
 */
const GIT_COMMAND = /(?:^|[\\/])(?:git(?:-[^\\/]*)?|gitk|scalar)$/i

/**
 * execFile-style argv (cmd + args[]) with NO shell — necessary everywhere, and
 * NOT sufficient for git, where the injection is in the callee's own config
 * (see runGit, §8.6). This is the general rule for every other exec action.
 *
 * The argv is returned EXACTLY as the action declared it. An earlier version
 * rewrote every dash-leading argument through `resolve()`, which silently
 * mangled any literal flag an action declared — including spec §8.8's own
 * editor example, `code --wait <file>`, which became `code <cwd>/--wait
 * <file>`, <cwd> being atrium's own working directory (not `/`: $HOME by
 * default under a user unit, and a --scope child inherits it). It failed with
 * no error and no log, and left a provider author no way to declare a flag.
 *
 * The guard was also the wrong shape for the threat. An argv array already
 * makes `-rf` inert as a shell token, because there is no shell. The real
 * protection against a dash-leading *positional* is `--`, and, exactly as in
 * `runGit`, that knowledge belongs to the action author — the only code that
 * knows where its own command's options end and its operands begin. Stated
 * plainly, so it can be quoted at a provider: any action forwarding a value it
 * did not choose itself (a branch name, a path out of a listing, anything not
 * typed by the operator) MUST place its own `--` before it, e.g.
 * `{ cmd: '/usr/bin/code', args: ['--wait', '--', untrustedPath] }`.
 */
export function buildArgv(action: Action, target: unknown): { cmd: string; args: string[] } {
  if (action.kind !== 'exec') throw new Error(`action "${action.id}" is not an exec action`)
  const out = action.argv(target)
  if (typeof out.cmd !== 'string' || !Array.isArray(out.args)) {
    throw new Error(`action "${action.id}" did not return an argv pair`)
  }
  if (out.args.some((a) => typeof a !== 'string')) {
    throw new Error(`action "${action.id}" returned a non-string argument`)
  }
  // The runtime half of "runGit is the only path to git" (§8.6). An exec
  // action reaches spawnDetached with NO hardening prefix, NO env allowlist
  // and the full process.env — i.e. a hostile repo's core.fsmonitor executes —
  // so the one thing an exec action may never be is the git suite. The static
  // half is the tripwire in test/rungit.test.ts; this layer also catches a
  // command name assembled at runtime, which no static scan can see.
  if (GIT_COMMAND.test(out.cmd)) {
    throw new Error(
      `action "${action.id}" may not exec the version-control binary directly: an exec action gets no hardening prefix and no env allowlist. Route it through runGit() in src/core/rungit.ts from a "call" action instead (§8.6).`,
    )
  }
  return { cmd: out.cmd, args: out.args }
}

export interface SpawnDetachedOptions {
  /**
   * The launcher to wrap the command in. Defaults to systemd-run; overridden
   * ONLY by the test suite, which points it at a fake launcher so both
   * branches below can be exercised without depending on a live user bus.
   */
  launcher?: string
}

/**
 * systemd tears down a unit's cgroup on deactivation and kills its children, so
 * without detaching, `systemctl --user restart atrium` kills every editor and
 * terminal the dashboard opened. Spec §9.
 *
 * Two properties this deliberately has, both of which an earlier `execFile`
 * version got wrong:
 *
 * 1. `stdio: 'ignore'`, not a pipe. `execFile` buffers the child's output and
 *    KILLS it once 1 MiB accumulates (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`).
 *    Every action here is fire-and-forget — nothing reads the output — and
 *    §7.1's own examples include opening a terminal running `claude`, which
 *    passes 1 MiB in ordinary use and would have been terminated mid-session
 *    from the dashboard, silently.
 * 2. The fallback fires only when the launcher fails to START (an `error`
 *    event: ENOENT, EACCES — no systemd, no D-Bus), never on its exit status.
 *    `systemd-run --scope` is synchronous and forwards the child's own exit
 *    code, so keying on that relaunched every editor that exited non-zero a
 *    SECOND time, bare and unscoped — which is precisely what §9 mandates the
 *    scope to prevent.
 *
 * NOTE: the --scope mechanism is a documented open question — it is exec'd by
 * the client, so it propagates this process's environment rather than the
 * manager's current one. Re-evaluate against a transient service before the
 * autostart plan lands. The argv array is unchanged either way.
 */
export function spawnDetached(cmd: string, args: string[], opts: SpawnDetachedOptions = {}): void {
  const launcher = opts.launcher ?? 'systemd-run'
  const wrapped = ['--user', '--scope', '--quiet', '--collect', '--', cmd, ...args]
  // detached + unref: a new process group, so a Ctrl-C or a group signal aimed
  // at atrium does not reach an editor the user is still typing in.
  const child = spawn(launcher, wrapped, { env: process.env, stdio: 'ignore', detached: true })
  child.unref()
  child.once('error', () => {
    const bare = spawn(cmd, args, { env: process.env, stdio: 'ignore', detached: true })
    bare.unref()
    bare.once('error', () => {})   // no such command either; nothing left to try
  })
}

export interface DispatchOptions {
  /**
   * The provider's own config, handed to every `call` action as run()'s second
   * argument. REQUIRED, not optional: it was hardcoded `undefined` once, and
   * all four `call` actions the spec plans (obsidian's daily note and
   * quick-capture, mail's mark-read and archive) are unimplementable without
   * it. A required field makes a caller that has no config say so explicitly.
   */
  cfg: unknown
  /** Test seam; see SpawnDetachedOptions.launcher. */
  launcher?: string
}

export async function dispatch(
  registry: Registry,
  providerId: string,
  actionId: string,
  payload: unknown,
  opts: DispatchOptions,
): Promise<void> {
  const p = registry.get(providerId)
  if (!p) throw new Error(`unknown provider: ${providerId}`)

  // Static lookup. NEVER index a function table by a client-supplied name.
  const action = p.actions.find((a) => a.id === actionId)
  if (!action) throw new Error(`unknown action: ${providerId}/${actionId}`)

  if (action.kind === 'exec') {
    const { cmd, args } = buildArgv(action, payload)
    spawnDetached(cmd, args, { launcher: opts.launcher })
    return
  }

  const validated = action.payloadSchema ? action.payloadSchema.parse(payload) : payload
  await action.run(validated, opts.cfg)
}
