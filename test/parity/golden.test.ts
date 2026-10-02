/**
 * The golden's integrity, and the reader's right to be trusted.
 *
 * The golden is a frozen snapshot of the reference implementation's output over a private application. It is NOT part
 * of this package — it lives outside the repository behind the `APPGRAPH_PARITY_GOLDEN` pointer, so
 * this suite skips cleanly wherever the pointer is absent (CI included) and runs unchanged wherever it
 * is configured. Two things are checked, and both are prerequisites for every number the real gate
 * reports:
 *
 *  1. the three documents still hash to the sums the golden's `MANIFEST.md` recorded at capture time
 *     (§12.1). A golden edited to make a test pass is the one failure mode this directory exists to
 *     prevent, which is why the expected sums live HERE and the files live THERE;
 *  2. `yaml-read.ts` reproduces the counts `MANIFEST.md` states independently. If the reader is wrong,
 *     every "difference from the golden" the gate reports is the reader's fault, not the port's.
 *
 * Nothing below names the application. Every app-specific value the assertions need is read from
 * `expectations.json`, which sits with the golden.
 */
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { GOLDEN_SHA256, goldenDir, goldenSnapshot } from "./golden.js"
import { GOLDEN_HINT, parityGolden } from "./golden-target.js"
import { readExpectations } from "./expectations.js"
import { readYaml } from "./yaml-read.js"
import { firstOrderDivergence } from "./compare.js"

const golden = parityGolden()

// `describe.skipIf` rather than a bare `if`: the suite must appear as SKIPPED in the report, not
// vanish, and the suite NAME carries why, so a skip can never be mistaken for a pass.
describe.skipIf(golden === null)(`the frozen golden (${golden ?? `SKIPPED: ${GOLDEN_HINT}`})`, () => {
  it.each(Object.entries(GOLDEN_SHA256))("%s still matches the MANIFEST sum", (file, expectedSum) => {
    const bytes = fs.readFileSync(path.join(goldenDir(), file))
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedSum)
  })

  it("all three documents parse with the independent reader", () => {
    for (const file of Object.keys(GOLDEN_SHA256)) {
      const parsed = readYaml(fs.readFileSync(path.join(goldenDir(), file), "utf8"))
      expect(typeof parsed === "object" && parsed !== null, file).toBe(true)
    }
  })

  it("reproduces every count MANIFEST.md states", () => {
    const expected = readExpectations()
    const snapshot = goldenSnapshot()
    expect(snapshot.contracts).toHaveLength(expected.screenUrlCount)
    expect(snapshot.counts).toEqual(expected.manifestCounts)
    expect(snapshot.componentKeys).toHaveLength(expected.componentKeyCount)
    expect(snapshot.navigationEdges).toHaveLength(expected.navigationEdgeCount)
    expect(snapshot.menuPaths).toHaveLength(expected.menuPathCount)
    expect(snapshot.shells).toEqual([...expected.shells])
  })

  it("reproduces MANIFEST.md's per-route table exactly", () => {
    // A spot-check of the extremes and the zero-entry rows: if the reader mis-nests a block, these are
    // the numbers that move first. Which rows those are is named in `expectations.json`, not here.
    const expected = readExpectations()
    const rows = new Map(goldenSnapshot().coverage.map((row) => [row.url, row]))
    for (const witness of expected.coverageWitnesses) {
      expect(rows.get(witness.url), witness.url).toMatchObject({
        endpoints: witness.endpoints,
        testIds: witness.testIds,
        reachable: witness.reachable,
      })
    }
    for (const url of Object.keys(expected.zeroEntryRedirects)) {
      expect(rows.get(url), url).toMatchObject({ endpoints: 0, testIds: 0, reachable: 0 })
    }
  })

  it("was sorted with localeCompare, which diverges from codepoint order at index 4 (§12.2)", () => {
    // The reason byte equality cannot hold, re-derived here rather than trusted.
    const keys = goldenSnapshot().componentKeys
    const locale = [...keys].sort((a, b) => a.localeCompare(b))
    const codepoint = [...keys].sort()
    expect(firstOrderDivergence(keys, locale)).toBe(-1)
    expect(firstOrderDivergence(locale, codepoint)).toBe(4)
  })

  it("carries no HTML golden, and says why", () => {
    // §12.6: the reference implementation embeds `new Date().toISOString().slice(0, 16)` in its HTML report, so the
    // bytes differ from themselves every minute. Asserting its absence keeps someone from "completing"
    // the golden set by capturing a file that cannot be compared.
    expect(fs.readdirSync(goldenDir()).filter((file) => file.endsWith(".html"))).toEqual([])
  })
})

describe("the reader itself", () => {
  it("round-trips the dialect's awkward scalars", () => {
    const text = [
      "meta:",
      "  root: frontend",
      "  depth: 3",
      "  flag: true",
      "  missing: null",
      '  quoted: "a: b"',
      '  dashish: "- not a sequence"',
      "  empty: []",
      "  emptyMap: {}",
      "list:",
      "  - one",
      '  - "two: three"',
      "  - nested:",
      "      deep: 1",
    ].join("\n")
    expect(readYaml(text)).toEqual({
      meta: {
        root: "frontend",
        depth: 3,
        flag: true,
        missing: null,
        quoted: "a: b",
        dashish: "- not a sequence",
        empty: [],
        emptyMap: {},
      },
      list: ["one", "two: three", { nested: { deep: 1 } }],
    })
  })

  it("refuses malformed input instead of guessing", () => {
    expect(() => readYaml("key\n")).toThrow()
    expect(() => readYaml("a:\n")).toThrow()
  })
})
