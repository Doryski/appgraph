import { describe, expect, it } from "vitest"
import ts from "typescript"
import { createBindingTable } from "../../src/core/bindings.js"
import { createAst, walk } from "../../src/core/ast.js"
import type { BindingTable } from "../../src/core/model.js"

const ast = createAst(ts)

const parse = (code: string): ts.SourceFile =>
  ts.createSourceFile("/repo/src/file.tsx", code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)

const build = (code: string, resolveModule?: (specifier: string) => string | null) =>
  createBindingTable(
    resolveModule === undefined
      ? { ts, source: parse(code) }
      : { ts, source: parse(code), resolveModule },
  )

const receiverOf = (code: string, method: string): ts.Node => {
  const source = parse(code)
  let found: ts.Node | null = null
  walk(source, (node) => {
    if (found !== null || !ts.isCallExpression(node)) return
    const callee = ast.asPropertyAccess(node.expression)
    if (callee !== null && callee.name.text === method) found = callee.expression
  })
  if (found === null) throw new Error(`no .${method}() call`)
  return found
}

describe("createBindingTable — static imports", () => {
  const table = build(
    [
      "import axios from 'axios'",
      "import { useNavigate, useQuery as useData } from 'react-router-dom'",
      "import * as RR from '@tanstack/react-router'",
      "import './side-effect.css'",
    ].join("\n"),
  )

  it("records default, named, renamed and namespace imports", () => {
    expect(table.get("axios")).toEqual({ kind: "import", module: "axios", imported: "default", file: null })
    expect(table.get("useNavigate")).toEqual({
      kind: "import",
      module: "react-router-dom",
      imported: "useNavigate",
      file: null,
    })
    expect(table.get("useData")).toEqual({
      kind: "import",
      module: "react-router-dom",
      imported: "useQuery",
      file: null,
    })
    expect(table.get("RR")).toEqual({
      kind: "import",
      module: "@tanstack/react-router",
      imported: "*",
      file: null,
    })
    expect(table.get("nothing")).toBeNull()
  })

  it("reports the module of a binding and every imported module", () => {
    expect(table.moduleOf("axios")).toBe("axios")
    expect(table.moduleOf("nothing")).toBeNull()
    expect(table.importedModules).toEqual([
      "./side-effect.css",
      "@tanstack/react-router",
      "axios",
      "react-router-dom",
    ])
  })

  it("resolves imported files through the injected resolveModule and keeps them unique and sorted", () => {
    const resolved = build(
      ["import { a } from './a.js'", "import { b } from './b.js'", "import { c } from './a.js'"].join("\n"),
      (specifier) => (specifier === "./a.js" ? "/repo/src/a.ts" : "/repo/src/b.tsx"),
    )

    expect(resolved.importedFiles).toEqual(["/repo/src/a.ts", "/repo/src/b.tsx"])
    expect(resolved.get("a")).toEqual({ kind: "import", module: "./a.js", imported: "a", file: "/repo/src/a.ts" })
  })
})

describe("createBindingTable — dynamic imports", () => {
  it("binds `const { default: X } = await import('…')`", () => {
    const table = build("const load = async () => { const { default: Orders } = await import('./Orders.js') }")
    expect(table.get("Orders")).toEqual({
      kind: "dynamic-import",
      module: "./Orders.js",
      imported: "default",
      file: null,
    })
  })

  it("binds array-destructured Promise.all([import(), import()])", () => {
    const table = build(
      [
        "const load = async () => {",
        "  const [{ default: A }, { default: B }] = await Promise.all([import('./A.js'), import('./B.js')])",
        "}",
      ].join("\n"),
    )

    expect(table.moduleOf("A")).toBe("./A.js")
    expect(table.moduleOf("B")).toBe("./B.js")
  })

  it("sees through a wrapped import specifier", () => {
    const table = build("const load = async () => { const { default: X } = await import('./X.js' as const) }")
    expect(table.moduleOf("X")).toBe("./X.js")
  })
})

