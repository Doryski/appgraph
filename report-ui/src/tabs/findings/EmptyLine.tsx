import { CircleCheck } from "lucide-react"
import type { StringKey } from "@appgraph/emit/strings.js"
import { useI18n } from "@/app/report-context"

export const EmptyLine = ({ textKey }: { readonly textKey: StringKey }) => {
  const { t } = useI18n()
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <CircleCheck aria-hidden className="size-4 shrink-0" />
      {t(textKey)}
    </p>
  )
}
