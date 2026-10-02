import { confidenceStatus } from "../core/confidence.js"
import { routeNameField } from "../core/model.js"
import type {
  Activation,
  AncestorRef,
  AppGraph,
  Diagnostic,
  Endpoint,
  EntryRef,
  FileFacts,
  NavEntry,
  NavGroup,
  ResolvedNavigation,
  Screen,
  SectionConfidence,
  ShellReport,
} from "../core/model.js"
import { sortedEntries, uniqueBy } from "../core/order.js"
import { endpointKey as graphEndpointKey } from "../core/graph/keys.js"
import { countsAsScreen } from "../core/graph/screens.js"
import { edgeGeometry, layoutGraph } from "./html-graph.js"
import { byCodepoint, isApiScreen } from "./html-util.js"
import { viaRedirectField } from "./view-index.js"
import {
  SEVERITY_ORDER,
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
  uniqueSlugs,
} from "./report-derive.js"
import type { RoutedFile } from "./report-derive.js"
import type { EncodedTreeNode, TreeRef } from "./tree-intern.js"
import { buildPathTable, internForests, treeFiles } from "./tree-intern.js"
import type { Locale } from "./strings.js"
import { stringTable } from "./strings.js"

export type ReportPayloadOptions = {
  readonly locale: Locale
  readonly generatedAt: string | null
}

const sortedUnique = (values: readonly string[]): readonly string[] => [...new Set(values)].sort(byCodepoint)

const slugRows = (keys: readonly string[]) => {
  const slugs = uniqueSlugs(keys)
  return sortedUnique(keys).map((key) => ({ key, slug: slugs.get(key) ?? slugify(key) }))
}

const endpointRow = (endpoint: Endpoint) => ({
  method: endpoint.method,
  url: endpoint.url,
  transport: endpoint.transport,
  client: endpoint.client,
  key: endpointKey(endpoint),
})

const navChipRows = (edges: readonly ResolvedNavigation[]) =>
  groupNavEdges(edges).map(({ edge, sources }) => ({
    to: edge.to,
    matchedRoute: edge.matchedRoute,
    trigger: edge.trigger,
    dynamic: edge.dynamic,
    from: edge.from,
    sources,
    ...viaRedirectField(edge),
  }))

const activationRow = (activation: Activation, locale: Locale) => ({
  kind: activation.kind,
  label: activationLabel(activation, locale),
  kindLabel: activationKindLabel(activation, locale),
})

const entryRow = (entry: EntryRef) =>
  entry.kind === "file"
    ? { kind: entry.kind, file: entry.file, exportName: entry.exportName, expr: null, line: null }
    : { kind: entry.kind, file: entry.file, exportName: null, expr: entry.expr, line: entry.line }

const ancestorRow = (ancestor: AncestorRef) => ({
  file: ancestor.file,
  exportName: ancestor.exportName,
  role: ancestor.role,
  spliceKind: ancestor.splice.kind,
  spliceLabel: spliceLabel(ancestor.splice),
})

const extraRows = (extra: Readonly<Record<string, readonly unknown[]>>) =>
  sortedEntries(extra).map(([channel, values]) => ({ channel, values: values.map(extraValueText) }))

const factsRow = (facts: Screen["facts"]) => ({
  endpoints: facts.endpoints.map(endpointRow),
  navigations: facts.navigations.map((navigation) => ({
    to: navigation.to,
    trigger: navigation.trigger,
    dynamic: navigation.dynamic,
  })),
  stores: facts.stores,
  queryKeys: facts.queryKeys,
  mutations: facts.mutations,
  i18nNamespaces: facts.i18nNamespaces,
  testIds: facts.testIds,
  formSchemas: facts.formSchemas,
  formFields: facts.formFields,
  featureGates: facts.featureGates,
  hooks: facts.hooks,
  messages: facts.messages,
  extra: extraRows(facts.extra),
})

