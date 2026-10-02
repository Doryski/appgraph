import { describe, expect, it } from "vitest"
import { markTruncated, toYaml, YamlEmitError } from "../../src/emit/yaml.js"
import { oracleOutcome, outcomeOf } from "./yaml-oracle.js"

const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

describe("toYaml structural behaviour", () => {
  it("emits an empty array as []", () => {
    expect(toYaml([])).toBe("[]\n")
  })

  it("emits an empty object as {}", () => {
    expect(toYaml({})).toBe("{}\n")
  })

  it("emits a plain scalar with a trailing newline", () => {
    expect(toYaml("hello")).toBe("hello\n")
  })

  it("emits nested mappings with two-space indentation", () => {
    expect(toYaml({ a: { b: "c" } })).toBe("a:\n  b: c\n")
  })

  it("inlines the first line of a container array item after the dash", () => {
    expect(toYaml([{ a: 1, b: 2 }])).toBe("- a: 1\n  b: 2\n")
  })

  it("preserves insertion order of object keys", () => {
    const value = { z: 1, a: 2, m: 3 }
    expect(toYaml(value)).toBe("z: 1\na: 2\nm: 3\n")
  })

  it("emits null for null and undefined", () => {
    expect(toYaml({ a: null, b: undefined })).toBe("a: null\nb: null\n")
  })

  it("emits booleans and numbers bare", () => {
    expect(toYaml({ a: true, b: 42, c: 1.5 })).toBe("a: true\nb: 42\nc: 1.5\n")
  })
})

describe("the quoting predicate", () => {
  it("quotes a value with a trailing colon", () => {
    const out = toYaml({ k: "foo:" })
    expect(out).toBe('k: "foo:"\n')
  })

  it("quotes a value containing colon-space", () => {
    expect(toYaml({ k: "a: b" })).toBe('k: "a: b"\n')
  })

  it("quotes the empty string", () => {
    expect(toYaml("")).toBe('""\n')
  })

  it("quotes a leading indicator character", () => {
    for (const ch of ["-", "?", ":", ",", "[", "]", "{", "}", "#", "&", "*", "!", "|", ">", "'", '"', "%", "@", "`"]) {
      const value = `${ch}rest`
      expect(toYaml(value)).toBe(`"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`)
    }
  })

  it("quotes space-hash", () => {
    expect(toYaml("hi #not a comment")).toBe('"hi #not a comment"\n')
  })

  it("quotes a leading hash", () => {
    expect(toYaml("#comment")).toBe('"#comment"\n')
  })

  it("quotes leading and trailing whitespace, including tab/cr/ff/vt", () => {
    expect(toYaml(" leading")).toBe('" leading"\n')
    expect(toYaml("trailing ")).toBe('"trailing "\n')
    expect(toYaml("\tleading")).toBe('"\\tleading"\n')
    expect(toYaml("trailing\t")).toBe('"trailing\\t"\n')
    expect(toYaml("trailing\f")).toBe('"trailing\\u000c"\n')
    expect(toYaml("trailing\v")).toBe('"trailing\\u000b"\n')
  })

  it("quotes YAML boolean/null lookalikes case-insensitively", () => {
    for (const word of ["true", "False", "NULL", "Yes", "no", "On", "off", "~"]) {
      expect(toYaml(word)).toBe(`"${word}"\n`)
    }
  })

  it("quotes strings that are full YAML numbers but not cosmetic near-numbers", () => {
    expect(toYaml("1.5")).toBe('"1.5"\n')
    expect(toYaml("1e10")).toBe('"1e10"\n')
    expect(toYaml("-42")).toBe('"-42"\n')
    expect(toYaml("1.2.3")).toBe("1.2.3\n")
    expect(toYaml("v1.0")).toBe("v1.0\n")
    expect(toYaml("/orders/:id")).toBe("/orders/:id\n")
  })

  it("quotes every YAML 1.1/1.2 implicit-type lookalike", () => {
    const hostile = [
      "2024-01-01",
      "2024-1-1",
      "2001-12-14t21:59:43.10-05:00",
      "2001-12-14 21:59:43.10 -5",
      "2001-12-15T02:59:43.1Z",
      "1_000",
      "1_000.5",
      "0b101",
      "-0b1_0",
      "0o17",
      "017",
      "0x1F",
      "0x_1f",
      "190:20:30",
      "-1:30.5",
      ".inf",
      "-.Inf",
      "+.INF",
      ".nan",
      ".NaN",
      "~",
      "y",
      "N",
      "yes",
      "OFF",
      "<<",
      "=",
    ] as const
    for (const value of hostile) {
      expect(toYaml(value)).toBe(`"${value}"\n`)
      expect(toYaml({ [value]: value })).toBe(`"${value}": "${value}"\n`)
    }
  })

  it("quotes any newline and U+2028/U+2029 line terminators", () => {
    expect(toYaml("line1\nline2")).toBe('"line1\\nline2"\n')
    expect(toYaml(`a${LINE_SEPARATOR}b`)).toBe('"a\\u2028b"\n')
    expect(toYaml(`a${PARAGRAPH_SEPARATOR}b`)).toBe('"a\\u2029b"\n')
  })

  it("leaves an embedded quote or backslash unquoted when nothing else forces quoting", () => {
    expect(toYaml('say "hi"')).toBe('say "hi"\n')
    expect(toYaml("back\\slash")).toBe("back\\slash\n")
  })

  it("escapes double quotes and backslashes with a purpose-written escaper once quoting is forced", () => {
    expect(toYaml('a: "hi"')).toBe('"a: \\"hi\\""\n')
    expect(toYaml("a: back\\slash")).toBe('"a: back\\\\slash"\n')
  })

  it("escapes C0 control characters as \\u00XX", () => {
    expect(toYaml("a\u0000b")).toBe('"a\\u0000b"\n')
    expect(toYaml("a\u0001b")).toBe('"a\\u0001b"\n')
  })

  it("escapes DEL, C1 controls, BOM, noncharacters and lone surrogates as \\uXXXX", () => {
    const cases = [
      ["/y\x7fz", '"/y\\u007fz"'],
      ["a\u0080b", '"a\\u0080b"'],
      ["a\u0085b", '"a\\u0085b"'],
      ["a\u009fb", '"a\\u009fb"'],
      ["a\ufeffb", '"a\\ufeffb"'],
      ["a\ufffeb", '"a\\ufffeb"'],
      ["a\uffffb", '"a\\uffffb"'],
      ["a\ud800b", '"a\\ud800b"'],
      ["a\udfffb", '"a\\udfffb"'],
      ["\udc00\ud800", '"\\udc00\\ud800"'],
    ] as const
    for (const [value, expected] of cases) {
      expect(toYaml(value)).toBe(`${expected}\n`)
      expect(toYaml({ route: value })).toBe(`route: ${expected}\n`)
      expect(toYaml({ [value]: 1 })).toBe(`${expected}: 1\n`)
    }
  })

  it("leaves printable non-ASCII text and valid surrogate pairs unquoted", () => {
    expect(toYaml("zażółć")).toBe("zażółć\n")
    expect(toYaml("a\u00a0b")).toBe("a\u00a0b\n")
    expect(toYaml("rocket \u{1f680}")).toBe("rocket \u{1f680}\n")
  })

  it("keeps a valid surrogate pair intact inside a quoted scalar", () => {
    expect(toYaml("a: \u{1f680}")).toBe('"a: \u{1f680}"\n')
  })
})

