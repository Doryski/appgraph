import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildReportPayload } from "@appgraph/emit/report-payload.js"
import { stringTable } from "@appgraph/emit/strings.js"
import { App } from "@/app/App"
import { renderInReport, resetUrlHash } from "@/app/test-utils"
import { TABS } from "@/config/tabs"
import { HOTKEYS, isSequenceEntry } from "@/hotkeys/config"
import { PALETTE_GROUP_LIMIT } from "@appgraph/emit/report-derive.js"
import { moveScreenList, onScreenListMove, screenListMoveRef } from "@/hotkeys/screen-list-bus"
import { searchInputRef } from "@/hotkeys/search-registry"
import { DEEP_LINK_SCREEN_ID, LOW_RANK_COMPONENT, buildFixtureGraph } from "../../../e2e/fixture-graph"
import { makeGraph } from "../../test/render"

const en = stringTable("en")
const fixture = buildFixtureGraph()
const fixturePayload = buildReportPayload(fixture, { locale: "en", generatedAt: null })

const isMac = /mac/i.test(`${navigator.platform} ${navigator.userAgent}`)
const MOD = isMac ? "Meta" : "Control"

const pressModK = () => userEvent.keyboard(`{${MOD}>}k{/${MOD}}`)

const deepLinkScreen = () => {
  const found = fixturePayload.screens.find((item) => item.id === DEEP_LINK_SCREEN_ID)
  if (found === undefined) throw new Error("fixture screen missing")
  return found
}

const SearchProbe = () => (
  <>
    <input aria-label="probe search" ref={searchInputRef("screens")} defaultValue="abc" />
    <input aria-label="other field" />
  </>
)

afterEach(() => {
  resetUrlHash()
})

describe("hotkeys config", () => {
  it("derives the g sequences from the tab config", () => {
    const sequences = HOTKEYS.filter(isSequenceEntry)
    expect(sequences).toHaveLength(TABS.length)
    TABS.forEach((tab) => {
      const entry = sequences.find((item) => item.tab === tab.id)
      expect(entry?.sequence).toEqual(["G", tab.sequenceKey.toUpperCase()])
    })
  })

  it("only lets the palette and Escape through while typing", () => {
    expect(HOTKEYS.filter((entry) => entry.allowInInputs).map((entry) => entry.id)).toEqual(["open-palette", "dismiss"])
  })
})

