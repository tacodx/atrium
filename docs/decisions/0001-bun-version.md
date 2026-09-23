# 0001 — Bun version floor

**Date:** 2026-09-13
**Status:** Accepted
**Corrected:** 2026-09-14 — three claims in this document were not true as
written. See "TLS — not measured at adoption; measured 2026-09-23", "Correction 2" and "Correction 3" below. Nothing
in the Decision changed; what changed is how much evidence it is recorded as
resting on.
**Corrected:** 2026-09-23 — four more, each a dated bracket or block beside the
original sentence, which stays: TLS is now measured (the "Not measured" section
is retitled "TLS — not measured at adoption; measured 2026-09-23" and carries
the measurement); the keyring on the reference machine is KDE's ksecretd/KWallet,
not GNOME; the credential-store adapter's owner is whichever plan first needs a
stored credential, not "Plan 4"; CI exists. The Decision is still unchanged.

## Measured
- bun version tested: `1.3.11`
- `--asset` recognised: no — `bun build --help` on this version lists only
  `--asset-naming`, not `--asset`. Passing `--asset ./web-dist` is silently
  dropped and `./web-dist` is then misparsed as a second entry point
  (`error: ModuleNotFound resolving "./web-dist" (entry point)`), confirming
  the brief's warning that this flag fails without any error on versions that
  lack it.
- `Bun.embeddedFiles.length`: 3   dist file count: 3 (via the
  `scripts/gen-assets.ts` fallback, not `--asset`)
- packaging assertion: pass — `packaging ok: 3 assets embedded, served from a
  foreign cwd`
- Tailwind utility present in served CSS: yes, with a caveat — see
  "Tailwind v4.3.3 output format" below.
- `Bun.secrets` round-trip in a compiled binary: ok (`keyring ok`, GNOME
  Secret Service via libsecret on this machine)
  [Correction, 2026-09-23: not GNOME. The session is KDE Plasma on Wayland, and
  the freedesktop Secret Service reached via libsecret is served by
  ksecretd/KWallet: `busctl --user status org.freedesktop.secrets` names
  `/usr/bin/ksecretd` (package `kf6-kwallet`); `gnome-keyring` is not
  installed. Re-measured 2026-09-21 by the Task 10c review and recorded in
  `docs/superpowers/plans/2026-09-14-plan-3-carry-forward.md` §2. The
  `keyring ok` result stands; only its attribution was wrong.]
- dual-stack TLS helper unit tests: pass (`2 pass, 0 fail, 4 expect() calls`)
  — this is a unit-test result, **not** a TLS measurement. It sat in this list
  beside genuinely measured items and read as though §7.3's requirement had
  been met. It had not. See "TLS — not measured at adoption; measured 2026-09-23" immediately below.

## TLS — not measured at adoption; measured 2026-09-23

**Correction 1 (2026-09-14, final whole-branch review).** No TLS handshake was
ever performed, on this bun version or any other.

- §7.3 requires "an integration test asserts a non-empty peer certificate and
  must fail if the workaround is removed."
- §12's Task 0 makes "a TLS handshake to `imap.gmail.com` yields a non-empty
  peer certificate" part of the walking skeleton.
- §5.1 calls the bun version "load-bearing for asset embedding, TLS, and
  secret storage."

What exists is `test/tls-helper.test.ts`: two unit tests over injected
`lookup`/`probe` fakes, exercising address-selection logic only. Both tests
substitute their own `probe`, so no socket is opened; the module's real probe
is in any case a plain `node:net` connect, so no TLS layer is involved in this
file at all, no certificate is inspected anywhere in the repo, and
`imap.gmail.com` is never contacted. Removing the workaround from a real imap
call site (there is none yet — mail is Plan 2) would turn nothing red.
[Correction, 2026-09-23: "mail is Plan 2" was wrong. Plan 2 deferred the
handshake for the whole plan
(`docs/superpowers/plans/2026-09-14-plan-2-first-light.md:362-363`, `:5545-5547`)
and shipped no mail provider; the Plan 3 spike took the measurement on
2026-09-23 — see "Measurement (2026-09-23)" below. There is still no
production call site: mail is the first.]
`src/net/tls-connect.ts` is imported by that test and by nothing else: it is
dead code today, and `resolveDualStack`'s doc comment overstates what its test
guards.

