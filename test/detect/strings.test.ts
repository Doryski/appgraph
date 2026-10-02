import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import { runDetection } from "../../src/detect/index.js"
import { createProjectProbe } from "../../src/detect/project.js"
import {
  STRING_SOURCE_SCAN_LIMITS,
  formatStringSourceTrace,
  probeStringSources,
} from "../../src/detect/strings.js"
import { resolveAppgraphConfig } from "../../src/config/resolve.js"

const ROOT = "/repo"

const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: "." }, include: ["src"] })

const ENUM_PATHS = `export enum Paths {
  ORDERS = '/',
  LOGIN = '/login',
  INVOICES = '/invoices',
}
`

const CONST_PATHS = `export const RoutePaths = {
  clients: '/clients',
  analytics: '/analytics',
  reports: '/analytics/reports',
} as const
`

const FROZEN_PATHS = `export const AdminPaths = Object.freeze({
  users: '/admin/users',
  audit: '/admin/audit',
})
`

const ROUTER = `import { createBrowserRouter } from "react-router-dom"
import { Paths } from "@/shared/helpers/paths"
export const router = createBrowserRouter([{ path: Paths.ORDERS, element: <Home /> }])
`

const probeOf = (files: Readonly<Record<string, string>>) =>
  createProjectProbe({
    ts,
    root: ROOT,
    host: createMemoryHost({
      files: Object.fromEntries(
        Object.entries({ "tsconfig.json": TSCONFIG, "package.json": "{}", ...files }).map(
          ([file, content]) => [`${ROOT}/${file}`, content],
        ),
      ),
    }),
  })

