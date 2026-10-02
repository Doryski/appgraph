import type { RedirectAlternative, RedirectResolution } from "@appgraph/core/model.js"
import { useI18n } from "@/app/report-context"
import type { Translate } from "@/lib/i18n"

type RedirectVia = Pick<RedirectResolution, "from" | "to" | "condition" | "alternatives">

type ViaRedirectNoteProps = {
  readonly id?: string
  readonly via: RedirectVia | undefined
}

const ALTERNATIVE_SEPARATOR = " · "

const alternativesText = (t: Translate, from: string, alternatives: readonly RedirectAlternative[]): string =>
  t("navViaRedirectAlternatives", {
    from,
    targets: alternatives.map((alternative) => t("navRedirectAlternative", alternative)).join(ALTERNATIVE_SEPARATOR),
  })

const redirectText = (t: Translate, { from, to, condition, alternatives }: RedirectVia): string => {
  if (alternatives !== undefined && alternatives.length > 1) return alternativesText(t, from, alternatives)
  return condition === undefined ? t("navViaRedirect", { from, to }) : t("navViaRedirectWhen", { from, to, condition })
}

export const ViaRedirectNote = ({ via, id }: ViaRedirectNoteProps) => {
  const { t } = useI18n()
  if (via === undefined) return null
  return (
    <span
      id={id}
      data-slot="via-redirect"
      className="min-w-0 max-w-full rounded border px-1.5 py-0.5 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]"
    >
      {redirectText(t, via)}
    </span>
  )
}
