import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createBuildModeReader } from "../../src/adapters/route-conditions.js"

const reader = createBuildModeReader(ts)

const expressionOf = (text: string): ts.Expression => {
  const source = ts.createSourceFile("probe.ts", `(${text})`, ts.ScriptTarget.Latest, true)
  const statement = source.statements[0]
  if (statement === undefined || !ts.isExpressionStatement(statement)) throw new Error("not an expression")
  return statement.expression
}

const markerIn = (text: string): ts.Node => {
  const source = ts.createSourceFile("probe.ts", text, ts.ScriptTarget.Latest, true)
  let found: ts.Node | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "marker") found = node
    node.forEachChild(visit)
  }
  visit(source)
  if (found === null) throw new Error("no marker")
  return found
}

describe("route-conditions: modeOf", () => {
  it.each([
    ["import.meta.env.DEV", "dev"],
    ["import.meta.env?.DEV", "dev"],
    ["!import.meta.env.DEV", "prod"],
    ["import.meta.env.PROD", "prod"],
    ["__DEV__", "dev"],
    ["process.env.NODE_ENV !== 'production'", "dev"],
    ["process.env.NODE_ENV === 'production'", "prod"],
    ["'development' === process.env.NODE_ENV", "dev"],
    ["import.meta.env.MODE === 'development'", "dev"],
    ["import.meta.env.DEV && user.isAdmin", "dev"],
    ["process.env.NODE_ENV === 'test'", null],
    ["flags.debug", null],
  ] as const)("%s → %s", (text, mode) => {
    expect(reader.modeOf(expressionOf(text))).toBe(mode)
  })
})

describe("route-conditions: requiredModeAt", () => {
  it.each([
    ["const xs = import.meta.env.DEV ? [marker] : []", "dev"],
    ["const xs = import.meta.env.PROD ? [] : [marker]", "dev"],
    ["const xs = __DEV__ && [marker]", "dev"],
    ["if (process.env.NODE_ENV !== 'production') { xs.push(marker) }", "dev"],
    ["if (import.meta.env.DEV) { } else { xs.push(marker) }", "prod"],
    ["if (import.meta.env.DEV) { if (ready) xs.push(marker) }", "dev"],
    ["const xs = [marker]", null],
  ] as const)("%s → %s", (text, mode) => {
    expect(reader.requiredModeAt(markerIn(text))).toBe(mode)
  })

  it("finds a throw reached only in a production build", () => {
    const scope = expressionOf("() => { if (!import.meta.env.DEV) throw notFound() }")
    expect(reader.blocksProduction(scope)).toBe(true)
    expect(reader.blocksProduction(expressionOf("() => { if (!session) throw redirect({ to: '/login' }) }"))).toBe(false)
  })
})