describe("string-source derivation", () => {
  it("finds a string enum of URL paths referenced from the router", () => {
    const result = probeStringSources(
      probeOf({ "src/shared/helpers/paths.ts": ENUM_PATHS, "src/routes/router.tsx": ROUTER }),
    )

    expect(result.files).toEqual(["src/shared/helpers/paths.ts"])
    expect(result.candidates[0]?.containers[0]).toEqual({
      name: "Paths",
      pathMembers: 3,
      members: 3,
      score: 1,
      referencedBy: ["src/routes/router.tsx"],
    })
    expect(result.candidates[0]?.evidence[0]?.line).toBe(1)
  })

  it("reads the `as const` object and `Object.freeze` forms too, and keeps EVERY candidate", () => {
    const result = probeStringSources(
      probeOf({
        "src/shared/helpers/paths.ts": ENUM_PATHS,
        "src/shared/helpers/routePaths.ts": CONST_PATHS,
        "src/shared/helpers/adminPaths.ts": FROZEN_PATHS,
        "src/routes/router.tsx": ROUTER,
        "src/modules/Nav.tsx": `import { RoutePaths } from '@/shared/helpers/routePaths'
import { AdminPaths } from '@/shared/helpers/adminPaths'
import { Link } from 'react-router-dom'
export const Nav = () => <Link to={RoutePaths.clients}>{AdminPaths.users}</Link>
`,
      }),
    )

    expect(result.files).toEqual([
      "src/shared/helpers/adminPaths.ts",
      "src/shared/helpers/paths.ts",
      "src/shared/helpers/routePaths.ts",
    ])
  })

  it("ignores a member table that no navigation site references", () => {
    const result = probeStringSources(
      probeOf({
        "src/shared/helpers/paths.ts": ENUM_PATHS,
        "src/shared/helpers/assets.ts": CONST_PATHS.replace("RoutePaths", "AssetPaths"),
        "src/routes/router.tsx": ROUTER,
      }),
    )

    expect(result.files).toEqual(["src/shared/helpers/paths.ts"])
  })

  it("ignores members whose values are not paths", () => {
    const result = probeStringSources(
      probeOf({
        "src/shared/helpers/labels.ts": `export const Labels = {
  orders: 'Orders',
  login: 'Login',
  root: '/',
} as const
`,
        "src/routes/router.tsx": `import { createBrowserRouter } from "react-router-dom"
import { Labels } from "@/shared/helpers/labels"
export const router = createBrowserRouter([{ path: Labels.root, element: <Home /> }])
`,
      }),
    )

    expect(result.files).toEqual([])
  })

  it("navigation sites are the router, `useNavigate` and link tags — not any importer", () => {
    const result = probeStringSources(
      probeOf({
        "src/shared/helpers/paths.ts": ENUM_PATHS,
        "src/modules/Login/Login.tsx": `import { useNavigate } from 'react-router-dom'
import { Paths } from '@/shared/helpers/paths'
export const Login = () => {
  const navigate = useNavigate()
  return <button onClick={() => navigate(Paths.ORDERS)} />
}
`,
        "src/services/logger.ts": `import { Paths } from '@/shared/helpers/paths'
export const log = () => Paths.LOGIN
`,
      }),
    )

    expect(result.navigationSites).toEqual(["src/modules/Login/Login.tsx"])
    expect(result.files).toEqual(["src/shared/helpers/paths.ts"])
  })

  it("is bounded, and reports what the scan cost", () => {
    const probe = probeOf({ "src/shared/helpers/paths.ts": ENUM_PATHS, "src/routes/router.tsx": ROUTER })
    const bounded = probeStringSources(probe, { maxParsed: 0 })

    expect(bounded.files).toEqual([])
    expect(bounded.filesSkipped).toBe(1)

    const full = probeStringSources(probe)
    expect(full.filesScanned).toBe(2)
    expect(full.filesParsed).toBe(1)
    expect(full.filesSkipped).toBe(0)
    expect(full.bytesRead).toBe(ENUM_PATHS.length + ROUTER.length)
    expect(STRING_SOURCE_SCAN_LIMITS.maxParsed).toBeLessThan(STRING_SOURCE_SCAN_LIMITS.maxFiles)
  })

  it("spends none of the file budget on tests, specs or stories, which sort ahead of the path table", () => {
    const navigatingSpec = `import { useNavigate } from 'react-router-dom'
import { Paths } from '@/shared/helpers/paths'
export const spec = () => useNavigate()(Paths.LOGIN)
`
    const result = probeStringSources(
      probeOf({
        "src/a.spec.tsx": navigatingSpec,
        "src/b.stories.tsx": navigatingSpec,
        "src/mocks/c.ts": navigatingSpec,
        "src/routes/router.tsx": ROUTER,
        "src/shared/helpers/paths.ts": ENUM_PATHS,
      }),
      { maxFiles: 2 },
    )

    expect(result.files).toEqual(["src/shared/helpers/paths.ts"])
    expect(result.navigationSites).toEqual(["src/routes/router.tsx"])
    expect(result.filesScanned).toBe(2)
    expect(result.filesSkipped).toBe(0)
  })

  it("skips a file over the byte budget instead of parsing it", () => {
    const probe = probeOf({ "src/shared/helpers/paths.ts": ENUM_PATHS, "src/routes/router.tsx": ROUTER })
    const result = probeStringSources(probe, { maxBytes: 10 })

    expect(result.files).toEqual([])
    expect(result.filesScanned).toBe(0)
    expect(result.filesSkipped).toBe(2)
  })

  it("the trace names every candidate with its evidence and the scan cost", () => {
    const result = probeStringSources(
      probeOf({ "src/shared/helpers/paths.ts": ENUM_PATHS, "src/routes/router.tsx": ROUTER }),
    )
    const lines = formatStringSourceTrace(result)

    expect(lines[0]).toContain("src/shared/helpers/paths.ts")
    expect(lines[0]).toContain("2 file(s) scanned")
    expect(lines[1]).toContain("Paths: 3/3 path-like member(s)")
    expect(formatStringSourceTrace(null)).toEqual(["string sources: not derived"])
  })
})

describe("string sources reach the resolved config", () => {
  const files = { "src/shared/helpers/paths.ts": ENUM_PATHS, "src/routes/router.tsx": ROUTER }

  const detectionOf = (options: Parameters<typeof runDetection>[0]["stringSources"]) =>
    runDetection({
      ts,
      root: ROOT,
      probe: probeOf(files),
      ...(options === undefined ? {} : { stringSources: options }),
    })

  it("detection carries the derived files and config picks them up without being told", () => {
    const detection = detectionOf(undefined)
    expect(detection.stringSources).toEqual(["src/shared/helpers/paths.ts"])

    const setup = resolveAppgraphConfig({ detection })
    expect(setup.config.stringSources).toEqual(["src/shared/helpers/paths.ts"])
    expect(setup.layers.find((layer) => layer.name === "conventions")?.fields).toContain("stringSources")
  })

  it("a configured file is unioned with the derived ones, never replaced by them", () => {
    const setup = resolveAppgraphConfig({
      detection: detectionOf(undefined),
      configFile: { stringSources: ["src/legacy/paths.ts"] },
    })

    expect(setup.config.stringSources).toEqual(["src/legacy/paths.ts", "src/shared/helpers/paths.ts"])
  })

  it("`stringSources: false` means the probe never ran, distinct from finding nothing", () => {
    const detection = detectionOf(false)
    expect(detection.stringSourceProbe).toBeNull()
    expect(detection.stringSources).toEqual([])
  })
})
