import { describe, expect, it, vi } from "vitest"
import type { AppGraph, Diagnostic, Screen, ScreenFacts } from "../../src/core/model.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { AnalyzeInternalOptions, AnalyzeResult } from "../../src/pipeline/run.js"
import { EMPTY_DETECTION_TRACE } from "../../src/pipeline/run.js"
import { runCli } from "../../src/cli/index.js"
import type { CliDeps } from "../../src/cli/index.js"
import { FINGERPRINT_FILE, parseSidecar } from "../../src/cli/stale.js"
import { GRAPH_CACHE_FILE, encodeGraphCache } from "../../src/emit/graph-cache.js"
import { commandSpec } from "../../src/cli/commands.js"
import {
  emptyResultNotice,
  formatTable,
  nearestMatches,
  paginate,
  projectFields,
  selectedFields,
  unknownTargetError,
} from "../../src/cli/query/output.js"

vi.mock("../../src/cli/query/stats.js", async () => {
  const { loadGraph } = await import("../../src/cli/query/runtime.js")
  const { writeItem } = await import("../../src/cli/query/output.js")
  const { EXIT_OK } = await import("../../src/pipeline/exit-codes.js")
  return {
    default: async (context: Parameters<typeof loadGraph>[0]) => {
      const loaded = await loadGraph(context)
      writeItem(context, {
        loaded,
        item: { appName: loaded.graph.meta.appName ?? null, screens: loaded.graph.screens.length, maxDepth: loaded.graph.meta.maxDepth },
      })
      return EXIT_OK
    },
  }
})

vi.mock("../../src/cli/query/screens.js", async () => {
  const { loadGraph } = await import("../../src/cli/query/runtime.js")
  const { writeList } = await import("../../src/cli/query/output.js")
  const { EXIT_OK } = await import("../../src/pipeline/exit-codes.js")
  return {
    default: async (context: Parameters<typeof loadGraph>[0]) => {
      const loaded = await loadGraph(context)
      writeList(context, {
        loaded,
        items: loaded.graph.screens.map((screen) => ({ id: screen.id, url: screen.url, title: screen.title, devOnly: screen.devOnly })),
        columns: ["id", "url", "title"],
      })
      return EXIT_OK
    },
  }
})

const ROOT = "/repo"

const OUT = `${ROOT}/docs/appgraph`

const CACHE = `${OUT}/${GRAPH_CACHE_FILE}`

const SIDECAR = `${OUT}/${FINGERPRINT_FILE}`

const VERSION = "0.1.0-test"

const PROJECT = {
  [`${ROOT}/package.json`]: JSON.stringify({ name: "fixture" }),
  [`${ROOT}/tsconfig.json`]: JSON.stringify({ compilerOptions: { baseUrl: "." } }),
  [`${ROOT}/src/App.tsx`]: "export const App = () => null",
}

const facts = (): ScreenFacts => ({
  endpoints: [],
  navigations: [],
  stores: [],
  queryKeys: [],
  mutations: 0,
  i18nNamespaces: [],
  testIds: [],
  formSchemas: [],
  formFields: [],
  featureGates: [],
  hooks: [],
  messages: [],
  extra: {},
})

const screen = (index: number): Screen => ({
  id: `/page-${String(index)}`,
  localId: `src/pages/page-${String(index)}.tsx`,
  source: "react-router",
  activations: [{ kind: "url", template: `/page-${String(index)}`, params: [] }],
  url: `/page-${String(index)}`,
  params: [],
  title: index === 0 ? "Home page" : null,
  kindTag: null,
  entries: [],
  ancestors: [],
  shell: null,
  auth: "protected",
  featureFlag: null,
  redirectTo: null,
  devOnly: false,
  addressable: true,
  tree: [],
  reachable: [],
  facts: facts(),
  navigatesTo: [],
  provenance: { sources: ["react-router"], evidence: [], mergedFrom: [], decisions: [] },
})

type GraphInput = {
  readonly screens?: number
  readonly version?: string
  readonly empty?: boolean
}

