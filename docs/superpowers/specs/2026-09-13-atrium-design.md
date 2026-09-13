# Atrium — Design

**Date:** 2026-09-13
**Status:** Approved, ready for implementation planning
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
thought, triage mail. Keyboard-driven, one surface, never leave the window.

This is a deliberate choice against the "ambient status wall" framing. Read-only
dashboards get built, admired twice, and abandoned.

## 4. Non-goals

Explicitly out of scope, not deferred-by-accident:

- **Phone / LAN access.** Requires binding beyond loopback, which requires real auth
  (see §8). Deliberately excluded from v1.
- **npm-loaded third-party plugins.** The provider contract is an internal seam, not
  a dynamic plugin runtime. YAGNI until someone actually wants to ship one.
- **Keyring integration** (KWallet / libsecret). v1 uses `0600` files. Phase 2.
- **Electron.** Never. Electron's GPU fault on Wayland/amdgpu has already corrupted
  this developer's desktop once via VS Code.

## 5. Architecture

```
  ┌──────────────────────────────────────────────────────────┐
  │  core  (bun, single process, systemd user service)       │
  │                                                          │
  │   registry ──┬─ git       detect: scan $HOME by 2 rules  │
  │              ├─ obsidian  detect: read obsidian.json     │
  │              ├─ mail      detect: none → first-run ask   │
  │              └─ claude    detect: local credentials      │
  │                                                          │
  │   scheduler   polls each provider on its own interval    │
  │   actions     fixed allowlist, execFile(argv[]) only     │
  │   http+ws     127.0.0.1 only, token cookie               │
  └───────────────┬──────────────────────────────────────────┘
                  │  one UI, two ways in
        ┌─────────┴─────────┐
   localhost:7777      Tauri shell  (phase 2: hotkey + tray)
   (browser / PWA)     (WebView → same URL)
```

The desktop app and the web app are not two builds. Tauri's model is a WebView
pointed at a local server, so the native shell is a thin wrapper around the same web
UI, adding only a global hotkey, a tray icon, and window management.

**Stack:** bun + TypeScript. React + Vite + `cmdk` (proven command-palette primitive)
+ Tailwind for the UI. Bun compiles to a single binary, so both `bunx` and a
downloaded binary work. No Rust until phase 2.

**Data flow:** core starts on login (systemd user service) → each provider polls on
its own interval → state pushed to the UI over WebSocket → UI dispatches actions via
`POST /actions/:providerId/:actionId`.

## 6. The provider contract

Every source implements one interface:

```ts
interface Provider<Cfg, Data> {
  id: string
  configSchema: ZodSchema<Cfg>
  detect(): Promise<Partial<Cfg> | null>   // self-configure, or null → ask user
  fetch(cfg: Cfg): Promise<Data>
  actions: Action<Data>[]                  // declared allowlist, never arbitrary
  interval: number                         // poll interval, ms
}

interface Action<Data> {
  id: string
  label: string
  keybinding?: string
  // Returns an argv array. NEVER a shell string. See §8.
  command(target: Data[number]): { cmd: string; args: string[] }
}
```

One folder per provider: `src/providers/<id>/{index,config,actions}.ts`. Adding a
fifth source is a new folder with zero core edits. Contributors get an obvious seam.

## 7. The four providers

### 7.1 git — projects

**Detection is the whole trick.** Scan `$HOME` for `.git` directories, then apply two
rules:

1. Drop repos under a dot-directory (`.claude/skills/*`, `.claude/worktrees/*`,
   plugin marketplaces, `.pyenv`), and repos whose own basename starts with a dot.
2. Drop repos nested inside another repo (vendored skill repos, agent worktrees).

Measured on the reference machine: **62 raw → 57 after pruning vendored/cache dirs →
35 after rule 1 → 30 after rule 2**, in 0.19 seconds. The surviving 30 are exactly
the real project list. Scanning all of `$HOME` is viable; hardcoding `~/Projects` is
not necessary and would be wrong for other users.

Config exists only for *overrides*: extra roots, additional ignore globs, pins, hides.

**Shows:** name, branch, relative time since last commit, uncommitted file count.
Repos sorted recent-first, with a separate "needs attention" group for repos whose
last commit is older than `git.staleDays` (default 30) *and* which carry uncommitted
changes. Both conditions must hold — an old but clean repo is finished, not rotting.

**Actions:** open in editor (`$EDITOR`, overridable), open terminal at path, show
diff, and open a terminal at the path running `claude`. Every action resolves to an
argv array; see §8.4.

**Interval:** 30s. The full scan measured 0.19s, so polling is cheap; a filesystem
watcher is a phase-2 optimisation, not a v1 requirement.

**Known edge case:** an umbrella repo containing sub-repos (e.g. a `clients/` repo
holding one repo per client) loses its children to rule 2. Resolution: config key
`git.treatAsContainer: string[]` listing paths whose children should be surfaced
instead of the parent. Defaults to empty.

### 7.2 obsidian — daily note and capture

**Detection:** Obsidian writes `obsidian.json` listing every known vault. Locations:

| Platform | Path |
|---|---|
| Linux (native) | `~/.config/obsidian/obsidian.json` |
| Linux (Flatpak) | `~/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json` |
| macOS | `~/Library/Application Support/obsidian/obsidian.json` |
| Windows | `%APPDATA%/obsidian/obsidian.json` |

One vault → use it. Several → ask once at first run. None → file picker.

