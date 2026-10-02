import { describe, expect, it } from "vitest"
import type { AppGraph, FileFacts, Screen, ScreenFacts, ShellReport, TreeNode } from "../../src/core/model.js"
import { emitFullView, fullDocument } from "../../src/emit/view-full.js"

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

const makeTreeNode = (overrides: Partial<TreeNode> = {}): TreeNode => ({
  file: "src/components/Thing.tsx",
  component: "Thing",
  kind: "ui",
  conditions: [],
  alwaysRendered: true,
  repeated: false,
  nullGuards: [],
  children: [],
  truncated: false,
  repeat: false,
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

const makeComponent = (overrides: Partial<FileFacts> = {}): FileFacts => ({
  file: "src/components/Thing.tsx",
  component: "Thing",
  kind: "ui",
  renders: [],
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
  ...overrides,
})

const makeGraph = (overrides: Partial<AppGraph> = {}): AppGraph => ({
  meta: {
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
  },
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

const asRecords = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? (value as readonly Record<string, unknown>[]) : []

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const graph = makeGraph({
  meta: {
    schemaVersion: 2,
    appgraphVersion: "0.1.0",
    root: "frontend",
    appName: "frontend",
    sourceRoots: ["src", "app"],
    screenSources: ["react-router", "state-screens"],
    maxDepth: 3,
    fingerprint: "deadbeef",
    counts: { screens: 2, components: 2 },
    confidence: [
      { section: "stores", count: 0, enablingDependency: "zustand", dependencyInstalled: true, level: "suspect" },
      { section: "endpoints", count: 0, enablingDependency: "axios", dependencyInstalled: false, level: "low" },
    ],
    limitations: ["Guards are detected, never evaluated."],
  },
  screens: [
    makeScreen({
      tree: [makeTreeNode({ conditions: ["isOpen"], alwaysRendered: false, nullGuards: ["!data"] })],
      facts: makeFacts({
        endpoints: [
          { method: "GET", url: "/api/orders", transport: "http", client: "axios" },
          { method: "POST", url: "listOrders", transport: "rpc", client: null },
        ],
        queryKeys: ["orders"],
        extra: { messagesV2: ["PING"] },
      }),
    }),
    makeScreen({
      id: "screen://state-screens/src%2FApp.tsx%230",
      localId: "src/App.tsx#0",
      source: "state-screens",
      activations: [{ kind: "state", holder: "App", expr: "isAuthenticated" }],
      url: null,
      addressable: false,
      title: "Main",
    }),
  ],
  shells: { "src/routes/RootLayout.tsx": makeShell() },
  components: {
    "src/components/Zeta.tsx": makeComponent({ file: "src/components/Zeta.tsx", component: "Zeta" }),
    "src/components/Alpha.tsx": makeComponent({
      file: "src/components/Alpha.tsx",
      component: "Alpha",
      renders: [{ file: "src/components/Zeta.tsx", conditions: ["ready"], alwaysRendered: false, repeated: true }],
      queryKeys: ["alpha"],
    }),
  },
  navGroups: [
    {
      name: "routeGroups",
      source: "src/config.tsx#routeGroups",
      score: 0.5,
      availableOnShells: ["src/routes/RootLayout.tsx"],
      entries: [
        {
          path: "/results",
          parentPath: null,
          label: "Results",
          labelKey: null,
          featureFlag: null,
          source: "src/config.tsx#routeGroups",
          file: "src/config.tsx",
          line: 42,
          resolvedScreen: null,
        },
      ],
    },
  ],
  navigation: [{ from: "/orders", to: "/orders/:id", trigger: "navigate", dynamic: false, via: "src/x.tsx" }],
  deadNavLinks: [
    {
      path: "/results",
      parentPath: null,
      label: "Results",
      labelKey: null,
      featureFlag: null,
      source: "src/config.tsx#routeGroups",
      file: "src/config.tsx",
      line: 42,
      resolvedScreen: null,
    },
  ],
  orphanScreens: ["/share/:token"],
  diagnostics: [
    { severity: "warning", code: "nav/dead-link", message: "no screen serves /results", plugin: "nav", line: 42 },
    { severity: "info", code: "screens/merged", message: "merged", plugin: null, screenId: "/orders" },
  ],
})

describe("full: top-level key layout", () => {
  it("emits every block of the AppGraph", () => {
    expect(Object.keys(fullDocument(graph))).toEqual([
      "meta",
      "selectors",
      "screens",
      "stateScreens",
      "redirects",
      "shells",
      "subtrees",
      "components",
      "navGroups",
      "navigation",
      "deadNavLinks",
      "orphanScreens",
      "diagnostics",
    ])
  })

  it("carries the per-file facts dictionary that detail deliberately drops", () => {
    const components = asRecord(fullDocument(graph)["components"])
    expect(Object.keys(components)).toEqual(["src/components/Alpha.tsx", "src/components/Zeta.tsx"])
    const alpha = asRecord(components["src/components/Alpha.tsx"])
    expect(asRecords(alpha["renders"])[0]).toEqual({
      file: "src/components/Zeta.tsx",
      conditions: ["ready"],
      alwaysRendered: false,
      repeated: true,
    })
  })

  it("emits via on tree nodes and render edges only when the edge has a provenance", () => {
    const marked = makeGraph({
      screens: [
        makeScreen({
          tree: [makeTreeNode({ children: [makeTreeNode({ file: "src/Lazy.tsx", via: "lazy" })] })],
        }),
      ],
      components: {
        "src/A.tsx": makeComponent({
          file: "src/A.tsx",
          renders: [
            { file: "src/B.tsx", conditions: [], alwaysRendered: true, repeated: false },
            { file: "src/C.tsx", conditions: [], alwaysRendered: false, repeated: false, via: "reference" },
          ],
        }),
      },
    })
    const document = fullDocument(marked)
    const root = asRecords(asRecords(document["screens"])[0]?.["tree"])[0] ?? {}
    expect("via" in root).toBe(false)
    expect(asRecords(root["children"])[0]?.["via"]).toBe("lazy")

    const renders = asRecords(asRecord(asRecord(document["components"])["src/A.tsx"])["renders"])
    expect(renders.map((edge) => edge["via"] ?? null)).toEqual([null, "reference"])
    expect(emitFullView(marked)).toBe(emitFullView(marked))
  })

  it("prints an Angular selector provenance as via: selector in the YAML", () => {
    const angular = makeGraph({
      screens: [
        makeScreen({
          tree: [makeTreeNode({ children: [makeTreeNode({ file: "src/app/card.component.ts", via: "selector" })] })],
        }),
      ],
      components: {
        "src/app/list.component.ts": makeComponent({
          file: "src/app/list.component.ts",
          renders: [
            { file: "src/app/card.component.ts", conditions: [], alwaysRendered: true, repeated: false, via: "selector" },
            { file: "src/app/chip.component.ts", conditions: [], alwaysRendered: true, repeated: false, via: "selector-global" },
          ],
        }),
      },
    })
    const yaml = emitFullView(angular)
    expect(yaml).toMatch(/\n\s+via: selector\n/)
    expect(yaml).toMatch(/\n\s+via: selector-global\n/)
    const renders = asRecords(asRecord(asRecord(fullDocument(angular)["components"])["src/app/list.component.ts"])["renders"])
    expect(renders.map((edge) => edge["via"])).toEqual(["selector", "selector-global"])
  })

  it("keeps every diagnostic, not only the screen-scoped ones", () => {
    expect(asRecords(fullDocument(graph)["diagnostics"]).map((entry) => entry["code"])).toEqual([
      "nav/dead-link",
      "screens/merged",
    ])
  })

  it("keeps meta fields the index leaves out", () => {
    const meta = asRecord(fullDocument(graph)["meta"])
    expect(meta["sourceRoots"]).toEqual(["app", "src"])
    expect(meta["fingerprint"]).toBe("deadbeef")
    expect(meta["limitations"]).toEqual(["Guards are detected, never evaluated."])
  })
})

describe("full: navigability contract holds here too", () => {
  it("keeps state-activated screens out of the screens block", () => {
    const document = fullDocument(graph)
    expect(asRecords(document["screens"]).map((row) => row["url"])).toEqual(["/orders"])
    expect(asRecords(document["stateScreens"]).map((row) => row["id"])).toEqual([
      "screen://state-screens/src%2FApp.tsx%230",
    ])
  })

  it("emits screens: [] rather than dropping the key on an empty graph", () => {
    expect(emitFullView(makeGraph())).toContain("screens: []")
  })

  it("reports dead nav links as a top-level block as well as inside navGroups", () => {
    const document = fullDocument(graph)
    expect(asRecords(document["deadNavLinks"])[0]).toMatchObject({
      label: "Results",
      target: "/results",
      file: "src/config.tsx",
      line: 42,
      resolves: false,
    })
    const entries = asRecords(asRecord(asRecords(document["navGroups"])[0])["entries"])
    expect(entries[0]?.["resolvedScreen"]).toBeNull()
  })
})

describe("full: facts and confidence", () => {
  it("splits endpoints by transport everywhere they appear", () => {
    const facts = asRecord(asRecord(asRecords(fullDocument(graph)["screens"])[0])["facts"])
    const endpoints = asRecord(facts["endpoints"])
    expect(asRecords(endpoints["http"])).toHaveLength(1)
    expect(asRecords(endpoints["rpc"])).toHaveLength(1)
    expect(emitFullView(graph)).toContain("transport: rpc are server functions")
  })

  it("preserves open fact channels under extra", () => {
    const facts = asRecord(asRecord(asRecords(fullDocument(graph)["screens"])[0])["facts"])
    expect(asRecord(facts["extra"])["messagesV2"]).toEqual(["PING"])
  })

  it("maps confidence levels onto the honest status vocabulary", () => {
    expect(asRecord(fullDocument(graph)["meta"])["confidence"]).toEqual([
      { section: "endpoints", status: "empty-expected", probed: "axios", dependencyInstalled: false, matched: 0 },
      { section: "stores", status: "empty-unexpected", probed: "zustand", dependencyInstalled: true, matched: 0 },
    ])
  })

  it("states the selector policy once, at the top", () => {
    expect(asRecord(fullDocument(graph)["selectors"])).toEqual({
      status: "no-attribute-detected",
      note: "This repository declares no test-id attributes; select elements by role or visible text.",
    })
  })
})

describe("full: route names", () => {
  const named = makeGraph({
    screens: [
      makeScreen({
        routeName: "orders",
        facts: makeFacts({ navigations: [{ to: "", trigger: "navigate", dynamic: false, routeName: "invoices" }] }),
        navigatesTo: [
          {
            to: "/invoices",
            matchedRoute: "/invoices",
            trigger: "navigate",
            dynamic: false,
            from: "src/modules/Orders/Orders.tsx",
            routeName: "invoices",
          },
        ],
      }),
    ],
    shells: {
      "src/routes/RootLayout.tsx": makeShell({
        navigatesTo: [
          { to: "name:gone", matchedRoute: null, trigger: "link", dynamic: false, from: "src/x.vue", routeName: "gone" },
        ],
      }),
    },
    components: {
      "src/x.vue": makeComponent({
        file: "src/x.vue",
        navigations: [{ to: "", trigger: "link", dynamic: false, routeName: "gone" }],
      }),
    },
  })

  it("prints routeName on screens, facts, navigations, shells and components when present", () => {
    const document = fullDocument(named)
    const screen = asRecords(document["screens"])[0] ?? {}
    expect(screen["routeName"]).toBe("orders")
    expect(asRecords(asRecord(screen["facts"])["navigations"])[0]?.["routeName"]).toBe("invoices")
    expect(asRecords(screen["navigatesTo"])[0]).toMatchObject({ to: "/invoices", routeName: "invoices" })
    const shell = asRecord(asRecord(document["shells"])["src/routes/RootLayout.tsx"])
    expect(asRecords(shell["navigatesTo"])[0]).toMatchObject({ to: "name:gone", routeName: "gone" })
    const component = asRecord(asRecord(document["components"])["src/x.vue"])
    expect(asRecords(component["navigations"])[0]?.["routeName"]).toBe("gone")
    expect(emitFullView(named)).toContain("routeName: orders")
  })

  it("leaves routeName out entirely when no screen or navigation carries one", () => {
    expect(emitFullView(graph)).not.toContain("routeName")
  })
})

describe("full: determinism", () => {
  it("sorts dictionary keys by codepoint and is byte-stable", () => {
    const first = emitFullView(graph)
    expect(emitFullView(graph)).toBe(first)
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(first.indexOf("src/components/Alpha.tsx")).toBeLessThan(first.indexOf("src/components/Zeta.tsx"))
  })

  it("quotes a query key sitting on the truncation boundary", () => {
    const key = "k".repeat(60)
    const truncated = makeGraph({ screens: [makeScreen({ facts: makeFacts({ queryKeys: [key] }) })] })
    expect(emitFullView(truncated)).toContain(`- "${key}"`)
  })

  it("re-parses as the same document through toYaml's self check", () => {
    expect(() => emitFullView(graph)).not.toThrow()
  })
})

describe("full: compact interned trees", () => {
  const leaf = (component: string) => makeTreeNode({ file: `src/${component}.tsx`, component })
  const shared = () => makeTreeNode({ file: "src/Card.tsx", component: "Card", children: [leaf("Title"), leaf("Body")] })
  const interned = makeGraph({
    screens: [
      makeScreen({ tree: [makeTreeNode({ file: "src/A.tsx", component: "A", children: [shared(), leaf("Icon")] })] }),
      makeScreen({
        id: "/b",
        url: "/b",
        activations: [{ kind: "url", template: "/b", params: [] }],
        tree: [makeTreeNode({ file: "src/B.tsx", component: "B", children: [shared(), leaf("Icon")] })],
      }),
    ],
    shells: { "src/routes/RootLayout.tsx": makeShell({ tree: [shared()] }) },
  })

  const treeOf = (document: Record<string, unknown>, url: string) =>
    asRecords(asRecords(document["screens"]).find((screen) => screen["url"] === url)?.["tree"])

  it("omits default-valued fields and keeps the non-default ones", () => {
    const root = treeOf(fullDocument(graph), "/orders")[0]
    expect(root).toEqual({
      component: "Thing",
      file: "src/components/Thing.tsx",
      kind: "ui",
      conditions: ["isOpen"],
      alwaysRendered: false,
      nullGuards: ["!data"],
    })
    const flagged = makeGraph({
      screens: [makeScreen({ tree: [makeTreeNode({ repeated: true, truncated: true, repeat: true })] })],
    })
    expect(treeOf(fullDocument(flagged), "/orders")[0]).toEqual({
      component: "Thing",
      file: "src/components/Thing.tsx",
      kind: "ui",
      repeated: true,
      truncated: true,
      repeat: true,
    })
  })

  it("emits a repeated subtree once under subtrees and references it by key", () => {
    const document = fullDocument(interned)
    expect(document["subtrees"]).toEqual({
      t0: {
        component: "Card",
        file: "src/Card.tsx",
        kind: "ui",
        children: [
          { component: "Title", file: "src/Title.tsx", kind: "ui" },
          { component: "Body", file: "src/Body.tsx", kind: "ui" },
        ],
      },
    })
    const children = [{ ref: "t0" }, { component: "Icon", file: "src/Icon.tsx", kind: "ui" }]
    expect(asRecords(treeOf(document, "/orders")[0]?.["children"])).toEqual(children)
    expect(asRecords(treeOf(document, "/b")[0]?.["children"])).toEqual(children)
    expect(asRecord(asRecord(document["shells"])["src/routes/RootLayout.tsx"])["tree"]).toEqual([{ ref: "t0" }])
  })

  it("keeps small or unique subtrees inline and emits an empty subtrees block", () => {
    const document = fullDocument(graph)
    expect(document["subtrees"]).toEqual({})
    expect(emitFullView(makeGraph())).toContain("subtrees: {}")
  })

  const expand =
    (subtrees: Record<string, unknown>) =>
    (value: Record<string, unknown>): Record<string, unknown> => {
      if (typeof value["ref"] === "string") return expand(subtrees)(asRecord(subtrees[value["ref"]]))
      if (!("children" in value)) return value
      return { ...value, children: asRecords(value["children"]).map(expand(subtrees)) }
    }

  const plain = (node: TreeNode): Record<string, unknown> => ({
    component: node.component,
    file: node.file,
    kind: node.kind,
    ...(node.children.length === 0 ? {} : { children: node.children.map(plain) }),
  })

  it("expands every reference back to the analysed tree", () => {
    const document = fullDocument(interned)
    const resolve = expand(asRecord(document["subtrees"]))
    expect(treeOf(document, "/orders").map(resolve)).toEqual(interned.screens[0]?.tree.map(plain))
    expect(treeOf(document, "/b").map(resolve)).toEqual(interned.screens[1]?.tree.map(plain))
  })

  it("renders refs in YAML once per occurrence and stays byte-stable", () => {
    const yaml = emitFullView(interned)
    expect(yaml).toMatch(/\n\s+- ref: t0\n/)
    expect(yaml.match(/component: Card/g)).toHaveLength(1)
    expect(yaml.indexOf("subtrees:")).toBeGreaterThan(yaml.indexOf("shells:"))
    expect(yaml.indexOf("subtrees:")).toBeLessThan(yaml.indexOf("components:"))
    expect(emitFullView(interned)).toBe(yaml)
  })
})
