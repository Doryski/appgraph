import { describe, expect, it } from "vitest"
import { GRAPH_LIMITATIONS } from "../../src/core/graph.js"
import type {
  AppGraph,
  AppGraphMeta,
  Endpoint,
  NavEntry,
  NavGroup,
  Screen,
  ScreenFacts,
  ShellReport,
} from "../../src/core/model.js"
import { fullDocument } from "../../src/emit/view-full.js"
import { activationView, ancestorView, emitIndexView, entryView, indexDocument, spliceView } from "../../src/emit/view-index.js"

const makeFacts = (overrides: Partial<ScreenFacts> = {}): ScreenFacts => ({
  endpoints: [],
  navigations: [],
  stores: [],
  queryKeys: [],
  mutations: 0,
  i18nNamespaces: [],
  testIds: [],
  formSchemas: [],
  formFields: [],
  featureGates: [],
  hooks: [],
  messages: [],
  extra: {},
  ...overrides,
})

const makeScreen = (overrides: Partial<Screen> = {}): Screen => ({
  id: "/orders",
  localId: "src/modules/Orders/Orders.tsx",
  source: "react-router",
  activations: [{ kind: "url", template: "/orders", params: [] }],
  url: "/orders",
  params: [],
  title: "Orders",
  kindTag: null,
  entries: [{ kind: "file", file: "src/modules/Orders/Orders.tsx", exportName: "default" }],
  ancestors: [],
  shell: null,
  auth: "protected",
  featureFlag: null,
  redirectTo: null,
  devOnly: false,
  addressable: true,
  tree: [],
  reachable: [],
  facts: makeFacts(),
  navigatesTo: [],
  provenance: { sources: ["react-router"], evidence: [], mergedFrom: [], decisions: [] },
  ...overrides,
})

const makeShell = (overrides: Partial<ShellReport> = {}): ShellReport => ({
  file: "src/routes/RootLayout.tsx",
  layouts: ["RootLayout"],
  tree: [],
  navigatesTo: [],
  endpoints: [],
  stores: [],
  i18nNamespaces: [],
  testIds: [],
  ...overrides,
})

const makeNavEntry = (overrides: Partial<NavEntry> = {}): NavEntry => ({
  path: "/orders",
  parentPath: null,
  label: "Orders",
  labelKey: null,
  featureFlag: null,
  source: "src/config.tsx#navigationRoutes",
  file: "src/config.tsx",
  line: 12,
  resolvedScreen: "/orders",
  ...overrides,
})

const makeNavGroup = (overrides: Partial<NavGroup> = {}): NavGroup => ({
  name: "navigationRoutes",
  source: "src/config.tsx#navigationRoutes",
  score: 1,
  availableOnShells: [],
  entries: [makeNavEntry()],
  ...overrides,
})

type MetaOverrides = Partial<Omit<AppGraphMeta, "emptyResult" | "emptyReason">> & {
  readonly empty?: { readonly reason: string }
}

const makeMeta = (overrides: MetaOverrides = {}): AppGraphMeta => {
  const { empty, ...rest } = overrides
  return {
    schemaVersion: 2,
    appgraphVersion: "0.1.0",
    root: "frontend",
    appName: "frontend",
    sourceRoots: ["src"],
    screenSources: ["react-router"],
    maxDepth: 3,
    fingerprint: "0000",
    counts: {},
    confidence: [],
    limitations: [],
    ...rest,
    ...(empty === undefined ? {} : { emptyResult: true as const, emptyReason: empty.reason }),
  }
}

const makeGraph = (overrides: Partial<AppGraph> = {}): AppGraph => ({
  meta: makeMeta(),
  screens: [],
  redirects: [],
  shells: {},
  components: {},
  navGroups: [],
  navigation: [],
  deadNavLinks: [],
  orphanScreens: [],
  diagnostics: [],
  ...overrides,
})

const httpEndpoint = (overrides: Partial<Endpoint> = {}): Endpoint => ({
  method: "GET",
  url: "/api/orders",
  transport: "http",
  client: "axios",
  ...overrides,
})

const asRecords = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? (value as readonly Record<string, unknown>[]) : []

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

