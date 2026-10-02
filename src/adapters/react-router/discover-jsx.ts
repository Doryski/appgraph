import { mentionsDevGuard } from "../route-conditions.js"
import type { RouteFlavour } from "../route-flavours.js"
import type { TsNode } from "../types.js"
import type { MappedRoutesApi } from "./mapped-routes.js"
import type { ItemScope, RouteElement, RouteItem, RouteList, RouteSpec } from "./model.js"
import type { ResolveApi } from "./resolve.js"
import type { SpecsApi } from "./specs.js"
import type { DiscoveryState } from "./state.js"

export const createDiscoverJsx = (deps: DiscoveryState & ResolveApi & SpecsApi & MappedRoutesApi) => {
  const { ctx, asRouteElement, openingOf, isRouterTag, isFragmentTag, returnedByCall, jsxSpecs, redirectSpecs, excerpt, mappedRoute, mappedItems } = deps

  type FoundRoute = {
    readonly element: RouteElement
    readonly dynamic: boolean
  }

  /** What a root child is under `flavour`: a `<Route>`, the flavour's redirect element, or neither. */
  const itemKindOf = (element: RouteElement, file: string, flavour: RouteFlavour): "route" | "redirect" | null => {
    const opening = openingOf(element)
    if (isRouterTag(file, opening, flavour.routeTag)) return "route"
    return flavour.redirect !== null && isRouterTag(file, opening, flavour.redirect.tag) ? "redirect" : null
  }

  const specsOf = (element: RouteElement, file: string, scope: ItemScope | null, flavour: RouteFlavour): readonly RouteSpec[] | null => {
    const kind = itemKindOf(element, file, flavour)
    if (kind === null) return null
    return kind === "route" ? jsxSpecs(element, file, scope, flavour) : redirectSpecs(element, file, scope, flavour)
  }

  const acceptedTags = (flavour: RouteFlavour): string =>
    [flavour.routeTag, ...(flavour.redirect === null ? [] : [flavour.redirect.tag])].map((tag) => `<${tag}>`).join(", ")

  const routeElementsIn = (node: TsNode, file: string, flavour: RouteFlavour): readonly FoundRoute[] => {
    const found: FoundRoute[] = []
    const visit = (candidate: TsNode, dynamic: boolean): void => {
      const element = asRouteElement(candidate)
      if (element !== null && itemKindOf(element, file, flavour) !== null) {
        found.push({ element, dynamic })
        return
      }
      const nested = dynamic || ctx.ts.isFunctionLike(candidate)
      candidate.forEachChild((child) => {
        visit(child, nested)
      })
    }
    visit(node, false)
    return found
  }

  /** A JSX child expression whose value is a call: the called function's single returned JSX or array. */
  const calledRoutes = (node: TsNode, file: string, flavour: RouteFlavour): RouteList | null => {
    const call = ctx.unwrap(node)
    const returned = returnedByCall(call, file)
    if (returned === null) return null
    const array = ctx.ast.asArrayLiteral(returned.node)
    if (array !== null) return { kind: "jsx", nodes: array.elements, file: returned.file, anchor: call, scope: null, flavour }
    const isJsx = asRouteElement(returned.node) !== null || ctx.ts.isJsxFragment(returned.node)
    return isJsx ? { kind: "jsx", nodes: [returned.node], file: returned.file, anchor: call, scope: null, flavour } : null
  }

  const expressionItems = (
    inner: TsNode,
    anchor: TsNode,
    file: string,
    scope: ItemScope | null,
    flavour: RouteFlavour,
  ): readonly RouteItem[] => {
    const devOnly = mentionsDevGuard(inner)
    const mapped = mappedRoute(ctx.unwrap(inner), file, flavour)
    if (mapped !== null) return mappedItems(mapped, file, scope, devOnly, flavour)

    const found = routeElementsIn(inner, file, flavour)
    const called = found.length === 0 ? calledRoutes(inner, file, flavour) : null
    if (called !== null) return [{ kind: "list", list: called, devOnly }]
    if (found.length === 0)
      return [
        {
          kind: "unreadable",
          node: anchor,
          file,
          reason: `route child {${excerpt(inner)}} is not a <Route> element this source can read; its routes are not discovered`,
        },
      ]

    const readable = found
      .filter((entry) => !entry.dynamic)
      .flatMap((entry) => specsOf(entry.element, file, scope, flavour) ?? [])
      .map((spec): RouteItem => ({ kind: "route", spec, file, devOnly }))
    if (!found.some((entry) => entry.dynamic)) return readable
    return [
      ...readable,
      {
        kind: "unreadable",
        node: anchor,
        file,
        reason: "<Route> elements built inside a callback this source cannot evaluate (e.g. `.map` over data that is not a literal array of route objects) are not read; those routes are not discovered",
      },
    ]
  }

  const jsxItems = (
    nodes: readonly TsNode[],
    file: string,
    scope: ItemScope | null,
    flavour: RouteFlavour,
  ): readonly RouteItem[] =>
    nodes.flatMap((node): readonly RouteItem[] => {
      if (ctx.ts.isJsxText(node)) return []
      if (ctx.ts.isJsxExpression(node))
        return node.expression === undefined ? [] : expressionItems(node.expression, node, file, scope, flavour)
      if (ctx.ts.isJsxFragment(node))
        return [
          { kind: "list", list: { kind: "jsx", nodes: node.children, file, anchor: node, scope, flavour }, devOnly: false },
        ]

      const element = asRouteElement(node)
      if (element === null)
        return node.kind === ctx.ts.SyntaxKind.OmittedExpression ? [] : expressionItems(node, node, file, scope, flavour)
      const opening = openingOf(element)
      const specs = specsOf(element, file, scope, flavour)
      if (specs !== null) return specs.map((spec) => ({ kind: "route", spec, file, devOnly: false }))
      if (isFragmentTag(opening) && ctx.ts.isJsxElement(node))
        return [
          { kind: "list", list: { kind: "jsx", nodes: node.children, file, anchor: node, scope, flavour }, devOnly: false },
        ]
      return [
        {
          kind: "unreadable",
          node,
          file,
          reason: `<${ctx.ast.tagName(opening) ?? "?"}> is not a <Route> element; react-router accepts only ${acceptedTags(flavour)} and fragments here`,
        },
      ]
    })

  return { jsxItems }
}

export type DiscoverJsxApi = ReturnType<typeof createDiscoverJsx>
