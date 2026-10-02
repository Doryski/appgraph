import type { StringKey } from "@appgraph/emit/strings.js"
import type { LucideIcon } from "lucide-react"
import { Boxes, LayoutList, ListTree, SearchCheck, Waypoints } from "lucide-react"

type TabConfig = {
  readonly id: string
  readonly labelKey: StringKey
  readonly descriptionKey: StringKey
  readonly icon: LucideIcon
  readonly sequenceKey: string
}

export const TABS = [
  {
    id: "screens",
    labelKey: "tabScreens",
    descriptionKey: "tabScreensDescription",
    icon: LayoutList,
    sequenceKey: "s",
  },
  {
    id: "map",
    labelKey: "tabGraph",
    descriptionKey: "tabGraphDescription",
    icon: Waypoints,
    sequenceKey: "n",
  },
  {
    id: "menu",
    labelKey: "tabMenu",
    descriptionKey: "tabMenuDescription",
    icon: ListTree,
    sequenceKey: "m",
  },
  {
    id: "components",
    labelKey: "tabComponents",
    descriptionKey: "tabComponentsDescription",
    icon: Boxes,
    sequenceKey: "c",
  },
  {
    id: "findings",
    labelKey: "tabFindings",
    descriptionKey: "tabFindingsDescription",
    icon: SearchCheck,
    sequenceKey: "f",
  },
] as const satisfies readonly TabConfig[]

export type Tab = (typeof TABS)[number]

export type TabId = Tab["id"]

export const DEFAULT_TAB_ID = "screens" satisfies TabId

export const TAB_IDS: readonly TabId[] = TABS.map((tab) => tab.id)

export const isTabId = (value: string): value is TabId => TAB_IDS.some((id) => id === value)