describe("index: everything under screens is navigable", () => {
  const graph = makeGraph({
    screens: [
      makeScreen(),
      makeScreen({
        id: "screen://state-screens/src%2FApp.tsx%230",
        localId: "src/App.tsx#0",
        source: "state-screens",
        activations: [{ kind: "state", holder: "App", expr: "isAuthenticated && !isLoading" }],
        url: null,
        addressable: false,
        title: "Main",
      }),
    ],
  })

  it("keeps state-activated screens out of the screens block", () => {
    const document = indexDocument(graph)
    const screens = asRecords(document["screens"])
    expect(screens).toHaveLength(1)
    expect(screens.every((row) => typeof row["url"] === "string" && row["url"] !== "")).toBe(true)
  })

  it("puts them in stateScreens with their activation precondition", () => {
    const stateScreens = asRecords(indexDocument(graph)["stateScreens"])
    expect(stateScreens).toHaveLength(1)
    const first = asRecord(stateScreens[0])
    expect(first["id"]).toBe("screen://state-screens/src%2FApp.tsx%230")
    expect(first["url"]).toBeUndefined()
    const activation = asRecord(asRecords(first["activation"])[0])
    expect(activation["kind"]).toBe("state")
    expect(activation["holder"]).toBe("App")
    expect(activation["when"]).toBe("isAuthenticated && !isLoading")
  })

  it("tells the agent in readMe that stateScreens have no URL", () => {
    expect(emitIndexView(graph)).toContain("stateScreens: these screens have no URL")
  })

  it("says in readMe that stateScreens are reached through in-app state or a named route", () => {
    expect(emitIndexView(graph)).toContain("reached through in-app state or a named route")
  })

  it("emits screens: [] on a zero-screen artifact and says so in prose", () => {
    const yaml = emitIndexView(makeGraph({ meta: makeMeta({ empty: { reason: "no screen source produced a draft" } }) }))
    expect(yaml).toContain("screens: []")
    expect(yaml).toContain("emptyResult: true")
    expect(yaml).toContain("ZERO-SCREEN result")
  })
})

describe("index: intercept activation and slot splice views", () => {
  it("emits the intercept as its own kind, never as a message, and omits a null slot", () => {
    expect(activationView({ kind: "intercept", from: "/feed", slot: null, file: "src/app/(.)orders/page.tsx" })).toEqual({
      kind: "intercept",
      from: "/feed",
      file: "src/app/(.)orders/page.tsx",
    })
    expect(
      activationView({ kind: "intercept", from: "/feed", slot: "modal", file: "src/app/@modal/(.)orders/page.tsx" }),
    ).toEqual({ kind: "intercept", from: "/feed", slot: "modal", file: "src/app/@modal/(.)orders/page.tsx" })
  })

  it("emits a route activation with its name and navigator, omitting a null navigator", () => {
    expect(activationView({ kind: "route", name: "Profile", navigator: "HomeTab" })).toEqual({
      kind: "route",
      name: "Profile",
      navigator: "HomeTab",
    })
    expect(activationView({ kind: "route", name: "Profile", navigator: null })).toEqual({ kind: "route", name: "Profile" })
  })

  it("emits an entry platform only when present", () => {
    const entry = { kind: "file", file: "app/settings.tsx", exportName: "default" } as const
    expect(entryView(entry)).not.toHaveProperty("platform")
    expect(entryView({ ...entry, file: "app/settings.ios.tsx", platform: "ios" })).toEqual({
      kind: "file",
      file: "app/settings.ios.tsx",
      exportName: "default",
      platform: "ios",
    })
  })

  it("emits a slot splice with its prop name", () => {
    expect(spliceView({ kind: "slot", name: "modal" })).toEqual({ kind: "slot", name: "modal" })
    expect(spliceView({ kind: "outlet", tag: "RouterView" })).toEqual({ kind: "outlet", tag: "RouterView" })
    expect(spliceView({ kind: "outlet", tag: "RouterView", name: "aside" })).toEqual({
      kind: "outlet",
      tag: "RouterView",
      name: "aside",
    })
  })

  it("adds branches to an ancestor only when it has some", () => {
    const ancestor = { file: "src/app/layout.tsx", exportName: "default", role: "layout", splice: { kind: "children" } } as const
    expect(ancestorView(ancestor)).not.toHaveProperty("branches")
    expect(ancestorView({ ...ancestor, branches: [] })).not.toHaveProperty("branches")
  })
})

