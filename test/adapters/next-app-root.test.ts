import { describe, expect, it } from "vitest"
import { nextAppSource } from "../../src/adapters/next-app.js"
import { adapterFor, run } from "../pipeline/harness.js"

const pageBody = (name: string): string => `export default function ${name}() { return <div /> }\n`

const layoutBody = (name: string): string =>
  `export default function ${name}({ children }: { children: unknown }) { return <main>{children}</main> }\n`

const NEXT_PACKAGE_JSON = JSON.stringify({ name: "fixture", dependencies: { next: "15.0.0", react: "19.0.0" } })

const screensOf = (files: Record<string, string>) =>
  run({ files: { "package.json": NEXT_PACKAGE_JSON, ...files }, adapters: [adapterFor(nextAppSource)] })

describe("the outermost `app` directory is the Next app root", () => {
  const FILES = {
    "app/layout.tsx": layoutBody("RootLayout"),
    "app/page.tsx": pageBody("Home"),
    "app/app/settings/page.tsx": pageBody("Settings"),
    "app/(marketing)/app/page.tsx": pageBody("AppLanding"),
  }

  it("keeps a route segment named `app` in the URL", () => {
    const result = screensOf(FILES)
    expect(result.graph.screens.map((screen) => screen.url).sort()).toEqual(["/", "/app", "/app/settings"])
  })

  it("does not collide app/(marketing)/app/page.tsx with the home page", () => {
    const result = screensOf(FILES)
    expect(result.diagnostics.filter((entry) => entry.code === "screens/duplicate-id")).toEqual([])
  })

  it("keeps the root layout in the ancestor chain below a nested `app` segment", () => {
    const result = screensOf(FILES)
    const settings = result.graph.screens.find((screen) => screen.url === "/app/settings")
    const landing = result.graph.screens.find((screen) => screen.url === "/app")
    expect(settings?.ancestors.map((ancestor) => ancestor.file)).toEqual(["app/layout.tsx"])
    expect(landing?.ancestors.map((ancestor) => ancestor.file)).toEqual(["app/layout.tsx"])
  })

  it("ignores `@scope` and `(x)` folders above the app root", () => {
    const result = screensOf({
      "packages/@acme/web/app/layout.tsx": layoutBody("RootLayout"),
      "packages/@acme/web/app/page.tsx": pageBody("Home"),
      "packages/@acme/web/app/dashboard/page.tsx": pageBody("Dashboard"),
      "(legacy)/web/app/about/page.tsx": pageBody("About"),
    })
    expect(result.graph.screens.map((screen) => screen.url).sort()).toEqual(["/", "/about", "/dashboard"])
    const dashboard = result.graph.screens.find((screen) => screen.url === "/dashboard")
    expect(dashboard?.ancestors.map((ancestor) => ancestor.file)).toEqual(["packages/@acme/web/app/layout.tsx"])
  })
})
