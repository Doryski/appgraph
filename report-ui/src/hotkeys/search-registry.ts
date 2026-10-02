import type { TabId } from "@/config/tabs"

const inputs = new Map<TabId, HTMLInputElement>()

export const searchInputRef =
  (tab: TabId) =>
  (element: HTMLInputElement | null): void => {
    if (element === null) {
      inputs.delete(tab)
      return
    }
    inputs.set(tab, element)
  }

export const focusSearch = (tab: TabId): void => {
  const input = inputs.get(tab)
  if (input === undefined) return
  input.focus()
  input.select()
}
