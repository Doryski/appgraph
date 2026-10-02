import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { DEEP_LINK_SCREEN_ID, HEAVY_ENDPOINT_SCREEN_ID, buildFixtureGraph } from "./fixture-graph.js"
import { REPORT_URL } from "./global-setup.js"

const PALETTE_PLACEHOLDER = "Type a command or screen name…"

const API_KIND_TAGS = new Set(["apiRoute", "api"])

const humanScreens = buildFixtureGraph().screens.filter(
  (screen) => screen.kindTag === null || !API_KIND_TAGS.has(screen.kindTag),
)

const idAt = (id: string, offset: number) => humanScreens[humanScreens.findIndex((screen) => screen.id === id) + offset]!.id

const detail = (page: Page) => page.locator('[data-slot="screen-detail"]')

const listRow = (page: Page, id: string) =>
  page.getByRole("list", { name: "Screens" }).locator(`[data-screen-id="${id}"]`)

const openScreen = async (page: Page, id: string) => {
  await page.goto(`${REPORT_URL}#tab=screens&screen=${id}`)
  await expect(detail(page)).toHaveAttribute("data-screen-id", id)
}

const expectSelected = (page: Page, id: string) => expect(detail(page)).toHaveAttribute("data-screen-id", id)

test.describe("screen list keyboard navigation", () => {
  test("j/k and arrow keys move the selection when the list has focus", async ({ page }) => {
    await openScreen(page, DEEP_LINK_SCREEN_ID)
    await listRow(page, DEEP_LINK_SCREEN_ID).focus()
    await page.keyboard.press("j")
    await expectSelected(page, idAt(DEEP_LINK_SCREEN_ID, 1))
    await page.keyboard.press("ArrowDown")
    await expectSelected(page, idAt(DEEP_LINK_SCREEN_ID, 2))
    await page.keyboard.press("k")
    await expectSelected(page, idAt(DEEP_LINK_SCREEN_ID, 1))
    await page.keyboard.press("ArrowUp")
    await expectSelected(page, DEEP_LINK_SCREEN_ID)
  })

  test("ArrowDown inside the screen detail does not change the selected screen", async ({ page }) => {
    await openScreen(page, HEAVY_ENDPOINT_SCREEN_ID)
    const control = detail(page).locator("button, [tabindex='0'], a[href]").first()
    await expect(control).toBeVisible()
    await control.focus()
    await expect(control).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("j")
    await page.keyboard.press("ArrowUp")
    await expectSelected(page, HEAVY_ENDPOINT_SCREEN_ID)
    await expect(page).toHaveURL(new RegExp(`screen=${HEAVY_ENDPOINT_SCREEN_ID}$`))
  })

  test("ArrowDown on a table cell inside the detail does not change the selected screen", async ({ page }) => {
    await openScreen(page, HEAVY_ENDPOINT_SCREEN_ID)
    const table = detail(page).locator('[data-section="endpoints"]').getByRole("table")
    await expect(table).toBeVisible()
    await table.evaluate((node) => {
      const target = node.querySelector<HTMLElement>("[tabindex], button, a[href]") ?? node
      target.tabIndex = target.tabIndex < 0 ? 0 : target.tabIndex
      target.focus()
    })
    await page.keyboard.press("ArrowDown")
    await expectSelected(page, HEAVY_ENDPOINT_SCREEN_ID)
  })
})

test.describe("search and palette hotkeys", () => {
  test("/ focuses the screen search field", async ({ page }) => {
    await openScreen(page, DEEP_LINK_SCREEN_ID)
    await page.locator("body").press("/")
    await expect(page.getByLabel("Find a screen")).toBeFocused()
    await expect(page.getByLabel("Find a screen")).toHaveValue("")
  })

  test("/ focuses the search field of the current tab", async ({ page }) => {
    await page.goto(`${REPORT_URL}#tab=components`)
    await page.locator("body").press("/")
    await expect(page.getByRole("searchbox", { name: "Find a component" })).toBeFocused()
  })

  test("Ctrl/Cmd+K inside a filter input opens the palette", async ({ page }) => {
    await page.goto(`${REPORT_URL}#tab=components`)
    const filter = page.getByRole("searchbox", { name: "Find a component" })
    await filter.focus()
    await filter.press("ControlOrMeta+K")
    await expect(page.getByRole("dialog")).toBeVisible()
    await expect(page.getByPlaceholder(PALETTE_PLACEHOLDER)).toBeFocused()
  })

  test("Ctrl/Cmd+K inside the screens filter opens the palette", async ({ page }) => {
    await openScreen(page, DEEP_LINK_SCREEN_ID)
    const filter = page.getByLabel("Find a screen")
    await filter.focus()
    await filter.press("ControlOrMeta+K")
    await expect(page.getByPlaceholder(PALETTE_PLACEHOLDER)).toBeFocused()
  })
})

test.describe("focus return after closing a dialog", () => {
  test("the palette button regains focus after Escape", async ({ page }) => {
    await page.goto(REPORT_URL)
    const trigger = page.getByRole("button", { name: "Open command palette" })
    await trigger.click()
    await expect(page.getByPlaceholder(PALETTE_PLACEHOLDER)).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test("the previously focused filter regains focus after the palette closes", async ({ page }) => {
    await page.goto(`${REPORT_URL}#tab=components`)
    const filter = page.getByRole("searchbox", { name: "Find a component" })
    await filter.focus()
    await filter.press("ControlOrMeta+K")
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(filter).toBeFocused()
  })

  test("the glossary button regains focus after Escape", async ({ page }) => {
    await page.goto(REPORT_URL)
    const trigger = page.getByRole("button", { name: "Glossary" })
    await trigger.click()
    await expect(page.getByRole("dialog", { name: "Glossary of terms" })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test("the palette button regains focus after the shortcuts dialog opened from the palette closes", async ({ page }) => {
    await page.goto(REPORT_URL)
    const trigger = page.getByRole("button", { name: "Open command palette" })
    await trigger.click()
    await page.getByRole("option", { name: /Keyboard shortcuts/ }).click()
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })
})
