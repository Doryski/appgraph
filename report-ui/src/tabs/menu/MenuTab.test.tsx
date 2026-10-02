import { fireEvent, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import type { NavEntry, NavGroup, Screen } from "@appgraph/core/model.js"
import { stringTable } from "@appgraph/emit/strings.js"
import { renderInReport, resetUrlHash } from "@/app/test-utils"
import { TABS } from "@/config/tabs"
import { emptyScreenFacts, makeGraph } from "../../../test/render"
import { MenuTab } from "./MenuTab"

const en = stringTable("en")

const makeScreen = (id: string, url: string): Screen => ({
  id,
  localId: id,
  source: "react-router",
  activations: [],
  url,
  params: [],
  title: null,
  kindTag: null,
  entries: [],
  ancestors: [],
  shell: null,
  auth: "unknown",
  featureFlag: null,
  redirectTo: null,
  devOnly: false,
  addressable: true,
  tree: [],
  reachable: [],
  facts: emptyScreenFacts,
  navigatesTo: [],
  provenance: { sources: [], evidence: [], mergedFrom: [], decisions: [] },
})

const entry = (path: string, label: string, resolvedScreen: string | null, extra: Partial<NavEntry> = {}): NavEntry => ({
  path,
  parentPath: null,
  label,
  labelKey: null,
  featureFlag: null,
  source: "nav-config",
  file: "src/nav.ts",
  line: 1,
  resolvedScreen,
  ...extra,
})

const groups: readonly NavGroup[] = [
  {
    name: "Main menu",
    source: "nav-config",
    score: 9,
    availableOnShells: ["AppShell"],
    entries: [
      entry("/zeta", "Zeta", "screen-zeta"),
      entry("/alpha", "Alpha", "screen-alpha", { featureFlag: "beta" }),
      entry("/ghost", "Ghost", null),
    ],
  },
  {
    name: "Admin menu",
    source: "nav-config",
    score: 6,
    availableOnShells: [],
    entries: [entry("/admin", "Admin", "screen-admin")],
  },
]

const graph = makeGraph({
  screens: [makeScreen("screen-zeta", "/zeta"), makeScreen("screen-alpha", "/alpha"), makeScreen("screen-admin", "/admin")],
  navGroups: groups,
})

const tab = TABS.find((candidate) => candidate.id === "menu")!

const renderMenu = (g = graph) => renderInReport(<MenuTab tab={tab} />, g)

const bodyRows = () => {
  const tbody = screen.getByRole("table").querySelector("tbody")
  if (!tbody) throw new Error("tbody missing")
  return within(tbody).getAllByRole("row")
}

const columnTexts = (index: number) => bodyRows().map((row) => row.querySelectorAll("td")[index]?.textContent ?? "")

afterEach(resetUrlHash)

describe("MenuTab", () => {
  it("renders rows from both groups", () => {
    renderMenu()
    expect(bodyRows()).toHaveLength(4)
    expect(columnTexts(0).join("|")).toContain("Admin menu")
    expect(columnTexts(0).join("|")).toContain("Main menu")
  })

  it("narrows rows with the group select", async () => {
    renderMenu()
    await userEvent.click(screen.getByRole("combobox"))
    await userEvent.click(await screen.findByRole("option", { name: "Admin menu" }))
    expect(bodyRows()).toHaveLength(1)
    expect(columnTexts(1)).toEqual(["Admin"])
  })

  it("marks entries missing from the router with text", () => {
    renderMenu()
    expect(screen.getAllByText(en.menuMissingInRouter)).toHaveLength(1)
    expect(screen.queryByRole("button", { name: "/ghost" })).not.toBeInTheDocument()
  })

  it("shows the redirect resolution note beside the path", () => {
    const viaRedirect = { from: "/old", to: "/alpha" }
    const redirected = makeGraph({
      screens: [makeScreen("screen-alpha", "/alpha")],
      navGroups: [{ ...groups[0]!, entries: [entry("/old", "Old", "screen-alpha", { viaRedirect }), entry("/alpha", "Alpha", "screen-alpha")] }],
    })
    renderMenu(redirected)
    expect(screen.getAllByText("via redirect /old → /alpha")).toHaveLength(1)
  })

  it("jumps to the linked screen when the path is clicked", () => {
    renderMenu()
    fireEvent.click(screen.getByRole("button", { name: "/alpha" }))
    expect(window.location.hash).toContain("screen=screen-alpha")
    expect(window.location.hash).toContain("tab=screens")
  })

  it("sorts by path", () => {
    renderMenu()
    fireEvent.click(screen.getByRole("button", { name: /Sort by Path/ }))
    expect(columnTexts(3).map((text) => text.replace(en.menuMissingInRouter, "").trim())).toEqual([
      "/admin",
      "/alpha",
      "/ghost",
      "/zeta",
    ])
  })

  it("filters with the search input", () => {
    renderMenu()
    fireEvent.change(screen.getByRole("searchbox", { name: en.menuFilterLabel }), { target: { value: "zeta" } })
    expect(bodyRows()).toHaveLength(1)
  })

  it("shows the empty state without nav groups", () => {
    renderMenu(makeGraph())
    expect(screen.getByText(en.menuEmpty)).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })
})
