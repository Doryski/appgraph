import { describe, expect, it } from "vitest"
import { extractTemplate, renderAssetsModule } from "../../scripts/generate-assets.js"
import { REPORT_TEMPLATE } from "../../src/emit/assets/generated.js"

describe("generated template module", () => {
  it("survives re-generation from arbitrary template text", () => {
    const hostile = "<html>\n `${\"$\"}{x}`</script>\nexport const REPORT_TEMPLATE = \"\"\n"
    const module = renderAssetsModule(hostile)
    expect(module).toContain(JSON.stringify(hostile))
    expect(extractTemplate(module)).toBe(hostile)
  })

  it("round-trips the generated template through the module text", () => {
    expect(extractTemplate(renderAssetsModule(REPORT_TEMPLATE))).toBe(REPORT_TEMPLATE)
  })

  it("exports nothing but the template", () => {
    expect(renderAssetsModule("x").match(/^export /gm)).toHaveLength(1)
  })

  it("reports a module without a template as missing one", () => {
    expect(extractTemplate("export const OTHER = \"\"\n")).toBeNull()
  })
})
