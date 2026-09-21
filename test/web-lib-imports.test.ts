import { test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'
import * as ts from 'typescript'

// Review M-4. api.ts imported TOKEN_STORAGE_KEY from ./session while
// session.ts imported redeemHandoff from ./api: a static import cycle, which
// bundled only because neither module read the other's binding at evaluation
// time. This walks every static `import … from`, `export … from` and
// `import x = require(…)` in web/src/lib — RECURSIVELY, so a module in a
// subdirectory is an edge source too — type-only ones included (deleting the
// word `type` is all it takes to make one a value edge), and requires the
// graph between the lib's own files to be acyclic. Dynamic import() is out of
// scope on purpose: it is not evaluated at load.
const ROOT = join(import.meta.dir, '..')
const LIB = resolve(ROOT, 'web', 'src', 'lib')
const rel = (p: string) => relative(ROOT, p)

function libFiles(dir = LIB): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...libFiles(p))
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out.sort()
}

const isFile = (p: string) => { try { return statSync(p).isFile() } catch { return false } }

// Under `moduleResolution: bundler`, a `.js`-family suffix names the TS source
// beside it: `./session.js` IS session.ts to tsc and to the bundler. Where
// tsc is stricter (it maps .mjs/.cjs only to .mts/.cts), this over-approximates,
// which can only ADD edges: a cycle can be over-reported, never hidden.
const JS_TO_TS: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx'], '.jsx': ['.tsx', '.ts'], '.mjs': ['.mts', '.ts'], '.cjs': ['.cts', '.ts'],
}

/**
 * A relative specifier resolved to the FILE it names, or undefined when no
 * candidate exists. FAIL CLOSED: the caller treats undefined as a test
 * failure, never as a skipped edge — a specifier this resolver does not
 * understand is exactly where a cycle would hide (a `./session.js` re-export
 * once did, with typecheck green).
 */
function resolveRelative(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec)
  const ext = /\.[cm]?jsx?$/.exec(base)?.[0]
  const stem = ext === undefined ? base : base.slice(0, -ext.length)
  const candidates = [
    base,
    ...(ext === undefined ? [] : JS_TO_TS[ext]!.map((e) => stem + e)),
    `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx'),
  ]
  return candidates.find(isFile)
}

function specifierOf(st: ts.Statement): string | undefined {
  if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
    return st.moduleSpecifier.text
  }
  if (ts.isImportEqualsDeclaration(st) && ts.isExternalModuleReference(st.moduleReference)
    && ts.isStringLiteral(st.moduleReference.expression)) {
    return st.moduleReference.expression.text
  }
  return undefined
}

/** Edges between web/src/lib's own files, plus every relative specifier that resolved to nothing. */
function walk(files: string[]): { edges: [string, string][]; unresolved: string[] } {
  const edges: [string, string][] = []
  const unresolved: string[] = []
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const st of sf.statements) {
      const spec = specifierOf(st)
      if (spec === undefined || !spec.startsWith('.')) continue
      const to = resolveRelative(file, spec)
      if (to === undefined) unresolved.push(`${rel(file)} -> ${spec}`)
      else if (to.startsWith(LIB + sep)) edges.push([rel(file), rel(to)])
    }
  }
  return { edges, unresolved }
}

function cycle(es: [string, string][]): string[] | undefined {
  const next = new Map<string, string[]>()
  for (const [a, b] of es) next.set(a, [...(next.get(a) ?? []), b])
  const state = new Map<string, 'open' | 'done'>()
  const stack: string[] = []
  const visit = (n: string): string[] | undefined => {
    if (state.get(n) === 'open') return [...stack.slice(stack.indexOf(n)), n]
    if (state.get(n) === 'done') return undefined
    state.set(n, 'open')
    stack.push(n)
    for (const m of next.get(n) ?? []) {
      const c = visit(m)
      if (c) return c
    }
    stack.pop()
    state.set(n, 'done')
    return undefined
  }
  for (const n of next.keys()) {
    const c = visit(n)
    if (c) return c
  }
  return undefined
}

test('web/src/lib has no static import cycle', () => {
  const files = libFiles()
  const { edges: es, unresolved } = walk(files)
  expect(unresolved).toEqual([])
  expect(cycle(es)).toBeUndefined()
  // Anti-vacuity: the walk saw the files M-4 was about and resolved the edge
  // each has to the leaf. A parser that found no edges would otherwise report
  // "no cycle" forever.
  expect(files.map(rel)).toEqual(expect.arrayContaining(['web/src/lib/api.ts', 'web/src/lib/session.ts', 'web/src/lib/storage-keys.ts']))
  expect(es).toContainEqual(['web/src/lib/api.ts', 'web/src/lib/storage-keys.ts'])
  expect(es).toContainEqual(['web/src/lib/session.ts', 'web/src/lib/storage-keys.ts'])
  expect(es).toContainEqual(['web/src/lib/session.ts', 'web/src/lib/api.ts'])
})

// The resolver itself: the `.js` family maps onto the TS source, and a
// specifier naming no file comes back undefined (which the walk reports).
test('the resolver maps .js-family suffixes to their TS source and reports what it cannot resolve', () => {
  const api = join(LIB, 'api.ts')
  const session = join(LIB, 'session.ts')
  for (const spec of ['./session', './session.ts', './session.js', './session.jsx', './session.mjs', '../lib/session.js']) {
    expect([spec, resolveRelative(api, spec)]).toEqual([spec, session])
  }
  expect(resolveRelative(api, './no-such-module')).toBeUndefined()
  expect(resolveRelative(api, './no-such-module.js')).toBeUndefined()
})

test('the cycle detector itself finds a cycle, and only a cycle', () => {
  expect(cycle([['a', 'b'], ['b', 'a']])).toEqual(['a', 'b', 'a'])
  expect(cycle([['a', 'b'], ['b', 'c'], ['c', 'a']])).toEqual(['a', 'b', 'c', 'a'])
  expect(cycle([['a', 'b'], ['b', 'c']])).toBeUndefined()
})
