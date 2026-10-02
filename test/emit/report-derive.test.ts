import { describe, expect, it } from "vitest"
import type { Activation, AncestorRef, AppGraph, Endpoint, FileFacts, ResolvedNavigation, Screen, TreeNode } from "../../src/core/model.js"
import {
  FINDING_SECTIONS,
  PALETTE_GROUP_LIMIT,
  SEVERITY_ORDER,
  SEVERITY_RANK,
  STAT_IDS,
  STAT_SPECS,
  componentKinds,
  componentPaletteText,
  flattenNavGroups,
  groupNames,
  isAlarmingStat,
  isHiddenStat,
  joinSearchText,
  matchesQuery,
  matchesTokens,
  normalizeQuery,
  queryTokens,
  redirectPath,
  resolveRedirectTarget,
  screenBadges,
  screenPaletteText,
  severityCounts,
  statValue,
  activationKindLabel,
  activationLabel,
  appNameOf,
  buildColorMap,
  byRendersThenFile,
  collectEndpointKeys,
  collectEndpoints,
  collectKinds,
  componentRoute,
  componentSearch,
  endpointKey,
  extraValueText,
  groupNavEdges,
  renderPaletteCss,
  routedFiles,
  screenPrimaryLabel,
  searchIndex,
  slugify,
  spliceLabel,
} from "../../src/emit/report-derive.js"
import { t } from "../../src/emit/strings.js"

const loose = <T>(value: object): T => value as unknown as T

const node = (kind: string, children: readonly TreeNode[] = []): TreeNode => loose<TreeNode>({ kind, children })

const endpoint = (transport: string, method: string): Endpoint => loose<Endpoint>({ transport, method })

const screenOf = (overrides: object): Screen =>
  loose<Screen>({
    url: null,
    title: null,
    localId: "id",
    featureFlag: null,
    entries: [],
    activations: [],
    tree: [],
    facts: { endpoints: [] },
    ...overrides,
  })

const factsOf = (overrides: object): FileFacts =>
  loose<FileFacts>({ file: "src/A.tsx", component: "A", renders: [], endpoints: [], kind: "component", ...overrides })

const edge = (overrides: object): ResolvedNavigation =>
  loose<ResolvedNavigation>({ to: "/x", dynamic: false, trigger: "link", from: "src/A.tsx", ...overrides })

describe("emit/report-derive slugify", () => {
  it("lowercases and collapses runs of non-alphanumerics into single dashes", () => {
    expect(slugify("Hello,  World!!")).toBe("hello-world")
    expect(slugify("api:GET")).toBe("api-get")
  })

  it("trims leading and trailing dashes", () => {
    expect(slugify("--a--")).toBe("a")
    expect(slugify("/users/")).toBe("users")
  })

  it("falls back to x when nothing alphanumeric survives (empty, symbols, non-ASCII)", () => {
    expect(slugify("")).toBe("x")
    expect(slugify("!!!")).toBe("x")
    expect(slugify("żółć")).toBe("x")
  })

  it("never emits characters that could break out of a CSS custom-property name", () => {
    expect(slugify("a;}</style><script>")).toMatch(/^[a-z0-9-]+$/)
  })
})

