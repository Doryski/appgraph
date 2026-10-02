import type { AncestorRef, SpliceMode } from "../../core/model.js"
import { uniqueBy } from "../../core/order.js"
import { joinUrl } from "../../core/url.js"
import { dynamicImportsIn, lazyModuleEntry } from "../dynamic-imports.js"
import type { EntryRef, TsNode } from "../types.js"
import { ROUTES_SPLICE, SPLAT_SUFFIX } from "./constants.js"
import type { ElementsApi } from "./elements.js"
import type { LazyApi } from "./lazy.js"
import type { ComponentRef, Descendant, ElementInfo, ItemScope, RouteList, RouteRoot, RouteSpec, TagUse } from "./model.js"
import { EMPTY_ELEMENT, mergeInfo } from "./model.js"
import type { ResolveApi } from "./resolve.js"
import type { RootsApi } from "./roots.js"
import type { RouteListsApi } from "./route-lists.js"
import type { SpecsApi } from "./specs.js"
import type { DiscoveryState } from "./state.js"
import { within } from "./wrappers.js"
import type ts from "typescript"

const LAZY_CALLEE = "lazy"
const MAX_LAZY_HOPS = 3

export const createDescendants = (deps: DiscoveryState & ResolveApi & ElementsApi & LazyApi & SpecsApi & RouteListsApi & RootsApi) => {
  const { ctx, fileOfTag, analyzeTags, tagOf, ownElements, analyzeComponent, analyzeLazy, rawPathOf, itemsOf, rootsIn } = deps

  const componentOf = (entry: EntryRef): ComponentRef | null => {
    if (entry.kind === "file") return { file: entry.file, exportName: entry.exportName }
    return entry.kind === "binding" ? fileOfTag(entry.from, entry.local) : null
  }

  const declarationScope = (source: ts.SourceFile, exportName: string): TsNode | null => {
    const declaration = ctx.ast.declarationOf(source, exportName)
    if (declaration === null || !ctx.ts.isExportAssignment(declaration)) return declaration
    const named = ctx.ast.asIdentifier(declaration.expression)
    return named === null ? declaration : ctx.ast.declarationOf(source, named.text)
  }

  const isLazyCall = (node: TsNode | undefined): node is ts.CallExpression => {
    const call = node === undefined ? null : ctx.ast.asCallExpression(ctx.unwrap(node))
    if (call === null) return false
    const callee = ctx.ast.asIdentifier(call.expression)?.text ?? ctx.ast.asPropertyAccess(call.expression)?.name.text
    return callee === LAZY_CALLEE
  }

  /** `export const X = lazy(() => import("./XExport"))`: the component the lazy module's export resolves to. */
  const lazyTargetOf = (component: ComponentRef): ComponentRef | null => {
    const source = ctx.sourceFile(component.file)
    const declaration = source === null ? null : ctx.ast.declarationOf(source, component.exportName)
    if (declaration === null || !ctx.ts.isVariableDeclaration(declaration)) return null
    const initializer = declaration.initializer
    if (!isLazyCall(initializer)) return null
    const [spec] = dynamicImportsIn(ctx, initializer)
    return spec === undefined ? null : lazyModuleEntry(ctx, component.file, spec).target
  }

  /** The component that renders the `<Routes>`: the entry itself, or what its `lazy()` loads. */
  const routesOwnerOf = (component: ComponentRef, hops = 0): ComponentRef => {
    if (rootsIn(component.file).length > 0 || hops >= MAX_LAZY_HOPS) return component
    const target = lazyTargetOf(component)
    return target === null ? component : routesOwnerOf(target, hops + 1)
  }

  /** The descendant route roots a component renders itself — only these splice in at its `<Routes>`. */
  const descendantRootsOf = (component: ComponentRef): readonly RouteRoot[] => {
    const roots = rootsIn(component.file).filter((root) => root.kind !== "factory")
    if (roots.length === 0) return []
    const source = ctx.sourceFile(component.file)
    const scope = source === null ? null : declarationScope(source, component.exportName)
    if (scope === null) return roots
    return roots.filter((root) => within(root.node, scope))
  }

  /**
   * Where a route's descendant lists mount: under its splat, or — for a prefix-matching v5 route or a wouter
   * `nest` route — its own url. A wouter splat without `nest` hands its lists the enclosing base unchanged.
   */
  const splatBase = (spec: RouteSpec, parentUrl: string | null, relative = false): string | null | undefined => {
    const declared = rawPathOf(spec)
    const rawPath = relative && declared?.startsWith("/") ? declared.slice(1) : declared
    if (rawPath === null) return undefined
    if (!SPLAT_SUFFIX.test(rawPath)) return spec.prefixMatch ? joinUrl(parentUrl, rawPath) : undefined
    if (!spec.flavour.splatNests) return parentUrl
    const own = rawPath.replace(SPLAT_SUFFIX, "")
    return own === "" ? parentUrl : joinUrl(parentUrl, own)
  }

  type Enclosure = {
    readonly chain: readonly AncestorRef[]
    readonly guards: ElementInfo
  }

  /** The wrappers that ENCLOSE `target` inside a route's element, outermost first, and what they decide. */
  const enclosureOf = (target: TsNode, element: TsNode, file: string, scope: ItemScope | null): Enclosure => {
    const uses: TagUse[] = []
    for (let node = target.parent; node !== undefined && within(node, element); node = node.parent) {
      const read = ctx.ts.isJsxElement(node) ? tagOf(node.openingElement, file, scope) : null
      if (read?.kind === "use") uses.unshift(read.use)
    }
    const chain = uses.flatMap((use) => {
      const info = analyzeTags([use], file, scope)
      return [...info.wrappers, ...info.entryAncestors]
    })
    return { chain, guards: analyzeTags(uses, file, scope) }
  }

  const mountSplice = (root: RouteRoot): SpliceMode =>
    root.list?.kind === "jsx" && root.list.flavour.mountsAtRoot ? { kind: "at", locator: ctx.locatorOf(root.node) } : ROUTES_SPLICE

  const routesMount = (component: ComponentRef, root: RouteRoot): AncestorRef => ({ ...component, splice: mountSplice(root), role: "layout" })

  /**
   * A `<Routes>` written inline in a splat route's element is that route's descendant list exactly as one
   * rendered by its element's component is; only the outermost such lists count, the rest nest in them.
   */
  const inlineDescendants = (spec: RouteSpec): readonly Descendant[] => {
    const element = spec.element
    if (element?.value === undefined) return []
    const value = element.value
    // A loose route group anchored at this very route (wouter) is the list the route sits in, not one it renders.
    const inside = rootsIn(element.file).filter(
      (root) => root.kind === "element" && root.node !== spec.node && within(root.node, value),
    )
    return inside
      .filter((root) => !inside.some((other) => other !== root && within(root.node, other.node)))
      .map((root) => {
        const enclosure = enclosureOf(root.node, value, root.file, spec.scope)
        return { root, mount: enclosure.chain, guards: enclosure.guards }
      })
  }

  /** A component the element renders outside any inline `<Routes>`, mounted under the wrappers enclosing it. */
  const mountedDescendants = (spec: RouteSpec): readonly Descendant[] => {
    const element = spec.element
    if (element?.value === undefined) return []
    const value = element.value
    return ownElements(value, element.file).flatMap((opening) => {
      const read = tagOf(opening, element.file, spec.scope)
      const own = read?.kind === "use" ? analyzeTags([read.use], element.file, spec.scope) : EMPTY_ELEMENT
      const entry = own.entries[0]
      const entryComponent = entry === undefined ? null : componentOf(entry)
      if (entryComponent === null) return []
      const component = routesOwnerOf(entryComponent)
      const node = ctx.ts.isJsxOpeningElement(opening) ? opening.parent : opening
      const enclosure = enclosureOf(node, value, element.file, spec.scope)
      return descendantRootsOf(component).map((root) => ({
        root,
        mount: [...enclosure.chain, ...own.wrappers, routesMount(component, root)],
        guards: enclosure.guards,
      }))
    })
  }

  /** `Component: X` and lazy modules name their entry with no JSX around it to enclose the mount. */
  const unwrappedDescendants = (spec: RouteSpec): readonly Descendant[] => {
    const info = mergeInfo(analyzeComponent(spec.component, spec.mode), analyzeLazy(spec.lazy, spec.scope))
    return info.entries.flatMap((entry) => {
      const entryComponent = componentOf(entry)
      if (entryComponent === null) return []
      const component = routesOwnerOf(entryComponent)
      return descendantRootsOf(component).map((root) => ({
        root,
        mount: [...info.wrappers, routesMount(component, root)],
        guards: info,
      }))
    })
  }

  const rootKey = (root: RouteRoot): string => `${root.file}|${String(root.node.pos)}`

  const descendantsOf = (spec: RouteSpec): readonly Descendant[] =>
    uniqueBy(
      [...inlineDescendants(spec), ...mountedDescendants(spec), ...unwrappedDescendants(spec)],
      (descendant) => rootKey(descendant.root),
    )

  // ---- claim scan: which roots are DESCENDANT routes of some splat route, not top-level ones ----

  const claimedRoots = (roots: readonly RouteRoot[]): ReadonlySet<RouteRoot> => {
    const claimed = new Set<RouteRoot>()
    const open = new Set<TsNode>()

    const scanList = (list: RouteList): void => {
      if (open.has(list.anchor)) return
      open.add(list.anchor)
      for (const item of itemsOf(list)) {
        if (item.kind === "list") scanList(item.list)
        if (item.kind !== "route") continue
        if (splatBase(item.spec, null) !== undefined)
          for (const { root } of descendantsOf(item.spec))
            claimed.add(root)
        if (item.spec.children !== null) scanList(item.spec.children)
      }
      open.delete(list.anchor)
    }

    for (const root of roots) if (root.list !== null) scanList(root.list)
    return claimed
  }

  return { declarationScope, splatBase, enclosureOf, descendantsOf, claimedRoots }
}

export type DescendantsApi = ReturnType<typeof createDescendants>
