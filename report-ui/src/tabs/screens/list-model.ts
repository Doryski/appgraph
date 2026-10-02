import type { ScreenPayload } from "@appgraph/emit/report-payload.js"
import { matchesQuery, normalizeQuery } from "@appgraph/emit/report-derive.js"

export type ScreenRow = {
  readonly type: "screen"
  readonly key: string
  readonly screen: ScreenPayload
}

export type ApiGroupRow = {
  readonly type: "apiGroup"
  readonly key: string
  readonly count: number
  readonly open: boolean
}

export type ListRow = ScreenRow | ApiGroupRow

export type ListModel = {
  readonly rows: readonly ListRow[]
  readonly matchCount: number
  readonly apiMatchCount: number
}

const API_GROUP_KEY = "__api-group__"

const toScreenRow = (screen: ScreenPayload): ScreenRow => ({ type: "screen", key: screen.id, screen })

const apiRows = (apis: readonly ScreenPayload[], open: boolean): readonly ListRow[] => {
  if (apis.length === 0) return []
  const header: ApiGroupRow = { type: "apiGroup", key: API_GROUP_KEY, count: apis.length, open }
  return open ? [header, ...apis.map(toScreenRow)] : [header]
}

export const buildListModel = (screens: readonly ScreenPayload[], query: string, apiOpen: boolean): ListModel => {
  const normalized = normalizeQuery(query)
  const matching = screens.filter((screen) => matchesQuery(screen, normalized))
  const humans = matching.filter((screen) => !screen.isApi)
  const apis = matching.filter((screen) => screen.isApi)
  return {
    rows: [...humans.map(toScreenRow), ...apiRows(apis, apiOpen)],
    matchCount: matching.length,
    apiMatchCount: apis.length,
  }
}

export const isScreenRow = (row: ListRow): row is ScreenRow => row.type === "screen"

export const rowIndexOf = (rows: readonly ListRow[], id: string | null): number =>
  id === null ? -1 : rows.findIndex((row) => isScreenRow(row) && row.screen.id === id)

const clampIndex = (index: number, length: number): number => Math.min(Math.max(index, 0), length - 1)

export const nextScreenId = (rows: readonly ListRow[], selectedId: string | null, direction: 1 | -1): string | null => {
  const screenRows = rows.filter(isScreenRow)
  if (screenRows.length === 0) return null
  const current = screenRows.findIndex((row) => row.screen.id === selectedId)
  const start = direction === 1 ? 0 : screenRows.length - 1
  const target = current === -1 ? start : clampIndex(current + direction, screenRows.length)
  return screenRows[target]?.screen.id ?? null
}

export const defaultScreenId = (screens: readonly ScreenPayload[]): string | null =>
  (screens.find((screen) => !screen.isApi) ?? screens[0])?.id ?? null
