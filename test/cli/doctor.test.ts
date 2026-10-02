import { describe, expect, it } from "vitest"
import type { AppGraph, NavGroup } from "../../src/core/model.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { AnalyzeOptions, AnalyzeResult } from "../../src/pipeline/run.js"
import { EMPTY_DETECTION_TRACE } from "../../src/pipeline/run.js"
import { runCli } from "../../src/cli/index.js"
import type { CliDeps } from "../../src/cli/index.js"

const ROOT = "/repo"

const PROJECT = {
  [`${ROOT}/package.json`]: JSON.stringify({ name: "fixture" }),
  [`${ROOT}/tsconfig.json`]: JSON.stringify({ compilerOptions: { baseUrl: "." } }),
  [`${ROOT}/src/App.tsx`]: "export const App = () => null",
}

const navGroup: NavGroup = {
  name: "sidebar",
  source: "config-menu",
  score: 0.75,
  availableOnShells: [],
  entries: [
    {
      path: "/invoices",
      parentPath: null,
      label: "Invoices",
      labelKey: null,
      featureFlag: null,
      source: "config-menu",
      file: "src/config.tsx",
      line: 4,
      resolvedScreen: "/invoices",
    },
  ],
}

const graph = (): AppGraph => ({
  meta: {
    schemaVersion: 2,
    appgraphVersion: "0.1.0-test",
    root: "repo",
    appName: "fixture",
    sourceRoots: ["src"],
    screenSources: ["react-router"],
    maxDepth: 3,
    fingerprint: "",
    counts: { screens: 4, endpoints: 9 },
    confidence: [
      { section: "stores", count: 0, enablingDependency: "zustand", dependencyInstalled: true, level: "suspect" },
    ],
    limitations: ["client-side nav edges are not linked"],
  },
  screens: [],
  redirects: [],
  shells: {},
  components: {},
  navGroups: [navGroup],
  navigation: [],
  deadNavLinks: [],
  orphanScreens: [],
  diagnostics: [],
})

type Harness = {
  readonly deps: CliDeps
  readonly out: string[]
  readonly err: string[]
  readonly written: Map<string, string>
  readonly calls: AnalyzeOptions[]
}

const harness = (input: { readonly result?: AnalyzeResult; readonly reject?: Error } = {}): Harness => {
  const out: string[] = []
  const err: string[] = []
  const written = new Map<string, string>()
  const calls: AnalyzeOptions[] = []

  const result: AnalyzeResult =
    input.result ?? {
      graph: graph(),
      files: [],
      diagnostics: [],
      emptyResult: false,
      refused: false,
      exitCode: 0,
      trace: "",
      detection: {
        ...EMPTY_DETECTION_TRACE,
        exclusions: [
          { pattern: ".*/", reason: "dot-directory" },
          { pattern: ".gitignore", reason: "gitignore", source: ".gitignore" },
        ],
        nestedPackages: [{ dir: "extension", sources: ["manifest-activation"] }],
      },
    }

  return {
    out,
    err,
    written,
    calls,
    deps: {
      analyze: (options) => {
        calls.push(options)
        return input.reject === undefined ? Promise.resolve(result) : Promise.reject(input.reject)
      },
      host: createMemoryHost({ files: PROJECT }),
      writer: { out: (line) => out.push(line), err: (line) => err.push(line) },
      writeFile: (absPath, content) => {
        written.set(absPath, content)
      },
      tsconfig: () =>
        Promise.resolve({
          files: ["tsconfig.base.json", "tsconfig.json"],
          baseUrl: ".",
          paths: { "@/*": ["src/*"] },
          include: ["src"],
          moduleResolution: "bundler",
          jsx: "react-jsx",
        }),
      cwd: ROOT,
      version: "0.1.0-test",
    },
  }
}

