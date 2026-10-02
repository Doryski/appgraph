import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { stringTable } from "@appgraph/emit/strings.js"
import type * as I18nModule from "@/lib/i18n"
import { renderInReport, resetUrlHash } from "@/app/test-utils"
import { TABS } from "@/config/tabs"
import { mockVirtualViewport } from "../../../../test/virtual"
import { ScreensTab } from "../ScreensTab"
import { makeGraph } from "../../../../test/render"
import { HOSTILE_GUARD, detailGraph, makeScreen, plainScreen } from "../test-fixtures"

vi.mock("@/lib/i18n", async (importOriginal) => {
  const original = await importOriginal<typeof I18nModule>()
  return { ...original, ...original.createI18n(stringTable("en"), "en") }
})

const en = stringTable("en")

const RICH_SECTION_TITLES = [
  en.sectionActivation,
  en.sectionRenderTree,
  en.sectionOutgoingNav,
  en.sectionAncestors,
  en.sectionShell,
  en.sectionEndpoints,
  en.sectionStores,
  en.sectionQueryKeys,
  en.sectionI18n,
  en.sectionFeatureGates,
  en.sectionFormSchemas,
  en.sectionFormFields,
  en.sectionTestIds,
  en.sectionMessages,
  "analytics (plugin channel)",
  en.sectionParams,
  en.sectionReachTitle,
] as const

const renderScreen = (id: string) => {
  window.history.replaceState(null, "", `#tab=screens&screen=${id}`)
  return renderInReport(<ScreensTab tab={TABS[0]} />, detailGraph())
}

const detail = () => document.querySelector<HTMLElement>('[data-slot="screen-detail"]')!

const sectionTitles = () =>
  within(detail())
    .queryAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent)

