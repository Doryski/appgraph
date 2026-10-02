import { describe, expect, it } from "vitest"
import ts from "typescript"
import { createAst, walk } from "../../src/core/ast.js"
import { createDiagnosticCollector } from "../../src/core/diagnostics.js"
import { createMemoryHost } from "../../src/core/host.js"
import { buildGraph, emptyFileFacts, resolveScreenConflicts, strongerVia } from "../../src/core/graph.js"
import type { BuildGraphInput, GraphProviders, ScreenContribution, SpliceRef } from "../../src/core/graph.js"
import type {
  AncestorRef,
  AppGraph,
  FileFacts,
  NodeLocator,
  RedirectRule,
  RenderEdge,
  ScreenDraft,
  SlotBranch,
  TreeNode,
} from "../../src/core/model.js"

const ast = createAst(ts)

const ROOT = "/repo"

const META = {
  appgraphVersion: "0.1.0",
  root: "repo",
  sourceRoots: ["src"],
  screenSources: ["test-source"],
  fingerprint: "fingerprint",
} as const

type FactsOverrides = Partial<Omit<FileFacts, "file" | "component">>

const componentOf = (file: string): string => {
  const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.[cm]?[jt]sx?$/, "")
  return base === "index" ? "index" : base
}

const facts = (file: string, overrides: FactsOverrides = {}): FileFacts => ({
  ...emptyFileFacts(file, componentOf(file)),
  ...overrides,
})

const edge = (file: string, overrides: Partial<Omit<RenderEdge, "file">> = {}): RenderEdge => ({
  file,
  conditions: [],
  alwaysRendered: true,
  repeated: false,
  ...overrides,
})

const factsTable = (entries: Readonly<Record<string, FactsOverrides>>) => {
  const table = new Map(Object.entries(entries).map(([file, overrides]) => [file, facts(file, overrides)]))
  return (file: string): FileFacts => table.get(file) ?? facts(file)
}

const draft = (input: Partial<ScreenDraft> & Pick<ScreenDraft, "localId">): ScreenDraft => ({
  activations: [],
  entries: [],
  evidence: [],
  ...input,
})

const urlDraft = (url: string, input: Partial<ScreenDraft> = {}): ScreenDraft =>
  draft({
    localId: input.localId ?? `${url}.tsx`,
    activations: [{ kind: "url", template: url, params: [] }],
    ...input,
  })

const contribution = (source: string, value: ScreenDraft): ScreenContribution => ({ source, draft: value })

const parse = (file: string, code: string): ts.SourceFile =>
  ts.createSourceFile(`${ROOT}/${file}`, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)

const sourcesFrom = (files: Readonly<Record<string, string>>) => {
  const parsed = new Map(Object.entries(files).map(([file, code]) => [file, parse(file, code)]))
  return (file: string): ts.SourceFile | null => parsed.get(file) ?? null
}

const build = (input: Partial<BuildGraphInput> & { readonly providers: GraphProviders }): AppGraph =>
  buildGraph({
    contributions: [],
    meta: META,
    ...input,
  })

const screenById = (graph: AppGraph, id: string) => {
  const found = graph.screens.find((screen) => screen.id === id)
  if (found === undefined)
    throw new Error(`no screen '${id}' in [${graph.screens.map((s) => s.id).join(", ")}]`)
  return found
}

const flatten = (nodes: readonly TreeNode[]): readonly TreeNode[] =>
  nodes.flatMap((node) => [node, ...flatten(node.children)])

const shapeOf = (nodes: readonly TreeNode[]): string =>
  nodes.map((node) => `${node.component}(${shapeOf(node.children)})`).join(",")

describe("render tree", () => {
  const provider = factsTable({
    "src/pages/Home.tsx": {
      renders: [edge("src/ui/Header.tsx"), edge("src/ui/List.tsx", { repeated: true })],
    },
    "src/ui/Header.tsx": { renders: [edge("src/ui/Logo.tsx")] },
    "src/ui/List.tsx": { renders: [edge("src/ui/Row.tsx")] },
    "src/ui/Row.tsx": { renders: [edge("src/ui/Logo.tsx")] },
    "src/ui/Logo.tsx": {},
  })

  const graphOf = (maxDepth: number): AppGraph =>
    build({
      providers: { ast, facts: provider },
      maxDepth,
      contributions: [
        contribution(
          "test-source",
          urlDraft("/home", {
            entries: [
              {
                kind: "file",
                file: "src/pages/Home.tsx",
                exportName: "default",
              },
            ],
          }),
        ),
      ],
    })

  it("expands to maxDepth and marks deeper nodes truncated", () => {
    const screen = screenById(graphOf(1), "/home")

    expect(shapeOf(screen.tree)).toBe("Home(Header(),List())")
    const header = screen.tree[0]?.children[0]
    expect(header?.truncated).toBe(true)
    expect(header?.children).toEqual([])
  })

  it("keeps truncated children in reachable", () => {
    const screen = screenById(graphOf(1), "/home")
    expect(screen.reachable).toContain("src/ui/Logo.tsx")
    expect(screen.reachable).toContain("src/ui/Row.tsx")
  })

  it("marks a file already expanded in this screen as repeat, not truncated", () => {
    const screen = screenById(graphOf(5), "/home")
    const logos = flatten(screen.tree).filter((node) => node.file === "src/ui/Logo.tsx")

    expect(logos).toHaveLength(2)
    expect(logos.map((node) => node.repeat)).toEqual([false, true])
    expect(logos[1]?.children).toEqual([])
    expect(logos[1]?.truncated).toBe(false)
  })

  it("carries the render edge's conditions, alwaysRendered and repeated onto the node", () => {
    const screen = screenById(graphOf(3), "/home")
    const list = screen.tree[0]?.children[1]
    expect(list?.repeated).toBe(true)
  })

  it("carries the edge's via provenance onto the node and leaves plain tags unmarked", () => {
    const graph = build({
      providers: {
        ast,
        facts: factsTable({
          "src/pages/Home.tsx": {
            renders: [edge("src/ui/Lazy.tsx", { via: "lazy" }), edge("src/ui/Panel.tsx", { via: "reference" })],
          },
        }),
      },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/home", { entries: [{ kind: "file", file: "src/pages/Home.tsx", exportName: "default" }] }),
        ),
      ],
    })
    const nodes = flatten(screenById(graph, "/home").tree)

    expect(nodes.map((node) => [node.file, node.via])).toEqual([
      ["src/pages/Home.tsx", undefined],
      ["src/ui/Lazy.tsx", "lazy"],
      ["src/ui/Panel.tsx", "reference"],
    ])
    expect(Object.hasOwn(nodes[0] ?? {}, "via")).toBe(false)
  })

  it("follows uses edges USES_DEPTH_BONUS levels past maxDepth", () => {
    const chained = factsTable({
      "src/pages/Deep.tsx": { uses: ["src/services/a.ts"] },
      "src/services/a.ts": { uses: ["src/services/b.ts"] },
      "src/services/b.ts": { uses: ["src/services/c.ts"] },
      "src/services/c.ts": { uses: ["src/services/d.ts"] },
      "src/services/d.ts": {},
    })

    const screen = screenById(
      build({
        providers: { ast, facts: chained },
        maxDepth: 0,
        contributions: [
          contribution(
            "test-source",
            urlDraft("/deep", {
              entries: [
                {
                  kind: "file",
                  file: "src/pages/Deep.tsx",
                  exportName: "default",
                },
              ],
            }),
          ),
        ],
      }),
      "/deep",
    )

    // maxDepth 0 + USES_DEPTH_BONUS 3: the entry sits at depth 0, so `d` (depth 4) is past the bound.
    expect(screen.reachable).toEqual([
      "src/pages/Deep.tsx",
      "src/services/a.ts",
      "src/services/b.ts",
      "src/services/c.ts",
    ])
  })

  describe("diamond reached down its long branch first", () => {
    const LEAF_ENDPOINT = { method: "GET", url: "/api/leaf", transport: "http", client: null } as const

    const diamond = (branches: readonly string[]) =>
      factsTable({
        "src/pages/Entry.tsx": { renders: branches.map((file) => edge(file)) },
        "src/ui/Long1.tsx": { renders: [edge("src/ui/Long2.tsx")] },
        "src/ui/Long2.tsx": { renders: [edge("src/ui/Shared.tsx")] },
        "src/ui/Short.tsx": { renders: [edge("src/ui/Shared.tsx")] },
        "src/ui/Shared.tsx": { uses: ["src/services/api.ts"], renders: [edge("src/ui/Leaf.tsx")] },
        "src/services/api.ts": { endpoints: [LEAF_ENDPOINT] },
        "src/ui/Leaf.tsx": {},
      })

    const screenOf = (branches: readonly string[]) =>
      screenById(
        build({
          providers: { ast, facts: diamond(branches) },
          maxDepth: 0,
          contributions: [
            contribution(
              "test-source",
              urlDraft("/diamond", {
                entries: [{ kind: "file", file: "src/pages/Entry.tsx", exportName: "default" }],
              }),
            ),
          ],
        }),
        "/diamond",
      )

    const longFirst = ["src/ui/Long1.tsx", "src/ui/Short.tsx"]

    it("re-expands a file when a shorter path reaches it after a longer one", () => {
      const screen = screenOf(longFirst)

      expect(screen.reachable).toEqual([
        "src/pages/Entry.tsx",
        "src/services/api.ts",
        "src/ui/Leaf.tsx",
        "src/ui/Long1.tsx",
        "src/ui/Long2.tsx",
        "src/ui/Shared.tsx",
        "src/ui/Short.tsx",
      ])
      expect(screen.facts.endpoints).toEqual([LEAF_ENDPOINT])
    })

    it("does not depend on which branch is visited first", () => {
      const longFirstScreen = screenOf(longFirst)
      const shortFirstScreen = screenOf([...longFirst].reverse())

      expect(shortFirstScreen.reachable).toEqual(longFirstScreen.reachable)
      expect(shortFirstScreen.facts).toEqual(longFirstScreen.facts)
    })
  })
})

