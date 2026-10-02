import type { DiagnosticCollector } from "../diagnostics.js"
import type { Activation, AncestorRef, EntryRef, Evidence, Provenance, ScreenId } from "../model.js"
import { by, sortStrings, sortedUnique, sortedUniqueBy, stableUnique } from "../order.js"
import { normalizeUrl } from "../url.js"
import { activationKey, entryKey, evidenceKey } from "./keys.js"
import { urlActivationOf } from "./screens.js"
import type { ConflictPolicy, ScreenContribution } from "./types.js"

export type MergedDraft = {
  readonly id: ScreenId
  readonly source: string
  readonly localId: string
  readonly activations: readonly Activation[]
  readonly entries: readonly EntryRef[]
  readonly ancestors: readonly AncestorRef[]
  readonly title: string | null
  readonly kindTag: string | null
  readonly shell: string | null
  readonly auth: "protected" | "public" | null
  readonly featureFlag: string | null
  readonly redirectTo: string | null
  readonly devOnly: boolean
  readonly evidence: readonly Evidence[]
  readonly provenance: Provenance
  readonly routeName?: string
  readonly routeNameAliases?: readonly string[]
}

const firstRouteNameOf = (activations: readonly Activation[]): string | null => {
  const [first] = sortStrings(activations.flatMap((activation) => (activation.kind === "route" ? [activation.name] : [])))
  return first ?? null
}

const screenIdOf = (contribution: ScreenContribution): ScreenId => {
  const url = urlActivationOf(contribution.draft.activations)
  if (url !== null) return normalizeUrl(url.template)
  const name = firstRouteNameOf(contribution.draft.activations)
  const local = name ?? contribution.draft.localId
  return `screen://${contribution.source}/${encodeURIComponent(local)}`
}

// §4.3: `?:` means "no opinion, ask the next source"; an explicit `null` means "this source asserts
// absence" and stops the fallthrough. Presence, not truthiness, is what decides.
const firstPresent = <T>(values: readonly (T | undefined)[]): T | null => {
  for (const value of values) if (value !== undefined) return value
  return null
}

const routeNamesOf = (contributions: readonly ScreenContribution[]) => {
  const [routeName, ...aliases] = stableUnique(
    contributions.flatMap(({ draft }) => [...(draft.routeName === undefined ? [] : [draft.routeName]), ...(draft.routeNameAliases ?? [])]),
  )
  if (routeName === undefined) return {}
  return aliases.length === 0 ? { routeName } : { routeName, routeNameAliases: sortedUnique(aliases) }
}

