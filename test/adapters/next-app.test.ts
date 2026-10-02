import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import { resolveConfig } from "../../src/config/types.js"
import { createEnv, createProjectContext } from "../../src/pipeline/context.js"
import { nextAppSource } from "../../src/adapters/next-app.js"
import { nextjsCases } from "../fixtures/route-dialects/nextjs.js"
import { createBuiltinAdapters } from "../../src/adapters/builtin.js"
import { adapterFor, PACKAGE_JSON, run as runFixture, type RunOptions } from "../pipeline/harness.js"

const ROOT = "/repo"

const NEXT_PACKAGE_JSON = JSON.stringify({ name: "fixture", dependencies: { next: "15.0.0", react: "19.0.0" } })

const run = (options: RunOptions) =>
  runFixture({ ...options, files: { "package.json": NEXT_PACKAGE_JSON, ...options.files } })

const pageBody = (name: string): string => `export default function ${name}() { return <div /> }\n`

const routeBody = "export default async function handler() { return new Response('ok') }\n"

const contentFor = (file: string): string =>
  /route\.(ts|js)$/.test(file) ? routeBody : pageBody("Screen")

describe("next-app: detect", () => {
  it("scores 100 when next is a dependency and an app-router page exists", () => {
    const host = createMemoryHost({
      files: {
        [`${ROOT}/package.json`]: JSON.stringify({ dependencies: { next: "15.0.0" } }),
        [`${ROOT}/src/app/page.tsx`]: pageBody("Home"),
      },
    })
    const env = createEnv({ ts, config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }), host })
    const result = nextAppSource.detect(createProjectContext(env))

    expect(result.score).toBe(100)
    expect(result.evidence).toHaveLength(1)
  })

  it("scores 0 without a next dependency, even with an app-router page", () => {
    const host = createMemoryHost({
      files: {
        [`${ROOT}/package.json`]: JSON.stringify({ dependencies: {} }),
        [`${ROOT}/src/app/page.tsx`]: pageBody("Home"),
      },
    })
    const env = createEnv({ ts, config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }), host })
    expect(nextAppSource.detect(createProjectContext(env)).score).toBe(0)
  })

  it("scores 0 with next as a dependency but no app-router page", () => {
    const host = createMemoryHost({
      files: { [`${ROOT}/package.json`]: JSON.stringify({ dependencies: { next: "15.0.0" } }) },
    })
    const env = createEnv({ ts, config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }), host })
    expect(nextAppSource.detect(createProjectContext(env)).score).toBe(0)
  })
})

describe("next-app: route-dialect fixture conversion", () => {
  for (const testCase of nextjsCases) {
    it(testCase.description, () => {
      const result = run({
        files: { [testCase.input]: contentFor(testCase.input) },
        adapters: [adapterFor(nextAppSource)],
      })

      const screen = result.graph.screens[0]
      expect(screen?.url).toBe(testCase.expected)
      expect(screen?.kindTag).toBe(/route\.(ts|js)$/.test(testCase.input) ? "apiRoute" : null)
    })
  }
})

