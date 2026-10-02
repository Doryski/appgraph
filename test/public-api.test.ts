import { readFileSync } from "node:fs"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as api from "../src/index.js"
import type { AncestorRef, AppGraph, GraphRedirect, SlotBranch } from "../src/index.js"
import { defineConfig as canonical } from "../src/config/define.js"

/**
 * The published surface is `analyze`, `defineConfig`, `BUILTIN_KINDS`, the emitted data-model
 * types and `AnalyzeOptions`/`AnalyzeResult`. A value escaping from `core/` or `pipeline/` would turn an
 * internal contract into a promise nobody agreed to keep.
 */
describe("the public API surface", () => {
  it("exports exactly the three runtime values 0.1 promises", () => {
    expect(Object.keys(api).sort()).toEqual(["BUILTIN_KINDS", "analyze", "defineConfig"])
  })

  it("re-exports the ONE defineConfig rather than declaring a second one", () => {
    expect(api.defineConfig).toBe(canonical)
    expect(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")).not.toContain(
      "export const defineConfig",
    )
  })

  it("exports only type names out of core/ and pipeline/", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
    const valueExports = source
      .split("\n")
      .filter((line) => line.startsWith("export ") && !line.startsWith("export type"))

    expect(valueExports).toEqual([
      'export { publicAnalyze as analyze } from "./pipeline/run.js"',
      'export { defineConfig } from "./config/define.js"',
      'export { BUILTIN_KINDS } from "./core/model.js"',
    ])
  })

  it("types analyze() with only the documented options — no internal injection points", () => {
    type Options = NonNullable<Parameters<typeof api.analyze>[0]>
    expectTypeOf<Options>().toEqualTypeOf<api.AnalyzeOptions>()
    expectTypeOf<Options>().not.toHaveProperty("ts")
    expectTypeOf<Options>().not.toHaveProperty("host")
    expectTypeOf<Options>().not.toHaveProperty("adapters")
    expectTypeOf<Options>().not.toHaveProperty("extractors")
    expectTypeOf<Options>().not.toHaveProperty("emitters")
    expectTypeOf<Options>().not.toHaveProperty("detections")
    expectTypeOf<Options>().not.toHaveProperty("vueCompiler")
  })

  it("exports the element types of AncestorRef.branches and AppGraph.redirects", () => {
    expectTypeOf<NonNullable<AncestorRef["branches"]>[number]>().toEqualTypeOf<SlotBranch>()
    expectTypeOf<AppGraph["redirects"][number]>().toEqualTypeOf<GraphRedirect>()
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
    expect(source).toMatch(/^ {2}GraphRedirect,$/m)
    expect(source).toMatch(/^ {2}SlotBranch,$/m)
  })
})
