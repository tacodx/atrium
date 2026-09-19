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
(Ruling C). And `test/rungit.test.ts:360`'s `GIT_LITERAL` regex is left **byte-identical** to how Plan 1 left it:

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
declaring `cmd: 'git'`; the reasoning is recorded at `test/rungit.test.ts:327-344`. Loosening it one plan later,
to accommodate a name we are free to choose, would undo that finding for no gain.

Stated bluntly: loosening a tripwire in one task while another task adds the file it was widened to cover is
exactly the bypass that shipped in Plan 1. Choosing a different provider name costs one word.

### What turns red if the tree ever contains a quoted git literal

Two tests, both pre-existing and unchanged by this plan:

- `test/rungit.test.ts:384` — "no source file calls git outside runGit (tripwire, not a proof)"
- `test/rungit.test.ts:469` — "the real src/ tree is clean under all four layers"

`src/core/rungit.ts` is the **one skipped file** (`test/rungit.test.ts:387`, `:471`) — it is the resolver, so it
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
— which is exactly the declaration Ruling A's paired pin at `test/rungit.test.ts:432` asserts is caught.

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

The consequence is that with `id: 'repos'`, a key written `git.staleDays` would resolve to `undefined` — and
since the spec gives it a default of 30, any `?? 30` fallback written against it **would swallow the wrong
spelling in silence**. Nothing would throw, nothing would log, and the dashboard's "needs attention" grouping
would quietly use the default forever. (Conditional on purpose: no consumer of this key exists at HEAD. T8 writes
the first ones, which is why this is a ruling recorded before the code rather than a bug report after it.) This is the defect the
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
server-side error, no server-side log line, and no failed request: the element simply renders unstyled. The
browser itself *does* report it — a console CSP-violation message and a `securitypolicyviolation` event on the
document — and that console message is the one place that names the cause, so it is where an author debugging an
unstyled pane should look first.

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

`GitResult` gains a required `timedOut: boolean` (`src/core/rungit.ts:223`), derived at the single construction
site (`src/core/rungit.ts:239`). This section is why.

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
only on exit **0**. So a timed-out probe reads as "not ignored", falls through to the ambiguous row — which spec
line 156 states as "drop, overridable by `git.treatAsContainer`", rendered `repos.treatAsContainer` under Ruling C
— and **the repo silently disappears from the dashboard instead of being retried.** A transient slow disk becomes a missing project, with no error anywhere.

### Why the derivation reads `killed` and not `signal`

`timedOut` is `err?.killed === true`, and nothing else.

The claim this rests on is narrow, so it is stated narrowly: **on bun 1.3.11, the timeout is the only path in
`runGit` that surfaces as `killed === true`.** It is *not* the only thing that terminates the child —
`maxBuffer: 16 * 1024 * 1024` is set on the line immediately after the timeout at the same call site
(`src/core/rungit.ts:234-235`) and also kills it, which is
documented behaviour and not an edge case — but on this version an overflow reports `killed: undefined` (row 5
above), so it does not read as a timeout. The derivation is therefore correct here **by measured runtime
behaviour, not by the API's guarantee**: Node's own `execFile` assigns `ex.killed = child.killed || killed` after a
maxBuffer kill, which would report `true`. See tripwire 2 below.

A child killed by an **external** signal — the OOM killer, a SIGSEGV — reports `killed: false` with `signal` set
(row 6 above), and must not be called a timeout: it is a crash, and a retry policy that treats it as a timeout
will retry a process that will die the same way again.

**This is pinned by a test, not merely by review.** It did not start that way. A timeout-and-miss pair constrains
`timedOut` only as "true on a timeout, false on a plain exit 1", and every wrong derivation in the obvious family
agrees with the correct one on exactly those two points — `err?.signal != null`, `err?.code === null` and
`typeof err?.code !== 'number'` all passed. Row 6 is the shape that separates them, because it is the only one
with a signal set and `killed` false, and the PATH-shadow technique already in the file reaches `runGit` with it.

