import { describe, expect, it } from "vitest"
import ts from "typescript"
import { EMPTY_STRING_CONTEXT, createAst, isComponentTag, isHookName, walk } from "../../src/core/ast.js"
import type { StringContext } from "../../src/core/ast.js"

const ast = createAst(ts)

const parse = (code: string, name = "/repo/src/file.tsx"): ts.SourceFile =>
  ts.createSourceFile(name, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)

const find = <T extends ts.Node>(source: ts.SourceFile, guard: (node: ts.Node) => node is T): T => {
  let found: T | null = null
  walk(source, (node) => {
    if (found === null && guard(node)) found = node
  })
  if (found === null) throw new Error("node not found")
  return found
}

const findAll = <T extends ts.Node>(source: ts.SourceFile, guard: (node: ts.Node) => node is T): T[] => {
  const out: T[] = []
  walk(source, (node) => {
    if (guard(node)) out.push(node)
  })
  return out
}

const context = (constants: Record<string, string>, members: Record<string, string> = {}): StringContext => ({
  constants: new Map(Object.entries(constants)),
  members: new Map(Object.entries(members)),
})

const firstArgumentOf = (code: string): ts.Node => {
  const source = parse(code)
  const call = find(source, ts.isCallExpression)
  const argument = call.arguments[0]
  if (argument === undefined) throw new Error("no argument")
  return argument
}

const WRAPPINGS = [
  ["plain", (expr: string) => expr],
  ["parenthesized", (expr: string) => `(${expr})`],
  ["as const", (expr: string) => `${expr} as const`],
  ["satisfies T", (expr: string) => `${expr} satisfies RouteObject[]`],
  ["as const satisfies T", (expr: string) => `${expr} as const satisfies RouteObject[]`],
  ["non-null asserted", (expr: string) => `${expr}!`],
  ["as unknown as T", (expr: string) => `${expr} as unknown as RouteObject[]`],
  ["double parenthesized", (expr: string) => `((${expr}))`],
] as const

describe("walk", () => {
  it("visits the node itself and every descendant in forEachChild order", () => {
    const source = parse("const a = 1")
    const kinds: number[] = []
    walk(source, (node) => {
      kinds.push(node.kind)
    })

    expect(kinds[0]).toBe(ts.SyntaxKind.SourceFile)
    expect(kinds).toContain(ts.SyntaxKind.VariableDeclaration)
    expect(kinds).toContain(ts.SyntaxKind.NumericLiteral)
  })
})

describe("unwrap — wrapped route arrays reach the raw literal", () => {
  it.each(WRAPPINGS)("unwraps %s to the raw array literal", (_label, wrap) => {
    const argument = firstArgumentOf(`createBrowserRouter(${wrap("[{ path: '/' }]")})`)
    const unwrapped = ast.unwrap(argument)

    expect(ts.isArrayLiteralExpression(unwrapped)).toBe(true)
  })

  it.each(WRAPPINGS)("asArrayLiteral survives %s where the raw predicate does not", (label, wrap) => {
    const argument = firstArgumentOf(`createBrowserRouter(${wrap("[{ path: '/' }]")})`)
    const array = ast.asArrayLiteral(argument)

    expect(array).not.toBeNull()
    expect(array?.elements).toHaveLength(1)
    if (label !== "plain") expect(ts.isArrayLiteralExpression(argument)).toBe(false)
  })

  it.each(WRAPPINGS)("asObjectLiteral survives %s", (_label, wrap) => {
    const argument = firstArgumentOf(`configure(${wrap("{ rootPath: '/admin' }")})`)
    expect(ast.asObjectLiteral(argument)?.properties).toHaveLength(1)
  })

  it.each(WRAPPINGS)("asCallExpression survives %s", (_label, wrap) => {
    const argument = firstArgumentOf(`register(${wrap("createFileRoute('/orders')")})`)
    expect(ast.asCallExpression(argument)).not.toBeNull()
  })

  it.each(WRAPPINGS)("asStringLiteralLike survives %s", (_label, wrap) => {
    const argument = firstArgumentOf(`createFileRoute(${wrap("'/orders/$id'")})`)
    expect(ast.asStringLiteralLike(argument)?.text).toBe("/orders/$id")
  })

  it("unwraps a JsxExpression container", () => {
    const source = parse("const el = <Route element={[1]} />")
    const attribute = ast.attributeByName(find(source, ts.isJsxSelfClosingElement), "element")
    expect(ast.asArrayLiteral(attribute?.initializer)).not.toBeNull()
  })

  it("returns null instead of the wrong node when the shape genuinely differs", () => {
    expect(ast.asArrayLiteral(firstArgumentOf("createBrowserRouter(routes as const)"))).toBeNull()
    expect(ast.asArrayLiteral(undefined)).toBeNull()
  })

  it("narrows the other exported helpers", () => {
    expect(ast.asIdentifier(firstArgumentOf("zodResolver((schema) as const)"))?.text).toBe("schema")
    expect(ast.asPropertyAccess(firstArgumentOf("f(Paths.ORDERS as const)"))?.name.text).toBe("ORDERS")
    expect(ast.asNewExpression(firstArgumentOf("f((new AdminJS({})) satisfies X)"))).not.toBeNull()
    expect(ast.asArrowFunction(firstArgumentOf("f((() => null) as const)"))).not.toBeNull()
  })
})

