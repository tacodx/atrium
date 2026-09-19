# Atrium — Design

**Date:** 2026-09-13
**Revision:** 2 — revised after adversarial validation (see §14)
**Status:** Approved
**Working name:** Atrium (provisional — see §11)

---

## 1. Problem

Local work state is scattered. Which repos have uncommitted work rotting in them,
whether today's daily note exists, what came into the inbox, how much of the Claude
rate-limit window is left — each lives in a different app, and none of them is
answerable at a glance.

Every existing dashboard solves the *internet* version of this problem. None solves
the local one.

## 2. Prior art and the gap

| Tool | What it is | Why it doesn't cover this |
|---|---|---|
| Glance | Go, web, self-hosted. The polished 2026 default. | Feed aggregator: RSS, Reddit, HN, weather, Docker. No knowledge of local work. |
| wtfutil | Modular terminal dashboard (Gmail, Calendar, GitHub). | Closest in spirit; development has gone quiet. |
| Emeraldian, Basalt, Folio, Obsidian CLI (v1.12, Feb 2026) | Vault TUIs and the official CLI. | Single-source. Obsidian only. |
| Homepage, Dashy, Homarr | Homelab service dashboards. | Bookmarks with uptime dots. Not personal work state. |

**The gap:** nothing aggregates local work state, and nothing lets you *act* on it
from one surface.

## 3. Core job

A **command center**, not a status wall. The user does not merely read it — they act
from it: open a repo in an editor, create today's note from a template, capture a
thought, triage mail. Keyboard-driven, one surface.

This is a deliberate choice against the "ambient status wall" framing. Read-only
dashboards get built, admired twice, and abandoned.

## 4. Non-goals

Explicitly out of scope, not deferred-by-accident:

- **Phone / LAN access.** Requires binding beyond loopback, which requires real auth
  (§8). Excluded from v1.
- **npm-loaded third-party plugins.** The provider contract is an internal seam, not
  a dynamic plugin runtime.
- **Electron.** Never. Electron's GPU fault on Wayland/amdgpu has already corrupted
  this developer's desktop once via VS Code.
- **A native desktop shell.** Parked, with findings recorded — see §12.
- ~~Keyring integration~~ — **reversed from revision 1**, where it was a non-goal on
  cost grounds. `Bun.secrets` ships in the runtime, needs no dependency, and works in
  a compiled binary, so the cost argument was simply wrong. It is now the preferred v1
  credential store (§8.5), with a `0600` file as fallback.
- **"Waiting on you" mail triage.** Deferred to its own post-v1 task; it cannot be
  planned honestly until a live-credential spike settles Gmail's Sent/Inbox split
  (§7.3).

## 5. Architecture

```
  ┌──────────────────────────────────────────────────────────┐
  │  core  (bun, single process, systemd user service)       │
  │                                                          │
  │   registry ──┬─ git       2 schedules: discovery + meta  │
  │              ├─ obsidian  poll + fs watcher              │
  │              ├─ mail      poll                           │
  │              └─ claude    poll, read-only credentials    │
  │                                                          │
  │   scheduler   named schedules, independent intervals     │
  │   actions     declared allowlist: exec | call            │
  │   runGit()    the ONLY path to git. Hardened. §8.6       │
  │   gate        Host/Origin chokepoint. HTTP + WS. §8.2    │
  │   http+ws     127.0.0.1 only, one port, Bearer token     │
  └───────────────┬──────────────────────────────────────────┘
                  │
          localhost:7373  ← web UI (browser tab or PWA)
```

**Data flow:** core starts on login → each schedule fires independently → state
pushed to the UI over WebSocket → UI dispatches actions via `POST /api/actions/:id`.

**Stack:** bun + TypeScript. React 19 + Vite + Tailwind v4 for the UI. Exact
versions and the palette-primitive choice are in §13. The UI contains **no**
shell-specific code — no `window.__TAURI__` branch, no shell API import — enforced by
a lint rule, so the page is identical in a browser tab and in any future wrapper.

### 5.1 Runtime version — settled first, by measurement

The Bun version is load-bearing for asset embedding, TLS, and secret storage, and it
is the first thing the implementation settles. **Candidate: bun >= 1.4.2.**
**Fallback: 1.3.11 plus an asset-codegen step.** Task 0 (§12) builds a walking
skeleton on the candidate and proves both `--asset` embedding and a dual-stack TLS
handshake before any provider is written. `engines.bun` is pinned to whichever
survives, and CI pins the same version.

## 6. The provider contract

Revision 1's contract was falsified by three of its own four providers. This is the
corrected shape.

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

