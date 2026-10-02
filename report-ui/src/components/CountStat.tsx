import { TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"
import { statNoun } from "@/config/stats"
import { InfoTip, InfoTipLabel } from "@/components/InfoTip"
import { cn } from "@/lib/utils"

type CountStatProps = {
  readonly id: string
  readonly label: string
  readonly countText?: string
  readonly help: string
  readonly value: number
  readonly alarm: boolean
  readonly onActivate?: () => void
}

type ReadoutProps = {
  readonly label: string
  readonly value: number
  readonly alarm: boolean
  readonly decorative: boolean
  readonly tip: ReactNode
}

const Readout = ({ label, value, alarm, decorative, tip }: ReadoutProps) => (
  <div className="pointer-events-none relative flex flex-col items-start gap-1">
    <span
      aria-hidden={decorative || undefined}
      className="flex items-center gap-1.5 font-mono text-lg leading-none font-semibold tabular-nums tracking-tight sm:text-xl md:text-2xl"
    >
      {alarm && <TriangleAlert aria-hidden className="size-4 shrink-0 md:size-5" />}
      {value}
    </span>
    <InfoTipLabel className="text-xs leading-tight" tip={<span className="pointer-events-auto">{tip}</span>}>
      <span aria-hidden={decorative || undefined} className={cn("break-words", alarm ? "font-medium" : "text-muted-foreground")}>
        {label}
      </span>
    </InfoTipLabel>
  </div>
)

const ActionOverlay = ({ onActivate, name }: { readonly onActivate: () => void; readonly name: string }) => (
  <button
    type="button"
    aria-label={name}
    onClick={onActivate}
    className="absolute -inset-x-1.5 -inset-y-1 rounded-md bg-destructive/8 outline-none hover:bg-destructive/15 focus-visible:ring-3 focus-visible:ring-destructive/40"
  />
)

export const CountStat = ({ id, label, countText, help, value, alarm, onActivate }: CountStatProps) => {
  const actionable = alarm && onActivate !== undefined
  return (
    <div
      data-slot="count-stat"
      data-stat-id={id}
      data-alarm={alarm || undefined}
      className={cn("relative min-w-0", alarm && "text-destructive")}
    >
      {actionable && <ActionOverlay onActivate={onActivate} name={countText ?? `${value} ${label}`} />}
      <Readout
        label={countText ? statNoun(countText, value) : label}
        value={value}
        alarm={alarm}
        decorative={actionable}
        tip={<InfoTip term={label} help={help} />}
      />
    </div>
  )
}