describe("TruncatedString", () => {
  it("is always quoted even when the content alone would not require quoting", () => {
    const value = markTruncated("hello")
    expect(toYaml(value)).toBe('"hello"\n')
  })

  it("stays quoted for the truncation-after-colon reachability case", () => {
    const source = "{ status: filter }"
    const cut = markTruncated(source.slice(0, source.indexOf(":") + 1))
    expect(cut.value).toBe("{ status:")
    const out = toYaml({ guard: cut })
    expect(out).toBe('guard: "{ status:"\n')
  })

  it("is quoted as a nested value inside arrays and objects", () => {
    const out = toYaml({ items: [markTruncated("a"), "b"] })
    expect(out).toBe('items:\n  - "a"\n  - b\n')
  })
})

describe("self-check re-parses every emitted document", () => {
  it("round-trips a representative nested structure", () => {
    const value = {
      meta: { root: "frontend", counts: { routes: 30, redirects: 4 } },
      routes: [
        { path: "/orders/:id", title: "Orders", tags: [] },
        { path: "/invoices", title: "Invoices", tags: ["a", "b"] },
      ],
      empty: {},
      emptyList: [],
    }
    expect(() => toYaml(value)).not.toThrow()
  })

  it("throws YamlEmitError and never silently succeeds if forced to mismatch", () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic["self"] = cyclic
    expect(() => toYaml(cyclic)).toThrow()
  })
})

describe("colon-terminated values never reach an unparseable document", () => {
  it("k: foo: emits quoted, parseable output", () => {
    expect(() => toYaml({ k: "foo:" })).not.toThrow(YamlEmitError)
    const out = toYaml({ k: "foo:" })
    expect(out.trimEnd().split("\n")).toEqual(['k: "foo:"'])
  })

  it("a truncated guard expression cut immediately after a colon emits quoted, parseable output", () => {
    const guardExpr = "status === 'active' && filter: something"
    const cutAt = guardExpr.indexOf(":") + 1
    const truncated = markTruncated(guardExpr.slice(0, cutAt))
    expect(() => toYaml({ guard: truncated })).not.toThrow()
  })
})

