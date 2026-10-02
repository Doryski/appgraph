import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import type { AppgraphConfig, Screen } from "../../src/core/model.js"
import { analyze } from "../../src/pipeline/run.js"
import type { AnalyzeResult } from "../../src/pipeline/run.js"

const ROOT = "/repo"

const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: ".", jsx: "preserve" }, include: ["src"] })

const packageJson = (dependencies: Readonly<Record<string, string>>): string =>
  JSON.stringify({ name: "fixture", dependencies: { react: "19.0.0", ...dependencies } })

const analyzeFiles = (
  files: Readonly<Record<string, string>>,
  config: AppgraphConfig,
  dependencies: Readonly<Record<string, string>> = {},
): Promise<AnalyzeResult> =>
  analyze({
    ts,
    root: ROOT,
    host: createMemoryHost({
      files: {
        [`${ROOT}/package.json`]: packageJson(dependencies),
        [`${ROOT}/tsconfig.json`]: TSCONFIG,
        ...Object.fromEntries(Object.entries(files).map(([file, text]) => [`${ROOT}/${file}`, text])),
      },
    }),
    config,
  })

const screenAt = (screens: readonly Screen[], url: string): Screen | undefined =>
  screens.find((screen) => screen.url === url)

const diagnosticOf = (result: AnalyzeResult, code: string) => result.diagnostics.find((entry) => entry.code === code)

const ROUTER = {
  "src/routes/RequireAuth.tsx": "export const RequireAuth = ({ children }: { children?: unknown }) => <div>{children}</div>\n",
  "src/modules/Home/index.tsx": "export default function Home() { return <div /> }\n",
  "src/routes/router.tsx": `
import { createBrowserRouter } from "react-router-dom"
import { RequireAuth } from "./RequireAuth"
import Home from "../modules/Home"
export const router = createBrowserRouter([
  { path: "/home", element: <RequireAuth><Home /></RequireAuth> },
])
`,
}

describe("config keys reach the built-in adapters", () => {
  it("wrapperRoles classifies a guard the defaults do not know, without dropping the defaults", async () => {
    const bare = await analyzeFiles(ROUTER, { screenSource: "react-router" }, { "react-router-dom": "6.0.0" })
    expect(screenAt(bare.graph.screens, "/home")?.auth).not.toBe("protected")

    const result = await analyzeFiles(
      ROUTER,
      {
        screenSource: "react-router",
        wrapperRoles: [{ name: "require-auth", role: "guard", tagRegex: "^RequireAuth$" }],
      },
      { "react-router-dom": "6.0.0" },
    )

    expect(screenAt(result.graph.screens, "/home")?.auth).toBe("protected")
  })

  it("pathlessRoles gives a custom `_` segment an auth meaning", async () => {
    const files = {
      "src/routes/_admin/users.tsx": [
        `import { createFileRoute } from "@tanstack/react-router"`,
        `export const Route = createFileRoute("/_admin/users")({ component: Users })`,
        "function Users() { return <div /> }",
        "",
      ].join("\n"),
    }
    const dependencies = { "@tanstack/react-router": "1.0.0" }

    const bare = await analyzeFiles(files, {}, dependencies)
    expect(screenAt(bare.graph.screens, "/users")?.auth).toBe("unknown")

    const result = await analyzeFiles(files, { pathlessRoles: { _admin: { auth: "protected" } } }, dependencies)
    expect(screenAt(result.graph.screens, "/users")?.auth).toBe("protected")
  })

  it("entryComponents selects the state-screens holder", async () => {
    const files = {
      "src/App.tsx": `
export function App({ ready }: { ready: boolean }) {
  if (ready) return <main>ready</main>
  return <p>loading</p>
}
`,
    }

    const result = await analyzeFiles(files, {
      screenSource: "state-screens",
      entryComponents: [{ file: "src/App.tsx", exportName: "App" }],
    })

    expect(result.graph.screens.length).toBeGreaterThan(0)
    expect(diagnosticOf(result, "screens/no-entry-component")).toBeUndefined()
  })

  it("adminjs.optionsFile makes AdminJS live where the content probe finds nothing", async () => {
    const files = { "src/admin/setup.ts": "export const resources = []\n" }
    const dependencies = { adminjs: "7.0.0" }
    const scoreOf = (result: AnalyzeResult) =>
      result.detection.detections.find((entry) => entry.source === "adminjs")?.score

    expect(scoreOf(await analyzeFiles(files, {}, dependencies))).toBe(0)
    expect(scoreOf(await analyzeFiles(files, { adminjs: { optionsFile: "src/admin/setup.ts" } }, dependencies))).toBe(100)
  })
})

