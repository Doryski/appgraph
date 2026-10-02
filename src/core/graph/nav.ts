import type { DiagnosticCollector } from "../diagnostics.js"
import type { NavEntry, NavGroup } from "../model.js"
import { by } from "../order.js"
import { NAV_CANDIDATE_MIN_SCORE } from "./constants.js"
import { viaRedirectOf } from "./redirects.js"
import type { buildShells } from "./shells.js"
import type { createTargetResolver } from "./targets.js"
import type { BuildGraphInput, GraphProviders } from "./types.js"

export const reconcileNavGroups = (
  input: Pick<BuildGraphInput, "navGroups">,
  providers: GraphProviders,
  { shellFiles, shellAnalyses }: ReturnType<typeof buildShells>,
  { resolveTarget }: ReturnType<typeof createTargetResolver>,
  diagnostics: DiagnosticCollector,
) => {
  const shellImports = new Map<string, ReadonlySet<string>>()

  const importsReachedBy = (file: string, importsOf: (file: string) => readonly string[]): ReadonlySet<string> => {
    const cached = shellImports.get(file)
    if (cached !== undefined) return cached
    const imported = new Set((shellAnalyses.get(file)?.reachable ?? []).flatMap((reachableFile) => importsOf(reachableFile)))
    shellImports.set(file, imported)
    return imported
  }

  const shellsRendering = (sourceFile: string): readonly string[] => {
    const importsOf = providers.importsOf
    if (importsOf === undefined) return []
    return shellFiles.filter((file) => importsReachedBy(file, importsOf).has(sourceFile))
  }

  const deadNavLinks: NavEntry[] = []

  const scored = (input.navGroups ?? []).map((group) => {
    const entries = group.entries.map((entry): NavEntry => {
      const target = resolveTarget(entry.path)
      return {
        ...entry,
        resolvedScreen: target.screen,
        ...viaRedirectOf(target),
      }
    })
    const resolvedCount = entries.filter((entry) => entry.resolvedScreen !== null).length
    return {
      group,
      entries,
      resolvedCount,
      score: entries.length === 0 ? 0 : Math.round((resolvedCount / entries.length) * 10000) / 10000,
    }
  })

  const navGroups: NavGroup[] = []

  for (const candidate of scored) {
    const { group, entries, score } = candidate

    if (group.auto === true && score < NAV_CANDIDATE_MIN_SCORE) {
      // Score 0 is the overwhelmingly common case — every array of object literals in the repo carrying a
      // path-like and a label-like field is a candidate — and it is not news. A candidate that resolved
      // SOME of its targets is: it is menu-shaped and half broken, which is worth a line.
      if (candidate.resolvedCount > 0)
        diagnostics.info(
          "nav/candidate-rejected",
          `menu candidate '${group.source}' resolved ${String(candidate.resolvedCount)} of ${String(entries.length)} targets to a screen (score ${String(score)}), below the ${String(NAV_CANDIDATE_MIN_SCORE)} threshold`,
          { file: group.source.split("#")[0] ?? group.source },
        )
      continue
    }

    for (const entry of entries) {
      if (entry.resolvedScreen !== null) continue
      deadNavLinks.push(entry)
      diagnostics.warning(
        "nav/dead-link",
        `menu entry '${entry.path}' in '${group.name}' resolves to no screen`,
        {
          file: entry.file,
          line: entry.line,
        },
      )
    }

    navGroups.push({
      name: group.name,
      source: group.source,
      score,
      availableOnShells: shellsRendering(group.source.split("#")[0] ?? group.source),
      entries: [...entries].sort(by((entry) => `${entry.path}|${entry.source}|${String(entry.line)}`)),
    })
  }

  return { navGroups, deadNavLinks }
}
