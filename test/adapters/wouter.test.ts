import ts from "typescript"
import { describe, expect, it } from "vitest"
import type { Screen } from "../../src/core/model.js"
import { createMemoryHost } from "../../src/core/host.js"
import { createReactRouterAdapter, createWouterAdapter, detectWouter } from "../../src/adapters/react-router.js"
import { createProjectProbe } from "../../src/detect/project.js"
import { ROOT, run, withProject } from "../pipeline/harness.js"

const WOUTER_PACKAGE = JSON.stringify({ name: "fixture", dependencies: { wouter: "3.3.0", react: "18" } })

const PAGES = {
  "src/pages.tsx": ["Home", "User", "Orders", "Profile", "NotFound", "Search", "Legacy", "About", "Settings", "AdminUsers", "Login", "Report"]
    .map((name) => `export const ${name} = () => <div />\n`)
    .join(""),
}

const analyze = (files: Readonly<Record<string, string>>, manifest = WOUTER_PACKAGE) =>
  run({ files: { "package.json": manifest, ...PAGES, ...files }, adapters: [createWouterAdapter()] })

type Result = ReturnType<typeof analyze>

const urlsOf = (result: Result): readonly (string | null)[] => result.graph.screens.map((screen) => screen.url)

const screenAt = (result: Result, url: string): Screen | undefined =>
  result.graph.screens.find((screen) => screen.url === url)

const entryNamesOf = (screen: Screen | undefined): readonly string[] =>
  (screen?.entries ?? []).flatMap((entry) => (entry.kind === "file" ? [entry.exportName] : []))

const unsupportedOf = (result: Result) =>
  result.diagnostics.filter((entry) => entry.code === "screens/unsupported-router-style")

describe("wouter: a <Switch> root", () => {
  const result = analyze({
    "src/App.tsx": `import { Route, Switch } from "wouter"
import { Home, Legacy, NotFound, Orders, Profile, Search, User } from "./pages"
export default function App() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/users/:id" component={User} />
      <Route path="/orders/*?" component={Orders} />
      <Route path="/u/:id?" component={Profile} />
      <Route path="/search">{(params) => <Search query={params.q} />}</Route>
      <Route path={/^\\/legacy\\/(\\d+)$/} component={Legacy} />
      <Route component={NotFound} />
    </Switch>
  )
}
`,
  })

  it("reads each route's wouter path, with a pathless route as the catch-all", () => {
    expect(urlsOf(result)).toEqual(["/", "/*", "/orders/*", "/search", "/u/:id?", "/users/:id"])
  })

  it("takes the component prop and a function child's returned JSX as the entry", () => {
    expect(entryNamesOf(screenAt(result, "/users/:id"))).toEqual(["User"])
    expect(entryNamesOf(screenAt(result, "/search"))).toEqual(["Search"])
    expect(entryNamesOf(screenAt(result, "/*"))).toEqual(["NotFound"])
  })

  it("reports a regex path as an unsupported router style", () => {
    const [diagnostic] = unsupportedOf(result)
    expect(diagnostic?.severity).toBe("warning")
    expect(diagnostic?.message).toContain("legacy")
  })
})

describe("wouter: loose routes outside a <Switch>", () => {
  const result = analyze({
    "src/App.tsx": `import { Route, Switch } from "wouter"
import { About, Home, Report, Search } from "./pages"
import { Header } from "./Header"
export default function App() {
  return (
    <>
      <Header />
      <Route path="/about" component={About} />
      <Route path="/search"><Search /></Route>
      <main>
        <Switch>
          <Route path="/" component={Home} />
        </Switch>
        <Route path="/report" component={Report} />
      </main>
    </>
  )
}
`,
    "src/Header.tsx": "export const Header = () => <nav />\n",
  })

  it("reads every loose group and the Switch as top-level lists", () => {
    expect(urlsOf(result)).toEqual(["/", "/about", "/report", "/search"])
    expect(entryNamesOf(screenAt(result, "/search"))).toEqual(["Search"])
  })

  it("raises no withdrawal or unsupported warning", () => {
    expect(result.diagnostics.filter((entry) => entry.severity === "warning")).toEqual([])
  })
})

describe("wouter: nest and base", () => {
  const result = analyze({
    "src/App.tsx": `import { Route, Router, Switch } from "wouter"
import { Home, Settings } from "./pages"
import { AdminShell } from "./AdminShell"
export default function App() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/app" nest>
        <Route path="/settings" component={Settings} />
      </Route>
      <Route path="/admin" nest component={AdminShell} />
    </Switch>
  )
}
`,
    "src/AdminShell.tsx": `import { Route, Switch } from "wouter"
import { AdminUsers } from "./pages"
export const AdminShell = () => (
  <Switch>
    <Route path="/users" component={AdminUsers} />
  </Switch>
)
`,
    "src/Portal.tsx": `import { Route, Router, Switch } from "wouter"
import { Login, Report } from "./pages"
export const Portal = () => (
  <Router base="/portal">
    <Switch>
      <Route path="/login" component={Login} />
    </Switch>
    <Router base="/reports">
      <Route path="/:id" component={Report} />
    </Router>
  </Router>
)
`,
  })

  it("resolves a nest route's JSX children and its component's Switch under its path", () => {
    expect(screenAt(result, "/app/settings")).toBeDefined()
    expect(entryNamesOf(screenAt(result, "/admin/users"))).toEqual(["AdminUsers"])
  })

  it("prefixes every route under <Router base>, nested bases stacking", () => {
    expect(entryNamesOf(screenAt(result, "/portal/login"))).toEqual(["Login"])
    expect(entryNamesOf(screenAt(result, "/portal/reports/:id"))).toEqual(["Report"])
  })

  it("reads no route at its unprefixed path", () => {
    expect(urlsOf(result)).not.toContain("/settings")
    expect(urlsOf(result)).not.toContain("/users")
    expect(urlsOf(result)).not.toContain("/login")
  })
})

