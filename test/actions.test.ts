import { test, expect, describe, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry } from '../src/core/registry'
import { dispatch, buildArgv, spawnDetached } from '../src/core/actions'
import type { Action, Provider } from '../src/core/contract'
import { INERT_LAUNCHER } from './fixtures/launcher'

const provider = (actions: Provider<any, any>['actions']): Provider<any, any> => ({
  id: 'git',
  configSchema: { parse: (x: any) => x },
  detect: async () => ({ kind: 'nothing-to-detect' }),
  schedules: [{ name: 'poll', intervalMs: 1000, runOnStart: false }],
  fetch: async () => ({}),
  toClient: () => ({ wire: true }),   // required by the contract; not identity, on purpose
  actions,
})

const exec = (argv: (t: any) => { cmd: string; args: string[] }): Action =>
  ({ kind: 'exec', id: 'open', label: 'Open', argv })

// --- real-process fixtures -------------------------------------------------
//
// The final whole-branch review found three defects in this module and traced
// all three to the same cause: nothing in the suite had ever exercised
// spawnDetached or dispatch's exec branch, so every one of them failed
// silently through seven task reviews. These fixtures spawn REAL processes —
// a fake launcher standing in for systemd-run (so no user bus is required and
// both of its branches are reachable) and a payload script that records what
// it was actually given.

const SANDBOXES: string[] = []

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atrium-exec-'))
  SANDBOXES.push(dir)
  return dir
}

afterAll(() => { for (const dir of SANDBOXES) rmSync(dir, { recursive: true, force: true }) })

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return path
}

/** Strips systemd-run's own options up to `--` and execs the rest, exactly as
 *  `systemd-run --scope` does — minus the scope and the bus. */
const PASSTHROUGH = 'while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"'

async function waitFor(path: string, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await Bun.sleep(20)
  }
  return existsSync(path)
}

describe('argv invariant', () => {
  test('every exec action yields an argv array, never a string', () => {
    const out = buildArgv(exec((t: any) => ({ cmd: '/usr/bin/xdg-open', args: [t.path] })), { path: '/home/u/repo' })
    expect(Array.isArray(out.args)).toBe(true)
    expect(out.args).toEqual(['/home/u/repo'])
  })

  test('a shell metacharacter in a target is inert because there is no shell', () => {
    const out = buildArgv(exec((t: any) => ({ cmd: '/bin/echo', args: [t.path] })), { path: '/tmp/foo; rm -rf ~' })
    expect(out.args).toEqual(['/tmp/foo; rm -rf ~'])   // one argument, not three
  })

  // Final review I2. buildArgv used to resolve() every dash-leading argument,
  // which turned spec §8.8's own editor example into
  // ['<cwd>/--wait', '/home/u/repo/NOTE.md'] with no error and no log.
  test('a literal flag an action declares survives verbatim — spec §8.8\'s `code --wait <file>`', () => {
    const out = buildArgv(exec((t: any) => ({ cmd: '/usr/bin/code', args: ['--wait', t.path] })), { path: '/home/u/repo/NOTE.md' })
    expect(out.args).toEqual(['--wait', '/home/u/repo/NOTE.md'])
  })

  test('a subcommand\'s own flags survive verbatim, `--` included', () => {
    const out = buildArgv(exec((t: any) => ({ cmd: '/usr/bin/tig', args: ['diff', '--stat', '--', t.path] })), { path: '/repo/x' })
    expect(out.args).toEqual(['diff', '--stat', '--', '/repo/x'])
  })

  // Replaces a test that passed '/tmp/-rf' — absolute, so the branch it meant
  // to exercise was never entered and it asserted the input unchanged.
  test('a dash-leading positional is passed through; `--` is the action author\'s guard', () => {
    const out = buildArgv(exec((t: any) => ({ cmd: '/usr/bin/xdg-open', args: ['--', t.path] })), { path: '-rf' })
    expect(out.args).toEqual(['--', '-rf'])
  })

  test('a non-string argument is rejected rather than passed to the spawn', () => {
    expect(() => buildArgv(exec(() => ({ cmd: '/bin/echo', args: [42 as unknown as string] })), {}))
      .toThrow(/non-string argument/i)
  })
})

