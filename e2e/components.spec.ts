import { expect, test } from "@playwright/test"
import { COMPONENT_COUNT, LOW_RANK_COMPONENT } from "./fixture-graph.js"
import { REPORT_URL } from "./global-setup.js"

const COMPONENTS_URL = `${REPORT_URL}#tab=components`

test("a component ranked past 400 is found by filtering", async ({ page }) => {
  await page.goto(COMPONENTS_URL)
  await expect(page.getByText(`Rows: ${COMPONENT_COUNT} of ${COMPONENT_COUNT}`)).toBeVisible()
  await page.getByRole("searchbox", { name: "Find a component" }).fill(LOW_RANK_COMPONENT)
  await expect(page.getByText(`Rows: 1 of ${COMPONENT_COUNT}`)).toBeVisible()
  await expect(page.getByRole("cell", { name: LOW_RANK_COMPONENT }).first()).toBeVisible()
})

test("the table scrolls to the last rows and keeps its header sticky", async ({ page }) => {
  await page.goto(COMPONENTS_URL)
  const container = page.locator("[data-virtualized]")
  await expect(container).toBeVisible()
  await container.evaluate((node) => {
    node.scrollTop = node.scrollHeight
  })
  await expect(page.getByRole("cell", { name: LOW_RANK_COMPONENT }).first()).toBeVisible()
  const containerBox = await container.boundingBox()
  const headerBox = await container.locator("thead").boundingBox()
  expect(containerBox).not.toBeNull()
  expect(headerBox).not.toBeNull()
  expect(headerBox!.y).toBeGreaterThanOrEqual(containerBox!.y - 1)
  expect(headerBox!.y).toBeLessThanOrEqual(containerBox!.y + 2)
})
