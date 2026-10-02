import type { StringKey } from "@appgraph/emit/strings.js"
import type { LucideIcon } from "lucide-react"
import { Maximize, ZoomIn, ZoomOut } from "lucide-react"
import { useI18n } from "@/app/report-context"
import { Button } from "@/components/ui/button"
import { FilterInput } from "@/components/FilterInput"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { searchInputRef } from "@/hotkeys/search-registry"
import { normalizeQuery } from "@appgraph/emit/report-derive.js"
import type { PanZoom } from "./usePanZoom"

const mapSearchRef = searchInputRef("map")

type ZoomAction = "zoomOut" | "fit" | "zoomIn"

const ZOOM_BUTTONS = [
  { action: "zoomOut", labelKey: "graphZoomOut", icon: ZoomOut },
  { action: "fit", labelKey: "graphZoomFit", icon: Maximize },
  { action: "zoomIn", labelKey: "graphZoomIn", icon: ZoomIn },
] as const satisfies readonly { action: ZoomAction; labelKey: StringKey; icon: LucideIcon }[]

const isDisabled = (action: ZoomAction, panZoom: PanZoom): boolean => {
  if (action === "zoomIn") return !panZoom.canZoomIn
  if (action === "zoomOut") return !panZoom.canZoomOut
  return panZoom.fitted
}

type ZoomButtonProps = {
  readonly config: (typeof ZOOM_BUTTONS)[number]
  readonly panZoom: PanZoom
}

const ZoomButton = ({ config, panZoom }: ZoomButtonProps) => {
  const { t } = useI18n()
  const Icon = config.icon
  const label = t(config.labelKey)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-zoom={config.action}
            disabled={isDisabled(config.action, panZoom)}
            onClick={panZoom[config.action]}
            className="pointer-coarse:h-11 pointer-coarse:min-w-11"
          />
        }
      >
        <Icon aria-hidden />
        <span className="max-sm:sr-only">{label}</span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

type MapToolbarProps = {
  readonly query: string
  readonly onQueryChange: (query: string) => void
  readonly matchCount: number
  readonly screenCount: number
  readonly linkCount: number
  readonly panZoom: PanZoom
}

export const MapToolbar = ({ query, onQueryChange, matchCount, screenCount, linkCount, panZoom }: MapToolbarProps) => {
  const { t, tPlural } = useI18n()
  const filtering = normalizeQuery(query) !== ""

  return (
    <div data-slot="map-toolbar" className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <FilterInput
        label={t("graphFilterLabel")}
        placeholder={t("graphFilterExample")}
        value={query}
        onValueChange={onQueryChange}
        inputRef={mapSearchRef}
        className="min-w-[min(100%,16rem)] max-w-sm flex-1"
      />
      <p
        data-slot="map-match-count"
        aria-live="polite"
        aria-atomic="true"
        className="min-h-5 pb-2 text-sm font-medium tabular-nums empty:hidden"
      >
        {filtering ? tPlural("graphFilterMatches", matchCount) : ""}
      </p>
      <p data-slot="map-summary" className="pb-2 text-sm text-muted-foreground tabular-nums sm:ms-auto">
        {tPlural("graphSummaryScreens", screenCount)} · {tPlural("graphSummaryLinks", linkCount)}
      </p>
      <div className="flex items-center gap-1.5">
        {ZOOM_BUTTONS.map((config) => (
          <ZoomButton key={config.action} config={config} panZoom={panZoom} />
        ))}
      </div>
    </div>
  )
}
