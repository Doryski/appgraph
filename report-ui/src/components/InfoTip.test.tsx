import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { stringTable } from "@appgraph/emit/strings.js"
import { renderInReport } from "@/app/test-utils"
import { GlossaryTip, InfoTip, InfoTipLabel } from "./InfoTip"

const en = stringTable("en")

describe("InfoTip", () => {
  it("opens its explanation on click", async () => {
    renderInReport(<InfoTip term="shell" help="The shared frame around a screen." />)
    const trigger = screen.getByRole("button", { name: en.infoTipLabel.replace("{{term}}", "shell") })
    expect(screen.queryByText("The shared frame around a screen.")).not.toBeInTheDocument()
    await userEvent.click(trigger)
    expect(await screen.findByText("The shared frame around a screen.")).toBeInTheDocument()
  })

  it("opens from the keyboard", async () => {
    renderInReport(<InfoTip term="depth" help="How deep it goes." />)
    await userEvent.tab()
    await userEvent.keyboard("{Enter}")
    expect(await screen.findByText("How deep it goes.")).toBeInTheDocument()
  })

  it("resolves glossary terms by id", async () => {
    renderInReport(<GlossaryTip id="shell" />)
    await userEvent.click(screen.getByRole("button", { name: en.infoTipLabel.replace("{{term}}", en.sectionShell) }))
    expect(await screen.findByText(en.helpShell)).toBeInTheDocument()
  })
})

const labelOf = (heading: HTMLElement) => {
  const label = heading.closest('[data-slot="info-tip-label"]')
  if (!(label instanceof HTMLElement)) throw new Error("info-tip-label missing")
  return label
}

describe("InfoTipLabel", () => {
  it.each([
    ["a short label", "Stores"],
    ["a label that wraps", "Feature gates (getConfiguration / featureFlag)"],
    ["a single unbreakable word", "data-testid"],
  ])("flows the tip inline right after %s", (_, term) => {
    renderInReport(
      <InfoTipLabel tip={<InfoTip term={term} help="help" />}>
        <h3>{term}</h3>
      </InfoTipLabel>,
    )
    const heading = screen.getByRole("heading", { name: term })
    const label = labelOf(heading)
    const tip = screen.getByRole("button", { name: en.infoTipLabel.replace("{{term}}", term) })
    const slot = tip.parentElement?.parentElement
    expect(label.className).not.toMatch(/\bflex\b/)
    expect(label.className).toContain("pe-6.5")
    expect(label.className).toContain("*:first:inline")
    expect(heading).not.toContainElement(tip)
    expect(label.lastElementChild).toBe(slot)
    expect(slot?.className).toContain("w-0")
    expect(heading.compareDocumentPosition(tip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it.each([null, false, undefined])("renders only the label when the tip is %s", (tip) => {
    renderInReport(
      <InfoTipLabel tip={tip}>
        <h3>Stores</h3>
      </InfoTipLabel>,
    )
    expect(labelOf(screen.getByRole("heading", { name: "Stores" })).children).toHaveLength(1)
  })
})
