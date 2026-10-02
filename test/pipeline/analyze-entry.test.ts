import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import ts from "typescript"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Diagnostic } from "../../src/core/model.js"
import { createMemoryHost } from "../../src/core/host.js"
import { resolveConfig } from "../../src/config/types.js"
import {
  EXIT_DIAGNOSTIC_ERROR,
  EXIT_NO_SCREENS,
  EXIT_OK,
  EXIT_STRICT_WARNING,
  EXIT_USAGE,
  UNKNOWN_SCREEN_CODE,
  exitCodeFor,
} from "../../src/pipeline/exit-codes.js"
import { analyze, detectionStatus, runPipeline } from "../../src/pipeline/run.js"
import { ROOT, adapterFor, codes, staticSource, withProject } from "./harness.js"

const diagnostic = (severity: Diagnostic["severity"], code = "test/code"): Diagnostic => ({
  severity,
  code,
  message: code,
  plugin: null,
})

const clean = { refused: false, emptyResult: false, diagnostics: [] }

describe("exitCodeFor — the CLI's exact mapping", () => {
  it.each([
    ["a clean run", clean, false, EXIT_OK],
    ["an empty run", { ...clean, emptyResult: true }, false, EXIT_NO_SCREENS],
    ["a refusal (beats empty)", { ...clean, refused: true, emptyResult: true }, false, EXIT_DIAGNOSTIC_ERROR],
    ["an error without strict", { ...clean, diagnostics: [diagnostic("error")] }, false, EXIT_DIAGNOSTIC_ERROR],
    ["a warning without strict", { ...clean, diagnostics: [diagnostic("warning")] }, false, EXIT_OK],
    ["a warning under strict", { ...clean, diagnostics: [diagnostic("warning")] }, true, EXIT_STRICT_WARNING],
    ["an error under strict (beats the warning)", { ...clean, diagnostics: [diagnostic("warning"), diagnostic("error")] }, true, EXIT_DIAGNOSTIC_ERROR],
    ["an unknown --screen (usage beats everything)", { ...clean, emptyResult: true, diagnostics: [diagnostic("error", UNKNOWN_SCREEN_CODE)] }, false, EXIT_USAGE],
  ] as const)("maps %s", (_label, result, strict, expected) => {
    expect(exitCodeFor(result, strict)).toBe(expected)
  })
})

describe("detectionStatus — doctor's classification in the trace", () => {
  it("labels a live source live, a scored dead one near-miss and a zero score no", () => {
    expect(detectionStatus({ source: "a", score: 90, live: true, evidence: [] })).toBe("live")
    expect(detectionStatus({ source: "b", score: 20, live: false, evidence: [] })).toBe("near-miss")
    expect(detectionStatus({ source: "c", score: 0, live: false, evidence: [] })).toBe("no")
  })

  it("never calls a score-0 source a near-miss in the zero-screen trace", () => {
    const result = runPipeline({
      ts,
      host: createMemoryHost({ files: withProject({}) }),
      config: resolveConfig({
        root: ROOT,
        appgraphVersion: "0.1.0-test",
        formats: ["full"],
        detections: [{ source: "test-empty", score: 0, live: false, evidence: [] }],
      }),
      adapters: [adapterFor(staticSource("test-empty", []))],
    })

    expect(result.trace).toContain("test-empty  score 0  no")
    expect(result.trace).not.toContain("near-miss\n")
  })
})

describe("--screen naming no screen", () => {
  const PAGE = { "src/a.tsx": "export default function A() { return <div /> }\n" }
  const source = staticSource("test-static", [
    {
      localId: "src/a.tsx",
      activations: [{ kind: "url", template: "/a", params: [] }],
      entries: [{ kind: "file", file: "src/a.tsx", exportName: "default" }],
      evidence: [],
    },
  ])

  const runDetail = (screen: string) =>
    runPipeline({
      ts,
      host: createMemoryHost({ files: withProject(PAGE) }),
      config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test", formats: ["detail", "index"] }),
      adapters: [adapterFor(source)],
      emitOptions: { screen },
    })

  it("reports one emit/unknown-screen error instead of a wrapped plugin/threw, and exits as a usage error", () => {
    const result = runDetail("/missing")

    expect(codes(result)).toContain(UNKNOWN_SCREEN_CODE)
    expect(codes(result)).not.toContain("plugin/threw")
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect(result.files.map((file) => file.path)).toEqual(["appgraph.index.yaml"])
  })

  it("still emits the detail view for a known screen", () => {
    const result = runDetail("/a")

    expect(codes(result)).not.toContain(UNKNOWN_SCREEN_CODE)
    expect(result.files.map((file) => file.path)).toContain("appgraph.a.yaml")
  })
})

describe("analyze() resolves config the way the CLI does", () => {
  let dir = ""

  const write = (file: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content, "utf8")
  }

  const project = (sub: string): void => {
    write(`${sub}/package.json`, JSON.stringify({ name: "fixture" }))
    write(`${sub}/tsconfig.json`, JSON.stringify({ include: ["src"] }))
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "appgraph-analyze-"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("loads appgraph.config.* from the root when no config object is passed", async () => {
    project(".")
    write("appgraph.config.mjs", 'export default { allowEmpty: true, formats: ["index"] }\n')

    const result = await analyze({ ts, root: dir, adapters: [adapterFor(staticSource("test-empty", []))] })

    expect(result.files.map((file) => file.path)).toEqual(["appgraph.index.yaml"])
  })

  it("labels the loaded file's validation diagnostics with its path", async () => {
    project(".")
    write("appgraph.config.mjs", "export default { allowEmpty: true, bogusField: 1 }\n")

    const result = await analyze({ ts, root: dir, adapters: [adapterFor(staticSource("test-empty", []))] })

    expect(result.diagnostics.find((entry) => entry.code.startsWith("config/"))?.file).toBe("appgraph.config.mjs")
  })

  it("resolves the loaded config's own root against the config file's directory", async () => {
    project(".")
    project("nested-app")
    write("appgraph.config.mjs", 'export default { root: "nested-app" }\n')

    const result = await analyze({ ts, cwd: dir, adapters: [adapterFor(staticSource("test-empty", []))] })

    expect(result.trace).toContain("root:         nested-app")
  })

  it("resolves an inline config root against options.cwd, not process.cwd()", async () => {
    project("inline-app")

    const result = await analyze({
      ts,
      cwd: dir,
      config: { root: "inline-app" },
      adapters: [adapterFor(staticSource("test-empty", []))],
    })

    expect(result.trace).toContain("root:         inline-app")
    expect(result.exitCode).toBe(EXIT_NO_SCREENS)
  })

  it("hands the resolved inline root to the config layers, so the project is found from another cwd", async () => {
    project("inline-app")

    const result = await analyze({
      ts,
      cwd: dir,
      config: { root: "inline-app" },
      adapters: [adapterFor(staticSource("test-empty", []))],
    })

    expect(codes(result)).not.toContain("project/no-tsconfig")
  })

  it("does not load the config file when a config object is passed", async () => {
    project(".")
    write("appgraph.config.mjs", 'export default { allowEmpty: true, formats: ["index"] }\n')

    const result = await analyze({ ts, root: dir, config: {}, adapters: [adapterFor(staticSource("test-empty", []))] })

    expect(result.files).toEqual([])
  })
})
