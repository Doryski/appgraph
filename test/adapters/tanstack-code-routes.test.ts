import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import { resolveConfig } from "../../src/config/types.js"
import { createEnv, createProjectContext } from "../../src/pipeline/context.js"
import type { Screen } from "../../src/core/model.js"
import { createTanStackRouterAdapter, detectTanStackRouter } from "../../src/adapters/tanstack-router.js"
import { ROOT, codes, run } from "../pipeline/harness.js"
import { parentMismatchCases } from "../fixtures/route-dialects/tanstack-code-routes-corpus.js"

const PACKAGE_JSON = JSON.stringify({
  name: "@acme/code-routes",
  dependencies: { react: "19.0.0", "@tanstack/react-router": "1.100.0" },
})

const analyze = (files: Readonly<Record<string, string>>, options = {}) =>
  run({ files: { "package.json": PACKAGE_JSON, ...files }, adapters: [createTanStackRouterAdapter(options)] })

const screenAt = (screens: readonly Screen[], url: string | null): Screen | undefined =>
  screens.find((screen) => screen.url === url)

const urlSet = (screens: readonly Screen[]): readonly string[] =>
  [...new Set(screens.flatMap((screen) => (screen.url === null ? [] : [screen.url])))].sort()

const entryFiles = (screen: Screen | undefined): readonly string[] =>
  (screen?.entries ?? []).map((entry) => (entry.kind === "file" ? `${entry.file}#${entry.exportName}` : entry.expr))

const chainOf = (screen: Screen | undefined): readonly (readonly string[])[] =>
  (screen?.ancestors ?? []).map((ancestor) => [ancestor.file, ancestor.exportName, ancestor.role])

const evidenceOf = (screen: Screen | undefined): readonly string[] =>
  (screen?.provenance.evidence ?? []).map((entry) => entry.what)

const PATHS = [`export const paths = {`, `  dashboard: "/dashboard",`, `  settings: "settings",`, `} as const`, ""].join("\n")

const LAYOUTS = [
  `import { Outlet } from "@tanstack/react-router"`,
  `export function AppLayout() { return <div className="shell"><nav /><Outlet /></div> }`,
  `export function Plain() { return <div /> }`,
  "",
].join("\n")

const page = (name: string): string => `export function ${name}() { return <section /> }\n`

const ROUTER = [
  `import { Outlet, createRootRoute, createRoute, createRouter, lazyRouteComponent, redirect } from "@tanstack/react-router"`,
  `import { AppLayout } from "@/components/layouts"`,
  `import { paths } from "@/paths"`,
  `import { Dashboard } from "@/pages/Dashboard"`,
  ``,
  `const rootRoute = createRootRoute({ component: () => <main><Outlet /></main> })`,
  ``,
  `const appRoute = createRoute({ getParentRoute: () => rootRoute, id: "app", component: AppLayout })`,
  ``,
  `const indexRoute = createRoute({`,
  `  getParentRoute: () => appRoute,`,
  `  path: "/",`,
  `  beforeLoad: () => { throw redirect({ to: "/dashboard" }) },`,
  `})`,
  ``,
  `const dashboardRoute = createRoute({ getParentRoute: () => appRoute, path: paths.dashboard, component: Dashboard })`,
  ``,
  `const settingsRoute = createRoute({`,
  `  getParentRoute: () => appRoute,`,
  `  path: paths.settings,`,
  `  component: lazyRouteComponent(() => import("@/pages/Settings"), "Settings"),`,
  `})`,
  ``,
  `const galleryRoute = createRoute({ getParentRoute: () => appRoute, path: "/gallery", component: GalleryShell })`,
  `const galleryIndexRoute = createRoute({ getParentRoute: () => galleryRoute, path: "/", component: GalleryIndex })`,
  `const galleryViewRoute = createRoute({ getParentRoute: () => galleryRoute, path: "view/$photoId", component: GalleryIndex })`,
  ``,
  `const filesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/files/$", component: GalleryIndex })`,
  ``,
  `function GalleryShell() { return <div><Outlet /></div> }`,
  `function GalleryIndex() { return <ul /> }`,
  ``,
  `const routeTree = rootRoute.addChildren([`,
  `  appRoute.addChildren([indexRoute, dashboardRoute, settingsRoute, galleryRoute.addChildren([galleryIndexRoute, galleryViewRoute])]),`,
  `  filesRoute,`,
  `])`,
  ``,
  `export const router = createRouter({ routeTree })`,
  "",
].join("\n")

