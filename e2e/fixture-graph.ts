import type {
  Activation,
  AppGraph,
  Diagnostic,
  Endpoint,
  FileFacts,
  NavEntry,
  Navigation,
  NavigationEdge,
  RenderEdge,
  ResolvedNavigation,
  Screen,
  ScreenFacts,
  ScreenId,
  SectionConfidence,
  TreeNode,
} from "../src/core/model.js"

export const FIXTURE_APP_NAME = "fixture-shop"
export const SCREEN_COUNT = 60
export const COMPONENT_COUNT = 700
export const HEAVY_ENDPOINT_SCREEN_ID = "screen-admin-07"
export const HEAVY_ENDPOINT_COUNT = 160
export const DEEP_LINK_SCREEN_ID = "screen-app-03"
export const API_SCREEN_IDS = ["api-health", "api-orders", "api-users"] as const
export const REDIRECT_SCREEN_ID = "screen-legacy-redirect"
export const STATE_SCREEN_ID = "screen-state-wizard"
export const FEATURE_FLAG_SCREEN_ID = "screen-app-05"
export const DEV_ONLY_SCREEN_ID = "screen-settings-04"
export const FEATURE_FLAG_NAME = "newCheckout"
export const MISSING_NAV_PATH = "/app/missing-from-router"
export const TOP_RENDERED_COMPONENT = "Component000"
export const LOW_RANK_COMPONENT = "ComponentTail699"
export const LOW_RANK_COMPONENT_MIN_RANK = 400

const GROUPS = [
  { prefix: "", name: "root", count: 6 },
  { prefix: "/admin", name: "admin", count: 18 },
  { prefix: "/app", name: "app", count: 20 },
  { prefix: "/settings", name: "settings", count: 12 },
] as const

const pad = (n: number, width = 2) => String(n).padStart(width, "0")
const SOURCE = "react-router"
const authAt = (i: number) => (["protected", "public", "unknown"] as const)[i % 3]!

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

const endpointAt = (screen: number, i: number): Endpoint =>
  i % 4 === 3
    ? { method: "query", url: `rpc.screen${screen}.op${i}`, transport: "rpc", client: "trpc" }
    : {
        method: (["GET", "POST", "PUT", "DELETE"] as const)[i % 4]!,
        url: `/api/s${pad(screen)}/res${i}`,
        transport: "http",
        client: "fetch",
      }

const endpointsFor = (screen: number, id: string): readonly Endpoint[] => {
  const count = id === HEAVY_ENDPOINT_SCREEN_ID ? HEAVY_ENDPOINT_COUNT : 2 + (screen % 5)
  return Array.from({ length: count }, (_, i) => endpointAt(screen, i))
}

const componentName = (i: number) => (i === COMPONENT_COUNT - 1 ? `ComponentTail${i}` : `Component${pad(i, 3)}`)
const componentFile = (i: number) => `src/components/${componentName(i)}.tsx`

