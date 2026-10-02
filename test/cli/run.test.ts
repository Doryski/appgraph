import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { AppGraph, Diagnostic } from "../../src/core/model.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { EmitFile } from "../../src/adapters/types.js"
import type { AnalyzeOptions, AnalyzeResult } from "../../src/pipeline/run.js"
import { EMPTY_DETECTION_TRACE, PIPELINE_PHASES } from "../../src/pipeline/run.js"
import { runCli } from "../../src/cli/index.js"
import type { CliDeps } from "../../src/cli/index.js"
import { FINGERPRINT_FILE, parseSidecar } from "../../src/cli/stale.js"
import { GRAPH_CACHE_FILE, encodeGraphCache } from "../../src/emit/graph-cache.js"
import { formatDiagnostic, sanitizeForTerminal } from "../../src/cli/print.js"

const ROOT = "/repo"

const OUT = `${ROOT}/docs/appgraph`

const PROJECT = {
  [`${ROOT}/package.json`]: JSON.stringify({ name: "fixture" }),
  [`${ROOT}/tsconfig.json`]: JSON.stringify({ compilerOptions: { baseUrl: "." } }),
  [`${ROOT}/src/App.tsx`]: "export const App = () => null",
}

const emptyGraph = (counts: Readonly<Record<string, number>> = { screens: 1 }): AppGraph => ({
  meta: {
    schemaVersion: 2,
    appgraphVersion: "0.1.0-test",
    root: "repo",
    appName: "fixture",
    sourceRoots: ["src"],
    screenSources: ["react-router"],
    maxDepth: 3,
    fingerprint: "",
    counts,
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
})

const diagnostic = (severity: Diagnostic["severity"], code: string): Diagnostic => ({
  severity,
  code,
  message: `${code} happened`,
  plugin: null,
  file: "src/App.tsx",
  line: 12,
})

type ResultOverrides = {
  readonly files?: readonly EmitFile[]
  readonly diagnostics?: readonly Diagnostic[]
  readonly emptyResult?: boolean
  readonly refused?: boolean
  readonly trace?: string
}

const resultOf = (overrides: ResultOverrides = {}): AnalyzeResult => ({
  graph: emptyGraph(),
  files: overrides.files ?? [{ path: "appgraph.yaml", content: "meta:\n  schemaVersion: 1\n" }],
  diagnostics: overrides.diagnostics ?? [],
  emptyResult: overrides.emptyResult ?? false,
  refused: overrides.refused ?? false,
  exitCode: 0,
  trace: overrides.trace ?? "",
  detection: EMPTY_DETECTION_TRACE,
})

type Harness = {
  readonly deps: CliDeps
  readonly out: string[]
  readonly err: string[]
  readonly written: Map<string, string>
  readonly calls: AnalyzeOptions[]
}

type HarnessInput = {
  readonly result?: AnalyzeResult
  readonly reject?: Error
  readonly files?: Readonly<Record<string, string>>
  readonly version?: string
  readonly writeFile?: (absPath: string, content: string) => void
  readonly realWrites?: boolean
}

const harness = (input: HarnessInput = {}): Harness => {
  const out: string[] = []
  const err: string[] = []
  const written = new Map<string, string>()
  const calls: AnalyzeOptions[] = []

  return {
    out,
    err,
    written,
    calls,
    deps: {
      analyze: (options) => {
        calls.push(options)
        return input.reject === undefined ? Promise.resolve(input.result ?? resultOf()) : Promise.reject(input.reject)
      },
      host: createMemoryHost({ files: { ...PROJECT, ...(input.files ?? {}) } }),
      writer: { out: (line) => out.push(line), err: (line) => err.push(line) },
      ...(input.realWrites === true
        ? {}
        : {
            writeFile:
              input.writeFile ??
              ((absPath: string, content: string) => {
                written.set(absPath, content)
              }),
          }),
      tsconfig: () =>
        Promise.resolve({
          files: ["tsconfig.json"],
          baseUrl: ".",
          paths: {},
          include: ["src"],
          moduleResolution: null,
          jsx: null,
        }),
      cwd: ROOT,
      version: input.version ?? "0.1.0-test",
    },
  }
}

const sidecarOf = (text: string) => parseSidecar(text)

const recordedRun = (bench: Harness) => sidecarOf(bench.written.get(`${OUT}/${FINGERPRINT_FILE}`) ?? "")?.run ?? null

const recordedGraph = (bench: Harness) => sidecarOf(bench.written.get(`${OUT}/${FINGERPRINT_FILE}`) ?? "")?.graph ?? null

const withCache = (overrides: ResultOverrides = {}): AnalyzeResult =>
  resultOf({
    ...overrides,
    files: overrides.files ?? [
      { path: "appgraph.index.yaml", content: "meta: {}\n" },
      { path: GRAPH_CACHE_FILE, content: encodeGraphCache(emptyGraph()) },
    ],
  })

describe("runCli — writing", () => {
  it("writes every emitted file under --out and reports each size", async () => {
    const bench = harness({
      result: resultOf({
        files: [
          { path: "appgraph.yaml", content: "a".repeat(100) },
          { path: "appgraph.index.yaml", content: "b".repeat(10) },
        ],
      }),
    })

    const code = await runCli(["--root", ROOT, "--out", "docs/map"], bench.deps)

    expect(code).toBe(0)
    expect([...bench.written.keys()].sort()).toEqual([
      `/repo/docs/map/${FINGERPRINT_FILE}`,
      "/repo/docs/map/appgraph.index.yaml",
      "/repo/docs/map/appgraph.yaml",
    ])
    const printed = bench.out.join("\n")
    expect(printed).toContain("wrote 2 file(s) to docs/map")
    expect(printed).toContain("appgraph.yaml  100 B")
    expect(printed).toContain("appgraph.index.yaml  10 B")
  })

  it("writes nothing on an empty result and passes --allow-empty through to the config", async () => {
    const withoutFlag = harness({ result: resultOf({ files: [], emptyResult: true, trace: "appgraph found no screens." }) })
    await runCli(["--root", ROOT], withoutFlag.deps)
    expect(withoutFlag.written.size).toBe(0)
    expect(withoutFlag.calls[0]?.config?.allowEmpty).toBeUndefined()

    const withFlag = harness({
      result: resultOf({
        files: [{ path: "appgraph.yaml", content: "meta:\n  emptyResult: true\n" }],
        emptyResult: true,
        trace: "appgraph found no screens.",
      }),
    })
    await runCli(["--root", ROOT, "--allow-empty"], withFlag.deps)
    expect(withFlag.calls[0]?.config?.allowEmpty).toBe(true)
    expect(withFlag.written.has(`${OUT}/appgraph.yaml`)).toBe(true)
  })

  it("passes --screen, --depth, --format and --source into the analysis", async () => {
    const bench = harness()
    await runCli(
      ["--root", ROOT, "--format", "detail", "--screen", "/x", "--depth", "7", "--source", "next-app"],
      bench.deps,
    )

    const call = bench.calls[0]
    expect(call?.config?.formats).toEqual(["detail", "graph"])
    expect(call?.config?.depth).toBe(7)
    expect(call?.config?.screenSource).toBe("next-app")
    expect(call?.emitOptions).toMatchObject({ screen: "/x" })
  })

  it("refuses --screen beside a format it does not restrict, instead of running unrestricted", async () => {
    const bench = harness()
    const code = await runCli(
      ["--root", ROOT, "--format", "detail", "--format", "html", "--screen", "/x"],
      bench.deps,
    )

    expect(code).toBe(2)
    expect(bench.calls.length).toBe(0)
    expect(bench.err.join("\n")).toContain("--screen requires --format detail")
  })
})

describe("runCli — the startup compiler guard", () => {
  it("exits 5 with an actionable message and runs NO analysis on an unsupported compiler", async () => {
    const bench = harness()
    const code = await runCli(["--root", ROOT], {
      ...bench.deps,
      compiler: () => Promise.resolve({ kind: "unsupported", version: "7.0.2", missing: ["readJsonConfigFile"] }),
    })

    expect(code).toBe(5)
    expect(bench.calls.length).toBe(0)
    expect(bench.written.size).toBe(0)
    expect(bench.err.join("\n")).toContain("typescript@7.0.2")
    expect(bench.err.join("\n")).toContain(">=5.0.0 <7.0.0")
  })

  it("tells a pnpm user the peer was never installed, rather than a module-resolution stack", async () => {
    const bench = harness()
    const code = await runCli(["--root", ROOT], {
      ...bench.deps,
      compiler: () => Promise.resolve({ kind: "not-installed", detail: "Cannot find package 'typescript'" }),
    })

    expect(code).toBe(5)
    expect(bench.calls.length).toBe(0)
    expect(bench.err.join("\n")).toContain("do not auto-install peer dependencies")
    expect(bench.err.join("\n")).toContain('pnpm add -D "typescript@>=5.0.0 <7.0.0"')
  })

  it("runs normally on the compiler this repo is developed against", async () => {
    const bench = harness()
    expect(await runCli(["--root", ROOT], bench.deps)).toBe(0)
    expect(bench.calls.length).toBe(1)
  })
})

describe("runCli — exit codes", () => {
  it("0 on a clean run", async () => {
    const bench = harness()
    expect(await runCli(["--root", ROOT], bench.deps)).toBe(0)
  })

  it("1 on any error diagnostic, with the diagnostic on stderr", async () => {
    const bench = harness({ result: resultOf({ diagnostics: [diagnostic("error", "project/no-tsconfig")] }) })
    expect(await runCli(["--root", ROOT], bench.deps)).toBe(1)
    expect(bench.err.join("\n")).toContain("project/no-tsconfig  project/no-tsconfig happened  src/App.tsx:12")
  })

  it("2 on a usage error", async () => {
    const bench = harness()
    expect(await runCli(["--root", ROOT, "--format", "nope"], bench.deps)).toBe(2)
    expect(await runCli(["--format", "detail"], bench.deps)).toBe(2)
    expect(bench.calls).toHaveLength(0)
    expect(bench.err.join("\n")).toContain("--format detail requires --screen <id>")
  })

  it("3 when no screens were found, printing the whole trace", async () => {
    const trace = "appgraph found no screens.\n\n  root:         repo\n  globs attempted:\n    src/**/*.tsx -> 0 match(es)"
    const bench = harness({ result: resultOf({ files: [], emptyResult: true, trace }) })
    expect(await runCli(["--root", ROOT], bench.deps)).toBe(3)
    expect(bench.err.join("\n")).toContain("globs attempted")
  })

  it("4 under --strict when only warnings exist, 0 without --strict", async () => {
    const warned = () => harness({ result: resultOf({ diagnostics: [diagnostic("warning", "nav/dead-link")] }) })
    expect(await runCli(["--root", ROOT, "--strict"], warned().deps)).toBe(4)
    expect(await runCli(["--root", ROOT], warned().deps)).toBe(0)
  })

  it("1 beats 4: an error under --strict is still an error", async () => {
    const bench = harness({
      result: resultOf({ diagnostics: [diagnostic("warning", "nav/dead-link"), diagnostic("error", "emit/unwritable-output")] }),
    })
    expect(await runCli(["--root", ROOT, "--strict"], bench.deps)).toBe(1)
  })

  it("5 when the output dir cannot be written", async () => {
    const bench = harness({
      writeFile: () => {
        throw new Error("EACCES: permission denied")
      },
    })
    expect(await runCli(["--root", ROOT], bench.deps)).toBe(5)
    expect(bench.err.join("\n")).toContain("cannot write to")
  })

  it("5 when the analysis itself throws", async () => {
    const bench = harness({ reject: new Error("boom") })
    expect(await runCli(["--root", ROOT], bench.deps)).toBe(5)
    expect(bench.err.join("\n")).toContain("appgraph: boom")
  })
})

describe("runCli — output discipline", () => {
  it("--quiet prints errors only", async () => {
    const bench = harness({
      result: resultOf({ diagnostics: [diagnostic("warning", "nav/dead-link"), diagnostic("error", "plugin/threw")] }),
    })
    await runCli(["--root", ROOT, "--quiet"], bench.deps)

    expect(bench.out).toEqual([])
    const printed = bench.err.join("\n")
    expect(printed).toContain("plugin/threw")
    expect(printed).not.toContain("nav/dead-link")
    expect(printed).not.toContain("wrote 1 file(s)")
  })

  it("escapes terminal control characters in diagnostics, keeping newlines and tabs", () => {
    const line = formatDiagnostic({
      severity: "error",
      code: "x/\u001b[31mred",
      message: "title \u001b]0;pwned\u0007 del\u007f c1\u009b tab\tok",
      plugin: null,
      file: "src/\u001b[2Jx.ts",
    })
    expect([...line].filter((char) => char !== "\t" && (char < " " || (char >= "\u007f" && char <= "\u009f")))).toEqual([])
    expect(line).toContain("\\x1b]0;pwned\\x07")
    expect(line).toContain("\\x7f")
    expect(line).toContain("\\x9b")
    expect(line).toContain("tab\tok")
    expect(sanitizeForTerminal("a\nb")).toBe("a\nb")
  })

  it("--json puts one machine object on stdout and nothing human there", async () => {
    const bench = harness({
      result: resultOf({ diagnostics: [diagnostic("warning", "nav/dead-link")] }),
    })
    const code = await runCli(["--root", ROOT, "--json"], bench.deps)

    expect(code).toBe(0)
    expect(bench.out).toHaveLength(1)
    const payload: unknown = JSON.parse(bench.out[0] ?? "")
    expect(payload).toMatchObject({
      command: "analyze",
      root: ROOT,
      out: "docs/appgraph",
      skipped: false,
      emptyResult: false,
      exitCode: 0,
      wrote: [{ path: "appgraph.yaml" }],
    })
    expect(bench.err.join("\n")).toContain("nav/dead-link")
    expect(bench.err.some((line) => line.startsWith("appgraph /repo"))).toBe(true)
  })
})

describe("runCli — failures under --json and usage errors", () => {
  const jsonOf = (bench: Harness): unknown => {
    expect(bench.out).toHaveLength(1)
    return JSON.parse(bench.out[0] ?? "")
  }

  it("still prints one JSON object on stdout when the run fails with exit 5", async () => {
    const bench = harness({
      writeFile: () => {
        throw new Error("EACCES: permission denied")
      },
    })
    expect(await runCli(["--root", ROOT, "--json"], bench.deps)).toBe(5)
    expect(jsonOf(bench)).toMatchObject({
      command: "analyze",
      exitCode: 5,
      error: { code: "cli/write-failed", message: expect.stringContaining("cannot write to"), hint: expect.any(String) },
    })
  })

  it("still prints one JSON object on stdout on a usage error", async () => {
    const bench = harness()
    expect(await runCli(["doctor", "--json", "--nope"], bench.deps)).toBe(2)
    expect(jsonOf(bench)).toMatchObject({
      command: "doctor",
      exitCode: 2,
      error: { code: "cli/usage", message: expect.stringContaining("--nope"), hint: "run appgraph doctor --help" },
    })
  })

  it("prints a commander usage error exactly once", async () => {
    const bench = harness()
    expect(await runCli(["--nope"], bench.deps)).toBe(2)
    expect(bench.err.filter((line) => line.includes("--nope"))).toHaveLength(1)
  })

  it("rejects a non-existent --root as a usage error naming the directory", async () => {
    const bench = harness()
    expect(await runCli(["--root", "/nowhere", "--json"], bench.deps)).toBe(2)
    expect(bench.calls).toHaveLength(0)
    expect(bench.err.join("\n")).toContain("--root /nowhere is not a directory")
    expect(jsonOf(bench)).toMatchObject({ exitCode: 2, error: { code: "cli/root-not-found" } })
  })

  it("reports config/not-found for a --config that does not exist", async () => {
    const bench = harness()
    expect(await runCli(["--root", ROOT, "--config", "/nowhere/appgraph.config.ts", "--json"], bench.deps)).toBe(5)
    expect(bench.err.join("\n")).toContain("config/not-found")
    expect(jsonOf(bench)).toMatchObject({ exitCode: 5, error: { code: "config/not-found" }, diagnostics: [{ code: "config/not-found" }] })
  })
})

describe("runCli — writing to the real filesystem", () => {
  const created: string[] = []

  afterEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  const realBench = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "appgraph-cli-write-")))
    created.push(dir)
    const base = harness({ realWrites: true })
    const host = createMemoryHost({ files: { [`${dir}/package.json`]: "{}", [`${dir}/tsconfig.json`]: "{}" } })
    return { dir, base, deps: { ...base.deps, host, cwd: dir } }
  }

  it("writes every artifact and leaves no staging file behind", async () => {
    const { dir, deps } = realBench()
    expect(await runCli(["--root", dir], deps)).toBe(0)
    const out = path.join(dir, "docs/appgraph")
    expect(fs.readdirSync(out).sort()).toEqual([FINGERPRINT_FILE, "appgraph.yaml"])
    expect(fs.readFileSync(path.join(out, "appgraph.yaml"), "utf8")).toContain("schemaVersion")
  })

  it("refuses to write through a symlinked artifact and leaves its target untouched", async () => {
    const { dir, base, deps } = realBench()
    const victim = path.join(dir, "victim.txt")
    fs.writeFileSync(victim, "keep me", "utf8")
    fs.mkdirSync(path.join(dir, "docs/appgraph"), { recursive: true })
    fs.symlinkSync(victim, path.join(dir, "docs/appgraph/appgraph.yaml"))

    expect(await runCli(["--root", dir], deps)).toBe(5)
    expect(fs.readFileSync(victim, "utf8")).toBe("keep me")
    expect(base.err.join("\n")).toContain("symlink")
    expect(fs.readdirSync(path.join(dir, "docs/appgraph"))).toEqual(["appgraph.yaml"])
  })

  it("refuses a directory where an artifact belongs and leaves no staging file behind", async () => {
    const { dir, base, deps } = realBench()
    const out = path.join(dir, "docs/appgraph")
    fs.mkdirSync(path.join(out, "appgraph.yaml"), { recursive: true })

    expect(await runCli(["--root", dir], deps)).toBe(5)
    expect(base.err.join("\n")).toContain("is a directory")
    expect(fs.readdirSync(out)).toEqual(["appgraph.yaml"])
  })
})

