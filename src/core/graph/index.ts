import type { AppGraph, AppGraphMeta, GraphRedirect } from "../model.js"
import { by, sortStrings, sortedRecord, uniqueBy } from "../order.js"
import { createScreenBuilder, entriesByAncestor, mountedByFile, routeEntryFiles } from "./build-screen.js"
import { createChainPlanner } from "./chain.js"
import { resolveScreenConflicts } from "./conflicts.js"
import { createGraphContext } from "./context.js"
import { endpointKey } from "./keys.js"
import { GRAPH_LIMITATIONS } from "./limitations.js"
import { reconcileNavGroups } from "./nav.js"
import { navigationOf } from "./navigation.js"
import { createPlacement } from "./placement.js"
import { graphRedirectKey, graphRedirectOf, graphRedirectOrder } from "./redirects.js"
import { createRenderEdges } from "./render-edges.js"
import { createRoots } from "./roots.js"
import { unknownRouteNameTarget, unknownRouteNames } from "./route-names.js"
import { countsAsScreen, isApiRouteScreen } from "./screens.js"
import { buildShells } from "./shells.js"
import { createSpliceJudge } from "./splice.js"
import { createSpliceScanner } from "./splice-scan.js"
import { createTargetResolver } from "./targets.js"
import type { BuildGraphInput } from "./types.js"
import { createWalk } from "./walk.js"

export { DEFAULT_MAX_DEPTH, MAX_REDIRECT_HOPS, NAV_CANDIDATE_MIN_SCORE, USES_DEPTH_BONUS } from "./constants.js"
export { resolveScreenConflicts } from "./conflicts.js"
export type { MergedDraft } from "./conflicts.js"
export { emptyFileFacts } from "./facts.js"
export { navigationKey } from "./keys.js"
export { GRAPH_LIMITATIONS } from "./limitations.js"
export type { SplicePoint, SpliceRef } from "./splice.js"
export type {
  BuildGraphInput,
  ConflictPolicy,
  GraphMetaInput,
  GraphProviders,
  ImportedBinding,
  NavGroupDraft,
  ScreenContribution,
} from "./types.js"
export { strongerVia, withVia } from "./via.js"

export const buildGraph = (input: BuildGraphInput): AppGraph => {
  const context = createGraphContext(input)
  const { providers, maxDepth, diagnostics, factsCache } = context
  const policy = input.conflicts ?? "merge"
  const scanner = createSpliceScanner(context)
  const roots = createRoots(context, input, scanner, createRenderEdges(context))
  const judge = createSpliceJudge(context, scanner, createPlacement(context, scanner), roots)
  const chain = createChainPlanner(diagnostics, judge)

  const drafts = resolveScreenConflicts(input.contributions, policy, diagnostics)

  const targets = createTargetResolver(drafts, input, diagnostics)
  const { routeNames } = targets
  const analyze = createWalk(context, targets, routeEntryFiles(drafts))
  const mounted = entriesByAncestor(drafts)
  const screens = drafts.map(createScreenBuilder(chain, roots, analyze, mounted))

  chain.reportSpliceProblems()

  const shellSet = buildShells(screens, analyze, context.factsOf, mountedByFile(mounted))
  const { shellFiles, shells } = shellSet
  const { navGroups, deadNavLinks } = reconcileNavGroups(input, providers, shellSet, targets, diagnostics)

  for (const [file, routeName] of unknownRouteNames(factsCache, routeNames))
    diagnostics.warning(
      "nav/dead-link",
      `navigation to route name '${routeName}' (${unknownRouteNameTarget(routeName)}) in '${file}' resolves to no screen`,
      { file },
    )

  const { navigation, orphanScreens } = navigationOf(screens, navGroups, diagnostics)

  const screenRedirects = screens
    .filter((screen) => screen.redirectTo !== null)
    .map((screen): GraphRedirect => ({
      from: screen.url ?? screen.id,
      to: screen.redirectTo ?? "",
    }))

  const ruleRedirects = uniqueBy((input.redirectRules ?? []).map(graphRedirectOf), graphRedirectKey)

  const redirects = [...screenRedirects, ...ruleRedirects].sort(graphRedirectOrder)

  const components = sortedRecord(Object.fromEntries(factsCache))

  const counts: Record<string, number> = {
    apiRoutes: screens.filter(isApiRouteScreen).length,
    components: Object.keys(components).length,
    deadNavLinks: deadNavLinks.length,
    endpoints: uniqueBy(
      Object.values(components).flatMap((facts) => facts.endpoints),
      endpointKey,
    ).length,
    navigationEdges: navigation.length,
    orphanScreens: orphanScreens.length,
    redirects: redirects.length,
    renderEdges: Object.values(components).reduce((total, facts) => total + facts.renders.length, 0),
    screens: screens.filter(countsAsScreen).length,
    shells: shellFiles.length,
  }

  const meta: AppGraphMeta = {
    schemaVersion: 2,
    appgraphVersion: input.meta.appgraphVersion,
    root: input.meta.root,
    appName: input.meta.appName ?? null,
    sourceRoots: sortStrings(input.meta.sourceRoots),
    screenSources: sortStrings(input.meta.screenSources),
    maxDepth,
    fingerprint: input.meta.fingerprint,
    ...(input.meta.emptyResult === true ? { emptyResult: true as const } : {}),
    ...(input.meta.emptyReason !== undefined ? { emptyReason: input.meta.emptyReason } : {}),
    counts: sortedRecord(counts),
    confidence: input.meta.confidence ?? [],
    limitations: [...GRAPH_LIMITATIONS, ...(input.meta.limitations ?? [])],
  }

  return {
    meta,
    screens: [...screens].sort(by((screen) => screen.id)),
    redirects,
    shells: sortedRecord(shells),
    components,
    navGroups: [...navGroups].sort(by((group) => `${group.name}|${group.source}`)),
    navigation,
    deadNavLinks: [...deadNavLinks].sort(by((entry) => `${entry.path}|${entry.file}|${String(entry.line)}`)),
    orphanScreens,
    diagnostics: diagnostics.all(),
  }
}
