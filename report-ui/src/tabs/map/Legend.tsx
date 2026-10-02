import type { ReactNode } from "react"
import type { StringKey } from "@appgraph/emit/strings.js"
import { useI18n } from "@/app/report-context"
import { cn } from "@/lib/utils"
import { DASH, EDGE_TONE, MARKER_TONE } from "./tones"
import type { Tone } from "./tones"

type Swatch = "node" | "protected" | "unknown" | "edge" | "dynamic" | "out" | "in"

const LEGEND_ITEMS = [
  { swatch: "node", labelKey: "legendNode" },
  { swatch: "protected", labelKey: "legendNodeAuth" },
  { swatch: "unknown", labelKey: "legendAuthUnknown" },
  { swatch: "edge", labelKey: "legendEdge" },
  { swatch: "dynamic", labelKey: "legendDynamic" },
  { swatch: "out", labelKey: "legendOutgoing" },
  { swatch: "in", labelKey: "legendIncoming" },
] as const satisfies readonly { swatch: Swatch; labelKey: StringKey }[]

const LEGEND_NOTES = ["legendLayout", "legendClick", "graphExcludedNote"] as const satisfies readonly StringKey[]

const NodeSwatch = ({ ring }: { readonly ring: "none" | "protected" | "unknown" }) => (
  <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden>
    {ring === "protected" ? (
      <circle cx="8" cy="8" r="6.5" className="fill-none stroke-emerald-600 dark:stroke-emerald-400" strokeWidth={1.5} />
    ) : null}
    {ring === "unknown" ? (
      <circle cx="8" cy="8" r="6.5" className="fill-none stroke-muted-foreground" strokeWidth={1.25} strokeDasharray={DASH.unknownRing} />
    ) : null}
    <circle cx="8" cy="8" r="4" className="fill-muted-foreground" />
  </svg>
)

const LineSwatch = ({ tone, dash, bold }: { readonly tone: Tone; readonly dash?: string; readonly bold?: boolean }) => (
  <svg viewBox="0 0 28 10" className="h-2.5 w-7 shrink-0" aria-hidden>
    <line
      x1="1"
      y1="5"
      x2="21"
      y2="5"
      className={EDGE_TONE[tone]}
      strokeWidth={bold ? 1.75 : 1.25}
      strokeLinecap="round"
      strokeDasharray={dash}
    />
    <path d="M20,1 L27,5 L20,9 z" className={MARKER_TONE[tone]} />
  </svg>
)

const SWATCHES: Readonly<Record<Swatch, ReactNode>> = {
  node: <NodeSwatch ring="none" />,
  protected: <NodeSwatch ring="protected" />,
  unknown: <NodeSwatch ring="unknown" />,
  edge: <LineSwatch tone="base" />,
  dynamic: <LineSwatch tone="base" dash={DASH.dynamic} />,
  out: <LineSwatch tone="out" bold />,
  in: <LineSwatch tone="in" dash={DASH.incoming} bold />,
}

export const Legend = ({ className }: { readonly className?: string }) => {
  const { t } = useI18n()
  return (
    <div data-slot="map-legend" className={cn("flex flex-col gap-2 text-xs text-muted-foreground", className)}>
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {LEGEND_ITEMS.map((item) => (
          <li key={item.swatch} data-legend={item.swatch} className="inline-flex items-center gap-2">
            {SWATCHES[item.swatch]}
            <span>{t(item.labelKey)}</span>
          </li>
        ))}
      </ul>
      {LEGEND_NOTES.map((key) => (
        <p key={key} className="max-w-prose leading-relaxed">
          {t(key)}
        </p>
      ))}
    </div>
  )
}