describe("index: dead nav links are a top-level block", () => {
  const dead = makeNavEntry({
    path: "/results",
    label: "Results",
    file: "src/config.tsx",
    line: 42,
    resolvedScreen: null,
  })
  const graph = makeGraph({
    screens: [makeScreen()],
    navGroups: [makeNavGroup({ entries: [makeNavEntry(), dead] })],
    deadNavLinks: [dead],
  })

  it("carries label, target and source file:line", () => {
    const links = asRecords(indexDocument(graph)["deadNavLinks"])
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      label: "Results",
      target: "/results",
      file: "src/config.tsx",
      line: 42,
      resolves: false,
      source: "src/config.tsx#navigationRoutes",
    })
  })

  it("is not buried in diagnostics and warns in readMe", () => {
    const yaml = emitIndexView(graph)
    expect(yaml).toContain("deadNavLinks:")
    expect(yaml).toContain("Following one leads nowhere")
    expect(yaml).not.toContain("diagnostics:")
  })

  it("flags the same entry inside the menu block", () => {
    const menu = asRecords(indexDocument(graph)["menu"])
    const entries = asRecords(asRecord(menu[0])["entries"])
    expect(entries.filter((entry) => entry["deadLink"] === true)).toHaveLength(1)
  })
})

describe("index: selector honesty", () => {
  const graph = makeGraph({ screens: [makeScreen()] })

  it("states plainly that the repo declares no test-id attribute", () => {
    const document = indexDocument(graph)
    expect(asRecord(document["selectors"])).toMatchObject({
      status: "no-attribute-detected",
      note: "This repository declares no test-id attributes; select elements by role or visible text.",
    })
  })

  it("never emits an empty testIds list", () => {
    expect(emitIndexView(graph)).not.toContain("testIds: []")
    expect(emitIndexView(graph)).not.toContain("testIds:")
  })

  it("distinguishes a detected attribute that matched nothing", () => {
    const document = indexDocument(graph, { testIdAttribute: "data-testid" })
    expect(asRecord(document["selectors"])).toMatchObject({
      attribute: "data-testid",
      status: "attribute-yielded-nothing",
    })
    expect(emitIndexView(graph, { testIdAttribute: "data-testid" })).not.toContain("testIds:")
  })

  it("lists test ids only when the attribute actually yielded some", () => {
    const withIds = makeGraph({
      screens: [makeScreen({ facts: makeFacts({ testIds: ["empty-list", "search-option"] }) })],
    })
    const document = indexDocument(withIds, { testIdAttribute: "data-testid" })
    expect(asRecord(document["selectors"])["status"]).toBe("present")
    expect(asRecords(document["screens"])[0]?.["testIds"]).toEqual(["empty-list", "search-option"])
  })

  it("collapses to a count under includeTestIds: false", () => {
    const withIds = makeGraph({
      screens: [makeScreen({ facts: makeFacts({ testIds: ["empty-list", "search-option"] }) })],
    })
    const row = asRecords(indexDocument(withIds, { testIdAttribute: "data-testid", includeTestIds: false })["screens"])[0]
    expect(asRecord(row)["testIdCount"]).toBe(2)
    expect(asRecord(row)["testIds"]).toBeUndefined()
  })
})

describe("index: no runtime behaviour is asserted without config", () => {
  const graph = makeGraph({
    screens: [makeScreen({ featureFlag: "invoices" })],
  })

  it("hedges the auth and flag lines by default", () => {
    const yaml = emitIndexView(graph)
    expect(yaml).toContain("the redirect target for an unauthenticated visitor was not configured")
    expect(yaml).toContain("what the app does when the flag is off was not configured")
    expect(yaml).not.toContain("redirects to /login")
  })

  it("states the configured targets as fact when config declares them", () => {
    const yaml = emitIndexView(graph, { redirects: { unauthenticated: "/login", flagOff: "/" } })
    expect(yaml).toContain("the configured redirect for an unauthenticated visitor is /login")
    expect(yaml).toContain("the configured redirect when the feature flag is off is /")
    expect(yaml).not.toContain("was not configured")
  })

  it("omits both lines when no screen is protected or flagged", () => {
    const yaml = emitIndexView(makeGraph({ screens: [makeScreen({ auth: "public" })] }))
    expect(yaml).not.toContain("auth: protected →")
    expect(yaml).not.toContain("feature flag")
  })
})

