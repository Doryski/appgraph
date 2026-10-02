import { SCRIPT_GLOB } from "../../core/extensions.js"
import type { SpliceMode } from "../../core/model.js"
import { isNonAppFile } from "../../core/project.js"
import type { RouteFlavour } from "../route-flavours.js"
import type { ProjectContext, TsNode } from "../types.js"

export const SOURCE_NAME = "react-router"

export const WOUTER_SOURCE_NAME = "wouter"

export const WOUTER_MODULE = "^wouter(/preact)?$"

export const WOUTER_DEPENDENCY = "wouter"

export const ROUTER_FACTORIES = ["createBrowserRouter", "createHashRouter", "createMemoryRouter"] as const

export const ROUTER_CALL = /\bcreate(?:Browser|Hash|Memory)Router\s*\(/

/**
 * Instrumentation wrappers documented to return the factory they are handed, unchanged in what it
 * routes: `const create = wrapCreateBrowserRouterV6(createBrowserRouter)` makes `create` a factory.
 */
export const FACTORY_WRAPPERS = [{ exported: "^wrapCreate(Browser|Hash|Memory)RouterV\\d+$", module: "^@sentry/" }] as const

export const FACTORY_WRAPPER_CALL = /\bwrapCreate(?:Browser|Hash|Memory)Router/

export const MAP_METHOD = "map"

export const FILTER_METHOD = "filter"

export const MAX_HOPS = 4

export const ROUTE_HOOKS = ["useRoutes"] as const

export const ELEMENT_ROUTE_FACTORIES = ["createRoutesFromElements", "createRoutesFromChildren"] as const

export const JSX_ROUTES = /<Routes[\s/>]|<Route[\s/>]/

/** The text gate of a file that can hold a root: a root element, or a route element where loose routes render. */
export const rootElementText = (flavours: readonly RouteFlavour[]): RegExp => {
  const roots = `<(?:${[...new Set(flavours.map((flavour) => flavour.rootTag))].join("|")})[\\s>]`
  const loose = [...new Set(flavours.filter((flavour) => flavour.looseRoutes).map((flavour) => flavour.routeTag))]
  return new RegExp(loose.length === 0 ? roots : `${roots}|<(?:${loose.join("|")})[\\s/>]`)
}

export const ROUTE_HOOK_CALL = /\buseRoutes\s*\(/

/** An aliased `import { useRoutes as useAppRoutes }` names the hook only at its import. */
export const ROUTE_HOOK_NAME = /\buseRoutes\b/

export const SPLAT_SUFFIX = /\/?\*$/

/** The path a root child with no path of its own matches under a flavour without pathless routes. */
export const CATCH_ALL_PATH = "*"

/** A `?` that starts a query string, not the optional marker after a path-to-regexp param (`:id?`). */
export const QUERY_START = /(?<!:[\w-]+(?:\([^)]*\))?)\?/

export const LEADING_SLASH = /^\//

/** react-router v5 hands a route's match through the `match` prop or the `useRouteMatch()` hook. */
export const MATCH_PROP = "match"

export const MATCH_HOOK = "useRouteMatch"

export const MATCH_PATH = "path"

export const STATE_HOOK = "useState"

/** In-place growth of a route-data array: where each call puts the items it adds. */
export const ARRAY_GROWTH = { push: "append", unshift: "prepend" } as const

export const ROUTE_CHILD_TEXT_MAX = 80

/** The export react-router renders out of a `lazy` route module. */
export const LAZY_EXPORT = "Component"

export const THEN_METHOD = "then"

export const appFiles = (ctx: ProjectContext): readonly string[] =>
  ctx.glob(SCRIPT_GLOB).filter((file) => !isNonAppFile(file))

export const DETECT_SCORE_DATA_ROUTER = 90

export const DETECT_SCORE_JSX_ROUTES = 80

/** react-router composes a child route into its parent's element through `<Outlet/>` (§6.3.1). */
export const OUTLET_SPLICE: SpliceMode = { kind: "outlet", tag: "Outlet" }

/** A descendant `<Routes>` (or `useRoutes`) renders its matched route in place, inside the splat route's element. */
export const ROUTES_SPLICE: SpliceMode = { kind: "outlet", tag: "Routes" }

export const CHILDREN_SPLICE: SpliceMode = { kind: "children" }

export const PER_ITEM_GUARD = "guard reads the mapped route item; auth is decided per item at runtime, so it is not asserted"

export const NO_LAYOUTS: ReadonlySet<TsNode> = new Set()

export const RUNTIME_GATE =
  "route data is filtered or chosen at runtime by a condition outside the item; the route is registered only when it holds, so auth is not asserted"

/** A `.filter(Boolean)` predicate reads nothing but the item. */
export const ITEM_ONLY_PREDICATES = ["Boolean"] as const

export const PREDICATE_GLOBALS = ["undefined"] as const

/** react-router components that host the WHOLE route tree: a list rendered under one is top-level. */
export const ROUTER_ELEMENTS = ["BrowserRouter", "HashRouter", "MemoryRouter", "Router", "RouterProvider"] as const

export const WOUTER_ROUTER_ELEMENTS = ["Router"] as const

export const routerElementText = (names: readonly string[]): RegExp => new RegExp(`\\b(?:${names.join("|")})\\b`)
