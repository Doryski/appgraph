import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { DIAGNOSTIC_CODES } from "../../src/core/diagnostics.js"

/**
 * `DIAGNOSTIC_CODES` is a promise to the reader of the README and to anyone grepping a CI log: this is
 * the whole vocabulary, and every entry is something the tool can actually say. Without this check the
 * list drifts in both directions — declared codes no code path emits (a README promise nothing can
 * keep) and emitted codes nobody declared.
 *
 * The extraction is deliberately syntactic rather than semantic: `DiagnosticCode` widens to
 * `(string & {})` so the compiler cannot do this job, and running the whole pipeline would only prove
 * which codes the fixtures happen to reach, not which ones exist. Scanning the emit sites is the only
 * check that fails for the right reason.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src")

const CODE = String.raw`[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*`
const QUOTED_CODE = new RegExp(String.raw`"(${CODE})"`, "g")

/** `code:` accepts an expression — `config/load.ts` picks between two codes with a ternary. */
const CODE_FIELD = /\bcode:\s*([^\n]*)/g
/** `sink.error("code", …)`, with the call arguments possibly starting on the next line. */
const SINK_CALL = new RegExp(String.raw`\.(?:error|warning|info)\(\s*\n?\s*"(${CODE})"`, "g")
/** `export const MULTIPLE_SOURCES_CODE = "project/multiple-screen-sources"` and friends. */
const CODE_CONSTANT = new RegExp(String.raw`\b[A-Z0-9_]*CODE\s*=\s*"(${CODE})"`, "g")

const sourceFiles = (dir: string): readonly string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith(".ts") ? [full] : []
  })

const emitSites = (): ReadonlyMap<string, readonly string[]> => {
  const sites = new Map<string, string[]>()
  const record = (code: string, file: string) => {
    const seen = sites.get(code) ?? []
    if (!seen.includes(file)) seen.push(file)
    sites.set(code, seen)
  }

  for (const file of sourceFiles(SRC)) {
    // The registry itself is the declaration, not an emit site.
    if (file.endsWith(join("core", "diagnostics.ts"))) continue
    const text = readFileSync(file, "utf8")
    const where = relative(SRC, file).split(sep).join("/")

    for (const match of text.matchAll(CODE_FIELD))
      for (const literal of (match[1] ?? "").matchAll(QUOTED_CODE)) record(literal[1] ?? "", where)
    for (const match of text.matchAll(SINK_CALL)) record(match[1] ?? "", where)
    for (const match of text.matchAll(CODE_CONSTANT)) record(match[1] ?? "", where)
  }
  return sites
}

describe("diagnostic codes: the registry matches the emit sites", () => {
  const sites = emitSites()

  it("finds emit sites at all — a silent zero would make both directions pass vacuously", () => {
    expect(sites.size).toBeGreaterThan(30)
  })

  it("declares every code that is emitted", () => {
    const undeclared = [...sites.keys()]
      .filter((code) => !(DIAGNOSTIC_CODES as readonly string[]).includes(code))
      .sort()
      .map((code) => `${code} (emitted in ${sites.get(code)?.join(", ")})`)
    expect(undeclared).toEqual([])
  })

  it("emits every code that is declared", () => {
    const dead = [...DIAGNOSTIC_CODES].filter((code) => !sites.has(code)).sort()
    expect(dead).toEqual([])
  })

  it("is sorted and free of duplicates, so the diff of a new code is one line", () => {
    expect([...DIAGNOSTIC_CODES]).toEqual([...DIAGNOSTIC_CODES].sort())
    expect(new Set(DIAGNOSTIC_CODES).size).toBe(DIAGNOSTIC_CODES.length)
  })
})