describe("isHookResult — hook results bound to any local name", () => {
  it("finds a directly named hook result", () => {
    const table = build(
      ["import { useNavigate } from 'react-router-dom'", "const navigate = useNavigate()"].join("\n"),
    )

    expect(table.isHookResult("navigate", "useNavigate")).toBe(true)
    expect(table.isHookResult("navigate", "useNavigate", "react-router-dom")).toBe(true)
    expect(table.isHookResult("navigate", "useNavigate", "@tanstack/react-router")).toBe(false)
  })

  it("finds a RENAMED local, not just the literal identifier `navigate`", () => {
    const table = build(["import { useNavigate } from 'react-router-dom'", "const go = useNavigate()"].join("\n"))

    expect(table.isHookResult("go", "useNavigate", "react-router-dom")).toBe(true)
    expect(table.get("go")).toEqual({ kind: "hook-result", hook: "useNavigate", module: "react-router-dom" })
  })

  it("finds an ALIASED import — `import { useNavigate as useNav }` then `const go = useNav()`", () => {
    const table = build(
      ["import { useNavigate as useNav } from 'react-router-dom'", "const go = useNav()"].join("\n"),
    )

    expect(table.isHookResult("go", "useNavigate", "react-router-dom")).toBe(true)
    expect(table.isHookResult("go", "useNav")).toBe(false)
  })

  it("finds a hook called on an imported namespace", () => {
    const table = build(
      ["import * as RR from '@tanstack/react-router'", "const go = RR.useNavigate()"].join("\n"),
    )

    expect(table.isHookResult("go", "useNavigate", "@tanstack/react-router")).toBe(true)
  })

  it("finds hooks whose result is destructured", () => {
    const table = build(
      ["import { useRouter } from 'next/navigation'", "const { push, replace } = useRouter()"].join("\n"),
    )

    expect(table.isHookResult("push", "useRouter", "next/navigation")).toBe(true)
    expect(table.isHookResult("replace", "useRouter", "next/navigation")).toBe(true)
  })

  it("matches a module pattern so react-router v6 and v7 are both covered", () => {
    const table = build(["import { useNavigate } from 'react-router'", "const go = useNavigate()"].join("\n"))
    expect(table.isHookResult("go", "useNavigate", /^react-router(-dom)?$/)).toBe(true)
  })

  it("records the element index of an array-destructured hook result", () => {
    const table = build(["import { useLocation } from 'wouter'", "const [location, navigate] = useLocation()"].join("\n"))

    expect(table.isHookResult("navigate", "useLocation", "wouter", 1)).toBe(true)
    expect(table.isHookResult("navigate", "useLocation", "wouter", 0)).toBe(false)
    expect(table.isHookResult("location", "useLocation", "wouter", 0)).toBe(true)
    expect(table.isHookResult("navigate", "useLocation", "wouter")).toBe(true)
  })

  it("counts an elided element when indexing: `const [, navigate] = useLocation()`", () => {
    const table = build(["import { useLocation } from 'wouter'", "const [, navigate] = useLocation()"].join("\n"))
    expect(table.isHookResult("navigate", "useLocation", /^wouter$/, 1)).toBe(true)
  })

  it("never matches an index on an identifier, object-destructured or rest binding", () => {
    const table = build(
      [
        "import { useLocation, useRouter } from 'x'",
        "const location = useLocation()",
        "const { push } = useRouter()",
        "const [first, ...rest] = useLocation()",
      ].join("\n"),
    )

    expect(table.isHookResult("location", "useLocation", "x", 0)).toBe(false)
    expect(table.isHookResult("push", "useRouter", "x", 0)).toBe(false)
    expect(table.isHookResult("rest", "useLocation", "x", 1)).toBe(false)
    expect(table.isHookResult("rest", "useLocation", "x")).toBe(true)
    expect(table.isHookResult("first", "useLocation", "x", 0)).toBe(true)
  })

  it("does NOT treat an unrelated local function named `navigate` as a hook result", () => {
    const table = build(["const navigate = (to) => console.log(to)", "navigate('/orders')"].join("\n"))

    expect(table.isHookResult("navigate", "useNavigate")).toBe(false)
    expect(table.get("navigate")?.kind).toBe("local")
  })

  it("keeps a shadowing local recognisable as NOT an import", () => {
    const table = build("const axios = { get: () => null }")
    expect(table.get("axios")?.kind).toBe("local")
    expect(table.rootsInModule("axios", "axios")).toBe(false)
  })
})

