import type ts from "typescript"
import { byCodepoint, sortBy, sortedUnique, stableUnique, uniqueBy } from "../core/order.js"
import {
  type ArrayElement,
  type Located,
  type UnreadableItem,
  createArrayFolder,
  createValueResolver,
} from "./array-values.js"
import { dynamicImportsIn, lazyModuleEntry } from "./dynamic-imports.js"
import type { DiscoverContext, EntryRef, TsNode } from "./types.js"
import { createStringValueReader } from "./values.js"
import type { VueAuthSignals } from "./vue-auth.js"

export type RouteRedirect =
  | { readonly kind: "path"; readonly value: string }
  | { readonly kind: "name"; readonly value: string }
  | { readonly kind: "function" }
  | { readonly kind: "opaque"; readonly text: string }

export type RouteNode = {
  readonly file: string
  readonly line: number
  readonly conditions: readonly string[]
  readonly path: string | null
  readonly name: string | null
  readonly entries: readonly EntryRef[]
  readonly entryConditions: readonly string[]
  readonly outletName?: string
  readonly inlineComponents?: readonly InlineComponent[]
  readonly redirect: RouteRedirect | null
  readonly alias: readonly string[]
  readonly authSignals: VueAuthSignals
  readonly hasBeforeEnter: boolean
  readonly children: readonly RouteNode[]
  readonly unreadableChildren: readonly UnreadableItem[]
}

export type RouteRecords = {
  readonly routes: readonly RouteNode[]
  readonly unreadable: readonly UnreadableItem[]
}

const PASSTHROUGH_METHODS: ReadonlySet<string> = new Set(["map", "filter"] as const)

const CONCAT_METHOD = "concat"

const DEFAULT_VIEW = "default"

const ASYNC_COMPONENT_FACTORY = "defineAsyncComponent"

const MAX_BINDING_HOPS = 8

const INLINE_COMPONENT_KEYS = ["render", "setup", "template"] as const

const ROUTE_KEYS = {
  path: "path",
  name: "name",
  component: "component",
  components: "components",
  redirect: "redirect",
  alias: "alias",
  meta: "meta",
  middleware: "middleware",
  beforeEnter: "beforeEnter",
  children: "children",
} as const

const FUNCTION_REDIRECT: RouteRedirect = { kind: "function" }

const EMPTY_RECORDS: RouteRecords = { routes: [], unreadable: [] }

const NO_SIGNALS: VueAuthSignals = { middleware: [], flags: {} }

type Members = ReadonlyMap<string, TsNode>

export type InlineComponent = { readonly file: string; readonly line: number }

type ComponentRead = {
  readonly entries: readonly EntryRef[]
  readonly conditions: readonly string[]
  readonly inline?: readonly InlineComponent[]
}

type ElementRead = { readonly route: RouteNode } | { readonly unreadable: UnreadableItem }

const combineRecords = (records: readonly RouteRecords[]): RouteRecords => ({
  routes: records.flatMap((record) => record.routes),
  unreadable: records.flatMap((record) => record.unreadable),
})

const entryKey = (entry: EntryRef): string => JSON.stringify(entry)

const viewOrder = (a: string, b: string): number => {
  if (a === b) return 0
  if (a === DEFAULT_VIEW) return -1
  if (b === DEFAULT_VIEW) return 1
  return byCodepoint(a, b)
}

