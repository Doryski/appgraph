import type { ScreenPayload } from "@appgraph/emit/report-payload.js"
import { Badge } from "@/components/ui/badge"

type ActivationListProps = {
  readonly activations: ScreenPayload["activations"]
}

export const ActivationList = ({ activations }: ActivationListProps) => (
  <ul className="flex flex-col gap-2">
    {activations.map((activation, index) => (
      <li
        key={`${index}:${activation.kind}`}
        data-slot="activation"
        className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2"
      >
        <Badge variant="secondary">{activation.kindLabel}</Badge>
        <span className="min-w-0 break-all font-mono text-xs">{activation.label}</span>
      </li>
    ))}
  </ul>
)