describe("next-app: real-world-shaped tree", () => {
  const ACCEPTANCE_FILES = {
    "src/app/layout.tsx": pageBody("RootLayout"),
    "src/app/page.tsx": pageBody("Home"),
    "src/app/(marketing)/layout.tsx": pageBody("MarketingLayout"),
    "src/app/(marketing)/about/page.tsx": pageBody("About"),
    "src/app/flows/page.tsx": pageBody("Flows"),
    "src/app/flows/[flowId]/layout.tsx": pageBody("FlowLayout"),
    "src/app/flows/[flowId]/template.tsx": pageBody("FlowTemplate"),
    "src/app/flows/[flowId]/page.tsx": pageBody("Flow"),
    "src/app/docs/[...slug]/page.tsx": pageBody("Docs"),
    "src/app/shop/[[...slug]]/page.tsx": pageBody("Shop"),
    "src/app/dashboard/layout.tsx": pageBody("DashboardLayout"),
    "src/app/dashboard/settings/page.tsx": pageBody("Settings"),
    "src/app/api/users/route.ts": routeBody,
    "src/app/@modal/page.tsx": pageBody("Modal"),
    "src/app/photos/(.)detail/page.tsx": pageBody("PhotoDetail"),
    "src/app/photos/detail/page.tsx": pageBody("PhotoDetailPage"),
    ".next/server/app/generated/page.js": pageBody("Generated"),
  }

  it("finds exactly 8 human pages, excludes .next, and turns no slot or intercepting page into a screen", () => {
    const result = run({ files: ACCEPTANCE_FILES, adapters: [adapterFor(nextAppSource)] })

    const pages = result.graph.screens.filter((screen) => screen.kindTag !== "apiRoute")
    const apiRoutes = result.graph.screens.filter((screen) => screen.kindTag === "apiRoute")

    expect(pages).toHaveLength(8)
    expect(apiRoutes.map((screen) => screen.url)).toEqual(["/api/users"])

    expect(pages.some((screen) => screen.entries.some((entry) => "file" in entry && entry.file.startsWith(".next/")))).toBe(
      false,
    )

    const urls = pages.map((screen) => screen.url).sort()
    expect(urls).toEqual(
      ["/", "/about", "/dashboard/settings", "/docs/*", "/flows", "/flows/:flowId", "/photos/detail", "/shop/*"].sort(),
    )

    expect(result.graph.screens.some((screen) => screen.url?.includes("modal"))).toBe(false)
    expect(result.graph.screens.some((screen) => screen.url?.includes("(.)"))).toBe(false)
    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([])
  })

  it("never picks up a page.* file that lives under .next/, even though the glob shape matches", () => {
    const result = run({ files: ACCEPTANCE_FILES, adapters: [adapterFor(nextAppSource)] })
    const files = result.graph.screens.flatMap((screen) =>
      screen.entries.flatMap((entry) => ("file" in entry ? [entry.file] : [])),
    )
    expect(files.some((file) => file.startsWith(".next/"))).toBe(false)
  })

  it("builds the outermost-first ancestor chain for a deeply nested page, through a route group", () => {
    const result = run({ files: ACCEPTANCE_FILES, adapters: [adapterFor(nextAppSource)] })
    const flow = result.graph.screens.find((screen) => screen.url === "/flows/:flowId")

    expect(flow?.ancestors.map((ancestor) => [ancestor.file, ancestor.role, ancestor.splice.kind])).toEqual([
      ["src/app/layout.tsx", "layout", "children"],
      ["src/app/flows/[flowId]/layout.tsx", "layout", "children"],
      ["src/app/flows/[flowId]/template.tsx", "transparent", "children"],
    ])
  })

  it("drops the (group) segment from the URL but keeps the group's own layout in the chain", () => {
    const result = run({ files: ACCEPTANCE_FILES, adapters: [adapterFor(nextAppSource)] })
    const about = result.graph.screens.find((screen) => screen.url === "/about")

    expect(about?.ancestors.map((ancestor) => ancestor.file)).toEqual([
      "src/app/layout.tsx",
      "src/app/(marketing)/layout.tsx",
    ])
  })

  it("keeps a layout-only directory's layout in the chain of its page-less descendant", () => {
    const result = run({ files: ACCEPTANCE_FILES, adapters: [adapterFor(nextAppSource)] })
    const settings = result.graph.screens.find((screen) => screen.url === "/dashboard/settings")

    expect(settings?.ancestors.map((ancestor) => ancestor.file)).toEqual([
      "src/app/layout.tsx",
      "src/app/dashboard/layout.tsx",
    ])
    expect(result.graph.screens.some((screen) => screen.url === "/dashboard")).toBe(false)
  })

  it("gives a route.ts handler no ancestor chain — layouts never wrap API routes", () => {
    const result = run({ files: ACCEPTANCE_FILES, adapters: [adapterFor(nextAppSource)] })
    const apiRoute = result.graph.screens.find((screen) => screen.kindTag === "apiRoute")
    expect(apiRoute?.ancestors).toEqual([])
  })

  it("tags route.ts as kindTag:'apiRoute', distinguishable from human pages", () => {
    const result = run({ files: ACCEPTANCE_FILES, adapters: [adapterFor(nextAppSource)] })
    const apiRoute = result.graph.screens.find((screen) => screen.url === "/api/users")
    const page = result.graph.screens.find((screen) => screen.url === "/")

    expect(apiRoute?.kindTag).toBe("apiRoute")
    expect(page?.kindTag).toBeNull()
  })

  it("hangs a root @slot page under the root layout of the screen its remainder matches", () => {
    const result = run({ files: ACCEPTANCE_FILES, adapters: [adapterFor(nextAppSource)] })
    const home = result.graph.screens.find((screen) => screen.url === "/")
    const about = result.graph.screens.find((screen) => screen.url === "/about")

    expect(home?.ancestors[0]?.branches).toEqual([
      {
        file: "src/app/@modal/page.tsx",
        exportName: "default",
        splice: { kind: "slot", name: "modal" },
        conditions: ["slot modal"],
      },
    ])
    expect(about?.ancestors[0]?.branches).toBeUndefined()
    expect(
      result.diagnostics.some(
        (entry) => entry.code === "screens/unsupported-next-convention" && entry.file?.includes("@modal"),
      ),
    ).toBe(false)
  })

  it("gives the target of a non-slot intercepting route ((.)) the intercept activation, plus one info", () => {
    const result = run({ files: ACCEPTANCE_FILES, adapters: [adapterFor(nextAppSource)] })
    const detail = result.graph.screens.find((screen) => screen.url === "/photos/detail")

    expect(detail?.activations).toContainEqual({
      kind: "intercept",
      from: "/photos",
      slot: null,
      file: "src/app/photos/(.)detail/page.tsx",
    })
    expect(detail?.provenance.evidence.map((entry) => entry.what)).toContain("intercepted from /photos")
    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "screens/unsupported-next-convention" && entry.file?.includes("(.)detail"),
    )
    expect(diagnostic?.severity).toBe("info")
  })
})

