import { beforeAll, describe, expect, it } from "vitest"
import type { AppGraph } from "../../src/core/model.js"
import { FINDING_SECTIONS } from "../../src/emit/report-derive.js"
import { GLOSSARY } from "../../src/emit/glossary.js"
import { buildFixtureGraph } from "../../e2e/fixture-graph.js"
import type { CatalogRun } from "./catalog-harness.js"
import { catalogBench, itemsOf, jsonOf } from "./catalog-harness.js"

type Query = (argv: readonly string[]) => Promise<CatalogRun>

const fixture = buildFixtureGraph()

let query: Query

beforeAll(async () => {
  query = await catalogBench(fixture)
})

const valuesOf = (rows: readonly Record<string, unknown>[], key: string) => rows.map((row) => row[key])

const errorOf = (run: CatalogRun) => jsonOf(run)["error"] as { readonly code: string; readonly hint: string }

describe("components", () => {
  it("prints the components table sorted by renders, with a next-page footer", async () => {
    const run = await query(["components", "--limit", "2"])
    expect(run.code).toBe(0)
    expect(run.out).toEqual([
      "component     kind    file                             route  renders  endpoints  mutations  stores",
      "Component000  shared  src/components/Component000.tsx  -      2        0          0          -",
      "Component003  ui      src/components/Component003.tsx  -      2        0          0          -",
      "1-2 of 700 — next: appgraph components --limit 2 --offset 2",
    ])
  })

  it("filters by kind and sorts by file", async () => {
    const rows = itemsOf(await query(["components", "--kind", "shared", "--sort", "file", "--json", "--limit", "1000"]))
    expect(rows).toHaveLength(70)
    expect(new Set(valuesOf(rows, "kind"))).toEqual(new Set(["shared"]))
    const files = valuesOf(rows, "file")
    expect(files).toEqual([...files].sort())
  })

  it("matches every search word against component, file, kind and route", async () => {
    const rows = itemsOf(await query(["components", "--search", "component01 shared", "--json"]))
    expect(valuesOf(rows, "component")).toEqual(["Component010"])
  })

  it("rejects an unknown kind with suggestions before printing", async () => {
    const run = await query(["components", "--kind", "shard", "--json"])
    expect(run.code).toBe(2)
    expect(errorOf(run)).toMatchObject({ code: "usage/unknown-kind", hint: "did you mean: shared" })
  })

  it("projects --fields", async () => {
    const rows = itemsOf(await query(["components", "--fields", "component,renders", "--json", "--limit", "1"]))
    expect(rows).toEqual([{ component: "Component000", renders: 2 }])
  })
})

describe("menu", () => {
  it("marks entries the router does not know in text and as missing in JSON", async () => {
    const text = await query(["menu", "--missing"])
    expect(text.out).toEqual([
      "group      label    labelKey  path                      featureFlag  parentPath  linkedScreen",
      "Main menu  Link 20  -         /app/missing-from-router  -            -           (missing from router)",
    ])
    expect(itemsOf(await query(["menu", "--missing", "--json"]))).toMatchObject([
      { group: "Main menu", path: "/app/missing-from-router", linkedScreen: null, missing: true },
    ])
  })

  it("filters by group and by search words", async () => {
    expect(itemsOf(await query(["menu", "--group", "Admin menu", "--json"]))).toHaveLength(5)
    expect(valuesOf(itemsOf(await query(["menu", "--search", "link 3", "--json"])), "label")).toEqual(["Link 3", "Link 30", "Link 31", "Link 32", "Link 33", "Link 34"])
  })

  it("rejects an unknown group with suggestions", async () => {
    const run = await query(["menu", "--group", "Main", "--json"])
    expect(run.code).toBe(2)
    expect(errorOf(run)).toMatchObject({ code: "usage/unknown-group", hint: "did you mean: Main menu" })
  })
})