describe("flattenString — all eight node cases", () => {
  const flatten = (code: string, ctx: StringContext = EMPTY_STRING_CONTEXT) =>
    ast.flattenString(firstArgumentOf(`f(${code})`), ctx)

  it("reads a string literal and a no-substitution template", () => {
    expect(flatten("'/orders'")).toEqual({ value: "/orders", dynamic: false })
    expect(flatten("`/orders`")).toEqual({ value: "/orders", dynamic: false })
  })

  it("reads an identifier from the file-local constant table, else null", () => {
    expect(flatten("BASE", context({ BASE: "/api" }))).toEqual({ value: "/api", dynamic: false })
    expect(flatten("BASE")).toBeNull()
  })

  it("reads A.B from the shared string table, else null", () => {
    expect(flatten("Paths.ORDERS", context({}, { "Paths.ORDERS": "/orders" }))).toEqual({
      value: "/orders",
      dynamic: false,
    })
    expect(flatten("Paths.MISSING", context({}, { "Paths.ORDERS": "/orders" }))).toBeNull()
    expect(flatten("a.b.c", context({}, { "Paths.ORDERS": "/orders" }))).toBeNull()
  })

  it("folds a template expression and marks an unresolvable span as :param", () => {
    expect(flatten("`/orders/${id}/lines`")).toEqual({ value: "/orders/:param/lines", dynamic: true })
    expect(flatten("`${BASE}/orders`", context({ BASE: "/api" }))).toEqual({
      value: "/api/orders",
      dynamic: false,
    })
  })

  it("concatenates a + b and forces dynamic when one side is unresolvable", () => {
    expect(flatten("'/api' + '/orders'")).toEqual({ value: "/api/orders", dynamic: false })
    expect(flatten("'/api/' + id")).toEqual({ value: "/api/:param", dynamic: true })
    expect(flatten("left + right")).toBeNull()
  })

  it("takes whenTrue else whenFalse from a ternary and is always dynamic", () => {
    expect(flatten("flag ? '/a' : '/b'")).toEqual({ value: "/a", dynamic: true })
    expect(flatten("flag ? unknownThing : '/b'")).toEqual({ value: "/b", dynamic: true })
    expect(flatten("flag ? a : b")).toBeNull()
  })

  it("takes the receiver value of a .replace() call and marks it dynamic", () => {
    expect(flatten("'/orders/:id'.replace(':id', id)")).toEqual({ value: "/orders/:id", dynamic: true })
    expect(flatten("unknownThing.replace(':id', id)")).toBeNull()
  })

  it("returns null for anything else", () => {
    expect(flatten("42")).toBeNull()
    expect(flatten("{ a: 1 }")).toBeNull()
  })

  it("sees through wrappers at every level because it calls unwrap first", () => {
    expect(flatten("('/orders' as const) satisfies string")).toEqual({ value: "/orders", dynamic: false })
    expect(flatten("`/api/${('x' as const)}`")).toEqual({ value: "/api/x", dynamic: false })
  })
})

