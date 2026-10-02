import type { FileFacts, Screen, ShellReport } from "../model.js"
import { sortedUnique } from "../order.js"
import type { ResolvedRoot } from "./model.js"
import { wholeFileRoot } from "./model.js"
import type { Analysis, createWalk } from "./walk.js"

/** A shell's own tree: the pages its route lists mount are what screens splice in, not part of the shell. */
const shellRoot = (file: string, facts: FileFacts, mounted: ReadonlySet<string>): ResolvedRoot =>
  mounted.size === 0
    ? wholeFileRoot(file)
    : { ...wholeFileRoot(file), facts: { ...facts, renders: facts.renders.filter((edge) => !mounted.has(edge.file)) } }

export const buildShells = (
  screens: readonly Screen[],
  analyze: ReturnType<typeof createWalk>,
  factsOf: (file: string) => FileFacts,
  mountedBy: (file: string) => ReadonlySet<string>,
) => {
  const shellFiles = sortedUnique(
    screens.map((screen) => screen.shell).filter((file): file is string => file !== null),
  )

  const layoutNamesFor = (file: string): readonly string[] =>
    sortedUnique(
      screens.flatMap((screen) =>
        screen.ancestors.filter((ancestor) => ancestor.file === file).map((ancestor) => ancestor.exportName),
      ),
    )

  const shellAnalyses = new Map<string, Analysis>()
  const shells: Record<string, ShellReport> = {}

  for (const file of shellFiles) {
    const analysis = analyze([shellRoot(file, factsOf(file), mountedBy(file))], [], [])
    shellAnalyses.set(file, analysis)
    shells[file] = {
      file,
      layouts: layoutNamesFor(file),
      tree: analysis.tree,
      navigatesTo: analysis.navigations,
      endpoints: analysis.facts.endpoints,
      stores: analysis.facts.stores,
      i18nNamespaces: analysis.facts.i18nNamespaces,
      testIds: analysis.facts.testIds,
    }
  }

  return { shellFiles, shellAnalyses, shells }
}
