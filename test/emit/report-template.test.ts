import { describe, expect, it } from "vitest"
import { REPORT_TEMPLATE } from "../../src/emit/assets/generated.js"
import { REPORT_PLACEHOLDERS } from "../../src/emit/html.js"

const TEMPLATE_BUDGET_BYTES = 1_000_000

const occurrences = (text: string, token: string): number => text.split(token).length - 1

describe("REPORT_TEMPLATE contract", () => {
  it.each(Object.values(REPORT_PLACEHOLDERS))("contains %s exactly once", (token) => {
    expect(occurrences(REPORT_TEMPLATE, token)).toBe(1)
  })

  it.each(["<link", 'src="http', "src='http", 'href="http', "href='http", "url(http", "url('http", 'url("http'])(
    "has no external reference %s",
    (needle) => {
      expect(REPORT_TEMPLATE).not.toContain(needle)
    },
  )

  it(`stays within the ${TEMPLATE_BUDGET_BYTES} byte budget`, () => {
    expect(Buffer.byteLength(REPORT_TEMPLATE, "utf8")).toBeLessThanOrEqual(TEMPLATE_BUDGET_BYTES)
  })
})