**`toClient` is the redaction seam and it is required, not optional.** A provider's
`Data` is its own working shape and may hold anything it needs; `toClient` is the one
function that decides what leaves the process. It is applied in exactly one place — the
scheduler, where the same computed value feeds both the `/api/state` snapshot and the
WebSocket push — so there is no second site to keep in sync and no route that can bypass
it. Write it as an explicit field-by-field allowlist, never a spread with deletions: a
deny-list is correct until the next field is added to `Data`. Status and error values in
the returned object come from the closed set of declared codes (§7.4: `ok`, `stale`, `unavailable`,
`unsupported-shape`); a caught exception object, its `message` or its `stack` never
appears in `toClient`'s return value. `ctx.previous` and the scheduler's internal return value stay raw —
redaction is about the wire, not about the provider's own incremental state.

What `toClient` does not cover: `/api/state` serves an envelope per provider,
`{ data?, schedules }`, and only `.data` is `toClient`'s output. `schedules.<name>.lastErrorMessage`
is the scheduler's failure record — the thrown exception's `message`, stored by
`recordFailure` and served and pushed as-is. It is a separate, provider-controlled,
currently unredacted text channel, so a provider must never throw with `Data`, a path or
a credential in the message. Sanitizing or closing that channel is an open item (the wire
task, Task 6, or a plan-level ruling); this section does not claim it is closed.

Both kinds are declared and both go through the same static allowlist — `dispatch()` looks
an action up by id in the provider's own declared array and never indexes a function table
by a client-supplied name. `exec` actions take argv arrays only; `call` actions are static
functions. **There is no audit log.** Revision 1's text claimed one; nothing in `src/` has
ever written one, and the claim is withdrawn here rather than left standing as an unbuilt
promise. If one is wanted it belongs at `dispatch()` in `src/core/actions.ts` and deserves
its own plan.

One folder per provider: `src/providers/<id>/{index,config,actions}.ts`.

## 7. The four providers

### 7.1 git — projects

**Two schedules.** Discovery (the `$HOME` scan, rule application, container
classification) runs at startup and every 10 minutes. Metadata (per-repo git
commands) runs every 30s over the cached repo list. Revision 1 conflated these on
the strength of a mismeasurement: the real pruned scan costs **0.97–1.25s** single
threaded, and 4–5.6s unpruned. The 0.19s figure came from a `find` that was a shim
for a parallel implementation.

**Discovery rules.** Rule 1: drop repos under a dot-directory, and repos whose own
basename starts with a dot. Rule 2 from revision 1 — "drop repos nested inside
another repo" — is **wrong** and is replaced. Its only effect on the reference
machine was to hide all five `~/Projects/clients/*` repos, which are among the most
active work on it. Replacements:

| Case | Test | Result |
|---|---|---|
| Linked worktree | a file named `gitdir` inside `git rev-parse --absolute-git-dir` | drop |
| Submodule | `git -C <parent> ls-files -s -- <rel>`, field 1 == `160000` | drop |
| Vendored | `git -C <parent> ls-files -- <rel>` non-empty | drop |
| Container | `git -C <parent> check-ignore -q <rel>` exits 0 | **surface the child** |
| Ambiguous (untracked, unignored) | — | drop, overridable by `git.treatAsContainer` |

**Evaluation is first-match-wins in exactly that order**, because the rows overlap
with opposite results: a linked worktree at `worktrees/feat` inside a repo whose
`.gitignore` contains `worktrees/` matches both the worktree row (drop) and the
container row (surface), and an implementer who tests `check-ignore` first surfaces
every worktree as a project. A container's **parent is a repo too and also appears** —
on the reference machine `~/Projects/clients` has 38 tracked files of its own, so
parent and all five children belong in the list.

The classifier is a heuristic over a hand-written `.gitignore`, not a zero-config
rule, and two shapes defeat it. An umbrella repo with **no** `.gitignore` leaves its
children ambiguous, so they are dropped — the same silent loss revision 1 was
corrected for, recoverable only via `git.treatAsContainer`, which the user has no
reason to know exists. A repo that gitignores `deps/` and holds a clone there
surfaces that clone as a project. Both must be reachable from the UI: discovery
reports dropped-ambiguous candidates so first run can offer them, rather than
silently deciding.

A validity gate runs before any repo enters the list: reject 0-byte `.git` files,
dangling gitdir pointers, and anything where `git rev-parse --absolute-git-dir`
returns empty. Rule 1 needs a config escape hatch (`git.extraRoots`,
`git.includeDotPaths`) or every chezmoi/yadm/`~/.dotfiles` user is silently
unsupported.

**Metadata.** Two commands, not three:
`git --no-optional-locks status --porcelain=v2 --branch -uall` (branch + uncommitted
count) and `git log -1 --format=%ct` (last commit). `-uall` is deliberate: without it
the dashboard reports 8 when 47 files are untracked. Concurrency 8–16, a per-repo
timeout, and a slow-repo backoff — one reference repo costs 115ms every single run
because ~67MB of committed build artifacts are permanently modified.

**Repo state** is richer than a branch name:
`clean | detached | rebasing(branch, n/total) | merging | cherry-picking | reverting
| bisecting | empty`, read from git-path-resolved state files. A rebase recovers its
real branch from `rebase-merge/head-name`, never rendering as bare `(detached)`. An
empty repo has no last-commit time and must not surface as a provider error.