describe("aggregation", () => {
  it("unions facts over the whole reachable set, deduped and codepoint-sorted", () => {
    const provider = factsTable({
      "src/pages/A.tsx": {
        renders: [edge("src/ui/B.tsx")],
        uses: ["src/services/api.ts"],
        testIds: ["zeta", "alpha"],
        stores: ["userStore"],
        mutations: 1,
      },
      "src/ui/B.tsx": {
        testIds: ["alpha", "Beta"],
        featureGates: ["flagB"],
        mutations: 2,
      },
      "src/services/api.ts": {
        endpoints: [
          { method: "GET", url: "/api/z", transport: "http", client: "axios" },
          { method: "POST", url: "/api/a", transport: "http", client: "axios" },
          { method: "GET", url: "/api/z", transport: "http", client: "axios" },
        ],
        queryKeys: ["users"],
      },
    })

    const screen = screenById(
      build({
        providers: { ast, facts: provider },
        contributions: [
          contribution(
            "test-source",
            urlDraft("/a", {
              entries: [
                {
                  kind: "file",
                  file: "src/pages/A.tsx",
                  exportName: "default",
                },
              ],
            }),
          ),
        ],
      }),
      "/a",
    )

    expect(screen.facts.testIds).toEqual(["Beta", "alpha", "zeta"])
    expect(screen.facts.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.url}`)).toEqual([
      "POST /api/a",
      "GET /api/z",
    ])
    expect(screen.facts.stores).toEqual(["userStore"])
    expect(screen.facts.queryKeys).toEqual(["users"])
    expect(screen.facts.featureGates).toEqual(["flagB"])
    expect(screen.facts.mutations).toBe(3)
  })

  it("carries the messages channel and open `extra` channels from FileFacts into ScreenFacts", () => {
    const provider = factsTable({
      "src/background.ts": {
        renders: [edge("src/popup/Popup.tsx")],
        messages: ["OPEN_POPUP", "AUTH_DONE"],
        extra: { manifestPermissions: ["storage", "tabs"] },
      },
      "src/popup/Popup.tsx": {
        messages: ["AUTH_DONE", "CLOSE_POPUP"],
        extra: {
          manifestPermissions: ["storage"],
          serverFns: [{ name: "getUser" }],
        },
      },
    })

    const screen = screenById(
      build({
        providers: { ast, facts: provider },
        contributions: [
          contribution(
            "test-source",
            urlDraft("/bg", {
              entries: [
                {
                  kind: "file",
                  file: "src/background.ts",
                  exportName: "default",
                },
              ],
            }),
          ),
        ],
      }),
      "/bg",
    )

    expect(screen.facts.messages).toEqual(["AUTH_DONE", "CLOSE_POPUP", "OPEN_POPUP"])
    expect(Object.keys(screen.facts.extra)).toEqual(["manifestPermissions", "serverFns"])
    expect(screen.facts.extra["manifestPermissions"]).toEqual(["storage", "tabs"])
    expect(screen.facts.extra["serverFns"]).toEqual([{ name: "getUser" }])
  })

  // `FileFacts.messages` / `extra` are required, so "a FileFacts without them" is not constructible;
  // what stays testable is that empty channels union to empty.
  it("unions empty messages/extra channels into empty ScreenFacts channels", () => {
    const withoutChannels: FileFacts = {
      file: "src/pages/A.tsx",
      component: "A",
      kind: "screen",
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
    }

    const screen = screenById(
      build({
        providers: { ast, facts: () => withoutChannels },
        contributions: [
          contribution(
            "test-source",
            urlDraft("/a", {
              entries: [
                {
                  kind: "file",
                  file: "src/pages/A.tsx",
                  exportName: "default",
                },
              ],
            }),
          ),
        ],
      }),
      "/a",
    )

    expect(screen.facts.messages).toEqual([])
    expect(screen.facts.extra).toEqual({})
  })

  it("resolves navigations against the screen set and drops self edges", () => {
    const provider = factsTable({
      "src/pages/A.tsx": {
        navigations: [
          { to: "/b/42", trigger: "navigate", dynamic: false },
          { to: "/a", trigger: "link", dynamic: false },
          { to: "/nowhere", trigger: "link", dynamic: false },
        ],
      },
      "src/pages/B.tsx": {},
    })

    const graph = build({
      providers: { ast, facts: provider },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/a", {
            entries: [{ kind: "file", file: "src/pages/A.tsx", exportName: "default" }],
          }),
        ),
        contribution(
          "test-source",
          urlDraft("/b/:id", {
            entries: [{ kind: "file", file: "src/pages/B.tsx", exportName: "default" }],
          }),
        ),
      ],
    })

    const screen = screenById(graph, "/a")
    expect(screen.navigatesTo.map((nav) => [nav.to, nav.matchedRoute])).toEqual([
      ["/b/42", "/b/:id"],
      ["/nowhere", null],
    ])
    expect(graph.navigation).toEqual([
      {
        from: "/a",
        to: "/b/:id",
        trigger: "navigate",
        dynamic: false,
        via: "src/pages/A.tsx",
      },
    ])
  })

  /**
   * A shell component (`Logo.tsx`) navigates to `/` from every screen, and on some screens the page's
   * OWN `navigate(Paths.HOME)` shares that `(from, to, trigger)`. Keying without `via` would keep
   * whichever file sorted first — the shell — and drop the page's edge, which reads as "the extractor
   * never saw the nested call".
   */
  it("keeps one edge per via when a shell and the page navigate to the same target", () => {
    const provider = factsTable({
      "src/modules/Logo/Logo.tsx": {
        navigations: [{ to: "/", trigger: "navigate", dynamic: false }],
      },
      "src/pages/Register.tsx": {
        navigations: [{ to: "/", trigger: "navigate", dynamic: false }],
        renders: [edge("src/modules/Logo/Logo.tsx")],
      },
      "src/pages/Home.tsx": {},
    })

    const graph = build({
      providers: { ast, facts: provider },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/register", {
            entries: [
              {
                kind: "file",
                file: "src/pages/Register.tsx",
                exportName: "default",
              },
            ],
          }),
        ),
        contribution(
          "test-source",
          urlDraft("/", {
            entries: [
              {
                kind: "file",
                file: "src/pages/Home.tsx",
                exportName: "default",
              },
            ],
          }),
        ),
      ],
    })

    expect(graph.navigation.map((navEdge) => navEdge.via)).toEqual([
      "src/modules/Logo/Logo.tsx",
      "src/pages/Register.tsx",
    ])
  })
})

describe("ancestor chains", () => {
  const CHAIN_FILES = {
    "src/app/layout.tsx": `export default function RootLayout({ children }: { children: React.ReactNode }) {
      return <Shell><Nav />{children}</Shell>
    }`,
    "src/app/(admin)/layout.tsx": `export default function AdminLayout(props: { children: React.ReactNode }) {
      return <Sidebar>{props.children}</Sidebar>
    }`,
    "src/app/(admin)/users/page.tsx": `export default function UsersPage() { return <UsersTable /> }`,
  }

  const provider = factsTable({
    "src/app/layout.tsx": { renders: [edge("src/ui/Nav.tsx")] },
    "src/app/(admin)/layout.tsx": { renders: [edge("src/ui/Sidebar.tsx")] },
    "src/app/(admin)/users/page.tsx": {
      renders: [edge("src/ui/UsersTable.tsx")],
    },
  })

  const providers: GraphProviders = {
    ast,
    facts: provider,
    sourceOf: sourcesFrom(CHAIN_FILES),
  }

  const nextScreen = (ancestors: ScreenDraft["ancestors"]) =>
    build({
      providers,
      contributions: [
        contribution(
          "test-source",
          urlDraft("/users", {
            localId: "src/app/(admin)/users/page.tsx",
            entries: [
              {
                kind: "file",
                file: "src/app/(admin)/users/page.tsx",
                exportName: "default",
              },
            ],
            ...(ancestors === undefined ? {} : { ancestors }),
          }),
        ),
      ],
    })

  it("splices {children} so the tree is root layout -> nearest layout -> page", () => {
    const graph = nextScreen([
      {
        file: "src/app/layout.tsx",
        exportName: "default",
        splice: { kind: "children" },
        role: "layout",
      },
      {
        file: "src/app/(admin)/layout.tsx",
        exportName: "default",
        splice: { kind: "children" },
        role: "layout",
      },
    ])

    expect(shapeOf(screenById(graph, "/users").tree)).toBe(
      "layout(Nav(),layout(Sidebar(),page(UsersTable())))",
    )
  })

  it("derives shell from the innermost layout ancestor, not from a JSX tag match", () => {
    const graph = nextScreen([
      {
        file: "src/app/layout.tsx",
        exportName: "default",
        splice: { kind: "children" },
        role: "layout",
      },
      {
        file: "src/app/(admin)/layout.tsx",
        exportName: "default",
        splice: { kind: "children" },
        role: "layout",
      },
    ])

    expect(screenById(graph, "/users").shell).toBe("src/app/(admin)/layout.tsx")
    expect(Object.keys(graph.shells)).toEqual(["src/app/(admin)/layout.tsx"])
    expect(graph.shells["src/app/(admin)/layout.tsx"]?.layouts).toEqual(["default"])
  })

  it("skips a guard between the screen and its layout when picking the shell", () => {
    const graph = nextScreen([
      { file: "src/app/layout.tsx", exportName: "default", splice: { kind: "children" }, role: "layout" },
      { file: "src/app/(admin)/layout.tsx", exportName: "default", splice: { kind: "children" }, role: "guard" },
    ])

    expect(screenById(graph, "/users").shell).toBe("src/app/layout.tsx")
    expect(Object.keys(graph.shells)).toEqual(["src/app/layout.tsx"])
  })

  it("falls back to the nearest ancestor when no ancestor is a layout", () => {
    const graph = nextScreen([
      { file: "src/app/layout.tsx", exportName: "default", splice: { kind: "children" }, role: "guard" },
      {
        file: "src/app/(admin)/layout.tsx",
        exportName: "default",
        splice: { kind: "children" },
        role: "errorBoundary",
      },
    ])

    expect(screenById(graph, "/users").shell).toBe("src/app/(admin)/layout.tsx")
  })

  it("does not charge ancestor levels to the screen's maxDepth budget", () => {
    const graph = buildGraph({
      meta: META,
      maxDepth: 1,
      providers,
      contributions: [
        contribution(
          "test-source",
          urlDraft("/users", {
            entries: [
              {
                kind: "file",
                file: "src/app/(admin)/users/page.tsx",
                exportName: "default",
              },
            ],
            ancestors: [
              {
                file: "src/app/layout.tsx",
                exportName: "default",
                splice: { kind: "children" },
                role: "layout",
              },
              {
                file: "src/app/(admin)/layout.tsx",
                exportName: "default",
                splice: { kind: "children" },
                role: "layout",
              },
            ],
          }),
        ),
      ],
    })

    const page = flatten(screenById(graph, "/users").tree).find((node) => node.file.endsWith("page.tsx"))
    expect(page?.truncated).toBe(false)
    expect(page?.children.map((child) => child.file)).toEqual(["src/ui/UsersTable.tsx"])
  })

  it("keeps repeat detection spanning the whole chain", () => {
    const shared = factsTable({
      "src/app/layout.tsx": { renders: [edge("src/ui/Banner.tsx")] },
      "src/app/(admin)/users/page.tsx": {
        renders: [edge("src/ui/Banner.tsx")],
      },
    })

    const graph = build({
      providers: { ast, facts: shared, sourceOf: sourcesFrom(CHAIN_FILES) },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/users", {
            entries: [
              {
                kind: "file",
                file: "src/app/(admin)/users/page.tsx",
                exportName: "default",
              },
            ],
            ancestors: [
              {
                file: "src/app/layout.tsx",
                exportName: "default",
                splice: { kind: "children" },
                role: "layout",
              },
            ],
          }),
        ),
      ],
    })

    const banners = flatten(screenById(graph, "/users").tree).filter(
      (node) => node.file === "src/ui/Banner.tsx",
    )
    expect(banners.map((node) => node.repeat)).toEqual([false, true])
  })
})

describe("ancestors sharing a file", () => {
  const LAYOUT_FILE = "src/layout/RootLayout.tsx"

  // A common real-app shape: the root route's component and a pathless layout route's component
  // declared side by side in one layout file.
  const LAYOUT = `import { Outlet } from '@tanstack/react-router'
    import { AppShell } from './AppShell'
    import { Panel } from '../ui/Panel'
    import { Toaster } from '../ui/Toaster'
    import { Spinner } from '../ui/Spinner'
    const Frame = ({ children }) => <Panel>{children}</Panel>
    const Devtools = lazy(() => import('../ui/Devtools'))
    export const RootLayout = () => <Frame render={Toaster}><Outlet /><Devtools /></Frame>
    export const AppLayout = () => <AppShell>{busy && <Spinner />}<Outlet /></AppShell>`

  const TAG_FILES: Readonly<Record<string, string>> = {
    AppShell: "src/layout/AppShell.tsx",
    Panel: "src/ui/Panel.tsx",
    Toaster: "src/ui/Toaster.tsx",
    Spinner: "src/ui/Spinner.tsx",
    Header: "src/ui/Header.tsx",
  }

  const LOCAL_NAMES = new Set(["Frame", "Devtools", "RootLayout", "AppLayout", "children", "busy", "lazy"])

  const provider = factsTable({
    [LAYOUT_FILE]: {
      renders: [
        edge("src/layout/AppShell.tsx"),
        edge("src/ui/Devtools.tsx", { via: "lazy" }),
        edge("src/ui/Panel.tsx"),
        edge("src/ui/Spinner.tsx", { conditions: ["busy"], alwaysRendered: false }),
        edge("src/ui/Toaster.tsx", { via: "reference" }),
      ],
    },
    "src/layout/AppShell.tsx": { renders: [edge("src/ui/Header.tsx")] },
    "src/pages/Dashboard.tsx": { renders: [edge("src/layout/AppShell.tsx")] },
  })

  const providers: GraphProviders = {
    ast,
    facts: provider,
    sourceOf: sourcesFrom({
      [LAYOUT_FILE]: LAYOUT,
      "src/layout/AppShell.tsx": "export const AppShell = ({ children }) => <div><Header />{children}</div>",
    }),
    declaringFileOf: (file, name) => {
      if (file !== LAYOUT_FILE) return null
      if (LOCAL_NAMES.has(name)) return null
      return TAG_FILES[name] ?? null
    },
  }

  const ROOT_LAYOUT = {
    file: LAYOUT_FILE,
    exportName: "RootLayout",
    splice: { kind: "outlet", tag: "Outlet" },
    role: "layout",
  } as const

  const APP_LAYOUT = { ...ROOT_LAYOUT, exportName: "AppLayout" } as const

  const screenUnder = (url: string, page: string, ancestors: NonNullable<ScreenDraft["ancestors"]>) =>
    contribution(
      "test-source",
      urlDraft(url, { entries: [{ kind: "file", file: page, exportName: "default" }], ancestors }),
    )

  const graph = build({
    providers,
    contributions: [
      screenUnder("/dashboard", "src/pages/Dashboard.tsx", [ROOT_LAYOUT, APP_LAYOUT]),
      screenUnder("/print", "src/pages/Print.tsx", [ROOT_LAYOUT]),
    ],
  })

  it("gives each export its own node, labelled by the export, never a repeat of its file-mate", () => {
    const tree = screenById(graph, "/dashboard").tree

    expect(shapeOf(tree)).toBe(
      "RootLayout(Devtools(),Panel(),Toaster(),AppLayout(AppShell(Header(),Dashboard(AppShell())),Spinner()))",
    )
    const layouts = flatten(tree).filter((node) => node.file === LAYOUT_FILE)
    expect(layouts.map((node) => [node.component, node.repeat])).toEqual([
      ["RootLayout", false],
      ["AppLayout", false],
    ])
  })

  it("keeps genuine repeats: a component the page renders again is still marked", () => {
    const shells = flatten(screenById(graph, "/dashboard").tree).filter(
      (node) => node.file === "src/layout/AppShell.tsx",
    )
    expect(shells.map((node) => node.repeat)).toEqual([false, true])
  })

  it("scopes render edges to the export: its own JSX, same-file helpers, references by name", () => {
    const print = screenById(graph, "/print")

    expect(shapeOf(print.tree)).toBe("RootLayout(Devtools(),Panel(),Toaster(),Print())")
    expect(print.reachable).not.toContain("src/layout/AppShell.tsx")
    expect(print.reachable).not.toContain("src/ui/Spinner.tsx")
  })

  it("takes guards from the export's own JSX and keeps an edge no export references on the main one", () => {
    const appLayout = flatten(screenById(graph, "/dashboard").tree).find(
      (node) => node.component === "AppLayout",
    )
    const spinner = appLayout?.children.find((node) => node.file === "src/ui/Spinner.tsx")
    expect(spinner?.conditions).toEqual(["busy"])
    expect(spinner?.alwaysRendered).toBe(false)

    const devtools = flatten(screenById(graph, "/print").tree).find(
      (node) => node.file === "src/ui/Devtools.tsx",
    )
    expect(devtools?.via).toBe("lazy")
  })

  it("scopes a lone ancestor exported as a component other than its file's main one", () => {
    const lone = build({
      providers,
      contributions: [screenUnder("/settings", "src/pages/Settings.tsx", [APP_LAYOUT])],
    })

    expect(shapeOf(screenById(lone, "/settings").tree)).toBe(
      "AppLayout(AppShell(Header(),Settings()),Devtools(),Spinner())",
    )
  })

  it("leaves an ancestor whose file holds no other route component as the whole-file node", () => {
    const whole = build({
      providers,
      contributions: [screenUnder("/print", "src/pages/Print.tsx", [ROOT_LAYOUT])],
    })

    const root = screenById(whole, "/print").tree[0]
    expect(root?.component).toBe("RootLayout")
    expect(root?.children.map((node) => node.file)).toContain("src/layout/AppShell.tsx")
  })

  it("is deterministic", () => {
    const again = build({
      providers,
      contributions: [
        screenUnder("/print", "src/pages/Print.tsx", [ROOT_LAYOUT]),
        screenUnder("/dashboard", "src/pages/Dashboard.tsx", [ROOT_LAYOUT, APP_LAYOUT]),
      ],
    })
    expect(JSON.stringify(again.screens)).toBe(JSON.stringify(graph.screens))
  })
})

describe("an entry sharing its file with another component export (r2)", () => {
  const PAGE_FILE = "src/pages/settings.tsx"

  const TAG_FILES: Readonly<Record<string, string>> = {
    Big: "src/widgets/Big.tsx",
    Small: "src/widgets/Small.tsx",
    Other: "src/widgets/Other.tsx",
  }

  const IMPORTS = `import { Big } from '../widgets/Big'
    import { Small } from '../widgets/Small'
    import { Other } from '../widgets/Other'`

  const LOCAL_NAMES = new Set(["Row"])

  const providersFor = (code: string): GraphProviders => ({
    ast,
    facts: factsTable({
      [PAGE_FILE]: {
        renders: Object.entries(TAG_FILES)
          .filter(([tag]) => code.includes(`<${tag}`))
          .map(([, target]) => edge(target)),
      },
    }),
    sourceOf: sourcesFrom({ [PAGE_FILE]: `${IMPORTS}\n${code}` }),
    declaringFileOf: (file, name) => {
      if (file !== PAGE_FILE || LOCAL_NAMES.has(name)) return null
      return TAG_FILES[name] ?? null
    },
  })

  const screenOf = (url: string, exportName: string) =>
    contribution("test-source", urlDraft(url, { entries: [{ kind: "file", file: PAGE_FILE, exportName }] }))

  const treesOf = (code: string, routes: Readonly<Record<string, string>>) => {
    const graph = build({
      providers: providersFor(code),
      contributions: Object.entries(routes).map(([url, exportName]) => screenOf(url, exportName)),
    })
    return Object.keys(routes).map((url) => shapeOf(screenById(graph, url).tree))
  }

  const TWO_EXPORTS = `export default function Settings() { return <Big /> }
    export function SettingsPage() { return <Small /> }`

  it("roots a routed named export at its own declaration, without the default export's renders", () => {
    expect(treesOf(TWO_EXPORTS, { "/settings": "SettingsPage" })).toEqual(["SettingsPage(Small())"])
  })

  it("keeps an unrouted default export's renders out of each of several routed named exports", () => {
    const three = `export default function Settings() { return <Big /> }
      export function SettingsPage() { return <Small /> }
      export function AboutPage() { return <p /> }`

    expect(treesOf(three, { "/about": "AboutPage", "/settings": "SettingsPage" })).toEqual([
      "AboutPage()",
      "SettingsPage(Small())",
    ])
  })

  it("keeps the renders of a default app shell that mounts the routed export out of its tree", () => {
    const shell = `export default function App() { return <><Big /><SettingsPage /></> }
      export function SettingsPage() { return <Small /> }`
    expect(treesOf(shell, { "/settings": "SettingsPage" })).toEqual(["SettingsPage(Small())"])
  })

  it("keeps what a same-file component export the entry renders renders", () => {
    const helper = `export function Row() { return <Big /> }
      export default function Settings() { return <Other /> }
      export function SettingsPage() { return <><Small /><Row /></> }`
    expect(treesOf(helper, { "/settings": "SettingsPage" })).toEqual(["SettingsPage(Big(),Small())"])
  })

  it("labels a routed default export by its declaration's own name, else by the file stem", () => {
    const anonymous = `export default () => <Big />
      export function SettingsPage() { return <Small /> }`
    const routes = { "/old": "default", "/settings": "SettingsPage" }

    expect(treesOf(TWO_EXPORTS, routes)).toEqual(["Settings(Big())", "SettingsPage(Small())"])
    expect(treesOf(anonymous, routes)).toEqual(["settings(Big())", "SettingsPage(Small())"])
  })

  it("leaves a lone default entry as the whole-file node: route-module parts render with it", () => {
    expect(treesOf(TWO_EXPORTS, { "/old": "default" })).toEqual(["settings(Big(),Small())"])
  })

  it("does not count a non-component export that renders JSX as a sibling", () => {
    const hook = `export const getPages = () => [<Big />]
      export function SettingsPage() { return <Small /> }`
    expect(treesOf(hook, { "/settings": "SettingsPage" })).toEqual(["settings(Big(),Small())"])
  })

  it("leaves the whole-file node when the other export is the entry's own part or its route definition", () => {
    const rendered = `export function Row() { return <Big /> }
      export function SettingsPage() { return <><Small /><Row /></> }`
    const definition = `export const Route = { component: SettingsPage, errorComponent: () => <Big /> }
      export function SettingsPage() { return <Small /> }`

    expect(treesOf(rendered, { "/settings": "SettingsPage" })).toEqual(["settings(Big(),Small())"])
    expect(treesOf(definition, { "/settings": "SettingsPage" })).toEqual(["settings(Big(),Small())"])
  })

  it("leaves a file with one component export as the whole-file node", () => {
    const single = `export function SettingsPage() { return <><Big /><Small /></> }
      export const useSettings = () => null`
    expect(treesOf(single, { "/settings": "SettingsPage" })).toEqual(["settings(Big(),Small())"])
  })

  it("is deterministic", () => {
    const routes = { "/old": "default", "/settings": "SettingsPage" }
    expect(treesOf(TWO_EXPORTS, routes)).toEqual(treesOf(TWO_EXPORTS, routes))
  })
})

describe("outlet splicing", () => {
  const routeFacts = factsTable({
    "src/routes/__root.tsx": { renders: [edge("src/ui/Chrome.tsx")] },
    "src/routes/_authed.tsx": {},
    "src/routes/orders.tsx": { renders: [edge("src/ui/OrdersTable.tsx")] },
  })

  const graphFor = (
    files: Readonly<Record<string, string>>,
    importedNameOf?: GraphProviders["importedNameOf"],
  ): AppGraph =>
    build({
      providers: {
        ast,
        facts: routeFacts,
        sourceOf: sourcesFrom(files),
        ...(importedNameOf === undefined ? {} : { importedNameOf }),
      },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/orders", {
            entries: [
              {
                kind: "file",
                file: "src/routes/orders.tsx",
                exportName: "Route",
              },
            ],
            ancestors: [
              {
                file: "src/routes/_authed.tsx",
                exportName: "Authed",
                splice: { kind: "outlet", tag: "Outlet" },
                role: "guard",
              },
            ],
          }),
        ),
      ],
    })

  it("splices at an <Outlet/> in the component a wrapper call exports", () => {
    const graph = graphFor({
      "src/routes/_authed.tsx": `function AuthedLayout() { return <Guarded><Outlet /></Guarded> }
      export const Authed = observer(AuthedLayout)`,
    })

    expect(shapeOf(screenById(graph, "/orders").tree)).toBe("_authed(orders(OrdersTable()))")
    expect(graph.diagnostics.filter((entry) => entry.code.startsWith("walk/"))).toEqual([])
  })

  it("splices at a plain <Outlet/>", () => {
    const graph = graphFor({
      "src/routes/_authed.tsx": `export const Authed = () => <Guarded><Outlet /></Guarded>`,
    })

    expect(shapeOf(screenById(graph, "/orders").tree)).toBe("_authed(orders(OrdersTable()))")
    expect(graph.diagnostics.filter((entry) => entry.code.startsWith("walk/"))).toEqual([])
  })

  it("splices at an aliased import, resolved through the binding rather than the written name", () => {
    const graph = graphFor(
      {
        "src/routes/_authed.tsx": `import { Outlet as Slot } from '@tanstack/react-router'
        export const Authed = () => <Guarded><Slot /></Guarded>`,
      },
      (file, local) =>
        file === "src/routes/_authed.tsx" && local === "Slot" ? { imported: "Outlet" } : null,
    )

    expect(shapeOf(screenById(graph, "/orders").tree)).toBe("_authed(orders(OrdersTable()))")
    expect(graph.diagnostics.filter((entry) => entry.code.startsWith("walk/"))).toEqual([])
  })

  it("splices at a namespace-imported <Router.Outlet/>", () => {
    const graph = graphFor(
      {
        "src/routes/_authed.tsx": `import * as Router from '@tanstack/react-router'
        export const Authed = () => <Router.Outlet />`,
      },
      (file, local) => (file === "src/routes/_authed.tsx" && local === "Router" ? { imported: "*" } : null),
    )

    expect(shapeOf(screenById(graph, "/orders").tree)).toBe("_authed(orders(OrdersTable()))")
  })

  it("splices at a useOutlet() call", () => {
    const graph = graphFor({
      "src/routes/_authed.tsx": `export const Authed = () => { const outlet = useOutlet(); return <Guarded>{outlet}</Guarded> }`,
    })

    expect(shapeOf(screenById(graph, "/orders").tree)).toBe("_authed(orders(OrdersTable()))")
  })

  it("splices under the rendered component that hosts the <Outlet/>, not at the ancestor", () => {
    const graph = build({
      providers: {
        ast,
        facts: factsTable({
          "src/routes/_authed.tsx": {
            renders: [edge("src/ui/Banner.tsx"), edge("src/ui/AppShell.tsx")],
          },
          "src/ui/AppShell.tsx": { renders: [edge("src/ui/Header.tsx")] },
          "src/routes/orders.tsx": {
            renders: [edge("src/ui/OrdersTable.tsx")],
          },
        }),
        sourceOf: sourcesFrom({
          "src/routes/_authed.tsx": "export const Authed = () => <><Banner /><AppShell /></>",
          "src/ui/Banner.tsx": "export const Banner = () => <p />",
          "src/ui/AppShell.tsx": "export const AppShell = () => <main><Header /><Outlet /></main>",
        }),
      },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/orders", {
            entries: [
              {
                kind: "file",
                file: "src/routes/orders.tsx",
                exportName: "Route",
              },
            ],
            ancestors: [
              {
                file: "src/routes/_authed.tsx",
                exportName: "Authed",
                splice: { kind: "outlet", tag: "Outlet" },
                role: "layout",
              },
            ],
          }),
        ),
      ],
    })

    expect(shapeOf(screenById(graph, "/orders").tree)).toBe(
      "_authed(Banner(),AppShell(Header(),orders(OrdersTable())))",
    )
    expect(graph.diagnostics.filter((entry) => entry.code.startsWith("walk/"))).toEqual([])
  })

  it("does not name-match a same-named local component that was never imported as Outlet", () => {
    const graph = graphFor(
      {
        "src/routes/_authed.tsx": `import { Slot } from './slot'
        export const Authed = () => <Slot />`,
      },
      () => ({ imported: "Slot" }),
    )

    expect(graph.diagnostics.map((entry) => entry.code)).toContain("walk/no-splice-point")
  })
})

describe("splice failures", () => {
  const provider = factsTable({
    "src/layouts/Two.tsx": { renders: [edge("src/ui/Left.tsx")] },
    "src/pages/P.tsx": { renders: [edge("src/ui/Body.tsx")] },
  })

  const graphFor = (code: string, exportName = "Two"): AppGraph =>
    build({
      providers: {
        ast,
        facts: provider,
        sourceOf: sourcesFrom({ "src/layouts/Two.tsx": code }),
      },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/p", {
            entries: [{ kind: "file", file: "src/pages/P.tsx", exportName: "default" }],
            ancestors: [
              {
                file: "src/layouts/Two.tsx",
                exportName,
                splice: { kind: "children" },
                role: "layout",
              },
            ],
          }),
        ),
      ],
    })

  it("splices directly under the layout and warns naming every candidate line, without claiming a line choice", () => {
    const graph = graphFor(`export const Two = ({ children }) => (
      <Split>
        <aside>{children}</aside>
        <main>{children}</main>
      </Split>
    )`)

    expect(shapeOf(screenById(graph, "/p").tree)).toBe("Two(Left(),P(Body()))")

    const warning = graph.diagnostics.find((entry) => entry.code === "walk/ambiguous-splice")
    expect(warning?.severity).toBe("warning")
    expect(warning?.file).toBe("src/layouts/Two.tsx")
    expect(warning?.message).toContain("lines 3, 4")
    expect(warning?.message).toContain("every site gives the same tree: the page is placed directly under the ancestor")
    expect(warning?.message).not.toContain("spliced at line")
    expect(warning?.line).toBe(3)
  })

  it("treats an ancestor with no splice point as transparent, keeps the subtree and warns", () => {
    const graph = graphFor(`export const Two = () => <Split><Left /></Split>`)
    const screen = screenById(graph, "/p")

    expect(shapeOf(screen.tree)).toBe("P(Body())")
    expect(screen.reachable).toContain("src/layouts/Two.tsx")

    const warning = graph.diagnostics.find((entry) => entry.code === "walk/no-splice-point")
    expect(warning?.severity).toBe("warning")
    expect(warning?.file).toBe("src/layouts/Two.tsx")
    expect(warning?.message).toContain("{children}")
  })

  it("finds the slot outside a JSX expression: a bare return, a concise arrow body, props.children", () => {
    for (const code of [
      "export function Two({ children }) { return children }",
      "export const Two = ({ children }) => children",
      "export function Two(props) { return props.children }",
      "export const Two = ({ children: content }) => <Split>{content}</Split>",
      "export const Two = ({ children }) => <Split>{Children.map(children, wrap)}</Split>",
      "export const Two = (props) => <Shell {...props} />",
      "export const Two = ({ title, ...rest }) => <Shell title={title} {...rest} />",
    ]) {
      const graph = graphFor(code)

      expect(shapeOf(screenById(graph, "/p").tree), code).toBe("Two(Left(),P(Body()))")
      expect(
        graph.diagnostics.filter((entry) => entry.code.startsWith("walk/")),
        code,
      ).toEqual([])
    }
  })

  it("finds the slot in the component a default-exported wrapper call renders", () => {
    for (const code of [
      "const Two = ({ children }) => <Split>{children}</Split>\nexport default withAuth(Two)",
      "function Two({ children }) { return <Split>{children}</Split> }\nexport default observer(memo(Two))",
      "const Inner = ({ children }) => <Split>{children}</Split>\nconst Two = memo(Inner)\nexport default withAuth(Two)",
      "export default withAuth(function Two({ children }) { return <Split>{children}</Split> })",
    ]) {
      const graph = graphFor(code, "default")

      expect(shapeOf(screenById(graph, "/p").tree), code).toBe("Two(Left(),P(Body()))")
      expect(
        graph.diagnostics.filter((entry) => entry.code.startsWith("walk/")),
        code,
      ).toEqual([])
    }
  })

  it("still warns when a wrapper call's argument cannot be resolved to a declaration in the file", () => {
    for (const code of [
      "import { Two } from './Two.impl'\nexport default withAuth(Two)",
      "export default withAuth(Missing)",
      "const Two = ({ children }) => <Split>{children}</Split>\nexport default withAuth(Other)",
    ]) {
      expect(
        graphFor(code, "default").diagnostics.map((entry) => entry.code),
        code,
      ).toContain("walk/no-splice-point")
    }
  })

  it("does not take a rest binding that pulled children out, or a helper's node.children, as the slot", () => {
    for (const code of [
      "export const Two = ({ children, ...rest }) => <Shell {...rest} />",
      "export const Two = () => { const kids = (node) => node.children; return <Split /> }",
    ]) {
      expect(
        graphFor(code).diagnostics.map((entry) => entry.code),
        code,
      ).toContain("walk/no-splice-point")
    }
  })

  it("reports a missing splice point once per ancestor, naming how many screens it affects", () => {
    const ancestors = [
      {
        file: "src/layouts/Two.tsx",
        exportName: "Two",
        splice: { kind: "children" },
        role: "layout",
      },
    ] as const
    const graph = build({
      providers: {
        ast,
        facts: provider,
        sourceOf: sourcesFrom({
          "src/layouts/Two.tsx": "export const Two = () => <Split />",
        }),
      },
      contributions: ["/a", "/b", "/c", "/d"].map((url) =>
        contribution(
          "test-source",
          urlDraft(url, {
            entries: [{ kind: "file", file: "src/pages/P.tsx", exportName: "default" }],
            ancestors,
          }),
        ),
      ),
    })

    const reported = graph.diagnostics.filter((entry) => entry.code === "walk/no-splice-point")
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain("affects 4 screens (/a, /b, /c, +1 more)")
    expect(reported[0]?.screenId).toBeUndefined()
  })

  it("says nothing about an ancestor the adapter declared transparent", () => {
    const graph = build({
      providers: {
        ast,
        facts: provider,
        sourceOf: sourcesFrom({
          "src/layouts/Two.tsx": "export const Two = 1",
        }),
      },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/p", {
            entries: [{ kind: "file", file: "src/pages/P.tsx", exportName: "default" }],
            ancestors: [
              {
                file: "src/layouts/Two.tsx",
                exportName: "Two",
                splice: { kind: "children" },
                role: "transparent",
              },
            ],
          }),
        ),
      ],
    })

    expect(shapeOf(screenById(graph, "/p").tree)).toBe("P(Body())")
    expect(screenById(graph, "/p").reachable).toContain("src/layouts/Two.tsx")
    expect(graph.diagnostics.filter((entry) => entry.code.startsWith("walk/"))).toEqual([])
  })

  /**
   * `{children ?? <Outlet />}` and an `export default <Identifier>` indirection are common layout
   * shapes. Both render a real `{children}`, so neither may be reported as having no splice point.
   */
  it("splices at {children} behind a ?? default, a || default and a ternary", () => {
    for (const body of [
      "{children ?? <Outlet />}",
      "{children || <Outlet />}",
      "{children ? children : <Outlet />}",
    ]) {
      const graph = graphFor(`export const Two = ({ children }) => <Split>${body}</Split>`)

      expect(shapeOf(screenById(graph, "/p").tree)).toBe("Two(Left(),P(Body()))")
      expect(graph.diagnostics.filter((entry) => entry.code.startsWith("walk/"))).toEqual([])
    }
  })

  it("still finds no splice point when the default has no children operand at all", () => {
    const graph = graphFor("export const Two = () => <Split>{fallback ?? <Outlet />}</Split>")

    expect(graph.diagnostics.map((entry) => entry.code)).toContain("walk/no-splice-point")
  })

  it("follows `export default Component` to the declaration that renders {children}", () => {
    const graph = build({
      providers: {
        ast,
        facts: provider,
        sourceOf: sourcesFrom({
          "src/layouts/Two.tsx": [
            "const Two = ({ children }) => <Split>{children}</Split>",
            "export default Two",
          ].join("\n"),
        }),
      },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/p", {
            entries: [{ kind: "file", file: "src/pages/P.tsx", exportName: "default" }],
            ancestors: [
              {
                file: "src/layouts/Two.tsx",
                exportName: "default",
                splice: { kind: "children" },
                role: "layout",
              },
            ],
          }),
        ),
      ],
    })

    expect(shapeOf(screenById(graph, "/p").tree)).toBe("Two(Left(),P(Body()))")
    expect(graph.diagnostics.filter((entry) => entry.code.startsWith("walk/"))).toEqual([])
  })

  it("keeps an unreadable ancestor transparent rather than dropping the screen", () => {
    const graph = build({
      providers: { ast, facts: provider, sourceOf: () => null },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/p", {
            entries: [{ kind: "file", file: "src/pages/P.tsx", exportName: "default" }],
            ancestors: [
              {
                file: "src/layouts/Two.tsx",
                exportName: "Two",
                splice: { kind: "children" },
                role: "layout",
              },
            ],
          }),
        ),
      ],
    })

    expect(shapeOf(screenById(graph, "/p").tree)).toBe("P(Body())")
    const error = graph.diagnostics.find((entry) => entry.code === "walk/no-splice-point")
    expect(error?.severity).toBe("error")
    expect(error?.screenId).toBe("/p")
  })
})

describe("splice placement inside a wrapper element", () => {
  const LAYOUT = "src/layouts/Picker.tsx"
  const TAG_FILES: Readonly<Record<string, string>> = {
    Wrapper: "src/ui/Wrapper.tsx",
    Chrome: "src/ui/Chrome.tsx",
    Switch: "src/ui/Switch.tsx",
    Hoist: "src/ui/Hoist.tsx",
    Guarded: "src/ui/Guarded.tsx",
    Tips: "src/ui/Tips.tsx",
  }

  const WRAPPER_SOURCES: Readonly<Record<string, string>> = {
    "src/ui/Wrapper.tsx": "export const Wrapper = ({ children }) => <div><Header />{children}</div>",
    "src/ui/Chrome.tsx": "export const Chrome = (props) => <nav {...props} />",
    "src/ui/Hoist.tsx": `export const Hoist = ({ children }) => {
      const set = useContext(SlotCtx)
      useEffect(() => set(children))
      return null
    }
    export const SlotProvider = ({ children }) => <SlotCtx.Provider value={1}>{children}</SlotCtx.Provider>`,
    "src/ui/Guarded.tsx": `const Content = ({ children }) => <section>{children}</section>
    export const Guarded = withAuth(memo(Content))`,
    "src/ui/Tips.tsx": "export const Tips = TooltipPrimitive.Provider",
  }

  const provider = factsTable({
    [LAYOUT]: {
      renders: [
        edge("src/ui/Chrome.tsx"),
        edge("src/ui/Guarded.tsx"),
        edge("src/ui/Hoist.tsx"),
        edge("src/ui/Switch.tsx"),
        edge("src/ui/Tips.tsx"),
        edge("src/ui/Wrapper.tsx"),
      ],
    },
    "src/ui/Wrapper.tsx": { renders: [edge("src/ui/Header.tsx")] },
    "src/pages/P.tsx": { renders: [edge("src/ui/Body.tsx")] },
  })

  const graphFor = (code: string): AppGraph =>
    build({
      providers: {
        ast,
        facts: provider,
        sourceOf: sourcesFrom({ ...WRAPPER_SOURCES, [LAYOUT]: code }),
        declaringFileOf: (file, tag) => (file === LAYOUT ? (TAG_FILES[tag] ?? null) : null),
      },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/p", {
            entries: [{ kind: "file", file: "src/pages/P.tsx", exportName: "default" }],
            ancestors: [{ file: LAYOUT, exportName: "Picker", splice: { kind: "children" }, role: "layout" }],
          }),
        ),
      ],
    })

  const walkWarnings = (graph: AppGraph) => graph.diagnostics.filter((entry) => entry.code.startsWith("walk/"))

  const BARE = "Picker(Chrome(),Guarded(),Hoist(),Switch(),Tips(),Wrapper(Header()),P(Body()))"
  const WRAPPED = "Picker(Chrome(),Guarded(),Hoist(),Switch(),Tips(),Wrapper(Header(),P(Body())))"

  it("places the screen under the component element that wraps {children}", () => {
    const graph = graphFor(
      "export const Picker = ({ children }) => <><Chrome /><Wrapper><section>{children}</section></Wrapper></>",
    )

    expect(shapeOf(screenById(graph, "/p").tree)).toBe(WRAPPED)
    expect(screenById(graph, "/p").placementAmbiguous).toBeUndefined()
    expect(walkWarnings(graph)).toEqual([])
  })

  it("leaves a layout rendering {children} directly unchanged", () => {
    const graph = graphFor("export const Picker = ({ children }) => <main><Chrome /><Wrapper />{children}</main>")

    expect(shapeOf(screenById(graph, "/p").tree)).toBe(BARE)
    expect(walkWarnings(graph)).toEqual([])
  })

  it("does not place under a component that only receives {children} as a named prop", () => {
    const graph = graphFor("export const Picker = ({ children }) => <Switch show={children} />")

    expect(shapeOf(screenById(graph, "/p").tree)).toBe(BARE)
  })

  it("grafts under the wrapper when every splice site agrees on it", () => {
    const graph = graphFor(`export const Picker = ({ children, wide }) => (
      wide ? <Wrapper>{children}</Wrapper> : <Wrapper><aside>{children}</aside></Wrapper>
    )`)

    expect(shapeOf(screenById(graph, "/p").tree)).toBe(WRAPPED)
    expect(screenById(graph, "/p").placementAmbiguous).toBeUndefined()
    const warning = graph.diagnostics.find((entry) => entry.code === "walk/ambiguous-splice")
    expect(warning?.message).toContain("every site gives the same tree: the page is placed inside <Wrapper>")
  })

  it("places the page under the host and marks the screen when a bare site and a wrapped one disagree", () => {
    const graph = graphFor(`export const Picker = ({ children, standalone }) => (
      <Switch
        show={children}
        elseShow={<Wrapper>{children}</Wrapper>}
      />
    )`)

    const screen = screenById(graph, "/p")
    expect(shapeOf(screen.tree)).toBe(BARE)
    expect(screen.placementAmbiguous).toEqual([LAYOUT])
    const warning = graph.diagnostics.find((entry) => entry.code === "walk/ambiguous-splice")
    expect(warning?.line).toBe(3)
    expect(warning?.screenId).toBe("/p")
    expect(warning?.message).toContain("lines 3, 4")
    expect(warning?.message).toContain(
      "no single placement holds (line 3 (directly under the ancestor), line 4 (inside <Wrapper>)), so the tree places the page directly under the ancestor",
    )
  })

  it("places the page under the host when two sites sit in different wrappers", () => {
    const graph = graphFor(
      "export const Picker = ({ children, mobile }) => (mobile ? <Chrome>{children}</Chrome> : <Wrapper>{children}</Wrapper>)",
    )

    expect(shapeOf(screenById(graph, "/p").tree)).toBe(BARE)
    expect(screenById(graph, "/p").placementAmbiguous).toEqual([LAYOUT])
  })

  it("never grafts under a wrapper whose own declaration does not render its children", () => {
    const graph = graphFor("export const Picker = ({ children }) => <html><body><Hoist>{children}</Hoist></body></html>")

    const screen = screenById(graph, "/p")
    expect(shapeOf(screen.tree)).toBe(BARE)
    expect(screen.placementAmbiguous).toEqual([LAYOUT])
    const warning = graph.diagnostics.find((entry) => entry.code === "walk/ambiguous-splice")
    expect(warning?.message).toContain("line 1 (inside <Hoist>, not seen rendering its {children})")
  })

  it("grafts under a wrapper that forwards its children with a props spread", () => {
    const graph = graphFor("export const Picker = ({ children }) => <Chrome>{children}</Chrome>")

    expect(shapeOf(screenById(graph, "/p").tree)).toBe(
      "Picker(Chrome(P(Body())),Guarded(),Hoist(),Switch(),Tips(),Wrapper(Header()))",
    )
    expect(screenById(graph, "/p").placementAmbiguous).toBeUndefined()
  })

  it("follows a wrapper through the higher-order components that wrap it, and trusts a Provider alias", () => {
    const guarded = graphFor("export const Picker = ({ children }) => <Guarded>{children}</Guarded>")
    const tips = graphFor("export const Picker = ({ children }) => <Tips>{children}</Tips>")

    expect(shapeOf(screenById(guarded, "/p").tree)).toBe(
      "Picker(Chrome(),Guarded(P(Body())),Hoist(),Switch(),Tips(),Wrapper(Header()))",
    )
    expect(shapeOf(screenById(tips, "/p").tree)).toBe(
      "Picker(Chrome(),Guarded(),Hoist(),Switch(),Tips(P(Body())),Wrapper(Header()))",
    )
  })

  it("never grafts under a wrapper whose source cannot be read", () => {
    const graph = graphFor("export const Picker = ({ children }) => <Switch>{children}</Switch>")

    expect(shapeOf(screenById(graph, "/p").tree)).toBe(BARE)
    expect(screenById(graph, "/p").placementAmbiguous).toEqual([LAYOUT])
  })
})

describe("slot branches", () => {
  const provider = factsTable({
    "src/app/layout.tsx": { renders: [edge("src/ui/Nav.tsx")] },
    "src/app/page.tsx": { renders: [edge("src/ui/Body.tsx")] },
    "src/app/@modal/page.tsx": {
      renders: [edge("src/ui/Dialog.tsx")],
      endpoints: [{ method: "GET", url: "/api/modal", transport: "http", client: null }],
    },
    "src/app/@aside/default.tsx": {},
  })

  const modalBranch: SlotBranch = {
    file: "src/app/@modal/page.tsx",
    exportName: "default",
    splice: { kind: "slot", name: "modal" },
    conditions: ["slot modal"],
  }

  const graphFor = (code: string, branches: readonly SlotBranch[] = [modalBranch]) =>
    build({
      providers: {
        ast,
        facts: provider,
        sourceOf: sourcesFrom({ "src/app/layout.tsx": code }),
      },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/p", {
            entries: [{ kind: "file", file: "src/app/page.tsx", exportName: "default" }],
            ancestors: [
              {
                file: "src/app/layout.tsx",
                exportName: "default",
                splice: { kind: "children" },
                role: "layout",
                branches,
              },
            ],
          }),
        ),
      ],
    })

  it("grafts a branch beside the page under a layout that renders the slot, conditionally", () => {
    const graph = graphFor(
      "export default function Layout({ children, modal }) { return <main>{children}{modal}</main> }",
    )
    const screen = screenById(graph, "/p")

    expect(shapeOf(screen.tree)).toBe("layout(Nav(),page(Body()),page(Dialog()))")
    const branch = screen.tree[0]?.children[2]
    expect(branch?.file).toBe("src/app/@modal/page.tsx")
    expect(branch?.conditions).toEqual(["slot modal"])
    expect(branch?.alwaysRendered).toBe(false)
    expect(screen.reachable).toContain("src/app/@modal/page.tsx")
    expect(screen.reachable).toContain("src/ui/Dialog.tsx")
    expect(screen.facts.endpoints.map((endpoint) => endpoint.url)).toEqual(["/api/modal"])
    expect(graph.diagnostics.filter((entry) => entry.code.startsWith("walk/"))).toEqual([])
  })

  it("finds the slot through props.modal and a destructured alias", () => {
    for (const code of [
      "export default function Layout(props) { return <main>{props.children}{props.modal}</main> }",
      "export default function Layout({ children, modal: overlay }) { return <main>{children}{overlay}</main> }",
    ]) {
      const graph = graphFor(code)
      expect(screenById(graph, "/p").reachable, code).toContain("src/app/@modal/page.tsx")
      expect(
        graph.diagnostics.filter((entry) => entry.code.startsWith("walk/")),
        code,
      ).toEqual([])
    }
  })

  it("drops a branch whose slot the layout does not render, with one warning, and keeps the chain", () => {
    const graph = graphFor("export default function Layout({ children }) { return <main>{children}</main> }")
    const screen = screenById(graph, "/p")

    expect(shapeOf(screen.tree)).toBe("layout(Nav(),page(Body()))")
    expect(screen.reachable).not.toContain("src/app/@modal/page.tsx")
    const warnings = graph.diagnostics.filter((entry) => entry.code === "walk/no-splice-point")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.severity).toBe("warning")
    expect(warnings[0]?.file).toBe("src/app/layout.tsx")
    expect(warnings[0]?.message).toContain("{modal}")
    expect(warnings[0]?.message).toContain("src/app/@modal/page.tsx")
  })

  it("orders branches by slot name, then file", () => {
    const graph = graphFor(
      "export default function Layout({ children, modal, aside }) { return <main>{children}{aside}{modal}</main> }",
      [
        modalBranch,
        {
          file: "src/app/@aside/default.tsx",
          exportName: "default",
          splice: { kind: "slot", name: "aside" },
          conditions: ["slot aside"],
        },
      ],
    )

    expect(screenById(graph, "/p").tree[0]?.children.map((node) => node.file)).toEqual([
      "src/ui/Nav.tsx",
      "src/app/page.tsx",
      "src/app/@aside/default.tsx",
      "src/app/@modal/page.tsx",
    ])
  })

  it("keeps the id and url of the url activation when a screen also has an intercept activation", () => {
    const graph = build({
      providers: { ast, facts: provider },
      contributions: [
        contribution(
          "test-source",
          draft({
            localId: "photo",
            activations: [
              { kind: "intercept", from: "/feed", slot: "modal", file: "src/app/@modal/(.)photo/page.tsx" },
              { kind: "url", template: "/photo/:id", params: ["id"] },
            ],
          }),
        ),
      ],
    })
    const screen = screenById(graph, "/photo/:id")

    expect(screen.url).toBe("/photo/:id")
    expect(screen.activations.map((activation) => activation.kind)).toEqual(["url", "intercept"])
  })
})

describe("sub-file roots", () => {
  // A browser-extension content script's shape: several distinct states
  // selected inside ONE file, which a file-granular tree node cannot tell apart.
  const CONTENT = `export const Content = () => {
    const [state, setState] = useState('idle')
    return (
      <div>
        {state === 'loading' && <Spinner />}
        {state === 'error' && <ErrorPanel />}
        {state === 'ready' && <ResultDialog />}
      </div>
    )
  }`

  const CONTENT_FILE = "src/content/Content.tsx"

  const source = parse(CONTENT_FILE, CONTENT)

  const branchElements = (): readonly ts.JsxSelfClosingElement[] => {
    const found: ts.JsxSelfClosingElement[] = []
    walk(source, (node) => {
      if (ts.isJsxSelfClosingElement(node)) found.push(node)
    })
    return found
  }

  const locators = branchElements().map((element): NodeLocator => ast.locate(element))

  const TAG_FILES: Readonly<Record<string, string>> = {
    Spinner: "src/ui/Spinner.tsx",
    ErrorPanel: "src/ui/ErrorPanel.tsx",
    ResultDialog: "src/ui/ResultDialog.tsx",
    DialogBody: "src/ui/DialogBody.tsx",
  }

  const provider = factsTable({
    [CONTENT_FILE]: {
      renders: [edge("src/ui/Spinner.tsx")],
      uses: ["src/services/messaging.ts"],
    },
    "src/ui/ResultDialog.tsx": { renders: [edge("src/ui/DialogBody.tsx")] },
  })

  const providers: GraphProviders = {
    ast,
    facts: provider,
    sourceOf: (file) => (file === CONTENT_FILE ? source : null),
    declaringFileOf: (_file, tag) => TAG_FILES[tag] ?? null,
  }

  const stateScreen = (index: number): ScreenContribution => {
    const at = locators[index]
    if (at === undefined) throw new Error(`no locator ${index}`)
    return contribution(
      "state-screens",
      draft({
        localId: `${CONTENT_FILE}#${index}`,
        activations: [
          {
            kind: "state",
            holder: "Content",
            expr: `state === '...' (${index})`,
          },
        ],
        entries: [{ kind: "file", file: CONTENT_FILE, exportName: "Content", at }],
      }),
    )
  }

  const graph = build({
    providers,
    contributions: [stateScreen(0), stateScreen(1), stateScreen(2)],
  })

  const idOf = (index: number) => `screen://state-screens/${encodeURIComponent(`${CONTENT_FILE}#${index}`)}`

  it("gives two roots in ONE file two DIFFERENT trees", () => {
    const first = screenById(graph, idOf(0))
    const second = screenById(graph, idOf(1))

    expect(shapeOf(first.tree)).toBe("Content#0(Spinner())")
    expect(shapeOf(second.tree)).toBe("Content#1(ErrorPanel())")
    expect(JSON.stringify(first.tree)).not.toBe(JSON.stringify(second.tree))
  })

  it("scopes render edges to the located subtree only", () => {
    const third = screenById(graph, idOf(2))
    expect(shapeOf(third.tree)).toBe("Content#2(ResultDialog(DialogBody()))")
    expect(third.reachable).not.toContain("src/ui/Spinner.tsx")
  })

  it("clamps guardOf at the locator so the screen's own activation guard is not a node condition", () => {
    const first = screenById(graph, idOf(0))
    for (const node of flatten(first.tree)) expect(node.conditions).toEqual([])
  })

  it("keeps guards BETWEEN the locator and inner JSX", () => {
    const nested = `export const Panel = () => (
      <section>
        {open && (
          <Dialog>
            {busy && <Spinner />}
          </Dialog>
        )}
      </section>
    )`
    const nestedSource = parse("src/ui/Panel.tsx", nested)
    let dialog: ts.JsxElement | null = null
    walk(nestedSource, (node) => {
      if (dialog === null && ts.isJsxElement(node) && ast.tagName(node.openingElement) === "Dialog")
        dialog = node
    })
    if (dialog === null) throw new Error("no Dialog element")

    const nestedGraph = build({
      providers: {
        ast,
        facts: factsTable({ "src/ui/Dialog.tsx": {} }),
        sourceOf: (file) => (file === "src/ui/Panel.tsx" ? nestedSource : null),
        declaringFileOf: (_file, tag) => TAG_FILES[tag] ?? (tag === "Dialog" ? "src/ui/Dialog.tsx" : null),
      },
      contributions: [
        contribution(
          "state-screens",
          draft({
            localId: "src/ui/Panel.tsx#0",
            activations: [{ kind: "state", holder: "Panel", expr: "open" }],
            entries: [
              {
                kind: "file",
                file: "src/ui/Panel.tsx",
                exportName: "Panel",
                at: ast.locate(dialog),
              },
            ],
          }),
        ),
      ],
    })

    const spinner = flatten(nestedGraph.screens[0]?.tree ?? []).find(
      (node) => node.file === "src/ui/Spinner.tsx",
    )
    expect(spinner?.conditions).toEqual(["busy"])
    expect(spinner?.alwaysRendered).toBe(false)
  })

  it("attributes file-level uses to every sub-file screen", () => {
    for (const index of [0, 1, 2])
      expect(screenById(graph, idOf(index)).reachable).toContain("src/services/messaging.ts")
  })

  it("errors on an unresolvable locator and keeps the screen with an empty tree", () => {
    const broken = build({
      providers,
      contributions: [
        contribution(
          "state-screens",
          draft({
            localId: `${CONTENT_FILE}#9`,
            activations: [{ kind: "state", holder: "Content", expr: "never" }],
            entries: [
              {
                kind: "file",
                file: CONTENT_FILE,
                exportName: "Content",
                at: { export: "Content", path: [99] },
              },
            ],
          }),
        ),
      ],
    })

    expect(broken.screens).toHaveLength(1)
    expect(broken.diagnostics.map((entry) => entry.code)).toContain("screens/unresolvable-locator")
  })

  it("prefers subtree facts over whole-file facts while keeping whole-file uses", () => {
    const scoped = build({
      providers: {
        ...providers,
        facts: factsTable({
          [CONTENT_FILE]: {
            testIds: ["whole-file"],
            uses: ["src/services/messaging.ts"],
          },
        }),
        subtreeFacts: (file, locator) =>
          file === CONTENT_FILE && locator.path.length > 0
            ? facts(file, { testIds: [`branch-${locator.path.join("-")}`] })
            : null,
      },
      contributions: [stateScreen(0)],
    })

    const screen = screenById(scoped, idOf(0))
    expect(screen.facts.testIds).not.toContain("whole-file")
    expect(screen.reachable).toContain("src/services/messaging.ts")
  })
})