const graphOf = (input: GraphInput = {}): AppGraph => ({
  meta: {
    schemaVersion: 2,
    appgraphVersion: input.version ?? VERSION,
    root: "repo",
    appName: "fixture",
    sourceRoots: ["src"],
    screenSources: ["react-router"],
    maxDepth: 3,
    fingerprint: "",
    counts: { screens: input.screens ?? 2 },
    confidence: [],
    limitations: [],
    ...(input.empty === true ? { emptyResult: true as const, emptyReason: "no route files matched" } : {}),
  },
  screens: Array.from({ length: input.screens ?? 2 }, (_, index) => screen(index)),
  redirects: [],
  shells: {},
  components: {},
  navGroups: [],
  navigation: [],
  deadNavLinks: [],
  orphanScreens: [],
  diagnostics: [],
})

type ResultInput = {
  readonly graph?: AppGraph
  readonly withCache?: boolean
  readonly refused?: boolean
  readonly emptyResult?: boolean
  readonly trace?: string
  readonly diagnostics?: readonly Diagnostic[]
}

const resultOf = (input: ResultInput = {}): AnalyzeResult => {
  const graph = input.graph ?? graphOf()
  return {
    graph,
    files: input.withCache === false ? [] : [{ path: GRAPH_CACHE_FILE, content: encodeGraphCache(graph) }],
    diagnostics: input.diagnostics ?? [],
    emptyResult: input.emptyResult ?? false,
    refused: input.refused ?? false,
    exitCode: 0,
    trace: input.trace ?? "",
    detection: EMPTY_DETECTION_TRACE,
  }
}

type Bench = {
  readonly code: number
  readonly out: readonly string[]
  readonly err: readonly string[]
  readonly written: ReadonlyMap<string, string>
  readonly calls: readonly AnalyzeInternalOptions[]
  readonly files: Readonly<Record<string, string>>
}

type BenchInput = {
  readonly files?: Readonly<Record<string, string>>
  readonly result?: AnalyzeResult
  readonly reject?: Error
}

const run = async (argv: readonly string[], input: BenchInput = {}): Promise<Bench> => {
  const out: string[] = []
  const err: string[] = []
  const written = new Map<string, string>()
  const calls: AnalyzeInternalOptions[] = []
  const files = { ...PROJECT, ...(input.files ?? {}) }
  const deps: CliDeps = {
    analyze: (options) => {
      calls.push(options)
      return input.reject === undefined ? Promise.resolve(input.result ?? resultOf()) : Promise.reject(input.reject)
    },
    host: createMemoryHost({ files }),
    writer: { out: (line) => out.push(line), err: (line) => err.push(line) },
    writeFile: (absPath, content) => {
      written.set(absPath, content)
    },
    compiler: () => Promise.resolve({ kind: "supported", version: "6.0.3" }),
    tsconfig: () =>
      Promise.resolve({ files: ["tsconfig.json"], baseUrl: ".", paths: {}, include: ["src"], moduleResolution: null, jsx: null }),
    cwd: ROOT,
    version: VERSION,
  }
  const code = await runCli(argv, deps)
  return { code, out, err, written, calls, files: { ...(input.files ?? {}), ...Object.fromEntries(written) } }
}

const jsonOf = (bench: Bench): Record<string, unknown> => JSON.parse(bench.out.join("\n")) as Record<string, unknown>

const built = (argv: readonly string[] = []) => run(["stats", "--root", ROOT, "--json", ...argv])

