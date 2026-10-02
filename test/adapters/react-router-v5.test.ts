import { describe, expect, it } from "vitest"
import type { Screen } from "../../src/core/model.js"
import { DEFAULT_WRAPPER_RULES, createReactRouterAdapter } from "../../src/adapters/react-router.js"
import type { WrapperRule } from "../../src/adapters/react-router.js"
import { codes, run } from "../pipeline/harness.js"

const V5_PACKAGE = JSON.stringify({
  name: "fixture",
  dependencies: { react: "17.0.2", "react-router-dom": "5.3.4" },
})

const COMPAT_PACKAGE = JSON.stringify({
  name: "fixture",
  dependencies: { react: "17.0.2", "react-router-dom": "5.3.4", "react-router-dom-v5-compat": "6.30.0" },
})

const PRIVATE_ROUTE: WrapperRule = { name: "private-route", role: "guard", tagRegex: "^PrivateRoute$" }

const analyze = (files: Readonly<Record<string, string>>, wrappers?: readonly WrapperRule[]) =>
  run({
    files: { "package.json": V5_PACKAGE, ...files },
    adapters: [createReactRouterAdapter(wrappers === undefined ? {} : { wrappers })],
  })

type Result = ReturnType<typeof analyze>

const urlsOf = (result: Result): readonly (string | null)[] => result.graph.screens.map((screen) => screen.url)

const screenAt = (result: Result, url: string): Screen | undefined =>
  result.graph.screens.find((screen) => screen.url === url)

const entryFilesOf = (screen: Screen | undefined): readonly string[] =>
  (screen?.entries ?? []).flatMap((entry) => (entry.kind === "file" ? [`${entry.file}#${entry.exportName}`] : []))

const evidenceOf = (screen: Screen | undefined): readonly string[] =>
  (screen?.provenance.evidence ?? []).map((entry) => entry.what)

const unsupportedOf = (result: Result, severity: "warning" | "info") =>
  result.diagnostics.filter((entry) => entry.code === "screens/unsupported-router-style" && entry.severity === severity)

const RUNTIME_GATE_TEXT = "route data is filtered or chosen at runtime"

const hasRuntimeGate = (screen: Screen | undefined): boolean =>
  evidenceOf(screen).some((what) => what.startsWith(RUNTIME_GATE_TEXT))

const PAGES = {
  "src/pages.tsx": [
    "Home",
    "Alerts",
    "Settings",
    "Trace",
    "NotFound",
    "Welcome",
    "ChartList",
    "Tags",
    "Roles",
    "General",
    "Billing",
    "Team",
    "Audit",
    "Legacy",
    "List",
    "Item",
    "Multi",
    "RenderPage",
    "ChildPage",
  ]
    .map((name) => `export const ${name} = () => <div />\n`)
    .join(""),
}