export const screenRow = (screen: Screen, locale: Locale) => ({
  id: screen.id,
  localId: screen.localId,
  source: screen.source,
  url: screen.url,
  title: screen.title,
  ...routeNameField(screen),
  kindTag: screen.kindTag,
  auth: screen.auth,
  featureFlag: screen.featureFlag,
  devOnly: screen.devOnly,
  addressable: screen.addressable,
  redirectTo: screen.redirectTo,
  shell: screen.shell,
  params: screen.params,
  activations: screen.activations.map((activation) => activationRow(activation, locale)),
  entries: screen.entries.map(entryRow),
  ancestors: screen.ancestors.map(ancestorRow),
  tree: screen.tree,
  reachableCount: screen.reachable.length,
  facts: factsRow(screen.facts),
  navChips: navChipRows(screen.navigatesTo),
  provenance: screen.provenance,
  primaryLabel: screenPrimaryLabel(screen, locale),
  search: searchIndex(screen),
  isApi: isApiScreen(screen),
})

export const orderedScreens = (screens: readonly Screen[]): readonly Screen[] => [
  ...screens.filter((screen) => !isApiScreen(screen)),
  ...screens.filter(isApiScreen),
]

const shellRow = ([id, shell]: readonly [string, ShellReport]) => ({
  id,
  file: shell.file,
  layouts: shell.layouts,
  tree: shell.tree,
  navChips: navChipRows(shell.navigatesTo),
  endpoints: shell.endpoints.map(endpointRow),
  stores: shell.stores,
  i18nNamespaces: shell.i18nNamespaces,
  testIds: shell.testIds,
})

const componentRow = (facts: FileFacts, routed: readonly RoutedFile[]) => {
  const route = componentRoute(facts, routed)
  return {
    file: facts.file,
    component: facts.component,
    kind: facts.kind,
    route,
    renders: facts.renders.length,
    endpoints: facts.endpoints.length,
    mutations: facts.mutations,
    stores: facts.stores,
    search: componentSearch(facts, route),
  }
}

export const componentRows = (graph: AppGraph) => {
  const routed = routedFiles(graph.screens)
  return Object.values(graph.components)
    .sort(byRendersThenFile)
    .map((facts) => componentRow(facts, routed))
}

export const navEntryRow = (entry: NavEntry, knownScreens: ReadonlySet<string>) => ({
  path: entry.path,
  parentPath: entry.parentPath,
  label: entry.label,
  labelKey: entry.labelKey,
  featureFlag: entry.featureFlag,
  source: entry.source,
  file: entry.file,
  line: entry.line,
  resolvedScreen: entry.resolvedScreen,
  linkedScreen: entry.resolvedScreen !== null && knownScreens.has(entry.resolvedScreen) ? entry.resolvedScreen : null,
  ...viaRedirectField(entry),
})

export const navGroupRow = (group: NavGroup, knownScreens: ReadonlySet<string>) => ({
  name: group.name,
  source: group.source,
  score: group.score,
  availableOnShells: group.availableOnShells,
  entries: group.entries.map((entry) => navEntryRow(entry, knownScreens)),
})

export const confidenceRow = (entry: SectionConfidence) => ({
  section: entry.section,
  count: entry.count,
  enablingDependency: entry.enablingDependency,
  dependencyInstalled: entry.dependencyInstalled,
  level: entry.level,
  status: confidenceStatus(entry),
})

const diagnosticRow = (diagnostic: Diagnostic) => ({
  severity: diagnostic.severity,
  code: diagnostic.code,
  message: diagnostic.message,
  plugin: diagnostic.plugin,
  file: diagnostic.file ?? null,
  line: diagnostic.line ?? null,
  screenId: diagnostic.screenId ?? null,
})

export const orderedDiagnostics = (diagnostics: readonly Diagnostic[]) =>
  SEVERITY_ORDER.flatMap((severity) => diagnostics.filter((diagnostic) => diagnostic.severity === severity)).map(
    diagnosticRow,
  )

export const headerCounts = (graph: AppGraph) => {
  const apiRoutes = graph.screens.filter(isApiScreen).length
  return {
    screens: graph.screens.filter(countsAsScreen).length,
    apiRoutes,
    redirects: graph.redirects.length,
    components: Object.keys(graph.components).length,
    renderEdges: Object.values(graph.components).reduce((sum, facts) => sum + facts.renders.length, 0),
    navEdges: graph.navigation.length,
    endpoints: uniqueBy(collectEndpoints(graph), graphEndpointKey).length,
    deadLinks: graph.deadNavLinks.length,
  }
}

