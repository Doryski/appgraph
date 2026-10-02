import { beforeAll, describe, expect, it } from "vitest"
import type { AppGraph, ShellReport } from "../../src/core/model.js"
import { COMMAND_NAMES, REGISTERED_COMMANDS } from "../../src/cli/commands.js"
import { runCli } from "../../src/cli/index.js"
import { API_SCREEN_IDS, DEEP_LINK_SCREEN_ID, buildFixtureGraph } from "../../e2e/fixture-graph.js"
import type { CatalogRun } from "./catalog-harness.js"
import { catalogBench, jsonOf } from "./catalog-harness.js"
import { validate } from "./schema-validator.js"

type Schema = Readonly<Record<string, unknown>>

type Query = (argv: readonly string[]) => Promise<CatalogRun>

const shellNode = (component: string): ShellReport["tree"][number] => ({
  file: `src/shell/${component}.tsx`,
  component,
  kind: "layout",
  conditions: [],
  alwaysRendered: true,
  repeated: false,
  nullGuards: [],
  children: [],
  truncated: false,
  repeat: false,
})

const SHELL: ShellReport = {
  file: "src/shell/AppShell.tsx",
  layouts: ["src/shell/AppShell.tsx"],
  tree: [shellNode("AppShell")],
  navigatesTo: [],
  endpoints: [],
  stores: ["useShellStore"],
  i18nNamespaces: ["shell"],
  testIds: ["shell-root"],
}

const withShell = (graph: AppGraph): AppGraph => ({ ...graph, shells: { AppShell: SHELL } })

const GRAPH = withShell(buildFixtureGraph())

const EMPTY_GRAPH: AppGraph = { ...GRAPH, meta: { ...GRAPH.meta, emptyResult: true, emptyReason: "fixture says so" } }

const ALL = ["--limit", "100000"] as const

const QUERY_RUNS: readonly (readonly string[])[] = [
  ["screens", ...ALL],
  ["screens", "--limit", "2"],
  ["screens", "--api"],
  ["links", DEEP_LINK_SCREEN_ID, ...ALL],
  ["links", API_SCREEN_IDS[0]],
  ["search", "page", ...ALL],
  ["search", "component", "--limit", "1"],
  ["components", ...ALL],
  ["menu", ...ALL],
  ["findings", ...ALL],
  ["findings", "--severity", "warning"],
  ["findings", "--section", "confidence"],
  ["stats"],
  ["usages", "src/components/Component000.tsx", ...ALL],
  ["usages", "Component000", ...ALL],
  ["usages", "useShellStore", ...ALL],
  ["usages", "nothing-here"],
  ["glossary", ...ALL],
  ["glossary", "shell"],
  ["screen", DEEP_LINK_SCREEN_ID, "--sections", "shell"],
  ["screen", DEEP_LINK_SCREEN_ID, "--tree-depth", "1"],
]

const commandOf = (argv: readonly string[]): string => argv[0] ?? ""

const runSchema = async (argv: readonly string[]) => {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(["schema", ...argv], { writer: { out: (line) => out.push(line), err: (line) => err.push(line) } })
  return { code, out, err, json: JSON.parse(out.join("\n")) as Schema }
}

const isRecord = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value)

const objectSchemas = (schema: unknown): readonly Schema[] => {
  if (Array.isArray(schema)) return schema.flatMap(objectSchemas)
  if (!isRecord(schema)) return []
  const own = isRecord(schema["properties"]) ? [schema] : []
  return [...own, ...Object.values(schema).flatMap(objectSchemas)]
}

let query: Query

let document: Schema

const definitionOf = (name: string): Schema => {
  const defs = document["$defs"]
  const found = isRecord(defs) ? defs[name] : undefined
  if (!isRecord(found)) throw new Error(`no schema for ${name}`)
  return found
}

const expectValid = (name: string, value: unknown): void => {
  expect(validate(definitionOf(name), value)).toEqual([])
}

beforeAll(async () => {
  query = await catalogBench(GRAPH)
  document = (await runSchema(["--json"])).json
})

