import { expect, test } from "@playwright/test"
import { API_SCREEN_IDS, COMPONENT_COUNT, SCREEN_COUNT, buildFixtureGraph } from "./fixture-graph.js"
import { REPORT_PL_URL } from "./global-setup.js"

const deadLinkCount = buildFixtureGraph().deadNavLinks.length

test("tabs and the palette placeholder are translated", async ({ page }) => {
  await page.goto(REPORT_PL_URL)
  await expect(page.getByRole("tab", { name: "Ekrany" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Ustalenia" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Screens" })).toHaveCount(0)
  await page.locator("body").press("ControlOrMeta+K")
  await expect(page.getByPlaceholder("Wpisz polecenie lub nazwę ekranu…")).toBeVisible()
})

test("the dead-links alarm uses the Polish few form", async ({ page }) => {
  expect(deadLinkCount).toBe(2)
  await page.goto(`${REPORT_PL_URL}#tab=findings`)
  const section = page.getByRole("region", { name: "Martwe linki nawigacyjne" })
  await expect(section.getByRole("alert")).toContainText("2 martwe linki")
})

test("the screen count uses the Polish many, one and few forms", async ({ page }) => {
  await page.goto(REPORT_PL_URL)
  await page.getByLabel("Znajdź ekran").fill("screen-admin")
  await expect(page.getByText("18 ekranów", { exact: true })).toBeVisible()
  await page.getByLabel("Znajdź ekran").fill("screen-app-03")
  await expect(page.getByText("1 ekran", { exact: true })).toBeVisible()
  await page.getByLabel("Znajdź ekran").fill("page-00")
  await expect(page.getByText("3 ekrany", { exact: true })).toBeVisible()
})

test("the components table row count is translated", async ({ page }) => {
  await page.goto(`${REPORT_PL_URL}#tab=components`)
  await expect(page.getByText(`Wiersze: ${COMPONENT_COUNT} z ${COMPONENT_COUNT}`)).toBeVisible()
})

test("the header shows a translated stat with the screen total", async ({ page }) => {
  await page.goto(REPORT_PL_URL)
  await expect(page.locator('header [data-slot="count-stat"]').first()).toContainText(`${SCREEN_COUNT - API_SCREEN_IDS.length}ekranów`)
})
