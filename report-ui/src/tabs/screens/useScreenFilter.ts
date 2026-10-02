import { useDeferredValue, useMemo, useState } from "react"
import type { ScreenPayload } from "@appgraph/emit/report-payload.js"
import { matchesQuery, normalizeQuery } from "@appgraph/emit/report-derive.js"
import { buildListModel } from "./list-model"

const hasApiMatch = (screens: readonly ScreenPayload[], query: string): boolean => {
  const normalized = normalizeQuery(query)
  return normalized !== "" && screens.some((screen) => screen.isApi && matchesQuery(screen, normalized))
}

export const useScreenFilter = (
  screens: readonly ScreenPayload[],
  selectedId: string | null,
  selectedIsApi: boolean,
) => {
  const [query, setQueryState] = useState("")
  const [apiOpen, setApiOpen] = useState(selectedIsApi)
  const [revealedId, setRevealedId] = useState(selectedId)
  if (revealedId !== selectedId) {
    setRevealedId(selectedId)
    if (selectedIsApi) setApiOpen(true)
  }
  const deferredQuery = useDeferredValue(query)
  const model = useMemo(() => buildListModel(screens, deferredQuery, apiOpen), [screens, deferredQuery, apiOpen])

  const setQuery = (next: string) => {
    setQueryState(next)
    if (hasApiMatch(screens, next)) setApiOpen(true)
  }

  const toggleApiGroup = () => setApiOpen((open) => !open)

  return {
    query,
    isFiltering: normalizeQuery(deferredQuery) !== "",
    model,
    setQuery,
    clearQuery: () => setQueryState(""),
    toggleApiGroup,
  }
}

export type ScreenFilter = ReturnType<typeof useScreenFilter>