const bogusTruncated = (value: unknown): unknown => ({ __brand: "TruncatedString", value })

const sparse = (length: number, filled: readonly (readonly [number, unknown])[]): unknown[] => {
  const items = new Array<unknown>(length)
  for (const [index, value] of filled) items[index] = value
  return items
}

const protoKeyed = (value: unknown): unknown => JSON.parse(`{"__proto__": ${JSON.stringify(value)}, "after": 1}`)

const screen = (index: number): Record<string, unknown> => ({
  id: `screen-${index}`,
  path: `/orders/:id/${index}`,
  title: index % 3 === 0 ? markTruncated("Orders: all") : "Orders",
  tags: index % 2 === 0 ? [] : ["a", "b: c", ""],
  meta: index % 5 === 0 ? {} : { depth: index, enabled: index % 2 === 0, note: null },
  tree: [{ name: "Root", children: [{ name: "Leaf", children: [] }, [[index], [{}]]] }],
})

const screens = (count: number): Record<string, unknown>[] => Array.from({ length: count }, (_, index) => screen(index))

const LARGE_FIXTURES = {
  topLevelSequence: screens(3000),
  topLevelMapping: { meta: { root: "frontend" }, screens: screens(3000), empty: [], emptyObject: {} },
  nestedLargeMapping: { app: Object.fromEntries(screens(2500).map((entry, index) => [`k${index}`, entry])) },
  sequenceOfLargeSequences: [screens(2500), [screens(2500)], []],
  deepSingleChain: { a: { b: { c: [{ d: screens(2500) }] } } },
  wideScalars: Array.from({ length: 20000 }, (_, index) => (index % 7 === 0 ? `value: ${index}` : index)),
} as const

const SMALL_FIXTURES = [
  [],
  {},
  "hello",
  "",
  { a: { b: "c" } },
  [{ a: 1, b: 2 }],
  [[[]]],
  [[{}], [[1, [2, { d: "e: f" }]]]],
  { a: null, b: undefined, c: true, d: 42, e: 1.5, f: 10n },
  { "a: b": "foo:", "-x": ["#y", " z", "2024-01-01"], "": "" },
  { items: [markTruncated("a"), "b"], guard: markTruncated("{ status:") },
  { route: "a\u0000b\u2028c\ud800" },
] as const

const MALFORMED_FIXTURES = {
  topLevelHole: sparse(2, [[1, 1]]),
  holeOnlySequence: sparse(1, []),
  nestedHoleOnly: { a: sparse(1, []) },
  itemHoleOnly: [sparse(1, [])],
  protoKey: protoKeyed({ a: 1 }),
  protoScalarKey: protoKeyed(1),
  bogusTruncated: { a: bogusTruncated(123) },
  largeWithTrailingProto: { list: screens(3000), tail: protoKeyed({ a: 1 }) },
  largeWithDeepHole: { list: screens(3000), deep: { a: [sparse(1, [])] } },
  largeWithSparseItem: { list: [...screens(3000), sparse(3, [[0, 1], [2, 2]])] },
  largeSparseTopLevel: sparse(3002, [...screens(3000).map((entry, index) => [index, entry] as const), [3001, "x"]]),
  largeWithBogusTruncated: { list: screens(3000), t: [bogusTruncated(5)] },
  largeWithProtoInside: [...screens(3000), protoKeyed({ a: [1] })],
} as const

describe("byte equality with the pre-streaming serialiser", () => {
  it("matches the oracle on small fixtures", () => {
    for (const value of SMALL_FIXTURES) {
      expect(outcomeOf(toYaml, value)).toEqual(oracleOutcome(value))
    }
  })

  it.each(Object.entries(LARGE_FIXTURES))("matches the oracle on the large %s fixture", (_, value) => {
    const outcome = outcomeOf(toYaml, value)
    expect(outcome.kind).toBe("text")
    expect(outcome).toEqual(oracleOutcome(value))
  })

  it.each(Object.entries(MALFORMED_FIXTURES))("throws the oracle's exact error for %s", (_, value) => {
    const outcome = outcomeOf(toYaml, value)
    expect(outcome.kind).toBe("error")
    expect(outcome).toEqual(oracleOutcome(value))
  })

  it("fails a cyclic value the same way the oracle does", () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic["self"] = cyclic
    expect(outcomeOf(toYaml, cyclic)).toEqual(oracleOutcome(cyclic))
  })
})
