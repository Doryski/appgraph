import { createContext, use, useMemo } from "react"
import type { ReactNode } from "react"
import type { ReportPayload } from "@appgraph/emit/report-payload.js"
import { i18n as moduleI18n } from "@/lib/i18n"
import type { I18n } from "@/lib/i18n"
import { payload as modulePayload } from "@/lib/payload"

export type Report = {
  readonly payload: ReportPayload
  readonly i18n: I18n
}

const ReportContext = createContext<Report | null>(null)

type ReportProviderProps = Report & {
  readonly children: ReactNode
}

export const ReportProvider = ({ payload, i18n, children }: ReportProviderProps) => {
  const value = useMemo(() => ({ payload, i18n }), [payload, i18n])
  return <ReportContext value={value}>{children}</ReportContext>
}

export const useI18n = (): I18n => use(ReportContext)?.i18n ?? moduleI18n

export const usePayload = (): ReportPayload => {
  const payload = use(ReportContext)?.payload ?? modulePayload
  if (payload === null) throw new Error("usePayload needs a <ReportProvider> or an embedded report payload")
  return payload
}
