import ts from "typescript"
import { createMemoryHost } from "../../src/core/host.js"
import { resolveConfig } from "../../src/config/types.js"
import type { Diagnostic } from "../../src/core/model.js"
import type { DiscoverContext } from "../../src/adapters/types.js"
import { createDiscoverContext, createEnv } from "../../src/pipeline/context.js"

export const ROOT = "/repo"

const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: "." }, include: ["src"] })

export type DiscoverBench = {
  readonly ctx: DiscoverContext
  readonly diagnostics: () => readonly Diagnostic[]
  /** First node (pre-order) of `file` satisfying `match`. */
  readonly find: <T extends ts.Node>(file: string, match: (node: ts.Node) => node is T) => T
}

export const discoverBench = (files: Readonly<Record<string, string>>): DiscoverBench => {
  const host = createMemoryHost({
    files: {
      [`${ROOT}/package.json`]: JSON.stringify({ name: "fixture" }),
      [`${ROOT}/tsconfig.json`]: TSCONFIG,
      ...Object.fromEntries(Object.entries(files).map(([file, text]) => [`${ROOT}/${file}`, text])),
    },
  })
  const env = createEnv({ ts, config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }), host })
  const ctx = createDiscoverContext({ env, plugin: "test" })

  const find = <T extends ts.Node>(file: string, match: (node: ts.Node) => node is T): T => {
    const source = ctx.sourceFile(file)
    if (source === null) throw new Error(`no source ${file}`)
    let found: T | null = null
    const visit = (node: ts.Node): void => {
      if (found !== null) return
      if (match(node)) {
        found = node
        return
      }
      node.forEachChild(visit)
    }
    visit(source)
    if (found === null) throw new Error(`no matching node in ${file}`)
    return found
  }

  return { ctx, diagnostics: () => env.diagnostics.all(), find }
}
