import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { THEME_STORAGE_KEY, parseTheme, readTheme, resetThemeSession, setTheme, useTheme } from "./theme"

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  document.documentElement.removeAttribute("data-theme")
  resetThemeSession()
})

describe("parseTheme", () => {
  it("accepts the three values and defaults to system", () => {
    expect(parseTheme("light")).toBe("light")
    expect(parseTheme("dark")).toBe("dark")
    expect(parseTheme("system")).toBe("system")
    expect(parseTheme(null)).toBe("system")
    expect(parseTheme("sepia")).toBe("system")
  })
})

describe("setTheme / useTheme", () => {
  it("defaults to system with no stored value", () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current).toBe("system")
  })

  it("reads a stored value", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark")
    expect(readTheme()).toBe("dark")
  })

  it("writes storage and the data-theme attribute", () => {
    const { result } = renderHook(() => useTheme())
    act(() => setTheme("dark"))
    expect(result.current).toBe("dark")
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark")
    expect(document.documentElement.dataset.theme).toBe("dark")
    act(() => setTheme("light"))
    expect(result.current).toBe("light")
    expect(document.documentElement.dataset.theme).toBe("light")
  })

  it("removes the attribute for system", () => {
    const { result } = renderHook(() => useTheme())
    act(() => setTheme("dark"))
    act(() => setTheme("system"))
    expect(result.current).toBe("system")
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system")
  })

  it("keeps the choice for the session when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    const { result } = renderHook(() => useTheme())
    act(() => setTheme("dark"))
    expect(result.current).toBe("dark")
    expect(document.documentElement.dataset.theme).toBe("dark")
  })

  it("follows storage events from other tabs", () => {
    const { result } = renderHook(() => useTheme())
    act(() => setTheme("light"))
    act(() => {
      window.localStorage.setItem(THEME_STORAGE_KEY, "dark")
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "dark" }))
    })
    expect(result.current).toBe("dark")
    expect(document.documentElement.dataset.theme).toBe("dark")
  })
})
