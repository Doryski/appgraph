import { beforeAll, describe, expect, it } from "vitest"
import type { AppGraph, ShellReport } from "../../src/core/model.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { AnalyzeResult } from "../../src/pipeline/run.js"
import { EMPTY_DETECTION_TRACE } from "../../src/pipeline/run.js"
import { runCli } from "../../src/cli/index.js"
import type { CliDeps } from "../../src/cli/index.js"
import { GRAPH_CACHE_FILE, encodeGraphCache } from "../../src/emit/graph-cache.js"
import { edgesTouching, layoutGraph } from "../../src/emit/html-graph.js"
import { PALETTE_GROUP_LIMIT, matchesQuery, normalizeQuery } from "../../src/emit/report-derive.js"
import { buildReportPayload } from "../../src/emit/report-payload.js"
import {
  API_SCREEN_IDS,
  DEV_ONLY_SCREEN_ID,
  FEATURE_FLAG_NAME,
  FEATURE_FLAG_SCREEN_ID,
  REDIRECT_SCREEN_ID,
  STATE_SCREEN_ID,
  buildFixtureGraph,
} from "../../e2e/fixture-graph.js"

const ROOT = "/repo"

const VERSION = "0.1.0-test"

const PROJECT = {
  [`${ROOT}/package.json`]: JSON.stringify({ name: "fixture" }),
  [`${ROOT}/tsconfig.json`]: JSON.stringify({ compilerOptions: { baseUrl: "." } }),
  [`${ROOT}/src/App.tsx`]: "export const App = () => null",
}

const leafNode = (component: string, children: ShellReport["tree"] = []): ShellReport["tree"][number] => ({
  file: `src/shell/${component}.tsx`,
  component,
  kind: "layout",
  conditions: [],
  alwaysRendered: true,
  repeated: false,
  nullGuards: [],
  children,
  truncated: false,
  repeat: false,
})

const SHELL: ShellReport = {
  file: "src/shell/AppShell.tsx",
  layouts: ["src/shell/AppShell.tsx"],
  tree: [leafNode("AppShell", [leafNode("Sidebar", [leafNode("SidebarItem")])])],
  navigatesTo: [],
  endpoints: [],
  stores: ["useShellStore"],
  i18nNamespaces: [],
  testIds: [],
}

const fixtureGraph = (): AppGraph => {
  const graph = buildFixtureGraph()
  return { ...graph, meta: { ...graph.meta, appgraphVersion: VERSION }, shells: { AppShell: SHELL } }
}

const GRAPH = fixtureGraph()

const PAYLOAD = buildReportPayload(GRAPH, { locale: "en", generatedAt: null })

const resultOf = (graph: AppGraph): AnalyzeResult => ({
  graph,
  files: [{ path: GRAPH_CACHE_FILE, content: encodeGraphCache(graph) }],
  diagnostics: [],
  emptyResult: false,
  refused: false,
  exitCode: 0,
  trace: "",
  detection: EMPTY_DETECTION_TRACE,
})

type Bench = {
  readonly code: number
  readonly out: readonly string[]
  readonly err: readonly string[]
  readonly analysed: number
  readonly files: Readonly<Record<string, string>>
}

