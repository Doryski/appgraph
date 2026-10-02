import { describe, expect, it } from "vitest"
import type { AppGraph, Screen, ScreenFacts, ShellReport, TreeNode } from "../../src/core/model.js"
import { detailDocument, emitDetailView, UnknownScreenError } from "../../src/emit/view-detail.js"

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

const detailScreen = makeScreen({
  id: "/invoices/:id",
  url: "/invoices/:id",
  params: ["id"],
  title: "Invoice Details",
  featureFlag: "invoices",
  shell: "src/routes/LayoutWrappers.tsx",
  ancestors: [
    {
      file: "src/routes/RootLayout.tsx",
      exportName: "RootLayout",
      splice: { kind: "outlet", tag: "Outlet" },
      role: "layout",
    },
    {
      file: "src/routes/ProtectedRoute.tsx",
      exportName: "ProtectedRoute",
      splice: { kind: "children" },
      role: "guard",
    },
  ],
  entries: [
    { kind: "file", file: "src/modules/InvoiceDetailPage/InvoiceDetailPage.tsx", exportName: "default" },
    { kind: "opaque", expr: "lazy(() => import(modulePath))", file: "src/routes/router.tsx", line: 88 },
  ],
  reachable: ["src/services/invoices.ts", "src/stores/invoice.ts"],
  navigatesTo: [
    {
      to: "/invoices",
      matchedRoute: "/invoices",
      trigger: "navigate",
      dynamic: false,
      from: "src/modules/InvoiceDetailPage/InvoiceDetailPage.tsx",
    },
    {
      to: "/nowhere",
      matchedRoute: null,
      trigger: "link",
      dynamic: true,
      from: "src/modules/InvoiceDetailPage/Footer.tsx",
    },
  ],
  facts: makeFacts({
    endpoints: [
      { method: "GET", url: "/api/invoices/:param", transport: "http", client: "axios" },
      { method: "POST", url: "createInvoice", transport: "rpc", client: null },
    ],
    stores: ["invoiceStore"],
    queryKeys: ["invoice", "invoices"],
    mutations: 3,
    i18nNamespaces: ["invoices", "common"],
    formSchemas: ["invoiceSchema"],
    formFields: ["general.number", "category"],
    featureGates: ["invoices"],
    hooks: ["useInvoice"],
    testIds: ["file-name", "next-button"],
  }),
  tree: [
    makeTreeNode({
      component: "InvoiceDetailPage",
      file: "src/modules/InvoiceDetailPage/InvoiceDetailPage.tsx",
      kind: "module",
      nullGuards: ["!invoice"],
      children: [
        makeTreeNode({
          component: "InvoiceLineItems",
          file: "src/components/InvoiceLineItems.tsx",
          conditions: ["isEditing && invoice"],
          alwaysRendered: false,
          children: [
            makeTreeNode({
              component: "Iconify",
              file: "src/components/Iconify.tsx",
              conditions: ["!isDisabled"],
              alwaysRendered: true,
              repeated: true,
              truncated: true,
            }),
          ],
        }),
      ],
    }),
  ],
})

const graph = makeGraph({
  screens: [detailScreen],
  shells: {
    "src/routes/LayoutWrappers.tsx": makeShell({
      file: "src/routes/LayoutWrappers.tsx",
      layouts: ["BasicLayoutWrapper"],
      testIds: ["integration"],
      navigatesTo: [
        { to: "/", matchedRoute: "/", trigger: "navigate", dynamic: false, from: "src/modules/Logo/Logo.tsx" },
      ],
    }),
  },
  components: {
    "src/modules/InvoiceDetailPage/InvoiceDetailPage.tsx": {
      file: "src/modules/InvoiceDetailPage/InvoiceDetailPage.tsx",
      component: "InvoiceDetailPage",
      kind: "module",
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
    },
  },
  diagnostics: [
    {
      severity: "info",
      code: "facts/masked",
      message: "preview subtree masked",
      plugin: "facts",
      file: "src/modules/InvoiceDetailPage/InvoiceDetailPage.tsx",
      line: 10,
      screenId: "/invoices/:id",
    },
    { severity: "warning", code: "nav/dead-link", message: "elsewhere", plugin: "nav", screenId: "/other" },
  ],
})

describe("detail: addressing one screen", () => {
  it("throws a named error for an unknown screen id", () => {
    expect(() => emitDetailView(graph, "/missing")).toThrow(UnknownScreenError)
    expect(() => emitDetailView(graph, "/missing")).toThrow("emit/unknown-screen")
  })

  it("emits the documented top-level key layout", () => {
    expect(Object.keys(detailDocument(graph, "/invoices/:id"))).toEqual([
      "meta",
      "id",
      "localId",
      "source",
      "url",
      "addressable",
      "title",
      "activation",
      "auth",
      "flag",
      "params",
      "entries",
      "ancestors",
      "shell",
      "selectors",
      "facts",
      "conditionalRendering",
      "tree",
      "reachable",
      "goesTo",
      "navigatesTo",
      "provenance",
      "diagnostics",
    ])
  })

  it("drops the per-file components dictionary — that is full's job", () => {
    expect(Object.keys(detailDocument(graph, "/invoices/:id"))).not.toContain("components")
  })
})