describe("react-router v5: SigNoz-shaped useState route data under a guard", () => {
  const files = {
    ...PAGES,
    "src/constants/routes.ts": `const ROUTES = {
  HOME: "/home",
  ALERTS: "/alerts/:alertId?",
  SETTINGS: "/settings?tab=general",
  TRACE: "/trace/:id(\\\\w+)",
} as const
export default ROUTES
`,
    "src/AppRoutes/routes.ts": `import ROUTES from "../constants/routes"
import { Alerts, Home, Settings, Trace } from "../pages"
const routes = [
  { path: ROUTES.HOME, exact: true, component: Home, key: "HOME" },
  { path: ROUTES.ALERTS, exact: true, component: Alerts, key: "ALERTS" },
  { path: ROUTES.SETTINGS, exact: true, component: Settings, key: "SETTINGS" },
  { path: ROUTES.TRACE, exact: false, component: Trace, key: "TRACE" },
]
export default routes
`,
    "src/AppRoutes/Private.tsx": "export default function PrivateRoute({ children }) { return <>{children}</> }\n",
    "src/AppRoutes/index.tsx": `import { useEffect, useState } from "react"
import { Route, Switch } from "react-router-dom"
import defaultRoutes from "./routes"
import PrivateRoute from "./Private"
import { Home, NotFound } from "../pages"
export default function App({ isCloud }) {
  const [routes, setRoutes] = useState(defaultRoutes)
  useEffect(() => {
    if (!isCloud) setRoutes(defaultRoutes.filter((route) => route.key !== "ALERTS"))
  }, [isCloud])
  return (
    <PrivateRoute>
      <Switch>
        {routes.map(({ path, component, exact }) => (
          <Route key={path} exact={exact} path={path} component={component} />
        ))}
        <Route exact path="/" component={Home} />
        <Route path="*" component={NotFound} />
      </Switch>
    </PrivateRoute>
  )
}
`,
  }

  const result = analyze(files, [...DEFAULT_WRAPPER_RULES, PRIVATE_ROUTE])

  it("reads every mapped item plus the literal routes, in path-to-regexp syntax", () => {
    expect([...urlsOf(result)].sort()).toEqual(["/", "/*", "/alerts/:alertId?", "/home", "/settings", "/trace/:id"])
    expect(entryFilesOf(screenAt(result, "/home"))).toEqual(["src/pages.tsx#Home"])
    expect(entryFilesOf(screenAt(result, "/*"))).toEqual(["src/pages.tsx#NotFound"])
  })

  it("protects every route through the guard enclosing the <Switch>", () => {
    expect(result.graph.screens.map((screen) => screen.auth)).toEqual(result.graph.screens.map(() => "protected"))
  })

  it("protects the routes under <PrivateRoute><Switch> with the default rules alone", () => {
    const defaults = analyze(files)
    expect(defaults.graph.screens).toHaveLength(result.graph.screens.length)
    expect(defaults.graph.screens.map((screen) => screen.auth)).toEqual(defaults.graph.screens.map(() => "protected"))
  })

  it("marks useState route data as a runtime gate and records `exact` as evidence", () => {
    expect(hasRuntimeGate(screenAt(result, "/home"))).toBe(true)
    expect(hasRuntimeGate(screenAt(result, "/"))).toBe(false)
    expect(evidenceOf(screenAt(result, "/home"))).toContain("react-router v5 `exact` attribute")
  })

  it("strips a query string from a path with an info at the route data item", () => {
    const infos = unsupportedOf(result, "info")
    expect(infos).toHaveLength(1)
    expect(infos[0]).toMatchObject({ file: "src/AppRoutes/routes.ts", line: 6 })
    expect(infos[0]?.message).toContain("'/settings?tab=general'")
  })

  it("reports no legacy-version or rootless warning for a v5 project", () => {
    expect(unsupportedOf(result, "warning")).toEqual([])
    expect(codes(result)).not.toContain("plugin/threw")
  })

  it("unwraps a lazy useState initializer the same way", () => {
    const lazy = analyze({
      ...files,
      "src/AppRoutes/index.tsx": files["src/AppRoutes/index.tsx"].replace(
        "useState(defaultRoutes)",
        "useState(() => defaultRoutes)",
      ),
    })
    expect(urlsOf(lazy)).toEqual(urlsOf(result))
  })
})

