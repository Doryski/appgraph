import { STAT_SPECS } from "@appgraph/emit/report-derive.js"
import type { StatId, StatSpec } from "@appgraph/emit/report-derive.js"
import type { StringKey } from "@appgraph/emit/strings.js"

type StatLabels = {
  readonly labelKey: StringKey
  readonly helpKey: StringKey
  readonly pluralKey: StringKey | null
}

const STAT_LABELS = {
  screens: { labelKey: "countScreens", helpKey: "helpScreens", pluralKey: "statScreensPlural" },
  components: { labelKey: "countComponents", helpKey: "helpComponents", pluralKey: "statComponentsPlural" },
  endpoints: { labelKey: "countEndpoints", helpKey: "helpEndpoints", pluralKey: "statEndpointsPlural" },
  deadLinks: { labelKey: "countDeadLinks", helpKey: "helpDeadLinks", pluralKey: "statDeadLinksPlural" },
  apiRoutes: { labelKey: "countApiRoutes", helpKey: "helpApiRoutes", pluralKey: "statApiRoutesPlural" },
  redirects: { labelKey: "countRedirects", helpKey: "helpRedirects", pluralKey: "statRedirectsPlural" },
  renderEdges: { labelKey: "countRenderEdges", helpKey: "helpRenderEdges", pluralKey: "statRenderEdgesPlural" },
  navEdges: { labelKey: "countNavEdges", helpKey: "helpNavEdges", pluralKey: "statNavEdgesPlural" },
  depth: { labelKey: "countDepth", helpKey: "helpDepth", pluralKey: null },
} as const satisfies Record<StatId, StatLabels>

export type Stat = StatSpec & StatLabels

export const STATS: readonly Stat[] = STAT_SPECS.map((spec) => ({ ...spec, ...STAT_LABELS[spec.id] }))

export const PRIMARY_STATS = STATS.filter((stat) => stat.primary)

export const SECONDARY_STATS = STATS.filter((stat) => !stat.primary)

export const statNoun = (text: string, value: number): string => text.replace(String(value), "").trim()
