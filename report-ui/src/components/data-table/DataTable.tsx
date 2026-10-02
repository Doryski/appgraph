import { useRef } from "react"
import type { ReactNode, Ref } from "react"
import type { StringKey } from "@appgraph/emit/strings.js"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { FilterInput } from "@/components/FilterInput"
import { useI18n } from "@/app/report-context"
import { cn } from "@/lib/utils"
import { PlainTable, VirtualTable } from "./TableSections"
import type { TermTipRenderer } from "./TableSections"
import { useDataTable } from "./useDataTable"
import type { DataTableController, UseDataTableOptions } from "./useDataTable"

export const VIRTUALIZE_AT = 150

export const DEFAULT_TABLE_MAX_HEIGHT = "min(70vh, 720px)"

export type DataTableProps<Row> = UseDataTableOptions<Row> & {
  readonly filterLabelKey: StringKey
  readonly filterExampleKey: StringKey
  readonly filterEmptyKey: StringKey
  readonly emptyKey: StringKey
  readonly tableLabelKey: StringKey
  readonly toolbar?: ReactNode
  readonly maxHeight?: string
  readonly renderTermTip?: TermTipRenderer
  readonly inputRef?: Ref<HTMLInputElement>
  readonly className?: string
}

const assignRef = <T,>(ref: Ref<T> | undefined, node: T | null) => {
  if (typeof ref === "function") {
    ref(node)
    return
  }
  if (ref) ref.current = node
}

const RowCount = <Row,>({ controller }: { readonly controller: DataTableController<Row> }) => {
  const { t } = useI18n()
  return (
    <p aria-live="polite" aria-atomic="true" className="ms-auto text-sm text-muted-foreground tabular-nums">
      {t("tableRowCount", { shown: controller.shownCount, total: controller.totalCount })}
    </p>
  )
}

type EmptyBlockProps = {
  readonly title: string
  readonly action?: ReactNode
}

const EmptyBlock = ({ title, action }: EmptyBlockProps) => (
  <Empty className="border p-8">
    <EmptyHeader>
      <EmptyTitle className="text-base">{title}</EmptyTitle>
    </EmptyHeader>
    {action ? <EmptyContent>{action}</EmptyContent> : null}
  </Empty>
)

type ViewKind = "empty" | "filterEmpty" | "virtual" | "plain"

const viewKindOf = <Row,>(controller: DataTableController<Row>): ViewKind => {
  if (controller.availableCount === 0) return "empty"
  if (controller.shownCount === 0 && controller.isFiltering) return "filterEmpty"
  if (controller.shownCount === 0) return "empty"
  return controller.availableCount > VIRTUALIZE_AT ? "virtual" : "plain"
}

export const DataTable = <Row,>(props: DataTableProps<Row>) => {
  const { t } = useI18n()
  const controller = useDataTable(props)
  const localInputRef = useRef<HTMLInputElement | null>(null)
  const label = t(props.tableLabelKey)
  const view = viewKindOf(controller)

  const setInputRef = (node: HTMLInputElement | null) => {
    localInputRef.current = node
    assignRef(props.inputRef, node)
  }

  const handleClear = () => {
    controller.clearQuery()
    localInputRef.current?.focus()
  }

  const sectionProps = { controller, columns: props.columns, renderTermTip: props.renderTermTip, label }

  return (
    <div className={cn("flex flex-col gap-3", props.className)}>
      <div className="flex flex-wrap items-end gap-3">
        <FilterInput
          label={t(props.filterLabelKey)}
          placeholder={t(props.filterExampleKey)}
          value={controller.query}
          onValueChange={controller.setQuery}
          inputRef={setInputRef}
          className="min-w-[min(100%,16rem)] max-w-sm flex-1"
        />
        {props.toolbar}
        <RowCount controller={controller} />
      </div>
      {view === "empty" ? <EmptyBlock title={t(props.emptyKey)} /> : null}
      {view === "filterEmpty" ? (
        <EmptyBlock
          title={t(props.filterEmptyKey, { query: controller.query.trim() })}
          action={
            <Button variant="outline" onClick={handleClear}>
              {t("filterClear")}
            </Button>
          }
        />
      ) : null}
      {view === "virtual" ? (
        <VirtualTable {...sectionProps} maxHeight={props.maxHeight ?? DEFAULT_TABLE_MAX_HEIGHT} />
      ) : null}
      {view === "plain" ? <PlainTable {...sectionProps} /> : null}
    </div>
  )
}