describe("screen conflict resolution", () => {
  const base = (source: string, extra: Partial<ScreenDraft>) =>
    contribution(source, urlDraft("/shared", { localId: `${source}-local`, ...extra }))

  const graphWith = (policy: "merge" | "first" | "error") =>
    build({
      providers: { ast, facts: factsTable({}) },
      conflicts: policy,
      contributions: [
        base("next", {
          entries: [
            {
              kind: "file",
              file: "src/app/shared/page.tsx",
              exportName: "default",
            },
          ],
          title: "From Next",
        }),
        base("adminjs", {
          entries: [
            {
              kind: "file",
              file: "src/admin/shared.tsx",
              exportName: "Shared",
            },
          ],
          title: "From AdminJS",
          auth: "protected",
        }),
      ],
    })

  it("merges by default: collections union, scalars take the first source with an opinion", () => {
    const graph = graphWith("merge")
    const screen = screenById(graph, "/shared")

    expect(screen.entries).toHaveLength(2)
    expect(screen.title).toBe("From Next")
    expect(screen.auth).toBe("protected")
    expect(screen.provenance.sources).toEqual(["next", "adminjs"])
    expect(screen.provenance.mergedFrom).toEqual([
      { source: "next", localId: "next-local" },
      { source: "adminjs", localId: "adminjs-local" },
    ])

    const info = graph.diagnostics.find((entry) => entry.code === "screens/merged")
    expect(info?.severity).toBe("info")
    expect(info?.message).toContain("next#next-local")
    expect(info?.message).toContain("adminjs#adminjs-local")
  })

  it("an explicit null asserts absence and stops the fallthrough", () => {
    const graph = build({
      providers: { ast, facts: factsTable({}) },
      contributions: [base("next", { title: null }), base("adminjs", { title: "From AdminJS" })],
    })

    expect(screenById(graph, "/shared").title).toBeNull()
  })

  it("first: the first source wins the whole screen and the loser is named", () => {
    const graph = graphWith("first")
    const screen = screenById(graph, "/shared")

    expect(screen.entries).toHaveLength(1)
    expect(screen.auth).toBe("unknown")

    const warning = graph.diagnostics.find((entry) => entry.code === "screens/conflict-dropped")
    expect(warning?.severity).toBe("warning")
    expect(warning?.message).toContain("adminjs")
  })

  it("error: an error diagnostic, screen kept as the first source's version", () => {
    const graph = graphWith("error")

    expect(screenById(graph, "/shared").entries).toHaveLength(1)
    expect(graph.diagnostics.find((entry) => entry.code === "screens/conflict-dropped")?.severity).toBe(
      "error",
    )
  })

  it("same-source duplicates are ALWAYS an error, even under merge", () => {
    const diagnostics = createDiagnosticCollector()
    const merged = resolveScreenConflicts(
      [base("next", { localId: "one" }), base("next", { localId: "two" })],
      "merge",
      diagnostics,
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]?.localId).toBe("one")
    const error = diagnostics.all().find((entry) => entry.code === "screens/duplicate-id")
    expect(error?.severity).toBe("error")
    expect(error?.message).toContain("twice")
  })

  /**
   * Whichever duplicate arrives FIRST (glob order) must not silence the other, or a bogus contribution
   * deletes a real screen's entry outright. The error names the adapter bug; it must not decide the
   * screen.
   */
  it("a same-source duplicate never deletes the sibling's entries or evidence", () => {
    const diagnostics = createDiagnosticCollector()
    const merged = resolveScreenConflicts(
      [
        base("next", { localId: "bogus", entries: [] }),
        base("next", {
          localId: "real",
          entries: [
            {
              kind: "file",
              file: "src/app/shared/page.tsx",
              exportName: "default",
            },
          ],
          auth: "protected",
        }),
      ],
      "merge",
      diagnostics,
    )

    const draft = merged[0]
    expect(draft?.entries).toEqual([{ kind: "file", file: "src/app/shared/page.tsx", exportName: "default" }])
    expect(draft?.auth).toBe("protected")
    expect(draft?.provenance.mergedFrom.map((entry) => entry.localId)).toEqual(["bogus", "real"])
    expect(diagnostics.all().map((entry) => entry.code)).toContain("screens/duplicate-id")
  })
})

