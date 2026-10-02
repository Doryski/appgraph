import { useCallback, useMemo, useState } from "react"
import { componentKinds } from "@appgraph/emit/report-derive.js"
import type { ComponentPayload } from "@appgraph/emit/report-payload.js"
import { useI18n, usePayload } from "@/app/report-context"
import { DataTable } from "@/components/data-table"
import type { DataTableSort } from "@/components/data-table"
import { FilterSelect } from "@/components/FilterSelect"
import { GlossaryTip } from "@/components/InfoTip"
import { searchInputRef } from "@/hotkeys/search-registry"
import { setTabQuery, useTabQuery } from "@/lib/tab-query"
import { componentColumns } from "./columns"

const ALL_KINDS = ""

const INITIAL_SORT: DataTableSort = { id: "renders", desc: true }

const rowId = (row: ComponentPayload) => row.file

const searchTextOf = (row: ComponentPayload) => row.search

const renderTermTip = (term: Parameters<typeof GlossaryTip>[0]["id"]) => <GlossaryTip id={term} />

const componentsSearchRef = searchInputRef("components")

const setComponentsQuery = (query: string) => setTabQuery("components", query)

export const ComponentsTab = () => {
  const { t } = useI18n()
  const payload = usePayload()
  const query = useTabQuery("components")
  const [kind, setKind] = useState<string>(ALL_KINDS)
  const kinds = useMemo(() => componentKinds(payload.components), [payload.components])
  const kindItems = [{ value: ALL_KINDS, label: t("componentKindAll") }, ...kinds.map((value) => ({ value, label: value }))]
  const slugByKind = useMemo(() => new Map(payload.kinds.map((entry) => [entry.key, entry.slug])), [payload.kinds])
  const columns = useMemo(() => componentColumns((value) => slugByKind.get(value)), [slugByKind])
  const rowFilter = useCallback((row: ComponentPayload) => kind === ALL_KINDS || row.kind === kind, [kind])

  return (
    <DataTable
      rows={payload.components}
      columns={columns}
      filterLabelKey="componentFilterLabel"
      filterExampleKey="componentFilterExample"
      filterEmptyKey="componentsFilterEmpty"
      emptyKey="componentsEmpty"
      tableLabelKey="tabComponents"
      searchText={searchTextOf}
      rowFilter={rowFilter}
      getRowId={rowId}
      initialSort={INITIAL_SORT}
      renderTermTip={renderTermTip}
      inputRef={componentsSearchRef}
      query={query}
      onQueryChange={setComponentsQuery}
      toolbar={<FilterSelect label={t("componentKindLabel")} items={kindItems} value={kind} onChange={setKind} />}
    />
  )
}