describe("detail: render tree and conditional rendering", () => {
  const document = detailDocument(graph, "/invoices/:id")

  it("keeps conditions, alwaysRendered, repeated and nullGuards on every node", () => {
    const root = asRecord(asRecords(document["tree"])[0])
    expect(root["alwaysRendered"]).toBe(true)
    expect(root["repeated"]).toBe(false)
    expect(root["nullGuards"]).toEqual(["!invoice"])
    const child = asRecord(asRecords(root["children"])[0])
    expect(child["conditions"]).toEqual(["isEditing && invoice"])
    expect(child["alwaysRendered"]).toBe(false)
    const grandchild = asRecord(asRecords(child["children"])[0])
    expect(grandchild["repeated"]).toBe(true)
    expect(grandchild["truncated"]).toBe(true)
  })

  it("flattens conditional nodes so a consumer need not walk the tree", () => {
    expect(document["conditionalRendering"]).toEqual([
      {
        component: "InvoiceLineItems",
        file: "src/components/InvoiceLineItems.tsx",
        onlyWhen: ["isEditing && invoice"],
      },
      {
        component: "Iconify",
        file: "src/components/Iconify.tsx",
        onlyWhen: ["!isDisabled"],
        alsoRenderedUnconditionally: true,
        repeated: true,
      },
    ])
  })

  it("quotes a guard sitting on the truncation boundary", () => {
    const condition = "invoice && ".repeat(11).slice(0, 110)
    const truncatedGraph = makeGraph({
      screens: [
        makeScreen({
          tree: [makeTreeNode({ conditions: [condition], alwaysRendered: false })],
        }),
      ],
    })
    expect(emitDetailView(truncatedGraph, "/orders")).toContain(`- "${condition}"`)
  })
})

describe("detail: activation, auth and flags stay honest", () => {
  it("hedges the auth note when no redirect target was configured", () => {
    const auth = asRecord(detailDocument(graph, "/invoices/:id")["auth"])
    expect(auth["state"]).toBe("protected")
    expect(auth["gatedBy"]).toEqual(["src/routes/ProtectedRoute.tsx"])
    expect(String(auth["note"])).toContain("was not configured and is not statically known")
  })

  it("states the configured redirect targets as fact when config supplies them", () => {
    const document = detailDocument(graph, "/invoices/:id", {
      redirects: { unauthenticated: "/login", flagOff: "/" },
    })
    expect(String(asRecord(document["auth"])["note"])).toContain("the configured redirect")
    expect(String(asRecord(document["flag"])["note"])).toContain("is / ")
  })

  it("omits the flag block when the screen is not gated", () => {
    const plain = makeGraph({ screens: [makeScreen()] })
    expect(Object.keys(detailDocument(plain, "/orders"))).not.toContain("flag")
  })

  it("describes every activation, including sub-file state screens", () => {
    const stateGraph = makeGraph({
      screens: [
        makeScreen({
          id: "screen://state-screens/src%2FApp.tsx%230",
          url: null,
          addressable: false,
          activations: [{ kind: "state", holder: "App", expr: "isAuthenticated" }],
        }),
      ],
    })
    const activation = asRecords(detailDocument(stateGraph, "screen://state-screens/src%2FApp.tsx%230")["activation"])
    expect(activation[0]).toEqual({ kind: "state", holder: "App", when: "isAuthenticated" })
  })
})

describe("detail: facts", () => {
  const document = detailDocument(graph, "/invoices/:id")
  const facts = asRecord(document["facts"])

  it("separates rpc endpoints from http ones", () => {
    expect(asRecord(facts["endpoints"])["http"]).toEqual([
      { method: "GET", url: "/api/invoices/:param", transport: "http", client: "axios" },
    ])
    expect(asRecord(facts["endpoints"])["rpc"]).toEqual([
      { method: "POST", url: "createInvoice", transport: "rpc" },
    ])
    expect(emitDetailView(graph, "/invoices/:id")).toContain("transport: rpc are server functions")
  })

  it("carries stores, query keys, i18n namespaces and form facts", () => {
    expect(facts["stores"]).toEqual(["invoiceStore"])
    expect(facts["queryKeys"]).toEqual(["invoice", "invoices"])
    expect(facts["i18nNamespaces"]).toEqual(["common", "invoices"])
    expect(facts["formSchemas"]).toEqual(["invoiceSchema"])
    expect(facts["formFields"]).toEqual(["category", "general.number"])
    expect(facts["mutations"]).toBe(3)
  })

  it("keeps test ids under selectors together with the policy note", () => {
    const selectors = asRecord(detailDocument(graph, "/invoices/:id", { testIdAttribute: "data-testid" })["selectors"])
    expect(selectors["status"]).toBe("present")
    expect(selectors["testIds"]).toEqual(["file-name", "next-button"])
  })

  it("never shows an unexplained empty test-id list when the repo has none", () => {
    const bare = makeGraph({ screens: [makeScreen()] })
    const yaml = emitDetailView(bare, "/orders")
    expect(yaml).not.toContain("testIds:")
    expect(yaml).toContain("This repository declares no test-id attributes")
  })
})

