import ts from "typescript"
import { describe, expect, it } from "vitest"
import { readFlatRoutes } from "../../src/adapters/flat-routes.js"
import type { FlatRoutesRequest, RouteNode } from "../../src/adapters/route-config.js"
import { discoverBench } from "./discover-harness.js"

const MODULE = "export default function Route() { return null }\n"

const filesOf = (paths: readonly string[]): Record<string, string> =>
  Object.fromEntries(paths.map((path) => [path, MODULE]))

const requestOf = (overrides: Partial<FlatRoutesRequest> = {}): FlatRoutesRequest => ({
  convention: "react-router",
  rootDirectory: "routes",
  appDirectory: "app",
  ignoredRouteFiles: [],
  options: null,
  declaredAt: { file: "app/routes.ts", line: 4 },
  ...overrides,
})

const outline = (nodes: readonly RouteNode[], depth = 0): readonly string[] =>
  nodes.flatMap((node) => [
    `${"  ".repeat(depth)}${node.id ?? ""} ${node.path ?? "-"}${node.index ? " (index)" : ""}`,
    ...outline(node.children, depth + 1),
  ])

const ROUTES_FILE = "app/routes.ts"

const read = (paths: readonly string[], overrides: Partial<FlatRoutesRequest> = {}, optionsSource?: string) => {
  const routesFile = optionsSource === undefined ? {} : { [ROUTES_FILE]: `flatRoutes(${optionsSource})\n` }
  const bench = discoverBench({ ...filesOf(paths), ...routesFile })
  const options = optionsSource === undefined ? null : bench.find(ROUTES_FILE, ts.isObjectLiteralExpression)
  const nodes = readFlatRoutes(bench.ctx)(requestOf({ options, ...overrides }))
  return { nodes, outline: outline(nodes), diagnostics: bench.diagnostics() }
}

describe("flat-routes: React Router / Remix v2 convention (trigger.dev-shaped)", () => {
  const files = [
    "app/routes/_app.tsx",
    "app/routes/_app.orgs.$organizationSlug.tsx",
    "app/routes/_app.orgs.$organizationSlug._index/route.tsx",
    "app/routes/_app.orgs.$organizationSlug._index/helpers.ts",
    "app/routes/[_].$.ts",
    "app/routes/concerts.tsx",
    "app/routes/concerts_.mine.tsx",
    "app/routes/_index.tsx",
    "app/routes/resources.x.ts",
    "app/routes/deep/nested/file.tsx",
    "app/routes/styles.css",
  ]

  it("builds the tree from dotted names, route folders, the pathless _app layout and nesting breaks", () => {
    expect(read(files).outline).toEqual([
      "[_].$ /_/*",
      "_app -",
      "  _app.orgs.$organizationSlug /orgs/:organizationSlug",
      "    _app.orgs.$organizationSlug._index /orgs/:organizationSlug (index)",
      "_index / (index)",
      "concerts /concerts",
      "concerts_.mine /concerts/mine",
      "resources.x /resources/x",
    ])
  })

  it("records the file, its own line and convention evidence, with no diagnostics", () => {
    const { nodes, diagnostics } = read(files)
    const app = nodes.find((node) => node.id === "_app")
    const index = app?.children[0]?.children[0]
    expect(index?.file).toBe("app/routes/_app.orgs.$organizationSlug._index/route.tsx")
    expect(index?.declaredAt).toEqual({ file: "app/routes/_app.orgs.$organizationSlug._index/route.tsx", line: 1 })
    expect(index?.evidence).toEqual(["flat route file app/routes/_app.orgs.$organizationSlug._index/route.tsx (react-router)"])
    expect(diagnostics).toEqual([])
  })

  it("lets route.tsx win over index.tsx in one folder and reports it", () => {
    const { outline: tree, diagnostics } = read(["app/routes/about/route.tsx", "app/routes/about/index.tsx"])
    expect(tree).toEqual(["about /about"])
    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: "info", code: "screens/unsupported-router-style", file: "app/routes/about/index.tsx" }),
    ])
  })

  it("skips files matched by an ignoredRouteFiles glob", () => {
    const { outline: tree } = read(["app/routes/about.tsx", "app/routes/about.test.tsx", "app/routes/.hidden.tsx"], {
      ignoredRouteFiles: ["**/*.test.tsx", "**/.*"],
    })
    expect(tree).toEqual(["about /about"])
  })

  it("reads .md routes only under remix-flat-routes", () => {
    expect(read(["app/routes/docs.mdx"]).outline).toEqual([])
    expect(read(["app/routes/docs.mdx"], { convention: "remix-flat-routes" }).outline).toEqual(["docs /docs"])
  })
})

