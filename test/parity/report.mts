/**
 * The parity report, run by hand against a private application checkout:
 *
 *   APPGRAPH_PARITY_FIXTURE="$(cat test/parity/target.local)" \
 *   APPGRAPH_PARITY_GOLDEN=/abs/path/to/parity-golden npx tsx test/parity/report.mts
 *
 * It runs both §12.4 comparisons, prints every gate verbatim with its numbers, and prints the raw material
 * a human needs to classify each difference as an expected bug-fix consequence or an unexplained
 * regression. It asserts nothing — `target-app.test.ts` is the gate; this is the microscope.
 */
import * as process from "node:process"
import { goldenSnapshot } from "./golden.js"
import { GOLDEN_HINT, parityGolden } from "./golden-target.js"
import { readExpectations } from "./expectations.js"
import { observedSnapshot } from "./observed.js"
import { runPinned, runZeroConfig } from "./pinned.js"
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
import { setDiff } from "./compare.js"
import { keyedByUrl } from "./model.js"
import { runAssertions } from "./assertions.js"
import { NOT_APPLICABLE_HERE } from "./assertions.js"
import { KNOWN_GAPS } from "./known-gaps.js"
import { TARGET_HINT, parityTargetPointer, pinMismatch } from "./target.js"
import type { GateResult } from "./gates.js"

const pointer = parityTargetPointer()
if (pointer === null) {
  console.error(`No parity target — ${TARGET_HINT}`)
  process.exit(2)
}
const { root } = pointer
const mismatch = pinMismatch(pointer)
if (mismatch !== null) console.warn(`WARNING: ${mismatch}`)
if (parityGolden() === null) {
  console.error(`No parity golden — ${GOLDEN_HINT}`)
  process.exit(2)
}

const expected = readExpectations()

const show = (gate: GateResult): void => {
  console.log(`\n### ${gate.gate}: ${gate.pass ? "PASS" : "FAIL"}`)
  console.log(`    stats: ${JSON.stringify(gate.stats)}`)
  for (const finding of gate.findings) console.log(`    ${finding.replaceAll("\n", "\n    ")}`)
}

const golden = goldenSnapshot()

const pinnedRun = await runPinned(root, pointer.config ?? {})
const pinned = observedSnapshot(pinnedRun, "pinned")
const zeroRun = await runZeroConfig(root)
const zero = observedSnapshot(zeroRun, "zero-config")

console.log("# appgraph parity report")
console.log(`\nroot: ${root}`)
console.log(`golden counts:  ${JSON.stringify(golden.counts)}`)
console.log(`pinned counts:  ${JSON.stringify(pinned.counts)}`)
console.log(`zero counts:    ${JSON.stringify(zero.counts)}`)
console.log(`pinned diagnostics: ${JSON.stringify(pinned.diagnosticCounts)}`)
console.log(`zero diagnostics:   ${JSON.stringify(zero.diagnosticCounts)}`)
console.log(`pinned stateScreens: ${JSON.stringify(pinned.stateScreenIds)}`)
console.log(`zero stateScreens:   ${JSON.stringify(zero.stateScreenIds)}`)

console.log("\n## Pinned config vs golden")
show(gate1(golden, pinned))
show(gate2(golden, pinned))
show(gate4(keyedByUrl(golden.contracts), keyedByUrl(pinned.contracts), "contract table, keyed by url"))
show(entriesSetReport(golden, pinned))
show(menuReport(golden, pinned))
show(extraMenuReport(golden, pinned, expected.extraMenuGroup.paths))
show(shellReport(golden, pinned))
show(orderingReport(golden, pinned))

console.log("\n## Gate 3 — named assertions")
for (const assertion of runAssertions(golden, pinned, expected, pinnedRun.files)) {
  console.log(`\n### ${assertion.id} ${assertion.pass ? "PASS" : "FAIL"} — ${assertion.claim}`)
  console.log(`    ${assertion.detail.replaceAll("\n", "\n    ")}`)
}

