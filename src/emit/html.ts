import type { AppGraph } from "../core/model.js"
import { REPORT_TEMPLATE } from "./assets/generated.js"
import { escapeHtml } from "./html-util.js"
import { appNameOf } from "./report-derive.js"
import { buildReportPayload, reportPaletteCss, serializePayload } from "./report-payload.js"
import type { Locale } from "./strings.js"
import { DEFAULT_LOCALE, t } from "./strings.js"

export type RenderHtmlOptions = {
  readonly locale?: Locale
  readonly generatedAt?: string
  readonly noTimestamp?: boolean
}

export const REPORT_PLACEHOLDERS = {
  lang: "__APPGRAPH_LANG__",
  title: "__APPGRAPH_TITLE__",
  palette: "__APPGRAPH_PALETTE__",
  data: "__APPGRAPH_DATA__",
} as const

type PlaceholderToken = (typeof REPORT_PLACEHOLDERS)[keyof typeof REPORT_PLACEHOLDERS]

const PLACEHOLDER_PATTERN = new RegExp(Object.values(REPORT_PLACEHOLDERS).join("|"), "g")

const escapeStyleText = (css: string): string => css.replace(/</g, "\\3C ")

const timestampOf = (options: RenderHtmlOptions | undefined): string | null => {
  if (options?.noTimestamp === true) return null
  return options?.generatedAt ?? null
}

const fillTemplate = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(PLACEHOLDER_PATTERN, (token) => values[token] ?? token)

export const renderHtml = (graph: AppGraph, options?: RenderHtmlOptions): string => {
  const locale = options?.locale ?? DEFAULT_LOCALE
  const payload = buildReportPayload(graph, { locale, generatedAt: timestampOf(options) })
  return fillTemplate(REPORT_TEMPLATE, {
    [REPORT_PLACEHOLDERS.lang]: escapeHtml(locale),
    [REPORT_PLACEHOLDERS.title]: escapeHtml(t(locale, "headerTitle", { appName: appNameOf(graph) })),
    [REPORT_PLACEHOLDERS.palette]: escapeStyleText(reportPaletteCss(graph)),
    [REPORT_PLACEHOLDERS.data]: serializePayload(payload),
  } satisfies Record<PlaceholderToken, string>)
}
