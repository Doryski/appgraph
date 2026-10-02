import { createElement } from "react"
import { defineColumns } from "@/components/data-table"
import { DashCell, FlagCell, GroupCell, PathCell } from "./cells"
import { MENU_GROUP_COLUMN_KEY } from "./keys"
import type { MenuRow } from "./rows"

export const MENU_COLUMNS = defineColumns<MenuRow>()([
  {
    id: "group",
    headerKey: MENU_GROUP_COLUMN_KEY,
    accessor: (row) => row.group,
    cell: (row) => createElement(GroupCell, { row }),
    sort: "text",
  },
  {
    id: "title",
    headerKey: "menuColTitle",
    accessor: (row) => row.label,
    cell: (row) => createElement(DashCell, { value: row.label }),
    sort: "text",
  },
  {
    id: "labelKey",
    headerKey: "menuColI18nKey",
    accessor: (row) => row.labelKey,
    cell: (row) => createElement(DashCell, { value: row.labelKey }),
    sort: "text",
    mono: true,
  },
  {
    id: "path",
    headerKey: "menuColPath",
    accessor: (row) => row.path,
    cell: (row) => createElement(PathCell, { row }),
    sort: "text",
    mono: true,
  },
  {
    id: "featureFlag",
    headerKey: "menuColFlag",
    accessor: (row) => row.featureFlag,
    cell: (row) => createElement(FlagCell, { row }),
    sort: "text",
  },
  {
    id: "parentPath",
    headerKey: "menuColParent",
    accessor: (row) => row.parentPath,
    cell: (row) => createElement(DashCell, { value: row.parentPath }),
    sort: "text",
    mono: true,
  },
])
