import { describe, expect, it } from "vitest"
import type { MenuSpec, NavGroup } from "../../src/core/model.js"
import { NAV_CANDIDATE_MIN_SCORE } from "../../src/core/graph.js"
import { createNavAdapter, NAV_AUTO_SCAN_LIMITS } from "../../src/adapters/nav-config.js"
import { createReactRouterAdapter } from "../../src/adapters/react-router.js"
import type { PipelineResult } from "../../src/pipeline/run.js"
import { by, sortStrings } from "../../src/core/order.js"
import { run } from "../pipeline/harness.js"

/**
 * Every shape below is a SYNTHETIC reproduction of a real-world menu config shape. Nothing here reads a real repository: the injectable memory host is the whole world.
 */

const PATHS = `export enum Paths {
  HOME = '/',
  INVOICES = '/invoices',
  CUSTOMERS = '/customers',
  ANALYTICS = '/analytics',
  ANALYTICS_REVENUE = '/analytics/revenue',
}
`

const router = (paths: readonly string[]): string => `import { createBrowserRouter } from 'react-router-dom'

export const router = createBrowserRouter([
${paths.map((path) => `  { path: '${path}', element: <div /> },`).join("\n")}
])
`

const ROUTED = ["/", "/invoices", "/customers", "/analytics", "/analytics/revenue"] as const

const ROUTED_SORTED = sortStrings(ROUTED)

const analyze = (
  files: Readonly<Record<string, string>>,
  menus?: readonly MenuSpec[],
): PipelineResult =>
  run({
    files: { "src/shared/paths.ts": PATHS, "src/routes/router.tsx": router(ROUTED), ...files },
    adapters: [
      createReactRouterAdapter(),
      createNavAdapter(menus === undefined ? {} : { menus }),
    ],
  })

const groupsOf = (result: PipelineResult): readonly NavGroup[] => result.graph.navGroups

/** The kernel sorts a group's entries canonically, so every path assertion compares SETS. */
const pathsOf = (result: PipelineResult): readonly string[] =>
  sortStrings(result.graph.navGroups.flatMap((group) => group.entries.map((entry) => entry.path)))

const groupNamed = (result: PipelineResult, name: string): NavGroup | undefined =>
  result.graph.navGroups.find((group) => group.name === name)

const codesOf = (result: PipelineResult): readonly string[] =>
  result.diagnostics.map((diagnostic) => diagnostic.code)

// ---------------------------------------------------------------------------
// Shape 1 — a web `frontend`: an array, `satisfies Route[]`, path/title/menuLabel/featureFlag/parentPath
// ---------------------------------------------------------------------------

const SATISFIES_ARRAY_NAV = `import { Paths } from '@/shared/paths'

type Route = { path: string; title: string }

export const navigationRoutes = [
  { path: Paths.HOME, title: 'Home', icon: 'home', menuLabel: 'menu.home' },
  { path: Paths.INVOICES, title: 'Invoices', featureFlag: 'invoices', icon: 'bill', menuLabel: 'menu.invoices' },
  { path: Paths.CUSTOMERS, title: 'Customers', icon: 'user', menuLabel: 'menu.customers' },
  { path: Paths.ANALYTICS, title: 'Analytics', icon: 'pie', menuLabel: 'menu.analytics' },
  {
    path: Paths.ANALYTICS_REVENUE,
    parentPath: Paths.ANALYTICS,
    title: 'Dashboard',
    featureFlag: 'analytics_revenue',
    icon: 'bar',
    menuLabel: 'menu.analyticsRevenue',
  },
] satisfies Route[]
`

const SATISFIES_ARRAY_NAV_SPEC: MenuSpec = {
  file: "src/config.tsx",
  export: "navigationRoutes",
  fields: { target: "path", title: "title", labelKey: "menuLabel", flag: "featureFlag", parent: "parentPath" },
}

