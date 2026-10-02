import { CONDITION_MAX } from "../core/ast.js"
import { confidenceStatus } from "../core/confidence.js"
import type {
  Activation,
  AncestorRef,
  AppGraph,
  AppgraphConfig,
  Endpoint,
  EntryRef,
  GraphRedirect,
  NavEntry,
  NodeLocator,
  RedirectResolution,
  Screen,
  SlotBranch,
  SpliceMode,
} from "../core/model.js"
import { routeNameField } from "../core/model.js"
import { by, sortBy, sortedUnique, thenBy } from "../core/order.js"
import type { TruncatedString } from "./yaml.js"
import { markTruncated, toYaml } from "./yaml.js"

export const DEFAULT_BIN_NAME = "appgraph"

export type ViewOptions = {
  readonly binName?: string
  readonly includeTestIds?: boolean
  readonly testIdAttribute?: string | null
  readonly redirects?: AppgraphConfig["redirects"]
}

export type EmittedValue = unknown

export const compact = <T extends Record<string, EmittedValue>>(value: T): Record<string, EmittedValue> =>
  Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== null && item !== undefined && !(Array.isArray(item) && item.length === 0),
    ),
  )

const QUERY_KEY_MAX = 60

// `ast.ts` truncates condition text at CONDITION_MAX and the query-key fallback at 60 chars without
// recording a flag on the resulting string, so a value sitting on the boundary is treated as
// truncated. Over-marking is safe: it only forces quoting, which is valid YAML for any scalar.
const atBoundary = (value: string, max: number): string | TruncatedString =>
  value.length >= max ? markTruncated(value) : value

export const conditionScalar = (value: string): string | TruncatedString => atBoundary(value, CONDITION_MAX)

export const queryKeyScalar = (value: string): string | TruncatedString => atBoundary(value, QUERY_KEY_MAX)

export const detailCommand = (options: ViewOptions): string =>
  `${options.binName ?? DEFAULT_BIN_NAME} --screen=<id> --format=detail`

export const isAddressable = (screen: Screen): boolean => screen.addressable && screen.url !== null

export const sortedScreens = (screens: readonly Screen[]): readonly Screen[] =>
  [...screens].sort(thenBy(by((screen: Screen) => screen.url ?? ""), by((screen: Screen) => screen.id)))

export const locatorView = (locator: NodeLocator): Record<string, EmittedValue> => ({
  export: locator.export,
  path: [...locator.path],
})

export const spliceView = (splice: SpliceMode): Record<string, EmittedValue> => {
  if (splice.kind === "outlet")
    return splice.name === undefined
      ? { kind: splice.kind, tag: splice.tag }
      : { kind: splice.kind, tag: splice.tag, name: splice.name }
  if (splice.kind === "at") return { kind: splice.kind, locator: locatorView(splice.locator) }
  if (splice.kind === "slot") return { kind: splice.kind, name: splice.name }
  return { kind: splice.kind }
}

export const slotBranchView = (branch: SlotBranch): Record<string, EmittedValue> => ({
  file: branch.file,
  exportName: branch.exportName,
  splice: spliceView(branch.splice),
  conditions: branch.conditions.map(conditionScalar),
})

export const ancestorView = (ancestor: AncestorRef): Record<string, EmittedValue> => ({
  file: ancestor.file,
  exportName: ancestor.exportName,
  role: ancestor.role,
  splice: spliceView(ancestor.splice),
  ...(ancestor.branches === undefined || ancestor.branches.length === 0
    ? {}
    : { branches: ancestor.branches.map(slotBranchView) }),
})

export const activationView = (activation: Activation): Record<string, EmittedValue> => {
  if (activation.kind === "url") {
    return compact({ kind: activation.kind, template: activation.template, params: [...activation.params] })
  }
  if (activation.kind === "state") {
    return { kind: activation.kind, holder: activation.holder, when: conditionScalar(activation.expr) }
  }
  if (activation.kind === "host") return { kind: activation.kind, pattern: activation.pattern }
  if (activation.kind === "intercept") {
    return compact({ kind: activation.kind, from: activation.from, slot: activation.slot, file: activation.file })
  }
  if (activation.kind === "message") return { kind: activation.kind, messageType: activation.messageType }
  if (activation.kind === "route") {
    return compact({ kind: activation.kind, name: activation.name, navigator: activation.navigator })
  }
  return activation satisfies never
}

export const entryView = (entry: EntryRef): Record<string, EmittedValue> =>
  entry.kind === "file"
    ? compact({
        kind: entry.kind,
        file: entry.file,
        exportName: entry.exportName,
        at: entry.at === undefined ? null : locatorView(entry.at),
        platform: entry.platform,
      })
    : { kind: entry.kind, file: entry.file, line: entry.line, expr: conditionScalar(entry.expr) }

