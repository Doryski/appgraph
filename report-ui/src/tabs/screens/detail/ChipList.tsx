import { CopyButton } from "@/components/CopyButton"

type ChipListProps = {
  readonly values: readonly string[]
  readonly copyable?: boolean
}

export const ChipList = ({ values, copyable = false }: ChipListProps) => (
  <ul className="flex flex-wrap gap-1.5">
    {values.map((value, index) => (
      <li
        key={`${index}:${value}`}
        data-slot="chip"
        className="inline-flex max-w-full items-center gap-0.5 rounded-md border bg-muted/40 py-0.5 ps-2 pe-0.5 font-mono text-xs"
      >
        <span className="min-w-0 break-all py-0.5 pe-1.5">{value}</span>
        {copyable && <CopyButton value={value} what={value} className="shrink-0" />}
      </li>
    ))}
  </ul>
)
