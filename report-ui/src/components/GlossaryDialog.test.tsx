import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { stringTable } from "@appgraph/emit/strings.js"
import { renderInReport } from "@/app/test-utils"
import { makeGraph } from "../../test/render"
import { GLOSSARY } from "@/config/glossary"
import { GlossaryDialog } from "./GlossaryDialog"

const en = stringTable("en")

describe("GlossaryDialog", () => {
  it("lists every glossary term with its explanation", async () => {
    renderInReport(<GlossaryDialog />)
    await userEvent.click(screen.getByRole("button", { name: en.glossaryOpen }))
    const dialog = await screen.findByRole("dialog", { name: en.glossaryTitle })
    expect(dialog.querySelectorAll('[data-slot="glossary-term"]')).toHaveLength(GLOSSARY.length)
    GLOSSARY.forEach((term) => {
      expect(within(dialog).getByText(en[term.helpKey])).toBeInTheDocument()
      expect(within(dialog).getAllByText(en[term.labelKey]).length).toBeGreaterThan(0)
    })
  })

  it("localizes the dialog close button", async () => {
    const pl = stringTable("pl")
    renderInReport(<GlossaryDialog />, makeGraph(), { locale: "pl" })
    await userEvent.click(screen.getByRole("button", { name: pl.glossaryOpen }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("button", { name: pl.dialogClose })).toBeInTheDocument()
  })

  it("closes with Escape", async () => {
    renderInReport(<GlossaryDialog />)
    await userEvent.click(screen.getByRole("button", { name: en.glossaryOpen }))
    await screen.findByRole("dialog")
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})
