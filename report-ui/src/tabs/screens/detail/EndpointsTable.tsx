import { createElement, useMemo } from "react"
import type { ScreenPayload } from "@appgraph/emit/report-payload.js"
import { CopyButton } from "@/components/CopyButton"
import { DataTable, defineColumns } from "@/components/data-table"
import { GlossaryTip } from "@/components/InfoTip"
import type { GlossaryTermId } from "@/config/glossary"
import {
  ENDPOINT_CLIENT_COLUMN_KEY,
  ENDPOINT_FILTER_EMPTY_KEY,
  ENDPOINT_FILTER_EXAMPLE_KEY,
  ENDPOINT_FILTER_LABEL_KEY,
  ENDPOINT_METHOD_COLUMN_KEY,
  ENDPOINT_TRANSPORT_COLUMN_KEY,
  ENDPOINT_URL_COLUMN_KEY,
} from "../keys"
import { usePaletteSlugs } from "./palette"
import type { PaletteSlugs } from "./palette"

type EndpointRow = ScreenPayload["facts"]["endpoints"][number]

const ENDPOINTS_MAX_HEIGHT = "min(60vh, 560px)"

const MethodBadge = ({ row, slug }: { readonly row: EndpointRow; readonly slug: string | undefined }) => (
  <span
    data-slot="method-badge"
    className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-4xl border px-2 font-mono text-xs font-semibold"
    style={slug ? { color: `var(--method-color-${slug})`, borderColor: `var(--method-color-${slug})` } : undefined}
  >
    {row.method}
  </span>
)

const methodCell = (slugs: PaletteSlugs) => (row: EndpointRow) =>
  createElement(MethodBadge, { row, slug: slugs.methodSlug(row.key) })

const urlCell = (row: EndpointRow) =>
  createElement(
    "span",
    { className: "inline-flex min-w-0 flex-wrap items-center gap-2" },
    createElement("span", { className: "min-w-0 break-all font-mono text-xs" }, row.url),
    createElement(CopyButton, { value: row.url, what: row.url }),
  )

const transportCell = (row: EndpointRow) =>
  createElement(
    "span",
    { className: row.transport === "rpc" ? "rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold" : "font-mono text-xs" },
    row.transport,
  )

const endpointColumns = (slugs: PaletteSlugs) =>
  defineColumns<EndpointRow>()([
    {
      id: "method",
      headerKey: ENDPOINT_METHOD_COLUMN_KEY,
      accessor: (row) => row.method,
      cell: methodCell(slugs),
      sort: "text",
    },
    {
      id: "url",
      headerKey: ENDPOINT_URL_COLUMN_KEY,
      accessor: (row) => row.url,
      cell: urlCell,
      sort: "text",
    },
    {
      id: "transport",
      headerKey: ENDPOINT_TRANSPORT_COLUMN_KEY,
      accessor: (row) => row.transport,
      cell: transportCell,
      sort: "text",
      glossaryTerm: "transport",
    },
    {
      id: "client",
      headerKey: ENDPOINT_CLIENT_COLUMN_KEY,
      accessor: (row) => row.client,
      sort: "text",
      mono: true,
    },
  ] as const)

const rowId = (row: EndpointRow, index: number) => `${index}:${row.key}:${row.url}`

const renderTermTip = (term: GlossaryTermId) => <GlossaryTip id={term} />

export const EndpointsTable = ({ endpoints }: { readonly endpoints: ScreenPayload["facts"]["endpoints"] }) => {
  const slugs = usePaletteSlugs()
  const columns = useMemo(() => endpointColumns(slugs), [slugs])
  return (
    <DataTable
      rows={endpoints}
      columns={columns}
      filterLabelKey={ENDPOINT_FILTER_LABEL_KEY}
      filterExampleKey={ENDPOINT_FILTER_EXAMPLE_KEY}
      filterEmptyKey={ENDPOINT_FILTER_EMPTY_KEY}
      emptyKey="emptyEndpoints"
      tableLabelKey="sectionEndpoints"
      getRowId={rowId}
      maxHeight={ENDPOINTS_MAX_HEIGHT}
      renderTermTip={renderTermTip}
    />
  )
}