const APP = {
  "src/router.tsx": ROUTER,
  "src/paths.ts": PATHS,
  "src/components/layouts.tsx": LAYOUTS,
  "src/pages/Dashboard.tsx": page("Dashboard"),
  "src/pages/Settings.tsx": page("Settings"),
} as const

const appRun = () => analyze(APP)

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

describe("tanstack-router code routes: detect", () => {
  it("scores a code-based tree 90 — live, but below the file convention's 100", () => {
    const result = detectOn({ "package.json": PACKAGE_JSON, "src/router.tsx": ROUTER })

    expect(result.score).toBe(90)
    expect(result.evidence.map((entry) => entry.what)).toEqual([
      "@tanstack/react-router dependency",
      "createRootRoute call",
    ])
    expect(result.evidence[1]?.file).toBe("src/router.tsx")
  })

  it("matches createRootRouteWithContext<T>()(…) as written", () => {
    const result = detectOn({
      "package.json": PACKAGE_JSON,
      "src/router.tsx": `export const rootRoute = createRootRouteWithContext<{ user: string }>()({})\n`,
    })
    expect(result.score).toBe(90)
  })

  it("does not mistake createRouter( for createRoute(", () => {
    expect(
      detectOn({ "package.json": PACKAGE_JSON, "src/router.tsx": `export const router = createRouter({ routeTree })\n` })
        .score,
    ).toBe(0)
  })

  it("still scores 0 without the dependency", () => {
    expect(
      detectOn({ "package.json": JSON.stringify({ dependencies: { react: "19.0.0" } }), "src/router.tsx": ROUTER }).score,
    ).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The route tree
// ---------------------------------------------------------------------------

describe("tanstack-router code routes: paths from the getParentRoute chain", () => {
  it("builds every URL from its parent chain, folding imported path constants", () => {
    expect(urlSet(appRun().graph.screens)).toEqual([
      "/",
      "/dashboard",
      "/files/*",
      "/gallery",
      "/gallery/view/:photoId",
      "/settings",
    ])
  })

  it("nests a child path under its parent even when the literal starts with '/'", () => {
    expect(screenAt(appRun().graph.screens, "/gallery/view/:photoId")?.params).toEqual(["photoId"])
  })

  it("runs clean: no errors, no duplicate ids", () => {
    const result = appRun()
    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([])
    expect(codes(result)).not.toContain("screens/duplicate-id")
  })

  it("retains a pathless `id` layout as url-null, tagged and non-addressable", () => {
    const layout = appRun().graph.screens.find((screen) => screen.localId === "src/router.tsx#0")

    expect(layout?.url).toBeNull()
    expect(layout?.kindTag).toBe("layout")
    expect(layout?.addressable).toBe(false)
    expect(evidenceOf(layout)).toContain("tanstack code route createRoute({ id: 'app' }) (pathless layout)")
  })

  it("makes a path route with a '/' child its LAYOUT, and gives the URL to the index child", () => {
    const screens = appRun().graph.screens
    const gallery = screens.filter((screen) => screen.url === "/gallery")

    expect(gallery).toHaveLength(1)
    expect(entryFiles(gallery[0])).toEqual(["src/router.tsx#GalleryIndex"])
    const layout = screens.find((screen) => screen.localId === "src/router.tsx#4")
    expect(layout?.kindTag).toBe("layout")
    expect(layout?.url).toBeNull()
  })
})

describe("tanstack-router code routes: entries", () => {
  it("resolves an imported component, a lazyRouteComponent module and a local function", () => {
    const screens = appRun().graph.screens

    expect(entryFiles(screenAt(screens, "/dashboard"))).toEqual(["src/pages/Dashboard.tsx#Dashboard"])
    expect(entryFiles(screenAt(screens, "/settings"))).toEqual(["src/pages/Settings.tsx#Settings"])
    expect(entryFiles(screenAt(screens, "/files/*"))).toEqual(["src/router.tsx#GalleryIndex"])
  })

  it("gives a redirect-only route no entry and records the redirect", () => {
    const index = screenAt(appRun().graph.screens, "/")

    expect(index?.entries).toEqual([])
    expect(evidenceOf(index)).toContain("beforeLoad redirect to '/dashboard'")
    expect(evidenceOf(index)).toContain("no component: renders an implicit <Outlet/>")
  })

  it("addresses an inline component by locator", () => {
    const result = analyze({
      "src/router.tsx": [
        `import { Outlet, createRootRoute, createRoute } from "@tanstack/react-router"`,
        `const rootRoute = createRootRoute({ component: () => <Outlet /> })`,
        `const ideaRoute = createRoute({ getParentRoute: () => rootRoute, path: "/ideas/$slug", component: function Idea() { return <p /> } })`,
        `export const routeTree = rootRoute.addChildren([ideaRoute])`,
        "",
      ].join("\n"),
    })
    const idea = screenAt(result.graph.screens, "/ideas/:slug")
    const entry = idea?.entries[0]

    expect(entry?.kind).toBe("file")
    expect(entry?.kind === "file" ? entry.at?.export : null).toBe("ideaRoute")
    expect(codes(result)).not.toContain("screens/unresolvable-locator")
  })
})

describe("tanstack-router code routes: ancestor chains", () => {
  it("chains root → pathless layout → path layout, each spliced at its own component's <Outlet/>", () => {
    const view = screenAt(appRun().graph.screens, "/gallery/view/:photoId")

    expect(chainOf(view)).toEqual([
      ["src/router.tsx", "rootRoute", "layout"],
      ["src/components/layouts.tsx", "AppLayout", "layout"],
      ["src/router.tsx", "GalleryShell", "layout"],
    ])
    expect(view?.shell).toBe("src/router.tsx")
  })

  it("hands a route straight under the root only the root", () => {
    expect(chainOf(screenAt(appRun().graph.screens, "/files/*"))).toEqual([["src/router.tsx", "rootRoute", "layout"]])
  })

  it("emits no walk diagnostics for the chain", () => {
    expect(codes(appRun()).filter((code) => code.startsWith("walk/"))).toEqual([])
  })

  it("treats a layout route WITHOUT a component as transparent (implicit <Outlet/>)", () => {
    const result = analyze({
      "src/router.tsx": [
        `import { Outlet, createRootRoute, createRoute } from "@tanstack/react-router"`,
        `const rootRoute = createRootRoute({ component: () => <Outlet /> })`,
        `const authed = createRoute({ getParentRoute: () => rootRoute, id: "_authed", beforeLoad: () => {} })`,
        `const orders = createRoute({ getParentRoute: () => authed, path: "orders", component: Orders })`,
        `function Orders() { return <table /> }`,
        "",
      ].join("\n"),
    })
    const orders = screenAt(result.graph.screens, "/orders")

    expect(chainOf(orders)).toEqual([
      ["src/router.tsx", "rootRoute", "layout"],
      ["src/router.tsx", "authed", "transparent"],
    ])
    expect(codes(result)).not.toContain("walk/no-splice-point")
    expect(orders?.auth).toBe("protected")
  })
})

describe("tanstack-router code routes: routes spread across files", () => {
  const files = {
    "src/routes/root.tsx": [
      `import { Outlet, createRootRouteWithContext } from "@tanstack/react-router"`,
      `export const rootRoute = createRootRouteWithContext<{ user: string }>()({ component: Root })`,
      `function Root() { return <Outlet /> }`,
      "",
    ].join("\n"),
    "src/routes/admin.tsx": [
      `import { Outlet, createRoute } from "@tanstack/react-router"`,
      `import { rootRoute } from "./root"`,
      `export const adminRoute = createRoute({ getParentRoute: () => rootRoute, path: "admin", component: Admin })`,
      `function Admin() { return <aside><Outlet /></aside> }`,
      "",
    ].join("\n"),
    "src/routes/admin-users.tsx": [
      `import { createRoute } from "@tanstack/react-router"`,
      `import { adminRoute } from "./admin"`,
      `export const usersRoute = createRoute({ getParentRoute: () => adminRoute, path: "users/$userId" }).lazy(() =>`,
      `  import("./admin-users.lazy").then((module) => module.Route),`,
      `)`,
      "",
    ].join("\n"),
    "src/routes/admin-users.lazy.tsx": [
      `import { createLazyRoute } from "@tanstack/react-router"`,
      `export const Route = createLazyRoute("/admin/users/$userId")({ component: UserPage })`,
      `function UserPage() { return <form /> }`,
      "",
    ].join("\n"),
    "src/router.tsx": [
      `import { createRouter } from "@tanstack/react-router"`,
      `import { rootRoute } from "./routes/root"`,
      `import { adminRoute } from "./routes/admin"`,
      `import { usersRoute } from "./routes/admin-users"`,
      `export const router = createRouter({ routeTree: rootRoute.addChildren([adminRoute.addChildren([usersRoute])]) })`,
      "",
    ].join("\n"),
  } as const

  it("resolves an imported parent and builds the full URL across three files", () => {
    expect(urlSet(analyze(files).graph.screens)).toEqual(["/admin", "/admin/users/:userId"])
  })

  it("chains the imported ancestors, the curried root included", () => {
    expect(chainOf(screenAt(analyze(files).graph.screens, "/admin/users/:userId"))).toEqual([
      ["src/routes/root.tsx", "Root", "layout"],
      ["src/routes/admin.tsx", "Admin", "layout"],
    ])
  })

  it("takes the component of a `.lazy(() => import(…))` route from its createLazyRoute file", () => {
    const users = screenAt(analyze(files).graph.screens, "/admin/users/:userId")

    expect(entryFiles(users)).toEqual(["src/routes/admin-users.lazy.tsx#UserPage"])
    expect(evidenceOf(users)).toContain("lazy route module './admin-users.lazy'")
  })
})

describe("tanstack-router code routes: honesty about what it cannot read", () => {
  it("skips a route with an unreadable path — and its subtree — with a warning", () => {
    const result = analyze({
      "src/router.tsx": [
        `import { Outlet, createRootRoute, createRoute } from "@tanstack/react-router"`,
        `import { computePath } from "./compute"`,
        `const rootRoute = createRootRoute({ component: () => <Outlet /> })`,
        `const dynamicRoute = createRoute({ getParentRoute: () => rootRoute, path: computePath(), component: Page })`,
        `const childRoute = createRoute({ getParentRoute: () => dynamicRoute, path: "child", component: Page })`,
        `const okRoute = createRoute({ getParentRoute: () => rootRoute, path: "ok", component: Page })`,
        `function Page() { return <div /> }`,
        "",
      ].join("\n"),
      "src/compute.ts": `export const computePath = () => "x"\n`,
    })
    const warning = result.diagnostics.find((entry) => entry.code === "screens/dynamic-registry")

    expect(urlSet(result.graph.screens)).toEqual(["/ok"])
    expect(warning?.severity).toBe("warning")
    expect(warning?.message).toContain("dynamicRoute")
  })

  it("skips a route whose getParentRoute names nothing readable", () => {
    const result = analyze({
      "src/router.tsx": [
        `import { createRootRoute, createRoute } from "@tanstack/react-router"`,
        `const rootRoute = createRootRoute({})`,
        `const lost = createRoute({ getParentRoute: () => pickParent(), path: "lost" })`,
        "",
      ].join("\n"),
    })

    expect(result.graph.screens).toEqual([])
    expect(codes(result)).toContain("screens/dynamic-registry")
  })

  it("does not invent screens from a file-based app's __root.tsx", () => {
    const result = analyze({
      "src/routes/__root.tsx": [
        `import { Outlet, createRootRoute } from "@tanstack/react-router"`,
        `export const Route = createRootRoute({ component: () => <Outlet /> })`,
        "",
      ].join("\n"),
      "src/routes/about.tsx": [
        `import { createFileRoute } from "@tanstack/react-router"`,
        `export const Route = createFileRoute("/about")({ component: () => null })`,
        "",
      ].join("\n"),
    })

    expect(result.graph.screens.map((screen) => screen.url)).toEqual(["/about"])
  })
})

// ---------------------------------------------------------------------------
// Dev-only registration
// ---------------------------------------------------------------------------

const leafRoute = (name: string, path: string, parent = "rootRoute"): string =>
  `const ${name} = createRoute({ getParentRoute: () => ${parent}, path: "${path}", component: Page })`

const codeRouter = (...body: readonly string[]): string =>
  [
    `import { Outlet, createRootRoute, createRoute } from "@tanstack/react-router"`,
    `function Page() { return <div><Outlet /></div> }`,
    `const rootRoute = createRootRoute({ component: () => <main><Outlet /></main> })`,
    ...body,
    "",
  ].join("\n")

const devOnlyUrls = (screens: readonly Screen[]): readonly string[] =>
  screens.flatMap((screen) => (screen.devOnly && screen.url !== null ? [screen.url] : [])).sort()

describe("tanstack-router code routes: dev-only registration", () => {
  it("marks a route pushed onto the children array under `if (import.meta.env.DEV)` devOnly", () => {
    const result = analyze({
      "src/router.tsx": codeRouter(
        leafRoute("homeRoute", "/"),
        leafRoute("devPreviewRoute", "/dev/pdf-preview"),
        `const childRoutes = [homeRoute]`,
        `if (import.meta.env.DEV) {`,
        `  childRoutes.push(devPreviewRoute)`,
        `}`,
        `const routeTree = rootRoute.addChildren(childRoutes)`,
      ),
    })

    expect(devOnlyUrls(result.graph.screens)).toEqual(["/dev/pdf-preview"])
    expect(evidenceOf(screenAt(result.graph.screens, "/dev/pdf-preview"))).toContain(
      "dev-only: registered (addChildren) only under a development-build condition",
    )
  })

  it("reads a spread ternary, `&&`, NODE_ENV comparisons and __DEV__", () => {
    const result = analyze({
      "src/router.tsx": codeRouter(
        leafRoute("homeRoute", "/"),
        leafRoute("aRoute", "/a"),
        leafRoute("bRoute", "/b"),
        leafRoute("cRoute", "/c"),
        leafRoute("dRoute", "/d"),
        leafRoute("prodRoute", "/prod"),
        `const routeTree = rootRoute.addChildren([`,
        `  homeRoute,`,
        `  ...(import.meta.env.DEV ? [aRoute] : []),`,
        `  ...(process.env.NODE_ENV !== "production" ? [bRoute] : []),`,
        `  ...(process.env.NODE_ENV === "production" ? [prodRoute] : [cRoute]),`,
        `  ...((__DEV__ && [dRoute]) || []),`,
        `])`,
      ),
    })

    expect(devOnlyUrls(result.graph.screens)).toEqual(["/a", "/b", "/c", "/d"])
  })

  it("follows a dev-gated spread of a named array and inherits devOnly down the tree", () => {
    const result = analyze({
      "src/router.tsx": codeRouter(
        leafRoute("homeRoute", "/"),
        leafRoute("toolsRoute", "/tools"),
        leafRoute("toolsChildRoute", "inspect", "toolsRoute"),
        `const devRoutes = [toolsRoute.addChildren([toolsChildRoute])]`,
        `const routeTree = rootRoute.addChildren([homeRoute, ...(import.meta.env.DEV ? devRoutes : [])])`,
      ),
    })

    expect(devOnlyUrls(result.graph.screens)).toEqual(["/tools", "/tools/inspect"])
    expect(evidenceOf(screenAt(result.graph.screens, "/tools/inspect"))).toContain(
      "dev-only: nested under the dev-only route 'toolsRoute'",
    )
  })

  it("does not mark a route registered both inside and outside a dev condition", () => {
    const result = analyze({
      "src/router.tsx": codeRouter(
        leafRoute("homeRoute", "/"),
        `const routeTree = rootRoute.addChildren([homeRoute, ...(import.meta.env.PROD ? [] : [homeRoute])])`,
      ),
    })

    expect(devOnlyUrls(result.graph.screens)).toEqual([])
  })

  it("marks a route whose own declaration is dev-gated", () => {
    const result = analyze({
      "src/router.tsx": codeRouter(
        leafRoute("homeRoute", "/"),
        `const debugRoute = import.meta.env.DEV ? createRoute({ getParentRoute: () => rootRoute, path: "/debug", component: Page }) : null`,
        `const routeTree = rootRoute.addChildren([homeRoute])`,
      ),
    })

    expect(devOnlyUrls(result.graph.screens)).toEqual(["/debug"])
  })
})

// ---------------------------------------------------------------------------
// addChildren as a parent source
// ---------------------------------------------------------------------------

describe("tanstack-router code routes: addChildren as a parent source", () => {
  it("places a route without getParentRoute under the single parent that registers it", () => {
    const result = analyze({
      "src/router.tsx": codeRouter(
        leafRoute("adminRoute", "/admin"),
        `const usersRoute = createRoute({ path: "users", component: Page })`,
        `const routeTree = rootRoute.addChildren([adminRoute.addChildren([usersRoute])])`,
      ),
    })

    const users = screenAt(result.graph.screens, "/admin/users")
    expect(users).toBeDefined()
    expect(evidenceOf(users)).toContain("parent 'adminRoute' from addChildren (getParentRoute is missing or unreadable)")
    expect(codes(result)).not.toContain("screens/dynamic-registry")
  })

  it("reads an object-form addChildren and a children array imported from another module", () => {
    const result = analyze({
      "src/admin.tsx": [
        `import { createRoute } from "@tanstack/react-router"`,
        `import { adminRoute } from "./router"`,
        `function Page() { return <div /> }`,
        `const auditRoute = createRoute({ path: "audit", component: Page })`,
        `export const adminChildren = [auditRoute]`,
        "",
      ].join("\n"),
      "src/router.tsx": [
        codeRouter(`export const adminRoute = createRoute({ getParentRoute: () => rootRoute, path: "/admin", component: Page })`),
        `import { adminChildren } from "./admin"`,
        `const routeTree = rootRoute.addChildren({ adminRoute: adminRoute.addChildren(adminChildren) })`,
        "",
      ].join("\n"),
    })

    expect(screenAt(result.graph.screens, "/admin/audit")).toBeDefined()
  })

  it("keeps getParentRoute authoritative and warns when addChildren registers the route elsewhere", () => {
    const result = analyze({
      "src/router.tsx": codeRouter(
        leafRoute("aRoute", "/a"),
        leafRoute("bRoute", "/b"),
        leafRoute("childRoute", "child", "aRoute"),
        `const routeTree = rootRoute.addChildren([aRoute, bRoute.addChildren([childRoute])])`,
      ),
    })

    expect(screenAt(result.graph.screens, "/a/child")).toBeDefined()
    const mismatch = result.diagnostics.find((entry) => entry.code === "screens/route-parent-mismatch")
    expect(mismatch?.severity).toBe("warning")
    expect(mismatch?.message).toBe(
      "TanStack code route 'childRoute': getParentRoute names 'aRoute' but addChildren registers it under 'bRoute'; getParentRoute wins",
    )
  })

  it("still skips a route registered under several parents with no getParentRoute", () => {
    const result = analyze({
      "src/router.tsx": codeRouter(
        leafRoute("aRoute", "/a"),
        leafRoute("bRoute", "/b"),
        `const childRoute = createRoute({ path: "child", component: Page })`,
        `const routeTree = rootRoute.addChildren([aRoute.addChildren([childRoute]), bRoute.addChildren([childRoute])])`,
      ),
    })

    expect(urlSet(result.graph.screens)).toEqual(["/a", "/b"])
    expect(codes(result)).toContain("screens/dynamic-registry")
  })
})

describe("tanstack-router code routes: getParentRoute vs addChildren at runtime", () => {
  it.each(parentMismatchCases)("$description", ({ body, url, warns }) => {
    const result = analyze({ "src/router.tsx": codeRouter(...body) })

    expect(screenAt(result.graph.screens, url)).toBeDefined()
    expect(codes(result).includes("screens/route-parent-mismatch")).toBe(warns)
  })

  it("records a harmless registration as evidence on the screen instead", () => {
    const [nestedTab] = parentMismatchCases
    const result = analyze({ "src/router.tsx": codeRouter(...(nestedTab?.body ?? [])) })

    expect(evidenceOf(screenAt(result.graph.screens, "/shop/:itemId/reviews"))).toContain(
      "addChildren also registers it under 'itemRoute', whose URL covers its own; getParentRoute decides its URL and nesting",
    )
  })
})

describe("tanstack-router code routes: test and mock files", () => {
  it("ignores a test harness router under a non-app directory, so it cannot claim the app's URLs", () => {
    const harness = codeRouter(
      `const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Page })`,
      `const routeTree = rootRoute.addChildren([indexRoute])`,
    )
    const result = analyze({
      "src/router.tsx": harness,
      "src/test/renderWithRouter.tsx": harness,
      "src/__mocks__/router.tsx": harness,
      "cypress/support/component/setup.tsx": harness,
    })

    expect(result.graph.screens.filter((screen) => screen.url === "/")).toHaveLength(1)
    expect(codes(result)).not.toContain("screens/duplicate-id")
  })

  const appRouteIn = (name: string, path: string): string =>
    [
      `import { createRoute } from "@tanstack/react-router"`,
      `import { rootRoute } from "../../root"`,
      `function ${name}Page() { return <section /> }`,
      `export const ${name}Route = createRoute({ getParentRoute: () => rootRoute, path: "${path}", component: ${name}Page })`,
      "",
    ].join("\n")

  const APP_ROOT = [
    `import { Outlet, createRootRoute } from "@tanstack/react-router"`,
    `export const rootRoute = createRootRoute({ component: () => <main><Outlet /></main> })`,
    "",
  ].join("\n")

  const APP_ROUTER = [
    `import { createRoute, createRouter } from "@tanstack/react-router"`,
    `import { rootRoute } from "./root"`,
    `import { labTestsRoute } from "./routes/tests"`,
    `import { encryptionRoute } from "./routes/e2e"`,
    `function Home() { return <section /> }`,
    `const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home })`,
    `const routeTree = rootRoute.addChildren([homeRoute, labTestsRoute, encryptionRoute])`,
    `export const router = createRouter({ routeTree })`,
    "",
  ].join("\n")

  const appWithTestNamedFolders = {
    "src/root.tsx": APP_ROOT,
    "src/router.tsx": APP_ROUTER,
    "src/routes/tests/index.tsx": appRouteIn("labTests", "/lab-tests"),
    "src/routes/e2e/index.tsx": appRouteIn("encryption", "/settings/encryption"),
  }

  it("keeps app routes under src/routes/tests/ and src/routes/e2e/ that the app's addChildren mounts", () => {
    const result = analyze(appWithTestNamedFolders)

    expect(result.graph.screens).toHaveLength(3)
    expect(urlSet(result.graph.screens)).toEqual(["/", "/lab-tests", "/settings/encryption"])
  })

  it("still excludes a root cypress/ harness router next to an app with test-named route folders", () => {
    const harness = codeRouter(
      `const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Page })`,
      `const harnessRoute = createRoute({ getParentRoute: () => rootRoute, path: "/harness-only", component: Page })`,
      `const routeTree = rootRoute.addChildren([indexRoute, harnessRoute])`,
    )
    const result = analyze({ ...appWithTestNamedFolders, "cypress/support/component/setup.tsx": harness })

    expect(result.graph.screens).toHaveLength(3)
    expect(urlSet(result.graph.screens)).toEqual(["/", "/lab-tests", "/settings/encryption"])
    expect(codes(result)).not.toContain("screens/duplicate-id")
  })

  it("does not let a non-app file mount its own route into the app's root", () => {
    const result = analyze({
      ...appWithTestNamedFolders,
      "src/test/extraRoutes.tsx": [
        `import { createRoute } from "@tanstack/react-router"`,
        `import { rootRoute } from "../root"`,
        `function Fake() { return <section /> }`,
        `const fakeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/fake", component: Fake })`,
        `rootRoute.addChildren([fakeRoute])`,
        "",
      ].join("\n"),
    })

    expect(urlSet(result.graph.screens)).toEqual(["/", "/lab-tests", "/settings/encryption"])
  })

  const unmountedRouteFile = [
    `import { createRoute } from "@tanstack/react-router"`,
    `import { rootRoute } from "../root"`,
    `function Fake() { return <section /> }`,
    `export const fakeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/fake", component: Fake })`,
    "",
  ].join("\n")

  it("reports a non-app route that no app addChildren mounts as one info diagnostic", () => {
    const result = analyze({ ...appWithTestNamedFolders, "src/__mocks__/fake.tsx": unmountedRouteFile })
    const found = result.diagnostics.filter((diagnostic) => diagnostic.code === "screens/unmounted-route")

    expect(found).toHaveLength(1)
    expect(found[0]?.severity).toBe("info")
    expect(found[0]?.file).toBe("src/__mocks__/fake.tsx")
    expect(urlSet(result.graph.screens)).toEqual(["/", "/lab-tests", "/settings/encryption"])
  })

  it("does not report a non-app route that an app addChildren mounts", () => {
    const result = analyze({
      ...appWithTestNamedFolders,
      "src/router.tsx": APP_ROUTER.replace("encryptionRoute])", "encryptionRoute, fakeRoute])").replace(
        `import { rootRoute }`,
        `import { fakeRoute } from "./__mocks__/fake"\nimport { rootRoute }`,
      ),
      "src/__mocks__/fake.tsx": unmountedRouteFile,
    })

    expect(codes(result)).not.toContain("screens/unmounted-route")
    expect(urlSet(result.graph.screens)).toContain("/fake")
  })

  it("stays silent for a harness whose whole tree is rooted in a non-app file", () => {
    const harness = codeRouter(
      `const harnessRoute = createRoute({ getParentRoute: () => rootRoute, path: "/harness-only", component: Page })`,
      `const routeTree = rootRoute.addChildren([harnessRoute])`,
    )
    const result = analyze({ ...appWithTestNamedFolders, "cypress/support/component/setup.tsx": harness })

    expect(codes(result)).not.toContain("screens/unmounted-route")
  })
})

// ---------------------------------------------------------------------------
// beforeLoad guards (via loader-guards)
// ---------------------------------------------------------------------------

const guardedRouter = (beforeLoad: string, ...extra: readonly string[]): string =>
  codeRouter(
    ...extra,
    `const appRoute = createRoute({ getParentRoute: () => rootRoute, path: "app", component: Page, beforeLoad: ${beforeLoad} })`,
    leafRoute("homeRoute", "home", "appRoute"),
    leafRoute("loginRoute", "login"),
    `export const routeTree = rootRoute.addChildren([appRoute.addChildren([homeRoute]), loginRoute])`,
  )

describe("tanstack-router code routes: beforeLoad guards", () => {
  const CONDITIONAL = `({ context }) => { if (!context.auth.user) throw redirect({ to: "/login" }) }`
  const withRedirect = (source: string): string => source.replace("createRoute }", "createRoute, redirect }")

  it("protects a route with a conditional guard AND the routes below it", () => {
    const screens = analyze({ "src/router.tsx": withRedirect(guardedRouter(CONDITIONAL)) }).graph.screens

    expect(screenAt(screens, "/app")?.auth).toBe("protected")
    expect(screenAt(screens, "/app/home")?.auth).toBe("protected")
    expect(screenAt(screens, "/login")?.auth).toBe("unknown")
    expect(evidenceOf(screenAt(screens, "/app/home"))).toContain(
      "protected by the beforeLoad guard of 'appRoute': beforeLoad redirect to '/login' (conditional: !context.auth.user)",
    )
  })

  it("makes an unconditional redirect the route's redirectTo, not a guard", () => {
    const screens = analyze({
      "src/router.tsx": withRedirect(guardedRouter(`() => { throw redirect({ to: "/x" }) }`)),
    }).graph.screens

    expect(screenAt(screens, "/app")?.redirectTo).toBe("/x")
    expect(screenAt(screens, "/app")?.auth).toBe("unknown")
    expect(screenAt(screens, "/app/home")?.auth).toBe("unknown")
  })

  it("converts a redirect target's TanStack param syntax", () => {
    const screens = analyze({
      "src/router.tsx": withRedirect(guardedRouter(`() => { throw redirect({ to: "/sequences/$id/scenes" }) }`)),
    }).graph.screens

    expect(screenAt(screens, "/app")?.redirectTo).toBe("/sequences/:id/scenes")
  })

  it("keeps a relative redirect target out of redirectTo", () => {
    const screens = analyze({
      "src/router.tsx": withRedirect(guardedRouter(`() => { throw redirect({ to: "../x" }) }`)),
    }).graph.screens

    expect(screenAt(screens, "/app")?.redirectTo).toBeNull()
  })

  it("scopes guards by unauthenticatedTarget", () => {
    const files = { "src/router.tsx": withRedirect(guardedRouter(CONDITIONAL)) }

    expect(screenAt(analyze(files, { unauthenticatedTarget: "/signin" }).graph.screens, "/app/home")?.auth).toBe("unknown")
    expect(screenAt(analyze(files, { unauthenticatedTarget: "/login" }).graph.screens, "/app/home")?.auth).toBe("protected")
  })

  it("follows a helper guard one hop", () => {
    const screens = analyze({
      "src/router.tsx": withRedirect(
        guardedRouter(
          `async ({ context }) => { await requireAuth(context) }`,
          `const requireAuth = (context: any) => { if (!context.auth.user) throw redirect({ to: "/login" }) }`,
        ),
      ),
    }).graph.screens

    expect(screenAt(screens, "/app/home")?.auth).toBe("protected")
    expect(evidenceOf(screenAt(screens, "/app")).some((what) => what.endsWith("via requireAuth"))).toBe(true)
  })
})
