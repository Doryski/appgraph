import { describe, expect, it } from "vitest"
import {
  DIRECTORY_VOCABULARY,
  TRAVERSABLE_VOCABULARY,
  deriveDefaultKindRules,
  evaluateKind,
  isScreenEntry,
  isTraversable,
  kindOf,
  selectKindRule,
} from "../../src/core/kinds.js"
import type { KindRule } from "../../src/core/model.js"

describe("selectKindRule — precedence", () => {
  it("matches by pathPrefix", () => {
    const rules: readonly KindRule[] = [
      { match: { pathPrefix: "src/services/" }, kind: "service", traversable: true, screenEntry: false },
    ]
    expect(selectKindRule(rules, { file: "src/services/orders.ts" })?.kind).toBe("service")
    expect(selectKindRule(rules, { file: "src/modules/orders.ts" })).toBeNull()
  })

  it("matches by pathRegex against the full relative path", () => {
    const rules: readonly KindRule[] = [
      { match: { pathRegex: "^src/(routes|layouts)/" }, kind: "layout", traversable: false, screenEntry: false },
    ]
    expect(selectKindRule(rules, { file: "src/layouts/AppLayout.tsx" })?.kind).toBe("layout")
    expect(selectKindRule(rules, { file: "src/routes/router.tsx" })?.kind).toBe("layout")
    expect(selectKindRule(rules, { file: "src/modules/AppLayout.tsx" })).toBeNull()
  })

  it("matches by fileRegex against the basename only", () => {
    const rules: readonly KindRule[] = [
      { match: { fileRegex: "^use[A-Z]" }, kind: "hook", traversable: true, screenEntry: false },
    ]
    expect(selectKindRule(rules, { file: "src/shared/hooks/useOrders.ts" })?.kind).toBe("hook")
    expect(selectKindRule(rules, { file: "src/shared/useOrders/index.ts" })).toBeNull()
  })

  it("a rule with no match constraints at all matches every file (the catch-all default)", () => {
    const rules: readonly KindRule[] = [{ match: {}, kind: "other", traversable: false, screenEntry: false }]
    expect(selectKindRule(rules, { file: "anything.ts" })?.kind).toBe("other")
  })

  it("higher priority wins regardless of array order", () => {
    const rules: readonly KindRule[] = [
      { match: { pathPrefix: "src/" }, kind: "other", traversable: false, screenEntry: false, priority: 0 },
      { match: { pathPrefix: "src/modules/" }, kind: "module", traversable: false, screenEntry: true, priority: 10 },
    ]
    expect(selectKindRule(rules, { file: "src/modules/Orders.tsx" })?.kind).toBe("module")
  })

  it("ties on priority resolve to the earliest rule in array order", () => {
    const first: KindRule = { match: { pathPrefix: "src/" }, kind: "module", traversable: false, screenEntry: true }
    const second: KindRule = { match: { pathPrefix: "src/" }, kind: "ui", traversable: false, screenEntry: false }
    expect(selectKindRule([first, second], { file: "src/x.tsx" })).toBe(first)
    expect(selectKindRule([second, first], { file: "src/x.tsx" })).toBe(second)
  })

  it("an uncompilable pathRegex or fileRegex matches nothing instead of throwing", () => {
    const broken: KindRule[] = [
      { match: { pathRegex: "([" }, kind: "module", traversable: false, screenEntry: true, priority: 9 },
      { match: { fileRegex: "*" }, kind: "ui", traversable: false, screenEntry: false, priority: 8 },
      { match: {}, kind: "other", traversable: false, screenEntry: false },
    ]
    expect(() => selectKindRule(broken, { file: "src/a.tsx" })).not.toThrow()
    expect(kindOf(broken, { file: "src/a.tsx" })).toBe("other")
  })

  it("returns null when nothing matches", () => {
    expect(selectKindRule([], { file: "src/x.ts" })).toBeNull()
  })
})

