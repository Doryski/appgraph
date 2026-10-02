import { afterEach, describe, expect, it, vi } from "vitest"
import { clearScreen } from "@/lib/url-state"
import { resetUrlHash } from "./test-utils"
import { watchUnknownScreens } from "./unknown-screen"

const ids = new Set(["a", "b"])

const goTo = (hash: string) => {
  window.history.pushState(null, "", hash)
  window.dispatchEvent(new PopStateEvent("popstate"))
}

afterEach(() => {
  resetUrlHash()
})

describe("watchUnknownScreens", () => {
  it("reports an unknown screen in the initial hash once", () => {
    window.history.replaceState(null, "", "#screen=zzz")
    const onUnknown = vi.fn()
    const stop = watchUnknownScreens(ids, onUnknown)
    window.dispatchEvent(new HashChangeEvent("hashchange"))
    expect(onUnknown).toHaveBeenCalledTimes(1)
    expect(onUnknown).toHaveBeenCalledWith("zzz")
    stop()
  })

  it("ignores known screens and reports again after leaving an unknown one", () => {
    const onUnknown = vi.fn()
    const stop = watchUnknownScreens(ids, onUnknown)
    goTo("#tab=screens&screen=a")
    expect(onUnknown).not.toHaveBeenCalled()
    goTo("#tab=screens&screen=nope")
    goTo("#tab=screens&screen=b")
    goTo("#tab=screens&screen=nope")
    expect(onUnknown).toHaveBeenCalledTimes(2)
    stop()
    goTo("#tab=screens&screen=other")
    expect(onUnknown).toHaveBeenCalledTimes(2)
  })

  it("reports the same unknown screen again after the handler dropped it from the hash", () => {
    const onUnknown = vi.fn(() => clearScreen())
    const stop = watchUnknownScreens(ids, onUnknown)
    goTo("#tab=map&screen=nope")
    expect(window.location.hash).toBe("#tab=map")
    goTo("#tab=map&screen=nope")
    expect(onUnknown).toHaveBeenCalledTimes(2)
    stop()
  })
})
