import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import type { FileHost } from "../../src/core/host.js"
import { resolveConfig } from "../../src/config/types.js"
import { createEnv, createProjectContext } from "../../src/pipeline/context.js"
import type { Screen } from "../../src/core/model.js"
import { convertTanStackRoutePath } from "../../src/core/url.js"
import { runPipeline } from "../../src/pipeline/run.js"
import {
  DEFAULT_PATHLESS_ROLES,
  createTanStackRouterAdapter,
  detectTanStackRouter,
} from "../../src/adapters/tanstack-router.js"
import type { TanStackRouterOptions } from "../../src/adapters/tanstack-router.js"
import { tanstackRouterCases } from "../fixtures/route-dialects/tanstack-router.js"
import {
  tanstackEscapedFileRouteCases,
  tanstackLiteralSegmentCases,
} from "../fixtures/route-dialects/tanstack-file-routes-corpus.js"
import { ROOT, codes, run, withProject } from "../pipeline/harness.js"

const PACKAGE_JSON = JSON.stringify({
  name: "@acme/admin",
  dependencies: {
    react: "19.0.0",
    "@tanstack/react-router": "1.100.0",
    "@tanstack/react-start": "1.100.0",
  },
})

const analyze = (files: Readonly<Record<string, string>>) =>
  run({ files: { "package.json": PACKAGE_JSON, ...files }, adapters: [createTanStackRouterAdapter()] })

const screenAt = (screens: readonly Screen[], url: string | null): Screen | undefined =>
  screens.find((screen) => screen.url === url)

const urlsOf = (screens: readonly Screen[]): readonly (string | null)[] => screens.map((screen) => screen.url)

const evidenceOf = (screen: Screen | undefined): readonly string[] =>
  (screen?.provenance.evidence ?? []).map((entry) => entry.what)

const routeFile = (literal: string | null, component = "RouteScreen"): string =>
  [
    `import { createFileRoute } from "@tanstack/react-router"`,
    `import { routePath } from "../route-path"`,
    `export const Route = createFileRoute(${literal ?? "routePath"})({ component: ${component} })`,
    `function ${component}() { return <div /> }`,
    "",
  ].join("\n")

/** `routePath` is an unresolvable binding, so the literal is unreadable and the FILENAME decides. */
const UNREADABLE_PATH_MODULE = `export const routePath = buildPath()\n`

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const detectOn = (files: Readonly<Record<string, string>>) => {
  const host = createMemoryHost({
    files: Object.fromEntries(Object.entries(files).map(([file, text]) => [`${ROOT}/${file}`, text])),
  })
  const env = createEnv({ ts, config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }), host })
  return detectTanStackRouter(createProjectContext(env))
}

const ROUTE_TEXT = `export const Route = createFileRoute("/orders")({ component: Orders })\n`