export const entryFile = (screen: Screen): string | null => {
  const first = screen.entries[0]
  if (first === undefined || first.kind !== "file") return null
  return first.file
}

const unresolvedEntry = (screen: Screen): string | null => {
  const first = screen.entries[0]
  if (first === undefined || first.kind !== "opaque") return null
  return `${first.file}:${first.line} ${first.expr}`
}

export const endpointView = (endpoint: Endpoint): Record<string, EmittedValue> =>
  compact({
    method: endpoint.method,
    url: endpoint.url,
    transport: endpoint.transport,
    client: endpoint.client,
  })

const endpointKey = (endpoint: Endpoint): string =>
  `${endpoint.transport} ${endpoint.method} ${endpoint.url} ${endpoint.client ?? ""}`

export const endpointsByTransport = (endpoints: readonly Endpoint[]): Record<string, EmittedValue> => {
  const sorted = sortBy(endpoints, endpointKey)
  return compact({
    http: sorted.filter((endpoint) => endpoint.transport === "http").map(endpointView),
    rpc: sorted.filter((endpoint) => endpoint.transport !== "http").map(endpointView),
  })
}

const allEndpoints = (graph: AppGraph): readonly Endpoint[] => [
  ...graph.screens.flatMap((screen) => [...screen.facts.endpoints]),
  ...Object.values(graph.shells).flatMap((shell) => [...shell.endpoints]),
  ...Object.values(graph.components).flatMap((component) => [...component.endpoints]),
]

const transportCounts = (graph: AppGraph): { readonly http: number; readonly rpc: number } => {
  const seen = new Map<string, Endpoint>()
  for (const endpoint of allEndpoints(graph)) seen.set(endpointKey(endpoint), endpoint)
  const values = [...seen.values()]
  return {
    http: values.filter((endpoint) => endpoint.transport === "http").length,
    rpc: values.filter((endpoint) => endpoint.transport !== "http").length,
  }
}

const redirectAlternativesField = ({ alternatives }: RedirectResolution) =>
  alternatives === undefined || alternatives.length < 2
    ? {}
    : { alternatives: alternatives.map(({ to, condition }) => ({ to, condition })) }

export const viaRedirectField = ({ viaRedirect: via }: { readonly viaRedirect?: RedirectResolution }) =>
  via === undefined
    ? {}
    : {
        viaRedirect: {
          from: via.from,
          to: via.to,
          ...(via.declaredAt === undefined ? {} : { declaredAt: via.declaredAt }),
          ...(via.condition === undefined ? {} : { condition: via.condition }),
          ...redirectAlternativesField(via),
        },
      }

export const placementAmbiguousField = (screen: Pick<Screen, "placementAmbiguous">) =>
  screen.placementAmbiguous === undefined ? {} : { placementAmbiguous: [...screen.placementAmbiguous] }

export const redirectView = (redirect: GraphRedirect): Record<string, EmittedValue> =>
  compact({
    from: redirect.from,
    to: redirect.to,
    declaredAt: redirect.declaredAt,
    condition: redirect.condition,
    conditional: redirect.conditional,
  })

export const redirectsView = (graph: AppGraph): readonly Record<string, EmittedValue>[] =>
  sortBy(graph.redirects, (redirect) => `${redirect.from} ${redirect.to}`).map(redirectView)

export const goesTo = (screen: Screen): readonly string[] =>
  sortedUnique(
    screen.navigatesTo.flatMap((edge) => (edge.matchedRoute === null ? [] : [edge.matchedRoute])),
  )

export const navigationView = (screen: Screen): readonly Record<string, EmittedValue>[] =>
  sortBy(screen.navigatesTo, (edge) => `${edge.to} ${edge.from} ${edge.trigger}`).map((edge) =>
    compact({
      to: edge.to,
      matchedRoute: edge.matchedRoute,
      resolves: edge.matchedRoute === null ? false : null,
      trigger: edge.trigger,
      dynamic: edge.dynamic,
      from: edge.from,
      ...viaRedirectField(edge),
      ...routeNameField(edge),
    }),
  )

export const confidenceView = (graph: AppGraph): readonly Record<string, EmittedValue>[] =>
  sortBy(graph.meta.confidence, (entry) => entry.section).map((entry) =>
    compact({
      section: entry.section,
      status: confidenceStatus(entry),
      probed: entry.enablingDependency ?? "always-on extractor",
      dependencyInstalled: entry.enablingDependency === null ? null : entry.dependencyInstalled,
      matched: entry.count,
    }),
  )