describe("JSX helpers", () => {
  const source = parse(
    [
      "const el = (",
      "  <Panel data-testid='panel' name={NAME} {...rest} featureFlag='beta'>",
      "    <Router.Outlet />",
      "    <div />",
      "  </Panel>",
      ")",
    ].join("\n"),
  )

  it("lists only JsxAttribute properties, skipping spreads", () => {
    const opening = find(source, ts.isJsxOpeningElement)
    expect(ast.jsxAttributes(opening).map((attribute) => attribute.name.getText())).toEqual([
      "data-testid",
      "name",
      "featureFlag",
    ])
  })

  it("finds an attribute by name and flattens it through the string context", () => {
    const opening = find(source, ts.isJsxOpeningElement)
    expect(ast.attributeByName(opening, "missing")).toBeUndefined()
    expect(ast.attributeString(opening, "data-testid", EMPTY_STRING_CONTEXT)).toBe("panel")
    expect(ast.attributeString(opening, "name", context({ NAME: "orders" }))).toBe("orders")
    expect(ast.attributeString(opening, "name", EMPTY_STRING_CONTEXT)).toBeNull()
  })

  it("resolves <Foo.Bar/> to its namespace root and lowercase host tags stay non-components", () => {
    const tags = findAll(source, ts.isJsxSelfClosingElement).map(ast.tagName)
    expect(tags).toEqual(["Router", "div"])
    expect(tags.map(isComponentTag)).toEqual([true, false])
  })

  it("collects every JSX opening-like element in a subtree", () => {
    expect(ast.jsxElementsIn(source)).toHaveLength(3)
    expect(ast.containsJsx(source)).toBe(true)
    expect(ast.containsJsx(parse("const a = 1"))).toBe(false)
  })

  it("recognises hook names by the React naming rule", () => {
    expect(isHookName("useNavigate")).toBe(true)
    expect(isHookName("used")).toBe(false)
    expect(isComponentTag(null)).toBe(false)
  })
})

describe("guardOf", () => {
  const guardOfFirstWidget = (code: string, stopAt?: ts.Node) => {
    const source = parse(code)
    const element = findAll(source, ts.isJsxSelfClosingElement).find((node) => ast.tagName(node) === "Widget")
    if (element === undefined) throw new Error("no Widget")
    return stopAt === undefined ? ast.guardOf(element) : ast.guardOf(element, stopAt)
  }

  it("collects && and ?? on the right operand", () => {
    expect(guardOfFirstWidget("const a = <>{isOpen && <Widget />}</>").condition).toBe("isOpen")
    expect(guardOfFirstWidget("const a = <>{value ?? <Widget />}</>").condition).toBe("value")
  })

  it("negates the left operand of ||", () => {
    expect(guardOfFirstWidget("const a = <>{isError || <Widget />}</>").condition).toBe("!(isError)")
  })

  it("collects both ternary branches with the false branch negated", () => {
    expect(guardOfFirstWidget("const a = <>{ready ? <Widget /> : null}</>").condition).toBe("ready")
    expect(guardOfFirstWidget("const a = <>{ready ? null : <Widget />}</>").condition).toBe("!(ready)")
  })

  it("joins nested guards outermost-first with ' && '", () => {
    const result = guardOfFirstWidget("const a = <>{isAuth && (!loading ? <Widget /> : null)}</>")
    expect(result.condition).toBe("isAuth && !loading")
  })

  it("marks an element inside a .map() callback as repeated and keeps the outer guard", () => {
    const result = guardOfFirstWidget("const a = <>{isAuth && items.map((item) => <Widget key={item} />)}</>")
    expect(result.repeated).toBe(true)
    expect(result.condition).toBe("isAuth")
  })

  it("stops at a plain function boundary", () => {
    const code = ["const Outer = () => isAuth && renderIt()", "const Inner = () => <Widget />"].join("\n")
    expect(guardOfFirstWidget(code).condition).toBeNull()
  })

  it("collapses whitespace and truncates the condition at 110 characters", () => {
    const long = `someVeryLongCondition${"X".repeat(200)}`
    const result = guardOfFirstWidget(`const a = <>{${long}\n  && <Widget />}</>`)
    expect(result.condition).toHaveLength(110)
    expect(result.condition?.startsWith("someVeryLongCondition")).toBe(true)
  })

  it("clamps the ancestor walk at a sub-file root", () => {
    const source = parse("const a = <>{isAuth && (ready && <Widget />)}</>")
    const element = findAll(source, ts.isJsxSelfClosingElement)[0]
    const inner = findAll(source, ts.isParenthesizedExpression)[0]
    if (element === undefined || inner === undefined) throw new Error("missing nodes")

    expect(ast.guardOf(element).condition).toBe("isAuth && ready")
    expect(ast.guardOf(element, inner).condition).toBe("ready")
  })
})

