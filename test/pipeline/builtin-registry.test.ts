import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import { detectAdminJs } from "../../src/adapters/adminjs.js"
import { nextAppSource } from "../../src/adapters/next-app.js"
import { detectExpoRouter } from "../../src/adapters/expo-router.js"
import { detectReactNavigation } from "../../src/adapters/react-navigation.js"
import { detectReactRouter, detectWouter } from "../../src/adapters/react-router.js"
import { detectStateScreens } from "../../src/adapters/state-screens.js"
import { detectManifestActivation } from "../../src/adapters/manifest-activation.js"
import { detectTanStackRouter } from "../../src/adapters/tanstack-router.js"
import { detectVueRouter } from "../../src/adapters/vue-router.js"
import { detectAngular } from "../../src/adapters/angular/router.js"
import { detectNuxt } from "../../src/adapters/nuxt.js"
import { nextPagesSource } from "../../src/adapters/next-pages.js"
import { detectReactRouterFramework } from "../../src/adapters/react-router-framework.js"
import {
  SOURCE_PRECEDENCE,
  builtinScreenSources,
  createBuiltinAdapters,
  builtinAdapterOptionsOf,
  createPipelineRegistry,
  createDefaultExtractors,
  createBuiltinEmitters,
} from "../../src/pipeline/registry.js"
import { DEFAULT_AUTH_OPTION_KEYS, DEFAULT_SIGNED_IN } from "../../src/adapters/native-auth.js"
import { run, valuesOf } from "../extractors/harness.js"
import { run as runFixture } from "./harness.js"
import { resolveConfig } from "../../src/config/types.js"
import { BUILTIN_SOURCE_PROBES, runDetection } from "../../src/detect/index.js"
import { createProjectProbe } from "../../src/detect/project.js"

const ROOT = "/repo"

const EXPECTED_SOURCES = [
  "next-app",
  "expo-router",
  "next-pages",
  "react-router-framework",
  "nuxt",
  "tanstack-router",
  "vue-router",
  "angular",
  "react-navigation",
  "adminjs",
  "react-router",
  "wouter",
  "state-screens",
  "manifest-activation",
] as const

const FILES = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." }, include: ["src"] }),
  "package.json": JSON.stringify({
    name: "fixture",
    dependencies: { "react-router-dom": "6.0.0", "@tanstack/react-router": "1.0.0", adminjs: "7.0.0", next: "15.0.0", "vue-router": "4.4.0" },
  }),
  "src/app/page.tsx": "export default () => null",
  "src/routes/index.tsx": 'export const Route = createFileRoute("/")({})',
  "src/admin/options.ts": 'export const options = { resources: [], rootPath: "/admin" }',
  "src/router.tsx":
    'import { createBrowserRouter } from "react-router-dom"\nexport const router = createBrowserRouter([{ path: "/", element: <Home /> }])\n',
  "src/vue-router.ts":
    'import { createRouter } from "vue-router"\nexport const router = createRouter({ routes: [{ path: "/" }] })\n',
  "public/manifest.json": JSON.stringify({ manifest_version: 3, action: { default_popup: "popup.html" } }, null, 2),
} as const

const probeOf = () =>
  createProjectProbe({
    ts,
    root: ROOT,
    host: createMemoryHost({
      files: Object.fromEntries(Object.entries(FILES).map(([file, text]) => [`${ROOT}/${file}`, text])),
    }),
  })

describe("the built-in adapter registry", () => {
  it("registers exactly the shipped screen sources, in precedence order", () => {
    const registry = createPipelineRegistry({ adapters: createBuiltinAdapters() })

    expect(registry.screenSources.map((owned) => owned.source.name)).toEqual([...EXPECTED_SOURCES])
    expect([...SOURCE_PRECEDENCE]).toEqual([...EXPECTED_SOURCES])
    expect(registry.diagnostics).toEqual([])
  })

  it("gives every registered source a discover hook, so a detected source can actually run", () => {
    for (const source of builtinScreenSources()) expect(typeof source.discover).toBe("function")
  })
})

