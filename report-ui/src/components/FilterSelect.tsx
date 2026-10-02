import { useId } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export type FilterSelectItem<Value extends string> = {
  readonly value: Value
  readonly label: string
}

type FilterSelectProps<Value extends string> = {
  readonly label: string
  readonly items: readonly FilterSelectItem<Value>[]
  readonly value: Value
  readonly onChange: (value: Value) => void
}

export const FilterSelect = <Value extends string>({ label, items, value, onChange }: FilterSelectProps<Value>) => {
  const id = useId()
  const handleChange = (next: unknown) => {
    const picked = items.find((item) => item.value === next)
    if (picked !== undefined) onChange(picked.value)
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select items={items} value={value} onValueChange={handleChange}>
        <SelectTrigger id={id} className="min-w-40 pointer-coarse:h-11">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
