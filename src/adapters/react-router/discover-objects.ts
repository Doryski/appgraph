import { mentionsDevGuard } from "../route-conditions.js"
import type { RouteMode } from "../route-dialects.js"
import type { TsNode } from "../types.js"
import type { Bindings, RouteItem } from "./model.js"
import type { ResolveApi } from "./resolve.js"
import type { SpecsApi } from "./specs.js"
import type { DiscoveryState } from "./state.js"
import type ts from "typescript"

export const createDiscoverObjects = (deps: DiscoveryState & ResolveApi & SpecsApi) => {
  const { ctx, innerMode, lastChild, resolveRouteList, objectSpec, excerpt, namedRouteObject, translatedRoute } = deps

  const topArrays = (node: TsNode): readonly ts.ArrayLiteralExpression[] => {
    const found: ts.ArrayLiteralExpression[] = []
    const visit = (candidate: TsNode): void => {
      const array = ctx.ast.asArrayLiteral(candidate)
      if (array !== null) {
        found.push(array)
        return
      }
      candidate.forEachChild(visit)
    }
    visit(node)
    return found
  }

  const spreadItems = (
    element: ts.Expression,
    file: string,
    mode: RouteMode,
    bindings: Bindings,
  ): readonly RouteItem[] => {
    const devOnly = mentionsDevGuard(element)
    const target = lastChild(element) ?? element
    const resolved = resolveRouteList(target, file, mode, bindings)
    if (resolved !== null) return [{ kind: "list", list: resolved, devOnly }]
    const nested = topArrays(target)
    if (nested.length === 0)
      return [
        {
          kind: "unreadable",
          node: element,
          file,
          reason: `route list spread {${excerpt(element)}} is not a route list this source can read; its routes are not discovered`,
        },
      ]
    return nested.map((array) => ({
      kind: "list",
      list: { kind: "array", array, file, anchor: array, mode, bindings },
      devOnly,
    }))
  }

  const arrayItems = (
    array: ts.ArrayLiteralExpression,
    file: string,
    mode: RouteMode,
    bindings: Bindings,
  ): readonly RouteItem[] =>
    array.elements.flatMap((element): readonly RouteItem[] => {
      const object = ctx.ast.asObjectLiteral(element)
      if (object !== null)
        return [{ kind: "route", spec: objectSpec(object, file, mode, bindings), file, devOnly: false }]
      if (element.kind === ctx.ts.SyntaxKind.OmittedExpression) return []
      const translated = translatedRoute(element, file)
      if (translated !== null)
        return [
          {
            kind: "route",
            spec: objectSpec(translated.object, translated.file, innerMode, bindings),
            file: translated.file,
            devOnly: false,
          },
        ]
      const named = namedRouteObject(element, file)
      if (named !== null)
        return [{ kind: "route", spec: objectSpec(named.object, named.file, mode, bindings), file: named.file, devOnly: false }]
      if (element.kind === ctx.ts.SyntaxKind.SpreadElement) return spreadItems(element, file, mode, bindings)
      return [
        {
          kind: "unreadable",
          node: element,
          file,
          reason: `route list entry {${excerpt(element)}} is not a route object this source can read; its routes are not discovered`,
        },
      ]
    })

  return { arrayItems }
}

export type DiscoverObjectsApi = ReturnType<typeof createDiscoverObjects>