The crash case — "a crashed git is NOT a timeout: killed by an external signal, same exit code, timedOut false" —
kills all three at once, each failing on `expect(crashed.timedOut).toBe(false)` with `Received: true` and each
leaving every other test in the file green. That last detail is the point: the timeout test alone constrained none
of them.

### Tripwire on the derivation

Two, both with the same shape: a non-timeout starts reporting as a timeout, and T8's per-repo backoff retries
forever something that will fail identically every run.

1. **If an `AbortSignal` is ever added to `runGit`'s `execFile` options, `killed` becomes `true` on abort too, and
   this derivation must be revisited.** A caller-initiated cancellation would then be reported as a timeout.
2. **If a bun upgrade brings `maxBuffer`'s `killed` reporting into line with Node's, a repo whose output overflows
   16MB would report as timed out on every run.** This one is uncovered: the brief ruled out a `maxBuffer` test on
   flakiness grounds, so the overflow shape is recorded here as a measured fact (row 5) and asserted by nothing. A
   bun-version bump should re-measure row 5 before anything else in this table.

Both warnings are in the doc comment at `src/core/rungit.ts:196-222`, where an author changing these options will
actually be looking.

---

## Measured — the boot handoff (appended by Task 4)

Task 4 ships the only way a session token is ever issued: `startServer` mints **one** handoff per server start,
writes it 0600 to `handoff.json` beside `endpoint.json` in the 0700 runtime directory, and `POST /api/session`
trades it, single-use, for the session token. `atrium open --print-url` **reads** that file and prints
`http://127.0.0.1:<port>/#<handoff>`.

### The 7-day TTL, and why §8.3's ~60s window does not apply

`BOOT_HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000` (`src/server/serve.ts`), passed explicitly to `mintHandoff`
rather than inheriting `createAuth`'s 60s default.

§8.3's short window exists for one specific exposure: **a handoff delivered in a URL is briefly visible in
`/proc/<pid>/cmdline`**, which is world-readable on a default Linux with no `hidepid`. This handoff is never in a
URL until the user's own `atrium open --print-url` puts it there. Between mint and that moment it exists in
exactly two places — the server's in-process `Map`, and a 0600 file inside a 0700 directory. Neither is readable
by another uid, so the window that §8.3 is shortening is not open — already partly false; see the revisit
trigger at the end of this section.

A 60s window instead has a concrete failure: a systemd-started server's handoff is **dead before the user reaches
a browser**. That is the failure mode this ruling trades against, and it is the more likely one.

The TTL is bounded above by the process regardless. `handoffs` is an in-memory `Map` inside `createAuth`'s
closure, so the handoff dies with the server whatever the constant says; seven days is a ceiling on one server's
uptime window, never a credential that outlives the process. `cleanup` removes `handoff.json` on every exit path
(explicit `stop()`, SIGTERM, SIGINT, `process.on('exit')`), under the same pid-ownership rule `endpoint.json`
already used.

**Tripwire.** `test/serve.test.ts`'s `the boot handoff TTL is long, per the recorded ruling` asserts only
`>= 24h`. It is labelled a tripwire, not coverage: it can fail only if someone edits the constant. It exists
because the tempting tidy-up is to drop `mintHandoff`'s second argument and inherit the 60s default — which
strands every systemd-started user, and which nothing else in the suite would notice.

**Revisit trigger — missing from this ruling as first written.** The premise above, that the handoff is "never in
a URL until the user's own `atrium open --print-url` puts it there", is designed to become false.
`src/index.ts`'s own comment says a browser-launching `atrium open` is a later plan's job, and
`xdg-open "$(atrium open --print-url)"` defeats the premise **today**: the handoff lands in that command's argv,
which is `/proc/<pid>/cmdline`, which is precisely the exposure §8.3's ~60s window exists for. When a
browser-launching `atrium open` lands, that exposure goes live inside atrium itself, and this ruling must be
re-taken rather than inherited.