**Shows:** name, branch, state, relative time since last commit, uncommitted count.
Recent-first, with a "needs attention" group for repos whose last commit is older
than `git.staleDays` (default 30) **and** which carry uncommitted changes — both
conditions, because an old clean repo is finished, not rotting.

**Actions:** open in editor, open terminal at path, show diff, open a terminal
running `claude`. All `exec`, all through `runGit()` or the editor template (§8.6).

### 7.2 obsidian — daily note and capture

**Vault detection enumerates candidates; it does not find "the" file.** A user can
have native *and* Flatpak Obsidian with two different vault maps.

| Platform | Candidates, in order |
|---|---|
| Linux | `$XDG_CONFIG_HOME/obsidian/` if set, else `~/.config/obsidian/`; then `~/.var/app/md.obsidian.Obsidian/config/obsidian/` |
| macOS | `~/Library/Application Support/obsidian/` |
| Windows | `%APPDATA%\Obsidian\` |

Snap and AppImage hit the native Linux path; no special cases. Revision 1 hardcoded
`~/.config/obsidian/`, which **does not exist on the reference machine at all**.

`obsidian.json` is `{ vaults: Record<hex16, { path, ts, open? }> }`. Entries
accumulate for deleted and moved vaults, so every entry is stat'd and checked for a
config folder before counting. Rank `open === true` first, then `ts` descending —
`ts` is registration time, not last-opened. Obsidian rewrites this file while
running, so reads retry and keep the last good value rather than degrading to "no
vault found". The sibling `<hex>.json` is window geometry; ignore it.

**Daily-note settings**, in Obsidian's own precedence order:
1. `plugins/periodic-notes/data.json` when `settings.daily.enabled`
2. `daily-notes.json`
3. defaults `{format:'YYYY-MM-DD', folder:'', template:''}` — and when `folder` is
   empty, the parent comes from `app.json`'s `newFileLocation`/`newFileFolderPath`.

**Folder inference.** Revision 1 said "the directory most of them live in," asserted
it yields `00 Inbox` on the reference vault, and was wrong — `00 Archive` holds 4
date-named notes to `00 Inbox`'s 3, so the stated rule yields the archive. The rule
is **latest parsed date wins**, ties broken by count, excluding `.trash` (6 more
date-named notes, enough to flip the result), the config folder, and all
dot-directories. It returns `{folder, confidence: 'configured'|'inferred'|'unknown',
sampleSize}` so the UI can show that it guessed.

**Date parsing** uses `dayjs` plus `advancedFormat`, `weekOfYear`, `weekYear`,
`isoWeek`, `customParseFormat`, `localeData`. Every parse carries a **round-trip
guard** — `dayjs(base, fmt, true)` must be valid AND `parsed.format(fmt) === base` —
because dayjs's strict parser silently resolves unimplemented week tokens to *today*,
which would make "today's note exists" permanently true.

Obsidian localizes filenames through `window.moment.locale(<UI language>)`, so a
German user's notes are `Sonntag 13-09-2026`. That language lives in Chromium
localStorage, which Atrium **never reads** — it also holds the user's Obsidian
account token in plaintext, and reading LevelDB needs a native addon that dies under
`--compile`. Instead: a config key `obsidian.locale` (default `en`).

**Shows:** whether today's note exists, recent notes, and gaps in the last 7 days.
The gap count is the feature the round-trip parse guard above exists to protect — a
silent parse failure would report a perfect streak or a total absence, both wrong.

**Schedules:** a 30s poll, plus a filesystem watcher on the resolved daily-note
directory so a note created in Obsidian appears immediately. Nested date formats
(`YYYY/MMMM/YYYY-MM-DD`) grow a new subdirectory each month, so the watcher watches
the tree, and inference degrades to `confidence: 'unknown'` rather than guessing.

**Actions:** create today's note from a template (`call`), open a note (`exec`),
quick-capture appending to a configured file (`call`). Template resolution
reproduces both of Obsidian's branches (literal vault-relative path, then linkpath
search) and `{{title}}` / `{{date:…}}` / `{{time:…}}` expansion matches core exactly.
Quick-capture must be atomic and must tolerate Obsidian holding the file open.

### 7.3 mail

**Transport: IMAP with an app password.** This decision was challenged and survives —
Google's own migration documentation explicitly carves app passwords out, and the
"they die in 2026" reports trace to SEO blogs. It also keeps Fastmail, Proton Bridge
and self-hosted users first-class. The auth field stays polymorphic
(`{pass} | {accessToken}`) from day one, since `imapflow` already accepts both, so a
future policy change is a credential-acquisition change and not a rewrite.

**Library:** `imapflow@^2.0.2`. node-imap, emailjs-imap-client and imap-simple were
all last published in 2022 and are not candidates.

**The dual-stack TLS trap.** Bun 1.3.11's `node:tls.connect` returns an empty peer
certificate — surfacing as `ERR_TLS_CERT_ALTNAME_INVALID` — for any host with a real
AAAA record when IPv6 is unreachable. `imap.gmail.com` is such a host and this
developer runs Mullvad, which blocks IPv6. **Node 22 is unaffected, so no contributor
testing under Node will ever reproduce it, and the error blames certificates rather
than the network.** The provider resolves the host itself via `dns.lookup({all:true})`,
picks a reachable address, and passes `host: <ip>` + `servername: <hostname>`. An
integration test asserts a non-empty peer certificate and must fail if the workaround
is removed.

**v1 scope: the unread list only.** Sender, subject, age, and **two** actions —
mark read and archive. "Open in web client" is deliberately cut from v1: it is the
one mail action that builds a URL from server-supplied data, which §8.7 forbids
without a design. If it returns, the URL comes from a provider-configured template
plus a strictly validated message id, never from string concatenation.
"Waiting on you" is deferred (§4) — on Gmail the user's own replies carry the Sent
label, not Inbox, so computing it from the configured folder alone misreports every
answered thread. It needs a second thread-scoped read against the SPECIAL-USE
discovered `\All` or `\Sent` mailbox, and a live-credential spike to confirm the
behaviour. Server-side thread IDs exist only on Gmail (`X-GM-EXT-1`) and Yahoo
(`OBJECTID`) — Fastmail, Outlook, Zoho and Dovecot have neither — so client-side
`Message-ID`/`References` threading is the primary path when that work happens, not a
fallback.

**Actions:** mark read (`messageFlagsAdd(range, ['\\Seen'])`) and archive
(`messageMove(range, archivePath)`), both `call`. `archivePath` comes from
SPECIAL-USE discovery via `client.list()`; a test asserts no `[Gmail]/All Mail`
literal exists in the source.

**Polling at 60s**, one connection per account. IDLE is an opt-in enhancement, not
the v1 default — Gmail permits only 15 simultaneous IMAP clients per account and
punishes reconnect storms.

Mail introduces a surface the rest of the security model doesn't cover: **subjects
and sender names are attacker-controlled strings that flow into the UI.** §8.7.

### 7.4 claude — usage

Ports the pure logic from `tacodx/TacosPlugins` `packages/core` — MIT, same owner,
zero dependencies, 262 passing tests, verified running under bun.

**Credentials are READ-ONLY. Atrium never refreshes, never writes.** Revision 1 said
"Actions: none. Informational." while the ported auth path performs a
read-modify-write of Claude Code's own `~/.claude/.credentials.json` whenever the
access token is near expiry — rotating a refresh token the running Claude Code
process also holds, whose failure mode is the user being forced to re-authenticate.
Atrium uses the access token while unexpired and reports `unavailable:
token-expired` otherwise. It never POSTs to the token endpoint and never touches
`~/.claude/tacos/`, which belongs to the plugins.

**Interval: 300s base, not 60s.** The endpoint rate-limits in practice, not in
theory: a 429 was recorded on the reference machine 64 seconds after a success, and a
controlled 60s single-process poller produced a clean alternating 200/429/200/429
with zero concurrency. Backoff is keyed by consecutive failure count, reset on
success.

**Status is four-way, not two:** `ok` | `stale(age)` | `unavailable(reason)` |
`unsupported-shape`. The last is separate because the endpoint is undocumented and
unversioned: a shape change yields zero recognised gauges, which a two-way model
reports as four empty gauges — visually identical to a plan that genuinely lacks
them. `unavailable` must emit no percentage, no bucket list, no gauge object at all.

**Data** is two sections, matching the payload rather than merging them: `gauges`
(five_hour, seven_day, extra_usage, scoped[]) and `buckets[]` (from `limits[]`) with
one marked binding. Percentages are 0–100 floats; money is minor units with
`decimal_places`; `resets_at` is parsed at the provider boundary and never passed to
the UI as a raw ISO string. `extra_usage.is_enabled` and `disabled_reason` are
carried through, so the UI doesn't show 38% of a pool the account cannot draw on.

A **redaction test** asserts nothing reaching the HTTP/WS layer contains
`accessToken`, `refreshToken`, or the raw payload — which carries spend in euros,
per-surface breakdowns, subscription type and rate-limit tier.

Shipping Claude Code's OAuth client id in a public package is a deliberate decision
to record in the README, alongside usage-guard's existing "this endpoint is
undocumented and may break without notice" warning.

## 8. Security model

A loopback server that executes shell commands is a loaded gun. Every clause here has
a test.

**8.1 Bind `127.0.0.1` only.** Never `0.0.0.0`, not behind a flag.

**8.2 One request gate, every route and the WS upgrade.** Host allowlist exact,
case-insensitive, port-inclusive: `{127.0.0.1:PORT, localhost:PORT}`. Never
`endsWith`/`includes` — `evil.localhost:7373` resolves to loopback in Chrome and
Firefox per RFC 6761. Explicitly reject missing Host, `0.0.0.0:PORT` (verified to
reach a loopback-bound Bun server from a real browser), `[::1]:PORT`, trailing-dot
forms, and any Host containing a comma (Bun joins duplicate Host headers rather than
returning 400). Origin allowlist likewise exact — a loose "is localhost" check admits
`http://localhost:3000`, a real attack origin. Default-deny on absent or `null`
Origin for anything state-changing, and **no GET may ever mutate state or run a
command.** Reject `Sec-Fetch-Site` when present and not `same-origin`/`none`.

