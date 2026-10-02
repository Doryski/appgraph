import { describe, expect, it } from "vitest"
import {
  ancestorAt,
  conventionChain,
  findConventionFile,
  groupNamesOf,
  isGroupSegment,
  partsOf,
  routeDirsFor,
  type FileRouteConvention,
} from "../../src/adapters/file-routes.js"

const existsIn = (files: readonly string[]) => {
  const present = new Set(files)
  return { exists: (file: string) => present.has(file) }
}

const NEXT: FileRouteConvention = { root: { kind: "segment", name: "app" }, extensions: ["tsx", "jsx", "ts", "js"] }
const EXPO: FileRouteConvention = { root: { kind: "dir", dir: "src/app" }, extensions: ["tsx", "ts"] }

describe("adapters/file-routes routeDirsFor", () => {
  it("starts a Next-shaped chain at the outermost `app` segment", () => {
    expect(routeDirsFor("packages/web/app/app/settings/page.tsx", NEXT.root)).toEqual([
      "packages/web/app",
      "packages/web/app/app",
      "packages/web/app/app/settings",
    ])
  })

  it("starts an Expo-shaped chain at the fixed root dir, even when a segment is named `app`", () => {
    expect(routeDirsFor("src/app/(tabs)/app/index.tsx", EXPO.root)).toEqual([
      "src/app",
      "src/app/(tabs)",
      "src/app/(tabs)/app",
    ])
  })

  it("walks every directory when the file is outside the root", () => {
    expect(routeDirsFor("lib/screens/home.tsx", EXPO.root)).toEqual(["lib", "lib/screens"])
  })
})

describe("adapters/file-routes partsOf", () => {
  it("splits a Next path at the outermost `app`", () => {
    expect(partsOf("src/app/app/page.tsx", NEXT.root)).toEqual({
      rootPrefix: ["src", "app"],
      dirs: ["app"],
      name: "page.tsx",
    })
  })

  it("splits an Expo path at the fixed root", () => {
    expect(partsOf("src/app/(tabs)/[id].tsx", EXPO.root)).toEqual({
      rootPrefix: ["src", "app"],
      dirs: ["(tabs)"],
      name: "[id].tsx",
    })
  })
})

describe("adapters/file-routes groups", () => {
  it("recognises a group segment", () => {
    expect(isGroupSegment("(tabs)")).toBe(true)
    expect(isGroupSegment("tabs")).toBe(false)
  })

  it("expands a group array", () => {
    expect(groupNamesOf("(home,search)")).toEqual(["home", "search"])
    expect(groupNamesOf("(a, b)")).toEqual(["a", "b"])
  })

  it("gives one name for a plain group and none for a route segment", () => {
    expect(groupNamesOf("(tabs)")).toEqual(["tabs"])
    expect(groupNamesOf("settings")).toEqual([])
  })
})

describe("adapters/file-routes findConventionFile and ancestorAt", () => {
  it("probes the convention's extensions in order", () => {
    const ctx = existsIn(["app/_layout.ts", "app/_layout.tsx"])
    expect(findConventionFile(ctx, "app", "_layout", EXPO.extensions)).toBe("app/_layout.tsx")
    expect(findConventionFile(ctx, "app", "_layout", ["js"])).toBeNull()
  })

  it("defaults to a children splice and omits empty branches", () => {
    const ctx = existsIn(["app/layout.tsx"])
    expect(ancestorAt(ctx, "app", "layout", { role: "layout", extensions: NEXT.extensions })).toEqual({
      file: "app/layout.tsx",
      exportName: "default",
      splice: { kind: "children" },
      role: "layout",
    })
  })

  it("carries a custom splice and non-empty branches", () => {
    const ctx = existsIn(["app/layout.tsx"])
    const branches = [{ file: "app/@modal/default.tsx", exportName: "default", splice: { kind: "slot", name: "modal" }, conditions: [] }] as const
    expect(
      ancestorAt(ctx, "app", "layout", {
        role: "layout",
        extensions: NEXT.extensions,
        splice: { kind: "outlet", tag: "Slot" },
        branches,
      }),
    ).toEqual({ file: "app/layout.tsx", exportName: "default", splice: { kind: "outlet", tag: "Slot" }, role: "layout", branches })
  })
})

describe("adapters/file-routes conventionChain", () => {
  it("orders ancestors outermost first, levels in order within a directory", () => {
    const ctx = existsIn(["app/layout.tsx", "app/template.tsx", "app/(shop)/layout.tsx", "app/(shop)/cart/template.tsx"])
    const chain = conventionChain(ctx, "app/(shop)/cart/page.tsx", NEXT, [
      { base: "layout", role: "layout" },
      { base: "template", role: "transparent" },
    ])
    expect(chain.map((ancestor) => [ancestor.file, ancestor.role])).toEqual([
      ["app/layout.tsx", "layout"],
      ["app/template.tsx", "transparent"],
      ["app/(shop)/layout.tsx", "layout"],
      ["app/(shop)/cart/template.tsx", "transparent"],
    ])
  })

  it("builds an Expo-shaped chain with per-directory branches", () => {
    const ctx = existsIn(["src/app/_layout.tsx", "src/app/(tabs)/_layout.tsx"])
    const chain = conventionChain(ctx, "src/app/(tabs)/home/index.tsx", EXPO, [
      {
        base: "_layout",
        role: "layout",
        splice: { kind: "outlet", tag: "Slot" },
        branchesAt: (dir) =>
          dir === "src/app" ? [{ file: "src/app/+not-found.tsx", exportName: "default", splice: { kind: "children" }, conditions: ["fallback"] }] : [],
      },
    ])
    expect(chain).toEqual([
      {
        file: "src/app/_layout.tsx",
        exportName: "default",
        splice: { kind: "outlet", tag: "Slot" },
        role: "layout",
        branches: [{ file: "src/app/+not-found.tsx", exportName: "default", splice: { kind: "children" }, conditions: ["fallback"] }],
      },
      { file: "src/app/(tabs)/_layout.tsx", exportName: "default", splice: { kind: "outlet", tag: "Slot" }, role: "layout" },
    ])
  })
})
