import type { AppGraph, FactChannel, SectionConfidence } from "../../core/model.js"
import { by, sortedUnique } from "../../core/order.js"
import { countsAsScreen, hasPageScreens } from "../../core/graph/screens.js"
import type { FactExtractor } from "../../extractors/types.js"
import type { PipelineEnv } from "../context.js"
import type { ChannelProviders } from "./confidence.js"
import {
  ALWAYS_ON,
  SPARSE_SCREEN_RATIO,
  installedPhrase,
  isSparseForScale,
  probeOf,
  providersByChannel,
  silentExtractors,
} from "./confidence.js"
import type { ResolvedScreen } from "./entries.js"
import type { FactSource } from "./facts.js"

export type AggregateInput = {
  readonly env: PipelineEnv
  readonly graph: AppGraph
  readonly facts: FactSource
  readonly extractors: readonly FactExtractor[]
  readonly screens: readonly ResolvedScreen[]
  readonly navGroupCount: number
}

const MASK_LIMITATION =
  "A masked component's facts are suppressed inside the masking subtree AND in the component's own file. Facts of components it renders are kept: a component the masked one shares with the shipping UI must not lose its selectors everywhere. Render edges and `reachable` are never masked."

export const aggregate = (input: AggregateInput): AppGraph => {
  const { env, graph, facts } = input

  const confidence: SectionConfidence[] = []
  const seen = new Set<string>()
  const screenCount = graph.screens.length

  const installed = (dependency: string): boolean => env.dependencies.has(dependency)

  const push = (section: FactChannel | "screens" | "nav", count: number, providers: ChannelProviders): void => {
    if (seen.has(section)) return
    seen.add(section)
    const probe = probeOf(providers, installed)
    const sparse = isSparseForScale(section, count, screenCount)
    const level = count === 0 ? (probe.dependencyInstalled ? "suspect" : "low") : sparse ? "low" : "high"
    confidence.push({ section, count, ...probe, level })
    if (level === "suspect")
      env.diagnostics.warning(
        "confidence/empty-section",
        `section '${section}' produced no facts while ${installedPhrase(providers.dependencies.filter(installed))}`,
      )
    if (sparse)
      env.diagnostics.info(
        "confidence/sparse-section",
        `section '${section}' produced ${String(count)} fact(s) across ${String(screenCount)} screens — fewer than 1 per ${String(SPARSE_SCREEN_RATIO)} screens, so it is reported 'partial' rather than 'ok'`,
      )
  }

  push("screens", graph.screens.filter(countsAsScreen).length, ALWAYS_ON)
  push("nav", input.navGroupCount, ALWAYS_ON)

  const providers = providersByChannel(input.extractors)
  for (const [channel, entry] of providers) push(channel, facts.channelCount(channel), entry)

  for (const { extractor, present } of silentExtractors(input.extractors, facts, installed))
    env.diagnostics.warning(
      "confidence/empty-section",
      `extractor '${extractor.name}' produced no facts while ${installedPhrase(present)}; its sections (${extractor.provides.join(", ")}) hold only other extractors' facts`,
    )

  const empty = !hasPageScreens(graph.screens)
  const maskLimitation = facts.maskedComponents().length > 0 ? [MASK_LIMITATION] : []

  // §11 rule 6: the explicit re-sort. An adapter cannot break determinism by forgetting.
  const mergedById = firstById(input.screens)
  const patched = graph.screens
    .map((screen) => {
      const merged = mergedById.get(screen.id)
      return merged === undefined ? screen : { ...screen, provenance: merged.merged.provenance }
    })
    .sort(by((screen) => screen.id))

  return {
    ...graph,
    screens: patched,
    meta: {
      ...graph.meta,
      confidence: [...confidence].sort(by((entry) => entry.section)),
      limitations: sortedUnique([...graph.meta.limitations, ...maskLimitation]),
      ...(empty ? { emptyResult: true as const, emptyReason: emptyReasonOf(input, graph) } : {}),
    },
    diagnostics: env.diagnostics.all(),
  }
}

const firstById = (screens: readonly ResolvedScreen[]) => {
  const index = new Map<string, ResolvedScreen>()
  for (const screen of screens) if (!index.has(screen.merged.id)) index.set(screen.merged.id, screen)
  return index
}

const emptyReasonOf = (input: AggregateInput, graph: AppGraph): string => {
  if (graph.screens.length > 0) return "only API routes or redirects were found, no page screen"
  return input.screens.length === 0
    ? "no screen source produced a draft"
    : "every discovered screen draft was dropped during normalization"
}
