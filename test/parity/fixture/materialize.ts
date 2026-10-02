import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { MINI_APP_FILES } from "./mini-app.js"

/**
 * Writes the fixture to a real temp directory rather than serving it from `createMemoryHost`.
 *
 * The reason is §12.4: the zero-config run must be `analyze({ root })` with NOTHING else. A memory host
 * is another option, and passing one would mean the zero-config run is not the call users make — it
 * would also bypass `core/walker.ts`, the exclusion list and the generated-file rules, which are
 * precisely the detection machinery the zero-config run exists to test.
 *
 * The fixture also cannot live as `.tsx` files in the repo: `tsconfig.json` includes `test/**` and
 * excludes only `test/golden/**`, so committed fixture sources would be type-checked against a React
 * that is not a dependency of this package. Keeping them as strings sidesteps that.
 */
export const materializeMiniApp = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appgraph-parity-fixture-"))
  for (const [relative, content] of Object.entries(MINI_APP_FILES)) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, "utf8")
  }
  return root
}

export const removeMiniApp = (root: string): void => {
  fs.rmSync(root, { recursive: true, force: true })
}
