import { expect, test } from "@playwright/test"
import { REPORT_URL } from "./global-setup.js"

const TAB_NAMES = ["Screens", "Navigation map", "Menu", "Components", "Findings"] as const

test("header shows the four key stats", async ({ page }) => {
  await page.goto(REPORT_URL)
  const stats = page.locator('header [data-slot="count-stat"]')
  await expect(stats).toHaveCount(4)
  await expect(stats.first()).toBeVisible()
})

test("back and forward restore the tab", async ({ page }) => {
  await page.goto(REPORT_URL)
  await page.getByRole("tab", { name: "Components" }).click()
  await expect(page).toHaveURL(/#tab=components$/)
  await page.getByRole("tab", { name: "Findings" }).click()
  await expect(page.getByRole("tab", { name: "Findings" })).toHaveAttribute("aria-selected", "true")
  await page.goBack()
  await expect(page.getByRole("tab", { name: "Components" })).toHaveAttribute("aria-selected", "true")
  await page.goBack()
  await expect(page.getByRole("tab", { name: "Screens" })).toHaveAttribute("aria-selected", "true")
  await page.goForward()
  await expect(page.getByRole("tab", { name: "Components" })).toHaveAttribute("aria-selected", "true")
})

test("a reload keeps the tab from the hash", async ({ page }) => {
  await page.goto(`${REPORT_URL}#tab=menu`)
  await expect(page.getByRole("tab", { name: "Menu" })).toHaveAttribute("aria-selected", "true")
})

test("theme choice survives a reload", async ({ page }) => {
  await page.goto(REPORT_URL)
  await page.getByRole("button", { name: "Theme" }).click()
  await page.getByRole("menuitemradio", { name: "Dark" }).click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await page.getByRole("button", { name: "Theme" }).click()
  await expect(page.getByRole("menuitemradio", { name: "Dark" })).toHaveAttribute("aria-checked", "true")
})

test("glossary opens and Escape closes it", async ({ page }) => {
  await page.goto(REPORT_URL)
  await page.getByRole("button", { name: "Glossary" }).click()
  await expect(page.getByRole("dialog", { name: "Glossary of terms" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

test("dead links stat jumps to Findings", async ({ page }) => {
  await page.goto(REPORT_URL)
  await page.locator('[data-stat-id="deadLinks"] button').first().click()
  await expect(page).toHaveURL(/#tab=findings$/)
})

test.describe("phone width", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

  test("shows a bottom bar with all five tabs and no horizontal scroll", async ({ page }) => {
    await page.goto(REPORT_URL)
    const bar = page.getByRole("tablist", { name: "Report sections" })
    await expect(bar.getByRole("tab")).toHaveCount(TAB_NAMES.length)
    const box = await bar.boundingBox()
    expect(box).not.toBeNull()
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeCloseTo(812, 0)
    for (const name of TAB_NAMES) {
      const tabBox = await bar.getByRole("tab", { name }).boundingBox()
      expect(tabBox?.height ?? 0).toBeGreaterThanOrEqual(44)
      expect(tabBox?.width ?? 0).toBeGreaterThanOrEqual(44)
    }
    await bar.getByRole("tab", { name: "Findings" }).tap()
    await expect(page).toHaveURL(/#tab=findings$/)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBe(0)
  })
})
