import { fireEvent, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import type { NavigationEdge, Screen } from "@appgraph/core/model.js"
import { stringTable } from "@appgraph/emit/strings.js"
import { renderInReport, resetUrlHash } from "@/app/test-utils"
import { emptyScreenFacts, makeGraph } from "../../../test/render"
import { MapTab } from "./MapTab"

const en = stringTable("en")

const makeScreen = (id: string, url: string | null, overrides: Partial<Screen> = {}): Screen => ({
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
  auth: "public",
  featureFlag: null,
  redirectTo: null,
  devOnly: false,
  addressable: true,
  tree: [],
  reachable: [],
  facts: emptyScreenFacts,
  navigatesTo: [],
  provenance: { sources: [], evidence: [], mergedFrom: [], decisions: [] },
  ...overrides,
})

const nav = (from: string, to: string): NavigationEdge => ({ from, to, trigger: "link", dynamic: false, via: "Link" })

const graph = makeGraph({
  screens: [
    makeScreen("home", "/", { title: "Home" }),
    makeScreen("orders", "/orders", { title: "Invoices list", auth: "protected" }),
    makeScreen("order-detail", "/orders/:id", { auth: "unknown" }),
    makeScreen("admin-users", "/admin/users"),
    makeScreen("admin-roles", "/admin/roles"),
  ],
  navigation: [
    nav("home", "/orders"),
    nav("orders", "/orders/:id"),
    nav("order-detail", "/orders"),
    nav("admin-users", "/admin/roles"),
    nav("home", "/admin/users"),
  ],
})

const renderMap = () => renderInReport(<MapTab />, graph)

const svg = () => screen.getByRole("group", { name: en.graphSvgLabel })

const nodes = () => within(svg()).getAllByRole("button")

const nodeByUrl = (url: string) => {
  const node = nodes().find((candidate) => candidate.getAttribute("data-node-url") === url)
  if (node === undefined) throw new Error(`no node for ${url}`)
  return node
}

const filterInput = () => screen.getByLabelText(en.graphFilterLabel)

const matchCount = () => document.querySelector('[data-slot="map-match-count"]')

describe("MapTab", () => {
  afterEach(() => resetUrlHash())

  it("shows the empty state when no screen has a URL", () => {
    renderInReport(<MapTab />, makeGraph({ screens: [makeScreen("wizard", null)] }))
    expect(screen.getByText(en.graphEmpty)).toBeInTheDocument()
    expect(screen.queryByRole("group", { name: en.graphSvgLabel })).not.toBeInTheDocument()
  })

  it("renders one node per URL screen with the summary in the toolbar", () => {
    renderMap()
    expect(nodes()).toHaveLength(5)
    expect(screen.getByText("5 screens · 5 distinct links")).toBeInTheDocument()
  })

  it("announces the match count in a polite live region", async () => {
    renderMap()
    const live = matchCount()
    expect(live).toHaveAttribute("aria-live", "polite")
    expect(live).toHaveTextContent("")
    await userEvent.type(filterInput(), "orders")
    expect(live).toHaveTextContent("2 matching screens")
    await userEvent.clear(filterInput())
    await userEvent.type(filterInput(), "invoices")
    expect(live).toHaveTextContent("1 matching screen")
    expect(nodeByUrl("/orders")).toHaveAttribute("data-state", "match")
    expect(nodeByUrl("/")).toHaveAttribute("data-state", "dim")
  })

  it("shows the empty message with a clear action when nothing matches", async () => {
    renderMap()
    await userEvent.type(filterInput(), "zzz")
    expect(matchCount()).toHaveTextContent("0 matching screens")
    expect(screen.getByText(en.graphFilterEmpty.replace("{{query}}", "zzz"))).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: en.filterClear }))
    expect(filterInput()).toHaveValue("")
    expect(screen.queryByText(en.graphFilterEmpty.replace("{{query}}", "zzz"))).not.toBeInTheDocument()
  })

  it("clears the filter on Escape", async () => {
    renderMap()
    await userEvent.type(filterInput(), "admin")
    await userEvent.keyboard("{Escape}")
    expect(filterInput()).toHaveValue("")
  })

  it("keeps a single tab stop and moves it with the arrow keys in column order", async () => {
    renderMap()
    const tabStops = () => nodes().filter((node) => node.getAttribute("tabindex") === "0")
    expect(tabStops()).toHaveLength(1)
    const [first, second] = nodes()
    expect(tabStops()[0]).toBe(first)
    first?.focus()
    await userEvent.keyboard("{ArrowDown}")
    expect(document.activeElement).toBe(second)
    expect(tabStops()).toEqual([second])
    await userEvent.keyboard("{ArrowUp}")
    expect(document.activeElement).toBe(first)
    await userEvent.keyboard("{End}")
    expect(document.activeElement).toBe(nodes().at(-1))
    expect(tabStops()).toHaveLength(1)
  })

  it("opens the screen in the Screens tab on Enter", async () => {
    renderMap()
    nodeByUrl("/orders").focus()
    await userEvent.keyboard("{Enter}")
    expect(window.location.hash).toContain("tab=screens")
    expect(window.location.hash).toContain("screen=orders")
  })

  it("opens the screen on click", async () => {
    renderMap()
    await userEvent.click(nodeByUrl("/admin/roles"))
    expect(window.location.hash).toBe("#tab=screens&screen=admin-roles")
  })

  it("labels auth without relying on colour", () => {
    renderMap()
    expect(nodeByUrl("/orders")).toHaveAccessibleName(`/orders — Invoices list, links: 3, ${en.legendNodeAuth}`)
    expect(nodeByUrl("/orders/:id")).toHaveAccessibleName(`/orders/:id, links: 2, ${en.badgeAuthUnknown}`)
    expect(nodeByUrl("/orders").querySelector('[data-auth="protected"]')).not.toBeNull()
    expect(nodeByUrl("/orders/:id").querySelector('[data-auth="unknown"]')).not.toBeNull()
    const legend = document.querySelector('[data-slot="map-legend"]')
    expect(legend).toHaveTextContent(en.legendNodeAuth)
    expect(legend).toHaveTextContent(en.legendAuthUnknown)
  })

  it("draws focused edges in a separate highlight layer without reordering the base edges", () => {
    renderMap()
    const baseOrder = () =>
      Array.from(document.querySelectorAll('[data-layer="edges"] path')).map((path) => path.getAttribute("d"))
    const before = baseOrder()
    fireEvent.focus(nodeByUrl("/orders"))
    const highlight = document.querySelectorAll('[data-layer="highlight"] path')
    const directions = Array.from(highlight).map((path) => path.getAttribute("data-direction"))
    expect(directions.filter((direction) => direction === "out")).toHaveLength(1)
    expect(directions.filter((direction) => direction === "in")).toHaveLength(2)
    const incoming = Array.from(highlight).find((path) => path.getAttribute("data-direction") === "in")
    expect(incoming).toHaveAttribute("stroke-dasharray")
    expect(incoming?.getAttribute("marker-end")).toMatch(/^url\(#.+-arrow-in\)$/)
    expect(nodeByUrl("/orders")).toHaveAttribute("data-state", "focus")
    expect(nodeByUrl("/")).toHaveAttribute("data-state", "near")
    expect(nodeByUrl("/admin/roles")).toHaveAttribute("data-state", "dim")
    expect(baseOrder()).toEqual(before)
    fireEvent.blur(nodeByUrl("/orders"))
    expect(document.querySelectorAll('[data-layer="highlight"] path')).toHaveLength(0)
  })

  it("changes the viewBox with the zoom buttons and restores it with fit", async () => {
    renderMap()
    const initial = svg().getAttribute("viewBox")
    const fit = screen.getByRole("button", { name: en.graphZoomFit })
    expect(fit).toBeDisabled()
    await userEvent.click(screen.getByRole("button", { name: en.graphZoomIn }))
    const zoomed = svg().getAttribute("viewBox")
    expect(zoomed).not.toBe(initial)
    expect(fit).toBeEnabled()
    await userEvent.click(screen.getByRole("button", { name: en.graphZoomOut }))
    await userEvent.click(screen.getByRole("button", { name: en.graphZoomOut }))
    expect(svg().getAttribute("viewBox")).not.toBe(zoomed)
    await userEvent.click(fit)
    expect(svg().getAttribute("viewBox")).toBe(initial)
  })

  it("zooms with ctrl + wheel but leaves a plain wheel to the page", () => {
    renderMap()
    const initial = svg().getAttribute("viewBox")
    fireEvent.wheel(svg(), { deltaY: -200 })
    expect(svg().getAttribute("viewBox")).toBe(initial)
    fireEvent.wheel(svg(), { deltaY: -200, ctrlKey: true })
    expect(svg().getAttribute("viewBox")).not.toBe(initial)
  })

  it("pans on drag past the threshold and suppresses the click that ends it", () => {
    renderMap()
    const initial = svg().getAttribute("viewBox")
    const target = nodeByUrl("/admin/roles")
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 102, clientY: 101 })
    expect(svg().getAttribute("viewBox")).toBe(initial)
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 60, clientY: 80 })
    expect(svg().getAttribute("viewBox")).not.toBe(initial)
    fireEvent.pointerUp(target, { pointerId: 1, clientX: 60, clientY: 80 })
    fireEvent.click(target)
    expect(window.location.hash).not.toContain("screen=admin-roles")
  })
})
