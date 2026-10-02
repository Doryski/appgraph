import { memo, useId, useMemo, useRef, useState } from "react"
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from "react"
import { degreeByUrl, edgesTouching, neighbourUrls } from "@appgraph/emit/html-graph.js"
import { useI18n } from "@/app/report-context"
import { selectScreen } from "@/lib/url-state"
import { cn } from "@/lib/utils"
import {
  ROW_HEIGHT,
  LABEL_OFFSET,
  edgeTouchesAny,
  isNavKey,
  labelWidth,
  nextNode,
  nodeTooltip,
} from "./graph-model"
import type { AuthState, MapEdge, MapGraph, MapHeader, MapNode } from "./graph-model"
import { DASH, EDGE_TONE, MARKER_TONE, TONES } from "./tones"
import type { Tone } from "./tones"
import type { PanZoom } from "./usePanZoom"

const EDGE_OPACITY = { idle: 0.55, match: 0.6, faded: 0.08 } as const
const HIGHLIGHT_BASE_OPACITY = 0.15
const ACTIVATE_KEYS: ReadonlySet<string> = new Set(["Enter", " "])

type MarkerIds = Readonly<Record<Tone, string>>

type NodeState = "idle" | "focus" | "near" | "match" | "dim"

const fixed = (value: number): number => Number(value.toFixed(1))

