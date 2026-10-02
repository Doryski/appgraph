import { useMemo, useState } from "react"
import { Waypoints } from "lucide-react"
import { useI18n, usePayload } from "@/app/report-context"
import { EmptyState } from "@/components/EmptyState"
import { normalizeQuery } from "@appgraph/emit/report-derive.js"
import { useUrlState } from "@/lib/url-state"
import { GraphCanvas } from "./GraphCanvas"
import { Legend } from "./Legend"
import { MapToolbar } from "./MapToolbar"
import { matchingUrls } from "./graph-model"
import type { MapGraph } from "./graph-model"
import { usePanZoom } from "./usePanZoom"

const fallbackActiveId = (graph: MapGraph, preferred: string | null): string => {
  const preferredNode = preferred === null ? undefined : graph.nodes.find((node) => node.id === preferred)
  return preferredNode?.id ?? graph.nodes[0]?.id ?? ""
}

const MapView = ({ graph }: { readonly graph: MapGraph }) => {
  const { t } = useI18n()
  const { screen } = useUrlState()
  const [query, setQuery] = useState("")
  const [chosenId, setChosenId] = useState<string | null>(null)
  const panZoom = usePanZoom(graph.width, graph.height)
  const matches = useMemo(() => matchingUrls(graph.nodes, query), [graph.nodes, query])
  const filtering = normalizeQuery(query) !== ""
  const activeId = fallbackActiveId(graph, chosenId ?? screen)

  return (
    <section data-slot="map-tab" className="flex flex-col gap-4">
      <MapToolbar
        query={query}
        onQueryChange={setQuery}
        matchCount={matches.size}
        screenCount={graph.nodes.length}
        linkCount={graph.edges.length}
        panZoom={panZoom}
      />
      {filtering && matches.size === 0 ? (
        <EmptyState
          title={t("graphFilterEmpty", { query: query.trim() })}
          onClear={() => setQuery("")}
          className="p-4 md:p-6"
        />
      ) : null}
      <GraphCanvas
        graph={graph}
        matches={matches}
        filtering={filtering}
        activeId={activeId}
        onActiveChange={setChosenId}
        panZoom={panZoom}
      />
      <Legend />
    </section>
  )
}

export const MapTab = () => {
  const { t } = useI18n()
  const { graph } = usePayload()
  if (graph.nodes.length === 0)
    return <EmptyState icon={Waypoints} title={t("graphEmpty")} description={t("graphExcludedNote")} />
  return <MapView graph={graph} />
}
