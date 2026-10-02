import type { AppGraph, NavigationEdge, Screen } from "../../core/model.js"
import { sortedUnique } from "../../core/order.js"
import { collapseEdges, degreeByUrl, edgesTouching } from "../../emit/html-graph.js"
import { isApiScreen } from "../../emit/html-util.js"
import { EXIT_OK } from "../../pipeline/exit-codes.js"
import type { QueryContext, QueryRun } from "../commands.js"
import { LINK_DIRECTIONS } from "../commands.js"
import type { LINK_EXCLUSIONS } from "../commands.js"
import { writeList } from "./output.js"
import { loadGraph } from "./runtime.js"
import { resolveScreen, targetOf } from "./screen.js"

const DEFAULT_COLUMNS = ["direction", "id", "url", "weight", "dynamic", "triggers"] as const

const EXCLUSION_REASONS = {
  "no-url": "it has no url",
  "api-route": "it is an API route",
} as const satisfies Readonly<Record<(typeof LINK_EXCLUSIONS)[number], string>>

type Exclusion = keyof typeof EXCLUSION_REASONS

type Direction = (typeof LINK_DIRECTIONS)[number]

type MapEdge = ReturnType<typeof collapseEdges>[number]

export const isMapScreen = (screen: Screen): boolean => screen.url !== null && !isApiScreen(screen)

const exclusionOf = (screen: Screen): Exclusion | null => {
  if (screen.url === null) return "no-url"
  return isApiScreen(screen) ? "api-route" : null
}

type MapModel = {
  readonly idToUrl: ReadonlyMap<string, string>
  readonly urlToId: ReadonlyMap<string, string>
  readonly edges: readonly MapEdge[]
}

const firstIdByUrl = (screens: readonly Screen[]): ReadonlyMap<string, string> =>
  screens.reduce((map, screen) => (screen.url === null || map.has(screen.url) ? map : map.set(screen.url, screen.id)), new Map<string, string>())

export const mapModel = (graph: AppGraph): MapModel => {
  const nodes = graph.screens.filter(isMapScreen)
  const idToUrl = new Map(nodes.map((screen) => [screen.id, screen.url ?? ""]))
  const urls = new Set(idToUrl.values())
  return { idToUrl, urlToId: firstIdByUrl(nodes), edges: collapseEdges(graph.navigation, idToUrl, urls) }
}

const directionOf = (edge: MapEdge, url: string): Direction => (edge.from === url ? "out" : "in")

const triggersOf = (navigation: readonly NavigationEdge[], idToUrl: ReadonlyMap<string, string>, edge: MapEdge) =>
  sortedUnique(
    navigation
      .filter((nav) => (idToUrl.get(nav.from) ?? nav.from) === edge.from && nav.to === edge.to)
      .map((nav) => nav.trigger),
  )

const wantedDirections = (context: QueryContext): readonly Direction[] => {
  const incoming = context.own["incoming"] === true
  const outgoing = context.own["outgoing"] === true
  if (incoming === outgoing) return LINK_DIRECTIONS
  return incoming ? ["in"] : ["out"]
}

const linkRow = (graph: AppGraph, model: MapModel, url: string) => (edge: MapEdge) => {
  const direction = directionOf(edge, url)
  const neighbour = direction === "out" ? edge.to : edge.from
  return {
    direction,
    id: model.urlToId.get(neighbour) ?? neighbour,
    url: neighbour,
    weight: edge.weight,
    dynamic: edge.dynamic,
    triggers: triggersOf(graph.navigation, model.idToUrl, edge),
  }
}

export const screenLinks = (graph: AppGraph, screen: Screen, directions: readonly Direction[]) => {
  const model = mapModel(graph)
  const url = model.idToUrl.get(screen.id) ?? null
  const touching = edgesTouching(model.edges, url)
  const rows = url === null ? [] : touching.map(linkRow(graph, model, url))
  const outDegree = rows.filter((row) => row.direction === "out").length
  return {
    item: {
      id: screen.id,
      url: screen.url,
      degree: url === null ? 0 : (degreeByUrl(model.edges).get(url) ?? 0),
      inDegree: rows.length - outDegree,
      outDegree,
      excluded: exclusionOf(screen),
    },
    rows: LINK_DIRECTIONS.filter((direction) => directions.includes(direction)).flatMap((direction) =>
      rows.filter((row) => row.direction === direction),
    ),
  }
}

type LinksItem = ReturnType<typeof screenLinks>["item"]

const exclusionNotice = (item: LinksItem): string | null =>
  item.excluded === null ? null : `appgraph: ${item.id} is not on the map because ${EXCLUSION_REASONS[item.excluded]}, so it has no links`

const summaryLine = (item: LinksItem): string =>
  `${item.id} (${item.url ?? "-"}): in ${String(item.inDegree)}, out ${String(item.outDegree)}`

const writeProse = (context: QueryContext, item: LinksItem): void => {
  if (context.options.quiet) return
  const notice = exclusionNotice(item)
  if (notice !== null) context.writer.err(notice)
  if (!context.options.json && notice === null) context.writer.out(summaryLine(item))
}

const run: QueryRun = async (context) => {
  const loaded = await loadGraph(context)
  const screen = resolveScreen(loaded.graph, targetOf(context))
  const links = screenLinks(loaded.graph, screen, wantedDirections(context))
  writeProse(context, links.item)
  writeList(context, { loaded, items: links.rows, columns: DEFAULT_COLUMNS, extra: { item: links.item } })
  return EXIT_OK
}

export default run
