import { createElement } from "react"
import { defineColumns } from "@/components/data-table"
import { CopyButton } from "@/components/CopyButton"
import type { ComponentPayload } from "@appgraph/emit/report-payload.js"
import { KindBadge } from "./KindBadge"

export type KindSlugOf = (kind: string) => string | undefined

const componentCell = (row: ComponentPayload) => {
  if (row.route === null) return createElement("span", { className: "font-mono text-xs" }, row.component)
  return createElement(
    "span",
    { className: "inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5" },
    createElement("span", { className: "font-mono text-xs font-semibold text-foreground" }, row.route),
    createElement(
      "span",
      { className: "rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground" },
      row.component,
    ),
  )
}

const fileCell = (row: ComponentPayload) =>
  createElement(
    "span",
    { className: "inline-flex items-center gap-1" },
    createElement("span", { className: "break-all" }, row.file),
    createElement(CopyButton, { value: row.file, what: row.file }),
  )

export const componentColumns = (slugOf: KindSlugOf) =>
  defineColumns<ComponentPayload>()([
    {
      id: "component",
      headerKey: "colComponent",
      accessor: (row) => row.route ?? row.component,
      cell: componentCell,
      sort: "text",
    },
    {
      id: "kind",
      headerKey: "colKind",
      accessor: (row) => row.kind,
      cell: (row) => createElement(KindBadge, { kind: row.kind, slug: slugOf(row.kind) }),
      sort: "text",
      glossaryTerm: "kind",
    },
    { id: "file", headerKey: "colFile", accessor: (row) => row.file, cell: fileCell, sort: "text", mono: true },
    {
      id: "renders",
      headerKey: "colRenders",
      accessor: (row) => row.renders,
      sort: "num",
      align: "end",
      glossaryTerm: "renderEdges",
    },
    {
      id: "endpoints",
      headerKey: "colEndpoints",
      accessor: (row) => row.endpoints,
      sort: "num",
      align: "end",
      glossaryTerm: "endpoints",
    },
    {
      id: "mutations",
      headerKey: "colMutations",
      accessor: (row) => row.mutations,
      sort: "num",
      align: "end",
    },
    {
      id: "stores",
      headerKey: "colStores",
      accessor: (row) => row.stores.join(", "),
      sort: "text",
      glossaryTerm: "stores",
    },
  ] as const)
