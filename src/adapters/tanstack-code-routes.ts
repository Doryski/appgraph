import type ts from "typescript"
import { walk } from "../core/ast.js"
import type { AncestorRef, Evidence } from "../core/model.js"
import { sortedUnique, uniqueBy } from "../core/order.js"
import { isNonAppFile } from "../core/project.js"
import { convertTanStackCodePath, normalizeUrl, paramsOf } from "../core/url.js"
import { DEV_ONLY_EVIDENCE, createBuildModeReader, devOnlyNestedEvidence } from "./route-conditions.js"
import type { ComponentRef, InheritedGuard, PathlessRoles, RouteOptionsReader } from "./tanstack-route-options.js"
import {
  authOfLayers,
  guardAuthTexts,
  guardedAuth,
  ownGuard,
  passedGuard,
  redirectOfGuard,
} from "./tanstack-route-options.js"
import { createStringValueReader, importedBindingOf } from "./values.js"
import type { DiscoverContext, ScreenDraft, TsNode } from "./types.js"
import { SCRIPT_GLOB } from "../core/extensions.js"

export const CODE_ROUTE_FACTORY = "createRoute"

export const ROOT_ROUTE_FACTORIES = ["createRootRoute", "createRootRouteWithContext"] as const

const CURRIED_ROOT_FACTORY = "createRootRouteWithContext"

const LAZY_CODE_FACTORY = "createLazyRoute"

const LAZY_METHOD = "lazy"

const LISTED_ROUTES = 5

/** Discovery probe: any code-route factory named, called or not. */
export const CODE_ROUTE_MENTION = /\bcreate(?:RootRoute(?:WithContext)?|Route)\b/

type CodeRoute = {
  readonly key: string
  readonly file: string
  readonly call: ts.CallExpression
  readonly options: TsNode | null
  readonly name: string | null
  readonly root: boolean
  readonly lazySpec: string | null
  readonly ordinal: number
}

type Placement = {
  readonly base: string
  readonly chain: readonly AncestorRef[]
  readonly pathless: readonly string[]
  /** Why the route only exists in a development build, or null. Inherited by every route below it. */
  readonly devOnly: string | null
  /** The nearest conditional `beforeLoad` guard on the route or above it. Inherited by every route below it. */
  readonly guard: InheritedGuard | null
}

/** One `parent.addChildren([…, child, …])` site naming `child`. */
type Registration = {
  readonly parentKey: string
  readonly devOnly: boolean
}

type RegistrationSite = Registration & {
  readonly childKey: string
  readonly file: string
}

export type CodeRouteOptions = {
  readonly pathless: PathlessRoles
}

const ADD_CHILDREN = "addChildren"

