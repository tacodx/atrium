# Atrium Plan 2 — First Light: the repos vertical slice

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the Plan 1 foundation from inert to *running*: one provider (`repos`) delivering real data
through a started scheduler, a redaction seam, a real authentication round trip, a WebSocket push, and a
pane you can look at — end to end, in a browser, with a token that was actually issued.

**Why a slice and not all four providers:** the foundation has never carried a single provider. Building
four against a contract nothing has exercised repeats the mistake the contract's own revision 1 made.
Scoring and reasoning: `docs/superpowers/plans/2026-09-14-plan-2-scoping.md`.

**Architecture:** unchanged from Plan 1 — one bun process, HTTP + WebSocket on 127.0.0.1 behind one
request gate. This plan adds: provider registration through a widened `ServeConfig`, config parsed inside
`createScheduler`, a `POST /api/session` handoff redemption route, a required `toClient` redaction member
on the provider contract, a shared wire protocol in `src/core/wire.ts`, the `repos` provider, and one pane.

**Tech Stack:** bun 1.3.11 + TypeScript, React 19 + Vite 7 + Tailwind v4. **No new runtime dependencies**
— `package.json` dependencies stay react + react-dom. Config schemas are hand-written `.parse` functions
against the shipped structural duck type in `contract.ts`; **zod is not added** (Plan 1's spec text still
says zod; Task 5 reconciles that).

**Design spec:** `docs/superpowers/specs/2026-09-13-atrium-design.md`.
**Inherited open items:** `docs/superpowers/plans/2026-09-14-plan-2-carry-forward.md`.

## Global Constraints

Every task's requirements implicitly include these. Plan 1's constraints all still bind — re-read its
Global Constraints section. The following are **new or newly load-bearing in this plan**.

- **The provider id is `repos`.** Directory `src/providers/repos/`. Config keys are `repos.staleDays`,
  `repos.extraRoots`, `repos.includeDotPaths`, `repos.treatAsContainer`. **Never `git.*`** — config
  lookup is keyed by provider id, so a `git.*` key resolves to `undefined` and falls back silently.
- **`test/rungit.test.ts`'s `GIT_LITERAL` regex is left completely unedited.** The id was chosen to be
  clean under it. Loosening a tripwire in one task while another adds the file it was widened to cover is
  the exact pattern that shipped a bypass in Plan 1.
- **`runGit()` remains the only path to git**, and no `exec` action may reach it — including indirectly
  through a terminal wrapper, which would carry full `process.env` and no hardening prefix.
- **No WebSocket frame may trigger `runNow`, an action, or any subprocess.** Actions go through
  `POST /api/actions/:providerId/:actionId`, which carries the gate, the bearer check and the static
  allowlist. A socket frame has none of it.
- **Every action validates its target against the discovered repo table** before building argv. The
  `exec` arm has no payload schema and the route forwards client JSON unvalidated.
- **`toClient` is a *required* contract member**, never optional-defaulting-to-identity: an author who
  forgets it must fail to compile, not ship secrets silently. It is applied in exactly one place.
- **Tailwind utility classes only in the UI — no `style={{}}` props.** The CSP ships `default-src 'self'`
  with no `style-src` and no `'unsafe-inline'`; inline styles fail silently and the packaging assertion
  uses `fetch`, never a browser, so it can never observe the violation.
- **Keep a literal `p-4` in the rendered tree.** It is the only Tailwind utility the packaging assertion
  checks for, and the entire built stylesheet is two rules.
- **Every security- or correctness-relevant test names the mutation that must turn it red**, and that
  mutation is run red-then-green. Seven tests in this project have been caught passing against
  deliberately broken implementations; this is the standing toll.
- **No test may assert a count or path derived from `$HOME`.** Generated fixtures only.

## Task ordering — load-bearing

**Tasks 2, 3, 4, 5 and 6 all modify `src/server/serve.ts` and/or `src/core/scheduler.ts`. They are
strictly sequential in that order.** Tasks 1 and 7 are the only ones safe to run alongside others
(Task 7 additionally needs Tasks 1 and 3). Never dispatch two of 2–6 concurrently.

**Coherent stopping points**, if the plan is abandoned partway: after **Task 2** (wired but
providerless, verifiable with curl) and after **Task 6** (authenticated live screen against a fixture
provider). **Stopping mid-Task-5 is worse than not starting** — a required contract member ripples
through every stub with no consumer.

---

### Task 1: Rulings ADR and the runGit timeout channel

This task writes down the four cross-cutting decisions every other task in Plan 2 depends on, and adds the one
field of state that Plan 2's repo classifier cannot work without. The ADR (`docs/decisions/0002-slice-rulings.md`)
fixes the provider id as `repos`, defers `show diff`, names the config section `repos.*`, and bans inline `style`
props — four rulings that, left unwritten, produce the exact defects Plan 1 shipped: a regex loosened in one task
to cover a file added in another, and a provider renamed in one task whose config keys were still spelled the old
way in another (an always-`undefined` lookup that falls back silently). The code change adds `timedOut: boolean`
to `GitResult`, because a timed-out `runGit` today returns `code: 1` — measured, byte-identical to a genuine
`git check-ignore -q -- <path>` miss — and §7.1's container row reads "not exit 0" as "not ignored", so every
timed-out probe would silently classify as ambiguous and drop the repo from the dashboard instead of retrying it.
This task touches no file that any other Plan 2 task edits, which is why it is the only one (with T7) safe to run
in parallel with anything.

**Depends on:** nothing. Parallel-safe with every other task in this plan.

**Files:**

- `docs/decisions/0002-slice-rulings.md` — **created.** The Rulings A–D record, plus the measured evidence for the
  `timedOut` channel. Markdown under `docs/`, so the `src/`-only tripwire in `test/rungit.test.ts` never scans it;
  it may quote `'git'` freely.
- `src/core/rungit.ts` — **modified.** Two edits only: add `timedOut: boolean` to the `GitResult` interface
  (line 185) and populate it in the single `res({...})` call (line 201). Plus a doc-comment paragraph above the
  interface (the existing comment occupies lines 176–184).
- `test/rungit.test.ts` — **modified.** One new test inserted after the existing test that ends at line 140, and
  one string change at line 378. `GIT_LITERAL` (line 305), `scanFile` (lines 307–316) and `walk` (318–327) are
  **not** touched.

**Steps:**

- [ ] Confirm the baseline before changing anything: `bun test` reports **118 pass, 0 fail, 226 expect() calls
      across 9 files**, and `bun run typecheck` exits 0. If `typecheck` dies with an ENOENT on `./web-dist`, run
      `bun run build:web` once first — that is carry-forward P2, and T2 fixes it. Do not fix it here.
- [ ] Create `docs/decisions/0002-slice-rulings.md`. Match `docs/decisions/0001-bun-version.md`'s conventions:
      an `# 0002 — Plan 2 slice rulings` H1, then `**Date:** 2026-09-14`, `**Status:** Accepted`, then a
      one-paragraph Context saying these rulings bind every task in Plan 2 (the repos vertical slice) and that
      each exists because a named defect was measured, not anticipated.
- [ ] **Ruling A — the provider id is `repos`, its directory is `src/providers/repos/`, and
      `test/rungit.test.ts:305`'s `GIT_LITERAL` regex is left completely unedited.** Record verbatim the regex as
      it stands:

          const GIT_LITERAL = /(['"`])(?:[^'"`]*[\\/])?git\1/i

      and the measured trip/clean table below (re-measured 2026-09-14 against that exact regex, every row run,
      not reasoned about):

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

      State the consequence in both directions: every string T7 and T8 need is clean under the unmodified regex,
      so the rename costs nothing; and a quoted `'git'` inside a **comment** trips, so provider authors must
      write the binary's name unquoted in prose. State why the alternative was rejected: an "exempt the identifier
      position" loosening would have to cover `id:`, equality comparisons, config lookups and snapshot keys — a
      surface wider than any paired test that would guard it — and layer 4 was widened to all of `src/` as final
      review finding I3 precisely to catch a provider file declaring `cmd: 'git'` (the reasoning is recorded in
      `test/rungit.test.ts:272-288`). Cite the two tests that turn red if the tree ever contains a quoted git
      literal: `test/rungit.test.ts:329` ("no source file calls git outside runGit (tripwire, not a proof)") and
      `test/rungit.test.ts:414` ("the real src/ tree is clean under all four layers"). Note that
      `src/core/rungit.ts` is the one skipped file and `src/core/actions.ts` is exempt from layers 1 and 2 only.
- [ ] **Ruling B — `show diff` is deferred. Plan 2 ships three exec actions on the repos provider, not four.**
      Spec §7.1's action list (spec lines 199–200) names four: open in editor, open terminal at path, show diff,
      open a terminal running `claude`. Write down all three illegal shapes, with citations:
      1. **A direct `exec` action on the git binary is rejected twice over.** At run time
         `buildArgv` throws (`src/core/actions.ts:54-58`, via `GIT_COMMAND` at `:14`), and statically the
         tripwire flags the quoted literal in any file under `src/` (layer 4).
      2. **A terminal wrapper passes `buildArgv` and is the §8.6 RCE re-entered.** `buildArgv` inspects only
         `out.cmd` (`src/core/actions.ts:42-58`), so `{cmd: '/usr/bin/tig', args: ['diff', …]}` — the precedent
         already in `test/actions.test.ts:80-83` — is accepted, and `spawnDetached` (`:97-109`) then runs it with
         `env: process.env` and no hardening prefix. Anything that reaches git that way gets the full environment
         and a hostile repo's `core.fsmonitor`, `diff.external` and `.gitattributes` textconv drivers back.
      3. **A `call` action has no result channel.** The `call` arm's `run` returns `Promise<void>`
         (`src/core/contract.ts:32-34`), `dispatch` returns `Promise<void>` (`src/core/actions.ts:124-130`), and
         `src/server/routes.ts:76` answers a successful dispatch with `{ok: true}` — there is nowhere for a diff
         to come back. Widening the contract with a result channel is a change deserving its own plan.
      Close the ruling with the honest alternative that was not taken: hard-coding an external viewer ships a
      fourth button that depends on a tool the user may not have installed.
- [ ] **Ruling C — the repos provider's config section is `repos.*`, never `git.*`.** The ruling fixes the
      **prefix**: every key this provider reads is `repos.*`. §7.1's four keys are renamed as follows, and later
      tasks in this plan add further `repos.*` keys (Task 8 adds five: `repos.metadataConcurrency`,
      `repos.metadataTimeoutMs`, `repos.editor`, `repos.terminal`, `repos.claudeTerminal`), widening
      `reposConfigSchema`'s unknown-key rejection alongside them. The §7.1 four are:
      `repos.staleDays` (number, default 30 — spec §7.1, spec line 196), `repos.extraRoots` (string[] of
      additional scan roots — spec line 177), `repos.includeDotPaths` (boolean, the dot-prefixed-basename escape
      hatch for chezmoi/yadm/`~/.dotfiles` users — spec line 178), and `repos.treatAsContainer` (the override for
      the classifier's dropped-ambiguous row — spec lines 156 and 169). Record the mechanism that makes the
      spelling load-bearing: **the scheduler looks a provider's config up by its provider id**, in two places —
      the `fetch` call inside `createScheduler`'s `runNow` (`src/core/scheduler.ts:25`) and the `configFor`
      accessor (`src/core/scheduler.ts:63`) — so with `id: 'repos'` a key written `git.staleDays` resolves to
      `undefined` and any `?? 30` fallback swallows it silently. **Describe that mechanism in prose; do not quote
      the current expression at either line.** T3 moves the parse inside `createScheduler`, rewriting both sites;
      what survives T3 unchanged, and what this ruling actually fixes, is the invariant that the lookup key is
      the provider id. State plainly that this ADR **supersedes the spec's own `git.*` spellings at spec lines
      156, 169, 177, 178 and 196 without editing the spec** — no task in this plan edits §7.1, so this document
      is the authoritative record of the rename.
- [ ] **Ruling D — Tailwind utility classes only in `web/`. No `style={{}}` props, no inline `<style>`, no
      injected stylesheet.** Quote the shipped policy exactly — `SECURITY_HEADERS` in `src/server/serve.ts:11-17`
      sends `content-security-policy: default-src 'self'; connect-src 'self' ws://127.0.0.1:${port}
      ws://localhost:${port}; frame-ancestors 'none'` — and name the two properties that make this a ruling
      rather than a style preference: there is **no `style-src` directive and no `'unsafe-inline'`**, so an inline
      style is dropped by the browser with no server-side error; and `scripts/assert-package.ts` drives everything
      through `fetch` (`:42`, `:58`, `:75`, `:96`, `:119`) and never a browser, so the packaging gate can
      **structurally** never observe a CSP violation. The failure mode is a pane that renders unstyled in the
      browser while every automated check stays green. Note that spec §8.9 (spec lines 448–451) states the same
      header set.
- [ ] Add a final ADR section, **"Measured — the `timedOut` channel"**, recording the four execFile shapes
      measured on **bun 1.3.11** (the pinned `engines.bun` floor) on 2026-09-14, each observed, none reasoned
      about:

      | Case | `err.code` | `err.killed` | `err.signal` | what `runGit` reports for `code` today |
      |---|---|---|---|---|
      | `timeout` fires | `null` | `true` | `'SIGTERM'` | **`1`** |
      | child exits 1 | `1` | `false` | `null` | `1` |
      | child exits 0 | (`err` is `null`) | — | — | `0` |
      | binary missing | `'ENOENT'` | `undefined` | `undefined` | `'ENOENT'` |
      | `maxBuffer` exceeded | `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` | `undefined` | `undefined` | that string |

      Then the consequence: a timed-out `runGit` is indistinguishable from a real exit 1 on `code` alone, and
      `git check-ignore -q -- <path>` exits **1** on a miss (measured) while §7.1's container row surfaces a child
      only on exit **0** — so a timeout reads as "not ignored", falls through to the ambiguous row, and the repo
      is dropped. Record that `timedOut` is derived from `err.killed` alone: `killed` is `true` only when this
      process called `kill()`, and `execFile`'s `timeout` option is the only thing that does so here, whereas a
      child killed by an **external** signal (OOM killer, SIGSEGV) reports `killed: false` with `signal` set and
      must not be called a timeout. Record the trip-wire on that reasoning: **if an `AbortSignal` is ever added to
      `runGit`'s execFile options, `killed` becomes `true` on abort too and this derivation must be revisited.**
- [ ] Edit `src/core/rungit.ts` line 185 to read exactly:

          export interface GitResult { stdout: string; stderr: string; code: number | string; timedOut: boolean }

      Required, not optional: the field is produced at the single construction site below, so no caller can be
      left holding a `GitResult` without it, and an optional field would let T7/T8 forget to branch on it.
- [ ] Extend the doc comment above that interface (currently lines 176–184) with a second paragraph carrying, in
      prose, the same three facts the ADR section records: the measured timeout tuple (`err.code === null`,
      `err.killed === true`, `err.signal === 'SIGTERM'`, reported as `code: 1`); why §7.1's classifier makes the
      distinction load-bearing; and why the derivation reads `killed` and not `signal`, with the AbortSignal
      warning. Write the word git **unquoted** in that comment — a quoted `'git'` in a comment trips layer 4, and
      `src/core/rungit.ts` being the one skipped file (`test/rungit.test.ts:332`, `:416`) is not a habit to build.
- [ ] Edit `src/core/rungit.ts` line 201 to read exactly:

          res({ stdout, stderr, code: err ? (err.code ?? 1) : 0, timedOut: err?.killed === true })

      No cast. `@types/node` declares `killed?: boolean` on `ExecException`
      (`node_modules/@types/node/child_process.d.ts:794`) and `ExecFileException extends ExecException` (`:1357`),
      so `err?.killed === true` narrows to `boolean` under `strict`. The existing comment at lines 199–200 already
      says no cast should be added; honour it.
- [ ] Add the new test to `test/rungit.test.ts`, inserted **after line 140** (the closing `})` of "runs the git it
      resolved from PATH, with `--no-optional-locks` before the subcommand", which spans lines 108–140) and before
      the `gitEnvFor` test at line 142. It reuses that test's PATH-shadowing technique, so **no new imports are
      needed** — `mkdtempSync`, `writeFileSync`, `join`, `tmpdir`, `runGit` and `makeRepo` are all already imported
      at lines 2–6. Exact shape:

          test('a timed-out git is reported as timedOut, not as a bare exit 1 indistinguishable from a real miss', async () => {
            const sleepBin = Bun.which('sleep')
            expect(sleepBin).not.toBeNull()          // no vacuous pass if the shim cannot block
            const dir = mkdtempSync(join(tmpdir(), 'atrium-slowgit-'))
            writeFileSync(join(dir, 'git'), `#!/bin/sh\nexec ${sleepBin} 5\n`, { mode: 0o755 })

            const timed = await (async () => {
              const saved = process.env.PATH
              process.env.PATH = dir
              try { return await runGit(tmpdir(), ['status', '--porcelain=v2', '--branch'], { timeoutMs: 250 }) }
              finally { process.env.PATH = saved }
            })()

            expect(timed.code).toBe(1)               // the collision itself: NOT distinguishable on code alone
            expect(timed.timedOut).toBe(true)

            const repo = makeRepo()
            const miss = await runGit(repo, ['check-ignore', '-q', '--', 'not-ignored.txt'])
            expect(miss.code).toBe(1)                // the same code, through the real binary
            expect(miss.timedOut).toBe(false)
          })

      Three details that are load-bearing and were measured, not guessed. The shim's `sleep` must be an
      **absolute** path resolved via `Bun.which`: `gitEnvFor` sets the child's `PATH` to `dirname(gitBin)`
      (`src/core/rungit.ts:168`), which is the shim directory, so a bare `sleep` inside the shim exits 127 with
      "not found" in ~12ms and the run never times out. `exec` is required so `/bin/sh` replaces itself with the
      sleeping process and execFile's SIGTERM reaches it directly, leaving no orphan. And `expect(timed.code)
      .toBe(1)` doubles as the positive guard carry-forward P4 asks for: a shim that fails to block reports 127,
      not 1, so this test cannot pass vacuously. Measured wall time for the timed-out call: ~261ms at
      `timeoutMs: 250`.
- [ ] Change **line 378 only** of `test/rungit.test.ts`, from `join('src', 'providers', 'git', 'actions.ts')` to
      `join('src', 'providers', 'repos', 'actions.ts')`. Leave that test's doc comment (lines 372–376) and the
      four-layer header comment's mention of `src/providers/git/actions.ts` (line 279) exactly as they stand —
      both are a historical record of Plan 1 final-review finding I3, and rewriting history in a comment is not
      this task's business. This is a string-only change with no behavioural effect:
      `scanFile` branches on the path only via `file === ACTIONS_PATH` (`test/rungit.test.ts:312`), both spellings
      are unequal to it, and both `expect` messages on lines 384 and 387 are built from the `providerFile`
      template. It aims the pin at the directory Ruling A actually creates. **Do not touch `GIT_LITERAL`,
      `scanFile`, `walk`, or the declaration's `cmd: 'git'` / `cmd: '/usr/bin/git'` payloads.**
- [ ] Verify Ruling A against the real tree the way the scoping doc specifies, then undo it. Create a throwaway
      `src/providers/repos/index.ts` containing `export const id = 'repos'` and run
      `bun test test/rungit.test.ts` — the tests at lines 329 and 414 stay green. Change that line to
      `export const id = 'git'` and re-run — **both** go red with
      `src/providers/repos/index.ts: references git directly`. Then delete the file and the directory, and confirm
      `git status --short` reports nothing under `src/providers/`. Shipping the provider is T7's; this step only
      proves the ruling holds against the real scanner rather than against a synthetic string.
- [ ] Run the full acceptance set: `bun test` reports **119 pass, 0 fail** across 9 files (118 + the one new
      test), and `bun run typecheck` exits 0. Then confirm the diff is exactly three files —
      `git status --short` shows `?? docs/decisions/0002-slice-rulings.md`, `M src/core/rungit.ts`,
      `M test/rungit.test.ts` and nothing else.

**Tests:**

1. **`a timed-out git is reported as timedOut, not as a bare exit 1 indistinguishable from a real miss`**
   (`test/rungit.test.ts`, new, inserted after line 140). Asserts four things. `Bun.which('sleep')` is non-null,
   so a missing `sleep` fails the test rather than silently producing a fast non-timeout. A `runGit` call whose
   child blocks past `timeoutMs: 250` returns `code === 1` — the collision this field exists to resolve, asserted
   rather than assumed. That same result returns `timedOut === true`. And a real `git check-ignore -q --
   not-ignored.txt` against a `makeRepo()` fixture, through the actual binary, returns `code === 1` with
   `timedOut === false` — the negative half, without which a constant-`true` implementation would pass.
2. **`actions.ts: a synthetic git invocation is caught even though child_process/Bun.spawn are allowed there`**
   (`test/rungit.test.ts:354-370`, pre-existing, unchanged). Already pins that `cmd: 'git'`, `cmd: '/usr/bin/git'`
   and a backtick `` `git` `` are each flagged through `scanFile`, and that `'.gitignore'` and `'legit'` stay
   clean. This task inherits it as the first half of Ruling A's paired pin; it must still be green afterwards.
3. **`a provider declaring an exec action on the git binary is caught too, not just actions.ts`**
   (`test/rungit.test.ts:377-388`, pre-existing, path string updated in this task). Pins that a **provider** file
   declaring `{cmd: 'git'}` or `{cmd: '/usr/bin/git'}` in an exec action is flagged, even though it imports
   nothing and calls no spawn. After the step above it names `src/providers/repos/actions.ts`; the assertions are
   unchanged and must still be green.
4. **`the real src/ tree is clean under all four layers`** (`test/rungit.test.ts:414-419`, pre-existing,
   unchanged) and **`no source file calls git outside runGit (tripwire, not a proof)`**
   (`test/rungit.test.ts:329-336`, pre-existing, unchanged). Ruling A's third pin: the real tree stays clean, and
   the throwaway-provider step above proves it would not have with `id: 'git'`.

**Mutations:**

- **Delete the field.** In `src/core/rungit.ts`, remove `, timedOut: err?.killed === true` from line 201 **and**
  `; timedOut: boolean` from line 185. Expected red: test 1's `expect(timed.timedOut).toBe(true)` fails with
  received `undefined`. (Removing only the line-201 half instead makes `bun run typecheck` fail with a missing-
  property error on the object literal and leaves the suite green — record both directions; the typecheck failure
  is the one that catches a half-done edit.)
- **Constant true.** Change line 201's field to `timedOut: true`. Expected red: test 1's
  `expect(miss.timedOut).toBe(false)` — the `check-ignore` miss. This is the mutation that proves the test is not
  satisfied by an implementation that reports every run as timed out.
- **Any error is a timeout.** Change line 201's field to `timedOut: err !== null`. Expected red: test 1's
  `expect(miss.timedOut).toBe(false)`, since a `check-ignore` miss produces a non-null `err` with `code: 1`.
- **Loosen the tripwire.** Temporarily change `test/rungit.test.ts:305` to
  `/(['"`])(?:[^'"`]*[\\/])?gitzzz\1/i`. Expected red: test 2 (line 354) and test 3 (line 377), both of which
  assert a specific offender string and receive `[]`. **Revert immediately**, then confirm
  `git diff -- test/rungit.test.ts` contains no change to line 305 — Ruling A requires that regex to end this task
  byte-identical to how it started.
- **Not pinned, stated honestly.** The tempting wrong derivation `timedOut: err?.signal != null` **passes test 1**:
  measured, a genuine exit 1 gives `signal: null` and a timeout gives `'SIGTERM'`, so both assertions still hold.
  It differs only for a child killed by an external signal, which this test cannot produce. That derivation is
  excluded by the doc comment and by review, **not** by a test. Do not record it as covered — this project already
  has seven tests found passing against deliberately broken implementations, and the way that number grows is by
  counting a mutation nobody ran.

**Out of scope for this task:**

- **Do not create the repos provider.** `src/providers/repos/{index,config,actions}.ts`, `createReposProvider()`,
  the discovery scan, the validity gate and the five-row classifier are T7 and T8. The only file this task puts
  under `src/providers/` is the throwaway verification file, which must be deleted before the task ends.
- **Do not implement the timeout policy.** Per-repo `timeoutMs` values, concurrency 8–16, and the backoff that
  branches on `timedOut` are T8. T1 ships the channel, not a consumer of it.
- **Do not edit `GIT_LITERAL`, `scanFile`, or `walk`** in `test/rungit.test.ts` (Ruling A), except for the
  temporary, reverted regex mutation above. The only permanent edits to that file are the new test and the
  line-378 path string.
- **Do not add the `afterAll` cleanup** that carry-forward P3 asks of `test/rungit.test.ts` — that is T7's, and
  doing it here collides with T7's edit to the same file. The new test's two `mkdtemp` directories are accounted
  for in T7's pass.
- **Do not fix carry-forward P2** (`typecheck` chaining `gen:assets`, which `readdirSync`s the gitignored
  `./web-dist`) — that is T2, in `package.json`.
- **Do not fix carry-forward P4** (the symlink-hijack test's two vacuous negatives) — that is T10.
- **Do not touch `src/server/serve.ts`, `src/core/scheduler.ts`, `src/core/registry.ts`, `src/core/contract.ts`,
  `src/core/config.ts`, `src/index.ts`, or anything under `web/`.** T2–T6 own those, strictly sequentially. T1 is
  parallel-safe precisely because it touches none of them; adding a "small" edit to one forfeits that.
- **Do not edit the spec.** `docs/superpowers/specs/2026-09-13-atrium-design.md` gets exactly one edit in this
  plan, §6's interface block, and that is T5's. Ruling C supersedes the spec's `git.*` key names **in the ADR**,
  by citing the spec lines, not by rewriting them.
- **Do not ship a `show diff` action**, an external-viewer action, or a result channel on the `call` arm of
  `Action` (Ruling B). Three exec actions, declared in T8.
- **Do not add an `AbortSignal` to `runGit`'s `execFile` options.** It would make `err.killed` true on abort and
  silently break the `timedOut` derivation this task introduces.
- **Do not set up CI, and do not chain `assert:package` to anything** — T10.
- **Do not perform the TLS handshake measurement** or touch `src/net/tls-connect.ts`. Deferred for the whole
  plan; ADR 0001's "Not measured" section stands as written.
- **Do not add a `maxBuffer` test.** The overflow shape is recorded in the ADR as a measured fact so a future
  reader does not have to re-derive it; a `yes`-driven overflow test is flaky and buys nothing this task needs.

---

### Task 2: Turn the foundation on — ServeConfig, registry validation, scheduler lifecycle

Plan 1 shipped a registry and a scheduler that are fully implemented, fully tested, and
completely inert: `src/server/serve.ts` constructs both locally, `ServeConfig` carries no way to
put a provider into the registry, and `scheduler.start()` / `stop()` / `onUpdate()` are called by
nothing. This task turns them on. It widens `ServeConfig` with two optional fields, registers
providers *before* the port binds, adds registry-time validation of the three schedule shapes that
today fail silently at `setInterval`, makes `start()` await its `runOnStart` schedules in
declaration order instead of firing them all in one tick, replaces the two bare `.catch(() => {})`
swallows with a per-schedule failure record that is reachable from `snapshot()`, and makes
`server.stop()` stop the scheduler. It also lands `test/fixtures/provider.ts`, the deterministic
push seam every later task's tests need, and fixes carry-forward P2 so `bun run typecheck` works on
a fresh clone. After this task the server has a real lifecycle with no provider in it yet; T3
(config), T4 (auth), T5 (redaction) and T6 (wire/WS) all land on top of it, strictly in that order,
because every one of them edits these same two files.

**Depends on:** nothing (parallel-safe with T1)

**Files:**
- `src/server/serve.ts` — widen `ServeConfig`; register `cfg.providers` before `Bun.serve`; pass
  `cfg.config` to the scheduler; add `shutdown`; start the scheduler; replace the now-false comment
  at lines 45-55.
- `src/core/scheduler.ts` — `async start()` with ordered `runOnStart`; generation guard; per-schedule
  failure record; `snapshot()` returns the status envelope; `runNow` rejects an unknown schedule;
  `p.watch(...)` wrapped; new exported types.
- `src/core/registry.ts` — three new validation rules inside `register`, all before `providers.set`.
- `scripts/gen-assets.ts` — tolerate a missing `./web-dist`; add `--allow-empty`; filter flags out of
  the positional arguments.
- `package.json` — `typecheck` no longer depends on a built `./web-dist` (carry-forward P2).
- `test/fixtures/provider.ts` — **new.** `makeFixtureProvider()`, whose `watch(cfg, emit)` hands
  `emit` back to the test.
- `test/fixtures/exit-probe.ts` — **new.** Tiny child entry point: start a server with a fixture
  provider, `stop()`, exit. Not a test file (`bun test` only collects `*.test.ts`).
- `test/scheduler-lifecycle.test.ts` — **new.** Scheduler `start`/`stop`/failure-record tests.
- `test/serve-providers.test.ts` — **new.** Serve-level wiring tests.
- `test/gen-assets.test.ts` — **new.** Two tests pinning the P2 fix.
- `test/contract.test.ts` — **edited, additively only.** Four registry-validation tests appended
  inside the existing `describe('registry')`. Do not touch any existing test in this file.
- **Do NOT touch** `src/server/routes.ts`, `src/server/auth.ts`, `src/server/gate.ts`,
  `src/index.ts`, `src/core/contract.ts`, `src/core/actions.ts`, `src/core/rungit.ts`,
  `test/rungit.test.ts`, `test/routes.test.ts`, `test/actions.test.ts`, `web/**`.

---

**Steps:**

*ServeConfig and registration position*

- [ ] In `src/server/serve.ts`, add `import type { Provider } from '../core/contract'`.
      `verbatimModuleSyntax` is on — it must be `import type`, not a value import.
- [ ] Widen `ServeConfig` (currently lines 35-41) by adding exactly two members, **both optional**,
      keeping `port`, `wsAuthTimeoutMs` and `env` byte-identical:
      ```ts
      /** Registered in array order, BEFORE the port binds. */
      providers?: Provider<any, any>[]
      /** Raw config record keyed by provider id; handed straight to createScheduler. */
      config?: Record<string, unknown>
      ```
      Both optional is load-bearing: it keeps all nine existing call sites compiling and behaving
      identically — `src/index.ts:18` and `test/serve.test.ts` lines 21, 34, 41, 70, 86, 108, 136
      and 165 (all verified present at those lines).
- [ ] Do **not** widen `startServer`'s return type. It returns the `Bun.Server` and nothing else.
      Eight call sites do `s.stop()` on that value; returning `{server, scheduler}` breaks all of
      them for no benefit. The scheduler and registry stay unreachable from outside.
- [ ] Delete the twelve-line comment at `serve.ts:45-55` (the one beginning "No providers are
      registered yet") — it asserts the opposite of what is now true. Replace it with a short comment
      recording the two facts that survive: providers are registered here, before `Bun.serve`, so a
      duplicate id throws before the port is bound and before `endpoint.json` is written; and
      `/api/state` plus `POST /api/actions/:providerId/:actionId` already serve whatever this
      registry holds, so this task widens how the registry gets *filled*, not the routes.
- [ ] At the existing construction point (`serve.ts:56-57`), make it exactly:
      ```ts
      const registry = createRegistry()
      for (const p of cfg.providers ?? []) registry.register(p)
      const scheduler = createScheduler(registry, { config: cfg.config ?? {} })
      ```
      The loop must stay **above** the `try { server = Bun.serve(...) }` block. `registry.register`
      throws on a duplicate provider id (`registry.ts:8`) and on a duplicate action id
      (`registry.ts:11`); that throw must escape `startServer` as a rejected promise with the port
      never bound. It is deliberately outside the `try`, which only maps `EADDRINUSE` to exit 78.
- [ ] Leave `createScheduler(registry, { config: ... })`'s call shape alone beyond swapping `{}` for
      `cfg.config ?? {}`. T3 changes what `createScheduler` does with `opts.config`, not this call.

*Registry-time schedule validation*

- [ ] In `src/core/registry.ts`, add three checks inside `register(p)`, placed **after** the existing
      duplicate-action-id loop and **before** `providers.set(p.id, p)`. A provider that fails any
      check must not be half-registered.
- [ ] Rule 1 — duplicate schedule names within one provider. Two schedules named `poll` collide on
      `scheduler.ts`'s `${providerId}:${scheduleName}` key (so they share `previousByKey` and
      `inflight`) *and* register two timers. Throw:
      `duplicate schedule name "${s.name}" in provider "${p.id}"`
- [ ] Rule 2 — `intervalMs` must be a positive integer no greater than `2_147_483_647`. It goes
      straight into `setInterval`. **Measured on the installed bun 1.3.11:**
      `setInterval(fn, 2_147_483_648)` prints `TimeoutOverflowWarning: ... Timeout duration was set
      to 1` and fires **60 times in 120 ms**; `2_147_483_647` fires 0 times in 120 ms. Accept iff
      `Number.isInteger(s.intervalMs) && s.intervalMs > 0 && s.intervalMs <= 2_147_483_647`
      (`Number.isInteger` is already false for `NaN`, `Infinity` and `1.5` — verified). Throw:
      `invalid intervalMs ${String(s.intervalMs)} for schedule "${s.name}" in provider "${p.id}": must be a positive integer <= 2147483647`
- [ ] Rule 3 — `watch` declared with an empty `schedules` array. `scheduler.ts`'s watch branch is
      guarded by `if (p.watch && fallback)` where `fallback = p.schedules[0]`, so such a provider's
      watcher is silently never installed and the provider is inert. Throw:
      `provider "${p.id}" declares watch() but has no schedules: watch emits route into schedules[0]`
- [ ] Do **not** reject a provider with zero schedules and no `watch` — `test/routes.test.ts:12`
      registers exactly that shape and it stays legal.
- [ ] Verified: every existing `registry.register` call site passes all three rules
      (`test/contract.test.ts` lines 19, 20, 31, 39, 40, 48, 70, 88, 103, 115, 132, 160, 178, 196,
      219; `test/routes.test.ts` lines 39, 51, 61, 62, 81; `test/actions.test.ts` lines 125, 133,
      139, 145, 161, 173, 194). No existing test needs editing for this.

*Scheduler: unknown schedule, failure record, snapshot envelope*

- [ ] In `src/core/scheduler.ts`, export the two record types:
      ```ts
      export interface ScheduleHealth {
        lastSuccessAt: number | null      // Date.now() of the last non-aborted success; null if never
        consecutiveFailures: number       // reset to 0 by a success
        lastErrorMessage: string | null   // most recent failure's message; null when not currently failing
      }
      export interface ProviderStatus {
        data?: unknown                              // the provider's most recent Data; absent until the first success
        schedules: Record<string, ScheduleHealth>   // schedule name -> that schedule's health
      }
      export type Scheduler = ReturnType<typeof createScheduler>
      ```
      Put them in `scheduler.ts`, not `contract.ts` — T5 edits `contract.ts` and must not collide
      here. T6 may re-export them from `src/core/wire.ts` with `import type` (erased at runtime, so
      no UI-to-scheduler runtime dependency).
- [ ] Add the record store next to the existing maps:
      `const health = new Map<string, Map<string, ScheduleHealth>>()  // providerId -> scheduleName -> record`
      Nested, not a flat `${id}:${name}` key, because provider ids are unconstrained at registration
      and a `:` in an id would make a flat key ambiguous.
- [ ] Add two private helpers above `runNow`:
      ```ts
      function healthFor(providerId: string, scheduleName: string): ScheduleHealth   // creates {lastSuccessAt:null, consecutiveFailures:0, lastErrorMessage:null} on first touch
      function recordSuccess(providerId: string, scheduleName: string): void         // lastSuccessAt = Date.now(); consecutiveFailures = 0; lastErrorMessage = null
      function recordFailure(providerId: string, scheduleName: string, err: unknown): void  // consecutiveFailures += 1; lastErrorMessage = (err as Error)?.message ?? String(err)
      ```
      `recordSuccess` clearing `lastErrorMessage` to `null` is required, not incidental: T9 renders
      "unavailable" off this record, and a stale error message sitting next to fresh data is exactly
      the ambiguity that mutation check exists to catch.
- [ ] In `runNow`, after the existing `if (!p) throw new Error(...)` provider check (`scheduler.ts:19-20`),
      add the schedule check — today only the provider is validated, so
      `runNow('repos', 'discvoery')` silently starts a run under a key nothing else ever reads:
      ```ts
      if (!p.schedules.some(s => s.name === scheduleName)) {
        throw new Error(`unknown schedule "${scheduleName}" for provider "${providerId}"`)
      }
      ```
      Place it **after** the `inflight` share check so the existing stampede behaviour is unchanged.
- [ ] Wrap `runNow`'s async body in `try` / `catch`, keeping the existing post-await abort guard
      (`if (!ac.signal.aborted)`) on **both** arms:
      - success arm, inside the guard: set `previousByKey`, set `last`, call
        `recordSuccess(providerId, scheduleName)`, then notify listeners. Keep the existing ordering
        of `previousByKey.set` before `last.set` — `test/contract.test.ts:128-155` pins that
        `previousByKey` holds the per-schedule raw value, and T5 will redact only the `last` side.
      - catch arm: `if (!ac.signal.aborted) { recordFailure(providerId, scheduleName, e); notify }`
        then **`throw e`**. Re-throwing is mandatory: `scheduler.ts:80-83`'s existing comment records
        that a direct `await s.runNow(...)` caller must still see failures, and
        `test/scheduler-lifecycle.test.ts` asserts it.
      The `!ac.signal.aborted` guard on the catch arm is equally mandatory: without it every
      `stop()` that lands mid-flight records a phantom failure, because the ordinary way a provider
      honours `ctx.signal` is to throw `AbortError`.
- [ ] Record the failure in **exactly one place** — `runNow`'s catch. The fire-and-forget call sites
      keep a bare `.catch(() => {})` whose only job is preventing an unhandled rejection. Recording
      at both sites would double-count every interval failure.
- [ ] Replace `snapshot: () => Object.fromEntries(last)` with an envelope builder that returns a
      freshly allocated object on every call (never the live record objects — a consumer must not be
      able to mutate the scheduler's state):
      ```ts
      snapshot: (): Record<string, ProviderStatus> => {
        const out: Record<string, ProviderStatus> = {}
        for (const [providerId, perSchedule] of health) {
          const schedules: Record<string, ScheduleHealth> = {}
          for (const [name, h] of perSchedule) schedules[name] = { ...h }
          out[providerId] = last.has(providerId)
            ? { data: last.get(providerId), schedules }
            : { schedules }
        }
        return out
      }
      ```
      `health` is the authoritative id set: every non-aborted success and every non-aborted failure
      writes a health entry, and `last` is only ever written alongside one. A provider that has
      neither succeeded nor failed produces no entry at all, which is what keeps
      `test/contract.test.ts:209`'s `expect(s.snapshot()).toEqual({})` green.
- [ ] Do **not** add a sibling `health()` accessor. The record must be reachable from `snapshot()`
      itself — T6's snapshot/update frames and T9's unavailable-vs-empty check have no other wire.
- [ ] Change `onUpdate`'s listener payload to the status envelope:
      `onUpdate: (fn: (providerId: string, status: ProviderStatus) => void) => ...`
      Listeners are notified on both arms (success and non-aborted failure) with
      `snapshot()[providerId]`, so an update frame carries the failure record without T6 having to
      re-read the snapshot. No existing test registers an `onUpdate` listener that inspects its
      second argument (`test/contract.test.ts:202` only counts calls), so this is additive.
- [ ] Leave `configFor` exactly as it is. T3 owns it.
- [ ] Do **not** key `last` per schedule. That is a documented deferral (a second multi-schedule
      provider forces it); the rule that stands is "every schedule branch returns the full merged
      Data".

*Scheduler: lifecycle*

- [ ] Add `let generation = 0` next to the existing `let started = false`.
- [ ] Rewrite `start()` as an **`async` method returning `Promise<void>`** with this exact shape:
      ```ts
      async start(): Promise<void> {
        if (started) return
        started = true
        const gen = ++generation
        for (const p of registry.all()) {
          for (const s of p.schedules) {
            if (!s.runOnStart) continue
            await runNow(p.id, s.name).catch(() => {})
            if (!started || gen !== generation) return
          }
        }
        if (!started || gen !== generation) return
        installSources()
      }
      ```
      where `installSources()` is a private helper that runs the existing loop over
      `registry.all()` / `p.schedules` pushing `setInterval(() => void runNow(p.id, s.name).catch(() => {}), s.intervalMs)`
      into `timers`, and then the watch branch.
      Four properties, each separately pinned by a test below:
      1. `await` per `runOnStart` schedule, in `registry.all()` order (Map insertion order = the
         order of `cfg.providers`) then `p.schedules` array order. Today `scheduler.ts:73-85` fires
         them in one tick, so repos' 30 s metadata pass would start ~1 s before the 0.97-1.25 s
         discovery scan resolves, on every cold start.
      2. `.catch(() => {})` on the awaited call, never a bare `await`. A bare `await` makes
         `start()` reject whenever a provider's first fetch throws — which would turn
         `test/contract.test.ts:213-243` ("stop() aborting an in-flight run does not produce an
         unhandled rejection") red, because that test calls `s.start()` without awaiting it. The
         failure is still recorded, inside `runNow`.
      3. The `!started` re-check after each await, so a `stop()` mid-pass cancels the rest.
      4. The `gen !== generation` re-check, so a `start()` that was cancelled and replaced by a
         later `start()` cannot resume and install a **second** set of timers and watchers. The
         `started` boolean alone cannot see this: the replacing `start()` has already set it back
         to `true`.
- [ ] `installSources()` must run **after** the `runOnStart` pass, never before.
- [ ] Note and preserve: an `async` function body runs synchronously up to its first `await`. A
      provider set with no `runOnStart` schedule therefore still gets its timers and watchers
      installed synchronously inside the `s.start()` call, which is what keeps
      `test/contract.test.ts:112-126` (watch emits) and `:157-173` (idempotence) green with their
      un-awaited `s.start()`.
- [ ] In `installSources()`, wrap the synchronous `p.watch(...)` call so a throwing watcher cannot
      escape `start()` (and therefore cannot escape `startServer` after the port is bound):
      ```ts
      const fallback = p.schedules[0]
      if (p.watch && fallback) {
        try {
          watchers.push(p.watch(opts.config[p.id] as never, () => void runNow(p.id, fallback.name).catch(() => {})))
        } catch (e) {
          recordFailure(p.id, fallback.name, new Error(`watch() threw: ${(e as Error)?.message ?? String(e)}`))
        }
      }
      ```
      Leave the `opts.config[p.id] as never` argument alone — T3 changes it.
- [ ] `start()` is specified to **never reject**. `stop()` is unchanged apart from nothing: leave
      `started = false`, the `clearInterval` loop, the `w.close()` loop, the `ac.abort()` loop and
      the three resets exactly as they are. Do **not** clear `last` or `health` in `stop()` — a
      restart keeps the last known state so the UI does not flash empty.

*Serve: lifecycle and teardown*

- [ ] In `serve.ts`, immediately after `const cleanup = ...` (currently line 176) add:
      `const shutdown = () => { scheduler.stop(); cleanup() }`
- [ ] Use `shutdown()` in the `SIGTERM` handler and the `SIGINT` handler (currently lines 178-179),
      and in the `server.stop` wrapper (currently lines 186-190) in place of `cleanup()`. Leave
      `process.on('exit', cleanup)` (line 177) alone — it is a last-resort unlink, not a lifecycle.
- [ ] `scheduler.stop()` must precede `originalStop()` in the wrapper. State this as an invariant in
      a comment: the post-await abort guard in `runNow` is the only thing suppressing a notification
      after the server has closed, so the scheduler must be quiesced first. (See the honesty note
      under **Mutations** — this ordering is not observable from T2.)
- [ ] As the last statement before `return server`, add:
      ```ts
      // T6 inserts scheduler.onUpdate(...) -> server.publish here, BEFORE this line.
      void scheduler.start().catch(() => {})
      ```
      Not awaited: a provider's `runOnStart` discovery pass must not delay `startServer`'s
      resolution, `endpoint.json` is already written, and `/healthz` is already answering. The
      `.catch` is defence in depth against a future edit inside `start()`.

*Carry-forward P2 — `bun run typecheck` on a fresh clone*

- [ ] `scripts/gen-assets.ts` currently `readdirSync`es `./web-dist`, which is gitignored, so a
      clean checkout gets an ENOENT stack trace; the friendly message only fires for an
      existing-but-empty directory. `tsc --noEmit` needs `src/generated-assets.ts` to exist because
      `src/server/routes.ts:32` does `import('../generated-assets')`, so the fix cannot be "skip
      generation".
- [ ] Change the argument parsing to filter flags out of the positionals:
      ```ts
      const args = process.argv.slice(2)
      const ALLOW_EMPTY = args.includes('--allow-empty')
      const positional = args.filter(a => !a.startsWith('--'))
      const DIST = positional[0] ?? './web-dist'
      const OUT = positional[1] ?? './src/generated-assets.ts'
      ```
- [ ] Import `existsSync` from `node:fs` and replace the walk call with
      `const files = existsSync(DIST) ? walk(DIST).sort() : []` so a missing directory is the same
      case as an empty one.
- [ ] Zero files **without** `--allow-empty`: keep the current friendly message (extend it to name
      the command) and `process.exit(1)`:
      `gen-assets: no files found under ${DIST} — did you run the vite build first? (bun run build:web)`
- [ ] Zero files **with** `--allow-empty`: write the module anyway (the existing template emits a
      valid `export const ASSET_PATHS: Record<string, string> = {}` when both `imports` and
      `entries` are empty) and warn on stderr:
      `gen-assets: ${DIST} is missing or empty; wrote a stub manifest for typecheck only — this build serves no assets.`
      Exit 0.
- [ ] In `package.json`, change only the `typecheck` script to
      `"typecheck": "bun run scripts/gen-assets.ts --allow-empty && tsc --noEmit"`.
      Leave `gen:assets`, `build:server` and `build` untouched — `build:server` must keep failing
      hard on an empty dist, and `assert:package` remains the end-to-end proof that a real build
      embedded real bytes.

*Fixtures*

- [ ] Create `test/fixtures/provider.ts` exporting `makeFixtureProvider` with exactly this surface
      (every later task's tests consume it, so the names are contractual):
      ```ts
      export interface FixtureProviderOptions<Data = unknown> {
        id?: string                        // default 'fx'
        schedules?: Schedule[]             // default [{ name: 'poll', intervalMs: 3_600_000, runOnStart: false }]
        withWatch?: boolean                // default true; false omits the watch member entirely
        watchThrows?: string               // when set, watch() throws new Error(<value>) instead of installing
        fetch?(cfg: unknown, ctx: FetchCtx<Data>): Promise<Data>   // default async () => ({ ok: true } as Data)
        configSchema?: { parse(x: unknown): unknown }              // default { parse: (x: unknown) => x }
        detect?(): Promise<DetectResult<any>>                      // default async () => ({ kind: 'nothing-to-detect' })
        actions?: Provider<any, any>['actions']                    // default []
        toClient?(data: Data): unknown     // T5 adds the required contract member; declared HERE, above
                                           // the overrides spread, so a test can replace it. The default
                                           // is an explicit allowlist over the default Data, NEVER
                                           // identity — an identity default makes every redaction and
                                           // redaction-ordering property in T5, T6 and T9 undetectable
                                           // by construction.
      }
      export interface FixtureProvider<Data = unknown> extends Provider<any, Data> {
        emit(): void                       // calls the scheduler's emit callback
        setData(d: Data): void             // what the next fetch() resolves to
        setWire(v: unknown): void          // what toClient() returns next, INCLUDING a value that
                                           // JSON.stringify throws on (T6 test 6 needs a circular one).
                                           // Overrides the opts.toClient default once called.
        waitForWatch(timeoutMs?: number): Promise<void>   // default 1000; rejects on timeout
        readonly calls: ReadonlyArray<{ schedule: string; cfg: unknown; previous: unknown }>
        readonly fetchCount: number        // === calls.length
        countFor(scheduleName: string): number
        readonly watchCalls: number        // how many times the scheduler called watch()
        readonly watchInstalled: boolean   // true once watch() has returned a Disposable
        readonly closeCalls: number        // how many times the returned Disposable was closed
      }
      export function makeFixtureProvider<Data = unknown>(opts?: FixtureProviderOptions<Data>): FixtureProvider<Data>
      ```
      `emit()` before the scheduler has installed the watcher must throw
      `fixture provider "<id>": emit() called before the scheduler installed watch()` — a silent
      no-op there is exactly the flake this fixture exists to prevent. `watch()` stores the emit
      callback, increments `watchCalls`, sets `watchInstalled`, and returns
      `{ close() { closeCalls++ } }`.
- [ ] Create `test/fixtures/exit-probe.ts`: read a port from `process.argv[2]`, build a fixture
      provider with `schedules: [{ name: 'poll', intervalMs: 20, runOnStart: true }]`,
      `await startServer({ port, providers: [p], config: { fx: {} } })`, `await Bun.sleep(100)`,
      `s.stop()`. No explicit `process.exit` — the point of the probe is that the process exits on
      its own.

---

**Tests:**

New serve-level tests use ports **7430-7433**, per the plan-wide port ledger below.
**Port ledger for Plan 2 — one table, published once and pasted into every brief that binds a port.
Do not re-derive it; a range not listed against your task is not yours.**

| Range | Owner |
|---|---|
| 7373 | `scripts/assert-package.ts` (existing) |
| 7391-7403 | `test/serve.test.ts` (existing) |
| 7404-7411 | Task 4 |
| 7412-7421 | Task 6 |
| 7422-7423 | Task 3 |
| 7424 | Task 9 |
| 7430-7433 | Task 2 |
 Every serve-level test
passes `env: { XDG_RUNTIME_DIR: <mkdtempSync scratch> }` and removes the scratch directory in a
`finally`, per carry-forward P3.

*`test/contract.test.ts` — appended inside `describe('registry')`, additive only*

- [ ] **"rejects two schedules with the same name in one provider"** — a provider with schedules
      `poll`/`poll` throws `/duplicate schedule name/i`.
- [ ] **"rejects an intervalMs that setInterval cannot honour"** — four registrations must each
      throw `/positive integer <= 2147483647/`: `intervalMs: 0`, `-1`, `1.5`, and `2_147_483_648`.
      The last is the measured overflow case (fires every 1 ms, 60 ticks in 120 ms on bun 1.3.11).
- [ ] **"rejects watch() declared with no schedules"** — `{ schedules: [], watch: () => ({close(){}}) }`
      throws `/watch\(\) but has no schedules/`. A provider with `schedules: []` and **no** `watch`
      registers without throwing (asserted in the same test — this is `test/routes.test.ts:12`'s
      shape).
- [ ] **"a provider rejected for an invalid schedule is not registered"** — after the throw,
      `r.get('fx')` is `undefined` and `r.all()` is `[]`.

*`test/scheduler-lifecycle.test.ts` — new*

- [ ] **"runNow rejects an unknown schedule name"** — `s.runNow('fx', 'discvoery')` rejects with
      `/unknown schedule "discvoery" for provider "fx"/`; the fixture's `fetchCount` stays 0.
- [ ] **"runOnStart schedules run in declaration order, each awaited before the next"** — a fixture
      with `a` (runOnStart, its fetch sleeps 30 ms and pushes `a-start`/`a-end`) and `b` (runOnStart,
      pushes `b-start` and captures whether `a` had finished). `await s.start()`; assert the order
      array is exactly `['a-start', 'a-end', 'b-start']` and that `b` observed `a` as finished.
- [ ] **"intervals and watchers are installed only after the runOnStart pass completes"** — same
      fixture shape plus `withWatch: true`. Call `const started = s.start()` **without** awaiting,
      `await Bun.sleep(5)`, assert `p.watchInstalled === false`; then `await started` and assert
      `p.watchInstalled === true`.
- [ ] **"stop() during the runOnStart pass cancels the remaining schedules"** — start without
      awaiting, `await Bun.sleep(5)`, `s.stop()`, `await started`; the order array is
      `['a-start', 'a-end']` with no `b-start`, and `p.watchInstalled === false`.
- [ ] **"a start() cancelled mid-pass installs no sources for the generation that replaced it"** —
      `const first = s.start()`, `await Bun.sleep(5)`, `s.stop()`, `const second = s.start()`,
      `await second`, `await first`; assert `p.watchCalls === 1`. (`watchCalls` is the observable
      proxy for "one set of sources"; the timer array is not reachable from outside.)
- [ ] **"a failing fetch is recorded in snapshot(), not swallowed"** — fixture whose fetch throws
      `new Error('boom')`. `await s.runNow('fx','poll')` inside a try/catch must have thrown (direct
      awaiters still see failures). Then `s.snapshot().fx` is defined, `.data` is `undefined`, and
      `.schedules.poll` deep-equals
      `{ lastSuccessAt: null, consecutiveFailures: 1, lastErrorMessage: 'boom' }`.
- [ ] **"consecutive failures accumulate and a success clears the record"** — fail, fail
      (`consecutiveFailures === 2`), then flip the fixture to succeed and run again:
      `consecutiveFailures === 0`, `lastErrorMessage === null`, `lastSuccessAt` is a number `> 0`,
      and `snapshot().fx.data` deep-equals the fixture's returned data.
- [ ] **"a run aborted by stop() is not counted as a failure"** — fixture whose fetch sleeps 30 ms
      then throws. Kick off `runNow` without awaiting, call `s.stop()`, await the promise inside a
      try/catch (it must throw), `await Bun.sleep(10)`, then assert `s.snapshot()` deep-equals `{}`.
- [ ] **"a throwing watch() is recorded and start() still resolves"** — fixture with
      `watchThrows: 'nope'` and one non-runOnStart schedule. `await s.start()` must resolve (not
      reject); `snapshot().fx.schedules.poll.lastErrorMessage` matches `/watch\(\) threw: nope/` and
      `consecutiveFailures === 1`.
- [ ] **"stop() closes every installed watcher"** — `await s.start()`, `s.stop()`, assert
      `p.closeCalls === 1`. (Test-only addition: `w.close()` is existing untested behaviour.)
- [ ] **"a watch emit routes into the first declared schedule"** — `await s.start()`,
      `await p.waitForWatch()`, `p.emit()`, `await Bun.sleep(10)`, assert
      `p.countFor('<first schedule name>') === 1` and the second schedule's count is 0. This is the
      deterministic push seam; it must not be written as a `runOnStart` race.

*`test/serve-providers.test.ts` — new*

- [ ] **"a registered provider is actually polled by the running server"** (port 7430) — fixture with
      `schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: true }]`;
      `await startServer({ port: 7430, providers: [p], config: { fx: {} }, env })`,
      `await Bun.sleep(20)`, assert `p.fetchCount === 1` and `p.calls[0].schedule === 'poll'`, then
      `s.stop()`.
- [ ] **"a duplicate provider id throws before the port binds"** (port 7431) — call `startServer`
      with `providers: [makeFixtureProvider({id:'fx'}), makeFixtureProvider({id:'fx'})]` inside a
      try/catch; assert it threw `/duplicate provider id/i`. **Then bind a plain
      `Bun.serve({ hostname:'127.0.0.1', port: 7431, fetch: () => new Response('free') })`** — it
      must succeed, proving the port was never taken — and stop it. This assertion is what pins the
      *position* of the registration loop, not merely the throw.
- [ ] **"server.stop() stops the scheduler"** (port 7432) — fixture with
      `schedules: [{ name: 'poll', intervalMs: 20, runOnStart: false }]`; start, `await Bun.sleep(80)`,
      capture `const before = p.fetchCount` and assert `before > 0`; `s.stop()`;
      `await Bun.sleep(80)`; assert `p.fetchCount === before`.
- [ ] **"a process with a registered provider exits after stop()"** (port 7433) — spawn
      `[process.execPath, 'run', 'test/fixtures/exit-probe.ts', '7433']` with
      `XDG_RUNTIME_DIR` pointed at the scratch dir; race `proc.exited` against `Bun.sleep(5000)`;
      on timeout `proc.kill('SIGKILL')` and fail. Assert the exit code is 0. **Measured on bun
      1.3.11:** a server whose `stop()` ran exits 0, while the same process with one uncleared
      `setInterval` is still alive after 5 s — so this test is genuinely falsifiable.
- [ ] **"startServer with no providers is unchanged"** — no new test. The eight existing
      `test/serve.test.ts` cases already assert this and must stay green.

*`test/gen-assets.test.ts` — new*

- [ ] **"a missing web-dist fails with the friendly message, not an ENOENT stack trace"** — spawn
      `[process.execPath, 'run', 'scripts/gen-assets.ts', '<scratch>/nope', '<scratch>/out.ts']`;
      exit code 1, stderr contains `did you run the vite build first`, stderr does **not** contain
      `ENOENT`.
- [ ] **"--allow-empty writes a stub manifest so a fresh clone can typecheck"** — spawn with
      `['--allow-empty', '<scratch>/nope', '<scratch>/out.ts']` (flag **first**, to pin the
      positional filter); exit code 0, `<scratch>/out.ts` exists and contains
      `export const ASSET_PATHS`.
- [ ] Both tests write only inside an `mkdtempSync` scratch directory removed in a `finally`. Neither
      may pass the default `OUT` — clobbering the real `src/generated-assets.ts` would be a
      cross-test hazard.

*Acceptance*

- [ ] `bun test` green, with all 118 pre-existing tests still passing —
      `test/contract.test.ts:157-192` (idempotence and start→stop→start) and `:194-243` (quiescent
      stop, no unhandled rejection) in particular.
- [ ] `bun run typecheck` green **from a fresh clone with no `web-dist`** — this is the P2
      acceptance criterion, so verify it by moving `web-dist` and `src/generated-assets.ts` aside
      first.

---

**Mutations:** each line is the exact edit to make, and the named test that must go red.

- [ ] Move the `for (const p of cfg.providers ?? []) registry.register(p)` loop in `serve.ts` to
      below the `Bun.serve` try/catch → **"a duplicate provider id throws before the port binds"**
      (the follow-up `Bun.serve` on 7431 fails with `EADDRINUSE`).
- [ ] Delete `void scheduler.start().catch(() => {})` from `serve.ts` → **"a registered provider is
      actually polled by the running server"** (`fetchCount` stays 0).
- [ ] Change `serve.ts`'s `const shutdown = () => { scheduler.stop(); cleanup() }` to
      `const shutdown = () => { cleanup() }` → **"server.stop() stops the scheduler"** and
      **"a process with a registered provider exits after stop()"**.
- [ ] In `scheduler.start()`, replace `await runNow(p.id, s.name).catch(() => {})` with
      `void runNow(p.id, s.name).catch(() => {})` → **"runOnStart schedules run in declaration
      order, each awaited before the next"** (order becomes `['a-start','b-start','a-end']`).
- [ ] Move `installSources()` above the `runOnStart` loop in `start()` → **"intervals and watchers
      are installed only after the runOnStart pass completes"**.
- [ ] Delete the `if (!started || gen !== generation) return` line that follows the await →
      **"stop() during the runOnStart pass cancels the remaining schedules"** (`b-start` appears).
- [ ] Weaken that same guard to `if (!started) return` (drop the generation half) → **"a start()
      cancelled mid-pass installs no sources for the generation that replaced it"**
      (`watchCalls === 2`).
- [ ] Delete `recordFailure(...)` from `runNow`'s catch arm → **"a failing fetch is recorded in
      snapshot(), not swallowed"** (`snapshot().fx` is undefined).
- [ ] Remove `throw e` from `runNow`'s catch arm → **"a failing fetch is recorded in snapshot(), not
      swallowed"** (the try/catch around `runNow` never sees a throw).
- [ ] Make the catch arm's guard unconditional (drop `if (!ac.signal.aborted)`) → **"a run aborted by
      stop() is not counted as a failure"** (`snapshot()` is no longer `{}`).
- [ ] In `recordSuccess`, drop `lastErrorMessage = null` → **"consecutive failures accumulate and a
      success clears the record"**.
- [ ] In `recordSuccess`, drop `consecutiveFailures = 0` → same test.
- [ ] Remove the `try` / `catch` around `p.watch(...)` in `installSources()` → **"a throwing watch()
      is recorded and start() still resolves"** (`await s.start()` rejects).
- [ ] Delete `for (const t of timers) clearInterval(t)` from `stop()` → **"a process with a
      registered provider exits after stop()"** (child never exits) and **"server.stop() stops the
      scheduler"**.
- [ ] Delete `for (const w of watchers) w.close()` from `stop()` → **"stop() closes every installed
      watcher"**.
- [ ] Revert `snapshot()` to `Object.fromEntries(last)` → **"a failing fetch is recorded in
      snapshot(), not swallowed"** and **"consecutive failures accumulate and a success clears the
      record"**.
- [ ] Delete the `unknown schedule` check from `runNow` → **"runNow rejects an unknown schedule
      name"**.
- [ ] Delete the duplicate-schedule-name check from `registry.register` → **"rejects two schedules
      with the same name in one provider"**.
- [ ] Relax the interval check to `typeof s.intervalMs === 'number'` → **"rejects an intervalMs that
      setInterval cannot honour"** (all four cases).
- [ ] Drop only the `<= 2_147_483_647` half of the interval check → same test (the
      `2_147_483_648` case).
- [ ] Delete the watch-with-no-schedules check → **"rejects watch() declared with no schedules"**.
- [ ] Move `providers.set(p.id, p)` above the schedule validation in `registry.register` → **"a
      provider rejected for an invalid schedule is not registered"**.
- [ ] Remove the `existsSync(DIST)` guard from `scripts/gen-assets.ts` → **"a missing web-dist fails
      with the friendly message, not an ENOENT stack trace"**.
- [ ] Make zero files always `process.exit(1)` regardless of `--allow-empty` → **"--allow-empty
      writes a stub manifest so a fresh clone can typecheck"**.
- [ ] Have `emit()` no-op instead of throwing when the watcher is not installed → **"a watch emit
      routes into the first declared schedule"** would silently pass with count 0, so instead assert
      the fixture's own guard directly in that test (`expect(() => p2.emit()).toThrow(/before the
      scheduler installed/)` on a never-started scheduler).

*Two honesty notes — do not paper over these with a test that cannot fail.*

- [ ] **`scheduler.stop()` before `originalStop()` is not observable from T2.** Both calls are
      synchronous and land in the same tick, so no in-flight run can resume between them; the
      scoping doc's "move `scheduler.stop()` after `originalStop()` → publish-after-close test goes
      red" only bites once T6 has a real `onUpdate → server.publish` wire. Implement the ordering
      and comment it as an invariant; the falsifiable half T2 *can* pin is "`shutdown` calls
      `scheduler.stop()` at all", which is the mutation listed above.
- [ ] **The `.catch(() => {})` on `void scheduler.start()` in `serve.ts` is not independently
      pinned.** `start()` is specified never to reject, so removing the `.catch` alone turns nothing
      red. It stays as defence in depth against a future edit inside `start()`; the real protection
      is the `try`/`catch` around `p.watch(...)`, which **is** pinned.

---

**Out of scope for this task:**

- Reading or parsing `config.json`, `src/core/config.ts`, `configDir()`, calling
  `p.configSchema.parse`, and the frozen-vs-mutable config ruling — **all T3**. T2 passes
  `cfg.config ?? {}` through untouched and does not edit `src/index.ts`.
- `mintHandoff`/`consumeHandoff` changes, `POST /api/session`, the boot-minted 0600 handoff file,
  `atrium open --print-url`, and anything in `src/server/auth.ts` — **all T4**. The two auth-line
  mutation checks belong there.
- `toClient`, redaction, any change to `src/core/contract.ts`, and reconciling spec §6 — **all T5**.
  T2 must leave the raw `data` flowing into `last` and into the listener payload; T5 is the task
  that makes `last`'s value the redacted one. Do not pre-emptively add a `toClient` member.
- `src/core/wire.ts`, `STATE_TOPIC`, `ws.subscribe`, `scheduler.onUpdate → server.publish`, any
  frame type, `web/src/lib/*`, `web/src/main.tsx`, the `p-4` packaging trap — **all T6**. T2 only
  leaves the marked insertion point above `void scheduler.start()`.
- The `repos` provider, `src/providers/**`, `test/fixtures/gitrepo.ts`, config keys `repos.*` —
  **T7/T8**. T2 registers zero providers in `src/index.ts`; the server runs providerless until T7.
- `web/src/panes/ReposPane.tsx` and the unavailable-vs-empty render — **T9**. T2's only obligation
  is that the record reaches `snapshot()`.
- `bun run verify`, chaining `assert:package`, CI, the dev-loop documentation, carry-forward P4 —
  **T10**. T2 changes only the `typecheck` script.
- ADR `docs/decisions/0002-slice-rulings.md` and `timedOut` on `GitResult` — **T1**.
- Do not edit `test/rungit.test.ts` at all; its `GIT_LITERAL` regex stays byte-identical.
- Do not add zod or any dependency. `package.json`'s `dependencies` stay `react` + `react-dom`.
- Do not widen `startServer`'s return type, do not expose the scheduler or registry from it, and do
  not add a `registry` field to `ServeConfig` (providers-in, registry-internal).
- Do not tighten `RouteCtx.snapshot()`'s type in `src/server/routes.ts` from
  `Record<string, unknown>`. `Record<string, ProviderStatus>` is already assignable to it, and
  tightening breaks `test/routes.test.ts:26`'s `() => ({ git: { ok: true } })` stub.
- Do not add a sibling `health()` accessor, do not key `last` per schedule, do not clear `last` or
  `health` in `stop()`, do not `.unref()` the timers, and do not add a WS refresh/run frame.
- Do not reject a provider with zero schedules and no `watch` — that shape is in use today.

---

### Task 3: Config — parse inside createScheduler

This task gives Atrium a config file and makes the scheduler the one place a provider's config
is ever parsed. A new `src/core/config.ts` reads `$XDG_CONFIG_HOME/atrium/config.json` (via the
existing `configDir()`), treats a missing file as `{}`, fails loudly on anything malformed, and
hands the raw top-level record to `startServer({ config })`. `createScheduler` then calls each
registered provider's `configSchema.parse(raw[p.id])` **once, at construction**, stores the
parsed value, and serves that same parsed value to `fetch`'s `cfg`, to `configFor`, and to
`watch`'s `cfg`. It exists here — rather than in the serve path, where both losing proposals put
it — because every direct `createScheduler` caller (all of `test/contract.test.ts`, and every
provider unit test Tasks 7–9 will write) would otherwise run against *unparsed* config while
production runs parsed, so provider defaults would be tested in a shape that never ships. Parsing
at construction rather than lazily also keeps a rejecting parse in front of `startServer`'s
`process.exit(78)` path instead of behind the scheduler's fire-and-forget error handling, where a
bad config would degrade into a silently failing poll.

**Depends on:** Task 2.

Task 2 widened `ServeConfig` with optional `providers` and `config`, moved provider registration
ahead of `createScheduler` inside `startServer`, and reworked `start()`. Two things in Task 2's
result are load-bearing here and must be confirmed before you begin:

1. Inside `startServer`, every provider from `cfg.providers` is registered **before**
   `createScheduler(...)` is called. Construction-time parsing reads `registry.all()`, so a
   provider registered after construction gets no parsed entry.
2. `startServer` passes its `cfg.config` through to `createScheduler` rather than a hardcoded
   empty object. Expected: already done by Task 2. If it is not, make that single one-line
   wiring change in `src/server/serve.ts` and say so in your completion report as a Task 2 gap
   you closed. Do not make any other edit to `src/server/serve.ts` from this task.

---

**Files:**

- `src/core/config.ts` — **new.** Exports `CONFIG_FILENAME`, `configFilePath(env)`,
  `loadConfig(env)` and the `ConfigError` class. No top-level side effects (it is imported by
  `src/core/scheduler.ts`, which unit tests import constantly).
- `src/core/scheduler.ts` — **modified.** `createScheduler` gains a construction-time parse loop
  and an internal `cfgFor(providerId)` accessor. Three existing read sites switch from the raw
  record to `cfgFor`: the `p.fetch(...)` call inside `runNow`, the exported `configFor`, and the
  `p.watch(...)` call inside `start()`. The `opts.config` parameter type widens to
  `Readonly<Record<string, unknown>>`.
- `src/index.ts` — **modified.** The `serve` case loads the config and passes it to
  `startServer`; a `ConfigError` from either the load or the provider parse prints to stderr and
  exits 78.
- `test/config.test.ts` — **new.** All seventeen tests below.
- `src/server/serve.ts` — **conditional, one line only**, and only in the case described under
  *Depends on* point 2.

Do **not** touch `docs/decisions/0002-slice-rulings.md` (Task 1 owns it),
`src/core/contract.ts` (Task 5 owns the next change to it), `src/core/registry.ts`, or
`test/rungit.test.ts`.

---

**Steps:**

Line numbers below are as of the Plan 1 merge (`450dc64`); Task 2 has since edited
`src/core/scheduler.ts` and `src/server/serve.ts`, so locate every site by **symbol name**, and
treat a line number as a hint only.

- [ ] Read `src/core/scheduler.ts` as Task 2 left it before editing anything. You need to know
      where `start()`'s `runOnStart` loop and failure record now live so your parse loop does not
      collide with them.

- [ ] Create `src/core/config.ts`. Import `join` from `node:path`, `readFileSync` from
      `node:fs`, and `configDir` from `./paths`.

- [ ] In `config.ts`, export `export const CONFIG_FILENAME = 'config.json'` and
      `export function configFilePath(env: NodeJS.ProcessEnv = process.env): string` returning
      `join(configDir(env), CONFIG_FILENAME)`. `configDir` is at `src/core/paths.ts:31-33`; it
      resolves to `${XDG_CONFIG_HOME || ~/.config}/atrium`. (The Plan 2 scoping doc says
      `configDir()` has "no caller today" — that is stale: `endpointPath` at
      `src/core/paths.ts:41` already calls it. It has no caller *outside* `paths.ts`. Nothing
      about this task changes as a result.)

- [ ] In `config.ts`, export `ConfigError`:
      ```ts
      export class ConfigError extends Error {
        constructor(message: string, options?: ErrorOptions) {
          super(message, options)
          this.name = 'ConfigError'
        }
      }
      ```
      This is the single type `src/index.ts` keys its exit-78 branch on. Every user-facing config
      failure — file-level or provider-level — must be a `ConfigError`, and nothing else in the
      codebase may throw one.

- [ ] In `config.ts`, export
      `loadConfig(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, unknown>>` with
      exactly this behaviour, in this order:
      1. `const path = configFilePath(env)`.
      2. Read `path` with `readFileSync(path, 'utf8')` inside a `try`. If the caught error's
         `code` is `'ENOENT'`, return `Object.freeze({})` — a missing config file is the normal
         first-run state, not an error. For **any other** read failure (`EACCES`, `EISDIR`, …)
         throw ``new ConfigError(`invalid config: ${path} could not be read`, { cause })``.
         Running on defaults because the user's config file is unreadable is precisely the silent
         fallback this plan exists to eliminate.
      3. If the file's contents are empty or whitespace-only (`text.trim() === ''`), return
         `Object.freeze({})`. `touch config.json` is a plausible user action with no ambiguous
         meaning; do not route it through `JSON.parse`.
      4. `JSON.parse` the text inside a `try`; on failure throw
         ``new ConfigError(`invalid config: ${path} is not valid JSON`, { cause })``.
      5. Reject a non-object top level: if the parsed value is `null`, an array, or not
         `typeof === 'object'`, throw
         ``new ConfigError(`invalid config: ${path} must contain a JSON object at the top level, got ${describe(value)}`)``
         where `describe` is a local (unexported) helper returning `'an array'` for arrays,
         `'null'` for null, and `typeof value` otherwise.
      6. Return `Object.freeze(value as Record<string, unknown>)`.

- [ ] In `config.ts`, add a module doc comment recording the two rulings this task takes, both of
      which later tasks depend on:
      - **No zod, and no new dependency.** `package.json`'s `dependencies` are `react` and
        `react-dom` only, and `src/core/contract.ts:38` types `configSchema` as the structural
        duck type `{ parse(x: unknown): Cfg }`. Every provider hand-writes its own `.parse`.
      - **Config is frozen and non-live.** `loadConfig` shallow-freezes the top-level record, and
        `createScheduler` snapshots each provider's parsed value at construction, so there is no
        reload mechanism in this plan: a config change requires a restart. The freeze is
        deliberately **shallow** — nested objects are not deep-frozen, and a `parse` that returns
        its input by reference hands the provider a mutable object. Providers must treat `cfg` as
        read-only. First run (`detect()` → confirm → persist) is deferred; it will need a writer,
        and this ruling is what it must be built against.

- [ ] In `src/core/scheduler.ts`, import `ConfigError` from `./config` (type-only imports are not
      applicable — `ConfigError` is a value). Widen the parameter type on `createScheduler` from
      `opts: { config: Record<string, unknown> }` to
      `opts: { config: Readonly<Record<string, unknown>> }`. Every existing call site still
      compiles: `test/contract.test.ts` passes object literals and `startServer` passes a
      `Record<string, unknown>`, both assignable to the readonly form.

- [ ] In `createScheduler`, immediately after the existing `let started = false` declaration and
      **before** `runNow` is defined, add the construction-time parse loop:
      ```ts
      // The ONE parse site in the system. It is here, not in startServer's
      // config-loading path, because every direct createScheduler caller —
      // test/contract.test.ts and every provider unit test — would otherwise
      // run on unparsed config while production runs parsed. It is at
      // construction, not lazily on first fetch, because start()'s poll path
      // swallows rejections: a lazy parse turns a bad config into a silently
      // failing provider instead of a startup failure the CLI can exit 78 on.
      const parsed = new Map<string, unknown>()
      for (const p of registry.all()) {
        try {
          parsed.set(p.id, p.configSchema.parse(opts.config[p.id]))
        } catch (cause) {
          throw new ConfigError(`invalid config for provider "${p.id}"`, { cause })
        }
      }
      ```
      Note what this does when a provider has **no** section in the file: it still calls
      `parse(undefined)`, so a schema that supplies defaults gets the chance to. Do not add an
      `if (opts.config[p.id] === undefined) continue` guard — that is the exact shape of the
      silent-default defect this plan is written against (a `repos.staleDays` lookup that is
      always `undefined` and always falls back to 30 without anyone noticing).

- [ ] Directly below the loop, add the internal accessor:
      ```ts
      function cfgFor(providerId: string): unknown {
        if (parsed.has(providerId)) return parsed.get(providerId)
        // A provider present in the registry but absent from `parsed` was
        // registered after construction, so its config was never parsed.
        // Serving the raw value here would be the silent half-parsed state
        // this task exists to make impossible.
        if (registry.get(providerId)) {
          throw new Error(
            `provider "${providerId}" was registered after the scheduler was constructed; its config was never parsed`,
          )
        }
        // A config section with no provider: the action layer and tests read
        // these, and they have never been parseable by anyone.
        return opts.config[providerId]
      }
      ```
      The final fallback is not optional: `test/contract.test.ts:81` asserts
      `s.configFor('git')` returns `{ roots: ['/src'] }` in a scheduler where only `obsidian` is
      registered, and `:82` asserts `s.configFor('absent')` is `undefined`.

- [ ] Replace all three raw-config reads inside `createScheduler` with `cfgFor`:
      - the `p.fetch(...)` call in `runNow` (was `opts.config[providerId] as never`, ~line 25) →
        `cfgFor(providerId) as never`;
      - the exported `configFor` (was `opts.config[providerId]`, ~line 63) →
        `cfgFor(providerId)`, keeping its existing doc comment;
      - the `p.watch(...)` call inside `start()` (was `opts.config[p.id] as never`, ~line 92) →
        `cfgFor(p.id) as never`.
      After this edit,
      `grep -n 'opts\.config\[' src/core/scheduler.ts | grep -vE ':\s*(//|\*)'` must return
      exactly two lines, both inside the parse loop and `cfgFor`. Run that grep and check it.

      > **CORRECTED after Task 3 (fix round 1, finding F2).** This gate originally read
      > `grep -n 'opts\.config\[' src/core/scheduler.ts` must return exactly two lines, and it
      > was **unsatisfiable at every commit**: `git show 450dc64:` and `git show 117168e:` both
      > return 4, and HEAD returns 3. The third HEAD hit is the parse-loop comment whose
      > sentence *this brief itself prescribes* (`There is deliberately no
      > `if (opts.config[p.id] === undefined) continue``), so obeying the brief's comment text
      > and satisfying the brief's own grep were mutually exclusive. The comment-filtered form
      > above is what the gate was actually measuring; verified returning exactly 2 against the
      > post-fix-round tree. Task 10 must use the corrected form.

- [ ] In `src/index.ts`, add `import { loadConfig, ConfigError } from './core/config'` and
      rewrite the body of the `serve` case's `await startServer(...)` as:
      ```ts
      try {
        // Providers are registered through ServeConfig.providers; nothing
        // registers one yet — that wiring lands with the repos provider.
        await startServer({ port, config: loadConfig() })
      } catch (e) {
        if (e instanceof ConfigError) {
          console.error(`atrium: ${e.message}`)
          if (e.cause instanceof Error) console.error(`atrium: ${e.cause.message}`)
          process.exit(78)   // EX_CONFIG, same convention as src/index.ts:16 and src/server/serve.ts:150
        }
        throw e
      }
      ```
      One `try` covers both failure sources on purpose: `loadConfig()`'s file-level errors and
      `createScheduler`'s per-provider parse errors are the same class of user-facing problem and
      deserve the same exit code. Leave the existing port validation and its `process.exit(78)`
      alone, and leave the `default:` case's `process.exit(64)` alone.

- [ ] Create `test/config.test.ts` with the seventeen tests below. Start it with this scratch-dir
      helper so no test ever reads the developer's real `~/.config/atrium/config.json` (spec §10
      rule 1) and nothing is left in `/tmp` (carry-forward P3):
      ```ts
      const made: string[] = []
      function scratchConfig(contents?: string): NodeJS.ProcessEnv {
        const dir = mkdtempSync(join(tmpdir(), 'atrium-config-'))
        made.push(dir)
        mkdirSync(join(dir, 'atrium'), { recursive: true })
        if (contents !== undefined) writeFileSync(join(dir, 'atrium', 'config.json'), contents)
        return { XDG_CONFIG_HOME: dir }
      }
      afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
      ```
      **No test in this file may call `loadConfig()` with no argument.**

- [ ] Also in `test/config.test.ts`, define a **local** provider helper rather than importing
      `test/fixtures/provider.ts` — that fixture is Task 2's, and only its `watch`/`emit` seam is
      specified, so depending on the rest of its shape from here is a guess:
      ```ts
      const provider = (id: string, overrides: Partial<Provider<any, any>> = {}): Provider<any, any> => ({
        id,
        configSchema: { parse: (x: any) => x } as any,
        detect: async () => ({ kind: 'nothing-to-detect' }),
        schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: false }],
        fetch: async () => ({}),
        actions: [],
        ...overrides,
      })
      ```

- [ ] Ports: this task owns **7422** and **7423**, per the plan-wide port ledger:

      **Port ledger for Plan 2 — one table, published once and pasted into every brief that binds a port.
      Do not re-derive it; a range not listed against your task is not yours.**
      
      | Range | Owner |
      |---|---|
      | 7373 | `scripts/assert-package.ts` (existing) |
      | 7391-7403 | `test/serve.test.ts` (existing) |
      | 7404-7411 | Task 4 |
      | 7412-7421 | Task 6 |
      | 7422-7423 | Task 3 |
      | 7424 | Task 9 |
      | 7430-7433 | Task 2 |

- [ ] Run the mutation table below. For each row: apply the edit, run the named test, confirm it
      is **red**, restore, confirm **green**. Seven tests in this project have been found passing
      against a deliberately broken implementation; a test you have not watched fail does not
      count. Record the red-then-green result in your completion report — Task 10 re-runs this
      table and will compare.

- [ ] Acceptance: `bun test` fully green (Plan 1's 118 plus Task 1/2's additions plus these
      seventeen), and `bun run typecheck` clean. `test/contract.test.ts` must pass **unedited** —
      in particular `:80`'s `expect(s.configFor('obsidian')).toBe(sawInFetch)` identity
      assertion, `:81`'s unregistered-`git`-key lookup and `:82`'s `absent` lookup. If you find
      yourself editing `test/contract.test.ts`, stop: your `cfgFor` fallback is wrong.

---

**Tests:** all in `test/config.test.ts`.

*`describe('loadConfig')`*

1. **`'a missing config.json yields an empty object, not a throw'`** — `scratchConfig()` with no
   file written; `loadConfig(env)` returns `{}` (`toEqual({})`).
2. **`'an empty or whitespace-only config.json yields an empty object'`** — table over `''` and
   `'  \n '`; both yield `{}`.
3. **`'malformed JSON throws ConfigError naming the file path'`** — contents `'{ not json'`;
   asserts `toThrow(ConfigError)`, that the message matches `/is not valid JSON/`, that it
   contains the scratch path, and that the caught error's `cause` is an `instanceof Error`.
3b. **`'an unreadable config.json throws ConfigError — it never falls back to defaults'`** — create
   the scratch config dir, then create `config.json` as a *directory* rather than a file
   (`mkdirSync(join(dir,'atrium','config.json'))`). `readFileSync` then fails `EISDIR`
   deterministically for any uid, unlike a `chmod 000` file which a root-owned CI would still
   read. Asserts `toThrow(ConfigError)` matching `/could not be read/` and containing the path.
4. **`'a non-object top level throws ConfigError'`** — table over `'[]'`, `'"nope"'`, `'null'`,
   `'42'`, `'true'`; each throws `ConfigError` matching `/must contain a JSON object/`.
5. **`'the returned record is frozen — config is a snapshot, not a live object'`** — contents
   `'{"repos":{"staleDays":7}}'`; asserts `Object.isFrozen(cfg)` is `true`, and that assigning a
   new top-level key throws (module code is strict-mode ESM) while the key remains absent.
6. **`'reads $XDG_CONFIG_HOME/atrium/config.json'`** — asserts
   `configFilePath({ XDG_CONFIG_HOME: dir })` equals `join(dir, 'atrium', 'config.json')`, and
   that a file written there is what `loadConfig` returns. Pins that config placement never
   derives from `$HOME` when `XDG_CONFIG_HOME` is set.

*`describe('createScheduler config parsing')`*

7. **`'parses every registered provider exactly once, at construction, before any fetch'`** — two
   providers registered, each with a counting `parse`. Immediately after `createScheduler(...)`
   returns and **before** any `runNow`, both counters are already `1`. Then `await runNow` twice
   on one of them and call `configFor` on both; both counters are still `1`.
8. **`'fetch receives the PARSED value, not the raw one'`** — **the headline test.** The fixture's
   `parse` must *transform*:
   ```ts
   configSchema: { parse: (raw: any) => ({ staleDays: Number(raw?.staleDays ?? 0) * 2, marker: 'PARSED' }) }
   ```
   with `config: { demo: { staleDays: 7, marker: 'RAW' } }`. After `await s.runNow('demo','poll')`,
   the cfg captured by `fetch` is `{ staleDays: 14, marker: 'PARSED' }`, and specifically **not**
   `{ staleDays: 7, marker: 'RAW' }`. Add a comment in the test saying why the transform is
   mandatory: the three existing stub providers use `{ parse: x => x }`, and against an identity
   parse the parsed and raw values are the same object, so a raw-passthrough implementation is
   undetectable by construction. A `{parse: x => x}` fixture here would be a test that cannot
   fail.
9. **`'configFor returns the same parsed object fetch received'`** — same transforming fixture;
   `expect(s.configFor('demo')).toBe(sawInFetch)` **and**
   `expect(s.configFor('demo')).toEqual({ staleDays: 14, marker: 'PARSED' })`. The second
   assertion is what `test/contract.test.ts:80` cannot give you: under an identity parse, a
   `configFor` that returns the raw value still satisfies `.toBe`.
10. **`'a provider with no config section is parsed from undefined, so its schema can supply defaults'`**
    — provider `repos`, `config: {}` (no `repos` key), and
    `parse: (raw: any) => ({ staleDays: raw?.staleDays ?? 30 })`. Asserts the fixture's `parse`
    was called with exactly `undefined`, and that `fetch`'s cfg and `configFor('repos')` are both
    `{ staleDays: 30 }`. This is the test that keeps `repos.staleDays`'s default honest.
11. **`'watch receives the PARSED value too'`** — provider with the transforming schema and a
    `watch(cfg, emit)` that records `cfg` and returns `{ close() {} }`; `s.start()`, then
    `s.stop()`. The recorded cfg is `{ staleDays: 14, marker: 'PARSED' }`. (Declare the schedule
    with `runOnStart: false` and a 3_600_000ms interval so nothing else fires.)
12. **`'a rejecting parse throws ConfigError naming the provider, preserving the original error as cause'`**
    — provider `repos` whose `parse` throws
    `new Error('staleDays must be a positive integer')`. Asserts `createScheduler(...)` throws
    synchronously, that the thrown value is `instanceof ConfigError`, that its message matches
    `/invalid config for provider "repos"/`, and that `err.cause` is the original `Error` with
    message `'staleDays must be a positive integer'`.
13. **`'a config key with no registered provider is still readable through configFor'`** — only
    `obsidian` registered, `config: { obsidian: {}, repos: { staleDays: 9 } }`; asserts
    `configFor('repos')` is `{ staleDays: 9 }` and `configFor('absent')` is `undefined`. A
    second, dedicated home for the property `test/contract.test.ts:81-82` relies on, so a future
    refactor of `cfgFor` sees a test whose title says what it is for.
14. **`'a provider registered after the scheduler was constructed is a loud error, not a silently unparsed config'`**
    — build a registry, construct the scheduler, **then** `r.register(provider('late'))`. Asserts
    `() => s.configFor('late')` throws matching `/registered after the scheduler/`, and that
    `await s.runNow('late','poll')` rejects with the same message.

*`describe('config reaches the server')`*

> **AMENDED after Task 3 (fix round 1, findings F5 and F7).** Tests 15 and 16 as shipped differ
> from the text below, both times deliberately and both times measured. **Task 10 must re-run
> M9 and M13 against the SHIPPED forms, not reconstruct the versions specified here.**
>
> - **Test 15 was RENAMED** to `'startServer hands the loaded config to the scheduler's parse
>   loop'`. Its old title claimed an ordering property no assertion in it could see: moving
>   `createScheduler` below the `Bun.serve` try/catch left it green (whole suite 163 pass / 0
>   fail under that mutation). It pins M13, precisely and only. The ordering half now has its
>   own test, `'a provider whose config is rejected fails startServer with the port never
>   bound'`, immediately after it.
> - **Test 16 was RESTRUCTURED** and renamed to `'a malformed config.json exits 78 with the path
>   named, before the port is bound'`. It holds the 7423 decoy for the child's WHOLE lifetime
>   rather than binding 7423 after the child exits. The specified shape **would have hung**:
>   built and run under M9, the child never exited within 6s, so the brief's own mandated
>   red-then-green run for M9 would have hung and left a live server squatting machine-global
>   port 7423. The shipped form is strictly stronger — under M9 `expect(code).toBe(78)` PASSES
>   (EADDRINUSE also exits 78), so the decoy is the only thing that discriminates.
> - Both also gained assertions in fix round 1; see the Task 3 addendum after the mutation table.

15. **`'startServer parses the loaded config before it starts listening'`** — write
    `'{"demo":{"staleDays":7}}'` into a scratch config dir; a provider whose `parse` records the
    raw value it was handed; `const s = await startServer({ port: 7422, providers: [p], config: loadConfig(env), env })`.
    Asserts the recorded raw value is `{ staleDays: 7 }` **immediately after `startServer`
    resolves**, with no polling and no sleep — parsing happens synchronously at scheduler
    construction, so this is deterministic, not a race. `s.stop()` in a `finally`. Pass the same
    scratch `env` to `startServer` so `endpoint.json` lands in the scratch dir, never the
    developer's real `$XDG_RUNTIME_DIR`.
16. **`'a malformed config.json exits 78 before the port is bound'`** — scratch config dir
    containing `'{ not json'`; spawn
    `Bun.spawn([process.execPath, 'run', 'src/index.ts', 'serve', '--port', '7423'], { env: { ...process.env, XDG_CONFIG_HOME: dir }, stderr: 'pipe' })`
    (same pattern as `test/serve.test.ts:52`). Asserts the exit code is `78`, that stderr
    contains `'not valid JSON'`, and — the "before the port is bound" half — that a
    `Bun.serve({ hostname: '127.0.0.1', port: 7423, ... })` started *after* the child exits binds
    successfully, then stop it.

**Mutations.** Each row is an exact edit that must turn the named test red. Apply, observe red,
restore, observe green.

| # | Exact edit | Must turn red |
|---|---|---|
| M1 | In `runNow`, pass `opts.config[providerId] as never` to `p.fetch` instead of `cfgFor(providerId) as never` | Test 8 (and 9) |
| M2 | Move the parse out of the construction loop and into `runNow` (`const cfg = p.configSchema.parse(opts.config[providerId])` per call) | Test 7 |
| M3 | Add `if (opts.config[p.id] === undefined) continue` as the first statement of the construction parse loop | Test 10 |
| M4 | Leave `start()`'s `p.watch(...)` call reading `opts.config[p.id] as never` | Test 11 |
| M5 | Replace the parse loop's `catch` body with `parsed.set(p.id, opts.config[p.id])` (swallow the parse error, fall back to raw) | Test 12 |
| M6 | Change `configFor` to `(providerId) => opts.config[providerId]` | Test 9 |
| M7 | Delete the `if (registry.get(providerId)) throw …` branch from `cfgFor` | Test 14 |
| M8 | Drop `Object.freeze` from `loadConfig`'s return (both the `{}` and the parsed-value returns) | Test 5 |
| M9 | Wrap `JSON.parse` in `try { … } catch { return {} }` (treat malformed as empty) | Test 3, Test 16 |
| M10 | Delete the non-object top-level check from `loadConfig` | Test 4 |
| M11 | In `loadConfig`, widen the `ENOENT` check to `catch { return Object.freeze({}) }` so any read failure yields an empty config | Test 3b |
| M12 | In `src/index.ts`, delete the `e instanceof ConfigError` branch so the error propagates | Test 16 (exit code becomes 1) |
| M13 | In `src/server/serve.ts`, construct the scheduler with a hardcoded `{ config: {} }` | Test 15 |

Fixture check, not an implementation mutation but required before you trust Test 8: swap the
transforming `parse` for `{ parse: (x: any) => x }` and confirm Test 8 then passes under M1. That
is the demonstration that the transform is what gives the test teeth; restore the transform
afterwards.

#### Task 3 addendum — mutation rows added after the brief was written

> Recorded HERE, in the tracked plan, and not only in the task report. **Finding F4 asked for
> these to go into `.superpowers/sdd/2026-09-14-plan-2-first-light/progress.md` "the TRACKED
> ledger" — that file is itself gitignored** (`.superpowers/sdd/.gitignore` is a single `*`, and
> `git ls-files .superpowers` is empty), so moving them there would have carried them from one
> untracked file to another. This plan document is the only tracked home. **Task 10's regression
> re-run covers M1–M13 above AND every row below.**

Added during Task 3 (the brief's table left Tests 1, 2, 6 and 13 in no row at all, while
presenting itself as complete):

| # | Exact edit | Must turn red |
|---|---|---|
| M14 | In `src/index.ts`, split the call: `loadConfig()` on its own line, then `startServer({ port })` | The `src/index.ts threads the loaded config…` text tripwire, and nothing else |
| M15 | Delete `loadConfig`'s ENOENT special case | Test 1 — **and 3 more**: the port-collision test and both SIGTERM/SIGINT tests in `test/serve.test.ts`. Expect **4** failures, not 1 |
| M16 | Delete the `text.trim() === ''` short-circuit | Test 2 |
| M17 | Make `configFilePath` ignore its `env` parameter and read `process.env` | Test 6, plus Tests 3, 3b, 4 and 15 (5 total) |
| M18 | Make `cfgFor`'s final fallback return `undefined` | Test 13, plus `test/contract.test.ts`'s `'exposes the same per-provider config the fetch side receives'` |

Added during Task 3 **fix round 1**, each run red-then-green on the post-fix tree:

| # | Exact edit | Must turn red |
|---|---|---|
| M19 | In `cfgFor`, `if (parsed.has(providerId))` → `if (parsed.get(providerId) !== undefined)` | `'a provider whose parse returns undefined is a PARSED entry, not an unregistered one'` |
| M20 | In `installSources`, `p.watch(cfgFor(p.id) …)` → `p.watch(p.configSchema.parse(opts.config[p.id]) …)` — a correct but freshly-computed value, deliberately **not** M4 | `'watch receives the PARSED value too'` (identity assertion) **and** Test 7 |
| M21 | In `startServer`, make `scheduler` a `let` and move `createScheduler(...)` below the `Bun.serve` try/catch | `'a provider whose config is rejected fails startServer with the port never bound'` |
| M22 | Drop `Object.freeze` from **only** `loadConfig`'s ENOENT and empty-file returns, leaving the parsed-value return frozen (a strict narrowing of M8) | Tests 1 and 2 |
| M23 | Replace `describe()`'s body in `src/core/config.ts` with `return typeof value` | Test 4 (`'…naming what it got instead'`) |
| M24 | In `src/index.ts`, delete `if (e.cause instanceof Error) console.error(…)` | Test 16 (the two-`atrium: `-lines assertion) |
| M25 | In `resolvePort`, delete the `Object.hasOwn(config, 'port')` arm so it always returns `DEFAULT_PORT` | `'the config file's "port" key is what binds when no --port is given'` **and** the nonsense-port test |
| M26 | In `resolvePort`, consult the config key **before** `--port` | `'--port still wins over the config file's "port"'` — and nothing else in the suite |
| M27 | In `resolvePort`, replace the bad-value throw with `return Number(raw) \|\| DEFAULT_PORT` | `'a nonsense "port" in the config exits 78 rather than silently rebinding the default'` |
| M28 | In `scripts/assert-package.ts`, delete `env: { ...process.env, XDG_CONFIG_HOME: configHome }` from the `Bun.spawn` | Not a `bun test` row — run `bun run assert:package` with a broken `$XDG_CONFIG_HOME/atrium/config.json`; it must fail `binary never started listening within 5s` |

**Deliberately NOT given a test** (recorded so a later lens does not re-raise it as a gap):
`ConfigError`'s `this.name = 'ConfigError'` is unpinned — deleting it leaves the suite green.
Every call site discriminates by `instanceof` / `toThrow(ConfigError)`, nothing in `src/` or
`test/` reads `.name`, and the only effect is stack-trace cosmetics.

#### Task 3 addendum — carry-forwards for later tasks

- **`test/serve.test.ts` is a SIXTH file touched by Task 3**, beyond the brief's Files list. Its
  three `src/index.ts serve` children now scope `XDG_CONFIG_HOME` to an empty scratch dir,
  because `serve` loads the config file as of this task and the alternative is three children
  reading the operator's home directory — a Global Constraint violation. **Tasks 4–6 must not
  treat it as untouched since BASE.** `scripts/assert-package.ts` is a **seventh**, scoped the
  same way in fix round 1.
- **Task 5's acceptance sentence is off by one.** It says "the three factory `toClient` members";
  there are **FOUR** `Provider<…>`-typed factories in `test/`, named here by SYMBOL because this
  plan has had five stale `file:line` citations already (one of them introduced by the very edit
  that added this paragraph — the factory moved from `:37` to `:47`):
  `actions.test.ts`'s `provider`, `contract.test.ts`'s `stub`, `config.test.ts`'s `provider`,
  and `routes.test.ts`'s `stubProvider`. Re-derive with
  `grep -rn ": Provider<" test/*.ts | grep -v "import type"`. Read the acceptance sentence as four.
- **ADR 0002's two `src/core/scheduler.ts` line citations (`:25` and `:63`) no longer resolve.**
  Task 2 broke them and Task 3 rewrote both expressions. When a task is permitted to touch the
  ADR, re-anchor by CONTENT: "the `p.fetch(cfgFor(...))` call inside `runNow`" and "the exported
  `configFor` accessor". The surrounding prose stays substantively true — both reads now go
  through the one `cfgFor` accessor, which is what that paragraph already argues for.
- **PORT LEDGER, extended by fix round 1:** Task 3 now also uses **7425 and 7426** (previously
  unallocated; 7424 is T9's). Full T3 allocation is **7422, 7423, 7425, 7426**.

---

**Out of scope for this task:**

- **The `repos` config schema.** `src/providers/repos/config.ts` and the keys `repos.staleDays`,
  `repos.extraRoots`, `repos.includeDotPaths`, `repos.treatAsContainer` belong to Task 7. Do not
  create a `repos` provider, a `repos` schema, or a `repos` section here; Test 10's `repos`
  fixture is a local test double with a two-line `parse`, nothing more.
- **Any new dependency.** No zod, no ajv, no validator library. `dependencies` stays exactly
  `react` + `react-dom`.
- **Config *writing*.** No `saveConfig`, no first-run `detect()` → confirm → persist flow, no
  creation of the config directory. `loadConfig` reads; it never `mkdir`s and never writes.
- **Reload.** No file watcher on `config.json`, no SIGHUP handler, no live re-parse. The frozen,
  non-live ruling is the decision — implementing a reload would contradict it.
- **Deep freezing.** `Object.freeze` on the top-level record only. Do not recurse.
- **A `--config` flag or `ATRIUM_*` environment overrides.** Placement is `configDir(env)` and
  nothing else.
- **`toClient` / redaction / `snapshot()` shape** — Task 5. **Auth, `/api/session`, handoff
  delivery** — Task 4. **The failure record, `runOnStart` ordering, registry validation,
  teardown** — Task 2, already done; do not adjust them.
- **`src/core/contract.ts`.** `configSchema` stays the structural duck type at `contract.ts:38`.
  Do not make it generic over a parsed/raw distinction, and do not add members — Task 5 adds
  `toClient` and will conflict.
- **Editing `test/contract.test.ts`**, and in particular its `GIT_LITERAL` neighbour
  `test/rungit.test.ts`, which stays completely unedited for the whole plan.
- **Wiring the real repos provider into `src/index.ts`'s `startServer` call.** Leave
  `providers` unset and add only the one-line comment marking where it goes. **Task 9 owns that
  wiring** — it is the only task that depends on both the finished provider (T7/T8) and the finished
  server (T6), and its end-to-end smoke test is what proves it. Leave the marked comment in place for
  Task 9 to replace; do not delete it.

---

### Task 4: The auth path, and the two mutation checks it unlocks

This task closes the loop that makes every other task in this plan testable: it gives the system a way to
*successfully* authenticate. Today nothing in the repo ever issues a session token, so no test has ever sent a
valid bearer or a valid WebSocket auth frame — measured against the 118-test baseline, `serve.ts`'s bearer check
can be mutated to `if (true)` (reject everything) and the WS handler's `state.authed = true` can be mutated to
`state.authed = false`, and both still pass 118/118. Note the precise claim: the *dangerous* directions are
already pinned (bypassing the bearer check fails 1 test; deleting the socket auth check fails 1 test). What is
unpinned is the **happy path** — a change that breaks legitimate access is invisible. That is an availability
regression gap, not an open security hole; do not describe it as one. Task 4 ships `mintHandoff(now, ttlMs?)`
with a per-entry TTL and an expiry sweep, a `POST /api/session` route that trades a single-use handoff for the
session token, a 0600 boot-handoff file in the existing 0700 runtime directory, and `atrium open --print-url`
that **reads** that file. The two mutations above then go red.

**Depends on:** Task 2, Task 3. (Task 3 only to avoid a concurrent `src/index.ts` edit — T3 rewrites the
`case 'serve'` block, T4 adds a sibling `case 'open'` block. Do not start until T3 is merged.)

---

**Files:**

- `src/core/paths.ts` — **modify.** Extract `runtimeDir(env)` out of the existing `endpointPath` and add
  `handoffPath(env)` next to it, so the handoff file is guaranteed to be a sibling of `endpoint.json` inside the
  directory `startServer` already chmods to 0700. Do **not** rename `removeEndpointIfOwned`; it reads only the
  file's `.pid` and is already file-agnostic, and renaming it churns `test/paths.test.ts` for nothing.
- `src/server/auth.ts` — **modify.** `handoffs` becomes `Map<string, {issuedAt, ttlMs}>`; `mintHandoff` takes an
  optional per-mint `ttlMs` and sweeps expired entries before minting; `consumeHandoff` compares against the
  entry's own `ttlMs`. `verifyBearer` and `authenticateSocket` are unchanged.
- `src/server/serve.ts` — **modify.** Export `BOOT_HANDOFF_TTL_MS`; add the `POST /api/session` branch inside
  `fetch`; mint one boot handoff and write it 0600 to `handoffPath(env)`; extend `cleanup` to remove that file
  too. The `websocket` block is **not** touched — the `state.authed` mutation is against code that already
  exists.
- `src/index.ts` — **modify.** Add `case 'open':` to the existing `switch (cmd)`, between the `case 'serve'`
  block (as T3 left it) and `default:`.
- `test/auth.test.ts` — **modify.** Three new cases in the `handoff token` describe block; one existing case
  amended to close carry-forward M8.
- `test/paths.test.ts` — **modify.** Two new cases for `handoffPath`.
- `test/serve.test.ts` — **modify.** Ten new cases, including the two headline mutation checks. **Reserves
  ports 7404–7411**, per the plan-wide port ledger:

  **Port ledger for Plan 2 — one table, published once and pasted into every brief that binds a port.
  Do not re-derive it; a range not listed against your task is not yours.**
  
  | Range | Owner |
  |---|---|
  | 7373 | `scripts/assert-package.ts` (existing) |
  | 7391-7403 | `test/serve.test.ts` (existing) |
  | 7404-7411 | Task 4 |
  | 7412-7421 | Task 6 |
  | 7422-7423 | Task 3 |
  | 7424 | Task 9 |
  | 7430-7433 | Task 2 |
- `docs/decisions/0002-slice-rulings.md` — **append only**, and only if Task 1 has already created it. See
  Step 12.

---

**Steps:**

- [ ] **Step 1 — `src/core/paths.ts`: one runtime directory, two files.**
      Extract the body of `endpointPath` into a new exported `runtimeDir(env = process.env): string` returning
      `env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'atrium') : configDir(env)`. Redefine
      `endpointPath(env = process.env)` as `join(runtimeDir(env), 'endpoint.json')` — behaviour identical. Add:

      ```ts
      /**
       * The boot handoff. A SEPARATE file, never endpoint.json: §9 fixes that file's
       * shape as {url, pid, startedAt} and its `nonce` is already echoed on the
       * unauthenticated /healthz route, so nothing in it is treated as secret.
       * Sibling-by-construction so it inherits the 0700 directory startServer
       * asserts on every boot.
       */
      export function handoffPath(env = process.env): string {
        return join(runtimeDir(env), 'handoff.json')
      }
      ```

      Leave `removeEndpointIfOwned` untouched; add one line to its doc comment noting it reads only `.pid` and
      is therefore used for `handoff.json` as well.

- [ ] **Step 2 — `src/server/auth.ts`: per-entry TTL plus a sweep.**
      Rename the closure constant `ttlMs` to `defaultTtlMs` (the `AuthOptions.ttlMs` field name does **not**
      change — `test/auth.test.ts` constructs `createAuth({ ttlMs: 60_000 })` in three describe blocks). Then:

      ```ts
      interface HandoffEntry { issuedAt: number; ttlMs: number }
      // ...
      const handoffs = new Map<string, HandoffEntry>()   // token -> {issuedAt, ttlMs}

      mintHandoff(now: number, ttlMs: number = defaultTtlMs): string {
        // The ONLY sweep. consumeHandoff deletes exactly the one token it was
        // handed, so without this an expired handoff that is never redeemed
        // stays in the map for the process's lifetime. Today there is exactly
        // one production mint site (startServer's boot handoff), so this never
        // fires in production — it is exercised directly in test/auth.test.ts
        // rather than claimed as covered. Deleting from a Map while iterating
        // it is well-defined in JS.
        for (const [t, e] of handoffs) {
          if (now - e.issuedAt > e.ttlMs) handoffs.delete(t)
        }
        const t = randomToken()
        handoffs.set(t, { issuedAt: now, ttlMs })
        return t
      },

      consumeHandoff(token: string, now: number): boolean {
        const e = handoffs.get(token)
        if (e === undefined) return false
        handoffs.delete(token)                      // single-use, even when expired
        return now - e.issuedAt <= e.ttlMs
      },
      ```

      Both comparisons use the **entry's** `ttlMs`, never `defaultTtlMs`. Every time value still arrives as a
      parameter — nothing in this module reads the clock.

- [ ] **Step 3 — `src/server/serve.ts`: the TTL constant.**
      Add, next to `DEFAULT_WS_AUTH_TIMEOUT_MS`:

      ```ts
      /**
       * The boot handoff's TTL. §8.3's ~60s window exists because a handoff
       * delivered in a URL is briefly visible in /proc/<pid>/cmdline, which is
       * world-readable with no hidepid. This handoff is never in a URL until the
       * user's own `atrium open --print-url` puts it there: it is written 0600
       * into the 0700 runtime directory. A 60s window instead means a
       * systemd-started server's handoff is dead before the user reaches a
       * browser. Accepted residual, owner-ruled.
       */
      export const BOOT_HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000   // 604_800_000 — 7 days
      ```

      Add `handoffPath` to the existing named import from `../core/paths`, and `chmodSync` is already imported
      from `node:fs`.

- [ ] **Step 4 — `src/server/serve.ts`: the `POST /api/session` route.**
      Inside `fetch`, insert **after** the static-asset fallthrough (`const asset = await serveAsset(path,
      headers)` / `if (asset) return asset`) and **before** `if (!auth.verifyBearer(req))`. Both line numbers
      have shifted from Plan 1's; anchor on those two statements, not on a number.

      ```ts
      // Handoff -> session token. Position is load-bearing in both directions:
      // ABOVE the bearer check, because a client redeeming a handoff has no
      // bearer yet — below it, every request here is a 401 and the route is
      // unreachable. BELOW serveAsset, so the build-time asset manifest keeps
      // first refusal exactly as it does today (that manifest is generated from
      // the real vite dist tree and contains no /api/* key, so nothing can
      // actually shadow this).
      //
      // POST, never GET, for two independent reasons: gate.ts rejects a
      // non-read method that arrives with no Origin header, and §8.3 forbids
      // the token travelling in a URL, where it lands in logs and shell
      // history. A cross-origin form POST is a "simple request" that skips
      // preflight, but it still carries Origin (and Sec-Fetch-Site), both of
      // which the gate above already rejected.
      if (path === '/api/session' && req.method === 'POST') {
        let handoff: unknown
        try {
          handoff = ((await req.json()) as { handoff?: unknown } | null)?.handoff
        } catch {
          handoff = undefined                       // malformed body is just a miss
        }
        if (typeof handoff !== 'string' || !auth.consumeHandoff(handoff, Date.now())) {
          // Byte-identical to the bearer 401 below. Unknown, malformed,
          // expired and already-redeemed are ONE answer: no oracle.
          return new Response('unauthorized', { status: 401, headers })
        }
        return Response.json({ token: auth.sessionToken }, { headers })
      }
      ```

      `headers` already carries `cache-control: no-store`, which is why the success response must use it —
      this body contains the bearer.

- [ ] **Step 5 — `src/server/serve.ts`: mint and write the boot handoff.**
      After the existing `writeFileSync(ep, ...)` call (the `endpoint.json` write, which already runs after
      `mkdirSync(epDir, {recursive: true, mode: 0o700})` and `chmodSync(epDir, 0o700)`), add:

      ```ts
      const hp = handoffPath(env)
      const bootHandoff = auth.mintHandoff(Date.now(), BOOT_HANDOFF_TTL_MS)
      writeFileSync(hp, JSON.stringify({ token: bootHandoff, port: cfg.port, pid: process.pid }), { mode: 0o600 })
      // writeFileSync's `mode` is only applied when it CREATES the file.
      // Measured: rewriting an existing 0644 file with { mode: 0o600 } leaves it
      // 0644. This file holds a long-lived credential, so assert the mode every
      // startup — the same reason epDir's 0700 is chmod'd rather than assumed.
      chmodSync(hp, 0o600)
      ```

      **Never** `console.log`/`console.error` the handoff or the session token from the server. Under systemd
      that moves a live credential into the persistent journal. The only place the handoff is ever printed is
      the user's own `atrium open --print-url` process (Step 7).

- [ ] **Step 6 — `src/server/serve.ts`: remove the handoff file on shutdown.**
      Extend the body of the existing `cleanup` constant to remove both files:

      ```ts
      const cleanup = () => {
        removeEndpointIfOwned(ep, process.pid)
        removeEndpointIfOwned(hp, process.pid)   // same pid-ownership rule; it reads only `.pid`
      }
      ```

      **Do not touch T2's `shutdown` wrapper, the signal handlers, or the `server.stop` wrapper** — they all
      call `cleanup`, so extending `cleanup` alone covers every exit path. `handoff.json` inherits
      `endpoint.json`'s documented overwrite-on-start gap for two concurrent instances; that gap is carried
      forward, not fixed here.

- [ ] **Step 7 — `src/index.ts`: `atrium open --print-url`.**
      Add `import { readFileSync } from 'node:fs'` and `import { handoffPath } from './core/paths'` to the
      existing imports. Insert a new case into the existing `switch (cmd)`, between the `case 'serve'` block
      and `default:`:

      ```ts
      case 'open': {
        // `--print-url` is a BOOLEAN flag. The existing flag() helper returns
        // the NEXT argv element and is wrong for it; use argv.includes.
        if (!argv.includes('--print-url')) {
          // Actually launching a browser is a later plan's job. This slice
          // ships exactly the one subcommand the handoff file needs a reader for.
          console.error('atrium: usage: atrium open --print-url')
          process.exit(64)   // EX_USAGE, matching the default case below
        }
        // READS the boot handoff; it does NOT mint. `handoffs` lives in the
        // closure createAuth() builds inside startServer, so a separate process
        // has no map to mint into. The only other exit is an unauthenticated
        // mint route, which would hand the session token to every local process.
        const raw = (() => {
          try { return readFileSync(handoffPath(), 'utf8') } catch { return undefined }
        })()
        if (raw === undefined) {
          console.error('atrium: no handoff file found — is the server running? (start it with `atrium serve`)')
          process.exit(69)   // EX_UNAVAILABLE
        }
        const h = JSON.parse(raw) as { token?: unknown; port?: unknown }
        if (typeof h.token !== 'string' || typeof h.port !== 'number') {
          console.error('atrium: handoff file is malformed; restart the server')
          process.exit(69)
        }
        console.log(`http://127.0.0.1:${h.port}/#${h.token}`)
        break
      }
      ```

      `JSON.parse` on a corrupt file throws an uncaught error with a non-zero exit — acceptable; do not add a
      second catch for it unless `bun run typecheck` forces restructuring. The result must be clean under this
      project's `noUncheckedIndexedAccess`.

- [ ] **Step 8 — write the three new `test/auth.test.ts` cases and amend one.** See **Tests** below.

- [ ] **Step 9 — write the two new `test/paths.test.ts` cases.** See **Tests** below.

- [ ] **Step 10 — write the ten new `test/serve.test.ts` cases.** Reuse the file's existing `connectWs`
      helper (do not copy it) and its `mkdtempSync`/`rmSync` scratch-directory pattern. **Every scratch test
      passes `env: { XDG_RUNTIME_DIR: scratch }`** so no test writes a live credential into the developer's real
      runtime directory. **Every POST must set an explicit `origin` header** — measured: bun's `fetch` sends no
      `Origin` and no `content-type` of its own, and `gate.ts` returns 403 for a non-read method with no Origin,
      so a POST without it never reaches the route.

- [ ] **Step 11 — run every mutation in the Mutations table below, red then green.** Revert the mutation after
      each. A test that stays green under its named mutation is not done: fix the test, not the table. Seven
      tests in this project have already been found passing against a deliberately broken implementation.

- [ ] **Step 12 — record the residual.** If `docs/decisions/0002-slice-rulings.md` exists (Task 1 has landed),
      **append** a section at end of file: the boot handoff's 7-day TTL, why §8.3's ~60s window does not apply
      (no `/proc/<pid>/cmdline` exposure for a 0600 file in a 0700 directory), and the second accepted residual —
      **one boot handoff, single-use, means exactly one browser profile can redeem per server start; recovery is
      `systemctl --user restart atrium`.** Do not edit anything Task 1 wrote. If the file does not exist yet,
      skip this step: the `BOOT_HANDOFF_TTL_MS` doc comment carries the rationale, and Task 1 absorbs the
      residual.

- [ ] **Step 13 — acceptance.** `bun test` green — **whatever count Tasks 1–3 left green, plus exactly 15 new.**
      Record the before and after numbers in your completion report rather than an absolute total: this task
      depends on Tasks 2 and 3, which between them add roughly forty cases, so a fixed target of 133 would mean
      tests had been lost. `bun run typecheck` clean.

---

**Tests:**

*`test/auth.test.ts` — inside the existing `describe('handoff token')`, which already runs
`createAuth({ ttlMs: 60_000 })` in `beforeEach`:*

- [ ] **`a handoff minted with an explicit ttl outlives the default ttl`** — `mintHandoff(1000, 604_800_000)`,
      then `consumeHandoff(t, 1000 + 600_000)` is `true`. Ten minutes is far past the 60s default, so this
      passes only if the per-mint `ttlMs` is the one stored and compared.
- [ ] **`minting sweeps handoffs that expired before the new mint`** — `const stale = auth.mintHandoff(1000)`
      (default 60s), then `auth.mintHandoff(1000 + 60_001)` to trigger the sweep, then
      `expect(auth.consumeHandoff(stale, 1000)).toBe(false)`. Replaying at a moment when `stale` **would** still
      be inside its window is what makes this detect the sweep rather than the TTL — the same trick the existing
      `an expired token is consumed, not merely rejected` case uses. Do **not** add a `pendingHandoffs()` getter
      to make this easier: it is production API surface added for a test.
- [ ] **`a live handoff is not swept by a later mint`** — `const live = auth.mintHandoff(1000)`, then
      `auth.mintHandoff(30_000)`, then `expect(auth.consumeHandoff(live, 30_000)).toBe(true)`. Paired with the
      case above: without it, `handoffs.clear()` satisfies the sweep test.
- [ ] **`rejects a missing header, a wrong scheme, and a wrong token`** *(amend, closing carry-forward M8)* —
      add a fourth entry to the existing `cases` array: `` { authorization: `Basic ${auth.sessionToken}` } ``.
      The existing second entry is a **bare** token with no scheme at all, which is why the title has never
      matched the body.
- [ ] **`an expired token is consumed, not merely rejected`** *(existing, must stay green)* — regression pin on
      the `HandoffEntry` rewrite. If this goes red, `consumeHandoff` stopped deleting unconditionally.

*`test/paths.test.ts` — synthetic env objects only, no `$HOME`-derived assertion (§10 rule 1):*

- [ ] **`handoffPath and endpointPath are siblings in the runtime directory`** — with
      `{ XDG_RUNTIME_DIR: '/run/user/1000' }`, `handoffPath(env)` is `/run/user/1000/atrium/handoff.json` and
      `dirname(handoffPath(env)) === dirname(endpointPath(env))`. This is the assertion that keeps the handoff
      inside the directory `startServer` forces to 0700; `~/.config` itself is 0755 (§8.5).
- [ ] **`handoffPath falls back to the config dir when XDG_RUNTIME_DIR is unset`** — with
      `{ XDG_CONFIG_HOME: '/home/u/.config' }`, `handoffPath(env)` is `/home/u/.config/atrium/handoff.json`.

*`test/serve.test.ts` — ports 7404–7411:*

- [ ] **`a handoff redeemed at POST /api/session returns a session token that is accepted by /api/state`**
      *(headline 1, port 7404)* — start with a scratch `XDG_RUNTIME_DIR`, read `handoff.json`'s `token`, POST
      `{handoff}` with `host` + `origin` + `content-type: application/json` headers, assert 200 and a string
      `token` in the body, then `GET /api/state` with `Authorization: Bearer <token>` and assert **200**. That
      final assertion is the one that has never existed: until it did, the bearer check could reject everything
      and the suite stayed green. (`GET` with no Origin is fine — `gate.ts` only requires Origin on non-read
      methods.)
- [ ] **`a socket that authenticates stays open and is not re-authenticated on later frames`** *(headline 2,
      port 7405, `wsAuthTimeoutMs: 150`)* — redeem the handoff for a session token, open a socket via the
      existing `connectWs(url, origin)` helper, send `{type:'auth', token}` on `open`, send a **second**
      non-auth frame `{type:'ping'}` ~50ms later, and after ~600ms assert no `close` event fired and
      `ws.readyState === WebSocket.OPEN` (use the literal `1` if the DOM/bun-types merge rejects the constant,
      as `connectWs`'s own comment describes).

      **Read this before writing it.** The obvious version — "authenticate, then assert the socket is still open
      past the 150ms window" — **stays green under the mutation it is supposed to catch.** With
      `state.authed = false`, the handler still reaches `clearTimeout(state.authTimer)`, so the timeout never
      fires and the socket never closes. The **second frame** is the half that catches it: with `authed` still
      false, that frame is read as another first frame, fails `authenticateSocket`, and closes 1008. Both
      assertions must be present, and the second one is the test.
- [ ] **`the same handoff is refused on a second redemption`** *(port 7406)* — POST the handoff twice; 200 then
      401, with the second body carrying no token.
- [ ] **`a GET to /api/session neither issues nor consumes`** *(port 7407)* — `GET
      /api/session?handoff=<token>` (handoff deliberately in the query string, which §8.3 forbids) returns
      **401** and a body not containing `token`; then POST the same handoff in the body and get **200**, proving
      the GET consumed nothing. The query string is not decoration — without it the test is insensitive to the
      mutation below.
- [ ] **`POST /api/session with no Origin header is rejected by the gate before the route runs`** *(port 7408)* —
      POST with only a `host` header returns **403** (the gate's answer, not the route's 401), and the handoff is
      still redeemable afterwards with a proper Origin.
- [ ] **`handoff.json is 0600 even when it pre-existed looser, and holds the handoff, never the session token`**
      *(port 7409)* — pre-create `<scratch>/atrium/` at 0700 and `handoff.json` at 0644, sanity-assert 0644 took,
      start the server, assert `statSync(hp).mode & 0o777 === 0o600`. Then assert the file's `pid` is
      `process.pid`, its `port` is `7409`, its `token` matches `/^[A-Za-z0-9_-]{43}$/`, and — after redeeming it —
      that the file's token is **not** the returned session token.
- [ ] **`stop() removes handoff.json as well as endpoint.json`** *(port 7410)* — after `s.stop()`, neither file
      exists in the scratch directory.
- [ ] **`atrium open --print-url prints the boot handoff from the file and does not mint a new one`** *(port
      7411)* — `Bun.spawn` the server as a real child with `XDG_RUNTIME_DIR=<scratch>` (mirroring the existing
      SIGTERM test), wait for `handoff.json`, read its `token`, then `Bun.spawn([process.execPath, 'run',
      'src/index.ts', 'open', '--print-url'])` with the same env. Assert stdout trims to exactly
      `http://127.0.0.1:7411/#<token>`, and that `handoff.json`'s token is **unchanged** afterwards.
- [ ] **`atrium open fails cleanly with no server and with no --print-url`** *(no port)* — two spawns against an
      empty scratch `XDG_RUNTIME_DIR`: `open --print-url` exits **69** with stderr mentioning the server, and
      bare `open` exits **64** with a usage line. Neither prints anything to stdout.
- [ ] **`the boot handoff TTL is long, per the recorded ruling`** — `expect(BOOT_HANDOFF_TTL_MS)
      .toBeGreaterThanOrEqual(24 * 60 * 60 * 1000)`. **Label this in the file as a tripwire, not coverage**: it
      can only fail if someone edits the constant. It exists because the tempting tidy-up is to drop the second
      argument and inherit `createAuth`'s 60s default, which strands every systemd-started user — and nothing
      else in the suite would notice.

**Mutations** — run each, confirm the named test goes red, revert:

| # | Exact edit | Test that must go red |
|---|---|---|
| X1 | `src/server/serve.ts`, the bearer branch: `if (!auth.verifyBearer(req))` → `if (true)` | `a handoff redeemed at POST /api/session returns a session token that is accepted by /api/state` |
| X2 | `src/server/serve.ts`, `websocket.message`: `state.authed = true` → `state.authed = false` | `a socket that authenticates stays open and is not re-authenticated on later frames` (via the **second** frame; the stays-open half alone stays green) |
| X3 | `src/server/auth.ts`, `mintHandoff`: `handoffs.set(t, { issuedAt: now, ttlMs })` → `handoffs.set(t, { issuedAt: now, ttlMs: defaultTtlMs })` | `a handoff minted with an explicit ttl outlives the default ttl` |
| X4 | `src/server/auth.ts`, `mintHandoff`: delete the `for (const [t, e] of handoffs)` sweep loop | `minting sweeps handoffs that expired before the new mint` |
| X5 | `src/server/auth.ts`, `mintHandoff`: replace the sweep loop with `handoffs.clear()` | `a live handoff is not swept by a later mint` |
| X6 | `src/server/auth.ts`, `verifyBearer`: replace the body with `const parts = h?.split(' '); if (!parts \|\| parts.length !== 2) return false; return parts[1] === sessionToken` (scheme-agnostic) | `rejects a missing header, a wrong scheme, and a wrong token` — and **only** the newly added `Basic` entry fails, which is the proof carry-forward M8 is closed |
| X7 | `src/server/auth.ts`, `consumeHandoff`: delete `handoffs.delete(token)` | `the same handoff is refused on a second redemption` |
| X8 | `src/server/serve.ts`, the `/api/session` guard: `if (path === '/api/session' && req.method === 'POST')` → `if (path === '/api/session')`, and source the handoff as `... ?? new URL(req.url).searchParams.get('handoff')` | `a GET to /api/session neither issues nor consumes` (the GET returns 200 **and** the follow-up POST returns 401) |
| X9 | `src/server/serve.ts`: move the whole `/api/session` block above the `const gate = checkRequest(req, cfg.port)` call | `POST /api/session with no Origin header is rejected by the gate before the route runs` (403 becomes 200) |
| X10 | `src/server/serve.ts`: delete `chmodSync(hp, 0o600)` | `handoff.json is 0600 even when it pre-existed looser, ...` (measured: `writeFileSync`'s `mode` does not tighten an existing file) |
| X11 | `src/server/serve.ts`: write `{ token: auth.sessionToken, ... }` into `handoff.json` instead of the minted handoff | same test — the not-equal assertion and the redemption both fail |
| X12 | `src/server/serve.ts`: remove `removeEndpointIfOwned(hp, process.pid)` from `cleanup` | `stop() removes handoff.json as well as endpoint.json` |
| X13 | `src/index.ts`, `case 'open'`: replace the file read with a fresh `createAuth().mintHandoff(Date.now())` | `atrium open --print-url prints the boot handoff from the file and does not mint a new one` |
| X14 | `src/core/paths.ts`: `handoffPath` returns `join(configDir(env), 'handoff.json')` unconditionally | `handoffPath and endpointPath are siblings in the runtime directory` |
| X15 | `src/server/serve.ts`: `BOOT_HANDOFF_TTL_MS` → `60_000` | `the boot handoff TTL is long, per the recorded ruling` |

#### Task 4 addendum — two mutation rows corrected, measured on the post-T3 tree

> Recorded HERE, in the tracked plan, for the same reason Task 3's addendum was: **Task 10 re-runs
> this whole mutation table**, `.superpowers/sdd/` is gitignored, and a row that cannot redden its
> named test would read as a regression when Task 10 runs it. Both corrections were measured, not
> reasoned about — the brief's literal text was run first and its result is recorded below.

| # | The brief says | Measured | The realisable row |
|---|---|---|---|
| X8 | drop `&& req.method === 'POST'`, and source the handoff as `… ?? new URL(req.url).searchParams.get('handoff')` | **183 pass / 0 fail — cannot redden.** `req.json()` THROWS on a bodyless GET (bun 1.3.11: `SyntaxError: Unexpected end of JSON input`), so control reaches the `catch`, which sets `handoff = undefined`; the `??` on the try-branch assignment is never evaluated and the route answers 401 exactly as shipped | put the query-string fallback on **both** paths — the try-branch `??` **and** `catch { handoff = new URL(req.url).searchParams.get('handoff') ?? undefined }`. Then 182/1, the named test failing on `Expected: 401 / Received: 200` |
| X13 | in `case 'open'`, "replace the file read" with a fresh `createAuth().mintHandoff(Date.now())` | the file read is also the ONLY source of `h.port`, so replacing it outright leaves the template with no port and is not a compiling mutant | keep the read, mint only the **token**: `` console.log(`http://127.0.0.1:${h.port}/#${createAuth().mintHandoff(Date.now())}`) ``. Then 182/1 on two different 43-char tokens |

**Eight rows redden MORE than predicted** (all safe-direction; the named test is red in every case):
X7 → 3 (adds `the same token is rejected on second use` and `an expired token is consumed, not merely
rejected`), X11 → 6 (every test that redeems the boot handoff), X14 → 23. The re-confirmation of the
bearer *bypass* direction (`if (false)`) now reddens **2**, not 1: `a GET to /api/session neither
issues nor consumes` sees 404 from `handleRoute` instead of 401, so that new test doubles as a second
pin on the bearer check existing at all.

**X14 carries a side effect on the machine it runs on.** With `handoffPath` resolving through
`configDir`, every server in the suite writes its boot handoff to `$XDG_CONFIG_HOME/atrium/` — and
with `XDG_CONFIG_HOME` unset that is `~/.config/atrium`, the operator's real config directory. On a
machine where that directory does not exist the write ENOENTs and the failure is loud and harmless
(measured: 23 red, `~/.config/atrium` still absent afterwards). **On a machine where it does exist,
this row writes a live credential into it.** Run X14 as `bun test test/paths.test.ts` — the named
test is in that file and nothing there starts a server — or check the directory first.

**The socket case's shape is load-bearing and was verified, not assumed.** With X2 applied *and* the
second frame removed, `test/serve.test.ts` is **21 pass / 0 fail**. The "authenticate, then assert
the socket is still open past the auth window" shape is vacuous against the very mutation it is
written for, because the handler still reaches `clearTimeout(state.authTimer)` before the mutated
assignment matters. The second, non-auth frame is the entire test.

Already-pinned directions to re-confirm unchanged (they must stay red under their existing tests): the bearer
check mutated to `if (false)` still fails `a token-gated route rejects a request with no bearer`, and deleting
`if (!auth.authenticateSocket(String(raw))) return ws.close(1008, 'auth')` still fails
`websocket: zero state before auth, and close(1008) on a bad first frame`.

---

**Out of scope for this task:**

- **Any second mint site.** No `/api/handoff`, no `atrium rotate-token`, no re-mint on redemption. An
  unauthenticated mint route hands the session token to every local process; a bearer-gated one is useless to a
  client that has no bearer. One boot handoff per server start is the ruling.
- **Sending the handoff or the session token anywhere but the `/api/session` 200 body and the 0600 file.** No
  `console.log` in `serve.ts`, not into `endpoint.json` (whose `nonce` is already public on `/healthz` and whose
  §9 shape is `{url, pid, startedAt}`), not into the `ws://` query string.
- **Anything in the `websocket` block.** The `open`/`message`/`close` handlers, `WS_MAX_PAYLOAD_BYTES` and
  `DEFAULT_WS_AUTH_TIMEOUT_MS` are unchanged. `ws.subscribe`, `STATE_TOPIC`, `ready`/`snapshot` frames and the
  post-auth branch's contents are **Task 6**.
- **The browser side.** `web/src/lib/session.ts` (localStorage, `location.hash`, `history.replaceState`),
  `socket.ts`, `store.ts`, `api.ts` and any change to `main.tsx` are **Task 6**. Task 4 ships the server
  contract only.
- **`atrium open` without `--print-url`** — no browser launch, no `xdg-open`, no `systemd-run`. It exits 64.
- **Staleness / liveness checking of `handoff.json` or `endpoint.json`.** `paths.ts` already documents
  pid-liveness checking as future work for `atrium open`/`doctor`; a stale file from a crashed instance prints a
  URL that will not connect, and that is accepted here.
- **Fixing the concurrent-instance overwrite gap.** `handoff.json` inherits `endpoint.json`'s documented
  single-instance assumption. Do not add locking.
- **Constant-time comparison or rate limiting on `/api/session`.** A `Map.get` on a 43-character base64url token
  is the same shape `consumeHandoff` has always had; changing it is a separate decision.
- **Renaming `removeEndpointIfOwned`, or any other refactor of `src/core/paths.ts`** beyond extracting
  `runtimeDir` and adding `handoffPath`.
- **`toClient` / redaction** (Task 5), **provider registration or scheduler lifecycle** (Task 2), **config
  parsing** (Task 3). If `bun run typecheck` fails on something outside this task's files, it is a dependency
  landing badly — report it, do not patch around it.

---

### Task 5: Redaction — toClient as a required contract member

This task installs the one thing that decides what leaves the Atrium process. Today
`/api/state` serves whatever a provider's `fetch` returned, verbatim, and the scheduler's
`onUpdate` listeners are handed the same object — so the moment Task 7 starts returning real
repository data (absolute `$HOME` paths, branch names, and whatever a later provider carries:
access tokens, spend in euros, mail subjects) it crosses the wire unfiltered. This task adds
`toClient(data: Data): unknown` to the `Provider` interface as a **required** member, applies it
in **exactly one place** — the post-await block inside the scheduler's `runNow`, where the same
computed value feeds both the snapshot map and the listener notification — and reconciles the
design spec's §6 interface block with what actually shipped. It lands before any provider ships
real data, which is the entire point of its position in the plan: a redaction seam added after
the data is flowing is a seam that has already leaked.

**Depends on:** Tasks 2, 3, 4.

Task 2 and Task 3 both edit `src/core/scheduler.ts` (lifecycle, registry validation, failure
record; and moving the config parse inside `createScheduler`). Task 4 edits `src/server/serve.ts`
and `src/index.ts`. Task 5 is sequenced behind all three so no two tasks touch the scheduler
concurrently. Task 2 also creates `test/fixtures/provider.ts` and Task 3 creates
`test/config.test.ts`; both are files this task must update.

> **Line-number warning, read before you start.** Tasks 2 and 3 both insert code into
> `src/core/scheduler.ts` *above* the block this task edits. Every line number the scoping
> document gave for that file is stale by the time you run. This brief therefore anchors on
> structure, never on scheduler line numbers, and it never quotes the current text of any line an
> earlier task rewrites. Do the same in anything you write. (A Plan 1 brief instructed "change
> line 37 to X" using a key that a dependency task had already replaced; an implementer following
> it verbatim would have silently reverted its own dependency.)

---

**Files:**

| File | What changes |
|---|---|
| `src/core/contract.ts` | Adds the required `toClient(data: Data): unknown` member to `Provider<Cfg, Data>`, immediately after `fetch` and before `actions`, with the allowlist and closed-set rules as its JSDoc. Only file in `src/` whose public shape changes. |
| `src/core/scheduler.ts` | Inside `runNow`'s post-await `if (!ac.signal.aborted)` block: compute the client value once via `p.toClient(data)` and use that one variable for both the `last` write and the listener notification. `previousByKey` keeps the raw value; `runNow` keeps resolving to the raw value. Two declaration comments updated. |
| `test/contract.test.ts` | The shared `stub` factory gains a **transforming** default `toClient`. Two new tests (sentinel redaction; missing-`toClient` run failure). No existing assertion is altered. |
| `test/routes.test.ts` | The `stubProvider` factory gains a `toClient`. One new test proving the redaction survives serialization through `handleRoute`'s `/api/state` response body. |
| `test/actions.test.ts` | The `provider` factory gains a `toClient`. Typecheck-only change; no test logic touched. |
| `test/fixtures/provider.ts` | Created in Task 2. Its exported fixture provider gains a `toClient`. Will not typecheck without it. |
| `test/config.test.ts` | Created in Task 3. Any object literal in it typed as `Provider<…>` gains a `toClient`. |
| `docs/superpowers/specs/2026-09-13-atrium-design.md` | §6's `ts` code block is replaced with the shipped shape; the false "audit log" claim in the prose below it is withdrawn; a paragraph documenting `toClient` is added. |

Do **not** edit `src/server/serve.ts`, `src/server/routes.ts`, `src/core/registry.ts`,
`src/core/actions.ts`, or `package.json` in this task.

---

**Steps:**

- [ ] Read `src/core/contract.ts` and `src/core/scheduler.ts` in their **current** state (post
      Task 2, post Task 3, post Task 4). Confirm `runNow` still contains a post-await
      `if (!ac.signal.aborted)` guard that writes `previousByKey`, writes `last`, and iterates
      `listeners`. If Tasks 2/3 restructured that block, adapt — the invariant this task needs is
      "one place where the value that reaches a client is decided", not a particular line.

- [ ] In `src/core/contract.ts`, inside `interface Provider<Cfg, Data>`, insert the member
      **immediately after** the `fetch(cfg: Cfg, ctx: FetchCtx<Data>): Promise<Data>` line and
      **before** `actions: Action[]`. The exact text to insert:

      ```ts
        /**
         * The redaction seam, and the only thing that decides what leaves this
         * process. Everything `/api/state` serves and every WS frame the scheduler
         * pushes is the return value of this function — never `Data` itself.
         *
         * REQUIRED, not optional, for the same reason `DispatchOptions.cfg` is
         * required (src/core/actions.ts, where it records that it was hardcoded
         * `undefined` once): an optional member that defaults to identity means the
         * provider author who forgets it ships secrets silently and nothing goes
         * red. A missing `toClient` must be a compile error.
         *
         * Write it as an explicit field-by-field ALLOWLIST — build a fresh object
         * naming each field you intend to expose. NEVER `{ ...data }` with
         * deletions: a deny-list is correct exactly until the next field is added to
         * `Data`, and then it silently is not, with no diff to review.
         *
         * Closed set on the wire: any status or error value in the returned object
         * is one of the declared codes — `ok`, `stale`, `unavailable`,
         * `unsupported-shape` (spec §7.4) — plus their declared operands. Never a
         * caught exception object and never its text: no `e.message`, no `e.stack`,
         * no `String(e)`. Exception text carries absolute paths, argv and
         * occasionally credentials, and the client has no use for any of it.
         */
        toClient(data: Data): unknown
      ```

- [ ] In `src/core/scheduler.ts`, make a **surgical two-line change** inside `runNow`'s post-await
      success arm. Do **not** retype the block: Task 2 rewrote it, and a verbatim replacement
      written against pre-Task-2 text would silently delete Task 2's work. The only edits are:

      1. Insert `const wire = p.toClient(data)` immediately **above** the existing
         `last.set(providerId, …)` statement and **below** Task 2's `previousByKey.set(key, data)`.
      2. Change the value written to `last` from `data` to `wire`.

      Everything else in that arm stays **byte-identical to how Task 2 left it** — in particular
      Task 2's `recordSuccess(providerId, scheduleName)` call and Task 2's listener loop, whose
      payload is the status envelope `snapshot()[providerId]`, not a bare value. Task 2's catch arm
      (`recordFailure(...)` then `throw e`) is likewise untouched. Sketch of the result, with Task 2's
      statements marked as belonging to Task 2:

      ```ts
            if (!ac.signal.aborted) {
              // previousByKey keeps the RAW value: ctx.previous is a provider's own
              // incremental state, not a client payload. Redacting it here would hand
              // the next fetch its own censored output — the metadata pass would read a
              // redacted discovery list and rediscover nothing.
              previousByKey.set(key, data)                  // …Task 2's, unchanged
              // Computed ONCE, deliberately, and stored in exactly one place. `last` is
              // the single holder of the client value: snapshot() reads it for
              // /api/state AND builds the listener payload from it, so the object
              // /api/state serves and the object pushed to a WS subscriber are the same
              // object by construction. A second toClient call anywhere is two chances
              // for the two wires to disagree.
              const wire = p.toClient(data)                 // …added by THIS task
              last.set(providerId, wire)                    // …Task 2's line, `data` -> `wire`
              recordSuccess(providerId, scheduleName)       // …Task 2's, unchanged — do not drop
              for (const l of listeners) l(providerId, snapshot()[providerId])  // …Task 2's, unchanged
            }
      ```

- [ ] Immediately below that block, leave `runNow`'s existing `return data` **unchanged** and put
      this comment above it:

      ```ts
            // RAW, on purpose. runNow's resolved value is internal — in-flight
            // sharing and direct calls from tests — and must NEVER be serialized to a
            // client. The client value is snapshot()'s.
      ```

- [ ] Update the two map declaration comments at the top of `createScheduler` so they describe the
      new truth: the `last` map's comment must say it holds the **client value** (the `toClient`
      output) keyed by provider id, not the provider's `Data`; the `previousByKey` map's comment
      must say the word **RAW** about the value it holds. Do not otherwise reword them and do not
      change either map's type — both are already `Map<string, unknown>`, so no type change is
      needed anywhere in this file.

- [ ] Apply no redaction anywhere else. **Task 2 owns `snapshot()`'s envelope** — it returns
      `Record<string, ProviderStatus>` where `ProviderStatus` is
      `{ data?: unknown; schedules: Record<string, ScheduleHealth> }` and `data` is read straight out
      of the `last` map. Do not touch it: because it reads `last`, it becomes redacted for free the
      moment you change what `last` holds, and because the listener payload is also built from
      `snapshot()`, both wires are redacted by that one change. `configFor` is untouched;
      `src/server/routes.ts` and `src/server/serve.ts` are untouched. If you find yourself adding a
      second `toClient` call site, stop — that is the defect this task exists to prevent.

- [ ] In `test/contract.test.ts`, add a module-level constant above the `stub` factory:

      ```ts
      const SENTINEL = 'atrium-redaction-sentinel-9f2c41'
      ```

- [ ] In the same file, add a `toClient` member to the `stub` factory, positioned between its
      `fetch` member and its `actions` member and therefore **before** the `...overrides` spread,
      so a test can override it. It must **transform**, not be identity:

      ```ts
        // Deliberately NOT identity. An identity default would make the "redaction
        // above previousByKey" mutation undetectable by every test in this file — the
        // same trap Task 3 records for `{ parse: x => x }` config stubs.
        toClient: () => ({ wire: true }),
      ```

      This default is safe against every existing test in the file: the only assertion anywhere in
      it that inspects `snapshot()` expects `{}` (the `stop()` is quiescent test), and every
      assertion about `ctx.previous` reads the raw side.

- [ ] In `test/contract.test.ts`, inside the existing `describe('scheduler', …)`, add the test
      named exactly
      `the client value is the redacted one — a Data sentinel reaches neither snapshot() nor an onUpdate listener`
      with this body:

      ```ts
          const r = createRegistry()
          r.register(stub('repos', {
            schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: false }],
            fetch: async () => ({ root: '/home/someone/src', token: SENTINEL, count: 2 }),
            toClient: (d: any) => ({ count: d.count }),      // allowlist, field by field
          }))

          const s = createScheduler(r, { config: { repos: {} } })
          const pushed: unknown[] = []
          s.onUpdate((_id, data) => pushed.push(data))

          const raw = await s.runNow('repos', 'poll')

          // Positive shape FIRST. A negative-only assertion passes just as happily
          // when the value is empty or missing, which is exactly how a redaction test
          // becomes a test that cannot fail.
          //
          // NOTE the envelope: Task 2 made snapshot() return
          // Record<providerId, { data?, schedules }>, and made the onUpdate payload
          // that same per-provider envelope. Assert on `.data`, never on the envelope
          // as a whole — `schedules` carries a live health record.
          expect((s.snapshot() as any).repos.data).toEqual({ count: 2 })
          expect(pushed).toHaveLength(1)
          expect((pushed[0] as any).data).toEqual({ count: 2 })
          expect(JSON.stringify(s.snapshot())).not.toContain(SENTINEL)
          expect(JSON.stringify(pushed)).not.toContain(SENTINEL)

          // Computed once: the value /api/state serves and the value pushed to the
          // socket are the SAME object, not two independent toClient calls. The
          // identity is on `.data`, because Task 2's snapshot() allocates a fresh
          // envelope per call while `last.get(providerId)` returns the one stored
          // client value — which is exactly the property being pinned.
          expect((pushed[0] as any).data).toBe((s.snapshot() as any).repos.data)

          // runNow's own resolution stays RAW — internal, never serialized.
          expect((raw as any).token).toBe(SENTINEL)
      ```

- [ ] In `test/contract.test.ts`, add the test named exactly
      `a provider with no toClient fails the run instead of publishing raw Data`:

      ```ts
          const r = createRegistry()
          const p = stub('broken', {
            schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: false }],
            fetch: async () => ({ token: SENTINEL }),
          })
          // A hand-written JS provider, or a future `p.toClient?.(data) ?? data`
          // fallback quietly reintroducing optionality. Either way the run must fail
          // loudly rather than publish Data.
          delete (p as any).toClient

          r.register(p)
          const s = createScheduler(r, { config: { broken: {} } })
          const pushed: unknown[] = []
          s.onUpdate((_id, status) => pushed.push(status))

          await expect(s.runNow('broken', 'poll')).rejects.toThrow()

          // No client value was ever published for this provider. Task 2's catch arm
          // DOES record a failure and DOES notify, so `snapshot()` is not `{}` here and
          // `notified` is not 0 — assert the property that actually matters instead:
          // nothing carrying Data reached either wire.
          expect((s.snapshot() as any).broken?.data).toBeUndefined()
          expect((s.snapshot() as any).broken?.schedules.poll?.consecutiveFailures).toBe(1)
          expect(pushed.every(st => (st as any)?.data === undefined)).toBe(true)
          expect(JSON.stringify(s.snapshot())).not.toContain(SENTINEL)
          expect(JSON.stringify(pushed)).not.toContain(SENTINEL)
      ```

      Note for the reviewer: `previousByKey` *is* written before the throw. That is intended —
      the raw side is the provider's own incremental state and is never client-facing. Do not
      "fix" it by moving `previousByKey.set` below the `toClient` call; Mutation M2 exists
      precisely to keep it where it is.

- [ ] In `test/routes.test.ts`, add `toClient: () => ({ wire: true })` to the `stubProvider`
      factory, between its `fetch` and `actions` members. It is never invoked by the existing
      tests in that file (they pass a plain `snapshot` function into `ctx()`), but it must exist
      for the file to typecheck, and it must not be written as identity — identity in a shared
      fixture is how the next author learns the wrong pattern.

- [ ] In `test/routes.test.ts`, add the imports it now needs (`createScheduler` from
      `../src/core/scheduler`; `Provider` is already imported as a type) and a module-level
      `const SENTINEL = 'atrium-redaction-sentinel-9f2c41'`, then add the test named exactly
      `GET /api/state serves the redacted client value, not the provider Data`:

      ```ts
        const registry = createRegistry()
        registry.register({
          id: 'repos',
          configSchema: { parse: (x: any) => x },
          detect: async () => ({ kind: 'nothing-to-detect' }),
          schedules: [{ name: 'poll', intervalMs: 3_600_000, runOnStart: false }],
          fetch: async () => ({ root: '/home/someone/src', token: SENTINEL, count: 2 }),
          toClient: (d: any) => ({ count: d.count }),
          actions: [],
        } as Provider<any, any>)

        const s = createScheduler(registry, { config: { repos: {} } })
        await s.runNow('repos', 'poll')

        const res = await handleRoute(new Request('http://x/api/state'), {
          registry,
          snapshot: s.snapshot,
          configFor: s.configFor,
          headers: HEADERS,
        })

        expect(res.status).toBe(200)
        const body = await res.text()
        expect(JSON.parse(body).repos.data).toEqual({ count: 2 })   // positive shape, inside
                                                                    // Task 2's status envelope
        expect(body).not.toContain(SENTINEL)                        // and the sentinel is gone
      ```

      Assert on `res.text()`, not `res.json()`: the claim is about the bytes on the wire, and a
      structural assertion can miss a sentinel hiding in a key name or a nested value.

      This test constructs a real `createScheduler` and a real `handleRoute`. If Task 3 changed
      `createScheduler`'s options shape, use whatever shape Task 3 shipped — the stub's
      `configSchema.parse` is the identity function, so the parsed and raw values coincide and
      the assertions above are unaffected either way.

- [ ] In `test/actions.test.ts`, add `toClient: () => ({ wire: true })` to the `provider` factory,
      between its `fetch` and `actions` members. Change nothing else in that file.

- [ ] Open `test/fixtures/provider.ts` (created in Task 2). Task 2 already declares
      `FixtureProviderOptions.toClient?` and a `setWire(v)` member, positioned above the overrides
      spread — you are **amending** that fixture, not inventing the member. Confirm its default is an
      explicit field-by-field allowlist over the fixture's default `Data` — name each field — and
      never `(d) => d`, never `{ ...d }`. If Task 2's default is identity, fix it here and say so in
      your report: an identity default makes M2, Task 6's frame tests and Task 9's render tests
      undetectable by construction.

- [ ] Open `test/config.test.ts` (created in Task 3). If it declares any object literal annotated
      as `Provider<…>`, add a `toClient` to it on the same rules.

- [ ] Run `bun run typecheck`. Every remaining error will be a `Provider`-typed literal missing
      `toClient`. Fix each by adding the member — never by loosening the type, never by casting to
      `any`, never by making the contract member optional. Repeat until clean.

- [ ] Run `bun test`. Expected: the whole suite green, three tests more than the pre-task count,
      and **no existing assertion changed**. The only edits to pre-existing test code in this task
      are the three factory `toClient` members, the two new `SENTINEL` constants, and one import.

- [ ] Spec reconciliation, part 1. In `docs/superpowers/specs/2026-09-13-atrium-design.md`, replace
      the entire fenced `ts` block in §6 (opening fence through closing fence; in the tree as of
      writing that is lines 103–125, but locate it by the `interface Provider<Cfg, Data> {` line,
      not by number) with this block, which is the shape that actually shipped:

      ```ts
      interface Provider<Cfg, Data> {
        id: string
        configSchema: { parse(x: unknown): Cfg }   // structural duck type — no zod dependency
        detect(): Promise<DetectResult<Cfg>>
        schedules: Schedule[]                      // NOT a single interval
        watch?(cfg: Cfg, emit: () => void): Disposable   // push source; the interval is the fallback
        fetch(cfg: Cfg, ctx: FetchCtx<Data>): Promise<Data>
        toClient(data: Data): unknown              // REQUIRED redaction seam — see below
        actions: Action[]
      }

      interface Disposable { close(): void }

      interface Schedule {
        name: string                               // 'discovery' | 'metadata' | 'poll'
        intervalMs: number
        runOnStart: boolean
      }

      interface FetchCtx<Data = unknown> {
        schedule: string                           // which schedule triggered this run
        previous?: Data                            // that schedule's OWN last result, never another's
        signal: AbortSignal
      }

      type DetectResult<Cfg> =
        | { kind: 'configured'; config: Partial<Cfg> }
        | { kind: 'candidates'; candidates: Array<{ label: string; config: Partial<Cfg> }> }
        | { kind: 'nothing-to-detect'; reason?: string }

      // Two action kinds, because two of four providers act in-process, not by subprocess.
      type Action =
        | { kind: 'exec'; id: string; label: string; keybinding?: string
            argv(target: unknown): { cmd: string; args: string[] } }   // §8.6
        | { kind: 'call'; id: string; label: string; keybinding?: string
            payloadSchema?: { parse(x: unknown): unknown }
            run(target: unknown, cfg: unknown): Promise<void> }        // in-process
      ```

      Four corrections are folded in here and each is deliberate: `configSchema` is the shipped
      structural duck type, not `ZodSchema<Cfg>` (there is no zod in `package.json` — dependencies
      are react and react-dom only); `watch?`, `FetchCtx`, `DetectResult`, `Disposable` and
      `payloadSchema?` all shipped but were never written into §6; `toClient` is new in this task.

- [ ] Spec reconciliation, part 2. Directly beneath that block, add this paragraph:

      > **`toClient` is the redaction seam and it is required, not optional.** A provider's
      > `Data` is its own working shape and may hold anything it needs; `toClient` is the one
      > function that decides what leaves the process. It is applied in exactly one place — the
      > scheduler, where the same computed value feeds both the `/api/state` snapshot and the
      > WebSocket push — so there is no second site to keep in sync and no route that can bypass
      > it. Write it as an explicit field-by-field allowlist, never a spread with deletions: a
      > deny-list is correct until the next field is added to `Data`. Status and error values on
      > the wire come from the closed set of declared codes (§7.4: `ok`, `stale`, `unavailable`,
      > `unsupported-shape`); a caught exception object, its `message` or its `stack` never
      > reaches a client. `ctx.previous` and the scheduler's internal return value stay raw —
      > redaction is about the wire, not about the provider's own incremental state.

- [ ] Spec reconciliation, part 3 — the audit log. The prose sentence below the §6 block claims
      both action kinds go through the same allowlist *and audit log*. There is no audit log:
      `grep -rn -i audit src/ web/ test/ scripts/` returns nothing, and none is built in this
      plan. Replace that sentence with:

      > Both kinds are declared and both go through the same static allowlist — `dispatch()` looks
      > an action up by id in the provider's own declared array and never indexes a function table
      > by a client-supplied name. `exec` actions take argv arrays only; `call` actions are static
      > functions. **There is no audit log.** Revision 1's text claimed one; nothing in `src/` has
      > ever written one, and the claim is withdrawn here rather than left standing as an unbuilt
      > promise. If one is wanted it belongs at `dispatch()` in `src/core/actions.ts` and deserves
      > its own plan.

      Do not build an audit log.

- [ ] Leave the rest of §6 alone — in particular the `One folder per provider:
      src/providers/<id>/{index,config,actions}.ts` line, which is already consistent with the
      ruling that the provider id is `repos` and its directory is `src/providers/repos/`.
      Do not edit §5's architecture diagram; naming is Task 1's territory.

- [ ] Re-run `bun test` and `bun run typecheck`. Both clean.

- [ ] Run the six mutation checks below, red-then-green, and record the result of each in the
      commit message or the task's notes. An unexercised mutation is not a mutation check.

---

**Tests:**

Three new tests, plus two existing tests that this task newly turns into pins.

1. **`the client value is the redacted one — a Data sentinel reaches neither snapshot() nor an onUpdate listener`** (`test/contract.test.ts`).
   Asserts, in order: `snapshot().repos.data` equals the allowlisted shape `{ count: 2 }`; the
   `onUpdate` listener received exactly one status envelope whose `.data` is `{ count: 2 }`; neither
   serialization contains `SENTINEL`; the listener's `.data` is reference-identical to the snapshot's
   `.data` (the "computed once" property); and `runNow`'s own resolved value still carries the sentinel (the
   raw side is intentionally unredacted). The positive `toEqual` assertions come before the
   negative `not.toContain` ones on purpose — a redaction test that only asserts absence passes
   just as happily when the whole value has gone missing.

   *This is the test that stands in for the WS half until Task 6.* No WebSocket push path exists
   at this point in the plan; the `onUpdate` listener payload is the exact value Task 6's
   `server.publish` will serialize, so asserting against it now is the honest equivalent. Task 6
   adds the literal "the sentinel is absent from the WS frame" assertion once frames exist — it is
   **test 10 of `test/ws-protocol.test.ts`**, named in Task 6's brief, not a hope.

2. **`a provider with no toClient fails the run instead of publishing raw Data`** (`test/contract.test.ts`).
   A provider whose `toClient` has been deleted at runtime: `runNow` rejects, no status envelope
   anywhere carries a `data` key, and the sentinel appears in neither wire. (Task 2's catch arm
   records a failure and notifies, so the older `snapshot()` is `{}` / `notified === 0` form of this
   assertion is wrong against the tree this task actually lands on.) Pins that the scheduler calls
   `toClient` unconditionally — no `?.`, no `?? data`, no `typeof` guard — so optionality cannot
   creep back in behind the type.

3. **`GET /api/state serves the redacted client value, not the provider Data`** (`test/routes.test.ts`).
   A real registry + real `createScheduler` + real `handleRoute`: the response body text parses to
   `{ repos: { data: { count: 2 }, schedules: { … } } }` — `body.repos.data` deep-equals
   `{ count: 2 }` — and does not contain the sentinel. Pins that redaction survives the
   whole serialization path, not just the in-memory map.

4. **`previous is scoped per schedule — a two-schedule provider never sees the other schedule's previous`** (`test/contract.test.ts`, existing).
   Unchanged, but newly load-bearing: with the `stub` factory's default `toClient` now
   transforming, this test goes red if redaction is applied to `previousByKey`.

5. **`passes the previous result so a metadata pass can read the discovery list`** (`test/contract.test.ts`, existing).
   Same: unchanged, newly load-bearing, red under the same mutation. Two independent pins on the
   raw-previous invariant.

Acceptance also includes a clean `bun run typecheck` with every `Provider`-typed literal in the
repo carrying a `toClient`. The three Plan 1 stub factories breaking is the point of making the
member required — if nothing breaks, the member was declared optional somewhere.

*Feasibility, and what it does and does not cover.* The contract member, the `toClient` call site
and the three factory `toClient`s were applied to a throwaway copy of the **Plan 1** tree at
`3a0491e`: `bun test` went 118 → 121 pass, 0 fail, and `tsc --noEmit` exited 0, with no existing
assertion changed. Treat that as evidence about the *shape* of the diff only. **The three new tests'
assertions in this brief have been rewritten against Task 2's status envelope and were NOT measured
on that tree** — the Plan 1 tree has no envelope and no failure record. Re-measure M1–M4 on a tree
with Tasks 2, 3 and 4 applied before you trust the table below, and record what you observe.

**Mutations:**

The mutation *directions* below were exercised on the Plan 1 tree; the *red/green outcomes* must be
re-observed on the post-Task-2/3/4 tree, because the envelope changes what the assertions read.
Test *counts* will differ once Tasks 2–4 have added their own tests; the *names* are what to check.

- **M1 — redaction removed from the write path.** In `src/core/scheduler.ts`, delete the
  `const wire = p.toClient(data)` line and write the raw value instead: `last.set(providerId, data)`.
  (There is only one write site to mutate; the listener payload is built from `snapshot()`, which
  reads `last`, so this one edit un-redacts both wires — which is the design property M1 confirms.)
  → **Three** tests go red, and all three must:
  `the client value is the redacted one — a Data sentinel reaches neither snapshot() nor an onUpdate listener`,
  `GET /api/state serves the redacted client value, not the provider Data`, and
  `a provider with no toClient fails the run instead of publishing raw Data` (the third because
  with no call site left, the provider missing `toClient` no longer throws). If fewer than three
  fail, one of them is not reading the redacted path at all.

- **M2 — redaction moved above `previousByKey`.** In `src/core/scheduler.ts`, hoist the
  `const wire = p.toClient(data)` line above `previousByKey.set` and change that call to
  `previousByKey.set(key, wire)`.
  → `previous is scoped per schedule — a two-schedule provider never sees the other schedule's previous` goes **red**, and
  `passes the previous result so a metadata pass can read the discovery list` goes **red**.

- **M3 — optionality reintroduced.** In `src/core/contract.ts` change the member to
  `toClient?(data: Data): unknown`, and in `src/core/scheduler.ts` change the call to
  `const wire = p.toClient ? p.toClient(data) : data`.
  → `a provider with no toClient fails the run instead of publishing raw Data` goes **red**.
  This is the mutation that matters most: it is the shape a well-meaning author reaches for when
  a stub provider somewhere fails to compile, and it silently restores exactly the leak this task
  removed.

- **M4 — computed twice.** In `src/core/scheduler.ts`, leave the `last` write alone but give the
  listener its own second computation: replace the notification argument `snapshot()[providerId]`
  with a freshly built envelope `{ data: p.toClient(data), schedules: {} }`.
  → the `expect((pushed[0] as any).data).toBe((s.snapshot() as any).repos.data)` assertion inside
  `the client value is the redacted one …` goes **red** (`toClient` returns a fresh object, so the
  two are equal but not identical). Pins "exactly one place, one value". Note honestly *why* the
  original form of this mutation ("call `p.toClient` in each of the two places") is no longer
  expressible: Task 2 made the listener payload `snapshot()[providerId]`, whose `data` is read out
  of `last`, so there is now structurally **one** holder of the client value. M4 as restated is the
  mutation that reintroduces a second one.

- **M5 — the identity-stub demonstration (run it, record it, revert it).** Temporarily change the
  `stub` factory's default in `test/contract.test.ts` to `toClient: (d: any) => d`, then apply
  **M2** on top. Measured result: the **entire suite stays green — zero failures**, including both
  tests M2 is supposed to turn red. Revert both changes. Record this result: it is the proof that
  a non-transforming default fixture makes the redaction-ordering property undetectable by
  construction — the same failure mode Task 3 records for `{ parse: x => x }` config stubs, and
  the reason the default `toClient` in this file must transform. Do not ship either change.

- **M6 — the required-ness check (typecheck level, not a test).** Delete the `toClient` member
  from `test/actions.test.ts`'s `provider` factory and run `tsc --noEmit` (or `bun run typecheck`).
  → Measured: it fails with
  `test/actions.test.ts(9,83): error TS2741: Property 'toClient' is missing in type '{ … }' but required in type 'Provider<any, any>'`.
  Restore it and confirm the typecheck is clean again. If the deletion typechecks, either the
  contract member is optional or the literal lost its `Provider<any, any>` annotation, and the
  compile-time guarantee this task's entire rationale rests on does not exist.

---

#### Task 5 addendum — mutation rows measured on the post-T4 tree

> Recorded HERE, in the tracked plan, for the same reason Task 3's and Task 4's were: **Task 10
> re-runs this whole mutation table**, `.superpowers/sdd/` is gitignored, and a row that cannot
> redden its named test would read as a regression when Task 10 runs it. The table above was
> written against the Plan 1 tree at `3a0491e` and had never been run on a tree with Tasks 2–4
> applied. Every row below was run on `f68a5d1` plus this task's commits, the plan's literal text
> first, on the FULL suite (`bun test`), by exact-string replacement that refuses to apply unless
> the target occurs exactly once, then reverted with `git checkout` and re-run green. Baseline
> 184 pass / 0 fail / 449 expect() across 13 files; exit 187 / 0 / 465. Before any code was
> written, every row's literal target string was absent from the tree (the seam did not exist),
> so the pre-code audit is: "all six rows are inapplicable until the seam lands; `snapshot()[providerId]`
> is absent and stays absent".

| # | The plan says | Measured | The realisable row |
|---|---|---|---|
| M1 | delete `const wire = p.toClient(data)`, write `last.set(providerId, data)`; **three** named tests red | **184 pass / 3 fail / 453** — exactly the three named. `the client value is the redacted one …` on the first `toEqual` (`.data` carries `+ root`, `+ token`); `a provider with no toClient …` on `Expected promise that rejects / Received promise that resolved`; `GET /api/state serves the redacted client value …` on the body's `.repos.data` (`+ root`, `+ token`). Mutant typechecks (exit 0) | as written |
| M2 | hoist `const wire` above `previousByKey.set`, write `previousByKey.set(key, wire)`; two named tests red | **185 / 2 / 464** — exactly `passes the previous result …` (`- "n": 1 / + "wire": true`) and `previous is scoped per schedule …` (`repos: ["a","b"]` replaced by `wire: true`). Mutant typechecks | as written |
| M3 | `toClient?(data: Data): unknown` and `const wire = p.toClient ? p.toClient(data) : data`; one named test red | **186 / 1 / 460** — exactly `a provider with no toClient fails the run …` (`Expected promise that rejects`). **`bun run typecheck` exit 0 under the mutant**: the compiler cannot see this one, only the runtime test can | as written |
| M4 | replace "the notification argument `snapshot()[providerId]`" with `{ data: p.toClient(data), schedules: {} }` | **cannot apply — 0 occurrences.** Task 2 factored the listener loop into `notify(providerId)` → `buildStatus(providerId)` → `last.get(providerId)`; the plan's sketch line `for (const l of listeners) l(providerId, snapshot()[providerId])` never existed on this tree | Two forms, BOTH measured. **M4-coarse** (the success-arm `notify(providerId)` → `for (const l of listeners) l(providerId, { data: p.toClient(data), schedules: {} })`): **185 / 2 / 462** — the identity line (`Received: serializes to the same string`) AND collateral `onUpdate carries the status envelope …` in test/scheduler-lifecycle.test.ts, a `TypeError: undefined is not an object (evaluating 'seen[1][1].schedules.poll.consecutiveFailures')` from the empty `schedules`. **M4-sharp** (preferred; the row Task 10 should run): `for (const l of listeners) l(providerId, { ...buildStatus(providerId)!, data: p.toClient(data) })` — **186 / 1 / 464**, ONLY the identity line, the mutation that says "computed twice" and nothing else. `notify(providerId)` occurs twice in scheduler.ts; mutate the success-arm occurrence only — in the catch arm `data` is out of scope and the mutant does not compile. Both mutants typecheck |
| M5 | identity stub default + M2 → zero failures | **187 / 0 / 465** — confirmed: the ENTIRE suite green, including both tests M2 reddens. Both changes reverted | demonstration, as written. It is the proof the `stub` default must transform |
| M6 | delete `test/actions.test.ts`'s `toClient` → `(9,83) TS2741` | exactly `test/actions.test.ts(9,83): error TS2741: Property 'toClient' is missing in type '{ … }' but required in type 'Provider<any, any>'`, exit 2; restored → exit 0 | as written. The error code depends on the factory's shape: the two `...overrides: Partial<Provider>` factories (contract.test.ts, config.test.ts) surface as **TS2322** (`((data: any) => unknown) | undefined` is not assignable), not TS2741 — see the checkpoint below. Task 10 must not grep for TS2741 alone |

**Every runtime mutant (M1, M2, M3, M4-coarse, M4-sharp, M5) typechecks with exit 0.** The compile-time
guarantee this task ships is exactly M6's — a `Provider`-typed literal without the member does not
compile — and nothing more; the other five properties are held by tests alone.

**The contract-edit-alone checkpoint (A2).** With the member added to `src/core/contract.ts` and nothing
else touched, `bun run typecheck` gives EXACTLY four errors: `test/actions.test.ts(9,83)` and
`test/routes.test.ts(8,99)` as TS2741 (property missing), `test/contract.test.ts(6,96)` and
`test/config.test.ts(47,100)` as TS2322 (through their `...overrides` spread). That is the moment "the
stub factories breaking is the point" is observable; after the four members it iterates zero times.
`test/fixtures/provider.ts` typechecked UNCHANGED — it already declared `toClient` on
`FixtureProviderOptions` (:40) and on the object (:107) with `defaultToClient = (data) => ({ ok: data?.ok })`
at :76, an explicit one-field allowlist. The table row "will not typecheck without it" was stale, and the
step "if Task 2's default is identity, fix it here" did not fire.

**The ripple the plan section does not know about (F3).** `test/scheduler-lifecycle.test.ts` is Task 2's
and post-dates this section. With the contract member, the scheduler edit and the four factory members
applied and that file UNTOUCHED, the full suite is **182 pass / 2 fail / 447**, and the red set is exactly
`consecutive failures accumulate and a success clears the record` (:206,
`expect(s.snapshot().fx?.data).toEqual(payload)`) and `onUpdate carries the status envelope, and the record
is current when it fires` (:234, `expect(seen[1]![1].data).toEqual(payload)`), both `- "v": 42 /
+ "ok": undefined` through the fixture's `{ ok }` allowlist. Nothing else moved; the fixture-seam test's
`{ ok: false }` at :334 survives. Ruled fix: each of the two `makeFixtureProvider` calls names its one field,
`toClient: (d) => ({ v: d.v })` — `Data` is inferred from `fetch`'s return so `d` needs no annotation — and
**the two assertions are byte-identical**. Then 184 / 0 / 449 again. So "no existing assertion changed" holds
on this tree, but the sentence "the only edits to pre-existing test code in this task are the three factory
`toClient` members, the two new `SENTINEL` constants, and one import" does not: add the two fixture options
in scheduler-lifecycle.test.ts, and read "three" as four (below).

**Three declaration comments, not two.** Besides `last` and `previousByKey` (scheduler.ts :24–25), the
exported `ProviderStatus.data` comment (:19, "the provider's most recent Data") went false with this edit —
`data` is now the `toClient()` output — and Task 6 documents its structural copy of that type as exactly
that. It now reads "the provider's toClient() output (the client value); absent until the first success".

**Prose in this section corrected here rather than rewritten in place:**

- "three factory `toClient` members" (~2249) and "the three Plan 1 stub factories" / "the three factory
  `toClient`s" (~2384–2388): **four**. `test/config.test.ts:47` is the fourth `Provider`-typed factory,
  created by Task 3, whose own block comment already said to read the sentence as four. Its member is the
  same constant as routes/actions — over a default `Data` of `{}` the field-by-field allowlist names zero
  fields, so a constant IS that allowlist, and its comment now says so.
- "**test 10 of `test/ws-protocol.test.ts`**" (~2359): Task 6 numbers the sentinel-frame test **18**.
- "Four corrections are folded in here" (~2296): seven items are listed.
- the fixture's `toClient` "positioned above the overrides spread" (~2233): the fixture has no spread;
  `toClient` is at :107 and `setWire` at :126.
- "the same computed value feeds both the `/api/state` snapshot and the WebSocket push" (~2307, spec text):
  forward-looking — no push exists until Task 6. On this tree the one holder is `last`, read by
  `buildStatus()` for both `snapshot()` and `notify()`; the "one place" property is what Task 6's publish
  inherits.
- The M1 row's parenthetical "the listener payload is built from `snapshot()`" is `buildStatus()` on this
  tree; the property it states (one write un-redacts both wires) is what was measured.

**Counts.** 184 → 187 tests (+3), 449 → 465 expect() (+16: 7 in the sentinel test, 6 in the missing-toClient
test, 3 in the routes test). Full suite run twice at exit, identical.

##### Task 5 fix round — two rows added, one row re-measured, and a claim withdrawn

> Same discipline as above: every runtime row run RED on the full suite by exact-once replacement on
> `9075f82` plus the fix-round commits, reverted with `git checkout`, re-run GREEN. Baseline 187 / 0 / 465;
> exit **187 / 0 / 466** (+1 expect(), the T1 length pin). Every mutant below typechecks except where the
> row says otherwise.

| # | The mutation | Measured RED | Notes |
|---|---|---|---|
| M7 | catch-arm `notify(providerId)` removed (the success-arm occurrence is left; in the catch arm the target is `recordFailure(providerId, scheduleName, e)` + newline + `notify(providerId)`, which is unique) | **185 / 2 / 456** — `a provider with no toClient fails the run instead of publishing raw Data` at the new `expect(pushed).toHaveLength(1)` (`Expected length: 1 / Received length: 0`), and `onUpdate carries the status envelope, and the record is current when it fires` (test/scheduler-lifecycle.test.ts:236, `expect(seen.length).toBe(1)`, `Expected: 1 / Received: 0`). Mutant typechecks | **Before the pin, the same mutant was 186 / 1 / 458 — the no-toClient test stayed GREEN.** `pushed.every(...)` is vacuously true on `[]`; the length line is what makes the "nothing carrying Data reached either wire" claim about a real envelope. Task 10: two named tests red, not one |
| M8 | runNow's `return data` → `return p.toClient(data)` | **186 / 1 / 466** — ONLY `the client value is the redacted one …` at `expect((raw as any).token).toBe(SENTINEL)` (`Expected: "atrium-redaction-sentinel-9f2c41" / Received: undefined`). Mutant typechecks | The review's spelling `return data` → `return wire` is **not a runnable mutant**: `wire` is `const` inside the `if (!ac.signal.aborted)` block, so it is `src/core/scheduler.ts(219,16): error TS2304: Cannot find name 'wire'` (measured at 9075f82; `(225,16)` at 6b4b129, after the R2 JSDoc grew the file by six lines) under typecheck and a `ReferenceError: wire is not defined` at runtime that reddens **15** tests (172 / 15 / 423) — every test with a successful run, across contract, routes, scheduler-lifecycle and config. Task 10 runs the `p.toClient(data)` form |
| M6-routes | `toClient` deleted from the `/api/state` test's inline literal, now `satisfies Provider<any, any>` | `bun run typecheck` exit 2, verbatim: `test/routes.test.ts(128,21) — (131,21) at 6b4b129, after the test comment's final wording: error TS2345: Argument of type '{ id: string; … actions: never[]; }' is not assignable to parameter of type 'Provider<any, any>'.` + `test/routes.test.ts(135,5) — (138,5) at 6b4b129: error TS1360: Type '{ … }' does not satisfy the expected type 'Provider<any, any>'.`, each elaborated `Property 'toClient' is missing in type '{ … }' but required in type 'Provider<any, any>'.` Restored → exit 0 | **Not TS2741**, which the fix brief predicted: in argument position the missing member surfaces as TS2345 at the call and TS1360 at the `satisfies`, with the TS2741 wording as the elaboration line. Task 10 must not grep for TS2741 here either (see the M6 row) |

**The `as` claim, withdrawn.** The review (L1-2/L3-7) said a type assertion "checks comparability, so
that literal MINUS toClient would still compile". Measured on this tree, with the plan's own `as
Provider<any, any>` (plan ~2202 wrote `as`; T5 kept it) and `toClient` deleted: **exit 2**,
`test/routes.test.ts(122,21): error TS2352: Conversion of type '{ … }' to type 'Provider<any, any>' may be
a mistake because neither type sufficiently overlaps with the other`, elaborated `Property 'toClient' is
missing`. Widening `actions: []` to `Provider<any, any>['actions']`, or `detect` to `Promise<any>`, or
`schedules` to `Provider<any, any>['schedules']`, or all three (four variants, scratch file, same tsc
flags) — still TS2352 with the same elaboration. So the cast was NOT silent on this literal. The
`satisfies` change stands on the narrower ground the test comment now states: a cast is the one spelling
a later edit silences with `as unknown as Provider<any, any>` (tsc's own suggestion text), and it reads
as a conversion rather than a check. The plan's sketch line at ~2202 still says `as`; read it as `satisfies`.

**R1 — the exception-text claim was false, and is now scoped (text, not measurable).** T5's contract JSDoc
and spec §6 both said "a caught exception object, its `message` or its `stack` never reaches a client".
The review's probe P7 showed the opposite on this tree: a `fetch` that throws `new Error('ENOENT
/home/someone/.secret ' + SENTINEL)` puts that string in the `/api/state` body under
`schedules.poll.lastErrorMessage` and in every onUpdate envelope — on `9075f82` line numbers, `recordFailure` (scheduler.ts:123)
stores `(err as Error)?.message ?? String(err)`, `buildStatus` (:140) copies it into the envelope, the
watch-install catch (:281) writes `watch() threw: ${e.message}`, routes.ts:66 serializes the snapshot.
That is Task 2's failure-record design, pinned as a feature by scheduler-lifecycle :176/:240/:289 and
rendered by Task 9. **Nothing in the channel was changed this round** — `recordFailure` is byte-identical.
What changed is the two claims: the closed-set rule now governs `toClient`'s RETURN VALUE; the JSDoc
and §6 both name `schedules.<name>.lastErrorMessage` as a separate, provider-controlled, currently
unredacted text channel `toClient` never sees, tell providers never to throw with `Data`, a path or a
credential in the message, and mark sanitizing/closing it as an **open item with no owner yet** —
Task 6 (the wire) or a plan-level ruling: sanitize at `recordFailure`, or a closed-set code on the wire
with the message kept server-side. The JSDoc also (L3-3) says `/api/state` serves the `{ data?, schedules }`
envelope and only `.data` is `toClient`'s output, (L3-4) calls the allowlist and closed-set rules
conventions held by each provider's redaction test, not checks — `unknown` accepts identity and spreads,
nothing inspects the shape at registration or the call site, the compile-time guarantee is exactly that
the member exists — and (L3-5) states §7.4's four-way status as the pattern, not the universal set.

**R2 — buildStatus's isolation comment (text, not measurable).** "freshly allocated — never the live
record objects" held for `schedules[name]` (copied at :140) and not for `.data` (:142 hands out the stored
object; the review's P4: a listener doing `(st.data as any).injected = 'x'` changes the next `/api/state`
body). That aliasing is deliberate and is the M4 oracle (`toBe` in contract.test.ts). The comment now says
exactly that: records copied, `.data` shared by design, consumers treat it as read-only. No behaviour changed.

**T4 — the spec's two §6 paragraphs (text, not measurable).** The part-2 and part-3 blocks landed as
blockquotes because the plan's text carried a leading `> ` (the plan quoting its own insertion); they were
the only `> ` lines in the spec. Both are plain paragraphs now; part 3 is byte-identical to the unquoted
original and part 2 differs only by the R1 correction ("on the wire" → "in the returned object"; "never
reaches a client" → "never appears in `toClient`'s return value") plus the new channel paragraph.

**Carried forward from the T5 review, not fixed here (owners named):**

- **`lastErrorMessage` channel** (R1 above) — needs an owner: Task 6 or a plan ruling. Sanitize at
  `recordFailure`, or a closed-set code + server-side message.
- **L3-2** — `src/server/routes.ts:81` (POST `/api/actions` 400) serializes `e.message` from
  provider-authored `payloadSchema.parse` / `argv` / `run`; the ":78-80 echoes only the ids" comment is true
  only for the two lookup errors. routes.ts was forbidden this round; Task 6 owns the server.
- **L2-2** — a circular `toClient` value makes `handleRoute` reject (`JSON.stringify cannot serialize
  cyclic structures`) and `/api/state` stays broken until the next successful run; production would answer
  500 via Bun.serve's `error` hook (inferred, not measured). Task 6 owns serialization failure; the fixture's
  `setWire(circular)` exists for it.
- **L2-4** — "exactly one call site" is held by grep, not a test: a no-effect second `p.toClient` call is
  invisible (P1b, P6 both green). Task 10's verify gate should carry `grep -n 'p.toClient' src/` = 1.
- **L2-5** — `toClient` returning `undefined` yields an envelope with an explicit `data: undefined` key
  that JSON drops; on the wire indistinguishable from "never succeeded" except via `lastSuccessAt`. Task 9 note.
- **L3-8** — a JS provider (or an `as any` registration) that forgot `toClient` registers fine, fails EVERY
  run with `lastErrorMessage: 'p.toClient is not a function'` and polls forever; nothing raw is published.
  A registry-time `typeof` check is out of scope by the plan. Recorded as the ruling.
- L1-3 is M8 above (fixed). L1-2/L3-7 is M6-routes above (fixed, with the `as` claim withdrawn).

---

**Out of scope for this task:**

- **Do not build an audit log.** Step "spec reconciliation, part 3" deletes the claim; it does not
  schedule the work.
- **Do not add a second redaction site.** No `publicSnapshot()` on the scheduler, no filtering in
  `src/server/routes.ts`, none in `src/server/serve.ts`, none in the (not yet existing)
  `src/core/wire.ts`. One call site is the contract this task ships.
- **Do not redact `previousByKey` or `runNow`'s return value.** Both stay raw, deliberately, and
  M2 exists to keep them that way.
- **Do not add runtime validation that `toClient` is a function** to `src/core/registry.ts`.
  Registry-time validation belongs to Task 2, and required-ness here is enforced by the compiler
  plus test 2's runtime failure — not by a third mechanism.
- **Do not touch the config path.** `configFor`, `configSchema`, the parse location and the
  frozen-vs-mutable ruling are Task 3's, already landed. Read them; do not revise them.
- **Do not add WebSocket frames, `ws.subscribe`, `server.publish`, `STATE_TOPIC`, or
  `src/core/wire.ts`.** Task 6 owns the wire protocol and adds the literal WS-frame redaction
  assertion there.
- **Do not create `src/providers/` or write any real provider.** Tasks 7 and 8 own the repos
  provider; this task ships the seam they must satisfy, and no data.
- **Do not add a dependency.** No zod. `configSchema` stays a structural duck type and
  `package.json` is not edited in this task.
- **Do not key `last` per schedule.** That debt is explicitly deferred by the plan; the rule in
  force is that every schedule branch returns the full merged `Data`.
- **Do not edit `test/rungit.test.ts`'s `GIT_LITERAL` regex.** Settled ruling: it stays completely
  unedited.
- **Do not rename providers, directories, or config keys, and do not revise spec §5's diagram.**
  Naming is Task 1's; the config keys are `repos.*`.
- **Task 2 owns `snapshot()`'s envelope and the `onUpdate` payload.** Do not reshape either, and do
  not touch any `RouteCtx` member. This task redacts only the value that lands in `last`; the
  envelope around it and the failure record beside it are Task 2's and stay exactly as Task 2 left
  them.

---

### Task 6: Wire protocol, WS push, and the first authenticated screen

This task turns the wired-but-headless foundation into a live authenticated screen. It defines one
shared wire vocabulary in `src/core/wire.ts` — imported by both the bun server and the React UI —
finishes `serve.ts`'s WebSocket handler so an authenticated socket is subscribed to a Bun pub/sub
topic and immediately receives `ready` then `snapshot`, registers the scheduler's update listener as
the publisher of `update` frames, and ships the four client modules (`session`, `socket`, `store`,
`api`) plus a `main.tsx` that renders live state as a `<pre>`. It exists because every layer beneath
it has now been built and none of them has ever been exercised together: the scheduler was inert
until Task 2, the config never reached a provider until Task 3, no token was ever issued until Task
4, and no value ever crossed a redaction seam until Task 5. This is the task that proves the whole
column carries load, and it is one of the two coherent stopping points for the plan (the other is
Task 2).

**Depends on:** 2, 3, 4, 5 (strictly — all five tasks edit `src/server/serve.ts` and/or
`src/core/scheduler.ts` and are serialized in that order). Tasks 7 and 8 are parallel-safe with this
one; Task 9 depends on it.

---

## Files

| File | Change |
|---|---|
| `src/core/wire.ts` | **New.** The single wire-protocol definition: topic names, route paths, `ClientFrame`, `ServerFrame`, the closed error-code set and its fixed message table, and the health/snapshot payload types. Zero imports of its own. |
| `src/server/serve.ts` | **Modified.** Subscribe on successful auth only; send `ready` then `snapshot`; handle post-auth `subscribe`/`unsubscribe`; reply to bad frames with closed-set `error` frames; register `scheduler.onUpdate` → `server.publish` before the scheduler is started; add the `frameJson` serialization guard. |
| `web/src/lib/session.ts` | **New.** Token acquisition: read the handoff out of `location.hash`, scrub the fragment **first**, then redeem it, then store. Pure logic behind an injected-deps interface. |
| `web/src/lib/socket.ts` | **New.** WebSocket client: auth frame first, capped jittered reconnect backoff, and on a 1008 close clear the token and stop. Pure logic behind an injected-deps interface. |
| `web/src/lib/store.ts` | **New.** External store for `useSyncExternalStore` with a **cached** snapshot identity. |
| `web/src/lib/api.ts` | **New.** Three typed same-origin fetch helpers: `redeemHandoff`, `getState`, `postAction`. |
| `web/src/main.tsx` | **Rewritten.** Renders live state as a `<pre>`. Keeps a literal `p-4` class in the rendered tree. |
| `test/fixtures/ws.ts` | **New.** Shared test helpers: the `connectWs` cast extracted from `test/serve.test.ts`, plus handoff-file reading and session opening. |
| `test/serve.test.ts` | **Modified, helper extraction only.** Delete the local `connectWs` function and its explanatory comment, import `connectWs` from `./fixtures/ws` instead. Change nothing else — every existing assertion stays byte-identical. |
| `test/ws-protocol.test.ts` | **New.** Ten server-side protocol tests (numbered 1–8, 17 and 18). |
| `test/client-wire.test.ts` | **New.** Eight client-module tests (session ordering, socket backoff, store identity and latching). |

Do **not** edit `src/index.ts`, `src/core/scheduler.ts`, `src/core/contract.ts`, `src/core/registry.ts`,
`src/server/routes.ts`, `src/server/auth.ts` or `src/server/gate.ts` in this task.

---

## Interfaces this task consumes from earlier tasks

These are the exact names this brief is written against. If an earlier task shipped a different
spelling, adapt at the **single** call site named here and nowhere else; do not change the wire
types, which are this task's own.

- **From Task 2** — `ServeConfig` carries optional `providers?: Provider<any, any>[]` and
  `config?: Record<string, unknown>`. **`scheduler.snapshot()` returns
  `Record<string, ProviderStatus>`**, where
  `ProviderStatus = { data?: unknown; schedules: Record<string, ScheduleHealth> }` and
  `ScheduleHealth = { lastSuccessAt: number | null; consecutiveFailures: number; lastErrorMessage: string | null }`.
  The health map is nested **per provider, keyed by schedule name** — deliberately not a flat
  `` `${id}:${name}` `` key, because provider ids are unconstrained at registration and a `:` in an
  id would make a flat key ambiguous. `data` is **absent** until that provider's first successful
  run, and a provider that has neither succeeded nor failed produces **no entry at all**.
  `scheduler.onUpdate`'s listener is called as `(providerId, status: ProviderStatus)` — that second
  argument is `snapshot()[providerId]`, so it already carries the failure record and this task never
  needs to re-read the snapshot to get one. `scheduler.start()` is called inside `startServer` after
  `Bun.serve` has bound. `test/fixtures/provider.ts` exports **`makeFixtureProvider`**, which yields a
  `Provider` plus a test-held `emit()` (the captured `watch` callback), `setData(d)` for what the next
  `fetch` resolves to, and `setWire(v)` for what its `toClient` returns next.
  *Single adapter point:* the two lines in `serve.ts` that read `scheduler.snapshot()`.
- **From Task 4** — `POST /api/session` accepts a JSON body `{ "handoff": "<token>" }` and returns
  `200 { "token": "<session token>" }` or a bare `401`. The boot-minted handoff is written 0600 by
  `startServer` to the path `handoffPath(env)` returns — `<XDG_RUNTIME_DIR>/atrium/handoff.json` —
  and its **contents are JSON**: `{ token, port, pid }`. The handoff to POST is the `.token` field,
  never the file text.
  *Single adapter point:* `test/fixtures/ws.ts`, which imports `handoffPath` from
  `../../src/core/paths` rather than respelling the filename.
- **From Task 5** — `Provider.toClient(data)` is a **required** contract member and the scheduler
  computes the wire value once, using the same variable for the `last` write and the listener
  notification. Everything `serve.ts` reads out of `snapshot()` or receives in `onUpdate` is already
  redacted. This task must **not** call `toClient` itself and must not re-redact.

---

## The wire protocol (authoritative definition)

`src/core/wire.ts` is the single definition imported by both sides. `tsconfig.json` has no `include`,
so `tsc --noEmit` already covers `src/`, `web/`, `test/` and `scripts/` together — one file, one
truth, and a drift between server and UI is a type error rather than a runtime surprise.

**Verified before writing this brief:** Vite 7.3.6 with `root: 'web'` bundles a *value* import of
`../../src/core/wire` from `web/src/main.tsx` with no config change (28 modules transformed, the
constants appear verbatim in the emitted chunk), and `tsc --noEmit` accepts it. So the client may
import wire constants as values, not only as types — **provided `wire.ts` itself imports nothing**.
A `node:path` import added there would break the production bundle at release time and nothing else
in the suite would catch it; Test 8 is the tripwire for that.

```ts
// src/core/wire.ts — NO imports. Types and string constants only.

/** Bun pub/sub topic every authenticated socket joins. Zero-state invariant §8.4. */
export const STATE_TOPIC = 'state'
/** Per-provider narrowing topic. Provider ids match [A-Za-z0-9_-]+, so this never collides with STATE_TOPIC. */
export function providerTopic(providerId: string): string { return `${STATE_TOPIC}:${providerId}` }

export const WS_PATH = '/ws'
export const SESSION_PATH = '/api/session'
export const STATE_PATH = '/api/state'

/**
 * A STRUCTURAL COPY of the scheduler's per-schedule health record
 * (`ScheduleHealth` in src/core/scheduler.ts). It is copied rather than imported
 * because this file must have zero imports — see Test 8 and the Vite note above.
 * `src/server/serve.ts` imports both declarations and carries a one-line compile
 * assertion that keeps them from drifting; if you change either shape, change both.
 */
export interface ScheduleHealth {
  lastSuccessAt: number | null
  consecutiveFailures: number
  lastErrorMessage: string | null
}

/**
 * One provider's status. Structural copy of the scheduler's `ProviderStatus`.
 * `data` is the value `toClient()` produced and is ABSENT until the provider's
 * first successful run. `schedules` is keyed by SCHEDULE NAME, nested under the
 * provider — never a flat `${providerId}:${scheduleName}` key.
 */
export interface ProviderStatus {
  data?: unknown
  schedules: Record<string, ScheduleHealth>
}

/** The body of GET /api/state and the payload of the `snapshot` frame — the same shape, by design. */
export type WireSnapshot = Record<string, ProviderStatus>

export type ClientFrame =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; providerId: string }
  | { type: 'unsubscribe'; providerId: string }

export type ServerFrame =
  | { type: 'ready' }
  | { type: 'snapshot'; providers: WireSnapshot }
  | { type: 'update'; providerId: string; status: ProviderStatus }
  | { type: 'error'; code: WireErrorCode; message: string }

export type WireErrorCode = 'bad-frame' | 'unknown-frame-type' | 'unknown-provider' | 'unserializable'

export const WIRE_ERROR_CODES: readonly WireErrorCode[] =
  ['bad-frame', 'unknown-frame-type', 'unknown-provider', 'unserializable']

/**
 * Fixed messages, one per code. A wire error value is ALWAYS one of these — never a caught
 * exception's `.message`, never an echo of client input. Same closed-set rule Task 5 wrote for
 * provider status values.
 */
export const WIRE_ERROR_MESSAGES: Record<WireErrorCode, string> = {
  'bad-frame': 'malformed frame',
  'unknown-frame-type': 'unsupported frame type',
  'unknown-provider': 'unknown provider',
  'unserializable': 'payload could not be serialized',
}
```

**The `auth` client frame is not a free choice.** `createAuth().authenticateSocket` parses the frame
and requires `msg.type === 'auth'` and `msg.token === sessionToken`. The `ClientFrame` auth variant
must be exactly `{ type: 'auth'; token: string }` — verified against the shipped
`src/server/auth.ts`.

**There is deliberately no `refresh`/`run`/`dispatch` client frame.** `POST
/api/actions/:providerId/:actionId` already carries the Host/Origin gate, the bearer check and
`dispatch`'s static allowlist. A WS frame that triggered `runNow` would run subprocesses through a
path with none of that. Actions go over HTTP, always.

### Subscription semantics

- On successful auth the socket joins `STATE_TOPIC` — the firehose. It then receives every
  provider's `update`.
- `{type:'subscribe', providerId}` narrows: the socket **leaves** `STATE_TOPIC` and joins
  `providerTopic(providerId)`. Further `subscribe` frames add more provider topics.
- `{type:'unsubscribe', providerId}` leaves that provider topic. It never rejoins the firehose.
- Every `update` is published **twice**: once to `STATE_TOPIC` and once to
  `providerTopic(providerId)`. A socket is on the firehose *or* on provider topics, never both, so
  no socket ever receives a duplicate. Publishing to a topic with zero subscribers is free —
  measured on bun 1.3.11: `server.publish` returns `0` and does not throw.
- This narrowing is **bandwidth management, not an authorization control**. The authorization
  control is that an unauthenticated socket is subscribed to nothing at all.

---

## Steps

### A. The wire module

- [ ] Create `src/core/wire.ts` with exactly the contents specified above. No `import` statement of
      any kind, no `require(`. Types, string constants, and the one `providerTopic` helper.

### B. `src/server/serve.ts`

Line numbers in `serve.ts` have shifted since Plan 1: Task 2 widened `ServeConfig` and added
registration, teardown and the scheduler lifecycle, Task 4 inserted the `POST /api/session` route
between the `serveAsset` fallthrough and the bearer check, and Task 5 changed what the scheduler
hands out. Locate the code below **by content**, not by line number.

- [ ] Add `import { STATE_TOPIC, providerTopic, WIRE_ERROR_MESSAGES } from '../core/wire'` and
      `import type { ClientFrame, ServerFrame } from '../core/wire'`.
- [ ] Add a module-level serialization guard, used at **every** site that turns a frame into a
      string:
      ```ts
      const UNSERIALIZABLE_JSON = JSON.stringify(
        { type: 'error', code: 'unserializable', message: WIRE_ERROR_MESSAGES['unserializable'] } satisfies ServerFrame,
      )
      function frameJson(frame: ServerFrame): string {
        try { return JSON.stringify(frame) } catch { return UNSERIALIZABLE_JSON }
      }
      ```
      A provider's wire value is `unknown` and reaches `JSON.stringify` unvalidated; a circular
      reference or a `BigInt` throws `TypeError`. Unguarded, that exception escapes into
      `scheduler`'s listener loop and into the `websocket.message` handler. Never call
      `JSON.stringify` on a frame directly.
- [ ] In `websocket.message`, inside the **successful-auth branch only** — after the
      `authenticateSocket` check has returned true, after `state.authed` is set and the auth timer is
      cleared — add, in this exact order:
      ```ts
      ws.subscribe(STATE_TOPIC)
      ws.send(frameJson({ type: 'ready' }))
      ws.send(frameJson({ type: 'snapshot', providers: scheduler.snapshot() }))
      return
      ```
      **Never call `ws.subscribe` in `websocket.open`.** Bun drops a socket's subscriptions when it
      closes — measured: `server.subscriberCount(STATE_TOPIC)` returns to 0 after a close with no
      server-side bookkeeping — so `websocket.close` needs no change beyond the existing
      `clearTimeout`. Subscribing in `open()` is the natural-looking place, reads as harmless, and
      turns none of Plan 1's 118 tests red; it is also a direct §8.4 violation, because a socket that
      never authenticates would then receive every `update` the scheduler publishes.
- [ ] Replace the placeholder comment at the end of `websocket.message` (the one reading
      "Provider subscriptions land here in a later plan.") with the post-auth frame handler:
      ```ts
      let msg: unknown
      try { msg = JSON.parse(String(raw)) } catch { return sendError(ws, 'bad-frame') }
      const frame = msg as Partial<ClientFrame>
      if ((frame?.type === 'subscribe' || frame?.type === 'unsubscribe')) {
        const id = (frame as { providerId?: unknown }).providerId
        if (typeof id !== 'string' || id.length === 0) return sendError(ws, 'bad-frame')
        if (!registry.get(id)) return sendError(ws, 'unknown-provider')
        if (frame.type === 'subscribe') { ws.unsubscribe(STATE_TOPIC); ws.subscribe(providerTopic(id)) }
        else { ws.unsubscribe(providerTopic(id)) }
        return
      }
      return sendError(ws, 'unknown-frame-type')
      ```
      with a local helper
      `const sendError = (ws, code: WireErrorCode) => { ws.send(frameJson({ type: 'error', code, message: WIRE_ERROR_MESSAGES[code] })) }`.
      A **post-auth `auth` frame is not a valid frame type**: it falls through to
      `unknown-frame-type`, changes nothing, and must not re-enter the auth branch or close the
      socket.
- [ ] The error frame's `message` is **always** `WIRE_ERROR_MESSAGES[code]`. Never
      `(e as Error).message`, never any part of the client's frame. `routes.ts` echoes ids in its HTTP
      400s because those ids came from a validated path regex; a WS frame is arbitrary bytes up to the
      1 MiB `maxPayloadLength` and is never echoed.
- [ ] After the `Bun.serve` try/catch has succeeded (so `server` is assigned) and **strictly before**
      the `scheduler.start()` call Task 2 added, register the publisher:
      ```ts
      scheduler.onUpdate((providerId, status) => {
        const json = frameJson({ type: 'update', providerId, status })
        server.publish(STATE_TOPIC, json)
        server.publish(providerTopic(providerId), json)
      })
      ```
      Registering after `start()` would lose every `runOnStart` update, which Task 2 now awaits before
      the intervals are installed. The whole body is already exception-free through `frameJson`; wrap
      it in an additional `try { … } catch { }` so no future edit inside it can throw into the
      scheduler's listener loop.
- [ ] The `update` frame carries the whole `ProviderStatus` — `data` **and** `schedules` — because
      Task 9's mandatory unavailable-vs-zero mutation check has no data otherwise. Task 2 hands the
      listener exactly that envelope, so do not unpack it into a bare `data` and do not drop the
      health half "because the snapshot already sent it": a provider whose schedule started failing
      after the snapshot would otherwise never reach the UI.
- [ ] Add the one-line compile-time bridge that keeps `src/core/wire.ts`'s copies of `ProviderStatus`
      and `ScheduleHealth` from drifting from the scheduler's originals. In `src/server/serve.ts`
      (which already imports from both modules), next to the `frameJson` helper:
      ```ts
      import type { ProviderStatus as SchedulerProviderStatus } from '../core/scheduler'
      import type { ProviderStatus as WireProviderStatus } from '../core/wire'
      // Drift guard: wire.ts cannot import from scheduler.ts (Test 8 forbids every
      // import there, because Vite bundles wire.ts into the browser build). These two
      // assignments make a divergence a `tsc` error instead of a runtime surprise.
      const _wireMatchesScheduler: WireProviderStatus = {} as SchedulerProviderStatus
      const _schedulerMatchesWire: SchedulerProviderStatus = {} as WireProviderStatus
      void _wireMatchesScheduler; void _schedulerMatchesWire
      ```
- [ ] Leave the CSP header alone. It already ships
      `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`, which is exactly what a page
      served from either host needs. Do not add `style-src` or `'unsafe-inline'` (Ruling D).

### C. Client modules

All four modules must be importable under `bun test` with no DOM. **No module-scope access to
`window`, `document`, `localStorage`, `location` or `history` in any file under `web/src/lib/`** —
every browser touch lives inside a `browser*Deps()` factory that only `main.tsx` calls. Tailwind
classes only; no `style={{}}` props anywhere (Ruling D: the CSP ships `default-src 'self'` with no
`style-src` and no `'unsafe-inline'`, the failure is silent, and `scripts/assert-package.ts` uses
`fetch` and never a browser, so it can structurally never observe a CSP violation).

- [ ] `web/src/lib/api.ts` — three helpers, all same-origin, all relative paths, token in the
      `Authorization` header and **never** in a URL:
      - `export async function redeemHandoff(handoff: string): Promise<string | null>` — `POST`
        `SESSION_PATH` with `content-type: application/json` and body
        `JSON.stringify({ handoff })`; returns `body.token` on 200, `null` on any other status.
      - `export async function getState(token: string): Promise<WireSnapshot>` — `GET` `STATE_PATH`
        with `Authorization: Bearer ${token}`.
      - `export async function postAction(token, providerId, actionId, target): Promise<{ ok: boolean; error?: string }>`
        — `POST` to `/api/actions/${providerId}/${actionId}` with the bearer header and
        `JSON.stringify(target)` as the body.
      A same-origin browser `POST` sends `Origin` and `Sec-Fetch-Site: same-origin` automatically, so
      all three pass `checkRequest`; the absent-Origin rejection only bites non-browser callers.
- [ ] `web/src/lib/session.ts`:
      ```ts
      export const TOKEN_STORAGE_KEY = 'atrium.token'
      export const HANDOFF_RE = /^[A-Za-z0-9_-]{16,256}$/
      export interface SessionDeps {
        storage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
        getHash(): string
        clearHash(): void
        redeem(handoff: string): Promise<string | null>
      }
      export function parseHandoff(hash: string): string | null
      export async function acquireToken(deps: SessionDeps): Promise<string | null>
      export function clearToken(deps: Pick<SessionDeps, 'storage'>): void
      export function browserSessionDeps(): SessionDeps
      ```
      `parseHandoff` strips a single leading `#` and returns the value only if it matches
      `HANDOFF_RE` (the mint produces 43 base64url characters from 32 random bytes; the range is
      deliberately wider than 43 so a future token length is not a client change). Anything else
      returns `null`.

      `acquireToken` runs in exactly this order:
      1. `const handoff = parseHandoff(deps.getHash())`
      2. if `handoff` is non-null: **`deps.clearHash()` first**, then
         `const t = await deps.redeem(handoff)`; if `t` is non-null,
         `deps.storage.setItem(TOKEN_STORAGE_KEY, t)` and return `t`.
      3. return `deps.storage.getItem(TOKEN_STORAGE_KEY)` (may be `null`).

      Scrubbing before the network call is §8.3's requirement, not a nicety: the fragment must not
      survive a failed or slow redemption in the address bar, browser history or a subsequent
      referrer. **A fresh handoff beats a stored token** — `sessionToken` is regenerated on every
      `startServer`, so after `systemctl --user restart atrium` the stored token is dead and the
      stored-first ordering would strand the user on a token that can only ever 401.

      `clearToken` calls `deps.storage.removeItem(TOKEN_STORAGE_KEY)`.

      `browserSessionDeps()` returns `{ storage: localStorage, getHash: () => location.hash,
      clearHash: () => history.replaceState(null, '', location.pathname + location.search),
      redeem: redeemHandoff }`. The `clearHash` replacement URL must never include `location.hash`.
- [ ] `web/src/lib/socket.ts`:
      ```ts
      export const RECONNECT_BASE_MS = 500
      export const RECONNECT_CAP_MS = 15_000
      export interface SocketDeps {
        url: string
        token(): string | null
        onFrame(frame: ServerFrame): void
        onOpen(): void
        onClose(): void
        onAuthFailure(): void
        createSocket(url: string): WebSocket
        setTimer(fn: () => void, ms: number): unknown
        clearTimer(handle: unknown): void
        random(): number
      }
      export interface SocketHandle { close(): void }
      export function connect(deps: SocketDeps): SocketHandle
      export function browserSocketDeps(partial): SocketDeps   // fills createSocket/setTimer/clearTimer/random from globals
      ```
      Behaviour:
      - On `open`, send `JSON.stringify({ type: 'auth', token })` as the **first** frame. If
        `deps.token()` is `null`, do not open at all.
      - On `message`, `JSON.parse` inside a try/catch; on success call `deps.onFrame(frame)`; on
        failure ignore the frame (never throw into the event handler).
      - On a `ready` frame, reset the reconnect attempt counter to 0 and call `deps.onOpen()`.
      - On `close` with code **1008**, call `deps.onAuthFailure()` and **stop permanently** — no
        reconnect, ever. 1008 is the server's code for a bad first frame *and* for the auth-window
        timeout; both mean the stored token is worthless. The caller wires `onAuthFailure` to
        `clearToken` plus a re-read of the fragment.
      - On any other close, schedule a reconnect:
        `const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt)` then
        `const sleep = delay * (0.5 + deps.random() * 0.5)`, then `deps.setTimer(reopen, sleep)` and
        `attempt++`. The cap is applied **before** the jitter.
      - `close()` on the returned handle clears any pending timer, marks the handle disposed, and
        closes the live socket. A disposed handle never reconnects.
- [ ] `web/src/lib/store.ts`:
      ```ts
      export interface AtriumState {
        connected: boolean
        /** True once a `snapshot` frame has been applied. Initial value: false. */
        hasSnapshot: boolean
        providers: WireSnapshot          // Record<providerId, ProviderStatus>
      }
      export interface Store {
        subscribe(cb: () => void): () => void
        getSnapshot(): AtriumState
        apply(frame: ServerFrame): void
        setConnected(connected: boolean): void
      }
      export function createStore(): Store
      ```
      There is no separate `health` member: the failure record lives inside each provider's
      `ProviderStatus.schedules`, which is where Task 9 reads it from.

      **`hasSnapshot` is load-bearing, not bookkeeping.** Task 9's pane distinguishes `loading` from
      `unavailable` on it, and `connected` cannot stand in: a socket can be connected with no
      snapshot applied yet, and can be disconnected after one. Set it `true` in `apply`'s `snapshot`
      branch and **never reset it** — in particular `setConnected(false)` must leave it alone, or a
      reconnect flashes the pane back to `loading`.
      `getSnapshot` returns a **cached** object reference. A new object is built only inside `apply`
      or `setConnected`, and only when something actually changed; `getSnapshot` itself never
      allocates. `scheduler.snapshot()` returns a fresh `Object.fromEntries` on every call, so an
      unmemoized passthrough into `useSyncExternalStore` surfaces as "Maximum update depth exceeded"
      — an infinite render loop, not a clear error.

      `apply` handles each `ServerFrame`:
      - `ready` → no state change (connection state is `setConnected`'s job).
      - `snapshot` → replace `providers` wholesale **and set `hasSnapshot` to `true`**.
      - `update` → replace **only** `providers[frame.providerId]` with `frame.status` (keeping every
        other provider's value at its existing object identity). A `ProviderStatus` whose `data` key
        is missing — normal, because `JSON.stringify` drops an `undefined` value and Task 2 omits
        `data` until the first success — is stored with the key still **absent**, never coerced to
        `null`: Task 9's `entry.data === undefined` branch is what distinguishes `unavailable` from
        `empty`, and a `null` there would break it.
      - `error` → no state change; the frame is dropped. (A visible error surface is Task 9's job.)
      Subscribers are notified exactly once per applied change, and not at all when nothing changed.
- [ ] `web/src/main.tsx` — rewrite:
      - `const store = createStore()` at module scope.
      - `useSyncExternalStore(store.subscribe, store.getSnapshot)`. **This is the live-state call site
        Task 9 replaces the `<pre>` at**; there is no `useAtriumState()` wrapper hook and Task 9 is
        told not to expect one. The value it yields is `AtriumState`, so `state.hasSnapshot` and
        `state.providers` are what Task 9's pane derives from.
      - On mount (`useEffect` with an empty dep array): `acquireToken(browserSessionDeps())`; if it
        resolves `null`, render the unauthenticated notice; otherwise `connect(...)` against
        `` `ws://${location.host}${WS_PATH}` `` and return the handle's `close` as the effect cleanup.
      - Wire `onAuthFailure` to `clearToken(browserSessionDeps())` followed by a re-render into the
        unauthenticated notice.
      - Render `<pre className="…">{JSON.stringify(state, null, 2)}</pre>`.
      - The unauthenticated notice is plain text telling the user to run `atrium open --print-url`.
      - **Checklist item, not a footnote: keep a literal `p-4` class on the rendered root element.**
        Measured: the entire built stylesheet is ~4.1 KB containing two rules, and
        `.p-4{padding:calc(var(--spacing) * 4)}` — sourced solely from the class in the old
        `web/src/main.tsx:5` — is the only thing satisfying `scripts/assert-package.ts:108-113`. Drop
        it and the release gate fails with a message blaming a Tailwind config problem that does not
        exist. Re-verified for this brief: a rewritten `main.tsx` keeping only `className="p-4"`
        still emits `padding:calc(var(--spacing) * 4)` under tailwindcss 4.3.3. The `id="canary"`
        attribute and `text-emerald-500` are **not** load-bearing — nothing reads them — and may go.
      - No `dangerouslySetInnerHTML`, no `new URL()` over provider data, no `style={{}}`.

### D. Test helpers

- [ ] Create `test/fixtures/ws.ts` (bun's test matcher only picks up `*.test.ts`, so a helper module
      under `test/fixtures/` is not collected — same as the existing `test/fixtures/gitrepo.ts`):
      ```ts
      import { handoffPath } from '../../src/core/paths'   // Task 4's exported path builder
      export function connectWs(url: string, origin: string): WebSocket   // moved verbatim, comment included
      /** Reads Task 4's boot handoff FILE and returns its `token` field. */
      export function readHandoff(runtimeDir: string): string
      export async function openSession(port: number, runtimeDir: string): Promise<string>
      ```
      `readHandoff` is
      `JSON.parse(readFileSync(handoffPath({ XDG_RUNTIME_DIR: runtimeDir }), 'utf8')).token as string`.
      Two details are not optional: the path comes from `handoffPath`, **never** from a filename
      respelled here (Task 4 writes `handoff.json`, and a second spelling in a test helper is a
      silent 401 at setup time); and the value POSTed is the parsed `.token`, **never** the file text,
      which is a JSON document `{ token, port, pid }` that `consumeHandoff` answers with a 401.
      `openSession` reads the handoff, `POST`s `{ handoff }` to
      `http://127.0.0.1:${port}/api/session` with headers
      `{ host: \`127.0.0.1:${port}\`, origin: \`http://127.0.0.1:${port}\`, 'content-type': 'application/json' }`
      — both headers are required, `checkRequest` rejects a non-GET with no `Origin` — and returns
      `body.token`, throwing with the status code if the response is not 200.
      **This file is the one place Task 4's handoff filename and body/response key names appear.**
- [ ] Edit `test/serve.test.ts`: delete the local `connectWs` function and the comment block above it,
      add `import { connectWs } from './fixtures/ws'`. No other change; all of its existing
      assertions must still pass unmodified.

### E. Acceptance

- [ ] `bun test` — Plan 1's 118 tests plus everything Tasks 1–5 added stay green, and the new files
      pass.
- [ ] `bun run typecheck` clean.
- [ ] `bun run build && bun run assert:package` passes against the rewritten `main.tsx`. Run it
      explicitly; `assert:package` still has no caller until Task 10 chains it into `bun run verify`.
- [ ] Every mutation in the **Mutations** section below performed, observed red, reverted, observed
      green. Record the result; Task 10 re-runs all of them in one pass.

---

## Tests

### `test/ws-protocol.test.ts` (new)

**Port allocation: this task owns 7412–7421, one port per test** (tests 1–7 take 7412–7418, test 17
takes 7419, test 18 takes 7420, and 7421 is spare; test 8 and the client-wire tests bind nothing). Per the plan-wide port ledger:

**Port ledger for Plan 2 — one table, published once and pasted into every brief that binds a port.
Do not re-derive it; a range not listed against your task is not yours.**

| Range | Owner |
|---|---|
| 7373 | `scripts/assert-package.ts` (existing) |
| 7391-7403 | `test/serve.test.ts` (existing) |
| 7404-7411 | Task 4 |
| 7412-7421 | Task 6 |
| 7422-7423 | Task 3 |
| 7424 | Task 9 |
| 7430-7433 | Task 2 |

Every test
creates its own `mkdtempSync` scratch directory, passes it as
`env: { XDG_RUNTIME_DIR: scratch }`, and removes it in a `finally` (carry-forward P3 asks for exactly
this hygiene). Every test calls `s.stop()`.

Each test registers fixture providers through `startServer({ providers: [...], config: {} })` and
drives updates through the fixture's captured `emit()` — **never** through a `runOnStart` race, which
is flaky in exactly the way this project has been burned by.

1. **`'an unauthenticated socket is subscribed to nothing and receives nothing, even while updates are being published'`** (port 7412)
   One fixture provider with id `fixture`. `wsAuthTimeoutMs: 5000`, so the auth-window close does not
   race the assertions. Open socket A and wait for its `open` event; send nothing. Assert
   `s.subscriberCount(STATE_TOPIC)` is `0`. Call `emit()` and wait 150 ms. Assert A received `[]`.
   Assert `s.subscriberCount(STATE_TOPIC)` is still `0`. This is the positive, deterministic form of
   §10:534-535's mandated WS-auth-gate check: the publish actually happens during the pre-auth
   window, so "received zero frames" is a claim about a real opportunity to leak rather than about an
   idle server.

2. **`'an authenticated socket receives ready then snapshot, in that order, and nothing before its auth frame'`** (port 7413)
   Fixture `fixture` with Data set to `{ n: 1 }`. Open a socket, send
   `{type:'auth', token}` from `openSession(...)` on `open`, collect frames. Assert exactly two
   frames arrive; `JSON.parse(frames[0]).type === 'ready'`; `JSON.parse(frames[1]).type ===
   'snapshot'`; the snapshot frame's `providers` is an object whose `fixture` entry has a
   `schedules` object; and `s.subscriberCount(STATE_TOPIC)` is `1`. Also assert `frames.length` was
   `0` at the moment the auth frame was sent. *(That last assertion cannot distinguish where the
   sends live — see M3 — so it is a readability aid, not the pin; Test 1 is the pin.)*

3. **`'an update frame arrives on the fixture emit, carrying the provider id and the failure record'`** (port 7414)
   Authenticate, drain `ready` + `snapshot`. Set the fixture's Data to `{ n: 2 }`, call `emit()`,
   await the next frame. Assert `type === 'update'`, `providerId === 'fixture'`, `status.data`
   deep-equals the fixture's wire value, and `status.schedules` is an object containing the key
   `provider.schedules[0]!.name` — computed in the test from the fixture, not hardcoded — whose entry
   has the keys `lastSuccessAt`, `consecutiveFailures` and `lastErrorMessage`.

4. **`'a socket that subscribed to one provider does not receive another provider\'s updates'`** (port 7415)
   Two fixtures, `alpha` and `beta`. Authenticate one socket, drain, send
   `{type:'subscribe', providerId:'alpha'}`, wait 50 ms for the server to process it. Call `beta`'s
   `emit()`, wait 100 ms, then call `alpha`'s `emit()` and await one frame. Assert that frame is
   `{type:'update', providerId:'alpha'}` **and** that the total count of collected `update` frames is
   exactly 1. Include this comment verbatim in the test body:
   `// Bandwidth management, NOT an authorization control. The authorization control is test 1: an`
   `// unauthenticated socket is subscribed to nothing. Never cite this test as an access check.`

5. **`'closing one authenticated socket leaves the other subscribed and still receiving updates'`** (port 7416)
   Authenticate sockets A and B. Assert `s.subscriberCount(STATE_TOPIC)` is `2`. Close A from the
   client side and poll `s.subscriberCount(STATE_TOPIC)` until it is `1` (50 ms interval, 3 s
   deadline). Call `emit()`. Assert B receives exactly one `update` frame, A received nothing after
   its close, and `GET /healthz` still returns 200. Bun's own close handling is what prunes the
   subscription — measured, `subscriberCount` returns to 0 with no server-side bookkeeping — so this
   pins that the implementation uses topic routing rather than a hand-rolled socket set that would
   need pruning.

6. **`'an unserializable provider payload degrades to an error frame and the socket survives'`** (port 7417)
   Fixture whose wire value starts as `{ ok: true }`. Authenticate, drain. Switch the fixture's wire
   value to an object with a circular self-reference, `emit()`, await one frame: assert
   `{type:'error', code:'unserializable', message: WIRE_ERROR_MESSAGES['unserializable']}`. Switch
   back to `{ ok: true }`, `emit()`, await one frame: assert a normal `update` frame arrives — the
   connection survived. Assert `GET /healthz` returns 200.

7. **`'post-auth frames are answered with closed-set error codes that never echo client input'`** (port 7418)
   Authenticate, drain, then send three frames and collect three replies:
   - `'not json at all'` → `{code:'bad-frame', message: WIRE_ERROR_MESSAGES['bad-frame']}`
   - `JSON.stringify({type:'auth', token})` → `{code:'unknown-frame-type'}`, **and the socket is
     still open** (assert no close event fired) — a post-auth auth frame must not re-enter the auth
     branch and must not close the socket.
   - `JSON.stringify({type:'subscribe', providerId:'definitely-not-registered'})` →
     `{code:'unknown-provider'}`
   For all three assert `WIRE_ERROR_CODES.includes(frame.code)` and
   `frame.message === WIRE_ERROR_MESSAGES[frame.code]` — the equality is what forbids an exception
   message or an echo.

8. **`'src/core/wire.ts has no imports, so the UI bundle can take it whole'`**
   `readFileSync('src/core/wire.ts', 'utf8')`; assert `/^\s*import\b/m` does not match and
   `/\brequire\s*\(/` does not match. Comment the reason: Vite builds `web/` with `root: 'web'` and
   bundles this file from outside that root (verified: vite 7.3.6 transforms it with no config
   change); a `node:` import here breaks the production bundle at release time, and the unit suite,
   which runs under bun where `node:` imports resolve fine, would never notice.

17. **`'a run still in flight when stop() is called publishes nothing to a socket that was open'`** (port 7419)
   The teardown-ordering pin. Task 2 implements `shutdown` as `scheduler.stop(); cleanup()` and states
   in writing that the ordering is **not observable from Task 2** — this task creates the
   `onUpdate → server.publish` wire that makes it observable, so the test belongs here and Task 10's
   mutation row names it. Fixture whose `fetch` resolves after ~50 ms. Authenticate a socket, drain
   `ready` + `snapshot`, call `emit()` to start the slow run, then call `s.stop()` ~10 ms later.
   Wait 200 ms and assert the socket collected **no** `update` frame after the drain, and that no
   unhandled rejection was recorded (wrap the body with a `process.on('unhandledRejection', …)`
   collector, as `test/contract.test.ts` already does). With `originalStop()` running first, the
   run's post-await notify lands after the server closed.

18. **`'a Data sentinel never reaches a WS update frame'`** (port 7420)
   The WS half of Task 5's redaction proof, which Task 5 explicitly defers to this task and Task 10's
   mutation row 6 requires to exist. Fixture whose `fetch` resolves
   `{ token: 'atrium-redaction-sentinel-9f2c41', n: 1 }` and whose `toClient` allowlists `{ n }`.
   Authenticate, drain, `emit()`, await the `update` frame. Assert **positively first** that
   `frame.status.data` deep-equals `{ n: 1 }`, then that the **raw text** of every frame the socket
   collected does not contain `'atrium-redaction-sentinel-9f2c41'`. Assert on the raw text, not on the
   parsed object: the claim is about the bytes on the wire, and a structural assertion can miss a
   sentinel hiding in a key name.

### `test/client-wire.test.ts` (new)

No server, no ports, no DOM — every dependency is injected. These exist because the scoping doc
specifies the *ordering* and *failure handling* of these client modules explicitly, and an ordering
requirement with no test is a comment.

9. **`'acquireToken scrubs the fragment before it POSTs the handoff'`**
   Deps whose `clearHash` and `redeem` each push their name onto a shared `calls: string[]`. Hash is
   `'#' + 'a'.repeat(43)`. Assert `calls` equals `['clearHash', 'redeem']` and that the returned
   token was written to storage under `TOKEN_STORAGE_KEY`.

10. **`'a fresh handoff in the fragment beats a stored token'`**
    Storage pre-seeded with `'stale-token'`; hash carries a valid handoff; `redeem` resolves
    `'fresh-token'`. Assert `acquireToken` resolves `'fresh-token'` and storage now holds
    `'fresh-token'`. Comment the reason: `sessionToken` is regenerated on every `startServer`, so
    every `systemctl --user restart atrium` strands a stored token — this is the common path, not an
    edge case.

11. **`'a malformed fragment is never sent to the server'`**
    Hash `'#<script>alert(1)</script>'`, storage holding `'stored'`. Assert `redeem` was never
    called, `clearHash` **was** called, and the result is `'stored'`.

12. **`'a 1008 close clears nothing on the wire and stops reconnecting'`**
    Fake socket factory counting calls. Drive `open` (assert the first frame sent is
    `{type:'auth', token}`), then `close` with code `1008`. Assert `onAuthFailure` was called exactly
    once, and that after draining every scheduled timer the factory was called exactly **once** — no
    reconnect.

13. **`'a non-auth close reconnects with a capped, jittered delay'`**
    Injected `random: () => 0.5` and a fake timer recording each requested delay. Drive seven
    consecutive `close(1006)` cycles. Assert the recorded delays are exactly
    `[375, 750, 1500, 3000, 6000, 11250, 11250]` — `min(15000, 500 * 2 ** attempt)` capped first,
    then multiplied by `0.5 + 0.5 * random()`.

14. **`'the store hands useSyncExternalStore a stable snapshot identity'`**
    `const a = store.getSnapshot(); expect(store.getSnapshot()).toBe(a)`. Apply an `update` frame;
    `const b = store.getSnapshot(); expect(b).not.toBe(a); expect(store.getSnapshot()).toBe(b)`.
    Also assert a subscriber fired exactly once for that one frame. Comment the failure mode: an
    unmemoized `getSnapshot` surfaces in React 19 as "Maximum update depth exceeded", not as a clear
    error.

15. **`'an update replaces only its own provider entry'`**
    Apply a `snapshot` frame with `providers: { a: {n:1}, b: {n:2} }`; capture
    `const bBefore = store.getSnapshot().providers.b`. Apply
    `{type:'update', providerId:'a', status:{ data:{n:9}, schedules:{} }}`. Assert `providers.a`
    deep-equals `{ data:{n:9}, schedules:{} }` and `providers.b` **is** `bBefore` (identity).

16. **`'a snapshot frame latches hasSnapshot, and a disconnect does not clear it'`**
    Fresh store: assert `getSnapshot().hasSnapshot` is `false`. Apply a `snapshot` frame; assert it
    is `true`. Call `setConnected(false)`; assert `connected` is `false` and `hasSnapshot` is still
    **`true`**. Comment the reason: Task 9 renders `loading` off this flag, so clearing it on a
    disconnect flashes a populated pane back to a spinner on every reconnect.

---

## Mutations

Each line is an exact edit to make, the test it must turn red, and the restoration. Perform every one
and record red-then-green. Task 10 re-runs this list.

| # | Exact mutation | Must turn red |
|---|---|---|
| M1 | In `serve.ts`, move `ws.subscribe(STATE_TOPIC)` out of the successful-auth branch and into `websocket.open(ws)`. | **Test 1** on both assertions: `subscriberCount` is 1 before auth, and socket A receives the `update` frame published by `emit()`. *(This is the scoping doc's mandated mutation. Note that a version of Test 1 which only asserted "received zero frames" without publishing anything during the pre-auth window would stay **green** under this mutation — that is why Test 1 fires `emit()` and checks `subscriberCount`.)* |
| M2 | In `serve.ts`, swap the two `ws.send` calls in the auth branch so `snapshot` is sent before `ready`. | **Test 2** on the frame-order assertions. |
| M3 | In `serve.ts`, move the `ready`/`snapshot` sends from the auth branch into `websocket.open(ws)`. | **Test 1** only — socket A receives frames it never authenticated for. *(Test 2 stays **green** under M3 and must not be listed: its frames still arrive in order, and its `frames.length === 0` check is taken inside the client's own `open` handler, before any server message can be delivered, so it cannot distinguish the two placements.)* |
| M4 | In `serve.ts`'s `onUpdate` listener, publish only the data half: replace `status` in the `update` frame with `{ data: status.data, schedules: {} }`. | **Test 3** on the `status.schedules` key assertion. |
| M5 | *(withdrawn — see the honesty note below the table. Do not record a red for it.)* | — |
| M6 | In `serve.ts`, make the `subscribe` frame handler a no-op (delete both the `ws.unsubscribe(STATE_TOPIC)` and the `ws.subscribe(providerTopic(id))` calls, keeping the validation). | **Test 4** — the socket stays on the firehose and collects beta's update, so the update count is 2. |
| M7 | In `serve.ts`, replace the two `server.publish(...)` calls with a loop over a module-scope `const live = new Set<ServerWebSocket<WsState>>()` populated in the auth branch and never pruned, sending with `ws.send(json)`. | **Test 5** — `s.subscriberCount(STATE_TOPIC)` is 0 at both checkpoints. *(Measured: `ws.send` on a closed socket returns 0 and does **not** throw on bun 1.3.11, and neither does `server.publish` after `server.stop()`. So a "does not throw" assertion here would be vacuous — `subscriberCount` is what makes the topic-routing design falsifiable.)* |
| M8 | In `serve.ts`, replace `frameJson(frame)` with a bare `JSON.stringify(frame)` at the `onUpdate` listener's call site. | **Test 6** — the `unserializable` error frame never arrives (the `TypeError` escapes the listener). |
| M9 | In `serve.ts`, replace `frameJson(frame)` with a bare `JSON.stringify(frame)` at the auth branch's `snapshot` call site, and make the fixture's wire value circular before the socket authenticates. | **Test 6**'s companion path — if this cannot be reached from Test 6 as written, extend Test 6 with a second socket that authenticates while the wire value is circular and assert it still receives `ready` followed by an `unserializable` error frame. |
| M10 | In `serve.ts`'s `sendError` helper, replace `WIRE_ERROR_MESSAGES[code]` with `(e as Error).message` from the `JSON.parse` catch. | **Test 7** on `frame.message === WIRE_ERROR_MESSAGES['bad-frame']`. |
| M11 | In `serve.ts`, delete the `registry.get(id)` check in the subscribe handler. | **Test 7** — the `unknown-provider` reply never arrives. |
| M12 | Add `import { join } from 'node:path'` at the top of `src/core/wire.ts`. | **Test 8**. |
| M13 | In `session.ts`'s `acquireToken`, swap the `deps.clearHash()` and `await deps.redeem(handoff)` statements. | **Test 9** on the `calls` ordering. |
| M14 | In `session.ts`'s `acquireToken`, move the stored-token read to the top and return early when it is non-null. | **Test 10** — the stale token is returned. |
| M15 | In `session.ts`'s `parseHandoff`, delete the `HANDOFF_RE.test(...)` guard. | **Test 11** — `redeem` is called with the script string. |
| M16 | In `socket.ts`, remove the 1008 special case so every close schedules a reconnect. | **Test 12** — the socket factory is called twice. |
| M17 | In `socket.ts`, delete the `Math.min(RECONNECT_CAP_MS, …)` cap. | **Test 13** — the sixth delay becomes **12000** (`500 * 2 ** 5 * 0.75`), not 11250, and the seventh becomes 24000. |
| M18 | In `store.ts`, change `getSnapshot` to `() => ({ ...state })`. | **Test 14** on the first `toBe`. |
| M19 | In `store.ts`'s `update` branch, rebuild `providers` from scratch instead of copying the existing entries. | **Test 15** on the `providers.b` identity assertion. |
| M21 | In `store.ts`'s `setConnected`, also reset `hasSnapshot` to `false` when `connected` is `false`. | **Test 16**. |
| M22 | In `serve.ts`'s `server.stop` wrapper (Task 2's `shutdown`), call `originalStop()` **before** `scheduler.stop()`. | **Test 17** — the in-flight run resolves after the close and publishes an `update`. |
| M23 | In `src/core/scheduler.ts`, write the raw `data` into `last` instead of the `toClient` value (Task 5's M1, re-run from here). | **Test 18** — the sentinel appears in the WS frame text. |

**M5, withdrawn and stated honestly — do not paper over it with a test that cannot fail.** The
tempting mutation "register `scheduler.onUpdate(...)` **after** `scheduler.start()`" turns **zero**
tests red, for two independent reasons. Task 2 ships `void scheduler.start().catch(() => {})`, and an
`async` function body runs synchronously only up to its first `await` — `start()` suspends inside the
first `runOnStart` run, control returns to `startServer`, and the registration on the next statement
still lands before any update fires. And every WS test observes only frames received *after* a socket
authenticates, so an update lost before any socket exists is unobservable from this file regardless.
Keep the ordering (registering after `start()` is wrong the moment `start()` becomes synchronous
again) and comment it as an invariant; do not add a `runOnStart: true` schedule and claim it as
coverage.
| M20 | In `web/src/main.tsx`, remove the `p-4` class from the rendered root. | `bun run build && bun run assert:package` — "served CSS contains no Tailwind utility". *(Not a `bun test` failure: this gate has no caller until Task 10.)* |

#### Task 6 addendum — the ports, every mutation row measured, and the failure-record channel on the WS wire

> Recorded HERE, in the tracked plan, for the same reason Tasks 3–5's were: **Task 10 re-runs this
> whole mutation table**, `.superpowers/sdd/` is gitignored, and a row that cannot redden its named
> test would read as a regression when Task 10 runs it. Every row below was run on `a8552d2` plus
> this task's commits, the plan's literal text first, on the FULL suite (`bun test`), by exact-string
> replacement that refuses to apply unless every target occurs exactly once, then reverted with
> `git checkout` and re-run green. Baseline 187 pass / 0 fail / 466 expect() across 13 files; exit
> **205 / 0 / 561 across 15 files** (+18 tests: ten protocol, eight client). Every runtime mutant
> typechecks (exit 0) except M10-literal, which does not compile.

**Ports.** The table above and the test list say 7412–7421. **7412 was already taken** by Task 4's
fix round (`test/serve.test.ts`, the malformed/unknown/replayed `POST /api/session` test). Task 6
binds **7413–7421**: tests 1–7 → 7413–7419, test 17 → 7420, test 18 → 7421. There is no spare.

**Pre-code audit (a8552d2).** Every serve.ts, wire.ts and web/ target string was absent — the only
hits for `server.publish` and `scheduler.onUpdate` were inside the placeholder comment. M22's
`const shutdown = () => { scheduler.stop(); cleanup() }` and M23's `last.set(providerId, wire)`
existed, but tests 17 and 18 did not, so no row could redden before the code landed. The real
measurement is the one below.

| # | The plan says | Measured | The realisable row |
|---|---|---|---|
| M1 | `ws.subscribe(STATE_TOPIC)` into `websocket.open` → Test 1 on both assertions | **204 / 1** — exactly Test 1, on the first `subscriberCount` (`Expected: 0 / Received: 1`, :103); the frame assertion is not reached | as written |
| M2 | swap the two `ws.send` calls → Test 2 | **203 / 2** — Test 2 (`Expected: "ready" / Received: "snapshot"`) **plus Test 6's M9 leg**, whose second socket also asserts `ready` first (`Received: "error"`). A first measurement reddened all seven `authedSocket` callers because the helper re-asserted the order; the helper now drains without asserting, so Test 2 owns the claim | as written |
| M3 | ready/snapshot sends into `open` → Test 1 only; Test 2 stays green | **197 / 8.** Test 1 red as named (`- [] / + ["{type:ready}","{type:snapshot,…}"]`). **Plan 1's three zero-state tests in `test/serve.test.ts`** (`close(1008) on a bad first frame`, `when no frame is ever sent`, `oversized pre-auth frame`) are red on the same diff — the section's "turns none of Plan 1's tests red" is true of M1, not of M3. Tests 3, 5, 6, 18 are red as a **timing artefact of the mutant**: the two frames now arrive from `open()` before the server has processed the auth frame, so "drained" no longer means "subscribed" and `emit()` fires before the subscribe (`timed out waiting for frame 3; have 2`, and Test 5's count `Expected: 2 / Received: 1`). **Test 2 stays green**, exactly as the plan says | as written; expect eight, not one |
| M4 | publish `{ data: status.data, schedules: {} }` → Test 3 | **204 / 1** — exactly Test 3 (`Expected to contain: "poll" / Received: []`) | as written |
| M5 | withdrawn | Demonstration run anyway: publisher registered after `void scheduler.start()` → **205 / 0**, the whole suite green, as the honesty note predicts. No red recorded | withdrawn |
| M6 | subscribe handler a no-op → Test 4 | **204 / 1** — exactly Test 4 (`Expected: 1 / Received: 2`) | as written |
| M7 | publishes → loop over a never-pruned `Set` populated in the auth branch → Test 5, count 0 at both checkpoints | **Literal text keeps `ws.subscribe(STATE_TOPIC)`** (it only replaces the publishes), so `subscriberCount` is still 2 and **Test 5 stays GREEN**; the literal reddens only Test 4 (the loop ignores narrowing, `Received: 2`). **204 / 1** | **M7-realisable**: additionally replace `ws.subscribe(STATE_TOPIC)` in the auth branch with `live.add(ws)` — **202 / 3**: Test 5 as named (`Expected: 2 / Received: 0`), Test 2 (`subscriberCount` `Expected: 1 / Received: 0`) and Test 4. This is the row Task 10 should run |
| M8 | bare `JSON.stringify` at the `onUpdate` call site → Test 6 | **204 / 1** — exactly Test 6 (`timed out waiting for frame 3`: the `TypeError` is swallowed by the listener's try/catch and no frame is sent) | as written |
| M9 | bare `JSON.stringify` at the auth branch's `snapshot` site, wire value circular before auth | Not reachable from Test 6 as first written; Test 6 was **extended with the second socket** the plan describes. **204 / 1** — exactly Test 6, on that leg: `TypeError: JSON.stringify cannot serialize cyclic structures` escapes the message handler after `ready`, the error frame never arrives | as written, with the extension |
| M10 | in `sendError`, `WIRE_ERROR_MESSAGES[code]` → `(e as Error).message` "from the JSON.parse catch" | **Cannot compile as written** — `e` is not in scope in `sendError`: `serve.ts(82,54): error TS2304: Cannot find name 'e'`. Run anyway: **203 / 2** — Test 7 AND `test/serve.test.ts`'s `a socket that authenticates stays open…` (a `ReferenceError` on every post-auth frame closes the socket) | **M10-realisable**: at the parse site, `catch (e) { ws.send(frameJson({ type: 'error', code: 'bad-frame', message: (e as Error).message })); return }` — **204 / 1**, exactly Test 7: `- "message": "malformed frame" / + "message": "JSON Parse error: Unexpected identifier "not""`. (`return ws.send(...)` fails tsc TS2322 because `ws.send` returns a number; use the statement form) |
| M11 | delete the `registry.get(id)` check → Test 7 | **204 / 1** — exactly Test 7 (`timed out waiting for frame 5; have 4`) | as written |
| M12 | `import { join } from 'node:path'` atop wire.ts → Test 8 | **204 / 1** — exactly Test 8 (`Expected: false / Received: true`). tsc exit 0 under the mutant — the compiler does not see this one | as written |
| M13 | swap `clearHash()` / `await redeem()` → Test 9 | **204 / 1** — exactly Test 9 (`calls` order) | as written |
| M14 | stored-token read first, early return → Test 10 | **203 / 2** — Test 10 (`Expected: "fresh-token" / Received: "stale-token"`) **plus Test 11** (`cleared` `Expected: 1 / Received: 0`: the early return skips the scrub as well) | as written; expect two |
| M15 | delete the `HANDOFF_RE.test` guard → Test 11 | **204 / 1** — exactly Test 11 (`redeemed` `+ ["<script>alert(1)</script>"]`) | as written |
| M16 | remove the 1008 special case → Test 12 | **204 / 1** — exactly Test 12 (`authFailures` `Expected: 1 / Received: 0`) | as written |
| M17 | delete the `Math.min` cap → Test 13 | **204 / 1** — exactly Test 13 (`- 11250, - 11250 / + 12000, + 24000`), the values the plan predicts | as written |
| M18 | `getSnapshot: () => ({ ...state })` → Test 14 | **204 / 1** — exactly Test 14 (`Received: serializes to the same string`) | as written |
| M19 | rebuild `providers` from scratch → Test 15 | Realised as `providers: structuredClone({ ...state.providers, [id]: status })`. **204 / 1** — exactly Test 15 on the `providers.b` identity | the `structuredClone` form |
| M21 | `setConnected(false)` also resets `hasSnapshot` → Test 16 | **First measurement 205 / 0 — GREEN.** Test 16 as written calls `setConnected(false)` on a fresh store that is already disconnected, and the "notify not at all when nothing changed" rule this section itself requires makes that a no-op: the mutant line never runs. Test 16 now calls `setConnected(true)` first. Re-measured: **204 / 1**, exactly Test 16 (`hasSnapshot` `Expected: true / Received: false`) | as written, against the strengthened Test 16 |
| M22 | `originalStop()` before `scheduler.stop()` in the stop wrapper → Test 17 | **205 / 0 — GREEN**, and it cannot be otherwise: both calls are synchronous and land in the same tick, so nothing resumes between them and the ORDER is unobservable — from this task or any other. What Test 17 pins is that `scheduler.stop()` runs on the stop path at all | **M22-realisable**: `const shutdown = () => { cleanup() }` — **201 / 4**: Test 17 as named (frames `Expected: 2 / Received: 3` — the in-flight run publishes its `update` to the still-open socket after `server.stop()`), plus `test/serve-providers.test.ts`'s `server.stop() stops the scheduler`, `a process with a registered provider exits after stop()`, and `SIGTERM stops the scheduler…`. Task 10 should run this form and expect four |
| M23 | scheduler.ts `last.set(providerId, data)` → Test 18 | **201 / 4** — Test 18 as named (`+ "token": "atrium-redaction-sentinel-9f2c41"` in `.data`), Task 5's two (`contract.test.ts:333`, `routes.test.ts:155`, as in Task 5's M1) **plus Test 6**: with raw Data in `last` the circular wire value never reaches a frame, so no `unserializable` error is produced (`Received: { type: "update", … }`). Four red, all consistent with the mutation; scheduler.ts reverted, never committed | as written; expect four |
| M20 | remove `p-4` from the rendered root → `assert:package` fails | **First measurement GREEN, CSS byte-identical (same hash).** The explanatory comment in `main.tsx` spelled `p-4`, and **Tailwind v4's scanner reads candidates out of comments**, so the utility was still emitted with the attribute gone. The comment was reworded (`b930a04`) to not spell the class. Re-measured with `grep -c 'p-4' web/src/main.tsx` = 0 under the mutant: `PACKAGING ASSERTION FAILED: - served CSS contains no Tailwind utility — v3 config artifacts?`, exit 1, CSS 4.09 kB; reverted → `packaging ok`, exit 0. Run ONLY as `RD=$(mktemp -d) && XDG_RUNTIME_DIR=$RD bun run build && XDG_RUNTIME_DIR=$RD bun run assert:package; rm -rf $RD` — `scripts/assert-package.ts:48` spawns the binary with no `XDG_RUNTIME_DIR` of its own and would otherwise write a live handoff into the operator's real runtime dir | as written, provided `p-4` occurs exactly once in `web/src/` — Task 10 must grep before trusting the row |

**Other corrections to the section, all applied.**

- **Test 11 vs. Step C's `acquireToken` order.** Step 2 scrubs only when the handoff parses; Test 11
  requires `clearHash` to be called on a junk fragment. Shipped: any non-empty fragment is scrubbed,
  only one matching `HANDOFF_RE` is redeemed; M13's swap target is unchanged inside the parsed branch.
- **The boot handoff is single-use**, so a test with two sockets (5, 6) calls `openSession` once and
  shares the token: `authedSocket(port, token)`, not `(port, scratch)`.
- **Test 2's "fixture with Data set to `{ n: 1 }`"** needs a run to have happened: a provider that has
  neither succeeded nor failed has no snapshot entry, so the test drives one `emit()` and waits for
  `fetchCount >= 1` before authenticating.
- "The two lines in `serve.ts` that read `scheduler.snapshot()`" — one existed (the routes ctx); the
  second is the one this task adds in the auth branch.
- `ScheduleHealth` IS exported from `scheduler.ts` (:11); the drift guard covers `ProviderStatus`,
  which nests it structurally, so both shapes are pinned by the two assignments.
- expect() count before any edit: 466 in the brief and in my first run, 467 once after the serve.ts
  commit with no test file touched — the variance lives in existing polling tests, not here.

**G5 — the failure-record channel now reaches the WS wire; recorded, not fixed.** The Task 5
addendum records that `schedules.*.lastErrorMessage` carries a provider exception's `.message`
verbatim, outside `toClient`, into `/api/state`. This task's `update` frame carries the whole
`ProviderStatus` (required above, for Task 9's unavailable-vs-zero check) and the `snapshot` frame
carries every provider's, so the same text now reaches both WS frames. `scheduler.ts` is forbidden
here and a wire-side sanitizer would be the second redaction site this plan forbids. **Test 18
asserts only that the Data sentinel is absent from `.data`; its body says in words that it does not
cover exception text, and it must not be cited as if it did.** Owner: a plan-level ruling — sanitize
at `recordFailure`, or replace the message with a closed-set code plus a server-side message.
Carried forward to Task 10.

**Fix round (minors only; both review lenses approved the task with 0 Important).** Base `89eb962`,
205 / 0 / 561 across 15 files. Exit **206 / 0 / 567** (+1 test), typecheck 0. Six rows.

- **F-A — a `null` message body could throw into the WebSocket listener (real; the only code fix).**
  `web/src/lib/socket.ts` parsed inside a try/catch, as §8.4 requires, and then handed the parsed
  value to `deps.onFrame` whatever it was. `JSON.parse` succeeds on `null`, `42` and `"str"`; only
  `not json` throws, and that one the try/catch already covered. `onFrame` is `store.apply`, which
  reads `frame.type`, so a body of `null` raised a `TypeError` **inside** the event listener — the
  exact failure the try/catch exists to prevent. `frame?.type === 'ready'` guarded the ready branch
  but not the `onFrame` call. Fixed with `if (typeof parsed !== 'object' || parsed === null) return`
  after the parse; arrays still pass and are harmless (`[].type` is `undefined`, the switch falls
  through). New **test 19** in `test/client-wire.test.ts` wires the fake socket to a REAL
  `createStore()` and fires all four bodies. **MUTATION M24** — exact-string delete of that one guard
  line; typechecks (exit 0); **RED 205 / 1 / 562**, exactly test 19,
  `expect(received).not.toThrow()` / `TypeError: null is not an object (evaluating 'frame.type')` at
  `test/client-wire.test.ts:262`. Reverted → **GREEN 206 / 0 / 567**. Only the `null` body reddens it;
  `42` and `"str"` survive the mutant because `(42).type` is merely `undefined`. Row for Task 10.
- **F-B — Test 17's mutation comment named an unobservable literal.** It cited M22 as written
  (`originalStop()` before `scheduler.stop()`), which the M22 row above measures GREEN and explains
  can never be otherwise. Reworded to name **M22-realisable** (`const shutdown = () => { cleanup() }`,
  four red) and to say the test pins that `scheduler.stop()` runs on the stop path at all, not that
  it runs first. Comment only — nothing measurable changed.
- **F-C — Test 5's mutation comment described the M7 literal but claimed the realisable row's
  outcome.** The literal replaces the publishes only, keeps `ws.subscribe(STATE_TOPIC)`, and reddens
  Test 4 alone; `subscriberCount` is 0 only under **M7-realisable**, which also replaces the
  subscribe with `live.add(ws)`. Reworded to say both. Comment only — nothing measurable changed.
- **F-D — `src/core/wire.ts` claimed a provider-id charset that nothing enforces.** The
  `providerTopic` doc comment said "Provider ids match `[A-Za-z0-9_-]+`, so this never collides with
  STATE_TOPIC". `registry.register()` checks duplicate ids, duplicate action ids and the three
  schedule-shape rules; it applies **no charset regex** — ids are unconstrained at registration.
  Reworded: the non-collision holds **by construction**, because `providerTopic` always yields
  `state:<id>`, which is never the string `state`, for any id whatsoever. Comment only — nothing
  measurable changed.
- **F-E — `onAuthFailure`: the plan says two different things; shipped follows main.tsx. Recorded,
  not resolved.** The socket bullet says the caller wires it to "`clearToken` plus a re-read of the
  fragment"; the `main.tsx` bullet says `clearToken(browserSessionDeps())` followed by a re-render
  into the unauthenticated notice. Shipped is the main.tsx form
  (`clearToken(...); setAuthed(false)`), and it is the right one on the facts: `acquireToken`
  scrubbed the fragment at mount, so a re-read at 1008 time finds an empty hash and can only
  re-derive the stored token that was just cleared. **`web/src/lib/socket.ts:71` still carries the
  socket bullet's wording verbatim** ("plus a re-read of the fragment") and was left as found,
  because correcting it would settle the ambiguity rather than record it. Whichever way the ruling
  goes, exactly one of the two sites needs an edit. Owner: plan-level ruling. Carried to Task 10.
- **F-F — cross-file port check.** `grep -n 7412 test/ws-protocol.test.ts` hits **only lines 11-12**,
  the comment recording the ports ruling. Every bound port in that file is a `const port =` in
  7413-7421, with no reuse. 7412 stays with `test/serve.test.ts` (Task 4's fix round). No collision,
  masked or otherwise; no test was moved.

---

## Out of scope for this task

- **`show diff`, and actions generally.** No action buttons, no `postAction` call site. `api.ts`
  exports `postAction` so Task 9 has it; this task does not invoke it.
- **The repos provider.** Tasks 7 and 8 own `src/providers/repos/`. This task's tests use fixture
  providers only. `src/index.ts` is not edited and registers no provider.
- **The repos pane, and any rendering beyond a `<pre>`.** No `web/src/panes/`, no per-provider
  components, no loading/unavailable/empty visual states — Task 9 owns all of that. This task only
  guarantees the `health` record reaches the client so Task 9 has data to render.
- **Any WS frame that triggers work.** No `refresh`, no `run`, no `dispatch` client frame, now or
  as a "just in case" union member. Actions go over `POST /api/actions/:providerId/:actionId`.
- **Minting, rotating or expiring tokens.** Task 4 owns `auth.ts` and `/api/session`; this task only
  redeems. Do not add a mint route, a refresh route, or a token-rotation frame.
- **Changing `scheduler.snapshot()`'s shape, the failure-record shape, or `toClient`.** Tasks 2 and 5
  own those. If something is missing, adapt in `serve.ts` and record it as an uncertainty rather than
  editing `src/core/scheduler.ts` or `src/core/contract.ts`. **Asserting** that redaction holds on the
  wire is, however, squarely this task's job — Task 5 defers the WS half of its sentinel proof to
  here, and Test 18 is it.
- **Widening `gate.ts`'s origin or `Sec-Fetch-Site` allowlists for a Vite dev server.** Measured and
  forbidden; Task 10 documents the dev loop (`build:web && gen:assets && bun run src/index.ts serve`)
  that makes it unnecessary.
- **Adding a CSP `style-src` or `'unsafe-inline'`, or any `style={{}}` prop.** Ruling D.
- **Chaining `assert:package` into a script.** Task 10 owns `bun run verify`. Run it by hand here.
- **Adding jsdom, happy-dom, a React test renderer, or any new dependency.** `package.json`
  dependencies stay react + react-dom. The client modules are testable because their browser
  dependencies are injected, not because a DOM is emulated.
- **Per-schedule keying of `last`.** Documented deferred debt in the scheduler; not this task's.
- **Editing `test/rungit.test.ts`'s `GIT_LITERAL` regex.** Ruling A — completely unedited, in this
  task and every other.

---

### Task 7: repos provider — discovery, validity gate, classifier

This task ships the first real provider: `createReposProvider()` in `src/providers/repos/`, a factory
returning a `Provider<ReposConfig, ReposData>` with two schedules (`discovery` every 600_000 ms,
`metadata` every 30_000 ms, both `runOnStart`). It delivers only the **discovery half**: walk the
configured roots, find repository candidates, put each through a validity gate built on
`git rev-parse --absolute-git-dir`'s **exit code** plus a gitdir-vs-candidate containment comparison,
then run each surviving candidate through a **five-row, first-match-wins classifier** (worktree →
submodule → vendored → container → ambiguous) that decides whether the repo is a project the user
should see. Dropped candidates are **reported in `Data`, never silently discarded**. Per-repo metadata
(branch, state, uncommitted count, last-commit time) and the three `exec` actions are Task 8's job;
this task ships the repo table, the `Data` shape both tasks share, and the fixture builders Task 8
reuses. It exists because every proposal for this plan agreed the discovery classifier is where the
previous design revision was factually wrong — revision 1's "drop repos nested inside another repo"
rule hid five of the most active repositories on the reference machine — and because the classifier's
row order is a silent-wrong-answer machine: testing `check-ignore` before the worktree row surfaces
every linked worktree as a project, and no test that does not specifically pin the order will notice.

**Depends on:** Task 1 (`GitResult.timedOut`), Task 3 (config parsed inside `createScheduler`).
Parallel-safe with Tasks 4, 5 and 6. Task 8 and Task 9 depend on this task.

---

### State you are building on (described as it is AFTER Tasks 1 and 3, not as it is today)

Do not read these files expecting the pre-task text. Both are changed by tasks that land before you.

- **`src/core/rungit.ts` (after Task 1).** `runGit(repoPath: string, args: string[], opts?: { timeoutMs?: number }): Promise<GitResult>`
  is the **only** path to the git binary. `GitResult` is
  `{ stdout: string; stderr: string; code: number | string; timedOut: boolean }`. `code` is `number`
  for any real git exit (including 128) and can be the **string** `'ENOENT'` when the child never
  started — narrow with `typeof code === 'number'` before any comparison. `timedOut` is `true` when
  the child was killed by `opts.timeoutMs`; a timed-out call **also** reports `code: 1`, byte-identical
  to a genuine `check-ignore -q --` miss (measured: `execFile` sets `err.killed = true`,
  `err.signal = 'SIGTERM'` and leaves `err.code` undefined, which `runGit` folds to `1`). `runGit`
  already supplies `--no-pager --no-optional-locks` and the `-c` hardening prefix and already does
  `-C <resolve(repoPath)>` — **never** pass `--no-optional-locks` yourself, and `args[0]` must be the
  subcommand.
- **`src/core/scheduler.ts` (after Task 3).** `createScheduler` calls `p.configSchema.parse(raw['repos'])`
  once at construction and serves **that parsed value** both as the `cfg` argument of `fetch` and as
  `configFor('repos')`. Your `fetch` therefore receives a fully-defaulted `ReposConfig`, never a raw
  JSON fragment and never `undefined`. `last` is still keyed by **provider id alone**, which is why
  the "every schedule branch returns the full merged Data" rule below is load-bearing.
- **`src/core/contract.ts`.** `Provider<Cfg, Data>` requires `id`, `configSchema`, `detect`,
  `schedules`, `fetch`, `actions`; `watch` is optional. Task 5 adds a **required** `toClient(data)`
  member. Step 12 below makes your provider satisfy it whether Task 5 has landed yet or not.

### Standing constraints you will trip over if you skip them

- **`test/rungit.test.ts`'s `GIT_LITERAL` tripwire scans every `.ts` file under `src/` and is NOT
  being edited.** The regex is `/(['"`])(?:[^'"`]*[\\/])?git\1/i`: it flags any quoted string whose
  entire content is `git`, or that ends in `/git` or `\git`. **Comments count** — the scan is over raw
  file text. Measured clean and safe to write in `src/providers/repos/`: `'repos'`, `'rev-parse'`,
  `'check-ignore'`, `'ls-files'`, `'--absolute-git-dir'`, `'gitdir'`, `'.git'`, `'.gitignore'`,
  `'160000'`. Measured as tripping it: `'git'`, `"/usr/bin/git"`, and a quoted `'git'` inside a
  comment. Layers 1 and 2 of the same tripwire also apply to your files: **no `node:child_process`
  import, no `Bun.spawn`/`Bun.spawnSync`, no `Bun.$`**. Everything reaches git through `runGit`.
  Test files are not scanned (`walk('src')` only), so `test/` may use the literal freely.
- **Config keys are `repos.*`** — `repos.staleDays`, `repos.extraRoots`, `repos.includeDotPaths`,
  `repos.treatAsContainer`. Never `git.*`. The scheduler looks config up by provider id, so a `git.*`
  key is always `undefined` and silently falls back to a default.
- **No zod.** `package.json` dependencies are `react` and `react-dom` only. `configSchema` is a
  structural duck type `{ parse(x: unknown): Cfg }`; write it by hand.
- **`tsconfig.json` has `strict`, `noUncheckedIndexedAccess` and `noFallthroughCasesInSwitch` on.**
  Every array/record index is `T | undefined`. `bun run typecheck` must be clean.
- **§10 rule 1: no test may assert a count or path derived from the developer's `$HOME`.** Every test
  in this task passes an explicit fixture `homeDir` into the factory. Nothing in
  `test/repos-discovery.test.ts` may reference `homedir()`, `process.env.HOME` or `~`.
- **§10 rule 2: every git call in a fixture runs under the `CLEAN_ENV` constant already defined at the
  top of `test/fixtures/gitrepo.ts`** (`PATH=/usr/bin:/bin`, `HOME=/nonexistent`,
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`). Reuse that constant; do not inline a
  second copy and do not omit the two `GIT_CONFIG_*` entries.

---

### Files

| File | Change |
|---|---|
| `src/providers/repos/config.ts` | **New.** `ReposConfig`, `REPOS_CONFIG_DEFAULTS`, `reposConfigSchema` — the hand-written `.parse` for the four `repos.*` keys. |
| `src/providers/repos/index.ts` | **New.** `createReposProvider()` factory, the `ReposData`/`RepoEntry`/`DroppedCandidate` types, `repoId`, `reposToClient`, the walker, the validity gate and the classifier. |
| `test/fixtures/gitrepo.ts` | **Modified.** Adds the discovery fixture builders (all 13 §10 shapes), the slow-git shim, temp-dir tracking and `cleanupFixtures()`. Existing exports (`makeRepo`, `makeMaliciousRepo`, `makeSingleVectorRepo`, `wasPwned`, `ALL_VECTORS`, `Vector`) keep their current signatures and behaviour — `makeRepo` gains only the tracking call. |
| `test/repos-discovery.test.ts` | **New.** Discovery, gate, classifier, config and redaction tests, plus `afterAll(cleanupFixtures)` (carry-forward P3). |

No other file is touched. In particular: `src/core/scheduler.ts`, `src/core/registry.ts`,
`src/server/serve.ts`, `src/index.ts` and `test/rungit.test.ts` are **not** edited by this task.
Task 2 built the `ServeConfig.providers` seam; **Task 9 owns the two lines in `src/index.ts` that put
`createReposProvider()` into it**, and its smoke test is what proves the wiring.

---

### Steps

#### A. Config (`src/providers/repos/config.ts`)

- [ ] Export `export interface ReposConfig { staleDays: number; extraRoots: string[]; includeDotPaths: boolean; treatAsContainer: string[] }`.
      All four fields are **required on the parsed value** — defaulting happens inside `parse`, so no
      consumer ever writes `cfg.staleDays ?? 30`.
- [ ] Export `export const REPOS_CONFIG_DEFAULTS: ReposConfig = { staleDays: 30, extraRoots: [], includeDotPaths: false, treatAsContainer: [] }`.
      `staleDays` default 30 is fixed by §7.1.
- [ ] Export `export const reposConfigSchema: { parse(x: unknown): ReposConfig }`. `parse` must
      **transform**, never pass its input through — a `{ parse: x => x }` shape is exactly the stub
      that made Plan 1's config coverage undetectable. Rules, in order:
  - [ ] `undefined` or `null` → return a **fresh** object equal to `REPOS_CONFIG_DEFAULTS` (fresh, so
        two providers cannot alias one mutable default).
  - [ ] Anything that is not a plain object (a string, a number, an array) → `throw new Error('repos config: expected an object')`.
  - [ ] **Reject unknown keys**: any own enumerable key not in the four-name set →
        `throw new Error(\`repos config: unknown key "\${key}"\`)`. This exists because a typo such as
        `staledays`, or a stale `git.staleDays` block copied under `repos`, would otherwise fall back
        to 30 in complete silence — defect class 2 of this plan's defect list.
  - [ ] `staleDays`: if present, must satisfy `typeof v === 'number' && Number.isFinite(v) && v > 0`,
        else `throw new Error('repos config: staleDays must be a positive finite number')`.
  - [ ] `includeDotPaths`: if present, must be `typeof v === 'boolean'`, else
        `throw new Error('repos config: includeDotPaths must be a boolean')`.
  - [ ] `extraRoots` and `treatAsContainer`: if present, must each be an array of strings where every
        entry `startsWith('/')` (absolute), else
        `throw new Error(\`repos config: \${key} must be an array of absolute paths\`)`. Copy the
        arrays into new arrays on the way out.
- [ ] Do **not** freeze the returned object here; Task 3 owns the frozen-vs-mutable ruling for the
      config record as a whole. Just never mutate `cfg` inside this provider.

#### B. Types and identity (`src/providers/repos/index.ts`)

- [ ] `export type DropReason = 'worktree' | 'submodule' | 'vendored' | 'ambiguous' | 'invalid' | 'timed-out'`.
- [ ] `export type ReposErrorCode = 'root-missing' | 'root-unreadable' | 'candidate-error'` — a
      **closed set**. Nothing derived from a caught exception, and no path, ever enters this channel
      (§7.4's closed-set rule, which Task 5 makes a contract-wide requirement).
- [ ] `export interface RepoEntry { id: string; path: string; name: string; gitDir: string; bare: boolean; origin: 'top-level' | 'container-child' }`
      — `path` and `gitDir` are absolute and realpath-resolved; `name` is `basename(path)`.
- [ ] `export interface DroppedCandidate { id: string; path: string; name: string; reason: DropReason }`.
- [ ] `export interface ReposData { repos: RepoEntry[]; dropped: DroppedCandidate[]; errors: ReposErrorCode[]; scannedAt: number; staleDays: number }`
      — `staleDays` is copied from `cfg` at fetch time so Task 9's pane can apply the
      "needs attention" rule without a second config channel (`toClient` receives only `Data`).
- [ ] `export interface ReposProviderDeps { homeDir?: string; classifyTimeoutMs?: number }` — the
      test seam. `homeDir` defaults to `homedir()` from `node:os`; `classifyTimeoutMs` defaults to the
      exported `DEFAULT_CLASSIFY_TIMEOUT_MS`. These exist so §10 rule 1 is satisfiable at all: without
      an injectable home the suite could only assert against the developer's real `$HOME`.
- [ ] `export function repoId(absPath: string): string` = `createHash('sha256').update(absPath).digest('hex').slice(0, 16)`
      (`node:crypto`). Deterministic, so tests compute the expected id rather than reading it back.
      `id` is a stable client-side handle (useful as a React key and for correlating rows across
      refreshes). It is **not** what Task 8's action target validation keys on — that keys on the
      absolute `path`, which is a key of the `table` map.
- [ ] Module constants: `export const DISCOVERY_INTERVAL_MS = 600_000`,
      `export const METADATA_INTERVAL_MS = 30_000`,
      `export const DEFAULT_CLASSIFY_TIMEOUT_MS = 5_000`,
      `const CLASSIFY_CONCURRENCY = 8`, `const MAX_SCAN_DEPTH = 8`,
      `const PRUNE_DIR_NAMES = new Set(['node_modules'])`.

#### C. The walker

- [ ] Roots = `[deps.homeDir ?? homedir(), ...cfg.extraRoots]`, each mapped through
      `realpathSync` and deduped. A root that does not exist or whose `realpathSync` throws pushes
      `'root-missing'` into `errors` and is skipped — **discovery must not throw for it**.
- [ ] Walk each root depth-first with `readdirSync(dir, { withFileTypes: true })`, up to
      `MAX_SCAN_DEPTH` levels below the root. A `readdirSync` that throws pushes `'root-unreadable'`
      and that subtree is skipped; the rest of the scan continues.
- [ ] **Never follow symlinks.** `Dirent.isDirectory()` is `false` for a symlink-to-directory
      (readdir uses lstat semantics), so only recurse into entries where `isDirectory()` is true. This
      is the cycle guard and the `$HOME`-escape guard in one.
- [ ] Prune, before recursing into a directory entry named `n`:
  - [ ] `n === '.git'` → never descend, in either `includeDotPaths` mode.
  - [ ] `n.startsWith('.')` and `cfg.includeDotPaths === false` → do not descend, and the directory is
        not a candidate. This is §7.1 Rule 1 ("drop repos under a dot-directory, and repos whose own
        basename starts with a dot") implemented as a prune. The roots themselves are **exempt**: a
        root named in `extraRoots` whose own basename starts with a dot is still scanned, because
        `extraRoots` is the documented escape hatch for chezmoi/yadm/`~/.dotfiles` users.
  - [ ] `PRUNE_DIR_NAMES.has(n)` → do not descend.
  - [ ] A directory already identified as a **bare** repo candidate → do not descend (its `objects/`
        and `refs/` subtrees are not projects).
- [ ] A directory `D` (each root included, then every directory reached by the walk) is a **candidate**
      when either:
  - [ ] `existsSync(join(D, '.git'))` — the ordinary, worktree and submodule shapes; or
  - [ ] all three of `join(D, 'HEAD')`, `join(D, 'objects')`, `join(D, 'refs')` exist — the bare shape.
        §10 lists "bare repo" among the discovery shapes and Task 8 gates metadata on
        `rev-parse --is-bare-repository`, so bare repos must reach the table.
  - [ ] Do continue descending into a candidate that is not bare: nested repos are the whole point of
        the container rule.
- [ ] Collect candidates as realpath-resolved absolute paths, deduped, sorted ascending by path. The
      sort is the determinism the tests rely on.

#### D. The validity gate

- [ ] For each candidate `C`, run `await runGit(C, ['rev-parse', '--absolute-git-dir'], { timeoutMs })`.
- [ ] Reject unless `typeof code === 'number' && code === 0`. The gate is on the **exit code**, not on
      emptiness: measured on git 2.55.0, a non-repo directory exits **128**
      ("not a git repository"), a **0-byte `.git` file** exits **128** ("invalid gitfile format"), and
      a **dangling `gitdir:` pointer** exits **128** ("not a git repository: (null)"). §7.1's
      "returns empty" case therefore never occurs with code 0, and the string `'ENOENT'` code must not
      be compared numerically — hence the `typeof` narrowing.
- [ ] Let `gitDir = realpathSync(stdout.trim())` when that path exists, else `stdout.trim()`.
- [ ] **Containment comparison — the second half of the gate.** `--absolute-git-dir` walks **up**:
      measured, running it in a plain subdirectory of a repo exits **0** and returns the *ancestor's*
      gitdir. Accept `C` only if one of:
  - [ ] `gitDir === join(C, '.git')` — ordinary repo; set `bare = false`.
  - [ ] `gitDir === C` — bare repo; set `bare = true`.
  - [ ] `lstatSync(join(C, '.git')).isFile()` — a `.git` **file**, so the gitdir legitimately lives
        elsewhere (linked worktree → `<main>/.git/worktrees/<name>`; submodule →
        `<parent>/.git/modules/<name>`, both measured). Set `bare = false`; the classifier decides.
  - [ ] Otherwise the candidate is a subdirectory of some other repo — record it in `dropped` with
        `reason: 'invalid'` and stop. This is what stops `extraRoots: ['/home/u/proj/src']` from
        surfacing `src` as its own repository.
- [ ] Any gate call with `timedOut === true` → `dropped` with `reason: 'timed-out'`, never `'invalid'`.
- [ ] A candidate that throws anything unexpected → push `'candidate-error'` into `errors`, drop the
      candidate with `reason: 'invalid'`, and keep scanning. One bad repository must never abort the
      scan.

#### E. The classifier — five rows, first match wins, in exactly this order

Run only for candidates that passed the gate. "Parent" means the **longest** valid candidate path `P`
that is a strict path prefix of `C` (i.e. `C.startsWith(P + sep)`); if there is none, `C` is
`origin: 'top-level'` and only row 1 applies. `rel` is `relative(P, C)` — always pass it after a `--`.

- [ ] **Row 1 — linked worktree.** `existsSync(join(gitDir, 'gitdir'))` → **drop**, `reason: 'worktree'`.
      Measured: a linked worktree's git dir contains a file literally named `gitdir`; a submodule's
      git dir (`<parent>/.git/modules/<name>`) does **not**. Applies even with no parent repo.
- [ ] **Row 2 — submodule.** `runGit(P, ['ls-files', '-s', '--', rel], { timeoutMs })`; take the first
      line of `stdout`, split on whitespace, and match field 0 against `'160000'` → **drop**,
      `reason: 'submodule'`. Measured shape: `160000 <sha> 0\tsub`.
- [ ] **Row 3 — vendored.** `runGit(P, ['ls-files', '--', rel], { timeoutMs })`; `stdout.trim() !== ''`
      → **drop**, `reason: 'vendored'`. Gate on **output**, not exit code: measured, `ls-files` exits
      **0** whether or not it matched anything.
- [ ] **Row 4 — container.** `runGit(P, ['check-ignore', '-q', '--', rel], { timeoutMs })`;
      `typeof code === 'number' && code === 0` → **surface** `C` with `origin: 'container-child'`.
      Measured: exit 0 = ignored, exit 1 = not ignored, exit 128 = not a repository. A `cfg.treatAsContainer`
      entry whose realpath equals `P` forces this row to match regardless of `check-ignore`.
- [ ] **Row 5 — ambiguous.** Everything else → **drop**, `reason: 'ambiguous'`, and the entry **must**
      appear in `ReposData.dropped`. §7.1: discovery reports dropped-ambiguous candidates rather than
      silently deciding.
- [ ] **Timeout short-circuit.** If any of rows 2–4's `runGit` calls returns `timedOut === true`, stop
      classifying `C` immediately and drop it with `reason: 'timed-out'`. Without this, a timed-out
      `check-ignore` returns `code: 1` — byte-identical to a genuine "not ignored" — and the repo is
      silently reclassified as ambiguous and dropped. This is the entire reason Task 1 added
      `GitResult.timedOut`.
- [ ] Narrow `typeof code === 'number'` before **every** comparison in this section.
- [ ] Row order is not negotiable and the two overlapping rows are the reason. A worktree at
      `worktrees/feat` inside a repo whose `.gitignore` contains `worktrees/` matches **both** row 1
      (drop) and row 4 (surface) — verified in a live fixture: `check-ignore -q -- worktrees/feat`
      exits 0 there. An implementer who tests `check-ignore` first surfaces every worktree as a
      project. Row 2 must precede row 3 for the same reason: a submodule is also tracked, so
      `ls-files -- sub` is non-empty and row 3 would claim it with the wrong reason.
- [ ] Run classification with bounded concurrency `CLASSIFY_CONCURRENCY` (8). Order of the results
      must not depend on completion order — sort `repos` and `dropped` by `path` ascending before
      returning.

#### F. The provider object

- [ ] `export function createReposProvider(deps: ReposProviderDeps = {}): Provider<ReposConfig, ReposData>`.
      A **factory**, not a module singleton: each call owns its own repo table so fixture tests are
      isolated and §10:517's "providers are `fetch(cfg) → Data`, testable against fixtures" survives.
- [ ] Closure state:
      ```ts
      const table = new Map<string, RepoEntry>()   // absolute realpath -> entry. A MAP, not an array:
                                                   // Task 8's resolveTarget validates an action target
                                                   // by exact string equality against a key of this
                                                   // map, and Task 8 reads it through a getter.
      let dropped: DroppedCandidate[] = []
      let errors: ReposErrorCode[] = []
      let scannedAt = 0
      let lastCfg: ReposConfig | undefined         // set at the top of fetch; Task 8's action layer
                                                   // reads it through a getter (exec actions get no cfg).
      ```
      A discovery pass rebuilds `table` in place (`table.clear()` then `set` each surviving entry) so
      the getter Task 8 holds keeps seeing the live table. Discovery writes all of this; Task 8's
      metadata pass reads and mutates the entries.
- [ ] `id: 'repos'`.
- [ ] `configSchema: reposConfigSchema`.
- [ ] `detect: async () => ({ kind: 'nothing-to-detect', reason: 'first run is not implemented in this slice' })`
      — first run (`detect()` → confirm → persist) is deferred by this plan; `detect` stays a required
      contract member with no caller.
- [ ] `schedules: [{ name: 'discovery', intervalMs: DISCOVERY_INTERVAL_MS, runOnStart: true }, { name: 'metadata', intervalMs: METADATA_INTERVAL_MS, runOnStart: true }]`.
- [ ] `actions: []` — Task 8 fills this. Do not add an action here.
- [ ] `fetch(cfg, ctx)` branches on `ctx.schedule` with a **total default branch**:
      `'discovery'` → run the scan, replace the closure state, return `buildData(cfg)`;
      `'metadata'` → return `buildData(cfg)` unchanged (Task 8 replaces this branch body with the
      per-repo pass); `default` → return `buildData(cfg)`. An unknown schedule name must never throw
      and must never return a partial object.
- [ ] `buildData(cfg)` returns
      `{ repos: [...table.values()], dropped: [...dropped], errors: [...errors], scannedAt, staleDays: cfg.staleDays }`,
      with the extracted array sorted by `path` ascending as specified above.
- [ ] **Documented rule, in a comment on `fetch`: every schedule branch returns the FULL merged
      `ReposData`.** The scheduler's `last` map is keyed by provider id alone, so a branch returning a
      metadata-only fragment would overwrite the repo list in `snapshot()` every 30 seconds. Per-schedule
      keying of `last` is deferred debt; this rule plus its pinning test is what stands in for it.
- [ ] Honour `ctx.signal`: check `ctx.signal.aborted` between walk batches and between classification
      batches and return early. The scheduler suppresses post-abort state writes, but a `$HOME` scan
      that keeps spawning git after `stop()` is still wrong.

#### G. Redaction

- [ ] Declare the wire types alongside the function, so Tasks 8 and 9 import them rather than
      restating them:
      ```ts
      export interface RepoWire { id: string; path: string; name: string; bare: boolean; origin: 'top-level' | 'container-child' }
      export interface DroppedWire { id: string; name: string; reason: DropReason }
      export interface ReposWire {
        repos: RepoWire[]
        dropped: DroppedWire[]
        errors: ReposErrorCode[]
        scannedAt: number
        staleDays: number
      }
      ```
      Task 8 **extends `RepoWire`** with its metadata fields (`branch?`, `repoState?`,
      `rebaseProgress?`, `uncommittedCount?`, `lastCommitAt?`, `metaStatus`, `metaReason?`) and
      extends the allowlist to match; Task 9 imports both interfaces type-only.
- [ ] `export function reposToClient(data: ReposData): ReposWire` — an explicit **field-by-field
      allowlist**, never `{ ...data }` with deletions:
      `{ repos: data.repos.map(r => ({ id: r.id, path: r.path, name: r.name, bare: r.bare, origin: r.origin })), dropped: data.dropped.map(d => ({ id: d.id, name: d.name, reason: d.reason })), errors: [...data.errors], scannedAt: data.scannedAt, staleDays: data.staleDays }`.
      **`path` is on the wire on purpose** (settled cross-task ruling): it is the identifier Task 9's
      action buttons post back and the key Task 8's `resolveTarget` validates against the discovered
      table, which is the control that makes accepting it safe. Record the residual in a one-line note
      next to the allowlist: absolute `$HOME`-relative repository paths reach an authenticated,
      same-origin client. `gitDir` **never** crosses this seam, and neither does any **dropped**
      candidate's path — a dropped candidate is not an action target, so it gets `id` and `name` only.
      No raw git `stdout`/`stderr` is ever stored on an entry, so nothing but parsed scalars can reach
      `toClient`.
- [ ] Attach it to the provider. Build the provider as a plain `const` and return that const rather
      than returning an object literal directly:
      `const provider = { id: 'repos', /* … */, toClient: reposToClient }; return provider`.
      A returned object **literal** is subject to excess-property checking against the annotated
      return type and would fail `tsc` while Task 5 is still in flight; a non-fresh `const` compiles
      either way, and satisfies the required member the moment Task 5 lands. Do not delete this member
      to "fix" a typecheck error.

#### H. Fixtures (`test/fixtures/gitrepo.ts`)

Every builder below runs git through `execFileSync` with the existing module-level `CLEAN_ENV`
constant (currently declared across lines 6–11 of that file), and every directory it creates is
registered for cleanup. Tests must create fixtures **inside** `beforeAll`/test bodies, never at module
top level, so the drain semantics of `cleanupFixtures()` stay ordered.

- [ ] Add `const created: string[] = []` and `function track(dir: string): string { created.push(dir); return dir }`.
      Route `makeRepo`'s `mkdtempSync` result through `track`. Do not change `makeRepo`'s signature or
      behaviour otherwise — `test/rungit.test.ts` and `test/actions.test.ts` both use it.
- [ ] `export function cleanupFixtures(): void` — `for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })`.
      `splice(0)` **drains**, so a later file's call cannot delete a directory created after it. This
      is carry-forward P3's `afterAll` cleanup.
- [ ] `export function makeScanRoot(): string` — a tracked `mkdtempSync(join(tmpdir(), 'atrium-scan-'))`
      containing nothing. Every test's `homeDir`.
- [ ] `export function makeRepoIn(root: string, rel: string, opts?: { bare?: boolean; empty?: boolean; branch?: string }): string`
      — `mkdirSync` the path, `git init -q -b <branch ?? 'main'>` (with `--bare` when `opts.bare`),
      and unless `opts.empty` write `x.txt`, `add`, and commit with
      `-c user.email=t@t -c user.name=t`. Returns the absolute path. Do **not** track it separately —
      it lives under an already-tracked root.
- [ ] `export function commitAll(repo: string, message: string): void` — `add -A` then the same
      identity-flagged commit.
- [ ] `export function writeGitignore(repo: string, lines: string[]): void` — writes `.gitignore` with
      a trailing newline per line and commits it via `commitAll`.
- [ ] `export function addWorktree(repo: string, rel: string, opts?: { detach?: boolean; branch?: string }): string`
      — `worktree add -q <rel> -b <branch>`, or `worktree add -q --detach <rel> HEAD`. Verified to work
      even when `rel` is inside a path the repo's own `.gitignore` covers.
- [ ] `export function addSubmodule(parent: string, child: string, rel: string): string` — run with
      `-c protocol.file.allow=always` and `submodule add -q <child> <rel>`, then `commitAll(parent, 'sub')`.
- [ ] `export function breakGitPointer(dir: string): void` — overwrite `<dir>/.git` with
      `gitdir: ../.git/modules/gone\n` (the dangling-pointer shape; measured to exit 128).
- [ ] `export function makeZeroByteGitFile(root: string, rel: string): string` — `mkdirSync` the path
      and write a 0-byte `.git` file into it.
- [ ] `export function makeVendoredChild(parent: string, rel: string): string` — create `<parent>/<rel>/v.txt`,
      `commitAll(parent, …)` so the file is **tracked**, then `git init` inside `<parent>/<rel>` and
      commit there. Verified: `ls-files -- <rel>` then returns `<rel>/v.txt` while
      `ls-files -s -- <rel>` shows mode `100644`, not `160000`.
- [ ] `export function startMergeConflict(repo: string): void`, `startCherryPickConflict(repo: string): void`,
      `startRebaseConflict(repo: string): void` — each builds the conflict shape by: commit `f.txt`
      containing `line1`, `checkout -b side`, rewrite `f.txt` to `side` and commit, `checkout main`,
      rewrite to `main` and commit, then `merge side` / `cherry-pick side` / `rebase side`. All three
      exit 1 and leave, respectively, `.git/MERGE_HEAD`, `.git/CHERRY_PICK_HEAD` and
      `.git/rebase-merge/` (with `head-name` = `refs/heads/main`, `msgnum` = 1, `end` = 1) — all
      measured on git 2.55.0. Task 8 reuses these three verbatim.
- [ ] `export function makeSlowGitShim(realGit: string, slowSubcommand: string, sleepBin = Bun.which('sleep')): string`
      — a tracked `mkdtempSync` directory containing an executable file named `git` (mode `0o755`):
      ```sh
      #!/bin/sh
      case " $* " in *" <slowSubcommand> "*) exec <sleepBin> 3 ;; esac
      exec <realGit> "$@"
      ```
      Start the function with `if (!sleepBin) throw new Error('makeSlowGitShim: sleep not found on PATH')`
      so the fixture cannot degrade silently. **Both absolutes are load-bearing and were measured
      (Task 1 records the same trap):** `gitEnvFor` builds the child's environment from scratch with
      `PATH` set to `dirname(gitBin)` — the shim directory, which contains only the shim — so a bare
      `sleep` exits **127** with "not found" in ~12 ms and the run never times out, leaving test 24
      failing against a correct implementation. `exec` is required so `/bin/sh` replaces itself with
      the sleeping process and `execFile`'s SIGTERM reaches it directly, leaving no orphan.
      Only the named subcommand sleeps, so the validity gate's `rev-parse` still completes normally and
      the timeout lands exactly on the row under test. Returns the directory to put on `process.env.PATH`.
      (`resolveGit()` reads `process.env.PATH` on every call, which is what makes this work; the
      pattern mirrors the recording wrapper already in `test/rungit.test.ts`.)

#### I. Cleanup and hygiene

- [ ] `test/repos-discovery.test.ts` calls `afterAll(cleanupFixtures)` and additionally restores
      `process.env.PATH` in a `finally` in the two shim tests.
- [ ] `bun run typecheck` clean, `bun test` green, and the tripwire test
      *"no source file calls git outside runGit (tripwire, not a proof)"* still passes with
      `src/providers/repos/` present — that test is the acceptance check for the naming ruling.

---

### Tests

All in `test/repos-discovery.test.ts` unless noted. Every test builds its own `makeScanRoot()` and
passes it as `deps.homeDir`; none reads `$HOME`. Drive the provider through
`createReposProvider({ homeDir: root }).fetch(reposConfigSchema.parse(undefined), { schedule: 'discovery', signal: new AbortController().signal })`
unless the case needs a different config or schedule.

**Config**

1. `'parse(undefined) returns the full default config, not undefined'` — asserts
   `{ staleDays: 30, extraRoots: [], includeDotPaths: false, treatAsContainer: [] }` and that two
   calls return objects that are `not.toBe` each other.
2. `'parse rejects an unknown key by name'` — `parse({ staledays: 10 })` throws `/unknown key "staledays"/`.
3. `'parse rejects a non-positive or non-numeric staleDays'` — `parse({ staleDays: 0 })` and
   `parse({ staleDays: '30' })` both throw `/staleDays/`.
4. `'parse rejects a relative path in extraRoots'` — `parse({ extraRoots: ['relative/path'] })` throws
   `/absolute/`.

**Discovery and the validity gate**

5. `'a plain repo under the scanned root surfaces as top-level'` — one repo at `proj`; `repos` has
   length 1, `origin === 'top-level'`, `bare === false`, `id === repoId(realpathSync(<path>))`.
6. `'a 0-byte .git file is dropped as invalid and never reaches the classifier'` — `dropped` contains
   that path with `reason: 'invalid'`; `repos` is empty.
7. `'a dangling gitdir pointer is dropped as invalid'` — same shape via `breakGitPointer`.
8. `'a plain subdirectory named as an extra root is not surfaced as its own repo'` — repo at `proj`
   with `proj/src/`; config `extraRoots: [<root>/proj/src]`; `<root>/proj/src` appears in `dropped`
   with `reason: 'invalid'` and is absent from `repos`. **This is the containment-comparison pin.**
9. `'a bare repo is discovered and marked bare'` — `makeRepoIn(root, 'mirror.git', { bare: true })`;
   `repos` contains it with `bare === true`.
10. `'an empty repo with no commits surfaces as a normal repo'` — `makeRepoIn(root, 'fresh', { empty: true })`;
    present in `repos`, absent from `dropped`. (§7.1: an empty repo must not surface as a provider error.)
11. `'a symlink to a repo inside the root does not produce a second entry'` — a repo at `proj` plus
    `symlinkSync(<root>/proj, <root>/link)`; `repos` has length 1 and its `path` is the realpath of
    `proj`.
12. `'a repo reachable through both the home root and an extra root appears once'` — `extraRoots`
    naming the repo's own parent; `repos` length 1.
13. `'a repo under a dot-directory is not discovered by default and is discovered with includeDotPaths'`
    — repo at `.dotfiles/cfg`; default config → `repos` empty; `parse({ includeDotPaths: true })` →
    `repos` length 1.
14. `'a missing extra root is reported as root-missing and does not abort the scan'` — one real repo
    plus `extraRoots: ['/nonexistent/atrium-test-root']`; `errors` contains `'root-missing'` and
    `repos` still has length 1.
15. `'mid-rebase, mid-merge and mid-cherry-pick repos all surface as ordinary repos'` — three repos
    built with the three conflict builders; all three in `repos`, none in `dropped`. (Their *rendering*
    is Task 8's.)

**The classifier**

16. `'the container regression fixture surfaces the parent and all three ignored children'` — §10's
    **literal** fixture: a repo with tracked files of its own whose `.gitignore` lists three child
    directories, each a repo. Asserts `repos` has length **4**, and by name: the parent with
    `origin: 'top-level'` and `kid1`, `kid2`, `kid3` each with `origin: 'container-child'`.
17. `'a linked worktree inside an ignored directory is dropped as a worktree, not surfaced as a container child'`
    — repo whose `.gitignore` contains `worktrees/`, plus `addWorktree(repo, 'worktrees/feat', { branch: 'feat' })`;
    `repos` has length 1 (the parent only) and `dropped` contains `worktrees/feat` with
    `reason: 'worktree'`. **This is the row-order pin.**
18. `'a detached linked worktree is dropped as a worktree'` — `addWorktree(repo, 'wt', { detach: true })`;
    dropped with `reason: 'worktree'`.
19. `'a submodule is dropped with reason submodule, not vendored'` — `addSubmodule`; `dropped` entry's
    `reason` is exactly `'submodule'`. **This is the row-2-before-row-3 pin.**
20. `'a vendored tracked child is dropped with reason vendored'` — `makeVendoredChild`; `reason` is
    exactly `'vendored'`.
21. `'an umbrella with no .gitignore drops its child but reports it as ambiguous'` — `repos` contains
    only the umbrella; `dropped` contains the child with `reason: 'ambiguous'` and its `name`.
22. `'treatAsContainer surfaces an otherwise-ambiguous child'` — same fixture, config
    `parse({ treatAsContainer: [<umbrella realpath>] })`; child now in `repos` with
    `origin: 'container-child'` and absent from `dropped`.
23. `'a repo gitignoring deps/ that contains a clone surfaces that clone — the documented false positive'`
    — asserts the clone IS in `repos` with `origin: 'container-child'`, with a comment naming it as
    §7.1's known classifier limitation rather than a bug.
24. `'a candidate whose classification git call times out is reported as timed-out, never as ambiguous'`
    — the container fixture, `process.env.PATH` set to `makeSlowGitShim(resolveGit(), 'check-ignore')`
    **before** constructing the provider, `classifyTimeoutMs: 300`. Assert the **positive** guard
    first: at least one entry of `dropped` has `reason: 'timed-out'`. Only then assert each kid
    appears in `dropped` with `reason: 'timed-out'` and that no entry has `reason: 'ambiguous'`.
    Without the positive guard, a shim that fails to block (see `makeSlowGitShim`'s `sleep` note)
    produces zero timeouts and the "no ambiguous" half can still pass for the wrong reason. Restore
    `PATH` in a `finally`.

**Shape and wire contract**

25. `'the metadata schedule returns the full repo list, not a fragment'` — run `discovery`, then run
    `fetch` with `{ schedule: 'metadata' }` on the **same** provider instance; the second result's
    `repos` deep-equals the first's. **This is the stand-in pin for per-schedule keying of `last`.**
26. `'an unknown schedule name returns the current merged data instead of throwing'` — `{ schedule: 'nonsense' }`
    resolves and its `repos` deep-equals the discovery result's.
27. `'two provider instances do not share a repo table'` — instance A over root A, instance B over
    root B, each run once; A's result contains only A's repo and B's only B's. Also assert each
    surfaced entry's `path` is the **realpath-resolved absolute** path of its repo — that value is
    the key of the closure `table` map and therefore the exact string Task 8's `resolveTarget`
    compares against.
28. `'staleDays reaches Data so the pane needs no second config channel'` — `parse({ staleDays: 7 })`
    → `data.staleDays === 7`.
29. `'reposToClient emits no gitDir and no dropped-candidate path'` — build a fixture root containing
    one surfaced repo **and** one dropped candidate. `const wire = reposToClient(data)`. Assert
    positively first: every entry of `wire.repos` has a `path`, a `name` and an `id`, and
    `wire.repos[0]!.path` equals the surfaced repo's realpath. Then assert
    `JSON.stringify(wire)` `not.toContain('gitDir')` and `not.toContain(<the dropped candidate's
    absolute path>)`. Comment the asymmetry: a surfaced repo's path is deliberately on the wire (it is
    the action target Task 8 validates); a dropped candidate's is not, because nothing can act on it.
30. `'every error code is a member of the closed set'` — for the root-missing fixture, every entry of
    `errors` is one of `'root-missing' | 'root-unreadable' | 'candidate-error'` and no entry contains
    a `/`.

#### Mutations

Each row is an exact edit to make, run `bun test`, confirm the named test is **red**, then revert.
Record red-then-green; Task 10 re-runs all of them in one pass.

| # | Exact edit | Test that must go red |
|---|---|---|
| M1 | In the classifier, delete Row 4 (container) so a candidate with a parent repo falls straight through to Row 5 (`reason: 'ambiguous'`) — i.e. revert to revision 1's "drop nested repos". | 16 `'the container regression fixture surfaces the parent and all three ignored children'` |
| M2 | Move Row 4 (`check-ignore`) above Row 1 (worktree) in the classifier's row sequence. | 17 `'a linked worktree inside an ignored directory is dropped as a worktree, not surfaced as a container child'` |
| M3 | Delete the `timedOut` short-circuit in the classifier, so Row 4 is decided purely from `code === 0` / `code === 1`. | 24 `'a candidate whose classification git call times out is reported as timed-out, never as ambiguous'` |
| M4 | Delete the containment comparison in the validity gate, accepting any candidate whose `rev-parse` exits 0. | 8 `'a plain subdirectory named as an extra root is not surfaced as its own repo'` |
| M5 | Swap Rows 2 and 3 so `ls-files -- rel` (vendored) is tested before `ls-files -s -- rel` (submodule). | 19 `'a submodule is dropped with reason submodule, not vendored'` |
| M6 | Change the Row 5 branch to drop the candidate **without** pushing it into `dropped`. | 21 `'an umbrella with no .gitignore drops its child but reports it as ambiguous'` |
| M7 | Change the `'metadata'` branch of `fetch` to `return { ...buildData(cfg), repos: [] }`. | 25 `'the metadata schedule returns the full repo list, not a fragment'` |
| M8 | Remove the `n.startsWith('.')` prune so the walker always descends into dot-directories. | 13 `'a repo under a dot-directory is not discovered by default and is discovered with includeDotPaths'` |
| M9 | Replace `reposConfigSchema.parse`'s body with `return x as ReposConfig` (raw passthrough). | 1 `'parse(undefined) returns the full default config, not undefined'` (and 2, 3, 4) |
| M10 | Change `reposToClient` to `return data`. | 29 `'reposToClient emits no absolute path and no gitDir'` |
| M11 | In the validity gate, change the accept condition to `code !== 128`. | 6 `'a 0-byte .git file is dropped as invalid and never reaches the classifier'` stays green — instead 7 `'a dangling gitdir pointer is dropped as invalid'` must be checked; if **both** stay green the gate is under-pinned and you must strengthen test 6 to also assert `errors` is empty and `repos` is empty for a root containing *only* a non-repo directory tree. |

M11 is deliberately written as a check on the tests rather than a guaranteed red: a **string** `code`
(`'ENOENT'`) cannot be produced in a fixture on a machine where `/usr/bin/git` exists, because
`resolveGit()` falls back to that absolute path when nothing is on `PATH`. The `typeof code === 'number'`
narrowing is therefore a code requirement enforced by review and `tsc`, not by a fixture.

---

### Out of scope for this task

- **Per-repo metadata.** No `status --porcelain=v2 --branch -uall`, no `log -1 --format=%ct`, no
  `rev-parse --is-bare-repository` call, no branch/state/uncommitted-count/last-commit fields, no
  concurrency-8-to-16 metadata pass, no slow-repo backoff. Task 8. The `'metadata'` branch of `fetch`
  is a deliberate no-op returning the merged data.
- **Any action.** `actions` stays `[]`. No `src/providers/repos/actions.ts`, no `exec` templates, no
  editor/terminal/`claude` launches, and no exec-target validation — all Task 8. `show diff` is
  deferred for the whole plan by Ruling B; do not add it in any form.
- **Registering the provider anywhere.** Do not touch `src/server/serve.ts`, `src/index.ts`,
  `src/core/scheduler.ts` or `src/core/registry.ts`. The `providers` seam is Task 2's and the
  end-to-end wiring is exercised in Task 9.
- **Changing `src/core/contract.ts`.** `toClient` becomes a required member in Task 5; this task only
  supplies the repos implementation in the compile-safe form described in step G.
- **Any UI.** No `web/` file, no pane, no "needs attention" grouping, no `Intl.RelativeTimeFormat`.
  Task 9.
- **First run.** `detect()` returns `nothing-to-detect`; no candidate confirmation flow, no config
  persistence, no writing `config.json`.
- **Loosening, widening or otherwise editing `test/rungit.test.ts`'s `GIT_LITERAL` regex or any part of
  that file.** If your provider trips the tripwire, rename your string — that is the whole point of
  Ruling A.
- **Adding config keys *in this task*.** The set this task parses is exactly `staleDays`,
  `extraRoots`, `includeDotPaths`, `treatAsContainer`. Task 8 adds five more `repos.*` keys and
  widens the unknown-key rejection and test 1's expected default object at the same time — that is
  expected, not a violation of Ruling C, which fixes the `repos.` **prefix**, not a closed list.
  Test-only knobs still go in `ReposProviderDeps`, never in config.
- **Adding a dependency.** No zod, no glob library, no fast-glob. `node:fs`, `node:path`, `node:os`,
  `node:crypto` and `runGit` are the whole toolbox.
- **Measuring or optimising `resolveGit()`'s per-call `Bun.which` PATH scan.** Carry-forward §4 flags
  it as something per-repo polling multiplies; that measurement belongs with Task 8's metadata pass,
  which is what actually multiplies it.
- **Fixing carry-forward P3 in `test/rungit.test.ts`.** This task adds the tracked-cleanup machinery
  and calls it from the new test file only.

---

### Task 8: repos provider — metadata, edge shapes, three actions with target validation

Task 7 gave the `repos` provider a discovery pass that decides *which* repositories exist; this task
makes them say something. It adds the `metadata` schedule branch that walks the closure-held repo
table with bounded concurrency, a per-repo timeout and a timeout-keyed backoff, reading branch,
repository state, uncommitted count and last-commit time off three exactly-specified git call shapes —
including the three edge shapes that were measured and that a naive reading of git's exit codes gets
wrong (an empty repo, a bare repo, and a `code` that is a string rather than a number). It then adds
the three `exec` actions §7.1 calls for (open in editor, open a terminal at the path, open a terminal
running `claude`) built from §8.8's `{cmd, args[]}` config template, each of which **validates its
target against the discovered repo table before building argv**. That last part is the security core
of this task: the `exec` arm of `Action` has no `payloadSchema` (`src/core/contract.ts:30-31`; the
`call` arm's is at `:33`),
`src/server/routes.ts:73` forwards `await req.json()` to `dispatch` untouched, and `buildArgv`
(`src/core/actions.ts:39-60`) validates only the argv an action *returns*, never the target it was
handed — so without an explicit check every bit of Task 7's validity gate and classifier is bypassed
by any `{"path": "..."}` a client posts.

**Depends on:** Task 7 (the `repos` provider, its config module, its closure-held repo table and its
`ctx.schedule` branch). It also consumes two members that land earlier in this plan and must already be
present when this task starts: `GitResult.timedOut` from Task 1, and the required `toClient` member of
`Provider` from Task 5.

---

## Files

- **`src/providers/repos/index.ts`** (modify) — add the `'metadata'` branch to `fetch`, the metadata
  pass itself (worker pool, per-repo read, state classifier, backoff table), the config stash that the
  action layer reads, and the new fields on the repo-entry type. Extend the provider's `toClient`
  allowlist with every field added here.
- **`src/providers/repos/config.ts`** (modify) — five new config keys (`repos.metadataConcurrency`,
  `repos.metadataTimeoutMs`, `repos.editor`, `repos.terminal`, `repos.claudeTerminal`) with
  hand-written validation and the `${path}` template rules. Not listed in the scoping doc's Files line
  for T8; it is unavoidable, because the three actions have nowhere else to get a command from.
- **`src/providers/repos/actions.ts`** (create) — `createReposActions()`, `resolveTarget()`,
  `renderTemplate()`, and the three `exec` action objects. Matches spec §6's
  `src/providers/<id>/{index,config,actions}.ts` layout.
- **`test/fixtures/gitrepo.ts`** (modify) — add the fixture builders this task's tests need
  (`makeEmptyRepo`, `makeBareRepo`, `makeRebasingRepo`, `makeMergingRepo`, `makeCherryPickingRepo`,
  `makeUntrackedRepo`) and export a `cleanupFixtures()` the tests call from `afterAll`
  (carry-forward P3).
- **`test/repos-metadata.test.ts`** (create) — everything in the Tests section below.
- **`test/repos-discovery.test.ts`** (modify, two assertions only) — Task 7's file. This task changes
  two things Task 7 pinned, so it must carry the matching test edits in the **same diff**; leaving
  them out is the "one task builds a control, a later task opens a path around it, and neither diff
  contains both halves" pattern this plan exists to avoid. See step A0.
- **`docs/decisions/0002-slice-rulings.md`** (modify, append only) — Ruling E, settling carry-forward
  P1 for all three actions. Do not edit Rulings A–D.

---

## Fixed values this task introduces

Constants, in `src/providers/repos/index.ts` unless stated otherwise. Every one of these is a literal
the tests below reference by value.

| Name | Value | Notes |
|---|---|---|
| `METADATA_CONCURRENCY_DEFAULT` | `8` | §7.1's range is 8–16; 8 is the floor and the default. |
| `METADATA_CONCURRENCY_MAX` | `16` | Clamp ceiling; higher values are a config error, not a clamp. |
| `METADATA_TIMEOUT_MS_DEFAULT` | `5000` | Matches `runGit`'s own default so nothing is implicit. |
| `MAX_SKIP_CYCLES` | `32` | Backoff ceiling, in metadata cycles (30s each → ~16 min). |
| `PATH_PLACEHOLDER` (in `config.ts`) | `'${path}'` | A single-quoted TS string — **not** a template literal. |

Backoff formula, exactly: after the *n*-th consecutive timeout on a repo,
`skipCycles = Math.min(2 ** (n - 1), MAX_SKIP_CYCLES)` → 1, 2, 4, 8, 16, 32, 32, … Reset to `n = 0`,
`skipCycles = 0` on any successful read.

### Config keys added (all under `repos.`, per Task 1 Ruling C — never `git.*`)

| Key | Type | Default |
|---|---|---|
| `repos.metadataConcurrency` | integer 1–16 | `8` |
| `repos.metadataTimeoutMs` | integer 100–60000 | `5000` |
| `repos.editor` | `{ cmd: string; args: string[] }` | `{ cmd: 'code', args: ['--', '${path}'] }` |
| `repos.terminal` | `{ cmd: string; args: string[] }` | `{ cmd: 'konsole', args: ['--separate', '--workdir', '${path}'] }` |
| `repos.claudeTerminal` | `{ cmd: string; args: string[] }` | `{ cmd: 'konsole', args: ['--separate', '--workdir', '${path}', '-e', 'claude'] }` |

§8.8's "defaulted by probing a small allowlist at first run" is **not** implemented here: first run
(`detect()` → confirm → persist) is deferred by this plan, so these are static defaults a user edits in
`config.json`. Say so in a comment on the defaults.

### Types added to `src/providers/repos/index.ts`

```ts
export type RepoState =
  | 'clean' | 'detached' | 'rebasing' | 'merging'
  | 'cherry-picking' | 'reverting' | 'bisecting' | 'empty'

export type RepoMetaStatus = 'ok' | 'stale' | 'unavailable'
export type RepoUnavailableReason = 'timeout' | 'bare' | 'gone' | 'git-error'
```

Fields added to Task 7's per-repo entry type (`RepoEntry` — if Task 7 named it differently, use Task
7's name and keep these field names exactly):

```ts
  branch?: string                                  // never the literal '(detached)'
  repoState?: RepoState
  rebaseProgress?: { current: number; total: number }
  uncommittedCount?: number
  lastCommitAt?: number                            // unix SECONDS, from %ct
  metaStatus: RepoMetaStatus
  metaReason?: RepoUnavailableReason               // present only when metaStatus === 'unavailable'
  metaCheckedAt?: number                           // Date.now() ms of the last successful read
```

Invariant to state in a comment and to pin with a test: **`metaCheckedAt !== undefined` if and only if
the entry currently carries readable metadata.** `metaStatus: 'unavailable'` deletes
`branch`, `repoState`, `rebaseProgress`, `uncommittedCount`, `lastCommitAt` **and** `metaCheckedAt`.
This is §7.4's rule ("`unavailable` must emit no percentage, no bucket list, no gauge object at all")
applied per repo: an unavailable repo emits no branch, no count, no time — not zero, not null, absent.

`'clean'` means "on a branch with no operation in progress". It says nothing about
`uncommittedCount`; a repo can be `clean` with 47 uncommitted files. Comment this, because the name
invites the opposite reading and Task 9's "needs attention" rule depends on the two being independent.

---

## Verified git call shapes

Three calls per repo per cycle, in this order, each through `runGit(path, args, { timeoutMs })` from
`src/core/rungit.ts` — the only path to the version-control binary (§8.6):

1. `['rev-parse', '--absolute-git-dir', '--is-bare-repository']`
2. `['status', '--porcelain=v2', '--branch', '-uall']`
3. `['log', '-1', '--format=%ct']`

Rules that are not optional:

- **Never add `--no-optional-locks` to any of those arrays.** `runGit` supplies it in its own
  pre-subcommand hardening prefix (`src/core/rungit.ts:91`) and `runGit`'s contract makes `args[0]` the
  subcommand. Measured on git 2.55.0: appended after the subcommand it is exit **129**,
  `error: unknown option 'no-optional-locks'`.
- **No positional operands, so no `--`.** The repository path reaches git through `runGit`'s own
  `-C <abs>`; none of the three calls forwards a repository-controlled positional, so none needs a
  `--`. (The `--` rule applies to the *action* argv templates below, which do.)
- **Absolute paths always.** `runGit` resolves its `repoPath` against the process cwd
  (`src/core/rungit.ts:189`), and cwd is `/` under systemd. Task 7's table keys are already absolute;
  never re-derive a path from anything relative.
- `runGit` inserts `--no-ext-diff --no-textconv` immediately after `log` (it is in
  `DIFF_PRODUCING_SUBCOMMANDS`). Expect it in any recorded argv; it is correct and already covered by
  existing tests.

### Measured behaviour these calls must be read against (git 2.55.0, this machine, 2026-09-14)

| Shape | Call | Result |
|---|---|---|
| Empty repo | `status --porcelain=v2 --branch -uall` | exit **0**, stdout begins `# branch.oid (initial)` then `# branch.head main` |
| Empty repo | `log -1 --format=%ct` | exit **128**, stderr `fatal: your current branch 'main' does not have any commits yet` |
| Bare repo | `status --porcelain=v2 --branch -uall` | exit **128**, `fatal: this operation must be run in a work tree` |
| Bare repo | `rev-parse --absolute-git-dir --is-bare-repository` | exit 0, two lines: the gitdir, then `true` |
| Non-bare repo | same rev-parse | exit 0, two lines: the gitdir, then `false` |
| Deleted / non-repo path | same rev-parse | exit **128** |
| Mid-rebase | `status` | exit 0, `# branch.head (detached)` — the real branch is only in the state file |
| Mid-rebase (merge backend) | gitdir | `rebase-merge/head-name` = `refs/heads/feature`, `msgnum` = `1`, `end` = `1` |
| Mid-rebase (apply backend) | gitdir | `rebase-apply/head-name` = `refs/heads/feat`, `next` = `1`, `last` = `1` |
| Mid-merge | gitdir / status | `MERGE_HEAD` present; `# branch.head main` |
| Mid-cherry-pick | gitdir | `CHERRY_PICK_HEAD` present |
| Mid-revert | gitdir | `REVERT_HEAD` present |
| Bisecting | gitdir | `BISECT_LOG`, `BISECT_NAMES`, `BISECT_START` present |
| 47 untracked files under `a/b/` | `status … -uall` | **47** `? ` lines; without `-uall` it collapses to **1** |
| Filename containing a newline | `status --porcelain=v2` | C-quoted on **one** line (`? "new\nline.txt"`) — line counting is safe |
| Linked worktree | `rev-parse --absolute-git-dir` | the per-worktree dir (`<main>/.git/worktrees/<name>`); `rebase-merge/` lives **there** |

**The empty-repo rule, stated once:** emptiness is read off `status` (`# branch.oid (initial)`), never
off `log`'s exit code. `log -1` exiting 128 means only "no `lastCommitAt` this cycle" — it must not
make the repo unavailable, and it must not make the repo `empty`.

---

## Steps

### A0. The two Task 7 pins this task moves (do this first, in the same diff)

- [ ] Task 7's test 1, `'parse(undefined) returns the full default config, not undefined'`, asserts the
      default config as a whole-object `toEqual`. Extend its expected object with this task's five new
      keys at their declared defaults: `metadataConcurrency: 8`, `metadataTimeoutMs: 5000`,
      `editor: { cmd: 'code', args: ['--', '${path}'] }`,
      `terminal: { cmd: 'konsole', args: ['--separate', '--workdir', '${path}'] }`,
      `claudeTerminal: { cmd: 'konsole', args: ['--separate', '--workdir', '${path}', '-e', 'claude'] }`.
      Widen Task 7's unknown-key rejection from the four-name set to the nine-name set at the same
      time, and re-run Task 7's mutation **M9** against the amended assertion, recording red-then-green.
- [ ] Task 7's test 29, `'reposToClient emits no gitDir and no dropped-candidate path'`, already
      permits `path` on a **surfaced** repo (settled ruling — see the `path` note in step B below) and
      forbids it on a **dropped** candidate. Extend its positive half to assert the metadata fields
      this task adds are present on the wire for a readable repo (`metaStatus`, and `branch`/
      `uncommittedCount` when `metaStatus === 'ok'`), and re-run Task 7's mutation **M10**
      (`reposToClient` returns `data` unchanged) against the amended assertion. Do not weaken the
      `gitDir` or dropped-path halves.
- [ ] Touch nothing else in `test/repos-discovery.test.ts`. If any other Task 7 test goes red, that is
      a defect to report, not to edit around.

### A. Config (`src/providers/repos/config.ts`)

- [ ] Extend the `ReposConfig` type (Task 7's name) with `metadataConcurrency: number`,
      `metadataTimeoutMs: number`, `editor: CommandTemplate`, `terminal: CommandTemplate`,
      `claudeTerminal: CommandTemplate`, where
      `export interface CommandTemplate { cmd: string; args: string[] }`. All five are **required on
      the parsed type and defaulted by `parse`** — the raw record may omit them, the parsed value may
      not. Keep Task 7's existing keys (`staleDays`, `extraRoots`, `includeDotPaths`,
      `treatAsContainer`) untouched.
- [ ] Add `const PATH_PLACEHOLDER = '${path}'` (single quotes — no interpolation).
- [ ] Add `function validateTemplate(key: string, value: unknown): CommandTemplate`, used for all
      three template keys with `key` one of `'editor' | 'terminal' | 'claudeTerminal'`. It throws
      `Error` with these exact messages (`${key}` interpolated, `${PATH_PLACEHOLDER}` rendering as the
      literal `${path}`):
      - `repos.${key}.cmd must be a non-empty string`
      - `repos.${key}.args must be an array of strings`
      - `repos.${key}.args must contain exactly one ${PATH_PLACEHOLDER} element`
      - `repos.${key}.args must not embed ${PATH_PLACEHOLDER} inside a larger argument`
      - `repos.${key}.args must place a literal option (starting with "-") immediately before ${PATH_PLACEHOLDER}`
- [ ] The rules `validateTemplate` enforces, in that order: `cmd` is a non-empty string; `args` is an
      array and every element is a string; exactly one element `=== PATH_PLACEHOLDER`; no *other*
      element `.includes(PATH_PLACEHOLDER)`; the element at `indexOf(PATH_PLACEHOLDER) - 1` exists and
      starts with `'-'`.
- [ ] Comment why substitution is **exact-element only**: a template that embedded the placeholder in
      a larger argument (`--workdir=${path}`) would hide the value's boundaries inside one argv
      element, and the "preceded by a literal option" rule would stop meaning anything. This is also
      why the default terminal template uses `--workdir`, `'${path}'` as two elements.
- [ ] **Do not add a check here that rejects the version-control binary as a `cmd`.** Two reasons: it
      is already enforced at dispatch time by `buildArgv` (`src/core/actions.ts:54-58`), and writing
      the literal name in any file under `src/` trips layer 4 of the tripwire in
      `test/rungit.test.ts` (`GIT_LITERAL`, which Task 1 Ruling A leaves completely unedited). The
      same warning applies to comments in every file this task touches: never write a quoted bare
      `'git'` or a quoted path ending in `/git` anywhere under `src/`. The regex lives at
      `test/rungit.test.ts:305`; the two tests that would turn red are at `:329` and `:414`.
- [ ] Add the two numeric keys with exact messages
      `repos.metadataConcurrency must be an integer between 1 and 16` and
      `repos.metadataTimeoutMs must be an integer between 100 and 60000`. Use
      `Number.isInteger(v)` plus range — reject out-of-range rather than clamping, so a typo is loud.

### B. The metadata pass (`src/providers/repos/index.ts`)

- [ ] Inside `createReposProvider()`'s closure add, next to Task 7's repo table:
      `const backoff = new Map<string, { consecutiveTimeouts: number; skipCycles: number }>()` and
      `let lastCfg: ReposConfig | undefined`.
- [ ] At the **top of `fetch`, before any `await`**, set `lastCfg = cfg`. This is the only way the
      action layer can see config: the `exec` arm's `argv(target)` takes no `cfg` argument
      (`src/core/contract.ts:30-31`), and `dispatch` passes `cfg` only to `call` actions
      (`src/core/actions.ts:144-145`). Comment that both schedules are `runOnStart: true`, so a fetch
      has run before any action can be dispatched through a started server.
- [ ] Add the `'metadata'` case to the `ctx.schedule` switch, leaving Task 7's total default branch
      intact.
- [ ] The metadata branch returns the **full merged Data** — the same shape the `discovery` branch
      returns, repo list and dropped-ambiguous candidates included — not a metadata-only delta. The
      scheduler keys `last` by provider id, not by schedule, so a partial return would blank the
      snapshot every 30 s. Comment this as the documented rule standing in for per-schedule keying of
      `last`, which this plan defers.
- [ ] Bail immediately when `ctx.signal.aborted` is already true: return the built Data without
      issuing any git call. Re-check `ctx.signal.aborted` at the top of each worker iteration.
- [ ] Worker pool: take `[...table.values()]` (surfaced repos only — never the dropped-ambiguous
      list), a shared cursor index, and `Math.min(cfg.metadataConcurrency, entries.length)` workers
      driven with `await Promise.all(...)`. No third-party pool, no `p-limit`.
- [ ] Per-repo read (`readOne`), in exactly this order:
      1. Backoff gate. If `skipCycles > 0`: decrement it, then set `metaStatus` to `'stale'` when
         `metaCheckedAt !== undefined` (keep every previously-read field as-is), or to `'unavailable'`
         with `metaReason: 'timeout'` when it is undefined. Return **without any git call**.
      2. `rev-parse --absolute-git-dir --is-bare-repository`. On `timedOut` → `onTimeout`, return.
         Narrow with `typeof code === 'number'` **before** comparing; a non-number `code` (the
         `'ENOENT'` case `GitResult` documents) is `unavailable` + `'git-error'`. A numeric non-zero
         is `unavailable` + `'gone'`. Split stdout on `'\n'`: line 0 trimmed is the gitdir, line 1
         trimmed is `'true'`/`'false'`. An empty gitdir is `unavailable` + `'gone'`. `'true'` is
         `unavailable` + `'bare'` — and returns before `status` runs, because `status` exits 128 in a
         bare repo and would otherwise be read as a broken repository.
      3. `status --porcelain=v2 --branch -uall`. On `timedOut` → `onTimeout`, return. Non-zero (or
         non-number) code → `unavailable` + `'git-error'`.
      4. `log -1 --format=%ct`. On `timedOut` → `onTimeout`, return. Otherwise
         `lastCommitAt = (typeof code === 'number' && code === 0) ? Number(stdout.trim()) : undefined`,
         with `Number.isFinite` guarding a `NaN`. **Never** branch on this exit code for emptiness.
      5. Assign the parsed fields, `metaStatus = 'ok'`, `metaCheckedAt = Date.now()`, delete
         `metaReason`, and reset this repo's backoff entry to `{ consecutiveTimeouts: 0, skipCycles: 0 }`.
- [ ] `onTimeout(entry)`: increment `consecutiveTimeouts`, set
      `skipCycles = Math.min(2 ** (consecutiveTimeouts - 1), MAX_SKIP_CYCLES)`, then set `metaStatus`
      to `'stale'` if `metaCheckedAt !== undefined` (previous values retained), else `'unavailable'`
      with `metaReason: 'timeout'`. A timed-out repo must never be written as a successful read — this
      is exactly the shape Task 1's `timedOut` exists for, because a timed-out `runGit` returns
      `code: 1`, byte-identical to several genuine failures.
- [ ] `setUnavailable(entry, reason)`: assign `metaStatus = 'unavailable'`, `metaReason = reason`, and
      **delete** `branch`, `repoState`, `rebaseProgress`, `uncommittedCount`, `lastCommitAt`,
      `metaCheckedAt`. Reset the repo's backoff entry for every reason other than `'timeout'`.
- [ ] `parseStatusV2(stdout)` → `{ branchHead?: string; initial: boolean; uncommittedCount: number }`.
      Split on `'\n'`. A line equal to `'# branch.oid (initial)'` sets `initial`. A line starting
      `'# branch.head '` yields everything after that prefix as `branchHead` (which may be the literal
      `(detached)`). Every other line that is non-empty and does not start with `'# '` increments
      `uncommittedCount` — that is one line each for `1 `/`2 `/`u `/`? ` entries, and paths are
      C-quoted so a newline in a filename cannot split a record.
- [ ] `classifyState(gitDir, parsed)` — **first match wins, in exactly this order**, using
      `existsSync` on paths joined to the absolute gitdir returned by step 2 (never to `<repo>/.git`,
      which is a *file* in a linked worktree):
      1. `rebase-merge` or `rebase-apply` → `'rebasing'`
      2. `CHERRY_PICK_HEAD` → `'cherry-picking'`
      3. `REVERT_HEAD` → `'reverting'`
      4. `MERGE_HEAD` → `'merging'`
      5. `BISECT_LOG` → `'bisecting'`
      6. `parsed.initial` → `'empty'`
      7. `parsed.branchHead === '(detached)'` → `'detached'`
      8. otherwise → `'clean'`
      Comment why rebase precedes detached: a mid-rebase `status` reports `(detached)` (measured), so
      the reverse order renders every rebase as a bare detached HEAD — which §7.1 forbids by name.
- [ ] `resolveBranch(gitDir, state, parsed)`: when `state === 'rebasing'`, read `head-name` from
      whichever of `rebase-merge`/`rebase-apply` exists, trim it, strip a leading `refs/heads/`, and
      use that; also read `msgnum`/`end` (merge backend) or `next`/`last` (apply backend) into
      `rebaseProgress` as `{ current, total }`, omitting `rebaseProgress` entirely if either file is
      missing or not an integer. Otherwise the branch is `parsed.branchHead` unless it is
      `'(detached)'`, in which case `branch` stays `undefined`. Assert in a comment: the string
      `'(detached)'` is never assigned to `branch`.
- [ ] All state-file reads use `existsSync`/`readFileSync` from `node:fs` wrapped in try/catch — a
      file that disappears between the two calls must not throw out of the metadata pass.
- [ ] Extend the provider's `toClient` allowlist (required member of `Provider`, added in Task 5) to
      name every field above **field by field**. Per surfaced repo the wire object carries exactly:
      `path`, `name`, whatever classifier field Task 7 already allowlisted, plus `branch`,
      `repoState`, `rebaseProgress`, `uncommittedCount`, `lastCommitAt`, `metaStatus`, `metaReason`.
      Never `{ ...entry }` with deletions. `metaCheckedAt` is internal and stays off the wire.
      `metaStatus`/`metaReason` are closed sets of declared codes — never a caught exception, never a
      git `stderr` string.
- [ ] `path` **is** on the wire, deliberately — this is a settled cross-task ruling, already written
      into Task 7's allowlist and its test 29: it is the identifier Task 9's action buttons post back,
      and `resolveTarget` below is the control that makes accepting it safe. Record it as a one-line
      note next to the allowlist, with the residual: absolute `$HOME`-relative repository paths reach
      an authenticated, same-origin client. No raw git `stdout`/`stderr` is ever stored on an entry in
      the first place, so nothing but parsed scalars can reach `toClient`.
- [ ] Extend Task 7's exported wire types rather than declaring new ones — Task 9 imports these names
      type-only and its brief is written against them:
      ```ts
      // in src/providers/repos/index.ts, extending Task 7's declaration
      export interface RepoWire {
        id: string; path: string; name: string; bare: boolean; origin: 'top-level' | 'container-child'
        branch?: string                                   // ABSENT when unknown — never null, never ''
        repoState?: RepoState                             // the STRING union declared above
        rebaseProgress?: { current: number; total: number }
        uncommittedCount?: number
        lastCommitAt?: number                             // unix SECONDS
        metaStatus: RepoMetaStatus
        metaReason?: RepoUnavailableReason
      }
      ```
      `ReposWire` keeps Task 7's shape (`repos`, `dropped`, `errors`, `scannedAt`, `staleDays`) with
      the widened `RepoWire`. Absent-not-null is the §7.4 rule applied to the wire, and Task 9's pane
      is written against absence.
- [ ] Measure one metadata cycle over the fixture set and record the wall-clock number in a comment on
      the metadata branch. Carry-forward §4 flags that `resolveGit()` runs a `Bun.which` PATH scan on
      every `runGit` call and that per-repo polling multiplies it. If the measurement is bad, record
      it — do **not** change `src/core/rungit.ts`, which this task does not own.

### C. The three actions (`src/providers/repos/actions.ts`)

- [ ] `export function resolveTarget(repos: ReadonlyMap<string, RepoEntry>, target: unknown): RepoEntry`.
      Throws `Error('repos: action target must be an object with a string "path"')` when `target` is
      not a non-null object or `typeof (target as { path?: unknown }).path !== 'string'`. Throws
      `Error('repos: unknown repository target')` when the map has no such key. **Exact string
      equality against a table key — no `resolve()`, no normalisation, no prefix or `startsWith`
      match.** A client that got the path from `/api/state` sends it back byte-identical; anything
      else fails closed. The message deliberately does not echo the path back.
- [ ] `export function renderTemplate(tpl: CommandTemplate, path: string): { cmd: string; args: string[] }`
      — `{ cmd: tpl.cmd, args: tpl.args.map(a => a === PATH_PLACEHOLDER ? path : a) }`. Exact-element
      comparison only; never `String.replace`.
- [ ] `export function createReposActions(deps: { repos: () => ReadonlyMap<string, RepoEntry>; config: () => ReposConfig | undefined }): Action[]`
      returning exactly three `{ kind: 'exec' }` actions, in this order:

      | `id` | `label` | template |
      |---|---|---|
      | `open-editor` | `Open in editor` | `repos.editor` |
      | `open-terminal` | `Open terminal here` | `repos.terminal` |
      | `open-claude` | `Open terminal running Claude` | `repos.claudeTerminal` |

      Every `id` matches `src/server/routes.ts:12`'s `ACTION_RE` character class
      (`[A-Za-z0-9_-]+`) — check any rename against it.
- [ ] Each `argv(target)` does, in this order: read `config()`; if it is `undefined` throw
      `Error('repos: configuration has not been loaded yet')`; call `resolveTarget(repos(), target)`;
      return `renderTemplate(tpl, entry.path)` built from the **entry's own stored path**, never from
      the client-supplied string. Both throws surface through `handleRoute`'s catch as a 400
      (`src/server/routes.ts:77-82`), which is the correct classification — these are client errors.
- [ ] Wire it up in `createReposProvider()`: `actions: createReposActions({ repos: () => table, config: () => lastCfg })`.
      Pass **getters**, not values — the table and the config are mutated by later fetches, and a
      snapshot captured at construction time would validate against an empty table forever.
- [ ] Only the surfaced repo table is passed. Dropped-ambiguous candidates from Task 7 are not valid
      action targets and must live in a separate collection that `resolveTarget` never sees.

### D. Ruling E — carry-forward P1 (`docs/decisions/0002-slice-rulings.md`, append)

- [ ] Append a section headed `## Ruling E — no user bus: the three repos exec actions are a silent
      no-op, accepted` stating, as measured facts: `spawnDetached` wraps every exec action in
      `systemd-run --user --scope` (`src/core/actions.ts:97-108`); its fallback fires only on the
      child's `error` event, i.e. the launcher failing to *start*; with `systemd-run` present but no
      user bus the launcher starts and exits 1, so no `error` event fires and nothing runs (the full
      `spawnDetached` body is `src/core/actions.ts:97-109`). All three
      of this task's actions inherit that. The route still returns `{ok: true}` because
      `dispatch` resolves `Promise<void>` and `src/server/routes.ts:73-76` has no result channel.
- [ ] Record the decision explicitly: **accepted as-is for this slice.** The alternatives were
      weighed and rejected here — probing for a user bus and selecting the launcher per call would
      require changing `DispatchOptions`/`dispatch`/`routes.ts`, which this task does not own, and a
      result channel on `exec` is the same contract change Ruling B already deferred for `show diff`.
      Name the consequence in one sentence so the next plan can pick it up: a user without a session
      bus (or without the configured `cmd` installed at all) clicks a button and nothing happens, with
      no error anywhere.

---

## Tests

New file `test/repos-metadata.test.ts`. Every fixture directory is registered and removed in an
`afterAll` (carry-forward P3). Every git call that builds a fixture runs under `test/fixtures/gitrepo.ts`'s
`CLEAN_ENV` (`PATH=/usr/bin:/bin`, `HOME=/nonexistent`, `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_SYSTEM=/dev/null`) — §10 rule 2. No test derives a count or a path from `$HOME` — §10 rule 1.
Tests that shim `process.env.PATH` restore it in a `finally`, following `test/rungit.test.ts`'s
recording-wrapper pattern. Note `tsconfig.json` sets `noUncheckedIndexedAccess`, so every array and map
index is `T | undefined` — narrow, do not cast.

**Edge shapes**

1. `an empty repo reports state "empty" with no lastCommitAt, and is not an error` — fixture: `git
   init -b main` with no commit. Asserts `repoState === 'empty'`, `metaStatus === 'ok'`,
   `lastCommitAt === undefined`, `branch === 'main'`, `uncommittedCount === 0`.
2. `a bare repo is unavailable with reason "bare", and status is never run on it` — fixture:
   `git init --bare`. Asserts `metaStatus === 'unavailable'`, `metaReason === 'bare'`, and that
   `branch`, `repoState` and `uncommittedCount` are all `undefined`. Uses the PATH-shim recorder to
   assert the recorded argv contains **no** `status` invocation for that repo.
3. `a mid-rebase repo recovers its real branch and never renders as detached` — fixture: conflicting
   rebase of `feature` onto `main`. Asserts `repoState === 'rebasing'`, `branch === 'feature'`,
   `branch !== '(detached)'`, `rebaseProgress` equals `{ current: 1, total: 1 }`.
4. `a mid-rebase repo on the apply backend recovers head-name too` — same shape via
   `git rebase --apply`. Asserts `repoState === 'rebasing'`, `branch === 'feat'`, `rebaseProgress`
   equals `{ current: 1, total: 1 }`.
5. `a mid-merge repo reports "merging" and keeps its branch` — asserts `repoState === 'merging'`,
   `branch === 'main'`.
6. `a mid-cherry-pick repo reports "cherry-picking"` — asserts `repoState === 'cherry-picking'`.
7. `-uall reports 47 untracked files, not 8` — fixture: 47 files under `a/b/`. Asserts
   `uncommittedCount === 47`. (Measured: the same repo without `-uall` reports 1.)
8. `a repo whose .git vanished between passes is unavailable with reason "gone"` — run metadata once,
   `rmSync` the `.git`, run metadata again. Asserts `metaStatus === 'unavailable'`,
   `metaReason === 'gone'`, and `uncommittedCount === undefined` and `branch === undefined` (the
   previously-good values are cleared, not left stale).
9. `a non-numeric git exit code is git-error, not a crash` — **an empty PATH directory does not
   work**: `resolveGit()` falls back to the absolute `/usr/bin/git` (`src/core/rungit.ts`'s
   `FHS_GIT`), which exists on this machine, so the repo reads normally and `metaStatus` is `'ok'`.
   Instead shim `process.env.PATH` at a tracked temp directory containing an executable file named
   `git` (mode `0o755`) whose only content is the shebang line `#!/nonexistent/atrium-no-such-sh` —
   `execve` on a missing interpreter fails with ENOENT, which Node surfaces as `err.code === 'ENOENT'`
   and `runGit` passes through as the **string** `code`. Sanity-assert that shape first
   (`typeof result.code === 'string'` on a direct `runGit` call) so the test cannot pass vacuously.
   Then asserts `metaStatus === 'unavailable'`, `metaReason === 'git-error'`, and that `fetch`
   resolved rather than rejected. Restore `PATH` in a `finally`.

**Timeout and backoff**

10. `a timing-out repo backs off instead of reporting clean` — PATH-shim a `git` wrapper that sleeps
    2 s on `status` and execs the real binary otherwise, with `metadataTimeoutMs: 200`. After one
    metadata pass: `metaStatus === 'unavailable'`, `metaReason === 'timeout'`,
    `uncommittedCount === undefined` (**not** `0`), `branch === undefined`. After a second, immediate
    pass: the shim's argv log gained **no** new `status` line for that repo (the backoff skipped it).
    After a third pass the shim is invoked again (`skipCycles` was 1).
11. `a repo that succeeds then times out goes stale, keeping its last good values` — first pass
    without the slow shim, second pass with it. Asserts `metaStatus === 'stale'`,
    `uncommittedCount` still equals the first pass's number, `metaReason === undefined`.

**Call shapes**

12. `the metadata argv is exactly the three declared shapes, with no caller-supplied --no-optional-locks` —
    PATH-shim recorder over a single clean repo. Asserts the recorded argv for the status call contains
    `--no-optional-locks` **exactly once**, at an index lower than `status`, and that the elements from
    `status` onward are exactly `['status', '--porcelain=v2', '--branch', '-uall']` with nothing after.
    Asserts the rev-parse call's tail is exactly
    `['rev-parse', '--absolute-git-dir', '--is-bare-repository']`, and the log call's tail is exactly
    `['log', '--no-ext-diff', '--no-textconv', '-1', '--format=%ct']` (runGit inserts the two diff-safety
    flags after `log`).

**Data and redaction**

13. `the metadata branch returns the full merged Data, not a delta` — after a discovery pass and a
    metadata pass, the metadata pass's return value still carries the complete repo list and the
    dropped-ambiguous list, with the same repo count as discovery returned.
14. `no filename ever reaches the wire — only the count does` — fixture repo with one untracked file
    named `ATRIUM-SENTINEL-<random>.txt`. Asserts `uncommittedCount === 1` and that
    `JSON.stringify(provider.toClient(data))` does **not** contain the sentinel string.
15. `an unavailable repo emits no branch, no count and no time on the wire` — take fixture 2 (bare),
    serialise through `toClient`, and assert the per-repo wire object has no `branch`,
    `uncommittedCount`, `lastCommitAt`, `repoState` or `rebaseProgress` key at all (`'branch' in obj`
    is `false` — not "is undefined"), while `metaStatus === 'unavailable'` and `metaReason === 'bare'`.
16. `metaCheckedAt never reaches the wire` — asserts the key is absent from the serialised object
    while present on the in-memory entry after a successful read.

**Actions and target validation**

17. `each action's argv places its own -- or option flag before the repo path` — with the default
    config, `buildArgv` on `open-editor` returns `{ cmd: 'code', args: ['--', '<discovered path>'] }`;
    `open-terminal` returns `{ cmd: 'konsole', args: ['--separate', '--workdir', '<discovered path>'] }`;
    `open-claude` returns `{ cmd: 'konsole', args: ['--separate', '--workdir', '<discovered path>', '-e', 'claude'] }`.
    Assert through `buildArgv(action, target)` from `src/core/actions.ts`, not by calling `argv`
    directly, so the exec-arm guard is in the path.
18. `an undiscovered path is refused before any argv is built` — `dispatch(registry, 'repos',
    'open-editor', { path: '/tmp/not-a-discovered-repo' }, { cfg })` rejects with
    `/unknown repository target/`. Also asserts a path that is a *subdirectory* of a discovered repo,
    a path with a trailing `/`, and `<discovered>/..` are each rejected.
19. `a dropped-ambiguous candidate is not an action target` — a candidate Task 7 reports in the
    dropped list is rejected by `resolveTarget` with the same error.
20. `a malformed target is refused` — `{}`, `null`, `'string'`, `{ path: 42 }` and
    `{ path: ['/tmp/x'] }` each reject with `/action target must be an object with a string "path"/`.
21. `an action dispatched before any fetch fails closed` — build the provider, do not call `fetch`,
    dispatch: rejects with `/configuration has not been loaded yet/`.
22. `a configured cmd naming the version-control binary is still refused` — set
    `repos.editor.cmd` to the binary name (the literal is legal in `test/`; the tripwire scans only
    `src/`) and assert `dispatch` rejects with `/runGit/`, i.e. `buildArgv`'s guard
    (`src/core/actions.ts:54-58`) is genuinely in the path.
23. `template validation rejects the five malformed shapes` — `parse` throws for
    `{ cmd: '', args: [] }`, `{ cmd: 'code', args: 'x' }`, `{ cmd: 'code', args: ['--'] }` (no
    placeholder), `{ cmd: 'code', args: ['--', '${path}', '${path}'] }` (two), and
    `{ cmd: 'code', args: ['--workdir=${path}'] }` (embedded), each with the exact message from
    step A.
24. `a placeholder with no dash-leading literal before it is rejected` — `{ cmd: 'code', args: ['${path}'] }`
    and `{ cmd: 'code', args: ['open', '${path}'] }` both throw
    `/must place a literal option \(starting with "-"\) immediately before/`.
25. `out-of-range numeric config is rejected, not clamped` — `metadataConcurrency` of `0`, `17` and
    `8.5`, and `metadataTimeoutMs` of `50` and `60001`, each throw the exact message.

**Lifecycle**

26. `an aborted fetch issues no git calls` — pass an `AbortController` whose `signal` is already
    aborted; the PATH-shim argv log stays empty and `fetch` resolves.

### Mutations

Each line is the exact edit to make, and the test that must turn red. Run them one at a time, confirm
red, restore, confirm green — and record the pass, because Task 10 re-runs all of them.

| # | Mutation | Goes red |
|---|---|---|
| M1 | In `classifyState`, delete row 6 (`parsed.initial` → `'empty'`) and change nothing else | Test 1 — the empty repo's `branchHead` is `main`, not `(detached)`, so it falls through to `'clean'` |
| M1b | In `readOne` step 4, branch on `log`'s exit code: `if (lg.code !== 0) setUnavailable(entry, 'git-error')` | Test 1 — `metaStatus` becomes `'unavailable'`. *(The originally recorded form of M1 — deriving `repoState = 'empty'` from `log`'s non-zero exit — turns **no** test red: the empty fixture's `log` exits 128, so the compensating half reproduces exactly the answer Test 1 asserts, and no other fixture in this suite has a non-zero `log` exit on a non-empty repo. M1/M1b split it into the two halves that do bite. Task 10's row 13 is corrected to match.)* |
| M2 | Delete the target validation: change each `argv` to `renderTemplate(tpl, (target as {path: string}).path)` with no `resolveTarget` call | Tests 18, 19, 20 |
| M3 | Relax `resolveTarget` to a prefix match (`[...repos.keys()].some(k => path.startsWith(k))`) | Test 18's subdirectory case |
| M4 | Remove the bare gate: drop the `isBare` branch and let `status` run | Test 2 — the repo becomes `unavailable`/`git-error` instead of `unavailable`/`bare`, and the recorded argv gains a `status` call |
| M5 | Ignore `timedOut`: in `onTimeout`'s call sites, treat a timed-out `status` as an ordinary non-zero result | Test 10 — `metaReason` becomes `'git-error'` and the second pass re-runs the repo |
| M6 | On timeout, write `uncommittedCount = 0` instead of leaving it undefined | Test 10's `uncommittedCount === undefined` assertion |
| M7 | Drop the backoff skip: never set `skipCycles` | Test 10's second-pass assertion (the shim is invoked again immediately) |
| M8 | Reorder `classifyState` so the `(detached)` check precedes the `rebase-merge` check | Tests 3 and 4 — `repoState` becomes `'detached'` and `branch` becomes `undefined` |
| M9 | In `resolveBranch`, assign `parsed.branchHead` unconditionally | Test 3 — `branch` becomes `'(detached)'` |
| M10 | Append `'--no-optional-locks'` to the status args array | Test 12 (two occurrences) **and** Tests 1/7 — git exits 129, so the repo goes `unavailable`/`git-error` |
| M11 | Drop `-uall` from the status args | Test 7 — 47 becomes 1 |
| M12 | Change `toClient` to `{ ...entry }` | Test 14 (the sentinel filename is not present — but `metaCheckedAt` is) → Test 16 goes red; and Test 15, since the deleted keys reappear as `undefined`-valued own properties only if also assigned — assert `'branch' in obj` so the spread form is caught |
| M13 | In `setUnavailable`, stop deleting `uncommittedCount`/`branch` | Tests 8 and 15 |
| M14 | Change the metadata branch to return only the changed repos | Test 13 |
| M15 | Capture `table`/`lastCfg` by value at construction instead of by getter | Tests 17 and 18 — the table is empty at construction, so every target is unknown |
| M16 | In `renderTemplate`, use `a.replace(PATH_PLACEHOLDER, path)` instead of exact-element comparison | Nothing in this suite — which is why Test 23's embedded-placeholder case exists at parse time; verify Test 23 still holds and note that M16 alone is not detectable, so the parse-time rejection is the control |
| M17 | Drop the `typeof code === 'number'` narrowing and compare `code !== 0` directly | Test 9 — `'ENOENT' !== 0` is true so this one still passes; instead mutate to `if (code === 0)` on a string code path and confirm Test 9 goes red. If neither direction reddens, the test is not pinning — fix the test, not the record |

M16 and M17 are recorded honestly as the two places where the obvious mutation does **not** redden a
test. Do not paper over them: this project has seven recorded tests that passed against a deliberately
broken implementation (carry-forward §3), and an unpinned mutation written down is worth more than a
pin that does not exist.

---

## Out of scope for this task

- **`show diff`.** Deferred by Task 1 Ruling B. Ship three actions, not four. Do not add a fourth
  action, a `call` action returning diff text, or an external-viewer action.
- **Any edit to `src/core/rungit.ts`.** `timedOut` arrives from Task 1. The `resolveGit()` PATH-scan
  cost is measured and recorded here, not fixed here.
- **Any edit to `src/core/actions.ts`, `src/server/routes.ts`, `src/core/contract.ts` or
  `src/core/scheduler.ts`.** In particular: do not add a `payloadSchema` to the `exec` arm, do not add
  a result channel to `exec`, and do not give `argv` a `cfg` parameter. Target validation lives inside
  the provider, which is where the discovered table is.
- **Any change to `test/rungit.test.ts`'s `GIT_LITERAL` regex** (Task 1 Ruling A) — and no quoted bare
  version-control binary name anywhere under `src/`, comments included.
- **The discovery pass, the validity gate and the classifier.** Task 7 owns them. If a discovery bug
  surfaces here, report it; do not fix it in this task's diff.
- **The pane.** No file under `web/` is touched. Rendering `metaStatus`, the needs-attention grouping,
  `Intl.RelativeTimeFormat` and the loading/unavailable/empty states are Task 9.
- **First run.** No `detect()` work, no editor-allowlist probing, no config persistence. The five new
  keys are defaulted in `parse` and edited by hand in `config.json`.
- **Per-schedule keying of `last`** in the scheduler. The documented "every schedule branch returns the
  full merged Data" rule plus Test 13 stands in for it, by plan decision.
- **Any `systemd-run`/D-Bus probing or launcher selection.** Ruling E records the no-op; it does not
  fix it.
- **`repos.staleDays` consumption.** It is parsed (Task 7) and rendered (Task 9). This task neither
  reads it nor groups by it.

---

### Task 9: The repos pane

This task turns the authenticated live screen T6 delivered into the first *real* screen: a
`ReposPane` that renders the `repos` provider's discovered repositories — name, branch, state,
relative time since last commit, uncommitted count — recent-first, with a separate "needs
attention" group, three POST action buttons per repo, and three visibly distinct non-populated
states (`loading`, `unavailable`, `empty`). It exists because the whole slice's claim is "one
provider end-to-end through auth, socket, and a real pane"; without this task the stack carries
real repo data to a `<pre>`. It is also where two mandatory mutation checks live: the spec's
`unavailable`-vs-zero branch (design spec §10, line 533) and the "needs attention" conjunction,
both of which are the exact shape of defect this project has shipped before. The pane is written
as a **pure function plus a pure component**, so both are testable with `react-dom/server` under
`bun test` with no DOM, no jsdom, and no new dependency.

**Depends on:** 6, 8 (transitively 1, 2, 3, 4, 5, 7)

---

## Files

- `web/src/panes/ReposPane.tsx` — **new.** Exports the pure component `ReposPane`, the pure
  derivation `deriveReposPaneState`, the presentation helpers `stateLabel` and
  `relativeCommitTime`, and the types `ReposPaneState`, `ReposPaneInput`, `ReposPaneProps`,
  `RepoRow`. Contains no fetch, no socket, no `useEffect`, no module-level state.
- `web/src/main.tsx` — **modified.** Replaces T6's live-state `<pre>` with `<ReposPane …/>`,
  wired to T6's store and to `postReposAction`. **Keeps a literal `p-4`** in its rendered tree
  (see the packaging trap below).
- `web/src/lib/api.ts` — **modified.** Adds exactly one export, `postReposAction(actionId, path)`,
  built on the authenticated POST helper T6 put in this file.
- `test/repos-pane.test.ts` — **new.** All pane unit tests plus the end-to-end smoke test. A
  `.ts` file, not `.tsx`: it builds elements with `createElement(...)`, never JSX, so the
  filename the scoping doc specifies stays correct.
- `src/index.ts` — **modified, two lines only.** This task owns the wiring that puts the finished
  `repos` provider into the running server. No earlier task does: T3 deliberately leaves `providers`
  unset with a marker comment, and T7/T8 are forbidden from touching `src/index.ts`. Without it the
  shipped binary registers **zero** providers, `/api/state` serves `{}` forever, and this task's own
  smoke test cannot pass. This task is also the only one that depends on both the finished provider
  (T7/T8) and the finished server (T6), so it is the only place the edit is conflict-free.

Apart from those two lines in `src/index.ts`, nothing under `src/` is edited by this task. In
particular `test/rungit.test.ts`'s `GIT_LITERAL` regex is not touched (Ruling A),
`src/core/scheduler.ts` and `src/server/serve.ts` belong to T2/T5/T6, and `src/providers/repos/`
belongs to T7/T8.

---

## Interfaces this task consumes (produced by earlier tasks — do not redefine them here)

**These are the producers' spellings. Import them; do not restate them, and do not invent
convenience aliases** — every name below was checked against the task that declares it.

From **T2/T6**, in `src/core/wire.ts`, carried by the `snapshot` and `update` server frames:

```ts
export interface ScheduleHealth {
  lastSuccessAt: number | null      // epoch ms of the last successful run, null if never
  consecutiveFailures: number       // 0 after a success
  lastErrorMessage: string | null
}
export interface ProviderStatus {
  data?: unknown                    // the value toClient() produced; ABSENT until a run succeeds
  schedules: Record<string, ScheduleHealth>   // keyed by schedule name ('discovery' | 'metadata')
}
```
`scheduler.snapshot()` returns `Record<providerId, ProviderStatus>` and creates **no entry** for
a provider that has neither succeeded nor failed (this is what keeps
`test/contract.test.ts:209`'s `expect(s.snapshot()).toEqual({})` green).

From **T7 and T8**, in `src/providers/repos/index.ts`, the value `toClient()` puts on the wire.
T7 declares `RepoWire`/`ReposWire`; T8 widens `RepoWire` with the metadata fields:

```ts
export type RepoState =                    // a flat STRING union, not a discriminated object union
  | 'clean' | 'detached' | 'rebasing' | 'merging'
  | 'cherry-picking' | 'reverting' | 'bisecting' | 'empty'

export type RepoMetaStatus = 'ok' | 'stale' | 'unavailable'
export type RepoUnavailableReason = 'timeout' | 'bare' | 'gone' | 'git-error'

export interface RepoWire {
  id: string
  path: string                 // absolute; deliberately on the wire — it is the action target
  name: string                 // basename; attacker-controlled (§8.7)
  bare: boolean
  origin: 'top-level' | 'container-child'
  branch?: string              // ABSENT when unknown — never null, never ''. Attacker-controlled (§8.7)
  repoState?: RepoState
  rebaseProgress?: { current: number; total: number }
  uncommittedCount?: number
  lastCommitAt?: number        // UNIX SECONDS (log -1 --format=%ct); ABSENT for an empty repo
  metaStatus: RepoMetaStatus
  metaReason?: RepoUnavailableReason
}
export interface DroppedWire { id: string; name: string; reason: DropReason }
export interface ReposWire {
  repos: RepoWire[]
  dropped: DroppedWire[]       // §7.1: candidates the classifier dropped, reported not discarded.
                               // Dropped candidates carry NO path — they are not action targets.
  errors: string[]
  scannedAt: number
  staleDays: number            // the effective repos.staleDays, echoed onto the wire
}
```

**Absent, not null**, throughout: T8 states the rule (§7.4 applied per repo) that an unavailable or
unknown value emits *no key at all* — "not zero, not null, absent". Every optional read in this file
is therefore `=== undefined`, never `=== null`.

From **T8**, the three exec action ids on the `repos` provider: `open-editor`, `open-terminal`,
`open-claude`. Each takes the payload `{ path: string }` and validates that path against the
discovered repo table before building argv.

From **T4**, `handoffPath(env)` in `src/core/paths.ts`, resolving to `handoff.json` beside
`endpoint.json` in the 0700 runtime dir, holding the boot-minted handoff 0600 as JSON
(`{ token, port, pid }`).

From **T6**, in `web/src/lib/store.ts`: `createStore()` and the state it yields,
`AtriumState = { connected: boolean; hasSnapshot: boolean; providers: Record<string, ProviderStatus> }`.
**There is no `useAtriumState()` wrapper hook** — T6's `main.tsx` calls
`useSyncExternalStore(store.subscribe, store.getSnapshot)` directly, and that is the call site this
task builds `ReposPaneInput` from. `hasSnapshot` latches `true` on the first `snapshot` frame and is
**not** cleared by a disconnect. Never change `ReposPane`'s or `deriveReposPaneState`'s signatures to
match a different store shape — those are what the tests pin.

---

## Steps

- [ ] Create `web/src/panes/ReposPane.tsx`. Import the wire types **type-only**:
      `import type { ReposWire, RepoWire, RepoState } from '../../../src/providers/repos/index'`
      and `import type { ProviderStatus } from '../../../src/core/wire'`. Declare none of them
      locally — a second declaration is how the pane and the provider drift. `verbatimModuleSyntax`
      is on, so `import type` erases completely. **A value import from `src/` here drags
      `node:child_process` into the browser bundle** — never drop the `type` keyword.

- [ ] Declare the derived state, exported from the same file:
```ts
export interface RepoRow extends RepoWire {}

export type ReposPaneState =
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'empty' }
  | { kind: 'ready'; needsAttention: RepoRow[]; recent: RepoRow[]; droppedAmbiguous: string[] }

export interface ReposPaneInput {
  hasSnapshot: boolean                        // T6's AtriumState.hasSnapshot
  providers: Record<string, ProviderStatus>   // T6's AtriumState.providers
  nowMs: number
}
```

- [ ] Implement `export function deriveReposPaneState(input: ReposPaneInput): ReposPaneState` with
      exactly this branch order. **The provider id is the literal `'repos'`** (Ruling A); there is
      no `git` key anywhere in this file.
  1. `if (!input.hasSnapshot) return { kind: 'loading' }`
  2. `const entry = input.providers['repos']; if (entry === undefined) return { kind: 'loading' }`
     — registered but not yet run.
  3. `if (entry.data === undefined)`: scan `entry.schedules` in `Object.keys` order for the first
     entry with `consecutiveFailures > 0`. If one exists, return
     `{ kind: 'unavailable', reason: f.lastErrorMessage ?? 'provider failed' }`. Otherwise return
     `{ kind: 'loading' }`.
  4. `const wire = entry.data as ReposWire; if (wire.repos.length === 0) return { kind: 'empty' }`
  5. Otherwise partition and sort (below) and return the `ready` shape, with
     `droppedAmbiguous = wire.dropped.filter(d => d.reason === 'ambiguous').map(d => d.name)`.
     Names, not paths: T7 deliberately keeps a dropped candidate's absolute path off the wire, so
     `ReposPaneState.droppedAmbiguous` stays a `string[]` of basenames.

- [ ] Implement the staleness and needs-attention rules inside `deriveReposPaneState`, as two
      named local predicates so the mutation is a one-line edit:
```ts
const isStale = (r: RepoWire) =>
  r.lastCommitAt !== undefined && input.nowMs - r.lastCommitAt * 1000 > wire.staleDays * 86_400_000
const needsAttention = (r: RepoWire) => isStale(r) && (r.uncommittedCount ?? 0) > 0
```
      Three properties that are easy to get wrong and are each pinned by a test:
      **(a)** the connective is `&&`, never `||` — §7.1: an old clean repo is finished, not
      rotting; **(b)** an **absent** `lastCommitAt` (an empty repo, or one whose metadata is
      unavailable) is **never** stale, however many uncommitted files it has — and the `?? 0` on
      `uncommittedCount` is deliberate for the same reason, since T8 omits that key entirely on an
      unavailable repo and such a repo must not be reported as needing attention on the strength of
      a count nobody could read; **(c)** the comparison is strict `>`, and the unit conversion is
      seconds→ms on `lastCommitAt` and days→ms on `staleDays`.

- [ ] Partition: every repo lands in **exactly one** of `needsAttention` and `recent` — no repo
      appears in both. Sort both arrays with one shared comparator, recent-first:
      descending `lastCommitAt`; an **absent** `lastCommitAt` sorts **after** every dated repo; ties
      (including two undated repos) break on `name` ascending with `localeCompare`. Determinism here is
      what makes the ordering test assertable.

- [ ] Implement `export function stateLabel(repo: RepoWire): string`. It takes the **whole repo**,
      not a state value, because T8 carries the state as a flat **string** union with `branch` and
      `rebaseProgress` as sibling fields. Two guards first, then an exhaustive switch:
      1. `if (repo.metaStatus === 'unavailable') return \`unavailable (${repo.metaReason ?? 'unknown'})\``
         — T8 deletes `repoState` along with every other metadata field in that case.
      2. `if (repo.repoState === undefined) return 'unavailable (unknown)'`, so the switch below can
         be genuinely exhaustive over the string union.
      3. `switch (repo.repoState)` with **no `default` branch**, ending with
         `const _never: never = repo.repoState; return _never`, so a future `RepoState` member fails
         `bun run typecheck` instead of silently rendering nothing. Labels, exactly:
         `clean` → `clean`; `detached` → `detached`; `merging` → `merging`;
         `cherry-picking` → `cherry-picking`; `reverting` → `reverting`; `bisecting` → `bisecting`;
         `empty` → `empty`; and `rebasing` →
         `` `rebasing ${repo.branch ?? '(unknown branch)'} ${p.current}/${p.total}` `` where
         `p = repo.rebaseProgress`, falling back to
         `` `rebasing ${repo.branch ?? '(unknown branch)'}` `` when `rebaseProgress` is absent — T8
         omits it entirely when the rebase state files are unreadable. §7.1: a rebase renders its
         real branch and is never shown as a bare `(detached)`.

- [ ] Implement `export function relativeCommitTime(lastCommitAt: number | undefined, nowMs: number): string`.
      `undefined` → the literal string `no commits yet` (§7.1: an empty repo has no last-commit time
      and must not surface as an error). Otherwise compute
      `deltaSec = Math.round(lastCommitAt - nowMs / 1000)` (negative for the past) and pick the
      largest unit whose absolute value is at least 1, from this fixed table:
      `year` 31_536_000, `month` 2_592_000, `week` 604_800, `day` 86_400, `hour` 3_600,
      `minute` 60, else `second`. Format with
      `new Intl.RelativeTimeFormat('en', { numeric: 'auto' })` — the locale is the **literal
      `'en'`**, never the ambient system locale, or the tests are machine-dependent. Construct the
      formatter once at module scope. No new dependency; `Intl.RelativeTimeFormat` is verified
      present in bun 1.3.11.

- [ ] Implement the component:
```ts
export interface ReposPaneProps {
  state: ReposPaneState
  nowMs: number
  onAction(actionId: string, path: string): void
}
export function ReposPane(props: ReposPaneProps) { … }
```
      Root element for every branch: `<section data-pane="repos" data-state={props.state.kind}
      className="flex flex-col gap-3">`. `data-state` is what makes the three non-populated
      branches mechanically distinguishable; each branch **also** renders distinct human text —
      `loading` → `Loading repositories…`; `unavailable` → `Repositories unavailable` plus the
      `reason` string; `empty` → `No repositories found`.

- [ ] Render the `ready` branch: the `needsAttention` array first under a heading
      `Needs attention`, then `recent` under `Recent`. The `Needs attention` heading is rendered
      only when that array is non-empty. Per repo, one row element
      `<li data-repo={repo.path} …>` showing `repo.name`, `repo.branch ?? '—'`,
      `stateLabel(repo)`, `relativeCommitTime(repo.lastCommitAt, props.nowMs)`, and
      `` `${repo.uncommittedCount ?? 0} uncommitted` ``.

- [ ] Render the three action buttons per repo, each exactly:
      `<button type="button" data-action="open-editor" onClick={() => props.onAction('open-editor', repo.path)}>Editor</button>`
      and likewise `open-terminal` → `Terminal`, `open-claude` → `Claude`. **`type="button"` is
      not decoration** — a bare `<button>` inside a form defaults to submit. There is **no `<a>`
      and no `<form>`** anywhere in this file: `src/server/routes.ts:70` dispatches an action only
      on `POST`, and `test/routes.test.ts:48-55` already pins that a GET on an action path is a
      404 with the handler never run.

- [ ] §8.7 discipline, enforced by the source-grep test below: branch names, repo names and paths
      are attacker-controlled. They reach the DOM only as React children or as plain string
      attributes. This file contains **no `dangerouslySetInnerHTML`, no `new URL(`, and no
      `style={{` prop** (Ruling D: `src/server/serve.ts:15-16` ships `default-src 'self'` with no
      `style-src` and no `'unsafe-inline'`, the failure is silent, and `scripts/assert-package.ts`
      uses `fetch` and can never observe a CSP violation). Tailwind utility classes only.

- [ ] Render `droppedAmbiguous` when non-empty as a single muted line,
      `` `${n} candidate(s) hidden as ambiguous` ``, with no action attached — §7.1 requires them
      reported rather than silently decided, and the first-run flow that lets a user adopt one is
      deferred out of this plan.

- [ ] Wire the provider into the binary. In `src/index.ts`, add
      `import { createReposProvider } from './providers/repos/index'` and change the `serve` case's
      call to `await startServer({ port, config: loadConfig(), providers: [createReposProvider()] })`,
      **replacing the placeholder comment Task 3 left there** ("Providers are registered through
      ServeConfig.providers; nothing registers one yet"). Two lines, and nothing else in that file.
      Do not construct the provider at module scope — `createReposProvider()` is a factory whose
      closure holds a repo table, and a module-scope instance would be shared by any future second
      server in the same process.

- [ ] Add to `web/src/lib/api.ts` exactly one export:
      `export function postReposAction(actionId: string, path: string): Promise<void>`, which
      POSTs `{ path }` as JSON to `/api/actions/repos/${actionId}` through the authenticated POST
      helper T6 already put in this file (bearer header, same-origin, `content-type:
      application/json`). Do not add a second fetch implementation.

- [ ] Edit `web/src/main.tsx`: read T6's live state from its existing
      `useSyncExternalStore(store.subscribe, store.getSnapshot)` call (there is no `useAtriumState()`
      hook), build `{ hasSnapshot: state.hasSnapshot, providers: state.providers, nowMs: Date.now() }`,
      call `deriveReposPaneState`, and render
      `<ReposPane state={…} nowMs={…} onAction={postReposAction} />`. The app shell root element
      **keeps a literal `p-4` in its `className`** — written out in full, never assembled as a
      template string, because Tailwind v4 scans source text for class names. This is the
      packaging trap: the entire built stylesheet is 4188 bytes with two rules, and
      `.p-4{padding:calc(var(--spacing) * 4)}`, sourced today solely from `web/src/main.tsx:5`, is
      the only thing satisfying `scripts/assert-package.ts:108-113`. Remove it and the release
      gate fails with a message blaming a Tailwind configuration problem that does not exist.

- [ ] Write `test/repos-pane.test.ts` (details below), run `bun test`, then run the whole
      **Mutations** list one at a time — apply the edit, confirm the named test goes red, revert,
      confirm green. Record the red-then-green result; T10 replays this list.

- [ ] Acceptance before handing off: `bun test` green (118 existing + the new cases, with no
      pre-existing test edited), `bun run typecheck` clean, and
      `bun run build && bun run assert:package` passing — the last one is not optional for this
      task specifically, because this task rewrites `main.tsx`.

---

## Tests

All in `test/repos-pane.test.ts`. Build elements with
`createElement(ReposPane, props)` from `react` and render with `renderToStaticMarkup` from
`react-dom/server` — both verified working under `bun test` on bun 1.3.11 with React 19, no jsdom
and no new dependency.

Shared fixture constants, declared once at the top of the file and never derived from `$HOME`
(design spec §10 rule 1):

- `const NOW_MS = Date.UTC(2026, 8, 14, 12, 0, 0)` and `const NOW_S = NOW_MS / 1000`.
- `READY_WIRE: ReposWire` with `staleDays: 30`, `scannedAt: NOW_MS`, `errors: []`,
  `dropped: [{ id: 'd1', name: 'ambig', reason: 'ambiguous' }]`, and five repos. Every row also
  carries `id: <name>`, `path: '/fixtures/<name>'`, `bare: false`, `origin: 'top-level'` and
  `metaStatus: 'ok'`; the columns below are the ones the assertions read:
  | name | `branch` | `repoState` | `lastCommitAt` | `uncommittedCount` | expected group |
  |---|---|---|---|---|---|
  | `alpha` | `'main'` | `'clean'` | `NOW_S - 7200` | 0 | recent |
  | `bravo` | `'feat/x'` | `'rebasing'`, `rebaseProgress: {current:2,total:5}` | `NOW_S - 90*86400` | 3 | **needs attention** |
  | `charlie` | `'main'` | `'clean'` | `NOW_S - 120*86400` | 0 | recent (stale but clean) |
  | `delta` | `'main'` | `'clean'` | `NOW_S - 3600` | 12 | recent (dirty but fresh) |
  | `echo` | *(key absent)* | `'empty'` | *(key absent)* | 4 | recent (no commit ⇒ never stale) |
  `echo`'s `branch` and `lastCommitAt` keys must be genuinely **absent** from the object literal, not
  present-and-`undefined`: T8's wire omits them, and a fixture that spells them out as `undefined`
  would hide a `=== null` bug in the pane.
- `FAILING_SNAPSHOT`: `{ repos: { schedules: { discovery: { lastSuccessAt: null, consecutiveFailures: 3, lastErrorMessage: 'ENOENT: no such file or directory' } } } }` with **no `data` key**.
- `EMPTY_SNAPSHOT`: `{ repos: { data: { repos: [], dropped: [], errors: [], scannedAt: NOW_MS, staleDays: 30 }, schedules: {} } }`.

**Derivation cases**

1. `'derives loading before the first snapshot frame'` — `hasSnapshot: false`, `providers: {}` →
   `kind === 'loading'`.
2. `'derives loading when the snapshot carries no repos entry yet'` — `hasSnapshot: true`,
   `providers: {}` → `kind === 'loading'`.
3. `'derives unavailable from the failure record, never empty'` — `FAILING_SNAPSHOT` →
   `kind === 'unavailable'` and `reason === 'ENOENT: no such file or directory'`.
4. `'derives empty only when the provider succeeded with zero repos'` — `EMPTY_SNAPSHOT` →
   `kind === 'empty'`.
5. `'needs attention requires BOTH staleness and uncommitted changes'` — `READY_WIRE` →
   `needsAttention.map(r => r.name)` equals `['bravo']` exactly. Asserted as a whole-array
   equality, not a `toContain`, so the OR mutation cannot pass by accident.
6. `'a repo with no commits is never stale, however dirty'` — `echo` (uncommitted 4,
   `lastCommitAt: null`) appears in `recent`, not in `needsAttention`.
7. `'recent is ordered most-recent-first with undated repos last'` —
   `recent.map(r => r.name)` equals `['delta', 'alpha', 'charlie', 'echo']`.
8. `'a repo appears in exactly one group'` — the concatenated name lists have length 5 and no
   duplicates.
9. `'droppedAmbiguous is reported, not discarded'` — the `ready` state carries exactly `['ambig']`,
   derived from the wire's `dropped` entries whose `reason` is `'ambiguous'`. Assert as a whole-array
   equality, and additionally assert the rendered markup contains no `/fixtures/` string, pinning that
   a dropped candidate's path never had to be on the wire in the first place.

**Presentation cases**

10. `'relativeCommitTime renders fixed English units and a no-commit case'` —
    `relativeCommitTime(NOW_S - 7200, NOW_MS) === '2 hours ago'`;
    `relativeCommitTime(NOW_S - 90 * 86400, NOW_MS) === '3 months ago'`;
    `relativeCommitTime(undefined, NOW_MS) === 'no commits yet'`.
11. `'a rebasing repo renders its real branch and step, never a bare detached'` —
    `stateLabel(READY_WIRE.repos.find(r => r.name === 'bravo')!) === 'rebasing feat/x 2/5'`, and
    the rendered `ready` markup contains `rebasing feat/x 2/5` and does not contain `(detached)`.
11b. `'an unavailable repo labels itself unavailable rather than guessing a state'` —
    `stateLabel({ …a minimal RepoWire…, metaStatus: 'unavailable', metaReason: 'bare' })` equals
    `'unavailable (bare)'`, with `repoState`, `branch` and `uncommittedCount` all absent from that
    object — the exact shape T8 produces for a bare repo.

**Render cases**

12. `'the three non-populated states render three visibly distinct panes'` — render `loading`,
    `unavailable` and `empty`; assert `data-state="loading"` / `"unavailable"` / `"empty"`
    respectively, assert each contains its own text (`Loading repositories…`,
    `Repositories unavailable` plus the reason, `No repositories found`), and assert the three
    markup strings are pairwise unequal.
13. `'an attacker-controlled branch name renders escaped'` — a one-repo `ready` state whose
    `name` is `<img src=x onerror=alert(1)>` and whose `branch` is `<script>alert(1)</script>`;
    assert the markup contains `&lt;script&gt;` and `&lt;img`, and contains neither `<script>`
    nor `<img `.
14. `'actions are POST buttons, never links or forms'` — render the `ready` state; assert the
    markup contains `data-action="open-editor"`, `data-action="open-terminal"` and
    `data-action="open-claude"`; assert every `<button` occurrence is immediately followed by
    `type="button"`; assert the markup contains no `<a ` and no `<form`.
15. `'clicking an action reports the action id and the repo path'` — call the `onClick` handler
    off the element tree directly (build the element, walk `props.children`) **or**, simpler and
    preferred, assert `data-repo="/fixtures/bravo"` is present on the row and that the three
    buttons are rendered inside it, then separately unit-test `postReposAction` is the value
    `main.tsx` passes by asserting the export exists and is a function. Do not add a DOM library
    to synthesize a click.
16. `'main.tsx still contains the literal p-4 the packaging gate depends on'` — read
    `web/src/main.tsx` with `readFileSync` and assert `/\bp-4\b/` matches. Cheap standing guard
    for `scripts/assert-package.ts:108-113`, which otherwise only fails at release.
17. `'the pane source contains no injection sink and no value import from src/'` — read
    `web/src/panes/ReposPane.tsx` and assert it contains none of `dangerouslySetInnerHTML`,
    `new URL(`, `style={{`; and that every line importing from a path containing `../src/`
    begins with `import type`.

**End-to-end smoke**

18. `'the assembled server serves the fixture repos over an authenticated /api/state'` —
    port **7424** — this task's only port, per the plan-wide port ledger:

    **Port ledger for Plan 2 — one table, published once and pasted into every brief that binds a port.
    Do not re-derive it; a range not listed against your task is not yours.**
    
    | Range | Owner |
    |---|---|
    | 7373 | `scripts/assert-package.ts` (existing) |
    | 7391-7403 | `test/serve.test.ts` (existing) |
    | 7404-7411 | Task 4 |
    | 7412-7421 | Task 6 |
    | 7422-7423 | Task 3 |
    | 7424 | Task 9 |
    | 7430-7433 | Task 2 |
    - Build a fixture root with `mkdtempSync` containing three repos via
      `makeRepo()` from `test/fixtures/gitrepo.ts` (whose `CLEAN_ENV` at
      `test/fixtures/gitrepo.ts:6-11` is what keeps git tests honest); move or create them under
      the fixture root.
    - Create an empty temp `HOME` and temp `XDG_CONFIG_HOME` / `XDG_RUNTIME_DIR`. Write
      `<XDG_CONFIG_HOME>/atrium/config.json` containing
      `{"repos": {"extraRoots": ["<fixtureRoot>"], "staleDays": 30}}`.
    - **Spawn the server as a subprocess** — `Bun.spawn([process.execPath, 'run',
      'src/index.ts', 'serve', '--port', '7424'], { env: { ...process.env, HOME, XDG_CONFIG_HOME,
      XDG_RUNTIME_DIR } })`, following the precedent at `test/serve.test.ts:52`. A subprocess is
      **required, not stylistic**: `os.homedir()` is resolved from `$HOME` at process start and
      is *not* affected by mutating `process.env.HOME` in-process (measured on bun 1.3.11), so an
      in-process `startServer` would run discovery over the developer's real `$HOME`, violating
      design spec §10 rule 1 and taking 1-5 seconds of unrelated I/O.
    - Poll `GET /healthz` with `host: 127.0.0.1:7424` until it answers (the poll-never-sleep
      pattern from `scripts/assert-package.ts:39-45`).
    - Read the boot handoff from `handoffPath({ XDG_RUNTIME_DIR })`, `POST /api/session` with the
      handoff in the **body** (never the query string), take `token` from the response, then poll
      `GET /api/state` with `Authorization: Bearer <token>` and `host: 127.0.0.1:7424` until
      `body.repos?.data?.repos?.length` is 3, with a 15s ceiling.
    - Assert the three fixture repo basenames are present and that no path outside the fixture
      root appears. Assert `body.repos.data.staleDays === 30` (proving T3's parsed config reached
      the provider and T5's `toClient` carried it).
    - **Then feed the real wire value straight into this task's own derivation** —
      `deriveReposPaneState({ hasSnapshot: true, providers: body, nowMs: Date.now() })` — and assert
      `kind === 'ready'` with `recent.length + needsAttention.length === 3`, then render that state
      through `renderToStaticMarkup` and assert each fixture basename appears in the markup. This
      single step is what makes the seventeen hand-built-fixture tests above non-vacuous: without it
      every field name in `READY_WIRE` could disagree with what the provider actually emits and the
      whole suite would stay green while the shipped pane rendered `undefined` in every cell.
    - `finally`: `proc.kill()` and `rmSync(..., { recursive: true, force: true })` every temp
      directory created here — carry-forward P3 asks for exactly this hygiene.

### Mutations

Each edit below must turn the named test red, and only that edit reverts it green. Apply, run,
revert, record.

| # | Exact edit | Test that must go red |
|---|---|---|
| M1 | In `deriveReposPaneState` step 3, replace `return { kind: 'unavailable', reason: … }` with `return { kind: 'empty' }` | 3 — `'derives unavailable from the failure record, never empty'` (**mandatory**, design spec §10 line 533) |
| M2 | In `needsAttention`, change `isStale(r) && r.uncommitted > 0` to `isStale(r) \|\| r.uncommitted > 0` | 5 — `'needs attention requires BOTH staleness and uncommitted changes'` (**mandatory**; `charlie` and `delta` both appear) |
| M3 | In `isStale`, drop the `r.lastCommitAt !== undefined &&` guard and treat an absent `lastCommitAt` as `0` | 6 — `'a repo with no commits is never stale, however dirty'` |
| M4 | Reverse the comparator (ascending `lastCommitAt`) | 7 — `'recent is ordered most-recent-first with undated repos last'` |
| M5 | In `stateLabel`, return the bare string `rebasing` for the `rebasing` case (dropping `repo.branch` and `repo.rebaseProgress`) | 11 — `'a rebasing repo renders its real branch and step, never a bare detached'` |
| M6 | Render the branch as `<span dangerouslySetInnerHTML={{ __html: repo.branch ?? '' }} />` | 13 — `'an attacker-controlled branch name renders escaped'` **and** 17 — source grep |
| M7 | Replace one action `<button type="button" …>` with `<a href={'/api/actions/repos/open-editor'} …>` | 14 — `'actions are POST buttons, never links or forms'` |
| M8 | Delete `p-4` from `web/src/main.tsx`'s className | 16 — `'main.tsx still contains the literal p-4 …'` |
| M9 | In step 3 of `deriveReposPaneState`, change `consecutiveFailures > 0` to `consecutiveFailures > 99` when scanning `entry.schedules` | 3 — the failing provider falls through to `loading` |
| M10 | In `deriveReposPaneState`, look the provider up as `input.providers['git']` | every derivation case 3-9 |
| M11 | In `src/index.ts`, delete `providers: [createReposProvider()]` from the `serve` case's `startServer` call | 18 — `'the assembled server serves the fixture repos over an authenticated /api/state'` (`/api/state` stays `{}` and the poll times out). This is the row that proves the vertical slice is actually wired. |
| M12 | In `stateLabel`, drop the `metaStatus === 'unavailable'` guard and fall through to the switch | 11b — `'an unavailable repo labels itself unavailable rather than guessing a state'` |

M10 is cheap and worth keeping in the list: it is the exact shape of scoping-doc plan defect 2
(the provider renamed to `repos` while the pane still reaches for `git`), and here it is a hard
failure rather than a silent `undefined`.

---

## Out of scope for this task

- **`show diff` — the fourth §7.1 action.** Deferred by Ruling B for this whole plan. Ship three
  buttons. Do not add a fourth, do not add an external viewer, do not widen the `Action` contract
  with a result channel.
- **Any edit under `src/` beyond the two provider-wiring lines in `src/index.ts`.** The scheduler,
  `serve.ts`, `wire.ts`, `contract.ts` and everything under `src/providers/repos/` are owned by
  T2/T5/T6/T7/T8. If a wire **field** this pane needs is missing or spelled differently, that is a
  cross-task interface defect to report, not to patch from here — adapt the pane to the producer's
  spelling and say so.
- **Loosening `test/rungit.test.ts`'s `GIT_LITERAL` regex.** It stays completely unedited
  (Ruling A). Nothing in this task's files is scanned by it anyway — the tripwire walks `src/`
  only, and only `.ts` files.
- **First run.** `droppedAmbiguous` is displayed, not actionable. No confirm-and-persist flow, no
  UI for `repos.treatAsContainer`, `repos.extraRoots` or `repos.includeDotPaths` — those stay
  hand-edited JSON this plan.
- **The four-way status envelope** (`ok | stale(age) | unavailable(reason) | unsupported-shape`).
  That is §7.4 and arrives with the claude provider. This pane has four states and `stale` is not
  one of them.
- **Sorting, filtering, search, collapsing, keyboard navigation, per-repo detail views,
  pagination, virtualisation.** Recent-first plus one group, as §7.1 specifies.
- **A WS `refresh`/`run` frame or any client-initiated poll.** T6 deliberately omits one:
  `POST /api/actions/:providerId/:actionId` carries the gate, the bearer check and `dispatch`'s
  static allowlist (`src/core/actions.ts:134-136`); a socket frame triggering `runNow` would run
  subprocesses through a path with none of it.
- **New dependencies of any kind** — no date library, no test-DOM library, no icon set, no CSS
  framework beyond the Tailwind already present. `Intl.RelativeTimeFormat` and
  `react-dom/server` cover everything this task needs.
- **`style={{}}` props and any inline `<style>`** — Ruling D; the CSP rejects them silently.
- **CI, `bun run verify`, and the consolidated mutation replay.** Those are T10.

---

### Task 10: Verify gate, dev loop, whole-plan mutation re-check

This task turns the plan's claims into enforced, repeatable facts. It adds one `verify`
entry point that chains the four gates (`build`, `assert:package`, `test`, `typecheck`)
so the packaging assertion — which has no caller at all until this task, and would
otherwise first
fail at release, with a message blaming a Tailwind config problem that does not exist —
runs on every check; it adds CI pinned to the same bun version `engines.bun` declares,
with a test that keeps the two from drifting; it writes down the dev loop that makes UI
iteration cheap and records, with measurements, that widening the request gate for a Vite
dev server is forbidden; it closes carry-forward P4; it records the written contracts the
next plan needs (the secrets adapter's shape, the claude port's forbidden-export grep,
the TLS spike); and it re-runs, one at a time on a clean tree, every mutation this plan
introduced, recording each red-then-green. Seven tests in this project have already been
found passing against a deliberately broken implementation. This pass is the toll for
adding roughly thirty more, and it is the only place the plan's central claim — that the
new tests can actually fail — is demonstrated rather than asserted.

**Depends on:** Task 9 (and, transitively, Tasks 1–8: the mutation pass requires every
earlier task's code and tests present on one tree).

**Files:**

- `package.json` — **modified**: add exactly one script, `verify`. Do **not** touch
  `scripts.typecheck` (Task 2 owns it and has already fixed carry-forward P2 there), do
  not touch `engines`, do not add `pretest`/`prepare`/`prepublish` hooks.
- `.github/workflows/ci.yml` — **new**: the only workflow. `ubuntu-latest`, bun pinned to
  the `engines.bun` floor, `bun install --frozen-lockfile`, then `bun run verify`.
- `test/verify-gate.test.ts` — **new**: four tests pinning that `verify` really chains all
  four stages in the right order, that every stage names a real script, that CI runs
  `verify` and not a bare test run, and that CI's bun pin equals the `engines.bun` floor.
- `test/rungit.test.ts` — **modified**, one test body only: carry-forward P4. Add the
  positive existence guard to the test named
  `'a symlink standing in for the hooks directory is refused, not followed'`. Change
  nothing else in this file — in particular the `GIT_LITERAL` regex and all four tripwire
  tests stay byte-identical (ADR 0002 Ruling A).
- `docs/decisions/0003-verify-gate-and-dev-loop.md` — **new** ADR: the verify chain and
  why, the CI pin, the measured dev loop, and the standing prohibition on widening
  `src/server/gate.ts` for a dev server.
- `docs/superpowers/plans/2026-09-14-plan-2-mutation-record.md` — **new**: the red-then-green
  table for every mutation this plan introduced.
- `docs/superpowers/plans/2026-09-14-plan-3-carry-forward.md` — **new**: written contracts
  for the next plan (TLS spike, secrets adapter shape, claude forbidden-export grep) plus
  what Plan 2 deliberately leaves open.

**Steps:**

- [ ] Confirm the starting point before changing anything: a clean working tree with Tasks
      1–9 merged, and `bun run build`, `bun run assert:package`, `bun test`,
      `bun run typecheck` each green when run by hand. Record the baseline test count
      (`N pass, 0 fail`) — the mutation record needs it. If any of the four is red, stop:
      this task cannot start on a red tree.
- [ ] Note before running anything: `scripts/assert-package.ts` spawns the compiled binary
      on port **7373**, which is also `atrium serve`'s default port (set in `src/index.ts`).
      Kill any dev-loop server before running `verify`, or the packaging assertion fails
      with `binary never started listening within 5s` for a reason that has nothing to do
      with packaging.
- [ ] Add to `package.json`'s `scripts` object, verbatim:
      `"verify": "bun run build && bun run assert:package && bun run test && bun run typecheck"`
      Order is load-bearing: `build` produces both `./atrium` and `./web-dist`, which
      `assert:package` consumes (it renames `web-dist` away, runs the binary from `/tmp`,
      and restores the directory in a `finally`).
- [ ] Create `.github/workflows/ci.yml` with exactly this shape (the regexes in
      `test/verify-gate.test.ts` below are written against it):

      ```yaml
      name: verify
      on:
        push:
          branches: ['**']
        pull_request:
      jobs:
        verify:
          runs-on: ubuntu-latest
          steps:
            - uses: actions/checkout@v4
            - uses: oven-sh/setup-bun@v2
              with:
                bun-version: 1.3.11
            - run: bun install --frozen-lockfile
            - run: bun run verify
      ```

- [ ] Do **not** add a bun-version matrix, a second OS, a lint step, coverage upload, or a
      release job. One job, one command. The pin `1.3.11` must equal the floor in
      `package.json`'s `engines.bun` (`>=1.3.11`); the test below enforces that.
- [ ] Record in the ADR that CI needs nothing else from the runner: `ubuntu-latest` ships
      git at `/usr/bin/git`, which is the only PATH entry
      `test/fixtures/gitrepo.ts`'s `CLEAN_ENV` exposes (`PATH: '/usr/bin:/bin'`), and
      that fixture's `makeRepo()` supplies its own committer identity inline
      (`-c user.email=t@t -c user.name=t`), so no global
      git config is required. `test/actions.test.ts` uses a fake launcher standing in for
      `systemd-run`, so no user D-Bus is required either.
- [ ] Create `test/verify-gate.test.ts` with the four tests specified under **Tests**. It
      reads `package.json` and `.github/workflows/ci.yml` by relative path; `bun test` runs
      with the repo root as cwd (`test/rungit.test.ts`'s existing `walk('src')` relies on
      the same thing).
- [ ] Close carry-forward P4. In `test/rungit.test.ts`, inside the test named
      `'a symlink standing in for the hooks directory is refused, not followed'`, add after
      its two existing `not.toBe` assertions:
      `expect(existsSync(used)).toBe(true)` and
      `expect(statSync(used).mode & 0o022).toBe(0)`.
      Rationale to put in the commit message: both existing assertions pass **vacuously**
      if the probe child fails to start, because `hooksDirUnder()` then returns an empty
      string, which is neither the symlink path nor the elsewhere path. Its sibling test
      (`'a group- or world-writable hooks directory is refused, not used'`) already carries
      the existence guard; this makes the pair symmetric. `existsSync` and `statSync` are
      already in scope in this file — add no imports unless the compiler says otherwise.
- [ ] Run `bun run verify` end to end. Record the wall time of each stage. Reference
      numbers measured on this machine at `3a0491e` (bun 1.3.11, before Tasks 1–9, so the
      implementer's numbers will be larger — record the real ones, do not copy these):
      `build` 1.44s, `assert:package` 0.16s, `test` 1.43s (118 tests), `typecheck` 2.76s;
      compiled binary 99,537,944 bytes.
- [ ] Write `docs/decisions/0003-verify-gate-and-dev-loop.md` covering, in this order:
      **(a)** the verify chain and why it exists — `assert:package` is defined in
      `package.json`'s `scripts` and, before this task, had no caller anywhere: no `pretest`, no
      `prepublish`, and no `.github/` directory existed at all, so every packaging demand
      (embedded-asset count vs dist count, `/` and both hashed assets returning 200 with
      the right content-type, the JS not being a development build, the `execLine`
      `$bunfs` check, and the Tailwind `p-4` canary at `scripts/assert-package.ts:108-113`)
      was unenforced and would have surfaced at release;
      **(b)** the CI pin and the test that keeps it equal to `engines.bun`;
      **(c)** the dev loop (next step);
      **(d)** the gate-widening prohibition (step after that);
      **(e)** the residual: this repo has **no git remote** (`git remote -v` is empty at
      `3a0491e`, branch `main`, never pushed), so the workflow does not execute until a
      remote exists. `test/verify-gate.test.ts` is what keeps the file honest in the
      meantime — treat the workflow as unexecuted-but-pinned, not as proven CI;
      **(f)** carry-forward P4 recorded as closed.
- [ ] Document the dev loop in the ADR, as a command and a measurement:
      `bun run build:web && bun run gen:assets && bun run src/index.ts serve`
      Measured 2026-09-14 at `3a0491e`: `build:web && gen:assets` completes in ~1.5s wall,
      and a plain source run (no `--compile`) then serves `GET /` as **200
      `text/html;charset=utf-8`** from the freshly built vite output — verified by curl
      against `127.0.0.1:7399` with the `Host` header the gate requires. This works because
      `src/server/routes.ts`'s `loadAssets()` imports the generated manifest **dynamically**
      and maps each entry to `Bun.file(diskPath)`; under a source run those disk paths are
      the real `web-dist/` files, so a re-run of `build:web && gen:assets` is picked up by
      restarting the server, with no `--compile` step. State the consequence plainly: UI
      iteration costs a ~1.5s rebuild, not a 99.5MB binary compile. Warn that the generated
      manifest is gitignored, so `gen:assets` must be re-run after every
      `build:web`, and that `loadAssets()` swallows a missing manifest and serves nothing
      rather than crashing — a blank page with 200s on `/api/*` is what "you forgot
      `gen:assets`" looks like.
- [ ] Record in the ADR, as a standing prohibition: **widening `src/server/gate.ts`'s
      origin allowlist (or its `Sec-Fetch-Site` check) to accommodate a Vite dev server on
      port 5173 is forbidden.** Two independent measurements, taken 2026-09-14 against a
      running source-run server on `127.0.0.1:7399`:
      `Origin: http://localhost:5173` with a correct `Host` → **403** (rejected by the
      origin allowlist, `gate.ts:18-22`); and `Sec-Fetch-Site: same-site` with a correct
      `Host` and **no** `Origin` → **403** (rejected by `gate.ts:33-36`). A browser sends
      `Sec-Fetch-Site: same-site` on any cross-**port** fetch, so both checks would have to
      be weakened, not one. `gate.ts:3-8` forbids the bypass by name, citing MCP Inspector
      **CVE-2025-49596** and Nuxt Devtools **CVE-2024-23657** — both compromised through
      exactly this convenience. The supported loop is the ~1.5s rebuild above. Also record
      that `scripts/assert-package.ts` uses `fetch`, never a browser, so it can
      structurally never observe a CSP violation — which is why ADR 0002 Ruling D (Tailwind
      classes only, no `style={{}}` props) is a ruling rather than a check.
- [ ] Run the mutation pass (procedure and list under **Tests → Mutations**) and write
      `docs/superpowers/plans/2026-09-14-plan-2-mutation-record.md` as you go, not
      afterwards from memory.
- [ ] Write `docs/superpowers/plans/2026-09-14-plan-3-carry-forward.md` with four sections:
      **1. The TLS spike, scheduled first.** One standalone measurement, ~30 minutes,
      before any mail work: a real TLS handshake to `imap.gmail.com:993` on bun 1.3.11,
      with and without `resolveDualStack`, asserting a non-empty peer certificate, with the
      connected address family recorded (the reference machine runs Mullvad with IPv6
      blocked, so "which family answered" is part of the result). Replace ADR 0001's
      "Not measured" section with the outcome. Today `src/net/tls-connect.ts` is imported
      only by its own test, whose two cases inject their own `probe`, so no socket is ever
      opened and no certificate is inspected anywhere in the repo. If the handshake fails,
      `engines.bun` moves, which is a plan-shaping fact and the reason this goes first.
      **2. The secrets adapter's required shape** (§8.5 of the design spec, plus ADR
      0001:153-161): every `Bun.secrets` call wrapped in `Promise.race` with a timeout,
      never a bare try/catch — and ADR 0001:153-161 records that a raced-away call is
      **not** inert, it can still complete or fail later, so the adapter must neither
      assume cancellation nor leave a handler that writes state after the timeout has been
      reported; a 0600 file in a 0700 directory as the fallback; startup **refuses to run**
      if the secrets file is group- or world-readable; `credential store locked` is a
      distinct outcome from `not configured`, because a user service can start before the
      session unlocks the wallet; read lazily with retry, never eagerly. Note that
      `keyring ok` in ADR 0001 is machine-specific (GNOME Secret Service via libsecret on
      the reference machine) and is evidence for no other environment — the keyring is
      optional, never guaranteed.
      **3. The claude port's forbidden-export grep.** A test that greps the source tree and
      fails if any of `getAccessToken`, `refreshToken`, `writeBackCredentials`, `getGauges`
      appears in `src/`. Rationale, from §7.4: Atrium's use of Claude credentials is
      **read-only** — it never refreshes and never writes. Upstream's `getGauges` calls
      `getAccessToken` (tacodx/TacosPlugins `packages/core`, reported at `usage.mjs:157`;
      not verifiable from this repo), whose read-modify-write of
      `~/.claude/.credentials.json` rotates a refresh token the running Claude Code process
      also holds, forcing the user to re-authenticate. Pair it with §7.4's redaction test:
      nothing reaching the HTTP/WS layer may contain `accessToken`, `refreshToken`, or the
      raw payload (which carries spend, per-surface breakdowns, subscription type and
      rate-limit tier). Record the ordering ruling: **claude next, then obsidian. Not
      mail** — mail needs §8.5 and the unmeasured TLS.
      **4. Still open after Plan 2**, as pointers only, not re-argued: `show diff` (ADR
      0002 Ruling B), first run (`detect()` remains a required contract member with no
      caller), per-schedule keying of `last` in the scheduler, the spec's audit-log claim,
      and §8.5 itself.
- [ ] Final gate: `bun run verify` green, and `git status --porcelain` shows only the files
      this brief names.

**Tests:**

Four new cases in `test/verify-gate.test.ts`, plus one repaired case in
`test/rungit.test.ts`. All five must be able to fail; each one's killing mutation is named
under **Mutations**.

- `'verify chains build, the packaging assertion, the test run and typecheck, in that order'`
  — reads `package.json`, asserts `scripts.verify` is a string, splits it on `&&`, trims
  each stage, strips a leading `bun run `, and asserts the resulting array **deep-equals**
  `['build', 'assert:package', 'test', 'typecheck']`. Exact equality, not `toContain`: a
  missing stage and a reordered chain must both fail, and `build` preceding
  `assert:package` is the part that matters (the packaging assertion consumes `./atrium`
  and `./web-dist`, which `build` produces).
- `'every stage named in verify is a real script'` — asserts each of the four stage names
  is a key of `scripts` in the same `package.json`. This catches a stage renamed on one
  side only.
- `'CI runs the verify gate, not a bare test run'` — reads `.github/workflows/ci.yml` and
  asserts `/^\s*-\s*run:\s*bun run verify\s*$/m` matches. Assert the match is non-null
  explicitly; do not wrap the assertion in an `if`.
- `'CI pins bun to the engines floor'` — extracts the workflow pin with
  `/bun-version:\s*['"]?(\d+\.\d+\.\d+)['"]?/` and the floor from `engines.bun` with
  `/^>=\s*(\d+\.\d+\.\d+)$/`, asserts **both** matches are non-null (this is the
  anti-vacuity step — `scripts/assert-package.ts:84-92` records this project already
  shipping a gate that went vacuous when its regex stopped matching), then asserts the two
  captured versions are equal. Both are `1.3.11` today.
- `'a symlink standing in for the hooks directory is refused, not followed'`
  (`test/rungit.test.ts`, existing test, repaired) — now also asserts the returned
  directory **exists** and is not group- or world-writable, so the test cannot pass by the
  probe child failing to produce any output at all.

**Mutations**

*Procedure, and it is part of the deliverable.* Apply exactly **one** mutation at a time to
a clean tree. Commit (or at minimum `git add`) this task's new files first, so every file
is tracked and `git checkout -- <file>` can restore it. Run `bun test`. Record, verbatim,
the names of the tests that turned red and the `N pass, M fail` line. Revert with
`git checkout -- <file>`. Re-run `bun test` and
confirm green **before** applying the next. Never stack two mutations. Record every row in
`docs/superpowers/plans/2026-09-14-plan-2-mutation-record.md` as it happens.

*Blocking rule.* A mutation that turns **zero** tests red is a defect in this plan, not a
footnote. Fix it by adding or repairing the guarding assertion in the owning task's test
file, then re-run that mutation red-then-green and record it as "gap found and closed". Do
not weaken the mutation, do not delete the test, and do not record the row as passing.
Equally, a mutation that turns a *large* number of unrelated tests red is a finding worth
a sentence — record which tests, because a mutation that breaks everything proves nothing
about the specific guard it was written for.

For this task's own tests:

- Delete `bun run assert:package && ` from `scripts.verify` in `package.json` →
  `'verify chains build, the packaging assertion, the test run and typecheck, in that order'`
  goes red. Also swap `build` and `assert:package` in the chain → the same test goes red.
- Change `bun-version: 1.3.11` to `bun-version: latest` in `.github/workflows/ci.yml` →
  `'CI pins bun to the engines floor'` goes red (the version regex stops matching, and the
  explicit non-null assertion is what catches it rather than letting the check vanish).
- Change the workflow's final step to `run: bun test` → `'CI runs the verify gate, not a
  bare test run'` goes red.
- In `test/rungit.test.ts`'s `hooksDirUnder()` helper, point the generated probe script's
  import at a nonexistent module path so the child exits without printing → the repaired
  test `'a symlink standing in for the hooks directory is refused, not followed'` goes red
  on the new `existsSync` assertion, while both original `not.toBe` assertions still pass.
  That contrast **is** the P4 finding; record it in the mutation record.

Then re-run every mutation this plan introduced. Each row below gives the exact edit; the
guarding test's name is set by the owning task's brief, so record the observed name
verbatim rather than assuming one. Where an existing Plan 1 test is the guard, its exact
name is given.

1. **Bearer gate, fail-closed direction (Task 4).** In `src/server/serve.ts`, force the
   bearer check in `fetch` to always take the `401` branch regardless of what
   `auth.verifyBearer(req)` returns. → Task 4's positive-path test (a handoff POSTed to
   `/api/session` returns a session token, and that token gets **200** from
   `GET /api/state`) goes red. Confirm the existing Plan 1 test `'a token-gated route
   rejects a request with no bearer'` (`test/serve.test.ts`) stays **green** — it must,
   and a mutation that reds both directions is not the check being made here.
2. **WS auth flag, fail-closed direction (Task 4).** In `src/server/serve.ts`'s
   `websocket.message` handler, after `auth.authenticateSocket(...)` returns true, set the
   socket's `authed` state to `false` instead of `true`, changing nothing else. → Task 4's
   test that a socket sending the correct first frame stays open goes red, and so does
   Task 6's `ready`-then-`snapshot` test. Confirm `'websocket: zero state before auth, and
   close(1008) on a bad first frame'` (`test/serve.test.ts`) stays green.
3. **Bearer bypass, dangerous direction — re-measure (Task 4).** Force the bearer check to
   never return 401. → Measured at `3a0491e` against the 118-test suite, this already
   fails 1 test. It must still fail at least that test after Task 4. This row exists so the
   record shows all four auth directions, and so a Task 4 regression that unpins the
   dangerous direction while adding the happy path is caught. **Do not** describe the
   pre-Task-4 state as "unfalsifiable" anywhere in the record: both dangerous directions
   were already pinned; only the fail-closed directions (rows 1 and 2) were not, and that
   is an availability-regression gap, not an open security hole.
4. **Socket auth bypass, dangerous direction — re-measure (Task 4).** Remove the socket
   auth check so any first frame authenticates. → Measured at `3a0491e`, already fails 1
   test; must still fail after Task 4.
5. **`ws.subscribe` moved into `open()` (Task 6).** In `src/server/serve.ts`, move the
   `ws.subscribe(STATE_TOPIC)` call out of the successful-auth branch and into
   `websocket.open(ws)`. → Task 6's test that an authenticating socket received **zero**
   frames before sending its auth frame goes red. This is §10's mandatory WebSocket-auth-gate
   check — "a socket that authenticates must have received zero state before its auth
   frame" — and the mutation is the natural, harmless-looking place to put the call.
6. **`toClient` removed from the scheduler write path (Task 5).** In `src/core/scheduler.ts`'s
   `runNow`, write the raw fetched `data` into `last` instead of the computed wire value.
   (One edit reaches both wires: the listener payload is `snapshot()[providerId]`, whose
   `data` is read out of `last`.) → **Two** named tests go red, in two different files, and
   both must: Task 5's `'GET /api/state serves the redacted client value, not the provider
   Data'` (`test/routes.test.ts` — the sentinel appears in the serialized body) **and**
   Task 6's test 18, `'a Data sentinel never reaches a WS update frame'`
   (`test/ws-protocol.test.ts` — the sentinel appears in the frame text). Task 5's
   `'the client value is the redacted one …'` goes red as well. If the WS half stays green,
   redaction is being applied somewhere other than the single required location — record
   that as a finding.
7. **Redaction moved above `previousByKey` (Task 5).** In `src/core/scheduler.ts`, store
   the wire value into `previousByKey` instead of the raw value. → The existing Plan 1 test
   `'previous is scoped per schedule — a two-schedule provider never sees the other
   schedule's previous'` (`test/contract.test.ts`) goes red. If it does **not**, Task 5's
   fixture `toClient` is an identity function and the sentinel test is vacuous — that is a
   blocking gap, fix the fixture so `toClient` genuinely transforms.
8. **Config raw instead of parsed (Task 3).** In `src/core/scheduler.ts`, serve the raw
   per-provider config record to `fetch` and to `configFor` instead of the value parsed at
   scheduler construction. → Task 3's "fetch receives the PARSED value" test goes red. If
   it does not, the test fixture's `parse` is an identity (`{parse: x => x}`, which is what
   all three Plan 1 stubs are) and the property is undetectable by construction — blocking
   gap, make the fixture's parse transform. Confirm `'exposes the same per-provider config
   the fetch side receives'` (`test/contract.test.ts`, the `.toBe` identity assertion)
   stays green.
9. **Teardown order (Task 2's code, Task 6's test).** In `src/server/serve.ts`'s
   `server.stop` wrapper, call `originalStop()` **before** `scheduler.stop()`. → **Task 6's**
   test 17, `'a run still in flight when stop() is called publishes nothing to a socket that
   was open'` (`test/ws-protocol.test.ts`), goes red. The guard lives in Task 2's code but is
   not observable from Task 2 — both calls are synchronous and land in the same tick, so
   nothing can see the difference until Task 6 builds the `onUpdate → server.publish` wire.
   Task 2 records that honestly and does not claim a test; do not go looking for one there.
   The post-await abort guard in `runNow` is the only thing suppressing a notify after the
   server has closed, and it only helps if the scheduler is stopped first.
10. **Container rule reverted (Task 7).** Change the discovery classifier back to dropping
    nested repos. → The §10 container-regression fixture test goes red: the parent with
    tracked files whose `.gitignore` lists three child repos, where **all four** must
    surface. Mandatory per the spec.
11. **Classifier row order (Task 7).** Move the `check-ignore` (vendored) row above the
    worktree row in the five-row first-match-wins classifier. → The linked-worktree
    discovery test goes red; every worktree surfaces as a project.
12. **`timedOut` deleted (Tasks 1 and 7).** Remove the `timedOut` field from `GitResult` in
    `src/core/rungit.ts` and the `err.killed`/`err.signal` derivation that sets it. → Task
    1's timeout test (`timedOut === true` while `code === 1`) goes red, and so does Task
    7's genuinely-timing-out fixture test. Without the field, a timed-out call is
    byte-identical to a real `check-ignore -q --` miss, which the classifier reads as "not
    ignored" and therefore drops the repo.
13. **Empty-repo detection (Task 8), in the two halves that actually bite.** Run them
    separately: **(a)** delete the `parsed.initial` row from `classifyState`, changing
    nothing else → Task 8's empty-repo test goes red (the repo's `branchHead` is `main`, so
    it falls through to `clean`). **(b)** make a non-zero `log` exit mark the repo
    unavailable → the same test goes red on `metaStatus`. Do **not** run the originally
    recorded single mutation ("derive emptiness from `log`'s exit code *and* drop the
    `parsed.initial` row"): in an empty repo `log` exits 128 while `status` exits 0, so the
    two halves cancel and reproduce exactly the answer the test asserts, turning **zero**
    tests red. Task 8's brief carries this as M1/M1b for the same reason.
14. **Exec target validation removed (Task 8).** Delete the check that validates an exec
    action's target path against the discovered repo table before building argv. → Task 8's
    test that an action invoked with an **undiscovered** path is rejected goes red. This is
    the one gap present in none of the competing proposals: the `exec` arm of `Action` has
    no `payloadSchema`, the action route forwards `req.json()` straight through, and
    `buildArgv` validates only the argv it is handed back — so without this check the whole
    discovery-and-classifier apparatus is bypassed by any path a client sends.
15. **`unavailable` collapsed into `empty` (Task 9).** In `web/src/panes/ReposPane.tsx`,
    render the `unavailable` state the same as the `empty` state. → Task 9's
    three-distinct-states test goes red. Mandatory: the `unavailable`-vs-zero branch is
    named in §10's list of required mutation checks.
16. **"Needs attention" as OR (Task 9).** Change the needs-attention predicate from
    staleness past `repos.staleDays` **and** uncommitted changes to an OR of the two. →
    Task 9's test that a stale but clean repo does **not** appear in the group goes red.
    An old clean repo is finished, not rotting.

Close the record with a one-line verdict: total mutations run, how many turned a named test
red on the first attempt, how many exposed a gap that had to be closed, and confirmation
that the tree is green and unmutated at the end.

**Out of scope for this task:**

- **Carry-forward P3** (the test suite littering `/tmp`, the missing `afterAll`). Task 7
  owns it. Do not add cleanup hooks here.
- **Carry-forward P2** (`typecheck` failing on a fresh clone). Task 2 owns it and has
  already fixed it. Do not edit `scripts.typecheck`, and do not re-derive its contents.
- Editing `engines.bun`, or changing any dependency version.
- A bun-version matrix, a second runner OS, a lint step, coverage, a release/publish
  workflow, a Dependabot config, branch-protection settings, or a second workflow file.
- `pretest`, `prepare`, `prepublish` or any other lifecycle hook. One `verify` entry point.
- Widening `src/server/gate.ts`, adding a `--dev` flag, a dev-server proxy, or a CORS
  allowance of any kind. Recording the prohibition is the deliverable; implementing an
  exception is forbidden.
- Taking the TLS measurement, writing the `Bun.secrets` adapter, touching
  `src/net/tls-connect.ts`, or starting the claude provider. This task records their
  required *shape* only.
- Editing `test/rungit.test.ts`'s `GIT_LITERAL` regex or any of its four tripwire tests
  (ADR 0002 Ruling A), and editing the two tests carry-forward §3 names as unable to fail
  (`'the hook-free directory is 0700 and owned by us'` in `test/rungit.test.ts`,
  `'neither spawn failing throws into the caller'` in `test/actions.test.ts`) — they are
  known smoke tests, and repairing them is a separate decision.
- Adding a README, a threat-model document, or a CONTRIBUTING file.
- Creating a git remote, pushing, tagging, or publishing. The workflow ships unexecuted.
- "Fixing" a mutation that fails to go red by softening the mutation, skipping the row, or
  deleting the test. Add the missing assertion in the owning test file instead.
- Adding new providers, panes, wire frames, routes, or config keys of any kind.

---

