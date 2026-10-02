import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { statValue } from "@appgraph/emit/report-derive.js"
import { buildReportPayload } from "@appgraph/emit/report-payload.js"
import { stringTable } from "@appgraph/emit/strings.js"
import { App } from "@/app/App"
import { renderInReport, resetUrlHash } from "@/app/test-utils"
import { PRIMARY_STATS, SECONDARY_STATS } from "@/config/stats"
import { TABS } from "@/config/tabs"
import { buildFixtureGraph, FIXTURE_APP_NAME } from "../../e2e/fixture-graph"
import { createI18n } from "@/lib/i18n"
import { makeGraph } from "../test/render"

const en = stringTable("en")
const fixture = buildFixtureGraph()
const fixtureMeta = buildReportPayload(fixture, { locale: "en", generatedAt: null }).meta

const statElement = (id: string) => {
  const element = document.querySelector(`[data-slot="count-stat"][data-stat-id="${id}"]`)
  if (!(element instanceof HTMLElement)) throw new Error(`stat ${id} not rendered`)
  return element
}

afterEach(() => {
  resetUrlHash()
})

describe("App header", () => {
  it("shows the title and the four primary counts from the payload", () => {
    renderInReport(<App />, fixture)
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(FIXTURE_APP_NAME)
    expect(document.querySelectorAll('[data-slot="count-stat"]')).toHaveLength(4)
    PRIMARY_STATS.forEach((stat) => {
      const element = statElement(stat.id)
      expect(element).toHaveTextContent(String(statValue(fixtureMeta, stat.id)))
      expect(element).toHaveTextContent(en[stat.labelKey])
      expect(within(element).getByRole("button", { name: en.infoTipLabel.replace("{{term}}", en[stat.labelKey]) })).toBeInTheDocument()
    })
  })

  it("marks dead links as an alarm that jumps to Findings", async () => {
    renderInReport(<App />, fixture)
    const deadLinks = statElement("deadLinks")
    expect(deadLinks).toHaveAttribute("data-alarm", "true")
    await userEvent.click(within(deadLinks).getByRole("button", { name: new RegExp(`^\\d+\\s*${en.countDeadLinks}$`) }))
    expect(window.location.hash).toBe("#tab=findings")
  })

  it("declines stat labels by count in Polish", async () => {
    const pl = stringTable("pl")
    const { tPlural } = createI18n(pl, "pl")
    expect(tPlural("statScreensPlural", 57)).toBe("57 ekranów")
    expect(tPlural("statScreensPlural", 2)).toBe("2 ekrany")
    expect(tPlural("statScreensPlural", 1)).toBe("1 ekran")
    renderInReport(<App />, fixture, { locale: "pl" })
    expect(within(statElement("deadLinks")).getByRole("button", { name: "2 martwe linki" })).toBeInTheDocument()
  })

  it("does not alarm when there are no dead links", () => {
    renderInReport(<App />, makeGraph())
    expect(statElement("deadLinks")).not.toHaveAttribute("data-alarm")
  })

  it("lists secondary stats in the More stats popover and hides zero API routes", async () => {
    renderInReport(<App />, makeGraph())
    await userEvent.click(screen.getByRole("button", { name: en.moreStatsLabel }))
    const list = await screen.findByText(en.moreStatsTitle)
    const popover = list.closest('[data-slot="popover-content"]')
    if (!(popover instanceof HTMLElement)) throw new Error("popover missing")
    SECONDARY_STATS.filter((stat) => stat.id !== "apiRoutes").forEach((stat) => {
      expect(within(popover).getByText(en[stat.labelKey])).toBeInTheDocument()
    })
    expect(within(popover).queryByText(en.countApiRoutes)).not.toBeInTheDocument()
  })

  it("shows generatedAt only when present", () => {
    renderInReport(<App />, makeGraph(), { generatedAt: "2026-10-02T10:00:00.000Z" })
    expect(screen.getByText("2026-10-02T10:00:00.000Z")).toBeInTheDocument()
  })

  it("links Limitations to Findings when limitations exist", async () => {
    renderInReport(<App />, fixture)
    await userEvent.click(screen.getByRole("button", { name: en.limitationsLink }))
    expect(window.location.hash).toBe("#tab=findings")
  })

  it("hides the Limitations link when there are none", () => {
    renderInReport(<App />, makeGraph())
    expect(screen.queryByRole("button", { name: en.limitationsLink })).not.toBeInTheDocument()
  })
})

