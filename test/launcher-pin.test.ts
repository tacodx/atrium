import { test, expect } from 'bun:test'
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import * as ts from 'typescript'
import { spawnDetached } from '../src/core/actions'
import { INERT_LAUNCHER } from './fixtures/launcher'

// A test that reaches spawnDetached with the DEFAULT launcher runs
// `systemd-run --user --scope -- <cmd>` for real, so a mutation run that
// deletes a refusal (repos M2/M3, the buildArgv git guard) would open a real
// editor or terminal on the operator's desktop. The rule: every dispatch( and
// spawnDetached( call in test/ passes an explicit `launcher` in an inline
// options literal, and its VALUE is INERT_LAUNCHER or one of the named fakes
// listed below — never `undefined`, a string literal or anything else, since
// spawnDetached's `opts.launcher ?? 'systemd-run'` treats undefined as absent.
//
// A TRIPWIRE, not a proof. Its limits, as a list:
//  - a call through a re-bound variable (`const d = dispatch`) or
//    Reflect.apply is invisible; aliased imports are caught below;
//  - options built elsewhere and passed by name fail closed (flagged as
//    <not-inline>), never silently pass;
//  - a named fake is pinned by its TEXT, so what the local binding holds is
//    taken on trust (each one is a sandbox script or a path inside one);
//  - handleRoute -> dispatch (src/server/routes.ts) passes no launcher by
//    design; test/routes.test.ts registers only `call` actions, so it cannot
//    reach spawnDetached, and nothing here checks that it stays that way;
//  - the exact list below adds deliberate friction to every new dispatch, the
//    same pattern as verify-gate's exact spawn count.
const OPTS_INDEX: Record<string, number> = { dispatch: 4, spawnDetached: 2 }
const ROOT = join(import.meta.dir, '..')

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsFilesUnder(p))
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

/** The launcher's initializer as source text, or a marker for its absence. */
function launcherOf(opts: ts.Expression | undefined, sf: ts.SourceFile): string {
  if (opts === undefined || !ts.isObjectLiteralExpression(opts)) return '<not-inline>'
  const found: string[] = []
  for (const p of opts.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'launcher') found.push(p.initializer.getText(sf))
    else if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'launcher') found.push('launcher (shorthand)')
    else if (ts.isSpreadAssignment(p)) found.push('<spread>')
  }
  return found.length === 0 ? '<missing>' : found.join(' + ')
}

function scan(): { sites: string[]; aliased: string[] } {
  const sites: string[] = []
  const aliased: string[] = []
  for (const file of tsFilesUnder(join(ROOT, 'test'))) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const where = relative(ROOT, file)
    const visit = (n: ts.Node): void => {
      if (ts.isImportSpecifier(n) && n.propertyName !== undefined && Object.hasOwn(OPTS_INDEX, n.propertyName.text)) {
        aliased.push(`${where}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`)
      }
      if (ts.isCallExpression(n)) {
        const e = n.expression
        const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : undefined
        if (name !== undefined && Object.hasOwn(OPTS_INDEX, name)) {
          sites.push(`${where} ${name} ${launcherOf(n.arguments[OPTS_INDEX[name]!], sf)}`)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return { sites: sites.sort(), aliased }
}

// EXACT, by value (design rule 4: `launcher: undefined` passes a key-presence
// rule). 13 dispatch sites (actions.test.ts 8, repos-metadata.test.ts 5) and
// 6 spawnDetached sites (actions.test.ts 4, this file 2). Every dispatch
// passes INERT_LAUNCHER except the one exec-branch test that must launch its
// recording PASSTHROUGH fake; the spawnDetached tests use their own fakes.
const EXPECTED_SITES = [
  ...Array(7).fill('test/actions.test.ts dispatch INERT_LAUNCHER'),
  'test/actions.test.ts dispatch launcher (shorthand)',
  "test/actions.test.ts spawnDetached join(dir, 'no-such-launcher')",
  "test/actions.test.ts spawnDetached join(dir, 'no-such-systemd-run')",
  ...Array(2).fill('test/actions.test.ts spawnDetached launcher (shorthand)'),
  'test/launcher-pin.test.ts spawnDetached INERT_LAUNCHER',
  "test/launcher-pin.test.ts spawnDetached join(dir, 'no-such-launcher')",
  ...Array(5).fill('test/repos-metadata.test.ts dispatch INERT_LAUNCHER'),
].sort()

test('every dispatch( and spawnDetached( in test/ passes an inert or named-fake launcher, by value', () => {
  const { sites, aliased } = scan()
  expect(sites).toEqual(EXPECTED_SITES)
  expect(aliased).toEqual([])
  expect(sites.filter((s) => / dispatch /.test(s))).toHaveLength(13)
  expect(sites.filter((s) => / spawnDetached /.test(s))).toHaveLength(6)
})

// The rule above is only as good as the value it demands. An ABSENT launcher
// path is worse than the default: failing to start is exactly what triggers
// spawnDetached's bare, unscoped relaunch of the command itself.
test('INERT_LAUNCHER starts, and the command it wraps never runs', async () => {
  expect(existsSync(INERT_LAUNCHER)).toBe(true)
  accessSync(INERT_LAUNCHER, constants.X_OK)
  const dir = mkdtempSync(join(tmpdir(), 'atrium-inert-'))
  try {
    const ran = join(dir, 'ran')
    const payload = join(dir, 'payload')
    writeFileSync(payload, `#!/bin/sh\n: > ${ran}\n`, { mode: 0o755 })
    spawnDetached(payload, [], { launcher: INERT_LAUNCHER })
    await Bun.sleep(500)
    expect(existsSync(ran)).toBe(false)
    // Positive control: the same payload DOES run when the launcher cannot
    // start, so the absence above is the launcher's doing, not a dead payload.
    spawnDetached(payload, [], { launcher: join(dir, 'no-such-launcher') })
    const deadline = Date.now() + 10_000
    while (!existsSync(ran) && Date.now() < deadline) await Bun.sleep(20)
    expect(existsSync(ran)).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
