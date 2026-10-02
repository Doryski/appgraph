import { describe, expect, it } from "vitest"
import {
  byCodepoint,
  compareStringArrays,
  sortBy,
  sortStrings,
  sortedEntries,
  sortedUnique,
  stableUnique,
  thenBy,
  uniqueBy,
} from "../../src/core/order.js"

describe("byCodepoint", () => {
  it("orders by codepoint, not by locale", () => {
    expect(byCodepoint("B", "a")).toBe(-1)
    expect("B".localeCompare("a")).toBe(1)
  })

  it("is a total order with 0 only on equality", () => {
    expect(byCodepoint("a", "a")).toBe(0)
    expect(byCodepoint("a", "b")).toBe(-1)
    expect(byCodepoint("b", "a")).toBe(1)
  })

  it("diverges from localeCompare on the shapes that appear in component keys", () => {
    const keys = ["src/Button.tsx", "src/app.tsx", "src/App.tsx", "src/_layout.tsx"]
    expect(sortStrings(keys)).toEqual([
      "src/App.tsx",
      "src/Button.tsx",
      "src/_layout.tsx",
      "src/app.tsx",
    ])
    expect([...keys].sort((a, b) => a.localeCompare(b))).not.toEqual(sortStrings(keys))
  })

  it("sorts underscores and dots deterministically", () => {
    expect(sortStrings(["a.b", "a/b", "a_b", "a-b"])).toEqual(["a-b", "a.b", "a/b", "a_b"])
  })
})

describe("stableUnique", () => {
  it("keeps first occurrence order", () => {
    expect(stableUnique(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"])
  })

  it("sortedUnique dedupes then sorts by codepoint", () => {
    expect(sortedUnique(["b", "A", "b", "a"])).toEqual(["A", "a", "b"])
  })
})

describe("uniqueBy", () => {
  it("dedupes by derived key, keeping the first value", () => {
    const values = [
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "a", n: 3 },
    ]
    expect(uniqueBy(values, (value) => value.id)).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ])
  })
})

describe("sortBy / thenBy / sortedEntries", () => {
  it("sortBy uses the codepoint comparator on the derived key", () => {
    expect(sortBy([{ k: "b" }, { k: "A" }], (value) => value.k)).toEqual([{ k: "A" }, { k: "b" }])
  })

  it("thenBy falls through to later comparators", () => {
    const compare = thenBy<{ a: string; b: string }>(
      (x, y) => byCodepoint(x.a, y.a),
      (x, y) => byCodepoint(x.b, y.b),
    )
    expect(compare({ a: "x", b: "1" }, { a: "x", b: "2" })).toBe(-1)
    expect(compare({ a: "x", b: "1" }, { a: "x", b: "1" })).toBe(0)
  })

  it("sortedEntries never depends on object insertion order", () => {
    expect(sortedEntries({ b: 1, a: 2 })).toEqual([
      ["a", 2],
      ["b", 1],
    ])
  })
})

describe("compareStringArrays", () => {
  it("compares element-wise then by length", () => {
    expect(compareStringArrays(["a"], ["a", "b"])).toBe(-1)
    expect(compareStringArrays(["a", "b"], ["a", "b"])).toBe(0)
    expect(compareStringArrays(["b"], ["a", "b"])).toBe(1)
  })
})