describe("runCli — --if-stale", () => {
  const stale = async (files: Readonly<Record<string, string>>, version = "0.1.0-test") => {
    const bench = harness({ files, version })
    const code = await runCli(["--root", ROOT, "--if-stale"], bench.deps)
    return { bench, code }
  }

  it("records a fingerprint, then skips the next run when nothing changed", async () => {
    const first = await stale({})
    expect(first.code).toBe(0)
    expect(first.bench.calls).toHaveLength(1)

    const sidecar = first.bench.written.get(`/repo/docs/appgraph/${FINGERPRINT_FILE}`)
    expect(sidecar).toBeDefined()

    expect(sidecarOf(sidecar ?? "")?.run?.artifacts).toEqual(["appgraph.yaml"])

    const second = await stale({
      [`${ROOT}/docs/appgraph/${FINGERPRINT_FILE}`]: sidecar ?? "",
      [`${ROOT}/docs/appgraph/appgraph.yaml`]: "meta: {}\n",
    })
    expect(second.code).toBe(0)
    expect(second.bench.calls).toHaveLength(0)
    expect(second.bench.out.join("\n")).toContain("up to date")
  })

  it("does NOT skip when the analyzer's own version changed", async () => {
    const first = await stale({})
    const sidecar = first.bench.written.get(`/repo/docs/appgraph/${FINGERPRINT_FILE}`) ?? ""

    const upgraded = await stale({ [`${ROOT}/docs/appgraph/${FINGERPRINT_FILE}`]: sidecar }, "0.2.0-test")
    expect(upgraded.bench.calls).toHaveLength(1)
    expect(upgraded.bench.out.join("\n")).not.toContain("up to date")
  })

  it("records no fingerprint for a zero-screen run, so --if-stale cannot skip past the failure", async () => {
    const bench = harness({
      result: resultOf({
        files: [{ path: "appgraph.yaml", content: "meta:\n  emptyResult: true\n" }],
        emptyResult: true,
        trace: "appgraph found no screens.",
      }),
    })
    expect(await runCli(["--root", ROOT, "--if-stale", "--allow-empty"], bench.deps)).toBe(3)
    expect(recordedRun(bench)).toBeNull()
  })

  it("does NOT skip when an artifact the recorded run wrote has since been deleted", async () => {
    const first = await stale({})
    const sidecar = first.bench.written.get(`/repo/docs/appgraph/${FINGERPRINT_FILE}`) ?? ""

    const again = await stale({ [`${ROOT}/docs/appgraph/${FINGERPRINT_FILE}`]: sidecar })
    expect(again.bench.calls).toHaveLength(1)
    expect(again.bench.out.join("\n")).not.toContain("up to date")
  })

  it("records no fingerprint for a run with an error diagnostic or a --strict warning", async () => {
    const errored = harness({ result: resultOf({ diagnostics: [diagnostic("error", "project/no-tsconfig")] }) })
    expect(await runCli(["--root", ROOT, "--if-stale"], errored.deps)).toBe(1)
    expect(recordedRun(errored)).toBeNull()

    const warned = harness({ result: resultOf({ diagnostics: [diagnostic("warning", "nav/dead-link")] }) })
    expect(await runCli(["--root", ROOT, "--if-stale", "--strict"], warned.deps)).toBe(4)
    expect(recordedRun(warned)).toBeNull()
  })

  it("does NOT skip when a source file changed", async () => {
    const first = await stale({})
    const sidecar = first.bench.written.get(`/repo/docs/appgraph/${FINGERPRINT_FILE}`) ?? ""

    const edited = await stale({
      [`${ROOT}/docs/appgraph/${FINGERPRINT_FILE}`]: sidecar,
      [`${ROOT}/src/New.tsx`]: "export const New = () => null",
    })
    expect(edited.bench.calls).toHaveLength(1)
  })
})