describe("one probe per source", () => {
  it("has exactly one probe per registered source and no probe without a source", () => {
    expect(BUILTIN_SOURCE_PROBES.map((probe) => probe.name)).toEqual([...EXPECTED_SOURCES])
    expect(new Set(BUILTIN_SOURCE_PROBES.map((probe) => probe.name)).size).toBe(BUILTIN_SOURCE_PROBES.length)
  })

  it("uses the adapter's own detect as the probe — the same function, not a copy", () => {
    const probeFor = (name: string) => BUILTIN_SOURCE_PROBES.find((probe) => probe.name === name)?.detect

    expect(probeFor("next-app")).toBe(nextAppSource.detect)
    expect(probeFor("next-pages")).toBe(nextPagesSource.detect)
    expect(probeFor("react-router-framework")).toBe(detectReactRouterFramework)
    expect(probeFor("nuxt")).toBe(detectNuxt)
    expect(probeFor("tanstack-router")).toBe(detectTanStackRouter)
    expect(probeFor("react-router")).toBe(detectReactRouter)
    expect(probeFor("wouter")).toBe(detectWouter)
    expect(probeFor("state-screens")).toBe(detectStateScreens)
    expect(probeFor("manifest-activation")).toBe(detectManifestActivation)
    expect(probeFor("react-navigation")).toBe(detectReactNavigation)
    // adminjs closes over its per-instance options, so the probe delegates rather than being identical.
    expect(probeFor("adminjs")).toBeTypeOf("function")
  })

  it("scores a project identically through the detect layer and through the adapters", () => {
    const probe = probeOf()
    const { context } = probe

    const adapters: Readonly<Record<string, number>> = {
      "next-app": nextAppSource.detect(context).score,
      "expo-router": detectExpoRouter(context).score,
      "next-pages": nextPagesSource.detect(context).score,
      "react-router-framework": detectReactRouterFramework(context).score,
      nuxt: detectNuxt(context).score,
      "tanstack-router": detectTanStackRouter(context).score,
      "vue-router": detectVueRouter(context).score,
      angular: detectAngular(context).score,
      "react-navigation": detectReactNavigation(context).score,
      adminjs: detectAdminJs(context).score,
      "react-router": detectReactRouter(context).score,
      wouter: detectWouter(context).score,
      "state-screens": detectStateScreens(context).score,
      "manifest-activation": detectManifestActivation(context).score,
    }

    const detected = Object.fromEntries(
      runDetection({ ts, root: ROOT, probe: probeOf() }).detections.map((entry) => [entry.source, entry.score]),
    )

    expect(detected).toEqual(adapters)
    const {
      nuxt,
      angular,
      "next-pages": nextPages,
      "react-router-framework": framework,
      wouter,
      "expo-router": expoRouter,
      "react-navigation": reactNavigation,
      ...others
    } = adapters
    expect([nuxt, angular, nextPages, framework, wouter, expoRouter, reactNavigation]).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(Object.values(others).every((score) => score > 0)).toBe(true)
  })
})

