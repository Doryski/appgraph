import type { AppGraph, NavigationEdge, Screen } from "../core/model.js"
import { byCodepoint, isApiScreen } from "./html-util.js"

const PAD = 24
const ROW_HEIGHT = 22
const HEADER_HEIGHT = 34
const GROUP_GAP = 14
const COLUMN_GAP = 64
const CHAR_WIDTH = 6.7
const LABEL_OFFSET = 14
const MIN_COLUMN_WIDTH = 140
const ROOT_GROUP = "/"

type MapNode = {
  readonly id: string
  readonly url: string
  readonly title: string | null
  readonly protected: boolean
}

type MapGroup = { readonly key: string; readonly nodes: readonly MapNode[]; readonly continued: boolean }

type PlacedNode = MapNode & {
  readonly x: number
  readonly y: number
  readonly labelEnd: number
  readonly prefix: string
  readonly radius: number
}

type PlacedHeader = {
  readonly key: string
  readonly count: number
  readonly continued: boolean
  readonly x: number
  readonly y: number
  readonly width: number
}

type MapEdge = { readonly from: string; readonly to: string; readonly dynamic: boolean; readonly weight: number }

export type GraphLayout = {
  readonly width: number
  readonly height: number
  readonly nodes: readonly PlacedNode[]
  readonly headers: readonly PlacedHeader[]
  readonly edges: readonly MapEdge[]
}

const toMapNode = (screen: Screen): readonly MapNode[] =>
  screen.url === null || isApiScreen(screen)
    ? []
    : [{ id: screen.id, url: screen.url, title: screen.title, protected: screen.auth === "protected" }]

const firstSegment = (url: string): string => url.split("/").find((segment) => segment.length > 0) ?? ""

const groupKeyOf = (url: string): string => {
  const segment = firstSegment(url)
  return segment.length === 0 ? ROOT_GROUP : `/${segment}`
}

const bucketByKey = (nodes: readonly MapNode[]): ReadonlyMap<string, readonly MapNode[]> => {
  const buckets = new Map<string, MapNode[]>()
  for (const node of nodes) {
    const key = groupKeyOf(node.url)
    buckets.set(key, [...(buckets.get(key) ?? []), node])
  }
  return buckets
}

const isLoneTopLevel = (key: string, nodes: readonly MapNode[]): boolean =>
  key !== ROOT_GROUP && nodes.length === 1 && nodes[0]?.url === key

export const groupNodes = (nodes: readonly MapNode[]): readonly MapGroup[] => {
  const merged = new Map<string, MapNode[]>()
  for (const [key, members] of bucketByKey(nodes)) {
    const target = isLoneTopLevel(key, members) ? ROOT_GROUP : key
    merged.set(target, [...(merged.get(target) ?? []), ...members])
  }
  return [...merged.entries()]
    .map(([key, members]) => ({
      key,
      nodes: [...members].sort((a, b) => byCodepoint(a.url, b.url)),
      continued: false,
    }))
    .sort((a, b) => byCodepoint(a.key, b.key))
}

const MIN_BUDGET = 22
const MAX_COLUMNS = 8

const groupCost = (group: MapGroup): number => group.nodes.length + 2

const columnBudget = (groups: readonly MapGroup[]): number => {
  const total = groups.reduce((sum, group) => sum + groupCost(group), 0)
  const columns = Math.max(1, Math.min(MAX_COLUMNS, Math.round(Math.sqrt(total / 2.5))))
  return Math.max(MIN_BUDGET, Math.ceil(total / columns))
}

const splitGroup = (group: MapGroup, budget: number): readonly MapGroup[] => {
  const size = budget - 2
  if (group.nodes.length <= size) return [group]
  const chunks: MapGroup[] = []
  for (let start = 0; start < group.nodes.length; start += size) {
    chunks.push({ key: group.key, nodes: group.nodes.slice(start, start + size), continued: start > 0 })
  }
  return chunks
}

