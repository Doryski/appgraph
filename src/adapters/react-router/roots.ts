import { walk } from "../../core/ast.js"
import type { RouteFlavour } from "../route-flavours.js"
import type { TsNode } from "../types.js"
import { importedBindingOf } from "../values.js"
import { FACTORY_WRAPPERS, FACTORY_WRAPPER_CALL, LEADING_SLASH, MAX_HOPS, ROUTER_CALL, ROUTE_HOOK_NAME, rootElementText } from "./constants.js"
import type { RouteRoot } from "./model.js"
import type { ResolveApi } from "./resolve.js"
import type { DiscoveryState } from "./state.js"
import { regexOf } from "./wrappers.js"
import type ts from "typescript"

export const createRoots = (deps: DiscoveryState & ResolveApi) => {
  const { ctx, profile, factories, hooks, outerMode, calleeName, exactString, asRouteElement, openingOf, isImportedRouterTag, isRouteTag, rootFlavourOf, looseFlavourOf, resolveRouteList } = deps

  // ---- roots: router factories, `useRoutes` calls, `<Routes>`/`<Switch>` elements and loose `<Route>` groups ----

  const rootCache = new Map<string, readonly RouteRoot[]>()

  const rootText = rootElementText(profile.flavours)

  const isRouteFile = (text: string): boolean =>
    ROUTER_CALL.test(text) ||
    FACTORY_WRAPPER_CALL.test(text) ||
    ROUTE_HOOK_NAME.test(text) ||
    rootText.test(text)

  const isFactoryWrapper = (call: ts.CallExpression, file: string): boolean => {
    const callee = ctx.ast.asIdentifier(call.expression)
    const imported = callee === null ? null : importedBindingOf(ctx.bindingsFor(file).get(callee.text))
    const wrapped = call.arguments[0] === undefined ? null : ctx.ast.asIdentifier(call.arguments[0])
    if (imported === null || wrapped === null || !factories.includes(wrapped.text)) return false
    return FACTORY_WRAPPERS.some(
      (wrapper) => regexOf(wrapper.exported).test(imported.imported) && regexOf(wrapper.module).test(imported.module),
    )
  }

  const isRouterModule = (spec: string): boolean => regexOf(profile.module).test(spec)

  const reExportsOf = (source: ts.SourceFile): readonly ts.ExportDeclaration[] =>
    source.statements.filter((statement) => ctx.ts.isExportDeclaration(statement))

  const moduleSpecOf = (statement: ts.ExportDeclaration): string | null =>
    statement.moduleSpecifier === undefined ? null : (ctx.ast.asStringLiteralLike(statement.moduleSpecifier)?.text ?? null)

  /**
   * The react-router export `name` names once `file`'s re-exports are followed (`export { useRoutes } from
   * "react-router-dom"` in an app barrel), else `null`. A module that declares `name` itself is the app's own.
   */
  const reExportedRouterName = (file: string, name: string, hops: number): string | null => {
    const source = hops > MAX_HOPS ? null : ctx.sourceFile(file)
    if (source === null || ctx.ast.declarationOf(source, name) !== null) return null

    const statements = reExportsOf(source)
    for (const statement of statements) {
      const clause = statement.exportClause
      const element =
        clause !== undefined && ctx.ts.isNamedExports(clause)
          ? clause.elements.find((candidate) => candidate.name.text === name)
          : undefined
      if (element === undefined) continue
      const origin = element.propertyName?.text ?? name
      const spec = moduleSpecOf(statement)
      if (spec === null) return routerNameOf(file, origin, hops + 1)
      if (isRouterModule(spec)) return origin
      const target = ctx.resolveModule(file, spec)
      return target === null ? null : reExportedRouterName(target, origin, hops + 1)
    }

    for (const statement of statements) {
      const spec = statement.exportClause === undefined ? moduleSpecOf(statement) : null
      if (spec === null) continue
      if (isRouterModule(spec)) return name
      const target = ctx.resolveModule(file, spec)
      const found = target === null ? null : reExportedRouterName(target, name, hops + 1)
      if (found !== null) return found
    }
    return null
  }

  /** The react-router export a local name is bound to, directly or through an app barrel. */
  const routerNameOf = (file: string, local: string, hops = 0): string | null => {
    const bound = importedBindingOf(ctx.bindingsFor(file).get(local))
    if (bound === null) return null
    if (isRouterModule(bound.module)) return bound.imported
    const declaring = ctx.resolveModule(file, bound.module)
    return declaring === null ? null : reExportedRouterName(declaring, bound.imported, hops + 1)
  }

  const isRouterImport = (file: string, name: string, imported: string): boolean =>
    routerNameOf(file, name) === imported

  /** `useRoutes(…)` counts only when imported from react-router — an app's own `useRoutes` hook is not it. */
  const isRouteHook = (call: ts.CallExpression, file: string): boolean => {
    const callee = ctx.ast.asIdentifier(call.expression)
    if (callee !== null) return hooks.some((hook) => isRouterImport(file, callee.text, hook))
    const access = ctx.ast.asPropertyAccess(call.expression)
    const namespace = access === null ? null : ctx.ast.asIdentifier(access.expression)
    return access !== null && namespace !== null && hooks.includes(access.name.text) && isRouterImport(file, namespace.text, "*")
  }

  /** Names bound to a provably-unchanged factory: `const create = wrapCreateBrowserRouterV6(createBrowserRouter)`. */
  const factoryAliases = (source: ts.SourceFile, file: string): ReadonlySet<string> => {
    const aliases = new Set<string>()
    walk(source, (node) => {
      if (!ctx.ts.isVariableDeclaration(node) || node.initializer === undefined) return
      const name = ctx.ast.asIdentifier(node.name)
      const call = ctx.ast.asCallExpression(node.initializer)
      if (name !== null && call !== null && isFactoryWrapper(call, file)) aliases.add(name.text)
    })
    return aliases
  }

  /**
   * The enclosing `<Router base>` prefixes of a root, outermost first and joined. The walk stops at a route
   * element: what encloses that route is already in the url its descendant lists are read under.
   */
  const baseOf = (node: TsNode, file: string, flavour: RouteFlavour): string | null => {
    const base = flavour.base
    if (base === null) return null
    const segments: string[] = []
    for (let scope = node.parent; scope !== undefined; scope = scope.parent) {
      if (!ctx.ts.isJsxElement(scope)) continue
      const opening = scope.openingElement
      if (isRouteTag(file, opening)) break
      if (!isImportedRouterTag(file, opening, base.tag)) continue
      const value = exactString(ctx.ast.attributeByName(opening, base.attribute)?.initializer, file)
      if (value !== null) segments.unshift(value.replace(LEADING_SLASH, ""))
    }
    const joined = segments.filter((segment) => segment !== "").join("/")
    return joined === "" ? null : joined
  }

  /** A loose route's parent groups its siblings into one list, unless it is a root whose own list holds them. */
  const isGroupParent = (parent: TsNode, file: string): boolean =>
    ctx.ts.isJsxFragment(parent) || (ctx.ts.isJsxElement(parent) && rootFlavourOf(file, parent.openingElement) === null)

  type LooseGroup = {
    readonly flavour: RouteFlavour
    readonly routes: TsNode[]
  }

  /** A loose group is anchored at its first route: the wrappers around the routes frame them, the parent included. */
  const groupRoot = (group: LooseGroup, file: string): RouteRoot | null => {
    const first = group.routes[0]
    if (first === undefined) return null
    const { flavour, routes } = group
    return {
      file,
      node: first,
      label: `<${flavour.routeTag}> group`,
      kind: "element",
      list: { kind: "jsx", nodes: routes, file, anchor: first, scope: null, flavour },
      base: baseOf(first, file, flavour),
    }
  }

  const collectRoots = (file: string): readonly RouteRoot[] => {
    const text = ctx.readFile(file)
    if (text === null || !isRouteFile(text)) return []

    const source = ctx.sourceFile(file)
    if (source === null) {
      ctx.nearMiss(file, `file matched a ${profile.name} route declaration but did not parse`)
      return []
    }

    const aliases = factoryAliases(source, file)
    const isFactory = (name: string): boolean => factories.includes(name) || aliases.has(name)
    const roots: RouteRoot[] = []
    const groups = new Map<TsNode, LooseGroup>()
    walk(source, (node) => {
      const call = ctx.ts.isCallExpression(node) ? node : null
      const name = call === null ? null : calleeName(call)
      if (call !== null && name !== null && (isFactory(name) || isRouteHook(call, file))) {
        const kind = isFactory(name) ? "factory" : "hook"
        roots.push({ file, node: call, label: name, kind, list: resolveRouteList(call.arguments[0], file, outerMode), base: null })
        return
      }

      const element = asRouteElement(node)
      const loose = element === null ? null : looseFlavourOf(file, openingOf(element))
      const parent = node.parent
      if (loose !== null && parent !== undefined && isGroupParent(parent, file)) {
        const group = groups.get(parent) ?? { flavour: loose, routes: [] }
        group.routes.push(node)
        groups.set(parent, group)
        return
      }

      const flavour = ctx.ts.isJsxElement(node) ? rootFlavourOf(file, node.openingElement) : null
      if (flavour === null || !ctx.ts.isJsxElement(node)) return
      roots.push({
        file,
        node,
        label: `<${flavour.rootTag}>`,
        kind: "element",
        list: { kind: "jsx", nodes: node.children, file, anchor: node, scope: null, flavour },
        base: baseOf(node, file, flavour),
      })
    })
    if (groups.size === 0) return roots
    const grouped = [...groups.values()].flatMap((group) => groupRoot(group, file) ?? [])
    return [...roots, ...grouped].sort((left, right) => left.node.pos - right.node.pos)
  }

  const rootsIn = (file: string): readonly RouteRoot[] => {
    const cached = rootCache.get(file)
    if (cached !== undefined) return cached
    const roots = collectRoots(file)
    rootCache.set(file, roots)
    return roots
  }

  return { routerNameOf, rootsIn }
}

export type RootsApi = ReturnType<typeof createRoots>
