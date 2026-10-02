import type { SectionConfidence } from "./model.js"

export const CONFIDENCE_STATUSES = ["ok", "partial", "empty-expected", "empty-unexpected"] as const

export type ConfidenceStatus = (typeof CONFIDENCE_STATUSES)[number]

/**
 * The four-state vocabulary the report speaks (§10.3), derived from the three-state `level` the
 * kernel records. `level: 'suspect'` already means "empty while the dependency is installed", so the
 * dependency check is a second, independent route to `empty-unexpected` for entries whose level was
 * computed before the dependency union was known.
 */
export const confidenceStatus = (entry: SectionConfidence): ConfidenceStatus => {
  if (entry.count > 0) return entry.level === "high" ? "ok" : "partial"
  const unexpected =
    entry.level === "suspect" || (entry.enablingDependency !== null && entry.dependencyInstalled)
  return unexpected ? "empty-unexpected" : "empty-expected"
}
