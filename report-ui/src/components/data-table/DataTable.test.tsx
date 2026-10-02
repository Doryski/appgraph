import { act, fireEvent, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { renderInReport } from "@/app/test-utils"
import { mockVirtualViewport } from "../../../test/virtual"
import { DataTable, VIRTUALIZE_AT } from "./DataTable"
import { defineColumns } from "./columns"
import { compareNumber, compareText } from "./sorting"

type Item = {
  readonly name: string
  readonly count: number | null
  readonly path: string
}

const columns = defineColumns<Item>()([
  { id: "name", headerKey: "colComponent", accessor: (row) => row.name, sort: "text" },
  { id: "count", headerKey: "colRenders", accessor: (row) => row.count, sort: "num", align: "end" },
  { id: "path", headerKey: "colFile", accessor: (row) => row.path, sort: null, mono: true },
])

const ITEMS: readonly Item[] = [
  { name: "beta", count: 3, path: "src/b.tsx" },
  { name: "Alpha", count: null, path: "src/a.tsx" },
  { name: "gamma", count: 10, path: "src/g.tsx" },
  { name: "alpha", count: 3, path: "src/a2.tsx" },
]

const makeItems = (size: number): readonly Item[] =>
  Array.from({ length: size }, (_, index) => ({
    name: `Item${String(index).padStart(4, "0")}`,
    count: index % 7 === 0 ? null : index % 13,
    path: `src/item-${index}.tsx`,
  }))

const renderTable = (rows: readonly Item[]) =>
  renderInReport(
    <DataTable
      rows={rows}
      columns={columns}
      filterLabelKey="componentFilterLabel"
      filterExampleKey="componentFilterExample"
      filterEmptyKey="componentsFilterEmpty"
      emptyKey="menuEmpty"
      tableLabelKey="tabComponents"
    />,
  )

const bodyRows = () => {
  const table = screen.getByRole("table")
  const tbody = table.querySelector("tbody")
  if (!tbody) throw new Error("tbody missing")
  return within(tbody)
    .getAllByRole("row")
    .filter((row) => !row.hasAttribute("data-spacer"))
}

const columnTexts = (index: number) => bodyRows().map((row) => row.querySelectorAll("td")[index]?.textContent ?? "")

const headerOf = (name: RegExp) => screen.getByRole("columnheader", { name })

const typeFilter = (value: string) => {
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a component" }), { target: { value } })
}

describe("DataTable sorting", () => {
  it("sorts text ascending first by code point, then toggles to descending", () => {
    renderTable(ITEMS)
    const button = screen.getByRole("button", { name: "Sort by Component / route" })
    expect(headerOf(/Component/)).toHaveAttribute("aria-sort", "none")

    fireEvent.click(button)
    expect(columnTexts(0)).toEqual(["Alpha", "alpha", "beta", "gamma"])
    expect(headerOf(/Component/)).toHaveAttribute("aria-sort", "ascending")
    expect(screen.getByRole("button", { name: "Sort by Component / route, ascending" })).toBeInTheDocument()

    fireEvent.click(button)
    expect(columnTexts(0)).toEqual(["gamma", "beta", "alpha", "Alpha"])
    expect(headerOf(/Component/)).toHaveAttribute("aria-sort", "descending")

    fireEvent.click(button)
    expect(headerOf(/Component/)).toHaveAttribute("aria-sort", "ascending")
  })

  it("sorts numbers descending first with nulls last and a stable tie-break", () => {
    renderTable(ITEMS)
    const button = screen.getByRole("button", { name: "Sort by Renders" })

    fireEvent.click(button)
    expect(columnTexts(0)).toEqual(["gamma", "beta", "alpha", "Alpha"])
    expect(headerOf(/Renders/)).toHaveAttribute("aria-sort", "descending")

    fireEvent.click(button)
    expect(columnTexts(0)).toEqual(["beta", "alpha", "gamma", "Alpha"])
    expect(headerOf(/Renders/)).toHaveAttribute("aria-sort", "ascending")
  })

  it("moves aria-sort to the most recently sorted column", () => {
    renderTable(ITEMS)
    fireEvent.click(screen.getByRole("button", { name: "Sort by Component / route" }))
    fireEvent.click(screen.getByRole("button", { name: "Sort by Renders" }))
    expect(headerOf(/Component/)).toHaveAttribute("aria-sort", "none")
    expect(headerOf(/Renders/)).toHaveAttribute("aria-sort", "descending")
  })

  it("leaves unsortable columns without a sort button or aria-sort", () => {
    renderTable(ITEMS)
    expect(headerOf(/File/)).not.toHaveAttribute("aria-sort")
    expect(screen.queryByRole("button", { name: /File/ })).not.toBeInTheDocument()
  })

  it("never yields NaN for null or non-numeric values", () => {
    const values = [null, 3, "abc", "", 0, -2, null] as const
    values.forEach((a) => {
      values.forEach((b) => {
        expect(Number.isNaN(compareNumber(a, b))).toBe(false)
        expect(Number.isNaN(compareText(a, b))).toBe(false)
      })
    })
  })
})

describe("DataTable filtering", () => {
  it("shows a visible label with an example placeholder", () => {
    renderTable(ITEMS)
    const input = screen.getByRole("searchbox", { name: "Find a component" })
    expect(input).toHaveAttribute("placeholder", "e.g. Header, src/ui/forms")
  })

  it("filters case-insensitively and announces the count in a polite live region", () => {
    renderTable(ITEMS)
    const count = screen.getByText("Rows: 4 of 4")
    expect(count).toHaveAttribute("aria-live", "polite")

    typeFilter("ALPHA")
    expect(columnTexts(0)).toEqual(["Alpha", "alpha"])
    expect(count).toHaveTextContent("Rows: 2 of 4")
  })

  it("shows an empty state with a clear button that restores all rows", () => {
    renderTable(ITEMS)
    typeFilter("zzz")
    expect(screen.getByText("No components match “zzz”.")).toBeInTheDocument()
    expect(screen.getByText("Rows: 0 of 4")).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }))
    expect(bodyRows()).toHaveLength(4)
    expect(screen.getByRole("searchbox", { name: "Find a component" })).toHaveValue("")
    expect(screen.getByRole("searchbox", { name: "Find a component" })).toHaveFocus()
    expect(screen.getByText("Rows: 4 of 4")).toBeInTheDocument()
  })

  it("clears the filter on Escape", () => {
    renderTable(ITEMS)
    typeFilter("beta")
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Find a component" }), { key: "Escape" })
    expect(bodyRows()).toHaveLength(4)
  })

  it("applies an external row filter and keeps the total", () => {
    renderInReport(
      <DataTable
        rows={ITEMS}
        columns={columns}
        rowFilter={(row) => row.count === 3}
        filterLabelKey="componentFilterLabel"
        filterExampleKey="componentFilterExample"
        filterEmptyKey="componentsFilterEmpty"
        emptyKey="menuEmpty"
        tableLabelKey="tabComponents"
      />,
    )
    expect(columnTexts(0)).toEqual(["beta", "alpha"])
    expect(screen.getByText("Rows: 2 of 4")).toBeInTheDocument()
  })

  it("shows the empty message, not the query message, when the row filter leaves nothing", () => {
    renderInReport(
      <DataTable
        rows={ITEMS}
        columns={columns}
        rowFilter={() => false}
        filterLabelKey="componentFilterLabel"
        filterExampleKey="componentFilterExample"
        filterEmptyKey="componentsFilterEmpty"
        emptyKey="menuEmpty"
        tableLabelKey="tabComponents"
      />,
    )
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "alpha" } })
    expect(screen.getByText("No menu entries.")).toBeInTheDocument()
  })

  it("shows the no-data empty state without a clear button", () => {
    renderTable([])
    expect(screen.getByText("No menu entries.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear filter" })).not.toBeInTheDocument()
  })
})

