import { expect, test } from "@playwright/test"
import { MISSING_NAV_PATH } from "./fixture-graph.js"
import { REPORT_URL } from "./global-setup.js"

const MENU_URL = `${REPORT_URL}#tab=menu`

test("sorting by path reorders the menu rows", async ({ page }) => {
  await page.goto(MENU_URL)
  const paths = page.locator("tbody tr td:nth-child(4)")
  await expect(paths.first()).toBeVisible()
  await page.getByRole("button", { name: /Sort by Path/ }).click()
  await expect(page.getByRole("columnheader", { name: /Path/ })).toHaveAttribute("aria-sort", "ascending")
  const texts = (await paths.allTextContents()).map((text) => text.replace(/\(missing from router\)/, "").trim())
  expect(texts).toEqual([...texts].sort())
})

test("missing entries carry a text badge", async ({ page }) => {
  await page.goto(MENU_URL)
  await expect(page.getByText("(missing from router)")).toHaveCount(1)
  await expect(page.getByText(MISSING_NAV_PATH)).toBeVisible()
})

test("clicking a path opens that screen in the Screens tab", async ({ page }) => {
  await page.goto(MENU_URL)
  await page.locator("tbody tr td:nth-child(4) button").first().click()
  await expect(page).toHaveURL(/#tab=screens&screen=screen-/)
  await expect(page.getByRole("tab", { name: "Screens" })).toHaveAttribute("aria-selected", "true")
})
