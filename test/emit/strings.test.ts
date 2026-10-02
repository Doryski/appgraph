import { describe, expect, it } from "vitest"
import { PLURAL_FORMS, PLURAL_SEPARATOR } from "../../src/emit/i18n-runtime.js"
import { PLURAL_KEYS, STRING_KEYS, stringTable } from "../../src/emit/strings.js"
import type { Locale, StringKey } from "../../src/emit/strings.js"

const LOCALES = ["en", "pl"] as const satisfies readonly Locale[]

const segmentCount = (locale: Locale, key: StringKey): number =>
  stringTable(locale)[key].split(PLURAL_SEPARATOR).length

describe("plural keys", () => {
  it.each(LOCALES)("each plural key has one segment per %s plural form", (locale) => {
    PLURAL_KEYS.forEach((key) => {
      expect(segmentCount(locale, key), key).toBe(PLURAL_FORMS[locale].length)
    })
  })

  it("only plural keys use the plural separator", () => {
    const pluralKeys = new Set<string>(PLURAL_KEYS)
    LOCALES.forEach((locale) => {
      const offenders = Object.entries(stringTable(locale))
        .filter(([key, value]) => !pluralKeys.has(key) && value.includes(PLURAL_SEPARATOR))
        .map(([key]) => key)
      expect(offenders, locale).toEqual([])
    })
  })

  it("every plural segment carries the count", () => {
    LOCALES.forEach((locale) => {
      PLURAL_KEYS.forEach((key) => {
        const segments = stringTable(locale)[key].split(PLURAL_SEPARATOR)
        segments.forEach((segment) => expect(segment, `${locale}.${key}`).toContain("{{count}}"))
      })
    })
  })
})

describe("string tables", () => {
  it.each(LOCALES)("%s has a non-empty value for every key", (locale) => {
    const table = stringTable(locale)
    const empty = Object.entries(table).filter(([, value]) => value.trim() === "")
    expect(empty).toEqual([])
    expect(Object.keys(table)).toEqual([...STRING_KEYS])
  })
})
