import type {
  Activation,
  AncestorRef,
  AppGraph,
  Endpoint,
  EntryRef,
  FileFacts,
  ResolvedNavigation,
  Screen,
  Severity,
  TreeNode,
} from "../core/model.js"
import { byCodepoint } from "./html-util.js"
import type { HeaderCounts } from "./report-payload.js"
import type { Locale } from "./strings.js"
import { t } from "./strings.js"

type ColorPair = { readonly light: string; readonly dark: string }

export const slugify = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : "x"
}

const stableHash = (value: string): string => {
  let hash = 0x811c9dc5
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

const hasNonAscii = (value: string): boolean => [...value].some((char) => (char.codePointAt(0) ?? 0) > 0x7f)

const countBy = (values: readonly string[]): ReadonlyMap<string, number> =>
  values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map<string, number>())

const needsHash = (key: string, base: string, counts: ReadonlyMap<string, number>): boolean =>
  hasNonAscii(key) || ((counts.get(base) ?? 0) > 1 && key !== base)

export const uniqueSlugs = (keys: readonly string[]): ReadonlyMap<string, string> => {
  const distinct = [...new Set(keys)].sort(byCodepoint)
  const bases = distinct.map((key) => [key, slugify(key)] as const)
  const counts = countBy(bases.map(([, base]) => base))
  return new Map(
    bases.map(([key, base]) => [key, needsHash(key, base, counts) ? `${base}-${stableHash(key)}` : base]),
  )
}

const PALETTE: readonly ColorPair[] = [
  { light: "#2f6df6", dark: "#6f9bff" },
  { light: "#16794d", dark: "#6ee7b7" },
  { light: "#8a5300", dark: "#fbbf6b" },
  { light: "#a3242f", dark: "#fca5a5" },
  { light: "#7c3aed", dark: "#c4b5fd" },
  { light: "#0e7490", dark: "#67e8f9" },
  { light: "#be185d", dark: "#f9a8d4" },
  { light: "#4d7c0f", dark: "#bef264" },
  { light: "#9a3412", dark: "#fdba74" },
  { light: "#334155", dark: "#cbd5e1" },
]

const FALLBACK_COLOR: ColorPair = { light: "#626b7a", dark: "#98a2b3" }

const paletteFor = (index: number): ColorPair => PALETTE[index % PALETTE.length] ?? FALLBACK_COLOR

export const buildColorMap = (keys: readonly string[]): ReadonlyMap<string, ColorPair> => {
  const sorted = [...new Set(keys)].sort(byCodepoint)
  return new Map(sorted.map((key, index) => [key, paletteFor(index)]))
}

const collectTreeKinds = (nodes: readonly TreeNode[], into: Set<string>): void => {
  for (const node of nodes) {
    into.add(node.kind)
    collectTreeKinds(node.children, into)
  }
}

export const collectKinds = (graph: AppGraph): readonly string[] => {
  const kinds = new Set<string>()
  for (const screen of graph.screens) collectTreeKinds(screen.tree, kinds)
  for (const shell of Object.values(graph.shells)) collectTreeKinds(shell.tree, kinds)
  for (const facts of Object.values(graph.components)) kinds.add(facts.kind)
  return [...kinds]
}

export const endpointKey = (endpoint: Endpoint): string => `${endpoint.transport}:${endpoint.method.toLowerCase()}`

export const collectEndpoints = (graph: AppGraph): readonly Endpoint[] => {
  const all: Endpoint[] = []
  for (const screen of graph.screens) all.push(...screen.facts.endpoints)
  for (const shell of Object.values(graph.shells)) all.push(...shell.endpoints)
  for (const facts of Object.values(graph.components)) all.push(...facts.endpoints)
  return all
}

export const collectEndpointKeys = (graph: AppGraph): readonly string[] => {
  const keys = new Set<string>()
  for (const endpoint of collectEndpoints(graph)) keys.add(endpointKey(endpoint))
  return [...keys]
}

export const renderPaletteCss = (
  kindColors: ReadonlyMap<string, ColorPair>,
  methodColors: ReadonlyMap<string, ColorPair>,
): string => {
  const kindSlugs = uniqueSlugs([...kindColors.keys()])
  const methodSlugs = uniqueSlugs([...methodColors.keys()])
  const declarations = (variant: "light" | "dark"): string => {
    const kindVars = [...kindColors.entries()]
      .map(([kind, pair]) => `--kind-color-${kindSlugs.get(kind) ?? slugify(kind)}: ${pair[variant]};`)
      .join(" ")
    const methodVars = [...methodColors.entries()]
      .map(([key, pair]) => `--method-color-${methodSlugs.get(key) ?? slugify(key)}: ${pair[variant]};`)
      .join(" ")
    return `${kindVars} ${methodVars}`
  }

  return `:root { ${declarations("light")} }
@media (prefers-color-scheme: dark) { :root { ${declarations("dark")} } }
:root[data-theme='dark'] { ${declarations("dark")} }
:root[data-theme='light'] { ${declarations("light")} }`
}

