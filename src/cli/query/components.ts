import { by } from "../../core/order.js"
import { componentKinds } from "../../emit/report-derive.js"
import { componentRows } from "../../emit/report-payload.js"
import { EXIT_OK } from "../../pipeline/exit-codes.js"
import type { QueryContext, QueryRun } from "../commands.js"
import { COMPONENT_SORTS } from "../commands.js"
import { applyFilters, isOneOf, ownString, requireKnown, searchText, tokenFilter } from "./catalog.js"
import type { RowFilter } from "./catalog.js"
import { writeList } from "./output.js"
import { loadGraph } from "./runtime.js"

const COLUMNS = ["component", "kind", "file", "route", "renders", "endpoints", "mutations", "stores"] as const

type ComponentPayloadRow = ReturnType<typeof componentRows>[number]

export const componentItem = (row: ComponentPayloadRow) => ({
  file: row.file,
  component: row.component,
  kind: row.kind,
  route: row.route,
  renders: row.renders,
  endpoints: row.endpoints,
  mutations: row.mutations,
  stores: row.stores,
})

type ComponentItem = ReturnType<typeof componentItem>

const SORTERS = {
  renders: (items: readonly ComponentItem[]) => items,
  file: (items: readonly ComponentItem[]) => [...items].sort(by((item) => item.file)),
} as const satisfies Record<(typeof COMPONENT_SORTS)[number], (items: readonly ComponentItem[]) => readonly ComponentItem[]>

const sortOf = (context: QueryContext) => {
  const sort = ownString(context, "sort")
  return isOneOf(COMPONENT_SORTS, sort) ? sort : "renders"
}

const kindFilter = (kind: string | null): RowFilter<ComponentItem> | null =>
  kind === null ? null : (item) => item.kind === kind

const searchFilter = (query: string | null) =>
  tokenFilter<ComponentItem>(query, (item) => searchText(item.component, item.file, item.kind, item.route))

const run: QueryRun = async (context) => {
  const loaded = await loadGraph(context)
  const items = componentRows(loaded.graph).map(componentItem)
  const kind = ownString(context, "kind")
  if (kind !== null)
    requireKnown({ what: "component kind", value: kind, valid: componentKinds(items), code: "usage/unknown-kind" })
  const filtered = applyFilters(items, [kindFilter(kind), searchFilter(ownString(context, "search"))])
  writeList(context, { loaded, items: SORTERS[sortOf(context)](filtered), columns: COLUMNS })
  return EXIT_OK
}

export default run