describe("nullGuardsIn", () => {
  it("records an else-less if returning null or an empty fragment, inside a JSX-rendering function", () => {
    const source = parse(
      [
        "const Screen = () => {",
        "  if (!user) return null",
        "  if (loading) { return <></> }",
        "  if (other) return <div />",
        "  return <main />",
        "}",
      ].join("\n"),
    )

    expect(ast.nullGuardsIn(source)).toEqual(["!user", "loading"])
  })

  it("ignores an if with an else branch", () => {
    const source = parse(
      ["const Screen = () => {", "  if (!user) { return null } else { return <div /> }", "  return <main />", "}"].join(
        "\n",
      ),
    )

    expect(ast.nullGuardsIn(source)).toEqual([])
  })

  it("ignores functions that contain no JSX at all", () => {
    const source = parse(["const value = () => {", "  if (!user) return null", "  return 1", "}"].join("\n"))
    expect(ast.nullGuardsIn(source)).toEqual([])
  })
})

describe("NodeLocator — structural addressing", () => {
  const WIDGET_FILE = (prefix: string) =>
    [
      "export const App = () => {",
      `  ${prefix}return (`,
      "    <div>",
      "      <Widget />",
      "    </div>",
      "  )",
      "}",
    ].join("\n")

  const widgetOf = (source: ts.SourceFile) =>
    findAll(source, ts.isJsxSelfClosingElement).find((node) => ast.tagName(node) === "Widget")

  it("addresses a node by export name plus a forEachChild index path, never by text", () => {
    const source = parse(WIDGET_FILE(""))
    const widget = widgetOf(source)
    if (widget === undefined) throw new Error("no Widget")

    const locator = ast.locate(widget)
    expect(locator.export).toBe("App")
    expect(locator.path.length).toBeGreaterThan(0)
    expect(ast.resolveLocator(source, locator)).toBe(widget)
  })

  it("survives reformatting, added comments and variable renames", () => {
    const original = parse(WIDGET_FILE(""))
    const widget = widgetOf(original)
    if (widget === undefined) throw new Error("no Widget")
    const locator = ast.locate(widget)

    const reformatted = parse(
      [
        "// a brand new leading comment",
        "export const App = () => {",
        "",
        "    /* reflowed by prettier */",
        "    return (",
        "        <div>",
        "",
        "            <Widget    />",
        "        </div>",
        "    )",
        "}",
      ].join("\n"),
    )

    const resolved = ast.resolveLocator(reformatted, locator)
    expect(resolved).not.toBeNull()
    expect(resolved === null ? null : ast.tagName(resolved as ts.JsxSelfClosingElement)).toBe("Widget")
  })

  it("breaks predictably when a sibling statement is inserted before the target", () => {
    const original = parse(WIDGET_FILE(""))
    const widget = widgetOf(original)
    if (widget === undefined) throw new Error("no Widget")
    const locator = ast.locate(widget)

    const shifted = parse(WIDGET_FILE("const inserted = 1\n  "))
    const resolved = ast.resolveLocator(shifted, locator)

    expect(resolved).not.toBe(widgetOf(shifted))
    expect(resolved === null || !ts.isJsxSelfClosingElement(resolved)).toBe(true)
  })

  it("addresses a default export and an exported function declaration", () => {
    const defaulted = parse(["export default function Page() {", "  return <Widget />", "}"].join("\n"))
    const widget = widgetOf(defaulted)
    if (widget === undefined) throw new Error("no Widget")
    expect(ast.locate(widget).export).toBe("default")
    expect(ast.resolveLocator(defaulted, ast.locate(widget))).toBe(widget)

    const named = parse(["export function Page() {", "  return <Widget />", "}"].join("\n"))
    const namedWidget = widgetOf(named)
    if (namedWidget === undefined) throw new Error("no Widget")
    expect(ast.locate(namedWidget).export).toBe("Page")
  })

  it("falls back to the source file itself for a node in no named declaration", () => {
    const source = parse("render(<Widget />)")
    const widget = widgetOf(source)
    if (widget === undefined) throw new Error("no Widget")

    const locator = ast.locate(widget)
    expect(locator.export).toBe("")
    expect(ast.resolveLocator(source, locator)).toBe(widget)
  })

  it("returns null for an unknown export and for an out-of-range path index", () => {
    const source = parse(WIDGET_FILE(""))
    expect(ast.resolveLocator(source, { export: "Missing", path: [] })).toBeNull()
    expect(ast.resolveLocator(source, { export: "App", path: [99] })).toBeNull()
  })

  it("resolves an export declaration node for each supported declaration form", () => {
    const source = parse(
      [
        "export enum Paths { ORDERS = '/orders' }",
        "export class Widget {}",
        "export const value = 1",
        "export default 42",
      ].join("\n"),
    )

    expect(ast.declarationOf(source, "Paths")?.kind).toBe(ts.SyntaxKind.EnumDeclaration)
    expect(ast.declarationOf(source, "Widget")?.kind).toBe(ts.SyntaxKind.ClassDeclaration)
    expect(ast.declarationOf(source, "value")?.kind).toBe(ts.SyntaxKind.VariableDeclaration)
    expect(ast.declarationOf(source, "default")?.kind).toBe(ts.SyntaxKind.ExportAssignment)
  })

  it("keeps the first matching declaration for repeated names and the first default form", () => {
    const source = parse(
      [
        "const [skipped] = []",
        "let first = 1, second = 2",
        "function first() {}",
        "export default function Page() {}",
        "export default 42",
      ].join("\n"),
    )

    expect(ast.declarationOf(source, "first")?.kind).toBe(ts.SyntaxKind.VariableDeclaration)
    expect(ast.declarationOf(source, "second")?.getText()).toBe("second = 2")
    expect(ast.declarationOf(source, "Page")?.kind).toBe(ts.SyntaxKind.FunctionDeclaration)
    expect(ast.declarationOf(source, "default")?.kind).toBe(ts.SyntaxKind.FunctionDeclaration)
    expect(ast.declarationOf(source, "skipped")).toBeNull()
    expect(ast.declarationOf(source, "")).toBe(source)
  })
})

