import { describe, expect, it } from "vitest"
import ts from "typescript"
import { createAst } from "../../src/core/ast.js"
import { GRAPH_LIMITATIONS, buildGraph, emptyFileFacts } from "../../src/core/graph.js"
import type { AncestorRef, FileFacts } from "../../src/core/model.js"

const ast = createAst(ts)

const META = {
  appgraphVersion: "0.1.0",
  root: "repo",
  sourceRoots: ["src"],
  screenSources: ["test-source"],
  fingerprint: "fingerprint",
} as const

const LAYOUT = "src/app/layout.tsx"
const PAGE = "src/app/page.tsx"
const BADGE = "src/ui/Badge.tsx"

const FACTS: Readonly<Record<string, Partial<FileFacts>>> = {
  [LAYOUT]: {
    endpoints: [{ method: "GET", url: "/api/session", transport: "http", client: "axios" }],
    testIds: ["layout-x"],
    renders: [{ file: BADGE, conditions: [], alwaysRendered: true, repeated: false }],
  },
  [PAGE]: { testIds: ["page"] },
  [BADGE]: { testIds: ["badge"] },
}

const factsOf = (file: string): FileFacts => ({ ...emptyFileFacts(file, "C"), ...FACTS[file] })

const parse = (file: string, code: string): ts.SourceFile =>
  ts.createSourceFile(`/repo/${file}`, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)

const SOURCES: Readonly<Record<string, ts.SourceFile>> = {
  [LAYOUT]: parse(
    LAYOUT,
    "export default function L(props: any) { const c = props.children; return <html><body>{c}</body></html> }",
  ),
}

const graphWith = (ancestor: AncestorRef) =>
  buildGraph({
    meta: META,
    providers: { ast, facts: factsOf, sourceOf: (file) => SOURCES[file] ?? null },
    contributions: [
      {
        source: "test-source",
        draft: {
          localId: PAGE,
          activations: [{ kind: "url", template: "/", params: [] }],
          entries: [{ kind: "file", file: PAGE, exportName: "default" }],
          evidence: [],
          ancestors: [ancestor],
        },
      },
    ],
  })

const buildScreen = (ancestor: AncestorRef) => graphWith(ancestor).screens.find((screen) => screen.id === "/")

const layoutAncestor = (role: AncestorRef["role"]): AncestorRef => ({
  file: LAYOUT,
  exportName: "default",
  splice: { kind: "children" },
  role,
})

describe("C12 — a transparent ancestor's facts are aggregated", () => {
  it("counts endpoints and test ids of a layout whose splice point is not found", () => {
    const screen = buildScreen(layoutAncestor("layout"))
    expect(screen?.reachable).toEqual([LAYOUT, PAGE, BADGE].sort())
    expect(screen?.facts.endpoints.map((endpoint) => endpoint.url)).toEqual(["/api/session"])
    expect(screen?.facts.testIds).toEqual(["badge", "layout-x", "page"])
  })

  it("counts the facts of an ancestor the adapter declared transparent", () => {
    const screen = buildScreen(layoutAncestor("transparent"))
    expect(screen?.facts.testIds).toEqual(["badge", "layout-x", "page"])
  })

  it("lists each reachable file once", () => {
    const reachable = buildScreen(layoutAncestor("layout"))?.reachable ?? []
    expect(new Set(reachable).size).toBe(reachable.length)
  })
})

describe("C22 — the traversal limitation describes edges INTO traversable files", () => {
  it("words the uses rule as following edges into traversable files", () => {
    const sentence = GRAPH_LIMITATIONS.find((entry) => entry.startsWith("Reachability follows"))
    expect(sentence).toContain("only INTO files the kind rules mark `traversable`")
    expect(sentence).not.toContain("out of files")
  })
})
