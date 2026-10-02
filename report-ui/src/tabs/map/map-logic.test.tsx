import { describe, expect, it } from "vitest"
import { degreeByUrl } from "@appgraph/emit/html-graph.js"
import { matchingUrls, nextNode } from "./graph-model"
import type { MapEdge, MapNode } from "./graph-model"
import { panZoomReducer } from "./usePanZoom"
import { MAX_ZOOM_RATIO, MIN_ZOOM_RATIO, VISIBLE_SHARE, baseView, clampView, clientToView, reveal, zoomCentered } from "./viewbox"

const node = (id: string, x: number, y: number, title: string | null = null): MapNode => ({
  id,
  url: `/${id}`,
  title,
  protected: false,
  auth: "public",
  x,
  y,
  labelEnd: x + 40,
  prefix: "",
  radius: 4,
})

const edge = (from: string, to: string): MapEdge => ({ from, to, dynamic: false, weight: 1, d: "M0,0" })

const columns = [node("a", 10, 10), node("b", 10, 40), node("c", 10, 70), node("d", 200, 30), node("e", 200, 75)]

describe("nextNode", () => {
  it("walks the column order with up and down and stops at the ends", () => {
    expect(nextNode(columns, "a", "ArrowDown")?.id).toBe("b")
    expect(nextNode(columns, "c", "ArrowDown")?.id).toBe("d")
    expect(nextNode(columns, "a", "ArrowUp")).toBeUndefined()
    expect(nextNode(columns, "e", "ArrowDown")).toBeUndefined()
    expect(nextNode(columns, "c", "Home")?.id).toBe("a")
    expect(nextNode(columns, "a", "End")?.id).toBe("e")
  })

  it("jumps to the vertically nearest node of the adjacent column with left and right", () => {
    expect(nextNode(columns, "b", "ArrowRight")?.id).toBe("d")
    expect(nextNode(columns, "c", "ArrowRight")?.id).toBe("e")
    expect(nextNode(columns, "e", "ArrowLeft")?.id).toBe("c")
    expect(nextNode(columns, "d", "ArrowRight")).toBeUndefined()
    expect(nextNode(columns, "a", "ArrowLeft")).toBeUndefined()
  })
})

describe("graph helpers", () => {
  it("matches url and title case-insensitively and ignores blank queries", () => {
    const nodes = [node("orders", 0, 0, "Invoices"), node("users", 0, 20)]
    expect([...matchingUrls(nodes, "  INVOICES ")]).toEqual(["/orders"])
    expect([...matchingUrls(nodes, "user")]).toEqual(["/users"])
    expect(matchingUrls(nodes, "   ").size).toBe(0)
  })

  it("counts distinct links per url in both directions", () => {
    const degree = degreeByUrl([edge("/a", "/b"), edge("/b", "/a"), edge("/a", "/c")])
    expect(degree.get("/a")).toBe(3)
    expect(degree.get("/c")).toBe(1)
  })
})

describe("viewbox", () => {
  const base = baseView(1000, 500)

  it("keeps zoom inside the 0.1x-2x range", () => {
    const zoomedIn = Array.from({ length: 30 }).reduce<typeof base>((view) => zoomCentered(view, base, 1 / 1.25), base)
    expect(zoomedIn.w).toBeCloseTo(base.w * MIN_ZOOM_RATIO)
    const zoomedOut = Array.from({ length: 30 }).reduce<typeof base>((view) => zoomCentered(view, base, 1.25), base)
    expect(zoomedOut.w).toBeCloseTo(base.w * MAX_ZOOM_RATIO)
  })

  it("clamps pan so part of the layout stays visible", () => {
    const lost = clampView({ x: 5000, y: -5000, w: 1000, h: 500 }, base)
    expect(lost.x).toBe(base.w - base.w * VISIBLE_SHARE)
    expect(lost.y).toBe(base.h * VISIBLE_SHARE - 500)
  })

  it("reveals an off-screen point by centring on it and leaves visible points alone", () => {
    const view = { x: 0, y: 0, w: 200, h: 100 }
    expect(reveal(view, base, 100, 50)).toBe(view)
    expect(reveal(view, base, 600, 300)).toEqual({ x: 500, y: 250, w: 200, h: 100 })
  })

  it("maps client coordinates through a letterboxed meet viewport", () => {
    const view = { x: 0, y: 0, w: 1000, h: 500 }
    const rect = { left: 0, top: 0, width: 500, height: 500 }
    expect(clientToView(view, rect, 250, 250)).toEqual({ x: 500, y: 250 })
    expect(clientToView(view, rect, 0, 125)).toEqual({ x: 0, y: 0 })
  })

  it("returns the same state when an action changes nothing", () => {
    const state = { base, view: base }
    expect(panZoomReducer(state, { type: "fit" })).toBe(state)
    expect(panZoomReducer(state, { type: "reveal", x: 500, y: 250 })).toBe(state)
  })
})