const mergeContributions = (
  id: ScreenId,
  contributions: readonly ScreenContribution[],
  policy: ConflictPolicy,
  diagnostics: DiagnosticCollector,
): MergedDraft => {
  const bySource = new Map<string, ScreenContribution[]>()
  for (const contribution of contributions) {
    const existing = bySource.get(contribution.source)
    if (existing === undefined) bySource.set(contribution.source, [contribution])
    else existing.push(contribution)
  }

  // Same-source duplicates are an error in EVERY mode: a source contradicting itself is an adapter
  // bug, not a policy question (§9.4). What the error must NOT do is decide the screen: the loser was
  // picked by arrival order (glob order), so discarding it lets one bogus discovery delete a real
  // screen's entry and facts outright. `deduped` therefore carries ONE representative per source for
  // the policy decision below, while `siblingsOf` puts the whole group back into the union.
  const deduped: ScreenContribution[] = []
  for (const contribution of contributions) {
    const siblings = bySource.get(contribution.source) ?? []
    const isFirstOfSource = siblings[0] === contribution
    if (isFirstOfSource) {
      deduped.push(contribution)
      continue
    }
    diagnostics.error(
      "screens/duplicate-id",
      `source '${contribution.source}' claimed screen '${id}' twice (localIds '${siblings[0]?.draft.localId ?? ""}' and '${contribution.draft.localId}')`,
      { screenId: id },
    )
  }

  const siblingsOf = (contribution: ScreenContribution): readonly ScreenContribution[] =>
    bySource.get(contribution.source) ?? [contribution]

  const first = deduped[0]
  if (first === undefined) throw new Error(`mergeContributions called with no contributions for '${id}'`)

  const decisions: string[] = []
  const contributingSources = deduped.map((contribution) => contribution.source)

  const effective = ((): readonly ScreenContribution[] => {
    if (deduped.length === 1) return deduped

    if (policy === "first") {
      for (const loser of deduped.slice(1))
        diagnostics.warning(
          "screens/conflict-dropped",
          `screen '${id}' claimed by '${loser.source}' was dropped; '${first.source}' won under conflicts:first`,
          { screenId: id },
        )
      decisions.push(
        `conflicts:first kept '${first.source}', dropped ${deduped.length - 1} other contribution(s)`,
      )
      return [first]
    }

    if (policy === "error") {
      diagnostics.error(
        "screens/conflict-dropped",
        `screen '${id}' claimed by ${deduped.length} sources (${contributingSources.join(", ")}); kept '${first.source}' under conflicts:error`,
        { screenId: id },
      )
      decisions.push(`conflicts:error kept '${first.source}'`)
      return [first]
    }

    diagnostics.info(
      "screens/merged",
      `screen '${id}' merged from ${deduped
        .map((contribution) => `${contribution.source}#${contribution.draft.localId}`)
        .join(", ")}`,
      { screenId: id },
    )
    decisions.push(`conflicts:merge unioned ${deduped.length} contributions`)
    return deduped
  })()

  // Every contribution the policy KEPT, duplicates included. The policy chooses between sources; it
  // never gets to silently delete a same-source sibling's entries, evidence or activations.
  const contributing = effective.flatMap(siblingsOf)

  const ancestorsSource = contributing.find((contribution) => contribution.draft.ancestors !== undefined)

  return {
    id,
    source: first.source,
    localId: first.draft.localId,
    activations: sortedUniqueBy(
      contributing.flatMap((contribution) => contribution.draft.activations),
      activationKey,
    ),
    entries: sortedUniqueBy(
      contributing.flatMap((contribution) => contribution.draft.entries),
      entryKey,
    ),
    ancestors: ancestorsSource?.draft.ancestors ?? [],
    title: firstPresent(contributing.map((contribution) => contribution.draft.title)),
    kindTag: firstPresent(contributing.map((contribution) => contribution.draft.kindTag)),
    shell: firstPresent(contributing.map((contribution) => contribution.draft.shell)),
    auth: firstPresent(contributing.map((contribution) => contribution.draft.auth)),
    featureFlag: firstPresent(contributing.map((contribution) => contribution.draft.featureFlag)),
    redirectTo: firstPresent(contributing.map((contribution) => contribution.draft.redirectTo)),
    devOnly: contributing.some((contribution) => contribution.draft.devOnly === true),
    evidence: sortedUniqueBy(
      contributing.flatMap((contribution) => contribution.draft.evidence),
      evidenceKey,
    ),
    provenance: {
      sources: effective.map((contribution) => contribution.source),
      evidence: sortedUniqueBy(
        contributing.flatMap((contribution) => contribution.draft.evidence),
        evidenceKey,
      ),
      mergedFrom: contributing.map((contribution) => ({
        source: contribution.source,
        localId: contribution.draft.localId,
      })),
      decisions,
    },
    ...routeNamesOf(contributing),
  }
}

export const resolveScreenConflicts = (
  contributions: readonly ScreenContribution[],
  policy: ConflictPolicy,
  diagnostics: DiagnosticCollector,
): readonly MergedDraft[] => {
  const grouped = new Map<ScreenId, ScreenContribution[]>()
  const order: ScreenId[] = []

  for (const contribution of contributions) {
    const id = screenIdOf(contribution)
    const existing = grouped.get(id)
    if (existing === undefined) {
      grouped.set(id, [contribution])
      order.push(id)
      continue
    }
    existing.push(contribution)
  }

  return order
    .map((id) => mergeContributions(id, grouped.get(id) ?? [], policy, diagnostics))
    .sort(by((draft) => draft.id))
}
