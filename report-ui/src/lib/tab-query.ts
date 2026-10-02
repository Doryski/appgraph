import { useSyncExternalStore } from "react"
import type { TabId } from "@/config/tabs"

const queries = new Map<TabId, string>()
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const readTabQuery = (tab: TabId): string => queries.get(tab) ?? ""

export const setTabQuery = (tab: TabId, query: string): void => {
  if (readTabQuery(tab) === query) return
  queries.set(tab, query)
  listeners.forEach((listener) => listener())
}

export const resetTabQueries = (): void => {
  queries.clear()
  listeners.forEach((listener) => listener())
}

export const useTabQuery = (tab: TabId): string =>
  useSyncExternalStore(
    subscribe,
    () => readTabQuery(tab),
    () => "",
  )
