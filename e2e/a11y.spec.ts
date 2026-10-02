import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { REPORT_URL } from "./global-setup.js"

const TABS = ["screens", "map", "menu", "components", "findings"] as const
const THEMES = ["light", "dark"] as const
const VIEWPORTS = [
  { width: 1512, height: 905 },
  { width: 390, height: 844 },
] as const
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] as const
const BLOCKING_IMPACTS = ["serious", "critical"]

const scan = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze()
  return violations
    .filter((violation) => BLOCKING_IMPACTS.includes(violation.impact ?? ""))
    .map((violation) => ({ rule: violation.id, impact: violation.impact, targets: violation.nodes.map((node) => node.target.join(" ")) }))
}

const openReport = async (page: Page, theme: (typeof THEMES)[number], hash: string) => {
  await page.addInitScript((value) => localStorage.setItem("appgraph-theme", value), theme)
  await page.goto(`${REPORT_URL}${hash}`)
  await page.getByRole("tabpanel").first().waitFor()
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`${theme} ${viewport.width}px`, () => {
      test.use({ viewport, reducedMotion: "reduce" })

      for (const tab of TABS) {
        test(`${tab} tab has no serious or critical violations`, async ({ page }) => {
          await openReport(page, theme, `#tab=${tab}`)
          expect(await scan(page)).toEqual([])
        })
      }

      test("shortcuts dialog has no serious or critical violations", async ({ page }) => {
        await openReport(page, theme, "#tab=screens")
        await page.locator("body").press("?")
        await expect(page.getByRole("dialog")).toBeVisible()
        expect(await scan(page)).toEqual([])
      })

      test("command palette has no serious or critical violations", async ({ page }) => {
        await openReport(page, theme, "#tab=screens")
        await page.locator("body").press("ControlOrMeta+K")
        await expect(page.getByRole("dialog")).toBeVisible()
        expect(await scan(page)).toEqual([])
      })
    })
  }
}
