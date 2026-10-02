import * as path from "node:path"
import type ts from "typescript"
import type { DiagnosticInput } from "../core/diagnostics.js"
import { by, thenBy, uniqueBy } from "../core/order.js"
import { type ArrayElement, type ArrayFold, type UnreadableItem, createArrayFolder, createValueResolver } from "./array-values.js"
import { createConfigFileReader } from "./config-file.js"
import { UNREADABLE_SITE_LIMIT } from "./next-config.js"
import type { DiscoverContext, TsNode } from "./types.js"
import { createStringValueReader, importedBindingOf } from "./values.js"

/**
 * Reads a React Router framework `routes.ts` (and Remix v2 through `remixRoutesOptionAdapter`) into a
 * route tree without evaluating it. File-system conventions are delegated to the injected
 * `readFlatRoutes`; every element it cannot read is counted in one warning per routes file.
 */

export type DeclaredAt = {
  readonly file: string
  readonly line: number
}

export type RouteNode = {
  /** Project-relative route module. */
  readonly file: string
  readonly path: string | null
  readonly index: boolean
  readonly id: string | null
  readonly children: readonly RouteNode[]
  readonly declaredAt: DeclaredAt
  readonly evidence: readonly string[]
}

export type FlatRoutesConvention = "react-router" | "remix-flat-routes"

export type FlatRoutesRequest = {
  readonly convention: FlatRoutesConvention
  /** `rootDirectory` (fs-routes) or `routeDir` (remix-flat-routes), relative to `appDirectory`. */
  readonly rootDirectory: string
  readonly ignoredRouteFiles: readonly string[]
  readonly basePath?: string
  readonly appDirectory: string
  /** The literal options object, for unsupported-option checks; `null` when the call passes none. */
  readonly options: ts.ObjectLiteralExpression | null
  readonly declaredAt: DeclaredAt
}

export type ReadFlatRoutes = (request: FlatRoutesRequest) => readonly RouteNode[]

export type RouteConfigOptions = {
  /** Project-relative `<appDirectory>/routes.{ts,tsx,js,mjs}`. */
  readonly file: string
  readonly appDirectory: string
  readonly readFlatRoutes: ReadFlatRoutes
}

export const ROUTE_CONFIG_MODULES = {
  routes: "@react-router/dev/routes",
  fsRoutes: "@react-router/fs-routes",
  adapter: "@react-router/remix-routes-option-adapter",
  remixFlatRoutes: "remix-flat-routes",
} as const

const HELPERS = ["route", "index", "layout", "prefix"] as const

type Helper = (typeof HELPERS)[number]

const RELATIVE_HELPERS: ReadonlySet<string> = new Set(["route", "index", "layout"] as const)

const NAMES = {
  relative: "relative",
  flatRoutes: "flatRoutes",
  adapter: "remixRoutesOptionAdapter",
  concat: "concat",
  namespace: "*",
  dirname: "dirname",
  legacyDirname: "__dirname",
} as const

const PATH_JOINERS: ReadonlySet<string> = new Set(["join", "resolve"] as const)

const DEFAULT_ROOT_DIRECTORY = "routes"

const OPTION_KEYS = {
  id: "id",
  file: "file",
  path: "path",
  index: "index",
  children: "children",
  rootDirectory: "rootDirectory",
  ignoredRouteFiles: "ignoredRouteFiles",
  basePath: "basePath",
} as const

type RouteRead = {
  readonly routes: readonly RouteNode[]
  readonly unreadable: readonly UnreadableItem[]
  readonly notices: readonly DiagnosticInput[]
}

type Callee =
  | { readonly kind: "helper"; readonly helper: Helper; readonly base: string | null; readonly evidence: readonly string[] }
  | { readonly kind: "flatRoutes" }
  | { readonly kind: "adapter" }
  | { readonly kind: "concat"; readonly receiver: TsNode }
  | { readonly kind: "unknown"; readonly name: string }

