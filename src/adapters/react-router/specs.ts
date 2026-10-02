import type { RouteDialectField } from "../../core/model.js"
import type { RouteMode } from "../route-dialects.js"
import { PLAIN_MODE, prefixedPath } from "../route-dialects.js"
import type { RouteFlavour } from "../route-flavours.js"
import { ROUTE_FLAVOURS } from "../route-flavours.js"
import type { TsNode } from "../types.js"
import { CATCH_ALL_PATH } from "./constants.js"
import type { ItemScopeApi } from "./item-scope.js"
import type { LazyApi } from "./lazy.js"
import type { Bindings, ElementInfo, ItemScope, ObjectMember, RouteElement, RouteList, RouteNote, RouteSpec, RouteValue } from "./model.js"
import { NO_BINDINGS, mergeInfo } from "./model.js"
import type { ResolveApi } from "./resolve.js"
import type { DiscoveryState } from "./state.js"
import type { QueryPath, V5PathsApi } from "./v5-paths.js"
import type ts from "typescript"

export const createSpecs = (deps: DiscoveryState & ResolveApi & ItemScopeApi & LazyApi & V5PathsApi) => {
  const { ctx, stringValue, exactString, memberValue, isTrue, openingOf, isFunctionLike, returnedBy, folded, resolveRouteList, itemValue, mentionsItem, analyzeComponent, analyzeLazy, analyzeValue, excerpt, regexpPathOf, regexpQueryOf, wouterPathOf } = deps

  const infoOf = (spec: RouteSpec): ElementInfo => {
    const fromElement = mergeInfo(analyzeValue(spec.element, spec.scope), analyzeComponent(spec.component, spec.mode))
    return mergeInfo(fromElement, analyzeLazy(spec.lazy, spec.scope))
  }

  const ownPathOf = (spec: RouteSpec): string | null => {
    if (spec.path === null) return spec.catchAll ? CATCH_ALL_PATH : null
    if (spec.flavour.pathSyntax === "path-to-regexp") return regexpPathOf(spec.path)
    if (spec.flavour.pathSyntax === "wouter") return wouterPathOf(spec.path)
    return spec.mode.dialect ? exactString(spec.path.value, spec.path.file) : stringValue(spec.path.value, spec.path.file)
  }

  const pathQueryOf = (spec: RouteSpec): QueryPath | null =>
    spec.path === null || spec.flavour.pathSyntax !== "path-to-regexp" ? null : regexpQueryOf(spec.path)

  const rawPathOf = (spec: RouteSpec): string | null => {
    const own = ownPathOf(spec)
    return own === null || spec.prefix === null ? own : prefixedPath(spec.prefix, own)
  }

  /**
   * A mapped route whose `path` derives from its item but cannot be read (`path={`/x/${route.slug}`}`):
   * one `<Route>` stands for every item, so reading it as pathless would stack them all on the parent.
   * Under a flavour without pathless routes an unread path is never read as pathless either.
   */
  const unreadablePath = (spec: RouteSpec): boolean =>
    spec.derivedPath ||
    ((spec.scope !== null || spec.mode.dialect || !spec.flavour.pathlessRoutes) &&
      spec.path !== null &&
      spec.path.value !== undefined &&
      ownPathOf(spec) === null)

  // ---- the two dialects, read into one RouteSpec ----

  const isFlagged = (object: ts.ObjectLiteralExpression, flag: string): boolean => {
    const found = memberValue(object, flag)
    return found !== null && isTrue(found.value)
  }

  /** A dialect redirect renders only the redirect: its component and children are never reached. */
  const childrenOf = (children: ObjectMember, file: string, mode: RouteMode, bindings: Bindings): RouteList => {
    const value = folded(children.value, bindings)
    return (
      resolveRouteList(value, file, mode, bindings) ?? {
        kind: "unreadable",
        file,
        anchor: children.node,
        reason: `route children {${excerpt(value)}} are not a route list this source can read; its routes are not discovered`,
      }
    )
  }

  const objectSpec = (
    object: ts.ObjectLiteralExpression,
    file: string,
    mode: RouteMode,
    bindings: Bindings = NO_BINDINGS,
  ): RouteSpec => {
    const field = (name: RouteDialectField): ObjectMember | null => {
      const key = mode.fields[name]
      return key === undefined ? null : memberValue(object, key)
    }
    const member = (name: RouteDialectField): RouteValue | null => {
      const found = field(name)
      return found === null ? null : { value: folded(found.value, bindings), node: found.node, file }
    }
    const index = member("index")
    const lazy = field("lazy")
    const redirect = member("redirect")
    const children = redirect === null ? field("children") : null
    return {
      node: object,
      what: "route object",
      path: member("path"),
      isIndex: index?.value !== undefined && isTrue(index.value),
      element: member("element"),
      component: redirect === null ? member("component") : null,
      lazy: lazy === null ? null : { value: lazy.node, node: lazy.node, file },
      children: children === null ? null : childrenOf(children, file, mode, bindings),
      scope: null,
      derivedPath: false,
      mode,
      redirect,
      prefixes: mode.prefixRules.filter((rule) => isFlagged(object, rule.flag)),
      prefix: null,
      flavour: ROUTE_FLAVOURS.v6,
      notes: [],
      catchAll: false,
      prefixMatch: false,
    }
  }

  // `lazy` is read as its whole attribute, like the object member, unless the item supplies it.
  const attributeReader =
    (element: RouteElement, file: string, scope: ItemScope | null) =>
    (name: string | null, whole = false): RouteValue | null => {
      const found = name === null ? undefined : ctx.ast.attributeByName(openingOf(element), name)
      if (found === undefined) return null
      const item = itemValue(found.initializer, scope)
      if (item !== null) return { value: item.value, node: found, file: item.file }
      return { value: whole ? found : found.initializer, node: found, file }
    }

  /** A render function stands for the JSX it returns; a function with no single return is read whole. */
  const renderedBy = (value: RouteValue | null): RouteValue | null => {
    const target = value?.value === undefined ? null : ctx.unwrap(value.value)
    if (value === null || target === null || !isFunctionLike(target)) return value
    return { ...value, value: returnedBy(target) ?? target }
  }

  const meaningfulChildren = (element: RouteElement): readonly TsNode[] =>
    (ctx.ts.isJsxElement(element) ? element.children : []).filter(
      (child) => !ctx.ts.isJsxText(child) || child.text.trim() !== "",
    )

  /** v5 children ARE the element: one child (a function child as what it returns), or the `<Route>` around several. */
  const childElementOf = (element: RouteElement, file: string): RouteValue | null => {
    const children = meaningfulChildren(element)
    const only = children.length === 1 ? children[0] : undefined
    if (children.length === 0) return null
    if (only === undefined) return { value: element, node: element, file }
    const inner = ctx.ts.isJsxExpression(only) ? only.expression : only
    return inner === undefined ? null : renderedBy({ value: inner, node: only, file })
  }

  const notesOf = (element: RouteElement, file: string, flavour: RouteFlavour): readonly RouteNote[] =>
    flavour.evidenceAttributes.flatMap((name) => {
      const found = ctx.ast.attributeByName(openingOf(element), name)
      return found === undefined ? [] : [{ what: `react-router ${flavour.name} \`${name}\` attribute`, node: found, file }]
    })

  /** A boolean attribute set: `exact` alone, `exact={true}`, or a mapped item's `exact: true`. */
  const isSet = (element: RouteElement, read: ReturnType<typeof attributeReader>, name: string | null): boolean => {
    const found = name === null ? undefined : ctx.ast.attributeByName(openingOf(element), name)
    if (found === undefined) return false
    if (found.initializer === undefined) return true
    const value = read(name)?.value
    return value !== undefined && isTrue(value)
  }

  /** v5 without `exact`, or wouter with `nest`. */
  const matchesByPrefix = (element: RouteElement, read: ReturnType<typeof attributeReader>, flavour: RouteFlavour): boolean =>
    (flavour.exactAttribute !== null && !isSet(element, read, flavour.exactAttribute)) ||
    isSet(element, read, flavour.nestAttribute)

  const isDerivedPath = (element: RouteElement, name: string, scope: ItemScope | null): boolean => {
    const initializer = ctx.ast.attributeByName(openingOf(element), name)?.initializer
    return itemValue(initializer, scope) === null && mentionsItem(initializer, scope)
  }

  const jsxSpec = (
    element: RouteElement,
    file: string,
    scope: ItemScope | null,
    flavour: RouteFlavour,
  ): RouteSpec => {
    const attribute = attributeReader(element, file, scope)
    const index = ctx.ast.attributeByName(openingOf(element), "index")
    const indexValue = attribute("index")?.value
    const nested = ctx.ts.isJsxElement(element) ? element.children : []
    const hasChildren = meaningfulChildren(element).length > 0
    const childElement = flavour.children === "element" ? childElementOf(element, file) : null
    const component = childElement === null ? attribute(flavour.componentAttribute) : null
    const rendered = component === null ? renderedBy(attribute(flavour.renderAttribute)) : null
    const path = attribute("path")
    return {
      node: element,
      what: scope === null ? "route element" : "mapped route element",
      path,
      isIndex:
        index !== undefined && (index.initializer === undefined || (indexValue !== undefined && isTrue(indexValue))),
      element: attribute(flavour.elementAttribute) ?? childElement ?? rendered,
      component,
      lazy: attribute("lazy", true),
      children:
        hasChildren && flavour.children === "routes"
          ? { kind: "jsx", nodes: nested, file, anchor: element, scope, flavour }
          : null,
      scope,
      derivedPath: isDerivedPath(element, "path", scope),
      mode: PLAIN_MODE,
      redirect: null,
      prefixes: [],
      prefix: null,
      flavour,
      notes: notesOf(element, file, flavour),
      catchAll: !flavour.pathlessRoutes && path === null,
      prefixMatch: matchesByPrefix(element, attribute, flavour),
    }
  }

  /** v5 `<Redirect from to>` in a `<Switch>`: a route at `from` that only redirects; without `from` it catches all. */
  const redirectSpec = (
    element: RouteElement,
    file: string,
    scope: ItemScope | null,
    flavour: RouteFlavour,
    redirect: NonNullable<RouteFlavour["redirect"]>,
  ): RouteSpec => {
    const attribute = attributeReader(element, file, scope)
    const path = attribute(redirect.from)
    return {
      node: element,
      what: "redirect element",
      path,
      isIndex: false,
      element: null,
      component: null,
      lazy: null,
      children: null,
      scope,
      derivedPath: isDerivedPath(element, redirect.from, scope),
      mode: PLAIN_MODE,
      redirect: attribute(redirect.to),
      prefixes: [],
      prefix: null,
      flavour,
      notes: notesOf(element, file, flavour),
      catchAll: path === null,
      prefixMatch: false,
    }
  }

  /** `path={["/a", "/b"]}` under a flavour with path arrays: one route per path, in array order. */
  const pathVariantsOf = (spec: RouteSpec): readonly RouteSpec[] => {
    const path = spec.path
    const array = path?.value === undefined || !spec.flavour.pathArrays ? null : ctx.ast.asArrayLiteral(path.value)
    if (path === null || array === null) return [spec]
    return array.elements.map((value) => ({ ...spec, node: value, path: { value, node: value, file: path.file } }))
  }

  /** The route specs one `<Route>` declares: one, or one per path of a path array. */
  const jsxSpecs = (
    element: RouteElement,
    file: string,
    scope: ItemScope | null,
    flavour: RouteFlavour,
  ): readonly RouteSpec[] => pathVariantsOf(jsxSpec(element, file, scope, flavour))

  /** The route specs one redirect element declares; none under a flavour without redirect elements. */
  const redirectSpecs = (
    element: RouteElement,
    file: string,
    scope: ItemScope | null,
    flavour: RouteFlavour,
  ): readonly RouteSpec[] =>
    flavour.redirect === null ? [] : pathVariantsOf(redirectSpec(element, file, scope, flavour, flavour.redirect))

  return { infoOf, ownPathOf, pathQueryOf, rawPathOf, unreadablePath, objectSpec, jsxSpecs, redirectSpecs }
}

export type SpecsApi = ReturnType<typeof createSpecs>