describe("tanstack-router: detect", () => {
  for (const dependency of ["@tanstack/react-router", "@tanstack/react-start"])
    it(`scores 100 for a ${dependency} dependency plus a createFileRoute call`, () => {
      const result = detectOn({
        "package.json": JSON.stringify({ dependencies: { [dependency]: "1.100.0" } }),
        "src/routes/orders.tsx": ROUTE_TEXT,
      })

      expect(result.score).toBe(100)
      expect(result.evidence.map((entry) => entry.what)).toEqual([
        `${dependency} dependency`,
        "createFileRoute call",
      ])
      expect(result.evidence[1]?.file).toBe("src/routes/orders.tsx")
      expect(result.evidence[1]?.line).toBe(1)
    })

  it("scores 0 without the dependency, even with a createFileRoute call", () => {
    const result = detectOn({
      "package.json": JSON.stringify({ dependencies: { react: "19.0.0" } }),
      "src/routes/orders.tsx": ROUTE_TEXT,
    })
    expect(result.score).toBe(0)
    expect(result.evidence).toEqual([])
  })

  it("scores 0 with the dependency but no createFileRoute call anywhere", () => {
    expect(
      detectOn({
        "package.json": PACKAGE_JSON,
        "src/app.tsx": "export const App = () => <div />\n",
      }).score,
    ).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The route-dialect fixture table, filename side
// ---------------------------------------------------------------------------

describe("tanstack-router: route-dialect fixture conversion (filename)", () => {
  for (const testCase of tanstackRouterCases) {
    it(testCase.description, () => {
      const result = analyze({
        "src/route-path.ts": UNREADABLE_PATH_MODULE,
        [testCase.input]: routeFile(null),
      })

      expect(codes(result)).not.toContain("plugin/threw")
      expect(result.graph.screens[0]?.url).toBe(testCase.expected)
    })
  }

  it("sets auth from the pathless map for every case whose path carries `_authed`", () => {
    for (const testCase of tanstackRouterCases) {
      const result = analyze({
        "src/route-path.ts": UNREADABLE_PATH_MODULE,
        [testCase.input]: routeFile(null),
      })
      const expected = testCase.input.includes("_authed") ? "protected" : "unknown"
      expect(result.graph.screens[0]?.auth, testCase.input).toBe(expected)
    }
  })
})

// ---------------------------------------------------------------------------
// The literal is authoritative
// ---------------------------------------------------------------------------

const LITERAL_CASES = [
  { literal: "/users/$userId", expected: "/users/:userId" },
  { literal: "/files/$", expected: "/files/*" },
  { literal: "/_authed/orders/$orderId/edit", expected: "/orders/:orderId/edit" },
  { literal: "/_authed/orders/", expected: "/orders" },
  { literal: "/posts/", expected: "/posts" },
] as const

describe("tanstack-router: the createFileRoute literal is authoritative", () => {
  for (const testCase of LITERAL_CASES)
    it(`reads '${testCase.literal}' as ${testCase.expected}`, () => {
      const result = analyze({
        "src/route-path.ts": UNREADABLE_PATH_MODULE,
        "src/routes/whatever.tsx": routeFile(`"${testCase.literal}"`),
      })
      expect(result.graph.screens[0]?.url).toBe(testCase.expected)
    })

  const STALE_FILE = "src/routes/legacy-orders.tsx"

  const staleRun = () =>
    analyze({
      "src/route-path.ts": UNREADABLE_PATH_MODULE,
      [STALE_FILE]: routeFile(`"/orders" as const`),
    })

  it("warns when the literal and the filename disagree, and the LITERAL wins", () => {
    const result = staleRun()
    const diagnostic = result.diagnostics.find((entry) => entry.code === "screens/stale-route-literal")

    // The naive answer — filename only — is a different URL, so "the literal wins" cannot pass by
    // accident: it is only satisfiable by reading the literal.
    expect(convertTanStackRoutePath(STALE_FILE).url).toBe("/legacy-orders")
    expect(urlsOf(result.graph.screens)).toEqual(["/orders"])

    expect(diagnostic?.severity).toBe("warning")
    expect(diagnostic?.message).toContain("/orders")
    expect(diagnostic?.message).toContain(STALE_FILE)
    expect(diagnostic?.message).toContain("/legacy-orders")
    expect(diagnostic?.file).toBe(STALE_FILE)
  })

  it("stays silent when the literal and the filename agree", () => {
    const result = analyze({
      "src/route-path.ts": UNREADABLE_PATH_MODULE,
      "src/routes/_authed/orders.index.tsx": routeFile(`"/_authed/orders/"`),
    })

    expect(urlsOf(result.graph.screens)).toEqual(["/orders"])
    expect(codes(result)).not.toContain("screens/stale-route-literal")
  })

  it("falls back to the filename when the literal is not readable, and warns about nothing", () => {
    const result = analyze({
      "src/route-path.ts": UNREADABLE_PATH_MODULE,
      "src/routes/_authed/orders.$orderId.edit.tsx": routeFile(null),
    })

    expect(urlsOf(result.graph.screens)).toEqual(["/orders/:orderId/edit"])
    expect(codes(result)).not.toContain("screens/stale-route-literal")
  })

  /** The exact node a raw type test inspects: `createFileRoute(<here>)`. */
  const literalArgumentOf = (text: string): ts.Node | null => {
    const source = ts.createSourceFile("route.tsx", text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
    let found: ts.Node | null = null
    const visit = (node: ts.Node): void => {
      if (
        found === null &&
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "createFileRoute"
      )
        found = node.arguments[0] ?? null
      node.forEachChild(visit)
    }
    visit(source)
    return found
  }

  it("a raw ts.isStringLiteral accepts the plain literal — the control case", () => {
    const node = literalArgumentOf(routeFile(`"/orders"`))
    expect(node).not.toBeNull()
    expect(ts.isStringLiteral(node as ts.Node)).toBe(true)
  })

  it("a raw ts.isStringLiteral REJECTS `'/orders' as const`, yet the literal still wins", () => {
    const node = literalArgumentOf(routeFile(`"/orders" as const`))

    expect(node).not.toBeNull()
    expect(ts.isStringLiteral(node as ts.Node)).toBe(false)
    expect(urlsOf(staleRun().graph.screens)).toEqual(["/orders"])
  })

  it("narrows a parenthesised and a `satisfies`-annotated literal the same way", () => {
    for (const wrapped of [`("/orders")`, `"/orders" satisfies string`]) {
      const result = analyze({
        "src/route-path.ts": UNREADABLE_PATH_MODULE,
        "src/routes/legacy-orders.tsx": routeFile(wrapped),
      })
      expect(urlsOf(result.graph.screens), wrapped).toEqual(["/orders"])
    }
  })
})

// ---------------------------------------------------------------------------
// An admin-panel-shaped tree
// ---------------------------------------------------------------------------

const ROOT_ROUTE = [
  `import { Outlet, createRootRoute } from "@tanstack/react-router"`,
  `export const Route = createRootRoute({ component: RootDocument })`,
  `function RootDocument() { return <div className="app"><Outlet /></div> }`,
  "",
].join("\n")

const AUTHED_ROUTE = [
  `import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"`,
  `export const Route = createFileRoute("/_authed")({`,
  `  beforeLoad: ({ context }) => {`,
  `    if (!context.user) throw redirect({ to: "/login" })`,
  `  },`,
  `  component: AuthedLayout,`,
  `})`,
  `function AuthedLayout() { return <div className="shell"><Outlet /></div> }`,
  "",
].join("\n")

const ACCOUNT_EDIT_ROUTE = [
  `import { createFileRoute } from "@tanstack/react-router"`,
  `import { createServerFn } from "@tanstack/react-start"`,
  `const loadAccount = createServerFn({ method: "GET" }).handler(async () => ({}))`,
  `export const Route = createFileRoute("/_authed/accounts/$accountUuid/edit")({`,
  `  loader: () => loadAccount(),`,
  `  component: EditAccount,`,
  `})`,
  `function EditAccount() { return <form /> }`,
  "",
].join("\n")

const ORDERS_INDEX_ROUTE = [
  `import { createFileRoute } from "@tanstack/react-router"`,
  `import { z } from "zod"`,
  `export const Route = createFileRoute("/_authed/orders/")({`,
  `  validateSearch: z.object({ status: z.string(), page: z.number().optional() }),`,
  `  component: OrdersIndex,`,
  `})`,
  `function OrdersIndex() { return <table /> }`,
  "",
].join("\n")

const GENERATED_TREE = [
  `/* eslint-disable */`,
  `// @ts-nocheck`,
  `// This file was automatically generated by TanStack Router. Do not edit.`,
  `export const Route = createFileRoute("/_authed/accounts/$accountUuid/edit")({ id: "/ghost" })`,
  `export const Ghost = createFileRoute("/ghost")({})`,
  "",
].join("\n")

const APP_FILES = {
  "package.json": PACKAGE_JSON,
  "src/routeTree.gen.ts": GENERATED_TREE,
  "src/routes/__root.tsx": ROOT_ROUTE,
  "src/routes/_authed.tsx": AUTHED_ROUTE,
  "src/routes/_authed/accounts/$accountUuid.edit.tsx": ACCOUNT_EDIT_ROUTE,
  "src/routes/_authed/orders.index.tsx": ORDERS_INDEX_ROUTE,
  "src/routes/files.$.tsx": routeFile(`"/files/$"`, "Files"),
  "src/routes/login.tsx": routeFile(`"/login"`, "Login"),
  "src/route-path.ts": UNREADABLE_PATH_MODULE,
} as const

const appRun = () => run({ files: APP_FILES, adapters: [createTanStackRouterAdapter()] })

describe("tanstack-router: a DOT-NOTATION route tree (orders.index.tsx)", () => {
  it("converts every route path, dropping the pathless segments from the URL", () => {
    const screens = appRun().graph.screens

    expect(urlsOf(screens).filter((url) => url !== null).sort()).toEqual([
      "/accounts/:accountUuid/edit",
      "/files/*",
      "/login",
      "/orders",
    ])
    expect(screenAt(screens, "/accounts/:accountUuid/edit")?.params).toEqual(["accountUuid"])
  })

  it("sets auth from the pathless map and leaves an unguarded route alone", () => {
    const screens = appRun().graph.screens

    expect(screenAt(screens, "/accounts/:accountUuid/edit")?.auth).toBe("protected")
    expect(screenAt(screens, "/orders")?.auth).toBe("protected")
    expect(screenAt(screens, "/login")?.auth).toBe("unknown")
  })

  it("ships `_authed` as a CONFIGURABLE default, not a hardcoded name", () => {
    expect(DEFAULT_PATHLESS_ROLES).toEqual({ _authed: { auth: "protected" } })

    const result = run({
      files: {
        ...APP_FILES,
        "src/routes/_authed.tsx": AUTHED_ROUTE.replace(/ {2}beforeLoad[\s\S]*?\n {2}\},\n/, ""),
        "src/routes/_private/secrets.tsx": routeFile(`"/_private/secrets"`, "Secrets"),
      },
      adapters: [createTanStackRouterAdapter({ pathless: { _private: { auth: "protected" } } })],
    })

    expect(screenAt(result.graph.screens, "/secrets")?.auth).toBe("protected")
    // With `_authed` unmapped and no beforeLoad guard, the `_authed` routes carry no assertion.
    expect(screenAt(result.graph.screens, "/orders")?.auth).toBe("unknown")
  })

  it("RETAINS the pathless `_authed` layout route with url null, tagged, non-addressable", () => {
    const pathless = appRun().graph.screens.filter((screen) => screen.url === null)

    expect(pathless).toHaveLength(1)
    expect(pathless[0]?.kindTag).toBe("layout")
    expect(pathless[0]?.addressable).toBe(false)
    expect(pathless[0]?.activations).toEqual([])
  })

  it("surfaces the `beforeLoad` redirect in the pathless route's evidence", () => {
    const layout = appRun().graph.screens.find((screen) => screen.url === null)
    expect(evidenceOf(layout)).toContain("beforeLoad redirect to '/login' (conditional: !context.user)")
  })

  it("records the pathless segment itself as evidence on the screens below it", () => {
    expect(evidenceOf(screenAt(appRun().graph.screens, "/orders"))).toContain(
      "pathless segment '_authed' (no URL segment)",
    )
  })

  it("gives every screen evidence pointing at a real route file", () => {
    for (const screen of appRun().graph.screens) {
      expect(screen.provenance.evidence.length).toBeGreaterThan(0)
      for (const entry of screen.provenance.evidence) expect(entry.file).toMatch(/^src\/routes\//)
    }
  })
})

describe("tanstack-router: the generated route tree", () => {
  const runWithReads = () => {
    const reads: string[] = []
    const base = createMemoryHost({ files: withProject(APP_FILES) })
    const host: FileHost = {
      ...base,
      readFile: (abs) => {
        reads.push(abs)
        return base.readFile(abs)
      },
    }

    const result = runPipeline({
      ts,
      host,
      config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test", formats: ["full"] }),
      adapters: [createTanStackRouterAdapter()],
    })
    return { result, reads }
  }

  it("never reads src/routeTree.gen.ts at all", () => {
    const { reads } = runWithReads()
    expect(reads.some((abs) => abs.includes("routeTree.gen.ts"))).toBe(false)
  })

  it("does not double-count the routes the generated tree re-declares", () => {
    const { result } = runWithReads()

    expect(urlsOf(result.graph.screens).filter((url) => url === "/accounts/:accountUuid/edit")).toEqual([
      "/accounts/:accountUuid/edit",
    ])
    expect(urlsOf(result.graph.screens)).not.toContain("/ghost")
  })

  it("the generated file WOULD have produced routes had it not been skipped", () => {
    const result = analyze({
      "src/route-path.ts": UNREADABLE_PATH_MODULE,
      // Same text, a name the generated-file rule does not recognise.
      "src/routes/handwritten.tsx": GENERATED_TREE.split("\n").slice(3).join("\n"),
    })
    expect(urlsOf(result.graph.screens)).toContain("/ghost")
  })
})

describe("tanstack-router: ancestor chains", () => {
  it("builds the pathless chain outermost-first, __root.tsx included, spliced at <Outlet/>", () => {
    const edit = screenAt(appRun().graph.screens, "/accounts/:accountUuid/edit")

    expect(edit?.ancestors.map((ancestor) => [ancestor.file, ancestor.role, ancestor.splice.kind])).toEqual([
      ["src/routes/__root.tsx", "layout", "outlet"],
      ["src/routes/_authed.tsx", "layout", "outlet"],
    ])
    expect(edit?.shell).toBe("src/routes/_authed.tsx")
  })

  it("names the EXPORTED outlet tag on every splice, so an aliased import still resolves", () => {
    const chain = screenAt(appRun().graph.screens, "/orders")?.ancestors ?? []

    expect(chain.length).toBeGreaterThan(0)
    for (const ancestor of chain) expect(ancestor.splice).toEqual({ kind: "outlet", tag: "Outlet" })
  })

  it("splices a chain whose ancestor renders an ALIASED <Slot/> without dropping it", () => {
    const result = run({
      files: {
        ...APP_FILES,
        "src/routes/_authed.tsx": AUTHED_ROUTE.replace(
          `import { Outlet, createFileRoute, redirect }`,
          `import { Outlet as Slot, createFileRoute, redirect }`,
        ).replace("<Outlet />", "<Slot />"),
      },
      adapters: [createTanStackRouterAdapter()],
    })

    expect(
      screenAt(result.graph.screens, "/orders")?.ancestors.map((ancestor) => ancestor.file),
    ).toEqual(["src/routes/__root.tsx", "src/routes/_authed.tsx"])
    expect(codes(result)).not.toContain("walk/no-splice-point")
  })

  it("emits no walk/no-splice-point (and no ambiguity) for the normal chain", () => {
    expect(codes(appRun()).filter((code) => code.startsWith("walk/"))).toEqual([])
  })

  it("gives the pathless layout route __root.tsx as its ancestor, never itself", () => {
    const layout = appRun().graph.screens.find((screen) => screen.url === null)

    expect(layout?.ancestors.map((ancestor) => ancestor.file)).toEqual(["src/routes/__root.tsx"])
  })

  it("gives a route outside any routes/ directory no chain rather than a guessed one", () => {
    const result = analyze({
      "src/route-path.ts": UNREADABLE_PATH_MODULE,
      "src/pages/orders.tsx": routeFile(`"/orders"`, "Orders"),
    })

    expect(screenAt(result.graph.screens, "/orders")?.ancestors).toEqual([])
  })
})

describe("tanstack-router: validateSearch", () => {
  it("reports the search-param NAMES and says required-ness is undecidable", () => {
    const result = appRun()
    const orders = screenAt(result.graph.screens, "/orders")
    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "facts/needs-typechecker" && entry.file?.includes("orders.index"),
    )

    expect(evidenceOf(orders)).toContain("validateSearch params: page, status")
    expect(diagnostic?.severity).toBe("info")
    expect(diagnostic?.message).toContain("status")
    expect(diagnostic?.message).toContain("page")
    expect(diagnostic?.message).toContain("possibly optional")
  })

  it("keeps search params OUT of the URL params, which are path params only", () => {
    expect(screenAt(appRun().graph.screens, "/orders")?.params).toEqual([])
  })
})

describe("tanstack-router: data flows through createServerFn, not HTTP", () => {
  it("asserts no http endpoint for a route whose loader calls a server fn", () => {
    const edit = screenAt(appRun().graph.screens, "/accounts/:accountUuid/edit")
    const endpoints = edit?.facts.endpoints ?? []

    expect(endpoints.length).toBeGreaterThan(0)
    expect(endpoints.every((endpoint) => endpoint.transport === "rpc")).toBe(true)
    expect(endpoints.some((endpoint) => endpoint.transport === "http")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The DIRECTORY convention — `messages/index.tsx`, not `messages.index.tsx`
//
// Every fixture above uses dot notation, which writes the layout-route/index-child pair as
// `messages.tsx` + `messages.index.tsx`. Apps using the directory convention write it as
// `messages.tsx` + `messages/index.tsx`.
// ---------------------------------------------------------------------------

const layoutRouteFile = (literal: string, component: string): string =>
  [
    `import { createFileRoute, Outlet } from "@tanstack/react-router"`,
    `export const Route = createFileRoute("${literal}")({ component: ${component} })`,
    `function ${component}() { return <section><h1>${component}</h1><Outlet /></section> }`,
    "",
  ].join("\n")

const indexChildFile = (literal: string): string =>
  [
    `import { createFileRoute } from "@tanstack/react-router"`,
    `export const Route = createFileRoute("${literal}")({ component: () => null })`,
    "",
  ].join("\n")

const DIRECTORY_FILES = {
  "package.json": PACKAGE_JSON,
  "src/routes/__root.tsx": ROOT_ROUTE,
  "src/routes/_authed.tsx": AUTHED_ROUTE,
  "src/routes/_authed/messages.tsx": layoutRouteFile("/_authed/messages", "MessagesLayout"),
  "src/routes/_authed/messages/index.tsx": indexChildFile("/_authed/messages/"),
  "src/routes/_authed/messages/$threadId.tsx": indexChildFile("/_authed/messages/$threadId"),
  "src/routes/_authed/accounts/index.tsx": indexChildFile("/_authed/accounts/"),
  "src/route-path.ts": UNREADABLE_PATH_MODULE,
} as const

const directoryRun = () => run({ files: DIRECTORY_FILES, adapters: [createTanStackRouterAdapter()] })

const screenByLocalId = (screens: readonly Screen[], localId: string): Screen | undefined =>
  screens.find((screen) => screen.localId === localId)

describe("tanstack-router: a DIRECTORY-convention route tree (messages/index.tsx)", () => {
  it("does not report the layout route and its index child as a duplicate screen id", () => {
    const result = directoryRun()

    expect(codes(result)).not.toContain("screens/duplicate-id")
    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([])
  })

  it("keeps BOTH entries and gives '/messages' to the index child alone", () => {
    const screens = directoryRun().graph.screens

    expect(urlsOf(screens).filter((url) => url === "/messages")).toEqual(["/messages"])
    expect(screenAt(screens, "/messages")?.localId).toBe("src/routes/_authed/messages/index.tsx")
    expect(screenByLocalId(screens, "src/routes/_authed/messages.tsx")).toBeDefined()
  })

  it("gives the layout route the url-null treatment: tagged, non-addressable, no activation", () => {
    const layout = screenByLocalId(directoryRun().graph.screens, "src/routes/_authed/messages.tsx")

    expect(layout?.url).toBeNull()
    expect(layout?.kindTag).toBe("layout")
    expect(layout?.addressable).toBe(false)
    expect(layout?.activations).toEqual([])
    expect(evidenceOf(layout)).toContain(
      "layout route: renders <Outlet/> and has an index child, which owns '/messages'",
    )
  })

  it("leaves the other directory-convention routes addressable", () => {
    const urls = urlsOf(directoryRun().graph.screens).filter((url) => url !== null)
    expect([...urls].sort()).toEqual(["/accounts", "/messages", "/messages/:threadId"])
  })

  it("keeps an Outlet-less parent as the layout and lets the walk report the missing splice point", () => {
    const result = run({
      files: {
        ...DIRECTORY_FILES,
        "src/routes/_authed/messages.tsx": routeFile(`"/_authed/messages"`, "MessagesNoOutlet"),
      },
      adapters: [createTanStackRouterAdapter()],
    })
    const layout = screenByLocalId(result.graph.screens, "src/routes/_authed/messages.tsx")

    expect(codes(result)).not.toContain("screens/duplicate-id")
    expect(layout?.kindTag).toBe("layout")
    expect(evidenceOf(layout)).toContain("layout route: has an index child, which owns '/messages'")
    expect(
      result.diagnostics.some(
        (entry) => entry.code === "walk/no-splice-point" && entry.message.includes("src/routes/_authed/messages.tsx"),
      ),
    ).toBe(true)
  })

  it("puts a non-pathless parent route into its children's chain", () => {
    const thread = screenAt(directoryRun().graph.screens, "/messages/:threadId")

    expect(thread?.ancestors.map((ancestor) => ancestor.file)).toEqual([
      "src/routes/__root.tsx",
      "src/routes/_authed.tsx",
      "src/routes/_authed/messages.tsx",
    ])
    expect(thread?.shell).toBe("src/routes/_authed/messages.tsx")
  })
})

// ---------------------------------------------------------------------------
// `route.tsx` — the segment's own layout route
// ---------------------------------------------------------------------------

const emptyRouteFile = (literal: string, factory = "createFileRoute"): string =>
  [`import { ${factory} } from "@tanstack/react-router"`, `export const Route = ${factory}("${literal}")({})`, ""].join(
    "\n",
  )

const entryNames = (screen: Screen | undefined): readonly string[] =>
  (screen?.entries ?? []).map((entry) => (entry.kind === "file" ? `${entry.file}#${entry.exportName}` : entry.expr))

const lazyRouteFile = (literal: string, body: string, imports = ""): string =>
  [
    `import { Outlet, createLazyFileRoute } from "@tanstack/react-router"`,
    imports,
    `export const Route = createLazyFileRoute("${literal}")({ component: Page })`,
    `function Page() { return ${body} }`,
    "",
  ].join("\n")

const SEGMENT_FILES = {
  "package.json": PACKAGE_JSON,
  "src/routes/__root.tsx": ROOT_ROUTE,
  "src/routes/_authed.tsx": AUTHED_ROUTE,
  "src/routes/_authed/workspace/$workspaceId/route.tsx": layoutRouteFile("/_authed/workspace/$workspaceId", "WorkspaceShell"),
  "src/routes/_authed/workspace/$workspaceId/index.tsx": indexChildFile("/_authed/workspace/$workspaceId/"),
  "src/routes/_authed/workspace/$workspaceId/documents.tsx": indexChildFile("/_authed/workspace/$workspaceId/documents"),
} as const

const segmentRun = (overrides: Readonly<Record<string, string>> = {}) =>
  run({ files: { ...SEGMENT_FILES, ...overrides }, adapters: [createTanStackRouterAdapter()] })

describe("tanstack-router: `route.tsx` is the layout route of its directory", () => {
  it("gives '/workspace/:workspaceId' to index.tsx alone — no duplicate id, no stale-literal warning", () => {
    const result = segmentRun()

    expect(codes(result)).not.toContain("screens/duplicate-id")
    expect(codes(result)).not.toContain("screens/stale-route-literal")
    expect(screenAt(result.graph.screens, "/workspace/:workspaceId")?.localId).toBe(
      "src/routes/_authed/workspace/$workspaceId/index.tsx",
    )
  })

  it("tags route.tsx as a non-addressable layout", () => {
    const layout = screenByLocalId(segmentRun().graph.screens, "src/routes/_authed/workspace/$workspaceId/route.tsx")

    expect(layout?.url).toBeNull()
    expect(layout?.kindTag).toBe("layout")
    expect(layout?.addressable).toBe(false)
  })

  it("splices both the index child and a sibling route into route.tsx", () => {
    const screens = segmentRun().graph.screens

    for (const url of ["/workspace/:workspaceId", "/workspace/:workspaceId/documents"])
      expect(screenAt(screens, url)?.shell, url).toBe("src/routes/_authed/workspace/$workspaceId/route.tsx")
  })

  it("treats `foo.route.tsx` + `foo.index.tsx` the same way", () => {
    const result = run({
      files: {
        "package.json": PACKAGE_JSON,
        "src/routes/__root.tsx": ROOT_ROUTE,
        "src/routes/reports.route.tsx": layoutRouteFile("/reports", "ReportsShell"),
        "src/routes/reports.index.tsx": indexChildFile("/reports/"),
      },
      adapters: [createTanStackRouterAdapter()],
    })

    expect(codes(result)).not.toContain("screens/duplicate-id")
    expect(screenAt(result.graph.screens, "/reports")?.localId).toBe("src/routes/reports.index.tsx")
    expect(screenByLocalId(result.graph.screens, "src/routes/reports.route.tsx")?.kindTag).toBe("layout")
  })
})

// ---------------------------------------------------------------------------
// `.lazy.tsx` companions and component-less routes
// ---------------------------------------------------------------------------

describe("tanstack-router: `.lazy` companions", () => {
  const files = {
    "package.json": PACKAGE_JSON,
    "src/routes/__root.tsx": ROOT_ROUTE,
    "src/routes/_authed.tsx": emptyRouteFile("/_authed"),
    "src/routes/_authed.lazy.tsx": lazyRouteFile("/_authed", "<main><Outlet /></main>"),
    "src/routes/_authed/calendar.tsx": emptyRouteFile("/_authed/calendar"),
    "src/routes/_authed/calendar.lazy.tsx": lazyRouteFile("/_authed/calendar", "<section />"),
    "src/routes/_authed/kanban.lazy.tsx": lazyRouteFile("/_authed/kanban", "<section />"),
  } as const

  const lazyRun = () => run({ files, adapters: [createTanStackRouterAdapter()] })

  it("merges a critical file and its lazy half into ONE screen whose entry is the lazy half's component", () => {
    const calendar = screenAt(lazyRun().graph.screens, "/calendar")

    expect(calendar?.localId).toBe("src/routes/_authed/calendar.tsx")
    expect(entryNames(calendar)).toEqual(["src/routes/_authed/calendar.lazy.tsx#Page"])
    expect(evidenceOf(calendar)).toContain("lazy companion 'src/routes/_authed/calendar.lazy.tsx'")
  })

  it("keeps both route modules as entries when neither half names a component", () => {
    const result = run({
      files: {
        ...files,
        "src/routes/_authed/empty.tsx": emptyRouteFile("/_authed/empty"),
        "src/routes/_authed/empty.lazy.tsx": emptyRouteFile("/_authed/empty", "createLazyFileRoute"),
      },
      adapters: [createTanStackRouterAdapter()],
    })

    expect(entryNames(screenAt(result.graph.screens, "/empty"))).toEqual([
      "src/routes/_authed/empty.lazy.tsx#Route",
      "src/routes/_authed/empty.tsx#Route",
    ])
  })

  it("discovers a lazy-only route at the URL its literal names, not '/kanban/lazy'", () => {
    const urls = urlsOf(lazyRun().graph.screens)

    expect(urls).toContain("/kanban")
    expect(urls.filter((url) => url === "/calendar")).toEqual(["/calendar"])
    expect(urls.some((url) => url?.includes("lazy") === true)).toBe(false)
  })

  it("splices into the LAZY file when the critical file has no component", () => {
    const result = lazyRun()

    expect(
      screenAt(result.graph.screens, "/kanban")?.ancestors.map((ancestor) => [ancestor.file, ancestor.role]),
    ).toEqual([
      ["src/routes/__root.tsx", "layout"],
      ["src/routes/_authed.tsx", "transparent"],
      ["src/routes/_authed.lazy.tsx", "layout"],
    ])
    expect(screenAt(result.graph.screens, "/kanban")?.shell).toBe("src/routes/_authed.lazy.tsx")
    expect(codes(result).filter((code) => code.startsWith("walk/"))).toEqual([])
  })
})

describe("tanstack-router: a route without a component renders an implicit <Outlet/>", () => {
  const files = {
    "package.json": PACKAGE_JSON,
    "src/routes/__root.tsx": ROOT_ROUTE,
    "src/routes/_authed.tsx": emptyRouteFile("/_authed"),
    "src/routes/_authed/orders.tsx": routeFile(`"/_authed/orders"`, "Orders"),
    "src/route-path.ts": UNREADABLE_PATH_MODULE,
  } as const

  const implicitRun = () => run({ files, adapters: [createTanStackRouterAdapter()] })

  it("hands the component-less layout down as a TRANSPARENT link, not a splice point", () => {
    const orders = screenAt(implicitRun().graph.screens, "/orders")

    expect(orders?.ancestors.map((ancestor) => [ancestor.file, ancestor.role])).toEqual([
      ["src/routes/__root.tsx", "layout"],
      ["src/routes/_authed.tsx", "transparent"],
    ])
    expect(orders?.shell).toBe("src/routes/__root.tsx")
  })

  it("emits no walk/no-splice-point for it", () => {
    expect(codes(implicitRun())).not.toContain("walk/no-splice-point")
  })

  it("records the implicit outlet on the layout itself", () => {
    const layout = implicitRun().graph.screens.find((screen) => screen.url === null)
    expect(evidenceOf(layout)).toContain("no component: renders an implicit <Outlet/>")
  })
})

describe("tanstack-router: a layout that delegates its <Outlet/> to an imported component", () => {
  const files = {
    "package.json": PACKAGE_JSON,
    "src/routes/__root.tsx": ROOT_ROUTE,
    "src/routes/workspace/$workspaceId/route.tsx": emptyRouteFile("/workspace/$workspaceId"),
    "src/routes/workspace/$workspaceId/route.lazy.tsx": lazyRouteFile(
      "/workspace/$workspaceId",
      "<WorkspaceLayout />",
      `import { WorkspaceLayout } from "@/modules/workspace"`,
    ),
    "src/routes/workspace/$workspaceId/settings.tsx": indexChildFile("/workspace/$workspaceId/settings"),
    "src/modules/workspace/index.ts": `export { WorkspaceLayout } from "./WorkspaceLayout"\n`,
    "src/modules/workspace/WorkspaceLayout.tsx": [
      `import { Outlet } from "@tanstack/react-router"`,
      `export function WorkspaceLayout() { return <div><nav /><Outlet /></div> }`,
      "",
    ].join("\n"),
  } as const

  it("splices at the delegate and keeps the route file as a transparent link", () => {
    const result = run({ files, adapters: [createTanStackRouterAdapter()] })
    const settings = screenAt(result.graph.screens, "/workspace/:workspaceId/settings")

    expect(settings?.ancestors.map((ancestor) => [ancestor.file, ancestor.exportName, ancestor.role])).toEqual([
      ["src/routes/__root.tsx", "", "layout"],
      ["src/routes/workspace/$workspaceId/route.tsx", "", "transparent"],
      ["src/routes/workspace/$workspaceId/route.lazy.tsx", "", "transparent"],
      ["src/modules/workspace/WorkspaceLayout.tsx", "WorkspaceLayout", "layout"],
    ])
    expect(settings?.shell).toBe("src/modules/workspace/WorkspaceLayout.tsx")
    expect(codes(result)).not.toContain("walk/no-splice-point")
  })
})

describe("tanstack-router: detect (file-based lazy routes)", () => {
  it("scores 100 for a createLazyFileRoute call alone", () => {
    const result = detectOn({
      "package.json": PACKAGE_JSON,
      "src/routes/kanban.lazy.tsx": `export const Route = createLazyFileRoute("/kanban")({})\n`,
    })
    expect(result.score).toBe(100)
    expect(result.evidence[1]?.what).toBe("createLazyFileRoute call")
  })
})

// ---------------------------------------------------------------------------
// The screen's entry is the page component, not the route module
// ---------------------------------------------------------------------------

describe("tanstack-router: the entry is `component: X`, resolved through imports", () => {
  const files = {
    "package.json": PACKAGE_JSON,
    "src/routes/__root.tsx": ROOT_ROUTE,
    "src/routes/_authed.tsx": emptyRouteFile("/_authed"),
    "src/routes/_authed/task-board.lazy.tsx": [
      `import { TaskBoardView } from "@/modules/tasks/task-board"`,
      `import { createLazyFileRoute } from "@tanstack/react-router"`,
      `export const Route = createLazyFileRoute("/_authed/task-board")({ component: TaskBoardView })`,
      "",
    ].join("\n"),
    "src/routes/_authed/reports.tsx": [
      `import { createFileRoute } from "@tanstack/react-router"`,
      `import ReportsPage from "@/pages/ReportsPage"`,
      `export const Route = createFileRoute("/_authed/reports")({ component: ReportsPage })`,
      "",
    ].join("\n"),
    "src/routes/_authed/vendor.tsx": [
      `import { createFileRoute } from "@tanstack/react-router"`,
      `import { VendorPage } from "vendor-ui"`,
      `export const Route = createFileRoute("/_authed/vendor")({ component: VendorPage })`,
      "",
    ].join("\n"),
    "src/modules/tasks/task-board/index.ts": `export { TaskBoardView } from "./TaskBoardView"\n`,
    "src/modules/tasks/task-board/TaskBoardView.tsx": `export function TaskBoardView() { return <section /> }\n`,
    "src/pages/ReportsPage.tsx": `export default function ReportsPage() { return <main /> }\n`,
  } as const

  const entryRun = () => run({ files, adapters: [createTanStackRouterAdapter()] })

  it("enters a lazy-only route at the imported view, through a barrel", () => {
    expect(entryNames(screenAt(entryRun().graph.screens, "/task-board"))).toEqual([
      "src/modules/tasks/task-board/TaskBoardView.tsx#TaskBoardView",
    ])
  })

  it("enters a non-lazy route at its default-imported page", () => {
    expect(entryNames(screenAt(entryRun().graph.screens, "/reports"))).toEqual(["src/pages/ReportsPage.tsx#default"])
  })

  it("enters a route with a locally declared component at that declaration", () => {
    const result = run({
      files: { ...files, "src/routes/_authed/orders.tsx": routeFile(`"/_authed/orders"`, "Orders") },
      adapters: [createTanStackRouterAdapter()],
    })
    expect(entryNames(screenAt(result.graph.screens, "/orders"))).toEqual(["src/routes/_authed/orders.tsx#Orders"])
  })

  it("enters at the lazy half's component when both halves name one (lazy options override)", () => {
    const result = run({
      files: {
        ...files,
        "src/routes/_authed/categories.tsx": layoutRouteFile("/_authed/categories", "CategoriesLayout"),
        "src/routes/_authed/categories.lazy.tsx": lazyRouteFile("/_authed/categories", "<table />"),
      },
      adapters: [createTanStackRouterAdapter()],
    })
    expect(entryNames(screenAt(result.graph.screens, "/categories"))).toEqual([
      "src/routes/_authed/categories.lazy.tsx#Page",
    ])
  })

  it("falls back to the route module, with no opaque-entry error, when the import does not resolve", () => {
    const result = entryRun()
    expect(entryNames(screenAt(result.graph.screens, "/vendor"))).toEqual(["src/routes/_authed/vendor.tsx#Route"])
    expect(codes(result)).not.toContain("screens/opaque-entry")
  })
})

// ---------------------------------------------------------------------------
// Dev-only file routes
// ---------------------------------------------------------------------------

describe("tanstack-router: dev-only file routes", () => {
  const guarded = (literal: string, condition: string): string =>
    [
      `import { createFileRoute, notFound } from "@tanstack/react-router"`,
      `export const Route = createFileRoute("${literal}")({`,
      `  beforeLoad: () => { if (${condition}) throw notFound() },`,
      `  component: Page,`,
      `})`,
      `function Page() { return <div><Outlet /></div> }`,
      "",
    ].join("\n")

  const files = {
    "package.json": PACKAGE_JSON,
    "src/routes/__root.tsx": ROOT_ROUTE,
    "src/routes/dev.tsx": guarded("/dev", "!import.meta.env.DEV"),
    "src/routes/dev/preview.tsx": routeFile(`"/dev/preview"`, "Preview"),
    "src/routes/staging.tsx": guarded("/staging", "process.env.NODE_ENV === 'production'"),
    "src/routes/feature.tsx": guarded("/feature", "!flags.feature"),
    "src/routes/sandbox.tsx": [
      `import { createFileRoute } from "@tanstack/react-router"`,
      `export const Route = import.meta.env.DEV ? createFileRoute("/sandbox")({ component: Sandbox }) : undefined`,
      `function Sandbox() { return <div /> }`,
      "",
    ].join("\n"),
    "src/routes/about.tsx": routeFile(`"/about"`, "About"),
  } as const

  const devRun = () => run({ files, adapters: [createTanStackRouterAdapter()] })

  it("marks a route whose beforeLoad throws in production builds devOnly", () => {
    const screens = devRun().graph.screens
    expect(screenAt(screens, "/dev")?.devOnly).toBe(true)
    expect(screenAt(screens, "/staging")?.devOnly).toBe(true)
    expect(evidenceOf(screenAt(screens, "/dev"))).toContain("dev-only: beforeLoad throws in a production build")
  })

  it("marks a route declared under a development-build condition devOnly", () => {
    expect(screenAt(devRun().graph.screens, "/sandbox")?.devOnly).toBe(true)
  })

  it("inherits devOnly from a gated parent route", () => {
    const preview = screenAt(devRun().graph.screens, "/dev/preview")
    expect(preview?.devOnly).toBe(true)
    expect(evidenceOf(preview)).toContain("dev-only: nested under the dev-only route 'src/routes/dev.tsx'")
  })

  it("leaves routes gated on something other than the build mode alone", () => {
    const screens = devRun().graph.screens
    expect(screenAt(screens, "/feature")?.devOnly).toBe(false)
    expect(screenAt(screens, "/about")?.devOnly).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Real-world shapes: escapes, literal segments, route groups, virtual routes
// ---------------------------------------------------------------------------

const AGREEMENT_CASES = [...tanstackEscapedFileRouteCases, ...tanstackLiteralSegmentCases]

describe("tanstack-router: the filename and the literal agree on escapes and literal segments", () => {
  for (const testCase of AGREEMENT_CASES) {
    it(`${testCase.description} (literal side, no stale-literal warning)`, () => {
      const result = analyze({ [testCase.file]: routeFile(`"${testCase.literal}"`) })

      expect(urlsOf(result.graph.screens)).toEqual([testCase.expected])
      expect(codes(result)).not.toContain("screens/stale-route-literal")
    })

    it(`${testCase.description} (filename side, literal unreadable)`, () => {
      const result = analyze({ "src/route-path.ts": UNREADABLE_PATH_MODULE, [testCase.file]: routeFile(null) })

      expect(urlsOf(result.graph.screens)).toEqual([testCase.expected])
    })
  }

  it("still warns when an escaped filename and its literal really disagree", () => {
    const result = analyze({ "src/routes/sitemap[.]xml.ts": routeFile(`"/sitemap.txt"`) })

    expect(urlsOf(result.graph.screens)).toEqual(["/sitemap.txt"])
    expect(codes(result)).toContain("screens/stale-route-literal")
  })

  it("nests a route under its escaped-segment parent and keeps the parent addressable", () => {
    const result = run({
      files: {
        "package.json": PACKAGE_JSON,
        "src/routes/__root.tsx": ROOT_ROUTE,
        "src/routes/team.[_].tsx": layoutRouteFile("/team/_", "TeamShell"),
        "src/routes/team.[_].$.tsx": indexChildFile("/team/_/$"),
      },
      adapters: [createTanStackRouterAdapter()],
    })
    const splat = screenAt(result.graph.screens, "/team/_/*")

    expect(screenAt(result.graph.screens, "/team/_")?.addressable).toBe(true)
    expect(splat?.ancestors.map((ancestor) => ancestor.file)).toEqual([
      "src/routes/__root.tsx",
      "src/routes/team.[_].tsx",
    ])
  })
})

describe("tanstack-router: an escaped `[_]foo` is not the pathless `_foo`", () => {
  const escapedNextToPathless = (escapedLiteral: string) =>
    run({
      files: {
        "package.json": PACKAGE_JSON,
        "src/routes/__root.tsx": ROOT_ROUTE,
        "src/routes/posts.[_]foo.tsx": layoutRouteFile(escapedLiteral, "EscapedShell"),
        "src/routes/posts.[_]foo.bar.tsx": indexChildFile(`${escapedLiteral}/bar`),
        "src/routes/posts/_foo/route.tsx": layoutRouteFile("/posts/_foo", "PathlessShell"),
        "src/routes/posts/_foo/x.tsx": indexChildFile("/posts/_foo/x"),
      },
      adapters: [createTanStackRouterAdapter()],
    })

  const ancestorFilesAt = (screens: readonly Screen[], url: string): readonly string[] =>
    (screenAt(screens, url)?.ancestors ?? []).map((ancestor) => ancestor.file)

  for (const literal of ["/posts/_foo", "/posts/[_]foo"])
    it(`addresses the escaped route at '/posts/_foo' and keeps the directory pathless (literal '${literal}')`, () => {
      const result = escapedNextToPathless(literal)
      const { screens } = result.graph
      const pathless = screenByLocalId(screens, "src/routes/posts/_foo/route.tsx")

      expect(screenAt(screens, "/posts/_foo")?.localId).toBe("src/routes/posts.[_]foo.tsx")
      expect(screenAt(screens, "/posts/_foo")?.addressable).toBe(true)
      expect(pathless?.url).toBeNull()
      expect(pathless?.kindTag).toBe("layout")
      expect(ancestorFilesAt(screens, "/posts/_foo/bar")).toEqual([
        "src/routes/__root.tsx",
        "src/routes/posts.[_]foo.tsx",
      ])
      expect(ancestorFilesAt(screens, "/posts/x")).toEqual([
        "src/routes/__root.tsx",
        "src/routes/posts/_foo/route.tsx",
      ])
      expect(codes(result)).not.toContain("screens/stale-route-literal")
    })

  for (const literal of ["/org/_", "/org/[_]"])
    it(`keeps a bare escaped '_' segment at '/org/_' (literal '${literal}')`, () => {
      const result = analyze({ "src/routes/org.[_].tsx": routeFile(`"${literal}"`) })

      expect(urlsOf(result.graph.screens)).toEqual(["/org/_"])
      expect(codes(result)).not.toContain("screens/stale-route-literal")
    })
})

const GROUP_FILES = {
  "package.json": PACKAGE_JSON,
  "src/routes/__root.tsx": ROOT_ROUTE,
  "src/routes/index.tsx": indexChildFile("/"),
  "src/routes/(console)/route.tsx": layoutRouteFile("/(console)", "ConsoleShell"),
  "src/routes/(console)/usage.tsx": indexChildFile("/(console)/usage"),
  "src/routes/(billing)/route.tsx": layoutRouteFile("/(billing)", "BillingShell"),
  "src/routes/(billing)/invoices.tsx": indexChildFile("/(billing)/invoices"),
} as const

describe("tanstack-router: a `(group)/route.tsx` is a pathless layout", () => {
  const groupRun = () => run({ files: GROUP_FILES, adapters: [createTanStackRouterAdapter()] })

  it("does not claim '/' a second and third time", () => {
    const result = groupRun()

    expect(codes(result)).not.toContain("screens/duplicate-id")
    expect(urlsOf(result.graph.screens).filter((url) => url === "/")).toEqual(["/"])
  })

  it("retains each group route as a non-addressable layout", () => {
    const layout = screenByLocalId(groupRun().graph.screens, "src/routes/(console)/route.tsx")

    expect(layout?.url).toBeNull()
    expect(layout?.kindTag).toBe("layout")
    expect(layout?.activations).toEqual([])
  })

  it("splices the group's children into the group layout", () => {
    const usage = screenAt(groupRun().graph.screens, "/usage")

    expect(usage?.ancestors.map((ancestor) => ancestor.file)).toEqual([
      "src/routes/__root.tsx",
      "src/routes/(console)/route.tsx",
    ])
  })
})

const APP_DECLARED_CREATE_ROUTE = {
  "src/lib/routing-store.ts": `export const createRoute = async (input: { path: string }) => input\n`,
  "src/routes/api/jobs/routes.ts": [
    `import { createFileRoute } from "@tanstack/react-router"`,
    `import { createRoute } from "../../../lib/routing-store"`,
    `const save = () => createRoute({ path: "nightly" })`,
    `export const Route = createFileRoute("/api/jobs/routes")({ component: () => null, loader: save })`,
    "",
  ].join("\n"),
  "src/components/route-form.tsx": [
    `import { useRouteMutations } from "./use-route-mutations"`,
    `export function RouteForm() {`,
    `  const { createRoute } = useRouteMutations()`,
    `  return <button onClick={() => createRoute({ path: "x" })} />`,
    `}`,
    "",
  ].join("\n"),
  "src/components/use-route-mutations.ts": `export const useRouteMutations = () => ({ createRoute: (input: { path: string }) => input })\n`,
  "src/server/openapi.ts": [
    `import { createRoute } from "@hono/zod-openapi"`,
    `export const listRoute = createRoute({ method: "get", path: "/items" })`,
    "",
  ].join("\n"),
} as const

describe("tanstack-router: a `createRoute` the app declares itself is not a TanStack factory", () => {
  it("reads no code route — and warns about none — from a project function, a hook result or another package", () => {
    const result = analyze(APP_DECLARED_CREATE_ROUTE)

    expect(codes(result)).not.toContain("screens/dynamic-registry")
    expect(urlsOf(result.graph.screens)).toEqual(["/api/jobs/routes"])
  })
})

const VIRTUAL_VITE_CONFIG = [
  `import { TanStackRouterVite } from "@tanstack/router-plugin/vite"`,
  `export default { plugins: [TanStackRouterVite({ virtualRouteConfig: "./src/routes.ts" })] }`,
  "",
].join("\n")

const VIRTUAL_FILES = {
  "vite.config.ts": VIRTUAL_VITE_CONFIG,
  "src/pages/account/layout.tsx": layoutRouteFile("/_signed-in/account/_shell", "AccountShell"),
  "src/pages/account/ProfilePage/route.tsx": indexChildFile("/_signed-in/account/_shell/profile"),
  "src/routes/misplaced.tsx": indexChildFile("/_signed-in/billing"),
} as const

describe("tanstack-router: virtual file routes (`virtualRouteConfig`)", () => {
  it("takes every path from the literal and never cross-checks it against the filename", () => {
    const result = analyze(VIRTUAL_FILES)

    expect(codes(result)).not.toContain("screens/stale-route-literal")
    expect(urlsOf(result.graph.screens).filter((url) => url !== null).sort()).toEqual([
      "/account/profile",
      "/billing",
    ])
  })

  it("keeps the literal's pathless layout and says why the filename was not consulted", () => {
    const screens = analyze(VIRTUAL_FILES).graph.screens
    const layout = screenByLocalId(screens, "src/pages/account/layout.tsx")

    expect(layout?.kindTag).toBe("layout")
    expect(evidenceOf(screenAt(screens, "/billing"))).toContain(
      "virtual file routes ('virtualRouteConfig') (vite.config.ts:2): the filename does not determine the path and is not cross-checked",
    )
  })

  it("skips a route whose literal is unreadable rather than inventing a URL from its filename", () => {
    const result = analyze({
      "vite.config.ts": VIRTUAL_VITE_CONFIG,
      "src/route-path.ts": UNREADABLE_PATH_MODULE,
      "src/pages/reports/route.tsx": routeFile(null),
    })
    const diagnostic = result.diagnostics.find((entry) => entry.code === "screens/dynamic-registry")

    expect(result.graph.screens).toEqual([])
    expect(diagnostic?.severity).toBe("warning")
    expect(diagnostic?.file).toBe("src/pages/reports/route.tsx")
  })
})

const APP_WRAPPER_FILES = {
  "src/root.tsx": [
    `import { Outlet, createRootRoute } from "@tanstack/react-router"`,
    `export const rootRoute = createRootRoute({ component: () => <main><Outlet /></main> })`,
    "",
  ].join("\n"),
  "src/lib/route.ts": [
    `import { createRoute as createTanStackRoute } from "@tanstack/react-router"`,
    `export const createRoute: typeof createTanStackRoute = (options) => createTanStackRoute({ ...options, pendingMs: 0 })`,
    "",
  ].join("\n"),
  "src/routes/lab/index.tsx": [
    `import { createRoute } from "../../lib/route"`,
    `import { rootRoute } from "../../root"`,
    `function TestsPage() { return <div>lab tests</div> }`,
    `export const labTestsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/lab-tests", component: TestsPage })`,
    "",
  ].join("\n"),
  "src/routes/enc/index.tsx": [
    `import { createRoute } from "@tanstack/react-router"`,
    `import { rootRoute } from "../../root"`,
    `function E2E() { return <div /> }`,
    `export const e2eRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/encryption", component: E2E })`,
    "",
  ].join("\n"),
  "src/router.tsx": [
    `import { createRouter } from "@tanstack/react-router"`,
    `import { rootRoute } from "./root"`,
    `import { labTestsRoute } from "./routes/lab"`,
    `import { e2eRoute } from "./routes/enc"`,
    `export const router = createRouter({ routeTree: rootRoute.addChildren([labTestsRoute, e2eRoute]) })`,
    "",
  ].join("\n"),
} as const

const wrapperWarnings = (result: ReturnType<typeof analyze>) =>
  result.diagnostics.filter((entry) => entry.code === "screens/dynamic-registry" && entry.message.includes("app wrapper"))

describe("tanstack-router: an app wrapper around a TanStack factory is named, never dropped silently", () => {
  it("warns at the call, naming the wrapper and the module that declares it", () => {
    const result = analyze(APP_WRAPPER_FILES)
    const [warning, ...rest] = wrapperWarnings(result)

    expect(rest).toEqual([])
    expect(warning?.severity).toBe("warning")
    expect(warning?.file).toBe("src/routes/lab/index.tsx")
    expect(warning?.line).toBe(4)
    expect(warning?.message).toContain("'createRoute' is an app wrapper declared in 'src/lib/route.ts' around TanStack createRoute")
    expect(urlsOf(result.graph.screens)).toEqual(["/settings/encryption"])
  })

  it("names a wrapper declared in the same file as the call", () => {
    const result = analyze({
      ...APP_WRAPPER_FILES,
      "src/routes/lab/index.tsx": [
        `import { createRoute as tanstackRoute } from "@tanstack/react-router"`,
        `import { rootRoute } from "../../root"`,
        `const createRoute = (options: Parameters<typeof tanstackRoute>[0]) => tanstackRoute(options)`,
        `export const labTestsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/lab-tests", component: () => null })`,
        "",
      ].join("\n"),
    })

    expect(wrapperWarnings(result).map((entry) => [entry.file, entry.line])).toEqual([["src/routes/lab/index.tsx", 4]])
  })

  it("stays silent about an app createRoute whose module imports TanStack but never calls a route factory", () => {
    const result = analyze({
      "src/routes/index.tsx": indexChildFile("/"),
      "src/lib/routing.ts": [
        `import { redirect } from "@tanstack/react-router"`,
        `export const createRoute = (pattern: string) => ({ pattern, go: () => redirect({ to: pattern }) })`,
        "",
      ].join("\n"),
      "src/lib/use-routing.ts": [
        `import { createRoute } from "./routing"`,
        `export const profile = createRoute("/profile/:id")`,
        "",
      ].join("\n"),
    })

    expect(codes(result)).not.toContain("screens/dynamic-registry")
  })
})

const VIRTUAL_DEPENDENCY_ONLY = {
  "package.json": JSON.stringify({
    dependencies: { "@tanstack/react-router": "1.100.0" },
    devDependencies: { "@tanstack/router-plugin": "1.100.0", "@tanstack/virtual-file-routes": "1.100.0" },
  }),
  "src/routes/__root.tsx": ROOT_ROUTE,
  "src/routes/_authed.tsx": layoutRouteFile("/_authed", "Shell"),
  "src/routes/_authed/dashboard.tsx": indexChildFile("/_authed/dashboard"),
  "src/routes/index.tsx": indexChildFile("/"),
} as const

const ancestorFilesOf = (screen: Screen | undefined): readonly string[] =>
  (screen?.ancestors ?? []).map((ancestor) => ancestor.file)

describe("tanstack-router: only a root `virtualRouteConfig` switches on virtual file routes", () => {
  it("keeps filename placement — and the layout chain — when only the dependency is present", () => {
    const screens = analyze(VIRTUAL_DEPENDENCY_ONLY).graph.screens

    expect(ancestorFilesOf(screenAt(screens, "/dashboard"))).toEqual(["src/routes/__root.tsx", "src/routes/_authed.tsx"])
    expect(evidenceOf(screenAt(screens, "/dashboard")).some((what) => what.startsWith("virtual file routes"))).toBe(false)
  })

  it("still cross-checks the literal against the filename when only the dependency is present", () => {
    const result = analyze({ ...VIRTUAL_DEPENDENCY_ONLY, "src/routes/settings.tsx": indexChildFile("/preferences") })

    expect(codes(result)).toContain("screens/stale-route-literal")
  })

  it("ignores a nested package's vite config that declares virtualRouteConfig", () => {
    const result = analyze({
      ...VIRTUAL_DEPENDENCY_ONLY,
      "packages/docs/vite.config.ts": VIRTUAL_VITE_CONFIG,
      "src/routes/settings.tsx": indexChildFile("/preferences"),
    })

    expect(codes(result)).toContain("screens/stale-route-literal")
    expect(ancestorFilesOf(screenAt(result.graph.screens, "/dashboard"))).toEqual([
      "src/routes/__root.tsx",
      "src/routes/_authed.tsx",
    ])
  })
})

const GENERATED_VIRTUAL_TREE = [
  "/* eslint-disable */",
  "// @ts-nocheck",
  "// This file was automatically generated by TanStack Router.",
  "// You should NOT make any changes in this file as it will be overwritten.",
  `import { createFileRoute } from '@tanstack/react-router'`,
  `import { Route as rootRoute } from './pages/root'`,
  `import { Route as authenticateImport } from './pages/middlewares/authenticate'`,
  `import { Route as settingsPageImport } from './pages/settings/route'`,
  `import { Route as billingPageImport } from './pages/billing/route'`,
  `const AuthenticateOrgImport = createFileRoute('/_authenticate/org')()`,
  `const authenticateRoute = authenticateImport.update({ id: '/_authenticate', getParentRoute: () => rootRoute } as any)`,
  `const AuthenticateOrgRoute = AuthenticateOrgImport.update({ id: '/org', path: '/org', getParentRoute: () => authenticateRoute } as any)`,
  `const settingsPageRoute = settingsPageImport.update({ id: '/', path: '/', getParentRoute: () => AuthenticateOrgRoute } as any)`,
  `const billingPageRoute = billingPageImport.update({ id: '/billing', path: '/billing', getParentRoute: () => rootRoute } as any)`,
  "",
].join("\n")

const GENERATED_VIRTUAL_FILES = {
  "vite.config.ts": VIRTUAL_VITE_CONFIG,
  "src/pages/root.tsx": ROOT_ROUTE,
  "src/pages/middlewares/authenticate.tsx": layoutRouteFile("/_authenticate", "AuthGate"),
  "src/pages/settings/route.tsx": indexChildFile("/_authenticate/org/"),
  "src/pages/billing/route.tsx": indexChildFile("/billing"),
  "src/routeTree.gen.ts": GENERATED_VIRTUAL_TREE,
} as const

const chainDiagnostics = (result: ReturnType<typeof analyze>) =>
  result.diagnostics.filter((entry) => entry.message.includes("layout chains are unknown"))

describe("tanstack-router: under virtual file routes the generated route tree supplies the layout chain", () => {
  it("chains each route through the generated tree's parents, skipping a file-less virtual route", () => {
    const screens = analyze(GENERATED_VIRTUAL_FILES).graph.screens

    expect(ancestorFilesOf(screenAt(screens, "/org"))).toEqual([
      "src/pages/root.tsx",
      "src/pages/middlewares/authenticate.tsx",
    ])
    expect(ancestorFilesOf(screenAt(screens, "/billing"))).toEqual(["src/pages/root.tsx"])
    expect(evidenceOf(screenAt(screens, "/org"))).toContain(
      "layout chain from the generated route tree 'src/routeTree.gen.ts'",
    )
  })

  it("reports nothing when every route is placed", () => {
    expect(chainDiagnostics(analyze(GENERATED_VIRTUAL_FILES))).toEqual([])
  })

  it("gives no chain to a route whose literal the generated tree contradicts, and says so once", () => {
    const result = analyze({
      ...GENERATED_VIRTUAL_FILES,
      "src/pages/billing/route.tsx": indexChildFile("/_authenticate/billing"),
    })
    const [diagnostic, ...rest] = chainDiagnostics(result)

    expect(rest).toEqual([])
    expect(diagnostic?.code).toBe("screens/dynamic-registry")
    expect(diagnostic?.message).toContain("1 route(s) carry no ancestors: 'src/pages/billing/route.tsx'")
    expect(screenAt(result.graph.screens, "/billing")?.ancestors).toEqual([])
    expect(ancestorFilesOf(screenAt(result.graph.screens, "/org"))).toHaveLength(2)
  })

  it("says once that the layout chains are unknown when there is no generated tree", () => {
    const result = analyze(
      Object.fromEntries(Object.entries(GENERATED_VIRTUAL_FILES).filter(([file]) => file !== "src/routeTree.gen.ts")),
    )
    const [diagnostic, ...rest] = chainDiagnostics(result)

    expect(rest).toEqual([])
    expect(diagnostic?.severity).toBe("warning")
    expect(diagnostic?.file).toBe("vite.config.ts")
    expect(diagnostic?.message).toContain("no generated route tree was found at 'src/routeTree.gen.ts'")
    expect(result.graph.screens.every((screen) => screen.ancestors.length === 0)).toBe(true)
  })

  it("reads the generated tree named by the config's generatedRouteTree", () => {
    const { "src/routeTree.gen.ts": tree, ...files } = GENERATED_VIRTUAL_FILES
    const screens = analyze({
      ...files,
      "tsr.config.json": JSON.stringify({ generatedRouteTree: "./src/gen/tree.gen.ts" }),
      "src/gen/tree.gen.ts": tree.replaceAll("'./pages/", "'../pages/"),
    }).graph.screens

    expect(ancestorFilesOf(screenAt(screens, "/billing"))).toEqual(["src/pages/root.tsx"])
  })
})

// ---------------------------------------------------------------------------
// A configured routes directory
// ---------------------------------------------------------------------------

const APP_ROUTE_URLS = ["/accounts/:accountUuid/edit", "/files/*", "/login", "/orders"] as const

const relocatedApp = (routesDir: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(APP_FILES).map(([file, text]) => [file.replace(/^src\/routes\//, `${routesDir}/`), text]),
  )

const viteConfig = (plugin: string, call: string, preamble = ""): string =>
  [`import { ${plugin} } from "@tanstack/react-start/plugin/vite"`, preamble, `export default { plugins: [${call}] }`, ""].join(
    "\n",
  )

const runApp = (files: Readonly<Record<string, string>>) => run({ files, adapters: [createTanStackRouterAdapter()] })

const routedUrls = (screens: readonly Screen[]): readonly (string | null)[] =>
  urlsOf(screens).filter((url) => url !== null).sort()

const chainOf = (screens: readonly Screen[], url: string): readonly string[] =>
  ancestorFilesOf(screenAt(screens, url))

const routesDirInfos = (result: ReturnType<typeof analyze>) =>
  result.diagnostics.filter((entry) => entry.code === "screens/dynamic-registry" && entry.severity === "info")

describe("tanstack-router: a configured routes directory", () => {
  it("reads tsr.config.json's routesDirectory: URLs, chains and no stale literal", () => {
    const result = runApp({
      ...relocatedApp("src/pages"),
      "tsr.config.json": JSON.stringify({ routesDirectory: "./src/pages" }),
    })
    const screens = result.graph.screens

    expect(routedUrls(screens)).toEqual(APP_ROUTE_URLS)
    expect(chainOf(screens, "/accounts/:accountUuid/edit")).toEqual(["src/pages/__root.tsx", "src/pages/_authed.tsx"])
    expect(chainOf(screens, "/login")).toEqual(["src/pages/__root.tsx"])
    expect(codes(result)).not.toContain("screens/stale-route-literal")
    expect(routesDirInfos(result)).toEqual([])
  })

  it("without the config, the same tree is unplaced and every literal looks stale", () => {
    const result = runApp(relocatedApp("src/pages"))

    expect(chainOf(result.graph.screens, "/login")).toEqual([])
    expect(codes(result)).toContain("screens/stale-route-literal")
  })

  it("reads tanstackStart's routesDirectory relative to its srcDirectory", () => {
    const result = runApp({
      ...relocatedApp("app/pages"),
      "vite.config.ts": viteConfig(
        "tanstackStart",
        `tanstackStart({ srcDirectory: 'app', router: { routesDirectory: 'pages' } })`,
      ),
    })
    const screens = result.graph.screens

    expect(routedUrls(screens)).toEqual(APP_ROUTE_URLS)
    expect(chainOf(screens, "/accounts/:accountUuid/edit")).toEqual(["app/pages/__root.tsx", "app/pages/_authed.tsx"])
    expect(codes(result)).not.toContain("screens/stale-route-literal")
    expect(routesDirInfos(result)).toEqual([])
  })

  it("defaults tanstackStart's routesDirectory to `routes` under srcDirectory", () => {
    const result = runApp({
      ...relocatedApp("app/routes"),
      "vite.config.ts": viteConfig("tanstackStart", `tanstackStart({ srcDirectory: 'app' })`),
    })

    expect(routedUrls(result.graph.screens)).toEqual(APP_ROUTE_URLS)
    expect(chainOf(result.graph.screens, "/login")).toEqual(["app/routes/__root.tsx"])
  })

  it("reads a literal routesDirectory in tanstackRouter relative to the root", () => {
    const result = runApp({
      ...relocatedApp("web/screens"),
      "vite.config.ts": viteConfig("tanstackRouter", `tanstackRouter({ routesDirectory: "./web/screens" })`),
    })

    expect(routedUrls(result.graph.screens)).toEqual(APP_ROUTE_URLS)
    expect(chainOf(result.graph.screens, "/login")).toEqual(["web/screens/__root.tsx"])
  })

  it("falls back to the default on a non-literal routesDirectory and names the config line", () => {
    const result = runApp({
      ...APP_FILES,
      "vite.config.ts": viteConfig(
        "tanstackRouter",
        `tanstackRouter({ routesDirectory: dir })`,
        `const dir = process.env.ROUTES ?? "./src/pages"`,
      ),
    })
    const [info, ...rest] = routesDirInfos(result)

    expect(rest).toEqual([])
    expect(info?.file).toBe("vite.config.ts")
    expect(info?.line).toBe(3)
    expect(info?.message).toContain("vite.config.ts:3")
    expect(info?.message).toContain("'routesDirectory' is not a string literal")
    expect(routedUrls(result.graph.screens)).toEqual(APP_ROUTE_URLS)
    expect(chainOf(result.graph.screens, "/login")).toEqual(["src/routes/__root.tsx"])
  })

  it("falls back to the default when two configs disagree", () => {
    const result = runApp({
      ...APP_FILES,
      "tsr.config.json": JSON.stringify({ routesDirectory: "./src/pages" }),
      "vite.config.ts": viteConfig("tanstackRouter", `tanstackRouter({ routesDirectory: "./src/app" })`),
    })
    const [info, ...rest] = routesDirInfos(result)

    expect(rest).toEqual([])
    expect(info?.message).toContain("'src/pages' (tsr.config.json:1), 'src/app' (vite.config.ts:3)")
    expect(chainOf(result.graph.screens, "/login")).toEqual(["src/routes/__root.tsx"])
  })

  it("lets virtualRouteConfig win over a routesDirectory and reports nothing about it", () => {
    const result = analyze({
      ...VIRTUAL_FILES,
      "tsr.config.json": JSON.stringify({ routesDirectory: "./src/pages" }),
    })

    expect(routesDirInfos(result)).toEqual([])
    expect(evidenceOf(result.graph.screens[0]).join("\n")).toContain("virtual file routes")
  })

  it("leaves a default project without any config unchanged", () => {
    const result = appRun()

    expect(routedUrls(result.graph.screens)).toEqual(APP_ROUTE_URLS)
    expect(chainOf(result.graph.screens, "/login")).toEqual(["src/routes/__root.tsx"])
    expect(codes(result)).not.toContain("screens/dynamic-registry")
  })
})

// ---------------------------------------------------------------------------
// beforeLoad guards (via loader-guards)
// ---------------------------------------------------------------------------

const guardedLayout = (path: string, beforeLoad: string, imports = ""): string =>
  [
    `import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"`,
    imports,
    `export const Route = createFileRoute("${path}")({`,
    `  beforeLoad: ${beforeLoad},`,
    `  component: Layout,`,
    `})`,
    `function Layout() { return <div><Outlet /></div> }`,
    "",
  ].join("\n")

const CONDITIONAL_GUARD = `({ context }) => { if (!context.auth.user) throw redirect({ to: "/login" }) }`

const guardRun = (files: Readonly<Record<string, string>>, options: TanStackRouterOptions = {}) =>
  run({
    files: {
      "package.json": PACKAGE_JSON,
      "src/routes/__root.tsx": ROOT_ROUTE,
      "src/routes/login.tsx": routeFile(`"/login"`, "Login"),
      "src/route-path.ts": UNREADABLE_PATH_MODULE,
      ...files,
    },
    adapters: [createTanStackRouterAdapter(options)],
  })

describe("tanstack-router: beforeLoad guards", () => {
  it("protects a layout with a conditional guard AND the routes below it", () => {
    const screens = guardRun({
      "src/routes/admin.tsx": guardedLayout("/admin", CONDITIONAL_GUARD),
      "src/routes/admin/users.tsx": routeFile(`"/admin/users"`, "Users"),
    }).graph.screens

    expect(screenAt(screens, "/admin")?.auth).toBe("protected")
    expect(screenAt(screens, "/admin/users")?.auth).toBe("protected")
    expect(screenAt(screens, "/login")?.auth).toBe("unknown")
    expect(evidenceOf(screenAt(screens, "/admin"))).toContain(
      "beforeLoad redirect to '/login' (conditional: !context.auth.user)",
    )
    expect(evidenceOf(screenAt(screens, "/admin/users"))).toContain(
      "protected by the beforeLoad guard of 'src/routes/admin.tsx': beforeLoad redirect to '/login' (conditional: !context.auth.user)",
    )
  })

  it("makes an unconditional redirect the route's redirectTo, not a guard", () => {
    const screens = guardRun({
      "src/routes/old.tsx": guardedLayout("/old", `() => { throw redirect({ to: "/x" }) }`),
      "src/routes/old/child.tsx": routeFile(`"/old/child"`, "Child"),
    }).graph.screens

    expect(screenAt(screens, "/old")?.redirectTo).toBe("/x")
    expect(screenAt(screens, "/old")?.auth).toBe("unknown")
    expect(screenAt(screens, "/old/child")?.auth).toBe("unknown")
    expect(screenAt(screens, "/old/child")?.redirectTo).toBeNull()
  })

  it("converts a redirect target's TanStack param syntax, with or without a params option", () => {
    const screens = guardRun({
      "src/routes/old.tsx": guardedLayout("/old", `() => { throw redirect({ to: "/sequences/$id/scenes", params: { id: "1" } }) }`),
      "src/routes/legacy.tsx": guardedLayout("/legacy", `() => { throw redirect({ to: "/files/{-$lang}/$" }) }`),
    }).graph.screens

    expect(screenAt(screens, "/old")?.redirectTo).toBe("/sequences/:id/scenes")
    expect(screenAt(screens, "/legacy")?.redirectTo).toBe("/files/:lang?/*")
  })

  it("keeps a relative redirect target as evidence only, never a redirectTo", () => {
    const screens = guardRun({
      "src/routes/old.tsx": guardedLayout("/old", `() => { throw redirect({ to: "./x" }) }`),
      "src/routes/up.tsx": guardedLayout("/up", `() => { throw redirect({ to: ".." }) }`),
    }).graph.screens

    expect(screenAt(screens, "/old")?.redirectTo).toBeNull()
    expect(screenAt(screens, "/up")?.redirectTo).toBeNull()
    expect(screenAt(screens, "/old")?.auth).toBe("unknown")
  })

  it("scopes guards by unauthenticatedTarget: a redirect elsewhere is evidence only", () => {
    const files = {
      "src/routes/admin.tsx": guardedLayout("/admin", CONDITIONAL_GUARD),
      "src/routes/admin/users.tsx": routeFile(`"/admin/users"`, "Users"),
    }
    const scopedOut = guardRun(files, { unauthenticatedTarget: "/signin" }).graph.screens
    const inScope = guardRun(files, { unauthenticatedTarget: "/login" }).graph.screens

    expect(screenAt(scopedOut, "/admin")?.auth).toBe("unknown")
    expect(screenAt(scopedOut, "/admin/users")?.auth).toBe("unknown")
    expect(evidenceOf(screenAt(scopedOut, "/admin"))).toContain(
      "beforeLoad redirect to '/login' (conditional: !context.auth.user); evidence only: not the unauthenticated target '/signin'",
    )
    expect(screenAt(inScope, "/admin/users")?.auth).toBe("protected")
  })

  it("follows a helper guard one hop, naming the helper", () => {
    const screens = guardRun({
      "src/lib/auth.ts": [
        `import { redirect } from "@tanstack/react-router"`,
        `export const requireAuth = (context: any) => { if (!context.auth.user) throw redirect({ to: "/login" }) }`,
        "",
      ].join("\n"),
      "src/routes/app.tsx": guardedLayout(
        "/app",
        `async ({ context }) => { await requireAuth(context) }`,
        `import { requireAuth } from "../lib/auth"`,
      ),
      "src/routes/app/home.tsx": routeFile(`"/app/home"`, "Home"),
    }).graph.screens

    expect(screenAt(screens, "/app")?.auth).toBe("protected")
    expect(screenAt(screens, "/app/home")?.auth).toBe("protected")
    expect(evidenceOf(screenAt(screens, "/app")).some((what) => what.endsWith("via requireAuth"))).toBe(true)
  })

  it("lets a guard win over a pathless `public` role, and says so", () => {
    const screens = guardRun(
      {
        "src/routes/_guest.tsx": guardedLayout("/_guest", CONDITIONAL_GUARD),
        "src/routes/_guest/welcome.tsx": routeFile(`"/_guest/welcome"`, "Welcome"),
      },
      { pathless: { _guest: { auth: "public" } } },
    ).graph.screens

    expect(screenAt(screens, "/welcome")?.auth).toBe("protected")
    expect(evidenceOf(screenAt(screens, "/welcome"))).toContain(
      "the beforeLoad guard wins over the pathless role's auth 'public'",
    )
  })
})
