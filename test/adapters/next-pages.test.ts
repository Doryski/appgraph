import { describe, expect, it } from "vitest"
import { createNextPagesSource, nextPagesSource } from "../../src/adapters/next-pages.js"
import type { ScreenSource } from "../../src/adapters/types.js"
import type { Screen } from "../../src/core/model.js"
import { discoverBench } from "./discover-harness.js"
import { adapterFor, codes, run } from "../pipeline/harness.js"

const NEXT_PACKAGE = JSON.stringify({ name: "fixture", dependencies: { next: "14.2.0", react: "18.0.0" } })

const page = (name: string): string => `export default function ${name}() { return <div>${name}</div> }\n`

const layout = (name: string, exported = "default"): string =>
  exported === "default"
    ? `export default function ${name}({ children }) { return <section>{children}</section> }\n`
    : `export function ${name}({ children }) { return <section>{children}</section> }\n`

const APP_ONE_SITE = `import type { AppProps } from "next/app"
export default function CustomApp({ Component, pageProps }: AppProps) {
  const getLayout = Component.getLayout ?? ((page) => page)
  return <div className="providers">{getLayout(<Component {...pageProps} />)}</div>
}
`

const runPages = (files: Readonly<Record<string, string>>, source: ScreenSource = nextPagesSource) =>
  run({ files: { "package.json": NEXT_PACKAGE, ...files }, adapters: [adapterFor(source)] })

const screenAt = (screens: readonly Screen[], url: string): Screen | undefined =>
  screens.find((screen) => screen.url === url)

const evidenceOf = (screen: Screen | undefined): readonly string[] =>
  screen?.provenance.evidence.map((entry) => entry.what) ?? []

describe("next-pages: Supabase-shaped project", () => {
  const FILES = {
    "pages/_app.tsx": APP_ONE_SITE,
    "pages/_document.tsx": page("Document"),
    "pages/404.tsx": page("NotFound"),
    "pages/500.tsx": page("ServerError"),
    "pages/_error.tsx": page("ErrorPage"),
    "pages/index.tsx": page("Home"),
    "pages/project/[ref]/index.tsx": `import { AppLayout } from "@/components/layouts/AppLayout"
import DefaultLayout from "@/components/layouts/DefaultLayout"

const ProjectPage = () => <div>project</div>

ProjectPage.getLayout = (page) => (
  <AppLayout>
    <DefaultLayout>{page}</DefaultLayout>
  </AppLayout>
)

export default ProjectPage
`,
    "pages/org/_/[[...routeSlug]].tsx": page("OrgRedirect"),
    "pages/api/health.ts": "export default function handler(req, res) { res.json({ ok: true }) }\n",
    "src/components/layouts/AppLayout.tsx": layout("AppLayout", "named"),
    "src/components/layouts/DefaultLayout.tsx": layout("DefaultLayout"),
  }

  it("maps pages to URLs, keeps `_` literal and skips the root special files", () => {
    const result = runPages(FILES)
    expect(result.graph.screens.map((screen) => screen.url).sort()).toEqual([
      "/",
      "/api/health",
      "/org/_/*",
      "/project/:ref",
    ])
  })

  it("tags pages/api as API routes with no ancestors", () => {
    const api = screenAt(runPages(FILES).graph.screens, "/api/health")
    expect(api?.kindTag).toBe("apiRoute")
    expect(api?.ancestors).toEqual([])
  })

  it("puts _app outermost with an `at` splice on its one <Component/> site", () => {
    const home = screenAt(runPages(FILES).graph.screens, "/")
    expect(home?.ancestors.map((ancestor) => [ancestor.file, ancestor.role, ancestor.splice.kind])).toEqual([
      ["pages/_app.tsx", "layout", "at"],
    ])
  })

  it("adds the two nested getLayout layouts inside _app, resolved to their declaring files", () => {
    const result = runPages(FILES)
    const project = screenAt(result.graph.screens, "/project/:ref")

    expect(project?.ancestors.map((ancestor) => [ancestor.file, ancestor.exportName, ancestor.splice.kind])).toEqual([
      ["pages/_app.tsx", "default", "at"],
      ["src/components/layouts/AppLayout.tsx", "AppLayout", "children"],
      ["src/components/layouts/DefaultLayout.tsx", "default", "children"],
    ])
    expect(evidenceOf(project)).toContain("getLayout wraps the page in <AppLayout> <DefaultLayout>")
    expect(codes(result)).not.toContain("walk/no-splice-point")
    expect(codes(result)).not.toContain("walk/ambiguous-splice")
  })

  it("reports a getLayout shape it cannot read as an info, with evidence", () => {
    const result = runPages({
      ...FILES,
      "pages/settings.tsx": `const Settings = () => <div />
Settings.getLayout = (page) => wrap(page)
export default Settings
`,
    })
    const settings = screenAt(result.graph.screens, "/settings")

    expect(settings?.ancestors.map((ancestor) => ancestor.file)).toEqual(["pages/_app.tsx"])
    expect(evidenceOf(settings)).toContain("getLayout not read")
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "info",
        code: "screens/unsupported-next-convention",
        file: "pages/settings.tsx",
        line: 2,
      }),
    )
  })
})

