import { describe, expect, it } from "vitest"
import { formatPlural } from "@appgraph/emit/i18n-runtime.js"
import { PLURAL_KEYS, STRING_KEYS, stringTable, t as serverT } from "@appgraph/emit/strings.js"
import type { Locale, StringKey } from "@appgraph/emit/strings.js"
import { createI18n } from "./i18n"

const LOCALES = ["en", "pl"] as const satisfies readonly Locale[]

const COUNTS = [0, 1, 2, 4, 5, 12, 14, 22, 101, 112] as const

const isStringKey = (key: string): key is StringKey => STRING_KEYS.includes(key)

const PARAMS = { appName: "Shop", query: "x", term: "shell", id: "rr:/a", count: 3, title: "Home" } as const

describe("createI18n", () => {
  it.each(LOCALES)("t matches the server-side t for every %s key", (locale) => {
    const { t } = createI18n(stringTable(locale), locale)
    STRING_KEYS.filter(isStringKey).forEach((key) => {
      expect(t(key, PARAMS), key).toBe(serverT(locale, key, PARAMS))
    })
  })

  it.each(LOCALES)("tPlural matches i18n-runtime formatPlural in %s", (locale) => {
    const table = stringTable(locale)
    const { tPlural } = createI18n(table, locale)
    PLURAL_KEYS.forEach((key) => {
      COUNTS.forEach((count) => {
        expect(tPlural(key, count), `${key}:${count}`).toBe(formatPlural(locale, table[key], count))
      })
    })
  })

  it("picks Polish one/few/many forms", () => {
    const { tPlural } = createI18n(stringTable("pl"), "pl")
    expect(tPlural("screenListCount", 1)).toBe("1 ekran")
    expect(tPlural("screenListCount", 2)).toBe("2 ekrany")
    expect(tPlural("screenListCount", 5)).toBe("5 ekranów")
    expect(tPlural("screenListCount", 22)).toBe("22 ekrany")
    expect(tPlural("screenListCount", 12)).toBe("12 ekranów")
  })

  it("picks English one/other forms", () => {
    const { tPlural } = createI18n(stringTable("en"), "en")
    expect(tPlural("findingsFilterMatches", 1)).toBe("1 finding")
    expect(tPlural("findingsFilterMatches", 0)).toBe("0 findings")
  })

  it("interpolates params and falls back to the key for a missing template", () => {
    const { t } = createI18n({ copyLabel: "Copy {{what}}" }, "en")
    expect(t("copyLabel", { what: "path" })).toBe("Copy path")
    expect(t("copied")).toBe("copied")
  })
})