describe("shape 1 — an array of object literals behind `satisfies`, with a path enum", () => {
  const result = analyze({ "src/config.tsx": SATISFIES_ARRAY_NAV }, [SATISFIES_ARRAY_NAV_SPEC])

  it("reads every entry through the enum the paths are declared in", () => {
    expect(pathsOf(result)).toEqual(ROUTED_SORTED)
  })

  it("names the group by its file and export, so the menu attaches to a shell", () => {
    expect(groupsOf(result).map((group) => group.source)).toEqual(["src/config.tsx#navigationRoutes"])
  })

  it("keeps the human title and the i18n key in separate fields", () => {
    const entry = groupsOf(result)[0]?.entries.find((candidate) => candidate.path === "/invoices")
    expect({ label: entry?.label, labelKey: entry?.labelKey, flag: entry?.featureFlag }).toEqual({
      label: "Invoices",
      labelKey: "menu.invoices",
      flag: "invoices",
    })
  })

  it("carries parentPath through the same enum fold", () => {
    const entry = groupsOf(result)[0]?.entries.find((candidate) => candidate.path === "/analytics/revenue")
    expect(entry?.parentPath).toBe("/analytics")
  })

  it("resolves every entry, so the group scores 1", () => {
    expect(groupsOf(result)[0]?.score).toBe(1)
    expect(result.graph.deadNavLinks).toEqual([])
  })

  it("finds the same menu with NO config at all, by scoring", () => {
    const auto = analyze({ "src/config.tsx": SATISFIES_ARRAY_NAV })
    expect(pathsOf(auto)).toEqual(ROUTED_SORTED)
    expect(groupsOf(auto).map((group) => [group.name, group.score])).toEqual([["navigationRoutes", 1]])
  })
})

// ---------------------------------------------------------------------------
// Shape 2 — a GROUPED menu, path/label/icon
// ---------------------------------------------------------------------------

const GROUPED = `export const routeGroups = [
  {
    label: 'Main',
    items: [
      { path: '/', label: 'Home', icon: 'home' },
      { path: '/invoices', label: 'Invoices', icon: 'bill' },
    ],
  },
  {
    label: 'Insights',
    items: [
      { path: '/analytics', label: 'Analytics', icon: 'pie' },
      { path: '/analytics/revenue', label: 'Dashboard', icon: 'bar' },
    ],
  },
]
`

describe("shape 2 — a grouped config, discovered without configuration", () => {
  const result = analyze({ "src/app/Sidebar.tsx": GROUPED })

  it("emits one group per section, labelled by the container", () => {
    expect(groupsOf(result).map((group) => group.name)).toEqual(["Insights", "Main"])
  })

  it("keeps every item under its own section", () => {
    expect(sortStrings(groupNamed(result, "Main")?.entries.map((entry) => entry.path) ?? [])).toEqual([
      "/",
      "/invoices",
    ])
    expect(sortStrings(groupNamed(result, "Insights")?.entries.map((entry) => entry.path) ?? [])).toEqual([
      "/analytics",
      "/analytics/revenue",
    ])
  })

  it("labels items from `label` when there is no `title`", () => {
    expect(sortStrings(groupNamed(result, "Main")?.entries.map((entry) => entry.label ?? "") ?? [])).toEqual([
      "Home",
      "Invoices",
    ])
  })
})

// ---------------------------------------------------------------------------
// Shape 3 — an `admin` panel: a flat array grouped by `groupKey`, to/labelKey/icon/search
// ---------------------------------------------------------------------------

const GROUP_KEYED = `export const MENU_SECTIONS = [
  { to: '/', labelKey: 'nav.home', icon: 'home', groupKey: 'operations', search: {} },
  { to: '/invoices', labelKey: 'nav.invoices', icon: 'bill', groupKey: 'operations' },
  { to: '/analytics', labelKey: 'nav.analytics', icon: 'pie', groupKey: 'insights' },
] as const
`