export const hasAnyTestIds = (graph: AppGraph): boolean =>
  graph.screens.some((screen) => screen.facts.testIds.length > 0) ||
  Object.values(graph.shells).some((shell) => shell.testIds.length > 0) ||
  Object.values(graph.components).some((component) => component.testIds.length > 0)

const NO_ATTRIBUTE_NOTE =
  "This repository declares no test-id attributes; select elements by role or visible text."

const NO_MATCH_NOTE =
  "The probe for this attribute matched nothing in this repository; select elements by role or visible text."

export type SelectorPolicy = {
  readonly present: boolean
  readonly note: string
  readonly block: Record<string, EmittedValue>
}

export const selectorPolicy = (graph: AppGraph, options: ViewOptions): SelectorPolicy => {
  const attribute = options.testIdAttribute ?? null
  if (attribute === null) {
    return {
      present: false,
      note: NO_ATTRIBUTE_NOTE,
      block: { status: "no-attribute-detected", note: NO_ATTRIBUTE_NOTE },
    }
  }
  if (!hasAnyTestIds(graph)) {
    return {
      present: false,
      note: NO_MATCH_NOTE,
      block: { attribute, status: "attribute-yielded-nothing", note: NO_MATCH_NOTE },
    }
  }
  const note = `Screens list the ${attribute} values reachable from them under testIds.`
  return { present: true, note, block: { attribute, status: "present", note } }
}

const selectorFields = (
  testIds: readonly string[],
  policy: SelectorPolicy,
  options: ViewOptions,
): Record<string, EmittedValue> => {
  if (!policy.present) return {}
  if (options.includeTestIds === false) return { testIdCount: testIds.length }
  return { testIds: sortedUnique(testIds) }
}

const AUTH_HEDGE =
  "auth: protected → the screen sits behind an auth guard; the redirect target for an unauthenticated visitor was not configured and is not statically known."

const FLAG_HEDGE =
  "flag: the screen is gated by a feature flag; what the app does when the flag is off was not configured and is not statically known."

export const authNote = (options: ViewOptions): string => {
  const target = options.redirects?.unauthenticated
  return target === undefined
    ? AUTH_HEDGE
    : `auth: protected → log in first; the configured redirect for an unauthenticated visitor is ${target}.`
}

export const flagNote = (options: ViewOptions): string => {
  const target = options.redirects?.flagOff
  return target === undefined
    ? FLAG_HEDGE
    : `flag: the configured redirect when the feature flag is off is ${target} — a different screen, not an error.`
}

const RPC_NOTE =
  "endpoints with transport: rpc are server functions the app invokes; a browser agent cannot call them directly."

const DEAD_LINK_NOTE =
  "deadNavLinks: navigation entries whose target matches no screen. Following one leads nowhere — do not retry it."

const STATE_SCREEN_NOTE =
  "stateScreens: these screens have no URL; they are reached through in-app state or a named route, stated under activation. Reach them through the app, not by navigating."

const EMPTY_RESULT_NOTE =
  "This file records a ZERO-SCREEN result (meta.emptyResult). It is not evidence that the application has no screens — the run found none."

export const readMe = (graph: AppGraph, options: ViewOptions, policy: SelectorPolicy): readonly string[] => {
  const addressable = graph.screens.filter(isAddressable)
  const lines: string[] = []
  if (graph.meta.emptyResult === true) lines.push(EMPTY_RESULT_NOTE)
  if (graph.screens.some((screen) => screen.auth === "protected")) lines.push(authNote(options))
  if (graph.screens.some((screen) => screen.featureFlag !== null)) lines.push(flagNote(options))
  if (addressable.some((screen) => screen.params.length > 0)) {
    lines.push("params: :name segments need a real record id; static analysis cannot supply one.")
  }
  if (graph.screens.some((screen) => goesTo(screen).length > 0)) {
    lines.push("goesTo: in-app navigation found in the screen's own code; menu links are listed under menu.")
  }
  if (graph.deadNavLinks.length > 0) lines.push(DEAD_LINK_NOTE)
  if (graph.screens.some((screen) => !isAddressable(screen))) lines.push(STATE_SCREEN_NOTE)
  if (transportCounts(graph).rpc > 0) lines.push(RPC_NOTE)
  lines.push(policy.note)
  return lines
}

const INDEX_PURPOSE =
  "Navigation index for browser agents: go straight to a URL instead of clicking through the UI. Everything under screens has a URL you can open; named screens with no URL sit under stateScreens."