Bun gives two disagreeing views of the same request: an absolute-form URI
`GET http://evil.example.com/` with `Host: 127.0.0.1:7373` returns 200 with a clean
header check while `req.url` is attacker-controlled. **Enforce on the Host header
only, and never build a redirect `Location` from `req.url`.** Set
`development: false` with an explicit `error()` handler, or the source-code error page
serves pre-auth.

The negative test suite is written **before** the gate and mutation-checked.

**8.3 Token, not cookie.** RFC 6265 §8.5 gives cookies no port isolation, so a
session cookie is sent to every other service on loopback, and a page from another
localhost port is same-site — `SameSite=Strict` would not apply. The token lives in
**`localStorage`** (origin-scoped, and origin includes the port) and travels as
`Authorization: Bearer`. Handoff: 32 bytes from `crypto.getRandomValues`, base64url,
delivered in the URL **fragment** — never the query — single-use with a ~60s TTL, and
`history.replaceState`'d away after reading. Residual risk, accepted and documented:
`/proc/<pid>/cmdline` is world-readable with no `hidepid`, so the fragment is briefly
visible to other local processes; single-use plus a 60s TTL is the mitigation.
`atrium rotate-token` invalidates.

**8.4 WebSocket auth is its own clause.** The browser WS API cannot set headers, and a
non-browser local process forges `Origin` trivially — a raw handshake with a forged
Host and no Origin returned 101. So: validate Origin on the upgrade through the same
gate, then require the client's first frame to be `{type:'auth', token}` within 2s,
send **zero** state before it, and close 1008 otherwise. The token never goes in the
`ws://` query string, where it would land in logs.

