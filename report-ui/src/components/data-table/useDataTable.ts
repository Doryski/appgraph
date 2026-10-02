import { useDeferredValue, useMemo, useState } from "react"
import {
  columnFilteringFeature,
  createFilteredRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table"
import type { ColumnDef, ColumnSort } from "@tanstack/react-table"
import { normalizeQuery } from "@appgraph/emit/report-derive.js"
import type { ColumnConfig } from "./columns"
import { SORT_COMPARATORS, SORT_DESC_FIRST, toSortValue } from "./sorting"

export type TableEntry<Row> = {
  readonly row: Row
  readonly search: string
  readonly id: string
}

export type DataTableSort = ColumnSort

export type UseDataTableOptions<Row> = {
  readonly rows: readonly Row[]
  readonly columns: readonly ColumnConfig<Row>[]
  readonly searchText?: (row: Row) => string
  readonly rowFilter?: (row: Row) => boolean
  readonly getRowId?: (row: Row, index: number) => string
  readonly initialSort?: DataTableSort | null
  readonly query?: string
  readonly onQueryChange?: (query: string) => void
}

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
})

const defaultSearchText =
  <Row>(columns: readonly ColumnConfig<Row>[]) =>
  (row: Row): string =>
    columns
      .map((column) => column.accessor(row))
      .filter((value) => typeof value === "string")
      .join(" ")

const toEntries = <Row>(
  rows: readonly Row[],
  searchText: (row: Row) => string,
  getRowId: (row: Row, index: number) => string,
): readonly TableEntry<Row>[] =>
  rows.map((row, index) => ({ row, search: searchText(row).toLowerCase(), id: getRowId(row, index) }))

const indexRowId = <Row>(_row: Row, index: number): string => String(index)

const toColumnDef = <Row>(column: ColumnConfig<Row>, index: number): ColumnDef<typeof features, TableEntry<Row>> => {
  const kind = column.sort ?? "text"
  const compareCells = SORT_COMPARATORS[kind]
  const compareRows = column.compare ?? ((a: Row, b: Row) => compareCells(column.accessor(a), column.accessor(b)))
  return {
    id: column.id,
    accessorFn: (entry) => toSortValue(column.accessor(entry.row)),
    enableSorting: column.sort !== null,
    enableGlobalFilter: index === 0,
    sortDescFirst: SORT_DESC_FIRST[kind],
    sortUndefined: "last",
    sortFn: (a, b) => compareRows(a.original.row, b.original.row),
  }
}

const sortingFrom = (sort: DataTableSort | null | undefined) => (sort ? [sort] : [])

export const useDataTable = <Row>({
  rows,
  columns,
  searchText,
  rowFilter,
  getRowId = indexRowId,
  initialSort = null,
  query: controlledQuery,
  onQueryChange,
}: UseDataTableOptions<Row>) => {
  const [localQuery, setLocalQuery] = useState("")
  const query = controlledQuery ?? localQuery
  const setQuery = onQueryChange ?? setLocalQuery
  const deferredQuery = useDeferredValue(query)
  const globalFilter = normalizeQuery(deferredQuery)

  const entries = useMemo(
    () => toEntries(rows, searchText ?? defaultSearchText(columns), getRowId),
    [rows, columns, searchText, getRowId],
  )
  const data = useMemo(
    () => (rowFilter ? entries.filter((entry) => rowFilter(entry.row)) : entries),
    [entries, rowFilter],
  )
  const columnDefs = useMemo(() => columns.map(toColumnDef), [columns])

  const table = useTable(
    {
      features,
      columns: columnDefs,
      data,
      getRowId: (entry) => entry.id,
      enableSortingRemoval: false,
      initialState: { sorting: sortingFrom(initialSort) },
      state: { globalFilter },
      onGlobalFilterChange: () => {},
      globalFilterFn: (row, _columnId, filterValue: string) => row.original.search.includes(filterValue),
    },
    (state) => ({ sorting: state.sorting, globalFilter: state.globalFilter }),
  )

  const visibleRows = table.getRowModel().rows

  return {
    table,
    query,
    setQuery,
    clearQuery: () => setQuery(""),
    isFiltering: globalFilter !== "",
    visibleRows,
    shownCount: visibleRows.length,
    availableCount: data.length,
    totalCount: rows.length,
  }
}

export type DataTableController<Row> = ReturnType<typeof useDataTable<Row>>
