import { readUrlState, resolveScreen, subscribeUrlState } from "@/lib/url-state"

export const unknownScreenId = (screenIds: ReadonlySet<string>): string | null => {
  const state = readUrlState()
  return resolveScreen(state, screenIds, null).unknown ? state.screen : null
}

export const watchUnknownScreens = (screenIds: ReadonlySet<string>, onUnknown: (id: string) => void) => {
  const notified: { id: string | null } = { id: null }
  const check = () => {
    const id = unknownScreenId(screenIds)
    if (id === notified.id) return
    notified.id = id
    if (id !== null) onUnknown(id)
  }
  check()
  return subscribeUrlState(check)
}
