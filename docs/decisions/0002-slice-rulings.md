# 0002 — Plan 2 slice rulings

**Date:** 2026-09-14
**Status:** Accepted

## Context

Plan 2 ("First Light") takes the Plan 1 foundation from inert to running: one `repos` provider delivering real
data through a started scheduler, a redaction seam, a real auth round trip, a WebSocket push, and one pane. It is
split across ten tasks written and executed by different authors, most of them in sequence and two of them in
parallel. Four decisions cut across every one of those tasks, and each of the four exists because a **named defect
was measured, not anticipated** — three of them shipped in Plan 1 and were caught only by a whole-branch review
that could see two tasks' diffs at once, which no per-task review can. The pattern in all three: the half that
creates the hazard lives in one task's diff and the half that would have caught it lives in another's.

This document is the binding record. Where it contradicts the spec (Ruling C), it supersedes the spec by citation
rather than by edit — no task in Plan 2 rewrites §7.1.

Every table below was produced by running the code, on this machine, on 2026-09-14, against bun 1.3.11 (the pinned
`engines.bun` floor, ADR 0001). Nothing in them is reasoned about.

---

## Ruling A — the provider id is `repos`, and `GIT_LITERAL` is left completely unedited

**Decided.** The provider id is `repos`. Its directory is `src/providers/repos/`. Its config prefix is `repos.*`
(Ruling C). And `test/rungit.test.ts:332`'s `GIT_LITERAL` regex is left **byte-identical** to how Plan 1 left it:

