import type { ReportPayload } from "@appgraph/emit/report-payload.js"
import { normalizeQuery } from "@appgraph/emit/report-derive.js"

export type MapGraph = ReportPayload["graph"]
export type MapNode = MapGraph["nodes"][number]
export type MapEdge = MapGraph["edges"][number]
export type MapHeader = MapGraph["headers"][number]
export type AuthState = MapNode["auth"]

export const ROW_HEIGHT = 22
export const LABEL_OFFSET = 14
export const CHAR_WIDTH = 6.7

const searchTextOf = (node: MapNode): string => `${node.url} ${node.title ?? ""}`.toLowerCase()

export const matchingUrls = (nodes: readonly MapNode[], query: string): ReadonlySet<string> => {
  const needle = normalizeQuery(query)
  if (needle === "") return new Set()
  return new Set(nodes.filter((node) => searchTextOf(node).includes(needle)).map((node) => node.url))
}

export const edgeTouchesAny = (edge: MapEdge, urls: ReadonlySet<string>): boolean =>
  urls.has(edge.from) || urls.has(edge.to)

export const nodeTooltip = (node: MapNode): string => (node.title ? `${node.url} — ${node.title}` : node.url)

export const labelWidth = (url: string): number => LABEL_OFFSET + url.length * CHAR_WIDTH

export const NAV_KEYS = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"] as const

export type NavKey = (typeof NAV_KEYS)[number]

export const isNavKey = (key: string): key is NavKey => NAV_KEYS.some((candidate) => candidate === key)

const nearestBy = (candidates: readonly MapNode[], score: (node: MapNode) => number): MapNode | undefined =>
  candidates.reduce<MapNode | undefined>(
    (best, node) => (best === undefined || score(node) < score(best) ? node : best),
    undefined,
  )

const adjacentColumn = (nodes: readonly MapNode[], current: MapNode, direction: 1 | -1): MapNode | undefined => {
  const ahead = nodes.filter((node) => (node.x - current.x) * direction > 0)
  const columnX = nearestBy(ahead, (node) => Math.abs(node.x - current.x))?.x
  if (columnX === undefined) return undefined
  return nearestBy(
    ahead.filter((node) => node.x === columnX),
    (node) => Math.abs(node.y - current.y),
  )
}

export const nextNode = (nodes: readonly MapNode[], currentId: string, key: NavKey): MapNode | undefined => {
  const index = nodes.findIndex((node) => node.id === currentId)
  const current = nodes[index]
  if (current === undefined) return nodes[0]
  switch (key) {
    case "ArrowDown":
      return nodes[index + 1]
    case "ArrowUp":
      return nodes[index - 1]
    case "ArrowRight":
      return adjacentColumn(nodes, current, 1)
    case "ArrowLeft":
      return adjacentColumn(nodes, current, -1)
    case "Home":
      return nodes[0]
    case "End":
      return nodes[nodes.length - 1]
  }
}
