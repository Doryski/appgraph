import { describe, expect, it } from "vitest"
import type { Screen } from "../../src/core/model.js"
import {
  createReactRouterFrameworkAdapter,
  createReactRouterFrameworkSource,
  detectReactRouterFramework,
  isFrameworkMode,
  type ReactRouterFrameworkOptions,
} from "../../src/adapters/react-router-framework.js"
import { codes, run } from "../pipeline/harness.js"
import { discoverBench } from "./discover-harness.js"

const COMPONENT = "export default function Route() { return null }\n"

const LAYOUT = `import { Outlet } from "react-router"
export default function Layout() { return <main><Outlet /></main> }
`

const manifest = (dependencies: Readonly<Record<string, string>>): string =>
  JSON.stringify({ name: "fixture", dependencies: { react: "19.0.0", ...dependencies } })

const RR_PACKAGE = manifest({ "react-router": "7.0.0", "@react-router/dev": "7.0.0" })

const REMIX_PACKAGE = manifest({ "@remix-run/react": "2.0.0", "@remix-run/dev": "2.0.0" })

const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: ".", jsx: "react-jsx", paths: { "~/*": ["app/*"] } } })

const runWith = (files: Readonly<Record<string, string>>, options: ReactRouterFrameworkOptions = {}) =>
  run({ files: { "tsconfig.json": TSCONFIG, ...files }, adapters: [createReactRouterFrameworkAdapter(options)] })

const screenAt = (screens: readonly Screen[], url: string): Screen => {
  const screen = screens.find((candidate) => candidate.url === url)
  if (screen === undefined) throw new Error(`no screen at ${url}; have ${screens.map((s) => s.url ?? "-").join(", ")}`)
  return screen
}

const chainOf = (screen: Screen): readonly string[] => screen.ancestors.map((ancestor) => ancestor.file)

const evidenceOf = (screen: Screen): readonly string[] => screen.provenance.evidence.map((item) => item.what)

const urlsOf = (screens: readonly Screen[]): readonly string[] => screens.map((screen) => screen.url ?? "-").sort()

describe("react-router-framework: plane-shaped routes.ts", () => {
  const files = {
    "package.json": RR_PACKAGE,
    "react-router.config.ts": `import type { Config } from "@react-router/dev/config"
export default { appDirectory: "app", ssr: false } satisfies Config
`,
    "app/root.tsx": LAYOUT,
    "app/routes.ts": `import { layout, route } from "@react-router/dev/routes";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import { coreRoutes } from "./routes/core";
import { extendedRoutes } from "./routes/extended";
import { mergeRoutes } from "./routes/helper";

const mergedRoutes: RouteConfigEntry[] = mergeRoutes(coreRoutes, extendedRoutes);

export default [layout("./layout.tsx", [...mergedRoutes, route("*", "./not-found.tsx")])] satisfies RouteConfigEntry[];
`,
    "app/routes/core.ts": `import { index, layout, route } from "@react-router/dev/routes";

export const coreRoutes = [
  layout("./(home)/layout.tsx", [index("./(home)/page.tsx"), route("sign-in", "./(home)/sign-in/page.tsx")]),
  layout("./(all)/layout.tsx", [
    route(":workspaceSlug", "./(all)/[workspaceSlug]/layout.tsx", [
      index("./(all)/[workspaceSlug]/page.tsx"),
      route("projects/:projectId/issues", "./(all)/[workspaceSlug]/issues/page.tsx"),
    ]),
  ]),
];
`,
    "app/routes/extended.ts": "export const extendedRoutes = [];\n",
    "app/routes/helper.ts": `export function mergeRoutes(core, extended) {
  return [...core, ...extended];
}
`,
    "app/layout.tsx": LAYOUT,
    "app/not-found.tsx": COMPONENT,
    "app/(home)/layout.tsx": LAYOUT,
    "app/(home)/page.tsx": COMPONENT,
    "app/(home)/sign-in/page.tsx": `import { redirect } from "react-router"
export const clientLoader = () => {
  throw redirect("/")
}
export default function SignIn() { return null }
`,
    "app/(all)/layout.tsx": LAYOUT,
    "app/(all)/[workspaceSlug]/layout.tsx": LAYOUT,
    "app/(all)/[workspaceSlug]/page.tsx": COMPONENT,
    "app/(all)/[workspaceSlug]/issues/page.tsx": COMPONENT,
  }

  it("maps every routed module to its joined URL without a Next adapter", () => {
    const result = runWith(files)
    expect(urlsOf(result.graph.screens)).toEqual([
      "/",
      "/*",
      "/:workspaceSlug",
      "/:workspaceSlug/projects/:projectId/issues",
      "/sign-in",
    ])
    expect(result.graph.screens.every((screen) => screen.source === "react-router-framework")).toBe(true)
  })

  it("chains root, layouts and routed parents outermost first with an Outlet splice", () => {
    const { screens } = runWith(files).graph
    expect(chainOf(screenAt(screens, "/:workspaceSlug/projects/:projectId/issues"))).toEqual([
      "app/root.tsx",
      "app/layout.tsx",
      "app/(all)/layout.tsx",
      "app/(all)/[workspaceSlug]/layout.tsx",
    ])
    expect(screenAt(screens, "/:workspaceSlug").entries).toEqual([
      { kind: "file", file: "app/(all)/[workspaceSlug]/page.tsx", exportName: "default" },
    ])
    expect(screenAt(screens, "/").ancestors[0]).toMatchObject({ splice: { kind: "outlet", tag: "Outlet" }, role: "layout" })
  })

  it("turns an unconditional clientLoader redirect into redirectTo, not a guard", () => {
    const signIn = screenAt(runWith(files).graph.screens, "/sign-in")
    expect(signIn.redirectTo).toBe("/")
    expect(signIn.auth).toBe("unknown")
    expect(evidenceOf(signIn)).toContain("clientLoader redirect to '/'")
  })

  it("reports the mergeRoutes union as an info", () => {
    const result = runWith(files)
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "info", code: "screens/dynamic-registry", file: "app/routes.ts" }),
    )
  })
})

