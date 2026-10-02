import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { stringTable } from "@appgraph/emit/strings.js"
import { renderInReport } from "@/app/test-utils"
import { THEME_STORAGE_KEY, resetThemeSession } from "@/lib/theme"
import { ThemeMenu } from "./ThemeMenu"

const en = stringTable("en")

const pick = async (label: string) => {
  await userEvent.click(screen.getByRole("button", { name: en.themeMenuLabel }))
  await userEvent.click(await screen.findByRole("menuitemradio", { name: label }))
}

afterEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute("data-theme")
  resetThemeSession()
})

describe("ThemeMenu", () => {
  it("offers light, dark and system", async () => {
    renderInReport(<ThemeMenu />)
    await userEvent.click(screen.getByRole("button", { name: en.themeMenuLabel }))
    expect(await screen.findAllByRole("menuitemradio")).toHaveLength(3)
    expect(screen.getByRole("menuitemradio", { name: en.themeSystem })).toHaveAttribute("aria-checked", "true")
  })

  it("sets data-theme and persists the choice", async () => {
    renderInReport(<ThemeMenu />)
    await pick(en.themeDark)
    expect(document.documentElement.dataset.theme).toBe("dark")
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark")
  })

  it("returns to system after an explicit choice", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light")
    document.documentElement.dataset.theme = "light"
    renderInReport(<ThemeMenu />)
    await pick(en.themeSystem)
    expect(document.documentElement).not.toHaveAttribute("data-theme")
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system")
  })
})
