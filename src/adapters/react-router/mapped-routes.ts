import { walk } from "../../core/ast.js"
import { uniqueBy } from "../../core/order.js"
import type { TsNode } from "../types.js"
import type { RouteFlavour } from "../route-flavours.js"
import { FILTER_METHOD, ITEM_ONLY_PREDICATES, MAP_METHOD, MAX_HOPS, PREDICATE_GLOBALS } from "./constants.js"
import type { ItemDefault, ItemScope, RouteElement, RouteItem, RuntimeGate } from "./model.js"
import type { ResolveApi } from "./resolve.js"
import type { ArrayGrowth, RouteDataApi } from "./route-data.js"
import type { SpecsApi } from "./specs.js"
import type { DiscoveryState } from "./state.js"
import type ts from "typescript"

export const createMappedRoutes = (deps: DiscoveryState & ResolveApi & SpecsApi & RouteDataApi) => {
  const { ctx, asRouteElement, openingOf, isRouterTag, valueOf, returnedBy, jsxSpecs, excerpt, stateInitOf, growthOf } = deps

  /** The literal items one source of route data contributes: an array literal, or one `push`/`unshift` call. */
  type DataArray = {
    readonly elements: readonly TsNode[]
    readonly file: string
    readonly gate: RuntimeGate | null
    readonly key: string
  }

  const keyOf = (node: TsNode, file: string): string => `${file}|${String(node.pos)}`

  const grownArray = (growth: ArrayGrowth, file: string, gate: RuntimeGate | null): DataArray => ({
    elements: growth.call.arguments,
    file,
    gate: gate ?? (growth.gate === null ? null : { node: growth.gate, file }),
    key: keyOf(growth.call, file),
  })

  /** The array a `const` declares plus what its `push` calls append and its `unshift` calls prepend. */
  const withGrowth = (own: readonly DataArray[], initializer: TsNode, file: string, gate: RuntimeGate | null): readonly DataArray[] => {
    const growth = growthOf(initializer)
    if (growth.length === 0) return own
    const grown = (placement: ArrayGrowth["placement"]): readonly DataArray[] =>
      growth.filter((entry) => entry.placement === placement).map((entry) => grownArray(entry, file, gate))
    return [...[...grown("prepend")].reverse(), ...own, ...grown("append")]
  }

  const declaredNamesIn = (fn: TsNode): ReadonlySet<string> => {
    const names = new Set<string>()
    walk(fn, (node) => {
      const declares = ctx.ts.isParameter(node) || ctx.ts.isBindingElement(node) || ctx.ts.isVariableDeclaration(node)
      const name = declares ? ctx.ast.asIdentifier(node.name) : null
      if (name !== null) names.add(name.text)
    })
    return names
  }

  /** An identifier that names a member or a key, not a value the expression reads. */
  const isNamePosition = (identifier: TsNode): boolean => {
    const parent = identifier.parent
    if (parent === undefined) return false
    if (ctx.ts.isPropertyAccessExpression(parent)) return parent.name === identifier
    if (ctx.ts.isPropertyAssignment(parent)) return parent.name === identifier
    if (ctx.ts.isBindingElement(parent)) return parent.name === identifier || parent.propertyName === identifier
    return ctx.ts.isJsxAttribute(parent)
  }

  const readNamesIn = (node: TsNode): readonly string[] => {
    const names: string[] = []
    walk(node, (candidate) => {
      if (ctx.ts.isIdentifier(candidate) && !isNamePosition(candidate)) names.push(candidate.text)
    })
    return names
  }

  /** `.filter((r) => !r.enterprise)` reads only the item; `.filter((r) => !r.private || session)` does not. */
  const readsOnlyItem = (predicate: TsNode | undefined): boolean => {
    if (predicate === undefined) return false
    const target = ctx.unwrap(predicate)
    const named = ctx.ast.asIdentifier(target)
    if (named !== null) return ITEM_ONLY_PREDICATES.some((name) => name === named.text)
    if (!ctx.ts.isArrowFunction(target) && !ctx.ts.isFunctionExpression(target)) return false
    const declared = declaredNamesIn(target)
    const globals: readonly string[] = PREDICATE_GLOBALS
    return readNamesIn(target.body).every((name) => declared.has(name) || globals.includes(name))
  }

  /**
   * The literal arrays a `.map` receiver can be: the array itself, a `const` naming it, a `.filter(…)`
   * of it (a subset, so every route it can yield is in the array), or a conditional whose branches all
   * are. Anything else — data fetched, computed, or passed in — is `null`. A filter or conditional whose
   * condition reads more than the item gates registration at runtime and is carried as `gate`, as is a
   * `useState(init)` value (read as `init`) and each item an `if`-guarded `push` adds.
   */
  const dataArrays = (
    node: TsNode,
    file: string,
    gate: RuntimeGate | null = null,
    depth = 0,
  ): readonly DataArray[] | null => {
    if (depth > MAX_HOPS) return null
    const target = ctx.unwrap(node)

    const array = ctx.ast.asArrayLiteral(target)
    if (array !== null) return [{ elements: array.elements, file, gate, key: keyOf(array, file) }]

    if (ctx.ts.isConditionalExpression(target)) {
      const branchGate = gate ?? { node: target, file }
      const whenTrue = dataArrays(target.whenTrue, file, branchGate, depth + 1)
      const whenFalse = dataArrays(target.whenFalse, file, branchGate, depth + 1)
      if (whenTrue === null || whenFalse === null) return null
      return uniqueBy([...whenTrue, ...whenFalse], (entry) => entry.key)
    }

    const call = ctx.ast.asCallExpression(target)
    const access = call === null ? null : ctx.ast.asPropertyAccess(call.expression)
    if (call !== null && access !== null) {
      if (access.name.text !== FILTER_METHOD) return null
      const filterGate = gate ?? (readsOnlyItem(call.arguments[0]) ? null : { node: call, file })
      return dataArrays(access.expression, file, filterGate, depth + 1)
    }

    const identifier = ctx.ast.asIdentifier(target)
    const state = identifier === null ? null : stateInitOf(identifier)
    if (state !== null) return dataArrays(state.init, file, gate ?? { node: state.call, file }, depth + 1)
    const declared = identifier === null ? null : valueOf(identifier, file)
    const own = declared === null ? null : dataArrays(declared.node, declared.file, gate, depth + 1)
    return declared === null || own === null ? null : withGrowth(own, declared.node, declared.file, gate)
  }

  const callbackNames = (callback: ts.SignatureDeclaration): ReadonlyMap<string, string | null> | null => {
    const parameter = callback.parameters[0]
    if (parameter === undefined) return new Map()
    const named = ctx.ast.asIdentifier(parameter.name)
    if (named !== null) return new Map([[named.text, null]])
    if (!ctx.ts.isObjectBindingPattern(parameter.name)) return null

    const names = new Map<string, string | null>()
    for (const binding of parameter.name.elements) {
      const local = ctx.ast.asIdentifier(binding.name)
      const property = binding.propertyName === undefined ? local : ctx.ast.asIdentifier(binding.propertyName)
      if (binding.dotDotDotToken !== undefined || local === null || property === null) return null
      names.set(local.text, property.text)
    }
    return names
  }

  /** `({ Fallback = Loading }) => …`: each destructured member's default, keyed by the member it reads. */
  const callbackDefaults = (callback: ts.SignatureDeclaration, file: string): ReadonlyMap<string, ItemDefault> => {
    const pattern = callback.parameters[0]?.name
    if (pattern === undefined || !ctx.ts.isObjectBindingPattern(pattern)) return new Map()
    return new Map(
      pattern.elements.flatMap((binding) => {
        const property = ctx.ast.asIdentifier(binding.propertyName ?? binding.name)
        return property === null || binding.initializer === undefined
          ? []
          : [[property.text, { value: binding.initializer, file }] as const]
      }),
    )
  }

  type MappedRoute = {
    readonly arrays: readonly DataArray[]
    readonly names: ReadonlyMap<string, string | null>
    readonly defaults: ReadonlyMap<string, ItemDefault>
    readonly route: RouteElement
  }

  const mappedRoute = (node: TsNode, file: string, flavour: RouteFlavour): MappedRoute | null => {
    const call = ctx.ast.asCallExpression(node)
    const access = call === null ? null : ctx.ast.asPropertyAccess(call.expression)
    const argument = call?.arguments[0]
    if (access === null || access.name.text !== MAP_METHOD || argument === undefined) return null

    const callback = ctx.unwrap(argument)
    if (!ctx.ts.isArrowFunction(callback) && !ctx.ts.isFunctionExpression(callback)) return null
    const names = callbackNames(callback)
    const returned = returnedBy(callback)
    const route = returned === null ? null : asRouteElement(returned)
    if (names === null || route === null || !isRouterTag(file, openingOf(route), flavour.routeTag)) return null

    const arrays = dataArrays(access.expression, file)
    return arrays === null ? null : { arrays, names, defaults: callbackDefaults(callback, file), route }
  }

  const mappedItems = (
    mapped: MappedRoute,
    file: string,
    outer: ItemScope | null,
    devOnly: boolean,
    flavour: RouteFlavour,
  ): readonly RouteItem[] => {
    const itemsIn = (entry: DataArray, depth: number): readonly RouteItem[] =>
      entry.elements.flatMap((element): readonly RouteItem[] => {
        const arrayFile = entry.file
        const item = ctx.ast.asObjectLiteral(element)
        if (item !== null) {
          const scope: ItemScope = { names: mapped.names, item, file: arrayFile, outer, gate: entry.gate, defaults: mapped.defaults }
          return jsxSpecs(mapped.route, file, scope, flavour).map((spec) => ({ kind: "route", spec, file, devOnly }))
        }
        const spread = ctx.ts.isSpreadElement(element)
          ? dataArrays(element.expression, arrayFile, entry.gate, depth + 1)
          : null
        if (spread !== null && depth < MAX_HOPS) return spread.flatMap((nested) => itemsIn(nested, depth + 1))
        return [
          {
            kind: "unreadable",
            node: element,
            file: arrayFile,
            reason: `route data {${excerpt(element)}} mapped into <Route> is not an object literal this source can read; its route is not discovered`,
          },
        ]
      })
    return mapped.arrays.flatMap((entry) => itemsIn(entry, 0))
  }

  return { mappedRoute, mappedItems }
}

export type MappedRoutesApi = ReturnType<typeof createMappedRoutes>
