import { fireEvent, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AppGraph, Diagnostic, NavEntry, SectionConfidence } from "@appgraph/core/model.js"
import { stringTable } from "@appgraph/emit/strings.js"
import { renderInReport, resetUrlHash } from "@/app/test-utils"
import { makeGraph } from "../../../test/render"
import { FindingsTab } from "./FindingsTab"
import { LIMITATIONS_ANCHOR_ID } from "./index"

const en = stringTable("en")

const deadLink = (path: string, line: number): NavEntry => ({
  path,
  parentPath: null,
  label: "Gone",
  labelKey: null,
  featureFlag: null,
  source: "nav-config",
  file: "src/nav.ts",
  line,
  resolvedScreen: null,
})

const diagnostics: readonly Diagnostic[] = [
  { severity: "info", code: "I_ONE", message: "Info message", plugin: null },
  { severity: "error", code: "E_ONE", message: "Error message", plugin: "react-router", file: "src/a.ts", line: 3 },
  { severity: "warning", code: "W_ONE", message: "Warning message", plugin: null },
]

const confidence: readonly SectionConfidence[] = [
  { section: "screens", count: 4, enablingDependency: "react-router-dom", dependencyInstalled: true, level: "high" },
  { section: "stores", count: 0, enablingDependency: "zustand", dependencyInstalled: true, level: "suspect" },
]

const renderTab = (overrides: Partial<AppGraph> = {}, metaOverrides: Partial<AppGraph["meta"]> = {}) => {
  const base = makeGraph()
  return renderInReport(<FindingsTab />, makeGraph({ ...overrides, meta: { ...base.meta, ...metaOverrides } }))
}

beforeEach(resetUrlHash)
afterEach(resetUrlHash)

describe("FindingsTab empty states", () => {
  it("shows every empty text and hides limitations when nothing was found", () => {
    renderTab()
    expect(screen.getByText(en.findingsDeadLinksEmpty)).toBeInTheDocument()
    expect(screen.getByText(en.findingsOrphansEmpty)).toBeInTheDocument()
    expect(screen.getByText(en.findingsConfidenceEmpty)).toBeInTheDocument()
    expect(screen.getByText(en.diagnosticsEmpty)).toBeInTheDocument()
    expect(screen.queryByText(en.limitationsTitle)).not.toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })

  it("renders sections in order", () => {
    renderTab()
    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)
    expect(headings).toEqual([
      en.findingsDeadLinksTitle,
      en.findingsOrphansTitle,
      en.findingsConfidenceTitle,
      en.findingsDiagnosticsTitle,
    ])
  })

  it("puts limitations before the first section", () => {
    renderTab({ deadNavLinks: [deadLink("/gone/one", 5)] }, { limitations: ["Dynamic imports are not followed"] })
    const alert = document.getElementById(LIMITATIONS_ANCHOR_ID) as HTMLElement
    const section = screen.getByRole("region", { name: en.findingsDeadLinksTitle })
    expect(alert.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("explains an empty result at the top", () => {
    renderTab({}, { emptyResult: true, emptyReason: "no routes" })
    expect(screen.getByText(en.emptyResultTitle)).toBeInTheDocument()
    expect(screen.getByText("no routes")).toBeInTheDocument()
    expect(screen.getByText(en.findingsDeadLinksEmpty)).toBeInTheDocument()
  })
})

describe("dead links", () => {
  it("raises an alarm with icon and count text and lists rows", () => {
    renderTab({ deadNavLinks: [deadLink("/gone/one", 5), deadLink("/gone/two", 6)] })
    const section = screen.getByRole("region", { name: en.findingsDeadLinksTitle })
    const alert = within(section).getByRole("alert")
    expect(alert).toHaveTextContent(`2 ${en.countDeadLinks}`)
    expect(alert.querySelector("svg")).not.toBeNull()
    expect(within(section).getByText("/gone/one")).toBeInTheDocument()
    expect(within(section).getByText("src/nav.ts:6")).toBeInTheDocument()
  })

  it("declines the alarm text by count", () => {
    renderTab({ deadNavLinks: [deadLink("/gone/one", 5)] })
    const alert = within(screen.getByRole("region", { name: en.findingsDeadLinksTitle })).getByRole("alert")
    expect(alert).toHaveTextContent("1 dead link")
    expect(alert).not.toHaveTextContent("1 dead links")
  })

  it("declines the alarm text in Polish", () => {
    const pl = stringTable("pl")
    const links = Array.from({ length: 5 }, (_, index) => deadLink(`/gone/${index}`, index + 1))
    renderInReport(<FindingsTab />, makeGraph({ deadNavLinks: links }), { locale: "pl" })
    const alert = within(screen.getByRole("region", { name: pl.findingsDeadLinksTitle })).getByRole("alert")
    expect(alert).toHaveTextContent("5 martwych linków")
  })
})

describe("dead links sorting", () => {
  it("sorts by the location column", async () => {
    renderTab({ deadNavLinks: [deadLink("/b", 9), deadLink("/a", 2)] })
    const section = screen.getByRole("region", { name: en.findingsDeadLinksTitle })
    await userEvent.click(within(section).getByRole("button", { name: new RegExp(en.deadLinkColLocation) }))
    const paths = within(section)
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelectorAll("td")[0]?.textContent)
    expect(paths).toEqual(["/a", "/b"])
  })

  it("sorts locations by file, then numerically by line", async () => {
    renderTab({ deadNavLinks: [deadLink("/ten", 10), deadLink("/nine", 9)] })
    const section = screen.getByRole("region", { name: en.findingsDeadLinksTitle })
    await userEvent.click(within(section).getByRole("button", { name: new RegExp(en.deadLinkColLocation) }))
    const paths = within(section)
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelectorAll("td")[0]?.textContent)
    expect(paths).toEqual(["/nine", "/ten"])
  })
})

