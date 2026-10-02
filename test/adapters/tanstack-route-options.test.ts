import ts from "typescript"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_PATHLESS_ROLES,
  OUTLET_SPLICE,
  authOfLayers,
  createRouteOptionsReader,
} from "../../src/adapters/tanstack-route-options.js"
import type { ComponentRef } from "../../src/adapters/tanstack-route-options.js"
import { discoverBench } from "./discover-harness.js"

const TANSTACK = `import { createRoute, createRootRoute, createFileRoute, lazyRouteComponent, redirect, Outlet } from "@tanstack/react-router"`

const bench = (files: Readonly<Record<string, string>>) => {
  const base = discoverBench(files)
  const reader = createRouteOptionsReader(base.ctx)
  const call = (file: string, callee: string): ts.CallExpression =>
    base.find(file, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText() === callee)
  const optionsOf = (file: string, callee: string): ts.Node | null => call(file, callee).arguments[0] ?? null
  return { ...base, reader, call, optionsOf }
}

describe("adapters/tanstack-route-options: pathless roles", () => {
  it("names _authed as the one built-in protected layer", () => {
    expect(DEFAULT_PATHLESS_ROLES).toEqual({ _authed: { auth: "protected" } })
  })

  it("returns the OUTERMOST layer's auth, skipping layers without a role", () => {
    const roles = { _a: { auth: "public" }, _b: { auth: "protected" }, _plain: {} } as const

    expect(authOfLayers(roles, ["_plain", "_a", "_b"])).toBe("public")
    expect(authOfLayers(roles, ["_b", "_a"])).toBe("protected")
  })

  it("is null for no layers, unknown layers and layers whose role names no auth", () => {
    expect(authOfLayers(DEFAULT_PATHLESS_ROLES, [])).toBeNull()
    expect(authOfLayers(DEFAULT_PATHLESS_ROLES, ["_other"])).toBeNull()
    expect(authOfLayers({ _x: {} }, ["_x"])).toBeNull()
  })

  it("does not read inherited object keys as roles", () => {
    expect(authOfLayers(DEFAULT_PATHLESS_ROLES, ["constructor", "toString"])).toBeNull()
  })
})

describe("adapters/tanstack-route-options: calleeName", () => {
  it("returns the IMPORTED name, so an aliased TanStack import still matches", () => {
    const { reader, call } = bench({
      "src/r.tsx": `import { createRoute as route, redirect } from "@tanstack/react-router"\nroute({})\nredirect({ to: "/" })`,
    })

    expect(reader.calleeName(call("src/r.tsx", "route"), "src/r.tsx")).toBe("createRoute")
    expect(reader.calleeName(call("src/r.tsx", "redirect"), "src/r.tsx")).toBe("redirect")
  })

  it("accepts a namespace member call by its written member name", () => {
    const { reader, call } = bench({
      "src/r.tsx": `import * as Router from "@tanstack/react-router"\nRouter.createRoute({})`,
    })

    expect(reader.calleeName(call("src/r.tsx", "Router.createRoute"), "src/r.tsx")).toBe("createRoute")
  })

  it("rejects a same-named local function, a hook result and a non-TanStack package export", () => {
    const { reader, call } = bench({
      "src/r.tsx": [
        `import { createRoute as pkgRoute } from "some-other-lib"`,
        `const { redirect } = useThing()`,
        `function createRoute() {}`,
        `createRoute({})`,
        `redirect("/x")`,
        `pkgRoute({})`,
      ].join("\n"),
    })

    expect(reader.calleeName(call("src/r.tsx", "createRoute"), "src/r.tsx")).toBeNull()
    expect(reader.calleeName(call("src/r.tsx", "redirect"), "src/r.tsx")).toBeNull()
    expect(reader.calleeName(call("src/r.tsx", "pkgRoute"), "src/r.tsx")).toBeNull()
  })

  it("rejects a project module's own function that merely shares a factory's name", () => {
    const { reader, call } = bench({
      "src/helpers.ts": `export const createRoute = (o: unknown) => o`,
      "src/r.tsx": `import { createRoute } from "./helpers"\ncreateRoute({})`,
    })

    expect(reader.calleeName(call("src/r.tsx", "createRoute"), "src/r.tsx")).toBeNull()
  })

  it("is null for callees that are not a plain name or member (calls of calls, element access)", () => {
    const { reader, call } = bench({ "src/r.tsx": `makeFactory()({})\nmap["createRoute"]({})` })

    expect(reader.calleeName(call("src/r.tsx", "makeFactory()"), "src/r.tsx")).toBeNull()
    expect(reader.calleeName(call("src/r.tsx", 'map["createRoute"]'), "src/r.tsx")).toBeNull()
  })
})