console.log("\n## Pinned vs zero-config (§12.4)")
show(gate4(keyedByUrl(pinned.contracts), keyedByUrl(zero.contracts), "contract table, keyed by url"))
show(gate4(keyedByUrl(pinned.coverage), keyedByUrl(zero.coverage), "coverage table, keyed by url"))
show(gate4(pinned.counts, zero.counts, "meta.counts"))
show(gate4(pinned.endpointsByScreen, zero.endpointsByScreen, "endpoints by screen"))
show(gate4(pinned.navigationEdges, zero.navigationEdges, "navigation edges"))
show(gate4([...pinned.shells].sort(), [...zero.shells].sort(), "shells"))
show(gate4([...pinned.componentKeys].sort(), [...zero.componentKeys].sort(), "component key set"))
show(gate4(pinned.componentKeys, zero.componentKeys, "component key ORDER"))

console.log("\n## Raw material")
const navDiff = setDiff(golden.navigationEdges, pinned.navigationEdges)
console.log(`navigation edges golden=${String(golden.navigationEdges.length)} pinned=${String(pinned.navigationEdges.length)}`)
console.log(`  only in golden: ${JSON.stringify(navDiff.onlyLeft)}`)
console.log(`  only in pinned: ${JSON.stringify(navDiff.onlyRight)}`)

const allGoldenEndpoints = new Set(Object.values(golden.endpointsByScreen).flat())
const allPinnedEndpoints = new Set(Object.values(pinned.endpointsByScreen).flat())
const endpointDiff = setDiff([...allGoldenEndpoints], [...allPinnedEndpoints])
console.log(
  `distinct endpoints golden=${String(allGoldenEndpoints.size)} pinned=${String(allPinnedEndpoints.size)}`,
)
console.log(`  only in golden (first 40): ${JSON.stringify(endpointDiff.onlyLeft.slice(0, 40))}`)
console.log(`  only in pinned: ${JSON.stringify(endpointDiff.onlyRight)}`)

const componentDiff = setDiff(golden.componentKeys, pinned.componentKeys)
console.log(`component keys golden=${String(golden.componentKeys.length)} pinned=${String(pinned.componentKeys.length)}`)
console.log(`  only in golden (first 30): ${JSON.stringify(componentDiff.onlyLeft.slice(0, 30))}`)
console.log(`  only in pinned (first 30): ${JSON.stringify(componentDiff.onlyRight.slice(0, 30))}`)

console.log("\ncoverage table (golden -> pinned)")
const pinnedCoverage = new Map(pinned.coverage.map((row) => [row.url, row]))
for (const row of golden.coverage) {
  const observed = pinnedCoverage.get(row.url)
  const cell = (a: number, b: number | undefined): string => `${String(a)}->${b === undefined ? "-" : String(b)}`
  console.log(
    `  ${row.url.padEnd(44)} reach ${cell(row.reachable, observed?.reachable).padEnd(11)} ep ${cell(row.endpoints, observed?.endpoints).padEnd(10)} ti ${cell(row.testIds, observed?.testIds).padEnd(8)} st ${cell(row.stores, observed?.stores).padEnd(8)} i18n ${cell(row.i18nNamespaces, observed?.i18nNamespaces).padEnd(8)} ff ${cell(row.formFields, observed?.formFields)}`,
  )
}

console.log("\nemitted files (pinned):")
for (const file of pinnedRun.files) console.log(`  ${file.path}  ${String(file.content.length)} B`)

console.log("\n## What this gate cannot check here, and why")
for (const entry of NOT_APPLICABLE_HERE) console.log(`  - ${entry}`)
console.log(
  "  - the HTML report: excluded from the goldens by construction (§12.6) — the reference output embeds",
)
console.log("    `new Date().toISOString().slice(0, 16)` in its report header.")

console.log("\n## Known gaps (measured, not accepted)")
for (const gap of KNOWN_GAPS) {
  console.log(`\n  ${gap.id}  [${gap.spec}]`)
  console.log(`    measured:   ${gap.measured}`)
  console.log(`    when fixed: ${gap.whenFixed}`)
}
