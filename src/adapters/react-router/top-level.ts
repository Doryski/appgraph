import { isComponentTag, walk } from "../../core/ast.js"
import type { TsNode } from "../types.js"
import { appFiles, routerElementText } from "./constants.js"
import type { DescendantsApi } from "./descendants.js"
import type { ElementsApi } from "./elements.js"
import type { ComponentRef, MergeScope, RouteContext, RouteRoot } from "./model.js"
import type { ParseApi } from "./parse.js"
import type { ResolveApi } from "./resolve.js"
import type { RootsApi } from "./roots.js"
import type { DiscoveryState } from "./state.js"
import { within } from "./wrappers.js"
import type ts from "typescript"

export const createTopLevel = (deps: DiscoveryState & ResolveApi & ElementsApi & RootsApi & DescendantsApi & ParseApi) => {
  const { ctx, profile, drafts, ancestors, ordinals, parsedRoots, flags, report, isRouteTag, isFunctionLike, fileOfTag, ownElements, routerNameOf, rootsIn, declarationScope, enclosureOf, urlsOf, parseRoot } = deps

  const topLevelMerges = new Map<string, MergeScope>()

  /** Separate router factories rendering one url both render there: one screen, not a duplicate id. */
  const factoryMerge: MergeScope = new Map()

  const enclosingFunction = (node: TsNode): TsNode => {
    let scope = node
    while (scope.parent !== undefined && !isFunctionLike(scope)) scope = scope.parent
    return scope
  }

  type RootFrame = Pick<RouteContext, "auth" | "featureFlag" | "title" | "ancestors">

  const OPEN_FRAME: RootFrame = { auth: "public", featureFlag: null, title: null, ancestors: [] }

  /** `<PrivateRoute><Switch>…</Switch></PrivateRoute>`: under a flavour with root wrappers they frame every route. */
  const rootFrameOf = (root: RouteRoot): RootFrame => {
    if (root.list?.kind !== "jsx" || !root.list.flavour.rootWrappers) return OPEN_FRAME
    const { chain, guards } = enclosureOf(root.node, enclosingFunction(root.node), root.file, null)
    return {
      auth: guards.auth === "protected" ? "protected" : "public",
      featureFlag: guards.featureFlag,
      title: guards.title,
      ancestors: chain,
    }
  }

  const topLevel = (root: RouteRoot): RouteContext => {
    const merge = topLevelMerges.get(root.file) ?? new Map()
    topLevelMerges.set(root.file, merge)
    return {
      ...rootFrameOf(root),
      file: root.file,
      url: null,
      lineage: [],
      devOnly: false,
      merge: root.kind === "factory" ? factoryMerge : merge,
      root,
    }
  }

  const urlOwners = new Map<string, string>()

  const withdrawn = new Set<RouteRoot>()

  const isRouterElement = (file: string, opening: ts.JsxOpeningLikeElement): boolean => {
    const tag = ctx.ast.tagName(opening)
    const exported = tag === null ? null : routerNameOf(file, tag)
    return exported !== null && profile.routerElements.includes(exported)
  }

  const renderedComponent = (file: string, opening: ts.JsxOpeningLikeElement): ComponentRef | null => {
    const tag = ctx.ast.tagName(opening)
    if (tag === null || !isComponentTag(tag)) return null
    const imported = fileOfTag(file, tag)
    if (imported !== null) return imported
    const source = ctx.sourceFile(file)
    return source !== null && ctx.ast.declarationOf(source, tag) !== null ? { file, exportName: tag } : null
  }

  const routerText = routerElementText(profile.routerElements)

  /** Components a router element renders directly — outside any `<Routes>`, so not as some route's element. */
  const routerRenderedIn = (file: string): readonly ComponentRef[] => {
    const text = ctx.readFile(file)
    const source = text === null || !routerText.test(text) ? null : ctx.sourceFile(file)
    if (source === null) return []
    const found: ComponentRef[] = []
    walk(source, (node) => {
      if (!ctx.ts.isJsxElement(node) || !isRouterElement(file, node.openingElement)) return
      for (const opening of ownElements(node, file)) {
        const component = renderedComponent(file, opening)
        if (component !== null) found.push(component)
      }
    })
    return found
  }

  const isUnderRouter = (root: RouteRoot): boolean => {
    for (let node = root.node.parent; node !== undefined; node = node.parent)
      if (ctx.ts.isJsxElement(node) && isRouterElement(root.file, node.openingElement)) return true
    return false
  }

  const sourceFiles = new Set(appFiles(ctx))

  const routeBoundaries = (file: string, elements: readonly ts.JsxOpeningLikeElement[]): readonly TsNode[] => [
    ...rootsIn(file).flatMap((root) => (root.list?.file === file ? [root.node, root.list.anchor] : [root.node])),
    ...elements.flatMap((element) => {
      if (!isRouteTag(file, element)) return []
      return [ctx.ts.isJsxOpeningElement(element) ? element.parent : element]
    }),
  ]

  /** Components a component renders itself, outside every route list and route element it declares. */
  const plainRendersOf = (component: ComponentRef): readonly ComponentRef[] => {
    const source = ctx.sourceFile(component.file)
    const scope = source === null ? null : declarationScope(source, component.exportName)
    if (scope === null) return []
    const elements = ownElements(scope, component.file)
    const boundaries = routeBoundaries(component.file, elements)
    return elements
      .filter((element) => !boundaries.some((boundary) => within(element, boundary)))
      .flatMap((element) => {
        const rendered = renderedComponent(component.file, element)
        return rendered !== null && sourceFiles.has(rendered.file) ? [rendered] : []
      })
  }

  /** Every component a router renders through plain component hops: none of them sits under a route. */
  const renderClosure = (seeds: readonly ComponentRef[]): readonly ComponentRef[] => {
    const seen = new Map<string, ComponentRef>()
    const queue = [...seeds]
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const key = `${next.file}|${next.exportName}`
      if (seen.has(key)) continue
      seen.set(key, next)
      queue.push(...plainRendersOf(next))
    }
    return [...seen.values()]
  }

  const isRenderedByRouter = (root: RouteRoot, rendered: readonly ComponentRef[]): boolean => {
    const source = ctx.sourceFile(root.file)
    if (source === null) return false
    return rendered.some((component) => {
      const scope = component.file === root.file ? declarationScope(source, component.exportName) : null
      return scope !== null && within(root.node, scope)
    })
  }

  const restore = <K, V>(target: Map<K, V>, saved: ReadonlyMap<K, V>): void => {
    target.clear()
    for (const [key, value] of saved) target.set(key, value)
  }

  type Footprint = {
    readonly urls: readonly string[]
    /** The descendant lists reading the root mounts: withdrawing the root withdraws them with it. */
    readonly mounted: readonly RouteRoot[]
  }

  /** What a root WOULD claim read top-level, with every side effect of reading it undone. */
  const footprintOf = (root: RouteRoot): Footprint => {
    const count = drafts.length
    const savedOrdinals = new Map(ordinals)
    const savedAncestors = new Map(ancestors)
    const savedParsed = [...parsedRoots]
    flags.dryRun = true
    parseRoot(root, { ...topLevel(root), merge: new Map() })
    flags.dryRun = false
    const urls = drafts.slice(count).flatMap(urlsOf)
    const mounted = [...parsedRoots].filter((parsed) => parsed !== root && !savedParsed.includes(parsed))
    drafts.splice(count)
    restore(ordinals, savedOrdinals)
    restore(ancestors, savedAncestors)
    parsedRoots.clear()
    for (const parsed of savedParsed) parsedRoots.add(parsed)
    return { urls, mounted }
  }

  const parseKept = (root: RouteRoot): void => {
    const count = drafts.length
    parseRoot(root, topLevel(root))
    for (const url of drafts.slice(count).flatMap(urlsOf)) if (!urlOwners.has(url)) urlOwners.set(url, root.file)
  }

  type Clash = {
    readonly url: string
    readonly owner: string
    readonly rival: boolean
  }

  const clashOf = (root: RouteRoot, footprints: ReadonlyMap<RouteRoot, Footprint>): Clash | null => {
    for (const url of footprints.get(root)?.urls ?? []) {
      const owner = urlOwners.get(url)
      if (owner !== undefined && owner !== root.file) return { url, owner, rival: false }
      const rival = [...footprints].find(([other, footprint]) => other.file !== root.file && footprint.urls.includes(url))
      if (rival !== undefined) return { url, owner: rival[0].file, rival: true }
    }
    return null
  }

  const clashNote = (clash: Clash | null): string => {
    if (clash === null) return ""
    const owner = clash.rival ? `the route list in ${clash.owner} also claims` : `${clash.owner} already claims`
    return `; read top-level it would claim '${clash.url}', which ${owner}`
  }

  const withdrawalReason = (root: RouteRoot, clash: Clash | null): string =>
    `${root.label} at ${root.file}:${String(ctx.lineOf(root.file, root.node))} could not be linked to a mounting route: no route this source can follow claims it, and it is not provably top-level (under a ${profile.routerElements.join("/")}, in a component one renders, or the app's only unclaimed route list)${clashNote(clash)}; it is most likely a descendant route list under a route whose element this source cannot follow, so it is withdrawn rather than read at the root, and its routes, with the descendant lists they mount, are not discovered`

  const withdraw = (root: RouteRoot, footprints: ReadonlyMap<RouteRoot, Footprint>): void => {
    withdrawn.add(root)
    for (const descendant of footprints.get(root)?.mounted ?? []) withdrawn.add(descendant)
    report({
      severity: "warning",
      code: "screens/conflict-dropped",
      message: withdrawalReason(root, clashOf(root, footprints)),
      file: root.file,
      line: ctx.lineOf(root.file, root.node),
    })
  }

  const isProvablyTopLevel = (root: RouteRoot, rendered: readonly ComponentRef[]): boolean =>
    root.kind === "factory" ||
    (root.list?.kind === "jsx" && root.list.flavour.unclaimedTopLevel) ||
    isUnderRouter(root) ||
    isRenderedByRouter(root, rendered)

  /**
   * A `<Routes>`/`useRoutes` list no followed route claims is read top-level only when that is provable:
   * a factory, a list under a router element or in a component one renders through plain component hops,
   * or — with `sole` — the app's only unclaimed list, which nothing else could mount. Any other list cannot
   * be told apart from a descendant list under a route this source cannot follow, so it is withdrawn whole
   * and reported, whether or not its urls collide. No decision depends on file order.
   */
  const parseTopLevels = (candidates: readonly RouteRoot[], rendered: readonly ComponentRef[], sole: boolean): void => {
    const alone = sole && candidates.length === 1
    const fixed = new Set(candidates.filter((root) => alone || isProvablyTopLevel(root, rendered)))
    for (const root of candidates) if (fixed.has(root)) parseKept(root)

    const loose = candidates.filter((root) => !fixed.has(root))
    const footprints = new Map(loose.map((root) => [root, footprintOf(root)] as const))
    for (const root of loose) withdraw(root, footprints)
  }

  return { withdrawn, routerRenderedIn, renderClosure, parseTopLevels }
}

export type TopLevelApi = ReturnType<typeof createTopLevel>