describe("adapters/tanstack-route-options: wrappedFactoryOf", () => {
  const WRAPPER = [
    `import { createRoute as base } from "@tanstack/react-router"`,
    `export const createRoute = (options: object) => base({ ...options })`,
  ].join("\n")

  it("recognises a project wrapper named like a factory whose module calls the real one", () => {
    const { reader, call } = bench({
      "src/route-factory.ts": WRAPPER,
      "src/r.tsx": `import { createRoute } from "./route-factory"\ncreateRoute({})`,
    })

    expect(reader.wrappedFactoryOf(call("src/r.tsx", "createRoute"), "src/r.tsx")).toEqual({
      name: "createRoute",
      file: "src/route-factory.ts",
      factory: "createRoute",
    })
  })

  it("recognises a wrapper declared in the same file", () => {
    const { reader, call } = bench({
      "src/r.tsx": [
        `import { createRoute as base } from "@tanstack/react-router"`,
        `const createRoute = (o: object) => base(o)`,
        `createRoute({})`,
      ].join("\n"),
    })

    expect(reader.wrappedFactoryOf(call("src/r.tsx", "createRoute"), "src/r.tsx")).toEqual({
      name: "createRoute",
      file: "src/r.tsx",
      factory: "createRoute",
    })
  })

  it("is null for the real TanStack factory itself", () => {
    const { reader, call } = bench({ "src/r.tsx": `${TANSTACK}\ncreateRoute({})` })

    expect(reader.wrappedFactoryOf(call("src/r.tsx", "createRoute"), "src/r.tsx")).toBeNull()
  })

  it("is null for an unrelated app function of the same name, and for non-factory names", () => {
    const { reader, call } = bench({
      "src/helpers.ts": `export const createRoute = (o: unknown) => o\nexport const other = () => 1`,
      "src/r.tsx": `import { createRoute, other } from "./helpers"\ncreateRoute({})\nother()`,
    })

    expect(reader.wrappedFactoryOf(call("src/r.tsx", "createRoute"), "src/r.tsx")).toBeNull()
    expect(reader.wrappedFactoryOf(call("src/r.tsx", "other"), "src/r.tsx")).toBeNull()
  })

  it("is null for an unbound callee and for a member-expression callee", () => {
    const { reader, call } = bench({ "src/r.tsx": `createRoute({})\nR.createRoute({})` })

    expect(reader.wrappedFactoryOf(call("src/r.tsx", "createRoute"), "src/r.tsx")).toBeNull()
    expect(reader.wrappedFactoryOf(call("src/r.tsx", "R.createRoute"), "src/r.tsx")).toBeNull()
  })
})

describe("adapters/tanstack-route-options: members", () => {
  const { reader, optionsOf } = bench({
    "src/r.tsx": `foo({ path: "/a", "quoted-key": 1, [computed]: 2, ...spread, shorthand, method() {}, 7: "seven" })`,
  })
  const options = optionsOf("src/r.tsx", "foo")

  it("lists identifier and string-literal keys in source order, dropping computed keys and spreads", () => {
    expect(reader.membersOf(options).map((member) => member.name)).toEqual(["path", "quoted-key", "shorthand", "method"])
  })

  it("exposes each member's value node, which for shorthand is the name itself", () => {
    const members = reader.membersOf(options)

    expect(members[0]?.value.getText()).toBe(`"/a"`)
    expect(members.find((member) => member.name === "shorthand")?.value.getText()).toBe("shorthand")
  })

  it("returns nothing for null and non-object nodes", () => {
    expect(reader.membersOf(null)).toEqual([])
    const { reader: other, optionsOf: otherOptions } = bench({ "src/r.tsx": `foo("str")\nbar([1])` })

    expect(other.membersOf(otherOptions("src/r.tsx", "foo"))).toEqual([])
    expect(other.membersOf(otherOptions("src/r.tsx", "bar"))).toEqual([])
  })

  it("looks a member up by exact name", () => {
    expect(reader.memberNamed(options, "path")?.name).toBe("path")
    expect(reader.memberNamed(options, "Path")).toBeNull()
    expect(reader.memberNamed(null, "path")).toBeNull()
  })
})

