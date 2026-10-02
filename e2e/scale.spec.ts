import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, test } from "@playwright/test"
import { renderHtml } from "../src/emit/html.js"
import {
  LARGE_COMPONENT_COUNT,
  LARGE_FAR_COMPONENT,
  LARGE_FAR_SCREEN_ID,
  LARGE_FAR_SCREEN_LABEL,
  LARGE_SCREEN_COUNT,
  buildLargeFixtureGraph,
} from "./fixture-graph-large.js"

const REPORT_LARGE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), ".out", "report-large.html")
const LARGE_URL = pathToFileURL(REPORT_LARGE_PATH).href
const MAX_DOM_ROWS = 60

test.beforeAll(() => {
  mkdirSync(dirname(REPORT_LARGE_PATH), { recursive: true })
  writeFileSync(REPORT_LARGE_PATH, renderHtml(buildLargeFixtureGraph(), { noTimestamp: true }))
})

test("a 3000-screen report loads and keeps the list virtualized", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${LARGE_URL}#tab=screens`)
  await expect(page.getByText(`${LARGE_SCREEN_COUNT} screens`, { exact: true })).toBeVisible()
  const rows = page.getByRole("list", { name: "Screens" }).locator("[data-screen-id]")
  await expect(rows.first()).toBeVisible()
  expect(await rows.count()).toBeLessThan(MAX_DOM_ROWS)
  expect(errors).toEqual([])
})

test("selecting a far-down screen via the palette scrolls it into view", async ({ page }) => {
  await page.goto(`${LARGE_URL}#tab=screens`)
  await page.locator("body").press("ControlOrMeta+K")
  await page.getByPlaceholder("Type a command or screen name…").fill(LARGE_FAR_SCREEN_ID)
  await page.locator('[data-palette-group="screens"]').getByRole("option").first().click()
  await expect(page).toHaveURL(new RegExp(`screen=${LARGE_FAR_SCREEN_ID}$`))
  await expect(page.locator('[data-slot="screen-detail"]')).toHaveAttribute("data-screen-id", LARGE_FAR_SCREEN_ID)
  const row = page.getByRole("list", { name: "Screens" }).locator(`[data-screen-id="${LARGE_FAR_SCREEN_ID}"]`)
  await expect(row).toBeInViewport()
  await expect(row).toHaveAttribute("aria-current", "true")
  await expect(row).toContainText(LARGE_FAR_SCREEN_LABEL)
})

test("the components table stays virtualized and filterable", async ({ page }) => {
  await page.goto(`${LARGE_URL}#tab=components`)
  await expect(page.getByText(`Rows: ${LARGE_COMPONENT_COUNT} of ${LARGE_COMPONENT_COUNT}`)).toBeVisible()
  expect(await page.locator("[data-virtualized] tbody tr").count()).toBeLessThan(MAX_DOM_ROWS * 2)
  await page.getByRole("searchbox", { name: "Find a component" }).fill(LARGE_FAR_COMPONENT)
  await expect(page.getByText(`Rows: 1 of ${LARGE_COMPONENT_COUNT}`)).toBeVisible()
})

test("the map tab renders for 3000 screens", async ({ page }) => {
  await page.goto(`${LARGE_URL}#tab=map`)
  await expect(page.getByRole("group", { name: "Navigation map of screens" })).toBeVisible({ timeout: 30_000 })
})
