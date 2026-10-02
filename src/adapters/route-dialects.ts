import type { RouteDialect, RouteDialectField, RoutePrefixRule } from "../core/model.js"
import { joinUrl, normalizeUrl } from "../core/url.js"
import type { ProjectContext } from "./types.js"

export type DialectFields = Partial<Readonly<Record<RouteDialectField, string>>>

/** react-router's own route-object names; it has no redirect field. */
export const REACT_ROUTER_DIALECT = {
  name: "react-router",
  fields: { path: "path", element: "element", component: "Component", children: "children", index: "index", lazy: "lazy" },
} as const satisfies RouteDialect

/**
 * Sentry's `SentryRouteObject` (`static/app/router/types.tsx`), translated to react-router by
 * `translateSentryRoute`: a `component` type, `redirectTo`, and `withOrgPath` dual routes.
 */
export const SENTRY_ROUTE_DIALECT = {
  name: "sentry",
  fields: { component: "component", redirect: "redirectTo" },
  translators: ["translateSentryRoute"],
  unwrapCalls: ["errorHandler", "memoize"],
  prefixRules: [{ flag: "withOrgPath", prefix: "/organizations/:orgId", keepPlain: true }],
} as const satisfies RouteDialect

const SENTRY_DEPENDENCY = /^@sentry\//

const presetFor = (ctx: Pick<ProjectContext, "hasDependency">): RouteDialect =>
  ctx.hasDependency(SENTRY_DEPENDENCY) ? SENTRY_ROUTE_DIALECT : REACT_ROUTER_DIALECT

/** The configured dialect wins; otherwise Sentry's when the project depends on a `@sentry/*` package. */
export const dialectFor = (ctx: Pick<ProjectContext, "hasDependency">, configured: RouteDialect | undefined): RouteDialect =>
  configured ?? presetFor(ctx)

/** The built-in preset a configured dialect replaces as a whole, or `null` when none would apply. */
export const overriddenPreset = (
  ctx: Pick<ProjectContext, "hasDependency">,
  configured: RouteDialect | undefined,
): RouteDialect | null => {
  if (configured === undefined) return null
  const preset = presetFor(ctx)
  return preset === REACT_ROUTER_DIALECT ? null : preset
}

/**
 * How one route object is read. `dialect` is false only for plain react-router objects outside every
 * translator, where nothing beyond react-router's own names applies.
 */
export type RouteMode = {
  readonly fields: DialectFields
  readonly unwrapCalls: readonly string[]
  readonly prefixRules: readonly RoutePrefixRule[]
  readonly dialect: boolean
}

export const PLAIN_MODE: RouteMode = {
  fields: REACT_ROUTER_DIALECT.fields,
  unwrapCalls: [],
  prefixRules: [],
  dialect: false,
}

export const modeOf = (dialect: RouteDialect): RouteMode => ({
  fields: { ...REACT_ROUTER_DIALECT.fields, ...dialect.fields },
  unwrapCalls: dialect.unwrapCalls ?? [],
  prefixRules: dialect.prefixRules ?? [],
  dialect: dialect !== REACT_ROUTER_DIALECT,
})

/** With translators, the dialect's names apply only inside their arguments; everything else stays react-router. */
export const outerModeOf = (dialect: RouteDialect): RouteMode =>
  (dialect.translators ?? []).length > 0 ? PLAIN_MODE : modeOf(dialect)

const PARENT_PREFIX = "../"

type RedirectSite = { readonly own: string | null; readonly parent: string | null; readonly isIndex: boolean }

const QUERY = /\?[^/#][^#]*/

const pathUrl = (target: string, route: RedirectSite): string | null => {
  if (target.startsWith("/")) return normalizeUrl(target)
  const climbs = target.startsWith(PARENT_PREFIX)
  const rest = climbs ? target.slice(PARENT_PREFIX.length) : target
  if (rest.split("/").includes("..") || (climbs && route.isIndex)) return null
  return joinUrl(climbs ? route.parent : route.own, rest)
}

/**
 * A redirect target as react-router resolves it from the route's element: absolute as written, relative
 * against the route's own url, and one leading `../` against the route above it. Any other `..` climbs a
 * route hierarchy this reader does not track, so it is `null`.
 */
export const redirectUrl = (target: string, route: RedirectSite): string | null => {
  const query = QUERY.exec(target)?.[0] ?? ""
  const url = pathUrl(query === "" ? target : target.replace(query, ""), route)
  return url === null ? null : `${url}${query}`
}

/** A flagged route's second path: the rule's prefix in front of the route's own. */
export const prefixedPath = (rule: RoutePrefixRule, path: string): string => normalizeUrl(`${rule.prefix}/${path}`)
