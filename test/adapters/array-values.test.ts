import type ts from "typescript"
import { describe, expect, it } from "vitest"
import type { ArrayFold } from "../../src/adapters/array-values.js"
import { createArrayFolder } from "../../src/adapters/array-values.js"
import { discoverBench } from "./discover-harness.js"

const FILE = "src/list.ts"

const SOURCE = [
  `const single = () => [{ id: 1 }]`,
  `export const spread = [...(await load()), { id: 0 }]`,
  `export const plain = [load(), { id: 2 }]`,
  `export const fallthrough = [...single(), ...load()]`,
  "",
].join("\n")

type OnCall = (call: ts.CallExpression, file: string) => ArrayFold | null

const bench = discoverBench({ [FILE]: SOURCE })
const { ctx } = bench

const initializerOf = (name: string): ts.Expression => {
  const declaration = bench.find(
    FILE,
    (node): node is ts.VariableDeclaration =>
      ctx.ts.isVariableDeclaration(node) && ctx.ast.asIdentifier(node.name)?.text === name,
  )
  if (declaration.initializer === undefined) throw new Error(`no initializer for ${name}`)
  return declaration.initializer
}

const foldNamed = (name: string, onCall?: OnCall): ArrayFold =>
  createArrayFolder(ctx, undefined, onCall === undefined ? {} : { onCall })(initializerOf(name), FILE)

const interpretLoad: OnCall = (call, file) => {
  if (ctx.ast.asIdentifier(call.expression)?.text !== "load") return null
  return { elements: [{ node: call, file, conditions: ["c"] }], unreadable: [] }
}

const textsOf = (fold: ArrayFold): readonly string[] => fold.elements.map((element) => element.node.getText())

describe("adapters/array-values createArrayFolder onCall", () => {
  it("interprets a spread of an awaited call", () => {
    const fold = foldNamed("spread", interpretLoad)

    expect(textsOf(fold)).toEqual(["load()", "{ id: 0 }"])
    expect(fold.elements[0]?.conditions).toEqual(["c"])
    expect(fold.unreadable).toEqual([])
  })

  it("interprets a plain call element as a spread-free element", () => {
    const fold = foldNamed("plain", interpretLoad)

    expect(textsOf(fold)).toEqual(["load()", "{ id: 2 }"])
  })

  it("falls through to the single-return fold when it returns null", () => {
    const fold = foldNamed("fallthrough", interpretLoad)

    expect(textsOf(fold)).toEqual(["{ id: 1 }", "load()"])
  })

  it("reports an awaited call as unreadable without the hook", () => {
    const fold = foldNamed("spread")

    expect(textsOf(fold)).toEqual(["{ id: 0 }"])
    expect(fold.unreadable).toHaveLength(1)
  })
})
