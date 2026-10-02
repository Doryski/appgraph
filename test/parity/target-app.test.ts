/**
 * §12.3's four gates and §12.4's pinned-versus-zero-config comparison, against a REAL application checkout.
 *
 * This is the acceptance test for the whole extraction. It needs two things this package deliberately
 * does not ship, and skips cleanly when either is missing:
 *
 *   APPGRAPH_PARITY_FIXTURE / test/parity/target.local  — the target pointer: the application checkout,
 *                                                          its pinned commit and its pinned config (`target.ts`)
 *   APPGRAPH_PARITY_GOLDEN  / test/parity/golden.local  — the frozen reference output to compare against
 *
 * Both point at private material, so CI cannot depend on them — `fixture.test.ts` covers the same
 * machinery against a committed synthetic app and always runs.
 *
 *   pnpm test test/parity                          # reads both pointer files
 *
 *   # The report script, which is the microscope rather than the gate, takes the same pointers as variables:
 *   APPGRAPH_PARITY_FIXTURE="$(cat test/parity/target.local)" \
 *   APPGRAPH_PARITY_GOLDEN=/abs/path/to/parity-golden npx tsx test/parity/report.mts
 *
 * Every application-specific value asserted below — route names, module paths, endpoint URLs, the extra
 * nav group's name — is read from `expectations.json` alongside the golden; the pinned commit and the
 * target-specific pinned config come from the target pointer (`target.ts`). Nothing in this file names
 * the application, and it must stay that way: this file is published, the golden is not.
 *
 * The target is READ-ONLY. Nothing here writes into it: `analyze` returns `EmitFile[]` and this file
 * never touches the filesystem of the analysed repo.
 *
 * ## What "red" means here
 *
 * This file is NOT expected to be red wholesale. `BASELINE.md` is the accepted baseline: it lists every
 * remaining difference, each classified either as an intended difference from the reference output or
 * as an entry in `known-gaps.ts` with a measurement and a resolution criterion. A failure not in
 * BASELINE.md is a regression. Use `npx tsx test/parity/report.mts` for the numbers behind any of it.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import ts from "typescript"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sortedUnique } from "../../src/core/order.js"
import { goldenSnapshot } from "./golden.js"
import { GOLDEN_HINT, parityGolden } from "./golden-target.js"
import type { ParityExpectations } from "./expectations.js"
import { readExpectations } from "./expectations.js"
import type { ObservedSnapshot } from "./observed.js"
import { observedSnapshot } from "./observed.js"
import { runPinned, runZeroConfig } from "./pinned.js"
import type { ParitySnapshot } from "./model.js"
import { keyedByUrl } from "./model.js"
import { deepDiff, formatDifferences, setDiff } from "./compare.js"
import { gapById } from "./known-gaps.js"
import {
  entriesSetReport,
  extraMenuReport,
  gate1,
  gate2,
  gate4,
  menuReport,
  orderingReport,
  shellReport,
} from "./gates.js"
import { runAssertions } from "./assertions.js"
import { TARGET_HINT, parityTargetPointer, pinMismatch } from "./target.js"

const pointer = parityTargetPointer()
const root = pointer?.root ?? null
const golden = parityGolden()
const ready = root !== null && golden !== null

const why = root === null ? `SKIPPED: ${TARGET_HINT}` : golden === null ? `SKIPPED: ${GOLDEN_HINT}` : root

// `describe.skipIf` rather than a bare `if`: the suite must appear as SKIPPED in the report, not vanish,
// and the suite NAME carries why, so a skip can never be mistaken for a pass.
describe.skipIf(!ready)(`parity — real application checkout (${why})`, () => {
  let expected: ParityExpectations
  let goldenSnap: ParitySnapshot
  let pinned: ObservedSnapshot
  let zero: ObservedSnapshot
  let pinnedFiles: readonly { readonly path: string; readonly content: string }[] = []

  beforeAll(async () => {
    if (!ready || pointer === null) return
    const mismatch = pinMismatch(pointer)
    if (mismatch !== null) throw new Error(mismatch)
    expected = readExpectations()
    goldenSnap = goldenSnapshot()
    const pinnedRun = await runPinned(pointer.root, pointer.config ?? {})
    pinned = observedSnapshot(pinnedRun, "pinned")
    pinnedFiles = pinnedRun.files
    zero = observedSnapshot(await runZeroConfig(root), "zero-config")
  }, 600_000)

  afterAll(() => {
    // Nothing to clean: the analysed repo is read-only and no temp dir was created.
  })

  it(`analyses the pinned commit ${pointer?.commit?.slice(0, 9) ?? "(none)"} and nothing else`, () => {
    // Redundant with the throw in `beforeAll` on purpose: that one stops a drifted checkout from being
    // measured at all, this one names the pin in the report so a green run says what it was green on.
    expect(pointer === null ? null : pinMismatch(pointer)).toBeNull()
  })

  describe("gate 1 — set equality on the agent-facing contract", () => {
    it("finds exactly the golden's screen URLs", () => {
      expect([...pinned.contracts.map((row) => row.url)].sort()).toEqual(
        [...goldenSnap.contracts.map((row) => row.url)].sort(),
      )
      expect(pinned.contracts).toHaveLength(expected.screenUrlCount)
    })

    it.fails("reproduces entries[0] BYTE-for-byte, which the §8.9 sort makes impossible on multi-entry screens", () => {
      // A failing expectation on purpose: it is what a reader expects gate 1 to check, and its findings
      // are exactly the §8.9 sort difference. The claim that IS true is below.
      const gate = gate1(goldenSnap, pinned)
      expect(gate.findings.join("\n"), `stats ${JSON.stringify(gate.stats)}`).toBe("")
    })

    it("reproduces params, auth, redirectTo and entries[0]-under-the-§8.9-sort on every screen", () => {
      // The golden sorted entries with `localeCompare`; the port sorts by codepoint. Applying the port's
      // documented sort to the GOLDEN's own entry list and then comparing `entries[0]` is not a
      // weakening — it removes the one variable §8.9 deliberately changed and leaves every other field
      // asserted exactly, so a wrong entry0 (a lost or mis-picked entry, as opposed to a reordered one)
      // still fails here.
      const goldenEntries = new Map(goldenSnap.entryLists.map((row) => [row.url, row.entries]))
      const observedRows = new Map(pinned.contracts.map((row) => [row.url, row]))
      const findings: string[] = []

      for (const row of goldenSnap.contracts) {
        const observed = observedRows.get(row.url)
        if (observed === undefined) {
          findings.push(`${row.url}: absent from observed`)
          continue
        }
        const codepointFirst = [...(goldenEntries.get(row.url) ?? [])].sort()[0] ?? null
        if (observed.entry0 !== codepointFirst)
          findings.push(`${row.url}.entry0: expected ${String(codepointFirst)} got ${String(observed.entry0)}`)
        if (observed.auth !== row.auth) findings.push(`${row.url}.auth: golden ${row.auth} got ${observed.auth}`)
        if (observed.redirectTo !== row.redirectTo)
          findings.push(`${row.url}.redirectTo: golden ${String(row.redirectTo)} got ${String(observed.redirectTo)}`)
        if (formatDifferences(deepDiff([...row.params].sort(), [...observed.params].sort())) !== "")
          findings.push(`${row.url}.params: golden ${JSON.stringify(row.params)} got ${JSON.stringify(observed.params)}`)
      }

      expect(findings.join("\n")).toBe("")
    })

    it.fails("loses no entry and invents none — red because one screen gains an entry the golden lacks", () => {
      const report = entriesSetReport(goldenSnap, pinned)
      expect(report.findings.join("\n"), `stats ${JSON.stringify(report.stats)}`).toBe("")
    })

    it("loses no golden entry, and every invented one is named in the expectations", () => {
      // Direction matters: a LOST entry is a regression, a GAINED one is coverage. The golden omits one
      // entry on a screen whose sibling entry it lists elsewhere, and the port finds it. Pinned by name so
      // a second invention fails.
      const observedRows = new Map(pinned.entryLists.map((row) => [row.url, row.entries]))
      const lost: string[] = []
      const gained: string[] = []

      for (const row of goldenSnap.entryLists) {
        const seen = observedRows.get(row.url) ?? []
        const differences = setDiff(row.entries, seen)
        for (const file of differences.onlyLeft) lost.push(`${row.url}: ${file}`)
        for (const file of differences.onlyRight) gained.push(`${row.url}: ${file}`)
      }

      expect(lost, "a lost entry is always a regression").toEqual([])
      expect(gained.sort()).toEqual([...expected.gainedEntries].sort())
    })
  })

  describe("gate 2 — monotonic coverage floors", () => {
    it("meets every golden floor on every screen", () => {
      const gate = gate2(goldenSnap, pinned)
      expect(gate.findings.join("\n"), `stats ${JSON.stringify(gate.stats)}`).toBe("")
    })
  })

  describe("gate 3 — named, falsifiable assertions", () => {
    // A4 is deliberately absent from this list and asserted separately below, against the known-gaps
    // entry that owns its failure. It is the only gate-3 claim not green, and BASELINE.md records why.
    it.each(["A1", "A2", "A2b", "ATEST", "A5", "A5b", "A9", "A10", "AORD"])("%s holds", (id) => {
      const assertion = runAssertions(goldenSnap, pinned, expected, pinnedFiles).find(
        (entry) => entry.id === id,
      )
      expect(assertion, `assertion ${id} is not registered`).toBeDefined()
      expect(assertion?.pass, `${assertion?.claim ?? id}\n${assertion?.detail ?? ""}`).toBe(true)
    })

    it("every golden component left unmapped carries no runtime code", () => {
      // What the golden maps and the port does not is only what imports resolve straight through (pure
      // re-export barrels) or never reach as a value (types-only modules). A golden-only file holding a
      // statement that runs means the depth-limited closure is cutting a real file.
      const mapped = new Set(Object.keys(pinned.graph.components))
      const isTypeOnly = (statement: ts.Statement): boolean =>
        ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly === true) ||
        (ts.isExportDeclaration(statement) && (statement.isTypeOnly || statement.moduleSpecifier !== undefined))
      const carriesCode = (file: string): boolean =>
        ts
          .createSourceFile(file, fs.readFileSync(path.join(root ?? "", file), "utf8"), ts.ScriptTarget.Latest, true)
          .statements.some((statement) => !isTypeOnly(statement))
      expect(goldenSnap.componentKeys.filter((file) => !mapped.has(file)).filter(carriesCode)).toEqual([])
    })

    it.fails(`A4 is red, and ONLY because of ${gapById("SPEC-A4-MISREADS-ANCESTOR-REACHABLE").id}`, () => {
      const assertion = runAssertions(goldenSnap, pinned, expected, pinnedFiles).find(
        (entry) => entry.id === "A4",
      )
      expect(assertion?.pass, `${assertion?.claim ?? ""}\n${assertion?.detail ?? ""}`).toBe(true)
    })

    it("A4's reachable is a strict SUPERSET on every screen — the excess is the §6.3.1 ancestor chain", () => {
      // The direction of A4 that is true and falsifiable; A4 itself stays wired above as a failing
      // expectation. The golden's tree is built from screen entries alone, so it does not count a
      // layout's closure; the port splices the ancestor chain in at depth 0 and does.
      const observedRows = new Map(pinned.coverage.map((row) => [row.url, row]))
      const shortfalls = goldenSnap.coverage.flatMap((row) => {
        const seen = observedRows.get(row.url)
        return seen === undefined || seen.reachable >= row.reachable
          ? []
          : [`${row.url}: golden ${String(row.reachable)} > observed ${String(seen.reachable)}`]
      })
      expect(shortfalls).toEqual([])

      // And the excess is not unbounded noise: no screen exceeds the whole component map.
      for (const row of pinned.coverage) expect(row.reachable).toBeLessThanOrEqual(pinned.componentKeys.length)
    })

    it("A9's N is pinned from the golden", () => {
      const goldenRow = goldenSnap.coverage.find((row) => row.url === expected.testIdWitness.url)
      expect(goldenRow?.testIds).toBe(expected.testIdWitness.count)
    })
  })

  describe("gate 4 — parsed objects, sorted keys, never text", () => {
    it.fails("the contract table is content-identical to the golden's, §8.9 aside", () => {
      // The same entry0 differences gate 1 reports, seen through the key-sorted comparison primitive. It
      // stays wired so the count cannot drift unnoticed; the assertion below pins it.
      const gate = gate4(keyedByUrl(goldenSnap.contracts), keyedByUrl(pinned.contracts), "contracts")
      expect(gate.findings.join("\n")).toBe("")
    })

    it("differs from the golden on exactly the expected entry0 values and nothing else", () => {
      // What gate 4 is FOR: proving a difference is confined. Every difference must be an `entry0` on a
      // screen with more than one entry — never a params, auth or redirectTo difference, and never on a
      // single-entry screen where no sort could matter.
      const gate = gate4(keyedByUrl(goldenSnap.contracts), keyedByUrl(pinned.contracts), "contracts")
      expect(gate.stats["differences"]).toBe(expected.entry0Differences.count)

      const multiEntry = new Set(
        goldenSnap.entryLists.filter((row) => row.entries.length > 1).map((row) => row.url),
      )
      const differing = goldenSnap.contracts.filter((row) => {
        const observed = pinned.contracts.find((entry) => entry.url === row.url)
        return observed !== undefined && observed.entry0 !== row.entry0
      })
      expect(differing.map((row) => row.url).sort()).toEqual([...expected.entry0Differences.urls].sort())
      for (const row of differing) expect(multiEntry.has(row.url), `${row.url} has one entry`).toBe(true)
    })
  })

  describe("§12.1 baseline facts outside the four gates", () => {
    it("finds all of the golden's menu paths", () => {
      const report = menuReport(goldenSnap, pinned)
      expect(report.findings.join("\n"), `stats ${JSON.stringify(report.stats)}`).toBe("")
    })

    it("finds a second legitimate nav group — the one the expectations name — and nothing else", () => {
      // §10.1/§10.6: detect ALL, report ALL. The reference run was given one menu file and cannot hold a
      // second, so finding two is correct. Naming the extra group and its paths exactly is what stops
      // that argument from excusing an actual scoring regression.
      const report = extraMenuReport(goldenSnap, pinned, expected.extraMenuGroup.paths)
      expect(report.findings.join("\n"), `stats ${JSON.stringify(report.stats)}`).toBe("")

      const group = pinned.graph.navGroups.find((entry) => entry.name === expected.extraMenuGroup.name)
      expect(group, `navGroups: ${JSON.stringify(pinned.graph.navGroups.map((entry) => entry.name))}`).toBeDefined()
      expect(group?.source).toBe(expected.extraMenuGroup.source)
      expect([...(group?.entries ?? [])].map((entry) => entry.path).sort()).toEqual(
        [...expected.extraMenuGroup.paths].sort(),
      )
    })

    it("reports exactly the expected dead nav links, and no other", () => {
      // External targets (`mailto:`, `https:`, protocol-relative) are dropped at extraction
      // (`EXTERNAL_TARGET` in src/adapters/nav-config.ts) rather than reported as dead, so the extra
      // group's `mailto:` entry is not a dead link. Pinning the list means a real menu path that stops
      // resolving makes it non-empty and fails.
      const dead = pinned.graph.diagnostics.filter((entry) => entry.code === "nav/dead-link")
      expect(dead.map((entry) => entry.message)).toEqual(
        expected.deadNavLinks.map(
          (path) => `menu entry '${path}' in '${expected.extraMenuGroup.name}' resolves to no screen`,
        ),
      )
      expect(pinned.counts["deadNavLinks"]).toBe(expected.deadNavLinks.length)
    })

    it("reproduces the golden's shells", () => {
      const report = shellReport(goldenSnap, pinned)
      expect(report.findings.join("\n"), `stats ${JSON.stringify(report.stats)}`).toBe("")
    })

    it("keeps exactly the golden's shells: a guard or error boundary under a layout is not a shell", () => {
      const differences = setDiff(goldenSnap.shells, pinned.shells)
      expect(differences.onlyLeft, "a lost shell is a regression").toEqual([])
      expect(differences.onlyRight).toEqual([])
      expect(pinned.counts["shells"]).toBe(goldenSnap.shells.length)
    })

    it("sorts by codepoint where the golden sorted by locale (§8.9)", () => {
      const report = orderingReport(goldenSnap, pinned)
      expect(report.findings.join("\n"), `stats ${JSON.stringify(report.stats)}`).toBe("")
    })
  })

  describe("§12.4 — zero-config must equal pinned-config", () => {
    // Every table below agrees EXACTLY: the derived `stringSources` and `kindRules` reproduce the pinned
    // answer, and the run is single-source. Detection treats a directory with its own `package.json` as a
    // nested package — its files are evidence for that package, never for the root — so a nested package
    // in the same checkout does not score as a second screen source and a bare run maps the app alone.
    it("agrees on the agent-facing contract", () => {
      expect(formatDifferences(deepDiff(keyedByUrl(pinned.contracts), keyedByUrl(zero.contracts)))).toBe("")
    })

    it("agrees on the coverage table", () => {
      expect(formatDifferences(deepDiff(keyedByUrl(pinned.coverage), keyedByUrl(zero.coverage)))).toBe("")
    })

    it("agrees on endpoints per screen", () => {
      expect(formatDifferences(deepDiff(pinned.endpointsByScreen, zero.endpointsByScreen))).toBe("")
    })

    it("agrees on navigation edges", () => {
      expect(formatDifferences(deepDiff(pinned.navigationEdges, zero.navigationEdges))).toBe("")
    })

    it("agrees on shells", () => {
      expect(formatDifferences(deepDiff([...pinned.shells].sort(), [...zero.shells].sort()))).toBe("")
    })

    it("agrees on the component set", () => {
      expect(
        formatDifferences(deepDiff([...pinned.componentKeys].sort(), [...zero.componentKeys].sort())),
      ).toBe("")
    })

    it("agrees on meta.counts", () => {
      expect(formatDifferences(deepDiff(pinned.counts, zero.counts))).toBe("")
    })

    it("a bare run is single-source and refuses nothing", () => {
      // A nested package scoring for the root would bring back either the
      // `project/multiple-screen-sources` refusal or a second source's screens; both are asserted absent.
      expect(sortedUnique(zero.graph.screens.map((screen) => screen.source))).toEqual(
        sortedUnique(pinned.graph.screens.map((screen) => screen.source)),
      )
      expect(zero.graph.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.code)).toEqual(
        [],
      )
    })

    it("the pinned half's own counts match the expectations' pin", () => {
      // Separate from the agreement above on purpose: zero == pinned passes just as well when BOTH drift,
      // so the pinned run's absolute counts are held against the expectations on their own.
      for (const [key, value] of Object.entries(expected.pinnedCounts)) expect(pinned.counts[key], key).toBe(value)
    })
  })

  describe("hygiene of the run itself", () => {
    it("produces no error-severity diagnostic", () => {
      // A `screens/duplicate-id` or `project/multiple-screen-sources` error means the graph is the result
      // of a collision the tool told us about — asserting it separately keeps a gate-1 finding from being
      // debugged as an extraction bug when it is really a discovery bug.
      const errors = pinned.graph.diagnostics.filter((entry) => entry.severity === "error")
      expect(errors.map((entry) => `${entry.code}: ${entry.message.slice(0, 160)}`)).toEqual([])
    })

    it("emits every requested format", () => {
      expect(pinnedFiles.map((file) => file.path).sort()).toEqual([...expected.emittedFiles].sort())
    })
  })
})
