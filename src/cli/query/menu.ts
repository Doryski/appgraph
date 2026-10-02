import type { AppGraph } from "../../core/model.js"
import { flattenNavGroups, groupNames } from "../../emit/report-derive.js"
import { navGroupRow } from "../../emit/report-payload.js"
import { t } from "../../emit/strings.js"
import { EXIT_OK } from "../../pipeline/exit-codes.js"
import type { QueryRun } from "../commands.js"
import { CATALOG_LOCALE, applyFilters, isFlagSet, ownString, requireKnown, searchText, tokenFilter } from "./catalog.js"
import type { RowFilter } from "./catalog.js"
import { writeList } from "./output.js"
import { loadGraph } from "./runtime.js"

const COLUMNS = ["group", "label", "labelKey", "path", "featureFlag", "parentPath", "linkedScreen"] as const

export const menuRows = (graph: AppGraph) => {
  const knownScreens = new Set(graph.screens.map((screen) => screen.id))
  return flattenNavGroups(graph.navGroups.map((group) => navGroupRow(group, knownScreens)))
}

type MenuRow = ReturnType<typeof menuRows>[number]

export const menuItem = (row: MenuRow) => ({
  group: row.group,
  label: row.label,
  labelKey: row.labelKey,
  path: row.path,
  featureFlag: row.featureFlag,
  parentPath: row.parentPath,
  linkedScreen: row.linkedScreen,
  missing: row.linkedScreen === null,
  source: row.source,
  file: row.file,
  line: row.line,
})

type MenuItem = ReturnType<typeof menuItem>

const MISSING_MARKER = t(CATALOG_LOCALE, "menuMissingInRouter")

const textItem = (item: MenuItem) => ({ ...item, linkedScreen: item.linkedScreen ?? MISSING_MARKER })

const groupFilter = (group: string | null): RowFilter<MenuItem> | null =>
  group === null ? null : (item) => item.group === group

const missingFilter = (missing: boolean): RowFilter<MenuItem> | null => (missing ? (item) => item.missing : null)

const searchFilter = (query: string | null) =>
  tokenFilter<MenuItem>(query, (item) => searchText(item.label, item.labelKey, item.path))

const run: QueryRun = async (context) => {
  const loaded = await loadGraph(context)
  const items = menuRows(loaded.graph).map(menuItem)
  const group = ownString(context, "group")
  if (group !== null)
    requireKnown({ what: "menu group", value: group, valid: groupNames(loaded.graph.navGroups), code: "usage/unknown-group" })
  const filtered = applyFilters(items, [
    groupFilter(group),
    missingFilter(isFlagSet(context.own["missing"])),
    searchFilter(ownString(context, "search")),
  ])
  writeList(context, { loaded, items: context.options.json ? filtered : filtered.map(textItem), columns: COLUMNS })
  return EXIT_OK
}

export default run
