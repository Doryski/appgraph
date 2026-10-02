import type { Severity } from "@appgraph/core/model.js"
import type { ConfidenceStatus } from "@appgraph/core/confidence.js"
import { SEVERITY_ORDER } from "@appgraph/emit/report-derive.js"
import type { StringKey } from "@appgraph/emit/strings.js"

export const LIMITATIONS_ANCHOR_ID = "limitations"

export const SEVERITY_FILTERS = ["all", ...SEVERITY_ORDER] as const

export type SeverityFilter = (typeof SEVERITY_FILTERS)[number]

export const SEVERITY_LABEL_KEYS = {
  all: "diagnosticSeverityAll",
  error: "severityError",
  warning: "severityWarning",
  info: "severityInfo",
} as const satisfies Record<SeverityFilter, StringKey>

export const SEVERITY_BADGE_LABEL_KEYS = {
  error: "severityErrorOne",
  warning: "severityWarningOne",
  info: "severityInfoOne",
} as const satisfies Record<Severity, StringKey>

export const CONFIDENCE_LABEL_KEYS = {
  ok: "confidenceStatusOk",
  partial: "confidenceStatusPartial",
  "empty-expected": "confidenceStatusEmptyExpected",
  "empty-unexpected": "confidenceStatusEmptyUnexpected",
} as const satisfies Record<ConfidenceStatus, StringKey>
