import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { buildReportPayload } from "../src/emit/report-payload.js"
import { DEEP_LINK_SCREEN_ID, buildFixtureGraph } from "./fixture-graph.js"
import { REPORT_URL } from "./global-setup.js"

const FILTER_QUERY = "admin"

const expectedMatches = () => {
  const { graph } = buildReportPayload(buildFixtureGraph(), { locale: "en", generatedAt: null })
  return graph.nodes.filter((node) => `${node.url} ${node.title ?? ""}`.toLowerCase().includes(FILTER_QUERY)).length
}

const openMap = async (page: Page) => {
  await page.goto(`${REPORT_URL}#tab=map`)
  const svg = page.getByRole("group", { name: "Navigation map of screens" })
  await expect(svg).toBeVisible()
  return svg
}

test("zoom buttons change the viewBox and fit restores it", async ({ page }) => {
  const svg = await openMap(page)
  const initial = await svg.getAttribute("viewBox")
  await page.getByRole("button", { name: "Zoom in" }).click()
  await page.getByRole("button", { name: "Zoom in" }).click()
  await expect(svg).not.toHaveAttribute("viewBox", initial ?? "")
  const zoomed = await svg.getAttribute("viewBox")
  await page.getByRole("button", { name: "Zoom out" }).click()
  await expect(svg).not.toHaveAttribute("viewBox", zoomed ?? "")
  await page.getByRole("button", { name: "Fit to view" }).click()
  await expect(svg).toHaveAttribute("viewBox", initial ?? "")
})

test("clicking a node opens that screen in the Screens tab", async ({ page }) => {
  const svg = await openMap(page)
  await svg.locator(`g[data-node-id="${DEEP_LINK_SCREEN_ID}"]`).click()
  await expect(page).toHaveURL(new RegExp(`tab=screens&screen=${DEEP_LINK_SCREEN_ID}$`))
})

test("the filter announces how many screens match", async ({ page }) => {
  await openMap(page)
  await page.getByLabel("Highlight screens on the map").fill(FILTER_QUERY)
  const count = expectedMatches()
  await expect(page.locator('[data-slot="map-match-count"]')).toHaveText(`${count} matching screens`)
  await page.getByLabel("Highlight screens on the map").fill("zzz-no-such-screen")
  await expect(page.locator('[data-slot="map-match-count"]')).toHaveText("0 matching screens")
})
