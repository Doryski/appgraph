import { describe, expect, it } from "vitest"
import { DEFAULT_LOOKUP_FUNCTIONS, createFeatureFlagsExtractor } from "../../src/extractors/feature-flags.js"
import { run, valuesOf } from "./harness.js"

const extractor = createFeatureFlagsExtractor()

const gates = (code: string) => valuesOf(run([extractor], code), "featureGates")

describe("feature-flags — lookup functions", () => {
  it("finds a bare getConfiguration call", () => {
    expect(gates("getConfiguration('newCheckout')")).toEqual(["newCheckout"])
  })

  it("finds useFlag, isEnabled and useFeatureFlag out of the box", () => {
    expect(gates("useFlag('newCheckout')")).toEqual(["newCheckout"])
    expect(gates("isEnabled('newCheckout')")).toEqual(["newCheckout"])
    expect(gates("useFeatureFlag('newCheckout')")).toEqual(["newCheckout"])
  })

  it("ignores an unrelated function name", () => {
    expect(gates("getSomethingElse('newCheckout')")).toEqual([])
  })

  it("respects a configured lookup function list, replacing the defaults", () => {
    const custom = createFeatureFlagsExtractor({ lookupFunctions: ["flagEnabled"] })
    expect(valuesOf(run([custom], "flagEnabled('x')"), "featureGates")).toEqual(["x"])
    expect(valuesOf(run([custom], "getConfiguration('x')"), "featureGates")).toEqual([])
  })

  it("deduplicates repeated lookups", () => {
    expect(gates("getConfiguration('x')\ngetConfiguration('x')")).toEqual(["x"])
  })
})

describe("feature-flags — JSX attribute form", () => {
  it("reads the featureFlag attribute off any tag", () => {
    expect(gates('<ProtectedRoute featureFlag="newCheckout" />')).toEqual(["newCheckout"])
  })

  it("respects a configured attribute name", () => {
    const custom = createFeatureFlagsExtractor({ attributeName: "flag" })
    expect(valuesOf(run([custom], '<Gate flag="x" />'), "featureGates")).toEqual(["x"])
    expect(valuesOf(run([custom], '<Gate featureFlag="x" />'), "featureGates")).toEqual([])
  })
})

describe("feature-flags — config tables, name-matched, both directions", () => {
  it("reads an enum whose name matches /FEATURE.?FLAGS?/i", () => {
    const code = "enum FeatureFlags { NewCheckout = 'newCheckout', DarkMode = 'darkMode' }"
    expect(gates(code)).toEqual(["newCheckout", "darkMode"])
  })

  it("falls back to the member name when the enum member has no string initializer", () => {
    expect(gates("enum FeatureFlags { NewCheckout, DarkMode }")).toEqual(["NewCheckout", "DarkMode"])
  })

  it("reads FEATURE_FLAG_CONFIG as an array of { key } objects", () => {
    const code = "const FEATURE_FLAG_CONFIG = [{ key: 'newCheckout' }, { key: 'darkMode' }]"
    expect(gates(code)).toEqual(["newCheckout", "darkMode"])
  })

  it("reads a flag config as a plain Record<flag, config> object", () => {
    const code = "const FEATURE_FLAG_CONFIG = { newCheckout: { enabled: true }, darkMode: { enabled: false } }"
    expect(gates(code)).toEqual(["newCheckout", "darkMode"])
  })

  it("ignores a same-shaped array whose name does not match the config-table pattern", () => {
    const code = "const AVAILABLE_REGIONS = [{ key: 'eu' }, { key: 'us' }]"
    expect(gates(code)).toEqual([])
  })

  it("ignores an enum whose name does not match the config-table pattern", () => {
    expect(gates("enum Status { Active = 'active', Inactive = 'inactive' }")).toEqual([])
  })
})

