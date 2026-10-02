import { describe, expect, it } from "vitest"
import { DEFAULT_CANDIDATE_SUFFIXES } from "../../src/core/resolver.js"
import {
  isReactNativeProject,
  platformCandidateSuffixes,
  platformsFor,
  splitPlatform,
} from "../../src/core/platform.js"

const deps = (...names: string[]) => new Set(names)

describe("platformsFor", () => {
  it("returns the native platforms without tvos", () => {
    expect(platformsFor({ dependencies: deps("react-native"), manifestText: "{}" })).toEqual([
      "ios",
      "android",
      "native",
      "web",
    ])
  })

  it("adds tv for the react-native npm alias", () => {
    const manifestText = '{"dependencies":{"react-native":"npm:react-native-tvos@0.76.0-0"}}'
    expect(platformsFor({ dependencies: deps("react-native"), manifestText })).toContain("tv")
  })

  it("adds tv for a react-native-tvos dependency", () => {
    expect(platformsFor({ dependencies: deps("react-native-tvos"), manifestText: "{}" })).toContain("tv")
  })

  it("adds tv for scoped tvos packages", () => {
    expect(platformsFor({ dependencies: deps("@react-native-tvos/config-tv"), manifestText: "{}" })).toContain("tv")
  })
})

describe("isReactNativeProject", () => {
  it.each([["react-native"], ["expo"], ["expo-router"], ["@react-navigation/native"]])("detects %s", (name) => {
    expect(isReactNativeProject(deps(name))).toBe(true)
  })

  it("rejects a web project", () => {
    expect(isReactNativeProject(deps("react", "react-dom", "react-router-dom"))).toBe(false)
  })
})

describe("splitPlatform", () => {
  const platforms = platformsFor({ dependencies: deps("react-native-tvos"), manifestText: "{}" })

  it("splits a tv variant", () => {
    expect(splitPlatform("app/settings.tv.tsx", platforms)).toEqual({ base: "app/settings.tsx", platform: "tv" })
  })

  it("splits ios and native variants", () => {
    expect(splitPlatform("a/b.ios.ts", platforms)).toEqual({ base: "a/b.ts", platform: "ios" })
    expect(splitPlatform("a/b.native.jsx", platforms)).toEqual({ base: "a/b.jsx", platform: "native" })
  })

  it("leaves unknown suffixes and plain files alone", () => {
    expect(splitPlatform("a/foo.test.tsx", platforms)).toEqual({ base: "a/foo.test.tsx", platform: null })
    expect(splitPlatform("a/foo.tsx", platforms)).toEqual({ base: "a/foo.tsx", platform: null })
    expect(splitPlatform("a/.ios.tsx", platforms)).toEqual({ base: "a/.ios.tsx", platform: null })
  })

  it("does not split tv without tvos", () => {
    expect(splitPlatform("a/b.tv.tsx", platformsFor({ dependencies: deps(), manifestText: "" }))).toEqual({
      base: "a/b.tv.tsx",
      platform: null,
    })
  })
})

describe("platformCandidateSuffixes", () => {
  const base = DEFAULT_CANDIDATE_SUFFIXES

  it("applies bluesky moduleSuffixes with the outer loop over module suffixes", () => {
    const result = platformCandidateSuffixes(base, [".ios", ".android", ".native", ""])
    expect(result.slice(0, 6)).toEqual([".ios.tsx", ".ios.ts", "/index.ios.tsx", "/index.ios.ts", ".ios.js", ".ios.jsx"])
    expect(result.indexOf(".android.tsx")).toBeGreaterThan(result.indexOf(".ios.tsx"))
    expect(result.indexOf(".native.tsx")).toBeGreaterThan(result.indexOf(".android.tsx"))
    expect(result.slice(-8)).toEqual([...base])
  })

  it("lets a cherry-style ios/android pair with no base resolve in a react native project", () => {
    const result = platformCandidateSuffixes(base, null, true)
    expect(result).toContain(".ios.tsx")
    expect(result).toContain(".android.tsx")
    expect(result).toContain("/index.ios.tsx")
  })

  it("keeps files with a base resolving exactly as before", () => {
    expect(platformCandidateSuffixes(base, null, true).slice(0, base.length)).toEqual([...base])
  })

  it("orders the react native default as base, native, ios, android", () => {
    const result = platformCandidateSuffixes([".tsx"], null, true)
    expect(result).toEqual([".tsx", ".native.tsx", ".ios.tsx", ".android.tsx"])
  })

  it("returns base suffixes untouched outside react native", () => {
    expect(platformCandidateSuffixes(base, null)).toBe(base)
  })
})