describe("flat-routes: remix-flat-routes (documenso-shaped)", () => {
  const files = [
    "app/routes/_authenticated+/_layout.tsx",
    "app/routes/_authenticated+/settings+/_layout.tsx",
    "app/routes/_authenticated+/settings+/profile.tsx",
    "app/routes/_unauthenticated+/signin.tsx",
    "app/routes/_index.tsx",
    "app/routes/t.$teamUrl+/documents.$id._index.tsx",
    "app/routes/users/$userId/_route.tsx",
    "app/routes/users/$userId/components.tsx",
  ]

  it("flattens + folders, maps _layout to the folder's own route and reads hybrid folders", () => {
    expect(read(files, { convention: "remix-flat-routes" }).outline).toEqual([
      "_authenticated -",
      "  _authenticated.settings /settings",
      "    _authenticated.settings.profile /settings/profile",
      "_index / (index)",
      "_unauthenticated.signin /signin",
      "t.$teamUrl.documents.$id._index /t/:teamUrl/documents/:id (index)",
      "users.$userId /users/:userId",
    ])
  })

  it("drops a trailing _-segment of a dotted file in a + folder, making it the layout of the shorter id", () => {
    const tree = read(
      [
        "app/routes/_authenticated+/_layout.tsx",
        "app/routes/_authenticated+/o.$orgUrl.settings._layout.tsx",
        "app/routes/_authenticated+/o.$orgUrl.settings.billing.tsx",
        "app/routes/_authenticated+/o.$orgUrl.settings.groups._index.tsx",
      ],
      { convention: "remix-flat-routes" },
    ).outline
    expect(tree).toEqual([
      "_authenticated -",
      "  _authenticated.o.$orgUrl.settings /o/:orgUrl/settings",
      "    _authenticated.o.$orgUrl.settings.billing /o/:orgUrl/settings/billing",
      "    _authenticated.o.$orgUrl.settings.groups._index /o/:orgUrl/settings/groups (index)",
    ])
  })

  it("prefixes basePath onto every URL", () => {
    const { outline: tree } = read(["app/routes/_index.tsx", "app/routes/about.tsx"], {
      convention: "remix-flat-routes",
      basePath: "/docs",
    })
    expect(tree).toEqual(["_index /docs (index)", "about /docs/about"])
  })

  it("warns once and reads nothing when an unsupported option is set", () => {
    const { nodes, diagnostics } = read(
      files,
      { convention: "remix-flat-routes" },
      `{ paramPrefixChar: "^", nestedDirectoryChar: "+", routeRegex: /x/ }`,
    )
    expect(nodes).toEqual([])
    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "screens/unsupported-router-style",
        file: ROUTES_FILE,
        line: 4,
        message: expect.stringContaining("'paramPrefixChar', 'routeRegex'"),
      }),
    ])
  })
})

describe("flat-routes: diagnostics on mapped routes", () => {
  it("accepts options that repeat their defaults", () => {
    const { outline: tree, diagnostics } = read(
      ["app/routes/about.tsx"],
      { convention: "remix-flat-routes" },
      `{ paramPrefixChar: "$", nestedDirectoryChar: "+", appDir: "app" }`,
    )
    expect(tree).toEqual(["about /about"])
    expect(diagnostics).toEqual([])
  })

  it("maps an optional static segment without it and reports it", () => {
    const { outline: tree, diagnostics } = read(["app/routes/(en).about.tsx"])
    expect(tree).toEqual(["(en).about /about"])
    expect(diagnostics).toEqual([expect.objectContaining({ severity: "info", file: "app/routes/(en).about.tsx" })])
  })

  it("keeps the first leaf by id when two leaves share a URL", () => {
    const { outline: tree, diagnostics } = read(["app/routes/_a.login.tsx", "app/routes/_b.login.tsx"])
    expect(tree).toEqual(["_a.login /login"])
    expect(diagnostics).toEqual([expect.objectContaining({ severity: "info", file: "app/routes/_b.login.tsx" })])
  })
})
