import { useMemo, useState } from "react"
import { SEVERITY_RANK, severityCounts } from "@appgraph/emit/report-derive.js"
import type { ReportPayload } from "@appgraph/emit/report-payload.js"
import { DataTable, defineColumns } from "@/components/data-table"
import { FilterSelect } from "@/components/FilterSelect"
import { searchInputRef } from "@/hotkeys/search-registry"
import { useI18n, usePayload } from "@/app/report-context"
import type { Translate } from "@/lib/i18n"
import { SeverityBadge } from "./badges"
import { Dash, LocationCell, locationText } from "./cells"
import { SEVERITY_FILTERS, SEVERITY_LABEL_KEYS } from "./config"
import type { SeverityFilter } from "./config"
import { EmptyLine } from "./EmptyLine"
import { FindingSection } from "./FindingSection"

type Diagnostic = ReportPayload["diagnostics"][number]

const columns = defineColumns<Diagnostic>()([
  {
    id: "severity",
    headerKey: "diagnosticColSeverity",
    accessor: (row) => SEVERITY_RANK[row.severity],
    cell: (row) => <SeverityBadge severity={row.severity} />,
    sort: "num",
  },
  { id: "code", headerKey: "diagnosticColCode", accessor: (row) => row.code, sort: "text", mono: true },
  { id: "message", headerKey: "diagnosticColMessage", accessor: (row) => row.message, sort: null },
  {
    id: "location",
    headerKey: "deadLinkColLocation",
    accessor: (row) => locationText(row.file, row.line),
    cell: (row) => <LocationCell file={row.file} line={row.line} />,
    sort: null,
    mono: true,
  },
  {
    id: "plugin",
    headerKey: "diagnosticColPlugin",
    accessor: (row) => row.plugin,
    cell: (row) => row.plugin ?? <Dash />,
    sort: "text",
    mono: true,
  },
])

const severityItems = (t: Translate, counts: Record<SeverityFilter, number>) =>
  SEVERITY_FILTERS.map((option) => ({
    value: option,
    label: option === "all" ? t(SEVERITY_LABEL_KEYS[option]) : `${t(SEVERITY_LABEL_KEYS[option])} (${counts[option]})`,
  }))

const findingsSearchRef = searchInputRef("findings")

export const DiagnosticsSection = () => {
  const { t } = useI18n()
  const { diagnostics } = usePayload()
  const [severity, setSeverity] = useState<SeverityFilter>("all")
  const counts = useMemo(() => severityCounts(diagnostics), [diagnostics])
  const rowFilter = useMemo(
    () => (row: Diagnostic) => severity === "all" || row.severity === severity,
    [severity],
  )
  return (
    <FindingSection id="findings-diagnostics" titleKey="findingsDiagnosticsTitle">
      {diagnostics.length === 0 ? (
        <EmptyLine textKey="diagnosticsEmpty" />
      ) : (
        <DataTable
          rows={diagnostics}
          columns={columns}
          rowFilter={rowFilter}
          filterLabelKey="diagnosticsFilterLabel"
          filterExampleKey="diagnosticsFilterExample"
          filterEmptyKey="findingsFilterEmpty"
          emptyKey={severity === "all" ? "diagnosticsEmpty" : "diagnosticsSeverityEmpty"}
          tableLabelKey="findingsDiagnosticsTitle"
          inputRef={findingsSearchRef}
          toolbar={
            <FilterSelect
              label={t("diagnosticColSeverity")}
              items={severityItems(t, counts)}
              value={severity}
              onChange={setSeverity}
            />
          }
        />
      )}
    </FindingSection>
  )
}
