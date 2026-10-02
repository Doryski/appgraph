import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { REPORT_URL } from "./global-setup.js"

const rootScheme = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)

const background = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor)

test.describe("OS dark", () => {
  test.use({ colorScheme: "dark" })

  test("with no stored theme the report follows the OS dark scheme", async ({ page }) => {
    await page.goto(REPORT_URL)
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/)
    expect(await rootScheme(page)).toBe("dark")
    await page.getByRole("button", { name: "Theme" }).click()
    await expect(page.getByRole("menuitemradio", { name: "System" })).toHaveAttribute("aria-checked", "true")
  })

  test("an explicit light choice overrides the OS dark scheme", async ({ page }) => {
    await page.goto(REPORT_URL)
    const darkBackground = await background(page)
    await page.getByRole("button", { name: "Theme" }).click()
    await page.getByRole("menuitemradio", { name: "Light" }).click()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
    expect(await rootScheme(page)).toBe("light")
    expect(await background(page)).not.toBe(darkBackground)
  })
})

test.describe("OS light", () => {
  test.use({ colorScheme: "light" })

  test("with no stored theme the report follows the OS light scheme", async ({ page }) => {
    await page.goto(REPORT_URL)
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/)
    expect(await rootScheme(page)).toBe("light")
  })
})
