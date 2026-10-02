import { useRef } from "react"
import type { CSSProperties, ReactNode } from "react"
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { GlossaryTermId } from "@/config/glossary"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useI18n } from "@/app/report-context"
import { cn } from "@/lib/utils"
import type { CellValue, ColumnConfig } from "./columns"
import { ariaSortOf, sortLabelKeyOf } from "./sorting"
import type { SortState } from "./sorting"
import type { DataTableController } from "./useDataTable"

export const ROW_ESTIMATE_PX = 37
const OVERSCAN = 8

export type TermTipRenderer = (term: GlossaryTermId) => ReactNode

type SectionProps<Row> = {
  readonly controller: DataTableController<Row>
  readonly columns: readonly ColumnConfig<Row>[]
  readonly renderTermTip?: TermTipRenderer
}

type VisibleRow<Row> = DataTableController<Row>["visibleRows"][number]

const SORT_ICONS = {
  asc: ArrowUpIcon,
  desc: ArrowDownIcon,
} as const

const SortIcon = ({ state }: { readonly state: SortState }) => {
  if (state === false) return <ArrowUpDownIcon aria-hidden className="text-muted-foreground/70" />
  const Icon = SORT_ICONS[state]
  return <Icon aria-hidden />
}

const alignClass = <Row,>(column: ColumnConfig<Row>) => (column.align === "end" ? "text-right" : "text-left")

const widthStyle = <Row,>(column: ColumnConfig<Row>): CSSProperties | undefined =>
  column.width ? { width: column.width } : undefined

const sortStateOf = <Row,>(controller: DataTableController<Row>, id: string): SortState => {
  const entry = controller.table.state.sorting.find((sort) => sort.id === id)
  if (!entry) return false
  return entry.desc ? "desc" : "asc"
}

type HeaderCellProps<Row> = SectionProps<Row> & { readonly column: ColumnConfig<Row> }

const HeaderCell = <Row,>({ controller, column, renderTermTip }: HeaderCellProps<Row>) => {
  const { t } = useI18n()
  const label = t(column.headerKey)
  const state = sortStateOf(controller, column.id)
  const toggle = () => controller.table.getColumn(column.id)?.toggleSorting()
  const term = column.glossaryTerm ?? null
  const tipped = term !== null && renderTermTip !== undefined

  return (
    <TableHead
      scope="col"
      aria-sort={column.sort ? ariaSortOf(state) : undefined}
      style={widthStyle(column)}
      className={alignClass(column)}
    >
      <span className={cn("inline-flex items-center gap-0.5", column.align === "end" && "flex-row-reverse")}>
        {column.sort ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={toggle}
            aria-label={t(sortLabelKeyOf(state), { column: label })}
            className={cn(
              "-mx-2 font-medium pointer-coarse:min-h-11",
              column.align === "end" && "flex-row-reverse",
              tipped && (column.align === "end" ? "-ms-2.75" : "-me-2.75"),
            )}
          >
            {label}
            <SortIcon state={state} />
          </Button>
        ) : (
          <span>{label}</span>
        )}
        {term && renderTermTip ? renderTermTip(term) : null}
      </span>
    </TableHead>
  )
}

const HeaderRow = <Row,>(props: SectionProps<Row> & { readonly className?: string }) => (
  <TableHeader className={props.className}>
    <TableRow className="hover:bg-transparent">
      {props.columns.map((column) => (
        <HeaderCell key={column.id} {...props} column={column} />
      ))}
    </TableRow>
  </TableHeader>
)

const formatValue = (value: CellValue): string => (value === null ? "" : String(value))

const cellClass = <Row,>(column: ColumnConfig<Row>) =>
  cn(
    "whitespace-normal",
    alignClass(column),
    column.mono && "min-w-48 font-mono text-xs",
    column.sort === "num" && "tabular-nums",
  )

type DataRowProps<Row> = {
  readonly row: VisibleRow<Row>
  readonly columns: readonly ColumnConfig<Row>[]
  readonly index?: number
  readonly measureRef?: (node: HTMLTableRowElement | null) => void
}

const DataRow = <Row,>({ row, columns, index, measureRef }: DataRowProps<Row>) => (
  <TableRow data-index={index} aria-rowindex={index === undefined ? undefined : index + 2} ref={measureRef}>
    {columns.map((column) => (
      <TableCell key={column.id} className={cellClass(column)} style={widthStyle(column)}>
        {column.cell ? column.cell(row.original.row) : formatValue(column.accessor(row.original.row))}
      </TableCell>
    ))}
  </TableRow>
)

const SpacerRow = ({ height, span }: { readonly height: number; readonly span: number }) => {
  if (height <= 0) return null
  return (
    <tr aria-hidden data-spacer="">
      <td colSpan={span} style={{ height, padding: 0 }} />
    </tr>
  )
}

export const PlainTable = <Row,>(props: SectionProps<Row> & { readonly label: string }) => (
  <div className="rounded-md border">
    <Table aria-label={props.label}>
      <HeaderRow {...props} />
      <TableBody>
        {props.controller.visibleRows.map((row) => (
          <DataRow key={row.id} row={row} columns={props.columns} />
        ))}
      </TableBody>
    </Table>
  </div>
)

type VirtualTableProps<Row> = SectionProps<Row> & {
  readonly label: string
  readonly maxHeight: string
}

export const VirtualTable = <Row,>(props: VirtualTableProps<Row>) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows = props.controller.visibleRows
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: OVERSCAN,
    useFlushSync: false,
  })
  const items = virtualizer.getVirtualItems()
  const paddingTop = items[0]?.start ?? 0
  const paddingBottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0)
  const span = props.columns.length

  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label={props.label}
      tabIndex={0}
      data-virtualized=""
      className="relative overflow-auto rounded-md border focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      style={{ maxHeight: props.maxHeight }}
    >
      <table data-slot="table" aria-label={props.label} aria-rowcount={rows.length + 1} className="w-full caption-bottom text-sm">
        <HeaderRow {...props} className="sticky top-0 z-10 bg-background shadow-[inset_0_-1px_0_var(--border)]" />
        <TableBody>
          <SpacerRow height={paddingTop} span={span} />
          {items.map((item) => {
            const row = rows[item.index]
            if (!row) return null
            return (
              <DataRow
                key={row.id}
                row={row}
                columns={props.columns}
                index={item.index}
                measureRef={virtualizer.measureElement}
              />
            )
          })}
          <SpacerRow height={paddingBottom} span={span} />
        </TableBody>
      </table>
    </div>
  )
}