describe("nav reconciliation", () => {
  const navGraph = (paths: readonly string[]): AppGraph =>
    build({
      providers: {
        ast,
        facts: factsTable({
          "src/pages/A.tsx": {
            navigations: [{ to: "/b", trigger: "link", dynamic: false }],
          },
        }),
        importsOf: (file) => (file === "src/layouts/Shell.tsx" ? ["src/nav/menu.ts"] : []),
      },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/a", {
            entries: [{ kind: "file", file: "src/pages/A.tsx", exportName: "default" }],
            ancestors: [
              {
                file: "src/layouts/Shell.tsx",
                exportName: "Shell",
                splice: { kind: "children" },
                role: "layout",
              },
            ],
          }),
        ),
        contribution(
          "test-source",
          urlDraft("/b", {
            entries: [{ kind: "file", file: "src/pages/B.tsx", exportName: "default" }],
          }),
        ),
      ],
      navGroups: [
        {
          name: "mainMenu",
          source: "src/nav/menu.ts#MAIN",
          entries: paths.map((path, index) => ({
            path,
            parentPath: null,
            label: path,
            labelKey: null,
            featureFlag: null,
            source: "src/nav/menu.ts#MAIN",
            file: "src/nav/menu.ts",
            line: index + 1,
          })),
        },
      ],
    })

  it("resolves every nav entry to a ScreenId or null", () => {
    const graph = navGraph(["/a", "/missing"])
    const entries = graph.navGroups[0]?.entries ?? []

    expect(entries.map((entry) => [entry.path, entry.resolvedScreen])).toEqual([
      ["/a", "/a"],
      ["/missing", null],
    ])
  })

  it("reports dead links in a top-level collection and as a warning", () => {
    const graph = navGraph(["/a", "/missing"])

    expect(graph.deadNavLinks.map((entry) => entry.path)).toEqual(["/missing"])
    const warning = graph.diagnostics.find((entry) => entry.code === "nav/dead-link")
    expect(warning?.severity).toBe("warning")
    expect(warning?.file).toBe("src/nav/menu.ts")
    expect(warning?.line).toBe(2)
  })

  it("resolves a catch-all's base path, except for a Next.js required [...slug]", () => {
    const fileEntry = (file: string) => [{ kind: "file" as const, file, exportName: "default" }]
    const graph = build({
      providers: { ast, facts: factsTable({}) },
      contributions: [
        contribution("test-source", urlDraft("/app-store/*", { entries: fileEntry("src/pages/AppStore.tsx") })),
        contribution("test-source", urlDraft("/x/*", { entries: fileEntry("src/routes/x.$.tsx") })),
        contribution("test-source", urlDraft("/shop/*", { entries: fileEntry("src/app/shop/[[...slug]]/page.tsx") })),
        contribution("test-source", urlDraft("/docs/*", { entries: fileEntry("src/app/docs/[...slug]/page.tsx") })),
      ],
      navGroups: [
        {
          name: "mainMenu",
          source: "src/nav/menu.ts#MAIN",
          entries: ["/app-store", "/x", "/shop", "/docs", "/docs/intro"].map((path, index) => ({
            path,
            parentPath: null,
            label: path,
            labelKey: null,
            featureFlag: null,
            source: "src/nav/menu.ts#MAIN",
            file: "src/nav/menu.ts",
            line: index + 1,
          })),
        },
      ],
    })

    expect(graph.navGroups[0]?.entries.map((entry) => [entry.path, entry.resolvedScreen])).toEqual([
      ["/app-store", "/app-store/*"],
      ["/docs/intro", "/docs/*"],
      ["/docs", null],
      ["/shop", "/shop/*"],
      ["/x", "/x/*"],
    ])
    expect(graph.deadNavLinks.map((entry) => entry.path)).toEqual(["/docs"])
  })

  it("scores a group by the share of entries that resolve", () => {
    expect(navGraph(["/a", "/missing"]).navGroups[0]?.score).toBe(0.5)
  })

  it("attaches the menu to shells instead of multiplying it across screens", () => {
    const graph = navGraph(["/a"])
    expect(graph.navGroups[0]?.availableOnShells).toEqual(["src/layouts/Shell.tsx"])
    expect(graph.navigation.every((navEdge) => navEdge.via.startsWith("src/pages/"))).toBe(true)
  })

  it("orphan screens are addressable screens with no inbound edge, at info severity", () => {
    const graph = navGraph(["/missing"])

    expect(graph.orphanScreens).toEqual(["/a"])
    expect(
      graph.diagnostics
        .filter((entry) => entry.code === "screens/orphan")
        .every((e) => e.severity === "info"),
    ).toBe(true)
  })
})

