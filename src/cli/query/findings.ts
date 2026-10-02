import type { AppGraph } from "../../core/model.js"
import { FINDING_SECTIONS, screenPrimaryLabel, severityCounts } from "../../emit/report-derive.js"
import type { FindingSectionId } from "../../emit/report-derive.js"
import { confidenceRow, navEntryRow, orderedDiagnostics } from "../../emit/report-payload.js"
import { EXIT_OK, EXIT_USAGE } from "../../pipeline/exit-codes.js"
import type { QueryContext, QueryRun } from "../commands.js"
import { SEVERITIES } from "../commands.js"
import { CliError } from "../index.js"
import { CATALOG_LOCALE, isOneOf, ownString } from "./catalog.js"
import type { Page, Row } from "./output.js"
import { emptyResultNotice, formatTable, listFooter, paginate, projectFields, selectedFields, writeList } from "./output.js"
import { loadGraph } from "./runtime.js"

const limitationRows = (graph: AppGraph) => graph.meta.limitations.map((message) => ({ section: "limitations", message }))

const deadLinkRows = (graph: AppGraph) => {
  const knownScreens = new Set(graph.screens.map((screen) => screen.id))
  return graph.deadNavLinks.map((entry) => {
    const row = navEntryRow(entry, knownScreens)
    return { section: "dead-links", path: row.path, label: row.label, source: row.source, file: row.file, line: row.line }
  })
}

const orphanRows = (graph: AppGraph) => {
  const byId = new Map(graph.screens.map((screen) => [screen.id, screen]))
  return graph.orphanScreens.map((id) => {
    const screen = byId.get(id)
    return { section: "orphans", id, label: screen === undefined ? id : screenPrimaryLabel(screen, CATALOG_LOCALE) }
  })
}

const confidenceRows = (graph: AppGraph) =>
  graph.meta.confidence.map((entry) => {
    const row = confidenceRow(entry)
    return {
      section: "confidence",
      id: row.section,
      count: row.count,
      enablingDependency: row.enablingDependency,
      dependencyInstalled: row.dependencyInstalled,
      level: row.level,
      status: row.status,
    }
  })

const diagnosticRows = (graph: AppGraph) =>
  orderedDiagnostics(graph.diagnostics).map((row) => ({ section: "diagnostics", ...row }))

const SECTION_ROWS = {
  limitations: limitationRows,
  "dead-links": deadLinkRows,
  orphans: orphanRows,
  confidence: confidenceRows,
  diagnostics: diagnosticRows,
} as const satisfies Record<FindingSectionId, (graph: AppGraph) => readonly Row[]>

const SECTION_COLUMNS = {
  limitations: ["message"],
  "dead-links": ["path", "label", "source", "file", "line"],
  orphans: ["id", "label"],
  confidence: ["id", "count", "enablingDependency", "level", "status"],
  diagnostics: ["severity", "code", "message", "file", "line", "screenId"],
} as const satisfies Record<FindingSectionId, readonly string[]>

type DiagnosticFilter = {
  readonly severity: string | null
  readonly code: string | null
}

type DiagnosticItem = ReturnType<typeof diagnosticRows>[number]

const keepsDiagnostic = (filter: DiagnosticFilter) => (row: DiagnosticItem) =>
  (filter.severity === null || row.severity === filter.severity) && (filter.code === null || row.code === filter.code)

const hasDiagnosticFilter = (filter: DiagnosticFilter): boolean => filter.severity !== null || filter.code !== null

const diagnosticOnlyError = (section: FindingSectionId): CliError =>
  new CliError(`--severity and --code filter diagnostics, not the ${section} section`, EXIT_USAGE, {
    code: "usage/invalid-combination",
    hint: "drop --section or pass --section diagnostics",
  })

const sectionsOf = (section: string | null, filter: DiagnosticFilter): readonly FindingSectionId[] => {
  if (isOneOf(FINDING_SECTIONS, section)) {
    if (section !== "diagnostics" && hasDiagnosticFilter(filter)) throw diagnosticOnlyError(section)
    return [section]
  }
  return hasDiagnosticFilter(filter) ? ["diagnostics"] : FINDING_SECTIONS
}

const sectionItems = (graph: AppGraph, section: FindingSectionId, filter: DiagnosticFilter): readonly Row[] =>
  section === "diagnostics" ? diagnosticRows(graph).filter(keepsDiagnostic(filter)) : SECTION_ROWS[section](graph)

const sectionOfRow = (row: Row): FindingSectionId => {
  const section = row["section"]
  return isOneOf(FINDING_SECTIONS, section) ? section : "diagnostics"
}

const countSections = (items: readonly Row[], sections: readonly FindingSectionId[]) =>
  Object.fromEntries(sections.map((section) => [section, items.filter((row) => sectionOfRow(row) === section).length]))

const filterOf = (context: QueryContext): DiagnosticFilter => {
  const severity = ownString(context, "severity")
  return { severity: isOneOf(SEVERITIES, severity) ? severity : null, code: ownString(context, "code") }
}

const sectionText = (section: FindingSectionId, rows: readonly Row[], total: number, fields: readonly string[] | null) => [
  `${section} (${String(total)})`,
  ...formatTable(
    rows.map((row) => projectFields(row, fields)),
    fields ?? SECTION_COLUMNS[section],
  ).map((line) => `  ${line}`),
]

const pageText = (context: QueryContext, page: Page<Row>, counts: Readonly<Record<string, number>>): readonly string[] => {
  const fields = selectedFields(context.spec, context.query.fields)
  const present = FINDING_SECTIONS.filter((section) => page.items.some((row) => sectionOfRow(row) === section))
  const empty = page.items.length === 0 ? ["(no findings)"] : []
  const footer = listFooter(context, page)
  return [
    ...empty,
    ...present.flatMap((section) =>
      sectionText(
        section,
        page.items.filter((row) => sectionOfRow(row) === section),
        counts[section] ?? 0,
        fields,
      ),
    ),
    ...(footer === null ? [] : [footer]),
  ]
}

const writeText = (context: QueryContext, lines: readonly string[]): void => {
  for (const line of lines) context.writer.out(line)
}

const run: QueryRun = async (context) => {
  const filter = filterOf(context)
  const sections = sectionsOf(ownString(context, "section"), filter)
  const loaded = await loadGraph(context)
  const items = sections.flatMap((section) => sectionItems(loaded.graph, section, filter))
  const counts = countSections(items, sections)
  const extra = { sections: counts, severityCounts: severityCounts(loaded.graph.diagnostics) }
  if (context.options.json) {
    writeList(context, { loaded, items, columns: [], extra })
    return EXIT_OK
  }
  const notice = emptyResultNotice(loaded.graph)
  if (notice !== null && !context.options.quiet) context.writer.out(notice)
  writeText(context, pageText(context, paginate(items, context.query), counts))
  return EXIT_OK
}

export default run
