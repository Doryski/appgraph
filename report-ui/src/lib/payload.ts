import type { ReportPayload, SerializedReportPayload } from "@appgraph/emit/report-payload.js"
import { createTreeHydrator } from "@appgraph/emit/tree-intern.js"

export const PAYLOAD_ELEMENT_ID = "appgraph-data"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const hasTree = (value: unknown): boolean => isRecord(value) && Array.isArray(value.tree)

const isSerializedPayload = (value: unknown): value is SerializedReportPayload =>
  isRecord(value) &&
  isRecord(value.meta) &&
  isRecord(value.strings) &&
  isRecord(value.graph) &&
  typeof value.locale === "string" &&
  Array.isArray(value.screens) &&
  Array.isArray(value.components) &&
  Array.isArray(value.shells) &&
  Array.isArray(value.subtrees) &&
  Array.isArray(value.paths) &&
  value.screens.every(hasTree) &&
  value.shells.every(hasTree)

const hydratePayload = ({ subtrees, paths, ...serialized }: SerializedReportPayload): ReportPayload => {
  const hydrate = createTreeHydrator(subtrees, paths)
  return {
    ...serialized,
    screens: serialized.screens.map((screen) => ({ ...screen, tree: screen.tree.map(hydrate) })),
    shells: serialized.shells.map((shell) => ({ ...shell, tree: shell.tree.map(hydrate) })),
  }
}

const safeHydrate = (serialized: SerializedReportPayload): ReportPayload | null => {
  try {
    return hydratePayload(serialized)
  } catch {
    return null
  }
}

export const readPayload = (doc: Document): ReportPayload | null => {
  const text = doc.getElementById(PAYLOAD_ELEMENT_ID)?.textContent ?? ""
  if (text.trim() === "") return null
  const parsed = parseJson(text)
  return isSerializedPayload(parsed) ? safeHydrate(parsed) : null
}

export const payload = typeof document === "undefined" ? null : readPayload(document)
