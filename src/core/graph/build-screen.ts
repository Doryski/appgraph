import type { AncestorRef, EntryRef, Screen } from "../model.js"
import { routeNameField } from "../model.js"
import { normalizeUrl, paramsOf } from "../url.js"
import type { createChainPlanner } from "./chain.js"
import type { MergedDraft } from "./conflicts.js"
import type { ChainLink } from "./model.js"
import type { createRoots } from "./roots.js"
import { shellOf, urlActivationOf } from "./screens.js"
import type { createWalk } from "./walk.js"
import { EMPTY_ANALYSIS } from "./walk.js"

const NO_FILES: ReadonlySet<string> = new Set()

const ancestorKey = (ancestor: Pick<AncestorRef, "file" | "exportName">): string => `${ancestor.file}#${ancestor.exportName}`

const entryFilesOf = (draft: MergedDraft): readonly string[] =>
  draft.entries.flatMap((entry) => (entry.kind === "file" ? [entry.file] : []))

/**
 * Per ancestor, every file its route list renders on the way to a screen it mounts: the deeper
 * ancestors (a page that mounts its own `<Routes>`) and the screen's entries.
 */
export const entriesByAncestor = (drafts: readonly MergedDraft[]): ReadonlyMap<string, ReadonlySet<string>> => {
  const mounted = new Map<string, Set<string>>()
  for (const draft of drafts)
    draft.ancestors.forEach((ancestor, index) => {
      const key = ancestorKey(ancestor)
      const files = mounted.get(key) ?? new Set<string>()
      for (const deeper of draft.ancestors.slice(index + 1)) files.add(deeper.file)
      for (const file of entryFilesOf(draft)) files.add(file)
      mounted.set(key, files)
    })
  return mounted
}

export const routeEntryFiles = (drafts: readonly MergedDraft[]): ReadonlySet<string> => new Set(drafts.flatMap(entryFilesOf))

/** Everything any export of `file` mounts through its route lists. */
export const mountedByFile =
  (mounted: ReadonlyMap<string, ReadonlySet<string>>) =>
  (file: string): ReadonlySet<string> =>
    new Set([...mounted].filter(([key]) => key.startsWith(`${file}#`)).flatMap(([, files]) => [...files]))

export const createScreenBuilder =
  (
    { planChain }: ReturnType<typeof createChainPlanner>,
    { resolveRoot }: ReturnType<typeof createRoots>,
    analyze: ReturnType<typeof createWalk>,
    mountedEntries: ReadonlyMap<string, ReadonlySet<string>>,
  ) =>
  (draft: MergedDraft): Screen => {
    const urlActivation = urlActivationOf(draft.activations)
    const url = urlActivation === null ? null : normalizeUrl(urlActivation.template)
    const plan = planChain(draft.ancestors, draft.id)
    const { transparent } = plan
    const chain = plan.chain.map((planned, index): ChainLink => {
      const link: ChainLink = { ...planned, mountedFiles: mountedEntries.get(ancestorKey(planned.ancestor)) ?? NO_FILES }
      const branches = plan.branches[index] ?? []
      if (branches.length === 0) return link
      return {
        ...link,
        branches: branches.map(({ branch, ...kept }) => ({
          branch,
          ...kept,
          root: resolveRoot(
            { kind: "file", file: branch.file, exportName: branch.exportName },
            draft.localId,
            draft.id,
          ),
        })),
      }
    })

    const roots = draft.entries
      .filter((entry): entry is Extract<EntryRef, { kind: "file" }> => entry.kind === "file")
      .map((entry) => resolveRoot(entry, draft.localId, draft.id))

    const analysis =
      roots.length === 0 && chain.length === 0 && transparent.length === 0
        ? EMPTY_ANALYSIS
        : analyze(roots, chain, transparent)
    const reachable = analysis.reachable

    const shell = chain.length > 0 ? shellOf(chain) : draft.shell

    return {
      id: draft.id,
      localId: draft.localId,
      source: draft.source,
      activations: draft.activations,
      url,
      params: url === null ? [] : paramsOf(url),
      title: draft.title,
      kindTag: draft.kindTag,
      entries: draft.entries,
      ancestors: draft.ancestors,
      shell,
      auth: draft.auth ?? "unknown",
      featureFlag: draft.featureFlag,
      redirectTo: draft.redirectTo,
      devOnly: draft.devOnly,
      addressable: url !== null,
      tree: analysis.tree,
      reachable,
      facts: analysis.facts,
      navigatesTo: analysis.navigations.filter((edge) => edge.to !== url && edge.matchedRoute !== draft.id),
      provenance: draft.provenance,
      ...routeNameField(draft),
      ...(plan.ambiguous.length === 0 ? {} : { placementAmbiguous: plan.ambiguous }),
    }
  }