describe("runCli — --timing (P0)", () => {
  const tickingClock = () => {
    const state = { now: 0 }
    return () => {
      state.now += 2
      return state.now
    }
  }

  const timedDeps = (bench: Harness): CliDeps => ({
    ...bench.deps,
    clock: tickingClock(),
    analyze: (options) => {
      for (const phase of PIPELINE_PHASES) options.onPhase?.(phase, 3)
      return Promise.resolve(resultOf())
    },
  })

  it("adds no timing to the JSON or stderr by default, and passes no phase listener", async () => {
    const bench = harness()
    expect(await runCli(["--root", ROOT, "--json"], bench.deps)).toBe(0)

    expect(JSON.parse(bench.out[0] ?? "")).not.toHaveProperty("timing")
    expect(bench.err).not.toContain("appgraph: timing")
    expect(bench.calls[0]).not.toHaveProperty("onPhase")
  })

  it("reports every phase with the injected clock under --timing --json", async () => {
    const bench = harness()
    expect(await runCli(["--root", ROOT, "--json", "--timing"], timedDeps(bench))).toBe(0)

    expect(JSON.parse(bench.out[0] ?? "")).toMatchObject({
      timing: {
        probe: 2,
        fingerprint: 2,
        ...Object.fromEntries(PIPELINE_PHASES.map((phase) => [phase, 3])),
        write: 2,
      },
    })
    expect(JSON.parse(bench.out[0] ?? "")).toHaveProperty("timing.total")
    expect(bench.err).toContain("appgraph: timing")
    expect(bench.err.some((line) => /^ {2}fingerprint\s+2\.0 ms$/.test(line))).toBe(true)
  })

  it("prints timing on stderr without --json, leaving stdout to the summary", async () => {
    const bench = harness()
    expect(await runCli(["--root", ROOT, "--timing"], timedDeps(bench))).toBe(0)

    expect(bench.err).toContain("appgraph: timing")
    expect(bench.out.join("\n")).not.toContain("appgraph: timing")
  })

  it("carries timing into the --if-stale skip JSON", async () => {
    const first = harness()
    await runCli(["--root", ROOT, "--if-stale"], first.deps)
    const sidecar = first.written.get(`/repo/docs/appgraph/${FINGERPRINT_FILE}`) ?? ""

    const second = harness({ files: { [`${ROOT}/docs/appgraph/${FINGERPRINT_FILE}`]: sidecar, [`${ROOT}/docs/appgraph/appgraph.yaml`]: "x" } })
    expect(await runCli(["--root", ROOT, "--if-stale", "--json", "--timing"], timedDeps(second))).toBe(0)
    expect(JSON.parse(second.out[0] ?? "")).toMatchObject({ skipped: true, timing: { fingerprint: 2 } })
  })
})