// Final review I3: an exec action is the ONE component §8.6's hardening does
// not cover — no -c prefix, no env allowlist, the full process.env — so a
// provider declaring { cmd: 'git', args: ['-C', path, 'diff'] } would have run
// git on a hostile repo with core.fsmonitor live. The tripwire in
// rungit.test.ts is the static half of this; these are the runtime half, and
// they also catch a command name assembled at run time, which no scan can see.
describe('the git chokepoint reaches the action layer', () => {
  test('an exec action naming the git binary is rejected, in every spelling', () => {
    for (const cmd of ['git', '/usr/bin/git', '/nix/store/abc-git-2.55.0/bin/git', './git', 'GIT']) {
      expect(() => buildArgv(exec(() => ({ cmd, args: ['-C', '/repo', 'diff'] })), {}))
        .toThrow(/runGit/)
    }
  })

  test('a name assembled at run time is caught too — the static tripwire cannot see this', () => {
    const assembled = ['gi', 't'].join('')
    expect(() => buildArgv(exec(() => ({ cmd: assembled, args: ['status'] })), {})).toThrow(/runGit/)
  })

  // ADR 0002 Ruling I. The guard used to match only a final segment equal to
  // the bare binary name, so every other member of the suite passed it. Two
  // are reachable from a valid repos.* template with no client input
  // (measured, 2.55.0): `git-receive-pack --advertise-refs <repo>` runs that
  // repo's core.alternateRefsCommand, and `scalar -C <repo> run fetch` its
  // core.sshCommand. Ruling I fails closed on the whole suite, so gitk and
  // git-crypt moved from the allowed side (where 4734d06 had put them without
  // a recorded rationale) to the refused side. tig and lazygit stay allowed as
  // a documented limit: no name check can enumerate git frontends.
  //
  // `refusedAsGit` demands the guard's OWN message: an unrelated throw (say a
  // "did not return an argv pair") must not count as a refusal.
  function refusedAsGit(cmd: string): boolean {
    try { buildArgv(exec(() => ({ cmd, args: [] })), {}); return false }
    catch (e) { if (/runGit/.test((e as Error).message)) return true; throw e }
  }

  // Exact on both sides (design rule 1): every row's verdict is pinned, so a
  // regex that refuses too little AND one that refuses too much both show.
  const SUITE_VERDICTS: ReadonlyArray<readonly [string, boolean]> = [
    // refused: the suite, by name and by path
    ['git-receive-pack', true], ['git-upload-pack', true], ['git-shell', true],
    ['git-crypt', true], ['git-absorb', true], ['gitk', true], ['git-gui', true], ['scalar', true],
    ['/usr/bin/git-receive-pack', true], ['/usr/bin/git-upload-pack', true], ['/usr/bin/git-shell', true],
    ['/usr/bin/git-crypt', true], ['/usr/bin/gitk', true], ['/usr/bin/scalar', true],
    ['/usr/libexec/git-core/git-log', true], ['/usr/libexec/git-core/git-status', true],
    ['/usr/libexec/git-core/scalar', true], ['/usr/lib/git-core/git-diff', true],
    ['Scalar', true], ['GIT-LOG', true], ['Gitk', true],
    ['C:\\Program Files\\Git\\mingw64\\libexec\\git-core\\git-log', true],
    // allowed: near-misses, other tools, and a git-ish DIRECTORY holding a non-git command
    ['legit', false], ['digit', false], ['gitlab-runner', false], ['github-desktop', false],
    ['tig', false], ['lazygit', false], ['code', false], ['konsole', false],
    ['/usr/bin/legit', false], ['/usr/bin/digit', false], ['/usr/bin/gitleaks', false],
    ['/usr/bin/gitkraken', false], ['/usr/bin/tig', false], ['scalars', false], ['xgit', false],
    ['gitk2', false], ['/opt/git-2.55/bin/code', false], ['/home/u/src/git/bin/konsole', false],
  ]

  test('the whole git suite is refused and its near-misses are not — every verdict pinned', () => {
    expect(SUITE_VERDICTS.map(([cmd]) => [cmd, refusedAsGit(cmd)])).toEqual(SUITE_VERDICTS.map(([c, v]) => [c, v]))
    for (const [cmd, refused] of SUITE_VERDICTS) {
      if (!refused) expect(buildArgv(exec(() => ({ cmd, args: [] })), {}).cmd).toBe(cmd)
    }
  })

  // The live half, restricted to entries named git* or scalar (a wrapper
  // artifact such as nixpkgs' .git-gui-wrapped is out of scope by name). The
  // anti-vacuity check stands outside the filter: an empty or unreadable
  // listing fails the length check instead of passing an empty filter.
  test('every git* and scalar entry in the installed git exec-path is refused', () => {
    const r = Bun.spawnSync(['git', '--exec-path'], { stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode).toBe(0)
    const dir = r.stdout.toString().trim()
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.isDirectory() && /^(?:git|scalar)/i.test(e.name))
      .map((e) => join(dir, e.name))
    expect(files.length).toBeGreaterThan(50)
    expect(files.filter((c) => !refusedAsGit(c))).toEqual([])
  })

  test('dispatch refuses the exec action rather than spawning it', async () => {
    const r = createRegistry()
    r.register(provider([{ kind: 'exec', id: 'diff', label: 'Diff', argv: () => ({ cmd: 'git', args: ['diff'] }) }]))
    await expect(dispatch(r, 'git', 'diff', {}, { cfg: {}, launcher: INERT_LAUNCHER })).rejects.toThrow(/runGit/)
  })
})

