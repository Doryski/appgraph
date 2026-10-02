/// <reference types="node" />
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { buildFixtureGraph } from "./fixture-graph.js"

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), ".out")

export const REPORT_PATH = resolve(OUT_DIR, "report.html")
export const REPORT_PL_PATH = resolve(OUT_DIR, "report-pl.html")
export const REPORT_URL = pathToFileURL(REPORT_PATH).href
export const REPORT_PL_URL = pathToFileURL(REPORT_PL_PATH).href

const CLI_ROOT = "/fixture"

const CLI_PROJECT = {
  [`${CLI_ROOT}/package.json`]: JSON.stringify({ name: "fixture-shop" }),
  [`${CLI_ROOT}/tsconfig.json`]: JSON.stringify({ compilerOptions: { baseUrl: "." } }),
}

const CLI_REPORT_FILE = "appgraph.html"

const REPORTS = [
  { path: REPORT_PATH, args: [] },
  { path: REPORT_PL_PATH, args: ["--locale", "pl"] },
] as const

const renderThroughCli = async (args: readonly string[]): Promise<string> => {
  const [{ runCli }, { createMemoryHost }, { createBuiltinEmitters }, { EMPTY_DETECTION_TRACE }, { renderHtml }] =
    await Promise.all([
      import("../src/cli/index.js"),
      import("../src/core/host.js"),
      import("../src/pipeline/registry.js"),
      import("../src/pipeline/run.js"),
      import("../src/emit/html.js"),
    ])
  const graph = buildFixtureGraph()
  const written = new Map<string, string>()
  const problems: string[] = []
  const code = await runCli(["--root", CLI_ROOT, "--format", "html", "--no-timestamp", ...args], {
    analyze: (options) => {
      const emitter = createBuiltinEmitters({ ...options.emit, renderHtml }).find((candidate) => candidate.name === "html")
      if (emitter === undefined) throw new Error("no html emitter is registered")
      const files = emitter.emit(graph, {
        format: "html",
        timestamp: options.timestamp ?? null,
        options: {},
        asset: () => "",
      })
      return Promise.resolve({
        graph,
        files,
        diagnostics: [],
        emptyResult: false,
        refused: false,
        exitCode: 0,
        trace: "",
        detection: EMPTY_DETECTION_TRACE,
      })
    },
    host: createMemoryHost({ files: CLI_PROJECT }),
    writer: { out: () => undefined, err: (line) => problems.push(line) },
    writeFile: (absPath, content) => {
      written.set(absPath, content)
    },
    cwd: CLI_ROOT,
    version: "0.0.0-e2e",
  })
  const html = [...written].find(([path]) => path.endsWith(`/${CLI_REPORT_FILE}`))?.[1]
  if (code !== 0 || html === undefined) throw new Error(`appgraph CLI failed (exit ${code}): ${problems.join("\n")}`)
  return html
}

export default async function globalSetup() {
  mkdirSync(OUT_DIR, { recursive: true })
  for (const report of REPORTS) writeFileSync(report.path, await renderThroughCli(report.args))
}
