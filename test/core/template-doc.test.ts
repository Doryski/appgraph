import ts from "typescript"
import { describe, expect, it } from "vitest"
import type { Adapter } from "../../src/adapters/types.js"
import { resolveConfig } from "../../src/config/types.js"
import { createDiagnosticCollector } from "../../src/core/diagnostics.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { AppGraph, AncestorRef } from "../../src/core/model.js"
import { scanTags } from "../../src/core/tag-scan.js"
import type { TemplateDoc, TemplateElement } from "../../src/core/template-doc.js"
import { EMPTY_TEMPLATE_TAGS, expressionsFrom, primaryNameOf } from "../../src/core/template-doc.js"
import type { TemplateFrameworkSpec } from "../../src/core/template-frameworks.js"
import { createEnv } from "../../src/pipeline/context.js"
import { configure, createFactSource, discover, normalize, resolveEntries, walk } from "../../src/pipeline/phases.js"
import { createDefaultExtractors, createPipelineRegistry } from "../../src/pipeline/registry.js"
import { createTemplateSource } from "../../src/pipeline/template-frameworks.js"

const ROOT = "/repo"

const FAKE_TAGS = ["Header", "FakeOutlet"] as const

const TEMPLATE_LITERAL = /template = "([^"]*)"/

const elementOf = (tag: string, pos: number, end: number, line: number): TemplateElement => ({
  tag,
  names: [tag],
  kind: "component",
  pos,
  end,
  line,
  attributes: [],
  guard: { condition: null, repeated: false, lazy: false },
  slotName: null,
})

const scannedDoc = (file: string, text: string): readonly TemplateDoc[] => {
  const match = TEMPLATE_LITERAL.exec(text)
  if (match === null) return []
  const from = match.index + match[0].indexOf("\"") + 1
  const elements = scanTags(text, { tags: FAKE_TAGS, from, to: from + (match[1] ?? "").length }).map((tag) =>
    elementOf(tag.tag, tag.pos, tag.end, tag.line),
  )
  return [{ framework: "angular", file, owner: "default", partial: true, elements, expressions: [], unsupported: [] }]
}

const fakeFramework: TemplateFrameworkSpec<unknown> = {
  id: "angular",
  label: "Fake",
  packages: [],
  moduleKind: "esm",
  installHint: "",
  skippedNote: "",
  appliesTo: () => true,
  projectMajor: () => null,
  checkVersion: () => null,
  fallbackOnUnsupported: false,
  adapt: (module) => module,
  producer: (_api, env) => ({
    framework: "angular",
    tags: { ...EMPTY_TEMPLATE_TAGS, outlets: [["FakeOutlet"]] },
    claims: (file) => file.endsWith(".ts") && (env.readFile(file) ?? "").includes("template = "),
    docsOf: (file) => scannedDoc(file, env.readFile(file) ?? ""),
  }),
  tags: { ...EMPTY_TEMPLATE_TAGS, outlets: [["FakeOutlet"]] },
}

const FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify({ name: "fixture" }),
  "tsconfig.json": JSON.stringify({ include: ["src"] }),
  "src/App.ts": [
    'import Header from "./Header"',
    "",
    'export const template = "<Header></Header>\\n<FakeOutlet></FakeOutlet>"',
    "",
    "export default class App {}",
    "",
  ].join("\n"),
  "src/Header.ts": 'export const template = "<header></header>"\nexport default class Header {}\n',
  "src/pages/Orders.ts": "export default class Orders {}\n",
}

const ancestor: AncestorRef = {
  file: "src/App.ts",
  exportName: "default",
  role: "layout",
  splice: { kind: "outlet", tag: "FakeOutlet" },
}

const adapter: Adapter = {
  name: "fake-routes",
  screens: [
    {
      name: "fake-routes",
      detect: () => ({ score: 100, evidence: [] }),
      discover: () => [
        {
          localId: "src/pages/Orders.ts",
          activations: [{ kind: "url", template: "/orders", params: [] }],
          entries: [{ kind: "file", file: "src/pages/Orders.ts", exportName: "default" }],
          ancestors: [ancestor],
          evidence: [],
        },
      ],
    },
  ],
}

type Analysis = {
  readonly graph: AppGraph
  readonly codes: readonly string[]
}