**8.5 Secrets are separate from config.** `config.json` (0644, shareable) vs a
`0600` secrets file in a `0700` directory — `~/.config` itself is 0755. Startup
refuses to run if the secrets file is group- or world-readable. The mail credential
prefers `Bun.secrets` (libsecret/KWallet; present on the reference machine without
GNOME) behind a one-function adapter, falling back to the 0600 file. It is read
**lazily with retry**, never eagerly, and a locked keyring surfaces as `credential
store locked` — not as "not configured" — because a user service can start before the
session unlocks the wallet. `Bun.secrets` hangs indefinitely with no internal timeout
when the Secret Service is present but unresponsive, so every call is wrapped in
`Promise.race` with a timeout, never a bare try/catch.

**8.6 `runGit()` is the only path to git, and argv discipline is not sufficient.**
Revision 1's invariant — "a repo named `foo; rm -rf ~` must be inert" — is satisfied
and beside the point. The injection is in the **callee**: a repo's own `.git/config`
`core.fsmonitor` executes an arbitrary program on a plain `git status --porcelain`,
and git runs that value through a shell; `diff.external` does the same on `git diff`.
With a 30s poll across every repo under `$HOME`, one hostile `.git/config` — from an
extracted archive, a package postinstall, or an agent writing files — is persistent
RCE. Confirmed exploitable on git 2.55.0.

Every invocation carries a fixed hardening prefix (command-line `-c` beats repo-local
config): `--no-pager -c core.fsmonitor= -c core.hooksPath=<empty dir Atrium owns>
-c core.sshCommand= -c core.askPass= -c core.editor=false -c core.pager=cat
-c diff.external= -c protocol.ext.allow=never`, plus `-C <absolute resolved path>`,
`--` before positionals, and a per-repo timeout. Blocklists are never viable:
`--upload-p=` executes exactly as `--upload-pack=` does.

**The env is an allowlist, built from scratch — not `process.env` with `GIT_*`
stripped.** `runGit()` passes a fixed minimal env and *explicitly sets*
`GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null`, in production as
well as in tests, since the `-c` prefix already supplies everything git needs. A
blanket "scrub all `GIT_*`" would delete exactly the two variables that make §10's
security tests honest, recreating the false pass those tests exist to catch.

Direct `execFile('git', …)` anywhere else is forbidden by a test that greps the
source. The fixture test plants `core.fsmonitor`, `diff.external`, a repo-local
`core.hooksPath` **and** a bare `.git/hooks/post-index-change`, runs under
`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`, and asserts no marker file
appears.

