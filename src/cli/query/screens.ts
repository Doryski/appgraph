import type { Screen } from "../../core/model.js"
import { sortedUnique } from "../../core/order.js"
import { matchesQuery, normalizeQuery, screenBadges } from "../../emit/report-derive.js"
import type { ScreenBadge } from "../../emit/report-derive.js"
import { orderedScreens, screenRow } from "../../emit/report-payload.js"
import { EXIT_OK } from "../../pipeline/exit-codes.js"
import type { OptionValue, QueryContext, QueryRun } from "../commands.js"
import { requireKnown } from "./catalog.js"
import { writeList } from "./output.js"
import { loadGraph } from "./runtime.js"

export const QUERY_LOCALE = "en"

const DEFAULT_COLUMNS = ["id", "url", "title", "auth", "badges"] as const

const badgeText = (badge: ScreenBadge): string => (badge.value === null ? badge.id : `${badge.id}:${badge.value}`)

type ScreenPayloadRow = ReturnType<typeof screenRow>

const listedOf = (row: ScreenPayloadRow) => ({
    id: row.id,
    url: row.url,
    title: row.title,
    primaryLabel: row.primaryLabel,
    source: row.source,
    kindTag: row.kindTag,
    auth: row.auth,
    featureFlag: row.featureFlag,
    devOnly: row.devOnly,
    addressable: row.addressable,
    redirectTo: row.redirectTo,
    shell: row.shell,
    isApi: row.isApi,
    badges: screenBadges(row).map(badgeText),
})

export const listedScreen = (screen: Screen) => listedOf(screenRow(screen, QUERY_LOCALE))

type ListedScreen = ReturnType<typeof listedScreen>

type Candidate = {
  readonly listed: ListedScreen
  readonly search: string
}

const candidateOf = (screen: Screen): Candidate => {
  const row = screenRow(screen, QUERY_LOCALE)
  return { listed: listedOf(row), search: row.search }
}

type ScreenFilter = (candidate: Candidate) => boolean

const stringOption = (value: OptionValue | undefined): string | null => (typeof value === "string" ? value : null)

const searchFilter = (value: OptionValue | undefined): ScreenFilter | null => {
  const query = stringOption(value)
  if (query === null) return null
  const normalized = normalizeQuery(query)
  return (candidate) => matchesQuery(candidate, normalized)
}

const equalsFilter =
  (pick: (row: ListedScreen) => string | null) =>
  (value: OptionValue | undefined): ScreenFilter | null => {
    const wanted = stringOption(value)
    return wanted === null ? null : (candidate) => pick(candidate.listed) === wanted
  }

const apiFilter = (value: OptionValue | undefined): ScreenFilter | null =>
  typeof value === "boolean" ? (candidate) => candidate.listed.isApi === value : null

const flagFilter = (value: OptionValue | undefined): ScreenFilter | null => {
  if (value === true) return (candidate) => candidate.listed.featureFlag !== null
  return equalsFilter((row) => row.featureFlag)(value)
}

const SCREEN_FILTERS = {
  search: searchFilter,
  auth: equalsFilter((row) => row.auth),
  api: apiFilter,
  flag: flagFilter,
  kind: equalsFilter((row) => row.kindTag),
  from: equalsFilter((row) => row.source),
} as const satisfies Readonly<Record<string, (value: OptionValue | undefined) => ScreenFilter | null>>

const activeFilters = (context: QueryContext): readonly ScreenFilter[] =>
  Object.entries(SCREEN_FILTERS).flatMap(([key, build]) => {
    const filter = build(context.own[key])
    return filter === null ? [] : [filter]
  })

export const filteredScreens = (screens: readonly Screen[], context: QueryContext) => {
  const filters = activeFilters(context)
  return orderedScreens(screens)
    .map(candidateOf)
    .filter((candidate) => filters.every((filter) => filter(candidate)))
    .map((candidate) => candidate.listed)
}

const KNOWN_VALUE_OPTIONS = [
  { key: "kind", what: "screen kind", code: "usage/unknown-kind", pick: (screen: Screen) => screen.kindTag },
  { key: "from", what: "screen source", code: "usage/unknown-source", pick: (screen: Screen) => screen.source },
] as const

const assertKnownValues = (screens: readonly Screen[], context: QueryContext): void => {
  for (const option of KNOWN_VALUE_OPTIONS) {
    const value = stringOption(context.own[option.key])
    if (value === null) continue
    const valid = sortedUnique(screens.flatMap((screen) => option.pick(screen) ?? []))
    requireKnown({ what: option.what, value, valid, code: option.code })
  }
}

const run: QueryRun = async (context) => {
  const loaded = await loadGraph(context)
  assertKnownValues(loaded.graph.screens, context)
  writeList(context, { loaded, items: filteredScreens(loaded.graph.screens, context), columns: DEFAULT_COLUMNS })
  return EXIT_OK
}

export default run
