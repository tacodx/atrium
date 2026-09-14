# Recommendation

Build **the repos vertical slice ("First Light")**, with the redaction seam upgraded to a required `toClient` contract member and config parsing moved inside the scheduler — one provider end-to-end through auth, socket, and a real pane, instead of four providers onto a stack that has never carried one. It wins because the auth path's **happy path** is currently untestable: nothing issues a token, so no
test ever authenticates successfully, and that gap keeps the whole stack unexercised end-to-end.

> **Controller correction (measured 2026-09-14, in a throwaway copy).** The synthesis originally claimed
> these were "the two most security-relevant lines in the repo" and "unfalsifiable". That overstates it,
> and the distinction changes how urgent this is. Four mutations against the 118-test suite:
>
> | Mutation | Direction | Result |
> |---|---|---|
> | `serve.ts:107` → `if (false)` (bearer check bypassed) | **auth bypass** | **117 pass, 1 fail — caught** |
> | `serve.ts:107` → `if (true)` (always 401) | fail-closed | 118 pass — unpinned |
> | `serve.ts:135` → `state.authed = false` | fail-closed | 118 pass — unpinned |
> | socket auth check removed | **socket auth bypass** | **117 pass, 1 fail — caught** |
>
> Both *dangerous* directions are genuinely pinned — neither auth check can be silently removed. What is
> unpinned is the positive path: a change that breaks *legitimate* access passes the suite. That is a real
> regression gap and T4 below still closes it, but it is availability coverage, not an open security hole.
> Do not repeat the stronger claim.

## Scores

| Proposal | Delivery & momentum | Spec + security fidelity | Plan-defect hunt |
|---|---|---|---|
| **First Light — repos vertical slice** | **8** | 7 | **7** |
| Wire the foundation, then prove it with git | 7 | **8** | 6 |
| Four Providers Against One Contract | 2 | 4 | 4 |

First Light wins two of three lenses and is second in the third by one point. The spec/security judge's single decisive complaint against it — "correct seam LOCATION, absent seam CONTENT" — is repaired below by grafting Plan C's Task 4 wholesale.

## Task decomposition

**Serialization rule, load-bearing:** T2, T3, T4, T5 and T6 all edit `src/server/serve.ts` and/or `src/core/scheduler.ts:35-39`. They are strictly sequential in the stated order. T1 and T7 are the only tasks safe to dispatch in parallel with anything. Every task below carries at least one named mutation check, specified in advance.

---

### T1 — Rulings ADR + the runGit timeout channel
**Depends on:** nothing (parallel-safe)

**Deliverable.** One ADR (`docs/decisions/0002-slice-rulings.md`) plus one small code change.

- **Ruling A — provider id is `repos`, directory `src/providers/repos/`, and `test/rungit.test.ts:305`'s `GIT_LITERAL` is left completely unedited.** Verified against the real regex: `id: 'git'` trips it (and turns `rungit.test.ts:329` and `:414` red); `id: 'repos'` is clean, as are `'rev-parse'`, `'check-ignore'`, `'--absolute-git-dir'`. Both losing proposals loosen the regex to keep the name; the defect judge measured that `providerId === 'git'` also trips, so any "spare the identifier position" exemption is broader than the paired test that would guard it — and layer 4 was widened as final-review finding I3 precisely to catch `src/providers/git/actions.ts` declaring `cmd:'git'`. The rename costs nothing. Note in the ADR that a quoted `'git'` in a *comment* trips too.
- **Ruling B — `show diff` is deferred**, with all three illegal shapes written down: `exec` on git is rejected at `actions.ts:54-58` and statically; a terminal wrapper passes `buildArgv` (which inspects only `out.cmd`) while reaching git with full `process.env` and no hardening prefix — the §8.6 RCE, re-entered; a `call` action returns `Promise<void>` that `routes.ts:76` discards.
- **Ruling C — config section is `repos.*`**, not `git.*`. Config lookup is keyed by provider id (`scheduler.ts:25`, `:63`), so with `id:'repos'` the keys are `repos.staleDays`, `repos.extraRoots`, `repos.includeDotPaths`, `repos.treatAsContainer`. *(This ruling exists solely because the defect judge caught First Light renaming the provider in T1 and still writing `git.staleDays` in its pane task — an always-undefined lookup silently falling back to 30.)*
- **Ruling D — Tailwind classes only, no `style={{}}` props.** `serve.ts:15-16` ships `default-src 'self'` with no `style-src` and no `'unsafe-inline'`; the failure is silent, and `scripts/assert-package.ts` uses `fetch`, never a browser, so it can structurally never observe a CSP violation. *(Promoted from a "check it later" note in Plan C to a ruling, per the spec judge.)*
- **Code:** add `timedOut: boolean` to `GitResult` (`rungit.ts:185`), derived from `err.killed`/`err.signal`, both discarded today at `rungit.ts:201`.