type NavChipGroup = { readonly edge: ResolvedNavigation; readonly sources: readonly string[] }

const navSource = (edge: ResolvedNavigation): string =>
  edge.expr === undefined ? `${edge.trigger} @ ${edge.from}` : `${edge.trigger} @ ${edge.from} — ${edge.expr}`

const navChipKey = (edge: ResolvedNavigation): string => `${edge.to}\u0000${edge.dynamic ? "1" : "0"}`

export const groupNavEdges = (edges: readonly ResolvedNavigation[]): readonly NavChipGroup[] => {
  const groups = new Map<string, { readonly edge: ResolvedNavigation; readonly sources: Set<string> }>()
  for (const edge of edges) {
    const key = navChipKey(edge)
    const group = groups.get(key) ?? { edge, sources: new Set<string>() }
    group.sources.add(navSource(edge))
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => ({ edge: group.edge, sources: [...group.sources].sort(byCodepoint) }))
}

export const activationLabel = (activation: Activation, locale: Locale): string => {
  switch (activation.kind) {
    case "url":
      return activation.template
    case "state":
      return t(locale, "activationStateDetail", { expr: activation.expr })
    case "host":
      return t(locale, "activationHostDetail", { pattern: activation.pattern })
    case "message":
      return t(locale, "activationMessageDetail", { messageType: activation.messageType })
    case "intercept":
      return t(locale, "activationInterceptDetail", { from: activation.from })
    case "route":
      return activation.navigator === null
        ? t(locale, "activationRouteNameDetail", { name: activation.name })
        : t(locale, "activationRouteDetail", { name: activation.name, navigator: activation.navigator })
  }
}

export const activationKindLabel = (activation: Activation, locale: Locale): string => {
  switch (activation.kind) {
    case "url":
      return t(locale, "activationKindUrl")
    case "state":
      return t(locale, "activationKindState")
    case "host":
      return t(locale, "activationKindHost")
    case "message":
      return t(locale, "activationKindMessage")
    case "intercept":
      return t(locale, "activationKindIntercept")
    case "route":
      return t(locale, "activationKindRoute")
  }
}

export const screenPrimaryLabel = (screen: Screen, locale: Locale): string => {
  if (screen.url !== null) return screen.url
  const activation = screen.activations[0]
  return activation ? activationLabel(activation, locale) : t(locale, "dash")
}

export const spliceLabel = (splice: AncestorRef["splice"]): string => {
  switch (splice.kind) {
    case "children":
      return "children"
    case "outlet":
      return splice.name === undefined ? `outlet <${splice.tag}>` : `outlet <${splice.tag} name="${splice.name}">`
    case "at":
      return `at ${splice.locator.export}#${splice.locator.path.join(".")}`
    case "slot":
      return `slot {${splice.name}}`
  }
}

const entryText = (entry: EntryRef): string => (entry.kind === "file" ? entry.file : `${entry.expr} ${entry.file}`)

export const searchIndex = (screen: Screen): string =>
  [
    screen.url ?? "",
    screen.title ?? "",
    screen.localId,
    screen.featureFlag ?? "",
    ...(screen.routeName === undefined ? [] : [screen.routeName]),
    ...screen.activations.flatMap((activation) => (activation.kind === "route" ? [activation.name] : [])),
    ...screen.entries.map(entryText),
  ]
    .join(" ")
    .toLowerCase()

const ROUTE_MODULE_NAMES: ReadonlySet<string> = new Set([
  "page",
  "layout",
  "route",
  "template",
  "default",
  "loading",
  "error",
  "not-found",
  "index",
  "__root",
  "root",
  "_layout",
])

export type RoutedFile = { readonly file: string; readonly url: string }

export const routedFiles = (screens: readonly Screen[]): readonly RoutedFile[] =>
  screens.flatMap((screen) => {
    const url = screen.url
    if (url === null) return []
    return screen.entries.flatMap((entry) => (entry.kind === "file" ? [{ file: entry.file, url }] : []))
  })