**8.7 Untrusted content rendering.** Mail subjects, sender names, branch names and
file paths are attacker-controlled strings. React escapes by default; the rule is that
none of them may reach `dangerouslySetInnerHTML`, a URL constructor, or an action
argv hole that is not path-shaped.

**8.8 `$EDITOR` is a seed, not a command.** The editor action is a config key of shape
`{cmd: string, args: string[]}` with a `${path}` placeholder, defaulted by probing a
small allowlist at first run. A multi-word `$EDITOR` like `code --wait` cannot be an
`execFile` cmd, and an env-influenced editor string is an injection vector.

**8.9 Standard headers on every response:** `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `Cache-Control: no-store`,
`Content-Security-Policy: default-src 'self'; connect-src 'self' ws://127.0.0.1:PORT;
frame-ancestors 'none'`.

The README carries a threat-model section naming the real precedents — MCP Inspector
CVE-2025-49596, Nuxt Devtools CVE-2024-23657, Ray CVE-2025-62593, 0.0.0.0-day — so
contributors understand why the gate exists and do not weaken it for convenience.

## 9. Configuration, first run, and auto-start

`~/.config/atrium/` (XDG-respecting), `config.json` plus a separate 0600 secrets file.

**Default port 7373**, configurable. Revision 1's 7777 is the default listening port
for Terraria, ARK, Unreal dedicated servers, SCP:SL and Mordhau — a poor choice on a
heavy gamer's machine, and a hardcoded well-known port is a first-run phishing target
because §9's exit-on-occupied hands the port to a squatter that can serve the UI and
harvest the handoff token. 7373 is free and IANA-unassigned. Port collision exits
**78** (`EX_CONFIG`) naming the port, the config key and the holding process.

**Two files every launcher depends on**, and the reason a configurable port works at
all:
- `$XDG_RUNTIME_DIR/atrium/endpoint.json` — `{url, pid, startedAt}`, written after
  binding, unlinked on clean shutdown. Nothing hardcodes the port.
- `GET /healthz` — unauthenticated, 200 as soon as the listener is up. Subject to the
  §8.2 gate but not the token, because the token-gated routes cannot serve this
  purpose.

**First run** runs every provider's `detect()`, shows what was found, asks only for
what wasn't. There is one ordering constraint the design must respect: mail's
`detect()` returns null by design, so first run requires typing the product's
highest-value secret into a page — which must already be authenticated by §8.3 before
that form is ever rendered.

**Auto-start** is two units, both `PartOf=` and `After=graphical-session.target`.
`After=` is not optional: lingering is enabled on the reference machine, so a
`default.target` unit starts ~20s before the session and systemd snapshots the
manager environment at exec — leaving the service `WAYLAND_DISPLAY`-less for its whole
lifetime, and every "open in editor" action broken. `WantedBy=` alone is a pull-in,
not an ordering dependency.

`graphical-session.target` is never started on sway, i3, Hyprland or XFCE, where
`enable` prints "Created symlink" and the service then silently never runs — so an
XDG autostart `.desktop` entry is documented as the portable route.

**Every GUI launch goes through `systemd-run --user --scope --collect`** (with a
plain-exec fallback when D-Bus is unreachable). systemd tears down a unit's cgroup on
deactivation and kills its children — verified — so without this, `systemctl --user
restart atrium` would kill every editor and terminal the dashboard opened.

`ExecStart` is built from `process.execPath` (plus `Bun.main` when running as a
script). **Never** from `__dirname`, `import.meta.path`, `import.meta.dir` or
`process.argv[1]` — inside a compiled binary those are `/$bunfs/root/…` paths that do
not exist on disk. Path substitution at install time ports the approach already
working in `~/claude/driftcheck`, with one addition it didn't need: escape `%` as
`%%`.

`atrium open` polls `/healthz` before launching a browser, then falls back `$BROWSER`
→ `xdg-open` → portal `OpenURI` → print the URL. `--once` is gated on a
`$XDG_RUNTIME_DIR` marker, so the tab opens on the first login after a boot rather
than on every session start. macOS (launchd) and Windows (Task Scheduler) are
documented and marked untested.

`atrium doctor` checks that the `ExecStart` path still exists, the unit is enabled,
the port is free or held by our own PID, and the secrets file is 0600 — the
`driftcheck` idea applied to Atrium's own installation.

## 10. Testing strategy

Providers are `fetch(cfg) → Data`, testable against fixtures: generated temp git
repositories, a fixture vault, canned IMAP responses.

**Two rules that exist because this research pass hit both false passes:**

1. **No test may assert a count or path derived from the developer's `$HOME`.** The
   revision-1 discovery chain had three of five numbers drift within a single day. A
   mutation check against a `$HOME` count goes red on drift and green on the wrong
   thing.
2. **Every git security test runs under `GIT_CONFIG_GLOBAL=/dev/null
   GIT_CONFIG_SYSTEM=/dev/null`.** This machine's `~/.gitconfig` sets `core.hookspath`
   elsewhere, which silently makes the hook-RCE test pass here while every second user
   stays exploitable. §8.6 sets both variables inside `runGit()` for the same reason;
   the test must not rely on inheriting them.

**Mutation checks are mandatory** on: the discovery rules and container classifier,
the daily-note folder inference, the `unavailable`-vs-zero branch, the request gate's
Host comparison, and the WebSocket auth gate (a socket that authenticates must have
received zero state before its auth frame).

Both of the checks that caught revision 1's errors are **generated fixtures**, per
rule 1 above. Their contents are specified here because a fixture rebuilt from a vague
description cannot reproduce the check:

*Container regression* — a directory that is itself a git repo with tracked files of
its own, whose `.gitignore` lists three child directories, each a git repo. Assert
all four repos surface: the parent **and** all three children. Mutating the container
rule back to "drop nested repos" must turn this red. This is the shape revision 1 got
wrong, reproduced without reference to any real path.

*Folder inference* — a fixture vault with two folders. Folder A holds **four**
date-named notes with the **older** dates (`2026-08-25`, `2026-08-26`, `2026-08-29`,
`2026-09-02`); folder B holds **three** with the **newer** dates (`2026-09-02`,
`2026-09-04`, `2026-09-05`). Latest-date-wins picks B; plain-majority picks A. A
`.trash` directory holds six notes dated later than both (`2026-09-10` onward), which
must be ignored — if it were counted it would win on both recency *and* count, so the
same fixture tests the exclusion. Mutating the rule to plain-majority, or dropping the
`.trash` exclusion, must each turn a test red.

The discovery fixture suite covers every case verified during validation: bare repo,
linked worktree (branch and detached), submodule, dangling submodule pointer, 0-byte
`.git` file, symlinked repo, empty repo, mid-rebase, mid-merge, mid-cherry-pick,
umbrella-with-ignored-children, vendored-tracked-child, and the two shapes that defeat
the classifier (§7.1): an umbrella with no `.gitignore`, and a repo gitignoring
`deps/` that contains a clone.

A post-build packaging assertion runs the compiled binary with the source `dist`
renamed away and fails CI if `Bun.embeddedFiles.length` is below the dist file count,
or if `/` and one hashed JS and CSS asset don't return 200 with the right
content-type. Assets imported but never referenced at runtime are dropped by
dead-code elimination **with no warning** — the failure is a blank page in a release
build that works perfectly in dev.

## 11. Naming and distribution

`atrium` — the open central space every room opens onto.

Bare `atrium` is taken on npm, which affects only `npm i atrium`, never the command
name. `github.com/tacodx/atrium` and `@tacodx/atrium` are both free.

**Two distribution lanes, not one.** `bunx @tacodx/atrium` runs the npm package's bin
from source; the compiled binary is a separate GitHub Releases artifact. The npm bin
carries `#!/usr/bin/env bun` and the package is therefore Bun-only — `npm i -g` on a
node-only machine installs fine and fails at first run with a cryptic `env: bun: No
such file or directory`, so the README says so plainly and points node-only users at
the release binary. Binaries are 58–110MB per target (`--minify` changes total size by
~0; the runtime dominates), cross-compiled for all 8 targets from one Linux CI runner.