const unsupported = (result: ReturnType<typeof run>) =>
  result.diagnostics
    .filter((entry) => entry.code === "screens/unsupported-next-convention")
    .map((entry) => [entry.severity, entry.file])

const interceptsOf = (result: ReturnType<typeof run>, url: string) =>
  result.graph.screens
    .find((screen) => screen.url === url)
    ?.activations.filter((activation) => activation.kind === "intercept")

describe("next-app: umami-shaped @modal slot with intercepting routes", () => {
  const BASE = "src/app/(main)/websites/[websiteId]"
  const FILES = {
    "src/app/layout.tsx": "export default function Root({ children }) { return <html>{children}</html> }\n",
    [`${BASE}/layout.tsx`]:
      "export default function WebsiteLayout({ children, modal }) { return <main>{children}{modal}</main> }\n",
    [`${BASE}/page.tsx`]: pageBody("Website"),
    [`${BASE}/sessions/[sessionId]/page.tsx`]: pageBody("Session"),
    [`${BASE}/replays/[replayId]/page.tsx`]: pageBody("Replay"),
    [`${BASE}/@modal/default.tsx`]: "export default function Default() { return null }\n",
    [`${BASE}/@modal/(.)sessions/[sessionId]/page.tsx`]: pageBody("SessionModal"),
    [`${BASE}/@modal/(.)replays/[sessionId]/page.tsx`]: pageBody("ReplayModal"),
  }

  const result = run({ files: FILES, adapters: [adapterFor(nextAppSource)] })
  const screenAt = (url: string) => result.graph.screens.find((screen) => screen.url === url)

  it("maps exactly the three pages, with no error and no unsupported-convention diagnostic", () => {
    expect(result.graph.screens.map((screen) => screen.url).sort()).toEqual([
      "/websites/:websiteId",
      "/websites/:websiteId/replays/:replayId",
      "/websites/:websiteId/sessions/:sessionId",
    ])
    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([])
    expect(unsupported(result)).toEqual([])
  })

  it("gives both targets an intercept activation, matching replays/[sessionId] to replays/[replayId] by shape", () => {
    expect(interceptsOf(result, "/websites/:websiteId/sessions/:sessionId")).toEqual([
      { kind: "intercept", from: "/websites/:websiteId", slot: "modal", file: `${BASE}/@modal/(.)sessions/[sessionId]/page.tsx` },
    ])
    expect(interceptsOf(result, "/websites/:websiteId/replays/:replayId")).toEqual([
      { kind: "intercept", from: "/websites/:websiteId", slot: "modal", file: `${BASE}/@modal/(.)replays/[sessionId]/page.tsx` },
    ])
    expect(screenAt("/websites/:websiteId/replays/:replayId")?.id).toBe("/websites/:websiteId/replays/:replayId")
  })

  it("hangs default.tsx plus the screen's own intercepting page under the layout, conditionally", () => {
    const layout = screenAt("/websites/:websiteId/sessions/:sessionId")?.ancestors.find(
      (ancestor) => ancestor.file === `${BASE}/layout.tsx`,
    )
    expect(layout?.branches?.map((branch) => [branch.file, branch.splice, branch.conditions])).toEqual([
      [`${BASE}/@modal/default.tsx`, { kind: "slot", name: "modal" }, ["slot modal"]],
      [
        `${BASE}/@modal/(.)sessions/[sessionId]/page.tsx`,
        { kind: "slot", name: "modal" },
        ["slot modal", "intercepted from /websites/:websiteId"],
      ],
    ])
  })

  it("grafts the branch nodes into the tree under the layout with their conditions", () => {
    const screen = screenAt("/websites/:websiteId/replays/:replayId")
    const layoutNode = screen?.tree
      .flatMap((node) => [node, ...node.children])
      .find((node) => node.file === `${BASE}/layout.tsx`)
    const branchNodes = layoutNode?.children
      .filter((node) => node.file.includes("@modal"))
      .map((node) => [node.file, node.conditions, node.alwaysRendered])
    expect(branchNodes).toEqual([
      [`${BASE}/@modal/(.)replays/[sessionId]/page.tsx`, ["slot modal", "intercepted from /websites/:websiteId"], false],
      [`${BASE}/@modal/default.tsx`, ["slot modal"], false],
    ])
    expect(screen?.reachable).toContain(`${BASE}/@modal/(.)replays/[sessionId]/page.tsx`)
  })

  it("gives the layout's own page only the default branch", () => {
    const layout = screenAt("/websites/:websiteId")?.ancestors.find((ancestor) => ancestor.file === `${BASE}/layout.tsx`)
    expect(layout?.branches?.map((branch) => branch.file)).toEqual([`${BASE}/@modal/default.tsx`])
  })
})

