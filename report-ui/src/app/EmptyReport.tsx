import { FileQuestion, SearchCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/EmptyState"
import { useI18n, usePayload } from "@/app/report-context"
import { setTab } from "@/lib/url-state"

const openFindings = () => setTab("findings")

export const EmptyReport = () => {
  const { t } = useI18n()
  const { emptyReason } = usePayload().meta
  return (
    <EmptyState
      icon={FileQuestion}
      title={t("emptyResultTitle")}
      className="mx-auto max-w-2xl py-16"
      description={
        <>
          {emptyReason !== null && (
            <span className="mb-2 block font-mono text-[13px] text-foreground">
              {t("emptyResultBody", { reason: emptyReason })}
            </span>
          )}
          <span className="block">{t("emptyResultHint")}</span>
        </>
      }
    >
      <Button type="button" variant="outline" className="pointer-coarse:h-11" onClick={openFindings}>
        <SearchCheck aria-hidden />
        {t("tabFindings")}
      </Button>
    </EmptyState>
  )
}
