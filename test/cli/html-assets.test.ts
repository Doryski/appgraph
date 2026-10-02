import { describe, expect, it } from "vitest"
import type { AppGraph } from "../../src/core/model.js"
import { createMemoryHost } from "../../src/core/host.js"
import { renderHtml } from "../../src/emit/html.js"
import { createBuiltinEmitters } from "../../src/pipeline/registry.js"
import type { AnalyzeResult } from "../../src/pipeline/run.js"
import { EMPTY_DETECTION_TRACE } from "../../src/pipeline/run.js"
import { runCli } from "../../src/cli/index.js"

const ROOT = "/repo"

const PROJECT = {
  [`${ROOT}/package.json`]: JSON.stringify({ name: "fixture" }),
  [`${ROOT}/tsconfig.json`]: JSON.stringify({ compilerOptions: { baseUrl: "." } }),
}

const graph: AppGraph = {
  meta: {
    schemaVersion: 2,
    appgraphVersion: "0.1.0-test",
    root: "repo",
    appName: "fixture",
    sourceRoots: ["src"],
    screenSources: ["react-router"],
    maxDepth: 3,
    fingerprint: "",
    counts: { screens: 0 },
    confidence: [],
    limitations: [],
  },
  screens: [],
  redirects: [],
  shells: {},
  components: {},
  navGroups: [],
  navigation: [],
  deadNavLinks: [],
  orphanScreens: [],
  diagnostics: [],
}

const renderHtmlFiles = (): AnalyzeResult["files"] => {
  const emitter = createBuiltinEmitters({ renderHtml }).find((candidate) => candidate.name === "html")
  if (emitter === undefined) throw new Error("no html emitter is registered")
  return emitter.emit(graph, { format: "html", timestamp: null, options: {}, asset: () => "" })
}

const DATA_SCRIPT_PATTERN = /<script type="application\/json" id="appgraph-data">([\s\S]*?)<\/script>/

const inlineBodies = (page: string, tag: "script" | "style"): readonly string[] =>
  [...page.matchAll(new RegExp(`<${tag}(?![^>]*type="application/json")[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map(
    (match) => match[1] ?? "",
  )

describe("html format smoke test", () => {
  it("writes a self-contained report with the data script and the app root", async () => {
    const out: string[] = []
    const err: string[] = []
    const written = new Map<string, string>()

    const code = await runCli(["--root", ROOT, "--format", "html"], {
      analyze: () =>
        Promise.resolve({
          graph,
          files: renderHtmlFiles(),
          diagnostics: [],
          emptyResult: false,
          refused: false,
          exitCode: 0,
          trace: "",
          detection: EMPTY_DETECTION_TRACE,
        }),
      host: createMemoryHost({ files: PROJECT }),
      writer: { out: (line) => out.push(line), err: (line) => err.push(line) },
      writeFile: (absPath, content) => {
        written.set(absPath, content)
      },
      cwd: ROOT,
      version: "0.1.0-test",
    })

    expect(code).toBe(0)

    const html = written.get("/repo/docs/appgraph/appgraph.html")
    expect(html).toBeDefined()
    const page = html ?? ""

    const data = DATA_SCRIPT_PATTERN.exec(page)?.[1] ?? ""
    expect(JSON.parse(data)).toMatchObject({ meta: { appName: "fixture" } })
    expect(page).toContain('<div id="root">')
    expect(page).not.toContain("__APPGRAPH_")
    expect(page).not.toContain("src/emit/assets")

    const scripts = inlineBodies(page, "script")
    const styles = inlineBodies(page, "style")
    expect(scripts.length).toBeGreaterThan(0)
    expect(styles.length).toBeGreaterThan(0)
    expect(scripts.every((body) => body.trim().length > 0)).toBe(true)
    expect(styles.every((body) => body.trim().length > 0)).toBe(true)
    expect(Math.max(...scripts.map((body) => body.length))).toBeGreaterThan(10_000)

    expect(out.join("\n")).toContain("appgraph.html")
  })
})
