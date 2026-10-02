import type { StringKey } from "@appgraph/emit/strings.js"
import { TABS } from "@/config/tabs"
import type { TabId } from "@/config/tabs"

export const HOTKEY_GROUPS = [
  { id: "general", labelKey: "shortcutsGroupSearch" },
  { id: "navigation", labelKey: "shortcutsGroupNavigation" },
  { id: "screens", labelKey: "shortcutsGroupList" },
] as const satisfies readonly { readonly id: string; readonly labelKey: StringKey }[]

export type HotkeyGroupId = (typeof HOTKEY_GROUPS)[number]["id"]

const GO_TO_TAB_LABELS = {
  screens: "shortcutGoScreens",
  map: "shortcutGoGraph",
  menu: "shortcutGoMenu",
  components: "shortcutGoComponents",
  findings: "shortcutGoFindings",
} as const satisfies Record<TabId, StringKey>

const SEQUENCE_LEADER = "G"

const goToTabEntries = TABS.map(
  (tab) =>
    ({
      id: `go-${tab.id}`,
      group: "navigation",
      sequence: [SEQUENCE_LEADER, tab.sequenceKey.toUpperCase()],
      scope: "global",
      labelKey: GO_TO_TAB_LABELS[tab.id],
      command: "goToTab",
      tab: tab.id,
      allowInInputs: false,
      native: false,
    }) as const,
)

export const HOTKEYS = [
  {
    id: "focus-search",
    group: "general",
    keys: ["/"],
    scope: "global",
    labelKey: "shortcutFocusSearch",
    command: "focusSearch",
    allowInInputs: false,
    native: false,
  },
  {
    id: "open-palette",
    group: "general",
    keys: ["Mod+K"],
    scope: "global",
    labelKey: "shortcutPalette",
    command: "openPalette",
    allowInInputs: true,
    native: false,
  },
  {
    id: "open-shortcuts",
    group: "general",
    keys: ["?"],
    scope: "global",
    labelKey: "shortcutHelp",
    command: "openShortcuts",
    allowInInputs: false,
    native: false,
  },
  {
    id: "dismiss",
    group: "general",
    keys: ["Escape"],
    scope: "global",
    labelKey: "shortcutClear",
    command: "dismiss",
    allowInInputs: true,
    native: true,
  },
  ...goToTabEntries,
  {
    id: "screen-next",
    group: "screens",
    keys: ["J", "ArrowDown"],
    scope: "screens",
    labelKey: "shortcutNextScreen",
    command: "screenListNext",
    allowInInputs: false,
    native: false,
  },
  {
    id: "screen-prev",
    group: "screens",
    keys: ["K", "ArrowUp"],
    scope: "screens",
    labelKey: "shortcutPrevScreen",
    command: "screenListPrev",
    allowInInputs: false,
    native: false,
  },
] as const

export type HotkeyEntry = (typeof HOTKEYS)[number]

export type KeyHotkeyEntry = Extract<HotkeyEntry, { readonly keys: readonly string[] }>

export type SequenceHotkeyEntry = Extract<HotkeyEntry, { readonly sequence: readonly string[] }>

export type HotkeyCommand = HotkeyEntry["command"]

export type HotkeyScope = HotkeyEntry["scope"]

export const isSequenceEntry = <T extends HotkeyEntry>(entry: T): entry is Extract<T, SequenceHotkeyEntry> =>
  "sequence" in entry

export const isKeyEntry = <T extends HotkeyEntry>(entry: T): entry is Extract<T, KeyHotkeyEntry> => "keys" in entry

export const hotkeysInGroup = (group: HotkeyGroupId): readonly HotkeyEntry[] =>
  HOTKEYS.filter((entry) => entry.group === group)