type PathRead = { readonly value: string | null } | null

const EMPTY_READ: RouteRead = { routes: [], unreadable: [], notices: [] }

const combineReads = (reads: readonly RouteRead[]): RouteRead => ({
  routes: reads.flatMap((read) => read.routes),
  unreadable: reads.flatMap((read) => read.unreadable),
  notices: reads.flatMap((read) => read.notices),
})

const isHelper = (name: string): name is Helper => HELPERS.some((helper) => helper === name)

const joinRoutePaths = (prefix: string, child: string): string =>
  [prefix.replace(/\/+$/, ""), child.replace(/^\/+/, "")].join("/")

/** React Router's `prefix()`: a routed or index entry takes the prefix on its own path; a pathless layout passes it down. */
const prefixed = (prefix: string, route: RouteNode): RouteNode => {
  const evidence = [...route.evidence, `prefix("${prefix}")`]
  if (route.path !== null || route.index)
    return { ...route, path: route.path === null || route.path === "" ? prefix : joinRoutePaths(prefix, route.path), evidence }
  return { ...route, children: route.children.map((child) => prefixed(prefix, child)) }
}

const withEvidence = (route: RouteNode, text: string): RouteNode => ({
  ...route,
  evidence: [...route.evidence, text],
  children: route.children.map((child) => withEvidence(child, text)),
})

const unionKey = (route: RouteNode): string => `${route.file}\0${route.path ?? ""}\0${String(route.index)}`

/** Siblings sharing `(file, path)` under one parent collapse into the first; their children merge by the same rule. */
const mergeUnion = (routes: readonly RouteNode[]): readonly RouteNode[] =>
  routes.reduce<readonly RouteNode[]>((merged, route) => {
    const at = merged.findIndex((other) => unionKey(other) === unionKey(route))
    if (at === -1) return [...merged, route]
    return merged.map((other, index) =>
      index === at ? { ...other, children: mergeUnion([...other.children, ...route.children]) } : other,
    )
  }, [])

const conditionEvidence = (conditions: readonly string[]): readonly string[] =>
  conditions.length === 0 ? [] : [`only when ${conditions.join(" && ")}`]

const siteOrder = thenBy<UnreadableItem>(
  by((item) => item.file),
  (a, b) => a.line - b.line,
)

const unreadableMessage = (file: string, items: readonly UnreadableItem[]): string => {
  const sites = [...items].sort(siteOrder).map((item) => `${item.file}:${String(item.line)}`)
  const listed = sites.slice(0, UNREADABLE_SITE_LIMIT).join(", ")
  const rest = sites.length - UNREADABLE_SITE_LIMIT
  const more = rest > 0 ? ` and ${String(rest)} more` : ""
  return `${String(items.length)} route entr${items.length === 1 ? "y" : "ies"} in ${file} could not be read statically and are not mapped as screens: ${listed}${more}.`
}

