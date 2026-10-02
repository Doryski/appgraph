import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import {
  BUILTIN_SOURCE_PROBES,
  SOURCE_SCORES,
  detectAdminJs,
  detectStateScreens,
  detectTanStackRouter,
  formatDetectionTrace,
  formatSourceChoice,
  runDetection,
} from "../../src/detect/index.js"
import { createProjectProbe } from "../../src/detect/project.js"
import {
  DETECT_SCORE_LAST_RESORT,
  DETECT_SCORE_MV3_BONUS,
} from "../../src/adapters/state-screens.js"

/** state-screens is ALWAYS applicable (the last resort) and adds the MV3 bonus on top. */
const STATE_SCREENS_MV3 = DETECT_SCORE_LAST_RESORT + DETECT_SCORE_MV3_BONUS

const ROOT = "/repo"

const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: "." }, include: ["src"] })

const manifest = (dependencies: Readonly<Record<string, string>>): string =>
  JSON.stringify({ name: "fixture", dependencies })

const project = (files: Readonly<Record<string, string>>, symlinks?: readonly string[]) =>
  createProjectProbe({
    ts,
    root: ROOT,
    host: createMemoryHost({
      files: Object.fromEntries(Object.entries(files).map(([file, content]) => [`${ROOT}/${file}`, content])),
      ...(symlinks === undefined ? {} : { symlinks: symlinks.map((entry) => `${ROOT}/${entry}`) }),
    }),
  })

const detect = (files: Readonly<Record<string, string>>) =>
  runDetection({ ts, root: ROOT, probe: project({ "tsconfig.json": TSCONFIG, ...files }) })

const scoreOf = (files: Readonly<Record<string, string>>, source: string): number =>
  detect(files).detections.find((entry) => entry.source === source)?.score ?? -1

const MV3 = JSON.stringify(
  { manifest_version: 3, name: "ext", action: { default_popup: "popup.html" } },
  null,
  2,
)

const PWA = JSON.stringify({ name: "app", icons: [], start_url: "/", display: "standalone" })

const ROUTER = `import { createBrowserRouter } from "react-router-dom"
export const router = createBrowserRouter([{ path: "/", element: <Home /> }])
`

const JSX_ROUTER = `import { Routes, Route } from "react-router-dom"
export const App = () => (
  <Routes>
    <Route path="/" element={<Home />} />
  </Routes>
)
`

