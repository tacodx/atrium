import type { Action } from '../../core/contract.ts'
import { PATH_PLACEHOLDER, type CommandTemplate, type ReposConfig } from './config.ts'
import type { RepoEntry } from './index.ts'

/**
 * The three `exec` actions §7.1 names (open in editor, open a terminal at the
 * path, open a terminal running `claude`), built from §8.8's `{cmd, args[]}`
 * templates in config. Every one VALIDATES ITS TARGET AGAINST THE DISCOVERED
 * REPO TABLE before building argv — that is the security core of this
 * module. The `exec` arm of `Action` has no payloadSchema, routes.ts forwards
 * `await req.json()` to dispatch untouched, and buildArgv validates only the
 * argv an action RETURNS, never the target it was handed: without the check
 * here, every bit of Task 7's validity gate and classifier is bypassed by any
 * `{"path": "..."}` a client posts.
 *
 * Both errors below surface through handleRoute's catch as a 400, which is
 * the right classification (client errors). Their messages are FIXED strings
 * that never echo the client's path: the route serves the message verbatim.
 */

/**
 * Exact string equality against a table key — no resolve(), no normalisation,
 * no prefix or startsWith match. A client that got the path from /api/state
 * sends it back byte-identical; anything else fails closed. Only the SURFACED
 * table is ever passed: dropped-ambiguous candidates live in a separate
 * collection this function never sees.
 */
export function resolveTarget(repos: ReadonlyMap<string, RepoEntry>, target: unknown): RepoEntry {
  if (typeof target !== 'object' || target === null || typeof (target as { path?: unknown }).path !== 'string') {
    throw new Error('repos: action target must be an object with a string "path"')
  }
  const entry = repos.get((target as { path: string }).path)
  if (entry === undefined) throw new Error('repos: unknown repository target')
  return entry
}

/**
 * Exact-element comparison only — never String.replace. validateTemplate in
 * config.ts guarantees exactly one element is the placeholder and that a
 * dash-leading literal precedes it, so the rendered argv always carries the
 * action's own option/`--` before the repository path.
 */
export function renderTemplate(tpl: CommandTemplate, path: string): { cmd: string; args: string[] } {
  return { cmd: tpl.cmd, args: tpl.args.map((a) => (a === PATH_PLACEHOLDER ? path : a)) }
}

export interface ReposActionDeps {
  /** GETTERS, not values: the table and the config are mutated by later fetches. */
  repos: () => ReadonlyMap<string, RepoEntry>
  config: () => ReposConfig | undefined
}

type TemplateKey = 'editor' | 'terminal' | 'claudeTerminal'

/**
 * Exactly three `exec` actions, in this order. Every id matches routes.ts's
 * ACTION_RE character class `[A-Za-z0-9_-]+`.
 */
export function createReposActions(deps: ReposActionDeps): Action[] {
  const make = (id: string, label: string, key: TemplateKey): Action => ({
    kind: 'exec',
    id,
    label,
    argv(target: unknown) {
      const cfg = deps.config()
      if (cfg === undefined) throw new Error('repos: configuration has not been loaded yet')
      const entry = resolveTarget(deps.repos(), target)
      // The ENTRY's own stored path — never the client-supplied string.
      return renderTemplate(cfg[key], entry.path)
    },
  })
  return [
    make('open-editor', 'Open in editor', 'editor'),
    make('open-terminal', 'Open terminal here', 'terminal'),
    make('open-claude', 'Open terminal running Claude', 'claudeTerminal'),
  ]
}