describe("App tabs", () => {
  it("renders one tablist with all tabs, which doubles as the mobile bottom bar", () => {
    renderInReport(<App />, makeGraph())
    const tablist = screen.getByRole("tablist", { name: en.tabsLabel })
    expect(within(tablist).getAllByRole("tab")).toHaveLength(TABS.length)
    expect(tablist.className).toContain("fixed")
    expect(tablist.className).toContain("bottom-0")
    expect(tablist.className).toContain("md:relative")
  })

  it("updates the hash and the panel when a tab is clicked", async () => {
    renderInReport(<App />, makeGraph())
    expect(screen.getByRole("tab", { name: en.tabScreens })).toHaveAttribute("aria-selected", "true")
    await userEvent.click(screen.getByRole("tab", { name: en.tabComponents }))
    expect(window.location.hash).toBe("#tab=components")
    expect(screen.getByRole("tab", { name: en.tabComponents })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tabpanel", { name: en.tabComponents })).toBeInTheDocument()
  })

  it("opens the tab named in the hash", () => {
    window.history.replaceState(null, "", "#tab=menu")
    renderInReport(<App />, makeGraph())
    expect(screen.getByRole("tabpanel", { name: en.tabMenu })).toBeInTheDocument()
  })

  it("has a skip link to the main content", async () => {
    renderInReport(<App />, makeGraph())
    await userEvent.click(screen.getByRole("link", { name: en.skipToContent }))
    expect(document.activeElement).toBe(document.getElementById("main-content"))
    expect(window.location.hash).toBe("")
  })
})

describe("App help tips", () => {
  const tipName = new RegExp(`^${en.infoTipLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{\\{term\\}\\}", ".+")}$`)
  const besideNonText = (tip: HTMLElement) => tip.closest("th") !== null || tip.closest("span")?.querySelector("[data-badge]") != null

  it.each(TABS.map((tab) => tab.id))("keeps every label tip in the %s tab inline after its label", async (id) => {
    window.history.replaceState(null, "", `#tab=${id}`)
    renderInReport(<App />, fixture)
    await userEvent.click(screen.getByRole("button", { name: en.moreStatsLabel }))
    await screen.findByText(en.moreStatsTitle)
    const tips = screen.getAllByRole("button", { name: tipName, hidden: true }).filter((tip) => !besideNonText(tip))
    expect(tips.length).toBeGreaterThan(0)
    tips.forEach((tip) => {
      expect(tip.closest('[data-slot="info-tip-label"]')).not.toBeNull()
      expect(tip.parentElement?.closest("button")).toBeNull()
    })
  })

  it("keeps the dead-links tip on the label line, outside the alarm button", () => {
    renderInReport(<App />, fixture)
    const deadLinks = statElement("deadLinks")
    const tip = within(deadLinks).getByRole("button", { name: en.infoTipLabel.replace("{{term}}", en.countDeadLinks) })
    const label = tip.closest('[data-slot="info-tip-label"]')
    expect(label).toHaveTextContent(en.countDeadLinks)
    expect(label).not.toHaveTextContent(/\d/)
    expect(tip.parentElement?.closest("button")).toBeNull()
  })
})

describe("App empty report", () => {
  const emptyGraph = makeGraph({
    meta: { ...makeGraph().meta, emptyResult: true, emptyReason: "no route files matched" },
  })

  it("shows the empty state with the reason in content tabs", () => {
    renderInReport(<App />, emptyGraph)
    const panel = screen.getByRole("tabpanel")
    expect(within(panel).getByText(en.emptyResultTitle)).toBeInTheDocument()
    expect(within(panel).getByText("no route files matched")).toBeInTheDocument()
  })

  it("keeps Findings reachable from the empty state", async () => {
    renderInReport(<App />, emptyGraph)
    await userEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: en.tabFindings }))
    expect(window.location.hash).toBe("#tab=findings")
    expect(screen.getByRole("tabpanel", { name: en.tabFindings })).toBeInTheDocument()
  })
})
