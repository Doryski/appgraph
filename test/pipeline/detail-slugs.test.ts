import { describe, expect, it } from "vitest"
import { slugOf, uniqueSlugs } from "../../src/pipeline/registry.js"

describe("uniqueSlugs", () => {
  it("keeps plain slugs when nothing collides", () => {
    const slugs = uniqueSlugs(["/orders", "/orders/:id"])
    expect(slugs.get("/orders")).toBe("orders")
    expect(slugs.get("/orders/:id")).toBe("orders-id")
  })

  it("suffixes a stable hash onto every colliding slug", () => {
    const slugs = uniqueSlugs(["/a-b", "/a/b"])
    const first = slugs.get("/a-b") ?? ""
    const second = slugs.get("/a/b") ?? ""
    expect(first).not.toBe(second)
    expect(first.startsWith(`${slugOf("/a-b")}-`)).toBe(true)
    expect(uniqueSlugs(["/a/b", "/a-b"]).get("/a-b")).toBe(first)
  })

  it("separates the root screen from a /root screen", () => {
    const slugs = uniqueSlugs(["/", "/root"])
    expect(new Set(slugs.values()).size).toBe(2)
  })
})
