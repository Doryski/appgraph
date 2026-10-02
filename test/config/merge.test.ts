import { describe, expect, it } from "vitest"
import { mergeByName } from "../../src/config/merge.js"

type Rule = { readonly name: string; readonly value: number }

const rule = (name: string, value: number): Rule => ({ name, value })

describe("config/merge mergeByName", () => {
  it("returns an empty list for no lists, empty lists and undefined lists", () => {
    expect(mergeByName<Rule>()).toEqual([])
    expect(mergeByName<Rule>([], [])).toEqual([])
    expect(mergeByName<Rule>(undefined, undefined)).toEqual([])
  })

  it("replaces a same-named entry IN PLACE, so rule order (match order) is preserved", () => {
    const merged = mergeByName([rule("a", 1), rule("b", 1), rule("c", 1)], [rule("b", 2)])

    expect(merged).toEqual([rule("a", 1), rule("b", 2), rule("c", 1)])
  })

  it("appends new names after the defaults, in the order they were given", () => {
    const merged = mergeByName([rule("a", 1)], [rule("z", 1), rule("m", 1)])

    expect(merged.map((entry) => entry.name)).toEqual(["a", "z", "m"])
  })

  it("lets the last list win across three lists and skips undefined ones between them", () => {
    const merged = mergeByName([rule("a", 1)], undefined, [rule("a", 2)], [rule("a", 3)])

    expect(merged).toEqual([rule("a", 3)])
  })

  it("collapses a duplicate inside one list to its last value at the first position", () => {
    const merged = mergeByName([rule("a", 1), rule("b", 1), rule("a", 9)])

    expect(merged).toEqual([rule("a", 9), rule("b", 1)])
  })

  it("treats names as case-sensitive exact keys, including prototype-ish names", () => {
    const merged = mergeByName([rule("Rule", 1), rule("rule", 2), rule("__proto__", 3), rule("constructor", 4)])

    expect(merged.map((entry) => entry.name)).toEqual(["Rule", "rule", "__proto__", "constructor"])
  })

  it("does not mutate its inputs", () => {
    const defaults = [rule("a", 1)]
    const overrides = [rule("a", 2), rule("b", 2)]
    mergeByName(defaults, overrides)

    expect(defaults).toEqual([rule("a", 1)])
    expect(overrides).toEqual([rule("a", 2), rule("b", 2)])
  })
})
