import { useMemo } from "react"
import type { ReportPayload } from "@appgraph/emit/report-payload.js"
import { DataTable, defineColumns } from "@/components/data-table"
import { useI18n, usePayload } from "@/app/report-context"
import type { Translate } from "@/lib/i18n"
import { ConfidenceBadge } from "./badges"
import { Dash } from "./cells"
import { CONFIDENCE_LABEL_KEYS } from "./config"
import { EmptyLine } from "./EmptyLine"
import { FindingSection } from "./FindingSection"

type ConfidenceRow = ReportPayload["confidence"][number]

const buildColumns = (t: Translate) =>
  defineColumns<ConfidenceRow>()([
    { id: "section", headerKey: "confidenceColSection", accessor: (row) => row.section, sort: "text", mono: true },
    { id: "count", headerKey: "confidenceColCount", accessor: (row) => row.count, sort: "num", align: "end" },
    {
      id: "dependency",
      headerKey: "confidenceColDependency",
      accessor: (row) => row.enablingDependency,
      cell: (row) => row.enablingDependency ?? <Dash />,
      sort: "text",
      mono: true,
    },
    {
      id: "status",
      headerKey: "confidenceColStatus",
      accessor: (row) => t(CONFIDENCE_LABEL_KEYS[row.status]),
      cell: (row) => <ConfidenceBadge status={row.status} />,
      sort: "text",
    },
  ])

export const ConfidenceSection = () => {
  const { t } = useI18n()
  const { confidence } = usePayload()
  const columns = useMemo(() => buildColumns(t), [t])
  return (
    <FindingSection id="findings-confidence" titleKey="findingsConfidenceTitle" term="confidence">
      {confidence.length === 0 ? (
        <EmptyLine textKey="findingsConfidenceEmpty" />
      ) : (
        <DataTable
          rows={confidence}
          columns={columns}
          filterLabelKey="confidenceFilterLabel"
          filterExampleKey="confidenceFilterExample"
          filterEmptyKey="findingsFilterEmpty"
          emptyKey="findingsConfidenceEmpty"
          tableLabelKey="findingsConfidenceTitle"
        />
      )}
    </FindingSection>
  )
}
