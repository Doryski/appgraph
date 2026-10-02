import type { ScreenPayload } from "@appgraph/emit/report-payload.js"
import { GlossaryTip } from "@/components/InfoTip"
import { Badge } from "@/components/ui/badge"
import { useI18n } from "@/app/report-context"
import type { Translate } from "@/lib/i18n"
import { FilePath } from "./FilePath"

type Ancestor = ScreenPayload["ancestors"][number]

const spliceText = (ancestor: Ancestor, t: Translate): string =>
  ancestor.spliceKind === "children" ? t("spliceChildren") : ancestor.spliceLabel

export const AncestorList = ({ ancestors }: { readonly ancestors: ScreenPayload["ancestors"] }) => {
  const { t } = useI18n()
  return (
    <ol className="flex flex-col gap-2">
      {ancestors.map((ancestor, index) => (
        <li
          key={`${index}:${ancestor.file}:${ancestor.exportName}`}
          data-slot="ancestor"
          className="flex gap-3 rounded-lg border bg-background px-3 py-2"
        >
          <span
            aria-hidden
            className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums"
          >
            {index + 1}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="font-mono text-[13px] font-semibold break-all">{ancestor.exportName}</span>
            <FilePath file={ancestor.file} />
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{t("ancestorRole", { role: ancestor.role })}</Badge>
              <Badge variant="outline" className="font-mono">
                {t("ancestorSplice", { splice: spliceText(ancestor, t) })}
              </Badge>
              {index === 0 && <GlossaryTip id="splice" />}
            </span>
          </span>
        </li>
      ))}
    </ol>
  )
}