describe("orphans", () => {
  it("selects the screen with a pushed history entry", async () => {
    renderTab({ orphanScreens: ["screen-a", "screen-b"] })
    await userEvent.click(screen.getByRole("button", { name: "screen-b" }))
    expect(window.location.hash).toBe("#tab=screens&screen=screen-b")
  })
})

describe("confidence", () => {
  it("flags unexpectedly empty sections with an icon and text", () => {
    renderTab({}, { confidence })
    const section = screen.getByRole("region", { name: en.findingsConfidenceTitle })
    const badge = within(section).getByText(en.confidenceStatusEmptyUnexpected)
    expect(badge.closest('[data-slot="badge"]')?.querySelector("svg")).not.toBeNull()
    expect(within(section).getByText(en.confidenceSuspectFlag)).toBeInTheDocument()
    expect(within(section).getByText(en.confidenceStatusOk)).toBeInTheDocument()
  })
})

describe("diagnostics", () => {
  const rowCodes = () => {
    const section = screen.getByRole("region", { name: en.findingsDiagnosticsTitle })
    return within(section)
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelectorAll("td")[1]?.textContent)
  }

  it("orders by severity and narrows with the severity select", async () => {
    renderTab({ diagnostics })
    expect(rowCodes()).toEqual(["E_ONE", "W_ONE", "I_ONE"])
    await userEvent.click(screen.getByRole("combobox", { name: en.diagnosticColSeverity }))
    await userEvent.click(await screen.findByRole("option", { name: `${en.severityWarning} (1)` }))
    expect(rowCodes()).toEqual(["W_ONE"])
  })

  it("shows per-severity counts and sorts by severity rank", async () => {
    renderTab({ diagnostics })
    const section = screen.getByRole("region", { name: en.findingsDiagnosticsTitle })
    await userEvent.click(within(section).getByRole("button", { name: new RegExp(en.diagnosticColSeverity) }))
    expect(rowCodes()).toEqual(["E_ONE", "W_ONE", "I_ONE"])
    await userEvent.click(screen.getByRole("combobox", { name: en.diagnosticColSeverity }))
    expect(await screen.findByRole("option", { name: `${en.severityError} (1)` })).toBeInTheDocument()
  })

  it("explains an empty severity filter instead of claiming there are no diagnostics", async () => {
    renderTab({ diagnostics: diagnostics.filter((entry) => entry.severity === "error") })
    await userEvent.click(screen.getByRole("combobox", { name: en.diagnosticColSeverity }))
    await userEvent.click(await screen.findByRole("option", { name: `${en.severityWarning} (0)` }))
    expect(screen.getByText(en.diagnosticsSeverityEmpty)).toBeInTheDocument()
  })

  it("omits the line when a diagnostic has a file but no line", () => {
    renderTab({ diagnostics: [{ severity: "warning", code: "W_FILE", message: "File only", plugin: null, file: "src/b.ts" }] })
    const section = screen.getByRole("region", { name: en.findingsDiagnosticsTitle })
    expect(within(section).getByText("src/b.ts")).toBeInTheDocument()
    expect(within(section).queryByText("src/b.ts:0")).not.toBeInTheDocument()
  })

  it("filters by text", () => {
    renderTab({ diagnostics })
    const section = screen.getByRole("region", { name: en.findingsDiagnosticsTitle })
    fireEvent.change(within(section).getByRole("searchbox"), { target: { value: "E_ONE" } })
    expect(rowCodes()).toEqual(["E_ONE"])
  })
})

describe("limitations", () => {
  it("lists payload limitations under the anchor id", () => {
    renderTab({}, { limitations: ["Dynamic imports are not followed", "Server screens are out of scope"] })
    const alert = document.getElementById(LIMITATIONS_ANCHOR_ID)
    expect(alert).not.toBeNull()
    expect(alert).toHaveTextContent(en.limitationsTitle)
    expect(within(alert as HTMLElement).getAllByRole("listitem")).toHaveLength(2)
  })
})
