import { describe, expect, it } from "vitest"
import { scanTags } from "../../src/core/tag-scan.js"

describe("scanTags", () => {
  it("finds every opening tag of the wanted names in one pass, with offsets and lines", () => {
    const text = "<div>\n  <NuxtLayout>\n    <NuxtPage />\n  </NuxtLayout>\n</div>"
    const found = scanTags(text, { tags: ["NuxtLayout", "NuxtPage"] })

    expect(found.map(({ tag, line }) => [tag, line])).toEqual([
      ["NuxtLayout", 2],
      ["NuxtPage", 3],
    ])
    expect(found.map(({ pos, end }) => text.slice(pos, end))).toEqual(["<NuxtLayout>", "<NuxtPage />"])
  })

  it("requires a name boundary and ignores closing tags", () => {
    expect(scanTags("<NuxtLayoutX /></NuxtLayout>", { tags: ["NuxtLayout"] })).toEqual([])
    expect(scanTags("<NuxtLayout", { tags: ["NuxtLayout"] }).map(({ tag }) => tag)).toEqual(["NuxtLayout"])
  })

  it("skips comments, including multi-line and unclosed ones, and keeps counting their lines", () => {
    const text = "<!-- <A> -->\n<!--\n<A>\n-->\n<A />\n<!-- <A>"
    const found = scanTags(text, { tags: ["A"] })

    expect(found.map(({ line }) => line)).toEqual([5])
  })

  it("reads static, valueless and quoted attributes, with > inside quotes", () => {
    const [tag] = scanTags("<A name=\"x > y\" flag data-id='7' size=3\n  :bound=\"a\"/>", { tags: ["A"] })

    expect(tag?.attributes).toEqual([
      { name: "name", value: "x > y" },
      { name: "flag", value: null },
      { name: "data-id", value: "7" },
      { name: "size", value: "3" },
      { name: ":bound", value: "a" },
    ])
  })

  it("counts CRLF and lone CR as one line break each", () => {
    const found = scanTags("<p>\r\n<A />\r\r\n<A />", { tags: ["A"] })

    expect(found.map(({ line }) => line)).toEqual([2, 4])
  })

  it("scans only the given range but keeps file lines", () => {
    const text = "<A />\n<template>\n  <A />\n</template>\n<A />"
    const from = text.indexOf("<template>")
    const to = text.indexOf("</template>")
    const found = scanTags(text, { tags: ["A"], from, to })

    expect(found.map(({ pos, line }) => [pos, line])).toEqual([[text.indexOf("  <A />") + 2, 3]])
  })

  it("finds nothing when no tag is wanted", () => {
    expect(scanTags("<A />", { tags: [] })).toEqual([])
    expect(scanTags("<A />", { tags: [""] })).toEqual([])
  })
})