const ADD_CHILDREN_CALL = /\.addChildren\s*\(/

const ARRAY_MUTATORS = ["push", "unshift"] as const

const ancestorKey = (ref: AncestorRef): string => `${ref.file}|${ref.exportName}|${ref.role}|${ref.splice.kind}`

const routeKey = (file: string, name: string): string => `${file}#${name}`

const joinCodeUrl = (base: string, own: string): string => normalizeUrl(`${base}/${own}`)

const isIndexPath = (path: string): boolean => path.split("/").every((segment) => segment === "")

/** `/a` covers `/a` and `/a/b`, never `/ab`; the root covers every URL. */
const coversUrl = (prefix: string, url: string): boolean => prefix === "/" || url === prefix || url.startsWith(`${prefix}/`)

export const discoverCodeRoutes = (
  ctx: DiscoverContext,
  reader: RouteOptionsReader,
  options: CodeRouteOptions,
): readonly ScreenDraft[] => {
  const stringValue = createStringValueReader(ctx)
  const buildMode = createBuildModeReader(ctx.ts)
  const routes = new Map<string, CodeRoute>()

  const sourceFiles = (): readonly string[] => ctx.glob(SCRIPT_GLOB).filter((file) => !ctx.isGenerated(file))

  const isWrapper = (node: TsNode): boolean =>
    node.kind === ctx.ts.SyntaxKind.ParenthesizedExpression ||
    node.kind === ctx.ts.SyntaxKind.AsExpression ||
    node.kind === ctx.ts.SyntaxKind.SatisfiesExpression ||
    node.kind === ctx.ts.SyntaxKind.NonNullExpression

  /** `const x = createRoute({…}).lazy(() => import('./x.lazy').then((d) => d.Route))` — name and lazy module. */
  const declarationOf = (call: ts.CallExpression): { name: string | null; lazySpec: string | null } => {
    let node: TsNode = call
    let lazySpec: string | null = null

    for (;;) {
      const parent = node.parent
      if (isWrapper(parent)) {
        node = parent
        continue
      }
      const access = ctx.ast.asPropertyAccess(parent)
      const chained = access === null ? null : ctx.ast.asCallExpression(access.parent)
      if (access === null || chained === null || chained.expression !== access) break
      if (access.name.text === LAZY_METHOD && chained.arguments[0] !== undefined)
        lazySpec = reader.dynamicImportSpec(chained.arguments[0])
      node = chained
    }

    const declaration = node.parent
    const named =
      declaration.kind === ctx.ts.SyntaxKind.VariableDeclaration
        ? ctx.ast.asIdentifier((declaration as ts.VariableDeclaration).name)?.text ?? null
        : null
    return { name: named, lazySpec }
  }

  const factoryCallsIn = (source: ts.SourceFile, file: string) => {
    const found: { call: ts.CallExpression; options: TsNode | null; root: boolean }[] = []
    walk(source, (node) => {
      const call = ctx.ast.asCallExpression(node)
      if (call === null) return
      const name = reader.calleeName(call, file)
      if (name === CODE_ROUTE_FACTORY || name === "createRootRoute") {
        found.push({ call, options: call.arguments[0] ?? null, root: name !== CODE_ROUTE_FACTORY })
        return
      }
      const inner = ctx.ast.asCallExpression(call.expression)
      if (inner !== null && reader.calleeName(inner, file) === CURRIED_ROOT_FACTORY)
        found.push({ call, options: call.arguments[0] ?? null, root: true })
    })
    return found
  }

  for (const file of sourceFiles()) {
    const text = ctx.readFile(file)
    if (text === null || !CODE_ROUTE_MENTION.test(text)) continue
    const source = ctx.sourceFile(file)
    if (source === null) continue

    let ordinal = 0
    for (const found of factoryCallsIn(source, file)) {
      const declared = declarationOf(found.call)
      const key = routeKey(file, declared.name ?? `@${String(found.call.pos)}`)
      routes.set(key, {
        key,
        file,
        call: found.call,
        options: found.options,
        name: declared.name,
        root: found.root,
        lazySpec: declared.lazySpec,
        ordinal: found.root ? -1 : ordinal,
      })
      if (!found.root) ordinal += 1
    }
  }

  const lazyOptionsOf = (route: CodeRoute): { file: string; options: TsNode | null } | null => {
    if (route.lazySpec === null) return null
    const lazyFile = ctx.resolveModule(route.file, route.lazySpec)
    const source = lazyFile === null ? null : ctx.sourceFile(lazyFile)
    if (lazyFile === null || source === null) return null

    let options: TsNode | null = null
    walk(source, (node) => {
      const call = ctx.ast.asCallExpression(node)
      const inner = call === null ? null : ctx.ast.asCallExpression(call.expression)
      if (options !== null || call === null || inner === null) return
      if (reader.calleeName(inner, lazyFile) === LAZY_CODE_FACTORY) options = call.arguments[0] ?? null
    })
    return { file: lazyFile, options }
  }

  const componentOf = (route: CodeRoute): ComponentRef => {
    const own = reader.componentOf(route.options, route.file)
    if (own.kind !== "none") return own
    const lazy = lazyOptionsOf(route)
    return lazy === null ? own : reader.componentOf(lazy.options, lazy.file)
  }

  const linksOf = (route: CodeRoute): readonly AncestorRef[] => {
    const component = componentOf(route)
    if (component.kind === "none") return [reader.transparentAt(route.file, route.name ?? "")]
    const scope = reader.scopeOf(component, route.name ?? "")
    return scope === null ? [] : reader.outletAncestors(scope)
  }

  const returnedExpression = (node: TsNode): TsNode | null => {
    const fn = ctx.unwrap(node)
    let body: TsNode | null = null
    fn.forEachChild((child) => {
      body = child
    })
    if (body === null) return null
    const block = body as TsNode
    if (block.kind !== ctx.ts.SyntaxKind.Block) return ctx.unwrap(block)

    let returned: TsNode | null = null
    block.forEachChild((statement) => {
      if (statement.kind !== ctx.ts.SyntaxKind.ReturnStatement) return
      const expression = (statement as ts.ReturnStatement).expression
      if (expression !== undefined) returned = ctx.unwrap(expression)
    })
    return returned
  }

  /** The route declaration a name in `file` refers to — local, or followed through its import. */
  const routeKeyNamed = (file: string, name: string): string | null => {
    const imported = importedBindingOf(ctx.bindingsFor(file).get(name))
    if (imported === null) return routeKey(file, name)
    const declaring = ctx.resolveModule(file, imported.module)
    if (declaring === null) return null
    const declared = ctx.declaredExport(declaring, imported.imported)
    return routeKey(declared.file, declared.exportName)
  }

  const declaredParentKeyOf = (route: CodeRoute): string | null => {
    const member = reader.memberNamed(route.options, "getParentRoute")
    const returned = member === null ? null : returnedExpression(member.value)
    const identifier = ctx.ast.asIdentifier(returned ?? undefined)
    return identifier === null ? null : routeKeyNamed(route.file, identifier.text)
  }

  // -------------------------------------------------------------------------
  // `parent.addChildren([...])` — the registry the router actually mounts
  // -------------------------------------------------------------------------

  const addChildrenReceiver = (node: TsNode): TsNode | null => {
    const call = ctx.ast.asCallExpression(node)
    const access = call === null ? null : ctx.ast.asPropertyAccess(call.expression)
    return access === null || access.name.text !== ADD_CHILDREN ? null : access.expression
  }

  /** `layoutRoute` and `layoutRoute.addChildren([...])` both name the route `layoutRoute`. */
  const routeKeyOfExpression = (node: TsNode, file: string): string | null => {
    const receiver = addChildrenReceiver(ctx.unwrap(node))
    if (receiver !== null) return routeKeyOfExpression(receiver, file)
    const identifier = ctx.ast.asIdentifier(node)
    const key = identifier === null ? null : routeKeyNamed(file, identifier.text)
    return key !== null && routes.has(key) ? key : null
  }

  type Child = { readonly key: string; readonly devOnly: boolean }

  const mutationArguments = (source: ts.SourceFile, name: string): readonly TsNode[] => {
    const found: TsNode[] = []
    walk(source, (node) => {
      const call = ctx.ast.asCallExpression(node)
      const access = call === null ? null : ctx.ast.asPropertyAccess(call.expression)
      if (call === null || access === null || ctx.ast.asIdentifier(access.expression)?.text !== name) return
      if ((ARRAY_MUTATORS as readonly string[]).includes(access.name.text)) found.push(...call.arguments)
    })
    return found
  }

  /** `const children = [a, b]; if (DEV) children.push(dev)` — the array a name holds, plus what is pushed onto it. */
  const childrenOfArrayName = (name: string, file: string, gated: boolean, seen: Set<TsNode>): readonly Child[] => {
    const imported = importedBindingOf(ctx.bindingsFor(file).get(name))
    const declaring = imported === null ? file : ctx.resolveModule(file, imported.module)
    const declared = declaring === null ? null : ctx.declaredExport(declaring, imported?.imported ?? name)
    const source = declared === null ? null : ctx.sourceFile(declared.file)
    if (declared === null || source === null) return []
    const { file: declaringFile, exportName } = declared

    const declaration = ctx.ast.declarationOf(source, exportName)
    const initializer =
      declaration !== null && ctx.ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined
    return [initializer, ...mutationArguments(source, exportName)].flatMap((node) =>
      childrenIn(node, declaringFile, gated, seen),
    )
  }

  const objectValues = (object: ts.ObjectLiteralExpression): readonly TsNode[] =>
    object.properties.flatMap((property): readonly TsNode[] => {
      if (ctx.ts.isShorthandPropertyAssignment(property)) return [property.name]
      if (ctx.ts.isPropertyAssignment(property)) return [property.initializer]
      return ctx.ts.isSpreadAssignment(property) ? [property.expression] : []
    })

  const branchesOf = (value: TsNode): readonly TsNode[] => {
    if (ctx.ts.isConditionalExpression(value)) return [value.whenTrue, value.whenFalse]
    if (ctx.ts.isSpreadElement(value)) return [value.expression]
    if (!ctx.ts.isBinaryExpression(value)) return []
    const operator = value.operatorToken.kind
    if (operator === ctx.ts.SyntaxKind.AmpersandAmpersandToken) return [value.right]
    const alternative = operator === ctx.ts.SyntaxKind.BarBarToken || operator === ctx.ts.SyntaxKind.QuestionQuestionToken
    return alternative ? [value.left, value.right] : []
  }

  /**
   * The routes an `addChildren` argument names. Each child carries whether it is reached only under a
   * development-build condition — at its own site (`DEV ? [dev] : []`, `if (DEV) xs.push(dev)`) or at
   * the site that referenced the array holding it (`...(DEV ? devRoutes : [])`).
   */
  const childrenIn = (node: TsNode | undefined, file: string, gated: boolean, seen: Set<TsNode>): readonly Child[] => {
    if (node === undefined || seen.has(node)) return []
    seen.add(node)

    const value = ctx.unwrap(node)
    const here = gated || buildMode.isDevGated(node)
    const array = ctx.ast.asArrayLiteral(value)
    if (array !== null) return array.elements.flatMap((element) => childrenIn(element, file, gated, seen))
    const object = ctx.ast.asObjectLiteral(value)
    if (object !== null) return objectValues(object).flatMap((element) => childrenIn(element, file, gated, seen))

    const branches = branchesOf(value)
    if (branches.length > 0) return branches.flatMap((branch) => childrenIn(branch, file, gated, seen))

    const key = routeKeyOfExpression(value, file)
    if (key !== null) return [{ key, devOnly: here }]
    const identifier = ctx.ast.asIdentifier(value)
    return identifier === null ? [] : childrenOfArrayName(identifier.text, file, here, seen)
  }

  const collectRegistrationSites = (): readonly RegistrationSite[] => {
    const sites: RegistrationSite[] = []
    for (const file of sourceFiles()) {
      const text = ctx.readFile(file)
      const source = text === null || !ADD_CHILDREN_CALL.test(text) ? null : ctx.sourceFile(file)
      if (source === null) continue

      walk(source, (node) => {
        const receiver = addChildrenReceiver(node)
        const parentKey = receiver === null ? null : routeKeyOfExpression(receiver, file)
        const call = ctx.ast.asCallExpression(node)
        if (parentKey === null || call === null) return
        for (const child of childrenIn(call.arguments[0], file, false, new Set()))
          sites.push({ parentKey, devOnly: child.devOnly, childKey: child.key, file })
      })
    }
    return sites
  }

  const isNonAppRoute = (key: string): boolean => {
    const route = routes.get(key)
    return route !== undefined && isNonAppFile(route.file)
  }

  /**
   * Test, mock and harness directories may not contribute router roots, nor mount routes into the
   * app's tree. A route declared there still belongs to the app when the app's own tree mounts it:
   * an `addChildren` in an app file, or one inside an already admitted non-app subtree.
   */
  const mountsInto = (admitted: ReadonlySet<string>, site: RegistrationSite): boolean =>
    admitted.has(site.parentKey) && (!isNonAppFile(site.file) || isNonAppRoute(site.parentKey))

  const admittedKeys = (sites: readonly RegistrationSite[]): ReadonlySet<string> => {
    const admitted = new Set([...routes.keys()].filter((key) => !isNonAppRoute(key)))
    const admits = (site: RegistrationSite): boolean => !admitted.has(site.childKey) && mountsInto(admitted, site)
    for (let next = sites.find(admits); next !== undefined; next = sites.find(admits)) admitted.add(next.childKey)
    return admitted
  }

  const groupByChild = (sites: readonly RegistrationSite[]): ReadonlyMap<string, readonly Registration[]> => {
    const byChild = new Map<string, Registration[]>()
    for (const { childKey, parentKey, devOnly } of sites) byChild.set(childKey, [...(byChild.get(childKey) ?? []), { parentKey, devOnly }])
    return byChild
  }

  const registrationSites = collectRegistrationSites()
  const admitted = admittedKeys(registrationSites)
  const registrations = groupByChild(
    registrationSites.filter((site) => admitted.has(site.childKey) && mountsInto(admitted, site)),
  )
  const dropped = new Map([...routes].filter(([key]) => !admitted.has(key)))
  for (const key of dropped.keys()) routes.delete(key)

  const isRootedInDropped = (route: CodeRoute, seen: ReadonlySet<string> = new Set()): boolean => {
    if (route.root) return true
    const parentKey = declaredParentKeyOf(route)
    const parent = parentKey === null || seen.has(parentKey) ? undefined : dropped.get(parentKey)
    return parent !== undefined && isRootedInDropped(parent, new Set([...seen, route.key]))
  }

  const unmounted = [...dropped.values()]
    .filter((route) => !isRootedInDropped(route))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  const nonRoot = [...routes.values()].filter((route) => !route.root)
  if (nonRoot.length === 0) return []

  const registeredParentsOf = (route: CodeRoute): readonly string[] =>
    sortedUnique((registrations.get(route.key) ?? []).map((registration) => registration.parentKey))

  /**
   * `getParentRoute` is authoritative when it names a readable route; `addChildren` is the fallback
   * when it is missing or unreadable and exactly one parent registers the route.
   */
  const parentKeyOf = (route: CodeRoute): string | null => {
    const declared = declaredParentKeyOf(route)
    if (declared !== null && routes.has(declared)) return declared
    const registered = registeredParentsOf(route)
    return registered.length === 1 ? (registered[0] ?? null) : null
  }

  const describe = (route: CodeRoute): string => route.name ?? `createRoute at line ${String(ctx.lineOf(route.file, route.call))}`

  const describeKey = (key: string): string => {
    const route = routes.get(key)
    return route === undefined ? key : describe(route)
  }

  /** Non-app routes no app `addChildren` mounts are dropped; a harness whose whole tree is non-app is test scaffolding and stays silent. */
  const reportUnmounted = (): void => {
    const [first] = unmounted
    if (first === undefined) return
    const listed = unmounted.slice(0, LISTED_ROUTES).map((route) => `'${describe(route)} (${route.file})'`).join(", ")
    const more = unmounted.length > LISTED_ROUTES ? ` and ${String(unmounted.length - LISTED_ROUTES)} more` : ""
    ctx.diagnostic({
      severity: "info",
      code: "screens/unmounted-route",
      message: `${String(unmounted.length)} TanStack code route(s) declared in test or mock files are mounted by no app addChildren and are not read: ${listed}${more}`,
      file: first.file,
      line: ctx.lineOf(first.file, first.call),
    })
  }

  /** The `addChildren` parents that disagree with a readable `getParentRoute`, or null when they agree. */
  const registryDisagreement = (route: CodeRoute): { declared: string; registered: readonly string[] } | null => {
    const declared = declaredParentKeyOf(route)
    const registered = registeredParentsOf(route)
    if (declared === null || !routes.has(declared) || registered.length === 0 || registered.includes(declared)) return null
    return { declared, registered }
  }

  /**
   * TanStack builds a route's URL and its render branch from `getParentRoute`; `addChildren` only
   * mounts it into the matching tree, whose segments the route's full path must continue. A
   * registering parent whose URL covers the route's own therefore changes nothing at runtime.
   */
  const registeredUnderCoveringUrl = (route: CodeRoute, registered: readonly string[]): boolean => {
    const own = place(route)
    if (own === null) return false
    return registered.every((key) => {
      const parent = routes.get(key)
      const placed = parent === undefined ? null : place(parent)
      return placed !== null && coversUrl(placed.base, own.base)
    })
  }

  const reportParentMismatch = (route: CodeRoute): void => {
    const disagreement = registryDisagreement(route)
    if (disagreement === null || registeredUnderCoveringUrl(route, disagreement.registered)) return
    const { declared, registered } = disagreement
    ctx.diagnostic({
      severity: "warning",
      code: "screens/route-parent-mismatch",
      message: `TanStack code route '${describe(route)}': getParentRoute names '${describeKey(declared)}' but addChildren registers it under ${registered.map((key) => `'${describeKey(key)}'`).join(", ")}; getParentRoute wins`,
      file: route.file,
      line: ctx.lineOf(route.file, route.call),
    })
  }

  const blocksProduction = (route: CodeRoute): boolean => {
    const beforeLoad = reader.memberNamed(route.options, "beforeLoad")
    return beforeLoad !== null && buildMode.blocksProduction(beforeLoad.value)
  }

  const ownDevOnly = (route: CodeRoute): string | null => {
    if (buildMode.isDevGated(route.call)) return DEV_ONLY_EVIDENCE.declared
    if (blocksProduction(route)) return DEV_ONLY_EVIDENCE.blocked
    const registered = registrations.get(route.key) ?? []
    return registered.length > 0 && registered.every((registration) => registration.devOnly)
      ? DEV_ONLY_EVIDENCE.registered
      : null
  }

  const unreadable = (route: CodeRoute, why: string): null => {
    ctx.diagnostic({
      severity: "warning",
      code: "screens/dynamic-registry",
      message: `TanStack code route '${describe(route)}': ${why}; it and every route below it are skipped`,
      file: route.file,
      line: ctx.lineOf(route.file, route.call),
    })
    return null
  }

  const pathOf = (route: CodeRoute): { path: string | null; readable: boolean } => {
    const member = reader.memberNamed(route.options, "path")
    if (member === null) return { path: null, readable: true }
    const path = stringValue(member.value, route.file)
    return { path, readable: path !== null }
  }

  const idOf = (route: CodeRoute): string | null => {
    const member = reader.memberNamed(route.options, "id")
    return member === null ? null : stringValue(member.value, route.file)
  }

  const beforeLoadGuardOf = (route: CodeRoute) => reader.beforeLoadGuardOf(route.options, route.file)

  const placements = new Map<string, Placement | null>()
  const placing = new Set<string>()

  const place = (route: CodeRoute): Placement | null => {
    if (placements.has(route.key)) return placements.get(route.key) ?? null
    if (placing.has(route.key)) return unreadable(route, "getParentRoute forms a cycle")
    placing.add(route.key)
    const placed = computePlacement(route)
    placing.delete(route.key)
    placements.set(route.key, placed)
    return placed
  }

  const computePlacement = (route: CodeRoute): Placement | null => {
    if (route.root) return { base: "/", chain: linksOf(route), pathless: [], devOnly: null, guard: null }

    const parentKey = parentKeyOf(route)
    const parent = parentKey === null ? null : (routes.get(parentKey) ?? null)
    if (parent === null)
      return unreadable(
        route,
        "neither getParentRoute nor a single parent's addChildren names a route declaration this source can read",
      )

    const placedParent = place(parent)
    if (placedParent === null) return null

    const { path, readable } = pathOf(route)
    if (!readable) return unreadable(route, "its `path` is not a readable string")

    const chain = uniqueBy([...placedParent.chain, ...linksOf(route)], ancestorKey)
    const devOnly = ownDevOnly(route) ?? (placedParent.devOnly === null ? null : devOnlyNestedEvidence(describe(parent)))
    const guard = ownGuard(beforeLoadGuardOf(route)) ?? passedGuard(placedParent.guard, describe(parent))
    if (path === null)
      return { base: placedParent.base, chain, pathless: [...placedParent.pathless, idOf(route) ?? ""], devOnly, guard }
    return {
      base: joinCodeUrl(placedParent.base, convertTanStackCodePath(path).url),
      chain,
      pathless: placedParent.pathless,
      devOnly,
      guard,
    }
  }

  const indexChildOwners = new Set(
    nonRoot.flatMap((route) => {
      const { path } = pathOf(route)
      const parentKey = parentKeyOf(route)
      return path !== null && isIndexPath(path) && parentKey !== null ? [parentKey] : []
    }),
  )

  const draftOf = (route: CodeRoute): ScreenDraft | null => {
    const placed = place(route)
    const parentKey = parentKeyOf(route)
    const parent = parentKey === null ? null : (routes.get(parentKey) ?? null)
    const parentPlacement = parent === null ? null : place(parent)
    if (placed === null || parentPlacement === null) return null

    const { path } = pathOf(route)
    const id = idOf(route)
    const pathless = path === null
    const layout = pathless || (!isIndexPath(path) && indexChildOwners.has(route.key))
    const url = pathless ? null : placed.base
    const component = componentOf(route)
    const entry = reader.entryOf(component)
    const layerAuth = authOfLayers(options.pathless, placed.pathless)
    const auth = guardedAuth(layerAuth, placed.guard)
    const redirectTo = redirectOfGuard(beforeLoadGuardOf(route))
    const parentFromRegistry = declaredParentKeyOf(route) !== parentKey

    const evidence: Evidence[] = [
      ctx.evidence(
        pathless
          ? `tanstack code route createRoute({ id: '${id ?? "?"}' }) (pathless layout)`
          : `tanstack code route createRoute({ path: '${path}' })`,
        route.file,
        route.call,
      ),
    ]
    if (route.lazySpec !== null)
      evidence.push(ctx.evidence(`lazy route module '${route.lazySpec}'`, route.file, route.call))
    if (component.kind === "none")
      evidence.push(ctx.evidence("no component: renders an implicit <Outlet/>", route.file, route.call))
    if (layout && !pathless)
      evidence.push(ctx.evidence(`layout route: has an index child, which owns '${url ?? ""}'`, route.file, route.call))
    if (parentFromRegistry && parent !== null)
      evidence.push(
        ctx.evidence(
          `parent '${describe(parent)}' from addChildren (getParentRoute is missing or unreadable)`,
          route.file,
          route.call,
        ),
      )
    const disagreement = registryDisagreement(route)
    if (disagreement !== null && registeredUnderCoveringUrl(route, disagreement.registered))
      evidence.push(
        ctx.evidence(
          `addChildren also registers it under ${disagreement.registered.map((key) => `'${describeKey(key)}'`).join(", ")}, whose URL covers its own; getParentRoute decides its URL and nesting`,
          route.file,
          route.call,
        ),
      )
    if (placed.devOnly !== null) evidence.push(ctx.evidence(placed.devOnly, route.file, route.call))
    evidence.push(...reader.optionEvidence(route.options, route.file, route.call))
    evidence.push(...guardAuthTexts(layerAuth, placed.guard).map((text) => ctx.evidence(text, route.file, route.call)))
    reader.reportSearchParams(route.options, route.file, describe(route), route.call)

    return {
      localId: ctx.localId(route.file, { ordinal: route.ordinal, node: route.call }),
      activations:
        layout || url === null ? [] : [{ kind: "url", template: url, params: [...paramsOf(url)] }],
      entries: entry === null ? [] : [entry],
      ancestors: parentPlacement.chain,
      evidence,
      ...(layout ? { kindTag: "layout" } : {}),
      ...(auth === null ? {} : { auth }),
      ...(redirectTo === null ? {} : { redirectTo }),
      ...(placed.devOnly === null ? {} : { devOnly: true }),
    }
  }

  reportUnmounted()

  return nonRoot.flatMap((route) => {
    reportParentMismatch(route)
    const draft = draftOf(route)
    return draft === null ? [] : [draft]
  })
}
