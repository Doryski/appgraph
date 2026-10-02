import ts from "typescript"
import { describe, expect, it } from "vitest"
import type { FileHost } from "../../src/core/host.js"
import { createCachingHost, createMemoryHost } from "../../src/core/host.js"
import { analyze } from "../../src/pipeline/run.js"
import type { AnalyzeResult } from "../../src/pipeline/run.js"

const ROOT = "/repo"

const FILES = {
  "package.json": JSON.stringify({ name: "fixture", dependencies: { react: "19.0.0", "react-router-dom": "6.0.0" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", jsx: "preserve", paths: { "@/*": ["src/*"] } }, include: ["src"] }),
  "src/main.tsx": `
import { RouterProvider } from "react-router-dom"
import { router } from "@/routes/router"
export const App = () => <RouterProvider router={router} />
`,
  "src/routes/router.tsx": `
import { createBrowserRouter } from "react-router-dom"
import { Layout } from "../shell/Layout"
import Home from "../modules/Home"
import Users from "../modules/Users"
import UserDetail from "../modules/Users/Detail"
export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/users", element: <Users /> },
      { path: "/users/:id", element: <UserDetail /> },
    ],
  },
])
`,
  "src/shell/Layout.tsx": `
import { Outlet } from "react-router-dom"
import { Sidebar } from "./Sidebar"
export const Layout = () => <div><Sidebar /><Outlet /></div>
`,
  "src/shell/Sidebar.tsx": `
import { Link } from "react-router-dom"
import { MENU } from "./menu"
export const Sidebar = () => <nav>{MENU.map((item) => <Link key={item.path} to={item.path}>{item.label}</Link>)}</nav>
`,
  "src/shell/menu.ts": `
export const MENU = [
  { path: "/", label: "Home" },
  { path: "/users", label: "Users" },
  { path: "/missing", label: "Missing" },
]
`,
  "src/modules/Home/index.tsx": `
import { Link } from "react-router-dom"
import { Card } from "../../ui/Card"
export default function Home() { return <Card><Link to="/users">Users</Link></Card> }
`,
  "src/modules/Users/index.tsx": `
import { useNavigate } from "react-router-dom"
import { Card } from "../../ui/Card"
export default function Users() { const navigate = useNavigate(); return <Card onClick={() => navigate("/users/1")} /> }
`,
  "src/modules/Users/Detail.tsx": `
import { Card } from "@/ui/Card"
export default function UserDetail() { return <Card /> }
`,
  "src/ui/Card.tsx": "export const Card = (props: { children?: unknown; onClick?: () => void }) => <div>{props.children}</div>\n",
}

const memoryHost = (): FileHost =>
  createMemoryHost({ files: Object.fromEntries(Object.entries(FILES).map(([file, text]) => [`${ROOT}/${file}`, text])) })

const countingHost = (inner: FileHost) => {
  const reads = new Map<string, number>()
  const listings = new Map<string, number>()
  const bump = (counts: Map<string, number>, abs: string) => counts.set(abs, (counts.get(abs) ?? 0) + 1)
  const host: FileHost = {
    ...inner,
    readFile: (abs) => {
      bump(reads, abs)
      return inner.readFile(abs)
    },
    readDir: (abs) => {
      bump(listings, abs)
      return inner.readDir(abs)
    },
  }
  return { host, reads, listings }
}

const run = (host: FileHost): Promise<AnalyzeResult> =>
  analyze({ ts, root: ROOT, host, config: { formats: ["full", "index"] } })

const snapshotOf = (result: AnalyzeResult) => ({
  files: result.files,
  diagnostics: result.diagnostics,
  trace: result.trace,
  exitCode: result.exitCode,
})

describe("I/O budget of one analyze() run", () => {
  it("reads each file and lists each directory at most once", async () => {
    const { host, reads, listings } = countingHost(memoryHost())

    const result = await run(host)

    expect(result.graph.screens.length).toBeGreaterThan(0)
    expect(reads.size).toBeGreaterThan(0)
    expect(listings.size).toBeGreaterThan(0)
    expect([...reads].filter(([, count]) => count > 1)).toEqual([])
    expect([...listings].filter(([, count]) => count > 1)).toEqual([])
  })

  it("produces the same output when the host is already wrapped in a caching host", async () => {
    const plain = await run(memoryHost())
    const cached = await run(createCachingHost(memoryHost()))

    expect(snapshotOf(cached)).toEqual(snapshotOf(plain))
  })
})