describe("findings", () => {
  it("lists every section in report order with section and severity counts", async () => {
    const body = jsonOf(await query(["findings", "--json", "--limit", "1000"]))
    const sections = valuesOf(body["items"] as readonly Record<string, unknown>[], "section")
    expect([...new Set(sections)]).toEqual([...FINDING_SECTIONS])
    expect(body).toMatchObject({
      sections: { limitations: 3, "dead-links": 2, orphans: 4, confidence: 4, diagnostics: 4 },
      severityCounts: { all: 4, error: 1, warning: 2, info: 1 },
    })
  })

  it("narrows to diagnostics by severity or code", async () => {
    expect(valuesOf(itemsOf(await query(["findings", "--severity", "warning", "--json"])), "code")).toEqual(["W_DYNAMIC", "W_UNUSED"])
    expect(itemsOf(await query(["findings", "--code", "E_PARSE", "--json"]))).toMatchObject([
      { section: "diagnostics", severity: "error", file: "src/routes.tsx", line: 12 },
    ])
  })

  it("picks one section and labels orphans with their primary label", async () => {
    const rows = itemsOf(await query(["findings", "--section", "orphans", "--json"]))
    expect(rows[0]).toEqual({ section: "orphans", id: "screen-admin-01", label: "/admin/page-01/:id" })
  })

  it("rejects diagnostic filters on another section", async () => {
    const run = await query(["findings", "--section", "orphans", "--severity", "error", "--json"])
    expect(run.code).toBe(2)
    expect(errorOf(run).code).toBe("usage/invalid-combination")
  })

  it("prints one titled table per section in text", async () => {
    const run = await query(["findings", "--section", "dead-links"])
    expect(run.out).toEqual([
      "dead-links (2)",
      "  path       label    source      file        line",
      "  /gone/one  Link 90  nav-config  src/nav.ts  95",
      "  /gone/two  Link 91  nav-config  src/nav.ts  96",
    ])
  })
})

describe("stats", () => {
  it("returns the header counts in stat order plus severities and the empty-result fields", async () => {
    const body = jsonOf(await query(["stats", "--json"]))
    const item = body["item"] as Record<string, unknown>
    expect(Object.keys(item)).toEqual([
      "appName",
      "appgraphVersion",
      "screens",
      "components",
      "endpoints",
      "deadLinks",
      "apiRoutes",
      "redirects",
      "renderEdges",
      "navEdges",
      "maxDepth",
      "errors",
      "warnings",
      "infos",
      "emptyResult",
      "emptyReason",
    ])
    expect(item).toMatchObject({ appName: "fixture-shop", screens: 57, apiRoutes: 3, errors: 1, warnings: 2, infos: 1, emptyResult: false })
    expect(body["cache"]).toMatchObject({ status: "fresh" })
  })

  it("hides zero API routes in text only and prints the cache line", async () => {
    const pages: AppGraph = { ...fixture, screens: fixture.screens.filter((screen) => screen.kindTag !== "apiRoute") }
    const pagesQuery = await catalogBench(pages)
    const text = await pagesQuery(["stats"])
    expect(text.out.some((line) => line.startsWith("apiRoutes:"))).toBe(false)
    expect(text.out).toContain("cache: fresh docs/appgraph/appgraph.graph.json")
    expect(jsonOf(await pagesQuery(["stats", "--json"]))["item"]).toMatchObject({ apiRoutes: 0 })
  })

  it("reports an empty result with its reason", async () => {
    const empty: AppGraph = { ...fixture, meta: { ...fixture.meta, emptyResult: true, emptyReason: "no route files matched" } }
    const run = await (await catalogBench(empty))(["stats", "--json"])
    expect(jsonOf(run)).toMatchObject({ emptyResult: true, item: { emptyResult: true, emptyReason: "no route files matched" } })
    expect(run.err).toContain("appgraph: the graph has no screens (empty result): no route files matched")
  })
})