describe("non-addressable screens and redirects", () => {
  const graph = build({
    providers: {
      ast,
      facts: factsTable({
        "src/layouts/Pathless.tsx": { renders: [edge("src/ui/Frame.tsx")] },
      }),
    },
    contributions: [
      contribution(
        "test-source",
        draft({
          localId: "src/layouts/Pathless.tsx",
          kindTag: "layout",
          entries: [
            {
              kind: "file",
              file: "src/layouts/Pathless.tsx",
              exportName: "default",
            },
          ],
        }),
      ),
      contribution("test-source", urlDraft("/old", { redirectTo: "/new" })),
      contribution("test-source", urlDraft("/entryless", { kindTag: "entryless", entries: [] })),
      contribution(
        "test-source",
        urlDraft("/opaque", {
          entries: [
            {
              kind: "opaque",
              expr: "registry.get(key)",
              file: "src/routes.tsx",
              line: 12,
            },
          ],
        }),
      ),
    ],
  })

  it("retains a pathless layout route with url null, tagged, and still walks its tree", () => {
    const screen = screenById(graph, "screen://test-source/src%2Flayouts%2FPathless.tsx")

    expect(screen.url).toBeNull()
    expect(screen.addressable).toBe(false)
    expect(screen.kindTag).toBe("layout")
    expect(shapeOf(screen.tree)).toBe("Pathless(Frame())")
  })

  it("retains an entryless route and an opaque entry rather than dropping them", () => {
    expect(screenById(graph, "/entryless").tree).toEqual([])
    expect(screenById(graph, "/opaque").entries[0]?.kind).toBe("opaque")
  })

  it("extracts redirects and excludes them from the screen count", () => {
    expect(graph.redirects).toEqual([{ from: "/old", to: "/new" }])
    expect(graph.meta.counts["redirects"]).toBe(1)
    expect(graph.meta.counts["screens"]).toBe(3)
  })

  it("counts screens as screens[] minus redirects and API routes, which are counted apart", () => {
    const counted = build({
      providers: { ast, facts: factsTable({}) },
      contributions: [
        contribution("test-source", urlDraft("/page")),
        contribution("test-source", urlDraft("/old", { redirectTo: "/page" })),
        contribution("test-source", urlDraft("/api/users", { kindTag: "apiRoute" })),
        contribution("test-source", draft({ localId: "state#Modal" })),
      ],
    })

    expect(counted.screens).toHaveLength(4)
    expect(counted.meta.counts["screens"]).toBe(2)
    expect(counted.meta.counts["redirects"]).toBe(1)
    expect(counted.meta.counts["apiRoutes"]).toBe(1)
  })

  it.each([
    ["apiRoute kindTag", urlDraft("/x", { kindTag: "apiRoute" }), false],
    ["api kindTag", urlDraft("/x", { kindTag: "api" }), false],
    ["redirect", urlDraft("/x", { redirectTo: "/page" }), false],
    ["plain page", urlDraft("/x"), true],
  ])("reports a %s with no inbound edge as an orphan only when it counts as a screen", (_name, screenDraft, isOrphan) => {
    const orphanGraph = build({
      providers: { ast, facts: factsTable({}) },
      contributions: [contribution("test-source", screenDraft)],
    })

    expect(orphanGraph.orphanScreens.includes("/x")).toBe(isOrphan)
    expect(orphanGraph.diagnostics.some((entry) => entry.code === "screens/orphan")).toBe(isOrphan)
  })

  it("never counts more orphan screens than screens", () => {
    const mixed = build({
      providers: { ast, facts: factsTable({}) },
      contributions: [
        contribution("test-source", urlDraft("/page")),
        contribution("test-source", urlDraft("/other")),
        contribution("test-source", urlDraft("/old", { redirectTo: "/page" })),
        contribution("test-source", urlDraft("/api/users", { kindTag: "apiRoute" })),
        contribution("test-source", urlDraft("/api/posts", { kindTag: "api" })),
      ],
    })

    expect(mixed.orphanScreens).toEqual(["/other", "/page"])
    expect(mixed.meta.counts["orphanScreens"]).toBeLessThanOrEqual(mixed.meta.counts["screens"] ?? 0)
  })
})