License MIT, consistent with `driftcheck` and `TacosPlugins`.

## 12. Scope

**Task 0 — the walking skeleton, before any provider or UI feature.** One artifact
that proves, on the candidate Bun version: `--asset` embedding survives a foreign cwd
with `dist/` deleted; the served CSS contains a real Tailwind utility and the JS is
not a development build; a loopback `Bun.serve` with the §8.2 gate and a WS upgrade on
the same port works inside the compiled binary; and a TLS handshake to
`imap.gmail.com` yields a non-empty peer certificate. This settles the single most
contested variable in the design and kills two silent-failure modes — both of which
return HTTP 200 with a broken page — at the cheapest possible moment.

Then, in order and for these reasons:

1. **The request gate and its negative suite** (before the WS protocol is written —
   the auth transport determines the frame protocol, the first-run ordering, and the
   opener's behaviour), plus `/healthz` and `endpoint.json`.
2. **`runGit()` and the malicious-repo fixture test**, before any git provider work.
   Every git call written before `runGit()` exists has to be retrofitted, and
   retrofits are where one call gets missed.
3. **The revised provider contract**, before any provider. Writing providers against
   revision 1's contract means rewriting all four when the second one refuses to fit.
4. **git** — most contested, best understood, and it exercises both the action layer
   and the two-schedule contract.
5. **claude** — small, read-only, no UI ambiguity.
6. **obsidian**.
7. **mail** — most external dependencies, unread list only.

Then the UI, whose state layer must not be written before the WebSocket payload shape
and reconnect contract exist.

**Parked: the native shell.** Revision 1 made it phase 2 on the strength of "Tauri's
model is a WebView pointed at a local server, so the shell is thin." On this target —
KDE Plasma 6, Wayland-only, no X11 session installed — all three capabilities it was
wanted for fail:

- `global-hotkey` 0.8.0 routes every Linux target to `#[path = "x11/mod.rs"]`. No
  Wayland backend, no portal backend. The community PR has been open since March 2026
  with no maintainer assigned to Linux since 2022.
- `always_on_top` and `set_outer_position` compile to `gtk_window_set_keep_above()` /
  `gtk_window_move()` and are documented `Linux(Wayland): Unsupported`. Tauri's
  `center()` returns `Ok(())` and silently does nothing — worse than a missing API.
- Tauri emits no tray *click* events on Linux at all.

The rescue — KWin window rules — works identically for a plain
`chrome --app=$URL --class=atrium` window, so it removes the justification for the
shell rather than saving it. The decision is deferred until the web UI exists and its
owner knows whether they reach for it. What v1 builds regardless, because the shell's
requirements leak backwards: `endpoint.json`, `/healthz`, and a UI with zero
shell-specific code.

When it is revisited, the honest options are a browser `--app` window plus a KWin rule
and a KDE global shortcut; a small GTK4/WebKitGTK wrapper; or Tauri with the hotkey
taken from the `org.freedesktop.portal.GlobalShortcuts` portal (verified present and
working on this machine) rather than from Tauri's plugin — in which case the user
picks the key in System Settings and the app can only propose a default, which is a
UX contract change, not just an implementation one.

## 13. Dependency decisions

| Choice | Decision | Why |
|---|---|---|
| Tailwind | **v4** (`tailwindcss` + `@tailwindcss/vite`) | v4's Vite story changed completely. A plan written from v3 memory scaffolds `tailwind.config.js`, PostCSS and autoprefixer — all wrong. |
| Vite | **7.x** with `@vitejs/plugin-react@5.x` | Vite 8 is four months old as a major, with Rolldown replacing both esbuild and Rollup; plugin-ecosystem edges are still being found. Upgrading later costs nothing. |
| Palette primitive | **Not cmdk.** `react-aria-components` or `@base-ui/react` Autocomplete | cmdk has had no release since 2025-03 and no commit since 2025-08, with 52 open issues. More decisively, in real WebKitGTK, replacing the item list — exactly what a WebSocket push does — leaves every option `aria-selected=false`, so Enter is inert until an arrow key is pressed, recurring on every poll. `vimBindings` also defaults on, silently claiming ctrl+n/j/p/k. |
| Palette isolation | One module, enforced by lint | Whichever primitive wins, no library types in app code, so a swap is a one-file change. |
| Fuzzy match | `fuzzysort`, zero deps | At 30–100 items recall is free; what matters is which row ranks #1. Test the tiebreakers (frecency, pins, per-kind weight), not the matcher. |
| UI state | `useSyncExternalStore` over a module-scope store | No fetch, no cache key, no revalidation — nothing for TanStack Query to manage. `getSnapshot` must return a cached identity or React throws. |
| git access | Shell out, hardened | `nodegit` last shipped 2020; `isomorphic-git` is 5× slower and throws `NotFoundError` on linked worktrees and bare repos. Native addons also complicate cross-compilation. |
| Date parsing | `dayjs` + 6 plugins | Obsidian formats are Moment tokens; moment itself is legacy. Round-trip guard required (§7.2). |

## 14. Validation record

Revision 1 was checked by a 28-agent adversarial pass: nine research dimensions, two
perspective-diverse refuters each (does this exist as described / does it survive our
actual constraints), and a completeness critic. All nine dimensions returned contested
load-bearing claims; the critic returned `readyToPlan: false` against revision 1 with
17 corrections and 11 gaps. This revision acts on all of them, but two were resolved
*against* the research rather than by adopting it, and are flagged here so a future
reader can re-litigate them instead of assuming they were settled:

- **§9 keeps `systemd-run --user --scope`** where the finding argued for a transient
  service. The blast radius is one launch helper, and §9's `After=graphical-session
  .target` fix already addresses the environment half of the objection. Worth a spike,
  not a redesign.
- **§8.5 makes the keyring the preferred v1 credential store**, reversing revision 1's
  §4 non-goal. The reason changed: `Bun.secrets` ships in the runtime, needs no
  dependency, works in a compiled binary, and is already available on the reference
  machine — so "too expensive" was never true. The real hazard is that it hangs
  indefinitely with no internal timeout, which is why §8.5 mandates `Promise.race`.

The two most consequential were both **measurement artifacts in revision 1, not
reasoning errors**, which is why they survived review: a repo count of 30 that silently
excluded five of the most active repos on the machine, and a 0.19s scan time that was
6–28× optimistic because the measuring tool was a parallel shim. Both had been stated
as verified facts.

Two decisions were deliberately left open by their owner rather than closed by the
research: the native shell (§12) and mail's "waiting on you" (§4).