**Daily-note location:** read `<vault>/.obsidian/daily-notes.json` for folder and
date format. When that file is absent, Obsidian's defaults say vault root — which is
frequently wrong, because users move daily notes without configuring the plugin.
Fallback: **infer from reality.** Scan the vault for files matching the date format,
find the directory most of them live in, use that. On the reference vault this
correctly yields `00 Inbox` rather than the vault root.

**Shows:** whether today's note exists, recent notes, gaps in the last 7 days.

**Actions:** create today's note from a template, open a note, and a quick-capture box
that appends a line to a configured capture file without opening Obsidian.

**Interval:** 30s, plus a filesystem watcher on the daily-note directory so a note
created elsewhere appears immediately.

### 7.3 mail

The only provider with genuine setup friction and the only one holding a secret.

**Transport: IMAP with an app password**, not Google OAuth. Rationale: OAuth would
require every open-source user to register their own Google Cloud client ID — a real
barrier — and would lock the provider to one vendor. IMAP is one pasted credential
and works with Gmail, Fastmail, Proton Bridge, and self-hosted alike.

**Shows:** unread count, sender, subject, age. A separate "waiting on you" group for
threads where the last message is inbound and older than a configurable threshold
(default 3 days).

**Actions:** open in web client, archive, mark read.

**Interval:** 60s.

**Config:** host, port, user, app password, folder, unanswered-threshold.

### 7.4 claude — usage

**Detection:** reads Claude credentials already present on the machine. Per-person,
zero configuration.

**Shows:** which rate-limit bucket is currently binding, percentage consumed of the
5-hour / weekly / model-scoped windows, and reset times.

**Actions:** none. Informational.

**Interval:** 60s.

**Credential source:** the OAuth token already written by Claude Code to its local
credential store, used to query the account usage endpoint. If no token is present,
the provider reports an explicit *unavailable* state — distinct from "zero usage",
a distinction `usage-guard` learned the hard way.

This is a port of existing, working logic from the `usage-guard` plugin
(`tacodx/TacosPlugins`), not new research.

## 8. Security model

A loopback server that executes shell commands is a loaded gun. These are
non-negotiable, and each has a test.

1. **Bind `127.0.0.1` only.** Never `0.0.0.0`, not even behind a flag.
2. **Reject DNS rebinding.** Refuse any request whose `Host` header is not
   `127.0.0.1:PORT` or `localhost:PORT`, and refuse any cross-origin `Origin`. This
   is how "but it's only localhost" projects get compromised: a malicious web page
   the user visits can otherwise POST to the local API.
3. **Token auth.** Generated on first run, delivered once through the auto-open URL
   (`http://127.0.0.1:PORT/?t=…`), immediately exchanged for an
   `httpOnly; SameSite=Strict` cookie, then redirected to a clean URL so the token
   never lingers in history.
4. **Actions are a declared allowlist executed via `execFile(cmd, args[])`.** No
   shell, no string interpolation, ever. A repository named `foo; rm -rf ~` must be
   completely inert. This is the single highest-risk surface in the project.
5. **Secrets at `0600`** in `~/.config/atrium/`. Never logged, never sent to the UI —
   the UI receives fetched data, never credentials.

## 9. Configuration and first run

`~/.config/atrium/config.json` (XDG-respecting; `$XDG_CONFIG_HOME` honoured).

Default port 7777, configurable. If the port is occupied, core exits with a clear
error naming the port rather than silently selecting another — a command centre that
moves is a command centre you cannot bookmark.

First run: run every provider's `detect()`, present what was found, ask only for what
was not. Nothing about the reference machine's paths is baked into the code — the
project must work unchanged for someone whose vault, repos, and mail live elsewhere.

Auto-start: a systemd user service starts core on login and opens the browser tab.
macOS (launchd) and Windows (Task Scheduler) equivalents are documented but not
automated in v1; on those platforms the user starts it manually.

## 10. Testing strategy

Providers are `fetch(cfg) → Data`, which makes them testable against fixtures:
generated temp git repositories, a fixture vault directory, canned IMAP responses.

**The discovery rules get the heaviest coverage**, because they fail *quietly* rather
than loudly — a wrong rule produces a plausible-looking list with the wrong contents.

**Mutation checks are mandatory on the discovery rules.** Break rule 2 deliberately
and confirm a test goes red; if none does, the test was decorative. This requirement
comes directly from a prior project in which five tests passed against a deliberately
broken implementation.

The action layer gets its own tests asserting that every action produces an argv
array and that no code path builds a shell string.

## 11. Naming and distribution

`atrium` — the open central space every room opens onto — matches "where all my stuff
meets." Alternatives considered: `perch`, `hearth`.

Availability checked 2026-09-13: the bare npm names `atrium`, `perch` and `hearth`
are all taken, but this only affects `npm i <name>`, not the command name. Both
`github.com/tacodx/atrium` and the scoped npm package `@tacodx/atrium` are free.

**Decision:** publish as `@tacodx/atrium` with `bin: { atrium: … }`, repository
`github.com/tacodx/atrium`. The user types `atrium` regardless. License MIT,
consistent with `driftcheck` and `TacosPlugins`.

The name is provisional; renaming before first publish costs a directory move and a
string replace.

## 12. Scope

**v1:** core service, provider contract, the four providers, web UI, first-run flow,
auto-start on login.

**Phase 2:** Tauri shell (global hotkey, tray icon, always-on-top window).

Rationale for the split: a native shell wrapping an empty dashboard is a beautiful
launcher for nothing. The shell is thin by construction and can be added at any point
once the dashboard has proven it earns being summoned.