const run = async (argv: readonly string[], seeded: Readonly<Record<string, string>> = {}): Promise<Bench> => {
  const out: string[] = []
  const err: string[] = []
  const written = new Map<string, string>()
  let analysed = 0
  const deps: CliDeps = {
    analyze: () => {
      analysed += 1
      return Promise.resolve(resultOf(GRAPH))
    },
    host: createMemoryHost({ files: { ...PROJECT, ...seeded } }),
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
  return { code, out, err, analysed, files: { ...seeded, ...Object.fromEntries(written) } }
}

type Json = Record<string, unknown>

const jsonOf = (bench: Bench): Json => JSON.parse(bench.out.join("\n")) as Json

const itemsOf = <T = Json>(bench: Bench): readonly T[] => jsonOf(bench)["items"] as readonly T[]

const idsOf = (bench: Bench): readonly string[] => itemsOf<{ id: string }>(bench).map((item) => item.id)

let cache: Readonly<Record<string, string>> = {}

const query = (argv: readonly string[]) => run([...argv, "--root", ROOT, "--cached"], cache)

const json = async (argv: readonly string[]) => query([...argv, "--json", "--limit", "1000"])

beforeAll(async () => {
  const seed = await run(["screens", "--root", ROOT, "--json"])
  expect(seed.code).toBe(0)
  cache = seed.files
})

describe("screens", () => {
  it("lists every screen in the report's order, API routes last", async () => {
    const bench = await json(["screens"])
    expect(bench.code).toBe(0)
    expect(idsOf(bench)).toEqual(PAYLOAD.screens.map((screen) => screen.id))
    expect(idsOf(bench).slice(-API_SCREEN_IDS.length)).toEqual([...API_SCREEN_IDS])
  })

  it("matches the report's labels and badges", async () => {
    const items = itemsOf<{ id: string; primaryLabel: string; badges: readonly string[] }>(await json(["screens"]))
    const byId = new Map(items.map((item) => [item.id, item]))
    for (const screen of PAYLOAD.screens) expect(byId.get(screen.id)?.primaryLabel).toBe(screen.primaryLabel)
    expect(byId.get(REDIRECT_SCREEN_ID)?.badges).toContain("redirect:/app/page-00")
    expect(byId.get(FEATURE_FLAG_SCREEN_ID)?.badges).toContain(`flag:${FEATURE_FLAG_NAME}`)
    expect(byId.get(DEV_ONLY_SCREEN_ID)?.badges).toContain("devOnly")
    expect(byId.get(STATE_SCREEN_ID)?.badges).toContain("unaddressable")
  })

  it("searches like the report's screen list", async () => {
    const normalized = normalizeQuery("  Admin/PAGE-0 ")
    const expected = PAYLOAD.screens.filter((screen) => matchesQuery(screen, normalized)).map((screen) => screen.id)
    expect(expected.length).toBeGreaterThan(0)
    expect(idsOf(await json(["screens", "--search", "  Admin/PAGE-0 "]))).toEqual(expected)
  })

  it.each([
    [["--auth", "public"], PAYLOAD.screens.filter((screen) => screen.auth === "public")],
    [["--api"], PAYLOAD.screens.filter((screen) => screen.isApi)],
    [["--no-api"], PAYLOAD.screens.filter((screen) => !screen.isApi)],
    [["--flag"], PAYLOAD.screens.filter((screen) => screen.featureFlag !== null)],
    [["--flag", FEATURE_FLAG_NAME], PAYLOAD.screens.filter((screen) => screen.featureFlag === FEATURE_FLAG_NAME)],
    [["--flag", "nope"], []],
    [["--kind", "apiRoute"], PAYLOAD.screens.filter((screen) => screen.kindTag === "apiRoute")],
    [["--from", "react-router"], PAYLOAD.screens],
  ])("filters with %j", async (flags, expected) => {
    expect(idsOf(await json(["screens", ...flags]))).toEqual(expected.map((screen) => screen.id))
  })

  it.each([
    [["--from", "next-app"], "usage/unknown-source", "valid screen sources: react-router"],
    [["--kind", "nope"], "usage/unknown-kind", "valid screen kinds:"],
  ])("rejects an unknown filter value %j with exit 2 and the valid values", async (flags, code, hint) => {
    const bench = await query(["screens", ...flags, "--json"])
    expect(bench.code).toBe(2)
    const error = jsonOf(bench)["error"] as { code: string; hint: string }
    expect(error.code).toBe(code)
    expect(error.hint).toContain(hint)
  })

  it("combines filters", async () => {
    const bench = await json(["screens", "--no-api", "--auth", "protected", "--search", "/settings"])
    const expected = PAYLOAD.screens.filter(
      (screen) => !screen.isApi && screen.auth === "protected" && matchesQuery(screen, "/settings"),
    )
    expect(idsOf(bench)).toEqual(expected.map((screen) => screen.id))
  })

  it("prints the default columns and a next-page footer", async () => {
    const bench = await query(["screens", "--limit", "2"])
    expect(bench.out[0]).toMatch(/^id\s+url\s+title\s+auth\s+badges$/)
    expect(bench.out[1]).toMatch(/^screen-root-00\s+\/\s+Screen screen-root-00\s+protected\s+shell:AppShell$/)
    expect(bench.out.at(-1)).toBe(`1-2 of ${String(PAYLOAD.screens.length)} — next: appgraph screens --limit 2 --offset 2`)
  })

  it("projects --fields in the JSON envelope", async () => {
    const bench = await query(["screens", "--json", "--fields", "id,isApi", "--limit", "1"])
    expect(jsonOf(bench)).toMatchObject({
      schemaVersion: 2,
      command: "screens",
      total: PAYLOAD.screens.length,
      truncated: true,
      cache: { status: "fresh" },
      items: [{ id: "screen-root-00", isApi: false }],
    })
  })
})

describe("screen", () => {
  type Item = Json & { readonly id: string }

  const itemOf = (bench: Bench): Item => jsonOf(bench)["item"] as Item

  it("resolves an id, an exact url and a concrete path the route matches", async () => {
    expect(itemOf(await json(["screen", "screen-admin-02"])).id).toBe("screen-admin-02")
    expect(itemOf(await json(["screen", "/admin/page-02"])).id).toBe("screen-admin-02")
    expect(itemOf(await json(["screen", "/admin/page-01/42"])).id).toBe("screen-admin-01")
  })

  it("fails an unknown screen with exit 2 and the nearest ids", async () => {
    const bench = await query(["screen", "screen-admin-0", "--json"])
    expect(bench.code).toBe(2)
    const error = jsonOf(bench)["error"] as { code: string; message: string; hint: string }
    expect(error.code).toBe("emit/unknown-screen")
    expect(error.message).toBe("unknown screen 'screen-admin-0'")
    expect(error.hint).toMatch(/^did you mean: screen-admin-00, /)
  })

  it("prints the header, the redirect target, the html link and every non-empty section", async () => {
    const item = itemOf(await json(["screen", REDIRECT_SCREEN_ID]))
    expect(item).toMatchObject({
      id: REDIRECT_SCREEN_ID,
      url: "/legacy",
      redirectTo: "/app/page-00",
      redirectTarget: "screen-app-00",
      badges: expect.arrayContaining(["redirect:/app/page-00", "shell:AppShell"]) as unknown,
      htmlLink: `appgraph.html#tab=screens&screen=${REDIRECT_SCREEN_ID}`,
      shell: { id: "AppShell", file: "src/shell/AppShell.tsx", stores: ["useShellStore"] },
    })
    expect(Object.keys(item)).toEqual(
      expect.arrayContaining(["activations", "entries", "tree", "navigation", "endpoints", "query-keys", "test-ids", "reachable"]),
    )
    expect(item).not.toHaveProperty("mutations")
    expect(item).not.toHaveProperty("forms")
  })

  it("groups outgoing navigation like the report's nav chips", async () => {
    const item = itemOf(await json(["screen", "screen-app-03", "--sections", "navigation"]))
    const payload = PAYLOAD.screens.find((screen) => screen.id === "screen-app-03")
    expect((item["navigation"] as readonly Json[]).map((chip) => [chip["to"], chip["dynamic"], chip["sources"]])).toEqual(
      payload?.navChips.map((chip) => [chip.to, chip.dynamic, chip.sources]),
    )
  })

  it("keeps only the requested sections", async () => {
    const item = itemOf(await json(["screen", "screen-app-01", "--sections", "endpoints,params"]))
    expect(item).toHaveProperty("endpoints")
    expect(item).toHaveProperty("params")
    expect(item).not.toHaveProperty("tree")
    expect(item["shell"]).toBe("AppShell")
  })

  it("rejects an unknown section with exit 2 before analysing", async () => {
    const bench = await run(["screen", "screen-app-01", "--root", ROOT, "--json", "--sections", "tree,bogus"])
    expect(bench.code).toBe(2)
    expect(bench.analysed).toBe(0)
    expect(jsonOf(bench)).toMatchObject({ error: { code: "usage/unknown-section" } })
  })

  it("cuts the printed render tree at --tree-depth", async () => {
    const item = itemOf(await json(["screen", "screen-app-01", "--sections", "tree,shell", "--tree-depth", "1"]))
    const tree = item["tree"] as readonly Json[]
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ component: "Screen25", truncated: true })
    expect(tree[0]).not.toHaveProperty("children")
    expect((item["shell"] as Json)["tree"]).toEqual([expect.not.objectContaining({ children: expect.anything() as unknown })])
  })

  it("prints YAML-like text", async () => {
    const bench = await query(["screen", "screen-app-01", "--sections", "params"])
    expect(bench.out.slice(0, 3)).toEqual(["id: screen-app-01", "url: /app/page-01/:id", "title: Screen screen-app-01"])
    expect(bench.out).toContain("params:")
  })
})