describe("shape 3 — `to` targets, i18n-key labels and a group key, behind `as const`", () => {
  const result = analyze({ "src/components/layout/sidebar.tsx": GROUP_KEYED }, [
    {
      file: "src/components/layout/sidebar.tsx",
      export: "MENU_SECTIONS",
      fields: { target: "to", labelKey: "labelKey", group: "groupKey" },
    },
  ])

  it("splits the flat array into one group per group key", () => {
    expect(groupsOf(result).map((group) => group.name)).toEqual(["insights", "operations"])
  })

  it("records the i18n key as a KEY, never as a label", () => {
    const entries = [...(groupNamed(result, "operations")?.entries ?? [])].sort(by((entry) => entry.path))
    expect(entries.map((entry) => [entry.path, entry.label, entry.labelKey])).toEqual([
      ["/", null, "nav.home"],
      ["/invoices", null, "nav.invoices"],
    ])
  })

  it("is found by auto-discovery too, as one group per key", () => {
    const auto = analyze({ "src/components/layout/sidebar.tsx": GROUP_KEYED })
    expect(pathsOf(auto)).toEqual(["/", "/analytics", "/invoices"])
  })
})

// ---------------------------------------------------------------------------
// Shape 4 — `admin`: a RECORD whose KEY is the target
// ---------------------------------------------------------------------------

const RECORD = `export const navigation = {
  invoices: { name: 'Invoices', icon: 'bill' },
  customers: { name: 'Customers', icon: 'user' },
}
`

describe("shape 4 — a record keyed by the target", () => {
  const result = run({
    files: {
      "src/routes/router.tsx": router(["/admin/resources/invoices", "/admin/resources/customers"]),
      "src/admin/utils/navigation.ts": RECORD,
    },
    adapters: [
      createReactRouterAdapter(),
      createNavAdapter({
        menus: [
          {
            file: "src/admin/utils/navigation.ts",
            export: "navigation",
            basePath: "/admin/resources",
            fields: { label: "name", icon: "icon" },
          },
        ],
      }),
    ],
  })

  it("takes the property key as the target and joins the base path", () => {
    expect(pathsOf(result)).toEqual(["/admin/resources/customers", "/admin/resources/invoices"])
  })

  it("labels each entry from the mapped field", () => {
    expect(sortStrings(groupsOf(result)[0]?.entries.map((entry) => entry.label ?? "") ?? [])).toEqual([
      "Customers",
      "Invoices",
    ])
  })
})

// ---------------------------------------------------------------------------
// Auto-discovery by scoring
// ---------------------------------------------------------------------------

const SIDEBAR = `export const sidebarLinks = [
  { path: '/', label: 'Home', icon: 'home' },
  { path: '/invoices', label: 'Invoices', icon: 'bill' },
  { path: '/customers', label: 'Customers', icon: 'user' },
  { path: '/analytics', label: 'Analytics', icon: 'pie' },
]
`

const TOPBAR = `export const topbarLinks = [
  { path: '/', label: 'Home' },
  { path: '/invoices', label: 'Invoices' },
  { path: '/analytics/revenue', label: 'Dashboard' },
  { path: '/help', label: 'Help' },
]
`

const DECORATIVE = `export const socialLinks = [
  { href: 'https://example.com/twitter', label: 'Twitter' },
  { href: 'https://example.com/github', label: 'GitHub' },
  { href: 'https://example.com/blog', label: 'Blog' },
]
`

const TEST_ROUTES = `export const ROUTES_FOR_TESTS = [
  { path: '/fixtures/one', title: 'One' },
  { path: '/fixtures/two', title: 'Two' },
  { path: '/', title: 'Root' },
]
`