describe("react-router-framework: documenso-shaped remix-flat-routes", () => {
  const files = {
    "package.json": RR_PACKAGE,
    "app/root.tsx": LAYOUT,
    "app/routes.ts": `import { remixRoutesOptionAdapter } from '@react-router/remix-routes-option-adapter';
import { flatRoutes } from 'remix-flat-routes';

export default remixRoutesOptionAdapter((defineRoutes) => {
  return flatRoutes('routes', defineRoutes, { ignoredRouteFiles: ['**/.*'] });
});
`,
    "app/routes/_authenticated+/_layout.tsx": `import { redirect, Outlet } from "react-router"
export async function loader({ request }) {
  const session = await getSession(request)
  if (!session) {
    throw redirect("/signin")
  }
  return { session }
}
export default function Layout() { return <Outlet /> }
`,
    "app/routes/_authenticated+/settings+/profile.tsx": COMPONENT,
    "app/routes/_unauthenticated+/forgot-password.tsx": `import { redirect } from "react-router"
export function loader() {
  if (!isSigninEnabledForProvider('email')) {
    throw redirect('/signin')
  }
  return null
}
export default function ForgotPassword() { return null }
`,
    "app/routes/_unauthenticated+/signin.tsx": COMPONENT,
    "app/routes/api+/x.ts": "export const loader = () => new Response('ok')\n",
  }

  it("protects the children of the authenticated layout guard and names the layout", () => {
    const profile = screenAt(runWith(files).graph.screens, "/settings/profile")
    expect(profile.auth).toBe("protected")
    expect(chainOf(profile)).toEqual(["app/root.tsx", "app/routes/_authenticated+/_layout.tsx"])
    expect(evidenceOf(profile)).toContain(
      "protected by the loader guard of 'app/routes/_authenticated+/_layout.tsx': loader redirect to '/signin' (conditional: !session)",
    )
  })

  it("keeps forgot-password unprotected when unauthenticatedTarget points elsewhere", () => {
    const forgot = screenAt(runWith(files, { unauthenticatedTarget: "/login" }).graph.screens, "/forgot-password")
    expect(forgot.auth).toBe("unknown")
    expect(forgot.redirectTo).toBeNull()
    expect(evidenceOf(forgot)).toContain("loader redirect to '/signin' (conditional: !isSigninEnabledForProvider('email'))")
  })

  it("marks forgot-password protected under the broad rule", () => {
    expect(screenAt(runWith(files).graph.screens, "/forgot-password").auth).toBe("protected")
  })

  it("tags a module without a default export as a resource route with no ancestors", () => {
    const api = screenAt(runWith(files).graph.screens, "/api/x")
    expect(api.kindTag).toBe("apiRoute")
    expect(api.ancestors).toEqual([])
    expect(api.entries).toEqual([])
  })

  it("leaves a route with no loader redirect at unknown auth", () => {
    expect(screenAt(runWith(files).graph.screens, "/signin").auth).toBe("unknown")
  })

  it("keeps a path-owning layout addressable when its only index child sits at a deeper flat path", () => {
    const { screens } = runWith({
      ...files,
      "app/routes/_authenticated+/settings+/_layout.tsx": LAYOUT,
      "app/routes/_authenticated+/settings+/security._index.tsx": COMPONENT,
    }).graph
    expect(screenAt(screens, "/settings").entries).toEqual([
      { kind: "file", file: "app/routes/_authenticated+/settings+/_layout.tsx", exportName: "default" },
    ])
    expect(screenAt(screens, "/settings/security").entries[0]?.file).toBe(
      "app/routes/_authenticated+/settings+/security._index.tsx",
    )
  })

  it("gives the shared URL to an index child, not its layout", () => {
    const { screens } = runWith({
      ...files,
      "app/routes/_authenticated+/t.$teamUrl+/_layout.tsx": LAYOUT,
      "app/routes/_authenticated+/t.$teamUrl+/_index.tsx": COMPONENT,
    }).graph
    expect(screens.filter((screen) => screen.url === "/t/:teamUrl").map((screen) => screen.entries[0]?.file)).toEqual([
      "app/routes/_authenticated+/t.$teamUrl+/_index.tsx",
    ])
  })
})

