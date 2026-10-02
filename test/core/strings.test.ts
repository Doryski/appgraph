import { describe, expect, it } from "vitest"
import ts from "typescript"
import { createAst } from "../../src/core/ast.js"
import {
  baseMembersOf,
  collectStringConstants,
  collectStringMembers,
  createScopedStrings,
  createStringTable,
  fileStrings,
  partialMembersOf,
} from "../../src/core/strings.js"

const parse = (code: string, name = "/repo/src/file.ts"): ts.SourceFile =>
  ts.createSourceFile(name, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)

const members = (code: string) => Object.fromEntries(collectStringMembers(ts, parse(code)))

const constants = (code: string, table: Record<string, string> = {}) =>
  Object.fromEntries(collectStringConstants(ts, parse(code), new Map(Object.entries(table))))

describe("collectStringMembers — string enums (preserved from readStringEnum)", () => {
  it("keys string enum members as Enum.Member", () => {
    expect(members("export enum Paths { ORDERS = '/orders', INVOICES = '/invoices' }")).toEqual({
      "Paths.ORDERS": "/orders",
      "Paths.INVOICES": "/invoices",
    })
  })

  it("ignores numeric and computed enum members", () => {
    expect(members("enum Level { LOW = 1, HIGH = 2 }")).toEqual({})
    expect(members("enum Auto { A, B }")).toEqual({})
  })
})

describe("collectStringMembers — `as const` object maps", () => {
  it("reads a plain object literal map", () => {
    expect(members("const Paths = { ORDERS: '/orders' }")).toEqual({ "Paths.ORDERS": "/orders" })
  })

  it("reads an `as const` object map — the dominant modern pattern", () => {
    expect(members("export const Paths = { ORDERS: '/', INVOICES: '/invoices' } as const")).toEqual({
      "Paths.ORDERS": "/",
      "Paths.INVOICES": "/invoices",
    })
  })

  it("reads `satisfies` and `as const satisfies` maps", () => {
    expect(members("const Paths = { ORDERS: '/orders' } satisfies Record<string, string>")).toEqual({
      "Paths.ORDERS": "/orders",
    })
    expect(members("const Paths = { ORDERS: '/orders' } as const satisfies Record<string, string>")).toEqual({
      "Paths.ORDERS": "/orders",
    })
  })

  it("reads Object.freeze({...}) maps", () => {
    expect(members("const Paths = Object.freeze({ ORDERS: '/orders' })")).toEqual({ "Paths.ORDERS": "/orders" })
  })

  it("reads nested maps as dotted keys", () => {
    expect(members("const Paths = { orders: { LIST: '/orders', NEW: '/orders/new' } } as const")).toEqual({
      "Paths.orders.LIST": "/orders",
      "Paths.orders.NEW": "/orders/new",
    })
  })

  it("accepts string and numeric property keys and skips non-string values", () => {
    expect(members("const Map1 = { 'a-b': '/a', 2: '/two', n: 3, f: () => null } as const")).toEqual({
      "Map1.a-b": "/a",
      "Map1.2": "/two",
    })
  })

  it("does not hoist object maps declared inside a function", () => {
    expect(members("const f = () => { const Paths = { ORDERS: '/orders' } as const; return Paths }")).toEqual({})
  })
})

describe("collectStringConstants — the three-pass fixpoint", () => {
  it("folds a literal constant", () => {
    expect(constants("const BASE = '/api'")).toEqual({ BASE: "/api" })
  })

  it("folds a constant declared in terms of a constant declared BELOW it", () => {
    expect(constants(["const API = `${BASE}/v1`", "const BASE = '/api'"].join("\n"))).toEqual({
      API: "/api/v1",
      BASE: "/api",
    })
  })

  it("reaches a three-deep chain declared in reverse order — this is why it is three passes", () => {
    expect(constants(["const C = `${B}/c`", "const B = `${A}/b`", "const A = '/a'"].join("\n"))).toEqual({
      A: "/a",
      B: "/a/b",
      C: "/a/b/c",
    })
  })

  it("records only non-dynamic values and never overwrites an existing key", () => {
    expect(constants(["const D = `${unknownThing}/x`", "const E = 'ok'", "const E = 'shadow'"].join("\n"))).toEqual({
      E: "ok",
    })
  })

  it("folds through the shared string table when one is supplied", () => {
    expect(constants("const ORDERS = Paths.ORDERS", { "Paths.ORDERS": "/orders" })).toEqual({
      ORDERS: "/orders",
    })
  })

  it("folds `+` concatenation and leaves non-strings alone", () => {
    expect(constants(["const P = A + '/b'", "const A = '/a'", "const N = 42"].join("\n"))).toEqual({
      A: "/a",
      P: "/a/b",
    })
  })
})