const useMarkerIds = (): MarkerIds => {
  const prefix = `map${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  return { base: `${prefix}-arrow`, out: `${prefix}-arrow-out`, in: `${prefix}-arrow-in` }
}

const markerUrl = (id: string): string => `url(#${id})`

const Markers = ({ ids }: { readonly ids: MarkerIds }) => (
  <defs>
    {TONES.map((tone) => (
      <marker
        key={tone}
        id={ids[tone]}
        viewBox="0 0 8 8"
        refX="7"
        refY="4"
        markerWidth="6"
        markerHeight="6"
        orient="auto"
      >
        <path className={MARKER_TONE[tone]} d="M0,0 L8,4 L0,8 z" />
      </marker>
    ))}
  </defs>
)

const baseEdgeOpacity = (edge: MapEdge, filtering: boolean, matches: ReadonlySet<string>): number => {
  if (!filtering) return EDGE_OPACITY.idle
  return edgeTouchesAny(edge, matches) ? EDGE_OPACITY.match : EDGE_OPACITY.faded
}

type BaseEdgesProps = {
  readonly edges: readonly MapEdge[]
  readonly filtering: boolean
  readonly matches: ReadonlySet<string>
  readonly markerId: string
}

const BaseEdges = memo(({ edges, filtering, matches, markerId }: BaseEdgesProps) => (
  <>
    {edges.map((edge) => (
      <path
        key={`${edge.from}\u0000${edge.to}`}
        data-from={edge.from}
        data-to={edge.to}
        data-weight={edge.weight}
        d={edge.d}
        className={cn("fill-none transition-opacity", EDGE_TONE.base)}
        strokeWidth={1}
        strokeDasharray={edge.dynamic ? DASH.dynamic : undefined}
        opacity={baseEdgeOpacity(edge, filtering, matches)}
        markerEnd={markerUrl(markerId)}
      />
    ))}
  </>
))

type HighlightEdgesProps = {
  readonly edges: readonly MapEdge[]
  readonly url: string
  readonly ids: MarkerIds
}

const HighlightEdges = ({ edges, url, ids }: HighlightEdgesProps) =>
  edges.map((edge) => {
    const tone = edge.from === url ? "out" : "in"
    return (
      <path
        key={`${edge.from}\u0000${edge.to}`}
        data-direction={tone}
        d={edge.d}
        className={cn("fill-none", EDGE_TONE[tone])}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeDasharray={tone === "in" ? DASH.incoming : undefined}
        markerEnd={markerUrl(ids[tone])}
      />
    )
  })

const Headers = memo(({ headers }: { readonly headers: readonly MapHeader[] }) => (
  <>
    {headers.map((header) => (
      <g key={`${header.key}@${header.x},${header.y}`} data-slot="map-group-header">
        <text
          x={fixed(header.x - 6)}
          y={fixed(header.y + 14)}
          className="fill-foreground font-mono text-[12px] font-bold"
        >
          {header.key}
          <tspan dx="8" className="fill-muted-foreground text-xs font-normal">
            {header.continued ? "…" : header.count}
          </tspan>
        </text>
        <line
          x1={fixed(header.x - 6)}
          x2={fixed(header.x + header.width - 20)}
          y1={fixed(header.y + 22)}
          y2={fixed(header.y + 22)}
          className="stroke-border"
          strokeWidth={1}
        />
      </g>
    ))}
  </>
))

const AuthRing = ({ node }: { readonly node: MapNode }) => {
  if (node.auth === "protected")
    return (
      <circle
        data-auth="protected"
        cx={fixed(node.x)}
        cy={fixed(node.y)}
        r={fixed(node.radius + 2.5)}
        className="fill-none stroke-emerald-600 dark:stroke-emerald-400"
        strokeWidth={1.5}
      />
    )
  if (node.auth === "unknown")
    return (
      <circle
        data-auth="unknown"
        cx={fixed(node.x)}
        cy={fixed(node.y)}
        r={fixed(node.radius + 2.5)}
        className="fill-none stroke-muted-foreground"
        strokeWidth={1.25}
        strokeDasharray={DASH.unknownRing}
      />
    )
  return null
}

const NODE_GROUP_CLASS: Readonly<Record<NodeState, string>> = {
  idle: "",
  focus: "",
  near: "",
  match: "",
  dim: "opacity-30",
}

const isAccented = (state: NodeState): boolean => state === "focus" || state === "match"

type NodeViewProps = {
  readonly node: MapNode
  readonly state: NodeState
  readonly active: boolean
  readonly label: string
  readonly tooltip: string
}

const NodeView = memo(({ node, state, active, label, tooltip }: NodeViewProps) => (
  <g
    data-node-id={node.id}
    data-node-url={node.url}
    data-state={state}
    role="button"
    tabIndex={active ? 0 : -1}
    aria-label={label}
    className={cn("group cursor-pointer outline-none transition-opacity", NODE_GROUP_CLASS[state])}
  >
    <title>{tooltip}</title>
    <rect
      x={fixed(node.x - 10)}
      y={fixed(node.y - ROW_HEIGHT / 2)}
      width={fixed(labelWidth(node.url) + 14)}
      height={ROW_HEIGHT}
      rx={5}
      className="fill-transparent group-hover:fill-sky-500/10 group-focus-visible:fill-sky-500/15 group-focus-visible:stroke-sky-600 group-focus-visible:[stroke-width:1.5] dark:group-focus-visible:stroke-sky-400"
    />
    <AuthRing node={node} />
    <circle
      cx={fixed(node.x)}
      cy={fixed(node.y)}
      r={fixed(node.radius)}
      className={cn(
        "stroke-background",
        isAccented(state) ? "fill-sky-600 dark:fill-sky-400" : "fill-muted-foreground",
      )}
      strokeWidth={2}
    />
    <text
      x={fixed(node.x + LABEL_OFFSET)}
      y={fixed(node.y)}
      dominantBaseline="central"
      className={cn(
        "font-mono text-xs",
        state === "focus" ? "fill-sky-700 font-bold dark:fill-sky-300" : "fill-foreground",
      )}
    >
      {node.prefix.length > 0 ? (
        <tspan className="fill-muted-foreground">{node.prefix}</tspan>
      ) : null}
      {node.url.slice(node.prefix.length)}
    </text>
  </g>
))

const nodeStateOf = (
  url: string,
  highlighted: string | null,
  near: ReadonlySet<string>,
  filtering: boolean,
  matches: ReadonlySet<string>,
): NodeState => {
  if (highlighted !== null) {
    if (url === highlighted) return "focus"
    return near.has(url) ? "near" : "dim"
  }
  if (!filtering) return "idle"
  return matches.has(url) ? "match" : "dim"
}

const AUTH_LABEL_KEY = { protected: "legendNodeAuth", unknown: "badgeAuthUnknown", public: null } as const

const useNodeLabels = (graph: MapGraph) => {
  const { t } = useI18n()
  return useMemo(() => {
    const degree = degreeByUrl(graph.edges)
    const authText = (auth: AuthState) => {
      const key = AUTH_LABEL_KEY[auth]
      return key === null ? null : t(key)
    }
    return new Map(
      graph.nodes.map((node) => {
        const tooltip = nodeTooltip(node)
        const auth = authText(node.auth)
        const base = t("graphNodeLabel", { title: tooltip, count: degree.get(node.url) ?? 0 })
        return [
          node.id,
          {
            label: auth === null ? base : `${base}, ${auth}`,
            tooltip: auth === null ? tooltip : `${tooltip} (${auth})`,
          },
        ] as const
      }),
    )
  }, [graph, t])
}

const nodeElementOf = (target: EventTarget | null): SVGGElement | null =>
  target instanceof Element ? target.closest<SVGGElement>("g[data-node-id]") : null

type GraphCanvasProps = {
  readonly graph: MapGraph
  readonly matches: ReadonlySet<string>
  readonly filtering: boolean
  readonly activeId: string
  readonly onActiveChange: (id: string) => void
  readonly panZoom: PanZoom
}

export const GraphCanvas = ({ graph, matches, filtering, activeId, onActiveChange, panZoom }: GraphCanvasProps) => {
  const { t } = useI18n()
  const markerIds = useMarkerIds()
  const labels = useNodeLabels(graph)
  const nodesLayerRef = useRef<SVGGElement | null>(null)
  const [hoverUrl, setHoverUrl] = useState<string | null>(null)
  const [focusUrl, setFocusUrl] = useState<string | null>(null)
  const highlighted = hoverUrl ?? focusUrl
  const touching = useMemo(() => edgesTouching(graph.edges, highlighted), [graph.edges, highlighted])
  const near = useMemo(
    () => (highlighted === null ? new Set<string>() : neighbourUrls(touching, highlighted)),
    [touching, highlighted],
  )
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes])

  const focusNodeElement = (id: string) => {
    const layer = nodesLayerRef.current
    if (layer === null) return
    const element = Array.from(layer.querySelectorAll<SVGGElement>("g[data-node-id]")).find(
      (candidate) => candidate.dataset.nodeId === id,
    )
    element?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    const element = nodeElementOf(event.target)
    const id = element?.dataset.nodeId
    if (id === undefined) return
    if (ACTIVATE_KEYS.has(event.key)) {
      event.preventDefault()
      selectScreen(id, "push")
      return
    }
    if (!isNavKey(event.key)) return
    event.preventDefault()
    const next = nextNode(graph.nodes, id, event.key)
    if (next === undefined) return
    onActiveChange(next.id)
    focusNodeElement(next.id)
  }

  const handleClick = (event: MouseEvent<SVGGElement>) => {
    const id = nodeElementOf(event.target)?.dataset.nodeId
    if (id === undefined) return
    selectScreen(id, "push")
  }

  const handleFocus = (event: FocusEvent<SVGGElement>) => {
    const id = nodeElementOf(event.target)?.dataset.nodeId
    const node = id === undefined ? undefined : nodeById.get(id)
    if (node === undefined) return
    onActiveChange(node.id)
    setFocusUrl(node.url)
    panZoom.reveal(node.x, node.y)
  }

  const handleBlur = () => setFocusUrl(null)

  const handlePointerOver = (event: PointerEvent<SVGGElement>) => {
    if (panZoom.isDragging()) return
    const url = nodeElementOf(event.target)?.dataset.nodeUrl
    if (url !== undefined) setHoverUrl(url)
  }

  const handlePointerOut = (event: PointerEvent<SVGGElement>) => {
    const from = nodeElementOf(event.target)
    if (from !== null && from === nodeElementOf(event.relatedTarget)) return
    setHoverUrl(null)
  }

  return (
    <div
      data-slot="map-canvas"
      className="relative overflow-hidden rounded-xl border bg-background bg-[radial-gradient(var(--color-border)_1px,transparent_1.2px)] [background-size:18px_18px]"
    >
      <svg
        {...panZoom.svgProps}
        viewBox={panZoom.viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={t("graphSvgLabel")}
        data-panning={panZoom.panning}
        data-highlighting={highlighted !== null}
        className={cn(
          "block min-h-72 w-full touch-none select-none",
          panZoom.panning ? "cursor-grabbing" : "cursor-grab",
        )}
        style={{ aspectRatio: `${graph.width} / ${graph.height}`, maxHeight: `min(75vh, ${graph.height}px)` }}
      >
        <Markers ids={markerIds} />
        <g data-layer="edges" aria-hidden opacity={highlighted === null ? 1 : HIGHLIGHT_BASE_OPACITY}>
          <BaseEdges edges={graph.edges} filtering={filtering} matches={matches} markerId={markerIds.base} />
        </g>
        <g data-layer="headers">
          <Headers headers={graph.headers} />
        </g>
        <g data-layer="highlight" aria-hidden className="pointer-events-none">
          {highlighted === null ? null : <HighlightEdges edges={touching} url={highlighted} ids={markerIds} />}
        </g>
        <g
          ref={nodesLayerRef}
          data-layer="nodes"
          onKeyDown={handleKeyDown}
          onClick={handleClick}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onPointerOver={handlePointerOver}
          onPointerOut={handlePointerOut}
        >
          {graph.nodes.map((node) => (
            <NodeView
              key={node.id}
              node={node}
              state={nodeStateOf(node.url, highlighted, near, filtering, matches)}
              active={node.id === activeId}
              label={labels.get(node.id)?.label ?? node.url}
              tooltip={labels.get(node.id)?.tooltip ?? node.url}
            />
          ))}
        </g>
      </svg>
    </div>
  )
}
