import { describe, expect, it } from "vitest"
import { markTruncated, toYaml } from "../../src/emit/yaml.js"
import { oracleOutcome, outcomeOf } from "./yaml-oracle.js"

// Deterministic PRNG (mulberry32) so a fuzz failure is reproducible from FUZZ_SEED alone —
// no external fuzzing library, keeping this package at zero runtime dependencies.
const mulberry32 = (seed: number): (() => number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FUZZ_SEED = 0x5eed_c0de
const STRUCTURE_ITERATIONS = 4000
const MAX_DEPTH = 4
const MAX_BREADTH = 5

const pick = <T,>(rng: () => number, items: readonly T[]): T => {
  const value = items[Math.floor(rng() * items.length)]
  if (value === undefined) throw new Error("empty pick pool")
  return value
}

const randomInt = (rng: () => number, max: number): number => Math.floor(rng() * max)

// Real-looking TypeScript source lines of the kind that gets truncated: condition/guard text and
// query-key fallbacks. Truncating any of these at an arbitrary offset is the reachable production
// path to a value that ends in a colon.
const SOURCE_LINES: readonly string[] = [
  "{ status: filter }",
  "isAdmin && hasPermission('write') || override === true",
  "user?.role === 'admin' ? '/admin' : '/dashboard'",
  "const go = useNavigate()",
  "navigate(`/orders/${id}?tab=details&status=${status}`)",
  "params.get('/x')",
  "condition && anotherCondition && yetAnotherCondition || fallback: value",
  "order.status === 'pending' && !order.isPreliminary ? renderPending() : null",
  "cache.get('/z')",
  "someMap.delete('/y')",
  "a: b: c: d",
  "filter?.status ?? 'active': dynamic",
  "`/orders/${id}` satisfies Route",
  "menu.orders.title: menuLabel",
  "i18n.t('menu.orders.title', { count })",
  "src/routes/router.tsx#navigationRoutes",
  "!!(a && b) || (c ?? d): result",
]

const ROUTE_PATTERNS: readonly string[] = [
  "/orders/:id",
  "/orders/:id/*",
  "/invoices/:invoiceId/lines/:lineId",
  "/:locale/dashboard",
  "*",
  "/orders/:id?tab=:tab",
]

const I18N_KEYS: readonly string[] = [
  "menu.orders.title",
  "errors.validation.required",
  "a.b.c.d.e.f",
  "menu.orders",
  "",
]

const FILE_PATHS: readonly string[] = [
  "src/routes/router.tsx",
  "src/config.tsx#navigationRoutes",
  "./components/../components/Button.tsx",
  "src/modules/Orders/index.ts",
  "a/b/c.d.e.tsx",
]

const GUARD_EXPRESSIONS: readonly string[] = [
  "a && b || c",
  "a ? b : c",
  "x === 'y' && z !== null",
  "user?.role === \"admin\"",
  "line1\nline2 && line3",
  "{ nested: { braces: true } }",
]

const KEYWORD_LOOKALIKES: readonly string[] = [
  "true",
  "false",
  "null",
  "yes",
  "no",
  "on",
  "off",
  "~",
  "True",
  "NULL",
]

const NUMBER_LOOKALIKES: readonly string[] = [
  "1.5",
  "1e10",
  "-42",
  "0x1F",
  "0o17",
  "017",
  ".inf",
  "-.inf",
  ".nan",
  "2024-01-01",
  "1.2.3",
  "0",
  "+3.14",
]

const UNICODE_AND_EDGE_CASES: readonly string[] = [
  "",
  " ",
  "   ",
  "\t",
  String.fromCharCode(0x2028),
  String.fromCharCode(0x2029),
  `line${String.fromCharCode(0x2028)}separator`,
  `para${String.fromCharCode(0x2029)}separator`,
  "emoji \u{1F680} rocket",
  "emoji family \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
  "unicode éèê café",
  "control" + String.fromCharCode(1) + "char",
  "a".repeat(5000),
  "#leading hash",
  "trailing hash #",
  ": leading colon-space",
  "trailing colon:",
  "colon-space in: middle",
]

const ALL_CORPORA: readonly (readonly string[])[] = [
  ROUTE_PATTERNS,
  I18N_KEYS,
  FILE_PATHS,
  GUARD_EXPRESSIONS,
  KEYWORD_LOOKALIKES,
  NUMBER_LOOKALIKES,
  UNICODE_AND_EDGE_CASES,
]

const genLeafString = (rng: () => number): string => {
  const corpus = pick(rng, ALL_CORPORA)
  return pick(rng, corpus)
}

const genLeaf = (rng: () => number): unknown => {
  const roll = rng()
  if (roll < 0.1) return null
  if (roll < 0.2) return rng() < 0.5
  if (roll < 0.35) return randomInt(rng, 100000) - 50000
  if (roll < 0.45) return randomInt(rng, 1000) / 3
  const text = genLeafString(rng)
  return roll < 0.6 ? markTruncated(text) : text
}

const genKey = (rng: () => number, index: number): string => {
  const roll = rng()
  if (roll < 0.5) return `k${index}`
  return `${genLeafString(rng)}_${index}`
}

const genValue = (rng: () => number, depth: number): unknown => {
  if (depth >= MAX_DEPTH || rng() < 0.35) return genLeaf(rng)

  if (rng() < 0.5) {
    const length = randomInt(rng, MAX_BREADTH + 1)
    return Array.from({ length }, () => genValue(rng, depth + 1))
  }

  const length = randomInt(rng, MAX_BREADTH + 1)
  const record: Record<string, unknown> = {}
  for (let i = 0; i < length; i += 1) {
    record[genKey(rng, i)] = genValue(rng, depth + 1)
  }
  return record
}

describe("permanent fuzz: emitter never reports success on unparseable output", () => {
  it(`round-trips ${STRUCTURE_ITERATIONS} random nested structures (seed ${FUZZ_SEED})`, () => {
    const rng = mulberry32(FUZZ_SEED)
    for (let i = 0; i < STRUCTURE_ITERATIONS; i += 1) {
      const value = genValue(rng, 0)
      expect(() => toYaml(value), `iteration ${i} failed for value ${JSON.stringify(value)}`).not.toThrow()
    }
  })

  it("round-trips every offset of a corpus of real source lines, truncated and un-truncated", () => {
    for (const line of SOURCE_LINES) {
      for (let cut = 0; cut <= line.length; cut += 1) {
        const slice = line.slice(0, cut)

        const plain = toYaml({ guard: slice })
        expect(plain.endsWith("\n")).toBe(true)

        const truncated = markTruncated(slice)
        const quoted = toYaml({ guard: truncated })
        expect(quoted).toMatch(/^guard: "/)
      }
    }
  })

  it("round-trips the query-key truncation site shape (slice(0, 60))", () => {
    for (const line of SOURCE_LINES) {
      const key = markTruncated(line.slice(0, 60))
      expect(() => toYaml({ [key.value]: "value", meta: key })).not.toThrow()
    }
  })

  it("round-trips the guard-truncation site shape (slice(0, 110))", () => {
    const long = SOURCE_LINES.join(" && ")
    for (let cut = 0; cut <= 110; cut += 1) {
      const truncated = markTruncated(long.slice(0, cut))
      expect(() => toYaml({ condition: truncated })).not.toThrow()
    }
  })

  it("quotes a value truncated immediately after a colon", () => {
    const source = "{ status: filter }"
    const colonIndex = source.indexOf(":")
    const truncated = markTruncated(source.slice(0, colonIndex + 1))
    expect(truncated.value.endsWith(":")).toBe(true)
    const out = toYaml({ k: truncated })
    expect(out).toBe(`k: "${truncated.value}"\n`)
  })

  it("handles deeply nested arrays and objects containing every corpus class together", () => {
    const rng = mulberry32(FUZZ_SEED + 1)
    for (let i = 0; i < 500; i += 1) {
      const value = {
        routes: Array.from({ length: 3 }, () => pick(rng, ROUTE_PATTERNS)),
        i18n: Object.fromEntries(I18N_KEYS.map((key, index) => [`${key || "empty"}_${index}`, key])),
        paths: FILE_PATHS,
        guards: GUARD_EXPRESSIONS.map((expr) => markTruncated(expr.slice(0, randomInt(rng, expr.length + 1)))),
        keywords: KEYWORD_LOOKALIKES,
        numbers: NUMBER_LOOKALIKES,
        unicode: UNICODE_AND_EDGE_CASES,
        empty: [],
        emptyObject: {},
      }
      expect(() => toYaml(value)).not.toThrow()
    }
  })
})

const ORACLE_ITERATIONS = 2000
const LARGE_DOCUMENTS = 6
const LARGE_BREADTH = 800
const DEFECT_ITERATIONS = 300

const holeOnly = (): unknown[] => new Array<unknown>(1)

const DEFECTS: readonly (() => unknown)[] = [
  holeOnly,
  () => [holeOnly()],
  () => {
    const items: unknown[] = ["a", "b"]
    items.length = 4
    return items
  },
  () => JSON.parse('{"__proto__": {"a": 1}, "b": 2}'),
  () => JSON.parse('{"__proto__": 1}'),
  () => ({ __brand: "TruncatedString", value: 7 }),
]

const containerChildren = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value
  if (typeof value === "object" && value !== null && !("__brand" in value)) return Object.values(value)
  return []
}

const isOpenContainer = (value: unknown): value is unknown[] | Record<string, unknown> =>
  Array.isArray(value) || (typeof value === "object" && value !== null && !("__brand" in value))

const pickHost = (rng: () => number, value: unknown[] | Record<string, unknown>): unknown[] | Record<string, unknown> => {
  const nested = containerChildren(value).filter(isOpenContainer)
  if (nested.length === 0 || rng() < 0.3) return value
  return pickHost(rng, pick(rng, nested))
}

const injectDefect = (rng: () => number, host: unknown[] | Record<string, unknown>, defect: unknown): void => {
  if (Array.isArray(host)) {
    host.splice(randomInt(rng, host.length + 1), 0, defect)
    return
  }
  host[`defect_${randomInt(rng, 1000)}`] = defect
}

const largeDocument = (rng: () => number): unknown => {
  const items = Array.from({ length: LARGE_BREADTH }, () => genValue(rng, 0))
  if (rng() < 0.5) return items
  return { meta: genValue(rng, 0), items, index: Object.fromEntries(items.map((item, index) => [genKey(rng, index), item])) }
}

describe("permanent fuzz: streaming serialiser matches the pre-streaming oracle", () => {
  it(`emits byte-identical output for ${ORACLE_ITERATIONS} random structures`, () => {
    const rng = mulberry32(FUZZ_SEED + 2)
    for (let i = 0; i < ORACLE_ITERATIONS; i += 1) {
      const value = genValue(rng, 0)
      expect(outcomeOf(toYaml, value), `iteration ${i}`).toEqual(oracleOutcome(value))
    }
  })

  it(`emits byte-identical output for ${LARGE_DOCUMENTS} documents large enough to stream in chunks`, () => {
    const rng = mulberry32(FUZZ_SEED + 3)
    for (let i = 0; i < LARGE_DOCUMENTS; i += 1) {
      const value = largeDocument(rng)
      const outcome = outcomeOf(toYaml, value)
      expect(outcome.kind, `document ${i}`).toBe("text")
      expect(outcome, `document ${i}`).toEqual(oracleOutcome(value))
    }
  })

  it(`throws the oracle's exact error for ${DEFECT_ITERATIONS} structures with an injected defect`, () => {
    const rng = mulberry32(FUZZ_SEED + 4)
    for (let i = 0; i < DEFECT_ITERATIONS; i += 1) {
      const value = i % 10 === 0 ? largeDocument(rng) : { root: genValue(rng, 0) }
      if (!isOpenContainer(value)) continue
      injectDefect(rng, pickHost(rng, value), pick(rng, DEFECTS)())
      const outcome = outcomeOf(toYaml, value)
      expect(outcome.kind, `iteration ${i}`).toBe("error")
      expect(outcome, `iteration ${i}`).toEqual(oracleOutcome(value))
    }
  })
})
