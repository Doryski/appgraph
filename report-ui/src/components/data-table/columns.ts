import type { ReactNode } from "react"
import type { StringKey } from "@appgraph/emit/strings.js"
import type { GlossaryTermId } from "@/config/glossary"

export const SORT_KINDS = ["text", "num"] as const

export type SortKind = (typeof SORT_KINDS)[number]

export type CellValue = string | number | null

export const COLUMN_ALIGNS = ["start", "end"] as const

export type ColumnAlign = (typeof COLUMN_ALIGNS)[number]

export type ColumnConfig<Row> = {
  readonly id: string
  readonly headerKey: StringKey
  readonly accessor: (row: Row) => CellValue
  readonly cell?: (row: Row) => ReactNode
  readonly sort: SortKind | null
  readonly compare?: (a: Row, b: Row) => number
  readonly align?: ColumnAlign
  readonly mono?: boolean
  readonly glossaryTerm?: GlossaryTermId | null
  readonly width?: string
}

export const defineColumns =
  <Row>() =>
  <const Columns extends readonly ColumnConfig<Row>[]>(columns: Columns): Columns =>
    columns
