import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { stringTable } from "@appgraph/emit/strings.js"
import { renderInReport } from "@/app/test-utils"
import { Toaster } from "@/components/ui/sonner"
import { CopyButton } from "./CopyButton"

const en = stringTable("en")

describe("CopyButton", () => {
  it("copies the value and confirms with a toast", async () => {
    const writeText = navigator.clipboard.writeText
    renderInReport(
      <>
        <CopyButton value="src/pages/Home.tsx" what="path" />
        <Toaster />
      </>,
    )
    await userEvent.click(screen.getByRole("button", { name: en.copyLabel.replace("{{what}}", "path") }))
    expect(writeText).toHaveBeenCalledWith("src/pages/Home.tsx")
    expect(await screen.findByText(en.copied)).toBeInTheDocument()
  })
})
