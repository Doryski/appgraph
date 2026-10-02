import type { AppGraph } from "../../core/model.js"
import { DEPTH_STAT_ID, STAT_SPECS, appNameOf, isHiddenStat, severityCounts, statValue } from "../../emit/report-derive.js"
import type { StatId } from "../../emit/report-derive.js"
import { headerCounts } from "../../emit/report-payload.js"
import { EXIT_OK } from "../../pipeline/exit-codes.js"
import type { QueryRun } from "../commands.js"
import { writeItem } from "./output.js"
import type { LoadedGraph } from "./runtime.js"
import { loadGraph } from "./runtime.js"

const MAX_DEPTH_KEY = "maxDepth"

const statKey = (id: StatId): string => (id === DEPTH_STAT_ID ? MAX_DEPTH_KEY : id)

type StatEntry = { readonly id: StatId; readonly key: string; readonly value: number }

const statEntries = (graph: AppGraph): readonly StatEntry[] => {
  const meta = { counts: headerCounts(graph), maxDepth: graph.meta.maxDepth }
  return STAT_SPECS.map((spec) => ({ id: spec.id, key: statKey(spec.id), value: statValue(meta, spec.id) }))
}

const countsOf = (entries: readonly StatEntry[]) => Object.fromEntries(entries.map((entry) => [entry.key, entry.value]))

const visibleInText = (entries: readonly StatEntry[]): readonly StatEntry[] =>
  entries.filter((entry) => !isHiddenStat(entry, entry.value))

export const statsItem = (graph: AppGraph, entries: readonly StatEntry[] = statEntries(graph)) => {
  const severities = severityCounts(graph.diagnostics)
  return {
    appName: appNameOf(graph),
    appgraphVersion: graph.meta.appgraphVersion,
    ...countsOf(entries),
    errors: severities.error,
    warnings: severities.warning,
    infos: severities.info,
    emptyResult: graph.meta.emptyResult === true,
    emptyReason: graph.meta.emptyReason ?? null,
  }
}

const cacheText = (loaded: LoadedGraph) => ({ cache: `${loaded.cache.status} ${loaded.cache.path}` })

const run: QueryRun = async (context) => {
  const loaded = await loadGraph(context)
  if (context.options.json) {
    writeItem(context, { loaded, item: statsItem(loaded.graph) })
    return EXIT_OK
  }
  writeItem(context, { loaded, item: { ...statsItem(loaded.graph, visibleInText(statEntries(loaded.graph))), ...cacheText(loaded) } })
  return EXIT_OK
}

export default run