**Files:** `docs/decisions/0002-slice-rulings.md`, `src/core/rungit.ts`, `test/rungit.test.ts`

**Tests.** Paired tripwire pins through the existing `scanFile`: synthetic `cmd: 'git'` MUST be flagged, `cmd: "/usr/bin/git"` MUST be flagged, the real `src/` tree stays clean with the provider present. Timeout test: a timed-out `runGit` returns `{code: 1}` — byte-identical to a genuine `check-ignore -q --` miss, which §7.1's classifier reads as "not ignored" and therefore drops the repo. Assert `timedOut === true` while `code === 1`. **Mutation:** delete the field, watch it go red.

---

### T2 — Turn the foundation on: ServeConfig, registry validation, scheduler lifecycle
**Depends on:** nothing (parallel-safe with T1)

**Deliverable.**
- Widen `ServeConfig` (`serve.ts:35-41`) with `providers?: Provider<any,any>[]` and `config?: Record<string, unknown>`, both **optional**, so all nine existing call sites (`src/index.ts:18`; `test/serve.test.ts:21,34,41,70,86,108,136,165`) compile and behave identically. Do **not** widen the return type — that breaks `s.stop()` at eight call sites for no benefit.
- Register providers at the current construction point (`serve.ts:56`), **before** `Bun.serve`, so a duplicate id (`registry.ts:8,11`) throws before the port binds and before `endpoint.json` is written.
- **Registry-time schedule validation** *(grafted from Plan B T1c, flagged by both the delivery and defect judges as a cheap gap in First Light)*: reject duplicate schedule names (they collide on `scheduler.ts:15`'s key **and** double-register timers at `:85`), reject `intervalMs` that is not a positive finite integer (it goes straight into `setInterval`), reject `watch` declared with an empty `schedules` array (silently dropped by the `if (p.watch && fallback)` guard at `:91`). **`runNow` rejects an unknown schedule name** — `scheduler.ts:19-20` validates only the provider today.
- **Deterministic `runOnStart` ordering:** `await` each `runOnStart` schedule in declaration order before installing intervals and watchers, re-checking the `started` flag after each await. Today `scheduler.ts:73-85` fires both in one tick, so repos' 30s metadata pass begins ~1s before the 0.97–1.25s discovery scan resolves, on every cold start.
- **Failure record** replacing the bare `.catch(() => {})` at `scheduler.ts:84-85` and `:92`: per `${providerId}:${scheduleName}`, `{lastSuccessAt, consecutiveFailures, lastErrorMessage}`. **This record must be reachable from `snapshot()`**, not only from a sibling `health()` — the defect judge found First Light's pane rendering "unavailable" from data no wire frame carried.
- Wrap the synchronous `p.watch(...)` call (`:91-92`) so a throwing watcher does not escape `start()` and `startServer` after the port is bound.
- **Teardown** *(shape grafted from Plan C T2, which the delivery judge rated harder to implement wrongly)*: define `const shutdown = () => { scheduler.stop(); cleanup() }` next to `cleanup` (`serve.ts:176`), use it in both signal handlers (`:178-179`) and in the `server.stop` wrapper (`:186-190`); leave `process.on('exit', cleanup)` alone. `scheduler.stop()` **must** precede `originalStop()` — the post-await abort guard at `scheduler.ts:35` is the only thing suppressing a notify after the server closed.
- **Fixture provider** at `test/fixtures/provider.ts` whose `watch(cfg, emit)` hands `emit` back to the test. This is the deterministic push seam every later test needs; without it a push test races `runOnStart` (`scheduler.ts:84`) and is flaky in exactly the way this project has been burned by.
- Fix carry-forward P2 while here: `typecheck` chains `gen:assets`, which `readdirSync`s the gitignored `./web-dist`.

**Files:** `src/server/serve.ts`, `src/core/scheduler.ts`, `src/core/registry.ts`, `test/fixtures/provider.ts`, `package.json`

**Tests.** A registered provider is actually polled. Two-schedule fixture: B's first run observes A's completed output. A throwing provider appears in the failure record rather than vanishing from `snapshot()`. Registry rejects each of the four new invalid shapes with a named message. A duplicate id throws **and the port is still free afterwards** (this pins the registration position, not just the throw). `bun test` still exits after `s.stop()` with a provider registered — timers are plain `setInterval` with no `.unref()`. `test/contract.test.ts:157-192` (idempotence, start→stop→start) stays green. **Mutation:** move `scheduler.stop()` after `originalStop()` and confirm the publish-after-close test goes red.

---

### T3 — Config: parse **inside** `createScheduler`
**Depends on:** T2

**Deliverable.** `src/core/config.ts` reads `join(configDir(env), 'config.json')` — `configDir()` exists at `paths.ts:31-33` with no caller today — treats a missing file as `{}`, and hands the raw record to `startServer({config})`.

**The parse itself moves into `createScheduler`** *(grafted from Plan B T1b)*: call `p.configSchema.parse(raw[p.id])` at scheduler construction, store the parsed value, and serve **that** value to both `fetch`'s cfg (`scheduler.ts:25`, today `opts.config[providerId] as never`) and `configFor` (`:63`). Both losing proposals put the parse in the serve path; the defect judge found that leaves every direct `createScheduler` caller — all of `test/contract.test.ts` and every future provider unit test — running unparsed while production runs parsed. It also dissolves First Light's circular brief (its loader needed a registry that only exists inside `startServer`).

No zod: `package.json` dependencies are react + react-dom only, and `contract.ts:38` is a structural duck type. Hand-written `.parse` per provider; record the decision. **Record explicitly whether the config object is frozen** — the scheduler reads it by reference at call time, making live mutation either a reload mechanism or an invisible footgun.

**Files:** `src/core/config.ts`, `src/core/scheduler.ts`, `src/index.ts`, `test/config.test.ts`

**Tests.** Missing `config.json` yields `{}`. A rejecting parse surfaces as exit 78, matching the EX_CONFIG convention at `src/index.ts:16` and `serve.ts:150`. **The test First Light omitted** *(grafted from Plan C T6)*: **fetch receives the PARSED value, not the raw one** — and the brief must state that a `{parse: x => x}` stub cannot detect this, so the fixture's parse must *transform*. **Mutation:** pass the raw value through, watch it go red. `test/contract.test.ts:80`'s `.toBe` identity assertion (fetch's cfg and `configFor` are the same object) stays green.

---

### T4 — The auth path, and the two mutation checks it unlocks
**Depends on:** T2, T3 *(sequenced behind T3 only to avoid a concurrent `src/index.ts` edit — the defect judge caught these colliding unflagged in First Light)*

**Deliverable.**
- `mintHandoff(now, ttlMs?)` storing `{issuedAt, ttlMs}` instead of the bare number (`auth.ts:22,29`), plus a sweep of expired entries on every mint — the only delete today is inside `consumeHandoff` (`auth.ts:36`).
- **POST `/api/session`**, inserted between the `serveAsset` fallthrough (`serve.ts:105`) and the bearer check (`serve.ts:107`) — above `:107` it is unreachable-by-401, below `serveAsset` it cannot be shadowed by a built asset. Handoff arrives in the **body**, never the URL (§8.3 forbids the query; a URL lands in logs). POST not GET, so `gate.ts:23-30`'s absent-Origin rejection applies. Returns `{token: auth.sessionToken}` or a bare 401 with no unknown-vs-expired distinction.
- **Delivery:** mint one handoff at boot, write it 0600 to a **separate** file in the existing 0700 runtime dir — not into `endpoint.json`, whose `nonce` is already echoed on unauthenticated `/healthz` (`serve.ts:88`) and whose contract §9 fixes as `{url,pid,startedAt}`; and not to stdout, which under systemd moves a live credential into the persistent journal.
- **`atrium open --print-url` READS that file** and prints `http://127.0.0.1:PORT/#<handoff>`. It does **not** mint: `handoffs` lives in the closure created at `serve.ts:44`, so a separate process cannot mint into the running server's map. *(This is the one place First Light is unambiguously right and Plan C's brief was unimplementable — its T1 said both "startServer mints and writes the file" and "`--print-url` mints on demand", whose only other exit is an unauthenticated mint route that hands the session token to every local process.)*
- The file-delivered handoff gets a long TTL, recorded as an accepted residual: §8.3's ~60s window exists for `/proc/<pid>/cmdline` exposure, which a 0600 file in a 0700 directory does not have.

**Files:** `src/server/auth.ts`, `src/server/serve.ts`, `src/index.ts`, `test/serve.test.ts`, `test/auth.test.ts`

**Tests — the headline of this plan.** Both mutations that survive the suite *today* must go red. (1) A valid handoff POSTed to `/api/session` returns the session token, and that token gets 200 from `GET /api/state` — **mutation:** `serve.ts:107` → `if (true)`. (2) A socket sending the correct first frame stays open — **mutation:** `serve.ts:135` → `state.authed = false`. This is the positive half of §10:534-535's mandated WS-auth-gate check, which has never been writable. Plus: the same handoff twice returns 401 the second time; a GET to `/api/session` neither consumes nor issues; an expired handoff is still *consumed* (`test/auth.test.ts:34-42` stays green); **a wrong-scheme header (`Basic <token>`) returns 401**, closing carry-forward M8 *(from Plan C T1)*. Because there is exactly one mint site, the sweep is exercised by minting twice in a unit test against `createAuth()` directly rather than being claimed untested.

---

### T5 — Redaction: `toClient` as a **required** contract member
**Depends on:** T2, T3, T4 — **grafted wholesale from Plan C Task 4**

This replaces First Light's `publicSnapshot()` pass-through. The spec/security judge's decisive finding: First Light gets the seam *location* right and ships it with no *content*, then pushes absolute `$HOME` repo paths and branch names through it in T7–T9 — exactly the ordering carry-forward §1 bullet 4 rules against.

**Deliverable.** Add `toClient(data: Data): unknown` to `Provider` (after `fetch`, `contract.ts:45`), documented as an explicit field-by-field **allowlist** — never `{...data}` with deletions, because a deny-list misses the next field added — plus the closed-set rule that any status or error value on the wire is one of §7.4's declared codes, never a caught exception object. **Required, not optional**, for the same reason `DispatchOptions.cfg` is required (`actions.ts:111-119` records it was hardcoded `undefined` once): an optional member defaulting to identity means the author who forgets it ships secrets silently.

Applied in **exactly one place**: compute the wire value **once** in `scheduler.ts:35-39` and use that same variable for both the `last` write and the listener notification — those two lines write the *same object* to two consumers, so this is the only location that covers `/api/state` and the WS push together. `previousByKey` (`:36`) keeps the **raw** value.

Same task: reconcile spec §6's interface block with what shipped (add `watch?`, define `FetchCtx` and `DetectResult`, add `payloadSchema?`, replace `configSchema: ZodSchema<Cfg>` with the shipped structural type, add `toClient`, and either file the "audit log" claim at spec:127 as work or delete it).

**Do not quote pre-T2/T3 line contents in this brief.** *(Plan C's version literally instructed "change line 37 to `last.set(providerId, p.toClient(data))`" — the pre-fix key — which an implementer following verbatim would use to revert T2's work. The defect judge flagged this as the cross-task invariant no per-task review can see.)*

**Files:** `src/core/contract.ts`, `src/core/scheduler.ts`, `test/contract.test.ts`, `test/routes.test.ts`, `test/actions.test.ts`, `docs/superpowers/specs/2026-09-13-atrium-design.md`

**Tests.** A fixture provider whose Data carries a sentinel secret: the sentinel appears in **neither** the serialized `/api/state` body **nor** (once T6 lands) any WS frame. **Mutation:** remove `toClient` from the scheduler write path — **both** assertions go red. **Mutation:** move the redaction above `previousByKey.set` and `test/contract.test.ts:128-155` goes red. Clean `bun run typecheck` is part of acceptance — the three stub providers breaking is the point.

---

### T6 — Wire protocol, WS push, and the first authenticated screen
**Depends on:** T4, T5

**Deliverable.** `src/core/wire.ts` as the single definition imported by server and UI (`tsconfig.json` has no `include`, so `tsc --noEmit` already covers `src/`, `web/`, `test/`, `scripts/` together; `verbatimModuleSyntax` means `import type`). `STATE_TOPIC`; `ClientFrame = {type:'auth'; token}` — **not a free choice**, it must match `auth.ts:50-51` exactly — plus subscribe/unsubscribe; `ServerFrame = ready | snapshot | update | error`. **Deliberately no refresh/run frame:** `POST /api/actions/:providerId/:actionId` already carries the gate, the bearer check and `dispatch`'s static allowlist (`actions.ts:134-136`); a WS frame triggering `runNow` would run subprocesses through a path with none of it.

`serve.ts`: replace the comment at `:139`. Call `ws.subscribe(STATE_TOPIC)` **only inside the successful-auth branch** after `:135`, never in `open()` — Bun drops subscriptions on close, so `close()` needs no bookkeeping, and topic routing makes §8.4's zero-state invariant *structural* rather than send-site discipline. Register `scheduler.onUpdate → server.publish` **before** `start()`, wrapped in try/catch. **The snapshot/update frames must carry T2's failure record**, or T9's mandatory unavailable-vs-zero check has no data.

Client: `session.ts` (localStorage → else read `location.hash`, `history.replaceState` the fragment away **first**, then POST, then store); `socket.ts` (auth frame first, capped jittered backoff, and on 1008-auth **clear the token and stop** — `sessionToken` is regenerated at `serve.ts:44` on every start, so *every `systemctl --user restart atrium` strands every open tab; this is the common path, not an edge case* — framing from Plan C); `store.ts` (`useSyncExternalStore` with a **cached** `getSnapshot` identity — `scheduler.snapshot()` returns a fresh `Object.fromEntries` per call at `:53`, and an unmemoized passthrough surfaces as an infinite render loop, not a clear error); `api.ts`. `main.tsx` renders live state as a `<pre>`.

**Checklist item, not a footnote:** keep a literal `p-4` in the rendered tree. Measured — the entire built stylesheet is 4188 bytes containing two rules, and `.p-4{padding:calc(var(--spacing) * 4)}`, sourced solely from `web/src/main.tsx:5`, is the only thing satisfying `scripts/assert-package.ts:108-113`.

**Files:** `src/core/wire.ts`, `src/server/serve.ts`, `web/src/lib/{session,socket,store,api}.ts`, `web/src/main.tsx`, `test/ws-protocol.test.ts`

**Tests.** New file; extract the `connectWs` cast from `test/serve.test.ts:15-18` to a shared helper; ports outside 7391-7403. (1) A socket sending a correct auth frame receives `ready` then `snapshot`, having received **zero** frames before sending it. **Mutation:** move `ws.subscribe` into `open()` — must go red. Putting it in `open()` is the natural place, reads as harmless, and turns none of today's 118 tests red. (2) An `update` frame arrives when the fixture provider's `emit()` fires — use that seam, not a `runOnStart` race. (3) A subscribe to one provider does not deliver another's updates, **recorded in the test as bandwidth management, not an authorization control** — the control is that an unauthenticated socket is subscribed to nothing. (4) A socket closed mid-push does not throw into the listener. `bun run assert:package` passes after `main.tsx` is rewritten.

---

### T7 — repos provider: discovery, validity gate, classifier
**Depends on:** T1, T3 (parallel-safe with T4–T6)

**Deliverable.** `src/providers/repos/{index,config}.ts`, exported as `createReposProvider()` — a **factory**, so each fixture test gets an isolated instance and §10:517's "providers are `fetch(cfg) → Data`, testable against fixtures" survives the closure-held repo table. Two schedules per §7.1 (`discovery` 600_000 runOnStart, `metadata` 30_000 runOnStart), branching on `ctx.schedule` with a **total default branch**.

Validity gate on `rev-parse --absolute-git-dir`'s **exit code**, not emptiness — measured, a non-repo and a 0-byte `.git` file both exit 128, so §7.1's "returns empty" never happens with code 0 — and compare the returned gitdir against the candidate, because the flag walks **up** and returns the parent's gitdir with code 0 on a subdirectory. Five-row first-match-wins classifier in §7.1's exact order (worktree → submodule → vendored → container → ambiguous); the spec records that testing `check-ignore` before the worktree row surfaces every worktree as a project. `typeof code === 'number'` narrowed before every comparison (`GitResult.code` is `number | string`). **Dropped-ambiguous candidates are reported in Data, not silently discarded.** Config keys per T1 Ruling C.

**Files:** `src/providers/repos/{index,config}.ts`, `test/fixtures/gitrepo.ts`, `test/repos-discovery.test.ts`

**Tests.** §10's container-regression fixture to the spec's **literal** contents (parent with tracked files whose `.gitignore` lists three child repos; all four must surface) plus the 13 discovery shapes §10:556-561 enumerates. Every git call under `test/fixtures/gitrepo.ts:8-10`'s CLEAN_ENV. No test derives a count or path from `$HOME` (§10 rule 1). **Three mandatory mutations:** revert the container rule to "drop nested repos" → red; move the `check-ignore` row before the worktree row → red; a fixture repo that **genuinely exceeds** the per-repo timeout is not classified from its exit code → red without T1's `timedOut`. Add the `afterAll` cleanup carry-forward P3 asks for.

---

### T8 — repos provider: metadata, edge shapes, three actions **with target validation**
**Depends on:** T7

**Deliverable.** Metadata over the closure-held table: concurrency 8-16, per-repo `timeoutMs`, backoff keyed on `timedOut`. Verified call shapes: `['status','--porcelain=v2','--branch','-uall']` (**never** add `--no-optional-locks`; `rungit.ts:91` supplies it and `args[0]` must be the subcommand), `['log','-1','--format=%ct']`, `['rev-parse','--absolute-git-dir']`. Caller-supplied `--` before every repository-controlled positional. Absolute paths always (`rungit.ts:189` resolves against cwd, `/` under systemd).

Three measured edge shapes: **empty** repo — `log` exits 128 ("does not have any commits yet") while `status` exits 0 emitting `# branch.oid (initial)`, so emptiness is read off status, never off log's exit code; **bare** repo — gate on `rev-parse --is-bare-repository` before status, which exits 128 in a bare repo; and `code` can be a string.

Three `exec` actions from the §8.8 `{cmd, args[]}` template: open in editor, open terminal at path, open a terminal running `claude`. **Settle carry-forward P1 here deliberately** — with `systemd-run` present and no user bus the action is a measured silent no-op, and all three inherit it.

**Target validation — the gap present in *no* proposal, found by the defect judge.** The `exec` arm of `Action` has no `payloadSchema` (`contract.ts:29-31`), `routes.ts:73` passes `await req.json()` straight through, and `actions.ts:139` hands it to `buildArgv`, which validates only the **returned** argv (`:42-58`), never the input. So T7's validity gate and classifier decide which repos exist, and an exec action would accept any `${path}` a client sends, bypassing all of it. **Each action must validate its target against the discovered repo table before building argv.**

**Files:** `src/providers/repos/{index,actions}.ts`, `test/repos-metadata.test.ts`

**Tests.** Fixtures for empty, bare, mid-rebase (recovering the real branch from `rebase-merge/head-name`, never rendering as `(detached)`), mid-merge, mid-cherry-pick, and a repo with 47 untracked files asserting `-uall` reports 47, not 8. A timing-out repo backs off rather than reporting clean. Each action's argv places its own `--`. **Mutations:** read emptiness from log's exit code → empty-repo test red; **remove target validation → an action invoked with an undiscovered path must go red**.

---

### T9 — The repos pane
**Depends on:** T6, T8

**Deliverable.** `web/src/panes/ReposPane.tsx`. Per repo: name, branch, state (`clean | detached | rebasing(branch, n/total) | merging | cherry-picking | reverting | bisecting | empty`), relative time since last commit via `Intl.RelativeTimeFormat` (no new dependency), uncommitted count. Recent-first with a "needs attention" group requiring **both** staleness past `repos.staleDays` **and** uncommitted changes — §7.1: an old clean repo is finished, not rotting. **Three distinct states**: loading, unavailable (from T2's failure record, delivered via T6's frames), empty. Actions as POST buttons; `routes.ts:70` requires POST and `test/routes.test.ts:48-55` pins that a GET on an action path is a 404 with the handler never run. §8.7: branch names and paths are attacker-controlled — React's default escaping is the mitigation, no `dangerouslySetInnerHTML`, no `new URL()` over them. Tailwind only (Ruling D). Keep `p-4`.

**Files:** `web/src/panes/ReposPane.tsx`, `web/src/main.tsx`, `web/src/lib/api.ts`, `test/repos-pane.test.ts`

**Tests.** Three fixture snapshots render three visibly distinct states. **Mutation (§10:538, mandatory):** collapse unavailable into empty → red. **Mutation:** make "needs attention" an OR → a stale clean repo appears → red. A branch name containing markup renders escaped. End-to-end smoke: start the server with the real provider against a fixture root, redeem a handoff, assert `/api/state` returns the fixture repos.

---

### T10 — Verify gate, dev loop, whole-plan mutation re-check
**Depends on:** T9

**Deliverable.** `bun run verify` = `build && assert:package && test && typecheck`. `assert:package` (`package.json:15`) has **no caller** today — no `pretest`, no CI — so every packaging demand, including the `p-4` trap, is currently unenforced and would surface at release. CI pinned to `engines.bun` (>=1.3.11). Document the dev loop: `bun run build:web && bun run gen:assets && bun run src/index.ts serve` — verified to serve the fresh vite build at 200 from a plain source run, so UI iteration costs ~1s, not a 58–110MB compile. **Record that widening `gate.ts`'s origin allowlist for a Vite dev server is forbidden**: measured, `Origin: http://localhost:5173` → 403 (`gate.ts:18-22`) *and* `Sec-Fetch-Site: same-site`, which a browser sends on any cross-port fetch, → 403 (`gate.ts:33-36`), independently; `gate.ts:3-8` forbids the bypass by name citing CVE-2025-49596 and CVE-2024-23657. Fix carry-forward P4.

**Also record, as written contracts for the next plan** *(grafted from Plan B)*: the secrets adapter's required shape (Promise.race timeout on **every** `Bun.secrets` call — ADR 0001:153-161 warns a raced-away call is not inert; 0600 file in a 0700 dir; startup refusal on group/world-readable; `locked` distinct from `not configured`), and the forbidden-export source-grep pattern for the eventual claude port (`getAccessToken`, `refreshToken`, `writeBackCredentials`, `getGauges` — `getGauges` calls `getAccessToken` at `usage.mjs:157` and would rotate the refresh token the running Claude Code process holds).

**Tests.** Re-run **every** mutation this plan introduced in one pass, recorded red-then-green: bearer gate, WS auth flag, `ws.subscribe` in `open()`, `toClient` removed, redaction above `previousByKey`, config raw-vs-parsed, `scheduler.stop()` after `originalStop()`, container rule, classifier row order, timeout-vs-exit-1, empty-repo branch, exec target validation, unavailable-vs-zero, needs-attention OR. Carry-forward §3 records seven tests already found passing against deliberately broken implementations; this pass is the toll for adding thirty more.

---

## Plan defects to avoid

Every defect the adversarial judge found in First Light, and how the decomposition above neutralises it.

1. **Redaction seam shipped as an untested no-op while real `$HOME` data crosses it.** First Light's `publicSnapshot()` was "initially a pass-through" and no task made it otherwise; its nine-mutation list contained no redaction mutation. → **T5 replaces it with a required `toClient` member**, landing *before* T7–T9 ship real data, with a sentinel-secret test that must go red in both `/api/state` and the WS frame.

2. **Provider renamed to `repos` in T1, config keys still written as `git.*` in the pane task.** Lookup is by provider id (`scheduler.ts:25,63`), so the key is always undefined, the fallback to 30 is silent, and the test passes because it never varies `staleDays`. → **T1 Ruling C names the keys `repos.*`** and T7/T9 both reference that ruling.

3. **Config loader circularly dependent on a registry that lives inside `startServer`.** Its likely resolution — lazy parse inside the scheduler — moves the failure to first fetch, where `scheduler.ts:84`'s `.catch(() => {})` eats it. → **T3 parses inside `createScheduler`** (Plan B's placement), which also makes the test path and the production path the same path.