describe("next-pages: langfuse-shaped project", () => {
  const FILES = {
    "src/pages/_app.tsx": `import type { AppType } from "next/app"
const MyApp: AppType = ({ Component, pageProps }) => {
  return (
    <main>
      <Component {...pageProps} />
    </main>
  )
}
export default api.withTRPC(MyApp)
`,
    "src/pages/project/[projectId]/traces.tsx": 'export { default } from "../../../features/traces/TracesPage"\n',
    "src/pages/auth/sign-in.tsx": 'export { default } from "../../features/auth/SignIn"\n',
    "src/features/traces/TracesPage.tsx": page("TracesPage"),
    "src/features/auth/SignIn.tsx": `export default function SignIn() { return <form /> }
SignIn.skipAppLayout = true
`,
  }

  it("reads src/pages and resolves re-exported pages to their feature files", () => {
    const traces = screenAt(runPages(FILES).graph.screens, "/project/:projectId/traces")
    expect(traces?.entries).toEqual([
      { kind: "file", file: "src/features/traces/TracesPage.tsx", exportName: "default" },
    ])
  })

  it("finds the <Component/> site through a wrapped default export", () => {
    const traces = screenAt(runPages(FILES).graph.screens, "/project/:projectId/traces")
    expect(traces?.ancestors.map((ancestor) => [ancestor.file, ancestor.splice.kind])).toEqual([
      ["src/pages/_app.tsx", "at"],
    ])
  })

  it("records skipAppLayout as evidence only, keeping _app in the chain", () => {
    const signIn = screenAt(runPages(FILES).graph.screens, "/auth/sign-in")
    expect(evidenceOf(signIn).some((what) => what.includes("skipAppLayout"))).toBe(true)
    expect(signIn?.ancestors.map((ancestor) => ancestor.file)).toEqual(["src/pages/_app.tsx"])
  })
})

describe("next-pages: getServerSideProps guards", () => {
  const CONDITIONAL = `export default function Admin() { return <div /> }
export async function getServerSideProps(ctx) {
  const session = await getSession(ctx)
  if (!session) return { redirect: { destination: "/login", permanent: false } }
  return { props: {} }
}
`
  const UNCONDITIONAL = `export default function Old() { return <div /> }
export async function getServerSideProps() {
  return { redirect: { destination: "/new", permanent: true } }
}
`
  const ELSEWHERE = `export default function Setup() { return <div /> }
export async function getServerSideProps(ctx) {
  if (!ctx.query.org) return { redirect: { destination: "/onboarding", permanent: false } }
  return { props: {} }
}
`
  const FILES = {
    "pages/admin.tsx": CONDITIONAL,
    "pages/old.tsx": UNCONDITIONAL,
    "pages/setup.tsx": ELSEWHERE,
    "pages/open.tsx": page("Open"),
  }

  it("marks a conditional redirect protected with its evidence", () => {
    const admin = screenAt(runPages(FILES).graph.screens, "/admin")
    expect(admin?.auth).toBe("protected")
    expect(evidenceOf(admin)).toContain("getServerSideProps redirect to '/login' (conditional: !session)")
  })

  it("turns an unconditional redirect into redirectTo", () => {
    const old = screenAt(runPages(FILES).graph.screens, "/old")
    expect(old?.redirectTo).toBe("/new")
    expect(old?.auth).toBe("unknown")
    expect(evidenceOf(old)).toContain("getServerSideProps redirect to '/new'")
  })

  it("scopes a conditional redirect away from unauthenticatedTarget to evidence only", () => {
    const screens = runPages(FILES, createNextPagesSource({ unauthenticatedTarget: "/login" })).graph.screens
    const setup = screenAt(screens, "/setup")

    expect(setup?.auth).toBe("unknown")
    expect(evidenceOf(setup)).toContain("getServerSideProps redirect to '/onboarding' (conditional: !ctx.query.org)")
    expect(screenAt(screens, "/admin")?.auth).toBe("protected")
  })

  it("leaves a page without getServerSideProps unknown", () => {
    expect(screenAt(runPages(FILES).graph.screens, "/open")?.auth).toBe("unknown")
  })
})

