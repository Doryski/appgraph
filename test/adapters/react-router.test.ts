import { readdirSync, readFileSync } from "node:fs"
import { posix } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import { resolveConfig } from "../../src/config/types.js"
import { createEnv, createProjectContext } from "../../src/pipeline/context.js"
import type { Screen, TreeNode } from "../../src/core/model.js"
import {
  DEFAULT_WRAPPER_RULES,
  ROUTER_FACTORIES,
  createReactRouterAdapter,
  detectReactRouter,
} from "../../src/adapters/react-router.js"
import { PACKAGE_JSON, ROOT, codes, run } from "../pipeline/harness.js"

const adapter = () => createReactRouterAdapter()

const analyze = (files: Readonly<Record<string, string>>, stringSources?: readonly string[]) =>
  run({
    files,
    adapters: [adapter()],
    ...(stringSources === undefined ? {} : { config: { stringSources } }),
  })

const urlsOf = (screens: readonly Screen[]): readonly (string | null)[] =>
  screens.map((screen) => screen.url)

const screenAt = (screens: readonly Screen[], url: string | null): Screen | undefined =>
  screens.find((screen) => screen.url === url)

const entryFilesOf = (screen: Screen | undefined): readonly string[] =>
  (screen?.entries ?? []).flatMap((entry) => (entry.kind === "file" ? [entry.file] : []))

// ---------------------------------------------------------------------------
// The router-forms corpus: wrapping forms at both discovery sites
// ---------------------------------------------------------------------------

const CORPUS = new URL("../fixtures/router-forms/", import.meta.url)

const SITES = ["argument", "children"] as const

const FORMS = ["01", "02", "03", "04", "05", "06", "07", "08"] as const

type Site = (typeof SITES)[number]

const PLAIN_FORM = "01"

const fixtureFiles = (site: Site, form: string): Record<string, string> => {
  const dir = new URL(`${site}/`, CORPUS)
  const names = readdirSync(dir).filter((name) => name.startsWith(form))
  return Object.fromEntries(
    names.map((name) => [`src/routes/${name}`, readFileSync(new URL(name, dir), "utf8")]),
  )
}

const routerTextOf = (files: Readonly<Record<string, string>>): string => {
  const entry = Object.entries(files).find(([, text]) => text.includes("createBrowserRouter("))
  return entry?.[1] ?? ""
}

/** The exact node a raw type test inspects: `createBrowserRouter(<here>)`. */
const argumentNodeOf = (text: string): ts.Node | null => {
  const source = ts.createSourceFile("fixture.tsx", text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  let found: ts.Node | null = null
  const visit = (node: ts.Node): void => {
    if (
      found === null &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "createBrowserRouter"
    ) {
      found = node.arguments[0] ?? null
    }
    node.forEachChild(visit)
  }
  visit(source)
  return found
}

/** The other raw type-test site: `children: <here>`. */
const childrenNodeOf = (text: string): ts.Node | null => {
  const source = ts.createSourceFile("fixture.tsx", text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  let found: ts.Node | null = null
  const visit = (node: ts.Node): void => {
    if (
      found === null &&
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "children"
    ) {
      found = node.initializer
    }
    node.forEachChild(visit)
  }
  visit(source)
  return found
}

const nodeUnderTest = (site: Site, files: Readonly<Record<string, string>>): ts.Node | null =>
  site === "argument" ? argumentNodeOf(routerTextOf(files)) : childrenNodeOf(routerTextOf(files))

describe("react-router: the router-forms corpus, 8 wrapping forms x 2 discovery sites", () => {
  const leavesOf = (site: Site, form: string): readonly (string | null)[] => {
    const result = analyze(fixtureFiles(site, form))
    expect(codes(result)).not.toContain("plugin/threw")
    expect(codes(result)).not.toContain("screens/dynamic-registry")
    return urlsOf(result.graph.screens.filter((screen) => screen.kindTag !== "layout"))
  }

  for (const site of SITES)
    for (const form of FORMS)
      it(`${site}/${form}: discovers /home and /about`, () => {
        expect(leavesOf(site, form)).toEqual(["/about", "/home"])
      })

  for (const site of SITES)
    it(`${site}: every wrapping form produces the same screen set as ${PLAIN_FORM}-plain-array`, () => {
      const baseline = urlsOf(analyze(fixtureFiles(site, PLAIN_FORM)).graph.screens)
      for (const form of FORMS)
        expect(urlsOf(analyze(fixtureFiles(site, form)).graph.screens), form).toEqual(baseline)
    })

  it("both discovery sites agree on the leaf screens", () => {
    for (const form of FORMS) expect(leavesOf("children", form), form).toEqual(leavesOf("argument", form))
  })

  it("the plain array is the only form a RAW ts.isArrayLiteralExpression accepts", () => {
    for (const site of SITES) {
      const node = nodeUnderTest(site, fixtureFiles(site, PLAIN_FORM))
      expect(node, site).not.toBeNull()
      expect(ts.isArrayLiteralExpression(node as ts.Node), site).toBe(true)
    }
  })

  // On every non-plain form a raw predicate returns false, so a discovery site that skipped `unwrap` would yield zero screens here.
  for (const site of SITES)
    for (const form of FORMS.filter((candidate) => candidate !== PLAIN_FORM))
      it(`${site}/${form}: a raw ts.isArrayLiteralExpression is false, yet discovery still works`, () => {
        const files = fixtureFiles(site, form)
        const node = nodeUnderTest(site, files)

        expect(node).not.toBeNull()
        expect(ts.isArrayLiteralExpression(node as ts.Node)).toBe(false)
        expect(leavesOf(site, form)).toEqual(["/about", "/home"])
      })
})

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const detectOn = (files: Readonly<Record<string, string>>) => {
  const host = createMemoryHost({
    files: Object.fromEntries(Object.entries(files).map(([file, text]) => [`${ROOT}/${file}`, text])),
  })
  const env = createEnv({ ts, config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }), host })
  return detectReactRouter(createProjectContext(env))
}

const DEPS = { "package.json": PACKAGE_JSON }

const JSX_ROUTER = `
import { Routes, Route } from "react-router-dom"
export const App = () => (
  <Routes>
    <Route path="/home" element={<div />} />
  </Routes>
)
`