describe("react-router v5: superset-shaped children elements, gated pushes and <Redirect from>", () => {
  const result = analyze({
    ...PAGES,
    "src/views/routePaths.ts": `export const RoutePaths = {
  WELCOME: "/welcome/",
  CHARTS: "/chart/list/",
  TAGS: "/superset/tags/",
  ROLES: "/roles/",
} as const
`,
    "src/flags.ts": "export const isFeatureEnabled = (flag: string): boolean => flag.length > 0\n",
    "src/views/routes.tsx": `import { RoutePaths } from "./routePaths"
import { ChartList, Roles, Tags, Welcome } from "../pages"
import { isFeatureEnabled } from "../flags"
export const routes = [
  { path: RoutePaths.WELCOME, Component: Welcome },
  { path: RoutePaths.CHARTS, Component: ChartList },
]
if (isFeatureEnabled("TaggingSystem")) {
  routes.push({ path: RoutePaths.TAGS, Component: Tags })
}
routes.push({ path: RoutePaths.ROLES, Component: Roles })
`,
    "src/views/App.tsx": `import { Redirect, Route, Switch } from "react-router-dom"
import { routes } from "./routes"
export const RouteSwitch = () => (
  <Switch>
    {routes.map(({ path, Component }) => (
      <Route path={path} key={path}>
        <Component />
      </Route>
    ))}
    <Redirect from="/" to="/welcome/" exact />
  </Switch>
)
`,
  })

  it("reads the array, then every push, with the item's Component as the element", () => {
    expect([...urlsOf(result)].sort()).toEqual(["/", "/chart/list", "/roles", "/superset/tags", "/welcome"])
    expect(entryFilesOf(screenAt(result, "/welcome"))).toEqual(["src/pages.tsx#Welcome"])
    expect(entryFilesOf(screenAt(result, "/superset/tags"))).toEqual(["src/pages.tsx#Tags"])
  })

  it("gates a pushed item by its enclosing `if`, and only that item", () => {
    const tags = screenAt(result, "/superset/tags")
    expect(hasRuntimeGate(tags)).toBe(true)
    expect(tags?.provenance.evidence.find((entry) => entry.what.startsWith(RUNTIME_GATE_TEXT))).toMatchObject({
      file: "src/views/routes.tsx",
      line: 8,
    })
    expect(hasRuntimeGate(screenAt(result, "/roles"))).toBe(false)
    expect(hasRuntimeGate(screenAt(result, "/welcome"))).toBe(false)
  })

  it("reads <Redirect from to> as a redirect screen", () => {
    const root = screenAt(result, "/")
    expect(root?.redirectTo).toBe("/welcome")
    expect(root?.entries).toEqual([])
  })
})

describe("react-router v5: nested <Switch> under a prefix-matching route", () => {
  const result = analyze({
    ...PAGES,
    "src/Settings.tsx": `import { Route, Switch, useRouteMatch } from "react-router-dom"
import { Audit, Billing, General, Team } from "./pages"
import { baseOf } from "./base"
export const Settings = ({ match }) => {
  const { path } = useRouteMatch()
  const base = baseOf(match)
  return (
    <Switch>
      <Route exact path={match.path} component={General} />
      <Route path={\`\${match.path}/billing\`} component={Billing} />
      <Route path={\`\${path}/team/:id\`} component={Team} />
      <Route path={\`\${useRouteMatch().path}/audit\`} component={Audit} />
      <Route path={\`\${base}/other\`} component={Audit} />
    </Switch>
  )
}
`,
    "src/base.ts": "export const baseOf = (match: { url: string }): string => match.url\n",
    "src/App.tsx": `import { BrowserRouter, Route, Switch } from "react-router-dom"
import { Home } from "./pages"
import { Settings } from "./Settings"
export const App = () => (
  <BrowserRouter>
    <Switch>
      <Route path="/settings" component={Settings} />
      <Route exact path="/" component={Home} />
    </Switch>
  </BrowserRouter>
)
`,
  })

  it("joins `${match.path}`, `${path}` and `${useRouteMatch().path}` onto the matched route", () => {
    expect([...urlsOf(result)].filter((url) => url !== null).sort()).toEqual([
      "/",
      "/settings",
      "/settings/audit",
      "/settings/billing",
      "/settings/team/:id",
    ])
    expect(entryFilesOf(screenAt(result, "/settings"))).toEqual(["src/pages.tsx#General"])
  })

  it("warns about any other template path", () => {
    const warnings = unsupportedOf(result, "warning")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ file: "src/Settings.tsx", line: 13 })
  })
})