const leaf = (i: number, overrides: Partial<TreeNode> = {}): TreeNode => ({
  file: componentFile(i),
  component: componentName(i),
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

const treeFor = (screen: number, file: string, name: string): readonly TreeNode[] => {
  const base = (screen * 7) % (COMPONENT_COUNT - 20)
  const grandchild = leaf(base + 3, { conditions: ["isLoaded"], alwaysRendered: false })
  const child = leaf(base + 1, {
    repeated: screen % 2 === 0,
    nullGuards: ["data"],
    children: [grandchild, leaf(base + 4, { repeated: true, repeat: screen % 5 === 0 })],
  })
  const second = leaf(base + 2, {
    conditions: ["user.isAdmin", "flags.enabled"],
    alwaysRendered: false,
    children: [leaf(base + 5, { truncated: screen % 6 === 0 })],
  })
  return [
    {
      file,
      component: name,
      kind: "screen",
      conditions: [],
      alwaysRendered: true,
      repeated: false,
      nullGuards: [],
      children: [
        child,
        second,
        leaf(base + 6, { conditions: ["isMobile"], via: "lazy" }),
        leaf(base + 7, { via: "reference" }),
      ],
      truncated: false,
      repeat: false,
    },
  ]
}

type ScreenSpec = {
  readonly id: ScreenId
  readonly url: string | null
  readonly activation: Activation
  readonly kindTag: string | null
  readonly auth: Screen["auth"]
  readonly title: string
  readonly extra: Partial<Screen>
}

const urlSpec = (id: string, url: string, index: number, extra: Partial<Screen> = {}): ScreenSpec => ({
  id,
  url,
  activation: { kind: "url", template: url, params: url.includes(":") ? ["id"] : [] },
  kindTag: null,
  auth: authAt(index),
  title: `Screen ${id}`,
  extra,
})

const groupedSpecs = (): readonly ScreenSpec[] =>
  GROUPS.flatMap(({ prefix, name, count }, groupIndex) =>
    Array.from({ length: count }, (_, i) => {
      const id = `screen-${name}-${pad(i)}`
      const isRoot = prefix === "" && i === 0
      const dynamic = i % 4 === 1 && !isRoot
      const url = isRoot ? "/" : `${prefix}/page-${pad(i)}${dynamic ? "/:id" : ""}`
      const extra: Partial<Screen> = {
        ...(id === FEATURE_FLAG_SCREEN_ID ? { featureFlag: FEATURE_FLAG_NAME } : {}),
        ...(id === DEV_ONLY_SCREEN_ID ? { devOnly: true } : {}),
      }
      return urlSpec(id, url, groupIndex * 20 + i, extra)
    }),
  )

const apiSpecs = (): readonly ScreenSpec[] =>
  API_SCREEN_IDS.map((id, i) => ({
    ...urlSpec(id, `/api/${id.slice(4)}`, i),
    kindTag: "apiRoute",
    title: `API ${id.slice(4)}`,
  }))

const specialSpecs = (): readonly ScreenSpec[] => [
  urlSpec(REDIRECT_SCREEN_ID, "/legacy", 1, { redirectTo: "/app/page-00" }),
  {
    id: STATE_SCREEN_ID,
    url: null,
    activation: { kind: "state", holder: "WizardHolder", expr: "step === 2" },
    kindTag: null,
    auth: "unknown",
    title: "Wizard step",
    extra: { addressable: false },
  },
]

const navigationsFor = (screen: number, count: number): readonly Navigation[] =>
  Array.from({ length: count }, (_, i) => ({
    to: i % 5 === 4 ? `/app/page-${pad((screen + i) % 20)}/${i}` : `${GROUPS[(screen + i) % 4]!.prefix}/page-${pad((screen + i) % 6)}`,
    trigger: (["navigate", "link", "redirect"] as const)[i % 3]!,
    dynamic: i % 5 === 4,
  }))

const buildScreens = (specs: readonly ScreenSpec[]): readonly Screen[] =>
  specs.map((spec, index) => {
    const componentFileName = `src/screens/${spec.id}.tsx`
    const componentLabel = `Screen${pad(index)}`
    const isApi = spec.kindTag === "apiRoute"
    const navs = navigationsFor(index, 5)
    const resolved: readonly ResolvedNavigation[] = navs.map((n, i) => ({
      ...n,
      from: spec.id,
      matchedRoute: n.dynamic ? null : specs[(index + i + 1) % specs.length]!.id,
    }))
    const endpoints = endpointsFor(index, spec.id)
    return {
      id: spec.id,
      localId: spec.id,
      source: SOURCE,
      activations: [spec.activation],
      url: spec.url,
      params: spec.activation.kind === "url" ? spec.activation.params : [],
      title: spec.title,
      kindTag: spec.kindTag,
      entries: [{ kind: "file", file: componentFileName, exportName: componentLabel }],
      ancestors: [],
      shell: isApi ? null : "AppShell",
      auth: spec.auth,
      featureFlag: null,
      redirectTo: null,
      devOnly: false,
      addressable: true,
      tree: isApi ? [] : treeFor(index, componentFileName, componentLabel),
      reachable: [componentFileName, componentFile(index % COMPONENT_COUNT)],
      facts: {
        ...emptyFacts,
        endpoints,
        navigations: navs,
        stores: index % 3 === 0 ? ["useCartStore"] : [],
        queryKeys: [`screen-${index}`],
        hooks: ["useAuth"],
        testIds: [`screen-${index}-root`],
        featureGates: index % 7 === 0 ? [FEATURE_FLAG_NAME] : [],
      },
      navigatesTo: resolved,
      provenance: {
        sources: [SOURCE],
        evidence: [{ what: "route", file: "src/routes.tsx", line: 10 + index }],
        mergedFrom: [],
        decisions: [],
      },
      ...spec.extra,
    }
  })

const renderEdges = (i: number): readonly RenderEdge[] => {
  if (i === COMPONENT_COUNT - 1) return []
  const targets = i % 3 === 0 && i + 2 < COMPONENT_COUNT ? [i + 1, i + 2] : [i + 1]
  return targets.map((target, k) => ({
    file: componentFile(target),
    conditions: k === 1 ? ["flag"] : [],
    alwaysRendered: k === 0,
    repeated: i % 4 === 0,
  }))
}

const buildComponents = (): Readonly<Record<string, FileFacts>> =>
  Object.fromEntries(
    Array.from({ length: COMPONENT_COUNT }, (_, i): [string, FileFacts] => [
      componentFile(i),
      {
        file: componentFile(i),
        component: componentName(i),
        kind: i % 10 === 0 ? "shared" : "ui",
        renders: renderEdges(i),
        nullGuards: i % 9 === 0 ? ["props.value"] : [],
        uses: i % 11 === 0 ? [componentFile((i + 5) % COMPONENT_COUNT)] : [],
        hooks: i % 6 === 0 ? ["useMemo"] : [],
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
    ]),
  )

const buildNavigation = (screens: readonly Screen[]): readonly NavigationEdge[] =>
  screens.flatMap((s) => s.navigatesTo.map((n) => ({ from: s.id, to: n.to, trigger: n.trigger, dynamic: n.dynamic, via: `src/screens/${s.id}.tsx` })))

const navEntry = (path: string, i: number, resolvedScreen: ScreenId | null): NavEntry => ({
  path,
  parentPath: i % 4 === 3 ? "/app/page-00" : null,
  label: `Link ${i}`,
  labelKey: null,
  featureFlag: null,
  source: "nav-config",
  file: "src/nav.ts",
  line: 5 + i,
  resolvedScreen,
})

const deadEntries: readonly NavEntry[] = [navEntry("/gone/one", 90, null), navEntry("/gone/two", 91, null)]

const buildNavGroups = (screens: readonly Screen[]): AppGraph["navGroups"] => [
  {
    name: "Main menu",
    source: "nav-config",
    score: 9,
    availableOnShells: ["AppShell"],
    entries: [
      ...screens.filter((s) => s.id.startsWith("screen-app-")).slice(0, 8).map((s, i) => navEntry(s.url ?? "/", i, s.id)),
      navEntry(MISSING_NAV_PATH, 20, null),
    ],
  },
  {
    name: "Admin menu",
    source: "nav-config",
    score: 6,
    availableOnShells: ["AppShell"],
    entries: screens.filter((s) => s.id.startsWith("screen-admin-")).slice(0, 5).map((s, i) => navEntry(s.url ?? "/", 30 + i, s.id)),
  },
]

const diagnostics: readonly Diagnostic[] = [
  { severity: "error", code: "E_PARSE", message: "Failed to parse route file", plugin: "react-router", file: "src/routes.tsx", line: 12 },
  { severity: "warning", code: "W_DYNAMIC", message: "Dynamic navigation target not resolved", plugin: null, screenId: DEEP_LINK_SCREEN_ID },
  { severity: "warning", code: "W_UNUSED", message: "Unused nav entry", plugin: "nav-config", file: "src/nav.ts", line: 40 },
  { severity: "info", code: "I_SCAN", message: "Scanned 700 components", plugin: null },
]

const confidence: readonly SectionConfidence[] = [
  { section: "screens", count: SCREEN_COUNT, enablingDependency: "react-router-dom", dependencyInstalled: true, level: "high" },
  { section: "endpoints", count: 400, enablingDependency: "axios", dependencyInstalled: true, level: "high" },
  { section: "nav", count: 2, enablingDependency: null, dependencyInstalled: false, level: "low" },
  { section: "stores", count: 0, enablingDependency: "zustand", dependencyInstalled: false, level: "suspect" },
]

export const buildFixtureGraph = (): AppGraph => {
  const screens = buildScreens([...groupedSpecs(), ...apiSpecs(), ...specialSpecs()])
  const orphanScreens = screens.filter((_, i) => i % 15 === 7).map((s) => s.id)
  return {
    meta: {
      schemaVersion: 2,
      appgraphVersion: "0.0.0-e2e",
      root: "fixture-shop",
      appName: FIXTURE_APP_NAME,
      sourceRoots: ["src"],
      screenSources: [SOURCE],
      maxDepth: 3,
      fingerprint: "e2e-fixture",
      counts: { screens: screens.length, components: COMPONENT_COUNT },
      confidence,
      limitations: ["Dynamic imports are not followed", "Runtime-generated routes are not detected", "Server-rendered screens are out of scope"],
    },
    screens,
    redirects: [{ from: "/legacy", to: "/app/page-00" }],
    shells: {},
    components: buildComponents(),
    navGroups: buildNavGroups(screens),
    navigation: buildNavigation(screens),
    deadNavLinks: deadEntries,
    orphanScreens,
    diagnostics,
  }
}