describe("global hotkeys", () => {
  it("g then c switches to Components", async () => {
    renderInReport(<App />, makeGraph())
    await userEvent.keyboard("gc")
    expect(window.location.hash).toBe("#tab=components")
    expect(screen.getByRole("tab", { name: en.tabComponents })).toHaveAttribute("aria-selected", "true")
  })

  it("g then f switches to Findings", async () => {
    renderInReport(<App />, makeGraph())
    await userEvent.keyboard("gf")
    expect(window.location.hash).toBe("#tab=findings")
  })

  it("? opens the shortcuts dialog listing every shortcut, Escape closes it", async () => {
    renderInReport(<App />, makeGraph())
    await userEvent.keyboard("?")
    const dialog = await screen.findByRole("dialog", { name: en.shortcutsTitle })
    expect(within(dialog).getByText(en.shortcutsIntro)).toBeInTheDocument()
    expect(dialog.querySelectorAll('[data-slot="shortcut"]')).toHaveLength(HOTKEYS.length)
    HOTKEYS.forEach((entry) => expect(within(dialog).getByText(en[entry.labelKey])).toBeInTheDocument())
    expect(within(dialog).getAllByText(en.shortcutThen).length).toBeGreaterThan(0)
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("does not switch tabs while a dialog is open", async () => {
    renderInReport(<App />, makeGraph())
    await userEvent.keyboard("?")
    await screen.findByRole("dialog", { name: en.shortcutsTitle })
    await userEvent.keyboard("gc")
    expect(window.location.hash).toBe("")
  })

  it("the header Shortcuts button opens the dialog", async () => {
    renderInReport(<App />, makeGraph())
    await userEvent.click(screen.getByRole("button", { name: en.shortcutsOpen }))
    expect(await screen.findByRole("dialog", { name: en.shortcutsTitle })).toBeInTheDocument()
  })

  it("/ focuses the registered search input of the active tab, but not while typing", async () => {
    renderInReport(
      <>
        <App />
        <SearchProbe />
      </>,
      makeGraph(),
    )
    const other = screen.getByRole("textbox", { name: "other field" })
    await userEvent.click(other)
    await userEvent.keyboard("/")
    expect(other).toHaveFocus()
    expect(other).toHaveValue("/")
    other.blur()
    await userEvent.keyboard("/")
    const probe = screen.getByRole("textbox", { name: "probe search" })
    expect(probe).toHaveFocus()
    expect(probe).toHaveValue("abc")
  })

  it("g sequences do not fire while typing", async () => {
    renderInReport(
      <>
        <App />
        <SearchProbe />
      </>,
      makeGraph(),
    )
    await userEvent.click(screen.getByRole("textbox", { name: "other field" }))
    await userEvent.keyboard("gc")
    expect(window.location.hash).toBe("")
  })
})

describe("command palette", () => {
  it("Mod+K opens the palette and picking a screen deep-links to it", async () => {
    renderInReport(<App />, fixture)
    await pressModK()
    const input = await screen.findByPlaceholderText(en.palettePlaceholder)
    const target = deepLinkScreen()
    await userEvent.type(input, target.id)
    const option = await screen.findByRole("option", { name: new RegExp(target.primaryLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
    await userEvent.click(option)
    expect(window.location.hash).toContain(`screen=${DEEP_LINK_SCREEN_ID}`)
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("Mod+K opens the palette while typing in an input", async () => {
    renderInReport(
      <>
        <App />
        <SearchProbe />
      </>,
      fixture,
    )
    await userEvent.click(screen.getByRole("textbox", { name: "other field" }))
    await pressModK()
    expect(await screen.findByPlaceholderText(en.palettePlaceholder)).toBeInTheDocument()
  })

  it("opens from the header button and shows the group headings", async () => {
    renderInReport(<App />, fixture)
    await userEvent.click(screen.getByRole("button", { name: en.paletteOpen }))
    const dialog = await screen.findByRole("dialog")
    const headings = Array.from(dialog.querySelectorAll("[cmdk-group-heading]"), (element) => element.textContent)
    expect(headings).toEqual([en.paletteGroupTabs, en.paletteGroupScreens, en.tabComponents, en.paletteGroupActions])
  })

  it("caps each group and still finds items past the cap by typing", async () => {
    renderInReport(<App />, fixture)
    await pressModK()
    const input = await screen.findByPlaceholderText(en.palettePlaceholder)
    const componentsGroup = () => document.querySelector('[data-palette-group="components"]')
    expect(componentsGroup()?.querySelectorAll('[cmdk-item=""]')).toHaveLength(PALETTE_GROUP_LIMIT)
    expect(screen.getByText(en.paletteKeepTyping)).toBeInTheDocument()
    fireEvent.change(input, { target: { value: LOW_RANK_COMPONENT } })
    await waitFor(() => expect(componentsGroup()).toHaveTextContent(LOW_RANK_COMPONENT))
    expect(screen.queryByText(en.paletteKeepTyping)).not.toBeInTheDocument()
  })

  it("selecting a component opens the Components tab filtered to it", async () => {
    renderInReport(<App />, fixture)
    await pressModK()
    const input = await screen.findByPlaceholderText(en.palettePlaceholder)
    fireEvent.change(input, { target: { value: LOW_RANK_COMPONENT } })
    await userEvent.click(await screen.findByRole("option", { name: new RegExp(LOW_RANK_COMPONENT) }))
    expect(window.location.hash).toBe("#tab=components")
    const component = fixturePayload.components.find((item) => item.component === LOW_RANK_COMPONENT)
    const panel = screen.getByRole("tabpanel", { name: en.tabComponents })
    expect(within(panel).getByLabelText(en.componentFilterLabel)).toHaveValue(component?.file)
    const shownOne = en.tableRowCount.replace("{{shown}}", "1").replace("{{total}}", String(fixturePayload.components.length))
    await waitFor(() => expect(within(panel).getByText(shownOne)).toBeInTheDocument())
  })

  it("shows the empty message when nothing matches and Escape closes", async () => {
    renderInReport(<App />, fixture)
    await pressModK()
    const input = await screen.findByPlaceholderText(en.palettePlaceholder)
    fireEvent.change(input, { target: { value: "zzzz-no-such-thing" } })
    expect(await screen.findByText(en.paletteEmpty)).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("the shortcuts action swaps the palette for the shortcuts dialog", async () => {
    renderInReport(<App />, makeGraph())
    await pressModK()
    await userEvent.click(await screen.findByRole("option", { name: new RegExp(en.shortcutsOpen) }))
    expect(await screen.findByRole("dialog", { name: en.shortcutsTitle })).toBeInTheDocument()
  })
})

describe("screen list bus", () => {
  it("publishes j/k and arrows only on the Screens tab", async () => {
    const handler = vi.fn()
    const unsubscribe = onScreenListMove(handler)
    renderInReport(<App />, makeGraph())
    await userEvent.keyboard("j{ArrowDown}k{ArrowUp}")
    expect(handler.mock.calls).toEqual([[1], [1], [-1], [-1]])
    handler.mockClear()
    await userEvent.keyboard("gm")
    await userEvent.keyboard("j")
    expect(handler).not.toHaveBeenCalled()
    unsubscribe()
  })

  it("moves the list only when focus is in the screen list or on the page body", async () => {
    const handler = vi.fn()
    const unsubscribe = onScreenListMove(handler)
    renderInReport(
      <>
        <App />
        <div data-slot="screen-list">
          <button type="button">in list</button>
        </div>
        <div role="region" aria-label="outside" tabIndex={0} />
      </>,
      makeGraph(),
    )
    screen.getByRole("region", { name: "outside" }).focus()
    await userEvent.keyboard("{ArrowDown}j")
    expect(handler).not.toHaveBeenCalled()
    screen.getByRole("button", { name: "in list" }).focus()
    await userEvent.keyboard("{ArrowDown}")
    expect(handler.mock.calls).toEqual([[1]])
    unsubscribe()
  })

  it("unsubscribes through the returned function and the ref cleanup", () => {
    const handler = vi.fn()
    onScreenListMove(handler)()
    const cleanup = screenListMoveRef(handler)(document.body)
    moveScreenList(1)
    cleanup?.()
    moveScreenList(-1)
    expect(handler.mock.calls).toEqual([[1]])
  })
})