describe("links", () => {
  type Link = { direction: string; id: string; url: string; weight: number; dynamic: boolean; triggers: readonly string[] }

  const MAP = layoutGraph(GRAPH)

  const mapLinks = (url: string) =>
    edgesTouching(MAP.edges, url).map((edge) => ({
      direction: edge.from === url ? "out" : "in",
      url: edge.from === url ? edge.to : edge.from,
      weight: edge.weight,
      dynamic: edge.dynamic,
    }))

  it("lists the map's collapsed edges of the screen with in/out degree", async () => {
    const bench = await json(["links", "/app/page-00"])
    const items = itemsOf<Link>(bench)
    const expected = mapLinks("/app/page-00")
    const pick = (link: { direction: string; url: string; weight: number; dynamic: boolean }) => [link.direction, link.url, link.weight, link.dynamic]
    expect(items.map(pick).sort()).toEqual(expected.map(pick).sort())
    expect(items.map((link) => link.direction)).toEqual([...items.map((link) => link.direction)].sort().reverse())
    const outDegree = expected.filter((link) => link.direction === "out").length
    expect(jsonOf(bench)["item"]).toMatchObject({
      id: "screen-app-00",
      url: "/app/page-00",
      inDegree: expected.length - outDegree,
      outDegree,
      excluded: null,
    })
    expect(items.every((link) => link.triggers.length > 0)).toBe(true)
  })

  it("keeps one direction with --incoming or --outgoing", async () => {
    const incoming = itemsOf<Link>(await json(["links", "/app/page-00", "--incoming"]))
    const outgoing = itemsOf<Link>(await json(["links", "/app/page-00", "--outgoing"]))
    expect(incoming.length).toBeGreaterThan(0)
    expect(outgoing.length).toBeGreaterThan(0)
    expect(incoming.every((link) => link.direction === "in")).toBe(true)
    expect(outgoing.every((link) => link.direction === "out")).toBe(true)
  })

  it("never links to an API route or an unaddressable screen", async () => {
    const urls = itemsOf<Link>(await json(["links", "/"])).map((link) => link.url)
    expect(urls.some((url) => url.startsWith("/api/"))).toBe(false)
  })

  it.each([
    [API_SCREEN_IDS[0], "api-route", "it is an API route"],
    [STATE_SCREEN_ID, "no-url", "it has no url"],
  ])("explains why %s is not on the map", async (id, excluded, reason) => {
    const bench = await json(["links", id])
    expect(itemsOf(bench)).toEqual([])
    expect(jsonOf(bench)["item"]).toMatchObject({ id, inDegree: 0, outDegree: 0, excluded })
    expect(bench.err).toEqual([`appgraph: ${id} is not on the map because ${reason}, so it has no links`])
  })

  it("prints a degree summary above the table", async () => {
    const bench = await query(["links", "/app/page-00"])
    expect(bench.out[0]).toMatch(/^screen-app-00 \(\/app\/page-00\): in \d+, out \d+$/)
    expect(bench.out[1]).toMatch(/^direction\s+id\s+url\s+weight\s+dynamic\s+triggers$/)
  })
})