describe("determinism and meta", () => {
  const input = (): BuildGraphInput => ({
    meta: META,
    providers: {
      ast,
      facts: factsTable({
        "src/pages/Z.tsx": {
          renders: [edge("src/ui/B.tsx"), edge("src/ui/A.tsx")],
          testIds: ["b", "a"],
        },
      }),
    },
    contributions: [
      contribution(
        "test-source",
        urlDraft("/z", {
          entries: [{ kind: "file", file: "src/pages/Z.tsx", exportName: "default" }],
        }),
      ),
      contribution(
        "test-source",
        urlDraft("/a", {
          entries: [{ kind: "file", file: "src/pages/Z.tsx", exportName: "default" }],
        }),
      ),
    ],
  })

  it("produces byte-identical output across runs", () => {
    expect(JSON.stringify(buildGraph(input()))).toBe(JSON.stringify(buildGraph(input())))
  })

  it("carries meta.appName through, and defaults it to null when the caller omits it", () => {
    expect(buildGraph(input()).meta.appName).toBeNull()

    const named = buildGraph({
      ...input(),
      meta: { ...META, appName: "@scope/frontend" },
    })
    expect(named.meta.appName).toBe("@scope/frontend")
  })

  it("sorts screens, components and counts by codepoint", () => {
    const graph = buildGraph(input())

    expect(graph.screens.map((screen) => screen.id)).toEqual(["/a", "/z"])
    expect(Object.keys(graph.components)).toEqual(Object.keys(graph.components).slice().sort())
    expect(Object.keys(graph.meta.counts)).toEqual(Object.keys(graph.meta.counts).slice().sort())
  })

  it("reports counts and carries the walk's limitations", () => {
    const graph = buildGraph(input())

    expect(graph.meta.counts["components"]).toBe(3)
    expect(graph.meta.counts["renderEdges"]).toBe(2)
    expect(graph.meta.maxDepth).toBe(3)
    expect(graph.meta.limitations.some((line) => line.includes("splice point"))).toBe(true)
  })

  /**
   * `meta.limitations` must carry this sentence word for word — the ancestor chain is the one place the tool can be structurally complete and subtly wrong,
   * and the sentence is the only warning an agent gets. Pinned as an exact substring so a reword that
   * softens it fails here rather than shipping.
   */
  it("states the mandated composition sentence verbatim", () => {
    const graph = buildGraph(input())

    expect(
      graph.meta.limitations.some((line) =>
        line.includes(
          "appgraph reports composition as the framework's convention describes it, not as the code proves it",
        ),
      ),
    ).toBe(true)
  })

  /**
   * The machine-tracked limitations the README, the CHANGELOG and `test/parity/known-gaps.ts` record
   * must also reach the emitted artifact. A gap documented only where a human reads it is not
   * documented for the consumer this tool exists to serve.
   */
  it("states the traversal default and makes no first-visit-depth memoisation claim", () => {
    const graph = buildGraph(input())

    expect(graph.meta.limitations.some((line) => line.includes("`(file, depth)`"))).toBe(false)
    expect(graph.meta.limitations.some((line) => line.includes("`traversable`"))).toBe(true)
  })
})

describe("kind rules", () => {
  it("gates uses traversal by KindRule.traversable when rules are supplied", () => {
    const provider = factsTable({
      "src/pages/A.tsx": { uses: ["src/services/api.ts", "src/ui/Widget.tsx"] },
    })

    const contributions = [
      contribution(
        "test-source",
        urlDraft("/a", {
          entries: [{ kind: "file", file: "src/pages/A.tsx", exportName: "default" }],
        }),
      ),
    ]

    const ungated = build({
      providers: { ast, facts: provider },
      contributions,
    })
    const gated = build({
      providers: { ast, facts: provider },
      contributions,
      kindRules: [
        {
          match: { pathPrefix: "src/services/" },
          kind: "service",
          traversable: true,
          screenEntry: false,
        },
        { match: {}, kind: "other", traversable: false, screenEntry: false },
      ],
    })

    expect(screenById(ungated, "/a").reachable).toContain("src/ui/Widget.tsx")
    expect(screenById(gated, "/a").reachable).not.toContain("src/ui/Widget.tsx")
    expect(screenById(gated, "/a").reachable).toContain("src/services/api.ts")
  })
})

describe("host isolation", () => {
  it("builds entirely from in-memory sources", () => {
    const host = createMemoryHost({
      files: { [`${ROOT}/src/pages/A.tsx`]: "export default () => <B />" },
    })
    const text = host.readFile(`${ROOT}/src/pages/A.tsx`)
    expect(text).not.toBeNull()

    const graph = build({
      providers: {
        ast,
        facts: factsTable({ "src/pages/A.tsx": {} }),
        sourceOf: (file) => {
          const content = host.readFile(`${ROOT}/${file}`)
          return content === null ? null : parse(file, content)
        },
      },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/a", {
            entries: [{ kind: "file", file: "src/pages/A.tsx", exportName: "default" }],
          }),
        ),
      ],
    })

    expect(graph.screens.map((screen) => screen.id)).toEqual(["/a"])
    expect(JSON.stringify(graph)).not.toContain(ROOT)
  })
})

describe("strongerVia", () => {
  it("ranks a lazy load over a plain tag and any tag over a value reference", () => {
    expect(strongerVia(undefined, "reference")).toBeUndefined()
    expect(strongerVia("reference", undefined)).toBeUndefined()
    expect(strongerVia(undefined, "lazy")).toBe("lazy")
    expect(strongerVia("lazy", "reference")).toBe("lazy")
    expect(strongerVia("reference", "reference")).toBe("reference")
    expect(strongerVia(undefined, "selector-global")).toBe("selector-global")
    expect(strongerVia("selector-global", "selector")).toBe("selector")
    expect(strongerVia("selector", "lazy")).toBe("lazy")
    expect(strongerVia("selector", "reference")).toBe("selector")
  })
})

describe("redirect rules", () => {
  const AT = "next.config.ts:10"

  const rule = (
    source: string,
    destination: string,
    extra: Partial<Pick<RedirectRule, "condition" | "conditional" | "declaredAt">> = {},
  ): RedirectRule => ({
    source,
    destination,
    declaredAt: AT,
    condition: null,
    conditional: false,
    ...extra,
  })

  const redirectGraph = (paths: readonly string[], redirectRules: readonly RedirectRule[]) =>
    build({
      providers: {
        ast,
        facts: factsTable({ "src/pages/Home.tsx": { navigations: [{ to: "/old/acme", trigger: "link", dynamic: false }] } }),
      },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/org/:slug/general", {
            entries: [{ kind: "file", file: "src/pages/Org.tsx", exportName: "default" }],
          }),
        ),
        contribution(
          "test-source",
          urlDraft("/home", { entries: [{ kind: "file", file: "src/pages/Home.tsx", exportName: "default" }] }),
        ),
      ],
      redirectRules,
      navGroups: [
        {
          name: "mainMenu",
          source: "src/nav/menu.ts#MAIN",
          entries: paths.map((path, index) => ({
            path,
            parentPath: null,
            label: path,
            labelKey: null,
            featureFlag: null,
            source: "src/nav/menu.ts#MAIN",
            file: "src/nav/menu.ts",
            line: index + 1,
          })),
        },
      ],
    })

  const resolved = (graph: AppGraph) =>
    (graph.navGroups[0]?.entries ?? []).map((entry) => [entry.path, entry.resolvedScreen, entry.viaRedirect ?? null])

  it("resolves a nav entry through one redirect hop and records viaRedirect", () => {
    const graph = redirectGraph(["/org/acme"], [rule("/org/:slug", "/org/:slug/general")])

    expect(resolved(graph)).toEqual([
      ["/org/acme", "/org/:slug/general", { from: "/org/acme", to: "/org/acme/general", declaredAt: AT }],
    ])
    expect(graph.deadNavLinks).toEqual([])
  })

  it("follows two hops and resolves navigations in code the same way", () => {
    const graph = redirectGraph(
      ["/legacy/acme"],
      [rule("/legacy/:slug", "/old/:slug"), rule("/old/:slug", "/org/:slug/general")],
    )

    expect(resolved(graph)).toEqual([
      ["/legacy/acme", "/org/:slug/general", { from: "/legacy/acme", to: "/org/acme/general", declaredAt: AT }],
    ])
    const navigation = screenById(graph, "/home").navigatesTo[0]
    expect(navigation?.matchedRoute).toBe("/org/:slug/general")
    expect(navigation?.viaRedirect).toEqual({ from: "/old/acme", to: "/org/acme/general", declaredAt: AT })
    expect(graph.navigation.map((navEdge) => [navEdge.from, navEdge.to])).toEqual([["/home", "/org/:slug/general"]])
  })

  it("stops on a redirect cycle", () => {
    const graph = redirectGraph(["/a"], [rule("/a", "/b"), rule("/b", "/a")])

    expect(resolved(graph)).toEqual([["/a", null, null]])
    expect(graph.deadNavLinks.map((entry) => entry.path)).toEqual(["/a"])
  })

  it("stops after the hop limit", () => {
    const chain = ["/h0", "/h1", "/h2", "/h3", "/h4", "/h5", "/home"]
    const rules = chain.slice(0, -1).map((source, index) => rule(source, chain[index + 1] ?? ""))

    expect(resolved(redirectGraph(["/h1"], rules))[0]?.[1]).toBe("/home")
    expect(resolved(redirectGraph(["/h0"], rules))[0]?.[1]).toBeNull()
  })

  it("never resolves through a conditional rule", () => {
    const graph = redirectGraph(["/org/acme"], [rule("/org/:slug", "/org/:slug/general", { condition: "has cookie", conditional: true })])

    expect(resolved(graph)).toEqual([["/org/acme", null, null]])
  })

  it("never resolves through a /*-equivalent or unreadable source", () => {
    const graph = redirectGraph(
      ["/anything", "/org/acme"],
      [rule("/:path*", "/home"), rule("/:locale?/:rest+", "/home"), rule("/org/:slug(\\d+)", "/home")],
    )

    expect(resolved(graph)).toEqual([
      ["/anything", null, null],
      ["/org/acme", null, null],
    ])
  })

  it("keeps a link dead when the destination is dead too", () => {
    const graph = redirectGraph(["/gone"], [rule("/gone", "/also-gone")])

    expect(resolved(graph)).toEqual([["/gone", null, null]])
    expect(graph.deadNavLinks.map((entry) => entry.path)).toEqual(["/gone"])
  })

  it("prefers a direct match and picks the first matching rule in declaration order", () => {
    const graph = redirectGraph(["/home", "/x"], [rule("/x", "/home"), rule("/:p", "/zzz"), rule("/x", "/zzz")])

    expect(resolved(graph)).toEqual([
      ["/home", "/home", null],
      ["/x", "/home", { from: "/x", to: "/home", declaredAt: AT }],
    ])
  })

  it("lets a specific rule declared before a catch-all win, and the catch-all win when declared first", () => {
    const specific = rule("/old/:slug/linter", "/home")
    const catchAll = rule("/old/:path*", "/org/:path*/general")

    expect(resolved(redirectGraph(["/old/acme/linter"], [specific, catchAll]))).toEqual([
      ["/old/acme/linter", "/home", { from: "/old/acme/linter", to: "/home", declaredAt: AT }],
    ])
    expect(resolved(redirectGraph(["/old/acme/linter"], [catchAll, specific]))).toEqual([
      ["/old/acme/linter", null, null],
    ])
    expect(resolved(redirectGraph(["/old/acme"], [catchAll, specific]))).toEqual([
      ["/old/acme", "/org/:slug/general", { from: "/old/acme", to: "/org/acme/general", declaredAt: AT }],
    ])
  })

  it("never chains rules whose branch conditions contradict each other", () => {
    const graph = redirectGraph(
      ["/a"],
      [rule("/a", "/b", { condition: "isPlatform" }), rule("/b", "/home", { condition: "!isPlatform" })],
    )

    expect(resolved(graph)).toEqual([["/a", null, null]])
    expect(graph.deadNavLinks.map((entry) => entry.path)).toEqual(["/a"])
  })

  it("spots a contradiction inside a joined condition and against a parenthesised negation", () => {
    const joined = redirectGraph(
      ["/a"],
      [rule("/a", "/b", { condition: "isPlatform && hasBilling" }), rule("/b", "/home", { condition: "!isPlatform" })],
    )
    const grouped = redirectGraph(
      ["/a"],
      [rule("/a", "/b", { condition: "a || b" }), rule("/b", "/home", { condition: "!(a || b)" })],
    )

    expect(resolved(joined)).toEqual([["/a", null, null]])
    expect(resolved(grouped)).toEqual([["/a", null, null]])
  })

  it("chains compatible conditional rules and carries every condition on the way", () => {
    const graph = redirectGraph(
      ["/a"],
      [
        rule("/a", "/b", { condition: "isPlatform", declaredAt: "next.config.ts:3" }),
        rule("/b", "/home", { condition: "isPlatform && hasBilling", declaredAt: "next.config.ts:7" }),
      ],
    )

    expect(resolved(graph)).toEqual([
      ["/a", "/home", { from: "/a", to: "/home", declaredAt: "next.config.ts:3", condition: "isPlatform && hasBilling" }],
    ])
  })

  it("falls through to a later conditional rule when the first one leads nowhere, and says which branch", () => {
    const graph = redirectGraph(
      ["/x"],
      [
        rule("/x", "/nowhere", { condition: "isPlatform", declaredAt: "next.config.ts:3" }),
        rule("/x", "/home", { condition: "!isPlatform", declaredAt: "next.config.ts:9" }),
      ],
    )

    expect(resolved(graph)).toEqual([
      ["/x", "/home", { from: "/x", to: "/home", declaredAt: "next.config.ts:9", condition: "!isPlatform" }],
    ])
    expect(graph.deadNavLinks).toEqual([])
  })

  it("keeps the first rule that resolves when both branches lead somewhere, and lists both as alternatives", () => {
    const graph = redirectGraph(
      ["/x"],
      [
        rule("/x", "/home", { condition: "isPlatform", declaredAt: "next.config.ts:3" }),
        rule("/x", "/org/acme/general", { condition: "!isPlatform", declaredAt: "next.config.ts:9" }),
      ],
    )

    expect(resolved(graph)).toEqual([
      [
        "/x",
        "/home",
        {
          from: "/x",
          to: "/home",
          declaredAt: "next.config.ts:3",
          condition: "isPlatform",
          alternatives: [
            { to: "/home", condition: "isPlatform" },
            { to: "/org/acme/general", condition: "!isPlatform" },
          ],
        },
      ],
    ])
  })

  it("records every conditional rule sharing a source as an alternative, in declaration order", () => {
    const graph = redirectGraph(
      ["/settings"],
      [
        rule("/settings", "/org/acme/general", { condition: "authority = SYS_ADMIN" }),
        rule("/settings", "/home", { condition: "authority = TENANT_ADMIN" }),
        rule("/settings", "/nowhere", { condition: "authority = CUSTOMER_USER" }),
      ],
    )

    expect(resolved(graph)).toEqual([
      [
        "/settings",
        "/org/:slug/general",
        {
          from: "/settings",
          to: "/org/acme/general",
          declaredAt: AT,
          condition: "authority = SYS_ADMIN",
          alternatives: [
            { to: "/org/acme/general", condition: "authority = SYS_ADMIN" },
            { to: "/home", condition: "authority = TENANT_ADMIN" },
          ],
        },
      ],
    ])
  })

  it("records no alternatives through an unconditional rule or a single conditional one", () => {
    const unconditional = redirectGraph(["/x"], [rule("/x", "/home"), rule("/x", "/org/acme/general", { condition: "beta" })])
    const single = redirectGraph(["/x"], [rule("/x", "/home", { condition: "beta" }), rule("/x", "/nowhere", { condition: "!beta" })])

    expect(resolved(unconditional)).toEqual([["/x", "/home", { from: "/x", to: "/home", declaredAt: AT }]])
    expect(resolved(single)).toEqual([["/x", "/home", { from: "/x", to: "/home", declaredAt: AT, condition: "beta" }]])
  })

  it("never falls through past a rule that always applies first", () => {
    const unconditional = redirectGraph(["/x"], [rule("/x", "/nowhere"), rule("/x", "/home", { condition: "isPlatform" })])
    const narrower = redirectGraph(
      ["/x"],
      [rule("/x", "/nowhere", { condition: "isPlatform" }), rule("/x", "/home", { condition: "isPlatform && beta" })],
    )

    expect(resolved(unconditional)).toEqual([["/x", null, null]])
    expect(resolved(narrower)).toEqual([["/x", null, null]])
  })

  it("keeps the listed redirects sorted whatever the declaration order", () => {
    const rules = [rule("/z", "/home"), rule("/a/:path*", "/home"), rule("/a/b", "/home")]

    expect(redirectGraph([], rules).redirects.map((redirect) => redirect.from)).toEqual(["/a/:path*", "/a/b", "/z"])
    expect(redirectGraph([], [...rules].reverse()).redirects).toEqual(redirectGraph([], rules).redirects)
  })

  it("lists every rule in redirects with declaredAt and condition only when present", () => {
    const graph = redirectGraph(
      [],
      [rule("/b", "/home", { condition: "!isPlatform", conditional: true }), rule("/a", "/home"), rule("/a", "/home")],
    )

    expect(graph.redirects).toEqual([
      { from: "/a", to: "/home", declaredAt: "next.config.ts:10" },
      { from: "/b", to: "/home", declaredAt: "next.config.ts:10", condition: "!isPlatform", conditional: true },
    ])
    expect(graph.meta.counts["redirects"]).toBe(2)
  })

  it("adds no viaRedirect and no redirects without rules", () => {
    const graph = redirectGraph(["/home"], [])

    expect(graph.redirects).toEqual([])
    expect(Object.keys(graph.navGroups[0]?.entries[0] ?? {})).not.toContain("viaRedirect")
  })
})