describe("adapters/tanstack-route-options: componentOf and entryOf", () => {
  const FILES = {
    "src/Page.tsx": `export default function Page() { return <div /> }\nexport const Named = () => <div />`,
    "src/r.tsx": [
      TANSTACK,
      `import Imported from "./Page"`,
      `function LocalPage() { return <Outlet /> }`,
      `const none = createRoute({ path: "/none" })`,
      `const inline = createRoute({ component: () => <div /> })`,
      `const inlineFn = createRoute({ component: function () { return null } })`,
      `const imported = createRoute({ component: Imported })`,
      `const local = createRoute({ component: LocalPage })`,
      `const lazy = createRoute({ component: lazyRouteComponent(() => import("./Page"), "Named") })`,
      `const lazyDefault = createRoute({ component: lazyRouteComponent(() => import("./Page")) })`,
      `const lazyDynamic = createRoute({ component: lazyRouteComponent(() => import(spec)) })`,
      `const undeclared = createRoute({ component: Ghost })`,
      `const call = createRoute({ component: makeComponent() })`,
      `const member = createRoute({ component: pages.Home })`,
    ].join("\n"),
  }

  const componentOfRoute = (routeName: string): { ref: ComponentRef; b: ReturnType<typeof bench> } => {
    const b = bench(FILES)
    const declaration = b.find("src/r.tsx", (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText() === routeName)
    const call = declaration.initializer
    if (call === undefined || !ts.isCallExpression(call)) throw new Error("not a call")
    return { ref: b.reader.componentOf(call.arguments[0] ?? null, "src/r.tsx"), b }
  }

  it("is `none` without a component option, and for null options", () => {
    expect(componentOfRoute("none").ref).toEqual({ kind: "none" })
    expect(bench(FILES).reader.componentOf(null, "src/r.tsx")).toEqual({ kind: "none" })
  })

  it("classifies arrow and function expressions as inline", () => {
    expect(componentOfRoute("inline").ref.kind).toBe("inline")
    expect(componentOfRoute("inlineFn").ref.kind).toBe("inline")
  })

  it("classifies identifiers as imported, local or (when undeclared) opaque", () => {
    expect(componentOfRoute("imported").ref).toEqual({ kind: "imported", file: "src/r.tsx", local: "Imported" })
    expect(componentOfRoute("local").ref).toEqual({ kind: "local", file: "src/r.tsx", name: "LocalPage" })
    expect(componentOfRoute("undeclared").ref.kind).toBe("opaque")
  })

  it("reads lazyRouteComponent's module and export, defaulting the export to `default`", () => {
    expect(componentOfRoute("lazy").ref).toEqual({ kind: "lazy-module", file: "src/r.tsx", spec: "./Page", exported: "Named" })
    expect(componentOfRoute("lazyDefault").ref).toEqual({ kind: "lazy-module", file: "src/r.tsx", spec: "./Page", exported: "default" })
  })

  it("falls back to opaque for a lazy loader with a non-literal specifier, a call and a member", () => {
    expect(componentOfRoute("lazyDynamic").ref.kind).toBe("opaque")
    expect(componentOfRoute("call").ref.kind).toBe("opaque")
    expect(componentOfRoute("member").ref.kind).toBe("opaque")
  })

  it("maps each kind to its entry reference", () => {
    expect(componentOfRoute("none").b.reader.entryOf({ kind: "none" })).toBeNull()
    expect(componentOfRoute("local").b.reader.entryOf({ kind: "local", file: "f.tsx", name: "N" })).toEqual({
      kind: "file",
      file: "f.tsx",
      exportName: "N",
    })
    expect(componentOfRoute("imported").b.reader.entryOf({ kind: "imported", file: "f.tsx", local: "L" })).toEqual({
      kind: "binding",
      from: "f.tsx",
      local: "L",
    })
    expect(componentOfRoute("lazy").b.reader.entryOf({ kind: "lazy-module", file: "f.tsx", spec: "./P", exported: "E" })).toEqual({
      kind: "module",
      from: "f.tsx",
      spec: "./P",
      exported: "E",
    })
  })

  it("anchors an inline component by locator and reports an opaque one with its text and line", () => {
    const inline = componentOfRoute("inline")
    const entry = inline.b.reader.entryOf(inline.ref)
    expect(entry?.kind).toBe("file")
    expect(entry?.kind === "file" ? entry.at : undefined).toBeDefined()

    const opaque = componentOfRoute("call")
    expect(opaque.b.reader.entryOf(opaque.ref)).toEqual({
      kind: "opaque",
      expr: "makeComponent()",
      file: "src/r.tsx",
      line: 13,
    })
  })

  it("only offers a page entry when the component resolves to a declaration it can read", () => {
    const local = componentOfRoute("local")
    const imported = componentOfRoute("imported")
    const lazy = componentOfRoute("lazy")

    expect(local.b.reader.pageEntryOf(local.ref)?.kind).toBe("file")
    expect(imported.b.reader.pageEntryOf(imported.ref)?.kind).toBe("binding")
    expect(lazy.b.reader.pageEntryOf(lazy.ref)?.kind).toBe("module")
    expect(local.b.reader.pageEntryOf({ kind: "none" })).toBeNull()
    expect(componentOfRoute("call").b.reader.pageEntryOf({ kind: "opaque", file: "src/r.tsx", node: local.b.call("src/r.tsx", "createRoute") })).toBeNull()
  })

  it("does not offer a page entry for an import that resolves nowhere", () => {
    const b = bench({ "src/r.tsx": `import Gone from "./gone"\nfoo({ component: Gone })` })
    const ref = b.reader.componentOf(b.optionsOf("src/r.tsx", "foo"), "src/r.tsx")

    expect(ref.kind).toBe("imported")
    expect(b.reader.pageEntryOf(ref)).toBeNull()
    expect(b.reader.scopeOf(ref, "anchor")).toBeNull()
  })
})

describe("adapters/tanstack-route-options: scopeOf", () => {
  const b = bench({
    "src/Page.tsx": `export default function Page() { return null }\nexport function Named() { return null }`,
    "src/r.tsx": `import Page, { Named as Renamed } from "./Page"`,
  })

  it("maps each reference kind to the module and export that declares it", () => {
    expect(b.reader.scopeOf({ kind: "local", file: "src/r.tsx", name: "L" }, "a")).toEqual({ file: "src/r.tsx", exportName: "L" })
    expect(b.reader.scopeOf({ kind: "imported", file: "src/r.tsx", local: "Renamed" }, "a")).toEqual({
      file: "src/Page.tsx",
      exportName: "Named",
    })
    expect(b.reader.scopeOf({ kind: "imported", file: "src/r.tsx", local: "Page" }, "a")).toEqual({
      file: "src/Page.tsx",
      exportName: "default",
    })
    expect(b.reader.scopeOf({ kind: "lazy-module", file: "src/r.tsx", spec: "./Page", exported: "Named" }, "a")).toEqual({
      file: "src/Page.tsx",
      exportName: "Named",
    })
  })

  it("uses the supplied anchor for an inline component and nothing for none/opaque", () => {
    const node = b.find("src/r.tsx", (candidate): candidate is ts.ImportDeclaration => ts.isImportDeclaration(candidate))

    expect(b.reader.scopeOf({ kind: "inline", file: "src/r.tsx", node }, "anchor")).toEqual({ file: "src/r.tsx", exportName: "anchor" })
    expect(b.reader.scopeOf({ kind: "none" }, "a")).toBeNull()
    expect(b.reader.scopeOf({ kind: "opaque", file: "src/r.tsx", node }, "a")).toBeNull()
  })

  it("is null for an import binding that no longer names an import, and for an unresolvable lazy spec", () => {
    expect(b.reader.scopeOf({ kind: "imported", file: "src/r.tsx", local: "notAnImport" }, "a")).toBeNull()
    expect(b.reader.scopeOf({ kind: "lazy-module", file: "src/r.tsx", spec: "./nope", exported: "X" }, "a")).toBeNull()
  })
})

describe("adapters/tanstack-route-options: option evidence and search params", () => {
  const route = (options: string) => {
    const b = bench({ "src/r.tsx": `${TANSTACK}\nconst r = createRoute(${options})` })
    return { b, options: b.optionsOf("src/r.tsx", "createRoute") }
  }

  it("reports a literal beforeLoad redirect target", () => {
    const { b, options } = route(`{ beforeLoad: () => { throw redirect({ to: "/login" }) } }`)
    const evidence = b.reader.optionEvidence(options, "src/r.tsx", options as ts.Node)

    expect(evidence.map((entry) => entry.what)).toEqual(["beforeLoad redirect to '/login'"])
    expect(evidence[0]?.file).toBe("src/r.tsx")
  })

  it("says the target is unreadable for a dynamic redirect, and does not invent a target from a guard", () => {
    const dynamic = route(`{ beforeLoad: ({ context }) => { throw redirect({ to: context.next }) } }`)
    const guard = route(`{ beforeLoad: ({ context }) => { if (!context.user) return } }`)

    expect(dynamic.b.reader.optionEvidence(dynamic.options, "src/r.tsx", dynamic.options as ts.Node).map((e) => e.what)).toEqual([
      "beforeLoad redirect (target is not a readable literal)",
    ])
    expect(guard.b.reader.optionEvidence(guard.options, "src/r.tsx", guard.options as ts.Node)).toEqual([])
  })

  it("keeps the FIRST readable redirect literal", () => {
    const { b, options } = route(`{ beforeLoad: (c) => { if (c.a) throw redirect({ to: "/first" }); throw redirect({ to: "/second" }) } }`)

    expect(b.reader.optionEvidence(options, "src/r.tsx", options as ts.Node)[0]?.what).toBe(
      "beforeLoad redirect to '/first' (conditional: c.a)",
    )
  })

  it("ignores a local function called redirect", () => {
    const b = bench({
      "src/r.tsx": `${TANSTACK.replace("redirect, ", "")}\nfunction redirect(a: unknown) {}\nconst r = createRoute({ beforeLoad: () => redirect({ to: "/x" }) })`,
    })
    const options = b.optionsOf("src/r.tsx", "createRoute")

    expect(b.reader.optionEvidence(options, "src/r.tsx", options as ts.Node)).toEqual([])
  })

  it("lists validateSearch param names sorted and unique, from the first object literal in the schema", () => {
    const { b, options } = route(`{ validateSearch: z.object({ page: z.number(), "sort-by": z.string().optional(), page: z.number() }) }`)
    const evidence = b.reader.optionEvidence(options, "src/r.tsx", options as ts.Node)

    expect(evidence.map((entry) => entry.what)).toEqual(["validateSearch params: page, sort-by"])
  })

  it("yields no evidence for empty options, a schema without an object literal, or no options at all", () => {
    const empty = route(`{}`)
    const opaque = route(`{ validateSearch: schema }`)
    const none = route(`undefined`)

    expect(empty.b.reader.optionEvidence(empty.options, "src/r.tsx", empty.options as ts.Node)).toEqual([])
    expect(opaque.b.reader.optionEvidence(opaque.options, "src/r.tsx", opaque.options as ts.Node)).toEqual([])
    expect(none.b.reader.optionEvidence(null, "src/r.tsx", none.options as ts.Node)).toEqual([])
  })

  it("reports search params once as an info diagnostic that names the subject and the required-ness caveat", () => {
    const { b, options } = route(`{ validateSearch: z.object({ q: z.string() }) }`)
    b.reader.reportSearchParams(options, "src/r.tsx", "/search", options as ts.Node)

    const reported = b.diagnostics()
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({ severity: "info", code: "facts/needs-typechecker", file: "src/r.tsx", line: 2 })
    expect(reported[0]?.message).toContain("'/search'")
    expect(reported[0]?.message).toContain("(q)")
  })

  it("reports nothing without search params", () => {
    const { b, options } = route(`{ path: "/x" }`)
    b.reader.reportSearchParams(options, "src/r.tsx", "/x", options as ts.Node)

    expect(b.diagnostics()).toEqual([])
  })
})

describe("adapters/tanstack-route-options: dynamicImportSpec", () => {
  it("finds the first import() specifier inside a loader", () => {
    const b = bench({ "src/r.tsx": `foo(() => import("./a").then((m) => import("./b")))` })

    expect(b.reader.dynamicImportSpec(b.optionsOf("src/r.tsx", "foo") as ts.Node)).toBe("./a")
  })

  it("is null for a non-literal specifier or when there is no dynamic import", () => {
    const b = bench({ "src/r.tsx": `foo(() => import(spec))\nbar(() => require("./a"))` })

    expect(b.reader.dynamicImportSpec(b.optionsOf("src/r.tsx", "foo") as ts.Node)).toBeNull()
    expect(b.reader.dynamicImportSpec(b.optionsOf("src/r.tsx", "bar") as ts.Node)).toBeNull()
  })
})

describe("adapters/tanstack-route-options: outlets and ancestors", () => {
  const FILES = {
    "src/layouts.tsx": [
      `import { Outlet, Outlet as Slot } from "@tanstack/react-router"`,
      `import * as Router from "@tanstack/react-router"`,
      `export function Direct() { return <main><Outlet /></main> }`,
      `export function Aliased() { return <main><Slot /></main> }`,
      `export function Namespaced() { return <main><Router.Outlet /></main> }`,
      `export function Plain() { return <main /> }`,
      `export const Arrow = () => <section><Outlet /></section>`,
      `export default function Fallback() { return <Outlet /> }`,
    ].join("\n"),
    "src/wrappers.tsx": [
      `import { Direct } from "./layouts"`,
      `import { Plain, Aliased } from "./layouts"`,
      `export function Delegating() { return <Direct /> }`,
      `export function Useless() { return <Plain /> }`,
      `export function Twice() { return <div><Direct /><Direct /></div> }`,
      `export function Ambiguous() { return <div><Direct /><Aliased /></div> }`,
    ].join("\n"),
  }

  const scope = (file: string, exportName: string) => ({ file, exportName })
  const reader = () => bench(FILES).reader

  it("detects an <Outlet/> as written, under an import alias, and as a namespace member", () => {
    const r = reader()

    expect(r.rendersOutlet(scope("src/layouts.tsx", "Direct"))).toBe(true)
    expect(r.rendersOutlet(scope("src/layouts.tsx", "Aliased"))).toBe(true)
    expect(r.rendersOutlet(scope("src/layouts.tsx", "Namespaced"))).toBe(true)
    expect(r.rendersOutlet(scope("src/layouts.tsx", "Arrow"))).toBe(true)
    expect(r.rendersOutlet(scope("src/layouts.tsx", "default"))).toBe(true)
  })

  it("is false for a layout without one, an unknown export and an unreadable file", () => {
    const r = reader()

    expect(r.rendersOutlet(scope("src/layouts.tsx", "Plain"))).toBe(false)
    expect(r.rendersOutlet(scope("src/layouts.tsx", "Missing"))).toBe(false)
    expect(r.rendersOutlet(scope("src/missing.tsx", "Direct"))).toBe(false)
  })

  it("contributes a single outlet layout for a scope that renders one itself", () => {
    expect(reader().outletAncestors(scope("src/layouts.tsx", "Direct"))).toEqual([
      { file: "src/layouts.tsx", exportName: "Direct", splice: OUTLET_SPLICE, role: "layout" },
    ])
  })

  it("splices at the single imported layout a scope delegates to, keeping the scope as a transparent link", () => {
    expect(reader().outletAncestors(scope("src/wrappers.tsx", "Delegating"))).toEqual([
      { file: "src/wrappers.tsx", exportName: "Delegating", splice: OUTLET_SPLICE, role: "transparent" },
      { file: "src/layouts.tsx", exportName: "Direct", splice: OUTLET_SPLICE, role: "layout" },
    ])
  })

  it("treats the same delegate rendered twice as one delegate", () => {
    const chain = reader().outletAncestors(scope("src/wrappers.tsx", "Twice"))

    expect(chain.map((link) => link.role)).toEqual(["transparent", "layout"])
  })

  it("hands the scope over as a layout when there is no delegate, or the delegate has no outlet, or several candidates", () => {
    const r = reader()

    expect(r.outletAncestors(scope("src/layouts.tsx", "Plain"))).toEqual([
      { file: "src/layouts.tsx", exportName: "Plain", splice: OUTLET_SPLICE, role: "layout" },
    ])
    expect(r.outletAncestors(scope("src/wrappers.tsx", "Useless"))).toEqual([
      { file: "src/wrappers.tsx", exportName: "Useless", splice: OUTLET_SPLICE, role: "layout" },
    ])
    expect(r.outletAncestors(scope("src/wrappers.tsx", "Ambiguous"))[0]?.role).toBe("layout")
  })

  it("builds a transparent ancestor with the outlet splice", () => {
    expect(reader().transparentAt("src/a.tsx", "A")).toEqual({
      file: "src/a.tsx",
      exportName: "A",
      splice: { kind: "outlet", tag: "Outlet" },
      role: "transparent",
    })
  })
})

describe("adapters/tanstack-route-options: beforeLoadGuardOf", () => {
  const PATHS = `const LOGIN = "/login"`
  const guardOf = (options: string, unauthenticatedTarget: string | null = null) => {
    const base = discoverBench({ "src/r.tsx": `${TANSTACK}\n${PATHS}\nconst r = createRoute(${options})` })
    const reader = createRouteOptionsReader(base.ctx, { unauthenticatedTarget })
    const call = base.find(
      "src/r.tsx",
      (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText() === "createRoute",
    )
    return reader.beforeLoadGuardOf(call.arguments[0] ?? null, "src/r.tsx")
  }

  it("is null without beforeLoad or without a redirect in it", () => {
    expect(guardOf(`{}`)).toBeNull()
    expect(guardOf(`{ beforeLoad: () => {} }`)).toBeNull()
  })

  it("flattens a direct redirect target the literal reader cannot read", () => {
    const guard = guardOf(`{ beforeLoad: () => { throw redirect({ to: LOGIN }) } }`)

    expect(guard?.kind).toBe("unconditional")
    expect(guard?.to).toBe("/login")
    expect(guard?.label).toBe("beforeLoad redirect to '/login'")
  })

  it("brings a flattened target aimed at unauthenticatedTarget back into scope", () => {
    const guard = guardOf(`{ beforeLoad: ({ context }) => { if (!context.user) throw redirect({ to: LOGIN }) } }`, "/login")

    expect(guard?.kind).toBe("conditional")
    expect(guard?.scopedOut).toBe(false)
  })

  it("marks a conditional redirect away from unauthenticatedTarget evidence only", () => {
    const options = `{ beforeLoad: ({ context }) => { if (!context.user) throw redirect({ to: "/login" }) } }`
    const base = discoverBench({ "src/r.tsx": `${TANSTACK}\nconst r = createRoute(${options})` })
    const reader = createRouteOptionsReader(base.ctx, { unauthenticatedTarget: "/signin" })
    const call = base.find(
      "src/r.tsx",
      (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText() === "createRoute",
    )
    const node = call.arguments[0] ?? null

    expect(reader.beforeLoadGuardOf(node, "src/r.tsx")?.kind).toBe("none")
    expect(reader.optionEvidence(node, "src/r.tsx", call).map((entry) => entry.what)).toEqual([
      "beforeLoad redirect to '/login' (conditional: !context.user); evidence only: not the unauthenticated target '/signin'",
    ])
  })
})
