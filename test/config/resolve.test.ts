import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import type { KindRule } from "../../src/core/model.js"
import { CONFIG_KIND_RULE_PRIORITY, selectKindRule } from "../../src/core/kinds.js"
import { BUILTIN_SOURCE_PROBES, runDetection } from "../../src/detect/index.js"
import { createProjectProbe } from "../../src/detect/project.js"
import { DEFAULT_WRAPPER_RULES } from "../../src/adapters/react-router.js"
import {
  PRESETS,
  companionsOf,
  isOneBundle,
  mergePresets,
  presetForSource,
  presetsForSources,
} from "../../src/config/presets.js"
import { MERGED_LIST_FIELDS, REPLACED_LIST_FIELDS, resolveAppgraphConfig } from "../../src/config/resolve.js"
import { DEFAULT_FORMATS, LIVE_SOURCE_SCORE } from "../../src/config/types.js"
import type { SourceDetection } from "../../src/config/types.js"

const ROOT = "/repo"

const ROUTER = `import { createBrowserRouter } from "react-router-dom"
export const router = createBrowserRouter([{ path: "/", element: <Home /> }])
`

const MV3 = JSON.stringify({ manifest_version: 3, action: { default_popup: "popup.html" } }, null, 2)

const files = (extra: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/modules/*": ["src/modules/*"] } },
        include: ["src"],
      }),
      "package.json": JSON.stringify({
        dependencies: { "react-router-dom": "6.0.0", zustand: "5.0.0" },
        devDependencies: { typescript: "npm:@typescript/typescript6@^6.0.2" },
      }),
      "src/router.tsx": ROUTER,
      "src/modules/orders/OrdersPage.tsx": 'export const OrdersPage = () => <div data-testid="orders" />',
      ...extra,
    }).map(([file, content]) => [`${ROOT}/${file}`, content]),
  )

const detectionOf = (extra: Readonly<Record<string, string>> = {}) =>
  runDetection({
    ts,
    root: ROOT,
    probe: createProjectProbe({ ts, root: ROOT, host: createMemoryHost({ files: files(extra) }) }),
  })

const rule = (prefix: string): KindRule => ({
  match: { pathPrefix: prefix },
  kind: "ui",
  traversable: false,
  screenEntry: false,
})

const detection = (source: string, score: number): SourceDetection => ({
  source,
  score,
  live: score >= LIVE_SOURCE_SCORE,
  evidence: [{ what: "fixture", file: "package.json", line: 1 }],
})

describe("derived defaults reach the resolved config", () => {
  it("resolves source roots, kind rules, the test-id attribute and resolution options from the host", () => {
    const setup = resolveAppgraphConfig({ detection: detectionOf() })

    expect(setup.config.sourceRoots).toEqual(["src"])
    expect(setup.config.testIdAttribute).toBe("data-testid")
    expect(setup.config.screenSources).toEqual(["react-router"])
    expect(setup.config.explicitSource).toBe(false)
    expect(setup.config.kindRules.some((entry) => entry.match.pathPrefix === "src/modules/")).toBe(true)
    expect(setup.presets).toEqual(["react-router"])
    expect(setup.wrapperRoles).toEqual([...DEFAULT_WRAPPER_RULES])
  })

  it("needs no config file at all — config is an override, never a prerequisite", () => {
    const setup = resolveAppgraphConfig({ detection: detectionOf() })
    expect(setup.config.formats).toEqual([...DEFAULT_FORMATS])
    expect(setup.config.depth).toBe(3)
    expect(setup.diagnostics.filter((entry) => entry.severity === "error")).toEqual([])
  })

  it("leaves testIdAttribute null when the histogram is all zeros", () => {
    const setup = resolveAppgraphConfig({
      detection: detectionOf({ "src/modules/orders/OrdersPage.tsx": "export const OrdersPage = () => <div />" }),
    })
    expect(setup.config.testIdAttribute).toBeNull()
  })

  it("freezes the result", () => {
    const setup = resolveAppgraphConfig({ detection: detectionOf() })

    expect(Object.isFrozen(setup.config)).toBe(true)
    expect(Object.isFrozen(setup.config.kindRules)).toBe(true)
    expect(Object.isFrozen(setup.config.redirects)).toBe(true)
    expect(() => {
      ;(setup.config as { depth: number }).depth = 99
    }).toThrow()
  })
})

describe("merge order (requirement 8)", () => {
  const layered = () =>
    resolveAppgraphConfig({
      detection: detectionOf(),
      sourceDefaults: {
        name: "source-defaults",
        config: { depth: 1, formats: ["full"], kindRules: [rule("a/")] },
        wrapperRoles: [{ name: "from-source", role: "layout" }],
        nav: ["source-nav"],
      },
      presets: [
        {
          name: "test-preset",
          screenSources: ["react-router"],
          wrapperRoles: [{ name: "from-preset", role: "guard" }],
          kindRules: [rule("b/")],
          config: { depth: 2, formats: ["index"] },
        },
      ],
      configFile: { depth: 3, formats: ["detail"], kindRules: [rule("d/")] },
      options: { depth: 4, kindRules: [rule("e/")] },
      cli: { depth: 5, formats: ["html"], kindRules: [rule("f/")] },
      extraLayers: [{ name: "cli-nav", nav: ["cli-nav"] }],
    })

  it("lets each later layer override the earlier one", () => {
    expect(layered().config.depth).toBe(5)
  })

  it("MERGES kindRules across every layer, later layers first so they win ties", () => {
    const prefixes = layered()
      .config.kindRules.map((entry) => entry.match.pathPrefix)
      .filter((prefix): prefix is string => prefix !== undefined)

    expect(prefixes.filter((prefix) => /^[a-f]\/$/.test(prefix))).toEqual(["f/", "e/", "d/", "b/", "a/"])
    expect(prefixes).toContain("src/modules/")
    expect(prefixes.indexOf("src/modules/")).toBeLessThan(prefixes.indexOf("b/"))
    expect(prefixes.indexOf("src/modules/")).toBeGreaterThan(prefixes.indexOf("d/"))
  })

  it("lets a config-file kind rule without a priority override a preset rule for the same file", () => {
    const setup = resolveAppgraphConfig({
      detection: detectionOf(),
      presets: [
        {
          name: "test-preset",
          screenSources: ["react-router"],
          wrapperRoles: [],
          kindRules: [{ match: { pathPrefix: "src/routes/" }, kind: "shared", traversable: false, screenEntry: false, priority: 20 }],
          config: {},
        },
      ],
      configFile: { kindRules: [{ match: { pathPrefix: "src/routes/" }, kind: "module", traversable: false, screenEntry: true }] },
    })

    expect(selectKindRule(setup.config.kindRules, { file: "src/routes/home.tsx" })?.kind).toBe("module")
    expect(setup.config.kindRules[0]?.priority).toBe(CONFIG_KIND_RULE_PRIORITY)
  })

  it("keeps an explicit priority on a config-file kind rule", () => {
    const setup = resolveAppgraphConfig({
      detection: detectionOf(),
      configFile: { kindRules: [{ match: { pathPrefix: "x/" }, kind: "ui", traversable: false, screenEntry: false, priority: 3 }] },
    })
    expect(setup.config.kindRules.find((entry) => entry.match.pathPrefix === "x/")?.priority).toBe(3)
  })

  it("REPLACES formats — the last layer that named them wins outright", () => {
    expect(layered().config.formats).toEqual(["html"])
  })

  it("REPLACES nav and MERGES wrapper roles in the same run", () => {
    const setup = layered()
    expect(setup.nav).toEqual(["cli-nav"])
    expect(setup.wrapperRoles.map((entry) => entry.name)).toEqual(["from-source", "from-preset"])
  })

  it("REPLACES sources: an explicit selection overrides detection", () => {
    const setup = resolveAppgraphConfig({
      detection: detectionOf({ "extension/public/manifest.json": MV3 }),
      cli: { screenSources: ["state-screens"] },
    })

    expect(setup.config.screenSources).toEqual(["state-screens"])
    expect(setup.config.explicitSource).toBe(true)
    expect(setup.refusal).toBeNull()
  })

  it("keeps the two list semantics disjoint", () => {
    const merged = new Set<string>(MERGED_LIST_FIELDS)
    expect(REPLACED_LIST_FIELDS.some((field) => merged.has(field))).toBe(false)
  })

  it("merges resolution options over the derived defaults instead of replacing them", () => {
    const setup = resolveAppgraphConfig({
      detection: detectionOf({
        "tsconfig.json": JSON.stringify({ compilerOptions: { moduleResolution: "nodenext" }, include: ["src"] }),
      }),
      configFile: { extensionRewrites: [{ from: ".cjs", to: [".cts"] }], candidateSuffixes: ["/main.ts"] },
    })

    expect(setup.config.extensionRewrites.map((entry) => entry.from)).toEqual([".js", ".jsx", ".mjs", ".cjs"])
    expect(setup.config.candidateSuffixes).toContain("/index.ts")
    expect(setup.config.candidateSuffixes).toContain("/main.ts")
  })

  it("reports which layer contributed which field", () => {
    const setup = resolveAppgraphConfig({
      detection: detectionOf(),
      configFile: { depth: 3 },
      cli: { formats: ["full"] },
    })

    expect(setup.layers.map((entry) => entry.name)).toEqual(["preset", "conventions", "config-file", "cli"])
    expect(setup.layers.find((entry) => entry.name === "config-file")?.fields).toEqual(["depth"])
    expect(setup.layers.find((entry) => entry.name === "cli")?.fields).toEqual(["formats"])
  })
})

describe("more than one live source", () => {
  const both = () => detectionOf({ "extension/public/manifest.json": MV3 })

  it("refuses by default, printing the trace and writing nothing", () => {
    const setup = resolveAppgraphConfig({ detection: both() })

    expect(setup.refusal).not.toBeNull()
    expect(setup.refusal).toContain("react-router")
    expect(setup.refusal).toContain("state-screens")
    expect(setup.refusal).toContain("--all-sources")
    expect(setup.diagnostics.map((entry) => entry.code)).toContain("project/multiple-screen-sources")
    // `manifest-activation` is not live (score 1); it joins the selection as the browser-extension
    // preset's companion to the live `state-screens`, which is why the refusal still names only two.
    expect(setup.config.screenSources).toEqual([
      "manifest-activation",
      "react-router",
      "state-screens",
    ])
  })

  it("--all-sources runs them all, namespaced, with no refusal", () => {
    const setup = resolveAppgraphConfig({ detection: both(), runtime: { allSources: true } })

    expect(setup.refusal).toBeNull()
    expect(setup.config.allSources).toBe(true)
    expect(setup.config.screenSources).toEqual([
      "manifest-activation",
      "react-router",
      "state-screens",
    ])
    expect(setup.diagnostics.map((entry) => entry.code)).not.toContain("project/multiple-screen-sources")
    expect(setup.presets).toEqual(["react-router", "browser-extension"])
  })

  it("keeps every detection, including the zeros, on the resolved config", () => {
    const setup = resolveAppgraphConfig({ detection: both() })
    expect(setup.config.detections).toHaveLength(BUILTIN_SOURCE_PROBES.length)
    expect(setup.config.detections.filter((entry) => entry.live)).toHaveLength(2)
  })

  it("warns when nothing scored 50 or higher", () => {
    const setup = resolveAppgraphConfig({
      detections: [detection("react-router", 40), detection("state-screens", 1)],
      root: ROOT,
    })

    expect(setup.config.screenSources).toEqual([])
    expect(setup.diagnostics.map((entry) => entry.code)).toContain("project/no-screen-source")
    expect(setup.diagnostics.find((entry) => entry.code === "project/no-screen-source")?.message).toContain(
      "react-router (40)",
    )
  })
})

describe("the Next family bundle (AS10)", () => {
  const live = (...sources: readonly string[]) =>
    resolveAppgraphConfig({ detections: sources.map((source) => detection(source, 100)), root: ROOT })

  it("co-runs next-app and next-pages with no refusal", () => {
    const setup = live("next-app", "next-pages")

    expect(setup.refusal).toBeNull()
    expect(setup.config.screenSources).toEqual(["next-app", "next-pages"])
    expect(setup.config.explicitSource).toBe(false)
  })

  it("refuses next-pages next to tanstack-router", () => {
    const setup = live("next-pages", "tanstack-router")

    expect(setup.refusal).toContain("next-pages")
    expect(setup.refusal).toContain("tanstack-router")
    expect(setup.diagnostics.map((entry) => entry.code)).toContain("project/multiple-screen-sources")
  })

  it("runs a companion that is not live itself", () => {
    const setup = resolveAppgraphConfig({
      detections: [detection("next-app", 100), detection("next-pages", 0)],
      root: ROOT,
    })

    expect(setup.refusal).toBeNull()
    expect(setup.config.screenSources).toEqual(["next-app", "next-pages"])
  })

  it("runs an explicit source's companions and keeps the selection explicit", () => {
    const setup = resolveAppgraphConfig({ detections: [], root: ROOT, cli: { screenSource: "next-pages" } })

    expect(setup.config.screenSources).toEqual(["next-app", "next-pages"])
    expect(setup.config.explicitSource).toBe(true)
  })

  it("adds no companions to an explicit source whose preset names none", () => {
    const setup = resolveAppgraphConfig({ detections: [], root: ROOT, cli: { screenSources: ["tanstack-router"] } })
    expect(setup.config.screenSources).toEqual(["tanstack-router"])
  })

  it("derives companions and bundle membership from the presets", () => {
    expect(companionsOf(["next-app"])).toEqual(["next-pages"])
    expect(companionsOf(["next-pages", "react-router"])).toEqual(["next-app"])
    expect(isOneBundle(["next-app", "next-pages"])).toBe(true)
    expect(isOneBundle(["next-pages", "tanstack-router"])).toBe(false)
    expect(mergePresets(presetsForSources(["next-app"])).screenSources).toEqual(["next-app", "next-pages"])
  })
})

describe("presets (requirement 9)", () => {
  it("bundles source, wrapper roles and kind rules per stack — never an extractor selection", () => {
    for (const preset of Object.values(PRESETS)) {
      expect(preset.screenSources.length).toBeGreaterThan(0)
      expect(preset).not.toHaveProperty("extractors")
    }

    expect(PRESETS["react-router"].wrapperRoles).toEqual([...DEFAULT_WRAPPER_RULES])
    expect(PRESETS["tanstack-router"].config.generated).toEqual(["**/routeTree.gen.ts"])
  })

  it("selects a preset from a detected source name", () => {
    expect(presetForSource("state-screens")?.name).toBe("browser-extension")
    expect(presetForSource("nope")).toBeNull()
    expect(presetsForSources(["react-router", "react-router"]).map((preset) => preset.name)).toEqual([
      "react-router",
    ])
  })

  it("merges several presets without losing either side", () => {
    const merged = mergePresets(presetsForSources(["react-router", "next-app"]))

    expect(merged.names).toEqual(["react-router", "next-app"])
    expect(merged.wrapperRoles).toEqual([...DEFAULT_WRAPPER_RULES])
    expect(merged.kindRules.length).toBe(
      PRESETS["react-router"].kindRules.length + PRESETS["next-app"].kindRules.length,
    )
  })
})

