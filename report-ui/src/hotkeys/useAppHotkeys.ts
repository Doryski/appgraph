import { formatForDisplay, normalizeHotkey, useHotkeySequences, useHotkeys } from "@tanstack/react-hotkeys"
import type { UseHotkeyDefinition, UseHotkeySequenceDefinition } from "@tanstack/react-hotkeys"
import { HOTKEYS, isKeyEntry, isSequenceEntry } from "@/hotkeys/config"
import type { HotkeyEntry, HotkeyScope, KeyHotkeyEntry, SequenceHotkeyEntry } from "@/hotkeys/config"
import { isScreenListTarget, moveScreenList } from "@/hotkeys/screen-list-bus"
import { focusSearch } from "@/hotkeys/search-registry"
import type { TabId } from "@/config/tabs"
import { readUrlState, setTab } from "@/lib/url-state"

export type AppHotkeyHandlers = {
  readonly openPalette: () => void
  readonly openShortcuts: () => void
}

type AppHotkeysOptions = AppHotkeyHandlers & {
  readonly tab: TabId
}

const isDialogOpen = () => document.querySelector('[data-slot="dialog-content"]') !== null

const unlessDialogOpen =
  (callback: (event: KeyboardEvent) => void) =>
  (event: KeyboardEvent): void => {
    if (isDialogOpen()) return
    callback(event)
  }

const listMove = (direction: 1 | -1) => (event: KeyboardEvent) => {
  if (event.defaultPrevented || !isScreenListTarget(event.target)) return
  event.preventDefault()
  moveScreenList(direction)
}

const keyCallback = (entry: KeyHotkeyEntry, handlers: AppHotkeyHandlers) => {
  switch (entry.command) {
    case "focusSearch":
      return () => focusSearch(readUrlState().tab)
    case "openPalette":
      return handlers.openPalette
    case "openShortcuts":
      return handlers.openShortcuts
    case "screenListNext":
      return listMove(1)
    case "screenListPrev":
      return listMove(-1)
    case "dismiss":
      return () => {}
  }
}

const isScopeActive = (scope: HotkeyScope, tab: TabId) => scope === "global" || scope === tab

const isEnabled = (entry: HotkeyEntry, options: AppHotkeysOptions) => isScopeActive(entry.scope, options.tab)

const isListMove = (entry: KeyHotkeyEntry) => entry.command === "screenListNext" || entry.command === "screenListPrev"

const toKeyDefinitions = (entry: KeyHotkeyEntry, options: AppHotkeysOptions): UseHotkeyDefinition[] =>
  entry.keys.map((key) => ({
    hotkey: normalizeHotkey(key),
    callback: unlessDialogOpen(keyCallback(entry, options)),
    options: {
      enabled: isEnabled(entry, options),
      ignoreInputs: !entry.allowInInputs,
      preventDefault: !isListMove(entry),
      meta: { name: entry.id },
    },
  }))

const toSequenceDefinition = (entry: SequenceHotkeyEntry, options: AppHotkeysOptions): UseHotkeySequenceDefinition => ({
  sequence: entry.sequence.map((step) => normalizeHotkey(step)),
  callback: unlessDialogOpen(() => setTab(entry.tab)),
  options: {
    enabled: isEnabled(entry, options),
    ignoreInputs: !entry.allowInInputs,
    meta: { name: entry.id },
  },
})

const isRegistered = (entry: HotkeyEntry) => !entry.native

export const useAppHotkeys = (options: AppHotkeysOptions): void => {
  const registered = HOTKEYS.filter(isRegistered)
  useHotkeys(registered.filter(isKeyEntry).flatMap((entry) => toKeyDefinitions(entry, options)))
  useHotkeySequences(registered.filter(isSequenceEntry).map((entry) => toSequenceDefinition(entry, options)))
}

export const formatKeyParts = (key: string): readonly string[] => formatForDisplay(key, { parts: true })
