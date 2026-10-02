import type { AppGraph, Endpoint, FileFacts, Screen, ShellReport, TreeNode } from "../../core/model.js"
import { byNumber, sortedEntries } from "../../core/order.js"
import { componentRoute, routedFiles } from "../../emit/report-derive.js"
import { orderedScreens } from "../../emit/report-payload.js"
import { EXIT_OK } from "../../pipeline/exit-codes.js"
import type { QueryContext, QueryRun } from "../commands.js"
import { USAGE_TYPES } from "../commands.js"
import { isOneOf, ownString } from "./catalog.js"
import { nearestMatches, writeList } from "./output.js"
import { loadGraph } from "./runtime.js"

type UsageType = (typeof USAGE_TYPES)[number]

type UserKind = "screen" | "component"

type Channel = { readonly via: string; readonly keys: readonly string[] }

type Hit = {
  readonly kind: UserKind
  readonly id: string
  readonly url: string | null
  readonly via: string
  readonly match: string
  readonly rank: number
}

type UsageIndex = ReadonlyMap<string, readonly Hit[]>

type UsageIndexes = (type: UsageType) => UsageIndex

const COLUMNS = ["kind", "id", "url", "via", "match"] as const

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i

const METHOD_PREFIX = new RegExp(`^(?:${HTTP_METHODS.join("|")})\\s+\\S`, "i")

const URL_LIKE = /^(?:\/|https?:\/\/)/i

export const endpointKey = (endpoint: Endpoint): string => `${endpoint.method.toUpperCase()} ${endpoint.url}`

const treeFiles = (nodes: readonly TreeNode[]): readonly string[] =>
  nodes.flatMap((node) => [node.file, ...treeFiles(node.children)])

const shellOf = (graph: AppGraph, screen: Screen): ShellReport | undefined =>
  screen.shell === null ? undefined : graph.shells[screen.shell]

const entryFiles = (screen: Screen): readonly string[] =>
  screen.entries.flatMap((entry) => (entry.kind === "file" ? [entry.file] : []))

const shellFiles = (shell: ShellReport | undefined): readonly string[] =>
  shell === undefined ? [] : [shell.file, ...shell.layouts, ...treeFiles(shell.tree)]

type ScreenChannels = (screen: Screen, shell: ShellReport | undefined) => readonly Channel[]

type ComponentChannels = (facts: FileFacts) => readonly Channel[]

const SCREEN_CHANNELS = {
  component: (screen, shell) => [
    { via: "entry", keys: entryFiles(screen) },
    { via: "tree", keys: treeFiles(screen.tree) },
    { via: "reachable", keys: screen.reachable },
    { via: "shell", keys: shellFiles(shell) },
  ],
  endpoint: (screen, shell) => [
    { via: "facts", keys: screen.facts.endpoints.map(endpointKey) },
    { via: "shell", keys: (shell?.endpoints ?? []).map(endpointKey) },
  ],
  testid: (screen, shell) => [
    { via: "facts", keys: screen.facts.testIds },
    { via: "shell", keys: shell?.testIds ?? [] },
  ],
  store: (screen, shell) => [
    { via: "facts", keys: screen.facts.stores },
    { via: "shell", keys: shell?.stores ?? [] },
  ],
  "query-key": (screen) => [{ via: "facts", keys: screen.facts.queryKeys }],
  i18n: (screen, shell) => [
    { via: "facts", keys: screen.facts.i18nNamespaces },
    { via: "shell", keys: shell?.i18nNamespaces ?? [] },
  ],
} as const satisfies Record<UsageType, ScreenChannels>

const COMPONENT_CHANNELS = {
  component: (facts) => [
    { via: "renders", keys: facts.renders.map((edge) => edge.file) },
    { via: "uses", keys: facts.uses },
  ],
  endpoint: (facts) => [{ via: "facts", keys: facts.endpoints.map(endpointKey) }],
  testid: (facts) => [{ via: "facts", keys: facts.testIds }],
  store: (facts) => [{ via: "facts", keys: facts.stores }],
  "query-key": (facts) => [{ via: "facts", keys: facts.queryKeys }],
  i18n: (facts) => [{ via: "facts", keys: facts.i18nNamespaces }],
} as const satisfies Record<UsageType, ComponentChannels>

type Entity = {
  readonly kind: UserKind
  readonly id: string
  readonly url: string | null
  readonly channels: (type: UsageType) => readonly Channel[]
}

const screenEntities = (graph: AppGraph): readonly Entity[] =>
  orderedScreens(graph.screens).map((screen) => {
    const shell = shellOf(graph, screen)
    return { kind: "screen", id: screen.id, url: screen.url, channels: (type) => SCREEN_CHANNELS[type](screen, shell) }
  })

const componentEntities = (graph: AppGraph): readonly Entity[] => {
  const routed = routedFiles(graph.screens)
  return sortedEntries(graph.components).map(([file, facts]) => ({
    kind: "component",
    id: file,
    url: componentRoute(facts, routed),
    channels: (type) => COMPONENT_CHANNELS[type](facts),
  }))
}

const addHit = (index: Map<string, Hit[]>, key: string, hit: Hit): void => {
  const hits = index.get(key)
  if (hits === undefined) {
    index.set(key, [hit])
    return
  }
  if (hits.some((existing) => existing.rank === hit.rank)) return
  hits.push(hit)
}

const buildIndex = (entities: readonly Entity[], type: UsageType): UsageIndex => {
  const index = new Map<string, Hit[]>()
  entities.forEach((entity, rank) => {
    for (const channel of entity.channels(type))
      for (const key of channel.keys)
        addHit(index, key, { kind: entity.kind, id: entity.id, url: entity.url, via: channel.via, match: key, rank })
  })
  return index
}

