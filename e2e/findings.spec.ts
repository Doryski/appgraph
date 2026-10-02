import { expect, test } from "@playwright/test"
import { REPORT_URL } from "./global-setup.js"

const FINDINGS_URL = `${REPORT_URL}#tab=findings`

test("all four sections and the limitations are visible", async ({ page }) => {
  await page.goto(FINDINGS_URL)
  for (const name of ["Dead navigation links", "Orphan screens", "Data confidence", "Diagnostics"]) {
    await expect(page.getByRole("region", { name })).toBeVisible()
  }
  await expect(page.locator("#limitations")).toBeVisible()
  await expect(page.locator("#limitations li")).toHaveCount(3)
})

test("dead links raise an alarm with text", async ({ page }) => {
  await page.goto(FINDINGS_URL)
  const section = page.getByRole("region", { name: "Dead navigation links" })
  await expect(section.getByRole("alert")).toContainText("2 dead links")
  await expect(section.getByText("/gone/one")).toBeVisible()
})

test("a suspect confidence row shows its flag", async ({ page }) => {
  await page.goto(FINDINGS_URL)
  const section = page.getByRole("region", { name: "Data confidence" })
  await expect(section.getByText("empty (unexpected)")).toBeVisible()
  await expect(section.getByText("unexpectedly empty")).toBeVisible()
})

test("the severity filter narrows the diagnostics", async ({ page }) => {
  await page.goto(FINDINGS_URL)
  const section = page.getByRole("region", { name: "Diagnostics" })
  await expect(section.getByRole("row")).toHaveCount(5)
  await section.getByRole("combobox", { name: "Severity" }).click()
  await page.getByRole("option", { name: "Warnings" }).click()
  await expect(section.getByRole("row")).toHaveCount(3)
  await expect(section.getByText("W_DYNAMIC")).toBeVisible()
  await expect(section.getByText("E_PARSE")).toHaveCount(0)
})

test("an orphan chip opens the screen", async ({ page }) => {
  await page.goto(FINDINGS_URL)
  await page.getByRole("region", { name: "Orphan screens" }).getByRole("button", { name: /^\// }).first().click()
  await expect(page).toHaveURL(/#tab=screens&screen=/)
})
