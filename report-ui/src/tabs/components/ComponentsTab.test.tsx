import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AppGraph, FileFacts } from "@appgraph/core/model.js"
import { stringTable } from "@appgraph/emit/strings.js"
import { renderInReport, resetUrlHash } from "@/app/test-utils"
import { resetTabQueries } from "@/lib/tab-query"
import { makeGraph } from "../../../test/render"
import { mockVirtualViewport } from "../../../test/virtual"
import { ComponentsTab } from "./ComponentsTab"

const en = stringTable("en")

const KINDS = ["ui", "widget", "layout"] as const

const facts = (index: number): FileFacts => ({
  file: `src/components/Item${String(index).padStart(4, "0")}.tsx`,
  component: `Item${String(index).padStart(4, "0")}`,
  kind: KINDS[index % KINDS.length]!,
  renders: Array.from({ length: index % 5 }, (_, i) => ({ file: `src/x${i}.tsx`, component: `X${i}` })),
  endpoints: [],
  mutations: 0,
  stores: [],
}) as unknown as FileFacts

const graphOf = (size: number): AppGraph =>
  makeGraph({
    components: Object.fromEntries(
      Array.from({ length: size }, (_, index) => {
        const entry = facts(index)
        return [entry.file, entry]
      }),
    ),
  })

const rowCount = (shown: number, total: number) =>
  en.tableRowCount.replace("{{shown}}", String(shown)).replace("{{total}}", String(total))

describe("ComponentsTab", () => {
  let restore: () => void

  beforeEach(() => {
    resetUrlHash()
    restore = mockVirtualViewport()
  })

  afterEach(() => {
    restore()
    resetTabQueries()
  })

  it("reports every component without a cap", () => {
    renderInReport(<ComponentsTab />, graphOf(450))
    expect(screen.getByText(rowCount(450, 450))).toBeInTheDocument()
  })

  it("finds a component ranked past 400", async () => {
    renderInReport(<ComponentsTab />, graphOf(450))
    await userEvent.type(screen.getByRole("searchbox"), "Item0449")
    expect(await screen.findByText(rowCount(1, 450))).toBeInTheDocument()
    expect(screen.getAllByText("Item0449").length).toBeGreaterThan(0)
  })

  it("narrows rows with the kind select", async () => {
    renderInReport(<ComponentsTab />, graphOf(450))
    await userEvent.click(screen.getByRole("combobox", { name: en.componentKindLabel }))
    await userEvent.click(await screen.findByRole("option", { name: "widget" }))
    expect(await screen.findByText(rowCount(150, 450))).toBeInTheDocument()
  })

  it("lists kinds from all components, sorted", async () => {
    renderInReport(<ComponentsTab />, graphOf(450))
    await userEvent.click(screen.getByRole("combobox", { name: en.componentKindLabel }))
    const options = await screen.findAllByRole("option")
    expect(options.map((option) => option.textContent)).toEqual([en.componentKindAll, "layout", "ui", "widget"])
  })

  it("copies the file path", async () => {
    renderInReport(<ComponentsTab />, graphOf(3))
    const [copy] = screen.getAllByRole("button", { name: /^Copy/ })
    await userEvent.click(copy!)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/^src\/components\/Item\d{4}\.tsx$/))
  })

  it("sorts by renders descending initially", () => {
    renderInReport(<ComponentsTab />, graphOf(10))
    const rows = within(screen.getByRole("table")).getAllByRole("row")
    expect(within(rows[1]!).getByText("Item0004")).toBeInTheDocument()
  })

  it("shows the empty state without components", () => {
    renderInReport(<ComponentsTab />, graphOf(0))
    expect(screen.getByText(en.componentsEmpty)).toBeInTheDocument()
  })
})
