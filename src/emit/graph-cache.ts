import type { AppGraph, Screen, ShellReport, TreeNode } from "../core/model.js"
import { sortedEntries } from "../core/order.js"
import type { EncodedTreeNode, PathTable, TreeRef } from "./tree-intern.js"
import { buildPathTable, createTreeHydrator, decodePaths, encodePaths, internForests, treeFiles } from "./tree-intern.js"

export const GRAPH_CACHE_FORMAT = "appgraph-graph"

export const GRAPH_CACHE_SCHEMA_VERSION = 2

export const GRAPH_CACHE_FILE = "appgraph.graph.json"

export type CachedScreen = Omit<Screen, "tree" | "reachable"> & {
  readonly tree: readonly TreeRef[]
  readonly reachable: readonly number[]
}

export type CachedShell = Omit<ShellReport, "tree"> & {
  readonly tree: readonly TreeRef[]
}

export type CachedGraph = Omit<AppGraph, "screens" | "shells"> & {
  readonly screens: readonly CachedScreen[]
  readonly shells: Readonly<Record<string, CachedShell>>
}

export type GraphCacheEnvelope = {
  readonly format: typeof GRAPH_CACHE_FORMAT
  readonly schemaVersion: typeof GRAPH_CACHE_SCHEMA_VERSION
  readonly appgraphVersion: string
  readonly paths: readonly string[]
  readonly subtrees: readonly EncodedTreeNode[]
  readonly graph: CachedGraph
}

export type GraphCacheRead =
  | { readonly kind: "ok"; readonly graph: AppGraph; readonly appgraphVersion: string }
  | { readonly kind: "corrupt"; readonly reason: string }
  | { readonly kind: "incompatible"; readonly reason: string }

const forestsOf = (graph: AppGraph): readonly (readonly TreeNode[])[] => [
  ...graph.screens.map((screen) => screen.tree),
  ...sortedEntries(graph.shells).map(([, shell]) => shell.tree),
]

const pathTableOf = (graph: AppGraph, forests: readonly (readonly TreeNode[])[]): PathTable =>
  buildPathTable([...treeFiles(forests), ...graph.screens.flatMap((screen) => screen.reachable)])

const forestAt = (forests: readonly (readonly TreeRef[])[], index: number): readonly TreeRef[] => forests[index] ?? []

export const toGraphCacheEnvelope = (graph: AppGraph): GraphCacheEnvelope => {
  const forests = forestsOf(graph)
  const table = pathTableOf(graph, forests)
  const interned = internForests(forests, { paths: table })
  const shellIndex = new Map(sortedEntries(graph.shells).map(([id], index) => [id, graph.screens.length + index]))

  return {
    format: GRAPH_CACHE_FORMAT,
    schemaVersion: GRAPH_CACHE_SCHEMA_VERSION,
    appgraphVersion: graph.meta.appgraphVersion,
    paths: table.paths,
    subtrees: interned.subtrees,
    graph: {
      ...graph,
      screens: graph.screens.map((screen, index) => ({
        ...screen,
        tree: forestAt(interned.forests, index),
        reachable: encodePaths(table, screen.reachable),
      })),
      shells: Object.fromEntries(
        Object.entries(graph.shells).map(([id, shell]) => [
          id,
          { ...shell, tree: forestAt(interned.forests, shellIndex.get(id) ?? -1) },
        ]),
      ),
    },
  }
}

export const fromGraphCacheEnvelope = (envelope: GraphCacheEnvelope): AppGraph => {
  const hydrate = createTreeHydrator(envelope.subtrees, envelope.paths)
  const { graph } = envelope
  return {
    ...graph,
    screens: graph.screens.map((screen) => ({
      ...screen,
      tree: screen.tree.map(hydrate),
      reachable: decodePaths(envelope.paths, screen.reachable),
    })),
    shells: Object.fromEntries(
      Object.entries(graph.shells).map(([id, shell]) => [id, { ...shell, tree: shell.tree.map(hydrate) }]),
    ),
  }
}

export const encodeGraphCache = (graph: AppGraph): string => JSON.stringify(toGraphCacheEnvelope(graph))

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseJson = (text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } => {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

const isEnvelopeShape = (value: Readonly<Record<string, unknown>>): boolean =>
  typeof value["appgraphVersion"] === "string" &&
  Array.isArray(value["paths"]) &&
  Array.isArray(value["subtrees"]) &&
  isRecord(value["graph"]) &&
  Array.isArray(value["graph"]["screens"]) &&
  isRecord(value["graph"]["shells"])

const incompatibility = (value: Readonly<Record<string, unknown>>, appgraphVersion: string | undefined): string | null => {
  if (value["format"] !== GRAPH_CACHE_FORMAT) return `format is ${JSON.stringify(value["format"])}, expected ${GRAPH_CACHE_FORMAT}`
  if (value["schemaVersion"] !== GRAPH_CACHE_SCHEMA_VERSION)
    return `schemaVersion is ${JSON.stringify(value["schemaVersion"])}, expected ${String(GRAPH_CACHE_SCHEMA_VERSION)}`
  if (appgraphVersion !== undefined && value["appgraphVersion"] !== appgraphVersion)
    return `written by appgraph ${JSON.stringify(value["appgraphVersion"])}, this is ${appgraphVersion}`
  return null
}

const hydrated = (envelope: GraphCacheEnvelope): GraphCacheRead => {
  try {
    return { kind: "ok", graph: fromGraphCacheEnvelope(envelope), appgraphVersion: envelope.appgraphVersion }
  } catch (error) {
    return { kind: "corrupt", reason: error instanceof Error ? error.message : String(error) }
  }
}

export const readGraphCache = (text: string, appgraphVersion?: string): GraphCacheRead => {
  const parsed = parseJson(text)
  if (!parsed.ok) return { kind: "corrupt", reason: parsed.reason }
  if (!isRecord(parsed.value)) return { kind: "corrupt", reason: "not a JSON object" }
  const reason = incompatibility(parsed.value, appgraphVersion)
  if (reason !== null) return { kind: "incompatible", reason }
  if (!isEnvelopeShape(parsed.value)) return { kind: "corrupt", reason: "missing envelope fields" }
  return hydrated(parsed.value as GraphCacheEnvelope)
}

export const decodeGraphCache = (text: string): AppGraph => {
  const read = readGraphCache(text)
  if (read.kind !== "ok") throw new Error(`emit/graph-cache: ${read.kind} cache: ${read.reason}`)
  return read.graph
}