export const createRouteReader = (ctx: DiscoverContext) => {
  const resolver = createValueResolver(ctx)
  const folder = createArrayFolder(ctx, resolver)
  const readString = createStringValueReader(ctx)

  const isFunctionLike = (node: TsNode): boolean =>
    ctx.ts.isArrowFunction(node) || ctx.ts.isFunctionExpression(node) || ctx.ts.isFunctionDeclaration(node)

  const isAsyncComponentCall = (node: TsNode): boolean => {
    const call = ctx.ast.asCallExpression(node)
    return call !== null && ctx.ast.asIdentifier(call.expression)?.text === ASYNC_COMPONENT_FACTORY
  }

  const resolveLocated = (node: TsNode, file: string, hops = 0): Located => {
    const inner = ctx.unwrap(node)
    const identifier = ctx.ast.asIdentifier(inner)
    if (identifier === null || hops >= MAX_BINDING_HOPS) return { node: inner, file }
    const bound = resolver.valueOf(identifier, file)
    return bound === null ? { node: inner, file } : resolveLocated(bound.node, bound.file, hops + 1)
  }

  const keyOf = (name: ts.PropertyName): string | null =>
    ctx.ast.asIdentifier(name)?.text ?? ctx.ast.asStringLiteralLike(name)?.text ?? null

  const memberEntry = (member: ts.ObjectLiteralElementLike): readonly [string, TsNode][] => {
    if (ctx.ts.isSpreadAssignment(member)) return []
    const key = keyOf(member.name)
    if (key === null) return []
    if (ctx.ts.isPropertyAssignment(member)) return [[key, member.initializer]]
    if (ctx.ts.isShorthandPropertyAssignment(member)) return [[key, member.name]]
    return [[key, member]]
  }

  const membersOf = (object: ts.ObjectLiteralExpression): Members =>
    new Map(object.properties.flatMap(memberEntry))

  const objectAt = (node: TsNode | undefined, file: string): { members: Members; file: string } | null => {
    if (node === undefined) return null
    const located = resolveLocated(node, file)
    const object = ctx.ast.asObjectLiteral(located.node)
    return object === null ? null : { members: membersOf(object), file: located.file }
  }

  const stringsAt = (node: TsNode | undefined, file: string): readonly string[] => {
    if (node === undefined) return []
    const located = resolveLocated(node, file)
    const array = ctx.ast.asArrayLiteral(located.node)
    const items = array === null ? [located.node] : array.elements
    return items.flatMap((item) => {
      const value = readString(item, located.file)
      return value === null ? [] : [value]
    })
  }

  const opaqueEntry = (node: TsNode, file: string): EntryRef => {
    const item = resolver.unreadableAt(node, file)
    return { kind: "opaque", expr: item.text, file: item.file, line: item.line }
  }

  const branchConditions = (node: TsNode): readonly string[] => {
    const found: string[] = []
    const visit = (candidate: TsNode): void => {
      if (ctx.ts.isIfStatement(candidate)) found.push(ctx.ast.conditionText(candidate.expression))
      if (ctx.ts.isConditionalExpression(candidate)) found.push(ctx.ast.conditionText(candidate.condition))
      candidate.forEachChild(visit)
    }
    visit(node)
    return stableUnique(found)
  }

  const lazyRead = (node: TsNode, file: string): ComponentRead | null => {
    const inner = ctx.unwrap(node)
    if (!isFunctionLike(inner) && !isAsyncComponentCall(inner)) return null
    const specs = dynamicImportsIn(ctx, inner)
    if (specs.length === 0) return null
    return {
      entries: uniqueBy(
        specs.map((spec) => lazyModuleEntry(ctx, file, spec).entry),
        entryKey,
      ),
      conditions: specs.length > 1 ? branchConditions(inner) : [],
    }
  }

  const isInlineComponent = (node: TsNode): boolean => {
    const object = ctx.ast.asObjectLiteral(node)
    if (object === null) return false
    const members = membersOf(object)
    return INLINE_COMPONENT_KEYS.some((key) => members.has(key))
  }

  const componentRead = (node: TsNode, file: string): ComponentRead => {
    const inner = ctx.unwrap(node)
    if (isInlineComponent(inner)) return { entries: [], conditions: [], inline: [{ file, line: ctx.lineOf(file, inner) }] }
    const identifier = ctx.ast.asIdentifier(inner)
    if (identifier === null) return lazyRead(inner, file) ?? { entries: [opaqueEntry(inner, file)], conditions: [] }
    const bound = resolver.valueOf(identifier, file)
    const lazy = bound === null ? null : lazyRead(bound.node, bound.file)
    return lazy ?? { entries: [{ kind: "binding", from: file, local: identifier.text }], conditions: [] }
  }

  const namedViews = (node: TsNode, file: string): readonly ComponentRead[] => {
    const views = objectAt(node, file)
    if (views === null) return [{ entries: [opaqueEntry(ctx.unwrap(node), file)], conditions: [] }]
    return [...views.members.keys()]
      .sort(viewOrder)
      .flatMap((key) => {
        const value = views.members.get(key)
        return value === undefined ? [] : [componentRead(value, views.file)]
      })
  }

  const componentsOf = (members: Members, file: string): ComponentRead => {
    const single = members.get(ROUTE_KEYS.component)
    const named = members.get(ROUTE_KEYS.components)
    const reads = [
      ...(single === undefined ? [] : [componentRead(single, file)]),
      ...(named === undefined ? [] : namedViews(named, file)),
    ]
    return {
      entries: uniqueBy(
        reads.flatMap((read) => read.entries),
        entryKey,
      ),
      conditions: stableUnique(reads.flatMap((read) => read.conditions)),
      inline: reads.flatMap((read) => read.inline ?? []),
    }
  }

  const outletNameOf = (members: Members, file: string): string | null => {
    if (members.has(ROUTE_KEYS.component)) return null
    const views = objectAt(members.get(ROUTE_KEYS.components), file)
    const [first] = views === null ? [] : [...views.members.keys()].sort(viewOrder)
    return first === undefined || first === DEFAULT_VIEW ? null : first
  }

  const objectRedirect = (members: Members, file: string, node: TsNode): RouteRedirect => {
    const name = members.get(ROUTE_KEYS.name)
    const nameValue = name === undefined ? null : readString(name, file)
    if (nameValue !== null) return { kind: "name", value: nameValue }
    const target = members.get(ROUTE_KEYS.path)
    const pathValue = target === undefined ? null : readString(target, file)
    if (pathValue !== null) return { kind: "path", value: pathValue }
    return { kind: "opaque", text: resolver.unreadableAt(node, file).text }
  }

  const redirectOf = (node: TsNode | undefined, file: string): RouteRedirect | null => {
    if (node === undefined) return null
    if (resolver.functionOf(node, file) !== null) return FUNCTION_REDIRECT
    const object = objectAt(node, file)
    if (object !== null) return objectRedirect(object.members, object.file, node)
    const value = readString(node, file)
    if (value !== null) return { kind: "path", value }
    return { kind: "opaque", text: resolver.unreadableAt(ctx.unwrap(node), file).text }
  }

  const flagOf = (node: TsNode): boolean | null => {
    const inner = ctx.unwrap(node)
    if (inner.kind === ctx.ts.SyntaxKind.TrueKeyword) return true
    if (inner.kind === ctx.ts.SyntaxKind.FalseKeyword) return false
    return null
  }

  const authSignalsOf = (node: TsNode | undefined, file: string): VueAuthSignals => {
    const meta = objectAt(node, file)
    if (meta === null) return NO_SIGNALS
    const flags = sortBy([...meta.members.entries()], ([key]) => key).flatMap(([key, value]) => {
      const flag = flagOf(value)
      return flag === null ? [] : [[key, flag] as const]
    })
    return {
      middleware: sortedUnique(stringsAt(meta.members.get(ROUTE_KEYS.middleware), meta.file)),
      flags: Object.fromEntries(flags),
    }
  }

  const readRoute = (object: ts.ObjectLiteralExpression, file: string, conditions: readonly string[]): RouteNode => {
    const members = membersOf(object)
    const valueOf = (key: string): string | null => {
      const node = members.get(key)
      return node === undefined ? null : readString(node, file)
    }
    const components = componentsOf(members, file)
    const outletName = outletNameOf(members, file)
    const childNode = members.get(ROUTE_KEYS.children)
    const children = childNode === undefined ? EMPTY_RECORDS : foldRoutes(childNode, file)
    return {
      file,
      line: ctx.lineOf(file, object),
      conditions,
      path: valueOf(ROUTE_KEYS.path),
      name: valueOf(ROUTE_KEYS.name),
      entries: components.entries,
      entryConditions: components.conditions,
      ...(outletName === null ? {} : { outletName }),
      ...(components.inline === undefined || components.inline.length === 0 ? {} : { inlineComponents: components.inline }),
      redirect: redirectOf(members.get(ROUTE_KEYS.redirect), file),
      alias: stringsAt(members.get(ROUTE_KEYS.alias), file),
      authSignals: authSignalsOf(members.get(ROUTE_KEYS.meta), file),
      hasBeforeEnter: members.has(ROUTE_KEYS.beforeEnter),
      children: children.routes,
      unreadableChildren: children.unreadable,
    }
  }

  const elementRead = (element: ArrayElement): ElementRead => {
    const located = resolveLocated(element.node, element.file)
    const object = ctx.ast.asObjectLiteral(located.node)
    if (object === null) return { unreadable: resolver.unreadableAt(element.node, element.file) }
    return { route: readRoute(object, located.file, element.conditions) }
  }

  const foldRoutes = (node: TsNode, file: string): RouteRecords => {
    const inner = ctx.unwrap(node)
    const call = ctx.ast.asCallExpression(inner)
    const access = call === null ? null : ctx.ast.asPropertyAccess(call.expression)
    if (call !== null && access !== null && PASSTHROUGH_METHODS.has(access.name.text))
      return foldRoutes(access.expression, file)
    if (call !== null && access !== null && access.name.text === CONCAT_METHOD)
      return combineRecords([
        foldRoutes(access.expression, file),
        ...call.arguments.map((argument) => foldRoutes(argument, file)),
      ])
    const fold = folder(inner, file)
    const reads = fold.elements.map(elementRead)
    return {
      routes: reads.flatMap((read) => ("route" in read ? [read.route] : [])),
      unreadable: [...fold.unreadable, ...reads.flatMap((read) => ("unreadable" in read ? [read.unreadable] : []))],
    }
  }

  return foldRoutes
}

export const readRoutes = (ctx: DiscoverContext, file: string, arrayExpr: TsNode): RouteRecords =>
  createRouteReader(ctx)(arrayExpr, file)