describe("loadGraph — cache states", () => {
  it("builds a missing cache with only the graph format, writing the cache then the sidecar", async () => {
    const bench = await built()

    expect(bench.code).toBe(0)
    expect(bench.calls).toHaveLength(1)
    expect(bench.calls[0]?.config?.formats).toEqual(["graph"])
    expect(bench.calls[0]?.timestamp).toBeNull()
    expect([...bench.written.keys()]).toEqual([CACHE, SIDECAR])
    expect(parseSidecar(bench.written.get(SIDECAR) ?? "")).toMatchObject({ run: null, graph: { tsconfigFiles: ["tsconfig.json"] } })
    expect(jsonOf(bench)).toMatchObject({
      schemaVersion: 2,
      command: "stats",
      cache: { status: "built", path: `docs/appgraph/${GRAPH_CACHE_FILE}` },
      item: { appName: "fixture", screens: 2 },
    })
    expect(bench.err).toEqual([])
  })

  it("answers a fresh cache without analysing, from the cache on disk", async () => {
    const first = await built()
    const fresh = await run(["stats", "--root", ROOT, "--json"], { files: first.files, result: resultOf({ graph: graphOf({ screens: 9 }) }) })

    expect(fresh.code).toBe(0)
    expect(fresh.calls).toHaveLength(0)
    expect(fresh.written.size).toBe(0)
    expect(jsonOf(fresh)).toMatchObject({ cache: { status: "fresh" }, item: { screens: 2 } })
    expect((jsonOf(fresh)["cache"] as { fingerprint: string }).fingerprint).toBe(parseSidecar(first.files[SIDECAR] ?? "")?.graph?.fingerprint)
  })

  it("refreshes a stale cache, keeps the sidecar run part and prints a progress line in text mode", async () => {
    const first = await built()
    const recordedRun = { fingerprint: "run-fp", artifacts: ["appgraph.index.yaml"], exitCode: 0, counts: { screens: 2 } }
    const sidecar = JSON.stringify({ ...JSON.parse(first.files[SIDECAR] ?? "{}"), run: recordedRun })
    const stale = await run(["stats", "--root", ROOT], {
      files: { ...first.files, [SIDECAR]: sidecar, [`${ROOT}/src/New.tsx`]: "export const New = 1" },
      result: resultOf({ graph: graphOf({ screens: 3 }) }),
    })

    expect(stale.code).toBe(0)
    expect(stale.calls).toHaveLength(1)
    expect(stale.err).toEqual([`appgraph: analysing ${ROOT} (cache stale)`])
    expect(stale.out).toContain("screens: 3")
    expect(parseSidecar(stale.written.get(SIDECAR) ?? "")?.run).toEqual(recordedRun)
  })

  it("rebuilds a corrupt cache and refreshes an incompatible one", async () => {
    const first = await built()
    const corrupt = await run(["stats", "--root", ROOT, "--json"], { files: { ...first.files, [CACHE]: "{nope" } })
    expect(jsonOf(corrupt)).toMatchObject({ cache: { status: "built" } })

    const foreign = encodeGraphCache(graphOf({ version: "9.9.9" }))
    const incompatible = await run(["stats", "--root", ROOT, "--json"], { files: { ...first.files, [CACHE]: foreign } })
    expect(jsonOf(incompatible)).toMatchObject({ cache: { status: "refreshed" } })
    expect(incompatible.calls).toHaveLength(1)
  })

  it("stays silent under --quiet", async () => {
    const bench = await run(["stats", "--root", ROOT, "--quiet"])
    expect(bench.err).toEqual([])
  })
})

describe("loadGraph — --cached", () => {
  const cachedFailure = async (files: Readonly<Record<string, string>>) => {
    const bench = await run(["stats", "--root", ROOT, "--cached", "--json"], { files })
    expect(bench.code).toBe(6)
    expect(bench.calls).toHaveLength(0)
    expect(bench.written.size).toBe(0)
    expect(bench.out).toHaveLength(1)
    return jsonOf(bench)
  }

  it("exits 6 with cache/missing when there is no cache", async () => {
    expect(await cachedFailure({})).toEqual({
      command: "stats",
      exitCode: 6,
      error: {
        code: "cache/missing",
        message: `graph cache unavailable (cache missing): no graph cache at docs/appgraph/${GRAPH_CACHE_FILE}`,
        hint: "drop --cached to analyse now, or run appgraph to rebuild the graph cache",
      },
      diagnostics: [],
    })
  })

  it("exits 6 with cache/stale, cache/corrupt and cache/incompatible", async () => {
    const first = await built()
    const stale = await cachedFailure({ ...first.files, [`${ROOT}/src/New.tsx`]: "x" })
    expect(stale).toMatchObject({ error: { code: "cache/stale" } })
    expect(await cachedFailure({ ...first.files, [CACHE]: "{nope" })).toMatchObject({ error: { code: "cache/corrupt" } })
    const foreign = encodeGraphCache(graphOf({ version: "9.9.9" }))
    expect(await cachedFailure({ ...first.files, [CACHE]: foreign })).toMatchObject({ error: { code: "cache/incompatible" } })
  })

  it("answers a fresh cache", async () => {
    const first = await built()
    const bench = await run(["stats", "--root", ROOT, "--cached", "--json"], { files: first.files })
    expect(bench.code).toBe(0)
    expect(jsonOf(bench)).toMatchObject({ cache: { status: "fresh" } })
  })
})

