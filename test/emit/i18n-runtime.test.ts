import { describe, expect, it } from "vitest"
import { formatPlural, interpolate, pickPlural, pluralForm } from "../../src/emit/i18n-runtime.js"
import { t } from "../../src/emit/strings.js"

const PLURAL_CASES = [
  { count: 0, en: "other", pl: "many" },
  { count: 1, en: "one", pl: "one" },
  { count: 2, en: "other", pl: "few" },
  { count: 4, en: "other", pl: "few" },
  { count: 5, en: "other", pl: "many" },
  { count: 12, en: "other", pl: "many" },
  { count: 14, en: "other", pl: "many" },
  { count: 22, en: "other", pl: "few" },
  { count: 101, en: "other", pl: "many" },
  { count: 112, en: "other", pl: "many" },
] as const

const SEGMENTS = {
  en: { template: "{{count}} screen|{{count}} screens", forms: { one: "{{count}} screen", other: "{{count}} screens" } },
  pl: {
    template: "{{count}} ekran|{{count}} ekrany|{{count}} ekranów",
    forms: { one: "{{count}} ekran", few: "{{count}} ekrany", many: "{{count}} ekranów" },
  },
} as const

describe("pluralForm", () => {
  it.each(PLURAL_CASES)("picks the right forms for $count", ({ count, en, pl }) => {
    expect(pluralForm("en", count)).toBe(en)
    expect(pluralForm("pl", count)).toBe(pl)
  })
})

describe("pickPlural", () => {
  it.each(PLURAL_CASES)("picks the matching segment for $count", ({ count, en, pl }) => {
    expect(pickPlural("en", SEGMENTS.en.template, count)).toBe(SEGMENTS.en.forms[en])
    expect(pickPlural("pl", SEGMENTS.pl.template, count)).toBe(SEGMENTS.pl.forms[pl])
  })

  it("falls back to the last segment when a template has too few segments", () => {
    expect(pickPlural("pl", "a|b", 5)).toBe("b")
    expect(pickPlural("en", "only", 3)).toBe("only")
  })

  it("formats the picked segment with the count", () => {
    expect(formatPlural("pl", SEGMENTS.pl.template, 22)).toBe("22 ekrany")
    expect(formatPlural("en", SEGMENTS.en.template, 1)).toBe("1 screen")
  })
})

describe("interpolate", () => {
  it("substitutes known params and leaves unknown ones literal", () => {
    expect(interpolate("{{a}} and {{b}}", { a: 1 })).toBe("1 and {{b}}")
  })

  it("returns the template untouched without params", () => {
    expect(interpolate("{{a}}", undefined)).toBe("{{a}}")
  })

  it("matches what t() produces through strings.ts", () => {
    expect(t("en", "headerTitle", { appName: "X" })).toBe(interpolate("{{appName}} — screen & component map", { appName: "X" }))
  })
})