describe("DataTable virtualization", () => {
  let restore: () => void = () => {}

  beforeEach(() => {
    restore = mockVirtualViewport()
  })

  afterEach(() => {
    restore()
  })

  it("renders every row below the threshold without a scroll container", () => {
    renderTable(makeItems(100))
    expect(bodyRows()).toHaveLength(100)
    expect(document.querySelector("[data-virtualized]")).toBeNull()
  })

  it("renders a bounded window of a 2,000-row table with a sticky header", async () => {
    renderTable(makeItems(2000))
    await act(async () => {})
    const container = document.querySelector("[data-virtualized]")
    expect(container).not.toBeNull()
    const tbodyRows = screen.getByRole("table").querySelectorAll("tbody tr")
    expect(tbodyRows.length).toBeGreaterThan(0)
    expect(tbodyRows.length).toBeLessThanOrEqual(60)
    expect(screen.getByRole("table").querySelector("thead")?.className).toContain("sticky")
    expect(screen.getByText("Rows: 2000 of 2000")).toBeInTheDocument()
  })

  it("exports the virtualization threshold", () => {
    expect(VIRTUALIZE_AT).toBe(150)
  })
})

describe("DataTable header tips", () => {
  const tippedColumns = defineColumns<Item>()([
    { id: "name", headerKey: "colComponent", accessor: (row) => row.name, sort: "text", glossaryTerm: "kind" },
    { id: "count", headerKey: "colRenders", accessor: (row) => row.count, sort: "num", align: "end", glossaryTerm: "renderEdges" },
    { id: "path", headerKey: "colFile", accessor: (row) => row.path, sort: "text" },
  ])

  const sortButtonIn = (name: RegExp) => {
    const button = headerOf(name).querySelector("button:not([aria-label^='What'])")
    if (!(button instanceof HTMLElement)) throw new Error("sort button missing")
    return button
  }

  it.each([
    ["a start-aligned", /Component/, "-me-2.75"],
    ["an end-aligned", /Renders/, "-ms-2.75"],
  ])("pulls the tip toward the sort icon on %s column", (_, name, margin) => {
    renderInReport(
      <DataTable
        rows={ITEMS}
        columns={tippedColumns}
        filterLabelKey="componentFilterLabel"
        filterExampleKey="componentFilterExample"
        filterEmptyKey="componentsFilterEmpty"
        emptyKey="menuEmpty"
        tableLabelKey="tabComponents"
        renderTermTip={(term) => <button type="button" aria-label={`What is ${term}`} />}
      />,
    )
    expect(sortButtonIn(name).className).toContain(margin)
    expect(sortButtonIn(/File/).className).not.toMatch(/-m[se]-2\.75/)
  })

  it("keeps the symmetric margin when the table renders no tips", () => {
    renderTable(ITEMS)
    expect(sortButtonIn(/Component/).className).not.toMatch(/-m[se]-2\.75/)
  })
})
