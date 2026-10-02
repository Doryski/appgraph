import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TAB_IDS } from "@/config/tabs"
import { formatHash, parseHash, resolveScreen, selectScreen, setTab, useUrlState } from "./url-state"
import type { UrlState } from "./url-state"

const resetHash = () => window.history.replaceState(null, "", window.location.pathname)

afterEach(() => {
  resetHash()
  vi.restoreAllMocks()
})

describe("parseHash / formatHash", () => {
  const states: readonly UrlState[] = [
    { tab: "screens", screen: null },
    { tab: "map", screen: null },
    { tab: "screens", screen: "react-router:/billing/:id" },
    { tab: "findings", screen: "next:/a b/ü?x=1&y" },
    ...TAB_IDS.map((tab) => ({ tab, screen: "s1" })),
  ]

  it.each(states)("round-trips %o", (state) => {
    expect(parseHash(formatHash(state))).toEqual(state)
  })

  it("formats tab first and keeps / and : readable", () => {
    expect(formatHash({ tab: "screens", screen: "rr:/users/:id" })).toBe("#tab=screens&screen=rr:/users/:id")
    expect(formatHash({ tab: "menu", screen: null })).toBe("#tab=menu")
  })

  it("accepts a hash that starts with screen= or omits the tab", () => {
    expect(parseHash("#screen=rr:/login")).toEqual({ tab: "screens", screen: "rr:/login" })
    expect(parseHash("#screen=rr%3A%2Flogin&tab=components")).toEqual({ tab: "components", screen: "rr:/login" })
  })

  it("falls back for empty, unknown or malformed values", () => {
    expect(parseHash("")).toEqual({ tab: "screens", screen: null })
    expect(parseHash("#tab=nope")).toEqual({ tab: "screens", screen: null })
    expect(parseHash("#screen=%E0%A4%A")).toEqual({ tab: "screens", screen: null })
    expect(parseHash("#screen=")).toEqual({ tab: "screens", screen: null })
  })
})

describe("resolveScreen", () => {
  const ids = new Set(["a", "b"])

  it("uses the hash screen when it exists", () => {
    expect(resolveScreen({ tab: "screens", screen: "b" }, ids, "a")).toEqual({ id: "b", unknown: false })
  })

  it("uses the fallback when no screen is in the hash", () => {
    expect(resolveScreen({ tab: "screens", screen: null }, ids, "a")).toEqual({ id: "a", unknown: false })
  })

  it("flags an unknown screen and falls back", () => {
    expect(resolveScreen({ tab: "screens", screen: "zzz" }, ids, "a")).toEqual({ id: "a", unknown: true })
    expect(resolveScreen({ tab: "screens", screen: "zzz" }, new Set(), null)).toEqual({ id: null, unknown: true })
  })
})

describe("useUrlState and commands", () => {
  it("reflects setTab with pushState", () => {
    const push = vi.spyOn(window.history, "pushState")
    const { result } = renderHook(() => useUrlState())
    expect(result.current).toEqual({ tab: "screens", screen: null })
    act(() => setTab("components"))
    expect(push).toHaveBeenCalledTimes(1)
    expect(window.location.hash).toBe("#tab=components")
    expect(result.current).toEqual({ tab: "components", screen: null })
  })

  it("selectScreen switches to screens and honours the history mode", () => {
    const push = vi.spyOn(window.history, "pushState")
    const replace = vi.spyOn(window.history, "replaceState")
    const { result } = renderHook(() => useUrlState())
    act(() => setTab("map"))
    act(() => selectScreen("rr:/a", "push"))
    expect(result.current).toEqual({ tab: "screens", screen: "rr:/a" })
    act(() => selectScreen("rr:/b", "replace"))
    expect(result.current).toEqual({ tab: "screens", screen: "rr:/b" })
    expect(push).toHaveBeenCalledTimes(2)
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it("does not write history when the hash is unchanged", () => {
    act(() => setTab("menu"))
    const push = vi.spyOn(window.history, "pushState")
    act(() => setTab("menu"))
    expect(push).not.toHaveBeenCalled()
  })

  it("follows hashchange events", () => {
    const { result } = renderHook(() => useUrlState())
    act(() => {
      window.location.hash = "#screen=legacy"
      window.dispatchEvent(new HashChangeEvent("hashchange"))
    })
    expect(result.current).toEqual({ tab: "screens", screen: "legacy" })
  })
})
