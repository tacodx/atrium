# 0003 — The verify gate, CI, the dev loop, and the gate-widening prohibition

**Date:** 2026-09-21
**Status:** Accepted

Every number below was measured on the reference machine (bun 1.3.11) at the commit named beside it. Where
this record corrects the plan's text (`docs/superpowers/plans/2026-09-14-plan-2-first-light.md`, Task 10), it
says so.

---

## (a) The verify chain, and why it exists

```
"verify": "bun run build && bun run assert:package && bun run test && bun run typecheck"
```

`assert:package` is defined in `package.json` and, before this task, had **no caller anywhere**: no `pretest`,
no `prepublish`, no `.github/` directory. Every packaging demand in `scripts/assert-package.ts` was
unenforced and would first have surfaced at release: the embedded-asset count against the dist count, `/` and
both hashed assets returning 200 with the right content-type, the JS not being a development build, the
`execLine` `$bunfs` check, and the Tailwind canary.

Order is load-bearing: `build` produces `./atrium` and `./web-dist`, which `assert:package` consumes (it
renames `web-dist` away, runs the binary from `/tmp`, and restores the directory in a `finally`).
`test/verify-gate.test.ts` pins the chain by exact equality, so a dropped or reordered stage goes red.

**Citations in `scripts/assert-package.ts`** (the file moved in this task, so both are given):

| What | at 5f15053 | at this ADR's commit |
|---|---|---|
| Tailwind canary check | `:126-131` | `:173-178` |
| its rationale (v4 emits `calc(var(--spacing) * 4)`) | `:119-125` | `:166-172` |
| the "gate that went vacuous" history | `:102-110` | `:149-157` |
| the two unmatched-href/src failures it produced | `:111-112`, `:134-135` | `:158-159`, `:181-182` |