describe("emit/report-derive buildColorMap", () => {
  it("assigns colors by sorted key, independent of input order and duplicates", () => {
    const forward = buildColorMap(["b", "a", "c", "a"])
    const backward = buildColorMap(["c", "a", "b"])

    expect([...forward.keys()]).toEqual(["a", "b", "c"])
    expect([...forward.entries()]).toEqual([...backward.entries()])
  })

  it("wraps around the palette after ten distinct keys", () => {
    const keys = Array.from({ length: 11 }, (_, index) => `k${String(index).padStart(2, "0")}`)
    const map = buildColorMap(keys)

    expect(map.get("k10")).toEqual(map.get("k00"))
    expect(map.get("k01")).not.toEqual(map.get("k00"))
  })

  it("returns an empty map for no keys", () => {
    expect(buildColorMap([]).size).toBe(0)
  })

  it("gives every color a light and a dark hex", () => {
    for (const pair of buildColorMap(["a", "b", "c"]).values()) {
      expect(pair.light).toMatch(/^#[0-9a-f]{6}$/)
      expect(pair.dark).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

describe("emit/report-derive renderPaletteCss", () => {
  it("emits light, media-dark and both explicit theme overrides using slugified names", () => {
    const kinds = buildColorMap(["Page Header"])
    const methods = buildColorMap(["http:get"])
    const css = renderPaletteCss(kinds, methods)
    const pair = kinds.get("Page Header")

    expect(css).toContain("--kind-color-page-header:")
    expect(css).toContain("--method-color-http-get:")
    expect(css).toContain("@media (prefers-color-scheme: dark)")
    expect(css).toContain(":root[data-theme='dark']")
    expect(css).toContain(":root[data-theme='light']")
    expect(css.startsWith(`:root { --kind-color-page-header: ${pair?.light};`)).toBe(true)
  })

  it("yields valid empty rule bodies with no colors", () => {
    expect(renderPaletteCss(new Map(), new Map())).toMatch(/^:root \{\s*\}\n@media/)
  })

  it("keeps two distinct kinds on distinct CSS variables (slugify collides 'a b' and 'a-b', src/emit/report-derive.ts:19 slugify)", () => {
    const css = renderPaletteCss(buildColorMap(["a b", "a-b"]), new Map())
    const names = [...css.split("\n")[0]?.matchAll(/--kind-color-[a-z0-9-]+/g) ?? []].map((match) => match[0])

    expect(new Set(names).size).toBe(2)
  })

  it("is deterministic for the same input", () => {
    const build = () => renderPaletteCss(buildColorMap(["b", "a"]), buildColorMap(["x:get"]))

    expect(build()).toBe(build())
  })
})

describe("emit/report-derive collectKinds and endpoints", () => {
  it("collects tree kinds recursively from screens and shells plus component kinds, deduplicated", () => {
    const graph = loose<AppGraph>({
      screens: [screenOf({ tree: [node("page", [node("card", [node("button")])])] })],
      shells: { shellA: { tree: [node("layout", [node("page")])], endpoints: [] } },
      components: { c1: factsOf({ kind: "widget" }), c2: factsOf({ kind: "card" }) },
    })

    expect([...collectKinds(graph)].sort()).toEqual(["button", "card", "layout", "page", "widget"])
  })

  it("returns no kinds or endpoints for an empty graph", () => {
    const empty = loose<AppGraph>({ screens: [], shells: {}, components: {} })

    expect(collectKinds(empty)).toEqual([])
    expect(collectEndpoints(empty)).toEqual([])
    expect(collectEndpointKeys(empty)).toEqual([])
  })

  it("gathers endpoints from screens, shells and components, and keys them lower-cased by transport", () => {
    const graph = loose<AppGraph>({
      screens: [screenOf({ facts: { endpoints: [endpoint("http", "GET")] } })],
      shells: { s: { tree: [], endpoints: [endpoint("http", "get"), endpoint("rpc", "Query")] } },
      components: { c: factsOf({ endpoints: [endpoint("http", "POST")] }) },
    })

    expect(collectEndpoints(graph)).toHaveLength(4)
    expect([...collectEndpointKeys(graph)].sort()).toEqual(["http:get", "http:post", "rpc:query"])
    expect(endpointKey(endpoint("convex", "MuTaTiOn"))).toBe("convex:mutation")
  })
})

describe("emit/report-derive groupNavEdges", () => {
  it("merges edges to the same target and dynamic-ness, deduplicating and sorting their sources", () => {
    const groups = groupNavEdges([
      edge({ to: "/a", from: "src/B.tsx", trigger: "link" }),
      edge({ to: "/a", from: "src/A.tsx", trigger: "navigate", expr: "go()" }),
      edge({ to: "/a", from: "src/B.tsx", trigger: "link" }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.sources).toEqual(["link @ src/B.tsx", "navigate @ src/A.tsx — go()"])
  })

  it("keeps a dynamic and a static edge to the same target apart", () => {
    const groups = groupNavEdges([edge({ to: "/a", dynamic: true }), edge({ to: "/a", dynamic: false })])

    expect(groups.map((group) => group.edge.dynamic)).toEqual([true, false])
  })

  it("keeps the first edge as the representative and the first-seen group order", () => {
    const first = edge({ to: "/b", from: "one" })
    const groups = groupNavEdges([first, edge({ to: "/a" }), edge({ to: "/b", from: "two" })])

    expect(groups.map((group) => group.edge.to)).toEqual(["/b", "/a"])
    expect(groups[0]?.edge).toBe(first)
  })

  it("returns no groups for no edges", () => {
    expect(groupNavEdges([])).toEqual([])
  })
})

describe("emit/report-derive activation and screen labels", () => {
  const activations: readonly [Activation, string, string][] = [
    [loose<Activation>({ kind: "url", template: "/a/:id" }), "/a/:id", t("en", "activationKindUrl")],
    [loose<Activation>({ kind: "state", expr: "isOpen" }), t("en", "activationStateDetail", { expr: "isOpen" }), t("en", "activationKindState")],
    [loose<Activation>({ kind: "host", pattern: "*.acme.io" }), t("en", "activationHostDetail", { pattern: "*.acme.io" }), t("en", "activationKindHost")],
    [loose<Activation>({ kind: "message", messageType: "ping" }), t("en", "activationMessageDetail", { messageType: "ping" }), t("en", "activationKindMessage")],
    [loose<Activation>({ kind: "intercept", from: "/x" }), t("en", "activationInterceptDetail", { from: "/x" }), t("en", "activationKindIntercept")],
    [
      { kind: "route", name: "Profile", navigator: "HomeTab" },
      t("en", "activationRouteDetail", { name: "Profile", navigator: "HomeTab" }),
      t("en", "activationKindRoute"),
    ],
    [{ kind: "route", name: "Profile", navigator: null }, t("en", "activationRouteNameDetail", { name: "Profile" }), t("en", "activationKindRoute")],
  ]

  it.each(activations)("labels %o", (activation, label, kindLabel) => {
    expect(activationLabel(activation, "en")).toBe(label)
    expect(activationKindLabel(activation, "en")).toBe(kindLabel)
  })

  it("localizes activation labels", () => {
    expect(activationLabel(loose<Activation>({ kind: "state", expr: "x" }), "pl")).toBe(t("pl", "activationStateDetail", { expr: "x" }))
  })

  it("labels a route activation in Polish with its name and navigator", () => {
    const route: Activation = { kind: "route", name: "Profile", navigator: "HomeTab" }

    expect(activationLabel(route, "pl")).toBe("Profile w HomeTab")
    expect(activationKindLabel(route, "pl")).toBe("Nazwa trasy")
    expect(activationLabel(route, "en")).toBe("Profile in HomeTab")
  })

  it("prefers the screen url, then the first activation, then a dash", () => {
    const state = loose<Activation>({ kind: "state", expr: "ready" })

    expect(screenPrimaryLabel(screenOf({ url: "/home", activations: [state] }), "en")).toBe("/home")
    expect(screenPrimaryLabel(screenOf({ activations: [state] }), "en")).toBe(activationLabel(state, "en"))
    expect(screenPrimaryLabel(screenOf({}), "en")).toBe(t("en", "dash"))
  })

  it("treats an empty-string url as a real url, not as absent", () => {
    expect(screenPrimaryLabel(screenOf({ url: "" }), "en")).toBe("")
  })
})

describe("emit/report-derive spliceLabel", () => {
  it("describes each splice mode", () => {
    const label = (splice: object) => spliceLabel(loose<AncestorRef["splice"]>(splice))

    expect(label({ kind: "children" })).toBe("children")
    expect(label({ kind: "outlet", tag: "Outlet" })).toBe("outlet <Outlet>")
    expect(label({ kind: "outlet", tag: "RouterView", name: "aside" })).toBe('outlet <RouterView name="aside">')
    expect(label({ kind: "slot", name: "default" })).toBe("slot {default}")
    expect(label({ kind: "at", locator: { export: "Layout", path: ["a", "0"] } })).toBe("at Layout#a.0")
    expect(label({ kind: "at", locator: { export: "Layout", path: [] } })).toBe("at Layout#")
  })
})

describe("emit/report-derive searchIndex", () => {
  it("joins url, title, localId, flag and entries, lower-cased", () => {
    const index = searchIndex(
      screenOf({
        url: "/Orders",
        title: "My ORDERS",
        localId: "Src/Orders.tsx",
        featureFlag: "BetaFlag",
        entries: [
          { kind: "file", file: "src/Orders.tsx" },
          { kind: "opaque", expr: "Lazy(Orders)", file: "src/R.tsx" },
        ],
      }),
    )

    expect(index).toBe("/orders my orders src/orders.tsx betaflag src/orders.tsx lazy(orders) src/r.tsx")
  })

  it("includes route-activation names", () => {
    const index = searchIndex(
      screenOf({ localId: "L", activations: [{ kind: "route", name: "ProfileScreen", navigator: null }] }),
    )

    expect(index).toContain("profilescreen")
  })

  it("keeps a stable shape with null parts (empty segments, never the word null)", () => {
    const index = searchIndex(screenOf({ localId: "L" }))

    expect(index).not.toContain("null")
    expect(index).toBe("  l ")
  })
})

describe("emit/report-derive routedFiles and componentRoute", () => {
  const screens = [
    screenOf({
      url: "/shop/cart",
      entries: [
        { kind: "file", file: "src/app/shop/cart/page.tsx" },
        { kind: "opaque", expr: "x", file: "src/ignored.tsx" },
      ],
    }),
    screenOf({ url: "/shop/checkout", entries: [{ kind: "file", file: "src/app/shop/checkout/page.tsx" }] }),
    screenOf({ url: null, entries: [{ kind: "file", file: "src/app/hidden/page.tsx" }] }),
  ]

  it("keeps only file entries of screens that have a url", () => {
    expect(routedFiles(screens)).toEqual([
      { file: "src/app/shop/cart/page.tsx", url: "/shop/cart" },
      { file: "src/app/shop/checkout/page.tsx", url: "/shop/checkout" },
    ])
    expect(routedFiles([])).toEqual([])
  })

  it("routes a component to its own screen url when the file is directly routed", () => {
    const routed = routedFiles(screens)

    expect(componentRoute(factsOf({ file: "src/app/shop/cart/page.tsx", component: "Cart" }), routed)).toBe("/shop/cart")
  })

  it("routes a route-module-named file with no direct entry to the common url prefix of its directory", () => {
    const routed = [
      { file: "src/app/shop/page.tsx", url: "/shop/a" },
      { file: "src/app/shop/other.tsx", url: "/shop/b" },
    ]

    expect(componentRoute(factsOf({ file: "src/app/shop/layout.tsx", component: "layout" }), routed)).toBe("/shop")
  })

  it("collapses to / when the directory's urls share no segment", () => {
    const routed = [
      { file: "src/r/a.tsx", url: "/a" },
      { file: "src/r/b.tsx", url: "/b" },
    ]

    expect(componentRoute(factsOf({ file: "src/r/layout.tsx", component: "layout" }), routed)).toBe("/")
  })

  it("returns null for an ordinary component with no direct route, or a route-module with no routed siblings", () => {
    const routed = routedFiles(screens)

    expect(componentRoute(factsOf({ file: "src/app/shop/cart/Button.tsx", component: "Button" }), routed)).toBeNull()
    expect(componentRoute(factsOf({ file: "src/elsewhere/layout.tsx", component: "layout" }), routed)).toBeNull()
  })

  it("does not treat a sibling directory sharing a name prefix as the same directory", () => {
    const routed = [{ file: "src/app/shop-extra/page.tsx", url: "/extra" }]

    expect(componentRoute(factsOf({ file: "src/app/shop/layout.tsx", component: "layout" }), routed)).toBeNull()
  })

  it("treats an Expo _layout file as a route module", () => {
    const routed = [{ file: "app/(tabs)/home.tsx", url: "/home" }]

    expect(componentRoute(factsOf({ file: "app/(tabs)/_layout.tsx", component: "_layout" }), routed)).toBe("/home")
  })

  it("handles a root-level file with no directory", () => {
    expect(componentRoute(factsOf({ file: "layout.tsx", component: "layout" }), [{ file: "page.tsx", url: "/p" }])).toBeNull()
  })

  it("keeps the first url when a file is routed more than once", () => {
    const routed = [
      { file: "src/app/page.tsx", url: "/first" },
      { file: "src/app/page.tsx", url: "/second" },
    ]

    expect(componentRoute(factsOf({ file: "src/app/page.tsx", component: "Page" }), routed)).toBe("/first")
  })

  it("collects routed files from nested directories under a route module's directory", () => {
    const routed = [
      { file: "src/app/shop/a/b/page.tsx", url: "/shop/a/b" },
      { file: "src/app/shop/a/page.tsx", url: "/shop/a" },
    ]

    expect(componentRoute(factsOf({ file: "src/app/shop/layout.tsx", component: "layout" }), routed)).toBe("/shop/a")
  })

  it("matches every absolute routed file for a root-level route module", () => {
    const routed = [
      { file: "/abs/x/page.tsx", url: "/x/one" },
      { file: "/abs/y/page.tsx", url: "/x/two" },
    ]

    expect(componentRoute(factsOf({ file: "layout.tsx", component: "layout" }), routed)).toBe("/x")
  })
})

describe("emit/report-derive componentSearch, ordering and small helpers", () => {
  it("builds a lower-cased search string with an empty slot for a null route", () => {
    expect(componentSearch(factsOf({ component: "Btn", file: "src/Btn.tsx" }), "/Route")).toBe("btn src/btn.tsx /route")
    expect(componentSearch(factsOf({ component: "Btn", file: "src/Btn.tsx" }), null)).toBe("btn src/btn.tsx ")
  })

  it("orders components by render count descending, then by file code point", () => {
    const list = [
      factsOf({ file: "b.tsx", renders: [1] }),
      factsOf({ file: "a.tsx", renders: [] }),
      factsOf({ file: "c.tsx", renders: [1, 2] }),
      factsOf({ file: "B.tsx", renders: [] }),
    ]

    expect([...list].sort(byRendersThenFile).map((facts) => facts.file)).toEqual(["c.tsx", "b.tsx", "B.tsx", "a.tsx"])
    expect([...list].reverse().sort(byRendersThenFile)).toEqual([...list].sort(byRendersThenFile))
  })

  it("renders extra values: strings verbatim, others as JSON, and unserializable ones as String()", () => {
    expect(extraValueText("hi")).toBe("hi")
    expect(extraValueText(3)).toBe("3")
    expect(extraValueText({ a: [1] })).toBe('{"a":[1]}')
    expect(extraValueText(null)).toBe("null")
    expect(extraValueText(undefined)).toBe("undefined")
    expect(extraValueText(Symbol.for("s"))).toBe("Symbol(s)")
    expect(extraValueText(() => 1)).toBe("() => 1")
  })

  it("names the app by its meta name, falling back to the root", () => {
    expect(appNameOf(loose<AppGraph>({ meta: { appName: "acme", root: "/r" } }))).toBe("acme")
    expect(appNameOf(loose<AppGraph>({ meta: { appName: null, root: "/r" } }))).toBe("/r")
    expect(appNameOf(loose<AppGraph>({ meta: { appName: "", root: "/r" } }))).toBe("")
  })
})

describe("shared client derivations", () => {
  it("normalises queries and matches rows by their search text", () => {
    expect(normalizeQuery("  Foo BAR ")).toBe("foo bar")
    expect(matchesQuery({ search: "/users list" }, "")).toBe(true)
    expect(matchesQuery({ search: "/users list" }, "users")).toBe(true)
    expect(matchesQuery({ search: "/users list" }, "orders")).toBe(false)
  })

  it("splits palette queries into lower-cased tokens that must all match", () => {
    expect(queryTokens("  Users   EDIT ")).toEqual(["users", "edit"])
    expect(queryTokens("   ")).toEqual([])
    expect(matchesTokens("/users/:id/edit user editor", ["users", "edit"])).toBe(true)
    expect(matchesTokens("/users/:id", ["users", "edit"])).toBe(false)
    expect(matchesTokens("anything", [])).toBe(true)
    expect(PALETTE_GROUP_LIMIT).toBe(50)
  })

  it("builds palette haystacks, skipping null parts", () => {
    expect(joinSearchText("A", null, "B")).toBe("a b")
    expect(screenPaletteText({ primaryLabel: "/Users", title: null, id: "s1" })).toBe("/users s1")
    expect(componentPaletteText({ component: "Card", route: "/x", file: "src/Card.tsx" })).toBe("card /x src/card.tsx")
    expect(componentPaletteText({ component: "Card", route: null, file: "src/Card.tsx" })).toBe("card src/card.tsx")
  })

  it("resolves a redirect target by url or id after stripping a trailing query", () => {
    const screens = [
      { id: "home", url: "/" },
      { id: "login", url: "/login" },
      { id: "modal", url: null },
    ]
    expect(redirectPath("/login?next=/x")).toBe("/login?next=/x")
    expect(redirectPath("/login?next=x")).toBe("/login")
    expect(resolveRedirectTarget(screens, "/login?next=x")?.id).toBe("login")
    expect(resolveRedirectTarget(screens, "modal")?.id).toBe("modal")
    expect(resolveRedirectTarget(screens, "/missing")).toBeUndefined()
  })

  it("flattens nav groups into rows carrying their group, and lists distinct group names", () => {
    const groups = [
      { name: "main", source: "a.ts", availableOnShells: ["app"], entries: [{ path: "/a" }, { path: "/b" }] },
      { name: "side", source: "b.ts", availableOnShells: [], entries: [] },
      { name: "main", source: "c.ts", availableOnShells: [], entries: [{ path: "/c" }] },
    ]
    expect(flattenNavGroups(groups)).toEqual([
      { path: "/a", group: "main", groupSource: "a.ts", groupShells: ["app"] },
      { path: "/b", group: "main", groupSource: "a.ts", groupShells: ["app"] },
      { path: "/c", group: "main", groupSource: "c.ts", groupShells: [] },
    ])
    expect(groupNames(groups)).toEqual(["main", "side"])
  })

  it("lists distinct component kinds in codepoint order", () => {
    expect(componentKinds([{ kind: "page" }, { kind: "Widget" }, { kind: "page" }, { kind: "hook" }])).toEqual([
      "Widget",
      "hook",
      "page",
    ])
  })

  it("orders finding sections and severities", () => {
    expect(FINDING_SECTIONS).toEqual(["limitations", "dead-links", "orphans", "confidence", "diagnostics"])
    expect([...SEVERITY_ORDER].sort((a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a])).toEqual(SEVERITY_ORDER)
    expect(severityCounts([{ severity: "info" }, { severity: "error" }, { severity: "info" }])).toEqual({
      all: 3,
      error: 1,
      warning: 0,
      info: 2,
    })
  })

  it("orders stats with four primary ones, an alarm on dead links, and hides zero API routes", () => {
    expect(STAT_IDS).toEqual([
      "screens",
      "components",
      "endpoints",
      "deadLinks",
      "apiRoutes",
      "redirects",
      "renderEdges",
      "navEdges",
      "depth",
    ])
    expect(STAT_SPECS.filter((spec) => spec.primary).map((spec) => spec.id)).toEqual([
      "screens",
      "components",
      "endpoints",
      "deadLinks",
    ])
    const deadLinks = { alarm: true }
    expect(isAlarmingStat(deadLinks, 1)).toBe(true)
    expect(isAlarmingStat(deadLinks, 0)).toBe(false)
    expect(isAlarmingStat({ alarm: false }, 5)).toBe(false)
    expect(isHiddenStat({ id: "apiRoutes" }, 0)).toBe(true)
    expect(isHiddenStat({ id: "apiRoutes" }, 2)).toBe(false)
    expect(isHiddenStat({ id: "redirects" }, 0)).toBe(false)
    const counts = {
      screens: 4,
      apiRoutes: 1,
      redirects: 2,
      components: 3,
      renderEdges: 5,
      navEdges: 6,
      endpoints: 7,
      deadLinks: 8,
    }
    expect(statValue({ counts, maxDepth: 9 }, "depth")).toBe(9)
    expect(statValue({ counts, maxDepth: 9 }, "deadLinks")).toBe(8)
  })

  it("derives screen badges in display order, only when they apply", () => {
    const plain = { redirectTo: null, featureFlag: null, devOnly: false, addressable: true, shell: null }
    expect(screenBadges(plain)).toEqual([])
    expect(
      screenBadges({ redirectTo: "/login", featureFlag: "beta", devOnly: true, addressable: false, shell: "app" }),
    ).toEqual([
      { id: "redirect", value: "/login" },
      { id: "flag", value: "beta" },
      { id: "devOnly", value: null },
      { id: "unaddressable", value: null },
      { id: "shell", value: "app" },
    ])
  })
})