The exposed case is narrow and worth naming: **a handoff that is launched and never redeemed.** A redeemed
handoff is deleted from the map as it is traded, so the window closes on first use however long the TTL says; one
that is printed into a command line and then never traded stays live for seven days, with its value sitting in a
world-readable `cmdline` for as long as that process runs. It is not the only case, and the sentence above read as
if it were: the other is the race between argv exposure and the browser's redemption, in which another local uid
reads `/proc/<pid>/cmdline` and POSTs `/api/session` first — a case that exists identically under a 60s TTL, and
is what §8.3's "briefly visible" means. No constant changes here — the trigger is what was missing.

### Accepted residual — one boot handoff means one browser profile per server start

The handoff is single-use and there is exactly one mint site. **Exactly one browser profile can redeem per server
start.** A second profile, a second machine on the same X session, or a user who redeems and then clears the
profile's `localStorage`, gets a 401 and no way to ask for another. Recovery is
`systemctl --user restart atrium` (or any restart), which mints a fresh one.

This is deliberate. The alternatives were both rejected: an **unauthenticated** mint route hands the session token
to every local process, which is the whole boundary; a **bearer-gated** one is useless to a client that has no
bearer yet, which is the only client that needs it.

Second-order consequence, recorded rather than fixed: **after the TTL expires, `atrium open --print-url` still
prints a well-formed URL that will silently fail to authenticate.** The file is still there and still parses; only
the map entry is stale, and nothing on the CLI side can tell. Same shape as the already-carried staleness gap on
`endpoint.json` (a stale file from a crashed instance prints a URL that will not connect), and it belongs with
that one — a future `atrium doctor` is the place both get checked.

### What the auth boundary actually is, stated plainly

- **Authenticated** (bearer, `verifyBearer`): everything reached through `handleRoute` — `GET /api/state` and
  `POST /api/actions/:providerId/:actionId`. On the socket: every frame after the first.
- **Gated but NOT authenticated**: `/healthz` (echoes pid, nonce, embedded-asset count and the resolved exec
  line), every static asset, `POST /api/session` itself, and the `/ws` upgrade — which any local process can
  reach with a forged Host/Origin and hold for up to `DEFAULT_WS_AUTH_TIMEOUT_MS`, receiving **zero** application
  data, which is the control that makes a forgeable Origin survivable (§8.4).
- **Comparison is `===` on strings and `Map.get` on the handoff — not constant-time.** Out of scope by the task's
  own ruling, and that conclusion stands — but the reason first recorded here is wrong, and is corrected in place
  rather than removed.

  It said the boundary is the **uid**: "a same-uid process can read the 0600 file outright, so a timing side
  channel is never the cheapest attack available." That does not describe the attacker who can actually reach
  these comparisons. **Loopback is interface-scoped, not uid-scoped.** A different-uid local process can open a
  socket to 127.0.0.1, forge Host and Origin, and time `POST /api/session` and a bearer request, while being
  unable to read the 0600 file or to `ptrace` the process. So the trigger as first written — "revisit only if
  either token ever becomes reachable across a uid boundary" — **is already satisfied today**.

  What the ruling actually rests on, keeping two things apart that the first version ran together:

  - **Guessing** is out of reach on entropy alone. Both tokens are 32 bytes from `crypto.getRandomValues` —
    **256 bits**, CSPRNG, re-minted on every server start.
  - **Measuring** is the part a non-constant-time compare actually exposes, and what it exposes is a prefix, one
    comparison chunk at a time — a byte in the textbook model, a machine word or more in practice, whatever the
    runtime's early exit is actually granular to. Anything coarser than a byte only makes the dismissed attack
    weaker: each step then has to enumerate a whole chunk to find the one that runs longer. Entropy does not help
    there; the noise floor does. The per-chunk signal is a few nanoseconds of string comparison, under a loopback
    round trip that already includes a `URL` parse, the Host/Origin gate and a JSON parse — microseconds of
    jitter — so each chunk costs a large sampling campaign, against a token that is re-minted on every restart.
  - The handoff side offers even less: `handoffs` holds **at most one entry** — one between boot and redemption,
    zero after it, since `consumeHandoff` deletes on trade — so in either state `Map.get` has no sibling entry
    to be faster or slower than. (As first written this bullet said "exactly one entry for the life of the
    process", which is false after redemption, and went on to reason about hash-bucket collisions on a miss.
    That was a claim about the engine's `Map` internals which this ADR neither names nor needs; it is dropped,
    and the ruling stands on entropy and the noise floor without it.)

  This is an analytical argument, **not a measurement**. Nobody has timed these operations, and nothing here
  claims otherwise.

  **Revisit if** either token becomes reachable from off this host, or if the handoff map ever holds enough
  entries for lookup timing to carry structure — concretely, if anything other than `startServer`'s single boot
  mint ever calls `mintHandoff`.

