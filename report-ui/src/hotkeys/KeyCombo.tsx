import { Fragment } from "react"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { formatKeyParts } from "@/hotkeys/useAppHotkeys"

type KeyComboProps = {
  readonly keys: string
  readonly className?: string
}

export const KeyCombo = ({ keys, className }: KeyComboProps) => (
  <KbdGroup className={className}>
    {formatKeyParts(keys).map((part) => (
      <Kbd key={part} className="min-w-6 border border-b-2 bg-background font-mono text-foreground">
        {part}
      </Kbd>
    ))}
  </KbdGroup>
)

type KeyListProps = {
  readonly keys: readonly string[]
  readonly separator: string
}

export const KeyList = ({ keys, separator }: KeyListProps) => (
  <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
    {keys.map((key, index) => (
      <Fragment key={key}>
        {index > 0 && <span className="text-xs text-muted-foreground">{separator}</span>}
        <KeyCombo keys={key} />
      </Fragment>
    ))}
  </span>
)