describe("search", () => {
  type Hit = { kind: string; id: string; label: string; detail: string | null }

  const search = async (argv: readonly string[]) => query(["search", ...argv, "--json"])

  it("caps each group at the palette limit and reports the totals", async () => {
    const bench = await search(["component"])
    const body = jsonOf(bench)
    const hits = itemsOf<Hit>(bench)
    expect(hits.filter((hit) => hit.kind === "component")).toHaveLength(PALETTE_GROUP_LIMIT)
    expect(body).toMatchObject({
      total: PAYLOAD.components.length,
      truncated: true,
      groups: [
        { kind: "screen", total: 0, shown: 0, truncated: false },
        { kind: "component", total: PAYLOAD.components.length, shown: PALETTE_GROUP_LIMIT, truncated: true },
        { kind: "menu", total: 0, shown: 0, truncated: false },
      ],
    })
  })

  it("matches every word across screens, components and menu entries in group order", async () => {
    const hits = itemsOf<Hit>(await search(["page-00 app", "--limit", "500"]))
    expect([...new Set(hits.map((hit) => hit.kind))]).toEqual(["screen", "component", "menu"].filter((kind) => hits.some((hit) => hit.kind === kind)))
    expect(hits.find((hit) => hit.kind === "screen")).toEqual({ kind: "screen", id: "screen-app-00", label: "/app/page-00", detail: "Screen screen-app-00" })
    expect(hits.find((hit) => hit.kind === "menu")).toEqual({ kind: "menu", id: "/app/page-00", label: "Link 0", detail: "Main menu" })
  })

  it("applies --limit per group", async () => {
    const hits = itemsOf<Hit>(await search(["e", "--limit", "3"]))
    expect(hits.map((hit) => hit.kind)).toEqual(["screen", "screen", "screen", "component", "component", "component", "menu", "menu", "menu"])
  })

  it("prints rows and one more-line per capped group", async () => {
    const bench = await query(["search", "page", "--limit", "2"])
    expect(bench.out[0]).toMatch(/^kind\s+label\s+detail\s+id$/)
    expect(bench.out.filter((line) => line.startsWith("… "))).toEqual([
      `… ${String(PAYLOAD.screens.filter((screen) => screen.primaryLabel.includes("page")).length - 2)} more screen matches (use --offset/--limit)`,
      `… ${String(PAYLOAD.navGroups.flatMap((group) => group.entries).filter((entry) => entry.path.includes("page")).length - 2)} more menu matches (use --offset/--limit)`,
    ])
  })

  it("says so when nothing matches", async () => {
    expect((await query(["search", "zzz-nothing"])).out).toEqual(["(no matches)"])
  })
})