**Correction to the plan.** The plan said the `p-4` canary was unenforced. The `p-4` *source literal* has been
pinned by `bun test` since Task 9 (`test/repos-pane.test.ts`, "main.tsx still contains the literal p-4 the
packaging gate depends on"). What was unenforced before this task was the *built-CSS emission check* and the
rest of the list above.

**A vacuous pass, found and closed here.** Measured by the Task 10a pre-flight at 5f15053: with a healthy
atrium already listening on 7373 and `./atrium` replaced by a stub that exits 1, `bun run assert:package`
printed `packaging ok` and exited 0 — it never checked that the `/healthz` it polled belonged to the child it
spawned. The script now rejects a `/healthz` whose `pid` is not `proc.pid`, and fails if the child has already
exited, with a message naming the foreign listener. `test/verify-gate.test.ts` pins each check with its own
test, against a stub binary and a temp web-dist. The pid check: a stub that stays alive and never binds, with
a *convincing* decoy on 7443; the run must fail with `is not the spawned binary's pid`. With that check
deleted, the decoy run prints `packaging ok: 3 of 3 assets embedded…` — the original vacuous pass,
reproduced. The exit check: a stub that exits at once with nothing on 7444; the run must fail with
`exited (code 1) before it could be tested`. (Fix round F1: the first version had one test, whose stub
exited, asserting only `foreign listener` — a substring the exit check's message also carries, so it stayed
green with the pid check deleted. Deleting either check alone now reddens only its own test.) A third test
runs the measured scenario itself — a stub that exits 1 while a convincing decoy answers on 7442 — and
asserts only the outcome: a non-zero exit and no `packaging ok` on stdout, with no message substring. (Fix
round 2: after F1's split nothing ran that scenario, and making the pid check stand down once the child had
exited and the exit check stand down once something had answered kept both isolated tests green while the
scenario printed `packaging ok`.) Since fix round 3 that test runs twice, with a stub that exits **0** (on 7445)
and one that exits 1 (on 7442): a pid check that stands down once the child has exited plus an exit check
that ignores code 0 kept every test green while an exit-0 stub — a compiled `serve` that falls off the end —
with a decoy printed `packaging ok`. With the pid test (stub alive) and the exit test (no listener), the stub
space {alive, exits 0, exits non-zero} × {decoy, none} is covered: a closure, not another rule.

**Correction to the plan.** The plan warned that a dev server left on 7373 makes the gate fail with
`binary never started listening within 5s`. Measured by the pre-flight at 5f15053, that was wrong: with a
source-run server on 7373 the script *reached* that server and failed blaming `DCE dropped assets` (a source
run embeds nothing), and with a compiled one it passed. After this task, both cases fail with
`a foreign listener answered on port 7373 (its /healthz pid … is not the spawned binary's pid …)`.

**Hermeticity, also closed here.** The child inherited the operator's `XDG_RUNTIME_DIR`. Measured at
5f15053 with a stand-in server on 7441: `assert:package` overwrote that server's `endpoint.json` and
`handoff.json`, and its killed child then deleted both, so `atrium open --print-url` exited **69** ("no
handoff file found — is the server running?") while the server was running. The child now gets temp `HOME`,
`XDG_CONFIG_HOME` and `XDG_RUNTIME_DIR`, removed in the `finally` after the child is killed and reaped. After
the fix, the same measurement leaves both files intact and `open --print-url` exits 0. Every other source-run
`serve` spawn in the suite got a temp `HOME` in the same pass, and a structural test in
`test/verify-gate.test.ts` checks all ten.

**What that structural test catches, and what it is not.** It walks the TypeScript AST of `test/` and
`scripts/`. Its strict matcher finds `Bun.spawn` / `Bun.spawnSync` calls whose first argument is an array
literal with a `'serve'` element, and pins their number at ten. For each one it resolves `env` (an inline
object literal, a shorthand `env`, or an identifier bound to an object literal) and requires `HOME`,
`XDG_RUNTIME_DIR` and `XDG_CONFIG_HOME` each to be set after the last spread to one of: a `mkdtempSync(…)`
call, a variable declared with `const`, `let` or `var` whose *initializer* is (or chains to) one — the
analysis reads the initializer only and never looks for a later reassignment — a call to a top-level helper
in the same file that returns such a value on every path (a body that can run off its end fails), or a property of such a helper's returned object literal
that is set from one (`scratchConfig(…).XDG_CONFIG_HOME`). Those are the shapes this repo uses. The loose
count is a separate, cruder scan: every `Bun.spawn` / `Bun.spawnSync` call whose source text contains the word
`serve`, plus every quoted `'serve'` outside such a call. It must equal the strict matches file by file. It
exists so that a *new* spawn shape — argv built in a variable, spread from a split string, a `sh -c` line —
makes the two counts disagree loudly instead of passing unseen. The two scans do not cover the same files:
the loose count skips `test/verify-gate.test.ts` itself (it names both `serve` and `Bun.spawn`), while the
strict count includes it and finds nothing there.

This is a tripwire for the shapes in the tree, not a proof of hermeticity: a determined author can always
write a server spawn a static scan does not see. Known limitations, recorded and deliberately not fixed:

- **A command string moved out of the call** (`const CMD = 'serve --port 7445'`, passed in by name) is
  invisible to both scans: the call's text no longer says `serve`, and the string is not exactly `'serve'`.
- **argv split/joined into a variable** (`const argv = s.split(' ')`) is invisible to the strict matcher and
  caught, if at all, only by the loose count.
- **`let` reassignment after a temp-dir initializer** (`let h = mkdtempSync(…); h = homedir()`) passes: the
  analysis reads the initializer only. Proven by mutation at `test/repos-pane.test.ts`; no such reassignment
  exists in the tree.
- **Parameter, `catch` and `for-of` bindings** are not variable statements, so the resolver cannot see them
  and a value bound that way fails closed (it is never accepted as a temp dir).
- **The loose count excludes `test/verify-gate.test.ts`**, so a server spawn written into this test file
  itself is checked by the strict count alone.

From fix round 2 on, a finding of the form "the analysis misses yet another spawn or helper shape" is recorded as a known limitation, not fixed, unless that shape
already exists in the repo. A coverage regression, a hole in a pin that is not part of the analyzer (the
chain, the stages, CI, the bun pin, assert-package's own-child checks), or a shape present in the tree still
gets fixed.

## (b) The CI pin

`.github/workflows/ci.yml`: one job on `ubuntu-latest`, `oven-sh/setup-bun@v2` with `bun-version: 1.3.11`,
`bun install --frozen-lockfile`, `bun run verify`. The pin must equal `engines.bun`'s floor (`>=1.3.11`, ADR
0001); `test/verify-gate.test.ts` extracts both with line-anchored regexes, asserts both matched (the
anti-vacuity step), and asserts they are equal. It also rejects `continue-on-error` and any step-level `if:`,
either of which would let a red `verify` pass the job. Since fix round F4 it also requires `push:` and
`pull_request:` triggers under `on:` (so CI cannot quietly become manual-only), and exactly one
`oven-sh/setup-bun` and one `bun-version` (a second, unpinned setup-bun step would otherwise override the pin).
Since F3, `typecheck` must contain `tsc --noEmit` and `build` must run both `build:web` and `build:server`.
Since fix round 2, `tsc --noEmit` must also be `typecheck`'s last command, with no `||`, `;` or lone `&` in the
script: `… tsc --noEmit || true` had printed TS2322 and exited 0.

**Exact pins, since fix round 3.** Every round of Task 10a found a new way to hollow a script or the
workflow past a contains/ends-with/regex rule — `vite build || true`, a new `pretest` lifecycle hook, a
step-level `shell: bash {0}` (which drops `-e`), a second setup-bun step spelled with YAML escapes
(`"oven-sh\/setup-bun@v2"`, `"bun\x2dversion"`) that no substring count sees. So
`test/verify-gate.test.ts` now also pins **package.json's whole `scripts` object** with `toEqual` against a
literal, and **the whole of `.github/workflows/ci.yml`** against a literal (only a trailing newline is
normalised). Every script in that object is in `verify`'s chain, directly or through a sub-script
(`gen:assets` via `build:server`), so nothing unrelated is pinned. The shape tests stay: their failure
messages say *why* each part matters; the exact pins make them un-evadable. **The consequence for a
maintainer: any edit to `scripts` or to `ci.yml` now fails `verify-gate` until the literal in the test is
updated in the same commit.** That is deliberate friction, because every round of this task found a new
way to hollow one of them.

**Deviation from the plan: `actions/checkout@v5`, not `@v4`.** `actions/checkout@v4`'s `action.yml` declares
`using: node20`; GitHub's changelog "Deprecation of Node 20 on GitHub Actions runners" (2025-09-19,
github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners) states runners default to
Node 24 from 2026-06-16 and **Node 20 is removed on 2026-09-23**. `v5`'s `action.yml` declares `using: node24`
(its only change from v4, per the v5.0.0 release notes). `oven-sh/setup-bun@v2`'s `action.yml` already
declares `using: "node24"`, so it stays. Both read from the actions' own repositories on 2026-09-21. v6 and v7
also exist (credential-persistence and ESM changes); v5 is the smallest step off node20.

**What CI measurably relies on from the runner** (this replaces the plan's "CI needs nothing else from the
runner", which was too strong):

- **git at `/usr/bin/git`** — the only PATH entry `test/fixtures/gitrepo.ts`'s `CLEAN_ENV` exposes. The
  ubuntu-latest image ships 2.55.0 (git-core PPA); the pre-flight also passed the suite on apt's 2.43.0.
- **`XDG_RUNTIME_DIR` unset, or a writable user-owned directory.** The stable-hooks-dir test in
  `test/rungit.test.ts` needs it; measured unstable when it is set but unwritable. The image sets
  `/run/user/1001`.
- **Node ≥ 22.12 for vite** — `vite`'s bin runs under node when node exists. The image ships 22.23.2.
- **No global git config** — `makeRepo()` supplies its committer identity inline.
- **No user D-Bus** — `test/actions.test.ts` uses a fake launcher standing in for `systemd-run`.

## (c) The dev loop

```
bun run build:web && bun run gen:assets && bun run src/index.ts serve --port 7444
```

Measured at `c8dd615`/`6281c07` (tree identical for these files): `build:web && gen:assets` **1.47 s** wall;
the source-run server then serves `GET /` as **200 `text/html;charset=utf-8`** and the hashed CSS as **200
`text/css;charset=utf-8`**, by curl against `127.0.0.1:7444` with the `Host` header the gate requires. This
works because `src/server/routes.ts`'s `loadAssets()` imports the generated manifest dynamically and maps each
entry to `Bun.file(diskPath)`; under a source run those are the real `web-dist/` files. UI iteration costs a
~1.5 s rebuild and a server restart, not a ~99.6 MB compile.

**Hermetic variant.** A source-run `serve` reads `$XDG_CONFIG_HOME/atrium/config.json`, writes
`$XDG_RUNTIME_DIR/atrium/{endpoint,handoff}.json`, and scans the real `$HOME` for repos on start. To iterate
without touching any of that:

```
H=$(mktemp -d); HOME=$H XDG_CONFIG_HOME=$H XDG_RUNTIME_DIR=$H bun run src/index.ts serve --port 7444
```

**"You forgot `gen:assets`" — corrected.** The plan said this looks like a blank page with 200s on `/api/*`.
Measured with `src/generated-assets.ts` absent: `GET /` → **401** `unauthorized` (`text/plain`), `/api/state`
→ **401**, only `/healthz` → **200**. With no manifest entry for `/`, the request falls through to the
bearer-gated routes. The pre-flight measured the same shape for every asset under a *stale* manifest. The
manifest is gitignored, so `gen:assets` must be re-run after every `build:web`.

## (d) Standing prohibition: do not widen the request gate for a dev server

**Widening `src/server/gate.ts`'s origin allowlist, its Host check or its `Sec-Fetch-Site` check to
accommodate a Vite dev server (port 5173) is forbidden. So is a dev-server proxy in front of it.**

`src/server/gate.ts:5-7`, word for word:

> Spec §8.2. Do not add a bypass — one unchecked route is full RCE, which is
> exactly how MCP Inspector (CVE-2025-49596) and Nuxt Devtools
> (CVE-2024-23657) were compromised.

gate.ts forbids *a bypass*; that a dev-server allowance is such a bypass is this ADR's reading, not something
gate.ts says by name.

Measured at `6281c07` against a source-run server on `127.0.0.1:7444`, all **403** `forbidden`:

| Request (correct `Host: 127.0.0.1:7444` unless stated) | Rejected by |
|---|---|
| `Origin: http://localhost:5173` | origin allowlist |
| `Sec-Fetch-Site: same-site`, no `Origin` | `Sec-Fetch-Site` check |
| `Sec-Fetch-Site: cross-site`, no `Origin` | `Sec-Fetch-Site` check |
| `Host: localhost:5173` (a proxy that forwards the browser's Host) | Host allowlist |

A direct cross-port fetch from a page on 5173 carries both an `Origin` and `Sec-Fetch-Site` — `same-site`
when the hostnames match, `cross-site` otherwise — and both values are rejected, so **for a direct fetch both
checks would have to be weakened**. A Vite `server.proxy` is different, and worse. In its usual copy-paste
form, `changeOrigin: true`, the proxy rewrites `Host` to the target's, so the Host check passes. The page and
the proxied path are then both on 5173, so a GET from the page is same-origin: the browser sends no `Origin`
and `Sec-Fetch-Site: same-origin`, which `src/server/gate.ts:34` allows. **Every GET through such a proxy
passes the gate**, with no gate.ts edit at all; only requests that carry an `Origin` (a POST, for one) are
still rejected, by the origin allowlist. (Without `changeOrigin`, the forwarded `Host: localhost:5173` trips
the Host check, as in the table.) So the read side of the gate is defeated by proxy configuration alone,
and **the prohibition must cover proxy configuration** — a `server.proxy` entry, in any form — not only
edits to gate.ts. The supported loop is the ~1.5 s rebuild in (c).

`scripts/assert-package.ts` uses `fetch`, never a browser, so it can structurally never observe a CSP
violation. That is why ADR 0002 Ruling D (Tailwind classes only, no `style={{}}`) is a ruling rather than a
check.

## (e) The residual: CI goes live on the next push

The plan said the repo had no remote. That is no longer true: `origin` is `github.com/tacodx/atrium`
(private, Actions enabled, all actions allowed, no workflows before this task). This task does not push;
**the next push executes `ci.yml` for the first time.** The evidence it will pass is the Task 10a pre-flight's
container run: all four gates plus `bun install --frozen-lockfile` green at 5f15053 as uid 1001 in
ubuntu:24.04, checkout inside `$HOME`, `XDG_RUNTIME_DIR` unset, with git 2.43.0 and 2.55.0, under 4/2/1 CPU
limits — 13 `bun test` runs, 287/0 every time. That run predates this task's edits and did not exercise the
node24 checkout. **The first real run's result is to be recorded here when it happens.**

## (f) Carry-forward P4 — closed

`test/rungit.test.ts`'s `'a symlink standing in for the hooks directory is refused, not followed'` now also
asserts the returned directory exists and is not group- or world-writable. Its two original `not.toBe`
assertions pass vacuously when the probe child fails to start (`hooksDirUnder()` returns `''`). Measured by
pointing the probe's import at a nonexistent module inside `hooksDirUnder()` only: 22 pass / 2 fail in that
file — the repaired test fails at the new `existsSync` line (`:274`), after both `not.toBe` lines
(`:269-270`) passed, and its sibling fails at its own existing `existsSync` guard.

## Reference numbers

| | 3a0491e (plan) | 5f15053 (10a baseline) | 6281c07 (this task) |
|---|---|---|---|
| `build` | 1.44 s | 1.53 s | 1.50 s |
| `assert:package` | 0.16 s | 0.21 s | 0.16 s |
| `test` | 1.43 s (118 tests) | 7.10 s (287 tests) | 7.36 s (293 tests) |
| `typecheck` | 2.76 s | 3.44 s | 3.38 s |
| binary | 99,537,944 B | 99,581,508 B | 99,581,508 B |

`bun run verify` end to end at `6281c07`: exit 0, **12.4 s** wall, 293 pass / 0 fail / 929 expect. Per-stage
times are each stage run on its own immediately afterwards, the same four commands in the same order.