describe("appgraph doctor", () => {
  it("prints the resolution, tsconfig chain, sources, nav candidates and fingerprint, and writes nothing", async () => {
    const bench = harness()
    const code = await runCli(["doctor", "--root", ROOT], bench.deps)
    const printed = bench.out.join("\n")

    expect(code).toBe(0)
    expect(bench.written.size).toBe(0)
    expect(printed).toContain("appgraph doctor — v0.1.0-test")
    expect(printed).toContain(`root:         ${ROOT}  (--root)`)
    expect(printed).toContain("tsconfig chain")
    expect(printed).toContain("1. tsconfig.base.json")
    expect(printed).toContain("@/* -> src/*")
    expect(printed).toContain("source roots: src")
    expect(printed).toContain("screen sources that ran")
    expect(printed).toContain("react-router")
    expect(printed).toContain("screens: 4")
    expect(printed).toContain("config-menu#sidebar  score=0.75  entries=1  resolved=1")
    expect(printed).toContain("stores  count=0  level=suspect  dep=zustand  installed=true")
    expect(printed).toContain("test-id attribute histogram")
    expect(printed).toContain("staleness fingerprint")
    expect(printed).toContain("appgraphVersion=0.1.0-test")
    expect(printed).toContain("excluded from discovery (pattern, reason)")
    expect(printed).toContain(".*/  (dot-directory)")
    expect(printed).toContain(".gitignore  (gitignore: .gitignore)")
    expect(printed).toContain("extension/  run appgraph --root extension to map it  (evidence for: manifest-activation)")
  })

  it("still prints a report when analysis finds nothing, including the zero-screen trace", async () => {
    const trace = "appgraph found no screens.\n\n  root:         repo\n  globs attempted:\n    src/**/*.tsx -> 0 match(es)"
    const bench = harness({
      result: {
        graph: graph(),
        files: [],
        diagnostics: [],
        emptyResult: true,
        refused: false,
        exitCode: 1,
        trace,
        detection: EMPTY_DETECTION_TRACE,
      },
    })

    const code = await runCli(["doctor", "--root", ROOT], bench.deps)
    const printed = bench.out.join("\n")

    expect(code).toBe(0)
    expect(printed).toContain("zero-screen trace")
    expect(printed).toContain("src/**/*.tsx -> 0 match(es)")
  })

  it("still prints a report when the analysis throws — it is the 'why did it guess wrong' command", async () => {
    const bench = harness({ reject: new Error("no tsconfig.json found") })
    const code = await runCli(["doctor", "--root", ROOT], bench.deps)
    const printed = bench.out.join("\n")

    expect(code).toBe(0)
    expect(printed).toContain("analysis failed")
    expect(printed).toContain("no tsconfig.json found")
    expect(printed).toContain("tsconfig chain")
    expect(printed).toContain("staleness fingerprint")
  })

  it.each([
    [{ framework: "vue", status: "loaded", version: "3.5.43", from: "appgraph" }, "  vue compiler: 3.5.43 (appgraph fallback)"],
    [{ framework: "vue", status: "loaded", version: "3.5.43", from: "project" }, "  vue compiler: 3.5.43 (project)"],
    [{ framework: "vue", status: "missing", version: null, from: null }, "  vue compiler: missing — template facts skipped"],
    [{ framework: "vue", status: "unsupported", version: "2.7.16", from: null }, "  vue compiler: unsupported 2.7.16"],
  ] as const)("prints the template compiler line for %o", async (status, line) => {
    const bench = harness({
      result: {
        graph: graph(),
        files: [],
        diagnostics: [],
        emptyResult: false,
        refused: false,
        exitCode: 0,
        trace: "",
        detection: { ...EMPTY_DETECTION_TRACE, templateCompilers: [status] },
      },
    })

    const code = await runCli(["doctor", "--root", ROOT], bench.deps)

    expect(code).toBe(0)
    expect(bench.out.join("\n")).toContain(line)
  })

  it("omits the vue compiler line for a project without Vue", async () => {
    const bench = harness()
    await runCli(["doctor", "--root", ROOT], bench.deps)

    expect(bench.out.join("\n")).not.toContain("vue compiler")
  })

  it("prints one compiler line per template framework, in trace order", async () => {
    const bench = harness({
      result: {
        graph: graph(),
        files: [],
        diagnostics: [],
        emptyResult: false,
        refused: false,
        exitCode: 0,
        trace: "",
        detection: {
          ...EMPTY_DETECTION_TRACE,
          templateCompilers: [
            { framework: "vue", status: "loaded", version: "3.5.43", from: "project" },
            { framework: "angular", status: "loaded", version: "22.0.1", from: "appgraph" },
          ],
        },
      },
    })

    await runCli(["doctor", "--root", ROOT], bench.deps)

    const lines = bench.out.join("\n").split("\n")
    expect(lines.filter((line) => line.includes(" compiler: "))).toEqual([
      "  vue compiler: 3.5.43 (project)",
      "  angular compiler: 22.0.1 (appgraph fallback)",
    ])
  })

  it("--json emits one object on stdout with the whole report and keeps prose on stderr", async () => {
    const bench = harness()
    const code = await runCli(["doctor", "--root", ROOT, "--json"], bench.deps)

    expect(code).toBe(0)
    expect(bench.out).toHaveLength(1)
    const payload: unknown = JSON.parse(bench.out[0] ?? "")
    expect(payload).toMatchObject({ command: "doctor", root: ROOT, screenSources: ["react-router"], exitCode: 0 })
    expect(bench.err.join("\n")).toContain("appgraph doctor")
  })
})
