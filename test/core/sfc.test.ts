import { describe, expect, it } from "vitest"
import { mentionsTag, splitSfc, templateBlock, virtualScript } from "../../src/core/sfc.js"

const contentOf = (text: string, type: string): readonly string[] =>
  splitSfc(text)
    .filter((block) => block.type === type)
    .map((block) => text.slice(block.contentStart, block.contentEnd))

const linesOf = (text: string): readonly string[] => text.split(/(?<=\n)/)

const DUAL = [
  "<script lang=\"ts\">",
  "export default { name: 'Dual' }",
  "</script>",
  "",
  "<script setup lang=\"ts\">",
  "import Child from './Child.vue'",
  "const n: number = 1",
  "</script>",
  "",
  "<template>",
  "  <Child :n=\"n\" />",
  "</template>",
  "",
  "<style scoped>",
  ".a { color: red }",
  "</style>",
  "",
].join("\n")

const NESTED = [
  "<template>",
  "  <div>",
  "    <template v-if=\"ok\">",
  "      <template #slot>x</template>",
  "    </template>",
  "  </div>",
  "</template>",
  "<script setup>",
  "const ok = true",
  "</script>",
].join("\n")

const CRLF = "<template>\r\n  <p>{{ a }}</p>\r\n</template>\r\n<script setup lang=\"tsx\">\r\nconst a = <b />\r\n</script>\r\n"

const CUSTOM = [
  "<!-- top-level comment <script>bogus</script> -->",
  "<route lang=\"json\">",
  "{ \"name\": \"home\", \"x\": \"</template>\" }",
  "</route>",
  "<i18n>",
  "{ \"en\": { \"hi\": \"<script>\" } }",
  "</i18n>",
  "<template lang=\"pug\">",
  "div",
  "  template(v-if=\"x\") </route>",
  "</template>",
  "<script>",
  "export default {}",
  "</script>",
].join("\n")

const QUOTED = [
  "<template>",
  "  <a title=\"a > b </template>\" :x='y > 1 ? \"<template>\" : 2'>{{ '</template>' }}</a>",
  "  <!-- </template> -->",
  "</template>",
  "<script setup lang=\"ts\">",
  "const s = '<template>'",
  "</script>",
].join("\n")

const FIXTURES = { DUAL, NESTED, CRLF, CUSTOM, QUOTED, EMPTY: "", PLAIN: "<template>\n  <p>hi</p>\n</template>\n" } as const

describe("splitSfc", () => {
  it("returns top-level blocks in source order with offsets", () => {
    expect(splitSfc(DUAL).map((block) => block.type)).toEqual(["script", "script", "template", "style"])
    expect(contentOf(DUAL, "style")).toEqual(["\n.a { color: red }\n"])
    const [first] = splitSfc(DUAL)
    expect(first).toMatchObject({ start: 0, contentStart: "<script lang=\"ts\">".length, attrs: { lang: "ts" } })
    expect(DUAL.slice(first?.contentEnd, first?.end)).toBe("</script>")
  })

  it("reads boolean and quoted attributes, including quotes containing '>'", () => {
    const text = "<script setup lang='ts' data-x=\"a > b\" generic=T>\nconst a = 1\n</script>"
    expect(splitSfc(text)[0]?.attrs).toEqual({ setup: true, lang: "ts", "data-x": "a > b", generic: "T" })
    expect(contentOf(text, "script")).toEqual(["\nconst a = 1\n"])
  })

  it("tracks nested <template> depth", () => {
    expect(splitSfc(NESTED).map((block) => block.type)).toEqual(["template", "script"])
    expect(contentOf(NESTED, "template")[0]).toContain("<template #slot>x</template>\n    </template>\n  </div>\n")
    expect(contentOf(NESTED, "template")[0]?.endsWith("</div>\n")).toBe(true)
  })

  it("ignores </template> inside attribute values, interpolations and comments", () => {
    const template = contentOf(QUOTED, "template")[0]
    expect(template).toContain("<!-- </template> -->")
    expect(contentOf(QUOTED, "script")).toEqual(["\nconst s = '<template>'\n"])
  })

  it("skips top-level comments and keeps custom blocks and non-html templates as raw text", () => {
    expect(splitSfc(CUSTOM).map((block) => block.type)).toEqual(["route", "i18n", "template", "script"])
    expect(contentOf(CUSTOM, "route")).toEqual(["\n{ \"name\": \"home\", \"x\": \"</template>\" }\n"])
    expect(contentOf(CUSTOM, "template")).toEqual(["\ndiv\n  template(v-if=\"x\") </route>\n"])
  })

  it("ends <script>/<style> raw text at the first case-insensitive close tag, even inside a JS string (as Vue does)", () => {
    const text = "<script>\nconst s = '</SCRIPT>'\nrest()\n</script>\n<style>a{}</STYLE >"
    expect(contentOf(text, "script")).toEqual(["\nconst s = '"])
    expect(contentOf(text, "style")).toEqual(["a{}"])
  })

  it("does not end raw text at a longer tag name sharing the prefix", () => {
    const text = "<script>\nconst s = '</scripts>'\n</script>"
    expect(contentOf(text, "script")).toEqual(["\nconst s = '</scripts>'\n"])
  })

  it("handles empty files, files without script, self-closing and unclosed blocks", () => {
    expect(splitSfc("")).toEqual([])
    expect(splitSfc(FIXTURES.PLAIN).map((block) => block.type)).toEqual(["template"])
    const selfClosing = "<script src=\"./a.ts\" />\n<template src='./t.html'></template>"
    expect(splitSfc(selfClosing).map((block) => [block.type, block.contentStart === block.contentEnd])).toEqual([
      ["script", true],
      ["template", true],
    ])
    const unclosed = "<script>\nconst a = 1\n"
    expect(splitSfc(unclosed)[0]).toMatchObject({ contentEnd: unclosed.length, end: unclosed.length })
  })
})

