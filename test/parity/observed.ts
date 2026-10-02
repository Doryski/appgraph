import type { AnalyzeResult } from "../../src/pipeline/run.js"
import type { AppGraph, Screen } from "../../src/core/model.js"
import type { ParitySnapshot, ScreenContract, ScreenCoverage } from "./model.js"

/**
 * Projects an `AppGraph` into the same shape `golden.ts` projects the golden document into.
 *
 * `stateScreens` (`url === null`) are excluded from the contract and coverage tables: gate 1 is about
 * "what can I navigate to by URL", and the golden has no concept of a state-activated screen, so
 * there is nothing to compare them against. They are surfaced separately as `stateScreenIds` so a gate
 * can still notice them appearing or vanishing.
 */
export type ObservedSnapshot = ParitySnapshot & {
  readonly stateScreenIds: readonly string[]
  readonly diagnosticCounts: Readonly<Record<string, number>>
  readonly graph: AppGraph
}

const addressable = (screen: Screen): boolean => screen.addressable && screen.url !== null

const urlOf = (screen: Screen): string => {
  if (screen.url === null) throw new Error(`screen '${screen.id}' has no url`)
  return screen.url
}

const entry0 = (screen: Screen): string | null => {
  const first = screen.entries[0]
  if (first === undefined) return null
  return first.kind === "file" ? first.file : null
}

export const observedSnapshot = (result: AnalyzeResult, label: string): ObservedSnapshot => {
  const graph = result.graph
  const screens = [...graph.screens].filter(addressable).sort((a, b) => (urlOf(a) < urlOf(b) ? -1 : 1))

  const contracts: readonly ScreenContract[] = screens.map((screen) => ({
    url: urlOf(screen),
    entry0: entry0(screen),
    params: [...screen.params],
    auth: screen.auth,
    redirectTo: screen.redirectTo,
  }))

  const entryLists = screens.map((screen) => ({
    url: urlOf(screen),
    entries: screen.entries.flatMap((entry) => (entry.kind === "file" ? [entry.file] : [])),
  }))

  const coverage: readonly ScreenCoverage[] = screens.map((screen) => ({
    url: urlOf(screen),
    reachable: screen.reachable.length,
    endpoints: screen.facts.endpoints.length,
    testIds: screen.facts.testIds.length,
    stores: screen.facts.stores.length,
    queryKeys: screen.facts.queryKeys.length,
    i18nNamespaces: screen.facts.i18nNamespaces.length,
    formSchemas: screen.facts.formSchemas.length,
    formFields: screen.facts.formFields.length,
    featureGates: screen.facts.featureGates.length,
  }))

  const endpointsByScreen = Object.fromEntries(
    screens.map((screen) => [
      urlOf(screen),
      [...screen.facts.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.url}`)].sort(),
    ]),
  )

  const diagnosticCounts: Record<string, number> = {}
  for (const diagnostic of result.diagnostics) {
    diagnosticCounts[diagnostic.code] = (diagnosticCounts[diagnostic.code] ?? 0) + 1
  }

  return {
    label,
    contracts,
    entryLists,
    coverage,
    endpointsByScreen,
    navigationEdges: [
      ...graph.navigation.map((edge) => `${edge.from} -> ${edge.to} via ${edge.via} (${edge.trigger})`),
    ].sort(),
    // The golden has exactly one nav source; appgraph models N nav groups. Flattening in declared
    // order is the faithful comparison — the gate asserts the SET of paths, not the grouping.
    menuPaths: graph.navGroups.flatMap((group) => group.entries.map((entry) => entry.path)),
    shells: Object.keys(graph.shells),
    componentKeys: Object.keys(graph.components),
    counts: { ...graph.meta.counts },
    stateScreenIds: [...graph.screens.filter((screen) => !addressable(screen)).map((screen) => screen.id)].sort(),
    diagnosticCounts,
    graph,
  }
}