const directoryOf = (file: string): string => file.slice(0, Math.max(0, file.lastIndexOf("/")))

const urlSegments = (url: string): readonly string[] => url.split("/").filter((segment) => segment.length > 0)

const sharedLength = (a: readonly string[], b: readonly string[]): number => {
  const mismatch = a.findIndex((segment, index) => segment !== b[index])
  return mismatch === -1 ? a.length : mismatch
}

const commonUrlPrefix = (urls: readonly string[]): string => {
  const [first, ...rest] = urls.map(urlSegments)
  if (first === undefined) return "/"
  const length = rest.reduce((shortest, other) => Math.min(shortest, sharedLength(first, other)), first.length)
  return `/${first.slice(0, length).join("/")}`
}

const slashPrefixes = (file: string): readonly string[] =>
  file
    .split("/")
    .slice(0, -1)
    .map((_, index, parts) => `${parts.slice(0, index + 1).join("/")}/`)

type RouteIndex = {
  readonly byFile: ReadonlyMap<string, string>
  readonly byDirectory: ReadonlyMap<string, readonly string[]>
}

const appendTo = (map: Map<string, string[]>, key: string, value: string): void => {
  const existing = map.get(key)
  if (existing === undefined) {
    map.set(key, [value])
    return
  }
  existing.push(value)
}

const buildRouteIndex = (routed: readonly RoutedFile[]): RouteIndex => {
  const byFile = new Map<string, string>()
  const byDirectory = new Map<string, string[]>()
  for (const { file, url } of routed) {
    if (!byFile.has(file)) byFile.set(file, url)
    for (const dir of slashPrefixes(file)) appendTo(byDirectory, dir, url)
  }
  return { byFile, byDirectory }
}

const routeIndexCache = new WeakMap<readonly RoutedFile[], RouteIndex>()

const routeIndexOf = (routed: readonly RoutedFile[]): RouteIndex => {
  const cached = routeIndexCache.get(routed)
  if (cached !== undefined) return cached
  const index = buildRouteIndex(routed)
  routeIndexCache.set(routed, index)
  return index
}

const directoryRoute = (file: string, index: RouteIndex): string | null => {
  const urls = index.byDirectory.get(`${directoryOf(file)}/`)
  return urls === undefined ? null : commonUrlPrefix(urls)
}

export const componentRoute = (facts: FileFacts, routed: readonly RoutedFile[]): string | null => {
  const index = routeIndexOf(routed)
  const direct = index.byFile.get(facts.file)
  if (direct !== undefined) return direct
  return ROUTE_MODULE_NAMES.has(facts.component) ? directoryRoute(facts.file, index) : null
}

export const componentSearch = (facts: FileFacts, route: string | null): string =>
  [facts.component, facts.file, route ?? ""].join(" ").toLowerCase()

export const byRendersThenFile = (a: FileFacts, b: FileFacts): number =>
  b.renders.length - a.renders.length || byCodepoint(a.file, b.file)

export const extraValueText = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))

export const SEVERITY_ORDER = ["error", "warning", "info"] as const satisfies readonly Severity[]

export const appNameOf = (graph: AppGraph): string => graph.meta.appName ?? graph.meta.root

export const normalizeQuery = (query: string): string => query.trim().toLowerCase()

export const matchesQuery = (row: { readonly search: string }, normalized: string): boolean =>
  normalized === "" || row.search.includes(normalized)

export const queryTokens = (query: string): readonly string[] => query.toLowerCase().split(/\s+/).filter(Boolean)

export const matchesTokens = (haystack: string, tokens: readonly string[]): boolean =>
  tokens.every((token) => haystack.includes(token))

export const joinSearchText = (...parts: readonly (string | null)[]): string =>
  parts
    .filter((part): part is string => part !== null)
    .join(" ")
    .toLowerCase()

export const screenPaletteText = (screen: {
  readonly primaryLabel: string
  readonly title: string | null
  readonly id: string
}): string => joinSearchText(screen.primaryLabel, screen.title, screen.id)

export const componentPaletteText = (component: {
  readonly component: string
  readonly route: string | null
  readonly file: string
}): string => joinSearchText(component.component, component.route, component.file)

export const PALETTE_GROUP_LIMIT = 50

export const redirectPath = (target: string): string => target.replace(/\?[^/]*=[^/]*$/, "")

export const resolveRedirectTarget = <S extends { readonly id: string; readonly url: string | null }>(
  screens: readonly S[],
  target: string,
): S | undefined => {
  const path = redirectPath(target)
  return screens.find((screen) => screen.url === path || screen.id === path)
}

