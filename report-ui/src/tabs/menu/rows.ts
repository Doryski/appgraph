import type { FlatNavEntry } from "@appgraph/emit/report-derive.js"
import type { ReportPayload } from "@appgraph/emit/report-payload.js"

type PayloadGroup = ReportPayload["navGroups"][number]

export type MenuRow = FlatNavEntry<PayloadGroup["entries"][number]>
