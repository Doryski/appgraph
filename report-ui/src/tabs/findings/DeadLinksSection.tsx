import type { ReportPayload } from "@appgraph/emit/report-payload.js"
import { DataTable, defineColumns } from "@/components/data-table"
import { useI18n, usePayload } from "@/app/report-context"
import { Dash, LocationCell, compareLocation, locationText } from "./cells"
import { EmptyLine } from "./EmptyLine"
import { FindingSection } from "./FindingSection"

type DeadLink = ReportPayload["deadNavLinks"][number]

const columns = defineColumns<DeadLink>()([
  { id: "path", headerKey: "deadLinkColPath", accessor: (row) => row.path, sort: "text", mono: true },
  {
    id: "label",
    headerKey: "deadLinkColLabel",
    accessor: (row) => row.label,
    cell: (row) => row.label ?? <Dash />,
    sort: "text",
  },
  { id: "source", headerKey: "deadLinkColSource", accessor: (row) => row.source, sort: "text", mono: true },
  {
    id: "location",
    headerKey: "deadLinkColLocation",
    accessor: (row) => locationText(row.file, row.line),
    cell: (row) => <LocationCell file={row.file} line={row.line} />,
    sort: "text",
    compare: compareLocation,
    mono: true,
  },
])

export const DeadLinksSection = () => {
  const { tPlural } = useI18n()
  const { deadNavLinks } = usePayload()
  const count = deadNavLinks.length
  return (
    <FindingSection
      id="findings-dead-links"
      titleKey="findingsDeadLinksTitle"
      introKey="findingsDeadLinksIntro"
      term="deadLinks"
      tone={count > 0 ? "alarm" : "neutral"}
      alarmText={tPlural("statDeadLinksPlural", count)}
    >
      {count === 0 ? (
        <EmptyLine textKey="findingsDeadLinksEmpty" />
      ) : (
        <DataTable
          rows={deadNavLinks}
          columns={columns}
          filterLabelKey="deadLinksFilterLabel"
          filterExampleKey="deadLinksFilterExample"
          filterEmptyKey="findingsFilterEmpty"
          emptyKey="findingsDeadLinksEmpty"
          tableLabelKey="findingsDeadLinksTitle"
        />
      )}
    </FindingSection>
  )
}
