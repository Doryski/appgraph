/**
 * A dev-time cross-check of `yaml-read.ts` against a real YAML implementation.
 *
 *   APPGRAPH_JS_YAML=/abs/path/to/node_modules/js-yaml/index.js npx tsx test/parity/oracle.mts
 *
 * `js-yaml` is deliberately NOT a dependency (or devDependency) of this package: appgraph ships a
 * zero-dependency serializer (§7.12) and a test-only reader, and adding a YAML library to prove the
 * reader right would put the thing being avoided into the dependency tree. So the oracle is opt-in,
 * loaded by absolute path from wherever the operator already has it, and it exits 0 with a message when
 * it is not available.
 *
 * What it proves: for each of the three frozen golden documents, `readYaml` produces a structure DEEPLY
 * EQUAL to js-yaml's, so a "difference from the golden" reported by the gate is never a parser artifact.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import * as process from "node:process"
import { GOLDEN_SHA256, goldenDir } from "./golden.js"
import { GOLDEN_HINT, parityGolden } from "./golden-target.js"
import { readYaml } from "./yaml-read.js"
import { deepDiff, formatDifferences } from "./compare.js"

const location = process.env["APPGRAPH_JS_YAML"]
if (location === undefined) {
  console.log("APPGRAPH_JS_YAML is unset — skipping the js-yaml oracle (it is not a dependency by design)")
  process.exit(0)
}

if (parityGolden() === null) {
  console.log(`No parity golden — ${GOLDEN_HINT}`)
  process.exit(0)
}

const module: unknown = await import(location)
const load = (module as { load?: (text: string) => unknown; default?: { load: (text: string) => unknown } })
const parse = load.load ?? load.default?.load
if (parse === undefined) throw new Error(`no 'load' export at ${location}`)

let failures = 0
for (const file of Object.keys(GOLDEN_SHA256)) {
  const text = fs.readFileSync(path.join(goldenDir(), file), "utf8")
  const differences = deepDiff(parse(text), readYaml(text))
  if (differences.length === 0) {
    console.log(`ok   ${file}: js-yaml and yaml-read agree`)
    continue
  }
  failures += 1
  console.log(`FAIL ${file}: ${String(differences.length)} difference(s)`)
  console.log(formatDifferences(differences, 20))
}

process.exit(failures === 0 ? 0 : 1)