export const buildUsageIndexes = (graph: AppGraph): UsageIndexes => {
  const entities = [...screenEntities(graph), ...componentEntities(graph)]
  const built = new Map<UsageType, UsageIndex>()
  return (type) => {
    const cached = built.get(type)
    if (cached !== undefined) return cached
    const index = buildIndex(entities, type)
    built.set(type, index)
    return index
  }
}

const componentNameAliases = (graph: AppGraph, term: string, index: UsageIndex): readonly string[] =>
  Object.values(graph.components)
    .filter((facts) => facts.component === term && index.has(facts.file))
    .map((facts) => facts.file)

const normalizedEndpoint = (term: string): string => {
  const [method = "", ...rest] = term.trim().split(/\s+/)
  return `${method.toUpperCase()} ${rest.join(" ")}`
}

const withoutQuery = (url: string): string => url.split("?")[0] ?? url

const methodOf = (key: string): string => key.slice(0, key.indexOf(" "))

const urlOf = (key: string): string => key.slice(key.indexOf(" ") + 1)

const sameResource = (url: string, term: string): boolean => url === term || withoutQuery(url) === withoutQuery(term)

/** An exact key first; otherwise every key for the same path, so `/api/x` finds `GET /api/x?id=:param`. */
const endpointAliases = (term: string, index: UsageIndex): readonly string[] => {
  const keys = [...index.keys()]
  if (!METHOD_PREFIX.test(term.trim())) return keys.filter((key) => sameResource(urlOf(key), term))
  const key = normalizedEndpoint(term)
  if (index.has(key)) return [key]
  return keys.filter((candidate) => methodOf(candidate) === methodOf(key) && sameResource(urlOf(candidate), urlOf(key)))
}

const ALIASES = {
  component: (graph, term, index) => (index.has(term) ? [term] : componentNameAliases(graph, term, index)),
  endpoint: (_graph, term, index) => endpointAliases(term, index),
  testid: (_graph, term, index) => (index.has(term) ? [term] : []),
  store: (_graph, term, index) => (index.has(term) ? [term] : []),
  "query-key": (_graph, term, index) => (index.has(term) ? [term] : []),
  i18n: (_graph, term, index) => (index.has(term) ? [term] : []),
} as const satisfies Record<UsageType, (graph: AppGraph, term: string, index: UsageIndex) => readonly string[]>

export const matchedKeys = (graph: AppGraph, indexes: UsageIndexes, type: UsageType, term: string): readonly string[] =>
  ALIASES[type](graph, term, indexes(type))

export const shapeType = (term: string): UsageType | null => {
  const trimmed = term.trim()
  if (SOURCE_FILE.test(trimmed)) return "component"
  if (METHOD_PREFIX.test(trimmed) || URL_LIKE.test(trimmed)) return "endpoint"
  return null
}

export const detectType = (graph: AppGraph, indexes: UsageIndexes, term: string): UsageType | null =>
  USAGE_TYPES.find((type) => matchedKeys(graph, indexes, type, term).length > 0) ?? shapeType(term)

const byRank = (a: Hit, b: Hit): number => byNumber(a.rank, b.rank)

export const usageHits = (indexes: UsageIndexes, type: UsageType, keys: readonly string[]): readonly Hit[] => {
  const seen = new Set<number>()
  return keys
    .flatMap((key) => indexes(type).get(key) ?? [])
    .sort(byRank)
    .filter((hit) => {
      if (seen.has(hit.rank)) return false
      seen.add(hit.rank)
      return true
    })
}

const usageRow = (type: UsageType) => (hit: Hit) => ({
  kind: hit.kind,
  id: hit.id,
  url: hit.url,
  type,
  via: hit.via,
  match: hit.match,
})

const candidateKeys = (indexes: UsageIndexes, type: UsageType | null): readonly string[] =>
  (type === null ? USAGE_TYPES : [type]).flatMap((candidate) => [...indexes(candidate).keys()])

const noUsageNotice = (term: string, suggestions: readonly string[]): string => {
  const hint = suggestions.length === 0 ? "" : `; did you mean: ${suggestions.join(", ")}`
  return `appgraph: nothing in the graph uses '${term}'${hint}`
}

const forcedType = (context: QueryContext): UsageType | null => {
  const type = ownString(context, "type")
  return isOneOf(USAGE_TYPES, type) ? type : null
}

type Resolution = {
  readonly type: UsageType | null
  readonly detected: boolean
  readonly keys: readonly string[]
}

const resolve = (graph: AppGraph, indexes: UsageIndexes, term: string, forced: UsageType | null): Resolution => {
  const type = forced ?? detectType(graph, indexes, term)
  return { type, detected: forced === null, keys: type === null ? [] : matchedKeys(graph, indexes, type, term) }
}

const writeNoUsage = (context: QueryContext, term: string, suggestions: readonly string[]): void => {
  if (!context.options.quiet) context.writer.err(noUsageNotice(term, suggestions))
}

const run: QueryRun = async (context) => {
  const term = context.args["term"] ?? ""
  const loaded = await loadGraph(context)
  const indexes = buildUsageIndexes(loaded.graph)
  const resolution = resolve(loaded.graph, indexes, term, forcedType(context))
  const { type } = resolution
  const items = type === null ? [] : usageHits(indexes, type, resolution.keys).map(usageRow(type))
  const suggestions = resolution.keys.length === 0 ? nearestMatches(candidateKeys(indexes, type), term) : []
  if (resolution.keys.length === 0) writeNoUsage(context, term, suggestions)
  writeList(context, {
    loaded,
    items,
    columns: COLUMNS,
    extra: { item: { term, type, detected: resolution.detected, matched: resolution.keys, suggestions } },
  })
  return EXIT_OK
}

export default run
