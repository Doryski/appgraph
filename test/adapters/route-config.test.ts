import { describe, expect, it } from "vitest"
import {
  type FlatRoutesRequest,
  type RouteNode,
  readRouteConfig,
} from "../../src/adapters/route-config.js"
import { discoverBench } from "./discover-harness.js"

const ROUTES_FILE = "app/routes.ts"

type Shape = { file: string; path: string | null; index?: true; children?: Shape[] }

const shapeOf = (route: RouteNode): Shape => ({
  file: route.file,
  path: route.path,
  ...(route.index ? { index: true as const } : {}),
  ...(route.children.length === 0 ? {} : { children: route.children.map(shapeOf) }),
})

const read = (files: Record<string, string>, readFlatRoutes: (request: FlatRoutesRequest) => readonly RouteNode[] = () => []) => {
  const bench = discoverBench(files)
  const routes = readRouteConfig(bench.ctx, { file: ROUTES_FILE, appDirectory: "app", readFlatRoutes })
  const diagnostics = bench.diagnostics().map(({ severity, code, message, file, line }) => ({ severity, code, message, file, line }))
  return { routes, shapes: routes.map(shapeOf), diagnostics }
}

const recorder = () => {
  const requests: FlatRoutesRequest[] = []
  const flatRoute: RouteNode = {
    file: "app/routes/home.tsx",
    path: "home",
    index: false,
    id: null,
    children: [],
    declaredAt: { file: "app/routes/home.tsx", line: 1 },
    evidence: [],
  }
  const readFlatRoutes = (request: FlatRoutesRequest): readonly RouteNode[] => {
    requests.push(request)
    return [flatRoute]
  }
  return { requests, readFlatRoutes }
}

const PLANE_ROUTES = `import { layout, route } from "@react-router/dev/routes";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import { coreRoutes } from "./routes/core";
import { extendedRoutes } from "./routes/extended";
import { mergeRoutes } from "./routes/helper";

const mergedRoutes: RouteConfigEntry[] = mergeRoutes(coreRoutes, extendedRoutes);

const routes: RouteConfigEntry[] = [layout("./layout.tsx", [...mergedRoutes, route("*", "./not-found.tsx")])];

export default routes;
`

const PLANE_CORE = `import { index, layout, route } from "@react-router/dev/routes";
import type { RouteConfigEntry } from "@react-router/dev/routes";

export const coreRoutes: RouteConfigEntry[] = [
  layout("./(home)/layout.tsx", [index("./(home)/page.tsx")]),
  layout("./(all)/layout.tsx", [
    layout("./(all)/[workspaceSlug]/layout.tsx", [
      route(":workspaceSlug", "./(all)/[workspaceSlug]/page.tsx"),
      route(":workspaceSlug/projects/:projectId/issues", "./(all)/[workspaceSlug]/issues/page.tsx"),
    ]),
  ]),
  layout("./(home)/layout.tsx", [route("sign-up", "./(all)/sign-up/page.tsx")]),
];
`

const PLANE_EXTENDED = `import type { RouteConfigEntry } from "@react-router/dev/routes";

export const extendedRoutes: RouteConfigEntry[] = [];
`

const PLANE_HELPER = `import type { RouteConfigEntry } from "@react-router/dev/routes";

export function mergeRoutes(core: RouteConfigEntry[], extended: RouteConfigEntry[]): RouteConfigEntry[] {
  const routeMap = new Map<string, RouteConfigEntry>();
  for (const coreRoute of core) routeMap.set(coreRoute.file, coreRoute);
  for (const extendedRoute of extended) routeMap.set(extendedRoute.file, extendedRoute);
  const result: RouteConfigEntry[] = [];
  for (const coreRoute of core) {
    if (routeMap.has(coreRoute.file)) {
      result.push(routeMap.get(coreRoute.file)!);
      routeMap.delete(coreRoute.file);
    }
  }
  if (result.length === 0) return core;
  return result;
}
`

const DOCUMENSO_ROUTES = `import { remixRoutesOptionAdapter } from '@react-router/remix-routes-option-adapter';
import { flatRoutes } from 'remix-flat-routes';

export default remixRoutesOptionAdapter((defineRoutes) => {
  return flatRoutes('routes', defineRoutes, {
    ignoredRouteFiles: ['**/.*'],
  });
});
`

