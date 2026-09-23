# Plan 2 → Plan 3 carry-forward

Everything Plan 2 (`feat/first-light`) knowingly left open, and every item it carried, reconciled. Written by
Task 10c, the last unit of Plan 2, at `4f7956c` plus the three text corrections that precede this document.
Corrected on 2026-09-23 after review (18 findings, all documentation accuracy), with every line citation the
review named re-derived against `91b2147`, the tree that holds ADR 0003 (e)'s addendum. Updated the same day after
the TLS spike (Plan 3 units 0a and 0b): every ADR 0001 citation, and the ADR 0003 and spec citations that `9c91b00`'s
inserted lines moved, is re-derived against `9c91b00`, the commit that holds ADR 0001's TLS measurement.

Plan 2's working notes (the ledger, briefs and reports under `.superpowers/sdd/`) are untracked by design: that
directory's own `.gitignore` is `*`. Citations below of the form `ledger:NNN` point into
`.superpowers/sdd/2026-09-14-plan-2-first-light/progress.md`, and `task-N-report.md:NNN` into the same directory.
They will not survive a clone. This document and the tracked plan addenda are the durable record, so every
disposition below carries its own evidence rather than a pointer to scratch.

Sections 1-3 are the Plan 3 work that is already shaped. Section 4 lists what is still open, as pointers only.
The appendix is the reconciliation: one row per item carried during Plan 2, with its disposition.

---

## 1. The TLS spike, scheduled first

One standalone measurement, about 30 minutes, before any mail work: a real TLS handshake to `imap.gmail.com:993` on
bun 1.3.11, with and without `resolveDualStack`, asserting a non-empty peer certificate, with the connected address
family recorded. The reference machine runs Mullvad with IPv6 blocked (`mullvad tunnel get`: `IPv6: off`), so
"which family answered" is part of the result, not a detail. Done 2026-09-23: ADR 0001's "Not measured" section is
now "TLS — not measured at adoption; measured 2026-09-23" (`docs/decisions/0001-bun-version.md:44-215` at `9c91b00`),
retitled and closed by a **Measurement (2026-09-23)** block (`:90-215`); every original sentence stays under a dated
bracket rather than being replaced.

Until unit 0a, `src/net/tls-connect.ts` was imported only by its own test (`test/tls-helper.test.ts:2`), whose two
cases inject their own `probe`, so no socket was ever opened and no certificate was inspected anywhere in the repo.
The module is now also imported by the live test (`test/tls-live.test.ts:5`) and the spike script
(`scripts/tls-spike.ts:28`), with no production call site until mail. The module's real probe is a plain `node:net`
connect. Had the handshake failed, `engines.bun` (`>=1.3.11`) would have moved, which is a plan-shaping fact and the
reason this went first.

**ADR 0001 was wrong about when this happens.** `0001-bun-version.md:62` says "there is none yet — mail is Plan 2",
and `:78` says "Taking the live handshake belongs to Plan 2's mail task". Plan 2 deferred the handshake for the
whole plan (plan `:362-363`, `:5545-5547`) and shipped no mail provider. Both lines now carry a dated correction
(`0001:63-68`, `:82-85`, commit `9c91b00`); the sentences themselves stay.

**Outcome (measured 2026-09-23; the record is ADR 0001's "TLS — not measured at adoption; measured 2026-09-23",
`0001:90-215`).** bun 1.3.11 completes the handshake through `resolveDualStack` every time, over IPv4, with an
authorized 17-key certificate for the host. The bare `tls.connect` fails on this network with
`ERR_TLS_CERT_ALTNAME_INVALID` and a null peer certificate at ~255-280 ms: when the 250 ms attempt timer fires while
the first address (an AAAA that Mullvad with IPv6 off refuses at ~1 s) is still pending, bun raises on that socket
and never tries the next address; node 22 is unaffected. The floor stays at `>=1.3.11` and now rests on three of
three load-bearing questions; the workaround is mandatory on this version wherever the first address fails slower
than 250 ms. Pinned by `test/tls-live.test.ts` under `ATRIUM_LIVE_TLS=1`: "resolveDualStack then tls.connect to
imap.gmail.com:993 yields a non-empty, authorized peer certificate for the host" (spec §7.3's integration test) and
"bug pin: on this bun a bare tls.connect whose first address is still pending at the 250 ms attempt timer fails with
ERR_TLS_CERT_ALTNAME_INVALID and a null peer certificate — retire resolveDualStack when this goes red on a newer
bun" (its retirement trigger). Without the variable both skip, and `test/verify-gate.test.ts`'s "the suite skips
exactly the two opt-in live TLS tests, and that file exists" pins that they are the suite's only skips (ADR 0003 (b)
addendum, `0003:161-164`). `scripts/tls-spike.ts` regenerates the ADR's table under either runtime. Retirement
procedure (`0001:181-194`): the bug pin red on bun X ⇒ raise `engines.bun` to X, move `ci.yml`'s `bun-version` and
the verify-gate literals with it, delete `resolveDualStack`; the handshake test keeps guarding the certificate. One
decision is left to the mail task: the workaround's probe is serial and costs ~2.1 s per connect here (both AAAA
refusals before the first A answers) ahead of a ~115 ms handshake — a parallel probe or a remembered winner would
remove it (`0001:161-167`; appendix A20). Commits: `720b9ff`, `1c2cac6`, `fdf7cff` (unit 0a), `9c91b00` (the record).

## 2. The secrets adapter's required shape

From §8.5 of the design spec (`docs/superpowers/specs/2026-09-13-atrium-design.md:446-456`) plus ADR 0001:313-321.
No adapter exists yet: nothing under `src/`, `scripts/` or `test/` calls `Bun.secrets`.

- Every `Bun.secrets` call is wrapped in `Promise.race` with a timeout, never a bare try/catch. ADR 0001:313-321
  records that a raced-away call is **not** inert: it can still complete or fail later. So the adapter must
  neither assume cancellation nor leave a handler that writes state after the timeout has been reported.
- The fallback is a 0600 file in a 0700 directory.
- Startup **refuses to run** if the secrets file is group- or world-readable.
- `credential store locked` is a distinct outcome from `not configured`, because a user service can start before
  the session unlocks the wallet.
- Read lazily, with retry. Never eagerly.

`keyring ok` in ADR 0001 is machine-specific evidence and says nothing about any other environment: the keyring
is optional, never guaranteed. **Correction to ADR 0001 (`:30-31`, `:315-316`) and to the plan's wording
(`:5335-5336`):** on the reference machine the keyring is the freedesktop **Secret Service API via libsecret,
served by KDE's ksecretd/KWallet — not GNOME**. Measured: `busctl --user status org.freedesktop.secrets` names
`/usr/bin/ksecretd` (package `kf6-kwallet`), `gnome-keyring` is not installed, and the session is KDE Plasma on
Wayland. Spec §8.5 already says "libsecret/KWallet" (`spec:449-450`). ADR 0001 is not edited here. [2026-09-23: ADR
0001 now carries this as dated brackets beside both lines (`0001:32-38`, `:322-327`, commit `9c91b00`); the plan's
`:5335-5336` still says GNOME.]

ADR 0001:314 assigns the build to "Plan 4's credential-store task". That numbering predates the current plans; the
adapter is owed by whichever plan first needs a stored credential, which under section 3's ordering is not
Plan 3's first provider. [2026-09-23: recorded beside that line in ADR 0001 as a dated bracket (`0001:328-330`).]

## 3. The claude port's forbidden-export grep, the redaction test, and the ordering

**The grep.** A test that greps the source tree and fails if any of `getAccessToken`, `refreshToken`,
`writeBackCredentials`, `getGauges` appears in `src/`. None does today, and no such test exists yet.

Rationale, from §7.4 (`spec:365`): Atrium's use of Claude credentials is **read-only** — it never refreshes and
never writes. Upstream's `getGauges` calls `getAccessToken`, whose read-modify-write of
`~/.claude/.credentials.json` rotates a refresh token the running Claude Code process also holds, forcing the user
to re-authenticate. The plan called this "not verifiable from this repo". It is not verifiable from *atrium*, but a
local checkout of tacodx/TacosPlugins at `27d15ae` confirms it: `packages/core/usage.mjs:118` exports `getGauges`,
`:157` awaits `getAccessToken`, and `auth.mjs:107` defines `getAccessToken`, which calls `refreshToken` (`:116`)
and `writeBackCredentials` (`:119`).

**The redaction test**, paired with it (`spec:393-395`): nothing reaching the HTTP/WS layer may contain
`accessToken`, `refreshToken`, or the raw payload (which carries spend, per-surface breakdowns, subscription type
and rate-limit tier).

**The ordering ruling: claude next, then obsidian. Not mail** — mail needs §8.5 and the probe-cost decision (§1).
This rests
on the scoping document's default (`2026-09-14-plan-2-scoping.md:243`, open question 4) and the plan
(`:5348-5349`), not on an ADR.

**Precondition on that ordering — ADR 0002 Ruling F's gate.** The plan's own text for this section omitted it; the
Task 10a pre-flight rated the omission BLOCKING. Ruling F (`docs/decisions/0002-slice-rulings.md:476-526`) keeps
`ScheduleHealth.lastErrorMessage` as raw exception text for Plan 2 only, and sets a hard precondition on Plan 3:

> *no provider that handles a credential may be registered until this channel is sanitised at `recordFailure`.*
> Plan 2's only provider is `repos`, which shells out to git and holds no secret. The claude provider does hold
> one, and an exception from it would put an API key on this exact channel. Task 10 writes this into the Plan 3
> carry-forward as a gate.
> — ADR 0002, Ruling F, `:507-510`

So, as a gate on the ordering: **no provider that holds a credential — claude included — may be registered until
`lastErrorMessage` is sanitised at `recordFailure` (`src/core/scheduler.ts:120-124`), and that fix carries its own
mutation coverage** (Ruling F `:521-524`). Today `recordFailure` stores `(err as Error)?.message ?? String(err)`
verbatim (`scheduler.ts:123`). It has two callers, the fetch failure (`:231`) and the `watch()` install wrapper
(`:287`). The string bypasses `toClient` and reaches `/api/state`, every `onUpdate` envelope, and both WS frame
kinds, and the pane renders it. Ruling F's revisit trigger (`:526`) — a second provider, and before any provider
that touches a secret — fires at exactly this point in Plan 3.

