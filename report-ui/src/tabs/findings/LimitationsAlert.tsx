import { Info } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useI18n, usePayload } from "@/app/report-context"
import { LIMITATIONS_ANCHOR_ID } from "./config"

export const LimitationsAlert = () => {
  const { t } = useI18n()
  const { limitations } = usePayload().meta
  if (limitations.length === 0) return null
  return (
    <Alert id={LIMITATIONS_ANCHOR_ID} className="scroll-mt-4">
      <Info aria-hidden />
      <AlertTitle>{t("limitationsTitle")}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-1 ps-5">
          {limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}
