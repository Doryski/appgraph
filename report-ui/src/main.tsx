import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { toast } from "sonner"
import { App } from "@/app/App"
import { PayloadError } from "@/app/PayloadError"
import { ReportErrorBoundary } from "@/app/ReportErrorBoundary"
import { ReportProvider } from "@/app/report-context"
import { watchUnknownScreens } from "@/app/unknown-screen"
import { i18n } from "@/lib/i18n"
import { payload } from "@/lib/payload"
import { clearScreen } from "@/lib/url-state"
import "./styles.css"

const container = document.getElementById("root")

if (container) {
  createRoot(container).render(
    <StrictMode>
      <ReportErrorBoundary>
        {payload ? (
          <ReportProvider payload={payload} i18n={i18n}>
            <App />
          </ReportProvider>
        ) : (
          <PayloadError />
        )}
      </ReportErrorBoundary>
    </StrictMode>,
  )
}

if (payload) {
  watchUnknownScreens(new Set(payload.screens.map((screen) => screen.id)), (id) => {
    toast.warning(i18n.t("hashUnknownScreen", { id }))
    clearScreen()
  })
}
