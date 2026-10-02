import { useMemo, useState } from "react"
import type { ComponentType } from "react"
import { List } from "lucide-react"
import { flattenNavGroups, groupNames } from "@appgraph/emit/report-derive.js"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/EmptyState"
import { FilterSelect } from "@/components/FilterSelect"
import { useI18n, usePayload } from "@/app/report-context"
import type { TabPanelProps } from "@/app/panels"
import { searchInputRef } from "@/hotkeys/search-registry"
import { MENU_COLUMNS } from "./columns"
import { MENU_GROUP_ALL_KEY, MENU_GROUP_FILTER_LABEL_KEY } from "./keys"
import type { MenuRow } from "./rows"

const ALL_GROUPS = "__all__"

const menuSearchRef = searchInputRef("menu")

const getRowId = (row: MenuRow, index: number) => `${index}:${row.group}:${row.path}`

export const MenuTab: ComponentType<TabPanelProps> = () => {
  const { t } = useI18n()
  const { navGroups } = usePayload()
  const [group, setGroup] = useState(ALL_GROUPS)
  const rows = useMemo(() => flattenNavGroups(navGroups), [navGroups])
  const groups = useMemo(() => groupNames(navGroups), [navGroups])
  const groupItems = [
    { value: ALL_GROUPS, label: t(MENU_GROUP_ALL_KEY) },
    ...groups.map((name) => ({ value: name, label: name })),
  ]
  const rowFilter = useMemo(
    () => (group === ALL_GROUPS ? undefined : (row: MenuRow) => row.group === group),
    [group],
  )

  if (navGroups.length === 0) return <EmptyState title={t("menuEmpty")} icon={List} />

  return (
    <DataTable
      rows={rows}
      columns={MENU_COLUMNS}
      rowFilter={rowFilter}
      getRowId={getRowId}
      filterLabelKey="menuFilterLabel"
      filterExampleKey="menuFilterExample"
      filterEmptyKey="menuFilterEmpty"
      emptyKey="menuEmpty"
      tableLabelKey="tabMenu"
      inputRef={menuSearchRef}
      toolbar={
        <FilterSelect label={t(MENU_GROUP_FILTER_LABEL_KEY)} items={groupItems} value={group} onChange={setGroup} />
      }
    />
  )
}
