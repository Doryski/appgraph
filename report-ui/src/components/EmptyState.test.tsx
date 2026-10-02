import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { stringTable } from "@appgraph/emit/strings.js"
import { renderInReport } from "@/app/test-utils"
import { EmptyState } from "./EmptyState"

const en = stringTable("en")

describe("EmptyState", () => {
  it("renders title, description and a clear action", async () => {
    const onClear = vi.fn()
    renderInReport(<EmptyState title="Nothing here" description="Try another word" onClear={onClear} />)
    expect(screen.getByRole("status")).toHaveTextContent("Nothing here")
    expect(screen.getByText("Try another word")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: en.filterClear }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it("omits the action without onClear", () => {
    renderInReport(<EmptyState title="Nothing here" />)
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
})