describe("decorators", () => {
  const source = parse(
    [
      'import { Component as Cmp, NgModule } from "@angular/core"',
      '@Cmp({ selector: "my-a", templateUrl: "./a.html" })',
      "export class A {}",
      "@NgModule({ declarations: [A] })",
      "export class M {}",
      "@Injectable()",
      "export class S {}",
      "export class Plain {}",
    ].join("\n"),
    "/repo/src/a.ts",
  )
  const classes = findAll(source, ts.isClassDeclaration)
  const [a, m, s, plain] = classes

  it("lists the decorators of a class", () => {
    expect(classes.map((node) => ast.decoratorsOf(node).length)).toEqual([1, 1, 1, 0])
  })

  it("returns the object argument of a decorator called by its local name", () => {
    expect(ast.decoratorArgument(a!, "Cmp")?.properties.length).toBe(2)
    expect(ast.decoratorArgument(m!, "NgModule")?.properties.length).toBe(1)
  })

  it("returns null for another name, a call without an object or an undecorated class", () => {
    expect(ast.decoratorArgument(a!, "Component")).toBeNull()
    expect(ast.decoratorArgument(s!, "Injectable")).toBeNull()
    expect(ast.decoratorArgument(plain!, "Component")).toBeNull()
  })

  it("returns no decorators for a node that cannot carry them", () => {
    expect(ast.decoratorsOf(source)).toEqual([])
  })
})