describe("index: self-referencing command carries no host path", () => {
  const graph = makeGraph({ screens: [makeScreen()] })

  it("derives the command from the package bin name", () => {
    expect(emitIndexView(graph)).toContain("detailCommand: appgraph --screen=<id> --format=detail")
  })

  it("honours a renamed bin", () => {
    expect(emitIndexView(graph, { binName: "my-appgraph" })).toContain("detailCommand: my-appgraph --screen=")
  })

  it("never embeds a host script path", () => {
    const yaml = emitIndexView(graph)
    expect(yaml).not.toContain("npx tsx")
    expect(yaml).not.toContain("scripts/")
  })
})

describe("index: meta.confidence per fact section", () => {
  const graph = makeGraph({
    screens: [makeScreen()],
    meta: makeMeta({
      confidence: [
        { section: "stores", count: 0, enablingDependency: "zustand", dependencyInstalled: true, level: "suspect" },
        { section: "endpoints", count: 0, enablingDependency: "axios", dependencyInstalled: false, level: "low" },
        { section: "screens", count: 34, enablingDependency: null, dependencyInstalled: false, level: "high" },
        { section: "testIds", count: 3, enablingDependency: null, dependencyInstalled: false, level: "low" },
      ],
    }),
  })

  it("classifies a zero-fact section whose dependency is installed as empty-unexpected", () => {
    const rows = asRecords(asRecord(indexDocument(graph)["meta"])["confidence"])
    expect(rows).toEqual([
      { section: "endpoints", status: "empty-expected", probed: "axios", dependencyInstalled: false, matched: 0 },
      { section: "screens", status: "ok", probed: "always-on extractor", matched: 34 },
      { section: "stores", status: "empty-unexpected", probed: "zustand", dependencyInstalled: true, matched: 0 },
      { section: "testIds", status: "partial", probed: "always-on extractor", matched: 3 },
    ])
  })
})

/**
 * The index is the ~10 KB file an agent loads; the `full` graph is the one a human opens. The stated
 * limitations belong in the index too, since it is the artifact they exist for.
 */
describe("index: meta.limitations reaches the artifact an agent reads", () => {
  it("repeats meta.limitations verbatim", () => {
    const limitations = ["Guards are detected, never evaluated.", "Trees are cut at meta.maxDepth."]
    const graph = makeGraph({ screens: [makeScreen()], meta: makeMeta({ limitations }) })
    expect(asRecord(indexDocument(graph)["meta"])["limitations"]).toEqual(limitations)
  })

  it("carries every limitation a built graph states, not a subset", () => {
    const graph = makeGraph({ screens: [makeScreen()], meta: makeMeta({ limitations: GRAPH_LIMITATIONS }) })
    expect(asRecord(indexDocument(graph)["meta"])["limitations"]).toEqual([...GRAPH_LIMITATIONS])
  })

  it("states the composition sentence word for word", () => {
    const graph = makeGraph({ screens: [makeScreen()], meta: makeMeta({ limitations: GRAPH_LIMITATIONS }) })
    const emitted = asRecord(indexDocument(graph)["meta"])["limitations"] as readonly string[]
    expect(
      emitted.some((line) =>
        line.includes(
          "appgraph reports composition as the framework's convention describes it, not as the code proves it",
        ),
      ),
    ).toBe(true)
  })
})

describe("index: rpc endpoints are distinguishable from http", () => {
  it("counts transports separately and warns that rpc is not browser-reachable", () => {
    const graph = makeGraph({
      screens: [
        makeScreen({
          facts: makeFacts({
            endpoints: [
              httpEndpoint(),
              { method: "POST", url: "listOrders", transport: "rpc", client: null },
            ],
          }),
        }),
      ],
    })
    const meta = asRecord(indexDocument(graph)["meta"])
    expect(meta["endpointTransports"]).toEqual({ http: 1, rpc: 1 })
    expect(emitIndexView(graph)).toContain("transport: rpc are server functions")
  })

  it("says nothing about rpc when the app has none", () => {
    const graph = makeGraph({ screens: [makeScreen({ facts: makeFacts({ endpoints: [httpEndpoint()] }) })] })
    expect(emitIndexView(graph)).not.toContain("transport: rpc")
  })
})

describe("index: determinism", () => {
  const graph = makeGraph({
    screens: [
      makeScreen({ id: "/zeta", url: "/zeta", title: "Zeta" }),
      makeScreen({ id: "/Alpha", url: "/Alpha", title: "Alpha" }),
      makeScreen({ id: "/beta", url: "/beta", title: "Beta" }),
    ],
  })

  it("sorts screens by codepoint, not locale", () => {
    const urls = asRecords(indexDocument(graph)["screens"]).map((row) => row["url"])
    expect(urls).toEqual(["/Alpha", "/beta", "/zeta"])
  })

  it("is byte-identical across runs and carries no timestamp", () => {
    const first = emitIndexView(graph)
    expect(emitIndexView(graph)).toBe(first)
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(first.toLowerCase()).not.toContain("generated")
  })
})

