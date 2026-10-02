import type { AppgraphConfig } from "../../src/core/model.js"
import { describe, expect, it } from "vitest"
import { PRESETS, PRESET_NAMES } from "../../src/config/presets.js"
import { TRAVERSABLE_VOCABULARY, isTraversable, kindOf } from "../../src/core/kinds.js"

/**
 * Without a traversable directory rule the `uses` reachability default rests on the `HOOK_FILE`
 * filename regex alone. On a repo whose data layer is `src/server/orders.ts` that regex matches
 * nothing, so `src/server/**` would never enter the graph and its `createServerFn` endpoints would go
 * unreported.
 */
describe("presets: every stack ships real traversable directory rules", () => {
  for (const name of PRESET_NAMES) {
    const preset = PRESETS[name as keyof typeof PRESETS]

    it(`'${name}' marks at least one directory traversable`, () => {
      expect(preset.kindRules.some((rule) => rule.traversable)).toBe(true)
    })

    it(`'${name}' covers the whole data-layer vocabulary, not just hooks`, () => {
      const prefixes = preset.kindRules
        .filter((rule) => rule.traversable)
        .map((rule) => rule.match.pathPrefix)

      for (const entry of TRAVERSABLE_VOCABULARY)
        for (const directory of entry.names) expect(prefixes).toContain(`src/${directory}/`)
    })

    it(`'${name}' makes a kebab-case server data layer traversable without any filename help`, () => {
      expect(kindOf(preset.kindRules, { file: "src/server/pricing-tiers.ts" })).toBe("service")
      expect(isTraversable(preset.kindRules, { file: "src/server/pricing-tiers.ts" })).toBe(true)
      expect(isTraversable(preset.kindRules, { file: "src/services/order-client.ts" })).toBe(true)
      expect(isTraversable(preset.kindRules, { file: "src/stores/auth-store.ts" })).toBe(true)
      expect(isTraversable(preset.kindRules, { file: "src/hooks/use-orders.ts" })).toBe(true)
    })

    it(`'${name}' does not make the shared grab-bag traversable`, () => {
      expect(isTraversable(preset.kindRules, { file: "src/shared/format.ts" })).toBe(false)
      expect(isTraversable(preset.kindRules, { file: "src/components/Button.tsx" })).toBe(false)
    })
  }

  it("keeps each stack's own screen-entry rules alongside the data-layer ones", () => {
    expect(kindOf(PRESETS["tanstack-router"].kindRules, { file: "src/routes/orders.tsx" })).toBe("module")
    expect(kindOf(PRESETS["next-app"].kindRules, { file: "app/orders/page.tsx" })).toBe("module")
    expect(kindOf(PRESETS["expo-router"].kindRules, { file: "app/(tabs)/index.tsx" })).toBe("module")
    expect(kindOf(PRESETS["expo-router"].kindRules, { file: "src/app/settings/[id].tsx" })).toBe("module")
    expect(kindOf(PRESETS["react-navigation"].kindRules, { file: "src/screens/Profile.tsx" })).toBe("module")
    expect(kindOf(PRESETS["next-pages"].kindRules, { file: "pages/orders/[id].tsx" })).toBe("module")
    expect(kindOf(PRESETS["next-pages"].kindRules, { file: "src/pages/index.tsx" })).toBe("module")
    expect(kindOf(PRESETS["react-router-framework"].kindRules, { file: "app/routes/orders.tsx" })).toBe("module")
    expect(kindOf(PRESETS.adminjs.kindRules, { file: "src/admin/orders.ts" })).toBe("module")
    expect(kindOf(PRESETS["react-router"].kindRules, { file: "src/layouts/App.tsx" })).toBe("layout")
    expect(kindOf(PRESETS.nuxt.kindRules, { file: "pages/orders/[id].vue" })).toBe("module")
    expect(kindOf(PRESETS.nuxt.kindRules, { file: "app/pages/index.vue" })).toBe("module")
    expect(kindOf(PRESETS.nuxt.kindRules, { file: "app/layouts/default.vue" })).toBe("layout")
  })

  it("lets Nuxt resolve extensionless imports of .vue files after the script suffixes", () => {
    const suffixesOf = (config: AppgraphConfig): readonly string[] | undefined => config.candidateSuffixes
    const suffixes = suffixesOf(PRESETS.nuxt.config) ?? []
    expect(suffixes.slice(-2)).toEqual([".vue", "/index.vue"])
    expect(suffixes.indexOf(".ts")).toBeLessThan(suffixes.indexOf(".vue"))
    expect(suffixesOf(PRESETS["vue-router"].config)).toBeUndefined()
  })

  it("pairs next-app and next-pages as each other's companions", () => {
    expect(PRESETS["next-app"].companions).toEqual(["next-pages"])
    expect(PRESETS["next-pages"].companions).toEqual(["next-app"])
  })

  it("marks the React Router typegen output generated", () => {
    expect(PRESETS["react-router-framework"].config.generated).toEqual(["**/.react-router/**", "**/+types/**"])
  })
})