## 4. Still open after Plan 2

Pointers only, not re-argued. Appendix rows name the section item they belong to.

**4.1 `show diff`.** The fourth §7.1 action is deferred: all three legal shapes are blocked, and a result channel
on `call`/`exec` is a contract change that deserves its own plan (ADR 0002 Ruling B, `:103-147`). Only
`open-editor`, `open-terminal` and `open-claude` ship (`src/providers/repos/actions.ts:73-75`). The same result
channel is what settles Ruling E's no-bus silent no-op, which rides on it (`0002:471-474`; appendix A6).

**4.2 First run.** `detect()` remains a required contract member (`src/core/contract.ts:39`) with no caller. The
repos stub returns `nothing-to-detect` (`src/providers/repos/index.ts:843-845`). A future config writer must be
built against the frozen, shallow, non-live config ruling (plan `:1082-1088`).

**4.3 Per-schedule keying of `last`.** The scheduler keys `last` by provider id alone (`src/core/scheduler.ts:24`).
A second multi-schedule provider forces per-schedule keying. Until then every schedule branch returns the full
merged `Data`, pinned by "the metadata branch returns the full merged Data, not a delta" and "the metadata schedule
returns the full repo list, not a fragment".

**4.4 An audit log at `dispatch()`.** The spec's audit-log *claim* is already withdrawn (`spec:166-169`, commit
`8332237`; the text was reflowed by `86d59b9`). What stays open is only the unplanned option of building one at
`dispatch()` in `src/core/actions.ts`.

**4.5 §8.5 itself** — the secrets adapter of section 2, and with it mail.

**4.6 Server hardening, never picked up after Task 4/5.**
- `POST /api/session` parses an unbounded body before any auth (`src/server/serve.ts:180`; 64 MB took RSS from
  191 to 313 MB). The WS side is capped at 1 MiB; HTTP has no `maxRequestBodySize`.
- The `req.method === 'POST'` guard on `/api/session` is not pinned on its own.
- The `/api/session` 401 is claimed byte-identical to the bearer 401 (`serve.ts:185`); no test compares them.
- Logging a *partial* credential (`tok.slice(0, 8)`) passes the containment assertions. An empty-stderr assertion on
  the happy path would close it.
- The CSP (`serve.ts:36-42`) has no `base-uri` or `form-action`; neither falls back to `default-src`.
- The server logs no requests, so a rejected action leaves no server-side evidence.
- `POST /api/actions`' 400 serializes a provider-authored `e.message`; the comment at `src/server/routes.ts:77-80`
  ("echoes only the ids") is true only for the two lookup errors.
- A circular `toClient` value breaks `/api/state` (`routes.ts:66`, bare `Response.json`) until the next successful
  run. The WS half is handled; the HTTP half is not, and no ruling covers it.
- `RouteCtx.snapshot()` is still `Record<string, unknown>` (`routes.ts:6`).

**4.7 The handoff and `atrium open`.**
- Launching a browser from `atrium open` is left to a later plan. When it lands, the boot-handoff TTL ruling must be
  re-taken (ADR 0002 `:352-366`); `xdg-open "$(atrium open --print-url)"` already defeats its premise today.
- The `BOOT_HANDOFF_TTL_MS` comment (`serve.ts:59-71`) and `src/index.ts:85-86` state the TTL premise with no
  pointer to that revisit trigger.
- A stale `handoff.json`/`endpoint.json` from a crashed instance prints a well-formed URL that silently fails; the
  pid-liveness check belongs to a future `atrium open`/`doctor` (`src/core/paths.ts:37-39`).
- Two instances overwrite each other's endpoint and handoff files (`serve.ts:285-287`).
- Re-opening the handoff URL in an already-loaded atrium tab does not re-run `acquireToken`: a fragment-only
  navigation never reloads the document and `web/src` has no `hashchange`/`popstate` handling, so the pane shows
  "Not signed in" until a manual reload (ledger:1143-1148; appendix J35).

**4.8 Scheduler and wire.**
- A `watch()` that throws at install is recorded but fires no `onUpdate` (`scheduler.ts:267-288`), so a connected
  client learns of it only at its next snapshot. Asserted neither way.
- A `toClient` returning `undefined` yields an envelope whose `data` JSON drops, indistinguishable from "never
  succeeded" except through `lastSuccessAt`. Unreachable for `reposToClient`; no ruling.
- Ruling H's visible error surface is deferred; its revisit (`0002:613`, a second provider) pairs with Ruling F.

**4.9 The repos pane.**
- A discovered-but-not-yet-read repo renders `unavailable (unknown)`, a fault label
  (`web/src/panes/ReposPane.tsx:177`). Task 8 asked for "not read yet".
- A rejected action (a 400) reaches only `console.error` (`web/src/lib/api.ts:86-96`). No ADR text defers it;
  only a source comment says "deferred with it (ADR 0002 Rulings E and H)".
- Task 9 Lens A minors 3, 4, 6, 8, 9, 11, 12 and 14 (appendix J13-J20): heading suppression, the em-dash branch,
  the unit table, heading text, two row cells, the `provider failed` fallback, the unconditional `Recent` heading,
  and the unchecked `ReposWire` cast with no error boundary.
- `postReposAction`'s behaviour is pinned only as source text; a behavioural test needs a `SessionDeps`-style seam.
- `getState` is exported with no call site; `postAction` is reached only through `postReposAction`.
- One thrown gate/classify call shows two scan-note lines (amber and grey) for one event.
- §8.7 escaping in attribute position (a quote in a path rendered into `data-repo`) holds when measured, but no
  test covers it.

**4.10 Test gaps with no owner.**
- Two tests cannot fail and must not be counted as coverage: "the hook-free directory is 0700 and owned by us"
  (`test/rungit.test.ts:282`) and "neither spawn failing throws into the caller" (`test/actions.test.ts:298`).
- The hooks-directory uid refusal (`src/core/rungit.ts:40-41`) is unpinned; it needs a second local user.
- Task 4 I1's fix (every in-process `startServer` in tests passes `env`) has no regression pin: the structural
  spawn test excludes in-process calls by design (`test/verify-gate.test.ts:152-157`).
- Ruling I limit 6: a `.exe` suffix is not matched, and narrowing the suffix class is caught by no test.
- The `p-4` standing gate: Tailwind v4 reads class candidates from comments, so a comment spelling `p-4` would
  satisfy "main.tsx still contains the literal p-4 the packaging gate depends on" while re-masking the build
  gate. No count check exists and the repo-wide rule is written nowhere.
- `test/config.test.ts:625-636` still says `src/index.ts` "registers no providers until Task 9" and tells Task 9
  to replace it. The runtime half is pinned elsewhere; the comment is stale.
- The escape test's `JSON.stringify` path-absence assertions are dead ("a symlink pointing out of the scanned root
  never reaches Data", `test/repos-discovery.test.ts:167-168`): the gate drops the link under the walker's path,
  not the target's, so they are never reached and would not fire if they were. Its only load-bearing assertions
  are `repos`/`dropped`/`errors` `=== []`. Either repair them, for example by asserting on the walker-path form,
  or stop counting them (plan:5661-5664; appendix H12).
