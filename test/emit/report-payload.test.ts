import { describe, expect, it } from "vitest"
import type { AppGraph, FileFacts, Screen, ScreenFacts, TreeNode } from "../../src/core/model.js"
import { edgeGeometry, layoutGraph } from "../../src/emit/html-graph.js"
import type { SerializedReportPayload } from "../../src/emit/report-payload.js"
import { buildReportPayload, serializePayload, toSerializedPayload } from "../../src/emit/report-payload.js"
import { createTreeHydrator } from "../../src/emit/tree-intern.js"
import { STRING_KEYS, t } from "../../src/emit/strings.js"

const emptyFacts: ScreenFacts = {
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
}

const HOSTILE = "</script><!-- \u2028 \u2029 & >"

const screenOf = (id: string, overrides: Partial<Screen> = {}): Screen => ({
  id,
  localId: `src/screens${id}.tsx`,
  source: "react-router",
  activations: [{ kind: "url", template: id, params: [] }],
  url: id,
  params: [],
  title: `Title ${id}`,
  kindTag: null,
  entries: [{ kind: "file", file: `src/app${id}/page.tsx`, exportName: "default" }],
  ancestors: [{ file: "src/Layout.tsx", exportName: "Layout", role: "layout", splice: { kind: "outlet", tag: "Outlet" } }],
  shell: "main",
  auth: "public",
  featureFlag: null,
  redirectTo: null,
  devOnly: false,
  addressable: true,
  tree: [],
  reachable: ["a", "b"],
  facts: {
    ...emptyFacts,
    endpoints: [{ method: "GET", url: "/api/items", transport: "http", client: null }],
    extra: { "0": ["zero"], messageHandlers: [{ type: "ping" }] },
  },
  navigatesTo: [
    { to: "/b", matchedRoute: "/b", trigger: "link", dynamic: false, from: "src/a.tsx" },
    { to: "/b", matchedRoute: "/b", trigger: "navigate", dynamic: false, from: "src/c.tsx" },
  ],
  provenance: { sources: ["react-router"], evidence: [], mergedFrom: [], decisions: [] },
  ...overrides,
})

const componentOf = (index: number): FileFacts => ({
  file: `src/components/C${String(index).padStart(3, "0")}.tsx`,
  component: `C${index}`,
  kind: index % 2 === 0 ? "ui" : "shared",
  renders: Array.from({ length: index % 5 }, () => ({
    file: "src/x.tsx",
    conditions: [],
    alwaysRendered: true,
    repeated: false,
  })),
  nullGuards: [],
  uses: [],
  hooks: [],
  stores: [],
  queryKeys: [],
  mutations: 0,
  endpoints: [],
  navigations: [],
  i18nNamespaces: [],
  testIds: [],
  formSchemas: [],
  formFields: [],
  featureGates: [],
  messages: [],
  extra: {},
})

const COMPONENT_TOTAL = 450

const baseMeta: AppGraph["meta"] = {
  schemaVersion: 2,
    appgraphVersion: "0.1.0",
    root: "frontend",
    appName: null,
    sourceRoots: ["src"],
    screenSources: ["react-router"],
    maxDepth: 3,
    fingerprint: "fixture",
    counts: {},
    confidence: [
      { section: "stores", count: 0, enablingDependency: "zustand", dependencyInstalled: true, level: "suspect" },
      { section: "screens", count: 3, enablingDependency: null, dependencyInstalled: false, level: "high" },
    ],
    limitations: ["limit"],
}

const graph: AppGraph = {
  meta: { ...baseMeta, emptyResult: true, emptyReason: "no screens found" },
  screens: [
    screenOf("/api/health", { kindTag: "apiRoute" }),
    screenOf("/a", { auth: "unknown", title: HOSTILE }),
    screenOf("/b", { auth: "protected" }),
    screenOf("/a/c", { url: null, addressable: false, activations: [{ kind: "state", holder: "h", expr: "s" }] }),
  ],
  redirects: [],
  shells: {
    main: {
      file: "src/Shell.tsx",
      layouts: ["Main"],
      tree: [],
      navigatesTo: [],
      endpoints: [{ method: "POST", url: "/s", transport: "rpc", client: null }],
      stores: [],
      i18nNamespaces: [],
      testIds: [],
    },
  },
  components: Object.fromEntries(
    Array.from({ length: COMPONENT_TOTAL }, (_, index) => componentOf(index)).map((facts) => [facts.file, facts]),
  ),
  navGroups: [],
  navigation: [
    { from: "/a", to: "/b", trigger: "link", dynamic: false, via: "x" },
    { from: "/b", to: "/a", trigger: "link", dynamic: true, via: "x" },
  ],
  deadNavLinks: [],
  orphanScreens: ["/a/c"],
  diagnostics: [
    { severity: "info", code: "I1", message: "info", plugin: null },
    { severity: "error", code: "E1", message: "error", plugin: "p", file: "f.ts", line: 2 },
    { severity: "warning", code: "W1", message: "warn", plugin: null },
  ],
}