describe("next-app: intercepting markers that climb", () => {
  it("resolves (..) one route segment up, skipping the @slot and (group) segments", () => {
    const result = run({
      files: {
        "src/app/(app)/feed/layout.tsx": "export default function Feed({ children, modal }) { return <>{children}{modal}</> }\n",
        "src/app/(app)/feed/page.tsx": pageBody("Feed"),
        "src/app/(app)/feed/@modal/(..)photo/[id]/page.tsx": pageBody("PhotoModal"),
        "src/app/photo/[photoId]/page.tsx": pageBody("Photo"),
      },
      adapters: [adapterFor(nextAppSource)],
    })

    expect(interceptsOf(result, "/photo/:photoId")).toEqual([
      { kind: "intercept", from: "/feed", slot: "modal", file: "src/app/(app)/feed/@modal/(..)photo/[id]/page.tsx" },
    ])
    expect(result.graph.screens.map((screen) => screen.url).sort()).toEqual(["/feed", "/photo/:photoId"])
    expect(unsupported(result)).toEqual([])
  })

  it("resolves (..)(..) two route segments up", () => {
    const result = run({
      files: {
        "src/app/a/b/layout.tsx": "export default function L({ children, modal }) { return <>{children}{modal}</> }\n",
        "src/app/a/b/page.tsx": pageBody("B"),
        "src/app/a/b/@modal/(..)(..)login/page.tsx": pageBody("LoginModal"),
        "src/app/login/page.tsx": pageBody("Login"),
      },
      adapters: [adapterFor(nextAppSource)],
    })

    expect(interceptsOf(result, "/login")?.map((activation) => activation.kind === "intercept" && activation.from)).toEqual([
      "/a/b",
    ])
  })

  it("resolves (...) from the app root", () => {
    const result = run({
      files: {
        "src/app/shop/cart/layout.tsx": "export default function L({ children, drawer }) { return <>{children}{drawer}</> }\n",
        "src/app/shop/cart/page.tsx": pageBody("Cart"),
        "src/app/shop/cart/@drawer/(...)login/page.tsx": pageBody("LoginDrawer"),
        "src/app/login/page.tsx": pageBody("Login"),
      },
      adapters: [adapterFor(nextAppSource)],
    })

    expect(interceptsOf(result, "/login")).toEqual([
      { kind: "intercept", from: "/shop/cart", slot: "drawer", file: "src/app/shop/cart/@drawer/(...)login/page.tsx" },
    ])
  })

  it("warns when the marker climbs above app", () => {
    const result = run({
      files: {
        "src/app/layout.tsx": "export default function L({ children, modal }) { return <>{children}{modal}</> }\n",
        "src/app/page.tsx": pageBody("Home"),
        "src/app/@modal/(..)x/page.tsx": pageBody("X"),
      },
      adapters: [adapterFor(nextAppSource)],
    })

    expect(unsupported(result)).toEqual([["warning", "src/app/@modal/(..)x/page.tsx"]])
  })
})

