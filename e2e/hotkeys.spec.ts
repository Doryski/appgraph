import { expect, test } from "@playwright/test"
import { DEEP_LINK_SCREEN_ID } from "./fixture-graph.js"
import { REPORT_URL } from "./global-setup.js"

test("? opens the shortcuts dialog and Escape closes it", async ({ page }) => {
  await page.goto(REPORT_URL)
  await page.locator("body").press("?")
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText("Go to Findings")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

test("g then f switches to Findings", async ({ page }) => {
  await page.goto(REPORT_URL)
  await page.locator("body").press("g")
  await page.keyboard.press("f")
  await expect(page).toHaveURL(/#tab=findings$/)
  await expect(page.getByRole("tab", { name: "Findings" })).toHaveAttribute("aria-selected", "true")
})

test("Mod+K palette jumps to a screen", async ({ page }) => {
  await page.goto(`${REPORT_URL}#tab=components`)
  await page.locator("body").press("ControlOrMeta+K")
  const input = page.getByPlaceholder("Type a command or screen name…")
  await expect(input).toBeFocused()
  await input.fill(DEEP_LINK_SCREEN_ID)
  await page.getByRole("option").first().click()
  await expect(page).toHaveURL(new RegExp(`screen=${DEEP_LINK_SCREEN_ID}`))
  await expect(page.getByRole("tab", { name: "Screens" })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

test("the header palette button opens the palette", async ({ page }) => {
  await page.goto(REPORT_URL)
  await page.getByRole("button", { name: "Open command palette" }).click()
  await expect(page.getByPlaceholder("Type a command or screen name…")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
})
