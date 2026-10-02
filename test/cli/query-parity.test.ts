import { beforeAll, describe, expect, it } from "vitest"
import type { AppGraph } from "../../src/core/model.js"
import { flattenNavGroups } from "../../src/emit/report-derive.js"
import { buildReportPayload } from "../../src/emit/report-payload.js"
import type { ReportPayload } from "../../src/emit/report-payload.js"
import { buildFixtureGraph } from "../../e2e/fixture-graph.js"
import { buildLargeFixtureGraph } from "../../e2e/fixture-graph-large.js"
import type { CatalogRun } from "./catalog-harness.js"
import { catalogBench, itemsOf, jsonOf } from "./catalog-harness.js"

const ALL = ["--json", "--limit", "100000"] as const

const pick = <K extends string>(rows: readonly Record<string, unknown>[], keys: readonly K[]) =>
  rows.map((row) => Object.fromEntries(keys.map((key) => [key, row[key]])))

const FIXTURES = [
  { name: "fixture graph", build: buildFixtureGraph },
  { name: "large fixture graph", build: buildLargeFixtureGraph },
] as const

describe.each(FIXTURES)("CLI ↔ report payload parity on the $name", ({ build }) => {
  let graph: AppGraph
  let payload: ReportPayload
  let query: (argv: readonly string[]) => Promise<CatalogRun>

  beforeAll(async () => {
    graph = build()
    payload = buildReportPayload(graph, { locale: "en", generatedAt: null })
    query = await catalogBench(graph)
  })

  const listed = async (argv: readonly string[]) => {
    const run = await query([...argv, ...ALL])
    expect(run.code).toBe(0)
    expect(run.analyses).toBe(0)
    expect(jsonOf(run)).toMatchObject({ truncated: false, cache: { status: "fresh" } })
    return itemsOf(run)
  }

  it("components match payload.components in order and key fields", async () => {
    const keys = ["file", "component", "kind", "route", "renders", "endpoints", "mutations", "stores"] as const
    expect(pick(await listed(["components"]), keys)).toEqual(pick(payload.components, keys))
  })

  it("menu matches the flattened payload.navGroups", async () => {
    const keys = ["group", "path", "label", "labelKey", "featureFlag", "parentPath", "linkedScreen"] as const
    const rows = await listed(["menu"])
    expect(pick(rows, keys)).toEqual(pick(flattenNavGroups(payload.navGroups), keys))
    expect(rows.map((row) => row["missing"])).toEqual(flattenNavGroups(payload.navGroups).map((row) => row.linkedScreen === null))
  })

  it("dead links match payload.deadNavLinks", async () => {
    const keys = ["path", "label", "source", "file", "line"] as const
    expect(pick(await listed(["findings", "--section", "dead-links"]), keys)).toEqual(pick(payload.deadNavLinks, keys))
  })

  it("orphans match payload.orphanScreens with the screens' primary labels", async () => {
    const labels = new Map(payload.screens.map((screen) => [screen.id, screen.primaryLabel]))
    expect(await listed(["findings", "--section", "orphans"])).toEqual(
      payload.orphanScreens.map((id) => ({ section: "orphans", id, label: labels.get(id) ?? id })),
    )
  })

  it("confidence matches payload.confidence including level and status", async () => {
    const rows = await listed(["findings", "--section", "confidence"])
    expect(rows.map((row) => row["id"])).toEqual(payload.confidence.map((row) => row.section))
    const keys = ["count", "enablingDependency", "dependencyInstalled", "level", "status"] as const
    expect(pick(rows, keys)).toEqual(pick(payload.confidence, keys))
  })

  it("diagnostics match payload.diagnostics in severity order", async () => {
    const keys = ["severity", "code", "message", "plugin", "file", "line", "screenId"] as const
    expect(pick(await listed(["findings", "--section", "diagnostics"]), keys)).toEqual(pick(payload.diagnostics, keys))
  })

  it("limitations match payload.meta.limitations", async () => {
    expect((await listed(["findings", "--section", "limitations"])).map((row) => row["message"])).toEqual(payload.meta.limitations)
  })

  it("stats counts match payload.meta", async () => {
    const run = await query(["stats", "--json"])
    const item = jsonOf(run)["item"]
    expect(item).toMatchObject({
      ...payload.meta.counts,
      appName: payload.meta.appName,
      appgraphVersion: payload.meta.appgraphVersion,
      maxDepth: payload.meta.maxDepth,
      emptyResult: payload.meta.emptyResult,
      emptyReason: payload.meta.emptyReason,
    })
  })
})