describe("zero-config == pinned-config", () => {
  it("a pinned config naming what detection derives resolves to the same values", () => {
    const derived = resolveAppgraphConfig({ detection: detectionOf() })
    const pinned = resolveAppgraphConfig({
      detection: detectionOf(),
      configFile: {
        screenSource: "react-router",
        depth: 3,
        sourceRoots: ["src"],
        testIdAttribute: "data-testid",
      },
    })

    expect(pinned.config.sourceRoots).toEqual(derived.config.sourceRoots)
    expect(pinned.config.screenSources).toEqual(derived.config.screenSources)
    expect(pinned.config.testIdAttribute).toBe(derived.config.testIdAttribute)
    expect(pinned.config.depth).toBe(derived.config.depth)
    expect(pinned.config.kindRules).toEqual(derived.config.kindRules)
    expect(pinned.config.explicitSource).toBe(true)
    expect(derived.config.explicitSource).toBe(false)
  })
})

describe("adapter option keys (wrapperRoles, pathlessRoles, entryComponents, adminjs, extractors)", () => {
  it("merges config wrapperRoles by name over the preset defaults: same name replaces in place, new appends", () => {
    const setup = resolveAppgraphConfig({
      detection: detectionOf(),
      configFile: {
        wrapperRoles: [
          { name: "protected-route", role: "guard", tagRegex: "^RequireAuth$" },
          { name: "gate", role: "guard", tagRegex: "^Gate$" },
        ],
      },
    })

    const names = setup.wrapperRoles.map((entry) => entry.name)
    expect(names).toEqual([...DEFAULT_WRAPPER_RULES.map((entry) => entry.name), "gate"])
    expect(setup.wrapperRoles.find((entry) => entry.name === "protected-route")?.tagRegex).toBe("^RequireAuth$")
    expect(setup.layers.find((entry) => entry.name === "config-file")?.fields).toEqual(["wrapperRoles"])
  })

  it("keeps the default pathless role and merges keys across layers", () => {
    const setup = resolveAppgraphConfig({
      detection: detectionOf(),
      configFile: { pathlessRoles: { _admin: { auth: "protected" } } },
      cli: { pathlessRoles: { _public: { auth: "public" } } },
    })

    expect(setup.config.pathlessRoles).toEqual({
      _authed: { auth: "protected" },
      _admin: { auth: "protected" },
      _public: { auth: "public" },
    })
  })

  it("merges adminjs per key across layers", () => {
    const setup = resolveAppgraphConfig({
      detection: detectionOf(),
      configFile: { adminjs: { optionsFile: "src/admin/options.ts" } },
      options: { adminjs: { componentLoaderFile: "src/admin/components.ts" } },
    })

    expect(setup.config.adminjs).toEqual({
      optionsFile: "src/admin/options.ts",
      componentLoaderFile: "src/admin/components.ts",
    })
  })

  it("merges vueAuth per key across layers and defaults it to empty", () => {
    const setup = resolveAppgraphConfig({
      detection: detectionOf(),
      configFile: { vueAuth: { protectedMiddleware: ["staff"] } },
      options: { vueAuth: { authMetaKeys: ["needsLogin"] } },
    })
    expect(setup.config.vueAuth).toEqual({ protectedMiddleware: ["staff"], authMetaKeys: ["needsLogin"] })
    expect(resolveAppgraphConfig({ detection: detectionOf() }).config.vueAuth).toEqual({})
  })

  it("merges angular per key across layers and defaults it to empty", () => {
    const setup = resolveAppgraphConfig({
      detection: detectionOf(),
      configFile: { angular: { protectedGuards: ["UserRightGuard"] } },
      options: { angular: { authDataKeys: ["scope"] } },
    })
    expect(setup.config.angular).toEqual({ protectedGuards: ["UserRightGuard"], authDataKeys: ["scope"] })
    expect(resolveAppgraphConfig({ detection: detectionOf() }).config.angular).toEqual({})
    expect(MERGED_LIST_FIELDS).toContain("angular")
  })

  it("merges the native keys per key across layers and defaults them to empty", () => {
    const setup = resolveAppgraphConfig({
      detection: detectionOf(),
      configFile: {
        expoRouter: { root: "src/app" },
        reactNavigation: { pathTables: [{ callee: "Router", argument: 0 }] },
        nativeAuth: { signedIn: ["isAuthed"] },
        featureFlags: { lookupFunctions: ["enabled"] },
      },
      options: {
        reactNavigation: { authOptionKeys: ["needsLogin"] },
        featureFlags: { lookupFunctions: ["flagOn"] },
      },
    })
    expect(setup.config.expoRouter).toEqual({ root: "src/app" })
    expect(setup.config.reactNavigation).toEqual({
      pathTables: [{ callee: "Router", argument: 0 }],
      authOptionKeys: ["needsLogin"],
    })
    expect(setup.config.nativeAuth).toEqual({ signedIn: ["isAuthed"] })
    expect(setup.config.featureFlags).toEqual({ lookupFunctions: ["flagOn"] })

    const bare = resolveAppgraphConfig({ detection: detectionOf() }).config
    expect([bare.expoRouter, bare.reactNavigation, bare.nativeAuth, bare.featureFlags]).toEqual([{}, {}, {}, {}])
    expect(MERGED_LIST_FIELDS).toEqual(expect.arrayContaining(["expoRouter", "reactNavigation", "nativeAuth", "featureFlags"]))
  })

  it("merges reactRouter per key across layers and defaults it to empty", () => {
    const sentry = { name: "sentry", translators: ["translateSentryRoute"] }
    const custom = { name: "custom", fields: { component: "page" } }
    const setup = resolveAppgraphConfig({
      detection: detectionOf(),
      configFile: { reactRouter: { routeDialect: sentry } },
      options: { reactRouter: {} },
    })

    expect(MERGED_LIST_FIELDS).toContain("reactRouter")
    expect(setup.config.reactRouter).toEqual({ routeDialect: sentry })
    expect(
      resolveAppgraphConfig({
        detection: detectionOf(),
        configFile: { reactRouter: { routeDialect: sentry } },
        cli: { reactRouter: { routeDialect: custom } },
      }).config.reactRouter,
    ).toEqual({ routeDialect: custom })
    expect(resolveAppgraphConfig({ detection: detectionOf() }).config.reactRouter).toEqual({})
  })

  it("merges redirectRules across layers in layer order and defaults them to empty", () => {
    const setup = resolveAppgraphConfig({
      detection: detectionOf(),
      configFile: { redirectRules: [{ source: "/a", destination: "/b" }] },
      options: { redirectRules: [{ source: "/c", destination: "/d" }] },
    })

    expect(MERGED_LIST_FIELDS).toContain("redirectRules")
    expect(setup.config.redirectRules).toEqual([
      { source: "/a", destination: "/b" },
      { source: "/c", destination: "/d" },
    ])
    expect(resolveAppgraphConfig({ detection: detectionOf() }).config.redirectRules).toEqual([])
  })

  it("defaults entryComponents and extractors to null — derive holders, run every extractor", () => {
    const setup = resolveAppgraphConfig({ detection: detectionOf() })
    expect(setup.config.entryComponents).toBeNull()
    expect(setup.config.extractors).toBeNull()

    const pinned = resolveAppgraphConfig({
      detection: detectionOf(),
      configFile: { entryComponents: [{ file: "src/App.tsx" }], extractors: ["store", "component-tree", "store"] },
    })
    expect(pinned.config.entryComponents).toEqual([{ file: "src/App.tsx" }])
    expect(pinned.config.extractors).toEqual(["component-tree", "store"])
  })
})
