import type { LucideIcon } from "lucide-react"
import { ArrowRight, Ban, Flag, Globe, LayoutTemplate, Lock, ShieldQuestion, Wrench } from "lucide-react"
import { screenBadges } from "@appgraph/emit/report-derive.js"
import type { ScreenBadgeId } from "@appgraph/emit/report-derive.js"
import type { ScreenPayload } from "@appgraph/emit/report-payload.js"
import { Badge } from "@/components/ui/badge"
import { GlossaryTip } from "@/components/InfoTip"
import { useI18n } from "@/app/report-context"
import type { Translate } from "@/lib/i18n"
import { cn } from "@/lib/utils"

type Auth = ScreenPayload["auth"]

const AUTH_BADGES = {
  protected: {
    icon: Lock,
    labelKey: "badgeAuthProtected",
    className: "border-success/40 bg-success/10 text-success",
  },
  public: { icon: Globe, labelKey: "badgeAuthPublic", className: "border-border text-foreground" },
  unknown: {
    icon: ShieldQuestion,
    labelKey: "badgeAuthUnknown",
    className: "border-dashed border-muted-foreground/50 text-muted-foreground",
  },
} as const satisfies Record<Auth, { readonly icon: LucideIcon; readonly labelKey: string; readonly className: string }>

export const AuthBadge = ({ auth }: { readonly auth: Auth }) => {
  const { t } = useI18n()
  const { icon: Icon, labelKey, className } = AUTH_BADGES[auth]
  return (
    <Badge variant="outline" data-auth={auth} className={className}>
      <Icon aria-hidden />
      {t(labelKey)}
    </Badge>
  )
}

type BadgeSpec = {
  readonly icon: LucideIcon
  readonly variant: "outline" | "secondary"
  readonly label: (value: string, t: Translate) => string
}

const SCREEN_BADGES = {
  redirect: { icon: ArrowRight, variant: "outline", label: (value, t) => t("badgeRedirect", { target: value }) },
  flag: { icon: Flag, variant: "secondary", label: (value, t) => t("badgeFlag", { flag: value }) },
  devOnly: { icon: Wrench, variant: "secondary", label: (_, t) => t("badgeDevOnly") },
  unaddressable: { icon: Ban, variant: "outline", label: (_, t) => t("badgeUnaddressable") },
  shell: { icon: LayoutTemplate, variant: "outline", label: (value) => value },
} as const satisfies Record<ScreenBadgeId, BadgeSpec>

type ScreenBadgesProps = {
  readonly screen: ScreenPayload
  readonly className?: string
  readonly withGlossary?: boolean
}

export const ScreenBadges = ({ screen, className, withGlossary = false }: ScreenBadgesProps) => {
  const { t } = useI18n()
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      <AuthBadge auth={screen.auth} />
      {screenBadges(screen).map(({ id, value }) => {
        const { icon: Icon, variant, label } = SCREEN_BADGES[id]
        const text = label(value ?? "", t)
        return (
          <span key={id} className="inline-flex max-w-full items-center gap-0.5">
            <Badge variant={variant} data-badge={id} className="max-w-full">
              <Icon aria-hidden />
              <span className="truncate">{text}</span>
            </Badge>
            {withGlossary && id === "shell" && <GlossaryTip id="shell" />}
          </span>
        )
      })}
    </span>
  )
}
