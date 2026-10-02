/**
 * The JSX route semantics of one react-router generation (or of wouter, read by the same reader). A route
 * ROOT picks its flavour (`<Routes>` is v6/v7, `<Switch>` is v5), and every `<Route>` read under that root
 * follows it — so a project mixing react-router-dom v5 with react-router-dom-v5-compat reads each root by
 * its own rules.
 */
export type RouteFlavour = {
  readonly name: string
  /** The element whose children are one route list. */
  readonly rootTag: string
  /** A root that is a common component name (`Switch`) counts only when imported from react-router. */
  readonly rootImported: boolean
  readonly routeTag: string
  readonly elementAttribute: string | null
  readonly componentAttribute: string
  /** A render prop whose returned JSX is read like `element`. */
  readonly renderAttribute: string | null
  /** `routes`: JSX children are nested routes; `element`: they are what the route renders. */
  readonly children: "routes" | "element"
  readonly pathSyntax: "react-router" | "path-to-regexp" | "wouter"
  /** `path={["/a", "/b"]}` declares one route per path. */
  readonly pathArrays: boolean
  /** `false`: a child of the root with no path matches every url under it (a catch-all). */
  readonly pathlessRoutes: boolean
  /** Without this attribute a route matches by prefix, so the routes its element renders nest under it. */
  readonly exactAttribute: string | null
  /** With this attribute a route matches by prefix and the routes its element renders resolve under its url. */
  readonly nestAttribute: string | null
  /** `false`: a splat route's descendant lists keep the enclosing base; only `nestAttribute` makes them relative. */
  readonly splatNests: boolean
  /** Attributes recorded as evidence only; they change how a url matches, not which url a route has. */
  readonly evidenceAttributes: readonly string[]
  /** A root child that redirects `from` one url `to` another; v6 redirects only through `<Navigate>` in an element. */
  readonly redirect: { readonly tag: string; readonly from: string; readonly to: string } | null
  /** Guards and layouts enclosing a top-level root frame every route in it. */
  readonly rootWrappers: boolean
  /** Route elements outside every root render too: siblings under one JSX parent form one non-exclusive list. */
  readonly looseRoutes: boolean
  /** A router element whose attribute prefixes every route in the lists it encloses; nested ones stack. */
  readonly base: { readonly tag: string; readonly attribute: string } | null
  /** Non-null: redirect targets are relative to the enclosing base, except one led by this marker (absolute). */
  readonly absoluteTargetMarker: string | null
  /**
   * A root no followed route claims is read top-level: its paths are absolute unless a nesting route makes
   * them relative, so reading it at the root is not a guess about an unseen parent.
   */
  readonly unclaimedTopLevel: boolean
  /** A component rendering this root splices the routes it mounts at the root element, not at a `<Routes/>` outlet. */
  readonly mountsAtRoot: boolean
}

export const ROUTE_FLAVOURS = {
  v6: {
    name: "v6",
    rootTag: "Routes",
    rootImported: false,
    routeTag: "Route",
    elementAttribute: "element",
    componentAttribute: "Component",
    renderAttribute: null,
    children: "routes",
    pathSyntax: "react-router",
    pathArrays: false,
    pathlessRoutes: true,
    exactAttribute: null,
    nestAttribute: null,
    splatNests: true,
    evidenceAttributes: [],
    redirect: null,
    rootWrappers: false,
    looseRoutes: false,
    base: null,
    absoluteTargetMarker: null,
    unclaimedTopLevel: false,
    mountsAtRoot: false,
  },
  v5: {
    name: "v5",
    rootTag: "Switch",
    rootImported: true,
    routeTag: "Route",
    elementAttribute: null,
    componentAttribute: "component",
    renderAttribute: "render",
    children: "element",
    pathSyntax: "path-to-regexp",
    pathArrays: true,
    pathlessRoutes: false,
    exactAttribute: "exact",
    nestAttribute: null,
    splatNests: true,
    evidenceAttributes: ["exact", "strict"],
    redirect: { tag: "Redirect", from: "from", to: "to" },
    rootWrappers: true,
    looseRoutes: false,
    base: null,
    absoluteTargetMarker: null,
    unclaimedTopLevel: false,
    mountsAtRoot: false,
  },
  wouter: {
    name: "wouter",
    rootTag: "Switch",
    rootImported: true,
    routeTag: "Route",
    elementAttribute: null,
    componentAttribute: "component",
    renderAttribute: null,
    children: "element",
    pathSyntax: "wouter",
    pathArrays: false,
    pathlessRoutes: false,
    exactAttribute: null,
    nestAttribute: "nest",
    splatNests: false,
    evidenceAttributes: [],
    redirect: { tag: "Redirect", from: "path", to: "to" },
    rootWrappers: true,
    looseRoutes: true,
    base: { tag: "Router", attribute: "base" },
    absoluteTargetMarker: "~",
    unclaimedTopLevel: true,
    mountsAtRoot: true,
  },
} as const satisfies Readonly<Record<string, RouteFlavour>>

/** react-router's root lookup order: the first flavour whose root tag matches wins. */
export const FLAVOUR_ORDER: readonly RouteFlavour[] = [ROUTE_FLAVOURS.v6, ROUTE_FLAVOURS.v5]