describe("scoring table", () => {
  it("next dep + an app-router page.tsx scores 100", () => {
    expect(
      scoreOf(
        { "package.json": manifest({ next: "15.0.0" }), "src/app/page.tsx": "export default () => null" },
        "next-app",
      ),
    ).toBe(SOURCE_SCORES.fileConvention)
  })

  it("next dep + a pages-router page scores next-pages 100", () => {
    expect(
      scoreOf(
        { "package.json": manifest({ next: "15.0.0" }), "pages/orders/[id].tsx": "export default () => null" },
        "next-pages",
      ),
    ).toBe(SOURCE_SCORES.fileConvention)
  })

  it("a framework dependency + an app/routes.ts config scores react-router-framework 100", () => {
    expect(
      scoreOf(
        {
          "package.json": manifest({ "@react-router/dev": "7.0.0", "react-router": "7.0.0" }),
          "app/routes.ts": 'export default [index("routes/home.tsx")]',
          "app/routes/home.tsx": "export default () => null",
        },
        "react-router-framework",
      ),
    ).toBe(SOURCE_SCORES.fileConvention)
  })

  it("expo-router dep + an app/ route file scores 100, alone among the sources", () => {
    const detection = detect({
      "package.json": manifest({ expo: "54.0.0", "expo-router": "6.0.0", react: "19.0.0" }),
      "app/_layout.tsx": "export default () => null",
      "app/index.tsx": "export default () => null",
      "app/items/page.tsx": "export default () => null",
    })
    expect(detection.detections.find((entry) => entry.source === "expo-router")?.score).toBe(
      SOURCE_SCORES.fileConvention,
    )
    expect(detection.liveSources).toEqual(["expo-router"])
  })

  it("an app/ route tree without the expo-router dependency scores 0 for expo-router", () => {
    expect(scoreOf({ "package.json": manifest({ react: "19.0.0" }), "app/index.tsx": "export {}" }, "expo-router")).toBe(
      SOURCE_SCORES.none,
    )
  })

  it("a @react-navigation dependency + a navigator factory call scores 90, alone among the sources", () => {
    const detection = detect({
      "package.json": manifest({ "@react-navigation/native": "7.0.0", "@react-navigation/native-stack": "7.0.0" }),
      "src/Navigation.tsx":
        'import { createNativeStackNavigator } from "@react-navigation/native-stack"\nexport const Stack = createNativeStackNavigator()\n',
    })
    expect(detection.detections.find((entry) => entry.source === "react-navigation")?.score).toBe(
      SOURCE_SCORES.dataRouter,
    )
    expect(detection.liveSources).toEqual(["react-navigation"])
  })

  it("react-navigation scores 0 when expo-router is a dependency, so an Expo app has one live source", () => {
    const detection = detect({
      "package.json": manifest({ "expo-router": "6.0.0", "@react-navigation/native": "7.0.0" }),
      "app/index.tsx": "export default () => null",
      "src/Tabs.tsx": 'import { createBottomTabNavigator } from "@react-navigation/bottom-tabs"\nexport const Tabs = createBottomTabNavigator()\n',
    })
    expect(detection.detections.find((entry) => entry.source === "react-navigation")?.score).toBe(SOURCE_SCORES.none)
    expect(detection.liveSources).toEqual(["expo-router"])
  })

  it("a @react-navigation dependency without a navigator factory scores 0", () => {
    expect(
      scoreOf({ "package.json": manifest({ "@react-navigation/native": "7.0.0" }), "src/main.tsx": "export {}" }, "react-navigation"),
    ).toBe(SOURCE_SCORES.none)
  })

  it("next without an app-router page scores 0", () => {
    expect(scoreOf({ "package.json": manifest({ next: "15.0.0" }), "src/main.tsx": "export {}" }, "next-app")).toBe(
      SOURCE_SCORES.none,
    )
  })

  it("tanstack dep + createFileRoute( scores 100", () => {
    const files = {
      "package.json": manifest({ "@tanstack/react-router": "1.0.0" }),
      "src/routes/index.tsx": 'export const Route = createFileRoute("/")({})',
    }
    expect(scoreOf(files, "tanstack-router")).toBe(SOURCE_SCORES.fileConvention)
    const evidence = detect(files).detections.find((entry) => entry.source === "tanstack-router")?.evidence ?? []
    expect(evidence.map((entry) => entry.what)).toContain("createFileRoute call")
  })

  it("react-start also enables the tanstack probe", () => {
    const probe = project({
      "tsconfig.json": TSCONFIG,
      "package.json": manifest({ "@tanstack/react-start": "1.0.0" }),
      "src/routes/a.tsx": 'createFileRoute("/a")',
    })
    expect(detectTanStackRouter(probe.context).score).toBe(SOURCE_SCORES.fileConvention)
  })

  it("tanstack dep with no createFileRoute scores 0", () => {
    expect(
      scoreOf(
        { "package.json": manifest({ "@tanstack/react-router": "1.0.0" }), "src/main.tsx": "export {}" },
        "tanstack-router",
      ),
    ).toBe(SOURCE_SCORES.none)
  })

  it("adminjs dep + an object with resources AND rootPath scores 100", () => {
    expect(
      scoreOf(
        {
          "package.json": manifest({ adminjs: "7.0.0" }),
          "src/admin/index.ts": 'export const options = { resources: [], rootPath: "/admin" }',
        },
        "adminjs",
      ),
    ).toBe(SOURCE_SCORES.fileConvention)
  })

  it("adminjs dep with the two properties on different objects scores 0", () => {
    const sameFile = project({
      "tsconfig.json": TSCONFIG,
      "package.json": manifest({ adminjs: "7.0.0" }),
      "src/admin/index.ts": 'export const options = { resources: [] }\nconst other = { rootPath: "/admin" }',
    })
    expect(detectAdminJs(sameFile.context).score).toBe(SOURCE_SCORES.none)

    const split = project({
      "tsconfig.json": TSCONFIG,
      "package.json": manifest({ adminjs: "7.0.0" }),
      "src/a.ts": "export const a = { resources: [] }",
      "src/b.ts": 'export const b = { rootPath: "/admin" }',
    })
    expect(detectAdminJs(split.context).score).toBe(SOURCE_SCORES.none)
  })

  it("react-router dep + a literal data-router factory scores 90", () => {
    expect(
      scoreOf({ "package.json": manifest({ "react-router-dom": "6.0.0" }), "src/router.tsx": ROUTER }, "react-router"),
    ).toBe(SOURCE_SCORES.dataRouter)
  })

  it("react-router dep with only JSX <Routes> scores 80, is live and raises no refusal", () => {
    const files = { "package.json": manifest({ "react-router-dom": "6.0.0" }), "src/App.tsx": JSX_ROUTER }
    expect(scoreOf(files, "react-router")).toBe(SOURCE_SCORES.jsxRouter)

    const detection = detect(files)
    expect(detection.liveSources).toEqual(["react-router"])
    expect(detection.diagnostics.map((entry) => entry.code)).not.toContain("screens/unsupported-router-style")
  })

  it("react-router dep with only a useRoutes call scores 80", () => {
    const files = {
      "package.json": manifest({ "react-router-dom": "6.0.0" }),
      "src/App.tsx": 'import { useRoutes } from "react-router-dom"\nexport const App = () => useRoutes([{ path: "/" }])\n',
    }
    expect(scoreOf(files, "react-router")).toBe(SOURCE_SCORES.jsxRouter)
  })

  it("an MV3 manifest earns the bonus on the manifest_version field, not the filename", () => {
    expect(scoreOf({ "extension/public/manifest.json": MV3 }, "state-screens")).toBe(STATE_SCREENS_MV3)
  })

  it("a PWA manifest with no manifest_version earns no bonus", () => {
    expect(scoreOf({ "public/manifest.json": PWA }, "state-screens")).toBe(DETECT_SCORE_LAST_RESORT)
  })

  it("an MV3-shaped manifest with no MV3 capability earns no bonus", () => {
    expect(
      scoreOf({ "public/manifest.json": JSON.stringify({ manifest_version: 3, name: "x" }) }, "state-screens"),
    ).toBe(DETECT_SCORE_LAST_RESORT)
  })

  it("a manifest_version declared as a string is not MV3", () => {
    expect(
      scoreOf(
        {
          "public/manifest.json": JSON.stringify({
            manifest_version: "3",
            action: { default_popup: "p.html" },
          }),
        },
        "state-screens",
      ),
    ).toBe(DETECT_SCORE_LAST_RESORT)
  })

  it("guarded top-level JSX alternatives are the last resort, scoring 1", () => {
    const probe = project({
      "tsconfig.json": TSCONFIG,
      "package.json": manifest({}),
      "src/Panel.tsx": `export const Panel = ({ loading }) => {
  if (loading) return <Spinner />
  return <Content />
}
`,
    })
    const result = detectStateScreens(probe.context)
    expect(result.score).toBe(DETECT_SCORE_LAST_RESORT)
    expect(result.evidence[0]?.what).toContain("guarded top-level JSX")
  })

  it("records a score for every source that did not fire, including the zeros", () => {
    const detection = detect({ "package.json": manifest({}), "src/main.ts": "export {}" })
    expect(detection.detections.map((entry) => entry.source).sort()).toEqual(
      BUILTIN_SOURCE_PROBES.map((probe) => probe.name).sort(),
    )
    // Every stack-specific source scores 0; state-screens is the always-applicable last resort.
    expect(
      detection.detections.filter((entry) => entry.source !== "state-screens").every((entry) => entry.score === 0),
    ).toBe(true)
    expect(detection.detections.find((entry) => entry.source === "state-screens")?.score).toBe(
      DETECT_SCORE_LAST_RESORT,
    )
    expect(detection.liveSources).toEqual([])
  })
})