describe("feature-flags — GrowthBook", () => {
  const bound = (body: string) => `import { useFeatureIsOn, useFeatureValue, useFeature, useGrowthBook, GrowthBook, IfFeatureEnabled, FeatureString } from '@growthbook/growthbook-react'\n${body}`

  it("reads the three hooks", () => {
    expect(gates(bound("useFeatureIsOn('a')"))).toEqual(["a"])
    expect(gates(bound("useFeatureValue('b', 'x')"))).toEqual(["b"])
    expect(gates(bound("useFeature('c')"))).toEqual(["c"])
  })

  it("reads isOn and getFeatureValue on useGrowthBook and new GrowthBook bindings", () => {
    expect(gates(bound("const gb = useGrowthBook()\ngb.isOn('a')\ngb.getFeatureValue('b', 1)"))).toEqual(["a", "b"])
    expect(gates(bound("const gb = new GrowthBook({})\ngb.isOn('a')\ngb.getFeatureValue('b', 1)"))).toEqual(["a", "b"])
  })

  it("reads the JSX components", () => {
    expect(gates(bound('<IfFeatureEnabled feature="a" />'))).toEqual(["a"])
    expect(gates(bound('<FeatureString feature="b" default="x" />'))).toEqual(["b"])
  })

  it("accepts the core package for the class and methods", () => {
    const code = "import { GrowthBook } from '@growthbook/growthbook'\nconst gb = new GrowthBook({})\ngb.isOn('a')"
    expect(gates(code)).toEqual(["a"])
  })

  it("emits nothing for unbound look-alikes", () => {
    expect(gates("const useFeatureIsOn = (k: string) => k\nuseFeatureIsOn('a')\nuseFeatureValue('b', 1)\nuseFeature('c')")).toEqual([])
    expect(gates("const gb = useGrowthBook()\ngb.isOn('a')")).toEqual([])
    expect(gates("class GrowthBook {}\nconst gb = new GrowthBook()\ngb.isOn('a')")).toEqual([])
    expect(gates("const gb = other()\ngb.isOn('a')")).toEqual([])
    expect(gates('<IfFeatureEnabled feature="a" />\n<FeatureString feature="b" />')).toEqual([])
    expect(gates("import { useFeatureIsOn } from './local'\nuseFeatureIsOn('a')")).toEqual([])
  })

  it("folds a string enum member key to its value", () => {
    expect(gates(bound("enum Features { AATest = 'aa-test' }\nuseFeatureIsOn(Features.AATest)"))).toEqual(["aa-test"])
  })

  it("falls back to the member name for a key that does not fold", () => {
    const code = bound("import { Features } from './features'\nuseFeatureIsOn(Features.AATest);\n<IfFeatureEnabled feature={Features.Other} />")
    expect(gates(code)).toEqual(["AATest", "Other"])
  })

  it("reaches a configured wrapper lookup with an enum key", () => {
    const custom = createFeatureFlagsExtractor({ lookupFunctions: ["enabled"] })
    const code = "enum Features { Beta = 'beta' }\nax.features.enabled(Features.Beta)"
    expect(valuesOf(run([custom], code), "featureGates")).toEqual(["beta"])
  })
})

describe("feature-flags — configured lookup member fallback", () => {
  it("names a configured lookup's non-folding member argument by its member name", () => {
    const code = "const ax = useAnalytics()\nexport const A = () => ax.features.enabled(ax.features.FollowingV2Enable)"
    const extractor = createFeatureFlagsExtractor({ lookupFunctions: [...DEFAULT_LOOKUP_FUNCTIONS, "enabled"] })

    expect(valuesOf(run([extractor], code), "featureGates")).toEqual(["FollowingV2Enable"])
  })

  it("keeps default lookups strict so a non-folding member emits nothing", () => {
    const code = "export const A = () => getConfiguration(settings.mode)"

    expect(valuesOf(run([createFeatureFlagsExtractor()], code), "featureGates")).toEqual([])
  })
})