type NavGroupShape<E> = {
  readonly name: string
  readonly source: string
  readonly availableOnShells: readonly string[]
  readonly entries: readonly E[]
}

export type FlatNavEntry<E> = E & {
  readonly group: string
  readonly groupSource: string
  readonly groupShells: readonly string[]
}

export const flattenNavGroups = <E extends object>(groups: readonly NavGroupShape<E>[]): readonly FlatNavEntry<E>[] =>
  groups.flatMap((group) =>
    group.entries.map((entry) => ({
      ...entry,
      group: group.name,
      groupSource: group.source,
      groupShells: group.availableOnShells,
    })),
  )

export const groupNames = (groups: readonly { readonly name: string }[]): readonly string[] => [
  ...new Set(groups.map((group) => group.name)),
]

export const componentKinds = (components: readonly { readonly kind: string }[]): readonly string[] =>
  [...new Set(components.map((component) => component.kind))].sort(byCodepoint)

export const FINDING_SECTIONS = ["limitations", "dead-links", "orphans", "confidence", "diagnostics"] as const

export type FindingSectionId = (typeof FINDING_SECTIONS)[number]

export const SEVERITY_RANK = { error: 2, warning: 1, info: 0 } as const satisfies Record<Severity, number>

const countSeverity = (rows: readonly { readonly severity: Severity }[], severity: Severity): number =>
  rows.filter((row) => row.severity === severity).length

export const severityCounts = (rows: readonly { readonly severity: Severity }[]): Record<"all" | Severity, number> => ({
  all: rows.length,
  error: countSeverity(rows, "error"),
  warning: countSeverity(rows, "warning"),
  info: countSeverity(rows, "info"),
})

export const DEPTH_STAT_ID = "depth"

type StatShape = {
  readonly id: keyof HeaderCounts | typeof DEPTH_STAT_ID
  readonly primary: boolean
  readonly alarm: boolean
}

export const STAT_SPECS = [
  { id: "screens", primary: true, alarm: false },
  { id: "components", primary: true, alarm: false },
  { id: "endpoints", primary: true, alarm: false },
  { id: "deadLinks", primary: true, alarm: true },
  { id: "apiRoutes", primary: false, alarm: false },
  { id: "redirects", primary: false, alarm: false },
  { id: "renderEdges", primary: false, alarm: false },
  { id: "navEdges", primary: false, alarm: false },
  { id: DEPTH_STAT_ID, primary: false, alarm: false },
] as const satisfies readonly StatShape[]

export type StatSpec = (typeof STAT_SPECS)[number]

export type StatId = StatSpec["id"]

export const STAT_IDS: readonly StatId[] = STAT_SPECS.map((spec) => spec.id)

export const statValue = (
  meta: { readonly counts: HeaderCounts; readonly maxDepth: number },
  id: StatId,
): number => (id === DEPTH_STAT_ID ? meta.maxDepth : meta.counts[id])

export const isAlarmingStat = (stat: { readonly alarm: boolean }, value: number): boolean => stat.alarm && value > 0

export const isHiddenStat = (stat: { readonly id: StatId }, value: number): boolean =>
  stat.id === "apiRoutes" && value === 0

type BadgeSource = {
  readonly redirectTo: string | null
  readonly featureFlag: string | null
  readonly devOnly: boolean
  readonly addressable: boolean
  readonly shell: string | null
}

export const SCREEN_BADGE_IDS = ["redirect", "flag", "devOnly", "unaddressable", "shell"] as const

export type ScreenBadgeId = (typeof SCREEN_BADGE_IDS)[number]

export type ScreenBadge = { readonly id: ScreenBadgeId; readonly value: string | null }

const textBadge = (value: string | null): readonly (string | null)[] => (value === null ? [] : [value])

const flagBadge = (on: boolean): readonly (string | null)[] => (on ? [null] : [])

const SCREEN_BADGE_RULES = {
  redirect: (screen) => textBadge(screen.redirectTo),
  flag: (screen) => textBadge(screen.featureFlag),
  devOnly: (screen) => flagBadge(screen.devOnly),
  unaddressable: (screen) => flagBadge(!screen.addressable),
  shell: (screen) => textBadge(screen.shell),
} as const satisfies Record<ScreenBadgeId, (screen: BadgeSource) => readonly (string | null)[]>

export const screenBadges = (screen: BadgeSource): readonly ScreenBadge[] =>
  SCREEN_BADGE_IDS.flatMap((id) => SCREEN_BADGE_RULES[id](screen).map((value) => ({ id, value })))
