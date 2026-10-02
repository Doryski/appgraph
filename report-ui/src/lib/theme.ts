import { useSyncExternalStore } from "react"

export const THEME_STORAGE_KEY = "appgraph-theme"

export const THEMES = ["light", "dark", "system"] as const

export type Theme = (typeof THEMES)[number]

const THEME_EVENT = "appgraph:theme"

const DEFAULT_THEME: Theme = "system"

const isTheme = (value: string | null): value is Theme => THEMES.some((theme) => theme === value)

const readStorage = (): string | null => {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY)
  } catch {
    return null
  }
}

const writeStorage = (theme: Theme) => {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    return
  }
}

const session: { theme: Theme | null } = { theme: null }

export const parseTheme = (value: string | null): Theme => (isTheme(value) ? value : DEFAULT_THEME)

export const readTheme = (): Theme => session.theme ?? parseTheme(readStorage())

export const applyThemeAttribute = (theme: Theme) => {
  const root = document.documentElement
  if (theme === "system") {
    root.removeAttribute("data-theme")
    return
  }
  root.dataset.theme = theme
}

const handleStorage = (event: StorageEvent, onChange: () => void) => {
  if (event.key !== THEME_STORAGE_KEY) return
  session.theme = null
  applyThemeAttribute(readTheme())
  onChange()
}

const subscribe = (onChange: () => void) => {
  const onStorage = (event: StorageEvent) => handleStorage(event, onChange)
  window.addEventListener("storage", onStorage)
  window.addEventListener(THEME_EVENT, onChange)
  return () => {
    window.removeEventListener("storage", onStorage)
    window.removeEventListener(THEME_EVENT, onChange)
  }
}

const getServerSnapshot = (): Theme => DEFAULT_THEME

export const useTheme = (): Theme => useSyncExternalStore(subscribe, readTheme, getServerSnapshot)

export const setTheme = (theme: Theme) => {
  session.theme = theme
  writeStorage(theme)
  applyThemeAttribute(theme)
  window.dispatchEvent(new Event(THEME_EVENT))
}

export const resetThemeSession = () => {
  session.theme = null
}