describe("evaluateKind / kindOf / isTraversable / isScreenEntry — one rule, three answers at once", () => {
  const rules: readonly KindRule[] = [
    { match: { pathPrefix: "src/services/" }, kind: "service", traversable: true, screenEntry: false },
    { match: { pathPrefix: "src/modules/" }, kind: "module", traversable: false, screenEntry: true },
  ]

  it("reads kind, traversable and screenEntry off the SAME winning rule", () => {
    const evaluation = evaluateKind(rules, { file: "src/services/orders.ts" })
    expect(evaluation).toEqual({
      kind: "service",
      traversable: true,
      screenEntry: false,
      rule: rules[0],
    })
  })

  it("exposes the three questions as standalone predicates", () => {
    expect(kindOf(rules, { file: "src/modules/OrdersScreen.tsx" })).toBe("module")
    expect(isTraversable(rules, { file: "src/services/orders.ts" })).toBe(true)
    expect(isTraversable(rules, { file: "src/modules/OrdersScreen.tsx" })).toBe(false)
    expect(isScreenEntry(rules, { file: "src/modules/OrdersScreen.tsx" })).toBe(true)
    expect(isScreenEntry(rules, { file: "src/services/orders.ts" })).toBe(false)
  })

  it("defaults an unmatched file to kind 'other', non-traversable, not a screen entry", () => {
    expect(kindOf(rules, { file: "README.md" })).toBe("other")
    expect(isTraversable(rules, { file: "README.md" })).toBe(false)
    expect(isScreenEntry(rules, { file: "README.md" })).toBe(false)
  })

  /**
   * `uses` is `USES_DIR || HOOK_FILE`. The walk's consumer-side gate — this predicate — must apply the
   * same union as the component-tree extractor, or it deletes every `uses` edge to a `useX` file living
   * under a non-traversable prefix.
   */
  it("treats a useX file as traversable even where its directory rule says otherwise", () => {
    expect(isTraversable(rules, { file: "src/modules/Catalog/hooks/usePageLabel.ts" })).toBe(true)
    expect(isTraversable(rules, { file: "src/modules/Catalog/hooks/useIsRowExpanded.tsx" })).toBe(true)
    expect(kindOf(rules, { file: "src/modules/Catalog/hooks/usePageLabel.ts" })).toBe("module")
    expect(isTraversable(rules, { file: "src/modules/Catalog/usefulHelpers.ts" })).toBe(false)
    expect(isTraversable(rules, { file: "src/modules/Catalog/PageLabel.tsx" })).toBe(false)
  })
})

describe("deriveDefaultKindRules — tsconfig aliases + directory-name vocabulary", () => {
  it("covers every vocabulary entry under the default source root ('src')", () => {
    const rules = deriveDefaultKindRules()

    expect(kindOf(rules, { file: "src/modules/Orders/OrdersScreen.tsx" })).toBe("module")
    expect(kindOf(rules, { file: "src/features/orders/index.tsx" })).toBe("module")
    expect(kindOf(rules, { file: "src/pages/orders.tsx" })).toBe("module")
    expect(kindOf(rules, { file: "src/screens/orders.tsx" })).toBe("module")
    expect(kindOf(rules, { file: "src/layouts/AppLayout.tsx" })).toBe("layout")
    expect(kindOf(rules, { file: "src/components/Button.tsx" })).toBe("ui")
    expect(kindOf(rules, { file: "src/ui/Button.tsx" })).toBe("ui")
    expect(kindOf(rules, { file: "src/services/orders.ts" })).toBe("service")
    expect(kindOf(rules, { file: "src/api/client.ts" })).toBe("service")
    expect(kindOf(rules, { file: "src/clients/http.ts" })).toBe("service")
    expect(kindOf(rules, { file: "src/stores/ordersStore.ts" })).toBe("store")
    expect(kindOf(rules, { file: "src/store/index.ts" })).toBe("store")
    expect(kindOf(rules, { file: "src/state/auth.ts" })).toBe("store")
    expect(kindOf(rules, { file: "src/hooks/useOrders.ts" })).toBe("hook")
    expect(kindOf(rules, { file: "src/shared/format.ts" })).toBe("shared")
    expect(kindOf(rules, { file: "src/utils/format.ts" })).toBe("shared")
    expect(kindOf(rules, { file: "src/helpers/format.ts" })).toBe("shared")
    expect(kindOf(rules, { file: "src/lib/format.ts" })).toBe("shared")
    expect(kindOf(rules, { file: "src/random/File.tsx" })).toBe("other")
  })

  it("marks exactly the traversable-by-spec kinds as traversable (feeds the `uses` closure)", () => {
    const rules = deriveDefaultKindRules()
    expect(isTraversable(rules, { file: "src/services/orders.ts" })).toBe(true)
    expect(isTraversable(rules, { file: "src/stores/ordersStore.ts" })).toBe(true)
    expect(isTraversable(rules, { file: "src/hooks/useOrders.ts" })).toBe(true)
    expect(isTraversable(rules, { file: "src/modules/Orders.tsx" })).toBe(false)
    expect(isTraversable(rules, { file: "src/layouts/AppLayout.tsx" })).toBe(false)
    expect(isTraversable(rules, { file: "src/components/Button.tsx" })).toBe(false)
  })

  it("the shared grab-bag is NOT traversable, but a behaviour directory nested inside it still is", () => {
    const rules = deriveDefaultKindRules()
    expect(isTraversable(rules, { file: "src/shared/format.ts" })).toBe(false)
    expect(isTraversable(rules, { file: "src/utils/format.ts" })).toBe(false)
    expect(isTraversable(rules, { file: "src/shared/hooks/useOrders.ts" })).toBe(true)
    expect(kindOf(rules, { file: "src/shared/hooks/useOrders.ts" })).toBe("hook")
    expect(isTraversable(rules, { file: "src/lib/services/orders.ts" })).toBe(true)
    expect(isTraversable(rules, { file: "src/shared/stores/useAuthStore.ts" })).toBe(true)
  })

  it("the nested rule outranks an alias rule for the same shared prefix", () => {
    const rules = deriveDefaultKindRules({ tsconfigPaths: { "@/shared/*": ["src/shared/*"] } })
    expect(isTraversable(rules, { file: "src/shared/format.ts" })).toBe(false)
    expect(isTraversable(rules, { file: "src/shared/hooks/useOrders.ts" })).toBe(true)
  })

  it("a config rule can widen the derived scope back to all of `shared`", () => {
    const widened: readonly KindRule[] = [
      ...deriveDefaultKindRules(),
      { match: { pathPrefix: "src/shared/" }, kind: "shared", traversable: true, screenEntry: false, priority: 20 },
    ]
    expect(isTraversable(widened, { file: "src/shared/format.ts" })).toBe(true)
  })

  it("marks only the module vocabulary as a valid screen entry, excluding routes and layouts", () => {
    const rules = deriveDefaultKindRules()
    expect(isScreenEntry(rules, { file: "src/modules/Orders/OrdersScreen.tsx" })).toBe(true)
    expect(isScreenEntry(rules, { file: "src/layouts/AppLayout.tsx" })).toBe(false)
    expect(isScreenEntry(rules, { file: "src/routes/router.tsx" })).toBe(false)
  })

  it("derives rules from tsconfig path aliases, mapping an alias target to its vocabulary kind", () => {
    const rules = deriveDefaultKindRules({
      tsconfigPaths: { "@/modules/*": ["src/modules/*"], "@/services/*": ["src/services/*"] },
      sourceRootsRel: [],
    })

    expect(kindOf(rules, { file: "src/modules/Orders.tsx" })).toBe("module")
    expect(kindOf(rules, { file: "src/services/orders.ts" })).toBe("service")
    expect(kindOf(rules, { file: "src/unmapped/x.ts" })).toBe("other")
  })

  it("respects a non-default source root", () => {
    const rules = deriveDefaultKindRules({ sourceRootsRel: ["app"] })
    expect(kindOf(rules, { file: "app/services/orders.ts" })).toBe("service")
    expect(kindOf(rules, { file: "src/services/orders.ts" })).toBe("other")
  })

  it("exposes the vocabulary table itself as a stable export", () => {
    expect(DIRECTORY_VOCABULARY.map((entry) => entry.kind)).toEqual([
      "module",
      "layout",
      "ui",
      "service",
      "store",
      "hook",
      "shared",
    ])
  })
})

