import type { DiagnosticCollector } from "../diagnostics.js"
import type { FileFacts, Navigation } from "../model.js"
import { by, sortBy, sortStrings, sortedUnique, stableUnique } from "../order.js"
import type { MergedDraft } from "./conflicts.js"

export const namedFirst = <T extends { readonly routeName?: string }>(items: readonly T[]): readonly T[] => [
  ...items.filter((item) => item.routeName !== undefined),
  ...items.filter((item) => item.routeName === undefined),
]

export const unknownRouteNameTarget = (routeName: string): string => `name:${routeName}`

export const targetsByRouteName = (navigation: Navigation): navigation is Navigation & { readonly routeName: string } =>
  navigation.to === "" && navigation.routeName !== undefined

const declaredRouteNamesOf = (draft: MergedDraft): readonly string[] =>
  draft.routeName === undefined ? [] : [draft.routeName, ...(draft.routeNameAliases ?? [])]

const activationRouteNamesOf = (draft: MergedDraft): readonly string[] =>
  sortStrings(draft.activations.flatMap((activation) => (activation.kind === "route" ? [activation.name] : [])))

const routeNamesOf = (draft: MergedDraft): readonly string[] =>
  stableUnique([...declaredRouteNamesOf(draft), ...activationRouteNamesOf(draft)])

export const routeNameTable = (
  drafts: readonly MergedDraft[],
  diagnostics: DiagnosticCollector,
): ReadonlyMap<string, MergedDraft> => {
  const table = new Map<string, MergedDraft>()
  for (const draft of [...drafts].sort(by((candidate) => candidate.id))) {
    for (const routeName of routeNamesOf(draft)) {
      const winner = table.get(routeName)
      if (winner === undefined) {
        table.set(routeName, draft)
        continue
      }
      diagnostics.warning(
        "screens/conflict-dropped",
        `route name '${routeName}' of screen '${draft.id}' was dropped; '${winner.id}' claimed it first`,
        { screenId: draft.id },
      )
    }
  }
  return table
}

export const unknownRouteNames = (
  factsByFile: ReadonlyMap<string, FileFacts>,
  routeNames: ReadonlyMap<string, MergedDraft>,
): readonly (readonly [string, string])[] =>
  sortBy(
    [...factsByFile.values()].flatMap((facts) =>
      sortedUnique(
        facts.navigations
          .filter(targetsByRouteName)
          .map((navigation) => navigation.routeName)
          .filter((routeName) => !routeNames.has(routeName)),
      ).map((routeName) => [facts.file, routeName] as const),
    ),
    ([file, routeName]) => `${file}|${routeName}`,
  )
