import { describe, expect, it } from "vitest"
import type { AppGraph, Screen, ScreenFacts, ShellReport, TreeNode } from "../../src/core/model.js"
import {
  GRAPH_CACHE_FILE,
  GRAPH_CACHE_FORMAT,
  GRAPH_CACHE_SCHEMA_VERSION,
  decodeGraphCache,
  encodeGraphCache,
  readGraphCache,
  toGraphCacheEnvelope,
} from "../../src/emit/graph-cache.js"
import { createBuiltinEmitters } from "../../src/pipeline/registry.js"
import { expandFormats } from "../../src/pipeline/phases/emit.js"

const facts = (): ScreenFacts => ({
  endpoints: [{ method: "GET", url: "/api/orders", transport: "http", client: null }],
  navigations: [],
  stores: ["cart"],
  queryKeys: [],
  mutations: 0,
  i18nNamespaces: [],
  testIds: [],
  formSchemas: [],
  formFields: [],
  featureGates: [],
  hooks: [],
  messages: [],
  extra: { analytics: ["checkout"] },
})

const node = (file: string, children: readonly TreeNode[] = [], overrides: Partial<TreeNode> = {}): TreeNode => ({
  file,
  component: file.replace(/^.*\//, "").replace(/\.tsx$/, ""),
  kind: "ui",
  conditions: [],
  alwaysRendered: true,
  repeated: false,
  nullGuards: [],
  children,
  truncated: false,
  repeat: false,
  ...overrides,
})

const card = (): TreeNode => node("src/Card.tsx", [node("src/Title.tsx"), node("src/Body.tsx")])

const screen = (id: string, tree: readonly TreeNode[], reachable: readonly string[]): Screen => ({
  id,
  localId: `src/pages${id}.tsx`,
  source: "react-router",
  activations: [{ kind: "url", template: id, params: [] }],
  url: id,
  params: [],
  title: null,
  kindTag: null,
  entries: [{ kind: "file", file: `src/pages${id}.tsx`, exportName: "default" }],
  ancestors: [],
  shell: "src/Layout.tsx",
  auth: "protected",
  featureFlag: null,
  redirectTo: null,
  devOnly: false,
  addressable: true,
  tree,
  reachable,
  facts: facts(),
  navigatesTo: [],
  provenance: { sources: ["react-router"], evidence: [], mergedFrom: [], decisions: [] },
})

const shell = (tree: readonly TreeNode[]): ShellReport => ({
  file: "src/Layout.tsx",
  layouts: ["Layout"],
  tree,
  navigatesTo: [],
  endpoints: [],
  stores: [],
  i18nNamespaces: [],
  testIds: [],
})

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
    counts: { screens: 2 },
    confidence: [],
    limitations: ["a limitation"],
  },
  screens: [
    screen(
      "/orders",
      [node("src/pages/orders.tsx", [card(), card(), node("src/List.tsx", [card()], { repeated: true, via: "lazy" })])],
      ["src/pages/orders.tsx", "src/Card.tsx", "src/Title.tsx"],
    ),
    screen("/cart", [node("src/pages/cart.tsx", [card()], { conditions: ["user"], alwaysRendered: false })], ["src/Card.tsx"]),
  ],
  redirects: [{ from: "/", to: "/orders" }],
  shells: { "src/Zed.tsx": shell([node("src/Zed.tsx")]), "src/Layout.tsx": shell([node("src/Layout.tsx", [card()])]) },
  components: {},
  navGroups: [],
  navigation: [],
  deadNavLinks: [],
  orphanScreens: ["/cart"],
  diagnostics: [{ severity: "warning", code: "nav/dead-link", message: "dead", plugin: null }],
})

describe("the graph cache", () => {
  it("decodes to a graph deep-equal to the one encoded", () => {
    expect(decodeGraphCache(encodeGraphCache(graph()))).toEqual(graph())
  })

  it("is byte-reproducible and carries no timestamp or fingerprint", () => {
    const text = encodeGraphCache(graph())
    expect(encodeGraphCache(graph())).toBe(text)
    expect(text).not.toMatch(/generatedAt|timestamp/)
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["format", "schemaVersion", "appgraphVersion", "paths", "subtrees", "graph"])
  })

  it("interns trees and reachable paths into shared tables", () => {
    const envelope = toGraphCacheEnvelope(graph())
    expect(envelope).toMatchObject({ format: GRAPH_CACHE_FORMAT, schemaVersion: GRAPH_CACHE_SCHEMA_VERSION, appgraphVersion: "0.1.0-test" })
    expect(envelope.subtrees.filter((tree) => tree.component === "Card")).toHaveLength(1)
    expect(envelope.graph.screens[0]?.tree).toEqual([expect.any(Number)])
    expect(envelope.graph.screens[1]?.reachable).toEqual([envelope.paths.indexOf("src/Card.tsx")])
    expect(new Set(envelope.paths).size).toBe(envelope.paths.length)
  })

  it("numbers subtrees first-seen over the screens, then the shells in sorted order", () => {
    const envelope = toGraphCacheEnvelope(graph())
    const components = envelope.subtrees.map((tree) => tree.component)
    expect(components.indexOf("orders")).toBeLessThan(components.indexOf("cart"))
    expect(components.indexOf("cart")).toBeLessThan(components.indexOf("Layout"))
    expect(components.indexOf("Layout")).toBeLessThan(components.indexOf("Zed"))
  })

  it("reports a cache that does not parse as corrupt and one of another version as incompatible", () => {
    const text = encodeGraphCache(graph())
    expect(readGraphCache("{nope").kind).toBe("corrupt")
    expect(readGraphCache("[]").kind).toBe("corrupt")
    expect(readGraphCache(text, "0.2.0").kind).toBe("incompatible")
    expect(readGraphCache(text.replace('"schemaVersion":2', '"schemaVersion":1')).kind).toBe("incompatible")
    expect(readGraphCache(text, "0.1.0-test")).toMatchObject({ kind: "ok", appgraphVersion: "0.1.0-test" })
    expect(() => decodeGraphCache("{nope")).toThrow(/corrupt/)
  })
})

describe("the graph emitter", () => {
  it("writes appgraph.graph.json as compact JSON, and `all` includes it", () => {
    const emitter = createBuiltinEmitters().find((entry) => entry.name === "graph")
    const files = emitter?.emit(graph(), { format: "graph", timestamp: "2026-01-01T00:00:00.000Z", options: {}, asset: () => "" }) ?? []
    expect(files).toEqual([{ path: GRAPH_CACHE_FILE, content: encodeGraphCache(graph()) }])
    expect(files[0]?.content).not.toContain("\n")
    expect(expandFormats(["all"])).toContain("graph")
  })
})
