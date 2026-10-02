import type { LucideIcon } from "lucide-react"
import { SearchX } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { useI18n } from "@/app/report-context"
import { cn } from "@/lib/utils"

type EmptyStateProps = {
  readonly title: string
  readonly description?: ReactNode
  readonly icon?: LucideIcon
  readonly onClear?: () => void
  readonly children?: ReactNode
  readonly className?: string
}

export const EmptyState = ({ title, description, icon: Icon = SearchX, onClear, children, className }: EmptyStateProps) => {
  const { t } = useI18n()
  const hasContent = onClear !== undefined || children !== undefined
  return (
    <Empty role="status" className={cn("border border-dashed bg-muted/20", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description !== undefined && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {hasContent && (
        <EmptyContent>
          {children}
          {onClear && (
            <Button type="button" variant="outline" className="pointer-coarse:h-11" onClick={onClear}>
              {t("filterClear")}
            </Button>
          )}
        </EmptyContent>
      )}
    </Empty>
  )
}