describe("readRouteConfig", () => {
  it("reads plane's layout + mergeRoutes(core, []) + catch-all as the union with one info", () => {
    const { routes, shapes, diagnostics } = read({
      [ROUTES_FILE]: PLANE_ROUTES,
      "app/routes/core.ts": PLANE_CORE,
      "app/routes/extended.ts": PLANE_EXTENDED,
      "app/routes/helper.ts": PLANE_HELPER,
    })

    expect(shapes).toEqual([
      {
        file: "app/layout.tsx",
        path: null,
        children: [
          {
            file: "app/(home)/layout.tsx",
            path: null,
            children: [
              { file: "app/(home)/page.tsx", path: null, index: true },
              { file: "app/(all)/sign-up/page.tsx", path: "sign-up" },
            ],
          },
          {
            file: "app/(all)/layout.tsx",
            path: null,
            children: [
              {
                file: "app/(all)/[workspaceSlug]/layout.tsx",
                path: null,
                children: [
                  { file: "app/(all)/[workspaceSlug]/page.tsx", path: ":workspaceSlug" },
                  {
                    file: "app/(all)/[workspaceSlug]/issues/page.tsx",
                    path: ":workspaceSlug/projects/:projectId/issues",
                  },
                ],
              },
            ],
          },
          { file: "app/not-found.tsx", path: "*" },
        ],
      },
    ])
    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: "info", code: "screens/dynamic-registry", file: ROUTES_FILE, line: 7 }),
    ])
    expect(diagnostics[0]?.message).toContain("mergeRoutes()")

    const [shell] = routes
    const [home] = shell?.children ?? []
    expect(shell?.evidence).toEqual([])
    expect(home?.evidence).toEqual(["read through unknown call mergeRoutes()"])
    expect(home?.children[0]?.evidence).toEqual(["read through unknown call mergeRoutes()"])
    expect(home?.declaredAt).toEqual({ file: "app/routes/core.ts", line: 5 })
  })

  it("applies prefix() to top-level paths and index routes, through pathless layouts and nested prefixes", () => {
    const { shapes, diagnostics } = read({
      [ROUTES_FILE]: `import { index, layout, prefix, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("./home.tsx"),
  ...prefix("projects", [
    index("./projects/home.tsx"),
    layout("./projects/layout.tsx", [route(":pid", "./projects/project.tsx"), ...prefix("/admin/", [route("users", "./admin/users.tsx")])]),
    route("", "./projects/empty.tsx"),
  ]),
] satisfies RouteConfig;
`,
    })

    expect(shapes).toEqual([
      { file: "app/home.tsx", path: null, index: true },
      { file: "app/projects/home.tsx", path: "projects", index: true },
      {
        file: "app/projects/layout.tsx",
        path: null,
        children: [
          { file: "app/projects/project.tsx", path: "projects/:pid" },
          { file: "app/admin/users.tsx", path: "projects/admin/users" },
        ],
      },
      { file: "app/projects/empty.tsx", path: "projects" },
    ])
    expect(diagnostics).toEqual([])
  })

  it("takes children from the third route()/second layout() argument and options from the object slot", () => {
    const { routes, shapes, diagnostics } = read({
      [ROUTES_FILE]: `import { index, layout, route } from "@react-router/dev/routes";

const settings = [index("./settings/index.tsx"), route("profile", "./settings/profile.tsx")];

const config = [
  route("settings", "./settings/layout.tsx", settings),
  route("about", "./about.tsx", { id: "about-page" }, [route("team", "./team.tsx")]),
  layout("./auth/layout.tsx", { id: "auth" }, [route("login", "./auth/login.tsx")]),
  route(null, "./pathless.tsx"),
];

export default config;
`,
    })

    expect(shapes).toEqual([
      {
        file: "app/settings/layout.tsx",
        path: "settings",
        children: [
          { file: "app/settings/index.tsx", path: null, index: true },
          { file: "app/settings/profile.tsx", path: "profile" },
        ],
      },
      { file: "app/about.tsx", path: "about", children: [{ file: "app/team.tsx", path: "team" }] },
      { file: "app/auth/layout.tsx", path: null, children: [{ file: "app/auth/login.tsx", path: "login" }] },
      { file: "app/pathless.tsx", path: null },
    ])
    expect(routes.map((route) => route.id)).toEqual([null, "about-page", "auth", null])
    expect(diagnostics).toEqual([])
  })

  it("resolves files of helpers destructured from relative(import.meta.dirname) against the declaring directory", () => {
    const { shapes, routes, diagnostics } = read({
      [ROUTES_FILE]: `import { route, type RouteConfig } from "@react-router/dev/routes";
import { marketing } from "./marketing/routes";

export default [route("/", "./home.tsx"), ...marketing] satisfies RouteConfig;
`,
      "app/marketing/routes.ts": `import { relative } from "@react-router/dev/routes";

const { route, index: idx } = relative(import.meta.dirname);

export const marketing = [idx("./landing.tsx"), route("pricing", "./pricing.tsx")];
`,
    })

    expect(shapes).toEqual([
      { file: "app/home.tsx", path: "/" },
      { file: "app/marketing/landing.tsx", path: null, index: true },
      { file: "app/marketing/pricing.tsx", path: "pricing" },
    ])
    expect(routes[2]?.evidence).toEqual(['relative("app/marketing")'])
    expect(diagnostics).toEqual([])
  })

  it("delegates documenso's remixRoutesOptionAdapter + remix-flat-routes to readFlatRoutes", () => {
    const { requests, readFlatRoutes } = recorder()
    const { shapes, diagnostics } = read({ [ROUTES_FILE]: DOCUMENSO_ROUTES }, readFlatRoutes)

    expect(requests).toEqual([
      expect.objectContaining({
        convention: "remix-flat-routes",
        rootDirectory: "routes",
        ignoredRouteFiles: ["**/.*"],
        appDirectory: "app",
        declaredAt: { file: ROUTES_FILE, line: 5 },
      }),
    ])
    expect(requests[0]?.options).not.toBeNull()
    expect(requests[0]).not.toHaveProperty("basePath")
    expect(shapes).toEqual([{ file: "app/routes/home.tsx", path: "home" }])
    expect(diagnostics).toEqual([])
  })

  it("issues one remix-flat-routes request per routeDir and passes a literal basePath", () => {
    const { requests, readFlatRoutes } = recorder()
    read(
      {
        [ROUTES_FILE]: `import { remixRoutesOptionAdapter } from '@react-router/remix-routes-option-adapter';
import { flatRoutes } from 'remix-flat-routes';

export default remixRoutesOptionAdapter((defineRoutes) => flatRoutes(['routes', 'admin'], defineRoutes, { basePath: '/app' }));
`,
      },
      readFlatRoutes,
    )

    expect(requests.map(({ rootDirectory, basePath, ignoredRouteFiles }) => ({ rootDirectory, basePath, ignoredRouteFiles }))).toEqual([
      { rootDirectory: "routes", basePath: "/app", ignoredRouteFiles: [] },
      { rootDirectory: "admin", basePath: "/app", ignoredRouteFiles: [] },
    ])
  })

  it("delegates ...(await flatRoutes({ rootDirectory })) from @react-router/fs-routes", () => {
    const { requests, readFlatRoutes } = recorder()
    const { shapes, diagnostics } = read(
      {
        [ROUTES_FILE]: `import { type RouteConfig, route } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

export default [
  route("/healthz", "./healthz.tsx"),
  ...(await flatRoutes({ rootDirectory: "pages", ignoredRouteFiles: ["**/*.test.tsx"] })),
] satisfies RouteConfig;
`,
      },
      readFlatRoutes,
    )

    expect(requests).toEqual([
      expect.objectContaining({
        convention: "react-router",
        rootDirectory: "pages",
        ignoredRouteFiles: ["**/*.test.tsx"],
        declaredAt: { file: ROUTES_FILE, line: 6 },
      }),
    ])
    expect(shapes).toEqual([
      { file: "app/healthz.tsx", path: "/healthz" },
      { file: "app/routes/home.tsx", path: "home" },
    ])
    expect(diagnostics).toEqual([])
  })

  it("defaults fs-routes rootDirectory to routes when flatRoutes() is the default export", () => {
    const { requests, readFlatRoutes } = recorder()
    read(
      {
        [ROUTES_FILE]: `import { flatRoutes } from "@react-router/fs-routes";

export default flatRoutes();
`,
      },
      readFlatRoutes,
    )

    expect(requests).toEqual([expect.objectContaining({ rootDirectory: "routes", ignoredRouteFiles: [], options: null })])
  })

  it("warns on an imperative defineRoutes builder and reads nothing from it", () => {
    const { requests, readFlatRoutes } = recorder()
    const { routes, diagnostics } = read(
      {
        [ROUTES_FILE]: `import { remixRoutesOptionAdapter } from '@react-router/remix-routes-option-adapter';

export default remixRoutesOptionAdapter((defineRoutes) =>
  defineRoutes((route) => {
    route('/', 'routes/home.tsx', { index: true });
  }),
);
`,
      },
      readFlatRoutes,
    )

    expect(routes).toEqual([])
    expect(requests).toEqual([])
    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", code: "screens/dynamic-registry", file: ROUTES_FILE, line: 4 }),
    ])
    expect(diagnostics[0]?.message).toContain("defineRoutes()")
  })

  it("does not treat a non-imported route() as the helper", () => {
    const { routes, diagnostics } = read({
      [ROUTES_FILE]: `import { route as rrRoute } from "@react-router/dev/routes";

const route = (path: string, file: string) => ({ path, file });

export default [route("a", "./a.tsx"), rrRoute("b", "./b.tsx")];
`,
    })

    expect(routes.map(shapeOf)).toEqual([{ file: "app/b.tsx", path: "b" }])
    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", code: "screens/dynamic-registry", file: ROUTES_FILE }),
    ])
    expect(diagnostics[0]?.message).toContain(`${ROUTES_FILE}:5`)
  })

  it("aggregates unreadable entries into one warning with at most five sites", () => {
    const { routes, diagnostics } = read({
      [ROUTES_FILE]: `import { route } from "@react-router/dev/routes";

declare const dyn: string;
declare function build(): unknown[];

export default [
  route(dyn, "./1.tsx"),
  route(dyn, "./2.tsx"),
  route(dyn, "./3.tsx"),
  route(dyn, "./4.tsx"),
  route(dyn, "./5.tsx"),
  route(dyn, "./6.tsx"),
  ...build(dyn),
  route("ok", "./ok.tsx"),
];
`,
    })

    expect(routes.map(shapeOf)).toEqual([{ file: "app/ok.tsx", path: "ok" }])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ severity: "warning", code: "screens/dynamic-registry", file: ROUTES_FILE })
    expect(diagnostics[0]?.message).toMatch(/^7 route entries in app\/routes\.ts .*app\/routes\.ts:11 and 2 more\.$/)
  })

  it("warns when an unknown call has an argument that is not a route array", () => {
    const { routes, diagnostics } = read({
      [ROUTES_FILE]: `import { route } from "@react-router/dev/routes";
import { withFlags } from "./flags";

export default [...withFlags([route("a", "./a.tsx")], process.env.FLAGS)];
`,
      "app/flags.ts": `export const withFlags = (routes: unknown[], flags: unknown) => (flags ? routes : []);\n`,
    })

    expect(routes).toEqual([])
    expect(diagnostics).toEqual([expect.objectContaining({ severity: "warning", code: "screens/dynamic-registry" })])
  })

  it("dedupes the union by (file, path) and merges children of duplicated layouts", () => {
    const { shapes, diagnostics } = read({
      [ROUTES_FILE]: `import { layout, route } from "@react-router/dev/routes";
import { merge } from "./merge";

const a = [layout("./shell.tsx", [route("x", "./x.tsx")]), route("y", "./y.tsx")];
const b = [layout("./shell.tsx", [route("x", "./x.tsx"), route("z", "./z.tsx")])];

export default merge(a, b);
`,
      "app/merge.ts": `export const merge = (...lists: unknown[][]) => { const out = []; for (const l of lists) out.push(...l); return out };\n`,
    })

    expect(shapes).toEqual([
      {
        file: "app/shell.tsx",
        path: null,
        children: [
          { file: "app/x.tsx", path: "x" },
          { file: "app/z.tsx", path: "z" },
        ],
      },
      { file: "app/y.tsx", path: "y" },
    ])
    expect(diagnostics.map(({ severity, line }) => ({ severity, line }))).toEqual([{ severity: "info", line: 7 }])
  })

  it("warns when routes.ts has no default export", () => {
    const { routes, diagnostics } = read({ [ROUTES_FILE]: `export const routes = [];\n` })

    expect(routes).toEqual([])
    expect(diagnostics).toEqual([expect.objectContaining({ severity: "warning", code: "screens/dynamic-registry" })])
  })
})