describe("usages", () => {
  const usage = async (argv: readonly string[]) => jsonOf(await query(["usages", ...argv, "--json", "--limit", "1000"]))

  it.each([
    ["src/components/Component010.tsx", "component"],
    ["Component010", "component"],
    ["GET /api/s00/res0", "endpoint"],
    ["/api/s00/res1", "endpoint"],
    ["screen-3-root", "testid"],
    ["useCartStore", "store"],
    ["screen-5", "query-key"],
  ])("detects %s as a %s", async (term, type) => {
    const body = await usage([term])
    expect(body["item"]).toMatchObject({ term, type, detected: true })
    expect(body["total"]).toBeGreaterThan(0)
  })

  it("lists screens first, then the components that render the file", async () => {
    const items = (await usage(["src/components/Component010.tsx"]))["items"]
    expect(items).toEqual([
      { kind: "screen", id: "screen-root-01", url: "/page-01/:id", type: "component", via: "tree", match: "src/components/Component010.tsx" },
      { kind: "screen", id: "screen-admin-04", url: "/admin/page-04", type: "component", via: "reachable", match: "src/components/Component010.tsx" },
      { kind: "component", id: "src/components/Component009.tsx", url: null, type: "component", via: "renders", match: "src/components/Component010.tsx" },
    ])
  })

  it("resolves a bare url to every method on it", async () => {
    const body = await usage(["/api/s00/res1"])
    expect(body["item"]).toMatchObject({ matched: ["POST /api/s00/res1"] })
  })

  it("matches an endpoint whose url carries a query string by its path alone", async () => {
    const [first, ...rest] = fixture.screens
    const endpoint = { method: "GET", url: "/api/domains?workspaceId=:param", transport: "http", client: "swr" } as const
    const withQuery: AppGraph = {
      ...fixture,
      screens: [{ ...first!, facts: { ...first!.facts, endpoints: [...first!.facts.endpoints, endpoint] } }, ...rest],
    }
    const bench = await catalogBench(withQuery)

    expect(jsonOf(await bench(["usages", "/api/domains", "--json"]))).toMatchObject({
      item: { type: "endpoint", matched: ["GET /api/domains?workspaceId=:param"] },
      items: [{ id: first!.id, via: "facts" }],
    })
    expect(jsonOf(await bench(["usages", "GET /api/domains", "--json"]))).toMatchObject({ items: [{ id: first!.id }] })
  })

  it("finds i18n namespaces", async () => {
    const [first, ...rest] = fixture.screens
    const withI18n: AppGraph = { ...fixture, screens: [{ ...first!, facts: { ...first!.facts, i18nNamespaces: ["checkout"] } }, ...rest] }
    const run = await (await catalogBench(withI18n))(["usages", "checkout", "--json"])
    expect(jsonOf(run)).toMatchObject({ item: { type: "i18n" }, items: [{ id: first!.id, via: "facts" }] })
  })

  it("honours --type over detection", async () => {
    const run = await query(["usages", "useCartStore", "--type", "testid", "--json"])
    expect(jsonOf(run)).toMatchObject({ item: { type: "testid", detected: false }, total: 0 })
    expect(run.err[0]).toContain("nothing in the graph uses 'useCartStore'")
  })

  it("answers an unknown term with an empty list, a notice and suggestions", async () => {
    const run = await query(["usages", "useCartStor", "--json"])
    expect(run.code).toBe(0)
    expect(jsonOf(run)).toMatchObject({ total: 0, items: [], item: { type: null, suggestions: ["useCartStore"] } })
    expect(run.err).toEqual(["appgraph: nothing in the graph uses 'useCartStor'; did you mean: useCartStore"])

    const text = await query(["usages", "src/components/Nope.tsx"])
    expect(text.out).toEqual(["(no matches)"])
  })
})

describe("glossary", () => {
  it("lists every term without loading the graph", async () => {
    const run = await query(["glossary", "--json"])
    expect(run.analyses).toBe(0)
    const body = jsonOf(run)
    expect(body).not.toHaveProperty("cache")
    expect(valuesOf(body["items"] as readonly Record<string, unknown>[], "id")).toEqual(GLOSSARY.map((entry) => entry.id))
  })

  it("explains one term by id or by its label", async () => {
    const byId = await query(["glossary", "shell"])
    expect(byId.out[0]).toBe("id: shell")
    expect(byId.out[1]).toBe("term: Shell (layout)")
    expect(jsonOf(await query(["glossary", "shell (LAYOUT)", "--json"]))["item"]).toMatchObject({ id: "shell" })
  })

  it("rejects an unknown term with suggestions", async () => {
    const run = await query(["glossary", "shel", "--json"])
    expect(run.code).toBe(2)
    expect(errorOf(run)).toMatchObject({ code: "usage/unknown-term", hint: "did you mean: shell" })
  })
})
