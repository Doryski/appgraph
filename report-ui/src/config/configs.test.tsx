import { describe, expect, it } from "vitest"
import { STRING_KEYS, stringTable } from "@appgraph/emit/strings.js"
import type { Locale } from "@appgraph/emit/strings.js"
import { buildReportPayload } from "@appgraph/emit/report-payload.js"
import { makeGraph } from "../../test/render"
import { GLOSSARY } from "./glossary"
import { statValue } from "@appgraph/emit/report-derive.js"
import { STATS } from "./stats"
import { TABS } from "./tabs"

const LOCALES = ["en", "pl"] as const satisfies readonly Locale[]

const configKeys = [
  ...TABS.flatMap((tab) => [tab.labelKey, tab.descriptionKey]),
  ...GLOSSARY.flatMap((term) => [term.labelKey, term.helpKey]),
  ...STATS.flatMap((stat) => [stat.labelKey, stat.helpKey]),
]

describe("config string keys", () => {
  it.each(LOCALES)("every config key resolves to a non-empty %s string", (locale) => {
    const table: Readonly<Record<string, string>> = stringTable(locale)
    const missing = configKeys.filter((key) => (table[key] ?? "").trim() === "")
    expect(missing).toEqual([])
  })

  it("the glossary explains every help key exactly once", () => {
    const helpKeys = STRING_KEYS.filter((key) => key.startsWith("help"))
    expect(GLOSSARY.map((term) => term.helpKey).sort()).toEqual([...helpKeys].sort())
  })

  it("stats reuse the glossary explanation for their term", () => {
    const glossaryHelp = new Set<string>(GLOSSARY.map((term) => term.helpKey))
    STATS.forEach((stat) => expect(glossaryHelp.has(stat.helpKey), stat.id).toBe(true))
  })
})

describe("tabs", () => {
  it("has unique ids and sequence keys", () => {
    expect(new Set(TABS.map((tab) => tab.id)).size).toBe(TABS.length)
    expect(new Set(TABS.map((tab) => tab.sequenceKey)).size).toBe(TABS.length)
  })
})

describe("stats", () => {
  it("covers every header count plus depth, with four primary stats", () => {
    const meta = buildReportPayload(makeGraph(), { locale: "en", generatedAt: null }).meta
    expect(STATS.map((stat) => stat.id).sort()).toEqual([...Object.keys(meta.counts), "depth"].sort())
    expect(STATS.filter((stat) => stat.primary).map((stat) => stat.id)).toEqual([
      "screens",
      "components",
      "endpoints",
      "deadLinks",
    ])
    expect(STATS.filter((stat) => stat.alarm).map((stat) => stat.id)).toEqual(["deadLinks"])
    expect(statValue(meta, "depth")).toBe(3)
    expect(statValue(meta, "screens")).toBe(0)
  })
})
