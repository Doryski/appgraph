import type { AppGraph } from "../../src/core/model.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { AnalyzeResult } from "../../src/pipeline/run.js"
import { EMPTY_DETECTION_TRACE } from "../../src/pipeline/run.js"
import { runCli } from "../../src/cli/index.js"
import type { CliDeps } from "../../src/cli/index.js"
import { GRAPH_CACHE_FILE, encodeGraphCache } from "../../src/emit/graph-cache.js"

export const ROOT = "/repo"

const PROJECT = {
  [`${ROOT}/package.json`]: JSON.stringify({ name: "fixture" }),
  [`${ROOT}/tsconfig.json`]: JSON.stringify({ compilerOptions: { baseUrl: "." } }),
  [`${ROOT}/src/App.tsx`]: "export const App = () => null",
}

const ROOTLESS: ReadonlySet<string> = new Set(["glossary"])

export type CatalogRun = {
  readonly code: number
  readonly out: readonly string[]
  readonly err: readonly string[]
  readonly analyses: number
}

const resultOf = (graph: AppGraph): AnalyzeResult => ({
  graph,
  files: [{ path: GRAPH_CACHE_FILE, content: encodeGraphCache(graph) }],
  diagnostics: [],
  emptyResult: graph.meta.emptyResult === true,
  refused: false,
  exitCode: 0,
  trace: "",
  detection: EMPTY_DETECTION_TRACE,
})

type Session = {
  readonly files: Readonly<Record<string, string>>
  readonly graph: AppGraph
}

const execute = async (argv: readonly string[], session: Session): Promise<CatalogRun & { readonly written: Readonly<Record<string, string>> }> => {
  const out: string[] = []
  const err: string[] = []
  const written: Record<string, string> = {}
  let analyses = 0
  const deps: CliDeps = {
    analyze: () => {
      analyses += 1
      return Promise.resolve(resultOf(session.graph))
    },
    host: createMemoryHost({ files: { ...PROJECT, ...session.files } }),
    writer: { out: (line) => out.push(line), err: (line) => err.push(line) },
    writeFile: (absPath, content) => {
      written[absPath] = content
    },
    compiler: () => Promise.resolve({ kind: "supported", version: "6.0.3" }),
    tsconfig: () =>
      Promise.resolve({ files: ["tsconfig.json"], baseUrl: ".", paths: {}, include: ["src"], moduleResolution: null, jsx: null }),
    cwd: ROOT,
    version: session.graph.meta.appgraphVersion,
  }
  const code = await runCli(argv, deps)
  return { code, out, err, analyses, written }
}

export const catalogBench = async (graph: AppGraph) => {
  const warm = await execute(["stats", "--root", ROOT, "--json", "--quiet"], { files: {}, graph })
  const session = { files: warm.written, graph }
  return async (argv: readonly string[]): Promise<CatalogRun> => {
    const result = await execute(ROOTLESS.has(argv[0] ?? "") ? argv : [...argv, "--root", ROOT], session)
    return { code: result.code, out: result.out, err: result.err, analyses: result.analyses }
  }
}

export const jsonOf = (run: CatalogRun): Record<string, unknown> => JSON.parse(run.out.join("\n")) as Record<string, unknown>

export const itemsOf = (run: CatalogRun): readonly Record<string, unknown>[] =>
  (jsonOf(run)["items"] ?? []) as readonly Record<string, unknown>[]