describe("next-app: intercepting and slot diagnostics", () => {
  it("warns once when an intercepting route's target page is missing, and maps no screen for it", () => {
    const result = run({
      files: {
        "src/app/layout.tsx": "export default function L({ children, modal }) { return <>{children}{modal}</> }\n",
        "src/app/page.tsx": pageBody("Home"),
        "src/app/@modal/(.)nothing/[id]/page.tsx": pageBody("Nothing"),
      },
      adapters: [adapterFor(nextAppSource)],
    })

    expect(unsupported(result)).toEqual([["warning", "src/app/@modal/(.)nothing/[id]/page.tsx"]])
    expect(result.graph.screens.map((screen) => screen.url)).toEqual(["/"])
    expect(result.graph.screens[0]?.ancestors[0]?.branches).toBeUndefined()
  })

  it("gives a non-slot intercept's target the activation and reports one info", () => {
    const result = run({
      files: {
        "src/app/photos/page.tsx": pageBody("Photos"),
        "src/app/photos/(.)[id]/page.tsx": pageBody("PhotoModal"),
        "src/app/photos/[photoId]/page.tsx": pageBody("Photo"),
      },
      adapters: [adapterFor(nextAppSource)],
    })

    expect(interceptsOf(result, "/photos/:photoId")).toEqual([
      { kind: "intercept", from: "/photos", slot: null, file: "src/app/photos/(.)[id]/page.tsx" },
    ])
    expect(unsupported(result)).toEqual([["info", "src/app/photos/(.)[id]/page.tsx"]])
  })

  it("reports an @slot without a layout.* beside it as info", () => {
    const result = run({
      files: {
        "src/app/page.tsx": pageBody("Home"),
        "src/app/@modal/default.tsx": "export default function D() { return null }\n",
      },
      adapters: [adapterFor(nextAppSource)],
    })

    expect(unsupported(result)).toEqual([["info", "src/app/@modal/default.tsx"]])
  })
})

