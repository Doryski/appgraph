import { useId } from "react"
import type { KeyboardEvent, ReactNode, Ref } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

type FilterInputProps = {
  readonly label: string
  readonly placeholder: string
  readonly value: string
  readonly onValueChange: (value: string) => void
  readonly inputRef?: Ref<HTMLInputElement>
  readonly hint?: ReactNode
  readonly className?: string
}

export const FilterInput = ({ label, placeholder, value, onValueChange, inputRef, hint, className }: FilterInputProps) => {
  const id = useId()
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return
    if (value === "") {
      event.currentTarget.blur()
      return
    }
    event.preventDefault()
    onValueChange("")
  }
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {hint}
      </div>
      <Input
        id={id}
        ref={inputRef}
        type="search"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
        className="pointer-coarse:h-11"
      />
    </div>
  )
}