```js
const GIT_LITERAL = /(['"`])(?:[^'"`]*[\\/])?git\1/i
```

### The measured trip/clean table

Re-measured 2026-09-14 against that exact regex. Every row was run, not reasoned about.

| Source text | Result |
|---|---|
| `id: 'git'` | **trips** |
| `if (providerId === 'git') {}` | **trips** |
| `cmd: '/usr/bin/git'` | **trips** |
| `` execFile(`git`, []) `` | **trips** |
| `"git"` | **trips** |
| `'a/b/git'` | **trips** |
| `// route it through runGit, never 'git'` (a **comment**) | **trips** |
| `id: 'repos'` | clean |
| `'repos.staleDays'` | clean |
| `['rev-parse', '--absolute-git-dir']` | clean |
| `['check-ignore', '-q', '--', p]` | clean |
| `['rev-parse', '--is-bare-repository']` | clean |
| `join(dir, '.git')` | clean |
| `'.gitignore'`, `'gitattributes'`, `'gitdir'`, `'--git-dir'` | clean |
| `'.git/worktrees'`, `'rebase-merge/head-name'` | clean |
| `'legit'`, `'digit'`, `label: 'Open in git'` | clean |
| `// we never exec the git binary directly` (unquoted, in a comment) | clean |

### The consequence, in both directions

**The rename costs nothing.** Every string Tasks 7 and 8 need — the provider id, the config keys, all four
subcommand argv arrays, the `.git` path joins, the state-file names — is clean under the unmodified regex. There
is no pressure to loosen it.

**A quoted `'git'` inside a comment trips.** The regex has no idea what a comment is. Provider authors must
therefore write the binary's name **unquoted in prose**: `// we never exec the git binary directly`, never
`// ... never 'git'`. This is a real constraint on documentation, accepted deliberately.

### Why the alternative was rejected

The tempting loosening is "exempt the identifier position" — teach the regex that `id: 'git'` is a provider name
and not a command. To be correct that exemption would have to cover `id:` declarations, equality comparisons
(`providerId === 'git'`), config-key lookups, snapshot keys, and route path segments: a surface wider than any
paired test that would guard it, in a file whose entire job is to be a tripwire. Layer 4 was widened from
`actions.ts` alone to **all of `src/`** as Plan 1 final-review finding I3, precisely to catch a provider file
declaring `cmd: 'git'`; the reasoning is recorded at `test/rungit.test.ts:299-315`. Loosening it one plan later,
to accommodate a name we are free to choose, would undo that finding for no gain.

Stated bluntly: loosening a tripwire in one task while another task adds the file it was widened to cover is
exactly the bypass that shipped in Plan 1. Choosing a different provider name costs one word.

### What turns red if the tree ever contains a quoted git literal

Two tests, both pre-existing and unchanged by this plan:

- `test/rungit.test.ts:356` — "no source file calls git outside runGit (tripwire, not a proof)"
- `test/rungit.test.ts:441` — "the real src/ tree is clean under all four layers"

`src/core/rungit.ts` is the **one skipped file** (`test/rungit.test.ts:359`, `:443`) — it is the resolver, so it
necessarily names the binary. `src/core/actions.ts` is exempt from **layers 1 and 2 only** (the
`node:child_process` import and the `Bun.spawn` call): layers 3 (`Bun.$`) and 4 (the git literal) still apply to
it, because the one file whose job is spawning subprocesses is exactly where an unthinking git call would land.

### Verified against the real scanner, not against a synthetic string

A throwaway `src/providers/repos/index.ts` was created and run through the real suite, then deleted:

| `src/providers/repos/index.ts` contains | `bun test test/rungit.test.ts` |
|---|---|
| `export const id = 'repos'` | **23 pass, 0 fail** |
| `export const id = 'git'` | **21 pass, 2 fail** — both tripwire tests report `src/providers/repos/index.ts: references git directly` |

---

## Ruling B — `show diff` is deferred. Plan 2 ships **three** exec actions on the repos provider, not four

Spec §7.1's action list (spec lines 199–200) names four: open in editor, open terminal at path, **show diff**, and
open a terminal running `claude`. Plan 2 ships three. `show diff` is deferred because all three shapes it could
take are illegal, and the fourth option — hardcoding an external viewer — is worse than shipping nothing.

Spec line 200's own summary ("All `exec`, all through `runGit()` or the editor template") is internally
contradictory and is part of what this ruling resolves: an `exec` action can never go through `runGit()`.
`runGit()` is called from inside this process; an `exec` action is an argv pair handed to `spawnDetached`.

### Shape 1 — a direct `exec` action on the git binary. Rejected twice over.

At run time `buildArgv` throws: `src/core/actions.ts:54-58`, matching `out.cmd` against `GIT_COMMAND`
(`src/core/actions.ts:14`). Statically, layer 4 of the tripwire flags the quoted literal in any file under `src/`
— which is exactly the declaration Ruling A's paired pin at `test/rungit.test.ts:404` asserts is caught.

### Shape 2 — a terminal wrapper. Passes `buildArgv`, and is the §8.6 RCE re-entered.

`buildArgv` inspects only `out.cmd` (`src/core/actions.ts:42-58`). So
`{cmd: '/usr/bin/tig', args: ['diff', …]}` is **accepted** — the precedent is already in the suite at
`test/actions.test.ts:80-83`, where `{cmd: '/usr/bin/tig', args: ['diff', '--stat', '--', t.path]}` passes with
its args verbatim. `spawnDetached` (`src/core/actions.ts:97-109`) then runs it with `env: process.env`, no
hardening prefix, and no env allowlist. Anything that reaches git down that path gets the full ambient
environment and a hostile repo's `core.fsmonitor`, `diff.external` and `.gitattributes` textconv drivers back —
the precise attack surface `runGit` and its five-vector fixture exist to close.

### Shape 3 — a `call` action. There is nowhere for a diff to come back.

The `call` arm's `run` returns `Promise<void>` (`src/core/contract.ts:32-34`). `dispatch` returns
`Promise<void>` (`src/core/actions.ts:124-130`). And `src/server/routes.ts:76` answers a successful dispatch with
`Response.json({ ok: true })`. The contract has no result channel at all. Widening it with one is a change
deserving its own plan, not a line item inside a slice whose point is to get the existing pipeline running.

### The alternative that was not taken, stated honestly

Hard-coding an external viewer (`tig`, `delta`, `difftastic`) would ship a fourth button. It would also ship a
button that depends on a tool the user may not have installed, whose absence surfaces as a silently-failing
`spawnDetached` (`src/core/actions.ts:104-107` swallows the spawn error and retries bare, then swallows again).
Three buttons that work beat four where one does nothing on most machines.

### The three that ship

Open in editor, open terminal at path, open a terminal running `claude` — all `exec`, declared in Task 8.

---

## Ruling C — the repos provider's config section is `repos.*`, never `git.*`

The ruling fixes the **prefix**. Every key this provider reads is `repos.*`.

### The §7.1 four, renamed

| Key | Type | Spec origin |
|---|---|---|
| `repos.staleDays` | number, default 30 | §7.1, spec line 196 |
| `repos.extraRoots` | string[], additional scan roots | spec line 177 |
| `repos.includeDotPaths` | boolean — the dot-prefixed-basename escape hatch for chezmoi/yadm/`~/.dotfiles` users | spec line 178 |
| `repos.treatAsContainer` | the override for the classifier's dropped-ambiguous row | spec lines 156 and 169 |

Later tasks add more under the same prefix: Task 8 adds `repos.metadataConcurrency`, `repos.metadataTimeoutMs`,
`repos.editor`, `repos.terminal` and `repos.claudeTerminal`, widening `reposConfigSchema`'s unknown-key rejection
alongside them.

### Why the spelling is load-bearing, not cosmetic

**The scheduler looks a provider's config up by its provider id.** It does so in two places: inside
`createScheduler`'s `runNow`, where the provider's own `fetch` is handed its slice of the config
(`src/core/scheduler.ts:25`), and in the `configFor` accessor that `dispatch` reads through
(`src/core/scheduler.ts:63`). Both are the same lookup of the same value, keyed on the provider id.

The consequence is that with `id: 'repos'`, a key written `git.staleDays` resolves to `undefined` — and every
consumer of it is written `?? 30`, so the wrong spelling is **swallowed in silence**. Nothing throws, nothing
logs, and the dashboard's "needs attention" grouping quietly uses the default forever. This is the defect the
Plan 2 scoping pass named: *a provider renamed in one task whose config keys stay unrenamed in another.*

(Deliberately not quoted here: the current expression at either line. Task 3 moves the config parse inside
`createScheduler` and rewrites both sites. What survives Task 3 unchanged — and what this ruling actually fixes —
is the **invariant that the lookup key is the provider id**, not the shape of today's expression. A brief that
quoted a pre-change line verbatim is itself a defect this project has already shipped once.)

### This ADR supersedes the spec's `git.*` spellings without editing the spec

Spec lines **156, 169, 177, 178 and 196** spell these keys `git.*`. No task in Plan 2 edits §7.1 — the spec gets
exactly one edit in this plan, §6's interface block, in Task 5 — so **this document is the authoritative record of
the rename.** A reader who finds `git.staleDays` in the spec and `repos.staleDays` in the code should believe the
code and this ADR.

---

## Ruling D — Tailwind utility classes only in `web/`. No `style={{}}`, no inline `<style>`, no injected stylesheet

This is a ruling rather than a style preference because of two properties of what already ships.

### The policy, quoted exactly

`SECURITY_HEADERS` in `src/server/serve.ts:11-17` sends:

```
content-security-policy: default-src 'self'; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; frame-ancestors 'none'
```

### Property 1 — there is no `style-src` directive and no `'unsafe-inline'`

Inline styles therefore fall back to `default-src 'self'` and are **dropped by the browser**. There is no
server-side error, no log line, and no failed request: the element simply renders unstyled.

### Property 2 — the packaging gate can never observe a CSP violation

`scripts/assert-package.ts` drives everything through `fetch` — lines `:42`, `:58`, `:75`, `:96` and `:119` — and
never through a browser. There is no Playwright, no Puppeteer, no headless Chromium anywhere in the repo. CSP is
enforced by a browser's renderer; a `fetch` has no renderer. The gate is **structurally incapable** of seeing this
class of failure, however thorough it becomes.

### The failure mode

A pane renders unstyled in the real browser while `bun test`, `bun run typecheck` and `bun run assert:package` all
stay green. Nothing in the automated set can go red. That is why this is written down instead of reviewed for.

### Spec cross-reference, with one recorded divergence

Spec §8.9 (spec lines 448–451) names the same four headers. Its `connect-src` is written
`'self' ws://127.0.0.1:PORT` where the shipped header also allows `ws://localhost:PORT`; the shipped version is
the broader of the two and is what `SECURITY_HEADERS` actually sends. Neither mentions `style-src`, which is the
point.

---

## Measured — the `timedOut` channel

`GitResult` gains a required `timedOut: boolean` (`src/core/rungit.ts:205`), derived at the single construction
site (`src/core/rungit.ts:221`). This section is why.

### The four execFile shapes

Measured on **bun 1.3.11** on 2026-09-14 via a direct `node:child_process.execFile` probe, each row observed:

| Case | `err.code` | `err.killed` | `err.signal` | what `runGit` reports for `code` |
|---|---|---|---|---|
| `timeout` fires | `null` | `true` | `'SIGTERM'` | **`1`** |
| child exits 1 | `1` | `false` | `null` | `1` |
| child exits 0 | (`err` is `null`) | — | — | `0` |
| binary missing | `'ENOENT'` | `undefined` | `undefined` | `'ENOENT'` |
| `maxBuffer` exceeded | `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` | `undefined` | `undefined` | that string |
| child killed by an **external** signal | `null` | **`false`** | `'SIGKILL'` | `1` |

The last row was measured in the same probe and is not in the task brief. It is the direct evidence for the
derivation choice below, which would otherwise rest on reasoning alone.

### The collision, and why it drops repos

A timed-out `runGit` is **indistinguishable from a real exit 1 on `code` alone** — row 1 and row 2 both report
`1`, because `err.code` is `null` on a timeout and the `?? 1` fallback fills it in.

That matters because of §7.1's classifier. Measured through `runGit` against a `makeRepo()` fixture:
`git check-ignore -q -- <path>` exits **1** on a miss and **0** on a hit. §7.1's container row surfaces a child
only on exit **0**. So a timed-out probe reads as "not ignored", falls through to the ambiguous row — which is
"drop, overridable by `repos.treatAsContainer`" (spec line 156) — and **the repo silently disappears from the
dashboard instead of being retried.** A transient slow disk becomes a missing project, with no error anywhere.

### Why the derivation reads `killed` and not `signal`

`timedOut` is `err?.killed === true`, and nothing else.

`killed` is `true` only when **this** process called `kill()`, and `execFile`'s `timeout` option is the only thing
in `runGit` that does so. A child killed by an **external** signal — the OOM killer, a SIGSEGV — reports
`killed: false` with `signal` set (row 6 above), and must not be called a timeout: it is a crash, and a retry
policy that treats it as a timeout will retry a process that will die the same way again.

The tempting alternative `timedOut: err?.signal != null` is **wrong and untested**. It passes the covering test —
measured — because a genuine exit 1 gives `signal: null` and a timeout gives `'SIGTERM'`, so both of that test's
assertions still hold. It differs only for row 6, which the test cannot produce. That derivation is excluded by
this document and by review, **not** by a test. It is recorded here as uncovered rather than counted as covered.

### Tripwire on the derivation

**If an `AbortSignal` is ever added to `runGit`'s `execFile` options, `killed` becomes `true` on abort too, and
this derivation must be revisited.** A caller-initiated cancellation would then be reported as a timeout and
retried. The same warning is in the doc comment at `src/core/rungit.ts:196-203`, where an author adding the option
will actually be looking.