describe("next-pages: conventions", () => {
  it("globs with a literal pageExtensions, including _app", () => {
    const result = runPages({
      "next.config.js": 'module.exports = { pageExtensions: ["page.tsx"] }\n',
      "pages/_app.page.tsx": APP_ONE_SITE,
      "pages/index.page.tsx": page("Home"),
      "pages/about.page.tsx": page("About"),
      "pages/components/Button.tsx": page("Button"),
    })

    expect(result.graph.screens.map((screen) => screen.url).sort()).toEqual(["/", "/about"])
    expect(screenAt(result.graph.screens, "/about")?.ancestors.map((ancestor) => ancestor.file)).toEqual([
      "pages/_app.page.tsx",
    ])
  })

  it("falls back to an outlet splice for two <Component/> sites, so the kernel reports the ambiguity", () => {
    const result = runPages({
      "pages/_app.tsx": `export default function App({ Component: Page, pageProps }) {
  if (pageProps.bare) return <Page {...pageProps} />
  return <main><Page {...pageProps} /></main>
}
`,
      "pages/index.tsx": page("Home"),
    })
    const home = screenAt(result.graph.screens, "/")

    expect(home?.ancestors[0]?.splice).toEqual({ kind: "outlet", tag: "Page" })
    expect(codes(result)).toContain("walk/ambiguous-splice")
  })

  it("reads root pages/ only when src/pages/ also exists, with an info", () => {
    const result = runPages({
      "pages/index.tsx": page("Home"),
      "src/pages/ignored.tsx": page("Ignored"),
    })

    expect(result.graph.screens.map((screen) => screen.url)).toEqual(["/"])
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "info", code: "screens/unsupported-next-convention", file: "src/pages" }),
    )
  })

  it("warns on a URL claimed by both app/ and pages/, keeping the pages screen", () => {
    const result = runPages({
      "pages/about.tsx": page("About"),
      "app/(site)/about/page.tsx": page("AboutApp"),
    })
    const warning = result.diagnostics.find((entry) => entry.code === "screens/unsupported-next-convention")

    expect(screenAt(result.graph.screens, "/about")?.entries).toEqual([
      { kind: "file", file: "pages/about.tsx", exportName: "default" },
    ])
    expect(warning?.severity).toBe("warning")
    expect(warning?.message).toContain("Next build error")
    expect(warning?.message).toContain("claimed by both app/ ('app/(site)/about/page.tsx') and pages/")
  })

  it("invents nothing for a src/pages/ project without a next dependency", () => {
    const result = run({
      files: {
        "package.json": JSON.stringify({ name: "fixture", dependencies: { react: "18.0.0" } }),
        "src/pages/index.tsx": page("Home"),
        "src/pages/settings.tsx": page("Settings"),
      },
      adapters: [adapterFor(nextPagesSource)],
    })
    expect(result.graph.screens).toEqual([])
  })
})

describe("next-pages: detect", () => {
  const detect = (files: Readonly<Record<string, string>>, pkg = NEXT_PACKAGE) =>
    nextPagesSource.detect(discoverBench({ "package.json": pkg, ...files }).ctx)

  it("scores 100 with next and a non-special, non-API page", () => {
    const result = detect({ "pages/_app.tsx": APP_ONE_SITE, "pages/index.tsx": page("Home") })
    expect(result.score).toBe(100)
    expect(result.evidence).toEqual([expect.objectContaining({ file: "pages/index.tsx" })])
  })

  it("scores 1 when only API routes and special files exist", () => {
    expect(detect({ "pages/_app.tsx": APP_ONE_SITE, "pages/api/hello.ts": page("Hello") }).score).toBe(1)
  })

  it("scores 0 with only special files, or without next", () => {
    expect(detect({ "pages/_app.tsx": APP_ONE_SITE, "pages/404.tsx": page("NotFound") }).score).toBe(0)
    expect(detect({ "pages/index.tsx": page("Home") }, JSON.stringify({ name: "fixture" })).score).toBe(0)
  })
})

describe("next-pages: catch-all base paths behind re-exports", () => {
  it("does not resolve a link to a re-exported [...slug]'s base path", () => {
    const result = runPages({
      "pages/index.tsx": `import Link from "next/link"\nexport default function Home() { return <nav><Link href="/docs">Docs</Link><Link href="/shop">Shop</Link></nav> }\n`,
      "pages/docs/[...slug].tsx": `export { default } from "../../src/features/Docs"\n`,
      "pages/shop/[[...slug]].tsx": `export { default } from "../../src/features/Shop"\n`,
      "src/features/Docs.tsx": page("Docs"),
      "src/features/Shop.tsx": page("Shop"),
    })

    const home = screenAt(result.graph.screens, "/")
    expect(home?.navigatesTo.map((edge) => [edge.to, edge.matchedRoute])).toEqual([
      ["/docs", null],
      ["/shop", "/shop/*"],
    ])
  })
})
