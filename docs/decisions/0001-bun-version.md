# 0001 — Bun version floor

**Date:** 2026-09-13
**Status:** Accepted

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
- dual-stack TLS helper unit tests: pass (`2 pass, 0 fail, 4 expect() calls`)

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
an `ASSET_PATHS: Record<url-path, disk-path>` map. `src/skeleton.ts` builds its
route table from that map (`Bun.file(diskPath)` per entry) rather than from
`Bun.embeddedFiles` directly, because on 1.3.11 an embedded `with { type:
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