4. **The config task's tests were all satisfiable by calling `parse` and discarding the result** — and the three existing stubs are `{parse: x => x}`, making the property undetectable by construction. → **T3 carries Plan C's "fetch receives the PARSED value" test with the explicit instruction that the fixture's parse must transform**, plus the raw-passthrough mutation.

5. **Parse outside the scheduler leaves every direct `createScheduler` caller on unparsed config** while production runs parsed. → Same fix as (3).

6. **T3 and T4 both `dependsOn: [2]` and both edit `src/index.ts`; T1/T2 in Plan C both `dependsOn: []` and both rewrite `serve.ts`.** → **T4 is sequenced behind T3**, and the serialization rule at the head of the decomposition marks T2→T6 strictly sequential.

7. **The handoff sweep was dead code as planned** — one mint site, so it never runs twice, and no test exercised it. → **T4 exercises it by minting twice against `createAuth()` directly**, and `--print-url` is specified to *read* the boot file, not mint.

8. **`unavailable` had no wire path.** T2's failure record lived behind a `health()` the WS frames never carried, so T9's mandated mutation check had no data. → **T2 requires the record to be reachable from `snapshot()`**, and **T6 requires the frames to carry it**.

9. **Exec-action targets are unvalidated client JSON — present in no proposal.** The `exec` arm has no `payloadSchema` (`contract.ts:29-31`), `routes.ts:73` forwards `req.json()` raw, and `buildArgv` validates only the output. The whole discovery-and-classifier apparatus is bypassed by any `${path}` the client sends. → **T8 requires target validation against the discovered repo table**, with its own mutation check.