describe("index: truncated scalars stay quoted", () => {
  it("quotes an activation guard sitting on the truncation boundary", () => {
    const expr = "a".repeat(110)
    const graph = makeGraph({
      screens: [
        makeScreen({
          id: "screen://state-screens/src%2FApp.tsx%230",
          url: null,
          addressable: false,
          activations: [{ kind: "state", holder: "App", expr }],
        }),
      ],
    })
    expect(emitIndexView(graph)).toContain(`when: "${expr}"`)
  })
})

describe("index: size discipline", () => {
  const SCREEN_COUNT = 34
  /**
   * The ceiling includes `meta.limitations`, a CONSTANT ~3.4 KB — the same strings whatever the app —
   * so it is a fixed offset on top of the per-screen budget this test guards. Real indexes run from
   * about 8 KB to over 40 KB, and it is screen count that drives them, not this block.
   */
  const INDEX_CEILING_BYTES = 16 * 1024
  const LIMITATIONS_BUDGET_BYTES = 4 * 1024

  const bigGraph = makeGraph({
    meta: makeMeta({
      // The real list, not a stub: emitting it is the point, so its cost has to be inside the ceiling.
      limitations: GRAPH_LIMITATIONS,
      counts: { screens: SCREEN_COUNT, components: 696, endpoints: 335 },
      confidence: [
        { section: "endpoints", count: 335, enablingDependency: "axios", dependencyInstalled: true, level: "high" },
        { section: "stores", count: 12, enablingDependency: "zustand", dependencyInstalled: true, level: "high" },
        { section: "testIds", count: 60, enablingDependency: null, dependencyInstalled: false, level: "high" },
      ],
    }),
    navGroups: [
      makeNavGroup({
        entries: Array.from({ length: 12 }, (_unused, index) =>
          makeNavEntry({ path: `/section-${index}`, label: `Section ${index}`, line: index + 1 }),
        ),
      }),
    ],
    // Densities mirror a real 34-screen index (8.6 KB): about a third of the
    // screens carry a test-id list, half carry a feature flag, most carry one or two nav targets.
    screens: Array.from({ length: SCREEN_COUNT }, (_unused, index) =>
      makeScreen({
        id: `/module-${index}/:id`,
        url: `/module-${index}/:id`,
        params: ["id"],
        title: `Module ${index}`,
        ...(index % 2 === 0 ? { featureFlag: `module_${index}` } : {}),
        entries: [
          { kind: "file", file: `src/modules/Module${index}/Module${index}.tsx`, exportName: "default" },
        ],
        navigatesTo: [
          { to: "/", matchedRoute: "/", trigger: "navigate", dynamic: false, from: `src/modules/Module${index}.tsx` },
          {
            to: `/module-${index}`,
            matchedRoute: `/module-${index}`,
            trigger: "link",
            dynamic: false,
            from: `src/modules/Module${index}.tsx`,
          },
        ],
        facts: makeFacts({
          testIds:
            index % 3 === 0
              ? [
                  "empty-list",
                  "filters.clear-all",
                  "filters.toggle-advanced",
                  "next-button",
                  "prev-button",
                  "search-option",
                  "data-table-empty-row",
                ]
              : [],
        }),
      }),
    ),
  })

  it(`stays under ${INDEX_CEILING_BYTES} bytes for ${SCREEN_COUNT} screens`, () => {
    const size = Buffer.byteLength(emitIndexView(bigGraph, { testIdAttribute: "data-testid" }), "utf8")
    expect(size).toBeLessThan(INDEX_CEILING_BYTES)
  })

  it("shrinks further without full test-id lists", () => {
    const withLists = Buffer.byteLength(emitIndexView(bigGraph, { testIdAttribute: "data-testid" }), "utf8")
    const withCounts = Buffer.byteLength(
      emitIndexView(bigGraph, { testIdAttribute: "data-testid", includeTestIds: false }),
      "utf8",
    )
    expect(withCounts).toBeLessThan(withLists)
    expect(withCounts).toBeLessThan(INDEX_CEILING_BYTES)
  })

  it("carries the stated limitations, and they cost a bounded constant", () => {
    const withLimitations = Buffer.byteLength(emitIndexView(bigGraph, { testIdAttribute: "data-testid" }), "utf8")
    const without = Buffer.byteLength(
      emitIndexView(
        { ...bigGraph, meta: { ...bigGraph.meta, limitations: [] } },
        { testIdAttribute: "data-testid" },
      ),
      "utf8",
    )
    expect(withLimitations - without).toBeGreaterThan(0)
    expect(withLimitations - without).toBeLessThan(LIMITATIONS_BUDGET_BYTES)
  })

  it("does not carry the per-file components dictionary, render trees or diagnostics", () => {
    const document = indexDocument(bigGraph, { testIdAttribute: "data-testid" })
    expect(Object.keys(document)).not.toContain("components")
    expect(Object.keys(document)).not.toContain("diagnostics")
    const yaml = emitIndexView(bigGraph, { testIdAttribute: "data-testid" })
    expect(yaml).not.toContain("tree:")
    expect(yaml).not.toContain("conditionalRendering:")
  })
})