export const packColumns = (groups: readonly MapGroup[]): readonly (readonly MapGroup[])[] => {
  const budget = columnBudget(groups)
  const columns: MapGroup[][] = []
  let used = 0
  for (const group of groups.flatMap((candidate) => splitGroup(candidate, budget))) {
    const cost = groupCost(group)
    const current = columns[columns.length - 1]
    if (current === undefined || (current.length > 0 && used + cost > budget)) {
      columns.push([group])
      used = cost
      continue
    }
    current.push(group)
    used += cost
  }
  return columns
}

const labelWidth = (url: string): number => LABEL_OFFSET + url.length * CHAR_WIDTH

const labelPrefix = (group: MapGroup, node: MapNode): string =>
  group.key !== ROOT_GROUP && node.url.length > group.key.length && node.url.startsWith(group.key) ? group.key : ""

const columnWidth = (column: readonly MapGroup[]): number => {
  const longest = Math.max(
    0,
    ...column.flatMap((group) => [group.key.length + 6, ...group.nodes.map((node) => node.url.length)]),
  )
  return Math.max(MIN_COLUMN_WIDTH, Math.ceil(LABEL_OFFSET + longest * CHAR_WIDTH + 8))
}

const groupHeight = (group: MapGroup): number => HEADER_HEIGHT + group.nodes.length * ROW_HEIGHT

const columnHeight = (column: readonly MapGroup[]): number =>
  column.reduce((sum, group) => sum + groupHeight(group), 0) + Math.max(0, column.length - 1) * GROUP_GAP

const nodeRadius = (degree: number): number => 3.5 + Math.min(3, Math.sqrt(degree))

type Placement = { readonly nodes: PlacedNode[]; readonly headers: PlacedHeader[] }

const placeColumn = (
  column: readonly MapGroup[],
  x: number,
  width: number,
  degree: ReadonlyMap<string, number>,
  into: Placement,
): void => {
  let y = PAD
  for (const group of column) {
    into.headers.push({ key: group.key, count: group.nodes.length, continued: group.continued, x, y, width })
    group.nodes.forEach((node, index) => {
      into.nodes.push({
        ...node,
        x,
        y: y + HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2,
        labelEnd: x + labelWidth(node.url) + 4,
        prefix: labelPrefix(group, node),
        radius: nodeRadius(degree.get(node.url) ?? 0),
      })
    })
    y += groupHeight(group) + GROUP_GAP
  }
}

const edgeKey = (from: string, to: string): string => `${from}\u0000${to}`

export const collapseEdges = (
  edges: readonly NavigationEdge[],
  idToUrl: ReadonlyMap<string, string>,
  urls: ReadonlySet<string>,
): readonly MapEdge[] => {
  const merged = new Map<string, MapEdge>()
  for (const edge of edges) {
    const from = idToUrl.get(edge.from) ?? edge.from
    if (from === edge.to || !urls.has(from) || !urls.has(edge.to)) continue
    const key = edgeKey(from, edge.to)
    const previous = merged.get(key)
    merged.set(key, {
      from,
      to: edge.to,
      dynamic: (previous?.dynamic ?? true) && edge.dynamic,
      weight: (previous?.weight ?? 0) + 1,
    })
  }
  return [...merged.values()].sort((a, b) => byCodepoint(a.from, b.from) || byCodepoint(a.to, b.to))
}

type EdgeEnds = { readonly from: string; readonly to: string }

export const degreeByUrl = (edges: readonly EdgeEnds[]): ReadonlyMap<string, number> => {
  const degree = new Map<string, number>()
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  return degree
}

export const edgesTouching = <E extends EdgeEnds>(edges: readonly E[], url: string | null): readonly E[] =>
  url === null ? [] : edges.filter((edge) => edge.from === url || edge.to === url)

export const neighbourUrls = (edges: readonly EdgeEnds[], url: string): ReadonlySet<string> =>
  new Set(edges.map((edge) => (edge.from === url ? edge.to : edge.from)))

const sameColumnBow = (from: PlacedNode, to: PlacedNode): number => Math.min(90, 14 + Math.abs(to.y - from.y) * 0.35)

const sameColumnStart = (from: PlacedNode): number => from.x - from.radius

const sameColumnEnd = (to: PlacedNode): number => to.x - to.radius - 1.5

const BEZIER_REACH = 0.75
const STROKE_ALLOWANCE = 2