10. **A regex loosening in one task, and the file it was widened to cover added in another.** This is the Plan 1 failure pattern verbatim (`test/rungit.test.ts:272-288` records it). Both losing proposals do it. → **T1 Ruling A renames instead, leaving `GIT_LITERAL` untouched**, with paired pinning tests proving `cmd:'git'` still trips.

11. **Quoting pre-change code in a later task's brief.** Plan C's T4 instructed changing "line 37" to the pre-T3 key, silently reverting its own dependency. → **T5's brief explicitly forbids quoting pre-T2/T3 line contents.**

12. **The `p-4` packaging trap** — rewriting `main.tsx` removes the only Tailwind utility `scripts/assert-package.ts:108-113` checks for, and the gate is not chained to anything, so it fails at release with a message blaming a Tailwind config problem that does not exist. → Named as a checklist item in **T6** and **T9**, and **T10 chains the gate** to `bun run verify`.

13. **Task 9 is a pure verification pass with no visible output — the obvious thing to cut.** → It is named as the plan's toll, and its content is the consolidated red-then-green record. If it is cut, the plan's central claim is unsupported; say so to whoever executes it.

## What this defers, and the cost

- **The claude, obsidian and mail providers.** Cost: three of Plan 2's four items slip a plan. Mitigated by the fact that all three are cheaper afterwards — claude in particular is one schedule, zero actions, and lands on T2's failure record and T5's redaction seam nearly free. Nothing in this slice blocks them.
- **The TLS measurement (§12 Task 0).** ADR 0001:33-52 records no handshake was ever performed on any bun version; `src/net/tls-connect.ts` is dead code imported only by its own test, whose two cases inject their own `probe` so no socket opens; the installed runtime is 1.3.11, the exact version §7.3 names as returning an empty peer certificate for dual-stack hosts, on a machine running Mullvad with IPv6 blocked. Cost: mail's feasibility stays unproven. **Mitigation: a standalone 30-minute spike scheduled the moment this slice lands** — one real handshake to `imap.gmail.com`, with and without `resolveDualStack`, replacing ADR 0001's "Not measured" section. Doing it first costs nothing; doing it last means discovering mid-task that `engines.bun` must move.
- **§8.5 entirely** — `Bun.secrets` adapter, Promise.race timeout, group/world-readable startup refusal. No provider in this slice needs a credential. Cost: this is the one area where the lowest-scoring proposal had real fidelity the winner lacks. T10 records the required *shape* so the first mail task does not invent it under time pressure.
- **First run (`detect()` → confirm → persist).** `detect()` stays a required contract member with no caller. Cost: §7.1's escape hatches are hand-editable JSON only. T3's frozen-vs-mutable ruling is the one decision first run depends on, and it is taken here.
- **`show diff`** — one of §7.1's four actions. The first screen ships three buttons, not four. All three legal shapes are blocked (T1 Ruling B); the honest alternative is a contract change deserving its own plan.
- **Per-schedule keying of `last`.** Replaced by a documented rule (every schedule branch returns the full merged Data) plus a pinning test. Cost: real deferred debt in `scheduler.ts:5,37` that a **second** multi-schedule provider forces. This is the one place the winner is weaker than Plan C, which fixes it structurally in its T3. Consider promoting it into T2 if the budget allows.
- **The audit log** (spec:127 claims both action kinds go through one; grep for `audit` across `src/` returns nothing). T5 files it or deletes the claim; it is not built.
- **Six tasks before the *real* screen.** T6 gives an authenticated, live-updating fixture screen; T7–T8 produce no new screen, the existing one starts showing real repos. If the plan is abandoned, **T2 and T6 are the coherent stopping points** (wired-but-providerless with a curl round trip; authenticated live screen). Stopping mid-T5 leaves a required contract member rippling through every stub with no consumer — strictly worse than today's clean-if-inert foundation. *(Stopping-point discipline grafted from Plan C.)*