describe("react-router v5: a v5 <Switch> and a v6 <Routes> in one project", () => {
  const result = run({
    files: {
      "package.json": COMPAT_PACKAGE,
      ...PAGES,
      "src/Modern.tsx": `import { Route, Routes } from "react-router-dom-v5-compat"
import { Item, List } from "./pages"
export const Modern = () => (
  <Routes>
    <Route path="list" element={<List />} />
    <Route path=":id" element={<Item />} />
  </Routes>
)
`,
      "src/App.tsx": `import { BrowserRouter, Route, Switch } from "react-router-dom"
import { CompatRouter } from "react-router-dom-v5-compat"
import { Legacy } from "./pages"
import { Modern } from "./Modern"
export const App = () => (
  <BrowserRouter>
    <CompatRouter>
      <Switch>
        <Route path="/legacy" component={Legacy} />
        <Route path="/modern" component={Modern} />
      </Switch>
    </CompatRouter>
  </BrowserRouter>
)
`,
    },
    adapters: [createReactRouterAdapter()],
  })

  it("reads each root by its own flavour, nesting the v6 list under the v5 route", () => {
    expect([...urlsOf(result)].sort()).toEqual(["/legacy", "/modern", "/modern/:id", "/modern/list"])
    expect(entryFilesOf(screenAt(result, "/modern/list"))).toEqual(["src/pages.tsx#List"])
    expect(unsupportedOf(result, "warning")).toEqual([])
  })
})

describe("react-router v5: path arrays, render props, function children and catch-all redirects", () => {
  const result = analyze({
    ...PAGES,
    "src/App.tsx": `import { Redirect, Route, Switch } from "react-router-dom"
import { Switch as Toggle } from "antd"
import { ChildPage, Multi, RenderPage } from "./pages"
export const App = () => (
  <Switch>
    <Route path={["/a", "/b/:id"]} component={Multi} />
    <Route path="/r" render={() => <RenderPage />} />
    <Route path="/gone" render={() => <Redirect to="/r" />} />
    <Route path="/c">{() => <ChildPage />}</Route>
    <Route path="/toggle" render={() => <Toggle checked />} />
    <Redirect to="/a" />
  </Switch>
)
`,
  })

  it("declares one route per path of a path array, in array order", () => {
    expect(entryFilesOf(screenAt(result, "/a"))).toEqual(["src/pages.tsx#Multi"])
    expect(entryFilesOf(screenAt(result, "/b/:id"))).toEqual(["src/pages.tsx#Multi"])
  })

  it("reads the JSX a render prop or a function child returns as the element", () => {
    expect(entryFilesOf(screenAt(result, "/r"))).toEqual(["src/pages.tsx#RenderPage"])
    expect(entryFilesOf(screenAt(result, "/c"))).toEqual(["src/pages.tsx#ChildPage"])
    expect(screenAt(result, "/gone")?.redirectTo).toBe("/r")
  })

  it("reads a <Redirect> without `from` as a catch-all redirect", () => {
    expect(screenAt(result, "/*")?.redirectTo).toBe("/a")
  })

  it("does not root a list at a <Switch> imported from elsewhere", () => {
    expect([...urlsOf(result)].sort()).toEqual(["/*", "/a", "/b/:id", "/c", "/gone", "/r", "/toggle"])
    expect(unsupportedOf(result, "warning")).toEqual([])
  })
})

describe("react-router v5: route components declared beside the <Switch>", () => {
  const result = analyze({
    "src/App.tsx": `import { BrowserRouter, Route, Switch } from "react-router-dom"
import { Home } from "./Home"
const User = () => <div>User</div>
export default function App() {
  return (
    <BrowserRouter>
      <Switch>
        <Route exact path="/" component={Home} />
        <Route path="/users/:id" component={User} />
      </Switch>
    </BrowserRouter>
  )
}
`,
    "src/Home.tsx": `import { Link } from "react-router-dom"
export const Home = () => <Link to="/users/1">user</Link>
`,
  })

  it("roots a same-file component at the whole router file", () => {
    expect(screenAt(result, "/users/:id")?.reachable).toEqual(["src/App.tsx"])
  })
})