const edgeLeftReach = (from: PlacedNode, to: PlacedNode): number =>
  from.x === to.x
    ? Math.min(sameColumnStart(from), sameColumnEnd(to)) - sameColumnBow(from, to) * BEZIER_REACH - STROKE_ALLOWANCE
    : Math.min(from.x, to.x) - Math.max(from.radius, to.radius) - STROKE_ALLOWANCE

const leftmostEdgeX = (nodes: readonly PlacedNode[], edges: readonly MapEdge[]): number => {
  const byUrl = new Map(nodes.map((node) => [node.url, node]))
  return Math.min(
    Infinity,
    ...edges.flatMap((edge) => {
      const from = byUrl.get(edge.from)
      const to = byUrl.get(edge.to)
      return from && to ? [edgeLeftReach(from, to)] : []
    }),
  )
}

const edgeInset = (placement: Placement, edges: readonly MapEdge[]): number =>
  Math.max(0, Math.ceil(PAD - leftmostEdgeX(placement.nodes, edges)))

const shiftPlacement = (placement: Placement, dx: number): Placement => ({
  nodes: placement.nodes.map((node) => ({ ...node, x: node.x + dx, labelEnd: node.labelEnd + dx })),
  headers: placement.headers.map((header) => ({ ...header, x: header.x + dx })),
})

export const layoutGraph = (graph: AppGraph): GraphLayout => {
  const nodes = graph.screens.flatMap(toMapNode)
  const idToUrl = new Map(nodes.map((node) => [node.id, node.url]))
  const edges = collapseEdges(graph.navigation, idToUrl, new Set(nodes.map((node) => node.url)))
  const degree = degreeByUrl(edges)
  const columns = packColumns(groupNodes(nodes))
  const placement: Placement = { nodes: [], headers: [] }

  let x = PAD
  for (const column of columns) {
    const width = columnWidth(column)
    placeColumn(column, x + COLUMN_GAP / 2, width, degree, placement)
    x += width + COLUMN_GAP
  }

  const inset = edgeInset(placement, edges)
  const shifted = shiftPlacement(placement, inset)
  const height = Math.max(0, ...columns.map(columnHeight))
  return {
    width: Math.ceil(x + inset + PAD - COLUMN_GAP / 2),
    height: Math.ceil(height + PAD * 2),
    nodes: shifted.nodes,
    headers: shifted.headers,
    edges,
  }
}

const fixed = (value: number): string => value.toFixed(1)

const sameColumnPath = (from: PlacedNode, to: PlacedNode): string => {
  const bow = sameColumnBow(from, to)
  const startX = sameColumnStart(from)
  const endX = sameColumnEnd(to)
  return `M${fixed(startX)},${fixed(from.y)} C${fixed(startX - bow)},${fixed(from.y)} ${fixed(endX - bow)},${fixed(
    to.y,
  )} ${fixed(endX)},${fixed(to.y)}`
}

const crossColumnPath = (from: PlacedNode, to: PlacedNode): string => {
  const rightward = to.x > from.x
  const startX = rightward ? from.labelEnd : from.x - from.radius
  const endX = rightward ? to.x - to.radius - 1.5 : to.labelEnd + 1.5
  const midX = (startX + endX) / 2
  return `M${fixed(startX)},${fixed(from.y)} C${fixed(midX)},${fixed(from.y)} ${fixed(midX)},${fixed(to.y)} ${fixed(
    endX,
  )},${fixed(to.y)}`
}

const edgePath = (from: PlacedNode, to: PlacedNode): string =>
  from.x === to.x ? sameColumnPath(from, to) : crossColumnPath(from, to)

export type EdgeGeometry = MapEdge & { readonly d: string }

export const edgeGeometry = (layout: GraphLayout): readonly EdgeGeometry[] => {
  const byUrl = new Map(layout.nodes.map((node) => [node.url, node]))
  return layout.edges.flatMap((edge) => {
    const from = byUrl.get(edge.from)
    const to = byUrl.get(edge.to)
    if (!from || !to) return []
    return [{ from: edge.from, to: edge.to, dynamic: edge.dynamic, weight: edge.weight, d: edgePath(from, to) }]
  })
}
