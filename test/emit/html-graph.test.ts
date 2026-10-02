import { describe, expect, it } from "vitest"
import { degreeByUrl, edgesTouching, neighbourUrls } from "../../src/emit/html-graph.js"

const edge = (from: string, to: string) => ({ from, to, dynamic: false, weight: 1 })

describe("map edge queries", () => {
  const edges = [edge("/a", "/b"), edge("/b", "/a"), edge("/a", "/c"), edge("/d", "/e")]

  it("counts in- and out-edges per url", () => {
    expect([...degreeByUrl(edges)]).toEqual([
      ["/a", 3],
      ["/b", 2],
      ["/c", 1],
      ["/d", 1],
      ["/e", 1],
    ])
    expect(degreeByUrl([]).size).toBe(0)
  })

  it("keeps the edges touching a url, preserving the edge objects", () => {
    expect(edgesTouching(edges, "/a")).toEqual([edges[0], edges[1], edges[2]])
    expect(edgesTouching(edges, null)).toEqual([])
    expect(edgesTouching(edges, "/zzz")).toEqual([])
  })

  it("lists the other end of each touching edge", () => {
    expect([...neighbourUrls(edgesTouching(edges, "/a"), "/a")]).toEqual(["/b", "/c"])
    expect(neighbourUrls([], "/a").size).toBe(0)
  })
})