describe("hostname folders of a multi-host Next.js app", () => {
  const menuOf = (paths: readonly string[]) => ({
    name: "partnersNav",
    source: "ui/nav.ts#NAV",
    entries: paths.map((path, index) => ({
      path,
      parentPath: null,
      label: path,
      labelKey: null,
      featureFlag: null,
      source: "ui/nav.ts#NAV",
      file: "ui/nav.ts",
      line: index + 1,
    })),
  })

  const hostGraph = (source: string, paths: readonly string[]) =>
    build({
      providers: { ast, facts: factsTable({}) },
      contributions: [
        contribution(source, urlDraft("/partners.acme.com/profile/members")),
        contribution(source, urlDraft("/:domain")),
        contribution(source, urlDraft("/settings")),
        contribution(source, urlDraft("/app.acme.com/settings")),
      ],
      navGroups: [menuOf(paths)],
    })

  const resolvedScreens = (graph: AppGraph) => (graph.navGroups[0]?.entries ?? []).map((entry) => entry.resolvedScreen)

  it("matches a host-relative link to the screen under the hostname folder", () => {
    const graph = hostGraph("next-app", ["/profile/members"])

    expect(resolvedScreens(graph)).toEqual(["/partners.acme.com/profile/members"])
    expect(graph.deadNavLinks).toEqual([])
  })

  it("never lets the alias shadow a screen that owns the same path", () => {
    expect(resolvedScreens(hostGraph("next-app", ["/settings"]))).toEqual(["/settings"])
  })

  it("adds no alias for a path that opens with a param, which would swallow other hosts' links", () => {
    const graph = build({
      providers: { ast, facts: factsTable({}) },
      contributions: [contribution("next-app", urlDraft("/partners.acme.com/:program/:group"))],
      navGroups: [menuOf(["/acme/events"])],
    })

    expect(resolvedScreens(graph)).toEqual([null])
  })

  it("adds no alias for other sources, whose dotted segments are plain literals", () => {
    const graph = hostGraph("react-router", ["/profile/members"])

    expect(resolvedScreens(graph)).toEqual([null])
    expect(graph.deadNavLinks.map((entry) => entry.path)).toEqual(["/profile/members"])
  })
})

describe("SFC splice provider", () => {
  type TemplateTag = { readonly pascal: string; readonly slotName?: string; readonly line: number }

  const templateProvider =
    (templates: Readonly<Record<string, readonly TemplateTag[]>>): NonNullable<GraphProviders["spliceCandidatesOf"]> =>
    ({ file, splice }) => {
      const tags = templates[file]
      if (tags === undefined || splice.kind === "at") return null
      return tags
        .map((tag, index) => ({ ...tag, pos: index * 10 }))
        .filter((tag) => {
          if (splice.kind === "outlet") return tag.pascal === splice.tag
          if (splice.kind === "children") return tag.slotName === "default"
          return tag.slotName === splice.name
        })
        .map(({ pos, line }) => ({ pos, line }))
    }

  const VUE_FACTS = factsTable({
    "src/App.vue": { renders: [edge("src/layouts/Default.vue")] },
    "src/layouts/Default.vue": { renders: [edge("src/ui/Header.vue")] },
    "src/pages/Orders.vue": { renders: [edge("src/ui/OrdersTable.vue")] },
  })

  const VUE_SOURCES = sourcesFrom({
    "src/App.vue": "",
    "src/layouts/Default.vue": "",
    "src/ui/Header.vue": "",
    "src/pages/Orders.vue": "",
  })

  type AncestorRefInput = Pick<AncestorRef, "file" | "splice"> & Partial<Pick<AncestorRef, "exportName">>

  const ordersDraft = (ancestor: AncestorRefInput): ScreenDraft =>
    urlDraft("/orders", {
      entries: [{ kind: "file", file: "src/pages/Orders.vue", exportName: "default" }],
      ancestors: [{ exportName: "default", role: "layout", ...ancestor }],
    })

  const graphFor = (
    ancestor: AncestorRefInput,
    templates: Readonly<Record<string, readonly TemplateTag[]>>,
    overrides: Partial<GraphProviders> = {},
  ): AppGraph =>
    build({
      providers: {
        ast,
        facts: VUE_FACTS,
        sourceOf: VUE_SOURCES,
        spliceCandidatesOf: templateProvider(templates),
        ...overrides,
      },
      contributions: [contribution("test-source", ordersDraft(ancestor))],
    })

  const walkCodes = (graph: AppGraph): readonly string[] =>
    graph.diagnostics.filter((entry) => entry.code.startsWith("walk/")).map((entry) => entry.code)

  it("splices the child at a .vue parent's <RouterView/>", () => {
    const graph = graphFor(
      { file: "src/layouts/Default.vue", splice: { kind: "outlet", tag: "RouterView" } },
      { "src/layouts/Default.vue": [{ pascal: "Header", line: 2 }, { pascal: "RouterView", line: 3 }] },
    )

    expect(shapeOf(screenById(graph, "/orders").tree)).toBe("Default.vue(Header.vue(),Orders.vue(OrdersTable.vue()))")
    expect(walkCodes(graph)).toEqual([])
  })

  it("finds the <router-view> of a layout App.vue renders through the hosted search", () => {
    const graph = graphFor(
      { file: "src/App.vue", splice: { kind: "outlet", tag: "RouterView" } },
      {
        "src/App.vue": [{ pascal: "Default", line: 2 }],
        "src/layouts/Default.vue": [{ pascal: "RouterView", line: 4 }],
      },
    )

    expect(shapeOf(screenById(graph, "/orders").tree)).toBe(
      "App.vue(Default.vue(Header.vue(),Orders.vue(OrdersTable.vue())))",
    )
    expect(walkCodes(graph)).toEqual([])
  })

  it("splices children at a layout's default <slot/>", () => {
    const graph = graphFor(
      { file: "src/layouts/Default.vue", splice: { kind: "children" } },
      { "src/layouts/Default.vue": [{ pascal: "Slot", slotName: "default", line: 5 }] },
    )

    expect(shapeOf(screenById(graph, "/orders").tree)).toBe("Default.vue(Header.vue(),Orders.vue(OrdersTable.vue()))")
    expect(walkCodes(graph)).toEqual([])
  })

  it("splices a named slot only at its <slot name>", () => {
    const named = graphFor(
      { file: "src/layouts/Default.vue", splice: { kind: "slot", name: "aside" } },
      { "src/layouts/Default.vue": [{ pascal: "Slot", slotName: "aside", line: 5 }] },
    )
    const unnamed = graphFor(
      { file: "src/layouts/Default.vue", splice: { kind: "slot", name: "aside" } },
      { "src/layouts/Default.vue": [{ pascal: "Slot", slotName: "default", line: 5 }] },
    )

    expect(walkCodes(named)).toEqual([])
    expect(walkCodes(unnamed)).toEqual(["walk/no-splice-point"])
  })

  it("warns walk/no-splice-point when the template has no outlet, and keeps the layout reachable", () => {
    const graph = graphFor(
      { file: "src/layouts/Default.vue", splice: { kind: "outlet", tag: "RouterView" } },
      { "src/layouts/Default.vue": [{ pascal: "Header", line: 2 }] },
    )
    const warning = graph.diagnostics.find((entry) => entry.code === "walk/no-splice-point")

    expect(warning?.severity).toBe("warning")
    expect(warning?.file).toBe("src/layouts/Default.vue")
    expect(screenById(graph, "/orders").reachable).toContain("src/layouts/Default.vue")
  })

  it("asks the provider with the ancestor's export on the direct path and no export in the hosted search", () => {
    const refs: SpliceRef[] = []
    const provider = templateProvider({
      "src/App.vue": [{ pascal: "Default", line: 2 }],
      "src/layouts/Default.vue": [{ pascal: "RouterView", line: 4 }],
    })
    graphFor(
      { file: "src/App.vue", exportName: "App", splice: { kind: "outlet", tag: "RouterView" } },
      {},
      {
        spliceCandidatesOf: (ref) => {
          refs.push(ref)
          return provider(ref)
        },
      },
    )

    expect(refs.map(({ file, exportName }) => [file, exportName])).toEqual([
      ["src/App.vue", "App"],
      ["src/layouts/Default.vue", null],
    ])
  })

  it("asks the provider for a slot branch with the ancestor's export", () => {
    const refs: SpliceRef[] = []
    const provider = templateProvider({
      "src/layouts/Default.vue": [
        { pascal: "Slot", slotName: "default", line: 3 },
        { pascal: "Slot", slotName: "aside", line: 4 },
      ],
    })
    const graph = build({
      providers: {
        ast,
        facts: VUE_FACTS,
        sourceOf: VUE_SOURCES,
        spliceCandidatesOf: (ref) => {
          refs.push(ref)
          return provider(ref)
        },
      },
      contributions: [
        contribution(
          "test-source",
          urlDraft("/orders", {
            entries: [{ kind: "file", file: "src/pages/Orders.vue", exportName: "default" }],
            ancestors: [
              {
                file: "src/layouts/Default.vue",
                exportName: "default",
                role: "layout",
                splice: { kind: "children" },
                branches: [
                  {
                    file: "src/ui/Aside.vue",
                    exportName: "default",
                    splice: { kind: "slot", name: "aside" },
                    conditions: [],
                  },
                ],
              },
            ],
          }),
        ),
      ],
    })

    expect(walkCodes(graph)).toEqual([])
    expect(refs).toContainEqual({
      file: "src/layouts/Default.vue",
      exportName: "default",
      splice: { kind: "slot", name: "aside" },
    })
  })

  it("places a node-less provided candidate directly under the ancestor, with no wrapper", () => {
    const graph = graphFor(
      { file: "src/layouts/Default.vue", splice: { kind: "outlet", tag: "RouterView" } },
      { "src/layouts/Default.vue": [{ pascal: "Header", line: 2 }, { pascal: "RouterView", line: 3 }] },
    )
    const layout = screenById(graph, "/orders").tree[0]

    expect(layout?.children.map((child) => child.file)).toEqual(["src/ui/Header.vue", "src/pages/Orders.vue"])
    expect(screenById(graph, "/orders").placementAmbiguous).toBeUndefined()
  })

  it("trusts a .vue splice point without a warning when no template could be read", () => {
    const graph = graphFor({ file: "src/layouts/Default.vue", splice: { kind: "outlet", tag: "RouterView" } }, {})

    expect(shapeOf(screenById(graph, "/orders").tree)).toBe("Default.vue(Header.vue(),Orders.vue(OrdersTable.vue()))")
    expect(walkCodes(graph)).toEqual([])
  })

  it("roots a .vue ancestor at its whole file even when several exports name it", () => {
    const layout = (exportName: string): AncestorRef => ({
      file: "src/layouts/Default.vue",
      exportName,
      splice: { kind: "outlet", tag: "RouterView" },
      role: "layout",
    })
    const graph = build({
      providers: {
        ast,
        facts: VUE_FACTS,
        sourceOf: sourcesFrom({
          "src/layouts/Default.vue": "export const First = () => null\nexport const Second = () => null",
        }),
        spliceCandidatesOf: templateProvider({ "src/layouts/Default.vue": [{ pascal: "RouterView", line: 3 }] }),
      },
      contributions: [
        contribution("test-source", urlDraft("/a", { entries: [], ancestors: [layout("First")] })),
        contribution("test-source", urlDraft("/b", { entries: [], ancestors: [layout("Second")] })),
      ],
    })

    expect(screenById(graph, "/a").tree[0]?.component).toBe("Default.vue")
    expect(screenById(graph, "/b").tree[0]?.component).toBe("Default.vue")
  })
})

