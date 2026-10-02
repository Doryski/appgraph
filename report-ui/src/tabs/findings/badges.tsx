import { CircleAlert, CircleCheck, CircleDashed, CircleMinus, Info, TriangleAlert } from "lucide-react"
import type { ConfidenceStatus } from "@appgraph/core/confidence.js"
import type { Severity } from "@appgraph/core/model.js"
import { Badge } from "@/components/ui/badge"
import { useI18n } from "@/app/report-context"
import { CONFIDENCE_LABEL_KEYS, SEVERITY_BADGE_LABEL_KEYS } from "./config"

const SEVERITY_BADGES = {
  error: { icon: CircleAlert, variant: "destructive", className: "" },
  warning: { icon: TriangleAlert, variant: "warning", className: "" },
  info: { icon: Info, variant: "secondary", className: "" },
} as const satisfies Record<Severity, unknown>

const CONFIDENCE_BADGES = {
  ok: { icon: CircleCheck, variant: "secondary", className: "" },
  partial: { icon: CircleDashed, variant: "warning", className: "" },
  "empty-expected": { icon: CircleMinus, variant: "outline", className: "text-muted-foreground" },
  "empty-unexpected": { icon: TriangleAlert, variant: "destructive", className: "" },
} as const satisfies Record<ConfidenceStatus, unknown>

export const SeverityBadge = ({ severity }: { readonly severity: Severity }) => {
  const { t } = useI18n()
  const { icon: Icon, variant, className } = SEVERITY_BADGES[severity]
  return (
    <Badge variant={variant} className={className}>
      <Icon aria-hidden />
      {t(SEVERITY_BADGE_LABEL_KEYS[severity])}
    </Badge>
  )
}

export const ConfidenceBadge = ({ status }: { readonly status: ConfidenceStatus }) => {
  const { t } = useI18n()
  const { icon: Icon, variant, className } = CONFIDENCE_BADGES[status]
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge variant={variant} className={className}>
        <Icon aria-hidden />
        {t(CONFIDENCE_LABEL_KEYS[status])}
      </Badge>
      {status === "empty-unexpected" && (
        <span className="text-xs font-medium text-destructive">{t("confidenceSuspectFlag")}</span>
      )}
    </span>
  )
}