describe("runCli — the graph cache and sidecar v2 (C1, C3)", () => {
  it("writes the cache and records both sidecar parts on a clean run", async () => {
    const bench = harness({ result: withCache() })
    expect(await runCli(["--root", ROOT], bench.deps)).toBe(0)

    expect(bench.written.has(`${OUT}/${GRAPH_CACHE_FILE}`)).toBe(true)
    expect(recordedRun(bench)).toMatchObject({ exitCode: 0, counts: { screens: 1 }, artifacts: ["appgraph.index.yaml", GRAPH_CACHE_FILE] })
    expect(recordedGraph(bench)).toMatchObject({
      options: { source: null, depth: null, allSources: false, allowEmpty: false },
      tsconfigFiles: ["tsconfig.json"],
      configFile: null,
    })
    expect([...bench.written.keys()].at(-1)).toBe(`${OUT}/${FINGERPRINT_FILE}`)
  })

  it("keeps the cache on exit 1, 4 and 3 under --allow-empty, but records no run", async () => {
    const cases = [
      { argv: [], result: withCache({ diagnostics: [diagnostic("error", "project/no-tsconfig")] }), code: 1 },
      { argv: ["--strict"], result: withCache({ diagnostics: [diagnostic("warning", "nav/dead-link")] }), code: 4 },
      { argv: ["--allow-empty"], result: withCache({ emptyResult: true, trace: "appgraph found no screens." }), code: 3 },
    ]
    for (const entry of cases) {
      const bench = harness({ result: entry.result })
      expect(await runCli(["--root", ROOT, ...entry.argv], bench.deps)).toBe(entry.code)
      expect(bench.written.has(`${OUT}/${GRAPH_CACHE_FILE}`)).toBe(true)
      expect(recordedGraph(bench)).not.toBeNull()
      expect(recordedRun(bench)).toBeNull()
    }
  })

  it("writes nothing at all on a refusal", async () => {
    const bench = harness({ result: withCache({ files: [], refused: true, diagnostics: [diagnostic("error", "project/multiple-screen-sources")] }) })
    expect(await runCli(["--root", ROOT], bench.deps)).toBe(1)
    expect(bench.written.size).toBe(0)
  })

  it("drops the cache on a caller mistake (exit 2) and keeps the recorded graph", async () => {
    const previous = { schemaVersion: 2, run: null, graph: { fingerprint: "old", options: { source: null, depth: null, allSources: false, allowEmpty: false }, tsconfigFiles: [], configFile: null } }
    const bench = harness({
      files: { [`${OUT}/${FINGERPRINT_FILE}`]: JSON.stringify(previous) },
      result: withCache({ diagnostics: [diagnostic("error", "emit/unknown-screen")] }),
    })
    expect(await runCli(["--root", ROOT, "--format", "detail", "--screen", "/x"], bench.deps)).toBe(2)
    expect(bench.written.has(`${OUT}/${GRAPH_CACHE_FILE}`)).toBe(false)
    expect(recordedGraph(bench)?.fingerprint).toBe("old")
  })

  it("lets a plain run satisfy a later --if-stale with the same options", async () => {
    const first = harness()
    expect(await runCli(["--root", ROOT], first.deps)).toBe(0)
    const sidecar = first.written.get(`${OUT}/${FINGERPRINT_FILE}`) ?? ""

    const second = harness({ files: { [`${OUT}/${FINGERPRINT_FILE}`]: sidecar, [`${OUT}/appgraph.yaml`]: "x" } })
    expect(await runCli(["--root", ROOT, "--if-stale"], second.deps)).toBe(0)
    expect(second.calls).toHaveLength(0)
  })

  it("re-runs --if-stale after --format or --locale changed, while the graph fingerprint stays", async () => {
    const first = harness()
    await runCli(["--root", ROOT, "--format", "index"], first.deps)
    const sidecar = first.written.get(`${OUT}/${FINGERPRINT_FILE}`) ?? ""

    const changed = harness({ files: { [`${OUT}/${FINGERPRINT_FILE}`]: sidecar, [`${OUT}/appgraph.yaml`]: "x" } })
    expect(await runCli(["--root", ROOT, "--if-stale", "--format", "index", "--locale", "pl"], changed.deps)).toBe(0)
    expect(changed.calls).toHaveLength(1)
    expect(recordedGraph(changed)?.fingerprint).toBe(sidecarOf(sidecar)?.graph?.fingerprint)
    expect(recordedRun(changed)?.fingerprint).not.toBe(sidecarOf(sidecar)?.run?.fingerprint)
  })

  it("treats a v1 text sidecar as stale", async () => {
    const bench = harness({ files: { [`${OUT}/${FINGERPRINT_FILE}`]: "abc\nappgraph.yaml\n", [`${OUT}/appgraph.yaml`]: "x" } })
    expect(await runCli(["--root", ROOT, "--if-stale"], bench.deps)).toBe(0)
    expect(bench.calls).toHaveLength(1)
  })

  it("gives the --if-stale skip JSON the run's keys, from the recorded run, without probing the compiler", async () => {
    const first = harness()
    await runCli(["--root", ROOT, "--if-stale"], first.deps)
    const sidecar = first.written.get(`${OUT}/${FINGERPRINT_FILE}`) ?? ""

    const probes: string[] = []
    const second = harness({ files: { [`${OUT}/${FINGERPRINT_FILE}`]: sidecar, [`${OUT}/appgraph.yaml`]: "x" } })
    const code = await runCli(["--root", ROOT, "--if-stale", "--json"], {
      ...second.deps,
      compiler: () => {
        probes.push("probe")
        return Promise.resolve({ kind: "supported", version: "6.0.3" })
      },
    })

    expect(code).toBe(0)
    expect(probes).toEqual([])
    const skipped: unknown = JSON.parse(second.out[0] ?? "")
    expect(skipped).toMatchObject({ skipped: true, counts: { screens: 1 }, emptyResult: false, refused: false, wrote: [], exitCode: 0 })
    const ran = harness()
    await runCli(["--root", ROOT, "--json"], ran.deps)
    const keysOf = (value: unknown) => Object.keys(Object(value)).sort()
    expect(keysOf(skipped)).toEqual(keysOf(JSON.parse(ran.out[0] ?? "")))
  })
})
