export type ScreenListDirection = 1 | -1

export const SCREEN_LIST_SLOT = "screen-list"

const SCREEN_LIST_SELECTOR = `[data-slot="${SCREEN_LIST_SLOT}"]`

export const isScreenListTarget = (target: EventTarget | null): boolean => {
  if (target === document.body || target === document.documentElement) return true
  return target instanceof Element && target.closest(SCREEN_LIST_SELECTOR) !== null
}

export type ScreenListMoveHandler = (direction: ScreenListDirection) => void

const handlers = new Set<ScreenListMoveHandler>()

export const onScreenListMove = (handler: ScreenListMoveHandler): (() => void) => {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

export const screenListMoveRef =
  (handler: ScreenListMoveHandler) =>
  (element: Element | null): (() => void) | undefined => {
    if (element === null) return undefined
    return onScreenListMove(handler)
  }

export const moveScreenList = (direction: ScreenListDirection): void => {
  handlers.forEach((handler) => handler(direction))
}
