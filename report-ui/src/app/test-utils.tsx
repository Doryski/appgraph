import type { ReactElement, ReactNode } from "react"
import type { AppGraph } from "@appgraph/core/model.js"
import { PayloadError } from "@/app/PayloadError"
import { ReportProvider } from "@/app/report-context"
import { createI18n } from "@/lib/i18n"
import { readPayload } from "@/lib/payload"
import { makeGraph, renderWithPayload } from "../../test/render"

const ReportRoot = ({ children }: { readonly children: ReactNode }) => {
  const payload = readPayload(document)
  if (payload === null) return <PayloadError />
  const i18n = createI18n(payload.strings, payload.locale === "pl" ? "pl" : "en")
  return (
    <ReportProvider payload={payload} i18n={i18n}>
      {children}
    </ReportProvider>
  )
}

type Options = Parameters<typeof renderWithPayload>[2]

export const renderInReport = (ui: ReactElement, graph: AppGraph = makeGraph(), options?: Options) =>
  renderWithPayload(<ReportRoot>{ui}</ReportRoot>, graph, options)

export const resetUrlHash = () => window.history.replaceState(null, "", window.location.pathname)