const OPTIONS = { locale: "en", generatedAt: "2026-01-01T00:00:00.000Z" } as const

const INTEGER_LIKE = /^(0|[1-9]\d*)$/

type Violation = { readonly path: string; readonly reason: string }

const violationsOf = (value: unknown, path: string): readonly Violation[] => {
  if (value === undefined) return [{ path, reason: "undefined" }]
  if (value instanceof Map || value instanceof Set) return [{ path, reason: "Map/Set" }]
  if (typeof value === "number" && !Number.isFinite(value)) return [{ path, reason: "non-finite number" }]
  if (Array.isArray(value)) return value.flatMap((item, index) => violationsOf(item, `${path}[${index}]`))
  if (value === null || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, child]) => [
    ...(INTEGER_LIKE.test(key) ? [{ path: `${path}.${key}`, reason: "integer-like key" }] : []),
    ...violationsOf(child, `${path}.${key}`),
  ])
}

describe("buildReportPayload — shape", () => {
  const payload = buildReportPayload(graph, OPTIONS)

  it("contains only plain JSON values with no integer-like keys", () => {
    expect(violationsOf(payload, "payload")).toEqual([])
  })

  it("keeps every component, beyond the old 400-row cap, sorted by renders then file", () => {
    expect(payload.components).toHaveLength(COMPONENT_TOTAL)
    expect(payload.meta.counts.components).toBe(COMPONENT_TOTAL)
    const first = payload.components[0]
    const second = payload.components[1]
    expect(first?.renders).toBe(4)
    expect(first && second && first.file < second.file).toBe(true)
  })

  it("preserves auth unknown", () => {
    expect(payload.screens.find((screen) => screen.id === "/a")?.auth).toBe("unknown")
    expect(payload.graph.nodes.find((node) => node.id === "/a")?.auth).toBe("unknown")
  })

  it("surfaces emptyResult and emptyReason", () => {
    expect(payload.meta.emptyResult).toBe(true)
    expect(payload.meta.emptyReason).toBe("no screens found")
    const plain = buildReportPayload({ ...graph, meta: baseMeta }, OPTIONS)
    expect(plain.meta.emptyResult).toBe(false)
    expect(plain.meta.emptyReason).toBeNull()
  })

  it("falls back to root for the app name and counts api routes apart", () => {
    expect(payload.meta.appName).toBe("frontend")
    expect(payload.meta.counts.screens).toBe(3)
    expect(payload.meta.counts.apiRoutes).toBe(1)
    expect(payload.meta.counts.endpoints).toBe(2)
  })

  it("keeps redirects out of the header's screen count, matching meta.counts.screens", () => {
    const withRedirect = buildReportPayload(
      {
        ...graph,
        screens: [...graph.screens, screenOf("/old", { redirectTo: "/a" })],
        redirects: [{ from: "/old", to: "/a" }],
      },
      OPTIONS,
    )
    expect(withRedirect.meta.counts.screens).toBe(3)
    expect(withRedirect.meta.counts.redirects).toBe(1)
    expect(withRedirect.meta.counts.apiRoutes).toBe(1)
  })

  it("lists non-API screens first and flags API screens", () => {
    expect(payload.screens.map((screen) => screen.id)).toEqual(["/a", "/b", "/a/c", "/api/health"])
    expect(payload.screens.map((screen) => screen.isApi)).toEqual([false, false, false, true])
  })

  it("precomputes labels, search, nav chips and splice text", () => {
    const unaddressable = payload.screens.find((screen) => screen.id === "/a/c")
    expect(unaddressable?.primaryLabel).toBe(t("en", "activationStateDetail", { expr: "s" }))
    const screen = payload.screens.find((candidate) => candidate.id === "/b")
    expect(screen?.search).toContain("title /b")
    expect(screen?.navChips).toEqual([
      expect.objectContaining({ to: "/b", sources: ["link @ src/a.tsx", "navigate @ src/c.tsx"] }),
    ])
    expect(screen?.ancestors[0]?.spliceLabel).toBe("outlet <Outlet>")
    expect(screen?.facts.extra.map((row) => row.channel)).toEqual(["0", "messageHandlers"])
  })

  it("carries the route name and indexes it for search only when the screen has one", () => {
    const named = buildReportPayload(
      { ...graph, screens: [screenOf("/named", { url: "/named", routeName: "user-profile" })] },
      OPTIONS,
    ).screens[0]
    expect(named?.routeName).toBe("user-profile")
    expect(named?.search).toContain("user-profile")
    const plain = payload.screens.find((screen) => screen.id === "/b")
    expect(plain).not.toHaveProperty("routeName")
  })

  it("orders diagnostics by severity and computes confidence status", () => {
    expect(payload.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["E1", "W1", "I1"])
    expect(payload.confidence.map((row) => row.status)).toEqual(["empty-unexpected", "ok"])
  })

  it("exposes kinds and methods with palette slugs", () => {
    expect(payload.kinds).toEqual([
      { key: "shared", slug: "shared" },
      { key: "ui", slug: "ui" },
    ])
    expect(payload.methods).toEqual([
      { key: "http:get", slug: "http-get" },
      { key: "rpc:post", slug: "rpc-post" },
    ])
  })

  it("draws edges with the shared edge geometry", () => {
    expect(payload.graph.edges.length).toBeGreaterThan(0)
    expect(payload.graph.edges).toEqual(edgeGeometry(layoutGraph(graph)))
  })

  it("merges nav chips per target and dynamic flag with distinct, sorted sources", () => {
    const nav = (to: string, dynamic: boolean, from: string, trigger: "link" | "navigate" = "link") => ({
      to,
      matchedRoute: to,
      trigger,
      dynamic,
      from,
    })
    const navigatesTo = [
      nav("/en/privacy", true, "src/Footer.tsx"),
      nav("/en/privacy", true, "src/Banner.tsx"),
      nav("/en/privacy", true, "src/Footer.tsx"),
      nav("/en/privacy", false, "src/Footer.tsx"),
      nav("/about", false, "src/Home.tsx", "navigate"),
    ]
    const chips = buildReportPayload({ ...graph, screens: [screenOf("/n", { navigatesTo })] }, OPTIONS).screens[0]?.navChips
    expect(chips?.map((chip) => [chip.to, chip.dynamic, chip.sources])).toEqual(
      expect.arrayContaining([
        ["/en/privacy", true, ["link @ src/Banner.tsx", "link @ src/Footer.tsx"]],
        ["/en/privacy", false, ["link @ src/Footer.tsx"]],
        ["/about", false, ["navigate @ src/Home.tsx"]],
      ]),
    )
    expect(chips).toHaveLength(3)
  })

  it("names the lookup expression in a chip source, so an expanded dynamic edge says where it came from", () => {
    const navigatesTo = [
      { to: "/members", matchedRoute: "/members", trigger: "navigate" as const, dynamic: true, from: "src/AppSidebar.tsx", expr: "pathByTab[tab]" },
    ]
    const chips = buildReportPayload({ ...graph, screens: [screenOf("/n", { navigatesTo })] }, OPTIONS).screens[0]?.navChips
    expect(chips?.[0]?.sources).toEqual(["navigate @ src/AppSidebar.tsx — pathByTab[tab]"])
  })

  it("passes render-tree provenance through untouched", () => {
    const tree: Screen["tree"] = [
      {
        file: "src/Lazy.tsx",
        component: "Lazy",
        kind: "ui",
        conditions: [],
        alwaysRendered: true,
        repeated: false,
        via: "lazy",
        nullGuards: [],
        children: [],
        truncated: false,
        repeat: false,
      },
    ]
    const withTree = buildReportPayload({ ...graph, screens: [screenOf("/t", { tree })] }, OPTIONS)
    expect(withTree.screens[0]?.tree).toEqual(tree)
  })

  it("labels generic route modules by the route they serve and keeps named components bare", () => {
    const facts = (file: string, component: string): FileFacts => ({ ...componentOf(0), file, component, renders: [] })
    const routed = buildReportPayload(
      {
        ...graph,
        screens: [
          screenOf("/credits", { entries: [{ kind: "file", file: "src/app/(a)/credits/page.tsx", exportName: "default" }] }),
          screenOf("/credits/history", {
            entries: [{ kind: "file", file: "src/app/(a)/credits/history/page.tsx", exportName: "default" }],
          }),
        ],
        components: {
          a: facts("src/app/(a)/credits/page.tsx", "page"),
          b: facts("src/app/(a)/credits/layout.tsx", "layout"),
          c: facts("src/components/Modal.tsx", "Modal"),
        },
      },
      OPTIONS,
    )
    const routeOf = (file: string) => routed.components.find((row) => row.file === file)?.route
    expect(routeOf("src/app/(a)/credits/page.tsx")).toBe("/credits")
    expect(routeOf("src/app/(a)/credits/layout.tsx")).toBe("/credits")
    expect(routeOf("src/components/Modal.tsx")).toBeNull()
  })

  it("labels confidence rows with the four-state status", () => {
    const confidence: AppGraph["meta"]["confidence"] = [
      { section: "stores", count: 0, enablingDependency: "zustand", dependencyInstalled: true, level: "suspect" },
      { section: "testIds", count: 0, enablingDependency: null, dependencyInstalled: false, level: "low" },
      { section: "hooks", count: 4, enablingDependency: null, dependencyInstalled: false, level: "low" },
      { section: "i18nNamespaces", count: 3, enablingDependency: null, dependencyInstalled: false, level: "high" },
    ]
    const rows = buildReportPayload({ ...graph, meta: { ...baseMeta, confidence } }, OPTIONS).confidence
    expect(rows.map((row) => row.status)).toEqual(["empty-unexpected", "empty-expected", "partial", "ok"])
  })

  it("keeps the messages channel and stringifies open extra channels", () => {
    const facts = { ...emptyFacts, messages: ["AUTH_DONE"], extra: { serverFns: [{ name: "getUser" }] } }
    const row = buildReportPayload({ ...graph, screens: [screenOf("/m", { facts })] }, OPTIONS).screens[0]
    expect(row?.facts.messages).toEqual(["AUTH_DONE"])
    expect(row?.facts.extra).toEqual([{ channel: "serverFns", values: ['{"name":"getUser"}'] }])
  })
})

