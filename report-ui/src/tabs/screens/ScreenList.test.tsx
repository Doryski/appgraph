import { act, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { stringTable } from "@appgraph/emit/strings.js"
import type * as I18nModule from "@/lib/i18n"
import { renderInReport, resetUrlHash } from "@/app/test-utils"
import { TABS } from "@/config/tabs"
import { moveScreenList } from "@/hotkeys/screen-list-bus"
import { selectScreen } from "@/lib/url-state"
import { makeGraph } from "../../../test/render"
import { mockVirtualViewport } from "../../../test/virtual"
import { ScreensTab } from "./ScreensTab"
import { makeScreen } from "./test-fixtures"

vi.mock("@/lib/i18n", async (importOriginal) => {
  const original = await importOriginal<typeof I18nModule>()
  return { ...original, ...original.createI18n(stringTable("en"), "en") }
})

const screensTab = TABS[0]

const graph = makeGraph({
  screens: [
    makeScreen("alpha", { url: "/alpha", title: "Alpha page", auth: "protected" }),
    makeScreen("beta", { url: "/beta", title: "Beta page", auth: "unknown" }),
    makeScreen("gamma", { url: "/gamma", title: "Gamma page", auth: "public" }),
    makeScreen("api-health", { url: "/api/health", kindTag: "apiRoute" }),
    makeScreen("api-orders", { url: "/api/orders", kindTag: "apiRoute" }),
  ],
})

const renderTab = () => renderInReport(<ScreensTab tab={screensTab} />, graph)

const list = () => screen.getByRole("list", { name: "Screens" })

const row = (id: string) => list().querySelector<HTMLButtonElement>(`[data-screen-id="${id}"]`)

const selectedRow = () => list().querySelector('[aria-current="true"]')

const detailHeading = () => screen.getByRole("heading", { level: 2 })

const scrollTopOf = (options: unknown): number =>
  typeof options === "object" && options !== null && "top" in options ? Number(options.top) : 0

const filterInput = () => screen.getByLabelText("Find a screen")

describe("ScreensTab list", () => {
  let restoreViewport: () => void = () => {}

  beforeEach(() => {
    resetUrlHash()
    restoreViewport = mockVirtualViewport()
  })

  afterEach(() => {
    restoreViewport()
    resetUrlHash()
  })

  it("selects the first human screen when the hash is empty", () => {
    renderTab()
    expect(selectedRow()).toHaveAttribute("data-screen-id", "alpha")
    expect(detailHeading()).toHaveTextContent("/alpha")
  })

  it("filtering never changes the selection or the hash", async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, "", "#tab=screens&screen=beta")
    renderTab()
    const hashBefore = window.location.hash
    await user.type(filterInput(), "gamma")
    expect(window.location.hash).toBe(hashBefore)
    expect(detailHeading()).toHaveTextContent("/beta")
    expect(row("beta")).toBeNull()
    expect(row("gamma")).not.toBeNull()
    expect(document.querySelector('[data-slot="selection-hidden"]')).toHaveTextContent("/beta")
  })

  it("shows the three auth states as text, including unknown", () => {
    renderTab()
    expect(within(row("alpha")!).getByText("auth")).toBeInTheDocument()
    expect(within(row("beta")!).getByText("auth unknown")).toBeInTheDocument()
    expect(within(row("gamma")!).getByText("public")).toBeInTheDocument()
  })

  it("collapses the API group and opens it on click or when the filter matches inside", async () => {
    const user = userEvent.setup()
    renderTab()
    const toggle = screen.getByRole("button", { name: /API routes/ })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(row("api-health")).toBeNull()
    await user.click(toggle)
    expect(row("api-health")).not.toBeNull()
    await user.click(toggle)
    expect(row("api-health")).toBeNull()
    await user.type(filterInput(), "orders")
    expect(screen.getByRole("button", { name: /API routes/ })).toHaveAttribute("aria-expanded", "true")
    expect(row("api-orders")).not.toBeNull()
    expect(row("api-health")).toBeNull()
  })

  it("j/k movement replaces the hash with the next visible screen", () => {
    renderTab()
    const lengthBefore = window.history.length
    act(() => moveScreenList(1))
    expect(window.location.hash).toBe("#tab=screens&screen=beta")
    act(() => moveScreenList(1))
    expect(window.location.hash).toBe("#tab=screens&screen=gamma")
    act(() => moveScreenList(1))
    expect(window.location.hash).toBe("#tab=screens&screen=gamma")
    act(() => moveScreenList(-1))
    expect(window.location.hash).toBe("#tab=screens&screen=beta")
    expect(window.history.length).toBe(lengthBefore)
    expect(selectedRow()).toHaveAttribute("data-screen-id", "beta")
  })

  it("clicking a row pushes a history entry", async () => {
    const user = userEvent.setup()
    renderTab()
    const lengthBefore = window.history.length
    await user.click(row("gamma")!)
    expect(window.location.hash).toBe("#tab=screens&screen=gamma")
    expect(window.history.length).toBe(lengthBefore + 1)
    expect(detailHeading()).toHaveTextContent("/gamma")
  })

  it("shows an empty state with the query and clears it", async () => {
    const user = userEvent.setup()
    renderTab()
    await user.type(filterInput(), "zzz")
    expect(screen.getByText("No screens match “zzz”")).toBeInTheDocument()
    expect(screen.getByText("0 screens")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Clear filter" }))
    expect(filterInput()).toHaveValue("")
    expect(filterInput()).toHaveFocus()
    expect(row("alpha")).not.toBeNull()
  })

  it("opens the collapsed API group when an API screen is selected from outside the list", () => {
    renderTab()
    expect(screen.getByRole("button", { name: /API routes/ })).toHaveAttribute("aria-expanded", "false")
    act(() => selectScreen("api-orders", "push"))
    expect(screen.getByRole("button", { name: /API routes/ })).toHaveAttribute("aria-expanded", "true")
    expect(selectedRow()).toHaveAttribute("data-screen-id", "api-orders")
  })

  it("scrolls the list to a selection made outside the list", () => {
    const many = makeGraph({
      screens: Array.from({ length: 60 }, (_, index) => makeScreen(`s${String(index).padStart(2, "0")}`)),
    })
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, value: 100_000 })
    renderInReport(<ScreensTab tab={screensTab} />, many)
    const scrollTo = vi.spyOn(Element.prototype, "scrollTo")
    act(() => selectScreen("s55", "push"))
    const offsets = scrollTo.mock.calls.map((call: readonly unknown[]) => scrollTopOf(call[0]))
    expect(offsets.some((top) => top > 0)).toBe(true)
    scrollTo.mockRestore()
    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight")
  })

  it("falls back to the default screen for an unknown hash", () => {
    window.history.replaceState(null, "", "#tab=screens&screen=nope")
    renderTab()
    expect(detailHeading()).toHaveTextContent("/alpha")
  })
})
