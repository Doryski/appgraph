import { describe, expect, it } from "vitest"
import type { Screen } from "../../src/core/model.js"
import { createTanStackRouterAdapter } from "../../src/adapters/tanstack-router.js"
import { run } from "../pipeline/harness.js"

const PACKAGE_JSON = JSON.stringify({
  name: "@acme/start",
  dependencies: { react: "19.0.0", "@tanstack/react-router": "1.100.0", "@tanstack/react-start": "1.100.0" },
})

const analyze = (files: Readonly<Record<string, string>>) =>
  run({ files: { "package.json": PACKAGE_JSON, ...files }, adapters: [createTanStackRouterAdapter()] })

const ROOT_ROUTE = [
  `import { createRootRoute, Outlet } from "@tanstack/react-router"`,
  `export const Route = createRootRoute({ component: () => <Outlet /> })`,
  "",
].join("\n")

const pageRoute = (literal: string): string =>
  [
    `import { createFileRoute } from "@tanstack/react-router"`,
    `export const Route = createFileRoute("${literal}")({ component: Page })`,
    `function Page() { return <div /> }`,
    "",
  ].join("\n")

const serverRoute = (literal: string): string =>
  [
    `import { createFileRoute } from "@tanstack/react-router"`,
    `export const Route = createFileRoute("${literal}")({ server: { handlers: { GET: async () => Response.json([]) } } })`,
    "",
  ].join("\n")

const screenAt = (screens: readonly Screen[], url: string): Screen | undefined =>
  screens.find((screen) => screen.url === url)

describe("a `routes` folder below the routes directory is a URL segment", () => {
  it("places src/routes/admin/routes/index.tsx at /admin/routes with no stale-literal warning", () => {
    const result = analyze({
      "src/routes/__root.tsx": ROOT_ROUTE,
      "src/routes/admin/routes/index.tsx": pageRoute("/admin/routes/"),
    })
    expect(result.graph.screens.map((screen) => screen.url)).toEqual(["/admin/routes"])
    expect(result.diagnostics.filter((entry) => entry.code === "screens/stale-route-literal")).toEqual([])
    expect(screenAt(result.graph.screens, "/admin/routes")?.ancestors.map((ancestor) => ancestor.file)).toEqual([
      "src/routes/__root.tsx",
    ])
  })
})

describe("braced params with a prefix or suffix", () => {
  it("reads user.{$id}[.]json.tsx as /user/:id.json with the param and no stale-literal warning", () => {
    const result = analyze({
      "src/routes/__root.tsx": ROOT_ROUTE,
      "src/routes/user.{$id}[.]json.tsx": pageRoute("/user/{$id}.json"),
    })
    const screen = screenAt(result.graph.screens, "/user/:id.json")
    expect(screen?.params).toEqual(["id"])
    expect(result.diagnostics.filter((entry) => entry.code === "screens/stale-route-literal")).toEqual([])
  })

  it("reads a prefixed param segment", () => {
    const result = analyze({
      "src/routes/__root.tsx": ROOT_ROUTE,
      "src/routes/posts/post-{$postId}.tsx": pageRoute("/posts/post-{$postId}"),
    })
    expect(screenAt(result.graph.screens, "/posts/post-:postId")?.params).toEqual(["postId"])
    expect(result.diagnostics.filter((entry) => entry.code === "screens/stale-route-literal")).toEqual([])
  })
})

describe("TanStack Start server routes are API routes", () => {
  const FILES = {
    "src/routes/__root.tsx": ROOT_ROUTE,
    "src/routes/index.tsx": pageRoute("/"),
    "src/routes/api/users.ts": serverRoute("/api/users"),
  }

  it("tags a component-less route with server handlers as apiRoute, with no ancestors", () => {
    const result = analyze(FILES)
    const api = screenAt(result.graph.screens, "/api/users")
    expect(api?.kindTag).toBe("apiRoute")
    expect(api?.ancestors).toEqual([])
    expect(screenAt(result.graph.screens, "/")?.kindTag).toBeNull()
  })

  it("excludes it from the human screen count", () => {
    const result = analyze(FILES)
    expect(result.graph.meta.counts.screens).toBe(1)
    expect(result.graph.meta.counts.apiRoutes).toBe(1)
  })

  it("keeps a route with both a component and server handlers a human screen", () => {
    const result = analyze({
      "src/routes/__root.tsx": ROOT_ROUTE,
      "src/routes/report.tsx": [
        `import { createFileRoute } from "@tanstack/react-router"`,
        `export const Route = createFileRoute("/report")({ component: Report, server: { handlers: { GET: async () => new Response("") } } })`,
        `function Report() { return <div /> }`,
        "",
      ].join("\n"),
    })
    expect(screenAt(result.graph.screens, "/report")?.kindTag).toBeNull()
  })
})

describe("route files under folders named like test or mock directories", () => {
  it("keeps routes in routes/**/test/ and routes/**/mocks/ and still skips *.test.tsx", () => {
    const result = analyze({
      "src/routes/__root.tsx": ROOT_ROUTE,
      "src/routes/api/test/verify.ts": serverRoute("/api/test/verify"),
      "src/routes/mocks/index.tsx": pageRoute("/mocks/"),
      "src/routes/about.test.tsx": pageRoute("/about"),
    })
    const urls = result.graph.screens.map((screen) => screen.url).sort()
    expect(urls).toEqual(["/api/test/verify", "/mocks"])
  })
})