describe("wouter: redirects", () => {
  const result = analyze({
    "src/App.tsx": `import { Redirect, Route, Switch } from "wouter"
import { Login } from "./pages"
export default function App() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/old"><Redirect to="/login" /></Route>
      <Redirect to="/login" />
    </Switch>
  )
}
`,
  })

  it("reads a <Redirect> without a path in a Switch as the catch-all redirect", () => {
    expect(screenAt(result, "/*")?.redirectTo).toBe("/login")
  })

  it("reads a wouter <Redirect> inside a route's element as its redirect", () => {
    expect(screenAt(result, "/old")?.redirectTo).toBe("/login")
    expect(entryNamesOf(screenAt(result, "/old"))).toEqual([])
  })
})

describe("wouter: redirects under <Router base>", () => {
  const result = analyze({
    "src/App.tsx": `import { Redirect, Route, Router, Switch } from "wouter"
import { Home, Login } from "./pages"
export default function App() {
  return (
    <Router base="/admin">
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/login" component={Login} />
        <Route path="/old"><Redirect to="/login" /></Route>
        <Route path="/out"><Redirect to="~/login" /></Route>
        <Redirect to="/" />
      </Switch>
    </Router>
  )
}
`,
  })

  it("prefixes a redirect target with the enclosing base", () => {
    expect(screenAt(result, "/admin/*")?.redirectTo).toBe("/admin")
    expect(screenAt(result, "/admin/old")?.redirectTo).toBe("/admin/login")
  })

  it("reads a `~/` target as absolute, outside the base", () => {
    expect(screenAt(result, "/admin/out")?.redirectTo).toBe("/login")
  })

  it("reports once, as info, that navigation targets under the base are not prefixed", () => {
    const notes = unsupportedOf(result).filter((entry) => entry.message.includes("base-relative"))
    expect(notes.map((entry) => [entry.severity, entry.file])).toEqual([["info", "src/App.tsx"]])
  })
})

describe("wouter: route components declared beside the router", () => {
  const result = analyze({
    "src/App.tsx": `import { Route, Switch } from "wouter"
import { Home } from "./Home"
import { Login } from "./pages"
const User = () => <div>User</div>
const Framed = () => <Frame />
const Frame = () => <Login />
export default function App() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/users/:id" component={User} />
      <Route path="/framed" component={Framed} />
    </Switch>
  )
}
`,
    "src/Home.tsx": `import { Link, useLocation } from "wouter"
export function Home() {
  const [, navigate] = useLocation()
  return <button onClick={() => navigate("/users/1")}><Link href="/framed">x</Link></button>
}
`,
  })

  it("roots a same-file component at the whole router file, without the pages the router only registers", () => {
    expect(screenAt(result, "/users/:id")?.reachable).toEqual(["src/App.tsx"])
  })

  it("keeps the routed screen's own navigations on it alone", () => {
    expect(screenAt(result, "/")?.navigatesTo.map((edge) => edge.to)).toEqual(["/framed", "/users/1"])
  })

  it("keeps a component built from same-file helpers whole-file", () => {
    expect(screenAt(result, "/framed")?.reachable).toContain("src/pages.tsx")
  })
})

describe("wouter: dependency gate and detection", () => {
  const APP = `import { Route, Switch } from "wouter"
import { Home } from "./pages"
export const App = () => (
  <Switch>
    <Route path="/" component={Home} />
  </Switch>
)
`

  const detect = (files: Readonly<Record<string, string>>) =>
    detectWouter(createProjectProbe({ ts, root: ROOT, host: createMemoryHost({ files: withProject(files) }) }).context)

  it("scores 80 with a wouter dependency and a file importing wouter's <Switch>/<Route>", () => {
    const detection = detect({ "package.json": WOUTER_PACKAGE, "src/App.tsx": APP })
    expect(detection.score).toBe(80)
    expect(detection.evidence.map((entry) => entry.what)).toEqual(["wouter dependency", "JSX wouter <Switch>/<Route> element"])
  })

  it("scores 0 without the dependency, or without a wouter route element", () => {
    expect(detect({ "src/App.tsx": APP }).score).toBe(0)
    expect(detect({ "package.json": WOUTER_PACKAGE, "src/App.tsx": "export const App = () => <div />\n" }).score).toBe(0)
  })

  it("discovers nothing without the wouter dependency", () => {
    const result = analyze({ "src/App.tsx": APP }, JSON.stringify({ name: "fixture", dependencies: { react: "18" } }))
    expect(result.graph.screens).toEqual([])
  })

  it("leaves a react-router project's screens unchanged when both adapters run", () => {
    const files = {
      ...PAGES,
      "src/App.tsx": `import { BrowserRouter, Route, Routes } from "react-router-dom"
import { Home, User } from "./pages"
export const App = () => (
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/users/:id" element={<User />} />
    </Routes>
  </BrowserRouter>
)
`,
    }
    const alone = run({ files, adapters: [createReactRouterAdapter()] })
    const both = run({ files, adapters: [createReactRouterAdapter(), createWouterAdapter()] })
    expect(both.graph.screens).toEqual(alone.graph.screens)
    expect(urlsOf(both)).toEqual(["/", "/users/:id"])
  })
})