describe("rootsIn — only real HTTP clients count as endpoint roots", () => {
  const HTTP_CLIENTS = /^(axios|ky|got|node-fetch)$/

  it("does NOT treat someMap.get('/x') as an HTTP client call", () => {
    const code = ["const someMap = new Map()", "someMap.get('/x')"].join("\n")
    const table = build(code)

    expect(table.rootsIn(receiverOf(code, "get"), HTTP_CLIENTS)).toBe(false)
  })

  it("does NOT treat params.delete('/y') or an unbound receiver as an HTTP client call", () => {
    const deleteCode = ["const params = new URLSearchParams()", "params.delete('/y')"].join("\n")
    expect(build(deleteCode).rootsIn(receiverOf(deleteCode, "delete"), HTTP_CLIENTS)).toBe(false)

    const bareCode = "unknownThing.get('/z')"
    expect(build(bareCode).rootsIn(receiverOf(bareCode, "get"), HTTP_CLIENTS)).toBe(false)
  })

  it("DOES treat axios.get('/api/orders') as an HTTP client call", () => {
    const code = ["import axios from 'axios'", "axios.get('/api/orders')"].join("\n")
    expect(build(code).rootsIn(receiverOf(code, "get"), HTTP_CLIENTS)).toBe(true)
  })

  it("DOES treat a project apiClient module call as an HTTP client call", () => {
    const code = ["import { apiClient } from '@/services/api'", "apiClient.get('/orders')"].join("\n")
    expect(build(code).rootsIn(receiverOf(code, "get"), /^@\/services\//)).toBe(true)
  })

  it("traces a receiver built from an imported factory back to its module", () => {
    const code = ["import axios from 'axios'", "const client = axios.create()", "client.get('/orders')"].join("\n")
    const table = build(code)

    expect(table.moduleOf("client")).toBe("axios")
    expect(table.rootsIn(receiverOf(code, "get"), HTTP_CLIENTS)).toBe(true)
  })

  it("walks a deep property, element-access and call chain to its leftmost identifier", () => {
    const code = ["import axios from 'axios'", "axios.instances[0].withAuth().get('/orders')"].join("\n")
    const table = build(code)

    expect(table.rootIdentifier(receiverOf(code, "get"))).toBe("axios")
    expect(table.rootsIn(receiverOf(code, "get"), HTTP_CLIENTS)).toBe(true)
  })

  it("sees through wrappers on the receiver", () => {
    const code = ["import axios from 'axios'", "(axios as unknown as Client).get('/orders')"].join("\n")
    expect(build(code).rootsIn(receiverOf(code, "get"), HTTP_CLIENTS)).toBe(true)
  })

  it("reaches a receiver bound by a dynamic import", () => {
    const code = [
      "const load = async () => {",
      "  const { default: client } = await import('axios')",
      "  client.get('/orders')",
      "}",
    ].join("\n")

    expect(build(code).rootsIn(receiverOf(code, "get"), HTTP_CLIENTS)).toBe(true)
  })
})

describe("createBindingTable — precedence and locals", () => {
  it("lets a static import win over a same-named local declaration", () => {
    const table = build(["import { helper } from './helper.js'", "const helper = 1"].join("\n"))
    expect(table.get("helper")?.kind).toBe("import")
  })

  it("records plain locals, parameters and function declarations", () => {
    const table = build(
      ["function render(props) { const inner = 1; return inner }", "class Widget {}"].join("\n"),
    )

    expect(table.get("render")?.kind).toBe("local")
    expect(table.get("props")?.kind).toBe("local")
    expect(table.get("inner")?.kind).toBe("local")
    expect(table.get("Widget")?.kind).toBe("local")
    expect(table.locals).toEqual(["Widget", "inner", "props", "render"])
  })

  it("satisfies the shared BindingTable contract declared in model.ts", () => {
    const table: BindingTable = build("const value = 1")
    expect(table.get("value")).not.toBeNull()
  })

  it("records a declaration position for locals", () => {
    const table = build("const value = 1")
    const binding = table.get("value")
    expect(binding?.kind === "local" ? binding.declaredAt : -1).toBeGreaterThan(0)
  })
})

describe("createBindingTable — CommonJS require", () => {
  const resolveLocal = (specifier: string): string | null =>
    specifier.startsWith(".") ? `/repo/src/${specifier.slice(2)}.ts` : null

  it("binds a whole-module require, destructured members and a picked member", () => {
    const table = build(
      [
        "const axios = require('axios')",
        "const { create, get: fetchIt } = require('./client')",
        "const store = require('./store').default",
      ].join("\n"),
      resolveLocal,
    )

    expect(table.get("axios")).toEqual({ kind: "import", module: "axios", imported: "default", file: null })
    expect(table.get("create")).toEqual({
      kind: "import",
      module: "./client",
      imported: "create",
      file: "/repo/src/client.ts",
    })
    expect(table.get("fetchIt")).toMatchObject({ kind: "import", imported: "get" })
    expect(table.get("store")).toMatchObject({ kind: "import", module: "./store", imported: "default" })
    expect(table.importedModules).toEqual(["./client", "./store", "axios"])
    expect(table.importedFiles).toEqual(["/repo/src/client.ts", "/repo/src/store.ts"])
  })

  it("attributes call sites in a CommonJS file to the required module", () => {
    const code = ["const axios = require('axios')", "axios.get('/api/orders')"].join("\n")
    expect(build(code).rootsIn(receiverOf(code, "get"), "axios")).toBe(true)
  })

  it("traces a hook result built from a required factory", () => {
    const table = build(["const { create } = require('zustand')", "const useStore = create(() => ({}))"].join("\n"))
    expect(table.isHookResult("useStore", "create", "zustand")).toBe(true)
  })

  it("ignores a non-literal specifier, a shadowed require and other calls", () => {
    const table = build(
      [
        "const dynamicName = require(name)",
        "const templated = require(`./${name}`)",
        "const other = load('./x')",
      ].join("\n"),
    )

    expect(table.get("dynamicName")?.kind).not.toBe("import")
    expect(table.get("templated")?.kind).not.toBe("import")
    expect(table.importedModules).toEqual([])
    const shadowed = build(["import { require } from './loader'", "const x = require('./x')"].join("\n"))
    expect(shadowed.get("x")?.kind).toBe("hook-result")
  })
})

describe("createBindingTable — lazyExports", () => {
  const lazyExports = (code: string) => build(["import { lazy } from 'react'", code].join("\n")).lazyExports

  it("lists each exported module-level lazy value in statement order", () => {
    const code = [
      "export default lazy(() => import('./A'))",
      "export const B = lazy(() => import('./B').then((m) => ({ default: m.BPage })))",
      "const C = lazy(() => import('./C'))",
      "export { C }",
    ].join("\n")

    expect(lazyExports(code)).toEqual([
      { kind: "dynamic-import", module: "./A", imported: "default", file: null },
      { kind: "dynamic-import", module: "./B", imported: "BPage", file: null },
      { kind: "dynamic-import", module: "./C", imported: "default", file: null },
    ])
  })

  it("skips lazy values that are not exported or not module-level", () => {
    const code = [
      "const A = lazy(() => import('./A'))",
      "export const B = () => { const C = lazy(() => import('./C')); return C }",
    ].join("\n")

    expect(lazyExports(code)).toEqual([])
  })

  it.each([
    ["an object literal", "export const VIEWS = { list: lazy(() => import('./List')), grid: lazy(() => import('./Grid')) }"],
    ["an array literal", "export const VIEWS = [lazy(() => import('./List')), lazy(() => import('./Grid'))]"],
    ["a `satisfies` object literal", "export const VIEWS = { list: lazy(() => import('./List')), grid: lazy(() => import('./Grid')) } satisfies Views"],
    ["an `as const` array literal", "export const VIEWS = [lazy(() => import('./List')), lazy(() => import('./Grid'))] as const"],
    ["a registry exported by name", "const VIEWS = { list: lazy(() => import('./List')), grid: lazy(() => import('./Grid')) }\nexport { VIEWS }"],
  ])("lists every lazy member of %s registry", (_label, code) => {
    expect(lazyExports(code)).toEqual([
      { kind: "dynamic-import", module: "./List", imported: "default", file: null },
      { kind: "dynamic-import", module: "./Grid", imported: "default", file: null },
    ])
  })

  it("lists next/dynamic registry members with the export each one picks", () => {
    const code = [
      "import dynamic from 'next/dynamic'",
      "export const DASHBOARDS = {",
      "  a: dynamic(() => import('./A').then((m) => m.A)),",
      "  b: dynamic(() => import('./B')),",
      "}",
    ].join("\n")

    expect(build(code).lazyExports).toEqual([
      { kind: "dynamic-import", module: "./A", imported: "A", file: null },
      { kind: "dynamic-import", module: "./B", imported: "default", file: null },
    ])
  })

  it("skips non-exported registries and registry members that are not lazy factories", () => {
    const code = [
      "const HIDDEN = { list: lazy(() => import('./Hidden')) }",
      "export const MIXED = { list: lazy(() => import('./List')), label: 'List', load: () => import('./Raw'), View }",
    ].join("\n")

    expect(lazyExports(code)).toEqual([{ kind: "dynamic-import", module: "./List", imported: "default", file: null }])
  })
})

describe("classMemberBinding — class plus member name", () => {
  const resolveClassMember = (code: string, member: string) => {
    const source = parse(code)
    const table = createBindingTable({ ts, source })
    const [declaration] = source.statements.filter(ts.isClassDeclaration)
    if (declaration === undefined) throw new Error("no class")
    return table.classMemberBinding(declaration, member)
  }

  const code = [
    "import { Router } from '@angular/router'",
    "import { inject } from '@angular/core'",
    "import { HttpClient } from '@angular/common/http'",
    "class A {",
    "  http = inject(HttpClient)",
    "  plain = 1",
    "  constructor(private router: Router, notProperty: Router) {}",
    "}",
  ].join("\n")

  it("resolves parameter properties and inject() fields by name", () => {
    expect(resolveClassMember(code, "router")).toEqual({ module: "@angular/router", imported: "Router" })
    expect(resolveClassMember(code, "http")).toEqual({ module: "@angular/common/http", imported: "HttpClient" })
  })

  it("returns null for unknown, untyped or non-property members", () => {
    expect(resolveClassMember(code, "missing")).toBeNull()
    expect(resolveClassMember(code, "plain")).toBeNull()
    expect(resolveClassMember(code, "notProperty")).toBeNull()
  })
})

describe("memberBinding — typed `this` members", () => {
  const resolveMember = (code: string, method: string) => {
    const source = parse(code)
    const table = createBindingTable({ ts, source })
    const receivers: ts.Expression[] = []
    walk(source, (node) => {
      if (!ts.isCallExpression(node)) return
      const callee = ast.asPropertyAccess(node.expression)
      if (callee !== null && callee.name.text === method) receivers.push(callee.expression)
    })
    const [receiver] = receivers
    if (receiver === undefined) throw new Error(`no .${method}() call`)
    return table.memberBinding(receiver)
  }

  const ROUTER = { module: "@angular/router", imported: "Router" }
  const HTTP = { module: "@angular/common/http", imported: "HttpClient" }

  it("resolves a constructor parameter property typed with an imported class", () => {
    const code = [
      "import { Router } from '@angular/router'",
      "import { HttpClient } from '@angular/common/http'",
      "class A {",
      "  constructor(private router: Router, public readonly http: HttpClient) {}",
      "  go() { this.router.navigate(['/home']); return this.http.get('/api') }",
      "}",
    ].join("\n")

    expect(resolveMember(code, "navigate")).toEqual(ROUTER)
    expect(resolveMember(code, "get")).toEqual(HTTP)
  })

  it("resolves an aliased import to its exported name", () => {
    const code = [
      "import { Router as NgRouter } from '@angular/router'",
      "class A {",
      "  constructor(protected nav: NgRouter) {}",
      "  go() { this.nav.navigate(['/home']) }",
      "}",
    ].join("\n")

    expect(resolveMember(code, "navigate")).toEqual(ROUTER)
  })

  it("resolves a typed field assigned in the constructor, ignoring generic arguments", () => {
    const code = [
      "import { Store } from '@ngrx/store'",
      "class A {",
      "  readonly store: Store<AppState>",
      "  constructor(store: Store<AppState>) { this.store = store }",
      "  load() { this.store.dispatch(load()) }",
      "}",
    ].join("\n")

    expect(resolveMember(code, "dispatch")).toEqual({ module: "@ngrx/store", imported: "Store" })
  })

  it("resolves a field initialised with inject() from @angular/core", () => {
    const code = [
      "import { inject } from '@angular/core'",
      "import { HttpClient } from '@angular/common/http'",
      "class A {",
      "  private http = inject(HttpClient)",
      "  load() { return this.http.get('/api') }",
      "}",
    ].join("\n")

    expect(resolveMember(code, "get")).toEqual(HTTP)
  })

  it("ignores an inject() that is not Angular's", () => {
    const code = [
      "import { inject } from './di'",
      "import { HttpClient } from '@angular/common/http'",
      "class A {",
      "  private http = inject(HttpClient)",
      "  load() { return this.http.get('/api') }",
      "}",
    ].join("\n")

    expect(resolveMember(code, "get")).toBeNull()
  })

  it("resolves the first member of a deeper chain", () => {
    const code = [
      "import { Router } from '@angular/router'",
      "class A {",
      "  constructor(private a: Router) {}",
      "  go() { this.a.b.c() }",
      "}",
    ].join("\n")

    expect(resolveMember(code, "c")).toEqual(ROUTER)
  })

  it("returns null for a locally declared type", () => {
    const code = [
      "class LocalRouter { navigate(_: string[]) {} }",
      "class A {",
      "  constructor(private router: LocalRouter) {}",
      "  go() { this.router.navigate(['/home']) }",
      "}",
    ].join("\n")

    expect(resolveMember(code, "navigate")).toBeNull()
  })

  it("returns null for `this` in a plain function", () => {
    const code = [
      "import { Router } from '@angular/router'",
      "function go(this: { router: Router }) { this.router.navigate(['/home']) }",
    ].join("\n")

    expect(resolveMember(code, "navigate")).toBeNull()
  })

  it("returns null inside a nested function expression but keeps an arrow's lexical `this`", () => {
    const nested = [
      "import { Router } from '@angular/router'",
      "class A {",
      "  constructor(private router: Router) {}",
      "  go() { setTimeout(function () { this.router.navigate(['/home']) }) }",
      "}",
    ].join("\n")
    const arrow = nested.replace("function () {", "() => {")

    expect(resolveMember(nested, "navigate")).toBeNull()
    expect(resolveMember(arrow, "navigate")).toEqual(ROUTER)
  })
})
