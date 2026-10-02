import { useSyncExternalStore } from "react"
import { DEFAULT_TAB_ID, isTabId } from "@/config/tabs"
import type { TabId } from "@/config/tabs"

export type UrlState = {
  readonly tab: TabId
  readonly screen: string | null
}

export type HistoryMode = "push" | "replace"

export type ResolvedScreen = {
  readonly id: string | null
  readonly unknown: boolean
}

const TAB_PARAM = "tab"
const SCREEN_PARAM = "screen"
const URL_STATE_EVENT = "appgraph:url-state"

const decodeValue = (value: string): string | null => {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

const encodeScreenId = (id: string): string => encodeURIComponent(id).replace(/%2F/gi, "/").replace(/%3A/gi, ":")

const hashEntries = (hash: string): ReadonlyMap<string, string> =>
  new Map(
    hash
      .replace(/^#/, "")
      .split("&")
      .filter((part) => part.indexOf("=") > 0)
      .map((part) => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)] as const),
  )

const readParam = (entries: ReadonlyMap<string, string>, name: string): string | null => {
  const raw = entries.get(name)
  return raw === undefined ? null : decodeValue(raw)
}

const parseTab = (value: string | null): TabId => (value !== null && isTabId(value) ? value : DEFAULT_TAB_ID)

const parseScreen = (value: string | null): string | null => (value === null || value === "" ? null : value)

export const parseHash = (hash: string): UrlState => {
  const entries = hashEntries(hash)
  return {
    tab: parseTab(readParam(entries, TAB_PARAM)),
    screen: parseScreen(readParam(entries, SCREEN_PARAM)),
  }
}

export const formatHash = (state: UrlState): string => {
  const tabPart = `${TAB_PARAM}=${encodeURIComponent(state.tab)}`
  return state.screen === null ? `#${tabPart}` : `#${tabPart}&${SCREEN_PARAM}=${encodeScreenId(state.screen)}`
}

export const resolveScreen = (
  state: UrlState,
  screenIds: ReadonlySet<string>,
  fallbackId: string | null,
): ResolvedScreen => {
  if (state.screen === null) return { id: fallbackId, unknown: false }
  if (screenIds.has(state.screen)) return { id: state.screen, unknown: false }
  return { id: fallbackId, unknown: true }
}

const snapshotCache = { hash: "", state: parseHash("") }

const getSnapshot = (): UrlState => {
  const { hash } = window.location
  if (hash === snapshotCache.hash) return snapshotCache.state
  snapshotCache.hash = hash
  snapshotCache.state = parseHash(hash)
  return snapshotCache.state
}

const getServerSnapshot = (): UrlState => snapshotCache.state

const URL_CHANGE_EVENTS = ["hashchange", "popstate", URL_STATE_EVENT] as const

export const subscribeUrlState = (onChange: () => void) => {
  URL_CHANGE_EVENTS.forEach((name) => window.addEventListener(name, onChange))
  return () => URL_CHANGE_EVENTS.forEach((name) => window.removeEventListener(name, onChange))
}

export const readUrlState = (): UrlState => getSnapshot()

export const useUrlState = (): UrlState => useSyncExternalStore(subscribeUrlState, getSnapshot, getServerSnapshot)

const writeHash = (state: UrlState, mode: HistoryMode) => {
  const next = formatHash(state)
  if (window.location.hash === next) return
  if (mode === "push") window.history.pushState(null, "", next)
  else window.history.replaceState(null, "", next)
  window.dispatchEvent(new Event(URL_STATE_EVENT))
}

export const setTab = (tab: TabId) => {
  writeHash({ ...readUrlState(), tab }, "push")
}

export const clearScreen = () => {
  writeHash({ ...readUrlState(), screen: null }, "replace")
}

export const selectScreen = (id: string, mode: HistoryMode) => {
  writeHash({ tab: DEFAULT_TAB_ID, screen: id }, mode)
}
