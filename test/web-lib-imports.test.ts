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

/** A relative specifier resolved to a FILE inside web/src/lib, or undefined. */
function resolveLocal(from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const base = resolve(dirname(from), spec)
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (isFile(c) && c.startsWith(LIB + sep)) return c
  }
  return undefined
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

function edges(files: string[]): [string, string][] {
  const out: [string, string][] = []
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const st of sf.statements) {
      const spec = specifierOf(st)
      const to = spec === undefined ? undefined : resolveLocal(file, spec)
      if (to !== undefined) out.push([rel(file), rel(to)])
    }
  }
  return out
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
  const es = edges(files)
  expect(cycle(es)).toBeUndefined()
  // Anti-vacuity: the walk saw the files M-4 was about and resolved the edge
  // each has to the leaf. A parser that found no edges would otherwise report
  // "no cycle" forever.
  expect(files.map(rel)).toEqual(expect.arrayContaining(['web/src/lib/api.ts', 'web/src/lib/session.ts', 'web/src/lib/storage-keys.ts']))
  expect(es).toContainEqual(['web/src/lib/api.ts', 'web/src/lib/storage-keys.ts'])
  expect(es).toContainEqual(['web/src/lib/session.ts', 'web/src/lib/storage-keys.ts'])
  expect(es).toContainEqual(['web/src/lib/session.ts', 'web/src/lib/api.ts'])
})

test('the cycle detector itself finds a cycle, and only a cycle', () => {
  expect(cycle([['a', 'b'], ['b', 'a']])).toEqual(['a', 'b', 'a'])
  expect(cycle([['a', 'b'], ['b', 'c'], ['c', 'a']])).toEqual(['a', 'b', 'c', 'a'])
  expect(cycle([['a', 'b'], ['b', 'c']])).toBeUndefined()
})
