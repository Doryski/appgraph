import { FileWarning } from "lucide-react"

const PAYLOAD_ERROR_TITLE = "Report data could not be read"
const PAYLOAD_ERROR_BODY = "This file is incomplete or damaged. Generate the report again with appgraph and reopen it."

export const PayloadError = () => (
  <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
    <div role="alert" className="flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
      <FileWarning aria-hidden className="size-8 text-destructive" />
      <h1 className="text-lg font-semibold">{PAYLOAD_ERROR_TITLE}</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">{PAYLOAD_ERROR_BODY}</p>
    </div>
  </main>
)