describe("builtinAdapterOptionsOf", () => {
  it("threads config redirects.unauthenticated to the loader-guard sources", () => {
    const config = resolveConfig({ root: ROOT, config: { redirects: { unauthenticated: "/login" } } })

    expect(builtinAdapterOptionsOf(config).unauthenticatedTarget).toBe("/login")
    expect(builtinAdapterOptionsOf(resolveConfig({ root: ROOT })).unauthenticatedTarget).toBeNull()
  })

  it("threads native auth rules, expoRouter and reactNavigation path tables", () => {
    const config = resolveConfig({
      root: ROOT,
      config: {
        expoRouter: { root: "src/app" },
        reactNavigation: { pathTables: [{ callee: "Router", argument: 0 }], authOptionKeys: ["needsLogin"] },
        nativeAuth: { signedIn: ["isAuthed"] },
      },
    })
    const options = builtinAdapterOptionsOf(config)

    expect(options.expoRouter).toEqual({ root: "src/app" })
    expect(options.reactNavigation).toEqual({ pathTables: [{ callee: "Router", argument: 0 }] })
    expect(options.nativeAuthRules?.signedIn).toEqual(expect.arrayContaining([...DEFAULT_SIGNED_IN, "isAuthed"]))
    expect(options.nativeAuthRules?.authOptionKeys).toEqual(expect.arrayContaining([...DEFAULT_AUTH_OPTION_KEYS, "needsLogin"]))

    const bare = builtinAdapterOptionsOf(resolveConfig({ root: ROOT }))
    expect(bare.expoRouter).toEqual({})
    expect(bare.reactNavigation).toEqual({})
    expect(bare.nativeAuthRules?.authOptionKeys).toEqual([...DEFAULT_AUTH_OPTION_KEYS])
  })

  it("reports an unknown requested screen source and lists the valid names", () => {
    const registry = createPipelineRegistry({ adapters: createBuiltinAdapters(), screenSources: ["wooter"] })

    expect(registry.diagnostics).toHaveLength(1)
    const [diagnostic] = registry.diagnostics
    expect(diagnostic?.severity).toBe("error")
    expect(diagnostic?.code).toBe("config/invalid-field")
    expect(diagnostic?.message).toContain("'wooter'")
    expect(diagnostic?.message).toContain("wouter")
    expect(diagnostic?.message).toContain("react-router-framework")
  })

  it("stays silent for a known requested screen source", () => {
    const registry = createPipelineRegistry({ adapters: createBuiltinAdapters(), screenSources: ["wouter"] })

    expect(registry.diagnostics).toEqual([])
    expect(registry.screenSources.map((owned) => owned.source.name)).toEqual(["wouter"])
  })
})


describe("createDefaultExtractors feature-flag lookups", () => {
  const gatesOf = (extractors: ReturnType<typeof createDefaultExtractors>, code: string) =>
    valuesOf(run(extractors, code), "featureGates")

  it("unions configured lookup functions with the defaults", () => {
    const extractors = createDefaultExtractors({ featureFlags: { lookupFunctions: ["enabled"] } })

    expect(gatesOf(extractors, "ax.features.enabled('newCheckout')")).toEqual(["newCheckout"])
    expect(gatesOf(extractors, "getConfiguration('legacy')")).toEqual(["legacy"])
  })

  it("keeps the defaults alone when nothing is configured", () => {
    expect(gatesOf(createDefaultExtractors(), "ax.features.enabled('newCheckout')")).toEqual([])
    expect(gatesOf(createDefaultExtractors({ featureFlags: {} }), "useFlag('x')")).toEqual(["x"])
  })
})

describe("built-in emitters", () => {
  it("registers no html emitter until a renderer is injected", () => {
    expect(createBuiltinEmitters().map((emitter) => emitter.name)).toEqual(["full", "index", "detail", "graph"])
  })

  it("delegates the html format to the injected renderer with the locale and timestamp", () => {
    const calls: unknown[] = []
    const emitters = createBuiltinEmitters({
      locale: "pl",
      renderHtml: (_graph, options) => {
        calls.push(options)
        return "<html></html>"
      },
    })
    const html = emitters.find((emitter) => emitter.name === "html")
    const ctx = { format: "html", options: {}, asset: () => "" }

    expect(html?.emit(runFixture({ files: {} }).graph, { ...ctx, timestamp: null })).toEqual([{ path: "appgraph.html", content: "<html></html>" }])
    html?.emit(runFixture({ files: {} }).graph, { ...ctx, timestamp: "2026-01-01T00:00:00Z" })
    expect(calls).toEqual([
      { locale: "pl", noTimestamp: true },
      { locale: "pl", generatedAt: "2026-01-01T00:00:00Z" },
    ])
  })
})