describe("loadGraph — sticky graph options", () => {
  it("records explicit flags, reuses them when omitted and lets new flags override", async () => {
    const first = await built(["--depth", "7", "--source", "next-app", "--all-sources"])
    expect(first.calls[0]?.config).toMatchObject({ depth: 7, screenSource: "next-app" })
    expect(first.calls[0]?.allSources).toBe(true)
    expect(parseSidecar(first.files[SIDECAR] ?? "")?.graph?.options).toEqual({ source: "next-app", depth: 7, allSources: true, allowEmpty: false })

    const reused = await run(["stats", "--root", ROOT, "--json"], { files: first.files })
    expect(reused.calls).toHaveLength(0)

    const overridden = await run(["stats", "--root", ROOT, "--json", "--depth", "2"], { files: first.files })
    expect(overridden.calls).toHaveLength(1)
    expect(overridden.calls[0]?.config).toMatchObject({ depth: 2, screenSource: "next-app" })
    expect(parseSidecar(overridden.written.get(SIDECAR) ?? "")?.graph?.options).toEqual({ source: "next-app", depth: 2, allSources: true, allowEmpty: false })
  })
})

describe("loadGraph — analysis failures pass through", () => {
  it("exits 1 on a refusal with a --source hint and writes nothing", async () => {
    const refusal: Diagnostic = { severity: "error", code: "project/multiple-screen-sources", message: "two live sources", plugin: null }
    const bench = await run(["stats", "--root", ROOT, "--json"], {
      result: resultOf({ withCache: false, refused: true, diagnostics: [refusal], trace: "appgraph refused." }),
    })
    expect(bench.code).toBe(1)
    expect(bench.written.size).toBe(0)
    expect(bench.err).toContain("appgraph refused.")
    expect(jsonOf(bench)).toMatchObject({
      exitCode: 1,
      error: { code: "analysis/refused", hint: expect.stringContaining("--source <name>") as unknown },
      diagnostics: [refusal],
    })
  })

  it("exits 3 with the trace on zero screens", async () => {
    const bench = await run(["stats", "--root", ROOT, "--json"], {
      result: resultOf({ withCache: false, emptyResult: true, graph: graphOf({ screens: 0, empty: true }), trace: "appgraph found no screens." }),
    })
    expect(bench.code).toBe(3)
    expect(bench.err).toContain("appgraph found no screens.")
    expect(jsonOf(bench)).toMatchObject({ error: { code: "analysis/no-screens" } })
  })

  it("exits 5 when the analysis itself fails", async () => {
    const bench = await run(["stats", "--root", ROOT, "--json"], { reject: new Error("boom") })
    expect(bench.code).toBe(5)
    expect(jsonOf(bench)).toMatchObject({ exitCode: 5, error: { message: "boom" } })
  })

  it("answers an empty-result cache with the notice and the envelope flag", async () => {
    const empty = graphOf({ screens: 0, empty: true })
    const bench = await run(["stats", "--root", ROOT, "--json"], { result: resultOf({ graph: empty, emptyResult: true }) })
    expect(bench.code).toBe(0)
    expect(jsonOf(bench)).toMatchObject({ emptyResult: true, emptyReason: "no route files matched" })
    expect(bench.err).toContain("appgraph: the graph has no screens (empty result): no route files matched")
  })
})