export const metaView = (
  graph: AppGraph,
  options: ViewOptions,
  policy: SelectorPolicy,
  purpose: string,
): Record<string, EmittedValue> =>
  compact({
    purpose,
    schemaVersion: graph.meta.schemaVersion,
    appgraphVersion: graph.meta.appgraphVersion,
    appName: graph.meta.appName,
    root: graph.meta.root,
    screenSources: sortedUnique(graph.meta.screenSources),
    maxDepth: graph.meta.maxDepth,
    emptyResult: graph.meta.emptyResult === true ? true : null,
    emptyReason: graph.meta.emptyReason ?? null,
    detailCommand: detailCommand(options),
    counts: Object.fromEntries(sortBy(Object.entries(graph.meta.counts), ([key]) => key)),
    endpointTransports: transportCounts(graph),
    confidence: confidenceView(graph),
    readMe: readMe(graph, options, policy),
    // The index is the artifact an agent loads; the `full` graph is the one a human opens. The stated
    // limitations belong where they are read, so `readMe` (what to do with this file) and `limitations` (what this file cannot tell
    // you) travel together. Cost: a flat ~3.4 KB regardless of screen count — the strings are
    // constant, so the per-screen budget the size test guards is unaffected.
    limitations: [...graph.meta.limitations],
  })

const screenRow = (
  screen: Screen,
  policy: SelectorPolicy,
  options: ViewOptions,
): Record<string, EmittedValue> =>
  compact({
    url: screen.url,
    id: screen.url === screen.id ? null : screen.id,
    title: screen.title,
    auth: screen.auth,
    flag: screen.featureFlag,
    devOnly: screen.devOnly ? true : null,
    kindTag: screen.kindTag,
    params: [...screen.params],
    redirectTo: screen.redirectTo,
    entry: entryFile(screen),
    entryUnresolved: unresolvedEntry(screen),
    ...placementAmbiguousField(screen),
    goesTo: goesTo(screen),
    ...selectorFields(screen.facts.testIds, policy, options),
  })

const stateScreenRow = (
  screen: Screen,
  policy: SelectorPolicy,
  options: ViewOptions,
): Record<string, EmittedValue> =>
  compact({
    id: screen.id,
    title: screen.title,
    activation: screen.activations.map(activationView),
    auth: screen.auth,
    flag: screen.featureFlag,
    devOnly: screen.devOnly ? true : null,
    entry: entryFile(screen),
    entryUnresolved: unresolvedEntry(screen),
    ...placementAmbiguousField(screen),
    goesTo: goesTo(screen),
    ...selectorFields(screen.facts.testIds, policy, options),
  })

const navEntryRow = (entry: NavEntry): Record<string, EmittedValue> =>
  compact({
    path: entry.path,
    title: entry.label,
    titleKey: entry.labelKey,
    flag: entry.featureFlag,
    parentPath: entry.parentPath,
    deadLink: entry.resolvedScreen === null ? true : null,
    ...viaRedirectField(entry),
  })

const menuView = (graph: AppGraph): readonly Record<string, EmittedValue>[] =>
  sortBy(graph.navGroups, (group) => `${group.name} ${group.source}`).map((group) =>
    compact({
      group: group.name,
      source: group.source,
      score: group.score,
      availableOnShells: sortedUnique(group.availableOnShells),
      entries: sortBy(group.entries, (entry) => `${entry.path} ${entry.file} ${entry.line}`).map(navEntryRow),
    }),
  )

export const deadNavLinksView = (graph: AppGraph): readonly Record<string, EmittedValue>[] =>
  sortBy(graph.deadNavLinks, (entry) => `${entry.path} ${entry.file} ${entry.line}`).map((entry) =>
    compact({
      label: entry.label,
      labelKey: entry.labelKey,
      target: entry.path,
      source: entry.source,
      file: entry.file,
      line: entry.line,
      resolves: false,
    }),
  )

export const indexDocument = (graph: AppGraph, options: ViewOptions = {}): Record<string, EmittedValue> => {
  const policy = selectorPolicy(graph, options)
  const screens = sortedScreens(graph.screens)
  const addressable = screens.filter(isAddressable)
  const stateScreens = screens.filter((screen) => !isAddressable(screen))
  return {
    meta: metaView(graph, options, policy, INDEX_PURPOSE),
    selectors: policy.block,
    ...compact({
      menu: menuView(graph),
      deadNavLinks: deadNavLinksView(graph),
    }),
    // Always present, even empty: §10.2 makes `screens: []` the greppable shape of a zero-screen run.
    screens: addressable.map((screen) => screenRow(screen, policy, options)),
    ...compact({
      stateScreens: stateScreens.map((screen) => stateScreenRow(screen, policy, options)),
      redirects: redirectsView(graph),
      orphanScreens: sortedUnique(graph.orphanScreens),
    }),
  }
}

export const emitIndexView = (graph: AppGraph, options: ViewOptions = {}): string =>
  toYaml(indexDocument(graph, options))