describe("detail: entries, ancestors, shell and navigation", () => {
  const document = detailDocument(graph, "/invoices/:id")

  it("keeps an unresolvable entry visible instead of dropping it", () => {
    expect(asRecords(document["entries"])[1]).toEqual({
      kind: "opaque",
      file: "src/routes/router.tsx",
      line: 88,
      expr: "lazy(() => import(modulePath))",
    })
  })

  it("records the ancestor chain with its splice mode", () => {
    expect(asRecords(document["ancestors"])[0]).toEqual({
      file: "src/routes/RootLayout.tsx",
      exportName: "RootLayout",
      role: "layout",
      splice: { kind: "outlet", tag: "Outlet" },
    })
  })

  it("inlines the resolved shell report", () => {
    const shell = asRecord(document["shell"])
    expect(shell["file"]).toBe("src/routes/LayoutWrappers.tsx")
    expect(shell["layouts"]).toEqual(["BasicLayoutWrapper"])
    expect(shell["testIds"]).toEqual(["integration"])
  })

  it("marks outgoing navigation that resolves to no screen", () => {
    const edges = asRecords(document["navigatesTo"])
    expect(document["goesTo"]).toEqual(["/invoices"])
    expect(edges.find((edge) => edge["to"] === "/nowhere")).toMatchObject({ resolves: false, dynamic: true })
    expect(edges.find((edge) => edge["to"] === "/invoices")?.["resolves"]).toBeUndefined()
  })

  it("keeps only the diagnostics scoped to this screen", () => {
    expect(asRecords(document["diagnostics"]).map((entry) => entry["code"])).toEqual(["facts/masked"])
  })
})

describe("detail: placement ambiguity", () => {
  it("names the ancestors whose placement is uncertain, and says nothing when it is not", () => {
    const marked = makeGraph({ screens: [makeScreen({ placementAmbiguous: ["src/layout/LayoutPicker.tsx"] })] })
    const plain = makeGraph({ screens: [makeScreen()] })

    expect(detailDocument(marked, "/orders")["placementAmbiguous"]).toEqual(["src/layout/LayoutPicker.tsx"])
    expect(emitDetailView(marked, "/orders")).toContain("placementAmbiguous:\n  - src/layout/LayoutPicker.tsx")
    expect(detailDocument(plain, "/orders")).not.toHaveProperty("placementAmbiguous")
  })
})

describe("detail: route names", () => {
  it("prints routeName on the screen and its navigations only when present", () => {
    const named = makeGraph({
      screens: [
        makeScreen({
          routeName: "orders",
          navigatesTo: [
            {
              to: "name:gone",
              matchedRoute: null,
              trigger: "navigate",
              dynamic: false,
              from: "src/modules/Orders/Orders.tsx",
              routeName: "gone",
            },
          ],
        }),
      ],
    })
    const document = detailDocument(named, "/orders")

    expect(document["routeName"]).toBe("orders")
    expect(asRecords(document["navigatesTo"])[0]).toMatchObject({ to: "name:gone", resolves: false, routeName: "gone" })
    expect(emitDetailView(graph, "/invoices/:id")).not.toContain("routeName")
  })
})

describe("detail: slot branches", () => {
  const branched = makeGraph({
    screens: [
      makeScreen({
        ancestors: [
          {
            file: "src/app/layout.tsx",
            exportName: "default",
            role: "layout",
            splice: { kind: "children" },
            branches: [
              {
                file: "src/app/@modal/page.tsx",
                exportName: "default",
                splice: { kind: "slot", name: "modal" },
                conditions: ["slot modal"],
              },
            ],
          },
        ],
      }),
    ],
  })

  it("emits an ancestor's slot branches with their slot splice and conditions", () => {
    const screen = branched.screens[0]
    const document = detailDocument(branched, screen?.id ?? "")
    expect(asRecords(document["ancestors"])[0]).toEqual({
      file: "src/app/layout.tsx",
      exportName: "default",
      role: "layout",
      splice: { kind: "children" },
      branches: [
        {
          file: "src/app/@modal/page.tsx",
          exportName: "default",
          splice: { kind: "slot", name: "modal" },
          conditions: ["slot modal"],
        },
      ],
    })
  })
})

describe("detail: determinism", () => {
  it("is byte-identical across runs and carries no timestamp", () => {
    const first = emitDetailView(graph, "/invoices/:id")
    expect(emitDetailView(graph, "/invoices/:id")).toBe(first)
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it("repeats the limitations verbatim from meta", () => {
    const limited = makeGraph({
      screens: [makeScreen()],
      meta: { ...graph.meta, limitations: ["Conditional rendering is DETECTED but not evaluated."] },
    })
    expect(asRecord(detailDocument(limited, "/orders")["meta"])["limitations"]).toEqual([
      "Conditional rendering is DETECTED but not evaluated.",
    ])
  })
})