const createReader = (ctx: DiscoverContext, options: RouteConfigOptions) => {
  const resolver = createValueResolver(ctx)
  const readString = createStringValueReader(ctx)
  const { exportedOf, memberNamed, literalField, literalStringArray } = createConfigFileReader(ctx, resolver)
  const expansions = new Map<ts.CallExpression, RouteRead | null>()

  const unreadable = (node: TsNode, file: string): RouteRead => ({
    ...EMPTY_READ,
    unreadable: [resolver.unreadableAt(node, file)],
  })

  const declaredAt = (file: string, node: TsNode): DeclaredAt => ({ file, line: ctx.lineOf(file, node) })

  const withoutAwait = (node: TsNode): TsNode => {
    const inner = ctx.unwrap(node)
    return ctx.ts.isAwaitExpression(inner) ? ctx.unwrap(inner.expression) : inner
  }

  const resolveLocated = (node: TsNode, file: string, trail: readonly TsNode[] = []): { node: TsNode; file: string } => {
    const inner = withoutAwait(node)
    const identifier = ctx.ast.asIdentifier(inner)
    const bound = identifier === null || trail.includes(inner) ? null : resolver.valueOf(identifier, file)
    return bound === null ? { node: inner, file } : resolveLocated(bound.node, bound.file, [...trail, inner])
  }

  const objectOf = (node: TsNode | undefined, file: string): ts.ObjectLiteralExpression | null =>
    node === undefined ? null : ctx.ast.asObjectLiteral(resolveLocated(node, file).node)

  const importOf = (name: string, file: string) => importedBindingOf(ctx.bindingsFor(file).get(name))

  const isImported = (name: string, file: string, module: string, imported: string): boolean => {
    const binding = importOf(name, file)
    return binding !== null && binding.module === module && binding.imported === imported
  }

  const isDirnameExpression = (node: TsNode): boolean => {
    if (ctx.ast.asIdentifier(node)?.text === NAMES.legacyDirname) return true
    const access = ctx.ast.asPropertyAccess(node)
    return access !== null && ctx.ts.isMetaProperty(access.expression) && access.name.text === NAMES.dirname
  }

  const calleeName = (node: TsNode): string | null =>
    ctx.ast.asIdentifier(node)?.text ?? ctx.ast.asPropertyAccess(node)?.name.text ?? null

  /** `import.meta.dirname`, `__dirname` and `path.join|resolve(<dirname>, "literal", ...)`; anything else is unreadable. */
  const directoryOf = (node: TsNode | undefined, file: string): string | null => {
    if (node === undefined) return null
    const inner = ctx.unwrap(node)
    if (isDirnameExpression(inner)) return path.posix.dirname(file)
    const call = ctx.ast.asCallExpression(inner)
    const name = call === null ? null : calleeName(call.expression)
    if (call === null || name === null || !PATH_JOINERS.has(name)) return null
    const [first, ...rest] = call.arguments
    if (first === undefined || !isDirnameExpression(ctx.unwrap(first))) return null
    const parts = rest.map((part) => ctx.ast.asStringLiteralLike(part)?.text ?? null)
    if (parts.some((part) => part === null || part.startsWith("/"))) return null
    return path.posix.join(path.posix.dirname(file), ...parts.filter((part) => part !== null))
  }

  const relativeCallOf = (node: TsNode, file: string): ts.CallExpression | null => {
    const call = ctx.ast.asCallExpression(ctx.unwrap(node))
    const callee = call === null ? null : ctx.ast.asIdentifier(call.expression)
    if (call === null || callee === null) return null
    return isImported(callee.text, file, ROUTE_CONFIG_MODULES.routes, NAMES.relative) ? call : null
  }

  const relativeHelper = (helper: string, call: ts.CallExpression, file: string): Callee | null => {
    if (!RELATIVE_HELPERS.has(helper) || !isHelper(helper)) return null
    const base = directoryOf(call.arguments[0], file)
    return { kind: "helper", helper, base, evidence: base === null ? [] : [`relative("${base}")`] }
  }

  const bindingElementNamed = (file: string, name: string): ts.BindingElement | null => {
    const source = ctx.sourceFile(file)
    let found: ts.BindingElement | null = null
    const visit = (node: TsNode): void => {
      if (found !== null) return
      if (ctx.ts.isBindingElement(node) && ctx.ast.asIdentifier(node.name)?.text === name) found = node
      node.forEachChild(visit)
    }
    if (source !== null) visit(source)
    return found
  }

  /** `const { route } = relative(import.meta.dirname)` and `const { route: r } = relative(...)`. */
  const destructuredHelper = (identifier: ts.Identifier, file: string): Callee | null => {
    const element = bindingElementNamed(file, identifier.text)
    const declaration = element?.parent.parent
    if (element === null || declaration === undefined || !ctx.ts.isVariableDeclaration(declaration)) return null
    const call = declaration.initializer === undefined ? null : relativeCallOf(declaration.initializer, file)
    const helper = element.propertyName === undefined ? identifier.text : calleeName(element.propertyName)
    return call === null || helper === null ? null : relativeHelper(helper, call, file)
  }

  const identifierCallee = (identifier: ts.Identifier, file: string): Callee => {
    const binding = importOf(identifier.text, file)
    if (binding?.module === ROUTE_CONFIG_MODULES.routes && isHelper(binding.imported))
      return { kind: "helper", helper: binding.imported, base: options.appDirectory, evidence: [] }
    if (isImported(identifier.text, file, ROUTE_CONFIG_MODULES.fsRoutes, NAMES.flatRoutes)) return { kind: "flatRoutes" }
    if (isImported(identifier.text, file, ROUTE_CONFIG_MODULES.adapter, NAMES.adapter)) return { kind: "adapter" }
    if (binding !== null) return { kind: "unknown", name: identifier.text }
    return destructuredHelper(identifier, file) ?? { kind: "unknown", name: identifier.text }
  }

  const memberCallee = (access: ts.PropertyAccessExpression, file: string): Callee => {
    const helper = access.name.text
    if (helper === NAMES.concat) return { kind: "concat", receiver: access.expression }
    const receiver = ctx.ast.asIdentifier(access.expression)
    const unknown: Callee = { kind: "unknown", name: ctx.ast.conditionText(access) }
    if (receiver === null) return unknown
    if (isImported(receiver.text, file, ROUTE_CONFIG_MODULES.routes, NAMES.namespace) && isHelper(helper))
      return { kind: "helper", helper, base: options.appDirectory, evidence: [] }
    const bound = resolver.valueOf(receiver, file)
    const call = bound === null ? null : relativeCallOf(bound.node, bound.file)
    return (call === null || bound === null ? null : relativeHelper(helper, call, bound.file)) ?? unknown
  }

  const calleeOf = (call: ts.CallExpression, file: string): Callee => {
    const identifier = ctx.ast.asIdentifier(call.expression)
    if (identifier !== null) return identifierCallee(identifier, file)
    const access = ctx.ast.asPropertyAccess(call.expression)
    return access === null ? { kind: "unknown", name: ctx.ast.conditionText(call.expression) } : memberCallee(access, file)
  }

  const claim = (call: ts.CallExpression, file: string): ArrayFold => ({
    elements: [{ node: call, file, conditions: [] }],
    unreadable: [],
  })

  const onCall = (call: ts.CallExpression, file: string): ArrayFold | null => {
    const callee = calleeOf(call, file)
    if (callee.kind !== "unknown") return claim(call, file)
    return unionOf(call, file, callee.name) === null ? null : claim(call, file)
  }

  const folder = createArrayFolder(ctx, resolver, { onCall })

  const readList = (node: TsNode, file: string): RouteRead => {
    const fold = folder(node, file)
    return combineReads([{ ...EMPTY_READ, unreadable: fold.unreadable }, ...fold.elements.map(readElement)])
  }

  const pathOf = (node: TsNode | undefined, file: string): PathRead => {
    if (node === undefined) return { value: null }
    const inner = ctx.unwrap(node)
    if (inner.kind === ctx.ts.SyntaxKind.NullKeyword || ctx.ast.asIdentifier(inner)?.text === "undefined")
      return { value: null }
    const value = readString(inner, file)
    return value === null ? null : { value }
  }

  /** `route(path, file, opts?, children?)`, `index(file, opts?)`, `layout(file, opts?, children?)`: children may take the options slot. */
  const helperArguments = (helper: Helper, call: ts.CallExpression, file: string) => {
    const [pathArg, fileArg, slot, last] = helper === "route" ? call.arguments : [undefined, ...call.arguments]
    const options = objectOf(slot, file)
    if (helper === "index") return { pathArg, fileArg, options, children: undefined }
    return { pathArg, fileArg, options, children: options === null ? slot : last }
  }

  const readHelper = (
    call: ts.CallExpression,
    file: string,
    callee: Extract<Callee, { kind: "helper" }>,
    conditions: readonly string[],
  ): RouteRead => {
    if (callee.base === null) return unreadable(call, file)
    if (callee.helper === "prefix") return readPrefix(call, file)
    const args = helperArguments(callee.helper, call, file)
    const moduleFile = args.fileArg === undefined ? null : readString(args.fileArg, file)
    const routePath = pathOf(args.pathArg, file)
    if (moduleFile === null || routePath === null) return unreadable(call, file)
    const children = args.children === undefined ? EMPTY_READ : readList(args.children, file)
    const route: RouteNode = {
      file: path.posix.join(callee.base, moduleFile),
      path: routePath.value,
      index: callee.helper === "index",
      id: args.options === null ? null : literalField(args.options, OPTION_KEYS.id),
      children: children.routes,
      declaredAt: declaredAt(file, call),
      evidence: [...callee.evidence, ...conditionEvidence(conditions)],
    }
    return { ...children, routes: [route] }
  }

  const readPrefix = (call: ts.CallExpression, file: string): RouteRead => {
    const [prefixArg, routesArg] = call.arguments
    const prefix = prefixArg === undefined ? null : readString(prefixArg, file)
    if (prefix === null || routesArg === undefined) return unreadable(call, file)
    const children = readList(routesArg, file)
    return { ...children, routes: children.routes.map((route) => prefixed(prefix, route)) }
  }

  const readObjectEntry = (object: ts.ObjectLiteralExpression, file: string, conditions: readonly string[]): RouteRead => {
    const moduleFile = literalField(object, OPTION_KEYS.file)
    const pathMember = memberNamed(object, OPTION_KEYS.path)
    const routePath = literalField(object, OPTION_KEYS.path)
    if (moduleFile === null || (pathMember !== null && routePath === null)) return unreadable(object, file)
    const indexMember = memberNamed(object, OPTION_KEYS.index)
    const childrenMember = memberNamed(object, OPTION_KEYS.children)
    const childrenNode =
      childrenMember !== null && ctx.ts.isPropertyAssignment(childrenMember) ? childrenMember.initializer : null
    if (childrenMember !== null && childrenNode === null) return unreadable(object, file)
    const children = childrenNode === null ? EMPTY_READ : readList(childrenNode, file)
    const route: RouteNode = {
      file: path.posix.join(options.appDirectory, moduleFile),
      path: routePath,
      index:
        indexMember !== null &&
        ctx.ts.isPropertyAssignment(indexMember) &&
        indexMember.initializer.kind === ctx.ts.SyntaxKind.TrueKeyword,
      id: literalField(object, OPTION_KEYS.id),
      children: children.routes,
      declaredAt: declaredAt(file, object),
      evidence: conditionEvidence(conditions),
    }
    return { ...children, routes: [route] }
  }

  const ignoredFilesOf = (object: ts.ObjectLiteralExpression | null): readonly string[] | null => {
    if (object === null) return []
    const ignored = literalStringArray(object, OPTION_KEYS.ignoredRouteFiles)
    if (ignored.kind === "dynamic") return null
    return ignored.kind === "literal" ? ignored.values : []
  }

  /** A present member that is not a string literal reads as `null`; an absent one as `fallback`. */
  const literalOrDefault = (object: ts.ObjectLiteralExpression | null, key: string, fallback: string | null) => {
    if (object === null || memberNamed(object, key) === null) return { value: fallback }
    const value = literalField(object, key)
    return value === null ? null : { value }
  }

  const flatRead = (requests: readonly FlatRoutesRequest[]): RouteRead => ({
    ...EMPTY_READ,
    routes: requests.flatMap((request) => options.readFlatRoutes(request)),
  })

  const readFsRoutes = (call: ts.CallExpression, file: string): RouteRead => {
    const [optionsArg] = call.arguments
    const object = objectOf(optionsArg, file)
    if (optionsArg !== undefined && object === null) return unreadable(call, file)
    const rootDirectory = literalOrDefault(object, OPTION_KEYS.rootDirectory, DEFAULT_ROOT_DIRECTORY)
    const ignoredRouteFiles = ignoredFilesOf(object)
    if (rootDirectory === null || rootDirectory.value === null || ignoredRouteFiles === null) return unreadable(call, file)
    return flatRead([
      {
        convention: "react-router",
        rootDirectory: rootDirectory.value,
        ignoredRouteFiles,
        appDirectory: options.appDirectory,
        options: object,
        declaredAt: declaredAt(file, call),
      },
    ])
  }

  const routeDirsOf = (node: TsNode | undefined, file: string): readonly string[] | null => {
    if (node === undefined) return null
    const located = resolveLocated(node, file)
    const array = ctx.ast.asArrayLiteral(located.node)
    const items = array === null ? [located.node] : array.elements
    const dirs = items.map((item) => readString(item, located.file))
    return dirs.some((dir) => dir === null) ? null : dirs.filter((dir) => dir !== null)
  }

  const readRemixFlatRoutes = (call: ts.CallExpression, file: string): RouteRead => {
    const [dirArg, , optionsArg] = call.arguments
    const object = objectOf(optionsArg, file)
    const dirs = routeDirsOf(dirArg, file)
    const ignoredRouteFiles = ignoredFilesOf(object)
    const basePath = literalOrDefault(object, OPTION_KEYS.basePath, null)
    if ((optionsArg !== undefined && object === null) || dirs === null || ignoredRouteFiles === null || basePath === null)
      return unreadable(call, file)
    return flatRead(
      dirs.map((rootDirectory) => ({
        convention: "remix-flat-routes",
        rootDirectory,
        ignoredRouteFiles,
        ...(basePath.value === null ? {} : { basePath: basePath.value }),
        appDirectory: options.appDirectory,
        options: object,
        declaredAt: declaredAt(file, call),
      })),
    )
  }

  const callsTo = (body: TsNode, name: string): readonly ts.CallExpression[] => {
    const found: ts.CallExpression[] = []
    const visit = (node: TsNode): void => {
      const call = ctx.ast.asCallExpression(node)
      if (call !== null && ctx.ast.asIdentifier(call.expression)?.text === name) found.push(call)
      node.forEachChild(visit)
    }
    visit(body)
    return found
  }

  const imperativeNotice = (name: string, call: ts.CallExpression, file: string): DiagnosticInput => ({
    severity: "warning",
    code: "screens/dynamic-registry",
    message: `${NAMES.adapter}() builds routes imperatively through ${name}(); no routes are read from it`,
    file,
    line: ctx.lineOf(file, call),
  })

  /** `remixRoutesOptionAdapter((defineRoutes) => flatRoutes(dir, defineRoutes, opts))` from remix-flat-routes. */
  const readAdapter = (call: ts.CallExpression, file: string): RouteRead => {
    const fn = call.arguments[0] === undefined ? null : resolver.functionOf(call.arguments[0], file)
    if (fn === null) return unreadable(call, file)
    const returned = resolver.returnedBy(fn.node)
    const inner = returned === null ? null : ctx.ast.asCallExpression(withoutAwait(returned))
    const callee = inner === null ? null : ctx.ast.asIdentifier(inner.expression)
    if (inner !== null && callee !== null && isImported(callee.text, fn.file, ROUTE_CONFIG_MODULES.remixFlatRoutes, NAMES.flatRoutes))
      return readRemixFlatRoutes(inner, fn.file)
    const parameter = ctx.ts.isFunctionLike(fn.node) ? fn.node.parameters[0] : undefined
    const defineName = parameter === undefined ? null : ctx.ast.asIdentifier(parameter.name)?.text ?? null
    const builders = defineName === null ? [] : callsTo(fn.node, defineName)
    if (defineName === null || builders.length === 0) return unreadable(call, file)
    return { ...EMPTY_READ, notices: builders.map((builder) => imperativeNotice(defineName, builder, fn.file)) }
  }

  const unionNotice = (name: string, call: ts.CallExpression, file: string): DiagnosticInput => ({
    severity: "info",
    code: "screens/dynamic-registry",
    message: `${name}() is not a known route helper; its ${String(call.arguments.length)} route argument(s) are read as their union, which over-reports if it filters`,
    file,
    line: ctx.lineOf(file, call),
  })

  /** AS14: an unknown call whose arguments all fold to route arrays reads as their deduped union; `null` = not readable that way. */
  const unionOf = (call: ts.CallExpression, file: string, name: string): RouteRead | null => {
    if (expansions.has(call)) return expansions.get(call) ?? null
    const reads = call.arguments.map((argument) => readList(argument, file))
    const readable = reads.length > 0 && reads.every((read) => read.unreadable.length === 0)
    const evidence = `read through unknown call ${name}()`
    const union = readable
      ? {
          routes: mergeUnion(reads.flatMap((read) => read.routes)).map((route) => withEvidence(route, evidence)),
          unreadable: [],
          notices: [...reads.flatMap((read) => read.notices), unionNotice(name, call, file)],
        }
      : null
    expansions.set(call, union)
    return union
  }

  const readCall = (call: ts.CallExpression, file: string, conditions: readonly string[]): RouteRead => {
    const callee = calleeOf(call, file)
    if (callee.kind === "helper") return readHelper(call, file, callee, conditions)
    if (callee.kind === "flatRoutes") return readFsRoutes(call, file)
    if (callee.kind === "adapter") return readAdapter(call, file)
    if (callee.kind === "concat")
      return combineReads([readList(callee.receiver, file), ...call.arguments.map((argument) => readList(argument, file))])
    return expansions.get(call) ?? unreadable(call, file)
  }

  const readElement = (element: ArrayElement): RouteRead => {
    const located = resolveLocated(element.node, element.file)
    const call = ctx.ast.asCallExpression(located.node)
    if (call !== null) return readCall(call, located.file, element.conditions)
    const object = ctx.ast.asObjectLiteral(located.node)
    if (object !== null) return readObjectEntry(object, located.file, element.conditions)
    return unreadable(element.node, element.file)
  }

  const readConfig = (): RouteRead | null => {
    const source = ctx.sourceFile(options.file)
    const exported = source === null ? null : exportedOf(source)
    return exported === null ? null : readList(exported, options.file)
  }

  return readConfig
}

const noticeKey = (notice: DiagnosticInput): string =>
  `${notice.code}\0${notice.file ?? ""}\0${String(notice.line ?? 0)}\0${notice.message}`

const itemKey = (item: UnreadableItem): string => `${item.file}\0${String(item.line)}\0${item.text}`

export const readRouteConfig = (ctx: DiscoverContext, options: RouteConfigOptions): readonly RouteNode[] => {
  const read = createReader(ctx, options)()
  if (read === null) {
    ctx.diagnostic({
      severity: "warning",
      code: "screens/dynamic-registry",
      message: `${options.file} has no default export this reader can fold; no routes are read from it`,
      file: options.file,
    })
    return []
  }

  uniqueBy(read.notices, noticeKey).forEach((notice) => ctx.diagnostic(notice))
  const unreadable = uniqueBy(read.unreadable, itemKey)
  if (unreadable.length > 0)
    ctx.diagnostic({
      severity: "warning",
      code: "screens/dynamic-registry",
      message: unreadableMessage(options.file, unreadable),
      file: options.file,
    })
  return read.routes
}
