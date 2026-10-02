import { Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/app/report-context"
import { copyWithToast } from "@/lib/clipboard"
import { cn } from "@/lib/utils"

type CopyButtonProps = {
  readonly value: string
  readonly what: string
  readonly className?: string
}

export const CopyButton = ({ value, what, className }: CopyButtonProps) => {
  const { t } = useI18n()
  const copy = () => {
    void copyWithToast(value, { success: t("copied"), failure: t("copyFailed") })
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={t("copyLabel", { what })}
      onClick={copy}
      className={cn(
        "relative text-muted-foreground hover:text-foreground after:absolute after:-inset-1.5 pointer-coarse:after:-inset-2.5",
        className,
      )}
    >
      <Copy aria-hidden />
    </Button>
  )
}