describe("buildReportPayload — navigation map", () => {
  const link = (from: string, to: string, dynamic = false): AppGraph["navigation"][number] => ({
    from,
    to,
    trigger: "link",
    dynamic,
    via: "x.tsx",
  })

  const mapOf = (urls: readonly string[], navigation: AppGraph["navigation"] = [], extra: readonly Screen[] = []) =>
    buildReportPayload(
      { ...graph, screens: [...urls.map((url) => screenOf(url)), ...extra], navigation, orphanScreens: [] },
      OPTIONS,
    ).graph

  const edgePoints = (map: ReturnType<typeof mapOf>) =>
    map.edges.flatMap((edge) =>
      [...edge.d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((point) => ({ x: Number(point[1]), y: Number(point[2]) })),
    )

  it("lays out screens with zero edges using finite numbers", () => {
    const map = mapOf(["/home"])
    expect(map.edges).toEqual([])
    expect(map.nodes).toHaveLength(1)
    expect(violationsOf(map, "graph")).toEqual([])
    expect(map.width).toBeGreaterThan(0)
    expect(map.height).toBeGreaterThan(0)
  })

  it("collapses duplicate edges, drops self links and never overlaps two nodes inside the canvas", () => {
    const urls = ["/", "/admin", "/admin/users", "/admin/users/:id", "/app", "/app/tasks", "/pricing", "/terms"]
    const map = mapOf(urls, [
      link("/", "/pricing"),
      link("/", "/pricing"),
      link("/admin", "/admin/users", true),
      link("/admin", "/admin"),
    ])
    expect(map.edges.map((edge) => [edge.from, edge.to, edge.weight, edge.dynamic])).toEqual(
      expect.arrayContaining([
        ["/", "/pricing", 2, false],
        ["/admin", "/admin/users", 1, true],
      ]),
    )
    expect(map.edges).toHaveLength(2)
    expect(map.nodes).toHaveLength(urls.length)
    for (const node of map.nodes) {
      expect(node.x).toBeLessThan(map.width)
      expect(node.y).toBeLessThan(map.height)
    }
    expect(new Set(map.nodes.map((node) => `${node.x},${node.y}`)).size).toBe(urls.length)
    expect(map.headers.map((header) => header.key)).toContain("/admin")
  })

  it("lays out the map identically on every build", () => {
    const urls = ["/b", "/a", "/a/x", "/c/y", "/c/z"]
    expect(mapOf(urls, [link("/a", "/c/y")])).toEqual(mapOf(urls, [link("/a", "/c/y")]))
  })

  it("keeps API route handlers and screens without a URL off the map", () => {
    const map = mapOf(
      ["/home"],
      [],
      [
        screenOf("/api/users", { kindTag: "apiRoute" }),
        screenOf("screen://dialog-1", { url: null, activations: [{ kind: "state", holder: "C", expr: "open" }] }),
      ],
    )
    expect(map.nodes.map((node) => node.id)).toEqual(["/home"])
  })

  const rootRoutes = ["/", "/archive", "/databases", "/login", "/storage", "/trash"]
  const manyGroups = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].flatMap((group) =>
    Array.from({ length: 10 }, (_, index) => `/${group}/a-rather-long-segment-${index}`),
  )
  const tallRoot = Array.from({ length: 20 }, (_, index) => `/page-${String(index).padStart(2, "0")}`)

  it.each([
    {
      name: "first-column back edges spanning several groups",
      urls: [...rootRoutes, "/admin/users", "/dev/pdf-preview", "/projects", "/projects/:projectId"],
      navigation: [
        ...rootRoutes.slice(1).map((url) => link(url, "/")),
        link("/", "/admin/users"),
        link("/", "/dev/pdf-preview"),
        link("/projects", "/"),
        link("/projects/:projectId", "/projects"),
      ],
    },
    { name: "adjacent rows in the first column", urls: rootRoutes, navigation: [link("/", "/archive")] },
    {
      name: "maximum bow between the first and last row of a tall column",
      urls: tallRoot,
      navigation: [link("/page-00", "/page-19"), link("/page-19", "/page-00")],
    },
    {
      name: "cross-column edges in both directions and a same-column edge in a later column",
      urls: manyGroups,
      navigation: [
        link("/alpha/a-rather-long-segment-0", "/zeta/a-rather-long-segment-9"),
        link("/zeta/a-rather-long-segment-9", "/alpha/a-rather-long-segment-0"),
        link("/zeta/a-rather-long-segment-0", "/zeta/a-rather-long-segment-9"),
      ],
    },
  ])("keeps every edge inside the canvas: $name", ({ urls, navigation }) => {
    const map = mapOf(urls, navigation)
    const points = edgePoints(map)
    expect(points.length).toBeGreaterThan(0)
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThanOrEqual(map.width)
      expect(point.y).toBeGreaterThanOrEqual(0)
      expect(point.y).toBeLessThanOrEqual(map.height)
    }
  })
})