describe("react-router-framework: Remix v2 classic", () => {
  const files = {
    "package.json": REMIX_PACKAGE,
    "remix.config.js": `/** @type {import('@remix-run/dev').AppConfig} */
module.exports = {
  ignoredRouteFiles: ["**/.*", "**/*.test.tsx"],
};
`,
    "app/root.tsx": LAYOUT,
    "app/routes/_index.tsx": COMPONENT,
    "app/routes/about.tsx": COMPONENT,
    "app/routes/about.test.tsx": COMPONENT,
    "app/routes/notes.tsx": LAYOUT,
    "app/routes/notes.$noteId.tsx": COMPONENT,
  }

  it("reads the flat app/routes convention, honouring remix.config ignoredRouteFiles", () => {
    const { screens } = runWith(files).graph
    expect(urlsOf(screens)).toEqual(["/", "/about", "/notes", "/notes/:noteId"])
    expect(chainOf(screenAt(screens, "/notes/:noteId"))).toEqual(["app/root.tsx", "app/routes/notes.tsx"])
  })

  it("warns that a remix.config routes function is not evaluated and still reads the default convention", () => {
    const result = runWith({
      ...files,
      "remix.config.js": `module.exports = { appDirectory: "app", routes(defineRoutes) { return defineRoutes(() => {}) } };\n`,
    })
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "warning", code: "screens/dynamic-registry", file: "remix.config.js" }),
    )
    expect(urlsOf(result.graph.screens)).toContain("/about")
  })

  it("reads appDirectory from the vite remix() plugin options", () => {
    const result = runWith({
      "package.json": REMIX_PACKAGE,
      "vite.config.ts": `import { vitePlugin as remix } from "@remix-run/dev"
import { defineConfig } from "vite"
export default defineConfig({ plugins: [remix({ appDirectory: "src/app" })] })
`,
      "src/app/root.tsx": LAYOUT,
      "src/app/routes/dashboard.tsx": COMPONENT,
    })
    expect(urlsOf(result.graph.screens)).toEqual(["/dashboard"])
  })

  it("reports a missing root as an info and maps routes without it", () => {
    const withoutRoot = Object.fromEntries(Object.entries(files).filter(([file]) => file !== "app/root.tsx"))
    const result = runWith(withoutRoot)
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "info", code: "screens/unsupported-router-style" }),
    )
    expect(chainOf(screenAt(result.graph.screens, "/about"))).toEqual([])
  })
})