describe('dispatch', () => {
  test('rejects an unknown action id rather than dispatching dynamically', async () => {
    const r = createRegistry()
    r.register(provider([]))
    await expect(dispatch(r, 'git', 'nonexistent', {}, { cfg: {}, launcher: INERT_LAUNCHER })).rejects.toThrow(/unknown action/i)
  })

  test('rejects an unknown provider id', async () => {
    const r = createRegistry()
    r.register(provider([]))
    await expect(dispatch(r, 'nope', 'open', {}, { cfg: {}, launcher: INERT_LAUNCHER })).rejects.toThrow(/unknown provider/i)
  })

  test('a call action validates its payload at the boundary', async () => {
    const r = createRegistry()
    r.register(provider([{
      kind: 'call', id: 'capture', label: 'Capture',
      payloadSchema: { parse: (x: any) => { if (typeof x?.text !== 'string') throw new Error('bad payload'); return x } },
      run: async () => {},
    }]))
    await expect(dispatch(r, 'git', 'capture', { text: 123 }, { cfg: {}, launcher: INERT_LAUNCHER })).rejects.toThrow(/bad payload/)
    await expect(dispatch(r, 'git', 'capture', { text: 'ok' }, { cfg: {}, launcher: INERT_LAUNCHER })).resolves.toBeUndefined()
  })

  // Final review I4: run()'s cfg was hardcoded undefined, which makes all four
  // `call` actions the spec plans (obsidian's daily note + quick-capture,
  // mail's mark-read + archive) unimplementable — every one of them needs a
  // vault path, a template, or an account out of config.
  test('a call action receives its provider config, not undefined', async () => {
    const r = createRegistry()
    const seen: unknown[] = []
    r.register(provider([{
      kind: 'call', id: 'capture', label: 'Capture',
      run: async (_target, cfg) => { seen.push(cfg) },
    }]))
    await dispatch(r, 'git', 'capture', { text: 'x' }, { cfg: { vault: '/home/u/vault', daily: 'journal/%Y-%m-%d.md' }, launcher: INERT_LAUNCHER })
    expect(seen).toEqual([{ vault: '/home/u/vault', daily: 'journal/%Y-%m-%d.md' }])
  })

  test('a call action still receives its target, and the two are not confused', async () => {
    const r = createRegistry()
    let target: unknown
    let cfg: unknown
    r.register(provider([{
      kind: 'call', id: 'capture', label: 'Capture',
      run: async (t, c) => { target = t; cfg = c },
    }]))
    await dispatch(r, 'git', 'capture', { text: 'note' }, { cfg: { vault: '/v' }, launcher: INERT_LAUNCHER })
    expect(target).toEqual({ text: 'note' })
    expect(cfg).toEqual({ vault: '/v' })
  })
})