## Open questions for the owner

1. **Provider id: `repos` or keep `git` and loosen the tripwire?** `repos` costs nothing — measured clean under the unmodified `GIT_LITERAL` — while any exemption must cover `id:`, equality comparisons, config lookups and snapshot keys, a surface wider than either losing proposal's paired test. But it diverges from §5's diagram and §6's `src/providers/<id>/` convention, and renames user-facing config keys to `repos.*`. **Default: `repos`.**

2. **Handoff delivery and TTL: long-TTL 0600 file, or 60s + on-demand mint?** A boot-minted handoff with today's process-global 60s (`auth.ts:20`, no `ServeConfig` path) is dead before a systemd-started user reaches the browser. The 60s rationale is `/proc/<pid>/cmdline` exposure, which a 0600 file in a 0700 dir does not have. **Default: long TTL on the file, recorded as an accepted residual.**

3. **`show diff`: defer, external viewer, or widen the contract?** The `tig` precedent already exists (`test/actions.test.ts:81`). Deferring ships three buttons instead of four; the viewer ships four but hard-codes a tool the user may not have; widening the contract (a result channel on `call`) is a change deserving its own plan. **Default: defer, with the three blocked shapes written into the ADR.**

4. **Second provider after the slice: claude or obsidian?** claude is the cheapest real consumer of the status envelope and the redaction seam and has zero actions; obsidian is the only provider that exercises `watch()` against a real filesystem and `detect()`'s `candidates` arm — and it carries an unresolved ruling the reference machine forces (no `daily-notes.json`, no periodic-notes, `newFileLocation: "root"`, and the root holds zero date-named notes while `00 Inbox` holds three). **Default: claude, then obsidian.**