describe("virtualScript", () => {
  it("keeps both script blocks at their original offsets and blanks the rest", () => {
    const virtual = virtualScript(DUAL)
    expect(virtual.text).toHaveLength(DUAL.length)
    expect(virtual.lang).toBe("ts")
    expect(virtual.unsupported).toEqual([])
    for (const content of ["export default { name: 'Dual' }", "import Child from './Child.vue'"]) {
      expect(virtual.text.indexOf(content)).toBe(DUAL.indexOf(content))
    }
    expect(virtual.text).not.toContain("<")
    expect(virtual.text).not.toContain("color")
    expect(virtual.text.trim().split(/\s*\n\s*/)).toEqual([
      "export default { name: 'Dual' }",
      "import Child from './Child.vue'",
      "const n: number = 1",
    ])
  })

  it.each([
    ["<script>\n</script>", "js"],
    ["<script lang=\"ts\">\n</script>", "ts"],
    ["<script lang=\"tsx\">\n</script>", "tsx"],
    ["<script lang=\"jsx\">\n</script>", "jsx"],
    ["<script lang=\"TS\">\n</script>", "ts"],
    ["<script lang=\"coffee\">\n</script>", "js"],
    ["<script lang=\"ts\">\n</script><script setup lang=\"tsx\">\n</script>", "tsx"],
    ["<script setup>\n</script><script lang=\"ts\">\n</script>", "ts"],
    ["<template><p /></template>", "js"],
    ["", "js"],
  ] as const)("maps %j to lang %s", (text, lang) => {
    expect(virtualScript(text).lang).toBe(lang)
  })

  it("reports <script src> as unsupported and blanks its content", () => {
    const text = "<script src=\"./logic.ts\" lang=\"ts\">\nignored()\n</script>\n<script setup>\nconst a = 1\n</script>"
    const virtual = virtualScript(text)
    expect(virtual.unsupported).toEqual(["script-src"])
    expect(virtual.text).not.toContain("ignored")
    expect(virtual.text.indexOf("const a = 1")).toBe(text.indexOf("const a = 1"))
  })

  it("preserves CRLF line endings", () => {
    const virtual = virtualScript(CRLF)
    expect(virtual.lang).toBe("tsx")
    expect([...virtual.text.matchAll(/\r\n/g)].map((match) => match.index)).toEqual(
      [...CRLF.matchAll(/\r\n/g)].map((match) => match.index),
    )
    expect(virtual.text.indexOf("const a = <b />")).toBe(CRLF.indexOf("const a = <b />"))
  })

  it("returns an all-blank text for files without script", () => {
    expect(virtualScript("").text).toBe("")
    expect(virtualScript(FIXTURES.PLAIN).text).toBe(FIXTURES.PLAIN.replace(/[^\r\n]/g, " "))
  })

  it.each(Object.entries(FIXTURES))("keeps line and offset parity for %s", (_name, raw) => {
    const virtual = virtualScript(raw).text
    const rawLines = linesOf(raw)
    const virtualLines = linesOf(virtual)
    expect(virtual).toHaveLength(raw.length)
    expect(virtualLines).toHaveLength(rawLines.length)
    rawLines.forEach((line, index) => {
      const twin = virtualLines[index] ?? ""
      expect(twin).toHaveLength(line.length)
      expect([...twin].flatMap((char, at) => (char === "\n" || char === "\r" ? [at] : []))).toEqual(
        [...line].flatMap((char, at) => (char === "\n" || char === "\r" ? [at] : [])),
      )
    })
  })
})

describe("templateBlock", () => {
  it("returns the content range of the top-level template", () => {
    const block = templateBlock(NESTED)
    expect(block).toMatchObject({ lang: "html", src: null })
    expect(NESTED.slice(block?.start, block?.end)).toBe(contentOf(NESTED, "template")[0])
  })

  it("reports pug and src templates", () => {
    expect(templateBlock(CUSTOM)).toMatchObject({ lang: "pug", src: null })
    expect(templateBlock("<template src=\"./view.html\"></template>")).toMatchObject({ lang: "html", src: "./view.html" })
  })

  it("returns null without a template", () => {
    expect(templateBlock("<script>\n</script>")).toBeNull()
    expect(templateBlock("")).toBeNull()
  })
})

describe("mentionsTag", () => {
  const app = "<template>\n  <nuxt-layout>\n    <NuxtPage/>\n  </nuxt-layout>\n</template>\n<script setup>\nconst NuxtLayout = 1\n</script>"

  it("matches Pascal and kebab spellings inside the template", () => {
    expect(mentionsTag(app, ["NuxtLayout"])).toBe(true)
    expect(mentionsTag(app, ["NuxtPage"])).toBe(true)
    expect(mentionsTag("<template><NuxtLayout name=\"x\"></NuxtLayout></template>", ["NuxtLayout"])).toBe(true)
  })

  it("requires a tag boundary and ignores script, comments and other blocks", () => {
    expect(mentionsTag("<template><NuxtLayoutX /></template>", ["NuxtLayout"])).toBe(false)
    expect(mentionsTag("<template><!-- <NuxtLayout> --></template>", ["NuxtLayout"])).toBe(false)
    expect(mentionsTag("<template><p /></template><script>'<NuxtLayout>'</script>", ["NuxtLayout"])).toBe(false)
    expect(mentionsTag("<script>'<NuxtLayout>'</script>", ["NuxtLayout"])).toBe(false)
    expect(mentionsTag(app, [])).toBe(false)
  })
})