describe("next-app: remainder-matched slot pages", () => {
  const result = run({
    files: {
      "src/app/layout.tsx": "export default function L({ children, aside }) { return <>{children}{aside}</> }\n",
      "src/app/page.tsx": pageBody("Home"),
      "src/app/settings/[tab]/page.tsx": pageBody("Settings"),
      "src/app/about/page.tsx": pageBody("About"),
      "src/app/@aside/page.tsx": pageBody("HomeAside"),
      "src/app/@aside/(panels)/settings/[section]/page.tsx": pageBody("SettingsAside"),
      "src/app/@aside/default.tsx": "export default function D() { return null }\n",
      "src/app/@aside/ghost/page.tsx": pageBody("Ghost"),
    },
    adapters: [adapterFor(nextAppSource)],
  })
  const branchFilesOf = (url: string) =>
    result.graph.screens.find((screen) => screen.url === url)?.ancestors[0]?.branches?.map((branch) => branch.file)

  it("picks the slot page whose path matches the screen's remainder, else default.*", () => {
    expect(branchFilesOf("/")).toEqual(["src/app/@aside/page.tsx"])
    expect(branchFilesOf("/settings/:tab")).toEqual(["src/app/@aside/(panels)/settings/[section]/page.tsx"])
    expect(branchFilesOf("/about")).toEqual(["src/app/@aside/default.tsx"])
  })

  it("maps no slot page as a screen and reports the unmatched one as info", () => {
    expect(result.graph.screens.map((screen) => screen.url).sort()).toEqual(["/", "/about", "/settings/:tab"])
    expect(unsupported(result)).toEqual([["info", "src/app/@aside/ghost/page.tsx"]])
  })
})

describe("next-app: private folders", () => {
  it("never turns a page under a `_folder` into a screen, but keeps a `%5F` escaped segment", () => {
    const result = run({
      files: {
        "src/app/dashboard/page.tsx": pageBody("Dashboard"),
        "src/app/dashboard/_components/preview/page.tsx": pageBody("Preview"),
        "src/app/%5Finternal/page.tsx": pageBody("Internal"),
      },
      adapters: [adapterFor(nextAppSource)],
    })

    expect(result.graph.screens.map((screen) => screen.url).sort()).toEqual(["/_internal", "/dashboard"])
  })
})

describe("next-app: catch-all base paths", () => {
  const linkingPage = [
    `import Link from "next/link"`,
    `export default function Home() {`,
    `  return <nav><Link href="/shop">Shop</Link><Link href="/docs">Docs</Link></nav>`,
    `}`,
    ``,
  ].join("\n")

  it("resolves a link to [[...slug]]'s base path but not to [...slug]'s", () => {
    const result = run({
      files: {
        "src/app/page.tsx": linkingPage,
        "src/app/shop/[[...slug]]/page.tsx": pageBody("Shop"),
        "src/app/docs/[...slug]/page.tsx": pageBody("Docs"),
      },
      adapters: [adapterFor(nextAppSource)],
    })

    const home = result.graph.screens.find((screen) => screen.url === "/")
    expect(home?.navigatesTo.map((edge) => [edge.to, edge.matchedRoute])).toEqual([
      ["/docs", null],
      ["/shop", "/shop/*"],
    ])
  })
})

describe("next-app: discover gate", () => {
  it("emits no next-app draft for app/x/page.tsx without the next dependency, with every builtin source", () => {
    const result = runFixture({
      files: { "package.json": PACKAGE_JSON, "app/x/page.tsx": pageBody("X") },
      adapters: createBuiltinAdapters(),
    })
    expect(result.graph.screens.filter((screen) => screen.source === "next-app")).toEqual([])
  })

  it("still emits the draft once next is a dependency", () => {
    const result = run({ files: { "app/x/page.tsx": pageBody("X") }, adapters: createBuiltinAdapters() })
    expect(result.graph.screens.filter((screen) => screen.source === "next-app").map((screen) => screen.url)).toEqual([
      "/x",
    ])
  })
})