describe("isTraversable — the default must survive a repo's naming convention", () => {
  /**
   * Hook files are named camelCase in some repos and kebab-case in others. The predicate must match
   * both, or `traversable` is `false` for a kebab-case repo's whole data layer.
   */
  const rules: readonly KindRule[] = [
    { match: { pathPrefix: "src/modules/" }, kind: "module", traversable: false, screenEntry: true },
  ]

  const hookFiles = [
    "src/modules/Catalog/hooks/usePageLabel.ts",
    "src/modules/Catalog/hooks/useIsRowExpanded.tsx",
    "src/modules/orders/hooks/use-page-label.ts",
    "src/modules/orders/hooks/use-is-field-hovered.tsx",
    "src/modules/orders/hooks/use_page_label.ts",
    "src/modules/orders/hooks/use_is_field_hovered.tsx",
    "src/modules/orders/hooks/use-page-label.mjs",
  ] as const

  for (const file of hookFiles)
    it(`treats '${file}' as traversable whatever its directory rule says`, () => {
      expect(isTraversable(rules, { file })).toBe(true)
    })

  const notHooks = [
    "src/modules/orders/user.ts",
    "src/modules/orders/used-values.ts",
    "src/modules/orders/usefulHelpers.ts",
    "src/modules/orders/PageLabel.tsx",
    "src/modules/orders/reuse-form.ts",
  ] as const

  for (const file of notHooks)
    it(`does not widen to '${file}', which is not a hook file`, () => {
      expect(isTraversable(rules, { file })).toBe(false)
    })
})

describe("deriveDefaultKindRules — a server-function data layer", () => {
  /**
   * `src/server/**` is the whole data layer of a TanStack Start app (`createServerFn`). Leaving it out
   * of the vocabulary would keep it out of the `uses` closure entirely, whatever its files are called.
   */
  it("classifies src/server/ as a traversable service directory", () => {
    const rules = deriveDefaultKindRules()
    expect(kindOf(rules, { file: "src/server/orders.ts" })).toBe("service")
    expect(isTraversable(rules, { file: "src/server/orders.ts" })).toBe(true)
    expect(isTraversable(rules, { file: "src/server/pricing-tiers.ts" })).toBe(true)
  })

  it("keeps the vocabulary and the exported traversable family in agreement", () => {
    expect(TRAVERSABLE_VOCABULARY).toEqual(DIRECTORY_VOCABULARY.filter((entry) => entry.traversable))
    expect(TRAVERSABLE_VOCABULARY.flatMap((entry) => entry.names)).toContain("server")
  })
})