describe("index: top-level key layout", () => {
  it("emits keys in a fixed order", () => {
    const graph = makeGraph({
      screens: [
        makeScreen(),
        makeScreen({ id: "screen://s/x", url: null, addressable: false, activations: [{ kind: "host", pattern: "*://*.example.com/*" }] }),
      ],
      redirects: [{ from: "/dashboard", to: "/analytics/orders" }],
      orphanScreens: ["/share/:token"],
      navGroups: [makeNavGroup()],
      deadNavLinks: [makeNavEntry({ path: "/nope", resolvedScreen: null })],
      shells: { "src/routes/RootLayout.tsx": makeShell() },
    })
    expect(Object.keys(indexDocument(graph))).toEqual([
      "meta",
      "selectors",
      "menu",
      "deadNavLinks",
      "screens",
      "stateScreens",
      "redirects",
      "orphanScreens",
    ])
  })
})

describe("redirect rules and viaRedirect in the views", () => {
  const viaRedirect = { from: "/org/acme", to: "/org/acme/general" }
  const graph = makeGraph({
    screens: [
      makeScreen({
        navigatesTo: [{ to: "/org/acme", matchedRoute: "/orders", trigger: "link", dynamic: false, from: "src/a.tsx", viaRedirect }],
      }),
    ],
    redirects: [
      { from: "/dashboard", to: "/analytics/orders" },
      { from: "/org/:slug", to: "/org/:slug/general", declaredAt: "next.config.ts:12", condition: "!IS_PLATFORM" },
      { from: "/:path*", to: "https://app.example.com/:path*", declaredAt: "next.config.ts:20", conditional: true },
    ],
    navGroups: [makeNavGroup({ entries: [makeNavEntry({ path: "/org/acme", viaRedirect }), makeNavEntry()] })],
  })

  it("shows declaredAt, condition, conditional and viaRedirect only when present in the index", () => {
    const document = indexDocument(graph)
    expect(document["redirects"]).toEqual([
      { from: "/:path*", to: "https://app.example.com/:path*", declaredAt: "next.config.ts:20", conditional: true },
      { from: "/dashboard", to: "/analytics/orders" },
      { from: "/org/:slug", to: "/org/:slug/general", declaredAt: "next.config.ts:12", condition: "!IS_PLATFORM" },
    ])
    expect(emitIndexView(graph).match(/conditional: true/g)).toHaveLength(1)
    const entries = asRecords(asRecords(document["menu"])[0]?.["entries"])
    expect(entries.map((entry) => entry["viaRedirect"] ?? null)).toEqual([null, viaRedirect])
  })

  it("shows the same fields in the full view", () => {
    const document = fullDocument(graph)
    expect(asRecords(document["redirects"])[0]?.["conditional"]).toBe(true)
    expect(asRecords(document["redirects"]).filter((redirect) => "conditional" in redirect)).toHaveLength(1)
    expect(asRecords(document["redirects"])[2]).toEqual({
      from: "/org/:slug",
      to: "/org/:slug/general",
      declaredAt: "next.config.ts:12",
      condition: "!IS_PLATFORM",
    })
    const entries = asRecords(asRecords(document["navGroups"])[0]?.["entries"])
    expect(entries.map((entry) => entry["viaRedirect"] ?? null)).toEqual([null, viaRedirect])
    expect(asRecords(asRecords(document["screens"])[0]?.["navigatesTo"])[0]?.["viaRedirect"]).toEqual(viaRedirect)
  })
})