describe("route names", () => {
  const HOME = "src/pages/Home.tsx"

  const namedGraph = (
    navigations: FileFacts["navigations"],
    named: readonly (readonly [string, string | undefined])[] = [["/users", "users"]],
  ) => {
    const graph = build({
      providers: { ast, facts: factsTable({ [HOME]: { navigations } }) },
      contributions: [
        contribution("test-source", urlDraft("/home", { entries: [{ kind: "file", file: HOME, exportName: "default" }] })),
        ...named.map(([url, routeName]) =>
          contribution("test-source", urlDraft(url, routeName === undefined ? {} : { routeName })),
        ),
      ],
    })
    return { graph, diagnostics: graph.diagnostics }
  }

  const homeEdges = (graph: AppGraph) =>
    screenById(graph, "/home").navigatesTo.map((edge) => [edge.to, edge.matchedRoute, edge.routeName ?? null])

  it("resolves a navigation by route name to the named screen's URL", () => {
    const { graph, diagnostics } = namedGraph([{ to: "", trigger: "navigate", dynamic: false, routeName: "users" }])

    expect(homeEdges(graph)).toEqual([["/users", "/users", "users"]])
    expect(graph.navigation.map((edge) => [edge.from, edge.to])).toEqual([["/home", "/users"]])
    expect(screenById(graph, "/users").routeName).toBe("users")
    expect(diagnostics.filter((entry) => entry.code === "nav/dead-link")).toEqual([])
  })

  it("turns an unknown route name into a name: target and a dead link naming it", () => {
    const { graph, diagnostics } = namedGraph([{ to: "", trigger: "navigate", dynamic: false, routeName: "nope" }])

    expect(homeEdges(graph)).toEqual([["name:nope", null, "nope"]])
    expect(graph.navigation).toEqual([])
    const dead = diagnostics.filter((entry) => entry.code === "nav/dead-link")
    expect(dead).toHaveLength(1)
    expect(dead[0]).toMatchObject({ severity: "warning", file: HOME })
    expect(dead[0]?.message).toContain("'nope'")
    expect(dead[0]?.message).toContain("name:nope")
  })

  it("keeps the first screen by code point for a duplicate name and warns about the other", () => {
    const { graph, diagnostics } = namedGraph(
      [{ to: "", trigger: "navigate", dynamic: false, routeName: "list" }],
      [
        ["/b-list", "list"],
        ["/a-list", "list"],
      ],
    )

    expect(homeEdges(graph)).toEqual([["/a-list", "/a-list", "list"]])
    const dropped = diagnostics.filter((entry) => entry.code === "screens/conflict-dropped")
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toMatchObject({ severity: "warning", screenId: "/b-list" })
    expect(dropped[0]?.message).toContain("'list'")
    expect(dropped[0]?.message).toContain("'/a-list'")
  })

  it("merges a URL navigation and a name navigation to the same screen into one edge", () => {
    const { graph } = namedGraph([
      { to: "/users", trigger: "navigate", dynamic: false },
      { to: "", trigger: "navigate", dynamic: false, routeName: "users" },
    ])

    expect(homeEdges(graph)).toEqual([["/users", "/users", "users"]])
    expect(graph.navigation).toHaveLength(1)
  })

  it("prefers to over routeName when both are present and keeps the name", () => {
    const { graph, diagnostics } = namedGraph(
      [{ to: "/users", trigger: "link", dynamic: false, routeName: "missing" }],
      [["/users", undefined]],
    )

    expect(homeEdges(graph)).toEqual([["/users", "/users", "missing"]])
    expect(diagnostics.filter((entry) => entry.code === "nav/dead-link")).toEqual([])
  })

  it("resolves a route name alias to its screen and keeps duplicate-name semantics for aliases", () => {
    const graph = build({
      providers: {
        ast,
        facts: factsTable({
          [HOME]: {
            navigations: [
              { to: "", trigger: "navigate", dynamic: false, routeName: "people" },
              { to: "", trigger: "navigate", dynamic: false, routeName: "list" },
            ],
          },
        }),
      },
      contributions: [
        contribution("test-source", urlDraft("/home", { entries: [{ kind: "file", file: HOME, exportName: "default" }] })),
        contribution("test-source", urlDraft("/users", { routeName: "users", routeNameAliases: ["list", "people"] })),
        contribution("test-source", urlDraft("/a-list", { routeName: "list" })),
      ],
    })

    expect(homeEdges(graph)).toEqual([
      ["/a-list", "/a-list", "list"],
      ["/users", "/users", "people"],
    ])
    expect(graph.screens.flatMap((screen) => Object.keys(screen))).not.toContain("routeNameAliases")
    const dropped = graph.diagnostics.filter((entry) => entry.code === "screens/conflict-dropped")
    expect(dropped.map((entry) => entry.message)).toEqual([expect.stringContaining("route name 'list' of screen '/users'")])
  })

  it("adds no routeName key to screens or navigations that carry none", () => {
    const { graph } = namedGraph([{ to: "/users", trigger: "link", dynamic: false }], [["/users", undefined]])

    expect(graph.screens.flatMap((screen) => Object.keys(screen))).not.toContain("routeName")
    expect(screenById(graph, "/home").navigatesTo.flatMap((edge) => Object.keys(edge))).not.toContain("routeName")
  })

  it("merges routeName across contributions of one screen", () => {
    const diagnostics = createDiagnosticCollector()
    const [merged] = resolveScreenConflicts(
      [contribution("a", urlDraft("/users")), contribution("b", urlDraft("/users", { routeName: "users" }))],
      "merge",
      diagnostics,
    )

    expect(merged?.routeName).toBe("users")
  })
})

describe("route activation identity", () => {
  const routeActivation = (name: string, navigator: string | null = "RootStack") =>
    ({ kind: "route", name, navigator }) as const

  it("sorts a route activation after an intercept activation", () => {
    const [merged] = resolveScreenConflicts(
      [
        contribution(
          "test-source",
          draft({
            localId: "photo",
            activations: [
              routeActivation("Photo"),
              { kind: "intercept", from: "/feed", slot: "modal", file: "src/app/@modal/(.)photo/page.tsx" },
              { kind: "url", template: "/photo/:id", params: ["id"] },
            ],
          }),
        ),
      ],
      "merge",
      createDiagnosticCollector(),
    )

    expect(merged?.activations.map((activation) => activation.kind)).toEqual(["url", "intercept", "route"])
  })

  it("gives a name-only draft the id of its first route name by code point", () => {
    const [merged] = resolveScreenConflicts(
      [
        contribution(
          "react-navigation",
          draft({
            localId: "src/Navigation.tsx#route:Profile",
            activations: [routeActivation("Profile", "HomeTab"), routeActivation("Profile", "SearchTab")],
          }),
        ),
      ],
      "merge",
      createDiagnosticCollector(),
    )

    expect(merged?.id).toBe("screen://react-navigation/Profile")
  })

  it("keeps the URL id for a draft with url and route activations", () => {
    const [merged] = resolveScreenConflicts(
      [
        contribution(
          "react-navigation",
          urlDraft("/profile/:id", {
            localId: "src/Navigation.tsx#route:Profile",
            activations: [{ kind: "url", template: "/profile/:id", params: ["id"] }, routeActivation("Profile")],
          }),
        ),
      ],
      "merge",
      createDiagnosticCollector(),
    )

    expect(merged?.id).toBe("/profile/:id")
  })

  it("keeps the localId-based id for a draft with neither url nor route activations", () => {
    const [merged] = resolveScreenConflicts(
      [contribution("state-screens", draft({ localId: "src/Popup.tsx#0", activations: [{ kind: "state", holder: "Popup", expr: "open" }] }))],
      "merge",
      createDiagnosticCollector(),
    )

    expect(merged?.id).toBe(`screen://state-screens/${encodeURIComponent("src/Popup.tsx#0")}`)
  })
})

describe("route activation names and multi-URL matching", () => {
  const HOME = "src/pages/Home.tsx"
  const homeEntry = { entries: [{ kind: "file", file: HOME, exportName: "default" }] } as const
  const routeActivation = (name: string, navigator: string | null = "RootStack") =>
    ({ kind: "route", name, navigator }) as const

  const graphWith = (navigations: FileFacts["navigations"], drafts: readonly ScreenDraft[]) =>
    build({
      providers: { ast, facts: factsTable({ [HOME]: { navigations } }) },
      contributions: [
        contribution("test-source", urlDraft("/home", homeEntry)),
        ...drafts.map((value) => contribution("test-source", value)),
      ],
    })

  const homeEdges = (graph: AppGraph) =>
    screenById(graph, "/home").navigatesTo.map((edge) => [edge.to, edge.matchedRoute, edge.routeName ?? null])

  const codesOf = (graph: AppGraph, code: string) => graph.diagnostics.filter((entry) => entry.code === code)

  const PROFILE_ID = "screen://test-source/Profile"

  it("resolves a name through a route activation of a URL-less screen", () => {
    const graph = graphWith(
      [{ to: "", trigger: "navigate", dynamic: false, routeName: "Profile" }],
      [draft({ localId: "src/Navigation.tsx#route:Profile", activations: [routeActivation("Profile")] })],
    )

    expect(homeEdges(graph)).toEqual([[PROFILE_ID, PROFILE_ID, "Profile"]])
    expect(codesOf(graph, "nav/dead-link")).toEqual([])
  })

  it("registers a draft named in two navigators once, without a conflict", () => {
    const graph = graphWith(
      [{ to: "", trigger: "navigate", dynamic: false, routeName: "Profile" }],
      [
        draft({
          localId: "src/Navigation.tsx#route:Profile",
          activations: [routeActivation("Profile", "HomeTab"), routeActivation("Profile", "SearchTab")],
        }),
      ],
    )

    expect(homeEdges(graph)).toEqual([[PROFILE_ID, PROFILE_ID, "Profile"]])
    expect(codesOf(graph, "screens/conflict-dropped")).toEqual([])
  })

  it("keeps the dead link for a name no route activation declares", () => {
    const graph = graphWith(
      [{ to: "", trigger: "navigate", dynamic: false, routeName: "Unknown" }],
      [draft({ localId: "src/Navigation.tsx#route:Profile", activations: [routeActivation("Profile")] })],
    )

    expect(homeEdges(graph)).toEqual([["name:Unknown", null, "Unknown"]])
    expect(graph.navigation).toEqual([])
    expect(codesOf(graph, "nav/dead-link")).toHaveLength(1)
  })

  it("resolves an Expo group-qualified name before its to", () => {
    const graph = graphWith(
      [{ to: "/seerr/page", trigger: "push", dynamic: false, routeName: "(auth)/(tabs)/(search)/seerr/page" }],
      [
        urlDraft("/seerr/page", {
          localId: "app/(auth)/(tabs)/(search)/seerr/page.tsx",
          activations: [
            { kind: "url", template: "/seerr/page", params: [] },
            routeActivation("(auth)/(tabs)/(search)/seerr/page", null),
          ],
        }),
        urlDraft("/seerr/:id", { localId: "app/(auth)/(tabs)/(home)/seerr/[id].tsx" }),
      ],
    )

    expect(homeEdges(graph)).toEqual([["/seerr/page", "/seerr/page", "(auth)/(tabs)/(search)/seerr/page"]])
  })

  it("prefers the resolving name over a to that matches another screen", () => {
    const graph = graphWith(
      [{ to: "/other", trigger: "push", dynamic: false, routeName: "(tabs)/index" }],
      [
        urlDraft("/", {
          localId: "app/(tabs)/index.tsx",
          activations: [{ kind: "url", template: "/", params: [] }, routeActivation("(tabs)/index", null)],
        }),
        urlDraft("/other"),
      ],
    )

    expect(homeEdges(graph)).toEqual([["/", "/", "(tabs)/index"]])
  })

  it("resolves a secondary url activation to the screen's primary id", () => {
    const graph = graphWith(
      [{ to: "/download", trigger: "link", dynamic: false }],
      [
        urlDraft("/", {
          localId: "app/index.tsx",
          activations: [
            { kind: "url", template: "/", params: [] },
            { kind: "url", template: "/download", params: [] },
          ],
        }),
      ],
    )

    expect(homeEdges(graph)).toEqual([["/download", "/", null]])
    expect(graph.navigation.map((edge) => [edge.from, edge.to])).toEqual([["/home", "/"]])
  })

  it("lets a screen's primary url win over another screen's secondary url", () => {
    const graph = graphWith(
      [{ to: "/download", trigger: "link", dynamic: false }],
      [
        urlDraft("/", {
          localId: "app/index.tsx",
          activations: [
            { kind: "url", template: "/", params: [] },
            { kind: "url", template: "/download", params: [] },
          ],
        }),
        urlDraft("/download"),
      ],
    )

    expect(homeEdges(graph)).toEqual([["/download", "/download", null]])
  })

  it("drops an ambiguous route-activation name from the later draft by id", () => {
    const graph = graphWith(
      [{ to: "", trigger: "navigate", dynamic: false, routeName: "Details" }],
      [
        draft({ localId: "src/b.tsx#route:Details", activations: [routeActivation("Details"), routeActivation("B")] }),
        draft({ localId: "src/a.tsx#route:Details", activations: [routeActivation("A"), routeActivation("Details")] }),
      ],
    )

    const winner = "screen://test-source/A"
    expect(homeEdges(graph)).toEqual([[winner, winner, "Details"]])
    const dropped = codesOf(graph, "screens/conflict-dropped")
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toMatchObject({ severity: "warning", screenId: "screen://test-source/B" })
    expect(dropped[0]?.message).toContain("'Details'")
  })

  it("resolves a raw group-qualified to through the route name that holds its groups", () => {
    const graph = graphWith(
      [{ to: "/(auth)/settings", trigger: "navigate", dynamic: false }],
      [
        urlDraft("/settings", {
          localId: "app/(auth)/(tabs)/(home)/settings.tsx",
          activations: [
            { kind: "url", template: "/settings", params: [] },
            routeActivation("(auth)/(tabs)/(home)/settings", null),
          ],
        }),
      ],
    )

    expect(homeEdges(graph)).toEqual([["/settings", "/settings", null]])
  })

  it("prefers the screen whose route name holds the href's groups over the URL owner", () => {
    const graph = graphWith(
      [{ to: "/(b)/x", trigger: "navigate", dynamic: false }],
      [
        urlDraft("/x", {
          localId: "app/(a)/x.tsx",
          activations: [{ kind: "url", template: "/x", params: [] }, routeActivation("(a)/x", null)],
        }),
        {
          localId: "app/(b)/(c)/x.tsx",
          activations: [routeActivation("(b)/(c)/x", null)],
          entries: [{ kind: "file", file: "/repo/app/(b)/(c)/x.tsx", exportName: "default" }],
          evidence: [],
        },
      ],
    )

    const loser = "screen://test-source/(b)%2F(c)%2Fx"
    expect(homeEdges(graph)).toEqual([[loser, loser, null]])
  })

  it("leaves a group-like segment alone in a project without group-qualified route names", () => {
    const graph = graphWith(
      [{ to: "/bar/(beta)", trigger: "navigate", dynamic: false }],
      [urlDraft("/bar", { localId: "src/Bar.tsx" })],
    )

    expect(homeEdges(graph)).toEqual([["/bar/(beta)", null, null]])
  })

  it("resolves a raw group-qualified to that ends on a group through its index route name", () => {
    const graph = graphWith(
      [{ to: "/(auth)/(tabs)/(home)", trigger: "replace", dynamic: false }],
      [
        urlDraft("/", {
          localId: "app/(auth)/(tabs)/(home)/index.tsx",
          activations: [
            { kind: "url", template: "/", params: [] },
            routeActivation("(auth)/(tabs)/(home)/index", null),
          ],
        }),
      ],
    )

    expect(homeEdges(graph)).toEqual([["/", "/", null]])
  })

  it("keeps an unresolvable group-qualified to unchanged", () => {
    const graph = graphWith([{ to: "/(auth)/nowhere", trigger: "navigate", dynamic: false }], [])

    expect(homeEdges(graph)).toEqual([["/(auth)/nowhere", null, null]])
  })
})