describe("multi-source detection", () => {
  const EXTENSION_INSIDE_ROUTER = {
    "package.json": manifest({ "react-router-dom": "6.0.0" }),
    "src/router.tsx": ROUTER,
    "extension/public/manifest.json": MV3,
  }

  it("reports BOTH sources rather than letting the higher score delete the extension", () => {
    const detection = detect(EXTENSION_INSIDE_ROUTER)
    expect(detection.liveSources).toEqual(["react-router", "state-screens"])

    const live = detection.detections.filter((entry) => entry.live)
    expect(live.map((entry) => [entry.source, entry.score])).toEqual([
      ["react-router", SOURCE_SCORES.dataRouter],
      ["state-screens", STATE_SCREENS_MV3],
    ])
    expect(live.every((entry) => entry.evidence.length > 0)).toBe(true)
  })

  it("keeps a nested package's evidence out of the root's scores and names it in the trace", () => {
    const detection = detect({
      ...EXTENSION_INSIDE_ROUTER,
      "extension/package.json": manifest({}),
    })

    expect(detection.liveSources).toEqual(["react-router"])
    expect(detection.diagnostics.map((entry) => entry.code)).not.toContain("project/multiple-screen-sources")
    expect(detection.nestedPackages).toEqual([
      { dir: "extension", sources: ["manifest-activation", "state-screens"] },
    ])
    expect(formatDetectionTrace(detection)).toContain(
      "nested package: extension/ — run appgraph --root extension to map it",
    )
  })

  it("never calls a package nested when the root has no package.json of its own", () => {
    const withoutRootManifest = Object.fromEntries(
      Object.entries(EXTENSION_INSIDE_ROUTER).filter(([file]) => file !== "package.json"),
    )
    const detection = detect({ ...withoutRootManifest, "extension/package.json": manifest({}) })
    expect(detection.nestedPackages).toEqual([])
  })

  it("reports no nested package when none holds evidence", () => {
    const detection = detect({ ...EXTENSION_INSIDE_ROUTER, "tools/package.json": manifest({}) })
    expect(detection.nestedPackages).toEqual([])
    expect(detection.liveSources).toEqual(["react-router", "state-screens"])
  })

  it("orders the display by score, then precedence, then name", () => {
    const detection = detect({
      "package.json": manifest({ next: "15.0.0", "react-router-dom": "6.0.0" }),
      "src/app/page.tsx": "export default () => null",
      "src/router.tsx": ROUTER,
      "extension/public/manifest.json": MV3,
    })
    expect(detection.detections.filter((entry) => entry.live).map((entry) => entry.source)).toEqual([
      "next-app",
      "react-router",
      "state-screens",
    ])
  })

  it("the refusal names every live source with its evidence and the flags that resolve it", () => {
    const detection = detect(EXTENSION_INSIDE_ROUTER)
    const text = formatSourceChoice(detection.detections, { binName: "appgraph", rootLabel: "repo" })

    expect(text).toContain("2 screen sources matched in repo")
    expect(text).toContain("react-router   90")
    expect(text).toContain(`state-screens   ${String(STATE_SCREENS_MV3)}`)
    expect(text).toContain("extension/public/manifest.json:2")
    expect(text).toContain("appgraph --source=react-router")
    expect(text).toContain("appgraph --all-sources")
  })
})

describe("registered sources win over the built-in probes", () => {
  it("uses a registered source's own detect and keeps the built-ins for the rest", () => {
    const detection = runDetection({
      ts,
      root: ROOT,
      probe: project({ "tsconfig.json": TSCONFIG, "package.json": manifest({}) }),
      sources: [{ name: "react-router", detect: () => ({ score: 77, evidence: [] }) }],
    })

    expect(detection.detections.find((entry) => entry.source === "react-router")?.score).toBe(77)
    expect(detection.detections.map((entry) => entry.source).sort()).toEqual(
      BUILTIN_SOURCE_PROBES.map((probe) => probe.name).sort(),
    )
  })
})