describe("viaRedirect alternatives in the views", () => {
  const alternatives = [
    { to: "/settings/general", condition: "authority = SYS_ADMIN" },
    { to: "/settings/home", condition: "authority = TENANT_ADMIN" },
  ]
  const via = { from: "/settings", to: "/settings/general", condition: "authority = SYS_ADMIN", alternatives }
  const lone = { from: "/x", to: "/home", condition: "beta", alternatives: alternatives.slice(0, 1) }
  const graph = makeGraph({
    screens: [
      makeScreen({
        navigatesTo: [
          { to: "/settings", matchedRoute: "/orders", trigger: "link", dynamic: false, from: "src/a.tsx", viaRedirect: via },
          { to: "/x", matchedRoute: "/orders", trigger: "link", dynamic: false, from: "src/a.tsx", viaRedirect: lone },
        ],
      }),
    ],
    navGroups: [makeNavGroup({ entries: [makeNavEntry({ path: "/settings", viaRedirect: via })] })],
  })

  it("emits every alternative in the YAML index and the full view", () => {
    const yaml = emitIndexView(graph)
    expect(yaml).toContain("alternatives:")
    expect(yaml).toContain("to: /settings/home")
    expect(yaml).toContain("condition: authority = TENANT_ADMIN")
    const entries = asRecords(asRecords(indexDocument(graph)["menu"])[0]?.["entries"])
    expect(entries[0]?.["viaRedirect"]).toEqual(via)

    const edges = asRecords(asRecords(fullDocument(graph)["screens"])[0]?.["navigatesTo"])
    expect(edges.map((edge) => edge["viaRedirect"])).toEqual([via, { from: "/x", to: "/home", condition: "beta" }])
  })
})

describe("viaRedirect provenance and placement ambiguity in the views", () => {
  const conditionalVia = {
    from: "/x",
    to: "/project/default",
    declaredAt: "next.config.ts:40",
    condition: "!isPlatform",
  }
  const plainVia = { from: "/org/acme", to: "/org/acme/general" }
  const graph = makeGraph({
    screens: [
      makeScreen({
        navigatesTo: [
          { to: "/x", matchedRoute: "/orders", trigger: "link", dynamic: false, from: "src/a.tsx", viaRedirect: conditionalVia },
          { to: "/org/acme", matchedRoute: "/orders", trigger: "link", dynamic: false, from: "src/a.tsx", viaRedirect: plainVia },
        ],
        placementAmbiguous: ["src/layout/LayoutPicker.tsx"],
      }),
      makeScreen({ id: "/plain", url: "/plain", activations: [{ kind: "url", template: "/plain", params: [] }] }),
    ],
    navGroups: [makeNavGroup({ entries: [makeNavEntry({ path: "/x", viaRedirect: conditionalVia })] })],
  })

  it("carries declaredAt and condition on viaRedirect, and omits them when absent", () => {
    const index = indexDocument(graph)
    const entries = asRecords(asRecords(index["menu"])[0]?.["entries"])
    expect(entries[0]?.["viaRedirect"]).toEqual(conditionalVia)

    const full = fullDocument(graph)
    const edges = asRecords(asRecords(full["screens"]).find((screen) => screen["id"] === "/orders")?.["navigatesTo"])
    expect(edges.map((edge) => edge["viaRedirect"])).toEqual([plainVia, conditionalVia])
    expect(Object.keys(edges[0]?.["viaRedirect"] ?? {})).toEqual(["from", "to"])
  })

  it("marks an ambiguous placement on the index row and in the full view, and only there", () => {
    const rows = asRecords(indexDocument(graph)["screens"])
    expect(rows.find((row) => row["url"] === "/orders")?.["placementAmbiguous"]).toEqual(["src/layout/LayoutPicker.tsx"])
    expect(rows.find((row) => row["url"] === "/plain")).not.toHaveProperty("placementAmbiguous")

    const screens = asRecords(fullDocument(graph)["screens"])
    expect(screens.find((screen) => screen["id"] === "/orders")?.["placementAmbiguous"]).toEqual([
      "src/layout/LayoutPicker.tsx",
    ])
    expect(screens.find((screen) => screen["id"] === "/plain")).not.toHaveProperty("placementAmbiguous")
  })
})