## Ruling E — no user bus: the three repos exec actions are a silent no-op, accepted

Appended by Task 8, which ships the three `exec` actions Ruling B settled on (`open-editor`,
`open-terminal`, `open-claude` on the `repos` provider). This ruling settles carry-forward P1 for all
three at once, as measured facts about the code that already ships, and records the decision taken.

### The facts, from the shipped source

- `spawnDetached` (`src/core/actions.ts:97-109`) wraps **every** exec action in
  `systemd-run --user --scope --quiet --collect -- <cmd> <args…>` (`:98-102`). The default launcher is
  `'systemd-run'` (`:98`); only the test suite overrides it.
- Its fallback (`:104-108`) fires **only on the child's `error` event** — the launcher failing to *start*
  (ENOENT, EACCES: no `systemd-run` binary at all). It is deliberately not keyed on exit status, and the
  comment at `:85-90` says why: `systemd-run --scope` forwards the wrapped command's own exit code, so keying on
  it would relaunch every editor that exited non-zero a second time, bare and unscoped.
- With `systemd-run` **present but no user bus** (no `DBUS_SESSION_BUS_ADDRESS`, no
  `$XDG_RUNTIME_DIR/bus` — a bare SSH session, a container, a `systemctl --user` unit started without a
  session), the launcher *starts*, fails to connect to the manager, prints to a stderr that is `'ignore'`d,
  and exits 1. No `error` event fires. The fallback does not run. Nothing runs.
- The route still answers `{ok: true}`: `dispatch` resolves `Promise<void>` after `spawnDetached` returns
  (`src/core/actions.ts:138-142`), and `src/server/routes.ts:73-76` has no result channel — it awaits
  `dispatch` and returns `Response.json({ ok: true })`.

All three of Task 8's actions inherit every line of that. They add target validation *before* argv is built
(`src/providers/repos/actions.ts`, `resolveTarget`) and nothing after it.

### The decision

**Accepted as-is for this slice.** The alternatives were weighed and rejected here:

- *Probe for a user bus and select the launcher per call* (bare `spawn` when there is no bus) would need
  `DispatchOptions`, `dispatch` and `routes.ts` to change — `src/core/**` and `src/server/**` are not Task 8's,
  and per-call launcher selection is exactly the "relaunch bare and unscoped" shape §9 mandates the scope to
  prevent.
- *A result channel on `exec`* (report the launcher's exit status to the client) is the same contract change
  Ruling B already deferred for `show diff`: `Action`'s exec arm would gain a result, `dispatch` would stop
  being `Promise<void>`, and the route would need a body. Deferred with it.

### The consequence, in one sentence

A user without a session bus — or without the configured `cmd` (`code`, `konsole`) installed at all — clicks
one of the three buttons and **nothing happens, with no error anywhere**: not in the response, not in the
pane, not in the server log. The next plan that touches `src/core/actions.ts` should pick this up together
with Ruling B's result channel.

**Revisit if** a result channel is added to the `exec` arm, or if the launcher is ever selected per call.