describe("createStringTable", () => {
  it("merges members across files and answers the same lookup shape as the enum table", () => {
    const table = createStringTable(ts)
    table.add(parse("export const Paths = { ORDERS: '/' } as const", "/repo/src/paths.ts"))
    table.add(parse("export enum Legacy { HOME = '/home' }", "/repo/src/legacy.ts"))

    expect(table.get("Paths.ORDERS")).toBe("/")
    expect(table.get("Legacy.HOME")).toBe("/home")
    expect(table.get("Paths.MISSING")).toBeNull()
    expect(table.has("Legacy.HOME")).toBe(true)
    expect(table.size()).toBe(2)
    expect(table.entries()).toEqual([
      ["Legacy.HOME", "/home"],
      ["Paths.ORDERS", "/"],
    ])
  })

  it("builds a per-file StringContext whose identifiers fold through the shared table", () => {
    const table = createStringTable(ts)
    table.add(parse("export const Paths = { ORDERS: '/orders' } as const", "/repo/src/paths.ts"))

    const consumer = parse("const TARGET = Paths.ORDERS", "/repo/src/consumer.ts")
    const context = table.contextFor(consumer)

    expect(context.constants.get("TARGET")).toBe("/orders")
    expect(context.members.get("Paths.ORDERS")).toBe("/orders")
    expect(table.contextFor(consumer)).toBe(context)
  })

  it("invalidates cached contexts when a new source adds members", () => {
    const table = createStringTable(ts)
    const consumer = parse("const TARGET = Paths.ORDERS", "/repo/src/consumer.ts")

    expect(table.contextFor(consumer).constants.get("TARGET")).toBeUndefined()

    table.add(parse("export const Paths = { ORDERS: '/orders' } as const", "/repo/src/paths.ts"))
    expect(table.contextFor(consumer).constants.get("TARGET")).toBe("/orders")
  })
})