describe("ScreenDetail", () => {
  let restoreViewport: () => void = () => {}

  beforeEach(() => {
    resetUrlHash()
    restoreViewport = mockVirtualViewport()
  })

  afterEach(() => {
    restoreViewport()
    resetUrlHash()
  })

  it("renders every section of a rich screen in the canonical order", () => {
    renderScreen("rich")
    expect(sectionTitles()).toEqual(RICH_SECTION_TITLES)
    expect(document.querySelector('[data-slot="empty-sections"]')).toBeNull()
  })

  it("renders the header with label, sub line, badges and entry file", () => {
    renderScreen("rich")
    const header = within(detail())
    expect(header.getByRole("heading", { level: 2 })).toHaveTextContent("/rich")
    expect(header.getByText("Rich screen")).toBeInTheDocument()
    expect(header.getAllByText("auth unknown").length).toBeGreaterThan(0)
    expect(header.getAllByText("flag: betaRich").length).toBeGreaterThan(0)
    expect(header.getByRole("button", { name: "Copy src/pages/Rich.tsx" })).toBeInTheDocument()
  })

  it("shows the route name next to the header badges when the screen has one", () => {
    window.history.replaceState(null, "", "#tab=screens&screen=named")
    const named = makeScreen("named", { url: "/named", title: "Named screen", routeName: "user-profile" })
    renderInReport(<ScreensTab tab={TABS[0]} />, makeGraph({ screens: [named, plainScreen] }))
    const badge = detail().querySelector('[data-badge="routeName"]')
    expect(badge).toHaveTextContent(`${en.routeNameLabel}user-profile`)
  })

  it("omits the route name badge when the screen has none", () => {
    renderScreen("rich")
    expect(detail().querySelector('[data-badge="routeName"]')).toBeNull()
  })

  it("shows the full file path in a tooltip", async () => {
    const user = userEvent.setup()
    renderScreen("rich")
    const path = detail().querySelector('[data-slot="file-path"] [data-slot="tooltip-trigger"]') as HTMLElement
    expect(path).not.toHaveAttribute("title")
    await user.hover(path)
    const content = await waitFor(() => {
      const found = document.querySelector('[data-slot="tooltip-content"]')
      if (!found) throw new Error("no tooltip")
      return found
    })
    expect(content).toHaveTextContent("src/pages/Rich.tsx")
  })

  it("renders a hostile guard as text, never as markup", () => {
    renderScreen("rich")
    const guard = detail().querySelector('[data-tag="guard"]')
    expect(guard).toHaveTextContent(`null when ${HOSTILE_GUARD}`)
    expect(detail().querySelector("script")).toBeNull()
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it("shows via, condition and list tags as visible text", () => {
    renderScreen("rich")
    const tags = [...detail().querySelectorAll("[data-tag]")].map((tag) => tag.textContent)
    expect(tags).toEqual(
      expect.arrayContaining(["lazy", "by reference", "selector", "selector (global)", "only when user.isAdmin +1", "list"]),
    )
    expect(tags.some((tag) => tag?.includes("isOpen"))).toBe(false)
  })

  it("lists every condition in the tag popover", async () => {
    const user = userEvent.setup()
    renderScreen("rich")
    await user.click(detail().querySelector<HTMLElement>('[data-tag="condition"]')!)
    expect(await screen.findByText("flags.beta")).toBeInTheDocument()
    expect(screen.getByText(en.helpCondOnly)).toBeInTheDocument()
  })

  it("ties the via-redirect note to its chip button", () => {
    renderScreen("rich")
    const note = detail().querySelector<HTMLElement>('[data-slot="via-redirect"]')!
    const chip = note.closest('[data-slot="nav-chip"]')!
    const button = chip.querySelector<HTMLElement>("[data-goto]")!
    expect(note.id).not.toBe("")
    expect(button).toHaveAccessibleDescription(note.textContent!)
    expect(chip).toHaveClass("flex-wrap")
  })

  it("groups nav chips with a count and marks dynamic targets", () => {
    renderScreen("rich")
    const navigation = detail().querySelector<HTMLElement>('[data-section="navigation"]')!
    expect(within(navigation).getByText("×2")).toBeInTheDocument()
    expect(navigation.querySelector('[data-slot="dynamic-mark"]')).not.toBeNull()
    expect(within(navigation).getByText(en.legendDynamic)).toBeInTheDocument()
  })

  it("renders the endpoints table with method and transport", () => {
    renderScreen("rich")
    const endpoints = detail().querySelector<HTMLElement>('[data-section="endpoints"]')!
    expect(within(endpoints).getByText("/api/rich")).toBeInTheDocument()
    expect(within(endpoints).getByText("rich.load")).toBeInTheDocument()
    expect(endpoints.querySelectorAll('[data-slot="method-badge"]')).toHaveLength(2)
  })

  it("shows only the redirect section for a redirect screen", async () => {
    const user = userEvent.setup()
    renderScreen("legacy")
    expect(sectionTitles()).toEqual([en.sectionRedirect])
    await user.click(within(detail()).getByRole("button", { name: "/plain" }))
    expect(window.location.hash).toBe("#tab=screens&screen=plain")
  })

  it("links a redirect whose target carries a query string to the target screen", async () => {
    const user = userEvent.setup()
    renderScreen("tabbed")
    await user.click(within(detail()).getByRole("button", { name: "/plain?tab=snapshots" }))
    expect(window.location.hash).toBe("#tab=screens&screen=plain")
  })

  it("collapses empty sections behind a toggle with their count", async () => {
    const user = userEvent.setup()
    renderScreen("plain")
    const group = document.querySelector<HTMLElement>('[data-slot="empty-sections"]')!
    expect(sectionTitles()).toEqual([])
    expect(group.querySelector('[data-slot="empty-count"]')).toHaveTextContent("16")
    await user.click(within(group).getByRole("button"))
    expect(sectionTitles()).toContain(en.sectionRenderTree)
    expect(within(detail()).getByText(en.emptyNav)).toBeInTheDocument()
  })
})
