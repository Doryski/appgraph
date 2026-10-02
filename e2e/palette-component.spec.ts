import { expect, test } from "@playwright/test"
import { COMPONENT_COUNT } from "./fixture-graph.js"
import { REPORT_URL } from "./global-setup.js"

const PICKED_COMPONENT = "Component123"

test("picking a component in the palette opens Components filtered to it", async ({ page }) => {
  await page.goto(REPORT_URL)
  await page.locator("body").press("ControlOrMeta+K")
  const input = page.getByPlaceholder("Type a command or screen name…")
  await input.fill(PICKED_COMPONENT)
  await page.locator('[data-palette-group="components"]').getByRole("option", { name: new RegExp(PICKED_COMPONENT) }).click()
  await expect(page).toHaveURL(/#tab=components/)
  await expect(page.getByRole("tab", { name: "Components" })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByText(`Rows: 1 of ${COMPONENT_COUNT}`)).toBeVisible()
  await expect(page.getByRole("cell", { name: PICKED_COMPONENT }).first()).toBeVisible()
  await expect(page.getByRole("searchbox", { name: "Find a component" })).toHaveValue(/Component123/)
})
