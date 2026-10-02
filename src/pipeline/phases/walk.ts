import type { NavGroupDraft, ScreenContribution } from "../../core/graph.js"
import { buildGraph } from "../../core/graph.js"
import { resolveAppName } from "../../core/app-name.js"
import { toPosix } from "../../core/host.js"
import type { AppGraph, KindRule, RedirectRule, RedirectRuleSpec } from "../../core/model.js"
import { routeNameField } from "../../core/model.js"
import { sortedUnique } from "../../core/order.js"
import type { PipelineEnv } from "../context.js"
import type { ResolvedScreen } from "./entries.js"
import type { FactSource } from "./facts.js"
import { templateSpliceCandidatesOf, templateTargetsOf } from "./template-splice.js"

export type WalkInput = {
  readonly env: PipelineEnv
  readonly screens: readonly ResolvedScreen[]
  readonly navGroups: readonly NavGroupDraft[]
  readonly facts: FactSource
  readonly kindRules: readonly KindRule[]
  readonly diagnostics: PipelineEnv["diagnostics"]
  /** Redirect rules read from the analysed project; joined after the config's `redirectRules`. */
  readonly discoveredRedirectRules?: readonly RedirectRule[]
}

/** `declaredAt` of a rule supplied by the appgraph config rather than found in the analysed code. */
export const CONFIG_REDIRECT_ORIGIN = "config"

const configuredRedirectRule = (spec: RedirectRuleSpec): RedirectRule => ({
  source: spec.source,
  destination: spec.destination,
  declaredAt: CONFIG_REDIRECT_ORIGIN,
  condition: null,
  conditional: false,
})

const toContribution = (screen: ResolvedScreen): ScreenContribution => ({
  source: screen.merged.source,
  draft: {
    localId: screen.merged.localId,
    activations: screen.merged.activations,
    entries: screen.entries,
    ancestors: screen.ancestors,
    title: screen.merged.title,
    kindTag: screen.merged.kindTag,
    shell: screen.merged.shell,
    auth: screen.merged.auth,
    featureFlag: screen.merged.featureFlag,
    redirectTo: screen.merged.redirectTo,
    devOnly: screen.merged.devOnly,
    evidence: screen.merged.evidence,
    ...routeNameField(screen.merged),
    ...(screen.merged.routeNameAliases === undefined ? {} : { routeNameAliases: screen.merged.routeNameAliases }),
  },
})

export const walk = (input: WalkInput): AppGraph => {
  const { env, facts } = input
  const { paths, resolver } = env

  const bindingFileOf = (file: string, local: string): { file: string; imported: string } | null => {
    const binding = env.bindingsFor(file).get(local)
    if (binding === null || binding.kind === "local" || binding.kind === "hook-result") return null
    if (binding.file === null) return null
    return { file: binding.file, imported: binding.imported }
  }

  const importLists = new Map<string, readonly string[]>()

  const importsOf = (file: string): readonly string[] => {
    const cached = importLists.get(file)
    if (cached !== undefined) return cached
    const imported = resolver.imports(paths.abs(file)).files.map((abs) => toPosix(paths.rel(abs)))
    importLists.set(file, imported)
    return imported
  }

  return buildGraph({
    providers: {
      ast: env.ast,
      facts: facts.factsOf,
      sourceOf: env.sourceOf,
      spliceCandidatesOf: (ref) => templateSpliceCandidatesOf(env, ref),
      templateTargetsOf: (file, exportName) => templateTargetsOf(env, file, exportName),
      subtreeFacts: facts.subtreeFactsOf,
      declaringFileOf: (file, tag) => {
        const binding = bindingFileOf(file, tag)
        if (binding === null) return null
        return toPosix(paths.rel(resolver.declarationFile(binding.file, binding.imported)))
      },
      importedNameOf: (file, local) => {
        const binding = env.bindingsFor(file).get(local)
        if (binding === null || binding.kind === "local" || binding.kind === "hook-result") return null
        return { imported: binding.imported }
      },
      importsOf,
    },
    contributions: input.screens.map(toContribution),
    navGroups: input.navGroups,
    maxDepth: env.config.depth,
    conflicts: env.config.conflicts,
    kindRules: input.kindRules,
    redirectRules: [
      ...env.config.redirectRules.map(configuredRedirectRule),
      ...(input.discoveredRedirectRules ?? []),
    ],
    diagnostics: input.diagnostics,
    meta: {
      appgraphVersion: env.config.appgraphVersion,
      root: env.config.rootLabel,
      appName: resolveAppName({ manifest: env.rootManifest, rootLabel: env.config.rootLabel }),
      sourceRoots: env.config.sourceRoots,
      screenSources: sortedUnique(input.screens.map((screen) => screen.merged.source)),
      fingerprint: env.config.fingerprint,
    },
  })
}
