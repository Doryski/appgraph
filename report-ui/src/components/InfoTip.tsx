import { CircleHelp } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { HOVER_POPOVER_TRIGGER_PROPS } from "@/components/hover-popover"
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { useI18n } from "@/app/report-context"
import { glossaryTerm } from "@/config/glossary"
import type { GlossaryTermId } from "@/config/glossary"
import { cn } from "@/lib/utils"

type InfoTipProps = {
  readonly term: string
  readonly help: string
  readonly className?: string
}

export const InfoTip = ({ term, help, className }: InfoTipProps) => {
  const { t } = useI18n()
  return (
    <Popover>
      <PopoverTrigger
        {...HOVER_POPOVER_TRIGGER_PROPS}
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("infoTipLabel", { term })}
            className={cn(
              "relative rounded-full text-muted-foreground hover:text-foreground data-popup-open:text-foreground after:absolute after:-inset-1.5 pointer-coarse:after:-inset-2.5",
              className,
            )}
          />
        }
      >
        <CircleHelp aria-hidden />
      </PopoverTrigger>
      <PopoverContent side="top" className="w-72 max-w-[calc(100vw-2rem)] gap-1.5 p-3.5">
        <PopoverTitle className="text-sm font-semibold first-letter:uppercase">{term}</PopoverTitle>
        <PopoverDescription className="text-sm leading-relaxed">{help}</PopoverDescription>
      </PopoverContent>
    </Popover>
  )
}

type GlossaryTipProps = {
  readonly id: GlossaryTermId
  readonly className?: string
}

export const GlossaryTip = ({ id, className }: GlossaryTipProps) => {
  const { t } = useI18n()
  const entry = glossaryTerm(id)
  if (!entry) return null
  return <InfoTip term={t(entry.labelKey)} help={t(entry.helpKey)} className={className} />
}

type InfoTipLabelProps = {
  readonly children: ReactNode
  readonly tip: ReactNode
  readonly className?: string
}

export const InfoTipLabel = ({ children, tip, className }: InfoTipLabelProps) => (
  <span data-slot="info-tip-label" className={cn("block pe-6.5 *:first:inline", className)}>
    {children}
    {tip && (
      <span className="-my-1 inline-flex w-0 align-middle">
        <span className="ms-0.5 inline-flex">{tip}</span>
      </span>
    )}
  </span>
)
