import { FileQuestion } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useI18n, usePayload } from "@/app/report-context"

export const EmptyResultAlert = () => {
  const { t } = useI18n()
  const { emptyResult, emptyReason } = usePayload().meta
  if (!emptyResult) return null
  return (
    <Alert>
      <FileQuestion aria-hidden />
      <AlertTitle>{t("emptyResultTitle")}</AlertTitle>
      <AlertDescription>
        {emptyReason !== null && <p className="font-mono text-[13px]">{t("emptyResultBody", { reason: emptyReason })}</p>}
        <p>{t("emptyResultHint")}</p>
      </AlertDescription>
    </Alert>
  )
}