export type HeaderCounts = ReturnType<typeof headerCounts>

const metaRow = (graph: AppGraph, generatedAt: string | null) => ({
  appName: appNameOf(graph),
  root: graph.meta.root,
  counts: headerCounts(graph),
  maxDepth: graph.meta.maxDepth,
  emptyResult: graph.meta.emptyResult === true,
  emptyReason: graph.meta.emptyReason ?? null,
  limitations: graph.meta.limitations,
  generatedAt,
  appgraphVersion: graph.meta.appgraphVersion,
})

const graphRow = (graph: AppGraph) => {
  const layout = layoutGraph(graph)
  const authById = new Map(graph.screens.map((screen) => [screen.id, screen.auth]))
  return {
    width: layout.width,
    height: layout.height,
    nodes: layout.nodes.map((node) => ({
      id: node.id,
      url: node.url,
      title: node.title,
      protected: node.protected,
      auth: authById.get(node.id) ?? "unknown",
      x: node.x,
      y: node.y,
      labelEnd: node.labelEnd,
      prefix: node.prefix,
      radius: node.radius,
    })),
    headers: layout.headers.map((header) => ({ ...header })),
    edges: edgeGeometry(layout).map((edge) => ({ ...edge })),
  }
}

export const buildReportPayload = (graph: AppGraph, options: ReportPayloadOptions) => {
  const knownScreens = new Set(graph.screens.map((screen) => screen.id))
  return {
    meta: metaRow(graph, options.generatedAt),
    locale: options.locale,
    strings: stringTable(options.locale),
    screens: orderedScreens(graph.screens).map((screen) => screenRow(screen, options.locale)),
    shells: sortedEntries(graph.shells).map(shellRow),
    components: componentRows(graph),
    navGroups: graph.navGroups.map((group) => navGroupRow(group, knownScreens)),
    deadNavLinks: graph.deadNavLinks.map((entry) => navEntryRow(entry, knownScreens)),
    orphanScreens: graph.orphanScreens,
    confidence: graph.meta.confidence.map(confidenceRow),
    diagnostics: orderedDiagnostics(graph.diagnostics),
    kinds: slugRows(collectKinds(graph)),
    methods: slugRows(collectEndpointKeys(graph)),
    graph: graphRow(graph),
  }
}

export type ReportPayload = ReturnType<typeof buildReportPayload>

export type ScreenPayload = ReportPayload["screens"][number]

export type ComponentPayload = ReportPayload["components"][number]

export const reportPaletteCss = (graph: AppGraph): string =>
  renderPaletteCss(buildColorMap(collectKinds(graph)), buildColorMap(collectEndpointKeys(graph)))

const unicodeEscape = (ch: string): string => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`

type ShellPayload = ReportPayload["shells"][number]

type WithInternedTree<T> = Omit<T, "tree"> & { readonly tree: readonly TreeRef[] }

export type SerializedReportPayload = Omit<ReportPayload, "screens" | "shells"> & {
  readonly paths: readonly string[]
  readonly subtrees: readonly EncodedTreeNode[]
  readonly screens: readonly WithInternedTree<ScreenPayload>[]
  readonly shells: readonly WithInternedTree<ShellPayload>[]
}

const forestAt = (forests: readonly (readonly TreeRef[])[], index: number): readonly TreeRef[] => forests[index] ?? []

export const toSerializedPayload = (payload: ReportPayload): SerializedReportPayload => {
  const forests = [...payload.screens.map((screen) => screen.tree), ...payload.shells.map((shell) => shell.tree)]
  const table = buildPathTable(treeFiles(forests))
  const interned = internForests(forests, { paths: table })
  const shellOffset = payload.screens.length
  return {
    ...payload,
    paths: table.paths,
    subtrees: interned.subtrees,
    screens: payload.screens.map((screen, index) => ({ ...screen, tree: forestAt(interned.forests, index) })),
    shells: payload.shells.map((shell, index) => ({ ...shell, tree: forestAt(interned.forests, shellOffset + index) })),
  }
}

export const serializePayload = (payload: ReportPayload): string =>
  JSON.stringify(toSerializedPayload(payload)).replace(/[<>&\u2028\u2029]/g, unicodeEscape)