**Consequence, stated plainly: the `engines.bun >= 1.3.11` floor rests on two
of its three load-bearing questions, not three.** Asset embedding and
`Bun.secrets` were genuinely measured against a compiled binary. TLS was not
measured at all, so this ADR asserts nothing about 1.3.11's TLS behaviour, and
a future reader must not treat the floor as evidence that it works. Taking the
live handshake belongs to Plan 2's mail task; it was deliberately NOT rushed
into this correction, because inventing a measurement to make a document
consistent is the failure this correction exists to undo.

[Correction, 2026-09-23, to "Taking the live handshake belongs to Plan 2's mail
task": it did not happen there. Plan 2 deferred it for the whole plan
(`docs/superpowers/plans/2026-09-14-plan-2-first-light.md:362-363`, `:5545-5547`)
and the Plan 3 spike took it on 2026-09-23, below.]
[Correction, 2026-09-23, to "Consequence, stated plainly": with the measurement
below, the `engines.bun >= 1.3.11` floor now rests on three of three
load-bearing questions.]

**Measurement (2026-09-23).** Taken by the Plan 3 spike. The raw record is
untracked (`.superpowers/sdd/2026-09-23-plan-3/tls-spike-measurement.md` and
its `tls-spike/` logs, named below), so the numbers are copied here and the
script that regenerates them is committed as `scripts/tls-spike.ts`.

