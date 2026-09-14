# Plan 1 → Plan 2 carry-forward

Everything Plan 1 (`feat/foundation`) knowingly left open, recorded here because the
working notes that produced it (`.superpowers/sdd/`) are gitignored scratch and were
deleted when the branch merged.

Plan 1 shipped at `450dc64`: 118 tests passing, `typecheck` clean, packaging gate hard
with no opt-out. Its final whole-branch review returned 0 Critical and 12 Important
findings; all 12 were fixed in one wave, plus a 13th added mid-wave. A scoped re-review
verdicted all 13 ADDRESSED with no new Critical/Important breakage and no scope
violations, after independently mutation-checking seven of the fixes.

The items below are *not* defects that slipped through. Each was found, judged, and
deliberately deferred with a written ruling.

## 1. Structural gaps — Plan 2 must close these

These are the reason the foundation is not yet a usable prototype.

- **The registry cannot be filled from outside `startServer`.** (Final review I5.)
  `src/server/serve.ts` constructs both the registry and the scheduler locally, and
  `ServeConfig` carries no `registry`, `providers` or `config` field. Plan 2 **must widen
  that signature** — this is not optional and not a comment fix. What is already live is
  everything downstream: `/api/state` and `POST /api/actions/:providerId/:actionId` serve
  whatever the registry holds, and a `call` action's cfg is read from the scheduler. Plan 2
  widens how the registry gets *filled*, not the routes.
- **The scheduler is never started.** (I6.) `scheduler.start()`, `stop()` and `onUpdate()`
  are uncalled in `serve.ts`. The scheduler is fully implemented and tested; it is inert
  because nothing turns it on. `configFor` *is* wired (it serves the action layer's cfg) —
  do not mistake that for the lifecycle being wired.
- **The handoff is unwired, so the assembled system has no way to authenticate.** (I7.)
  `mintHandoff`/`consumeHandoff` exist and are tested but no route calls them. Plan 4
  (`atrium open`) is the intended consumer; until then there is no end-to-end auth path.
- **`snapshot()` has no redaction seam.** `/api/state` serves provider state verbatim.
  Decide what providers may expose before the first provider ships real data.
- **No CI.** Nothing runs the suite, the typecheck or the packaging gate automatically.

## 2. Parked minors, with rulings

- **P1 — `src/core/actions.ts:86` comment claims the `error` event covers "no D-Bus". It
  does not.** *Measured:* with `systemd-run` present but no user bus, it exits 1 and emits
  no `error` event, so the fallback never fires and the action is a **silent no-op**
  (before the fix it was a double-launch). The keying is exactly what review I1 mandated,
  so the code stands — but **Plan 2 should decide the no-bus behaviour deliberately.** This
  is a real behaviour change wearing a comment's clothes.
- **P2 — `bun run typecheck` fails on a fresh clone.** It chains `gen:assets`, which does
  `readdirSync('./web-dist')`; `web-dist` is gitignored, so a clean checkout gets an ENOENT
  stack trace. The script's friendly "did you run the vite build first?" message only fires
  for an existing-but-empty directory. One-line fix (chain `build:web`, or guard). **Whoever
  sets up CI hits this first.**
- **P3 — the test suite litters `/tmp`.** `test/rungit.test.ts` creates seven `mkdtemp`
  directories per run with no `afterAll` (`test/actions.test.ts` does clean up). The two
  hijack tests deliberately drive the `rungit.ts` fallback, so `/tmp/atrium-nohooks-*`
  reappears. The *production* leak is genuinely fixed — that was the finding — but the test
  hygiene class is pre-existing and larger (`atrium-fix-` from `test/fixtures/gitrepo.ts`
  dominates). Worth one cleanup pass.
- **P4 — `test/rungit.test.ts` symlink-hijack test asserts only two negatives.** If the probe
  child fails to start, stdout is empty and both `not.toBe` assertions pass vacuously. Its
  sibling test is guarded by `expect(existsSync(used)).toBe(true)`; this one should be too.
  It *does* fail under the real mutation, so it pins today — the gap is robustness.

## 3. Test-integrity warnings — read before trusting coverage

**Two tests in this suite cannot fail. Do not count either as coverage.**

- `test/rungit.test.ts` — *"the hook-free directory is 0700 and owned by us"*: `mkdirSync`
  yields 0700 with or without the ownership check. Superseded by the two hijack tests; it
  is now a smoke test.
- `test/actions.test.ts` — *"neither spawn failing throws into the caller"*: removing the
  inner `bare.once('error', …)` surfaces an *asynchronous* unhandled error long after
  `expect(…).not.toThrow()` has returned. It asserts nothing about the handler it appears
  to guard.

Also: *"resolveGit searches the PATH it is given"* is supporting evidence, not a pin of the
hardcoded-PATH defect — it stays green under that mutation.

**Process note, earned the hard way.** Seven tests in this project have now been found
passing against a deliberately broken implementation — five during Plan 1's task loops, one
caught by the fix wave's own mutation check, one by the re-reviewer. **Mutation-check every
security-relevant test: revert the fix, watch the test fail, restore it.** A test that
cannot fail is worse than no test, because it is counted.

## 4. Security notes

- **The runtime git guard is a name check.** `buildArgv` rejects `cmd === 'git'` (and paths
  ending `/git`), so `{ cmd: '/usr/bin/env', args: ['git', …] }` slips past it. The widened
  static tripwire catches a quoted `'git'` in any `src/` file, so both halves together cover
  the realistic case. Consistent with the module's own "tripwire, not a proof" stance — but
  know the boundary.
- **`resolveGit()` runs a `Bun.which` PATH scan on every `runGit` call.** A deliberate trade
  at Plan 1's call volume. **Plan 2's per-repo polling multiplies it** — measure before
  shipping the git provider.
- **The hooks-directory ownership check verifies uid *and* mode, but only the mode and
  `isDirectory` halves are pinned.** Testing the uid half needs a second local user.
- **`--no-optional-locks` is a pre-subcommand global option.** It lives in `runGit`'s
  hardening prefix because `runGit`'s contract (`args[0]` must be the subcommand) gives
  callers no way to pass it. Do not try to supply it from a call site.
- **`M8` — `test/auth.test.ts`'s test titled "rejects a missing header, a wrong scheme, and a
  wrong token" has no wrong-scheme case.** Named in its own title. Real, small, unfixed.

## 5. Architectural facts worth not rediscovering

- `src/server/routes.ts` imports the generated asset module **dynamically**. It has to:
  `src/generated-assets.ts` is gitignored and absent until `build:web && gen:assets` runs, so
  a static import breaks every unit test. This stays dead-code-elimination-safe only because
  `bun build --compile` emits a single bundle with no code-splitting, and the packaging
  assertion serving real bytes is the proof. Do not "tidy" it into a static import.
- `docs/decisions/0001-bun-version.md` carries three dated corrections. The dual-stack TLS
  peer-certificate behaviour was **never measured** — only unit-tested over injected fakes.
  The `engines.bun` floor rests on the other two measurements. If that guarantee ever needs
  to be load-bearing, take the real measurement first.