- The T4-T6 tests were never run under CPU oversubscription (only CPU starvation, 10a's `podman --cpus`). T6's WS
  protocol tests sleep 50-150 ms and are the most timing-sensitive in the suite (task-6-report.md:336-337,
  task-6-fix-report.md:120-122, task-5-report.md:291).

**4.11 Recorded text left stale, outside Task 10c's edit list.**
- ADR 0002 Rulings A and B cite `test/rungit.test.ts` lines that moved +9 (`:360`→`:369`, `:327-344`→`:336-353`,
  `:384`→`:393`, `:469`→`:478`, `:387`/`:471`→`:396`/`:480`, `:432`→`:441`); the plan's Task 8 addendum
  (`:5858-5860`) repeats some.
- ADR 0002 Ruling C cites `src/core/scheduler.ts:25` and `:63`; the lookups are now the `p.fetch(cfgFor(...))`
  call in `runNow` (`:195`) and the `configFor` accessor (`:310`).
- ADR 0002 Ruling G cites `main.tsx:48`; the call site is now `:50`.
- ADR 0001 `:30-31` and `:315-316` say GNOME (section 2), `:62`/`:78` assign the TLS handshake to Plan 2 (section 1)
  and `:276-279` say there is no CI: all five carry a dated bracket since `9c91b00` (`0001:32-38`, `:322-327`;
  `:63-68`, `:82-85`; `:280-285`), the sentences themselves unchanged. The plan's `:5335-5336` still says GNOME.
- Plan-2 documents whose ADR 0001 line citations `9c91b00`'s inserted lines made stale, none on this unit's edit
  list: `scoping:188` and plan `:5327-5328` cite `0001:153-161` (the keyring paragraph, now `:313-321`);
  `scoping:227` cites `0001:33-52` (Correction 1 through "guards.", now `:46-71`, with a bracket at `:63-68` inside
  it); `cf2:108-111` cites no line but says ADR 0001 "carries three dated corrections" and the TLS behaviour "was
  never measured" — there are four correction rounds now, and the measurement is taken. The same commit moved spec
  lines after `:324` by 8 (the §7.3 bracket sits at `:325-332`) and after `:644` by 11, so ADR 0002 Ruling D's note (`0002:237`) citing
  `spec:488-491` now points at `:496-499` (that note itself says to re-resolve by content). Three more Plan-2 sentences are overtaken by the measurement rather than by a moved line:
  plan `:363` ("ADR 0001's 'Not measured' section stands as written"), plan `:5319-5322` ("Replace ADR 0001's 'Not
  measured' section with the outcome. Today `src/net/tls-connect.ts` is imported only by its own test"), plan `:5349`
  ("mail needs §8.5 and the unmeasured TLS"), and scoping `:227`'s "empty peer certificate" / "'Not measured'" wording
  (ADR 0001, "TLS — not measured at adoption; measured 2026-09-23"). The plan and scoping documents are historical and
  are not edited.
- The plan cites `scripts/assert-package.ts:108-113` (`:3086`, `:4937`, `:5040`, `:5274`) for the Tailwind
  canary, which is now at `:166-178`; separately, its `:84-92` (`:5379`) is the "gate that went vacuous" note, not
  the canary, and that note is now at `:149-157` (ADR 0003's table, `0003:34`, maps it the same way).
- The plan (`:4935`) and the scoping document (`:134`) give the built stylesheet as 4188 bytes; it is
  `web-dist/assets/index-BvcZoZ8W.css` at 6139 bytes at `91b2147`, larger since Task 9's 6004.
- `src/core/contract.ts:87-89` and `spec:160-161` still call the `lastErrorMessage` channel an open item for
  Task 6 "or a plan-level ruling"; Ruling F is that ruling.
- `src/core/scheduler.ts:336-338` still suggests async config parsing could make guard B live; `494b1e8` ruled
  that the wrong lever.
- `src/core/config.ts:13-14` still says the spec mentions zod and that a later task reconciles it; spec §6 was
  reconciled in `8332237`/`86d59b9`, and the spec's only remaining zod mention is "no zod dependency" (`spec:106`) (appendix D12).

**4.12 Operational.**
- No `ci.yml` step has yet run on a GitHub runner. The push happened on 2026-09-21: `origin/feat/first-light` is
  `11ede55` (after `ci.yml`, `f35c2f9`), and it triggered run 35644633756, which GitHub refused to start on the
  account's billing state before any step ran. ADR 0003 (e)'s dated addendum records this (`0003:242-257`); the
  first real run's result is still owed there (`0003:240`), and unblocking it is the owner's action in GitHub's
  Billing & plans.
- The stale `/tmp/atrium-*` entries from before the P3 fix were removed out of band on 2026-09-21; the controller
  counted 0 on 2026-09-23. No longer open (appendix K15).
- Review findings counted but never enumerated (T4 fix review 20, T5 pre-flight 6, T6 review 7, T8 review 11,
  10a pre-flight 29 — the 67 − 38 that were never sent to the verifier panel, ledger:1297-1298): the workflow
  outputs were not saved, so their dispositions cannot be traced.
- Adjudication panels refuted nothing in 0/15, 0/38 and later runs; whether the refute-by-default framing needs
  hardening was never decided.

**4.13 Later providers.**
- Obsidian carries an unresolved ruling the reference machine forces: no `daily-notes.json`, no periodic-notes,
  `newFileLocation` `root`, zero date-named notes at the root and three in `00 Inbox` (scoping `:243`).
- §7.4's four-way status envelope (`ok | stale(age) | unavailable(reason) | unsupported-shape`) arrives with the
  claude provider.
- `resolveDualStack`'s doc comment was corrected in unit 0a (`720b9ff`; now `src/net/tls-connect.ts:24-50`, stating
  the measured bug, the environment, the cost, which test guards which half, and the retirement procedure). The
  module still has no production call site — the two opt-in live tests and the unwired spike script are not call
  sites — until the mail task registers the first one, and two decisions ride with it: the serial probe's ~2.1 s cost
  (appendix A20) and whether to report the bun 1.3.11 bug upstream (appendix A21).

---

## Appendix — Every item carried during Plan 2, and its disposition

**Dispositions.** **closed**: a commit plus the exact title of a test that exists at this document's commit and
pins it. **ruled**: a recorded ruling, or a text-only change that no test can pin. **open**: a pointer into
section 4. Every test title below was checked against `test/` and every commit against the object store at this
document's commit.

**Source abbreviations.** `ledger` = `.superpowers/sdd/2026-09-14-plan-2-first-light/progress.md` (untracked);
`task-*-report.md` and briefs are in the same untracked directory. `plan` =
`docs/superpowers/plans/2026-09-14-plan-2-first-light.md`; `cf2` = `…/2026-09-14-plan-2-carry-forward.md`;
`scoping` = `…/2026-09-14-plan-2-scoping.md`; `record` = `…/2026-09-14-plan-2-mutation-record.md`; `0001`, `0002`,
`0003` = the ADRs in `docs/decisions/`; `spec` = `docs/superpowers/specs/2026-09-13-atrium-design.md`.

### A. Carried in from Plan 1

| # | Item | First carried | Disposition | Evidence |
|---|---|---|---|---|
| A1 | I5: the registry could not be filled from outside `startServer`; `ServeConfig` needed `providers`/`config` | cf2:20-26 | closed | `e727696`. "a registered provider is actually polled by the running server"; "a duplicate provider id throws before the port binds" |
| A2 | I6: the scheduler was never started | cf2:27-30 | closed | `e727696`, `b7b892a`, `98edc07`. "server.stop() stops the scheduler"; "SIGTERM stops the scheduler, not just the endpoint file" |
| A3 | I7: the handoff was unwired, so no path issued a session token | cf2:31-33 | closed | `5c95ac1`, `f526288`. "a handoff redeemed at POST /api/session returns a session token that is accepted by /api/state". Browser launch is E35 |
| A4 | `snapshot()` had no redaction seam; T5 deferred the literal WS-frame sentinel test to T6 | cf2:34-35; ledger:845 | closed | `dd16426`, `3ae453f`, `17c1234`. "GET /api/state serves the redacted client value, not the provider Data"; "a Data sentinel never reaches a WS update frame". Only `Data` is redacted; see F6 |
| A5 | No CI; enforcement was local only (ADR 0001 Correction 2) | cf2:36 | closed | `f35c2f9`, `6281c07`, `8967542`. "CI runs the verify gate, not a bare test run"; "CI pins bun to the engines floor". First run is K7; `0001:276-279` carries a dated bracket since `9c91b00` (`:280-285`) |
| A6 | P1: systemd-run present with no user bus makes an exec action a silent no-op | cf2:40-45 | ruled | ADR 0002 Ruling E (`0002:429-474`, `5521e9b`), accepted for this slice; owed forward with §4.1 (`0002:471-474`: the next plan that touches `src/core/actions.ts` picks it up with Ruling B's result channel). Taken from source, not re-measured (task-8-report.md:261-263) |
| A7 | P2: `bun run typecheck` failed on a fresh clone (gen:assets on a gitignored `web-dist`) | cf2:46-50 | closed | `96631c5`. "--allow-empty writes a stub manifest so a fresh clone can typecheck"; "a missing web-dist fails with the friendly message, not an ENOENT stack trace" |
| A8 | P3: the suite littered `/tmp` (rungit, then actions); T7 and T10 each pointed at the other | cf2:51-56 | closed | `77439a9` (C6), `d7d2419`. "${file} leaves nothing behind in a fresh TMPDIR" (for `./test/rungit.test.ts`); "no test source hands mkdtemp a hard-coded /tmp prefix". The ledger's "list it as open" (ledger:1344-1345) is superseded. Host litter is K15 |
| A9 | P4: the symlink-hijack test passed vacuously if the probe child failed to start | cf2:57-60 | closed | `83b94dd`. "a symlink standing in for the hooks directory is refused, not followed" |
| A10 | cf2 §3: two tests cannot fail ("the hook-free directory is 0700 and owned by us"; "neither spawn failing throws into the caller") | cf2:62-72 | open | §4.10. Unrepaired at `test/rungit.test.ts:282`, `test/actions.test.ts:298`; plan:5548-5551 made repair a separate decision nobody took |
| A11 | cf2 §3: "resolveGit searches the PATH it is given" stays green under the hardcoded-PATH mutation | cf2:74-75 | ruled | A warning, not a pin; the test is unchanged at `test/rungit.test.ts:208` |
| A12 | cf2 §4: `resolveGit()` runs a PATH scan on every `runGit` call | cf2:90-92 | ruled | Measured and accepted in `3cf9b99` (25 calls, 12.5 ms at concurrency 8; plan:5782-5784). `rungit.ts` deliberately untouched |
| A13 | cf2 §4: the hooks-dir ownership check's uid refusal is unpinned | cf2:93-94 | open | §4.10. `src/core/rungit.ts:40-41` checks `st.uid`; no test makes a wrong-uid directory |
| A14 | cf2 §4: `--no-optional-locks` is a runGit prefix global and never supplied from a call site | cf2:95-97 | closed | `049e85e`. "the metadata argv is exactly the three declared shapes, with no caller-supplied --no-optional-locks"; "runs the git it resolved from PATH, with --no-optional-locks before the subcommand" |
| A15 | M8: auth's "wrong scheme" case did not exist although the test title names it | cf2:98-99 | closed | `c693062`. "rejects a missing header, a wrong scheme, and a wrong token" |
| A16 | The TLS measurement was never taken; ADR 0001 `:62`/`:78` assign it to Plan 2 | cf2:108-111; 0001:46-80 | closed | `720b9ff`, `1c2cac6`, `fdf7cff` (unit 0a), `9c91b00` (ADR 0001's record). "resolveDualStack then tls.connect to imap.gmail.com:993 yields a non-empty, authorized peer certificate for the host". Measured 2026-09-23: the handshake completes through the workaround, over IPv4, on bun 1.3.11; the floor stays (§1). The two ADR lines carry dated corrections (`0001:63-68`, `:82-85`) |
| A17 | `src/net/tls-connect.ts` is dead code; `resolveDualStack`'s comment overstates its test | 0001:56-71 | ruled | The comment was corrected in unit 0a (`720b9ff`; now `src/net/tls-connect.ts:24-50`). The module stays dead until the mail task registers the first production call site — two opt-in live tests and an unwired spike script are not call sites (§4.13) |
| A18 | No git remote; this machine held the only copy | ledger:288 | ruled | Resolved out of band (ledger:479-482): `origin` is `github.com/tacodx/atrium`. An environment fact, so nothing can pin it |
| A19 | ADR 0001: a bun 1.4.x upgrade could retire `scripts/gen-assets.ts` once `--asset` is confirmed | 0001:244-247 | ruled | A revisit-on-upgrade trigger. `engines.bun` is still `>=1.3.11` |
| A20 | `resolveDualStack` probes the candidates serially with a 2 s-timeout plain TCP connect: ~2.1 s per connect here (both AAAA refusals at ~1 s each before the first A answers), ahead of a ~115 ms handshake | 0001:161-167 | open | §4.13. Owner: the mail task — a parallel probe or a remembered winner would remove it; acceptable for one connection per account at a 60 s poll (spec §7.3). Not changed by the spike |
| A21 | The bun 1.3.11 bug (attempt-timer expiry on a still-pending first address ⇒ `ERR_TLS_CERT_ALTNAME_INVALID`, null peer certificate, no next address) has no upstream report; oven-sh/bun#31950 is adjacent, not it | 0001:212-215 | open | §4.13. Owner: none; decide file-or-not. #41447 not examined |

### B. Task 1 (`runGit`, ADR 0002 Rulings A-D)

| # | Item | First carried | Disposition | Evidence |
|---|---|---|---|---|
| B1 | ADR 0002 Rulings A/B cite `test/rungit.test.ts` by line; re-verify after edits or stop citing | ledger:27-31 | open | §4.11. Stale by +9 at `4f7956c` (shifted by `83b94dd` and `77439a9`); no re-anchoring commit. Outside 10c D3 |
| B2 | A plausible wrong `timedOut` derivation (`err?.signal != null`) passed the covering test | ledger:32-34 | closed | `e22a287`. "a crashed git is NOT a timeout: killed by an external signal, same exit code, timedOut false"; record T1-M5/M5b RED |
| B3 | `timedOut` tripwire 2: a bun upgrade making maxBuffer report `killed` would read >16 MB repos as timed out; no maxBuffer test by ruling | ledger:54-58 | ruled | `53200bd`; `0002:309-312`, `src/core/rungit.ts:199-205`. Re-measure ADR row 5 on any bun bump |
| B4 | `timedOut` tripwire 1: an `AbortSignal` on runGit's execFile would make `killed` true on abort | 0002:307-308 | ruled | No `AbortSignal` in `rungit.ts`'s options; warned in its doc comment |
| B5 | Ruling B's `actions.ts`/`routes.ts` citations and its `ExecFileException` deprecation claim were unverified | ledger:61-63 | ruled | Re-verified at `4f7956c`: the source citations resolve, and `@types/node` 26.5.1 marks `ExecFileException` deprecated. Its test citations drifted (B1) |
| B6 | Spec §8.9's `connect-src` differs from the shipped CSP (which also allows `ws://localhost`) | ledger:36-37 | ruled | Recorded divergence at `0002:228-231`. Its stale spec and file citations are corrected by the Ruling D note appended in this task (`a0aa6fb`) |
| B7 | Ruling A: a quoted git literal trips the tripwire even in a comment | 0002:63-65 | ruled | Standing constraint, enforced by "no source file calls git outside runGit (tripwire, not a proof)" and "the real src/ tree is clean under all four layers" |
| B8 | Ruling D's citations of `src/server/serve.ts:11-17` and the `scripts/assert-package.ts` fetch lines are stale | task-10a-report.md:153-154 | ruled | Text-only: a dated old → new correction appended to Ruling D in `a0aa6fb` (`:36-42`; `:92`, `:140`, `:161`, `:184`; spec `:488-491`, which `9c91b00` moved to `:496-499`) |

### C. Task 2 (scheduler lifecycle and serve wiring)

| # | Item | First carried | Disposition | Evidence |
|---|---|---|---|---|
| C1 | Task 5's mutation table predated T2-T4 and had to be re-measured | ledger:14-15 | closed | `9075f82` (addendum measured on `f68a5d1`), replayed in `4f7956c`. "the client value is the redacted one — a Data sentinel reaches neither snapshot() nor an onUpdate listener" |
| C2 | `snapshot()`/`onUpdate` changed shape; the onUpdate payload was unpinned (three wrong implementations green) | ledger:110-112 | closed | `984e5d9`. "onUpdate carries the status envelope, and the record is current when it fires"; record T2-L/B/M RED |
| C3 | `cfg.config` reaching `createScheduler` was unpinned | ledger:194-195 | closed | `e35999b`. "a registered provider is actually polled by the running server"; record T2-G RED |
| C4 | The post-await generation guard was treated as unpinnable and its comment asserted a falsehood | ledger:144-154 | closed | `e91ecc9`. "a cancelled generation does not run its remaining runOnStart schedules"; record T2-S4 RED |
| C5 | Guard B (pre-`installSources`) is dead code kept as insurance; it needs its own test if an await ever lands before it | ledger:228-230 | ruled | Documented at `src/core/scheduler.ts:55-68`, `:327-336` (`494b1e8`); record survivors T2-B*, T2-S4c. Residual JSDoc `:336-338` in §4.11 |
| C6 | `scheduler.stop()` before `originalStop()` is not observable | ledger:155-157 | ruled | plan:919-924, `serve.ts:320-328`; survivor T2-HONESTY-1. The falsifiable half is pinned: "a run still in flight when stop() is called publishes nothing to a socket that was open" |
| C7 | The `.catch(() => {})` on `void scheduler.start()` is not pinned on its own | ledger:155-157 | ruled | plan:925-928; survivor T2-HONESTY-2, "no test is to be added" |
| C8 | A `watch()` that throws at install records a failure but never calls `notify()` | ledger:161-163 | open | §4.8. `scheduler.ts:267-288`; "a throwing watch() is recorded and start() still resolves" asserts the record only |
| C9 | The fixture's `toClient` existed only on the fixture; Task 5 owned making it a required member | ledger:159-161 | closed | `dd16426` (`contract.ts:91`). "a provider with no toClient fails the run instead of publishing raw Data" |
| C10 | `test/contract.test.ts` citations shifted +54; re-resolve by content | ledger:164-166 | ruled | A process caution consumed by T3-T6. The plan's pre-T2 numbers (e.g. plan:554, :4716 cite `:209`, now `:269`) are historical brief text, and 10c may not edit the plan beyond D3 |
| C11 | The exit probe passed vacuously under mutation V2 | ledger:199-200 | closed | `56ace86`. "a process with a registered provider exits after stop()" |
| C12 | The fixture's `setData()` was a silent no-op when `opts.fetch` was supplied | ledger:204-205 | closed | `5190249`. "the fixture seam: setData feeds fetch, setWire overrides toClient, and the default toClient is not identity" |
| C13 | The Task 2 report's §2-§8 test citations are stale by construction; do not cite | ledger:235-239 | ruled | Instruction at ledger:277; the report is untracked, so no tracked document inherits them |
| C14 | The interval-timer array is unreachable; timer count is observed only through proxies | ledger:243 | ruled | Accepted limitation (task-2-report.md:688-690), signed off at ledger:245-246. Recorded here so it survives a clone |
| C15 | `RouteCtx.snapshot()` is loosely typed as `Record<string, unknown>` | ledger:243 | open | §4.6. `src/server/routes.ts:6`; plan:957-959 and :2639 forbade T2/T5 from tightening it; nobody did |
| C16 | `.superpowers/sdd/` is gitignored, so ledger, briefs and reports are untracked | ledger:358-370 | ruled | ledger:1115-1116: "untracked working state by design — only docs/ is committed". Durable carries live in the plan addenda, the mutation record and this document |
| C17 | L2-F8: rungit tests create `$XDG_RUNTIME_DIR/atrium/nohooks` in the real runtime dir | ledger:740-741 | ruled | By design (`rungit.ts:27-31`, `stableHooksDir`); task-10a-report.md:144-147; `test/tmp-hygiene.test.ts:17-20` calls it "not litter" |

### D. Task 3 (config)

| # | Item | First carried | Disposition | Evidence |
|---|---|---|---|---|
| D1 | Task 3 touched `test/serve.test.ts` and `scripts/assert-package.ts` outside its brief | ledger:377-381 | ruled | Recorded in the Task 3 addendum (plan:1423-1428); T4-T6 are complete |
| D2 | NF2: `ConfigError`'s `this.name` is unpinned | ledger:390-392 | ruled | plan:1416-1419: deliberately not given a test; nothing reads `.name` |
| D3 | NF4: installSources mislabels the watch-threw string when `cfgFor` throws; hoisting is wrong | ledger:393-396 | ruled | Documented at `scheduler.ts:274-285` (`494b1e8`): "A mislabelled loud record beats a silent one" |
| D4 | ADR 0002 Ruling C's `scheduler.ts:25`/`:63` citations no longer resolve | ledger:399-401 | open | §4.11. Lookups now at `:195` and `:310`; outside 10c D3 |
| D5 | Task 5's acceptance sentence says three Provider factories; there are four | ledger:402 | ruled | plan:1429-1435 and the T5 addendum (plan:2513-2514): read "three" as four. All four carry `toClient` (`dd16426`) and record T5-A2 breaks all four at typecheck |
| D6 | `config: loadConfig()` threading in `src/index.ts` had no runtime observable until Task 9 | ledger:403-404 | closed | `c9863a3`, `a0daceb`. "the assembled server serves the fixture repos over an authenticated /api/state" (asserts `staleDays` 45 from a real config.json); record T3-M14 RED. The stale text tripwire is J21 |
| D7 | bun's `toEqual` is vacuous on `[undefined]` and ignores sparseness; assert lengths or use `toStrictEqual` | ledger:441-444 | ruled | Standing rule. The instance was fixed in `762b3a1` ("a provider with no config section is parsed from undefined, so its schema can supply defaults"); no `toEqual([undefined])` remains in `test/` |
| D8 | `scripts/assert-package.ts` is not run by `bun test`, so its env scoping can regress silently | task-3-report.md:1133-1135 | closed | `6281c07`, `c8dd615`. "every server spawn scopes HOME, XDG_RUNTIME_DIR and XDG_CONFIG_HOME to a temp dir"; record T3-M28 RED (the structural pin E8 cites; dropping `XDG_CONFIG_HOME` from assert-package's spawn env reddens it). `87b25c1`, `756aeb5` ("assert:package refuses a /healthz whose pid is not the binary it spawned"; "assert:package reports a spawned binary that exits before it could be tested") show only that assert-package now runs under `bun test` |
| D9 | `loadConfig`'s `Readonly<…>` annotation is pinned by nothing, and the shallow freeze is untested below the top | task-3-report.md:608-613 | ruled | No test can pin an annotation; the shallow freeze is a documented ruling (plan:1082-1088) for the deferred writer (§4.2) |
| D10 | `CONFIG_FILENAME` export was unpinned; `describe()`'s per-case wording was unpinned | task-3-report.md:627-633 | closed | `d357b13` imports `CONFIG_FILENAME` (`test/config.test.ts:5`), and "reads $XDG_CONFIG_HOME/atrium/config.json" asserts `configFilePath(...)` equals `join(dir, 'atrium', 'config.json')` (`:165`), which `configFilePath` builds from the constant (`src/core/config.ts:46`): a changed value reddens it, and a deleted export fails typecheck. The report's "would redden nothing" (task-3-report.md:632-633) was already false. `describe()` is closed by `cc51b2d`: "a non-object top level throws ConfigError naming what it got instead" |
| D11 | Adjudication returned 0 refutations of 15; the refute-by-default framing may need hardening | ledger:445-448 | open | §4.12. Process item, never decided; later panels also refuted nothing (ledger:1297-1298, :1496). Not resolvable from the tree |
| D12 | `src/core/config.ts:13-14` still says the spec mentions zod and that a later task reconciles it | src/core/config.ts:13-14 | open | §4.11. Spec §6 was reconciled in `8332237`/`86d59b9`; the only zod mention left is spec:106 ("no zod dependency"). Outside 10c D3 |

### E. Task 4 (auth, handoff, `atrium open`)

| # | Item | First carried | Disposition | Evidence |
|---|---|---|---|---|
| E1 | Mutation X8 as written cannot redden (`req.json()` throws on a bodyless GET) | ledger:494-498 | closed | `5c12bdd` records the realisable row (plan:1861-1874); record T4-X8 RED on "a GET to /api/session neither issues nor consumes" |
| E2 | Mutation X13 as written does not compile | ledger:499-500 | closed | `5c12bdd` (plan:1871); record T4-X13 RED on "atrium open --print-url prints the boot handoff from the file and does not mint a new one" |
| E3 | Mutation X9 needs `path` recomputed after the gate | ledger:501 | closed | Record T4-X9 RED on "POST /api/session with no Origin header is rejected by the gate before the route runs" (`f526288`). Not written into the T4 addendum |
| E4 | X14 can write a live credential into `~/.config/atrium`; run it scoped to `test/paths.test.ts` | ledger:502-504 | ruled | plan:1880-1886. The 10b replay ran it on the full suite, safely here because that directory is absent; the hazard is documented, not structural |
| E5 | The WS "authenticate, then still open" test is vacuous without its second frame | ledger:507-510 | closed | `f526288`. "a socket that authenticates stays open and is not re-authenticated on later frames"; record T4-X2 RED |
| E6 | Unauthenticated `/healthz` discloses pid, nonce and the absolute binary path | ledger:513-516 | ruled | task-4-review.md:229-234 (launcher liveness probe by design); posture at `0002:389-392` |
| E7 | Token comparisons are not constant-time; the first recorded reason was wrong (loopback is interface-scoped); timing never measured | ledger:517-520 | ruled | `44aac81`, `f68a5d1`: `0002:393-427`, "an analytical argument, not a measurement", revisit if off-host or a second `mintHandoff` caller |
| E8 | `scripts/assert-package.ts` inherited `XDG_CONFIG_HOME`/`XDG_RUNTIME_DIR`/`HOME`, clobbered a live server's files and scanned the real home; it could not be run safely | ledger:526-531 | closed | `1d6e6a4`, `c8dd615` (`assert-package.ts:55-76`), `6281c07`. "every server spawn scopes HOME, XDG_RUNTIME_DIR and XDG_CONFIG_HOME to a temp dir"; record T3-M28 RED. Measured at ledger:1358-1362 |
| E9 | I1: in-process `startServer` calls in `test/serve.test.ts` had no `env`, so `bun test` overwrote then deleted a running atrium's files; the "dead credential left behind" variant was never reproduced | ledger:548-555 | open | §4.10. Fixed in `abd2830` (all 30 in-process calls in `test/*.test.ts` pass `env` at `4f7956c`; the two fixture probes, `test/fixtures/sigterm-probe.ts:28` and `exit-probe.ts:14`, pass none and rely on their parent's scoped env), but no test pins it: the structural spawn test excludes in-process calls (`test/verify-gate.test.ts:152-157`) |
| E10 | I2: nothing pinned the security headers on the `/api/session` 200 | ledger:556-558 | closed | `079ddc6`. "a handoff redeemed at POST /api/session returns a session token that is accepted by /api/state"; record T4-I2 RED |
| E11 | I4: the 7-day TTL premise ("never in a URL") is designed to become false; the ruling needed a revisit trigger | ledger:566-568 | ruled | `4441844`, `acdfa8e`: trigger at `0002:352-366`. Source-comment half is E21 |
| E12 | M1: nothing pinned that the server never logs a credential | ledger:571 | closed | `91ef0aa`. "atrium open --print-url prints the boot handoff from the file and does not mint a new one"; record T4-M1a/M1b RED |
| E13 | M2: the 401 no-oracle property was unpinned | ledger:571 | closed | `cb4fd4c`. "a malformed body and an unknown handoff get the same 401, byte for byte"; record T4-M2 RED |
| E14 | M3: a `test/paths.test.ts` comment claimed coverage that measurement refutes | ledger:571-572 | closed | `356ceb7`. "handoffPath falls back to the config dir when XDG_RUNTIME_DIR is unset" (T4-M4a RED); "handoffPath and endpointPath are siblings in the runtime directory" (T4-X14 RED) |
| E15 | M4: two tests carried no named mutation | ledger:572 | closed | `356ceb7`, `e6fca62`. "atrium open fails cleanly with no server and with no --print-url" (T4-M4b1-b4 RED) and the paths fallback test |
| E16 | M5: `POST /api/session` parses an unbounded body before any auth | ledger:573-574 | open | §4.6. `serve.ts:180`; no `maxRequestBodySize`. Carried to T6 by name (ledger:844), then dropped from every later list |
| E17 | M6: the `req.method === 'POST'` guard is not pinned on its own | ledger:574 | open | §4.6. Reviewer marked it "recorded, not required" in an untracked review; only T4-X8, which also adds a URL source, touches it. Dropped after ledger:844 |
| E18 | The T4-T6 tests were never flake-checked under CPU oversubscription (T6's WS protocol tests sleep 50-150 ms) | ledger:576-577; task-6-report.md:336-337; task-5-report.md:291 | open | §4.10. T5 and T6 recorded the same gap (task-6-fix-report.md:120-122 repeats it). 10a's 13 runs under `podman --cpus 4/2/1` (287/0, ledger:1299-1302) measure starvation, not the 64-busy-loop shape T2/T3 used |
| E19 | The `/api/session` 401 is claimed byte-identical to the bearer 401; no test compares them | ledger:682 | open | §4.6. `serve.ts:185`; the three `/api/session` refusals are compared (`05dbf89`), the bearer 401 only by status |
| E20 | Logging a partial token (`tok.slice(0,8)`) passes the containment assertions | ledger:759-761 | open | §4.6. `test/serve.test.ts:643-663` asserts `not.toContain` of full credentials only |
| E21 | L3-8: the `BOOT_HANDOFF_TTL_MS` comment and `src/index.ts`'s "later plan's job" comment carry no pointer to ADR 0002's revisit trigger | ledger:739-740 | open | §4.7. `serve.ts:59-71` has no ADR reference; `src/index.ts:85-86` unchanged |
| E22 | L2-F1: M1 pinned only the handoff; a `console.error` of the session token shipped green | ledger:722-725 | closed | `c07f40b`. "atrium open --print-url prints the boot handoff from the file and does not mint a new one"; record T4-R1 RED |
| E23 | The M1 guard's rationale was inverted (`not.toContain('')` throws on bun 1.3.11), and assertions in `finally` masked the real failure | ledger:731-733 | closed | `f0eb37b`. "atrium open --print-url prints the boot handoff from the file and does not mint a new one"; record T4-R2 and T4-M1-guard RED |
| E24 | The `open` success path piped stderr and never read it | ledger:727-730 | closed | `34cdb95`. "atrium open --print-url prints the boot handoff from the file and does not mint a new one" (the openErr assertion); record T4-T1 RED |
| E25 | Only 2 of the 4 standard headers were pinned on the bearer 200 | ledger:727-730 | closed | `1c6fe3b`. "a handoff redeemed at POST /api/session returns a session token that is accepted by /api/state"; record T4-T2 RED |
| E26 | A header-carried 401 oracle and an already-redeemed 401 oracle both survived | ledger:727-730 | closed | `05dbf89`. "a malformed body and an unknown handoff get the same 401, byte for byte"; record T4-T3a/T3b RED |
| E27 | The 7394 port-collision child inherited the real `XDG_RUNTIME_DIR` | ledger:729-730 | closed | `d0602cb`, `86966f0`. "every server spawn scopes HOME, XDG_RUNTIME_DIR and XDG_CONFIG_HOME to a temp dir" counts it among its sites |
| E28 | ADR-lens wording faults in the boot-handoff section (A1-A8) | ledger:734-739 | ruled | Text-only, `f68a5d1`, `acdfa8e` (`0002:335-336`, `:360-366`, `:407-427`) |
| E29 | Review findings counted but never enumerated (T4 fix review 20, T5 pre-flight 6, T6 review 7, T8 review 11, 10a pre-flight 29 — the 67 − 38 never sent to the verifier panel, ledger:1297-1298) | ledger:692-693, :721, :877, :1016, :1297-1298 | open | §4.12. The workflow outputs were not saved; only counts survive (10a's evidence is in a session scratchpad a clone will not have). The T4 fix2 brief accounts for about 18 of 20. Cannot be resolved from the tree |
| E30 | No rate limiting on `POST /api/session` | plan:1921-1922 | ruled | Out of scope by plan:1921-1922; 256-bit tokens make brute force irrelevant (task-4-report.md:622-623) |
| E31 | One boot handoff per start means one browser profile can redeem | 0002:368-377 | ruled | ADR 0002 "Accepted residual" |
| E32 | A stale `handoff.json`/`endpoint.json` prints a well-formed URL that silently fails | 0002:379-383 | open | §4.7. `src/core/paths.ts:37-39`: "documented future work"; no doctor command |
| E33 | Two instances clobber each other's endpoint and handoff files | plan:1681-1683 | open | §4.7. `serve.ts:285-287`: "carried forward to a later plan"; no locking |
| E34 | `BOOT_HANDOFF_TTL_MS` is pinned only as ≥24 h; the mint sweep never fires in production | 0002:347-350 | ruled | "the boot handoff TTL is long, per the recorded ruling" is labelled a tripwire; the sweep is exercised by "minting sweeps handoffs that expired before the new mint" |
| E35 | Launching a browser from `atrium open`; the TTL ruling must be re-taken when it lands | cf2:31-33 | open | §4.7. `src/index.ts:84-88` exits 64 without `--print-url` |

### F. Task 5 (the `toClient` seam)

| # | Item | First carried | Disposition | Evidence |
|---|---|---|---|---|
| F1 | Pre-flight F1/A1: the plan's literal M4 does not exist; record the realisable M4-sharp for Task 10 | ledger:635-639 | closed | `9075f82` (plan:2474). Record T5-M4-sharp RED on "the client value is the redacted one — a Data sentinel reaches neither snapshot() nor an onUpdate listener" |
| F2 | Pre-flight F3: the ripple into two `.data` identity assertions in `scheduler-lifecycle.test.ts` | ledger:644-651 | closed | `dd16426`. Record T5-F3 RED on "consecutive failures accumulate and a success clears the record" and "onUpdate carries the status envelope, and the record is current when it fires" |
| F3 | Re-running M6 expects TS2322/TS2345/TS1360, not TS2741 alone; A2 typechecks between edits | ledger:825, :847 (the TS2322/TS2345/TS1360 carry); :698-701 (the A2 half) | ruled | Delivered as record rows T5-M6, T5-M6-routes, T5-A2 (all RED_TYPECHECK). Typecheck rows have no test title |
| F4 | Brief amendments A4/A5/A6/A8 (spec audit paragraph, `ProviderStatus.data` comment, retensed config test, plan prose) | ledger:703-706 | ruled | Text-only: `8332237`, `86d59b9`, `dd16426`, `9075f82` |
| F5 | Workflow worktrees start stale under `.claude/worktrees`; `rev-parse` first, remove after | ledger:683-684 | ruled | Standing process rule (ledger:712-714); at `4f7956c` `git worktree list` shows the main tree only |
| F6 | `lastErrorMessage` is an unredacted provider-controlled text channel outside `toClient`, on `/api/state`, `onUpdate` and both WS frames; T5's "never reaches a client" claim was false | ledger:790-797 | open | §3 (precondition) and §4.8. Ruled for Plan 2 by ADR 0002 Ruling F (`a138b85`); the false claim was scoped in `f1b482c`, `86d59b9`. Sanitising at `recordFailure` is owed before any credential-holding provider |
| F7 | Ruling F's gate must be written into the Plan 3 carry-forward as a precondition on the ordering (rated BLOCKING) | ledger:1082-1084 | ruled | Written in §3 of this document, quoting `0002:507-510` |
| F8 | `src/core/contract.ts:87-89` and `spec:160-161` still call the channel an open item for Task 6 | contract.ts:80-89 | open | §4.11. Neither points at Ruling F; neither file is on 10c's edit list |
| F9 | T5 fix-round test gaps: the no-toClient test was vacuous on an empty `pushed` array; the raw-return pin named no mutation | ledger:800 | closed | `26598c8`. "a provider with no toClient fails the run instead of publishing raw Data"; record T5-M8 RED on the redaction test |
| F10 | T5 fix-round doc items (R2 buildStatus comment, spec blockquotes, L3-3/4/5) | ledger:798-801 | ruled | Text-only: `54038fd`, `86d59b9`, `f1b482c` |
| F11 | L3-2: the `POST /api/actions` 400 serializes a provider-authored `e.message`; the comment claims it echoes only ids | ledger:802 | open | §4.6. `routes.ts:77-81` unchanged; dropped after T6 |
| F12 | L2-2: a circular `toClient` value breaks `/api/state` until the next successful run | ledger:802-803 | open | §4.6. WS half closed by `8476760` ("an unserializable provider payload degrades to an error frame and the socket survives"); HTTP half unguarded at `routes.ts:66` |
| F13 | L2-4: "exactly one `p.toClient` call site" was held by grep; carried as a Task 10 gate and dropped from the closeout list | ledger:804 | closed | `3321de3`. "toClient is called at exactly one site under src/: the scheduler write path that stores `last`"; record TB-G2 rows RED |
| F14 | L2-5: `toClient` returning `undefined` looks like "never succeeded" on the wire | ledger:804 | open | §4.8. Unreachable for `reposToClient` (`index.ts:618`); the pane treats `undefined` as loading; nobody recorded a disposition |
| F15 | L3-8: a JS or `as any` provider missing `toClient` registers, fails every run and polls forever | ledger:804-805 | ruled | plan:2604-2606. Fails safe: "a provider with no toClient fails the run instead of publishing raw Data" |
| F16 | The routes test's inline Provider literal used `as` rather than `satisfies` | task-5-report.md:299-300 | closed | `ec5a631`. "GET /api/state serves the redacted client value, not the provider Data" |
| F17 | The spec's audit-log claim (no audit log exists) | scoping:115, :232 | ruled | Withdrawn in `8332237` (`spec:166-169`). Only the option of building one at `dispatch()` stays open: §4.4 |
| F18 | Reconcile spec §6's interface block with the shipped contract | scoping:115 | ruled | Text-only, `8332237`, `86d59b9` |

### G. Task 6 (the WS wire)

| # | Item | First carried | Disposition | Evidence |
|---|---|---|---|---|
| G1 | T4's fix round took port 7412, colliding with T6's planned range | ledger:838-839 | ruled | T6 = 7413-7421 (plan:3359-3361, `89eb962`); no reuse (plan:3467-3470) |
| G2 | M20 was masked by a comment (Tailwind v4 reads candidates from comments); a standing `p-4` count gate and a repo-wide rule were owed to Task 10 | ledger:886-889 | open | §4.10. Only `main.tsx:25` was fixed (`b930a04`). "main.tsx still contains the literal p-4 the packaging gate depends on" matches `p-4` anywhere, including a comment; no count check, no rule in ADR 0003 |
| G3 | M24 is null-only: only a `null` WS body reddens the socket guard mutation | ledger:905-906 | closed | `41bf28d`. "a junk message body neither throws out of the listener nor moves the store"; record T6-M24 RED |
| G4 | R-B: `socket.ts` said `onAuthFailure` re-reads the fragment; the shipped `main.tsx` clears and re-renders | ledger:907-910 | ruled | ADR 0002 Ruling G (`0002:528-572`, `a138b85`); comment corrected in `5a6971c`. Wiring has no test (`main.tsx` is not importable under bun test). Citation drift `:48`→`:50` in §4.11 |
| G5 | Ruling H: the client drops the wire `error` frame; the visible surface is deferred | ledger:1180-1182 | ruled | `0002:574-616`. Pinned by "an error frame is dropped before and after the snapshot: no state change, no notification" (`476a386`, `345e01e`, `1c54ece`). Revisit with a second provider, paired with F (§4.8) |
| G6 | Mutants that set `connected` true on an error frame are RED only on `8ead746`'s pin, equivalent under production wiring | ledger:1593-1595 | ruled | Ruled equivalent by the F1 regression checker; recorded here because only the untracked ledger held it |
| G7 | T6 M5 withdrawn: registering the publisher after `start()` is wrong only once `start()` is synchronous | plan:3374 | ruled | Withdrawn in the T6 addendum |
| G8 | `postAction` and `getState` are exported but untested; `getState` has no call site | task-6-report.md:353 | open | §4.9. `postAction` is reached only via `postReposAction` and pinned as text |
| G9 | Nothing uses a real browser: CSP-vs-Tailwind, localStorage `SecurityError` and live WS behaviour are unobserved | task-6-report.md:326-329 | ruled | Structural: ADR 0002 Ruling D Property 2 and ADR 0003 (d) (`0003:228-230`) |

### H. Task 7 (repos discovery)

| # | Item | First carried | Disposition | Evidence |
|---|---|---|---|---|
| H1 | M10 names test 29 by a title that contradicts the path-on-the-wire ruling | ledger:941-942 | closed | `587740a`. Record T7-M10 RED on "reposToClient emits no gitDir and no dropped-candidate path" |
| H2 | G8: with the `lastErrorMessage` channel open, the repos fetch must never throw with a path | ledger:943-944 | ruled | T7 addendum (plan:5615-5622): no throw on the fetch path, by inspection. Partial pin: "every error code is a member of the closed set" (`7aac0db`) |
| H3 | The in-root symlink test was vacuous against a symlink-following walker (15th vacuity) | ledger:961-963 | closed | `4d42cfd`. "a symlink to a repo inside the root does not produce a second entry"; "a symlink pointing out of the scanned root never reaches Data"; record T7-R1 RED. The escape test's two `JSON.stringify` assertions are dead (H12) |
| H4 | A probe-root timeout leaked `basename($HOME)`; the plan's "two shim tests" was one | ledger:964, :966 | closed | `28bdf7b`. "a probe root whose rev-parse times out is reported on the closed set, never named in dropped"; record T7-R2 RED |
| H5 | `rev-parse` exiting 0 with empty stdout (`realpathSync('')` is the cwd) | ledger:964-965 | ruled | Guard shipped in `4c27eb2`; no fixture can produce the shape (plan:5680-5690). 10b's exit shim echoes real stdout, so it does not reach it either |
| H6 | A `.git` file pointing at a valid gitdir outside the root is accepted | ledger:965 | ruled | Dismissed as the spec's rule: the validity gate rejects only 0-byte `.git` files, dangling pointers and empty output (`spec:215-217`). Recorded here; no tracked doc held it |
| H7 | The plan's claim that tsc enforces the `typeof code === 'number'` narrowing is false | ledger:958-960 | ruled | T7 addendum M11 row (plan:5613); held by review at the one comparison site |
| H8 | Classifier rows 2-4 passed `rel` as a bare pathspec (`a[1]`, `*`, `?x`, `a\b`, `:x`, `:!x`, `:(top)x`) | ledger:965 | closed | `71d68ef`, `bade06c`, `e7fd074`. "row 2 is literal for every measured name: a submodule decoy never claims the child"; "row 3 is literal …"; "row 4 is literal for every measured name: an ignored child surfaces as a container child"; "a vendored child under an ignored vendor/ is still dropped as vendored" |
| H9 | The recorded fix text (`:(literal)` for all three rows) is wrong for row 4; the brief cited it to "ADR 0002 Ruling I's neighbours", which record nothing about it | ledger:980, :1500-1506 | ruled | Text-only, corrected by dated lines after both plan passages in `042efdc`, citing `bade06c` and `src/providers/repos/index.ts:346-354` (ADR 0002 mentions only the old bare shape, `:49`, `:269`) |
| H10 | M11 (gate accept → `code !== 128`) needs an exit-1 rev-parse shim; the closeout list dropped it | ledger:963, :980-981 | closed | `0b172d6`. "a repo whose rev-parse prints its gitdir but exits ${code} is dropped as invalid, never accepted" (1, 2, 128, 129, 255); "control: the same rev-parse shim exiting 0 lets the same repo through as top-level" |
| H11 | Absolute `$HOME`-relative paths reach an authenticated client | plan:3808-3816 | ruled | `path` is the action target key by ruling; control pinned by "an undiscovered path is refused before any argv is built" |
| H12 | The escape test's two `JSON.stringify` path-absence assertions are never reached and would not fire if they were; its only load-bearing assertions are `repos`/`dropped`/`errors` `=== []` | plan:5661-5664 | open | §4.10. "a symlink pointing out of the scanned root never reaches Data" (`test/repos-discovery.test.ts:158-169`): the gate drops the link under the walker's path, not the target's, so record T7-R1 reddens it only through `dropped`. Same class as A10 |

### I. Task 8 (repos metadata and actions)

| # | Item | First carried | Disposition | Evidence |
|---|---|---|---|---|
| I1 | F1: tests dispatched through the default launcher; nothing pinned the inert launcher | ledger:1032-1034 | closed | `2b0ea05`, `8ead746`, `b6954ee`. "every dispatch( and spawnDetached( in test/ passes an inert or named-fake launcher, by value"; "every file with an INERT_LAUNCHER site binds it once, by import from test/fixtures/launcher"; "INERT_LAUNCHER starts, and the command it wraps never runs" |
| I2 | F2: a multi-line rebase head-name reached the wire; `(detached)` broke the invariant | ledger:1034-1035 | closed | `15af9ba`. "a multi-line rebase head-name yields only its first line as the branch"; "a rebase head-name that is (detached) or empty leaves branch absent" |
| I3 | F3: an empty `log` stdout gave `lastCommitAt` 0 | ledger:1035-1036 | ruled | Guard in `43152f5`; unreachable on git 2.55 (plan:5843-5848) |
| I4 | F4: test 15's annotation named M12/M13, which do not redden it | ledger:1036 | ruled | Comment-only, `a5ae0d4` |
| I5 | `GIT_COMMAND` missed the git-core helpers (`git-receive-pack` runs `core.alternateRefsCommand`) | ledger:1036-1037 | closed | `2979b62` (Ruling I). "the whole git suite is refused and its near-misses are not — every verdict pinned"; "every git* and scalar entry in the installed git exec-path is refused" |
| I6 | Ruling I limits 1-5 (other-name frontends, wrappers such as `env`/`sh -c`, aliases and links, shipped defaults, unscanned args); cf2 §4's name-check warning | cf2:85-89; 0002:672-688 | ruled | Recorded limits; revisit if a realpath layer is proposed (`0002:699`) |
| I7 | Ruling I limit 6: `.exe` unmatched, and narrowing the suffix class is caught by nothing | 0002:689-690 | open | §4.10. "Minor, unpinned"; no test or record row targets it |
| I8 | B1: Ruling I and the `GIT_COMMAND` comment claimed every exec-path helper is git | ledger:1547-1549 | ruled | Text-only, `d4fd1d5` |
| I9 | P10: the `actions.ts:25` comment said a spawned child's cwd is `/` | ledger:1525-1526 | ruled | Comment-only in `2979b62`; side correction at `0002:692-697` |
| I10 | The live exec-path sweep needs git and >50 entries; measured only on Fedora and Ubuntu 24.04 | task-10-closeout-report.md:250-251 | ruled | The test carries an anti-vacuity length check |
| I11 | `INERT_LAUNCHER` is `/bin/false`, an FHS assumption | task-10-closeout-report.md:252 | ruled | Fails closed on NixOS, which is the intended direction |
| I12 | A discovered-but-not-yet-read repo is `unavailable` with no `metaReason`; Task 9 must render "not read yet" | ledger:1030-1031 | open | §4.9. `ReposPane.tsx:177` renders `unavailable (unknown)`; task-9-brief.md never took it; no test or ruling |
| I13 | M16: `String.replace` in `renderTemplate` is undetectable | plan:4612-4619 | ruled | Survivor T8-M16; control pinned by "template validation rejects the five malformed shapes" |
| I14 | The 10-minute discovery run can overlap a 30-second metadata pass | plan:5802-5806 | ruled | Reasoned, not measured; carry-over on rebuild heals it |

### J. Task 9 (the repos pane)

| # | Item | First carried | Disposition | Evidence |
|---|---|---|---|---|
| J1 | T9 owns the `src/index.ts` lines registering `createReposProvider()` | ledger:1056-1057 | closed | `c9863a3`. "the assembled server serves the fixture repos over an authenticated /api/state"; record T9-M11 RED |
| J2 | Carried constraints: type-only wire imports, Tailwind only, a literal `p-4` | ledger:1058-1063 | closed | `a0daceb`, `26dd62e`. "the pane source contains no injection sink and no value import from src/"; "main.tsx still contains the literal p-4 the packaging gate depends on". The fourth carried constraint, no wrapper hook, is J36 |
| J3 | `postReposAction(actionId, path)` could not reach a token | ledger:1103-1111 | closed | `39f6faf`, `7be3a8c`. "the action POST carries the token in a header and the path in a body, never in a URL"; record T9-M17 RED |
| J4 | Pin Ruling F: an unavailable reason containing a script tag renders escaped | ledger:1112-1114 | closed | `a0daceb`. "the three non-populated states render three visibly distinct panes"; record T9-M13 RED |
| J5 | The CSP has no `base-uri` or `form-action` | ledger:1183 | open | §4.6. `serve.ts:41`; dropped from the T10 inherits list and the closeout list |
| J6 | The server logs no requests (OWASP A09), so a rejected action leaves no evidence | ledger:1168-1170 | open | §4.6. Only console output is the port-in-use error |
| J7 | A rejected action (400) shows nothing in the pane; only `console.error` | ledger:1168-1170 | open | §4.9. `api.ts:74-96` says "deferred with it (ADR 0002 Rulings E and H)", but neither ADR ruling names it, and `test/repos-pane.test.ts:466` still calls it T10's |
| J8 | M-1/M-2: `postReposAction` unasserted, and a throwing `localStorage.getItem` was an unhandled rejection | ledger:1166-1168 | closed | `7be3a8c`. "the action POST carries the token in a header and the path in a body, never in a URL" |
| J9 | M-3: the value-import tripwire was bypassed by `../../../src` | ledger:1158-1165 | closed | `26dd62e`. "the pane source contains no injection sink and no value import from src/"; record T9-M16 RED |
| J10 | The click test never clicked (18th vacuity) | ledger:1191-1198 | closed | `e2b8593`. "clicking an action reports the action id and the repo path"; record T9-M14/M15 RED |
| J11 | Lens A minors 1, 2, 5, 7 (derivation step 1, strict `>`, tie-break, ambiguous filter) | ledger:1185 | closed | `62c9c60`. "derives loading before the first snapshot frame"; "a repo exactly on the staleness boundary is not yet stale"; "recent is ordered most-recent-first with undated repos last"; "droppedAmbiguous is reported, not discarded" |
| J12 | Every source-run server spawn scanned the developer's real `$HOME` (39 repos) | ledger:1199-1206 | closed | `86966f0`, `c8dd615`, `99c7acf`, `e9b6242`. "every server spawn scopes HOME, XDG_RUNTIME_DIR and XDG_CONFIG_HOME to a temp dir" |
| J13 | Lens A minor 3: the "Needs attention" heading-suppression guard is unpinned | ledger:1259 | open | §4.9. `ReposPane.tsx:362`; no assertion, no record row |
| J14 | Lens A minor 4: the em-dash branch fallback is unpinned | ledger:1259 | open | §4.9. `ReposPane.tsx:315` |
| J15 | Lens A minor 6: `relativeCommitTime`'s unit table is under-asserted | ledger:1259 | open | §4.9. "relativeCommitTime renders fixed English units and a no-commit case" asserts only hour, month and no-commit |
| J16 | Lens A minor 8: neither group heading's text is asserted | ledger:1259 | open | §4.9. `ReposPane.tsx:364`, `:370` |
| J17 | Lens A minor 9: the uncommitted-count and relative-time cells are unpinned | ledger:1259 | open | §4.9. `ReposPane.tsx:317-318` |
| J18 | Lens A minor 11: the `provider failed` fallback is unpinned | ledger:1259 | open | §4.9. `ReposPane.tsx:95`; no fixture has a null message |
| J19 | Lens A minor 12: "Recent" renders unconditionally, even over an empty list | ledger:1259 | open | §4.9. Spec-conformant design note with no ruling |
| J20 | Lens A minor 14: `entry.data as ReposWire` is unchecked and `main.tsx` has no error boundary | ledger:1259 | open | §4.9. `ReposPane.tsx:101`; unreachable today |
| J21 | Lens A minor 13: `test/config.test.ts` still says "registers no providers until Task 9" and tells Task 9 to replace the test | ledger:1185 | open | §4.10. Unchanged at `config.test.ts:625-636`; never carried by the ledger |
| J22 | Lens A minor 10: `?? 0` on `uncommittedCount` cannot be pinned; add no row | ledger:1212-1215 | ruled | No record row mutates it |
| J23 | T9 M2 and M3 redden the same tests; tell them apart on asserted values | ledger:1131-1132 | ruled | Lens A ruled it no vacuity; the record separates them (T9-M2 fails 4, T9-M3 fails 3) |
| J24 | T9's M1-M13 name tests by number and the fix round shifted the numbering | ledger:1234-1235 | closed | `4f7956c` names rows by title. Record T9-M13 RED on "the three non-populated states render three visibly distinct panes" |
| J25 | M-4: `session.ts` ⇄ `api.ts` import cycle; the walk later dropped `./session.js` specifiers | ledger:1171-1175 | closed | `eae9e85`, `6e22333`. "web/src/lib has no static import cycle"; "the resolver maps .js-family suffixes to their TS source and reports what it cannot resolve" |
| J26 | M-5: the pane ignored `wire.errors` and the `timed-out` drop reason | ledger:1176-1180 | closed | `a68cd13`. "scan notes count timed-out and invalid drops, never their names, and stay silent on deliberate drops"; "scan notes count every error code as a multiset"; "scan notes reach the pane from a real discovery pass: a mistyped extraRoot" |
| J27 | §8.7 escaping in attribute position is measured but covered by no test | ledger:1149-1150 | open | §4.9. "an attacker-controlled branch name renders escaped" covers child-text position only |
| J28 | The plan's "4188 bytes" built stylesheet is stale (6004 after T9; 6139 bytes at `91b2147`) | ledger:1136-1137 | open | §4.11. plan:4935, scoping:134; outside 10c D3 |
| J29 | `postReposAction`'s behaviour is pinned only as source text; a behavioural test needs a seam | task-9-report.md:175-182 | open | §4.9 |
| J30 | One thrown gate/classify call shows two scan-note lines for one event | task-10-closeout-report.md:247-249 | open | §4.9. Marked "not addressed" |
| J31 | The scan-note tone split was the implementer's decision, for the owner to review | task-10-closeout-report.md:244-246 | ruled | Pinned exactly by "scan notes render in a fixed order with a fixed tone per note"; a change is one expected-list edit |
| J32 | T9 known limits (ambiguous names shown only as a count, fixed port 7424, hook-free click walk, `data-repo` attribution) | task-9-report.md:193-205 | ruled | Recorded limitations; each record row names its red test |
| J33 | `test/repos-pane.test.ts` cites `scripts/assert-package.ts:119-131` for the canary | ledger:1101-1102 | ruled | Comment-only, corrected to `:166-178` in `8f8f577` |
| J34 | The plan cites stale `scripts/assert-package.ts` lines: `:108-113` for the Tailwind canary (now `:166-178`) and `:84-92` for the "gate that went vacuous" note (now `:149-157`) | ledger:1270-1272 | open | §4.11. ADR 0003 avoided them and maps the note to `:149-157` (`0003:34`); the plan text is outside 10c D3 |
| J35 | Re-opening the handoff URL in an already-loaded atrium tab shows "Not signed in": a fragment-only navigation does not reload the document, so `acquireToken` never re-runs | ledger:1143-1148 | open | §4.7. `web/src` has no `hashchange`/`popstate` handling; `atrium open --print-url` pasted into an existing tab hits exactly this path; a manual reload is needed. Only the untracked ledger held it |
| J36 | Carried constraint: no wrapper hook around the pane (split from J2) | ledger:1058-1063 | ruled | Held by inspection only; no test or record row pins it |

### K. Task 10 (10a, closeout, 10b, 10c)

| # | Item | First carried | Disposition | Evidence |
|---|---|---|---|---|
| K1 | The release gate passed vacuously: `assert:package` never checked `/healthz` was its own child; a dev server on 7373 made it pass | ledger:1312-1317; plan:5207-5211 | closed | `c8dd615`, `87b25c1`, `37d4f72`, `756aeb5`. "assert:package refuses a /healthz whose pid is not the binary it spawned"; "assert:package fails the measured scenario: a stub that exits ${exitCode} while a convincing listener answers" |
| K2 | The verify chain and CI pin had to be non-hollow and un-evadable | ledger:1250-1251 | closed | `b2e51d4` … `8967542`. "verify chains build, the packaging assertion, the test run and typecheck, in that order"; "every stage named in verify is a real script"; "package.json scripts are exactly the reviewed verify chain"; "CI runs on its own: push and pull_request triggers under on:" |
| K3 | `actions/checkout@v4` runs on node20, which leaves GitHub runners on 2026-09-23 | ledger:1305-1306 | closed | `f35c2f9` (`@v5`). ".github/workflows/ci.yml is exactly the reviewed workflow"; sourcing at `0003:141-149` |
| K4 | Known limits of the structural spawn scan, and the convergence rule | ledger:1409-1419 | ruled | `0003:95-113` (`357cbf5`, `90ab462`) |
| K5 | P-1: the plan's "no git remote" premise was false | ledger:1265-1269 | ruled | `0003:232-240` (`b5eb99d`) |
| K6 | P-3: re-measure every reference number instead of copying them | ledger:1273-1274 | ruled | `0003:166-191`, `:268-279` (`b5eb99d`) |
| K7 | CI has never executed; ADR 0003 (e) owes the first real run's result | ledger:1245-1246 | open | §4.12. Pushed 2026-09-21: `origin/feat/first-light` = `11ede55`, which triggered run 35644633756; GitHub refused to start the job on the account's billing state, so no `ci.yml` step has run on a runner (`0003:242-257`). The real run is still owed (`0003:240`); unblocking it is the owner's action |
| K8 | 10a brief v2 doc corrections (401s not a blank page; quote `gate.ts:5-7`; `changeOrigin`; CI runner reliance) | ledger:1323-1329 | ruled | Text-only, `b5eb99d`, `7092fea`, `242f497` |
| K9 | ADR 0003 (d): widening `gate.ts` or adding a Vite proxy is forbidden | plan:5292-5306 | ruled | Standing prohibition in `0003:193-230` |
| K10 | The plan's carry-forward "Still open" list is incomplete | ledger:1340-1341 | ruled | Section 4 of this document, fed by this appendix |
| K11 | The keyring is Secret Service via libsecret served by KDE ksecretd/KWallet, not GNOME | ledger:1342-1343 | ruled | Stated in §2 of this document with the measurement. ADR 0001 `:30-31` and `:315-316` carry dated corrections since `9c91b00` (`:32-38`, `:322-327`); plan `:5335-5336` still says GNOME (§4.11) |
| K12 | Closeout limitations F2-F5: `:/x` omitted, lexical per-file binding scan, looser-than-tsc resolver, and the F5 `/tmp` scan missing a variable-bound literal, `/var/tmp`, and `mkdirSync` | ledger:1573-1575 | ruled | Terminal condition "documented, not chased" (task-10-closeout-fix-report.md:127-143). In-tree notes at `test/repos-discovery.test.ts:402-403`, `test/launcher-pin.test.ts:18-33`, `test/web-lib-imports.test.ts:32-33`; the F5 misses and F3's cross-file forwarding case are tracked only here, and the unmeasured magic words `:(icase)`, `:(glob)`, `:(attr:…)`, `:(exclude)` are covered only by the shared `:`-prefix pins (task-10-closeout-fix-report.md:129-131) |
| K13 | Bun 1.3.11's `realpathSync` throws ENOENT on a directory whose name contains a backslash | ledger:1571-1572 | ruled | Worked around at `test/repos-discovery.test.ts:425-426` (`e7fd074`); no upstream report tracked |
| K14 | The tmp-hygiene test re-runs `rungit.test.ts` in a child on every run (~+0.55 s) | task-10-closeout-report.md:253 | ruled | Accepted as the cost of the P3 pin |
| K15 | Host still held stale `/tmp/atrium-*` entries (6152 at T8, 1276 at the closeout) | plan:5874-5875 | ruled | Resolved out of band, the way A18 is: the entries were removed on 2026-09-21, and the controller counted 0 on 2026-09-23. An environment fact, so nothing can pin it (§4.12) |
| K16 | Task 10 re-runs the whole mutation table using the realisable addendum rows (never the M7/M10/M21/M22 literals) | ledger:453-457 | ruled | Delivered as a record, not a test: `4f7956c`, 302 rows, 0 open gaps. Gap closes `0b172d6`, `3321de3` are H10 and F13 |
| K17 | Two corrections for 10b: cross-task row 9 is unobservable (run T6-M22 expecting four reds); row 6's parenthetical is stale | ledger:1335-1338 | closed | `4f7956c`. Record TX-9 duplicates T6-M22, RED on "server.stop() stops the scheduler" among four; TX-6 notes carry the correction |
| K18 | No mutation runner survived; 10b had to build one | ledger:1276-1277 | ruled | Delivered as the record and JSON; the runner lives in a session scratchpad, not the tree |
| K19 | Documented survivors dispositioned one by one | ledger:1639-1641 | ruled | `record:29-41` |
| K20 | Replay drifts: T4-X2-probe RED_UNNAMED; T2-S2's named test no longer reddens | ledger:1654-1659 | ruled | `record:43-47`, recorded as drift; T2-S2 is still caught by three scheduler tests |
| K21 | A sentence on each broad red (>10 tests) | ledger:1660-1661 | ruled | `record:49-65` |
| K22 | Plan-vs-report conflicts: T1-M1b, T3-M14, T3-M28 | ledger:1637-1638 | ruled | In the JSON's `expectNote`/`notes` fields |
| K23 | Any future test split carries a union check against the pre-split pin | ledger:1607-1608 | ruled | Process rule, applied in the F1 regression fix |
| K24 | Write `docs/superpowers/plans/2026-09-14-plan-3-carry-forward.md` (four sections plus this appendix) | plan:5316-5361 | ruled | This document |

### L. Scoping and later plans

| # | Item | First carried | Disposition | Evidence |
|---|---|---|---|---|
| L1 | §8.5 secrets adapter shape | scoping:188, :228; 0001:313-321 | open | §2 and §4.5. No `Bun.secrets` call in the tree |
| L2 | First run (`detect()` → confirm → persist) deferred; `detect()` has no caller | scoping:229 | open | §4.2 |
| L3 | `show diff` deferred; a result channel is a contract change | scoping:230, :241 | open | §4.1 |
| L4 | Per-schedule keying of `last` | scoping:231 | open | §4.3. `scoping:231`'s `scheduler.ts:5,37` citation is stale; `last` is at `:24` |
| L5 | The claude, obsidian and mail providers slip; "claude next, then obsidian; not mail" | scoping:226, :243 | open | §3, gated by Ruling F. Rests on the scoping default, not an ADR |
| L6 | Obsidian's unresolved ruling forced by the reference machine | scoping:243 | open | §4.13 |
| L7 | The claude forbidden-export grep and §7.4's redaction test | scoping:188 | open | §3. None of the four names appears in `src/`; upstream claim confirmed against TacosPlugins `27d15ae` |
| L8 | §7.4's four-way status envelope | plan:5138-5140 | open | §4.13 |
