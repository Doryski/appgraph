import { useState } from "react"
import type { TabId } from "@/config/tabs"

export const useVisitedTabs = (tab: TabId): ReadonlySet<TabId> => {
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(() => new Set([tab]))
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]))
  return visited
}