describe("buildReportPayload — strings", () => {
  it("carries the raw table of the chosen locale with exactly the en key set", () => {
    const en = buildReportPayload(graph, OPTIONS)
    expect(Object.keys(en.strings)).toEqual(STRING_KEYS)
    expect(en.strings.headerTitle).toContain("{{appName}}")
  })

  it("picks the pl table for the pl locale", () => {
    const pl = buildReportPayload(graph, { ...OPTIONS, locale: "pl" })
    expect(pl.locale).toBe("pl")
    expect(Object.keys(pl.strings)).toEqual(STRING_KEYS)
    expect(pl.strings.headerTitle).toBe(t("pl", "headerTitle"))
    expect(pl.strings.headerTitle).not.toBe(t("en", "headerTitle"))
  })
})

describe("buildReportPayload — intercept activation and slot splice", () => {
  const intercepted: AppGraph = {
    ...graph,
    screens: [
      screenOf("/photo/:id", {
        activations: [
          { kind: "url", template: "/photo/:id", params: ["id"] },
          { kind: "intercept", from: "/feed", slot: "modal", file: "src/app/@modal/(.)photo/[id]/page.tsx" },
        ],
        ancestors: [{ file: "src/app/layout.tsx", exportName: "default", role: "layout", splice: { kind: "slot", name: "modal" } }],
      }),
    ],
  }

  it.each([
    ["en", "Intercepted", "intercepted from /feed"],
    ["pl", "Przechwycony", "przechwycony z /feed"],
  ] as const)("labels the intercept activation in %s", (locale, kindLabel, label) => {
    const screen = buildReportPayload(intercepted, { ...OPTIONS, locale }).screens[0]
    expect(screen?.activations[1]).toEqual({ kind: "intercept", label, kindLabel })
  })

  it("labels a slot splice by its prop", () => {
    const ancestor = buildReportPayload(intercepted, OPTIONS).screens[0]?.ancestors[0]
    expect(ancestor?.spliceKind).toBe("slot")
    expect(ancestor?.spliceLabel).toBe("slot {modal}")
  })
})