describe("query output — lists", () => {
  const sevenScreens = { result: resultOf({ graph: graphOf({ screens: 7 }) }) }

  it("pages a list and reports total, truncated and nextOffset", async () => {
    const bench = await run(["screens", "--root", ROOT, "--json", "--limit", "3"], sevenScreens)
    const body = jsonOf(bench)
    expect(body).toMatchObject({ schemaVersion: 2, command: "screens", total: 7, offset: 0, limit: 3, truncated: true, nextOffset: 3 })
    expect((body["items"] as readonly unknown[]).map((item) => (item as { id: string }).id)).toEqual(["/page-0", "/page-1", "/page-2"])

    const last = await run(["screens", "--root", ROOT, "--json", "--limit", "3", "--offset", "6"], sevenScreens)
    expect(jsonOf(last)).toMatchObject({ total: 7, offset: 6, truncated: false })
    expect(jsonOf(last)).not.toHaveProperty("nextOffset")
  })

  it("prints aligned columns and a footer naming the next page with the same filters", async () => {
    const bench = await run(["screens", "--root", ROOT, "--limit", "2", "--search", "page one"], sevenScreens)
    expect(bench.out).toEqual([
      "id       url      title",
      "/page-0  /page-0  Home page",
      "/page-1  /page-1  -",
      "1-2 of 7 — next: appgraph screens --search 'page one' --limit 2 --offset 2",
    ])
  })

  it("projects --fields in JSON and as the text columns", async () => {
    const json = await run(["screens", "--root", ROOT, "--json", "--fields", "url,devOnly"], sevenScreens)
    expect((jsonOf(json)["items"] as readonly unknown[])[0]).toEqual({ url: "/page-0", devOnly: false })

    const text = await run(["screens", "--root", ROOT, "--fields", "url", "--limit", "1"], sevenScreens)
    expect(text.out.slice(0, 2)).toEqual(["url", "/page-0"])
  })

  it("rejects an unknown --fields entry with exit 2 before analysing", async () => {
    const bench = await run(["screens", "--root", ROOT, "--json", "--fields", "id,bogus"], sevenScreens)
    expect(bench.code).toBe(2)
    expect(bench.calls).toHaveLength(0)
    const body = jsonOf(bench) as { error: { code: string; hint: string } }
    expect(body.error.code).toBe("usage/unknown-field")
    expect(body.error.hint).toContain("valid fields: id, url, title")
  })

  it("prints byte-identical single-line JSON across runs", async () => {
    const first = await run(["screens", "--root", ROOT, "--json"], sevenScreens)
    const second = await run(["screens", "--root", ROOT, "--json"], { files: first.files })
    const third = await run(["screens", "--root", ROOT, "--json"], { files: first.files })
    expect(second.out).toHaveLength(1)
    expect(second.out).toEqual(third.out)
  })
})

describe("query output — helpers", () => {
  it("paginates past the end without a next page", () => {
    expect(paginate([1, 2], { limit: 5, offset: 4 })).toEqual({ total: 2, offset: 4, limit: 5, truncated: false, nextOffset: null, items: [] })
  })

  it("validates and projects fields in the requested order", () => {
    const spec = commandSpec("screens")
    expect(selectedFields(spec, null)).toBeNull()
    expect(() => selectedFields(spec, ["nope"])).toThrow("unknown field for screens: nope")
    expect(projectFields({ id: "a", url: "/a", title: null }, ["url", "id"])).toEqual({ url: "/a", id: "a" })
  })

  it("aligns columns, renders empty cells as - and lists as comma-joined values", () => {
    expect(formatTable([{ a: "x", b: ["p", "q"] }, { a: "longer", b: [] }], ["a", "b"])).toEqual(["a       b", "x       p,q", "longer  -"])
  })

  it("explains an empty result only when the graph has one", () => {
    expect(emptyResultNotice(graphOf())).toBeNull()
    expect(emptyResultNotice(graphOf({ screens: 0, empty: true }))).toContain("no route files matched")
  })

  it("suggests the nearest ids: exact, prefix, substring, then by edit distance", () => {
    const ids = ["/invoices", "/invoices/:id", "/settings", "/users", "/user", "/admin/invoices"]
    expect(nearestMatches(ids, "/invoice")).toEqual(["/invoices", "/invoices/:id", "/admin/invoices"])
    expect(nearestMatches(ids, "/usrs")).toEqual(["/users", "/user"])
    expect(nearestMatches(ids, "/zzzzzzzzzz")).toEqual([])
    expect(nearestMatches(ids, "/", 2)).toEqual(["/user", "/users"])
  })

  it("builds an unknown-screen usage error with suggestions", () => {
    const error = unknownTargetError({ kind: "screen", target: "/invoice", candidates: ["/invoices"] })
    expect(error).toMatchObject({ exitCode: 2, code: "emit/unknown-screen", hint: "did you mean: /invoices" })
  })
})