describe("react-router-framework: trigger.dev-shaped helper guard", () => {
  it("follows requireUserId one hop and protects the route", () => {
    const route = screenAt(
      runWith({
        "package.json": REMIX_PACKAGE,
        "app/root.tsx": LAYOUT,
        "app/services/session.server.ts": `import { redirect } from "@remix-run/node"
export async function requireUserId(request: Request) {
  const id = await getUserId(request)
  if (!id) throw redirect("/login")
  return id
}
`,
        "app/routes/_app.orgs.$organizationSlug.tsx": `import { requireUserId } from "~/services/session.server"
export const loader = async ({ request }) => {
  await requireUserId(request)
  return null
}
export default function Org() { return null }
`,
      }).graph.screens,
      "/orgs/:organizationSlug",
    )
    expect(route.auth).toBe("protected")
    expect(evidenceOf(route)).toContain("loader redirect to '/login' (conditional: !id) via requireUserId")
  })
})

describe("react-router-framework: root loader guard", () => {
  it("does not pass a root.tsx helper guard on to the routes", () => {
    const screens = runWith({
      "package.json": REMIX_PACKAGE,
      "app/root.tsx": `import { Outlet } from "@remix-run/react"
import { clearImpersonation } from "~/services/impersonation.server"
export const loader = async ({ request }) => {
  if (request.url.includes("impersonate")) await clearImpersonation(request)
  return null
}
export default function App() { return <Outlet /> }
`,
      "app/services/impersonation.server.ts": `import { redirect } from "@remix-run/node"
export async function clearImpersonation(request: Request) {
  if (!request.headers.get("cookie")) throw redirect("/")
  return null
}
`,
      "app/routes/login.tsx": COMPONENT,
      "app/routes/projects.tsx": COMPONENT,
    }).graph.screens
    expect(screenAt(screens, "/login").auth).not.toBe("protected")
    expect(screenAt(screens, "/projects").auth).not.toBe("protected")
    expect(evidenceOf(screenAt(screens, "/login")).some((what) => what.includes("protected by the loader guard"))).toBe(false)
  })
})

describe("react-router-framework: detection and gating", () => {
  it("scores 100 with evidence for @react-router/dev plus app/routes.ts", () => {
    const { ctx } = discoverBench({ "app/routes.ts": "export default []\n" })
    const project = { ...ctx, hasDependency: (name: string | RegExp) => name === "@react-router/dev" }
    expect(detectReactRouterFramework(project)).toEqual({
      score: 100,
      evidence: [
        { what: "@react-router/dev dependency", file: "package.json", line: 1 },
        { what: "React Router framework routes config", file: "app/routes.ts", line: 1 },
      ],
    })
    expect(isFrameworkMode(project)).toBe(true)
  })

  it("scores 100 on a vite reactRouter() plugin call", () => {
    const { ctx } = discoverBench({ "vite.config.ts": "import { reactRouter } from '@react-router/dev/vite'\n\nexport default { plugins: [reactRouter()] }\n" })
    const project = { ...ctx, hasDependency: (name: string | RegExp) => name === "@react-router/dev" }
    expect(detectReactRouterFramework(project).evidence[1]).toEqual({ what: "vite remix()/reactRouter() plugin", file: "vite.config.ts", line: 3 })
  })

  it("scores 0 without the dependency, and 0 with it but no framework file", () => {
    const { ctx } = discoverBench({ "app/routes.ts": "export default []\n" })
    expect(detectReactRouterFramework(ctx)).toEqual({ score: 0, evidence: [] })
    const project = { ...ctx, hasDependency: (name: string | RegExp) => name === "@remix-run/dev" }
    const { ctx: bare } = discoverBench({ "src/main.tsx": COMPONENT })
    expect(detectReactRouterFramework({ ...bare, hasDependency: project.hasDependency })).toEqual({ score: 0, evidence: [] })
  })

  it("discovers nothing without the framework dependency", () => {
    const { ctx } = discoverBench({ "app/root.tsx": LAYOUT, "app/routes/about.tsx": COMPONENT })
    expect(createReactRouterFrameworkSource().discover(ctx)).toEqual([])
  })

  it("produces no screens in a pipeline run without the dependency", () => {
    const result = run({
      files: { "app/root.tsx": LAYOUT, "app/routes/about.tsx": COMPONENT },
      adapters: [createReactRouterFrameworkAdapter()],
    })
    expect(result.graph.screens).toEqual([])
    expect(codes(result)).not.toContain("screens/dynamic-registry")
  })
})
