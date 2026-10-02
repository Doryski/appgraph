import type { ComponentType } from "react"
import type { Tab, TabId } from "@/config/tabs"
import { ComponentsTab } from "@/tabs/components"
import { FindingsTab } from "@/tabs/findings"
import { MapTab } from "@/tabs/map"
import { MenuTab } from "@/tabs/menu"
import { ScreensTab } from "@/tabs/screens"

export type TabPanelProps = {
  readonly tab: Tab
}

export const TAB_PANELS: Readonly<Record<TabId, ComponentType<TabPanelProps>>> = {
  screens: ScreensTab,
  map: MapTab,
  menu: MenuTab,
  components: ComponentsTab,
  findings: FindingsTab,
}

export const TABS_WITHOUT_EMPTY_REPORT: ReadonlySet<TabId> = new Set<TabId>(["findings"])
