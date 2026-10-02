import type { AppGraph } from "../../core/model.js"
import {
  componentPaletteText,
  flattenNavGroups,
  joinSearchText,
  matchesTokens,
  queryTokens,
  screenPaletteText,
} from "../../emit/report-derive.js"
import { componentRows, navGroupRow, orderedScreens } from "../../emit/report-payload.js"
import { EXIT_OK } from "../../pipeline/exit-codes.js"
import type { QueryContext, QueryRun } from "../commands.js"
import { SEARCH_KINDS } from "../commands.js"
import type { Page, PageWindow, Row } from "./output.js"
import { emptyResultNotice, formatJson, formatTable, listEnvelope, paginate, projectFields, selectedFields } from "./output.js"
import type { LoadedGraph } from "./runtime.js"
import { loadGraph } from "./runtime.js"
import { listedScreen } from "./screens.js"

type SearchKind = (typeof SEARCH_KINDS)[number]

const DEFAULT_COLUMNS = ["kind", "label", "detail", "id"] as const

type Hit = {
  readonly row: {
    readonly kind: SearchKind
    readonly id: string
    readonly label: string
    readonly detail: string | null
  }
  readonly haystack: string
}

const screenHits = (graph: AppGraph): readonly Hit[] =>
  orderedScreens(graph.screens).map((screen) => {
    const row = listedScreen(screen)
    return {
      row: { kind: "screen", id: row.id, label: row.primaryLabel, detail: row.title },
      haystack: screenPaletteText(row),
    }
  })

const componentHits = (graph: AppGraph): readonly Hit[] =>
  componentRows(graph).map((component) => ({
    row: { kind: "component", id: component.file, label: component.component, detail: component.route ?? component.file },
    haystack: componentPaletteText(component),
  }))

const menuHits = (graph: AppGraph): readonly Hit[] => {
  const known = new Set(graph.screens.map((screen) => screen.id))
  return flattenNavGroups(graph.navGroups.map((group) => navGroupRow(group, known))).map((entry) => ({
    row: { kind: "menu", id: entry.path, label: entry.label ?? entry.labelKey ?? entry.path, detail: entry.group },
    haystack: joinSearchText(entry.label, entry.labelKey, entry.path, entry.group),
  }))
}

const HIT_SOURCES = {
  screen: screenHits,
  component: componentHits,
  menu: menuHits,
} as const satisfies Readonly<Record<SearchKind, (graph: AppGraph) => readonly Hit[]>>

export type SearchGroup = {
  readonly kind: SearchKind
  readonly page: Page<Row>
}

export const searchGroups = (graph: AppGraph, query: string, window: PageWindow): readonly SearchGroup[] => {
  const tokens = queryTokens(query)
  return SEARCH_KINDS.map((kind) => ({
    kind,
    page: paginate(
      HIT_SOURCES[kind](graph)
        .filter((hit) => matchesTokens(hit.haystack, tokens))
        .map((hit) => hit.row),
      window,
    ),
  }))
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

const combinedPage = (groups: readonly SearchGroup[], window: PageWindow): Page<Row> => {
  const truncated = groups.some((group) => group.page.truncated)
  return {
    total: sum(groups.map((group) => group.page.total)),
    offset: window.offset,
    limit: window.limit,
    truncated,
    nextOffset: truncated ? window.offset + window.limit : null,
    items: groups.flatMap((group) => group.page.items),
  }
}

const groupSummary = (group: SearchGroup) => ({
  kind: group.kind,
  total: group.page.total,
  shown: group.page.items.length,
  truncated: group.page.truncated,
})

const moreLine = (group: SearchGroup): string | null => {
  const shown = group.page.offset + group.page.items.length
  const rest = group.page.total - shown
  return group.page.truncated ? `… ${String(rest)} more ${group.kind} matches (use --offset/--limit)` : null
}

const textLines = (groups: readonly SearchGroup[], page: Page<Row>, columns: readonly string[]): readonly string[] => {
  if (page.items.length === 0) return ["(no matches)"]
  const more = groups.flatMap((group) => {
    const line = moreLine(group)
    return line === null ? [] : [line]
  })
  return [...formatTable(page.items, columns), ...more]
}

const writeNotice = (context: QueryContext, loaded: LoadedGraph): void => {
  const notice = emptyResultNotice(loaded.graph)
  if (notice === null || context.options.quiet) return
  if (context.options.json) context.writer.err(notice)
  else context.writer.out(notice)
}

const writeLines = (context: QueryContext, lines: readonly string[]): void => {
  for (const line of lines) context.writer.out(line)
}

const run: QueryRun = async (context) => {
  const fields = selectedFields(context.spec, context.query.fields)
  const loaded = await loadGraph(context)
  const groups = searchGroups(loaded.graph, context.args["query"] ?? "", context.query)
  const page = combinedPage(groups, context.query)
  writeNotice(context, loaded)
  if (context.options.json) {
    const extra = { query: context.args["query"] ?? "", groups: groups.map(groupSummary) }
    context.writer.out(formatJson(listEnvelope({ command: context.command, loaded, page, fields, extra })))
    return EXIT_OK
  }
  const projected = page.items.map((item) => projectFields(item, fields))
  writeLines(context, textLines(groups, { ...page, items: projected }, fields ?? DEFAULT_COLUMNS))
  return EXIT_OK
}

export default run
