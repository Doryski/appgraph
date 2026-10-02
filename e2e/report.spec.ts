import { expect, test, type Page } from "@playwright/test"
import { FIXTURE_APP_NAME } from "./fixture-graph.js"
import { REPORT_PL_URL, REPORT_URL } from "./global-setup.js"

const ALLOWED_PROTOCOLS = ["file:", "data:"] as const

const openCollecting = async (page: Page, url: string) => {
  const consoleErrors: string[] = []
  const requests: string[] = []
  page.on("console", (message) => message.type() === "error" && consoleErrors.push(message.text()))
  page.on("pageerror", (error) => consoleErrors.push(error.message))
  page.on("request", (request) => requests.push(request.url()))
  await page.goto(url)
  await expect(page.getByText(FIXTURE_APP_NAME).first()).toBeVisible()
  return { consoleErrors, requests }
}

test("report opens from file:// without console errors", async ({ page }) => {
  const { consoleErrors } = await openCollecting(page, REPORT_URL)
  expect(consoleErrors).toEqual([])
})

test("report makes only file: or data: requests", async ({ page }) => {
  const { requests } = await openCollecting(page, REPORT_URL)
  const offenders = requests.filter((url) => !ALLOWED_PROTOCOLS.some((protocol) => url.startsWith(protocol)))
  expect(offenders).toEqual([])
})

test("html lang is en for the default report", async ({ page }) => {
  await openCollecting(page, REPORT_URL)
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
})

test("html lang is pl for the pl report", async ({ page }) => {
  await openCollecting(page, REPORT_PL_URL)
  await expect(page.locator("html")).toHaveAttribute("lang", "pl")
})