describe("react-router: detect", () => {
  for (const factory of ROUTER_FACTORIES)
    it(`scores 90 for a literal ${factory} call plus the dependency`, () => {
      const result = detectOn({
        ...DEPS,
        "src/routes/router.tsx": `export const router = ${factory}([{ path: "/" }])\n`,
      })

      expect(result.score).toBe(90)
      expect(result.evidence.map((entry) => entry.what)).toEqual([
        "react-router-dom dependency",
        `${factory} call`,
      ])
      expect(result.evidence[1]?.file).toBe("src/routes/router.tsx")
      expect(result.evidence[1]?.line).toBe(1)
    })

  it("scores 0 without the dependency, even with a literal createBrowserRouter call", () => {
    const result = detectOn({
      "package.json": JSON.stringify({ dependencies: { react: "19.0.0" } }),
      "src/routes/router.tsx": `export const router = createBrowserRouter([{ path: "/" }])\n`,
    })
    expect(result.score).toBe(0)
    expect(result.evidence).toEqual([])
  })

  it("scores 0 with the dependency but no router at all", () => {
    expect(detectOn({ ...DEPS, "src/app.tsx": "export const App = () => <div />\n" }).score).toBe(0)
  })

  it("scores 80 for the JSX <Routes>/<Route> form and points at the element", () => {
    const result = detectOn({ ...DEPS, "src/app.tsx": JSX_ROUTER })

    expect(result.score).toBe(80)
    expect(result.evidence.map((entry) => entry.what)).toEqual([
      "react-router-dom dependency",
      "JSX <Routes>/<Route> element",
    ])
    expect(result.evidence[1]?.file).toBe("src/app.tsx")
  })

  it("drops to a near miss on a framework-mode project, whose routes react-router-framework reads", () => {
    const result = detectOn({
      "package.json": JSON.stringify({ dependencies: { "react-router": "7.0.0", "@react-router/dev": "7.0.0" } }),
      "app/routes.ts": `import { index } from "@react-router/dev/routes"\nexport default [index("./home.tsx")]\n`,
      "src/app.tsx": JSX_ROUTER,
    })

    expect(result.score).toBe(1)
    expect(result.evidence.map((entry) => entry.what)).toEqual([
      "react-router dependency",
      "framework-mode project: routes come from react-router-framework",
    ])
  })

  it("scores 80 for a useRoutes call", () => {
    const result = detectOn({
      ...DEPS,
      "src/app.tsx": 'import { useRoutes } from "react-router-dom"\nexport const App = () => useRoutes([{ path: "/" }])\n',
    })
    expect(result.score).toBe(80)
    expect(result.evidence[1]?.what).toBe("useRoutes call")
  })

  it("reads the JSX-only form instead of refusing it", () => {
    const result = analyze({ "src/app.tsx": JSX_ROUTER })

    expect(codes(result)).not.toContain("screens/unsupported-router-style")
    expect(urlsOf(result.graph.screens)).toEqual(["/home"])
  })

  it("stays silent about the router style once a data router is present", () => {
    const result = analyze({
      "src/app.tsx": JSX_ROUTER,
      "src/routes/router.tsx": `export const router = createBrowserRouter([{ path: "/home" }])\n`,
    })
    expect(codes(result)).not.toContain("screens/unsupported-router-style")
  })

  it("warns instead of guessing when the router argument is not a readable route array", () => {
    const result = analyze({
      "src/routes/router.tsx": `
import { buildRoutes } from "./build"
export const router = createBrowserRouter(buildRoutes(window.config))
`,
      "src/routes/build.ts": `export const buildRoutes = (config) => config.routes\n`,
    })

    const diagnostic = result.diagnostics.find((entry) => entry.code === "screens/dynamic-registry")
    expect(diagnostic?.severity).toBe("warning")
    expect(diagnostic?.message).toContain("createBrowserRouter")
    expect(result.graph.screens).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// A real-world-shaped app: path constants, both lazy idioms, wrappers, dev guard
// ---------------------------------------------------------------------------

const APP_FILES = {
  "src/shared/helpers/paths.ts": `export enum Paths { Login = "/login", Orders = "/orders" }\n`,
  "src/shared/helpers/routes.ts": `export const ROUTES = { clients: "/clients" } as const\n`,
  "src/routes/ProtectedRoute.tsx":
    "export const ProtectedRoute = ({ children }: { children?: unknown }) => <div>{children}</div>\n",
  "src/routes/RouteErrorBoundary.tsx":
    "export const RouteErrorBoundary = ({ children }: { children?: unknown }) => <div>{children}</div>\n",
  "src/layouts/MainLayout.tsx":
    'import { Outlet } from "react-router-dom"\nexport const MainLayout = () => <div><Outlet /></div>\n',
  "src/modules/Login/index.tsx": "export default function Login() { return <div /> }\n",
  "src/modules/Orders/index.tsx": "export default function Orders() { return <div /> }\n",
  "src/modules/OrderDetails/index.tsx": "export default function OrderDetails() { return <div /> }\n",
  "src/modules/Clients/index.tsx": "export default function Clients() { return <div /> }\n",
  "src/modules/ClientDetails/index.tsx": "export default function ClientDetails() { return <div /> }\n",
  "src/modules/Dev/index.tsx": "export default function Dev() { return <div /> }\n",
  "src/routes/router.tsx": `
import { createBrowserRouter, Navigate, Outlet } from "react-router-dom"
import { Suspense } from "react"
import { ProtectedRoute as Protected } from "./ProtectedRoute"
import { RouteErrorBoundary } from "./RouteErrorBoundary"
import { MainLayout } from "../layouts/MainLayout"
import { Paths } from "../shared/helpers/paths"
import { ROUTES } from "../shared/helpers/routes"
import Login from "../modules/Login"
import Dev from "../modules/Dev"

const isDevelopment = () => true

export const router = createBrowserRouter([
  { path: Paths.Login, element: <Suspense><Login /></Suspense> },
  {
    element: (
      <RouteErrorBoundary routeName="root">
        <MainLayout title="Main" />
      </RouteErrorBoundary>
    ),
    children: [
      {
        path: Paths.Orders,
        lazy: async () => {
          const { default: OrdersModule } = await import("../modules/Orders")
          return { element: <Protected featureFlag="orders"><OrdersModule /></Protected> }
        },
      },
      {
        path: ROUTES.clients,
        children: [
          { index: true, element: <Outlet /> },
          {
            path: ":clientId",
            lazy: async () => {
              const [{ default: ClientsModule }, { default: DetailsModule }] = await Promise.all([
                import("../modules/Clients"),
                import("../modules/ClientDetails"),
              ])
              return { element: <><ClientsModule /><DetailsModule /></> }
            },
          },
        ],
      },
      { path: "*", element: <Navigate to={Paths.Login} /> },
      ...(isDevelopment() ? [{ path: "/dev", element: <Dev /> }] : []),
    ],
  },
])
`,
} as const

const appRun = () => analyze(APP_FILES, ["src/shared/helpers/paths.ts"])

describe("react-router: path constants", () => {
  it("reads a `Paths.X` enum member through the configured string source", () => {
    expect(urlsOf(appRun().graph.screens)).toContain("/login")
  })

  it("reads an `as const` object member out of its declaring file, unconfigured", () => {
    expect(urlsOf(appRun().graph.screens)).toContain("/clients")
  })

  it("resolves a `Paths.X` member inside a <Navigate to> attribute", () => {
    expect(screenAt(appRun().graph.screens, "/*")?.redirectTo).toBe("/login")
  })
})

describe("react-router: both lazy idioms", () => {
  it("binds `const { default: X } = await import(...)`", () => {
    expect(entryFilesOf(screenAt(appRun().graph.screens, "/orders"))).toEqual([
      "src/modules/Orders/index.tsx",
    ])
  })

  it("binds the array-destructured `await Promise.all([import(), import()])`", () => {
    expect(entryFilesOf(screenAt(appRun().graph.screens, "/clients/:clientId"))).toEqual([
      "src/modules/ClientDetails/index.tsx",
      "src/modules/Clients/index.tsx",
    ])
  })
})

describe("react-router: wrapper roles", () => {
  it("recognises an aliased <Protected> by its imported binding, not its tag", () => {
    const orders = screenAt(appRun().graph.screens, "/orders")

    expect(orders?.auth).toBe("protected")
    expect(orders?.featureFlag).toBe("orders")
    expect(orders?.ancestors.map((ancestor) => ancestor.file)).toContain("src/routes/ProtectedRoute.tsx")
  })

  it("keeps an aliased guard out of the screen entries", () => {
    expect(entryFilesOf(screenAt(appRun().graph.screens, "/orders"))).not.toContain(
      "src/routes/ProtectedRoute.tsx",
    )
  })

  it("reads `title` off a /Layout(Wrapper)?$/ tag and inherits it down the children", () => {
    const screens = appRun().graph.screens
    expect(screenAt(screens, "/orders")?.title).toBe("Main")
    expect(screenAt(screens, "/dev")?.title).toBe("Main")
    expect(screenAt(screens, "/login")?.title).toBeNull()
  })

  it("records the RouteErrorBoundary `routeName` as evidence rather than dropping it", () => {
    const layout = appRun().graph.screens.find((screen) => screen.url === null)
    expect(layout?.provenance.evidence.map((entry) => entry.what)).toContain("route name 'root'")
  })

  it("turns <Navigate to> into redirectTo and contributes no entry", () => {
    const wildcard = screenAt(appRun().graph.screens, "/*")
    expect(wildcard?.redirectTo).toBe("/login")
    expect(wildcard?.entries).toEqual([])
  })

  it("treats <Suspense> and react-router's own elements as transparent", () => {
    const login = screenAt(appRun().graph.screens, "/login")
    expect(entryFilesOf(login)).toEqual(["src/modules/Login/index.tsx"])
    expect(login?.ancestors).toEqual([])
  })

  it("ships five roles as DEFAULTS, not as hardcoded tags", () => {
    expect(DEFAULT_WRAPPER_RULES.map((rule) => [rule.role, rule.reads ?? null])).toEqual([
      ["guard", "featureFlag"],
      ["errorBoundary", "routeName"],
      ["redirect", "to"],
      ["redirect", "to"],
      ["layout", "title"],
      ["transparent", null],
      ["transparent", null],
    ])
  })

  it("matches both ProtectedRoute and PrivateRoute tags with the default guard rule", () => {
    const guard = DEFAULT_WRAPPER_RULES.find((rule) => rule.name === "protected-route")
    const pattern = new RegExp(guard?.tagRegex ?? "")
    expect(["ProtectedRoute", "PrivateRoute", "PrivateRouteX", "MyProtectedRoute"].map((tag) => pattern.test(tag))).toEqual([
      true,
      true,
      false,
      false,
    ])
  })

  it("lets a host project replace the roles entirely", () => {
    const result = run({
      files: {
        "src/routes/Gate.tsx": "export const Gate = ({ children }: { children?: unknown }) => <div>{children}</div>\n",
        "src/modules/Home/index.tsx": "export default function Home() { return <div /> }\n",
        "src/routes/router.tsx": `
import { Gate } from "./Gate"
import Home from "../modules/Home"
export const router = createBrowserRouter([
  { path: "/home", element: <Gate flag="beta"><Home /></Gate> },
])
`,
      },
      adapters: [
        createReactRouterAdapter({
          wrappers: [{ name: "gate", role: "guard", tagRegex: "^Gate$", reads: "flag" }],
        }),
      ],
    })

    const home = screenAt(result.graph.screens, "/home")
    expect(home?.auth).toBe("protected")
    expect(home?.featureFlag).toBe("beta")
    expect(entryFilesOf(home)).toEqual(["src/modules/Home/index.tsx"])
  })
})

describe("react-router: nesting, index routes, dev guards and retention", () => {
  it("joins a child path onto its parent's url and derives the params", () => {
    const details = screenAt(appRun().graph.screens, "/clients/:clientId")
    expect(details?.params).toEqual(["clientId"])
  })

  it("gives an `index: true` route its parent's url", () => {
    const screens = appRun().graph.screens
    expect(urlsOf(screens).filter((url) => url === "/clients")).toEqual(["/clients"])
    expect(screenAt(screens, "/clients")?.addressable).toBe(true)
  })

  it("marks a dev-guarded spread's routes devOnly and leaves its siblings alone", () => {
    const screens = appRun().graph.screens
    expect(screenAt(screens, "/dev")?.devOnly).toBe(true)
    expect(screenAt(screens, "/orders")?.devOnly).toBe(false)
  })

  it("RETAINS the pathless layout route with url null, tagged, non-addressable", () => {
    const pathless = appRun().graph.screens.filter((screen) => screen.url === null)

    expect(pathless).toHaveLength(2)
    for (const screen of pathless) {
      expect(screen.kindTag).toBe("layout")
      expect(screen.addressable).toBe(false)
      expect(screen.entries).toEqual([])
      expect(screen.activations).toEqual([])
    }
  })

  it("lets an index child own its parent's url, so the parent does not claim it twice", () => {
    const result = appRun()
    expect(codes(result)).not.toContain("screens/duplicate-id")
    expect(screenAt(result.graph.screens, "/clients")?.kindTag).toBe("entryless")
  })

  it("tags a childless route with no entry and no redirect `entryless`", () => {
    const result = analyze({
      "src/routes/router.tsx": `export const router = createBrowserRouter([{ path: "/ghost" }])\n`,
    })
    expect(screenAt(result.graph.screens, "/ghost")?.kindTag).toBe("entryless")
  })

  it("gives every route evidence with a real file:line", () => {
    for (const screen of appRun().graph.screens) {
      const evidence = screen.provenance.evidence
      expect(evidence.length).toBeGreaterThan(0)
      for (const entry of evidence) {
        expect(entry.file).toMatch(/^src\//)
        expect(entry.line).toBeGreaterThan(1)
      }
    }
  })

  it("reads the same `children` array twice when two parents share it", () => {
    const result = analyze({
      "src/routes/shared.ts": `export const shared = [{ path: "leaf" }]\n`,
      "src/routes/router.tsx": `
import { shared } from "./shared"
export const router = createBrowserRouter([
  { path: "/a", children: shared },
  { path: "/b", children: shared },
])
`,
    })

    expect(urlsOf(result.graph.screens)).toEqual(["/a", "/a/leaf", "/b", "/b/leaf"])
  })
})

describe("react-router: ancestor chains", () => {
  it("hands a child screen its parents' elements outermost-first, spliced at <Outlet/>", () => {
    const orders = screenAt(appRun().graph.screens, "/orders")

    expect(
      orders?.ancestors.map((ancestor) => [ancestor.file, ancestor.role, ancestor.splice.kind]),
    ).toEqual([
      ["src/routes/RouteErrorBoundary.tsx", "errorBoundary", "children"],
      ["src/layouts/MainLayout.tsx", "layout", "outlet"],
      ["src/routes/ProtectedRoute.tsx", "guard", "children"],
    ])
  })

  it("names the outlet tag on the splice that composes the child route", () => {
    const outlet = screenAt(appRun().graph.screens, "/orders")?.ancestors.find(
      (ancestor) => ancestor.splice.kind === "outlet",
    )
    expect(outlet?.splice).toEqual({ kind: "outlet", tag: "Outlet" })
  })

  it("derives the shell from the innermost layout ancestor, skipping the guard nested inside it", () => {
    expect(screenAt(appRun().graph.screens, "/orders")?.shell).toBe("src/layouts/MainLayout.tsx")
  })

  it("gives the pathless layout route the same outlet splice as its children", () => {
    const layout = appRun().graph.screens.find((screen) => screen.url === null)

    expect(layout?.ancestors.map((ancestor) => ancestor.splice.kind)).toEqual(["children", "outlet"])
    expect(codes(appRun())).not.toContain("walk/no-splice-point")
  })
})

/**
 * A test harness calling `createMemoryRouter([{ path: '/account' }, { path: '/members', element: <div/> }])`
 * must not become a screen source, or its two claims would collide with the real routes.
 */
describe("react-router: a test/spec/story file is never a screen source", () => {
  const files = {
    "src/routes/router.tsx": `
import MembersList from "../modules/MembersList/MembersList"
export const router = createBrowserRouter([{ path: "/members", element: <MembersList /> }])
`,
    "src/modules/MembersList/MembersList.tsx": `export default function MembersList() { return <ul /> }`,
    "src/features/settings/NotificationsTab.test.tsx": `
export const harness = () => createMemoryRouter([{ path: "/account" }, { path: "/members", element: <div /> }])
`,
    "src/features/settings/NotificationsTab.stories.tsx": `
export const story = () => createMemoryRouter([{ path: "/stories-only" }])
`,
    "src/test-utils/storybook/withMemoryRouter.tsx": `
const STUB_ROUTES = [{ path: "*", element: null }]
export const Bridge = () => createMemoryRouter(STUB_ROUTES)
`,
    "src/__tests__/harness.tsx": `
import { Routes, Route } from "react-router-dom"
export const Harness = () => <Routes><Route path="/harness-only" element={<div />} /></Routes>
`,
  }

  it("ignores routers built by test-utils, storybook and __tests__ harnesses", () => {
    const result = analyze(files)
    expect(urlsOf(result.graph.screens)).not.toContain("/*")
    expect(urlsOf(result.graph.screens)).not.toContain("/harness-only")
  })

  it("discovers only the real router's screens", () => {
    expect(urlsOf(analyze(files).graph.screens)).toEqual(["/members"])
  })

  it("raises no screens/duplicate-id and keeps the real entry", () => {
    const result = analyze(files)
    expect(codes(result)).not.toContain("screens/duplicate-id")
    expect(entryFilesOf(screenAt(result.graph.screens, "/members"))).toEqual([
      "src/modules/MembersList/MembersList.tsx",
    ])
    expect(screenAt(result.graph.screens, "/members")?.auth).toBe("public")
  })
})

// ---------------------------------------------------------------------------
// JSX routes: <Routes>/<Route>, createRoutesFromElements, useRoutes, descendant <Routes>
// ---------------------------------------------------------------------------

const PAGES = {
  "src/components/Layout.tsx":
    'import { Outlet } from "react-router-dom"\nexport const Layout = () => <main><Outlet /></main>\n',
  "src/pages/Dashboard.tsx": "export const Dashboard = () => <div />\n",
  "src/pages/Stores.tsx": "export const Stores = () => <div />\n",
  "src/pages/Books.tsx": "export const Books = () => <div />\n",
} as const

const JSX_APP = {
  ...PAGES,
  "src/App.tsx": `
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { Layout } from "./components/Layout"
import { Dashboard } from "./pages/Dashboard"
import { Stores } from "./pages/Stores"
import { Books } from "./pages/Books"

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="stores" element={<Stores />} />
          <Route path="books/:bookId" element={<Books />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
`,
} as const

const leafUrls = (screens: readonly Screen[]): readonly (string | null)[] =>
  urlsOf(screens.filter((screen) => screen.kindTag !== "layout"))

describe("react-router: JSX <Routes>/<Route>", () => {
  it("discovers nested, index and redirect routes from <BrowserRouter><Routes>", () => {
    const result = analyze(JSX_APP)

    expect(codes(result)).not.toContain("screens/unsupported-router-style")
    expect(leafUrls(result.graph.screens)).toEqual(["/", "/*", "/books/:bookId", "/stores"])
    expect(screenAt(result.graph.screens, "/books/:bookId")?.params).toEqual(["bookId"])
  })

  it("binds each <Route element> to its component file", () => {
    const screens = analyze(JSX_APP).graph.screens
    expect(entryFilesOf(screenAt(screens, "/stores"))).toEqual(["src/pages/Stores.tsx"])
  })

  it("splices children of a layout <Route> at the layout's <Outlet/>", () => {
    const stores = screenAt(analyze(JSX_APP).graph.screens, "/stores")

    expect(stores?.ancestors.map((ancestor) => [ancestor.file, ancestor.role, ancestor.splice])).toEqual([
      ["src/components/Layout.tsx", "layout", { kind: "outlet", tag: "Outlet" }],
    ])
    expect(codes(analyze(JSX_APP))).not.toContain("walk/no-splice-point")
  })

  it("turns <Navigate to> into redirectTo", () => {
    expect(screenAt(analyze(JSX_APP).graph.screens, "/*")?.redirectTo).toBe("/")
  })

  it("produces the same screens as the equivalent object-literal data router", () => {
    const dataRouter = analyze({
      ...PAGES,
      "src/routes/router.tsx": `
import { createBrowserRouter, Navigate } from "react-router-dom"
import { Layout } from "../components/Layout"
import { Dashboard } from "../pages/Dashboard"
import { Stores } from "../pages/Stores"
import { Books } from "../pages/Books"
export const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "stores", element: <Stores /> },
      { path: "books/:bookId", element: <Books /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
])
`,
    })
    const shape = (screens: readonly Screen[]) =>
      screens.map((screen) => [screen.url, screen.kindTag, entryFilesOf(screen), screen.redirectTo])

    expect(shape(analyze(JSX_APP).graph.screens)).toEqual(shape(dataRouter.graph.screens))
  })

  it("reads <Routes> rendered by a sub-component declared in another file", () => {
    const result = analyze({
      ...PAGES,
      "src/AppRoutes.tsx": `
import { Routes, Route } from "react-router-dom"
import { Stores } from "./pages/Stores"
export const AppRoutes = () => (
  <Routes>
    <Route path="/stores" element={<Stores />} />
  </Routes>
)
`,
      "src/App.tsx": `
import { HashRouter } from "react-router-dom"
import { AppRoutes } from "./AppRoutes"
export const App = () => <HashRouter><AppRoutes /></HashRouter>
`,
    })
    expect(urlsOf(result.graph.screens)).toEqual(["/stores"])
  })

  it("reads createRoutesFromElements(...) passed to createBrowserRouter", () => {
    const result = analyze({
      ...PAGES,
      "src/routes/router.tsx": `
import { createBrowserRouter, createRoutesFromElements, Route } from "react-router-dom"
import { Layout } from "../components/Layout"
import { Stores } from "../pages/Stores"
export const router = createBrowserRouter(
  createRoutesFromElements(
    <Route path="/" element={<Layout />}>
      <Route path="stores" element={<Stores />} />
    </Route>,
  ),
)
`,
    })
    expect(codes(result)).not.toContain("screens/dynamic-registry")
    expect(leafUrls(result.graph.screens)).toEqual(["/stores"])
  })

  it("reads the useRoutes([...]) object form", () => {
    const result = analyze({
      ...PAGES,
      "src/App.tsx": `
import { useRoutes } from "react-router-dom"
import { Stores } from "./pages/Stores"
export const App = () => useRoutes([{ path: "/stores", element: <Stores /> }])
`,
    })
    expect(urlsOf(result.graph.screens)).toEqual(["/stores"])
  })

  it("prefixes a descendant <Routes> with its splat parent and splices it at <Routes>", () => {
    const result = analyze({
      ...PAGES,
      "src/pages/Users.tsx": `
import { Routes, Route } from "react-router-dom"
import { Books } from "./Books"
export const Users = () => (
  <section>
    <Routes>
      <Route path=":userId" element={<Books />} />
    </Routes>
  </section>
)
`,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Users } from "./pages/Users"
export const App = () => (
  <Routes>
    <Route path="/users/*" element={<Users />} />
  </Routes>
)
`,
    })

    expect(urlsOf(result.graph.screens)).toEqual(["/users/*", "/users/:userId"])
    expect(
      screenAt(result.graph.screens, "/users/:userId")?.ancestors.map((ancestor) => [ancestor.file, ancestor.splice]),
    ).toEqual([["src/pages/Users.tsx", { kind: "outlet", tag: "Routes" }]])
    expect(codes(result)).not.toContain("walk/no-splice-point")
  })

  it("follows a lazy() entry and its default re-export to the descendant <Routes> it renders", () => {
    const result = analyze({
      ...PAGES,
      "src/pages/Users.tsx": `
import { Routes, Route } from "react-router-dom"
import { Books } from "./Books"
export const Users = () => (
  <Routes>
    <Route path=":userId" element={<Books />} />
  </Routes>
)
`,
      "src/pages/UsersExport.tsx": `
import { Users } from "./Users.tsx"
export default Users
`,
      "src/pages/LazyUsers.tsx": `
import { lazy } from "react"
export const LazyUsers = lazy(() => import("./UsersExport.tsx"))
`,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { LazyUsers } from "./pages/LazyUsers"
export const App = () => (
  <Routes>
    <Route path="/users/*" element={<LazyUsers />} />
  </Routes>
)
`,
    })

    expect(urlsOf(result.graph.screens)).toEqual(["/users/*", "/users/:userId"])
    expect(
      screenAt(result.graph.screens, "/users/:userId")?.ancestors.map((ancestor) => [ancestor.file, ancestor.splice]),
    ).toEqual([["src/pages/Users.tsx", { kind: "outlet", tag: "Routes" }]])
    expect(codes(result)).not.toContain("screens/conflict-dropped")
  })

  it("reads a leading slash in a descendant <Routes> as relative to its mount, as react-router v6 matches it", () => {
    const result = analyze({
      ...PAGES,
      "src/pages/Users.tsx": `
import { Routes, Route } from "react-router-dom"
import { Books } from "./Books"
import { Stores } from "./Stores"
export const Users = () => (
  <Routes>
    <Route path="/" element={<Books />} />
    <Route path="/stores" element={<Stores />} />
  </Routes>
)
`,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Users } from "./pages/Users"
export const App = () => (
  <Routes>
    <Route path="/" element={<Books />} />
    <Route path="/users/*" element={<Users />} />
  </Routes>
)
`,
    })

    expect(urlsOf(result.graph.screens)).toEqual(["/", "/users", "/users/*", "/users/stores"])
    expect(codes(result)).not.toContain("screens/duplicate-id")
  })

  it("keeps a descendant screen's tree and reach to its own branch, not its siblings' or the pages a route table registers", () => {
    const result = analyze({
      "src/pages/Tokens.tsx": `export const Tokens = () => <div data-testid="create-token" />\n`,
      "src/pages/Users.tsx": `export const Users = () => <div data-testid="users-table" />\n`,
      "src/pages/Admin.tsx": `
import { Routes, Route } from "react-router-dom"
import { Tokens } from "./Tokens"
import { Users } from "./Users"
export const Admin = () => (
  <Routes>
    <Route path="tokens" element={<Tokens />} />
    <Route path="users" element={<Users />} />
  </Routes>
)
`,
      "src/menu/routes.ts": `
import { Admin } from "../pages/Admin"
import { Tokens } from "../pages/Tokens"
export const routes = [{ path: "/admin/*", component: Admin }, { path: "/tokens-shortcut", component: Tokens }]
`,
      "src/Sidebar.tsx": `
import { routes } from "./menu/routes"
export const Sidebar = () => <nav>{routes.map((route) => <a key={route.path} href={route.path} />)}</nav>
`,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Admin } from "./pages/Admin"
import { Sidebar } from "./Sidebar"
export const App = () => (
  <>
    <Sidebar />
    <Routes>
      <Route path="/admin/*" element={<Admin />} />
    </Routes>
  </>
)
`,
    })

    const users = screenAt(result.graph.screens, "/admin/users")
    expect(users?.reachable).toContain("src/pages/Users.tsx")
    expect(users?.reachable).not.toContain("src/pages/Tokens.tsx")
    expect(users?.facts.testIds).toEqual(["users-table"])
    expect(screenAt(result.graph.screens, "/admin/tokens")?.facts.testIds).toEqual(["create-token"])
  })

  it("marks a dev-guarded {cond && <Route/>} child devOnly", () => {
    const result = analyze({
      ...PAGES,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Books } from "./pages/Books"
import { Stores } from "./pages/Stores"
export const App = () => (
  <Routes>
    <Route path="/stores" element={<Stores />} />
    {import.meta.env.DEV && <Route path="/dev" element={<Books />} />}
  </Routes>
)
`,
    })
    expect(screenAt(result.graph.screens, "/dev")?.devOnly).toBe(true)
    expect(screenAt(result.graph.screens, "/stores")?.devOnly).toBe(false)
  })

  it("marks a {__DEV__ && <Route/>} child devOnly (React Native / webpack DefinePlugin guard)", () => {
    const result = analyze({
      ...PAGES,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Books } from "./pages/Books"
import { Stores } from "./pages/Stores"
export const App = () => (
  <Routes>
    <Route path="/stores" element={<Stores />} />
    {__DEV__ && <Route path="/dev" element={<Books />} />}
  </Routes>
)
`,
    })
    expect(screenAt(result.graph.screens, "/dev")?.devOnly).toBe(true)
    expect(screenAt(result.graph.screens, "/stores")?.devOnly).toBe(false)
  })

  it("reads <Route>s grouped in a fragment", () => {
    const result = analyze({
      ...PAGES,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Books } from "./pages/Books"
export const App = () => (
  <Routes>
    <>
      <Route path="/a" element={<Books />} />
      <Route path="/b" element={<Books />} />
    </>
  </Routes>
)
`,
    })
    expect(urlsOf(result.graph.screens)).toEqual(["/a", "/b"])
  })

  it("warns about routes built by .map over data, and still reads the literal siblings", () => {
    const result = analyze({
      ...PAGES,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Stores } from "./pages/Stores"
import { usePages } from "./usePages"
export const App = () => {
  const pages = usePages()
  return (
  <Routes>
    <Route path="/stores" element={<Stores />} />
    {pages.map(({ path, Page }) => <Route key={path} path={path} element={<Page />} />)}
  </Routes>
  )
}
`,
    })
    const diagnostic = result.diagnostics.find((entry) => entry.code === "screens/unsupported-router-style")

    expect(diagnostic?.severity).toBe("warning")
    expect(diagnostic?.file).toBe("src/App.tsx")
    expect(diagnostic?.message).toContain(".map")
    expect(urlsOf(result.graph.screens)).toEqual(["/stores"])
  })

  it("warns about a route child expression it cannot read instead of dropping it silently", () => {
    const result = analyze({
      ...PAGES,
      "src/App.tsx": `
import { Routes } from "react-router-dom"
import { adminRoutes } from "./admin"
export const App = () => <Routes>{adminRoutes}</Routes>
`,
      "src/admin.tsx": "export const adminRoutes = null\n",
    })
    const diagnostic = result.diagnostics.find((entry) => entry.code === "screens/unsupported-router-style")
    expect(diagnostic?.message).toContain("{adminRoutes}")
  })
})

describe("react-router: Component and lazy-module entries", () => {
  const files = {
    ...PAGES,
    "src/pages/Lazy.tsx": "export function Component() { return <div /> }\n",
    "src/pages/LazyDefault.tsx": "export default function LazyDefault() { return <div /> }\n",
    "src/routes/router.tsx": `
import { createBrowserRouter } from "react-router-dom"
import { Stores } from "../pages/Stores"
export const router = createBrowserRouter([
  { path: "/stores", Component: Stores },
  { path: "/lazy", lazy: () => import("../pages/Lazy") },
  { path: "/lazy-default", lazy: () => import("../pages/LazyDefault") },
])
`,
  }

  it("resolves `Component: X` to X's file", () => {
    const screens = analyze(files).graph.screens
    expect(entryFilesOf(screenAt(screens, "/stores"))).toEqual(["src/pages/Stores.tsx"])
    expect(screenAt(screens, "/stores")?.kindTag).toBeNull()
  })

  it("resolves `lazy: () => import(...)` to the module's Component export, else its default", () => {
    const screens = analyze(files).graph.screens
    expect(screenAt(screens, "/lazy")?.entries).toEqual([
      { kind: "file", file: "src/pages/Lazy.tsx", exportName: "Component" },
    ])
    expect(screenAt(screens, "/lazy-default")?.entries).toEqual([
      { kind: "file", file: "src/pages/LazyDefault.tsx", exportName: "default" },
    ])
  })

  it("reads <Route Component={X}> the same way", () => {
    const result = analyze({
      ...PAGES,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Stores } from "./pages/Stores"
export const App = () => <Routes><Route path="/stores" Component={Stores} /></Routes>
`,
    })
    expect(entryFilesOf(screenAt(result.graph.screens, "/stores"))).toEqual(["src/pages/Stores.tsx"])
  })
})

// ---------------------------------------------------------------------------
// Real-world route shapes: minimal synthesized equivalents, never copied code
// ---------------------------------------------------------------------------

const warningsOf = (result: ReturnType<typeof analyze>, code: string) =>
  result.diagnostics.filter((entry) => entry.code === code)

describe("react-router: <Route> mapped over a literal array of route data", () => {
  const files = {
    ...PAGES,
    "src/ProtectedRoute.tsx": "export const ProtectedRoute = ({ children }) => <>{children}</>\n",
    "src/menu/routes.ts": `
import { Stores } from "../pages/Stores"
import { Books } from "../pages/Books"
export const routes = [
  { path: "/stores", component: Stores, enterprise: false },
  { path: "/books/:bookId", component: Books, enterprise: true },
]
`,
    "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { routes } from "./menu/routes"
import { ProtectedRoute } from "./ProtectedRoute"
import { Dashboard } from "./pages/Dashboard"
export const App = ({ oss }) => {
  const available = oss ? routes.filter((route) => !route.enterprise) : routes
  return (
    <Routes>
      {available.map((route) => (
        <Route key={route.path} path={route.path} element={<ProtectedRoute><route.component /></ProtectedRoute>} />
      ))}
      <Route path="/" element={<Dashboard />} />
    </Routes>
  )
}
`,
  }

  it("reads one route per item, substituting the item's members into path and element", () => {
    const result = analyze(files)
    expect(codes(result)).not.toContain("screens/unsupported-router-style")
    expect(urlsOf(result.graph.screens)).toEqual(["/", "/books/:bookId", "/stores"])
    expect(entryFilesOf(screenAt(result.graph.screens, "/books/:bookId"))).toEqual(["src/pages/Books.tsx"])
    expect(screenAt(result.graph.screens, "/stores")?.auth).toBe("protected")
  })

  it("points each mapped screen's evidence at its data item", () => {
    const evidence = screenAt(analyze(files).graph.screens, "/stores")?.provenance.evidence ?? []
    expect(evidence.map((entry) => [entry.what, entry.file])).toContainEqual(["route data item", "src/menu/routes.ts"])
  })

  it("reads a destructuring callback and a mapped <Navigate to>", () => {
    const result = analyze({
      ...PAGES,
      "src/App.tsx": `
import { Routes, Route, Navigate } from "react-router-dom"
import { Stores } from "./pages/Stores"
const pages = [{ path: "/x", Page: Stores }]
const REDIRECTS = [{ from: "/old", to: "/x" }]
export const App = () => (
  <Routes>
    {pages.map(({ path, Page }) => <Route key={path} path={path} element={<Page />} />)}
    {REDIRECTS.map((r) => <Route key={r.from} path={r.from} element={<Navigate to={r.to} replace />} />)}
  </Routes>
)
`,
    })
    expect(entryFilesOf(screenAt(result.graph.screens, "/x"))).toEqual(["src/pages/Stores.tsx"])
    expect(screenAt(result.graph.screens, "/old")?.redirectTo).toBe("/x")
  })

  it("warns instead of stacking items on the parent when a mapped path is not readable", () => {
    const result = analyze({
      ...PAGES,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Stores } from "./pages/Stores"
const pages = [{ slug: "a" }, { slug: "b" }]
export const App = () => (
  <Routes>
    {pages.map((page) => <Route key={page.slug} path={\`/p/\${page.slug}\`} element={<Stores />} />)}
  </Routes>
)
`,
    })
    expect(warningsOf(result, "screens/unsupported-router-style")).toHaveLength(2)
    expect(result.graph.screens).toEqual([])
  })

  it("warns about a mapped item that is not an object literal", () => {
    const result = analyze({
      ...PAGES,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Stores } from "./pages/Stores"
import { extraRoute } from "./extra"
const pages = [{ path: "/a" }, extraRoute()]
export const App = () => (
  <Routes>{pages.map((page) => <Route path={page.path} element={<Stores />} />)}</Routes>
)
`,
    })
    expect(urlsOf(result.graph.screens)).toEqual(["/a"])
    expect(warningsOf(result, "screens/unsupported-router-style")[0]?.message).toContain("extraRoute()")
  })

  const guarded = (element: string) => ({
    ...PAGES,
    "src/ProtectedRoute.tsx": "export const ProtectedRoute = ({ children }) => <>{children}</>\n",
    "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { ProtectedRoute } from "./ProtectedRoute"
import { Stores } from "./pages/Stores"
import { Books } from "./pages/Books"
const pages = [
  { path: "/login", Page: Stores, type: "unprotected" },
  { path: "/books", Page: Books, type: "protected" },
]
export const App = () => (
  <Routes>
    {pages.map((route) => <Route key={route.path} path={route.path} element={${element}} />)}
  </Routes>
)
`,
  })

  it("does not assert `protected` when the guard is handed the mapped item, and says why", () => {
    const result = analyze(guarded("<ProtectedRoute route={route}><route.Page /></ProtectedRoute>"))
    expect(screenAt(result.graph.screens, "/login")?.auth).toBe("unknown")
    expect(screenAt(result.graph.screens, "/books")?.auth).toBe("unknown")
    const evidence = screenAt(result.graph.screens, "/login")?.provenance.evidence ?? []
    expect(evidence.map((entry) => entry.what)).toContainEqual(expect.stringContaining("decided per item"))
  })

  it("treats a guard handed one member of the item, or a spread of it, the same way", () => {
    const member = analyze(guarded("<ProtectedRoute kind={route.type}><route.Page /></ProtectedRoute>"))
    const spread = analyze(guarded("<ProtectedRoute {...route}><route.Page /></ProtectedRoute>"))
    expect(screenAt(member.graph.screens, "/login")?.auth).toBe("unknown")
    expect(screenAt(spread.graph.screens, "/login")?.auth).toBe("unknown")
  })

  it("keeps `protected` for a mapped guard that is handed nothing per item (control)", () => {
    const result = analyze(guarded('<ProtectedRoute featureFlag="beta"><route.Page /></ProtectedRoute>'))
    expect(screenAt(result.graph.screens, "/login")?.auth).toBe("protected")
    expect(screenAt(result.graph.screens, "/books")?.featureFlag).toBe("beta")
  })

  it("keeps `protected` when a per-item guard sits under a protected parent route", () => {
    const result = analyze({
      ...guarded("<route.Page />"),
      "src/App.tsx": `
import { Routes, Route, Outlet } from "react-router-dom"
import { ProtectedRoute } from "./ProtectedRoute"
import { Stores } from "./pages/Stores"
const pages = [{ path: "login", Page: Stores }]
export const App = () => (
  <Routes>
    <Route path="/app" element={<ProtectedRoute><Outlet /></ProtectedRoute>}>
      {pages.map((route) => <Route key={route.path} path={route.path} element={<ProtectedRoute route={route}><route.Page /></ProtectedRoute>} />)}
    </Route>
  </Routes>
)
`,
    })
    expect(screenAt(result.graph.screens, "/app/login")?.auth).toBe("protected")
  })
})

describe("react-router: useRoutes is react-router's only by import binding", () => {
  it("ignores an app's own useRoutes hook instead of warning about it", () => {
    const result = analyze({
      ...PAGES,
      "src/menu/useRoutes.ts": "export const useRoutes = () => ({ routes: [] })\n",
      "src/Sidebar.tsx": `
import { useRoutes } from "./menu/useRoutes"
export const Sidebar = () => {
  const { routes } = useRoutes()
  return <nav>{routes.length}</nav>
}
`,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Stores } from "./pages/Stores"
export const App = () => <Routes><Route path="/stores" element={<Stores />} /></Routes>
`,
    })
    expect(codes(result)).not.toContain("screens/dynamic-registry")
    expect(urlsOf(result.graph.screens)).toEqual(["/stores"])
  })

  it("still reads an aliased react-router useRoutes import", () => {
    const result = analyze({
      ...PAGES,
      "src/App.tsx": `
import { useRoutes as useAppRoutes } from "react-router"
import { Stores } from "./pages/Stores"
export const App = () => useAppRoutes([{ path: "/stores", element: <Stores /> }])
`,
    })
    expect(urlsOf(result.graph.screens)).toEqual(["/stores"])
  })
})

describe("react-router: url ownership across descendant and sibling route lists", () => {
  it("merges sibling <Routes> of one component at a shared url and lets the splat parent frame them", () => {
    const result = analyze({
      ...PAGES,
      "src/pages/Users.tsx": `
import { Routes, Route } from "react-router-dom"
import { Books } from "./Books"
import { Stores } from "./Stores"
import { Dashboard } from "./Dashboard"
export const UsersView = () => (
  <>
    <Routes>
      <Route path="inactive" element={<Dashboard />} />
      <Route path="*" element={null} />
    </Routes>
    <Routes>
      <Route path="inactive" element={<Books />} />
      <Route path="*" element={<Stores />} />
    </Routes>
  </>
)
export const Users = () => <Routes><Route path="*" element={<UsersView />} /></Routes>
`,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Users } from "./pages/Users"
export const App = () => <Routes><Route path="/users/*" element={<Users />} /></Routes>
`,
    })

    expect(codes(result)).not.toContain("screens/duplicate-id")
    expect(urlsOf(result.graph.screens.filter((screen) => screen.url !== null))).toEqual([
      "/users/*",
      "/users/inactive",
    ])
    expect(entryFilesOf(screenAt(result.graph.screens, "/users/inactive"))).toEqual([
      "src/pages/Books.tsx",
      "src/pages/Dashboard.tsx",
    ])
    expect(entryFilesOf(screenAt(result.graph.screens, "/users/*"))).toEqual(["src/pages/Stores.tsx"])
  })

  it("withdraws an unclaimed descendant <Routes> whose top-level urls collide with a provably top-level list", () => {
    const result = analyze({
      ...PAGES,
      "src/main.tsx": `
import { BrowserRouter } from "react-router-dom"
import { App } from "./App"
export const Root = () => <BrowserRouter><App /></BrowserRouter>
`,
      "src/admin/Admin.tsx": `
import { Routes, Route } from "react-router-dom"
import { Books } from "../pages/Books"
import { Stores } from "../pages/Stores"
export const Admin = () => (
  <Routes>
    <Route path="users" element={<Books />} />
    <Route path="*" element={<Stores />} />
  </Routes>
)
`,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Stores } from "./pages/Stores"
import { Dashboard } from "./pages/Dashboard"
const Shell = ({ page: Page }) => <Page />
export const App = () => (
  <Routes>
    <Route path="/admin/*" element={<Shell page={Dashboard} />} />
    <Route path="*" element={<Stores />} />
  </Routes>
)
`,
    })

    expect(codes(result)).not.toContain("screens/duplicate-id")
    expect(urlsOf(result.graph.screens)).toEqual(["/*", "/admin/*"])
    const dropped = warningsOf(result, "screens/conflict-dropped")
    expect(dropped.map((entry) => [entry.file, entry.severity])).toEqual([["src/admin/Admin.tsx", "warning"]])
    expect(dropped[0]?.message).toContain("src/App.tsx")
  })

  it("keeps the first of two equal paths in one route list and reports the shadowed one", () => {
    const result = analyze({
      ...PAGES,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Books } from "./pages/Books"
import { Stores } from "./pages/Stores"
export const App = () => (
  <Routes>
    <Route path="/a" element={<Books />} />
    <Route path="/a" element={<Stores />} />
  </Routes>
)
`,
    })
    expect(codes(result)).not.toContain("screens/duplicate-id")
    expect(entryFilesOf(screenAt(result.graph.screens, "/a"))).toEqual(["src/pages/Books.tsx"])
    expect(warningsOf(result, "screens/conflict-dropped")[0]?.line).toBe(8)
  })
})

describe("react-router: route families returned by functions", () => {
  const files = {
    ...PAGES,
    "src/components/ShellLayout.tsx": "export const ShellLayout = ({ children }) => <main>{children}</main>\n",
    "src/routes/os-routes.tsx": `
import { Route } from "react-router-dom"
import { lazy } from "react"
const Home = lazy(() => import("../pages/Dashboard"))
export function getOsRoutes() {
  return (
    <>
      <Route path="/home" element={<Home />} />
      <Route path="/settings" element={<Home />} />
    </>
  )
}
`,
    "src/routes/owner-routes.tsx": `
import { Route } from "react-router-dom"
import { Books } from "../pages/Books"
export function getOwnerRoutes() {
  return [
    <Route key="o1" path="/owner" element={<Books />} />,
    <Route key="o2" path="/owner/billing" element={<Books />} />,
  ]
}
`,
    "src/routes/MobileRoutes.tsx": `
import { Route } from "react-router-dom"
import { Stores } from "../pages/Stores"
export const MobileRoutes = ({ ProtectedRoute }) => (
  <>
    <Route path="/mobile" element={<ProtectedRoute><Stores /></ProtectedRoute>} />
  </>
)
`,
    "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { ShellLayout } from "./components/ShellLayout"
import { ProtectedRoute } from "./ProtectedRoute"
import { Stores } from "./pages/Stores"
import { getOsRoutes } from "./routes/os-routes"
import { getOwnerRoutes } from "./routes/owner-routes"
import { MobileRoutes } from "./routes/MobileRoutes"
export const App = () => (
  <Routes>
    <Route path="/login" element={<Stores />} />
    <Route path="/*" element={
      <Routes>
        {MobileRoutes({ ProtectedRoute })}
        <Route path="*" element={
          <ShellLayout>
            <Routes>
              {getOsRoutes()}
              {getOwnerRoutes()}
              <Route path="*" element={<Stores />} />
            </Routes>
          </ShellLayout>
        } />
      </Routes>
    } />
  </Routes>
)
`,
    "src/ProtectedRoute.tsx": "export const ProtectedRoute = ({ children }) => <>{children}</>\n",
  }

  it("reads the JSX fragment or <Route> array a called function returns", () => {
    const result = analyze(files)
    expect(codes(result)).not.toContain("screens/unsupported-router-style")
    expect(urlsOf(result.graph.screens.filter((screen) => screen.url !== null))).toEqual([
      "/*",
      "/home",
      "/login",
      "/mobile",
      "/owner",
      "/owner/billing",
      "/settings",
    ])
    expect(screenAt(result.graph.screens, "/mobile")?.auth).toBe("protected")
  })

  it("nests an inline <Routes> in a splat route's element under that route, with no duplicate catch-all", () => {
    const result = analyze(files)
    expect(codes(result)).not.toContain("screens/duplicate-id")
    expect(entryFilesOf(screenAt(result.graph.screens, "/*"))).toEqual(["src/pages/Stores.tsx"])
    expect(screenAt(result.graph.screens, "/home")?.ancestors.map((ancestor) => ancestor.file)).toContain(
      "src/components/ShellLayout.tsx",
    )
  })

  it("still warns about a route-family call whose function has more than one return", () => {
    const result = analyze({
      ...PAGES,
      "src/routes.tsx": `
import { Route } from "react-router-dom"
import { Books } from "./pages/Books"
export function getRoutes(admin) {
  if (admin) return <Route path="/admin" element={<Books />} />
  return null
}
`,
      "src/App.tsx": `
import { Routes } from "react-router-dom"
import { getRoutes } from "./routes"
export const App = () => <Routes>{getRoutes(true)}</Routes>
`,
    })
    expect(warningsOf(result, "screens/unsupported-router-style")[0]?.message).toContain("getRoutes(true)")
  })
})

describe("react-router: wrapped factories and route-building functions", () => {
  it("treats `wrapCreateBrowserRouterV6(createBrowserRouter)` from @sentry as the factory itself", () => {
    const result = analyze({
      ...PAGES,
      "src/routes.tsx": `
import { Stores } from "./pages/Stores"
export function buildRoutes() {
  return [{ path: "/stores", element: <Stores /> }]
}
`,
      "src/main.tsx": `
import { createBrowserRouter } from "react-router-dom"
import { wrapCreateBrowserRouterV6 } from "@sentry/react"
import { buildRoutes } from "./routes"
const create = wrapCreateBrowserRouterV6(createBrowserRouter)
export const router = create(buildRoutes())
`,
    })
    expect(codes(result)).not.toContain("screens/dynamic-registry")
    expect(urlsOf(result.graph.screens)).toEqual(["/stores"])
  })

  it("names the wrapped factory when its argument is not readable", () => {
    const result = analyze({
      "src/main.tsx": `
import { createBrowserRouter } from "react-router-dom"
import { wrapCreateBrowserRouterV6 } from "@sentry/react"
import memoize from "lodash/memoize"
import { buildRoutes } from "./routes"
const routes = memoize(buildRoutes)
const create = wrapCreateBrowserRouterV6(createBrowserRouter)
export const router = create(routes())
`,
      "src/routes.ts": "export const buildRoutes = () => []\n",
    })
    expect(warningsOf(result, "screens/dynamic-registry")[0]?.message).toContain("create(...)")
  })

  it("does not trust an arbitrary wrapper of the factory", () => {
    const result = analyze({
      "src/main.tsx": `
import { createBrowserRouter } from "react-router-dom"
import { instrument } from "./instrument"
const create = instrument(createBrowserRouter)
export const router = create([{ path: "/home" }])
`,
      "src/instrument.ts": "export const instrument = (factory) => factory\n",
    })
    expect(result.graph.screens).toEqual([])
  })

  it("warns about a route-list entry that is not a route object, and reads a named route const", () => {
    const result = analyze({
      ...PAGES,
      "src/routes/router.tsx": `
import { createBrowserRouter } from "react-router-dom"
import { Stores } from "../pages/Stores"
import { translate } from "./translate"
const pluginRoute = { path: "plugin/:page", element: <Stores /> }
export const router = createBrowserRouter([pluginRoute, translate({ path: "/x" })])
`,
      "src/routes/translate.ts": "export const translate = (route) => route\n",
    })
    expect(urlsOf(result.graph.screens)).toEqual(["/plugin/:page"])
    expect(warningsOf(result, "screens/unsupported-router-style")[0]?.message).toContain("translate(")
  })
})

describe("react-router: a descendant route gets only the wrappers enclosing its own mount", () => {
  const files = {
    ...PAGES,
    "src/ProtectedRoute.tsx": "export const ProtectedRoute = ({ children }) => <>{children}</>\n",
    "src/components/ShellLayout.tsx": "export const ShellLayout = ({ children }) => <main>{children}</main>\n",
    "src/AdminRoutes.tsx": `
import { Routes, Route } from "react-router-dom"
import { Books } from "./pages/Books"
export const AdminRoutes = () => <Routes><Route path="audit" element={<Books />} /></Routes>
`,
    "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { ProtectedRoute } from "./ProtectedRoute"
import { ShellLayout } from "./components/ShellLayout"
import { AdminRoutes } from "./AdminRoutes"
import { Stores } from "./pages/Stores"
import { Dashboard } from "./pages/Dashboard"
export const App = () => (
  <Routes>
    <Route path="/*" element={
      <Routes>
        <Route path="/public" element={<Stores />} />
        <Route path="/private" element={<ProtectedRoute><ShellLayout><Dashboard /></ShellLayout></ProtectedRoute>} />
      </Routes>
    } />
    <Route path="/admin/*" element={<><ProtectedRoute><Dashboard /></ProtectedRoute><AdminRoutes /></>} />
  </Routes>
)
`,
  }

  const ancestorFiles = (screen: Screen | undefined): readonly string[] =>
    (screen?.ancestors ?? []).map((ancestor) => ancestor.file)

  it("keeps a sibling's guard and layout out of an inline descendant route", () => {
    const screens = analyze(files).graph.screens
    expect(screenAt(screens, "/public")?.auth).toBe("public")
    expect(ancestorFiles(screenAt(screens, "/public"))).not.toContain("src/components/ShellLayout.tsx")
    expect(screenAt(screens, "/private")?.auth).toBe("protected")
    expect(ancestorFiles(screenAt(screens, "/private"))).toContain("src/components/ShellLayout.tsx")
  })

  it("does not hand a component-mounted descendant list the guard around a sibling element", () => {
    const screens = analyze(files).graph.screens
    expect(screenAt(screens, "/admin/audit")?.auth).toBe("public")
  })
})

describe("react-router: colliding unclaimed route lists are decided without file order", () => {
  const app = `
import { Routes, Route } from "react-router-dom"
import { ADMIN } from "./admin-import"
import { Stores } from "./pages/Stores"
import { Dashboard } from "./pages/Dashboard"
const sections = { admin: ADMIN }
export const App = () => {
  const Section = sections.admin
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/settings" element={<Stores />} />
      <Route path="/admin/*" element={<Section />} />
    </Routes>
  )
}
`
  const admin = `
import { Routes, Route } from "react-router-dom"
import { Books } from "./pages/Books"
export default function AdminRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Books />} />
      <Route path="users" element={<Books />} />
    </Routes>
  )
}
`
  const main = `
import { BrowserRouter } from "react-router-dom"
import { App } from "./App"
export const Root = () => <BrowserRouter><App /></BrowserRouter>
`
  const project = (adminFile: string, withRouter: boolean) => ({
    ...PAGES,
    "src/App.tsx": app.replace("./admin-import", `./${adminFile.replace(/^src\//, "").replace(/\.tsx$/, "")}`),
    [adminFile]: admin.replace("./pages/Books", adminFile.includes("/routes/") ? "../pages/Books" : "./pages/Books"),
    ...(withRouter ? { "src/main.tsx": main } : {}),
  })

  const outcome = (result: ReturnType<typeof analyze>) => ({
    urls: urlsOf(result.graph.screens.filter((screen) => screen.url !== null)),
    entries: result.graph.screens.map((screen) => [screen.url, entryFilesOf(screen)]),
    dropped: warningsOf(result, "screens/conflict-dropped").length,
  })

  it("keeps the list rendered under a router element whichever file sorts first", () => {
    const before = analyze(project("src/AdminRoutes.tsx", true))
    const after = analyze(project("src/routes/admin.tsx", true))
    expect(outcome(before)).toEqual(outcome(after))
    expect(outcome(before).urls).toEqual(["/", "/admin/*", "/settings"])
    expect(entryFilesOf(screenAt(before.graph.screens, "/"))).toEqual(["src/pages/Dashboard.tsx"])
  })

  it("withdraws both lists when neither is provably top-level", () => {
    const before = analyze(project("src/AdminRoutes.tsx", false))
    const after = analyze(project("src/routes/admin.tsx", false))
    expect(outcome(before)).toEqual(outcome(after))
    expect(outcome(before).urls).toEqual([])
    expect(outcome(before).dropped).toBe(2)
  })
})

describe("react-router: route data filtered by a runtime condition is not asserted public", () => {
  const filtered = (receiver: string) => ({
    ...PAGES,
    "src/session.ts": "export const useSession = () => null\n",
    "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Stores } from "./pages/Stores"
import { Books } from "./pages/Books"
import { useSession } from "./session"
const routes = [
  { path: "/", Page: Stores, private: false },
  { path: "/admin", Page: Books, private: true },
]
export const App = () => {
  const session = useSession()
  return <Routes>{${receiver}.map(({ path, Page }) => <Route key={path} path={path} element={<Page />} />)}</Routes>
}
`,
  })

  it("reads a filter predicate that consults a session as a runtime gate", () => {
    const screens = analyze(filtered("routes.filter((route) => !route.private || session !== null)")).graph.screens
    expect(screenAt(screens, "/admin")?.auth).toBe("unknown")
    const evidence = screenAt(screens, "/admin")?.provenance.evidence ?? []
    expect(evidence.map((entry) => entry.what)).toContainEqual(expect.stringContaining("filtered or chosen at runtime"))
  })

  it("reads a conditional choice of route data as a runtime gate", () => {
    const screens = analyze(filtered("(session ? routes : routes.filter((route) => !route.private))")).graph.screens
    expect(screenAt(screens, "/admin")?.auth).toBe("unknown")
  })

  it("keeps a predicate that reads only the item public", () => {
    const screens = analyze(filtered("routes.filter((route) => !route.private)")).graph.screens
    expect(screenAt(screens, "/")?.auth).toBe("public")
  })
})

describe("react-router: useRoutes re-exported through an app barrel", () => {
  it("follows the barrel to react-router", () => {
    const result = analyze({
      ...PAGES,
      "src/lib/router.ts": 'export { useRoutes, BrowserRouter } from "react-router-dom"\n',
      "src/App.tsx": `
import { useRoutes } from "./lib/router"
import { Stores } from "./pages/Stores"
import { Books } from "./pages/Books"
export const App = () => useRoutes([
  { path: "/", element: <Stores /> },
  { path: "/books", element: <Books /> },
])
`,
    })
    expect(urlsOf(result.graph.screens)).toEqual(["/", "/books"])
  })
})

describe("react-router: an unclaimed route list is read top-level only when that is provable", () => {
  const specifier = (from: string, to: string) => {
    const relative = posix.relative(posix.dirname(from), to).replace(/\.tsx$/, "")
    return relative.startsWith(".") ? relative : `./${relative}`
  }

  const layout = { main: "src/main.tsx", app: "src/App.tsx", routes: "src/routes/AppRoutes.tsx", access: "src/project/ProjectAccess.tsx", table: "src/project/ProjectAccessTable.tsx" }

  type Layout = typeof layout

  const project = (paths: Layout) => ({
    ...PAGES,
    [paths.main]: `
import { BrowserRouter } from "react-router-dom"
import App from "${specifier(paths.main, paths.app)}"
const Providers = ({ children }) => <>{children}</>
export const Root = () => <BrowserRouter><Providers><App /></Providers></BrowserRouter>
`,
    [paths.app]: `
import { AppRoutes } from "${specifier(paths.app, paths.routes)}"
const Shell = ({ children }) => <div>{children}</div>
export default function App() {
  return <Shell><AppRoutes /></Shell>
}
`,
    [paths.routes]: `
import { Routes, Route } from "react-router-dom"
import { ProjectAccess } from "${specifier(paths.routes, paths.access)}"
import { Dashboard } from "${specifier(paths.routes, "src/pages/Dashboard.tsx")}"
const sections = { access: ProjectAccess }
export const AppRoutes = () => {
  const Section = sections.access
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/projects/:projectId/access/*" element={<Section />} />
    </Routes>
  )
}
`,
    [paths.access]: `
import { ProjectAccessTable } from "${specifier(paths.access, paths.table)}"
export const ProjectAccess = () => <ProjectAccessTable />
`,
    [paths.table]: `
import { Routes, Route } from "react-router-dom"
import { Books } from "${specifier(paths.table, "src/pages/Books.tsx")}"
import { Stores } from "${specifier(paths.table, "src/pages/Stores.tsx")}"
export const ProjectAccessTable = () => (
  <Routes>
    <Route path="create" element={<Books />} />
    <Route path="edit/user/:userId" element={<Stores />} />
  </Routes>
)
`,
  })

  const outcome = (result: ReturnType<typeof analyze>) => ({
    urls: urlsOf(result.graph.screens),
    entries: result.graph.screens.map((screen) => [screen.url, entryFilesOf(screen)]),
    dropped: warningsOf(result, "screens/conflict-dropped").map((entry) => entry.severity),
  })

  it("withdraws an unclaimed nested list whose urls collide with nothing, naming where it is", () => {
    const result = analyze(project(layout))
    expect(urlsOf(result.graph.screens)).not.toContain("/create")
    expect(urlsOf(result.graph.screens)).not.toContain("/edit/user/:userId")
    const dropped = warningsOf(result, "screens/conflict-dropped")
    expect(dropped.map((entry) => [entry.file, entry.line, entry.severity])).toEqual([[layout.table, 6, "warning"]])
    expect(dropped[0]?.message).toContain(`${layout.table}:6`)
    expect(dropped[0]?.message).toContain("could not be linked to a mounting route")
  })

  it("keeps an app list a router element in another file renders through plain component hops", () => {
    const result = analyze(project(layout))
    expect(urlsOf(result.graph.screens)).toEqual(["/", "/projects/:projectId/access/*"])
    expect(entryFilesOf(screenAt(result.graph.screens, "/"))).toEqual(["src/pages/Dashboard.tsx"])
  })

  it("keeps the only route list of an app whose router it cannot link", () => {
    const result = analyze({
      ...PAGES,
      "src/main.tsx": `
import { BrowserRouter } from "react-router-dom"
import { mount } from "./mount"
export const Root = () => <BrowserRouter>{mount()}</BrowserRouter>
`,
      "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { Books } from "./pages/Books"
export const App = () => <Routes><Route path="/books" element={<Books />} /></Routes>
`,
    })
    expect(urlsOf(result.graph.screens)).toEqual(["/books"])
    expect(warningsOf(result, "screens/conflict-dropped")).toEqual([])
  })

  it("decides the same whichever order the files sort in", () => {
    const renamed = { main: "src/zz/main.tsx", app: "src/zz/App.tsx", routes: "src/y/routes.tsx", access: "src/a/Access.tsx", table: "src/a/Table.tsx" }
    expect(outcome(analyze(project(renamed)))).toEqual(outcome(analyze(project(layout))))
  })
})

// ---------------------------------------------------------------------------
// Route dialects: a configured dialect and the built-in Sentry preset
// ---------------------------------------------------------------------------

describe("react-router: route dialects and the Sentry preset", () => {
  const SENTRY_PACKAGE_JSON = JSON.stringify({
    name: "fixture",
    dependencies: { react: "19.0.0", "react-router-dom": "6.0.0", "@sentry/react": "9.0.0" },
  })

  type SentryLayout = { readonly main: string; readonly routes: string; readonly views: string }

  const SENTRY_LAYOUT: SentryLayout = { main: "src/main.tsx", routes: "src/router/routes.tsx", views: "src/views" }

  const relative = (from: string, to: string): string => {
    const path = posix.relative(posix.dirname(from), to)
    return path.startsWith(".") ? path : `./${path}`
  }

  const sentryApp = (layout: SentryLayout): Record<string, string> => {
    const view = (name: string): string => relative(layout.routes, `${layout.views}/${name}`)
    return {
      "package.json": SENTRY_PACKAGE_JSON,
      [`${layout.views}/App.tsx`]: 'import { Outlet } from "react-router-dom"\nexport const App = () => <Outlet />\n',
      [`${layout.views}/OrgLayout.tsx`]:
        'import { Outlet } from "react-router-dom"\nexport const OrgLayout = () => <Outlet />\n',
      ...Object.fromEntries(
        ["AccountLayout", "AccountDetails", "IssueList", "GroupDetails"].map((name) => [
          `${layout.views}/${name}.tsx`,
          `export default function ${name}() { return <div /> }\n`,
        ]),
      ),
      [layout.routes]: `
import memoize from "lodash/memoize"
import { TabPaths, Tab } from "./tabs"
import { translateSentryRoute } from "./compat"
import { errorHandler, make, routeHook } from "./helpers"
import { App } from "${view("App")}"
import { OrgLayout } from "${view("OrgLayout")}"

function buildRoutes() {
  const accountChildren = [
    { index: true, redirectTo: "details/" },
    { path: "details/", component: make(() => import("${view("AccountDetails")}")) },
    { path: "emails/old/", redirectTo: "../emails/" },
  ]
  const accountRoutes = {
    path: "account/",
    component: make(() => import("${view("AccountLayout")}")),
    children: accountChildren,
  }
  const issueRoutes = {
    path: "/issues/",
    withOrgPath: true,
    component: errorHandler(OrgLayout),
    children: [
      { index: true, component: make(() => import("${view("IssueList")}")) },
      { path: ":groupId/", component: make(() => import("${view("GroupDetails")}")) },
      routeHook("routes:issues"),
    ],
  }
  const appRoutes = {
    component: errorHandler(App),
    children: [
      { path: "/settings/", children: [accountRoutes] },
      issueRoutes,
      { path: "/old-issues/", redirectTo: "/issues/" },
      { path: \`\${TabPaths[Tab.EVENTS]}/\`, component: make(() => import("${view("IssueList")}")) },
      routeHook("routes:root"),
    ],
  }
  return [translateSentryRoute(appRoutes)]
}

export const routes = memoize(buildRoutes)
`,
      [layout.main]: `
import { createBrowserRouter } from "react-router-dom"
import { routes } from "${relative(layout.main, layout.routes).replace(/\.tsx$/, "")}"
export const router = createBrowserRouter(routes())
`,
    }
  }

  const SENTRY_URLS = [
    "/issues",
    "/issues/:groupId",
    "/old-issues",
    "/organizations/:orgId/issues",
    "/organizations/:orgId/issues/:groupId",
    "/settings",
    "/settings/account",
    "/settings/account/details",
    "/settings/account/emails/old",
  ]

  const addressed = (screens: readonly Screen[]): readonly string[] =>
    screens.flatMap((screen) => (screen.url === null ? [] : [screen.url])).sort()

  const ordinalOf = (screen: Screen | undefined): number => Number(screen?.localId.split("#")[1] ?? Number.NaN)

  const sentry = analyze(sentryApp(SENTRY_LAYOUT))

  it("follows memoize(buildRoutes) into the translator's argument and its nested const subtrees", () => {
    expect(addressed(sentry.graph.screens)).toEqual(SENTRY_URLS)
  })

  it("reads `component: make(() => import())` and `errorHandler(X)` as entries", () => {
    const screens = sentry.graph.screens
    expect(entryFilesOf(screenAt(screens, "/settings/account/details"))).toEqual(["src/views/AccountDetails.tsx"])
    expect(entryFilesOf(screenAt(screens, "/issues"))).toEqual(["src/views/IssueList.tsx"])
    expect(screenAt(screens, "/issues")?.ancestors.map((ancestor) => ancestor.file)).toContain("src/views/OrgLayout.tsx")
    const root = screens.find((screen) => screen.url === null && entryFilesOf(screen).includes("src/views/App.tsx"))
    expect(root?.entries).toEqual([{ kind: "file", file: "src/views/App.tsx", exportName: "App" }])
  })

  it("sets redirectTo from absolute, relative, index and `../` targets", () => {
    const screens = sentry.graph.screens
    expect(screenAt(screens, "/old-issues")?.redirectTo).toBe("/issues")
    expect(screenAt(screens, "/settings/account")?.redirectTo).toBe("/settings/account/details")
    expect(screenAt(screens, "/settings/account/emails/old")?.redirectTo).toBe("/settings/account/emails")
  })

  it("reads a withOrgPath route plain, then prefixed, claiming ordinals in that order", () => {
    const screens = sentry.graph.screens
    expect(ordinalOf(screenAt(screens, "/issues/:groupId"))).toBeLessThan(
      ordinalOf(screenAt(screens, "/organizations/:orgId/issues")),
    )
    const dual = screens.filter((screen) =>
      screen.provenance.evidence.some((entry) => entry.what === "dual route (withOrgPath)"),
    )
    expect(addressed(dual)).toEqual([
      "/issues",
      "/issues/:groupId",
      "/organizations/:orgId/issues",
      "/organizations/:orgId/issues/:groupId",
    ])
    expect(dual).toHaveLength(6)
  })

  it("reports each routeHook(...) and unfoldable template path once, even under a dual route", () => {
    const messages = warningsOf(sentry, "screens/unsupported-router-style").map((entry) => entry.message)
    expect(messages).toHaveLength(3)
    expect(messages.filter((message) => message.includes("routes:issues"))).toHaveLength(1)
    expect(messages.filter((message) => message.includes("TabPaths[Tab.EVENTS]"))).toHaveLength(1)
    expect(codes(sentry)).not.toContain("screens/duplicate-id")
  })

  it("decides the same whichever paths the files live at", () => {
    const moved = analyze(sentryApp({ main: "src/zz/main.tsx", routes: "src/a/routes.tsx", views: "src/m/views" }))
    const shape = (result: ReturnType<typeof analyze>) =>
      result.graph.screens.map((screen) => [screen.url, screen.redirectTo, screen.entries.length])
    expect(addressed(moved.graph.screens)).toEqual(SENTRY_URLS)
    expect(shape(moved)).toEqual(shape(sentry))
  })

  const PLAIN_APP = {
    ...PAGES,
    "src/routes/router.tsx": `
import { createBrowserRouter } from "react-router-dom"
import { Stores } from "../pages/Stores"
import { Books } from "../pages/Books"
export const router = createBrowserRouter([
  { path: "/a", component: Stores, withOrgPath: true, children: [{ path: "b", Component: Books }] },
  { path: "/c", redirectTo: "/a" },
])
`,
  }

  it("leaves a non-Sentry app that depends on @sentry/react unchanged", () => {
    const withSentry = analyze({ ...PLAIN_APP, "package.json": SENTRY_PACKAGE_JSON })
    const without = analyze(PLAIN_APP)
    expect(withSentry.graph.screens).toEqual(without.graph.screens)
    expect(addressed(withSentry.graph.screens)).toEqual(["/a", "/a/b", "/c"])
    expect(screenAt(withSentry.graph.screens, "/c")?.redirectTo).toBeNull()
  })

  it("applies a configured dialect without translators everywhere", () => {
    const result = run({
      files: {
        ...PAGES,
        "src/routes/router.tsx": `
import { createBrowserRouter } from "react-router-dom"
import { Stores } from "../pages/Stores"
import { Books } from "../pages/Books"
export const router = createBrowserRouter([
  { path: "/a", component: Stores, routes: [{ path: "b", component: Books }, { path: "c", goTo: "../b" }] },
])
`,
      },
      adapters: [
        createReactRouterAdapter({
          routeDialect: { fields: { component: "component", children: "routes", redirect: "goTo" } },
        }),
      ],
    })
    const screens = result.graph.screens
    expect(addressed(screens)).toEqual(["/a", "/a/b", "/a/c"])
    expect(entryFilesOf(screenAt(screens, "/a"))).toEqual(["src/pages/Stores.tsx"])
    expect(entryFilesOf(screenAt(screens, "/a/b"))).toEqual(["src/pages/Books.tsx"])
    expect(screenAt(screens, "/a/c")?.redirectTo).toBe("/a/b")
  })
})

describe("react-router: a mapped guard's `entryFrom` names the page", () => {
  const UNLEASH_ELEMENT =
    "<LayoutPicker isStandalone={route.isStandalone === true}><ProtectedRoute route={route} /></LayoutPicker>"

  const RETURNS_ROUTE_COMPONENT = `
import { LoginRedirect } from "./LoginRedirect"
export const ProtectedRoute = ({ route }) => {
  const isLoggedIn = Boolean(globalThis.user)
  if (!isLoggedIn && route.type === "protected") return <LoginRedirect />
  return <route.component />
}
`

  type MappedApp = {
    readonly guard?: string
    readonly guardTag?: string
    readonly element?: string
    readonly callback?: string
    readonly path?: string
    readonly data?: string
  }

  const mappedApp = ({
    guard = RETURNS_ROUTE_COMPONENT,
    guardTag = "ProtectedRoute",
    element = UNLEASH_ELEMENT,
    callback = "(route)",
    path = "route.path",
    data = '{ path: "/stores", component: Stores, type: "protected" },\n  { path: "/books", component: Books, type: "open" },',
  }: MappedApp = {}) => ({
    ...PAGES,
    "src/common/LoginRedirect.tsx": "export const LoginRedirect = () => <div />\n",
    [`src/common/${guardTag}.tsx`]: guard,
    "src/layout/LayoutPicker.tsx":
      "export const LayoutPicker = ({ children, isStandalone }) => (isStandalone ? children : <main>{children}</main>)\n",
    "src/menu/routes.ts": `
import { Stores } from "../pages/Stores"
import { Books } from "../pages/Books"
export const routes = [
  ${data}
]
`,
    "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { routes } from "./menu/routes"
import { LayoutPicker } from "./layout/LayoutPicker"
import { ${guardTag} } from "./common/${guardTag}"
export const App = () => (
  <Routes>
    {routes.map(${callback} => <Route key={${path}} path={${path}} element={${element}} />)}
  </Routes>
)
`,
  })

  const chainOf = (screen: Screen | undefined) =>
    (screen?.ancestors ?? []).map((ancestor) => [ancestor.file, ancestor.role, ancestor.splice.kind])

  const evidenceOf = (screen: Screen | undefined): readonly string[] =>
    (screen?.provenance.evidence ?? []).map((entry) => entry.what)

  it("enters the Unleash shape at the item's page, framed by the picker and spliced at the guard's <route.component/>", () => {
    const result = analyze(mappedApp())
    const stores = screenAt(result.graph.screens, "/stores")

    expect(entryFilesOf(stores)).toEqual(["src/pages/Stores.tsx"])
    expect(entryFilesOf(screenAt(result.graph.screens, "/books"))).toEqual(["src/pages/Books.tsx"])
    expect(chainOf(stores)).toEqual([
      ["src/layout/LayoutPicker.tsx", "layout", "children"],
      ["src/common/ProtectedRoute.tsx", "guard", "at"],
    ])
    expect(evidenceOf(stores)).toContain(
      "page component 'Stores' from <ProtectedRoute route={…}> (via route prop)",
    )
    expect(stores?.tree.length).toBeGreaterThan(0)
    expect(warningsOf(result, "walk/no-splice-point")).toEqual([])
  })

  it("keeps the per-item auth semantics of a guard handed the item", () => {
    const stores = screenAt(analyze(mappedApp()).graph.screens, "/stores")
    expect(stores?.auth).toBe("unknown")
    expect(evidenceOf(stores)).toContainEqual(expect.stringContaining("decided per item"))
  })

  it("splices at a page the guard destructures out of its prop, `({ route: { component: Page } })`", () => {
    const guard = "export const ProtectedRoute = ({ route: { component: Page } }) => <section><Page /></section>\n"
    const stores = screenAt(analyze(mappedApp({ guard })).graph.screens, "/stores")
    expect(entryFilesOf(stores)).toEqual(["src/pages/Stores.tsx"])
    expect(chainOf(stores).at(-1)).toEqual(["src/common/ProtectedRoute.tsx", "guard", "at"])
  })

  it("reads a member handed through a destructured map callback, `({ component: Page })`", () => {
    const result = analyze(
      mappedApp({
        guard: "export const ProtectedRoute = ({ component: Page }) => <Page />\n",
        callback: "({ path, component: Page })",
        path: "path",
        element: "<ProtectedRoute component={Page} />",
      }),
    )
    const stores = screenAt(result.graph.screens, "/stores")
    expect(entryFilesOf(stores)).toEqual(["src/pages/Stores.tsx"])
    expect(chainOf(stores)).toEqual([["src/common/ProtectedRoute.tsx", "guard", "at"]])
    expect(evidenceOf(stores)).toContain(
      "page component 'Stores' from <ProtectedRoute component={…}> (via component prop)",
    )
  })

  it("gives an opaque entry for a non-identifier member, and still frames it", () => {
    const result = analyze(
      mappedApp({ data: '{ path: "/stores", component: lazy(() => import("../pages/Stores")) },' }),
    )
    const stores = screenAt(result.graph.screens, "/stores")
    expect(stores?.entries.map((entry) => entry.kind)).toEqual(["opaque"])
    expect(stores?.entries[0]).toMatchObject({ expr: 'lazy(() => import("../pages/Stores"))' })
    expect(chainOf(stores).map(([file]) => file)).toEqual([
      "src/layout/LayoutPicker.tsx",
      "src/common/ProtectedRoute.tsx",
    ])
    expect(evidenceOf(stores).filter((what) => what.startsWith("page component"))).toEqual([])
  })

  it("keeps the pre-`entryFrom` reading, with an info, when the guard renders the page somewhere this source cannot point to", () => {
    const guard = "export const ProtectedRoute = (props) => { const Page = props.route.component; return <Page /> }\n"
    const result = analyze(mappedApp({ guard }))
    const stores = screenAt(result.graph.screens, "/stores")
    expect(entryFilesOf(stores)).toEqual(["src/layout/LayoutPicker.tsx"])
    expect(chainOf(stores)).toEqual([["src/common/ProtectedRoute.tsx", "guard", "children"]])
    expect(evidenceOf(stores).filter((what) => what.startsWith("page component"))).toEqual([])
    expect(warningsOf(result, "screens/entry-from-unresolved").map((entry) => entry.message)).toEqual([
      expect.stringContaining("src/common/ProtectedRoute.tsx"),
    ])
  })

  it("keeps today's reading for a guard rule without `entryFrom`", () => {
    const withoutEntryFrom = [
      { name: "protected-route", role: "guard", tagRegex: "^ProtectedRoute$" } as const,
      ...DEFAULT_WRAPPER_RULES.filter((rule) => rule.entryFrom === undefined),
    ]
    const result = run({
      files: mappedApp(),
      adapters: [createReactRouterAdapter({ wrappers: withoutEntryFrom })],
    })
    const stores = screenAt(result.graph.screens, "/stores")
    expect(entryFilesOf(stores)).toEqual(["src/layout/LayoutPicker.tsx"])
    expect(chainOf(stores)).toEqual([["src/common/ProtectedRoute.tsx", "guard", "children"]])
    expect(evidenceOf(stores).filter((what) => what.startsWith("page component"))).toEqual([])
  })

  it("applies a configured `entryFrom` on a custom guard name", () => {
    const guard = "export const AuthGate = ({ page }) => <page.view />\n"
    const files = mappedApp({
      guard,
      guardTag: "AuthGate",
      element: "<LayoutPicker><AuthGate page={route} /></LayoutPicker>",
      data: '{ path: "/stores", view: Stores },',
    })
    const result = run({
      files,
      adapters: [
        createReactRouterAdapter({
          wrappers: [...DEFAULT_WRAPPER_RULES, { name: "auth-gate", role: "guard", tagRegex: "^AuthGate$", entryFrom: "view" }],
        }),
      ],
    })
    const stores = screenAt(result.graph.screens, "/stores")
    expect(entryFilesOf(stores)).toEqual(["src/pages/Stores.tsx"])
    expect(chainOf(stores)).toEqual([
      ["src/layout/LayoutPicker.tsx", "layout", "children"],
      ["src/common/AuthGate.tsx", "guard", "at"],
    ])
    expect(evidenceOf(stores)).toContain("page component 'Stores' from <AuthGate page={…}> (via page prop)")
  })
})

describe("react-router: dialect routes read honestly, never dropped silently", () => {
  const view = (name: string): string => `make(() => import("../views/${name}"))`

  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "fixture",
      dependencies: { react: "19.0.0", "react-router-dom": "6.0.0", "@sentry/react": "9.0.0" },
    }),
    ...Object.fromEntries(
      ["Panel", "PanelView", "WidgetList", "WidgetDetail", "Leaf", "Kept"].map((name) => [
        `src/views/${name}.tsx`,
        `export default function ${name}() { return <div /> }\n`,
      ]),
    ),
    "src/router/widgets.tsx": `
import { make } from "./helpers"
export const widgetRoutes = {
  path: "/widgets/",
  children: [
    { index: true, component: ${view("WidgetList")} },
    { path: ":widgetId/", component: ${view("WidgetDetail")} },
  ],
}
`,
    "src/router/routes.tsx": `
import memoize from "lodash/memoize"
import { translateSentryRoute } from "./compat"
import { getSection, make, unknownRoutes } from "./helpers"
import { widgetRoutes } from "./widgets"

function buildRoutes() {
  const someFlag = Math.random() > 0.5
  const panelChildren = (plain: boolean) => [
    { index: true, redirectTo: plain ? "/hub/" : "/org/:orgId/hub/" },
    { path: "view/", component: ${view("PanelView")} },
    { path: "old/", redirectTo: "../view/?mode=1" },
  ]
  function looseChildren(mode: boolean) {
    return [{ path: "x/", redirectTo: mode ? "/a/" : "/b/" }]
  }
  const computed = Object.values({ a: "a" }).map((name) => ({ path: name }))
  const appRoutes = {
    children: [
      { path: "/panel/", component: ${view("Panel")}, children: panelChildren(true) },
      { path: "/org/:orgId/panel/", children: panelChildren(false) },
      { path: "/loose/", children: looseChildren(someFlag) },
      { path: "/missing/", children: unknownRoutes() },
      {
        path: "/hub/",
        withOrgPath: true,
        children: [...widgetRoutes.children!, { path: "deep/", children: [{ path: "leaf/", component: ${view("Leaf")} }] }],
      },
      { path: "/legacy/", children: [...computed, { path: "kept/", component: ${view("Kept")} }] },
      { path: "/tpl/", redirectTo: \`/\${getSection()}/\` },
      { path: "/snap/", redirectTo: "/hub/?tab=snap" },
    ],
  }
  return [translateSentryRoute(appRoutes)]
}

export const routes = memoize(buildRoutes)
`,
    "src/main.tsx": `
import { createBrowserRouter } from "react-router-dom"
import { routes } from "./router/routes"
export const router = createBrowserRouter(routes())
`,
  }

  const result = analyze(files)
  const screens = result.graph.screens
  const messages = warningsOf(result, "screens/unsupported-router-style").map((entry) => entry.message)
  const messagesWith = (text: string): readonly string[] => messages.filter((message) => message.includes(text))

  it("follows a function-local route builder and folds a ternary on its literal argument", () => {
    expect(screenAt(screens, "/panel")?.redirectTo).toBe("/hub")
    expect(screenAt(screens, "/org/:orgId/panel")?.redirectTo).toBe("/org/:orgId/hub")
    expect(entryFilesOf(screenAt(screens, "/panel/view"))).toEqual(["src/views/PanelView.tsx"])
    expect(entryFilesOf(screenAt(screens, "/org/:orgId/panel/view"))).toEqual(["src/views/PanelView.tsx"])
  })

  it("reads a local function declaration, and reports a ternary on a non-literal argument", () => {
    expect(screenAt(screens, "/loose/x")?.redirectTo).toBeNull()
    expect(messagesWith('mode ? "/a/" : "/b/"')).toHaveLength(1)
  })

  it("reports a children call it cannot resolve instead of reading an empty list", () => {
    expect(messagesWith("route children {unknownRoutes()}")).toHaveLength(1)
    expect(screens.some((screen) => screen.url?.startsWith("/missing/") ?? false)).toBe(false)
  })

  it("spreads `X.children!` of an imported route object", () => {
    expect(entryFilesOf(screenAt(screens, "/hub"))).toEqual(["src/views/WidgetList.tsx"])
    expect(entryFilesOf(screenAt(screens, "/hub/:widgetId"))).toEqual(["src/views/WidgetDetail.tsx"])
    expect(entryFilesOf(screenAt(screens, "/organizations/:orgId/hub/:widgetId"))).toEqual([
      "src/views/WidgetDetail.tsx",
    ])
  })

  it("reports a computed spread it cannot read and keeps its siblings", () => {
    expect(messagesWith("route list spread {...computed}")).toHaveLength(1)
    expect(entryFilesOf(screenAt(screens, "/legacy/kept"))).toEqual(["src/views/Kept.tsx"])
  })

  it("keeps a route with an unfoldable redirect as a screen and reports the site", () => {
    const tpl = screenAt(screens, "/tpl")
    expect(tpl?.redirectTo).toBeNull()
    expect(tpl?.entries).toEqual([])
    expect(messagesWith("redirect target {redirectTo: `/${getSection()}/`}")).toHaveLength(1)
  })

  it("keeps the query string of absolute and relative redirect targets", () => {
    expect(screenAt(screens, "/snap")?.redirectTo).toBe("/hub?tab=snap")
    expect(screenAt(screens, "/panel/old")?.redirectTo).toBe("/panel/view?mode=1")
  })

  it("carries the dual-route evidence onto every descendant of both variants", () => {
    const dualOf = (url: string): readonly string[] =>
      (screenAt(screens, url)?.provenance.evidence ?? [])
        .filter((entry) => entry.what === "dual route (withOrgPath)")
        .map((entry) => `${entry.file}:${String(entry.line)}`)
    const flagged = dualOf("/hub/deep/leaf")
    expect(flagged).toHaveLength(1)
    expect(dualOf("/organizations/:orgId/hub/deep/leaf")).toEqual(flagged)
    expect(dualOf("/hub")).toEqual(flagged)
    expect(dualOf("/panel/view")).toEqual([])
  })

  it("reports each site once", () => {
    expect(new Set(messages).size).toBe(messages.length)
    expect(messages).toHaveLength(4)
  })
})

describe("react-router: barrels carry the forwarded export, guards hand a page only when they render it, dialects say when they replace a preset", () => {
  const SHELLS = {
    "src/ui/Chart.tsx": "export const Chart = () => <canvas />\n",
    "src/ui/Table.tsx": "export const Table = () => <table />\n",
    "src/ui/Drawer.tsx": "export const Drawer = ({ children }) => <aside>{children}</aside>\n",
    "src/ui/Panel.tsx": "export const Panel = ({ children }) => <section>{children}</section>\n",
    "src/layouts/shells.tsx": `
import { Outlet } from "react-router-dom"
import { Panel } from "../ui/Panel"
import { Drawer } from "../ui/Drawer"
export function MobileShell() { return <Drawer><Outlet /></Drawer> }
export function DesktopShell() { return <main><Panel><Outlet /></Panel></main> }
`,
    "src/pages/screens.tsx": `
import { Chart } from "../ui/Chart"
import { Table } from "../ui/Table"
export function Dashboard() { return <div><Chart /></div> }
export function Helper() { return <div><Table /></div> }
`,
  } as const

  const BARREL_APP = {
    ...SHELLS,
    "src/layouts/desktop.ts": 'import { DesktopShell } from "./shells"\nexport default DesktopShell\n',
    "src/pages/dashboard.ts": 'import { Dashboard } from "./screens"\nexport default Dashboard\n',
    "src/App.tsx": `
import { createBrowserRouter } from "react-router-dom"
import Desktop from "./layouts/desktop"
export const router = createBrowserRouter([
  { path: "/", element: <Desktop />, children: [{ path: "dash", lazy: () => import("./pages/dashboard") }] },
])
`,
  }

  const DIRECT_APP = {
    ...SHELLS,
    "src/App.tsx": `
import { createBrowserRouter } from "react-router-dom"
import { DesktopShell } from "./layouts/shells"
import { Dashboard } from "./pages/screens"
export const router = createBrowserRouter([
  { path: "/", element: <DesktopShell />, children: [{ path: "dash", element: <Dashboard /> }] },
])
`,
  }

  const componentsAbove = (nodes: readonly TreeNode[], file: string, above: readonly string[] = []): readonly string[] | null => {
    for (const node of nodes) {
      if (node.file === file) return above
      const found = componentsAbove(node.children, file, [...above, node.component])
      if (found !== null) return found
    }
    return null
  }

  const shellAncestorOf = (screen: Screen | undefined) =>
    screen?.ancestors.find((ancestor) => ancestor.file === "src/layouts/shells.tsx")

  it("pairs a barrel's `export default <named import>` with the named export and places the page in DesktopShell", () => {
    const result = analyze(BARREL_APP)
    const dash = screenAt(result.graph.screens, "/dash")

    expect(shellAncestorOf(dash)?.exportName).toBe("DesktopShell")
    expect(dash?.entries).toContainEqual(expect.objectContaining({ file: "src/pages/screens.tsx", exportName: "Dashboard" }))
    const above = componentsAbove(dash?.tree ?? [], "src/pages/screens.tsx")
    expect(above).toContain("Panel")
    expect(above).not.toContain("Drawer")
    expect(warningsOf(result, "walk/ambiguous-splice")).toEqual([])
  })

  it("leaves a direct named import unchanged", () => {
    const result = analyze(DIRECT_APP)
    const dash = screenAt(result.graph.screens, "/dash")

    expect(shellAncestorOf(dash)?.exportName).toBe("DesktopShell")
    const above = componentsAbove(dash?.tree ?? [], "src/pages/screens.tsx")
    expect(above).toContain("Panel")
    expect(above).not.toContain("Drawer")
  })

  it("carries the final name through a chained default re-export", () => {
    const result = analyze({
      ...BARREL_APP,
      "src/layouts/desktop.ts": 'export { default } from "./middle"\n',
      "src/layouts/middle.ts": 'import { DesktopShell as Shell } from "./shells"\nexport default Shell\n',
    })
    const dash = screenAt(result.graph.screens, "/dash")

    expect(shellAncestorOf(dash)?.exportName).toBe("DesktopShell")
    expect(componentsAbove(dash?.tree ?? [], "src/pages/screens.tsx")).toContain("Panel")
  })

  const guardedApp = (guard: string) => ({
    ...PAGES,
    "src/pages/Notes.tsx": "export const Notes = () => <div />\n",
    "src/common/ProtectedRoute.tsx": guard,
    "src/menu/routes.ts": `
import { Stores } from "../pages/Stores"
import { Books } from "../pages/Books"
export const routes = [
  { path: "/stores", component: Stores },
  { path: "/books", component: Books },
]
`,
    "src/App.tsx": `
import { Routes, Route } from "react-router-dom"
import { routes } from "./menu/routes"
import { Notes } from "./pages/Notes"
import { ProtectedRoute } from "./common/ProtectedRoute"
export const App = () => (
  <Routes>
    {routes.map((route) => <Route key={route.path} path={route.path} element={<ProtectedRoute route={route}><Notes /></ProtectedRoute>} />)}
  </Routes>
)
`,
  })

  const unresolvedEntriesOf = (result: ReturnType<typeof analyze>) => warningsOf(result, "screens/entry-from-unresolved")

  it("does not take the handed component as the page when the guard renders {children}, and says so once", () => {
    const result = analyze(guardedApp("export const ProtectedRoute = ({ route, children }) => <section>{children}</section>\n"))
    const books = screenAt(result.graph.screens, "/books")

    expect(entryFilesOf(books)).toEqual(["src/pages/Notes.tsx"])
    expect(entryFilesOf(screenAt(result.graph.screens, "/stores"))).toEqual(["src/pages/Notes.tsx"])
    expect(books?.ancestors.map((ancestor) => [ancestor.file, ancestor.splice.kind])).toEqual([
      ["src/common/ProtectedRoute.tsx", "children"],
    ])
    expect(books?.provenance.evidence.filter((entry) => entry.what.startsWith("page component"))).toEqual([])
    const infos = unresolvedEntriesOf(result)
    expect(infos).toHaveLength(1)
    expect(infos[0]).toMatchObject({ severity: "info", file: "src/App.tsx" })
    expect(infos[0]?.message).toContain("src/common/ProtectedRoute.tsx")
  })

  it("keeps the Unleash shape: a guard rendering <route.component/> hands the page, with no info", () => {
    const result = analyze(
      guardedApp('export const ProtectedRoute = ({ route }) => <route.component />\n'),
    )

    expect(entryFilesOf(screenAt(result.graph.screens, "/books"))).toContain("src/pages/Books.tsx")
    expect(entryFilesOf(screenAt(result.graph.screens, "/stores"))).toContain("src/pages/Stores.tsx")
    expect(screenAt(result.graph.screens, "/books")?.ancestors.at(-1)?.splice.kind).toBe("at")
    expect(unresolvedEntriesOf(result)).toEqual([])
  })

  const SENTRY_SHAPED = {
    ...PAGES,
    "package.json": JSON.stringify({
      name: "fixture",
      dependencies: { react: "19.0.0", "react-router-dom": "6.0.0", "@sentry/react": "9.0.0" },
    }),
    "src/routes/router.tsx": `
import { createBrowserRouter } from "react-router-dom"
import { translateSentryRoute } from "./compat"
import { Stores } from "../pages/Stores"
export const router = createBrowserRouter([translateSentryRoute({ path: "/a", component: Stores, children: [{ path: "old", redirectTo: "/a" }] })])
`,
  }

  const partialDialect = createReactRouterAdapter({ routeDialect: { fields: { redirect: "redirectTo" } } })

  it("says when a partial configured dialect replaces the Sentry preset", () => {
    const configured = run({ files: SENTRY_SHAPED, adapters: [partialDialect] })
    const preset = analyze(SENTRY_SHAPED)

    expect(warningsOf(preset, "config/dialect-overrides-preset")).toEqual([])
    expect(screenAt(preset.graph.screens, "/a/old")?.redirectTo).toBe("/a")
    const infos = warningsOf(configured, "config/dialect-overrides-preset")
    expect(infos).toHaveLength(1)
    expect(infos[0]).toMatchObject({ severity: "info" })
    expect(infos[0]?.message).toContain("'sentry'")
    expect(screenAt(configured.graph.screens, "/a/old")).toBeUndefined()
  })

  it("says nothing when no preset would apply", () => {
    const result = run({ files: { ...SENTRY_SHAPED, "package.json": PACKAGE_JSON }, adapters: [partialDialect] })
    expect(warningsOf(result, "config/dialect-overrides-preset")).toEqual([])
  })
})

describe("react-router: single factory reads, lazy Component exports and version warnings", () => {
  const LAYOUT_PAGES = {
    "src/pages.tsx": `import { Outlet } from "react-router-dom"
export const Home = () => <div />
export const Shell = () => <Outlet />
`,
  }

  const inlineRouter = (wrap: (factory: string) => string) => ({
    ...LAYOUT_PAGES,
    "src/main.tsx": `import { createBrowserRouter, RouterProvider } from "react-router-dom"
import { createRoot } from "react-dom/client"
import { Home, Shell } from "./pages"
createRoot(document.body).render(<RouterProvider router={${wrap(
      'createBrowserRouter([{ path: "/", element: <Shell />, children: [{ index: true, element: <Home /> }, { path: "x", element: <Home /> }] }])',
    )}} />)
`,
  })

  for (const [label, wrap] of [
    ["inline in a JSX attribute", (factory: string) => factory],
    ["parenthesised in a JSX attribute", (factory: string) => `(${factory})`],
  ] as const)
    it(`reads a router factory written ${label} exactly once`, () => {
      const result = analyze(inlineRouter(wrap))
      expect(urlsOf(result.graph.screens)).toEqual(["/", "/x", null])
      expect(codes(result)).not.toContain("screens/duplicate-id")
    })

  it("resolves a lazy route's returned `Component` to the destructured named export", () => {
    const result = analyze({
      ...LAYOUT_PAGES,
      "src/settings.tsx": "export function Settings() { return <div /> }\n",
      "src/billing.tsx": "export function Billing() { return <div /> }\n",
      "src/team.tsx": "export function Team() { return <div /> }\n",
      "src/main.tsx": `import { createBrowserRouter } from "react-router-dom"
export const router = createBrowserRouter([
  { path: "/settings", lazy: async () => { const { Settings } = await import("./settings"); return { Component: Settings } } },
  { path: "/billing", lazy: async () => { const mod = await import("./billing"); return { Component: mod.Billing } } },
  { path: "/team", lazy: () => import("./team").then((m) => ({ Component: m.Team })) },
])
`,
    })
    expect(screenAt(result.graph.screens, "/settings")?.entries).toEqual([
      { kind: "file", file: "src/settings.tsx", exportName: "Settings" },
    ])
    expect(screenAt(result.graph.screens, "/billing")?.entries).toEqual([
      { kind: "file", file: "src/billing.tsx", exportName: "Billing" },
    ])
    expect(screenAt(result.graph.screens, "/team")?.entries).toEqual([
      { kind: "file", file: "src/team.tsx", exportName: "Team" },
    ])
  })

  const V5_APP = {
    "src/pages.tsx": "export const Home = () => <div />\n",
    "src/App.tsx": `import { BrowserRouter, Switch, Route } from "react-router-dom"
import { Home } from "./pages"
export const App = () => <BrowserRouter><Switch><Route exact path="/" component={Home} /></Switch></BrowserRouter>
`,
  }

  const unsupportedOf = (result: ReturnType<typeof analyze>) =>
    warningsOf(result, "screens/unsupported-router-style").filter((entry) => entry.severity === "warning")

  const ROOTLESS_APP = {
    "src/pages.tsx": "export const Home = () => <div />\n",
    "src/App.tsx": `import { BrowserRouter, Route } from "react-router-dom"
import { Home } from "./pages"
export const App = () => <BrowserRouter><Route exact path="/" component={Home} /></BrowserRouter>
`,
  }

  it("warns when package.json declares react-router-dom v3 or older", () => {
    const result = analyze({
      ...V5_APP,
      "package.json": JSON.stringify({ dependencies: { react: "17.0.0", "react-router-dom": "^3.2.0" } }),
    })
    const warnings = unsupportedOf(result)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ file: "package.json" })
    expect(warnings[0]?.message).toContain("'^3.2.0'")
  })

  it("warns when <Route> elements are found but no route root is, whatever the declared range", () => {
    const result = analyze({
      ...ROOTLESS_APP,
      "package.json": JSON.stringify({ dependencies: { react: "17.0.0", "react-router-dom": "*" } }),
    })
    const warnings = unsupportedOf(result)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ file: "src/App.tsx", line: 3 })
  })

  it("warns that a framework mode app/routes.ts is not read", () => {
    const result = analyze({
      ...LAYOUT_PAGES,
      "src/main.tsx": `import { createBrowserRouter } from "react-router-dom"
import { Home } from "./pages"
export const router = createBrowserRouter([{ path: "/", element: <Home /> }])
`,
      "app/routes.ts": `import { type RouteConfig, index } from "@react-router/dev/routes"
export default [index("routes/home.tsx")] satisfies RouteConfig
`,
    })
    const warnings = unsupportedOf(result)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ file: "app/routes.ts" })
  })

  it("stays silent for a v6 app with a route root", () => {
    const result = analyze({
      ...LAYOUT_PAGES,
      "src/main.tsx": `import { createBrowserRouter } from "react-router-dom"
import { Home } from "./pages"
export const router = createBrowserRouter([{ path: "/", element: <Home /> }])
`,
    })
    expect(unsupportedOf(result)).toEqual([])
  })
})