describe("appgraph schema", () => {
  it("keys every command's schema, plus the error object, by name", () => {
    expect(document["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema")
    expect(Object.keys(document["$defs"] ?? {})).toEqual([...COMMAND_NAMES, "error"])
  })

  it("prints one command's schema on its own", async () => {
    const run = await runSchema(["screens", "--json"])
    expect(run.code).toBe(0)
    expect(run.json).toEqual({ $schema: document["$schema"], ...definitionOf("screens") })
  })

  it("pretty-prints without --json", async () => {
    const run = await runSchema(["stats"])
    expect(run.out.length).toBeGreaterThan(1)
    expect(run.json).toEqual({ $schema: document["$schema"], ...definitionOf("stats") })
  })

  it("rejects an unknown command with suggestions and exit 2", async () => {
    const out: string[] = []
    const code = await runCli(["schema", "scren", "--json"], { writer: { out: (line) => out.push(line), err: () => undefined } })
    const failure = JSON.parse(out.join("\n")) as unknown
    expect(code).toBe(2)
    expectValid("error", failure)
    expect(failure).toMatchObject({ exitCode: 2, error: { code: "usage/unknown-command" } })
    expect(JSON.stringify(failure)).toContain("screens")
  })

  it("forbids undeclared keys on every object it describes", () => {
    const schemas = objectSchemas(document["$defs"])
    expect(schemas.length).toBeGreaterThan(REGISTERED_COMMANDS.length)
    for (const schema of schemas) expect(schema["additionalProperties"]).toBe(false)
  })

  it("describes fields with the glossary help text", () => {
    const stats = JSON.stringify(definitionOf("stats"))
    expect(stats).toContain("A screen is one page or view a user can open")
  })
})

describe("schema-validator", () => {
  const schema = { type: "object", properties: { a: { type: ["integer", "null"] } }, required: ["a"], additionalProperties: false }

  it("flags undeclared, missing and mistyped keys", () => {
    expect(validate(schema, { a: 1 })).toEqual([])
    expect(validate(schema, { a: null })).toEqual([])
    expect(validate(schema, { a: "x", b: 1 })).toEqual(["$: undeclared key 'b'", "$.a: expected integer|null, got string"])
    expect(validate(schema, {})).toEqual(["$: missing required key 'a'"])
  })
})

describe("real --json output matches its schema", () => {
  it.each(QUERY_RUNS.map((argv) => [argv.join(" "), argv] as const))("%s", async (_, argv) => {
    const run = await query([...argv, "--json"])
    expect(run.code).toBe(0)
    expectValid(commandOf(argv), jsonOf(run))
  })

  it("covers every query command but schema", () => {
    const covered = new Set(QUERY_RUNS.map(commandOf))
    const queries = REGISTERED_COMMANDS.filter((spec) => spec.kind === "query" && spec.envelope !== "document")
    expect(queries.filter((spec) => !covered.has(spec.name)).map((spec) => spec.name)).toEqual([])
  })

  it("matches for every screen's full detail", async () => {
    const ids = GRAPH.screens.map((screen) => screen.id)
    const runs = await Promise.all(ids.map((id) => query(["screen", id, "--json"])))
    for (const run of runs) expectValid("screen", jsonOf(run))
  })

  it("matches with the empty-result marker in the envelope", async () => {
    const empty = await catalogBench(EMPTY_GRAPH)
    const run = await empty(["screens", "--json", "--quiet"])
    expect(jsonOf(run)).toMatchObject({ emptyResult: true, emptyReason: "fixture says so" })
    expectValid("screens", jsonOf(run))
  })

  it("matches for the error object", async () => {
    const run = await query(["screen", "no-such-screen", "--json"])
    expect(run.code).toBe(2)
    expectValid("error", jsonOf(run))
  })

  it("matches for the analyze run summary and the doctor report", async () => {
    const analyze = await query(["analyze", "--json", "--quiet"])
    expectValid("analyze", jsonOf(analyze))
    const doctor = await query(["doctor", "--json"])
    expectValid("doctor", jsonOf(doctor))
  })
})
