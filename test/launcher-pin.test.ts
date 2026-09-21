import { test, expect } from 'bun:test'
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
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
//  - INERT_LAUNCHER is pinned by its text AND its binding: every file with
//    an INERT_LAUNCHER site must bind the name exactly once, by a plain value
//    import from test/fixtures/launcher (with or without .ts), and nowhere
//    else — no local const, parameter, function, class, destructuring or
//    aliased import may shadow it (a local const undefined once did);
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

const INERT = 'INERT_LAUNCHER'
const LAUNCHER_MODULE = join(ROOT, 'test', 'fixtures', 'launcher')
const THE_IMPORT = 'import { INERT_LAUNCHER } from test/fixtures/launcher'

/**
 * Every declaration in `sf` that BINDS the name INERT_LAUNCHER, rendered. The
 * one allowed form renders as THE_IMPORT; anything else renders as its syntax
 * kind and line, so a shadow is named in the failure.
 */
function inertBindings(sf: ts.SourceFile, file: string): string[] {
  const out: string[] = []
  const at = (n: ts.Node) => `${ts.SyntaxKind[n.kind]}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === INERT) {
      const p = n.parent
      if (ts.isImportSpecifier(p) && p.name === n) {
        const decl = p.parent.parent.parent
        const spec = ts.isStringLiteral(decl.moduleSpecifier) ? decl.moduleSpecifier.text : ''
        const target = resolve(dirname(file), spec).replace(/\.ts$/, '')
        const plain = (p.propertyName === undefined || p.propertyName.text === INERT)
          && !p.isTypeOnly && !p.parent.parent.isTypeOnly && spec.startsWith('.') && target === LAUNCHER_MODULE
        out.push(plain ? THE_IMPORT : `${at(p)} from '${spec}'`)
      } else if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)
        || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p)
        || ts.isClassExpression(p) || ts.isEnumDeclaration(p) || ts.isModuleDeclaration(p)
        || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p)) && p.name === n) {
        out.push(at(p))
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

function scan(): { sites: string[]; aliased: string[]; bindings: Record<string, string[]> } {
  const sites: string[] = []
  const aliased: string[] = []
  const bindings: Record<string, string[]> = {}
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
    bindings[where] = inertBindings(sf, file)
  }
  return { sites: sites.sort(), aliased, bindings }
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

// The pin above reads the initializer's TEXT; this pins what that text is
// bound to. MUTATION: replace repos-metadata.test.ts's import with
// `const INERT_LAUNCHER: string | undefined = undefined` — the site text is
// unchanged, and all five repos dispatches would pass undefined.
test('every file with an INERT_LAUNCHER site binds it once, by import from test/fixtures/launcher', () => {
  const { sites, bindings } = scan()
  const files = [...new Set(sites.filter((s) => s.endsWith(` ${INERT}`)).map((s) => s.split(' ')[0]!))].sort()
  // Anti-vacuity: the files that really carry INERT_LAUNCHER sites.
  expect(files).toEqual(['test/actions.test.ts', 'test/launcher-pin.test.ts', 'test/repos-metadata.test.ts'])
  expect(Object.fromEntries(files.map((f) => [f, bindings[f]]))).toEqual(Object.fromEntries(files.map((f) => [f, [THE_IMPORT]])))
})

// The binding scan itself sees every shadowing form, and accepts only the plain import.
test('the INERT_LAUNCHER binding scan names every shadowing form', () => {
  const file = join(ROOT, 'test', 'probe.test.ts')
  const kinds = (src: string) => inertBindings(ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true), file)
    .map((b) => b.replace(/:\d+.*$/, ''))
  expect(kinds("import { INERT_LAUNCHER } from './fixtures/launcher'")).toEqual([THE_IMPORT])
  expect(kinds("import { INERT_LAUNCHER } from './fixtures/launcher.ts'")).toEqual([THE_IMPORT])
  expect(kinds("import { INERT_LAUNCHER } from '../test/fixtures/launcher'")).toEqual([THE_IMPORT])
  expect(kinds("import { INERT_LAUNCHER } from './fixtures/other'")).toEqual(['ImportSpecifier'])
  expect(kinds("import { X as INERT_LAUNCHER } from './fixtures/launcher'")).toEqual(['ImportSpecifier'])
  expect(kinds("import type { INERT_LAUNCHER } from './fixtures/launcher'")).toEqual(['ImportSpecifier'])
  expect(kinds("import { type INERT_LAUNCHER } from './fixtures/launcher'")).toEqual(['ImportSpecifier'])
  expect(kinds("import INERT_LAUNCHER from './fixtures/launcher'")).toEqual(['ImportClause'])
  expect(kinds("import * as INERT_LAUNCHER from './fixtures/launcher'")).toEqual(['NamespaceImport'])
  expect(kinds('const INERT_LAUNCHER: string | undefined = undefined')).toEqual(['VariableDeclaration'])
  expect(kinds('function f(INERT_LAUNCHER?: string) {}')).toEqual(['Parameter'])
  expect(kinds('function INERT_LAUNCHER() {}')).toEqual(['FunctionDeclaration'])
  expect(kinds('class INERT_LAUNCHER {}')).toEqual(['ClassDeclaration'])
  expect(kinds('const { INERT_LAUNCHER } = o; const [INERT_LAUNCHER] = a')).toEqual(['BindingElement', 'BindingElement'])
  expect(kinds('const { x: INERT_LAUNCHER } = o')).toEqual(['BindingElement'])
  expect(kinds('try {} catch (INERT_LAUNCHER) {}')).toEqual(['VariableDeclaration'])
  expect(kinds('enum INERT_LAUNCHER {}')).toEqual(['EnumDeclaration'])
  // Uses are not bindings.
  expect(kinds('f({ launcher: INERT_LAUNCHER }); o.INERT_LAUNCHER; ({ INERT_LAUNCHER: 1 })')).toEqual([])
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