// --- exec branch, end to end against real processes ------------------------

describe('the exec branch actually launches things', () => {
  test('dispatch launches the declared argv, flags intact, through the launcher', async () => {
    const dir = sandbox()
    const marker = join(dir, 'ran')
    const argvLog = join(dir, 'argv')
    const launcher = script(dir, 'launcher', PASSTHROUGH)
    const payload = script(dir, 'payload', `printf '%s\\n' "$@" > ${argvLog}\n: > ${marker}`)

    const r = createRegistry()
    r.register(provider([{
      kind: 'exec', id: 'open', label: 'Open',
      argv: (t: any) => ({ cmd: payload, args: ['--wait', '--', t.path] }),
    }]))
    await dispatch(r, 'git', 'open', { path: '/home/u/repo/NOTE.md' }, { cfg: {}, launcher })

    expect(await waitFor(marker)).toBe(true)
    expect(readFileSync(argvLog, 'utf8').split('\n').filter(Boolean))
      .toEqual(['--wait', '--', '/home/u/repo/NOTE.md'])
  })

  // Final review I1(a). execFile's default 1 MiB maxBuffer does not truncate —
  // it KILLS the child. §7.1's own example is a terminal running `claude`.
  test('a child writing far more than 1 MiB runs to completion instead of being killed', async () => {
    const dir = sandbox()
    const finished = join(dir, 'finished')
    const launcher = script(dir, 'launcher', PASSTHROUGH)
    const payload = script(dir, 'payload', `dd if=/dev/zero bs=65536 count=64 2>/dev/null | tr '\\0' 'x'\n: > ${finished}`)

    spawnDetached(payload, [], { launcher })
    expect(await waitFor(finished, 20_000)).toBe(true)
  })

  // Final review I1(b). `systemd-run --scope` is synchronous and forwards the
  // child's own exit status, so keying the fallback on a non-zero exit relaunched
  // every editor that exited non-zero a second time — bare and unscoped, which
  // is exactly what §9 mandates the scope to prevent.
  test('a launcher exiting non-zero does NOT relaunch the command unscoped', async () => {
    const dir = sandbox()
    const launcherRan = join(dir, 'launcher-ran')
    const cmdRan = join(dir, 'cmd-ran')
    const launcher = script(dir, 'launcher', `: > ${launcherRan}\nexit 1`)
    const payload = script(dir, 'payload', `: > ${cmdRan}`)

    spawnDetached(payload, [], { launcher })
    expect(await waitFor(launcherRan)).toBe(true)   // the launcher ran and has already exited 1
    await Bun.sleep(500)                            // ample slack: the fallback spawn was immediate
    expect(existsSync(cmdRan)).toBe(false)
  })

  test('a launcher that cannot start at all DOES fall back to a bare spawn', async () => {
    const dir = sandbox()
    const cmdRan = join(dir, 'cmd-ran')
    const payload = script(dir, 'payload', `: > ${cmdRan}`)

    spawnDetached(payload, [], { launcher: join(dir, 'no-such-systemd-run') })
    expect(await waitFor(cmdRan)).toBe(true)
  })

  test('neither spawn failing throws into the caller', () => {
    const dir = sandbox()
    expect(() => spawnDetached(join(dir, 'no-such-command'), [], { launcher: join(dir, 'no-such-launcher') }))
      .not.toThrow()
  })
})