describe("auto-discovery keeps every candidate that scores, and only those", () => {
  const result = analyze({
    "src/nav/Sidebar.tsx": SIDEBAR,
    "src/nav/Topbar.tsx": TOPBAR,
    "src/nav/Footer.tsx": DECORATIVE,
    "src/test-utils/routes.ts": TEST_ROUTES,
  })

  it("keeps BOTH a sidebar and a topbar, each with its own score", () => {
    expect(groupsOf(result).map((group) => [group.name, group.score])).toEqual([
      ["sidebarLinks", 1],
      ["topbarLinks", 0.75],
    ])
  })

  it("scores the sidebar above the topbar rather than merging them", () => {
    const scores = new Map(groupsOf(result).map((group) => [group.name, group.score]))
    expect((scores.get("sidebarLinks") ?? 0) > (scores.get("topbarLinks") ?? 0)).toBe(true)
  })

  it("drops the decorative array of external links", () => {
    expect(groupNamed(result, "socialLinks")).toBeUndefined()
  })

  it("never scores a test-fixture array: test-utils files are skipped before scoring", () => {
    expect(groupNamed(result, "ROUTES_FOR_TESTS")).toBeUndefined()
    const rejected = result.diagnostics.filter((entry) => entry.code === "nav/candidate-rejected")
    expect(rejected.map((entry) => entry.severity)).toEqual(rejected.map(() => "info"))
    expect(rejected.some((entry) => entry.message.includes("src/test-utils/routes.ts"))).toBe(false)
  })

  it("keeps candidates at exactly the threshold", () => {
    const half = analyze({
      "src/nav/Half.tsx": `export const halfLinks = [
  { path: '/', label: 'Home' },
  { path: '/nope', label: 'Nope' },
]
`,
    })
    expect(groupNamed(half, "halfLinks")?.score).toBe(NAV_CANDIDATE_MIN_SCORE)
  })

  it("does NOT report the router's own route array as a menu", () => {
    const routerOnly = analyze({})
    expect(groupsOf(routerOnly)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Dead links and orphans
// ---------------------------------------------------------------------------

const WITH_DEAD_LINK = `export const sidebarLinks = [
  { path: '/', label: 'Home', icon: 'home' },
  { path: '/invoices', label: 'Invoices', icon: 'bill' },
  { path: '/customers', label: 'Customers', icon: 'user' },
  { path: '/results', label: 'Results', icon: 'chart' },
]
`

describe("a menu entry pointing at no screen is a finding about the app, not a tool error", () => {
  const result = analyze({ "src/nav/Sidebar.tsx": WITH_DEAD_LINK })

  it("reports it in deadNavLinks with the file and line it was declared on", () => {
    expect(
      result.graph.deadNavLinks.map((entry) => [entry.path, entry.file, entry.line]),
    ).toEqual([["/results", "src/nav/Sidebar.tsx", 5]])
  })

  it("warns once, naming the same location", () => {
    const warning = result.diagnostics.find((entry) => entry.code === "nav/dead-link")
    expect({ severity: warning?.severity, file: warning?.file, line: warning?.line }).toEqual({
      severity: "warning",
      file: "src/nav/Sidebar.tsx",
      line: 5,
    })
  })

  it("does NOT invent the screen the entry would have pointed at", () => {
    expect(result.graph.screens.map((screen) => screen.url).includes("/results")).toBe(false)
    const entry = groupsOf(result)[0]?.entries.find((candidate) => candidate.path === "/results")
    expect(entry?.resolvedScreen).toBeNull()
  })

  it("keeps the group: three of four entries resolve, so it is a menu with a broken link", () => {
    expect(groupsOf(result)[0]?.score).toBe(0.75)
    expect(codesOf(result)).toContain("nav/dead-link")
  })
})

describe("orphan screens shrink once a menu resolves", () => {
  const files = { "src/nav/Sidebar.tsx": SIDEBAR }

  const withoutNav = run({
    files: { "src/shared/paths.ts": PATHS, "src/routes/router.tsx": router(ROUTED), ...files },
    adapters: [createReactRouterAdapter()],
  })
  const withNav = analyze(files)

  it("reports every addressable screen as an orphan when no nav source runs", () => {
    expect(withoutNav.graph.navGroups).toEqual([])
    expect(withoutNav.graph.orphanScreens).toEqual(ROUTED_SORTED)
  })

  it("removes every screen the menu reaches", () => {
    expect(withNav.graph.orphanScreens).toEqual(["/analytics/revenue"])
    expect(withNav.graph.orphanScreens.length).toBeLessThan(withoutNav.graph.orphanScreens.length)
  })
})

// ---------------------------------------------------------------------------
// The named source's own failure modes
// ---------------------------------------------------------------------------

describe("a named menu config that cannot be read says so", () => {
  it("warns when the export is not an array or record of object literals", () => {
    const result = analyze({ "src/config.tsx": "export const navigationRoutes = buildMenu()\n" }, [
      SATISFIES_ARRAY_NAV_SPEC,
    ])
    expect(codesOf(result)).toContain("nav/config-unreadable")
    expect(result.graph.navGroups).toEqual([])
  })

  it("warns when the config is readable but no element carries a target", () => {
    const result = analyze({ "src/config.tsx": "export const navigationRoutes = [{ title: 'Orders' }]\n" }, [
      SATISFIES_ARRAY_NAV_SPEC,
    ])
    expect(codesOf(result)).toContain("nav/config-empty")
  })

  it("never drops a NAMED config for scoring low — only auto-discovered candidates are gated", () => {
    const result = analyze(
      { "src/config.tsx": "export const navigationRoutes = [{ path: '/nowhere', title: 'Nowhere' }]\n" },
      [SATISFIES_ARRAY_NAV_SPEC],
    )
    expect(groupsOf(result).map((group) => group.score)).toEqual([0])
    expect(result.graph.deadNavLinks.map((entry) => entry.path)).toEqual(["/nowhere"])
  })
})

describe("auto-discovery never parses bundles: oversized and minified files are near misses", () => {
  const minified = `export const items=[${Array.from({ length: 40 }, (_, index) => `{path:'/p${index}',label:'L${index}'}`).join(",")}];`
  const oversized = `${GROUPED}\n${"// padding\n".repeat(Math.ceil(NAV_AUTO_SCAN_LIMITS.maxBytes / 11) + 1)}`

  it.each([
    ["a minified bundle", minified],
    ["a file above the byte limit", oversized],
  ])("skips %s without reading a menu from it", (_label, text) => {
    const result = analyze({ "public/vendor/bundle.js": text })
    expect(groupsOf(result)).toEqual([])
  })

  it("still reads the same menu from a normally formatted source file", () => {
    expect(groupsOf(analyze({ "src/nav.ts": GROUPED })).length).toBeGreaterThan(0)
  })
})

describe("menu entries that are not in-app screens", () => {
  const EXTERNAL = `export const accountMenu = [
  { path: '/', label: 'Home' },
  { href: 'mailto:support@example.com', label: 'Contact' },
  { href: 'https://example.com/docs', label: 'Docs' },
  { href: '//cdn.example.com', label: 'CDN' },
  { href: '#map', label: 'See on the map' },
  { path: '/invoices', label: 'Invoices' },
]
`

  it("drops external and in-page targets (mailto:, https:, protocol-relative, #anchor) instead of reporting dead links", () => {
    const result = analyze({ "src/nav.ts": EXTERNAL })
    expect(pathsOf(result)).toEqual(["/", "/invoices"])
    expect(codesOf(result)).not.toContain("nav/dead-link")
  })

  it("never reads a menu from a Storybook or test-utils fixture", () => {
    const result = analyze({ "src/test-utils/storybook/appShell.tsx": GROUPED })
    expect(groupsOf(result)).toEqual([])
  })
})

describe("auto-discovery stays inside this root's own package", () => {
  it("never scores a menu declared under a nested package (a directory with its own package.json)", () => {
    const result = analyze({
      "extension/package.json": "{ \"name\": \"extension\" }",
      "extension/src/nav.ts": GROUPED,
    })
    expect(groupsOf(result)).toEqual([])
  })

  it("still scores the same menu when it lives in the root package", () => {
    expect(groupsOf(analyze({ "extension/src/nav.ts": GROUPED })).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// A record KEY is a target only when it is path-like
// ---------------------------------------------------------------------------

const deadPathsOf = (result: PipelineResult): readonly string[] =>
  sortStrings(result.graph.deadNavLinks.map((entry) => entry.path))

describe("a record key becomes a target only when it starts with `/` or the config has a basePath", () => {
  it("never reads a domain id as a target: a keyed container's real links live in its nested array", () => {
    const result = analyze({
      "src/lib/empty-states.ts": `export const CONTEXTUAL_EMPTY_STATES = {
  business: {
    icon: Briefcase,
    title: 'Your business command center',
    actions: [
      { label: 'Invoices', to: '/invoices' },
      { label: 'Customers', to: '/customers' },
    ],
  },
  money: {
    icon: Wallet,
    title: 'Take control of your money',
    actions: [{ label: 'Analytics', to: '/analytics' }],
  },
}
`,
    })
    expect(deadPathsOf(result)).toEqual([])
    expect(pathsOf(result)).toEqual(["/analytics", "/customers", "/invoices"])
    expect(groupsOf(result).map((group) => group.name)).toEqual(["Take control of your money", "Your business command center"])
  })

  it("keeps a keyed section's items but never the section key itself", () => {
    const result = analyze({
      "src/home/content.ts": `export const HOME_CONTENT = {
  categorias: {
    heading: 'Explora por categoría',
    items: [
      { slug: 'facturas', label: 'Facturas', href: '/invoices' },
      { slug: 'clientes', label: 'Clientes', href: '/customers' },
    ],
  },
}
`,
    })
    expect(deadPathsOf(result)).toEqual([])
    expect(pathsOf(result)).toEqual(["/customers", "/invoices"])
    expect(groupsOf(result).map((group) => group.name)).toEqual(["Explora por categoría"])
  })

  it("drops a flat relative-keyed element when no basePath is configured", () => {
    const result = analyze({
      "src/nav/keyed.ts": `export const keyedLinks = {
  invoices: { label: 'Invoices', icon: 'bill' },
  customers: { label: 'Customers', icon: 'user' },
}
`,
    })
    expect(groupsOf(result)).toEqual([])
    expect(deadPathsOf(result)).toEqual([])
  })

  it("keeps a slash-keyed map: the key IS the path", () => {
    const result = analyze({
      "src/nav/recents.ts": `export const RECENT_LABELS = {
  '/invoices': { label: 'Invoices', icon: 'bill' },
  '/customers': { label: 'Customers', icon: 'user' },
}

export const openRecent = (navigate: Navigate, to: string) => navigate({ to })
`,
    })
    expect(pathsOf(result)).toEqual(["/customers", "/invoices"])
    expect(deadPathsOf(result)).toEqual([])
  })

  it("warns that a NAMED record of relative keys without a basePath yields no entries", () => {
    const result = analyze({ "src/admin/navigation.ts": RECORD }, [
      { file: "src/admin/navigation.ts", export: "navigation", fields: { label: "name", icon: "icon" } },
    ])
    expect(groupsOf(result)).toEqual([])
    expect(codesOf(result)).toContain("nav/config-empty")
  })

  it("never joins a keyed CONTAINER's key onto the basePath: it names the section", () => {
    const result = run({
      files: {
        "src/routes/router.tsx": router(["/admin/resources/invoices"]),
        "src/admin/navigation.ts": `export const navigation = {
  billing: { items: [{ to: 'invoices', name: 'Invoices' }] },
}
`,
      },
      adapters: [
        createReactRouterAdapter(),
        createNavAdapter({
          menus: [{ file: "src/admin/navigation.ts", export: "navigation", basePath: "/admin/resources" }],
        }),
      ],
    })
    expect(pathsOf(result)).toEqual(["/admin/resources/invoices"])
    expect(groupsOf(result).map((group) => group.name)).toEqual(["billing"])
  })
})

describe("a TanStack route options object is never a menu", () => {
  const tanstackRoute = (call: string): string => `import { createFileRoute, createRoute } from '@tanstack/react-router'

export const Route = ${call}({
  beforeLoad: async () => {},
  component: NewInvoicePage,
  staticData: {
    breadcrumb: [
      { label: 'Invoices', to: '/invoices' },
      { label: 'New invoice' },
    ],
  },
})

function NewInvoicePage() {
  return null
}
`

  it.each([
    ["createFileRoute", "createFileRoute('/_app/invoices/new/')"],
    ["createRoute", "createRoute"],
  ])("reads nothing from %s options, `staticData` included", (_label, call) => {
    const result = analyze({ "src/routes/_app/invoices/new.tsx": tanstackRoute(call) })
    expect(groupsOf(result)).toEqual([])
    expect(deadPathsOf(result)).toEqual([])
  })
})

describe("a nested item's relative target joins its container's target", () => {
  const NESTED = `export const sidebar = [
  { title: 'Invoices', path: '/invoices' },
  { title: 'Analytics', path: '/analytics', children: [
    { title: 'Revenue', path: 'revenue' },
    { title: 'Absolute', path: '/customers' },
  ] },
]
`

  const result = analyze({ "src/nav.ts": NESTED })

  it("resolves `{ path: 'revenue' }` under `/analytics` to `/analytics/revenue` and keeps the section", () => {
    expect(sortStrings(groupNamed(result, "Analytics")?.entries.map((entry) => entry.path) ?? [])).toEqual([
      "/analytics",
      "/analytics/revenue",
      "/customers",
    ])
    expect(deadPathsOf(result)).toEqual([])
  })
})

describe("a vue-router route table is never a menu", () => {
  const VUE_ROUTES = `import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

export const projectsRoutes: RouteRecordRaw[] = [
  {
    path: '/projects',
    name: 'projects',
    redirect: '/home/workflows',
    children: [
      { path: ':projectId', name: 'project.details', redirect: { name: 'project.workflows' } },
    ],
  },
]

export const settingsRoutes = [
  { path: '/settings', name: 'settings', children: [{ path: 'general', name: 'settings.general' }] },
  { path: '/settings/old', name: 'settings.old', beforeEnter: () => true, components: { default: Settings } },
]

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'user.login', component: Login },
    {
      path: '/lists:pathMatch(.*)*',
      name: 'lists',
      redirect(to) {
        return { path: to.path.replace('/lists', '/projects') }
      },
    },
    ...projectsRoutes,
  ],
})

export default router
`

  const result = analyze({ "src/router/index.ts": VUE_ROUTES, "src/nav/Sidebar.tsx": SIDEBAR })

  it("reads no nav entries and no dead links from redirect records or relative children", () => {
    expect(groupNamed(result, "router")).toBeUndefined()
    expect(groupNamed(result, "projectsRoutes")).toBeUndefined()
    expect(groupNamed(result, "settingsRoutes")).toBeUndefined()
    expect(deadPathsOf(result)).toEqual([])
  })

  it("still reads a real menu array alongside the route table", () => {
    expect(groupsOf(result).map((group) => group.name)).toEqual(["sidebarLinks"])
  })
})

describe("ambiguous route fields never hide a real menu's dead links", () => {
  it("reads a registry whose `components` is a string ARRAY as entries, not as vue-router named views", () => {
    const result = analyze({
      "src/registry.ts": `export const FEATURE_MATRIX = [
  { id: 'FR-001', name: 'Invoices', route: '/invoices', components: ['InvoiceList', 'InvoiceForm'] },
  { id: 'FR-002', name: 'Spending', route: '/money/analytics', components: ['SpendingCharts'] },
]
`,
    })
    expect(deadPathsOf(result)).toEqual(["/money/analytics"])
  })

  it("keeps the `path` items of a quick-nav array whose other items carry an `action` callback", () => {
    const result = analyze({
      "src/pages/Owner.tsx": `export const quickNav = [
  { label: 'Invoices', icon: 'bill', path: '/invoices' },
  { label: 'Enterprise', icon: 'globe', path: '/enterprise' },
  { label: 'Incidents', icon: 'alert', action: () => goTo('incidents') },
]
`,
    })
    expect(deadPathsOf(result)).toEqual(["/enterprise"])
    expect(pathsOf(result)).toEqual(["/enterprise", "/invoices"])
  })

  it("still drops a route table identified only through its children's route records", () => {
    const result = analyze({
      "src/router/routes.ts": `export const routes = [
  { path: '/settings', name: 'settings', children: [{ path: 'general', name: 'general', component: General }] },
]
`,
    })
    expect(groupNamed(result, "routes")).toBeUndefined()
    expect(deadPathsOf(result)).toEqual([])
  })
})
