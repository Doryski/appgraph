import ts from "typescript"
import { describe, expect, it } from "vitest"
import type { Binding } from "../../src/core/model.js"
import { createStringValueReader, importedBindingOf } from "../../src/adapters/values.js"
import { discoverBench } from "./discover-harness.js"

describe("adapters/values importedBindingOf", () => {
  it("projects module and imported name from static and dynamic imports", () => {
    const staticImport: Binding = { kind: "import", module: "./a", imported: "X", file: "src/a.ts" }
    const dynamicImport: Binding = { kind: "dynamic-import", module: "./b", imported: "default", file: null }

    expect(importedBindingOf(staticImport)).toEqual({ module: "./a", imported: "X" })
    expect(importedBindingOf(dynamicImport)).toEqual({ module: "./b", imported: "default" })
  })

  it("is null for null, locals and hook results", () => {
    expect(importedBindingOf(null)).toBeNull()
    expect(importedBindingOf({ kind: "local", declaredAt: 0 })).toBeNull()
    expect(importedBindingOf({ kind: "hook-result", hook: "useX", module: null })).toBeNull()
  })
})

describe("adapters/values createStringValueReader", () => {
  const FILES = {
    "src/paths.ts": [
      `export enum Paths { LOGIN = "/login", HOME = "/" }`,
      `export const ROUTES = { orders: "/orders", nested: { id: "/n" } } as const`,
      `export const NOT_CONST = { n: compute() }`,
      "",
    ].join("\n"),
    "src/router.tsx": [
      `import { Paths, ROUTES as R } from "./paths"`,
      `import { Missing } from "./nowhere"`,
      `import * as NS from "./paths"`,
      `enum Local { A = "/local-a" }`,
      `const own = { page: "/own-page" } as const`,
      `const num = 3`,
      `Paths.LOGIN; Paths.HOME; Paths.NOPE`,
      `R.orders; R.nested.id; R.missing`,
      `Local.A; own.page; Missing.X`,
      `NS.Paths; "/literal"; num; Paths["LOGIN"]; call().x; Paths.LOGIN.length`,
      "",
    ].join("\n"),
  }

  const statementValues = (): Record<string, string | null> => {
    const bench = discoverBench(FILES)
    const reader = createStringValueReader(bench.ctx)
    const source = bench.ctx.sourceFile("src/router.tsx")
    const out: Record<string, string | null> = {}
    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)) out[node.expression.getText()] = reader(node.expression, "src/router.tsx")
      node.forEachChild(visit)
    }
    if (source !== null) visit(source)
    return out
  }

  it("returns null for an undefined node", () => {
    const bench = discoverBench(FILES)

    expect(createStringValueReader(bench.ctx)(undefined, "src/router.tsx")).toBeNull()
  })

  it("reads a member of an enum declared in an imported file", () => {
    const values = statementValues()

    expect(values["Paths.LOGIN"]).toBe("/login")
    expect(values["Paths.HOME"]).toBe("/")
  })

  it("follows an aliased import to the declaring file's const map", () => {
    expect(statementValues()["R.orders"]).toBe("/orders")
  })

  it("resolves a NESTED member through an import although the member table holds it (src/adapters/values.ts:42-52 reads only root.member)", () => {
    expect(statementValues()["R.nested.id"]).toBe("/n")
  })

  it("reads members declared in the SAME file without any import", () => {
    const values = statementValues()

    expect(values["Local.A"]).toBe("/local-a")
    expect(values["own.page"]).toBe("/own-page")
  })

  it("is null for an unknown member, an unresolvable import, a namespace root and non-string values", () => {
    const values = statementValues()

    expect(values["Paths.NOPE"]).toBeNull()
    expect(values["R.missing"]).toBeNull()
    expect(values["Missing.X"]).toBeNull()
    expect(values["NS.Paths"]).toBeNull()
    expect(values["num"]).toBeNull()
  })

  it("is null when the receiver is a call or a computed key, never guessing", () => {
    const values = statementValues()

    expect(values["call().x"]).toBeNull()
    expect(values['Paths["LOGIN"]']).toBeNull()
  })

  it("folds plain string literals directly", () => {
    expect(statementValues()['"/literal"']).toBe("/literal")
  })

  it("does not treat `.length` of a resolved member as a string", () => {
    expect(statementValues()["Paths.LOGIN.length"]).toBeNull()
  })

  it("keeps independent readers independent and stays stable across repeated reads", () => {
    const bench = discoverBench(FILES)
    const target = bench.find("src/router.tsx", (node): node is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(node) && node.getText() === "Paths.LOGIN")
    const first = createStringValueReader(bench.ctx)
    const second = createStringValueReader(bench.ctx)

    expect([first(target, "src/router.tsx"), first(target, "src/router.tsx"), second(target, "src/router.tsx")]).toEqual([
      "/login",
      "/login",
      "/login",
    ])
  })

  it("reads nothing from a file whose source is unavailable", () => {
    const bench = discoverBench({ "src/router.tsx": `import { Paths } from "./gone"\nPaths.LOGIN` })
    const target = bench.find("src/router.tsx", (node): node is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(node))

    expect(createStringValueReader(bench.ctx)(target, "src/router.tsx")).toBeNull()
    expect(createStringValueReader(bench.ctx)(target, "src/not-a-file.tsx")).toBeNull()
  })
})
