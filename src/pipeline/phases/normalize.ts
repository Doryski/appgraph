import type { ConflictPolicy, MergedDraft, ScreenContribution } from "../../core/graph.js"
import { resolveScreenConflicts } from "../../core/graph.js"
import type { Activation, ScreenDraft as CoreScreenDraft } from "../../core/model.js"
import { routeNameField } from "../../core/model.js"
import { normalizeUrl, paramsOf } from "../../core/url.js"
import type { EntryRef, ScreenContributionDraft, ScreenShape } from "../../adapters/types.js"
import { isResolvedEntry } from "../../adapters/types.js"
import type { PipelineEnv } from "../context.js"

export type NormalizedScreen = {
  readonly merged: MergedDraft
  readonly shape: ScreenShape
  /** Entry refs still needing resolution, in contributing-source order. */
  readonly pending: readonly EntryRef[]
}

export type NormalizeInput = {
  readonly env: PipelineEnv
  readonly contributions: readonly ScreenContributionDraft[]
  readonly conflicts?: ConflictPolicy
}

/**
 * §4.1: `params` is DERIVED from the template by the core, never supplied by an adapter, and every
 * template goes through `normalizeUrl` before it can become an identity.
 */
const canonicalActivation = (activation: Activation): Activation => {
  if (activation.kind === "intercept") return { ...activation, from: normalizeUrl(activation.from) }
  if (activation.kind !== "url") return activation
  const template = normalizeUrl(activation.template)
  return { kind: "url", template, params: paramsOf(template) }
}

const contributionKey = (source: string, localId: string): string => `${source}|${localId}`

export const normalize = (input: NormalizeInput): readonly NormalizedScreen[] => {
  const { env } = input
  const policy = input.conflicts ?? env.config.conflicts

  const pendingByContribution = new Map<string, readonly EntryRef[]>()

  const contributions: ScreenContribution[] = input.contributions.map((contribution) => {
    const draft = contribution.draft
    pendingByContribution.set(contributionKey(contribution.source, draft.localId), draft.entries)

    const core: CoreScreenDraft = {
      ...draft,
      activations: draft.activations.map(canonicalActivation),
      // Only already-resolved refs can take part in the merge's entry union; `module`/`binding` refs
      // are carried alongside and resolved in phase 4, where an adapter hook and the resolver exist.
      entries: draft.entries.filter(isResolvedEntry),
    }
    return { source: contribution.source, draft: core }
  })

  const merged = resolveScreenConflicts(contributions, policy, env.diagnostics)

  return merged.map((draft): NormalizedScreen => {
    const url = draft.activations.find((activation) => activation.kind === "url") ?? null
    const template = url === null ? null : url.template
    const pending = draft.provenance.mergedFrom.flatMap(
      (origin) => pendingByContribution.get(contributionKey(origin.source, origin.localId)) ?? [],
    )

    return {
      merged: draft,
      pending,
      shape: {
        id: draft.id,
        localId: draft.localId,
        source: draft.source,
        activations: draft.activations,
        url: template,
        params: template === null ? [] : paramsOf(template),
        title: draft.title,
        kindTag: draft.kindTag,
        entries: pending,
        ancestors: draft.ancestors,
        shell: draft.shell,
        auth: draft.auth ?? "unknown",
        featureFlag: draft.featureFlag,
        redirectTo: draft.redirectTo,
        devOnly: draft.devOnly,
        addressable: template !== null,
        provenance: draft.provenance,
        ...routeNameField(draft),
      },
    }
  })
}