describe("serializePayload", () => {
  it("is byte-identical across runs", () => {
    expect(serializePayload(buildReportPayload(graph, OPTIONS))).toBe(serializePayload(buildReportPayload(graph, OPTIONS)))
  })

  it("escapes script-breaking characters and still round-trips", () => {
    const payload = buildReportPayload(graph, OPTIONS)
    const json = serializePayload(payload)
    expect(json).not.toContain("</script>")
    expect(json).not.toContain("<!--")
    expect(json).not.toMatch(/[<>&\u2028\u2029]/)
    expect(json).toContain("\\u003c/script\\u003e")
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(toSerializedPayload(payload))))
    expect(JSON.parse(json).screens[0].title).toBe(HOSTILE)
  })
})

describe("serializePayload — tree interning", () => {
  const leaf = (file: string, component: string): TreeNode => ({
    file,
    component,
    kind: "ui",
    conditions: [],
    alwaysRendered: true,
    repeated: false,
    nullGuards: [],
    children: [],
    truncated: false,
    repeat: false,
  })
  const shared = { ...leaf("src/Shared.tsx", "Shared"), children: [leaf("src/Button.tsx", "Button")] }
  const apiScreen = screenOf("/api/x", { kindTag: "api", tree: [shared] })
  const internGraph: AppGraph = {
    ...graph,
    screens: [apiScreen, screenOf("/a", { tree: [shared, leaf("src/A.tsx", "A")] }), screenOf("/b", { tree: [shared] })],
    shells: {
      zeta: { file: "src/Zeta.tsx", layouts: [], tree: [shared], navigatesTo: [], endpoints: [], stores: [], i18nNamespaces: [], testIds: [] },
      alpha: { file: "src/Alpha.tsx", layouts: [], tree: [leaf("src/Alpha.tsx", "Alpha")], navigatesTo: [], endpoints: [], stores: [], i18nNamespaces: [], testIds: [] },
    },
  }
  const payload = buildReportPayload(internGraph, OPTIONS)
  const serialized = toSerializedPayload(payload)

  const parsed: SerializedReportPayload = JSON.parse(serializePayload(payload))

  const hydrated = () => {
    const hydrate = createTreeHydrator(parsed.subtrees, parsed.paths)
    return {
      ...parsed,
      screens: parsed.screens.map((screen) => ({ ...screen, tree: screen.tree.map(hydrate) })),
      shells: parsed.shells.map((shell) => ({ ...shell, tree: shell.tree.map(hydrate) })),
    }
  }

  it("stores each distinct subtree once and references roots by id", () => {
    expect(serialized.subtrees).toHaveLength(4)
    expect(serialized.paths).toEqual(["src/Shared.tsx", "src/Button.tsx", "src/A.tsx", "src/Alpha.tsx"])
    expect(serialized.screens.map((screen) => screen.tree)).toEqual([[1, 2], [1], [1]])
    expect(serialized.shells.map((shell) => shell.tree)).toEqual([[3], [1]])
  })

  it("numbers subtrees first-seen in screen order, then shells sorted by id", () => {
    expect(serialized.screens.map((screen) => screen.id)).toEqual(["/a", "/b", "/api/x"])
    expect(serialized.shells.map((shell) => shell.id)).toEqual(["alpha", "zeta"])
  })

  it("hydrates back to the in-memory payload", () => {
    expect(hydrated()).toEqual({ ...JSON.parse(JSON.stringify(payload)), paths: parsed.paths, subtrees: parsed.subtrees })
  })
})

describe("serializePayload size", () => {
  it("stays under 3x the input graph JSON", () => {
    const json = serializePayload(buildReportPayload(graph, OPTIONS))
    expect(json.length).toBeLessThan(JSON.stringify(graph).length * 3)
  })
})
