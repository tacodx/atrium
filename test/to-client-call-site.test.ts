import { test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as ts from 'typescript'

// Task 5 made `toClient` a required contract member and the scheduler's write
// path the SINGLE place it is applied: runNow computes the client value once
// and stores it in `last`, the one holder both /api/state and the WS push read.
// The plan's cross-task row 6 leans on that ("if the WS half stays green,
// redaction is being applied somewhere other than the single required
// location"), and nothing held it single. This pins it by AST: across every
// source file under src/, every CallExpression whose callee is the identifier
// `toClient`, a property access named `toClient` (optional or not) or an
// element access with the literal key 'toClient' — exactly one, in
// src/core/scheduler.ts, inside the anonymous async IIFE that runNow binds to
// `run`, as the initializer of `const wire`, next to the only `last.set`.
//
// A TRIPWIRE, not a proof. Comments, the contract's method signature and the
// provider's `toClient: reposToClient` property are not calls and are not
// counted (the synthetic check below holds that). A call through a re-bound
// name (`const f = p.toClient; f(d)`) or a direct call of a provider's own
// implementation (`reposToClient(d)`) is invisible to it.

const ROOT = join(import.meta.dir, '..')
const SRC = join(ROOT, 'src')

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFilesUnder(p))
    else if (/\.[cm]?[jt]sx?$/.test(e.name)) out.push(p)
  }
  return out.sort()
}

function isToClientCallee(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return callee.text === 'toClient'
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'toClient'
  if (ts.isElementAccessExpression(callee)) {
    const k = callee.argumentExpression
    return (ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k)) && k.text === 'toClient'
  }
  return false
}

/** The name a function-like node goes by: its own, or the variable its (called) value is bound to. */
function functionLabel(fn: ts.Node): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined) {
    return fn.name.getText()
  }
  let m: ts.Node = fn
  while (ts.isParenthesizedExpression(m.parent)) m = m.parent
  const iife = ts.isCallExpression(m.parent) && m.parent.expression === m ? ' IIFE' : ''
  // Climb through the call, any `.then`/`.finally` chained on it and any await,
  // to the variable the whole expression initialises.
  let n: ts.Node = fn
  while (
    ts.isParenthesizedExpression(n.parent) || ts.isCallExpression(n.parent) || ts.isAwaitExpression(n.parent)
    || (ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)
  ) n = n.parent
  const bound = ts.isVariableDeclaration(n.parent) ? n.parent.name.getText() : '?'
  const kind = ts.isArrowFunction(fn) ? 'arrow' : 'function'
  const mods = ts.canHaveModifiers(fn) ? ts.getModifiers(fn) : undefined
  const async = mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''
  return `<${async}${kind}${iife} bound to ${bound}>`
}

interface Site { file: string; chain: string[]; call: ts.CallExpression; fn: ts.Node | undefined }

function toClientCalls(fileName: string, text: string): Site[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const out: Site[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isToClientCallee(node.expression)) {
      const chain: string[] = []
      let fn: ts.Node | undefined
      for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
        if (ts.isFunctionLike(p)) {
          fn ??= p
          chain.unshift(functionLabel(p))
        }
      }
      out.push({ file: fileName, chain, call: node, fn })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

const describeSite = (s: Site) => `${s.file} :: ${s.chain.join(' > ')}`

test('the scanner counts calls only: comments, signatures and property values are not call sites', () => {
  const sample = [
    '// p.toClient(data) in a comment',
    '/* toClient(x) */',
    'interface P { toClient(data: unknown): unknown }',
    'type Q = { toClient: (d: unknown) => unknown }',
    'const provider = { toClient: reposToClient }',
    'const s = "p.toClient(d)"',
    'function a(p: P) { return p.toClient(1) }',
    'const b = (p: P) => p?.toClient?.(2)',
    "const c = (p: P) => p['toClient'](3)",
    'const d = () => toClient(4)',
    'const e = (async () => { const w = toClient(5) })().finally(() => {})',
  ].join('\n')
  const got = toClientCalls('sample.ts', sample).map((s) => [s.chain.join(' > '), s.call.arguments[0]?.getText()])
  expect(got).toEqual([
    ['a', '1'],
    ['<arrow bound to b>', '2'],
    ['<arrow bound to c>', '3'],
    ['<arrow bound to d>', '4'],
    ['<async arrow IIFE bound to e>', '5'],
  ])
})

test('toClient is called at exactly one site under src/: the scheduler write path that stores `last`', () => {
  const files = sourceFilesUnder(SRC)
  // Not hollow: the walk found the scheduler and more than a handful of files.
  expect(files).toContain(join(SRC, 'core', 'scheduler.ts'))
  expect(files.length).toBeGreaterThan(5)

  const sites = files.flatMap((f) => toClientCalls(relative(ROOT, f), readFileSync(f, 'utf8')))
  expect(sites.map(describeSite)).toEqual([
    'src/core/scheduler.ts :: createScheduler > runNow > <async arrow IIFE bound to run>',
  ])

  // Inside the function that WRITES `last`: the call is `const wire = p.toClient(data)`,
  // and the same innermost function holds the file's only `last.set(…)`, storing `wire`.
  const site = sites[0]!
  expect(site.call.getText()).toBe('p.toClient(data)')
  const decl = site.call.parent
  expect(ts.isVariableDeclaration(decl) && decl.name.getText() === 'wire').toBe(true)

  const writes: Array<{ args: string; fn: ts.Node | undefined }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'set' && node.expression.expression.getText() === 'last') {
      let fn: ts.Node | undefined
      for (let p: ts.Node | undefined = node.parent; p !== undefined && fn === undefined; p = p.parent) if (ts.isFunctionLike(p)) fn = p
      writes.push({ args: node.arguments.map((a) => a.getText()).join(', '), fn })
    }
    ts.forEachChild(node, visit)
  }
  visit(site.call.getSourceFile())
  expect(writes.map((w) => w.args)).toEqual(['providerId, wire'])
  expect(writes[0]!.fn).toBe(site.fn)
})