const analyze = (frameworks: readonly TemplateFrameworkSpec<unknown>[]): Analysis => {
  const diagnostics = createDiagnosticCollector()
  const env = createEnv({
    ts,
    config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }),
    host: createMemoryHost({ files: Object.fromEntries(Object.entries(FILES).map(([file, text]) => [`${ROOT}/${file}`, text])) }),
    diagnostics,
    frameworks,
  })
  const registry = createPipelineRegistry({ adapters: [adapter] })
  const { kindRules } = configure({ env, registry })
  const discovered = discover({ env, registry })
  const screens = resolveEntries({ env, registry, screens: normalize({ env, contributions: discovered.contributions }) })
  const facts = createFactSource({ env, extractors: createDefaultExtractors({ kindRules }), kindRules })
  const graph = walk({ env, screens, navGroups: discovered.navGroups, facts, kindRules, diagnostics })
  return { graph, codes: diagnostics.all().map((diagnostic) => diagnostic.code) }
}

const treeFilesOf = (graph: AppGraph): readonly string[] => {
  const visit = (nodes: AppGraph["screens"][number]["tree"]): readonly string[] =>
    nodes.flatMap((node) => [node.file, ...visit(node.children)])
  return visit(graph.screens[0]?.tree ?? [])
}

describe("template-doc helpers", () => {
  it("takes the first binding name as the primary name, falling back to the tag", () => {
    expect(primaryNameOf({ tag: "router-view", names: ["RouterView", "router-view"] })).toBe("RouterView")
    expect(primaryNameOf({ tag: "x-y", names: [] })).toBe("x-y")
  })

  it("filters expressions by origin", () => {
    const expression = { pos: 0, end: 1, line: 1, pipes: [] }
    const doc = {
      expressions: [
        { ...expression, text: "a", origin: "interpolation" as const },
        { ...expression, text: "b()", origin: "event" as const },
      ],
    }
    expect(expressionsFrom(doc, "event").map((entry) => entry.text)).toEqual(["b()"])
  })
})

describe("template source — locator over the registered producers", () => {
  const files: Readonly<Record<string, string>> = { "src/App.ts": FILES["src/App.ts"] ?? "" }
  const source = createTemplateSource({
    apis: undefined,
    readFile: (file) => files[file] ?? null,
    ambient: (names) => (names.includes("Header") ? { kind: "file", file: "src/Header.ts", exportName: "default", via: "ambient" } : null),
    frameworks: [fakeFramework],
  })

  it("claims, reads and caches the documents of the framework that owns a file", () => {
    const docs = source.templatesOf("src/App.ts")

    expect(source.claims("src/App.ts")).toBe(true)
    expect(source.claims("src/Other.ts")).toBe(false)
    expect(docs.map((doc) => [doc.framework, doc.file, doc.owner, doc.elements.map(primaryNameOf)])).toEqual([
      ["angular", "src/App.ts", "default", ["Header", "FakeOutlet"]],
    ])
    expect(source.templatesOf("src/App.ts")).toBe(docs)
  })

  it("falls back to the ambient registry by element names when the producer cannot resolve a tag", () => {
    const [doc] = source.templatesOf("src/App.ts")
    const [header, outlet] = doc?.elements ?? []
    if (doc === undefined || header === undefined || outlet === undefined) throw new Error("expected two elements")

    expect(source.resolveTag(doc, header)).toEqual({ kind: "file", file: "src/Header.ts", exportName: "default", via: "ambient" })
    expect(source.resolveTag(doc, outlet)).toBeNull()
  })

  it("exposes each framework's tags and label, and empty tags for an unregistered one", () => {
    expect(source.tagsOf("angular").outlets).toEqual([["FakeOutlet"]])
    expect(source.labelOf("angular")).toBe("Fake")
    expect(source.tagsOf("vue")).toEqual(EMPTY_TEMPLATE_TAGS)
    expect(source.componentNameOf("src/App.ts")).toBeNull()
  })
})

describe("drop-in proof — a third template framework needs only its spec", () => {
  it("gets render edges and outlet splices from a registered spec alone", () => {
    const { graph, codes } = analyze([fakeFramework])

    expect(treeFilesOf(graph)).toEqual(["src/App.ts", "src/Header.ts", "src/pages/Orders.ts"])
    expect(codes.filter((code) => code.startsWith("walk/"))).toEqual([])
  })

  it("finds neither without the spec", () => {
    const { graph, codes } = analyze([])

    expect(treeFilesOf(graph)).toEqual(["src/pages/Orders.ts"])
    expect(codes).toContain("walk/no-splice-point")
  })
})
