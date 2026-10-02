import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { DEEP_LINK_SCREEN_ID, HEAVY_ENDPOINT_COUNT, HEAVY_ENDPOINT_SCREEN_ID, buildFixtureGraph } from "./fixture-graph.js"
import { REPORT_URL } from "./global-setup.js"

const API_KIND_TAGS = new Set(["apiRoute", "api"])

const humanScreens = buildFixtureGraph().screens.filter(
  (screen) => screen.kindTag === null || !API_KIND_TAGS.has(screen.kindTag),
)

const firstHumanScreen = humanScreens[0]!

const deepLinkIndex = humanScreens.findIndex((screen) => screen.id === DEEP_LINK_SCREEN_ID)

const neighbourScreen = humanScreens[deepLinkIndex + 1]!

const detail = (page: Page) => page.locator('[data-slot="screen-detail"]')

const listRow = (page: Page, id: string) =>
  page.getByRole("list", { name: "Screens" }).locator(`[data-screen-id="${id}"]`)

test("a deep link selects that screen", async ({ page }) => {
  await page.goto(`${REPORT_URL}#tab=screens&screen=${DEEP_LINK_SCREEN_ID}`)
  await expect(detail(page)).toHaveAttribute("data-screen-id", DEEP_LINK_SCREEN_ID)
  await expect(listRow(page, DEEP_LINK_SCREEN_ID)).toHaveAttribute("aria-current", "true")
})

test("clicking another screen then going back restores the deep-linked one", async ({ page }) => {
  await page.goto(`${REPORT_URL}#tab=screens&screen=${DEEP_LINK_SCREEN_ID}`)
  await expect(detail(page)).toHaveAttribute("data-screen-id", DEEP_LINK_SCREEN_ID)
  await listRow(page, neighbourScreen.id).click()
  await expect(page).toHaveURL(new RegExp(`screen=${neighbourScreen.id}$`))
  await expect(detail(page)).toHaveAttribute("data-screen-id", neighbourScreen.id)
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`screen=${DEEP_LINK_SCREEN_ID}$`))
  await expect(detail(page)).toHaveAttribute("data-screen-id", DEEP_LINK_SCREEN_ID)
})

test("an unknown screen in the hash shows a toast and falls back to the first screen", async ({ page }) => {
  await page.goto(`${REPORT_URL}#tab=screens&screen=no-such-screen`)
  await expect(page.getByText("Screen “no-such-screen” is not in this report.")).toBeVisible()
  await expect(detail(page)).toHaveAttribute("data-screen-id", firstHumanScreen.id)
})

test("filtering keeps the selected screen and the hash", async ({ page }) => {
  await page.goto(`${REPORT_URL}#tab=screens&screen=${DEEP_LINK_SCREEN_ID}`)
  await page.getByLabel("Find a screen").fill("settings")
  await expect(page).toHaveURL(new RegExp(`screen=${DEEP_LINK_SCREEN_ID}$`))
  await expect(detail(page)).toHaveAttribute("data-screen-id", DEEP_LINK_SCREEN_ID)
})

test("the heavy endpoint screen renders its endpoints table", async ({ page }) => {
  await page.goto(`${REPORT_URL}#tab=screens&screen=${HEAVY_ENDPOINT_SCREEN_ID}`)
  const endpoints = detail(page).locator('[data-section="endpoints"]')
  await expect(endpoints.getByRole("table")).toBeVisible()
  await expect(endpoints.getByText(`Rows: ${HEAVY_ENDPOINT_COUNT} of ${HEAVY_ENDPOINT_COUNT}`)).toBeVisible()
  await expect(endpoints.locator('[data-slot="method-badge"]').first()).toBeVisible()
})
