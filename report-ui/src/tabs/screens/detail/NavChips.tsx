import { useId } from "react"
import { Info } from "lucide-react"
import type { ScreenPayload } from "@appgraph/emit/report-payload.js"
import { Button } from "@/components/ui/button"
import { HOVER_POPOVER_TRIGGER_PROPS } from "@/components/hover-popover"
import { ViaRedirectNote } from "@/components/ViaRedirectNote"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useI18n } from "@/app/report-context"
import { selectScreen } from "@/lib/url-state"

type NavChip = ScreenPayload["navChips"][number]

const DynamicMark = () => {
  const { t } = useI18n()
  return (
    <>
      <span aria-hidden data-slot="dynamic-mark" className="ms-0.5 font-semibold text-warning">
        *
      </span>
      <span className="sr-only">{t("legendDynamic")}</span>
    </>
  )
}

type ChipTargetProps = {
  readonly chip: NavChip
  readonly describedBy: string | undefined
}

const ChipTarget = ({ chip, describedBy }: ChipTargetProps) => {
  const label = (
    <>
      <span className="break-all">{chip.to}</span>
      {chip.dynamic && <DynamicMark />}
    </>
  )
  if (chip.matchedRoute === null) return <span className="px-2 py-1 font-mono text-xs">{label}</span>
  const target = chip.matchedRoute
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      data-goto={target}
      aria-describedby={describedBy}
      onClick={() => selectScreen(target, "push")}
      className="h-auto min-h-6 whitespace-normal py-1 text-start font-mono pointer-coarse:min-h-11"
    >
      {label}
    </Button>
  )
}

const SourcesPopover = ({ chip }: { readonly chip: NavChip }) => {
  const { t, tPlural } = useI18n()
  const count = chip.sources.length
  return (
    <Popover>
      <PopoverTrigger
        {...HOVER_POPOVER_TRIGGER_PROPS}
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={count > 1 ? tPlural("navChipSourcesPlural", count) : (chip.sources[0] ?? t("deadLinkColSource"))}
            className="h-auto min-h-6 self-stretch rounded-s-none border-s px-1.5 text-muted-foreground tabular-nums pointer-coarse:min-w-11"
          />
        }
      >
        {count > 1 ? <span data-slot="chip-count">×{count}</span> : <Info aria-hidden />}
      </PopoverTrigger>
      <PopoverContent side="top" className="w-80 max-w-[calc(100vw-2rem)] gap-2 p-3.5">
        {chip.dynamic && <p className="text-sm text-muted-foreground">* {t("legendDynamic")}</p>}
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
          {chip.sources.map((source) => (
            <li key={source} className="rounded bg-muted px-2 py-1 font-mono text-xs break-all">
              {source}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

const NavChipItem = ({ chip }: { readonly chip: NavChip }) => {
  const noteId = useId()
  return (
    <li data-slot="nav-chip" className="inline-flex max-w-full flex-wrap items-stretch rounded-md border bg-background">
      <ChipTarget chip={chip} describedBy={chip.viaRedirect === undefined ? undefined : noteId} />
      <ViaRedirectNote id={noteId} via={chip.viaRedirect} />
      <SourcesPopover chip={chip} />
    </li>
  )
}

export const NavChips = ({ chips }: { readonly chips: ScreenPayload["navChips"] }) => (
  <ul className="flex flex-wrap gap-1.5">
    {chips.map((chip, index) => (
      <NavChipItem key={`${index}:${chip.to}:${chip.matchedRoute ?? ""}`} chip={chip} />
    ))}
  </ul>
)