const identifierNamed = (source: ts.SourceFile, name: string, occurrence: number): ts.Identifier => {
  const found: ts.Identifier[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && !ts.isVariableDeclaration(node.parent)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  const identifier = found[occurrence]
  if (identifier === undefined) throw new Error(`no use #${String(occurrence)} of ${name}`)
  return identifier
}

describe("createScopedStrings — scope-aware folding", () => {
  const twoFunctions = [
    "function loadOrders() { const url = '/api/orders'; return get(url) }",
    "function loadUsers() { const url = '/api/users'; return del(url) }",
  ].join("\n")

  it("resolves each use of a same-named const to the declaration in its own function", () => {
    const source = parse(twoFunctions)
    const scoped = createScopedStrings(ts, source)
    expect(scoped.contextAt(identifierNamed(source, "url", 0)).constants.get("url")).toBe("/api/orders")
    expect(scoped.contextAt(identifierNamed(source, "url", 1)).constants.get("url")).toBe("/api/users")
  })

  it("leaves an ambiguous nested name out of the file-wide table instead of picking the first", () => {
    expect(constants(twoFunctions)).toEqual({})
  })

  it("keeps a module-scope constant file-wide and lets an inner declaration shadow it", () => {
    const source = parse(
      ["const url = '/outer'", "function f(url) { return get(url) }", "function g() { return get(url) }"].join("\n"),
    )
    const scoped = createScopedStrings(ts, source)
    expect(scoped.context.constants.get("url")).toBe("/outer")
    expect(scoped.contextAt(identifierNamed(source, "url", 1)).constants.get("url")).toBeUndefined()
    expect(scoped.contextAt(identifierNamed(source, "url", 2)).constants.get("url")).toBe("/outer")
  })

  it("folds an inner constant through an outer one declared in an enclosing scope", () => {
    const source = parse(["const BASE = '/api'", "function f() { const url = `${BASE}/orders`; return get(url) }"].join("\n"))
    const scoped = createScopedStrings(ts, source)
    expect(scoped.contextAt(identifierNamed(source, "url", 0)).constants.get("url")).toBe("/api/orders")
    expect(constants(source.text)).toEqual({ BASE: "/api", url: "/api/orders" })
  })

  it("keeps a block-scoped const inside its block and hoists a var to the function", () => {
    const source = parse(
      ["function f() {", "  if (a) { const u = '/block'; var v = '/var' }", "  return [get(u), get(v)]", "}"].join("\n"),
    )
    const scoped = createScopedStrings(ts, source)
    expect(scoped.contextAt(identifierNamed(source, "u", 0)).constants.get("u")).toBeUndefined()
    expect(scoped.contextAt(identifierNamed(source, "v", 0)).constants.get("v")).toBe("/var")
  })

  it("does not throw on a string chain deep enough to overflow the recursive folder", () => {
    const deep = `const BIG = ${Array.from({ length: 6000 }, (_, index) => `"s${String(index)}"`).join(" + ")}`
    expect(() => createScopedStrings(ts, parse(deep))).not.toThrow()
  })
})

describe("fileStrings — one scoped table per declaring file (C18)", () => {
  it("caches per source and remembers the base members it was built over", () => {
    const base = new Map([["Paths.HOME", "/"]])
    const source = parse("export const HOME = Paths.HOME")
    const first = fileStrings(ts, source, base)

    expect(fileStrings(ts, source, base)).toBe(first)
    expect(first.context.constants.get("HOME")).toBe("/")
    expect(baseMembersOf(first.context)).toBe(base)
  })
})

const lastExpression = (source: ts.SourceFile): ts.Expression => {
  const statement = source.statements.at(-1)
  if (statement === undefined || !ts.isExpressionStatement(statement)) throw new Error("no trailing expression")
  return statement.expression
}

const binariesIn = (source: ts.SourceFile): readonly ts.BinaryExpression[] => {
  const found: ts.BinaryExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const flatOf = (source: ts.SourceFile, node: ts.Node, base: ReadonlyMap<string, string> = new Map()) =>
  createAst(ts).flattenString(node, fileStrings(ts, source, base).contextAt(node))

describe("static class fields as members (GR8)", () => {
  const runnerService = [
    "import { environment } from '../environments/environment'",
    "export class RunnerService {",
    "  static BASE_RUNNER_URL = environment.apiUrl + '/api/v1/runners'",
    "  private static readonly STATIC_URL = '/api/v1/static'",
    "  static readonly JOBS_URL = RunnerService.BASE_RUNNER_URL + '/jobs'",
    "}",
  ].join("\n")

  it("folds a same-file static field, keeping an unknown prefix as :param and marking it dynamic", () => {
    const source = parse(`${runnerService}\nRunnerService.BASE_RUNNER_URL + '/jobs'`)
    expect(flatOf(source, lastExpression(source))).toEqual({ value: ":param/api/v1/runners/jobs", dynamic: true })
  })

  it("keeps a fully literal static field static and chains static fields through each other", () => {
    const source = parse(`${runnerService}\nRunnerService.JOBS_URL`)
    const context = fileStrings(ts, source, new Map()).context
    expect(context.members.get("RunnerService.STATIC_URL")).toBe("/api/v1/static")
    expect(context.partialMembers?.get("RunnerService.JOBS_URL")).toBe(":param/api/v1/runners/jobs")
  })

  it("resolves `this.X` inside a static method (through an arrow) and a static initializer", () => {
    const source = parse(
      [
        "class Api {",
        "  static BASE = '/api'",
        "  static url() { return () => this.BASE + '/x' }",
        "  static FULL = this.BASE + '/full'",
        "}",
      ].join("\n"),
    )
    expect(binariesIn(source).map((node) => flatOf(source, node))).toEqual([
      { value: "/api/x", dynamic: false },
      { value: "/api/full", dynamic: false },
    ])
    expect(fileStrings(ts, source, new Map()).context.members.get("Api.FULL")).toBe("/api/full")
  })

  it("leaves `this.X` in an instance method and `this.constructor.X` unknown, as :param", () => {
    const source = parse(
      [
        "class Api {",
        "  static BASE = '/api'",
        "  load() { return [this.BASE + '/x', this.constructor.BASE + '/y'] }",
        "}",
      ].join("\n"),
    )
    expect(binariesIn(source).map((node) => flatOf(source, node))).toEqual([
      { value: ":param/x", dynamic: true },
      { value: ":param/y", dynamic: true },
    ])
  })

  it("resolves `ClassName.X` imported from a string-source file through the shared table", () => {
    const table = createStringTable(ts)
    table.add(parse(runnerService, "/repo/src/runner.service.ts"))
    table.add(parse("export class Paths { static readonly HOME = '/home' }", "/repo/src/paths.ts"))

    expect(table.get("Paths.HOME")).toBe("/home")
    expect(partialMembersOf(table.members).get("RunnerService.BASE_RUNNER_URL")).toBe(":param/api/v1/runners")

    const consumer = parse(
      "import { RunnerService } from './runner.service'\nRunnerService.BASE_RUNNER_URL + '/jobs'",
      "/repo/src/consumer.ts",
    )
    expect(flatOf(consumer, lastExpression(consumer), table.members)).toEqual({
      value: ":param/api/v1/runners/jobs",
      dynamic: true,
    })
  })

  it("does not let a static field shadow an existing literal member of the same key", () => {
    const base = new Map([["Api.BASE", "/v2"]])
    const source = parse("class Api { static BASE = '/v1' }\nApi.BASE")
    expect(flatOf(source, lastExpression(source), base)).toEqual({ value: "/v2", dynamic: false })
  })
})
