import type { ReactNode } from "react"
import { HOVER_POPOVER_TRIGGER_PROPS } from "@/components/hover-popover"
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export const TAG_TONES = {
  condition: "border-warning/40 bg-warning/5 text-warning",
  guard: "border-destructive/40 bg-destructive/5 text-destructive",
  repeated: "border-border bg-secondary text-secondary-foreground",
  via: "border-dashed border-muted-foreground/60 text-muted-foreground",
} as const

export type TagTone = keyof typeof TAG_TONES

type TagPopoverProps = {
  readonly tag: string
  readonly label: string
  readonly tone: TagTone
  readonly help: string
  readonly items?: readonly string[]
  readonly extra?: ReactNode
}

export const TagPopover = ({ tag, label, tone, help, items = [], extra }: TagPopoverProps) => (
  <Popover>
    <PopoverTrigger
      {...HOVER_POPOVER_TRIGGER_PROPS}
      data-tag={tag}
      className={cn(
        "relative inline-flex h-5 max-w-[18rem] items-center rounded-4xl border px-2 text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 after:absolute after:-inset-1 pointer-coarse:after:-inset-3",
        TAG_TONES[tone],
      )}
    >
      <span className="truncate">{label}</span>
    </PopoverTrigger>
    <PopoverContent side="top" className="w-80 max-w-[calc(100vw-2rem)] gap-2 p-3.5">
      <PopoverTitle className="text-sm font-semibold break-words">{label}</PopoverTitle>
      <PopoverDescription className="text-sm leading-relaxed">{help}</PopoverDescription>
      {extra}
      {items.length > 0 && (
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
          {items.map((item, index) => (
            <li key={`${index}:${item}`} className="rounded bg-muted px-2 py-1 font-mono text-xs break-all">
              {item}
            </li>
          ))}
        </ul>
      )}
    </PopoverContent>
  </Popover>
)