describe("native config keys reach analyze()", () => {
  const FLAGGED = {
    ...ROUTER,
    "src/modules/Home/index.tsx": [
      `import { ax } from "../../analytics"`,
      "export default function Home() { return ax.features.enabled('newCheckout') ? <div /> : null }",
      "",
    ].join("\n"),
    "src/analytics.ts": "export const ax = { features: { enabled: (key: string) => key.length > 0 } }\n",
  }
  const dependencies = { "react-router-dom": "6.0.0" }

  it("featureFlags.lookupFunctions adds a lookup on top of the defaults", async () => {
    const bare = await analyzeFiles(FLAGGED, { screenSource: "react-router" }, dependencies)
    expect(screenAt(bare.graph.screens, "/home")?.facts.featureGates).toEqual([])

    const result = await analyzeFiles(
      FLAGGED,
      { screenSource: "react-router", featureFlags: { lookupFunctions: ["enabled"] } },
      dependencies,
    )
    expect(screenAt(result.graph.screens, "/home")?.facts.featureGates).toEqual(["newCheckout"])
  })

  it("accepts expoRouter, reactNavigation and nativeAuth without a config diagnostic", async () => {
    const result = await analyzeFiles(
      ROUTER,
      {
        screenSource: "react-router",
        expoRouter: { root: "src/app" },
        reactNavigation: { pathTables: [{ callee: "Router", argument: 0 }], authOptionKeys: ["needsLogin"] },
        nativeAuth: { signedIn: ["isAuthed"] },
      },
      dependencies,
    )
    expect(result.diagnostics.filter((entry) => entry.code.startsWith("config/"))).toEqual([])
  })
})

describe("config validation inside analyze()", () => {
  it("names the field a configured path came from when the file does not exist", async () => {
    const result = await analyzeFiles(ROUTER, { adminjs: { optionsFile: "src/admin/missing.ts" } })

    const diagnostic = diagnosticOf(result, "config/missing-file")
    expect(diagnostic?.severity).toBe("error")
    expect(diagnostic?.message).toContain("adminjs.optionsFile")
    expect(diagnostic?.message).toContain("src/admin/missing.ts")
  })

  it("rejects an unknown key with a suggestion and keeps the run going", async () => {
    const config = { screenSource: "react-router", pathless: { _admin: {} } }
    const result = await analyzeFiles(ROUTER, config, { "react-router-dom": "6.0.0" })

    const diagnostic = diagnosticOf(result, "config/unknown-field")
    expect(diagnostic?.severity).toBe("error")
    expect(diagnostic?.message).toContain("'pathless'")
    expect(diagnostic?.message).toContain("Did you mean 'pathlessRoles'?")
    expect(result.graph.screens.length).toBeGreaterThan(0)
  })

  it("names the config file in validation diagnostics when the caller passes it", async () => {
    const result = await analyze({
      ts,
      root: ROOT,
      host: createMemoryHost({
        files: {
          [`${ROOT}/package.json`]: packageJson({ "react-router-dom": "6.0.0" }),
          [`${ROOT}/tsconfig.json`]: TSCONFIG,
          ...Object.fromEntries(Object.entries(ROUTER).map(([file, text]) => [`${ROOT}/${file}`, text])),
        },
      }),
      config: { screenSource: "react-router", pathless: {} } as AppgraphConfig,
      configFile: "appgraph.config.ts",
    })

    const diagnostic = diagnosticOf(result, "config/unknown-field")
    expect(diagnostic?.file).toBe("appgraph.config.ts")
    expect(diagnostic?.message.startsWith("appgraph.config.ts: ")).toBe(true)
  })

  it("drops a mistyped field instead of passing it to an adapter", async () => {
    const config: AppgraphConfig = JSON.parse(
      JSON.stringify({ screenSource: "react-router", wrapperRoles: [{ name: "x", role: "bouncer" }] }),
    )
    const result = await analyzeFiles(ROUTER, config, { "react-router-dom": "6.0.0" })

    expect(diagnosticOf(result, "config/invalid-field")?.message).toContain("'wrapperRoles'")
    expect(screenAt(result.graph.screens, "/home")).toBeDefined()
  })
})