*Environment.* bun 1.3.11, with node v22.22.2 as the control, on the reference
machine at 2026-09-23T16:02:50Z with Mullvad connected and `IPv6: off` while
the host still holds an IPv6 default route (`env.txt`). That network REFUSES
IPv6, it does not blackhole it: a connect to either AAAA address gets
`ECONNREFUSED` at ~1 s (1023, 1024, 1035 ms under bun; 1022, 1087, 1038 ms
under node). DNS answered four addresses, AAAA first — for the runs tabulated
below `2a00:1450:400c:c1d::6d`, `2a00:1450:400c:c1d::6c`, `108.177.15.109`,
`108.177.15.108` (node's lookup had the two AAAA in the other order). The
answers rotate between runs (`74.125.206.x` in the strace and probe-cost logs,
`66.102.1.x` in unit 0a's run); the behaviour did not.

*Probes* (`bun-v3.log` / `node-v3.log`; one `tls.connect` to
`imap.gmail.com:993` per run, every run listed; ms from connect to the first
of the IMAP greeting or `error`):

| probe | bun 1.3.11 | node v22.22.2 |
|---|---|---|
| bare `tls.connect({host, servername})` ×3 | error `ERR_TLS_CERT_ALTNAME_INVALID`, no family, no address, cert null — 280, 255, 255 ms | ok, IPv4 108.177.15.109 / .109 / .108, cert 17 keys — 368, 369, 366 ms |
| `autoSelectFamily: false` ×2 | error `ECONNREFUSED` on the first AAAA — 1023, 1024 ms | error `ECONNREFUSED` — 1022, 1087 ms |
| `family: 4` ×2 | ok, IPv4 .109, 17 keys — 124, 113 ms | ok, IPv4 .109 — 129, 120 ms |
| custom lookup, A before AAAA ×2 | ok, IPv4 .109 — 118, 123 ms | ok, IPv4 .109 — 116, 116 ms |
| custom lookup, AAAA before A ×2 | error `ERR_TLS_CERT_ALTNAME_INVALID`, cert null — 255, 255 ms | ok, IPv4 .109 — 370, 361 ms |
| `autoSelectFamilyAttemptTimeout: 3000` ×2 | ok, IPv4 .109 — 1181, 1146 ms | ok, IPv4 .109 / .108 — 1148, 1145 ms |
| pinned to the first AAAA ×1 | error `ECONNREFUSED` — 1035 ms | error `ECONNREFUSED` — 1038 ms |
| pinned to the first A ×1 | ok, IPv4 .109 — 119 ms | ok, IPv4 .109 — 120 ms |
| `resolveDualStack`, then connect ×3 | ok, IPv4 .109 (picked .109) — 114, 112, 116 ms | ok, IPv4 .108 / .109 / .108 — 125, 122, 125 ms |

Every `ok` row, both runtimes: `authorized: true`, TLSv1.3, a certificate with
17 keys, subject CN `imap.gmail.com`, issuer CN `WR2`, SANs including the host,
valid to `Nov 27 08:06:04 2026 GMT`, and a greeting beginning `* OK Gimap ready
for requests from`. The family that answered in every successful case, both
runtimes: IPv4. The bare rows' error text under bun: `Hostname/IP does not
match certificate's altnames: Cert does not contain a DNS name`.

*The certificate at the error is `null`, not empty.* The record's summary table
printed `certAtErr:0` for the error rows because the script revision that
printed it folded null into a key count (`c ? Object.keys(c).length : 0`); the
raw JSON lines carry that as `certKeysAtError:0`. The committed
`scripts/tls-spike.ts` records the two separately, and its table prints
`certAtErr:null`: both runtimes return null before any handshake, so the
`ECONNREFUSED` rows print null too, and bun 1.3.11's distinctive shape is null
at an `ERR_TLS_CERT_ALTNAME_INVALID` error on a socket that is still `pending`.
Measured directly (`bare-null-bun.log`, one bare connect per attempt timer):
`certIsNull: true, certType: "object", certKeys: null, pending: true, remote:
null` at every error, and the error tracks the timer plus ~28 ms — timer 250 →
error at 278 ms, 500 → 529 ms, 700 → 729 ms; timer 3000 → `secureConnect` over
IPv4 at 1107 ms. Spec §7.3's "empty peer certificate" is this null.

*Reading.* When the attempt timer (`autoSelectFamilyAttemptTimeout`, 250 ms by
default) expires while the first address is still connecting, bun 1.3.11 raises
`ERR_TLS_CERT_ALTNAME_INVALID` on that still-pending socket with a null peer
certificate (`getPeerCertificate() === null`, `pending: true`) and never tries
the next address: `strace -f -e trace=connect` on a bare connect with the
default timer (`strace-bare.log`) shows exactly one TCP connect to port 993 —
`AF_INET6` to the first AAAA, returning `EINPROGRESS` — and no `AF_INET`
connect to 993 (the four port-0 connects are the runtime's UDP route probes for
address sorting). A connect error that arrives before the timer triggers the
fallback, and that fallback works (the 3000 ms rows: the ~1 s refusal arrives
first, then IPv4 succeeds). A reachable first address works (`family: 4`, the
A-first lookup, the pinned A). node 22 is unaffected: its bare connect falls
back on the timer and succeeds at 366-369 ms. The trap the bug needs is
therefore "first address still pending at 250 ms", not "first address
unreachable": a first address that fails fast (no v6 route, a local REJECT,
`::1` with nothing listening) falls back by error and the bare path works.
Mullvad with IPv6 off is the slow-failing shape.

*The workaround's cost.* `resolveDualStack` probes the candidates serially with
a 2 s-timeout plain TCP connect, so here both AAAA refusals (~1 s each) are
paid before the first A answers: `probe-cost-bun.log` 2086, 2111, 2113 ms and
`probe-cost-node.log` 2072, 2105, 2121 ms for the probe alone — ~2.1 s, three
runs each runtime — before a ~115 ms handshake. Acceptable for one connection
per account at a 60 s poll (spec §7.3); a parallel probe or a remembered winner
would remove it. Not changed by the spike: that is a mail-task decision.

*Consequence for the floor.* `engines.bun >= 1.3.11` stays, and now rests on
three of three load-bearing questions: 1.3.11 completes the handshake with the
workaround, every time, over IPv4. The workaround is MANDATORY on this version
wherever the first address fails slower than 250 ms — the bare path is broken
there, and the error blames the certificate. Spec §7.3's "must fail if the
workaround is removed" is met only where that trap exists: there, unit 0a
measured the handshake test going red with the workaround mutated out
(`ERR_TLS_CERT_ALTNAME_INVALID`). Elsewhere the same test is a plain handshake
test, the bug pin skips with a visible reason, and removing the workaround
turns nothing red. The workaround stays because the reference machine, and any
network that fails IPv6 slowly, hit the trap.

*Retirement procedure.* The bug pin going red on bun X means: raise
`engines.bun` to X, move `.github/workflows/ci.yml`'s `bun-version` and the
verify-gate literals with it (ADR 0003 (b): the pin equals the floor), then
delete `resolveDualStack`; the handshake test keeps guarding the certificate.
A red bug pin has two readings, and the test prints which: a success at
~timer + handshake (a few hundred ms) means this bun now tries the next address
after the timer — the fix; a success at ~refusal + handshake (~1 s here) means
the first address failed before the timer and the fallback was error-driven —
the trap probe misjudged the environment, not a fix. The test samples the trap
itself at `SAMPLE_MS = 400` (margin over the runtime's 250 ms, because the
sample and the test are separate connects) and skips when the first AAAA is
not still pending; that margin is not itself mutation-guarded — on a network
whose first address fails slower than 250 ms, cutting it to 0 changes only the
label.

*Reproduction.* `bun scripts/tls-spike.ts` and `node scripts/tls-spike.ts`
(eighteen probes each; the table above, regenerated); `ATRIUM_LIVE_TLS=1 bun
test test/tls-live.test.ts` — "resolveDualStack then tls.connect to
imap.gmail.com:993 yields a non-empty, authorized peer certificate for the
host" (spec §7.3's integration test) and "bug pin: on this bun a bare
tls.connect whose first address is still pending at the 250 ms attempt timer
fails with ERR_TLS_CERT_ALTNAME_INVALID and a null peer certificate — retire
resolveDualStack when this goes red on a newer bun". Without the variable both
skip, and "the suite skips exactly the two opt-in live TLS tests, and that file
exists" pins that they are the suite's only skips: `bun run verify` is 338 pass
/ 2 skip / 0 fail across 340 tests in 24 files; with the variable, 340 pass / 0
skip. Committed by Plan 3 unit 0a: `720b9ff` (the script, the live test,
`resolveDualStack`'s corrected doc comment), `1c2cac6` (the skip pin),
`fdf7cff` (fix round: the sample margin named, the timing in the bug pin's
message).

*Upstream.* oven-sh/bun#31950 (closed unmerged 2026-09-05, superseded by
#41447) is adjacent — it relabels fetch-client handshake resets that were
reported as certificate errors — and is not this bug (node:tls, attempt-timer
expiry, null peer certificate); #41447 not examined; not filed.

## Decision
`engines.bun` floor is `>=1.3.11` (the version installed on this machine).
The 1.4.2 candidate mentioned in the brief was never tested — network access
to a newer bun release was not attempted, per the standing instruction not to
run `bun upgrade`. 1.3.11 is capable of everything this skeleton requires
*provided* the asset-embedding fallback below is used in place of
`bun build --compile --asset`.

## Consequences

**The 1.3.11 fallback was taken.** `bun build --compile --asset <dir>` is not
supported. `scripts/gen-assets.ts` is therefore **PERMANENT, not temporary**:
it scans `web-dist/` and generates `src/generated-assets.ts`, one
`import assetN from "<file>" with { type: "file" }` per dist file, exported as
an `ASSET_PATHS: Record<url-path, disk-path>` map. `src/server/routes.ts`
builds its route table from that map (`Bun.file(diskPath)` per entry) rather
than from `Bun.embeddedFiles` directly, because on 1.3.11 an embedded `with { type:
"file" }` import is renamed to a flattened, content-hashed filename inside the
binary (e.g. `sub/style.css` → `style-5zbvvaxz.css`, no subdirectory, a
different hash than Vite's own) — verified empirically with a throwaway
two-file probe. `embeddedFiles.length` is still valid as the DCE-detection
signal (a count), but `embeddedFiles[i].name` cannot be used to reconstruct
the original request path, so index.html's own `/assets/index-XXXX.js`-style
references are matched by URL through the generated manifest instead. Every
dist file needs a generated `with { type: "file" }` import that is referenced
at runtime (`ASSET_PATHS` is read entry-by-entry to populate the route map),
or dead-code elimination drops it silently and the release build serves a
blank page. **A later upgrade to bun 1.4.x could retire `gen-assets.ts`** in
favor of `--asset` directly, once that flag is confirmed present via
`bun build --help` (not just a version-number check, since this flag's
silent-failure mode means the version number alone is not proof).

The generated file also needs `// @ts-nocheck`: bun-types' `declare module "*"
with { type: "file" }` (typing every such import as `string`) only resolves
under TypeScript 7.1's newer import-attribute-first module resolution. This
repo runs TypeScript 5.x (`^5`, pinned by the brief), which falls back to
extension-based ambient declarations instead — `*.html` typed as `HTMLBundle`,
`*.css`/`*.js` with no declaration at all — misdescribing every import in the
generated file even though bun's own bundler resolves the "file" loader
correctly (proven by the packaging assertion actually serving the content).
`bun run scripts/gen-assets.ts && bunx tsc --noEmit` is clean with the
suppression in place; without it `tsc --noEmit` fails on the generated file on
every regeneration.

**Correction 2 (2026-09-14, final whole-branch review).** The sentence above
was written at Task 1 and was true then. It stopped being true somewhere in
the following five tasks: by the end of the branch `tsc --noEmit` reported 5
errors — 4 in `test/actions.test.ts`, 1 in `test/auth.test.ts`, all from the
deliberately enabled `noUncheckedIndexedAccess`, none in `src/`, and none in
the generated file this paragraph is about. The claim was therefore still
accurate about the `@ts-nocheck` suppression and inaccurate as a statement
about the repo.

The reason the regression survived five tasks is that **nothing ran the
command.** There was no `test` script and no `typecheck` script in
`package.json`, so neither the suite nor the typecheck ran for anyone who
cloned the repo. Both errors are fixed and both scripts now exist
(`bun run typecheck` = `gen:assets` then `tsc --noEmit`, which is this
paragraph's command with the prerequisite wired in). The claim is true again
*and* enforced by something a contributor can run — but note that no CI
executes either script, so enforcement is still local-only; §5.1's "CI pins
the same version" and §10's "fails CI" both assume a CI that does not exist
in this plan.
[Correction, 2026-09-23: CI exists. `.github/workflows/ci.yml` — one job,
`oven-sh/setup-bun@v2` pinned to `bun-version: 1.3.11`, `bun run verify` —
since `f35c2f9` (ADR 0003 (b)). Its first run did not execute: GitHub refused
to start the job on the account's billing state before any step ran, so no
step of `ci.yml` has yet run on a runner and the first real run's result is
still owed to ADR 0003 (e) (`docs/decisions/0003-verify-gate-and-dev-loop.md:242-257`).]

**Three bugs were found and fixed in the brief's verbatim `scripts/assert-package.ts`.**
The first two are load-bearing for a correct measurement rather than a false
pass/fail; the third is a robustness gap on a failure path this run never hit:
1. `Bun.spawn([BIN, ...], { cwd: '/tmp' })` resolves a relative `BIN` (the
   default `'./atrium'`) against the *child's* cwd, not the caller's — so the
   literal script as written throws `ENOENT: posix_spawn './atrium'`
   regardless of whether the binary was built correctly. Fixed by resolving
   `BIN` with `node:path`'s `resolve()` before spawning.
2. The utility-detection check `text.includes('padding:1rem')` never matches
   tailwindcss@4.3.3's actual output. Tailwind v4's spacing scale emits
   `padding:calc(var(--spacing) * 4)` for `p-4` (backed by a single `--spacing`
   custom property, confirmed present in the served CSS as `--spacing:.25rem`),
   not a literal rem value. The check now accepts either form; the literal
   `padding:1rem` check is kept only as a fallback for a hypothetical future
   Tailwind release that reverts to fixed values. Without this fix the
   packaging assertion would fail on every correctly-built binary, which
   defeats its purpose (the assertion exists to catch DCE dropping assets or
   Tailwind emitting nothing — not to fail on healthy output).
3. The "binary never started listening within 5s" branch called
   `process.exit(1)` directly, which skips the `finally` block — so a genuine
   startup failure would leave `web-dist` permanently renamed to
   `web-dist.parked` and the spawned child orphaned, breaking every subsequent
   run of the assertion (and the dev build) until someone noticed and renamed
   it back by hand. Fixed by killing the child and restoring the parked
   directory in that branch too, before exiting.

**Keyring was available** (`keyring ok`) on this machine, so §8.5's 0600-file
fallback is not exercised by default here — but Plan 4's credential-store task
must still treat the keyring as optional, not guaranteed, since this result is
machine-specific (GNOME Secret Service via libsecret) and is not evidence for
any other environment. `Bun.secrets` has no internal timeout when the Secret
Service is present but unresponsive, so every call must stay wrapped in the
same `Promise.race` timeout used here (which does not cancel the underlying
call — a timed-out call can still complete or fail later, so callers must not
assume the raced-away promise is inert).
[Correction, 2026-09-23: not GNOME — KDE Plasma on Wayland, the Secret Service
served by ksecretd/KWallet (`busctl --user status org.freedesktop.secrets` →
`/usr/bin/ksecretd`, package `kf6-kwallet`; `gnome-keyring` not installed),
re-measured 2026-09-21 by the Task 10c review and recorded in
`docs/superpowers/plans/2026-09-14-plan-3-carry-forward.md` §2. The
machine-specific caveat stands as written.]
[Correction, 2026-09-23: "Plan 4's credential-store task" predates the current
plans. The adapter is owed by whichever plan first needs a stored credential
(carry-forward §2); under its §3 ordering that is not Plan 3's first provider.]

**Correction 3 (2026-09-14, final whole-branch review).** The paragraph above
named `src/skeleton.ts` as the module that builds its route table from
`ASSET_PATHS`. That file was deleted in Task 4 and no longer exists. Verified
rather than assumed: `ASSET_PATHS` is consumed in exactly one place,
`src/server/routes.ts`'s `loadAssets()`, which reads it entry by entry into a
`Map<urlPath, Bun.file(diskPath)>` that `serveAsset()` then serves from; the
name above has been corrected to point there.

One detail the old wording obscured and that matters for the DCE hazard this
whole section is about: `routes.ts` imports the generated module
**dynamically**, not statically, because the module is gitignored and does not
exist until `build:web && gen:assets` has run, and a static import would make
every unit test fail to load. That is still DCE-safe here only because `bun
build --compile` emits a single bundled output with no code-splitting, so the
generated module's own nested static `with { type: "file" }` imports are
embedded anyway. The end-to-end proof of that is the packaging assertion,
which serves real bytes out of the compiled binary from a foreign cwd — not
the import statement's shape.
