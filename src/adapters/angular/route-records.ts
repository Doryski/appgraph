import type ts from "typescript"
import { walk } from "../../core/ast.js"
import type { Located } from "../array-values.js"
import { lazyModuleEntry } from "../dynamic-imports.js"
import type { DiscoverContext, EntryRef, TsNode } from "../types.js"
import { createStringValueReader, importedBindingOf } from "../values.js"
import { ANGULAR_GUARD_KINDS } from "./auth.js"
import type { AngularDataValue, AngularGuardInput } from "./auth.js"
import { EMPTY_ENV, createAngularValues } from "./values.js"
import type { AngularElement, AngularUnreadable, AngularValues, Env, ObjectMember } from "./values.js"

export type AngularRedirect = { readonly kind: "path"; readonly value: string } | { readonly kind: "function" }

export type LoadChildren = {
  readonly kind: "routes" | "module"
  readonly file: string | null
  readonly exportName: string
  readonly unresolvedSpec?: string
}

export type AngularRouteGuard = AngularGuardInput & { readonly file: string | null }

export type AngularPathMatch = "full" | "prefix"

export type AngularRouteNode = {
  readonly path: string | null
  readonly file: string
  readonly line: number
  readonly component: EntryRef | null
  readonly loadComponent: EntryRef | null
  readonly loadsNothing: boolean
  readonly loadChildren: LoadChildren | null
  readonly redirectTo: AngularRedirect | null
  readonly pathMatch: AngularPathMatch | null
  readonly title: string | null
  readonly guards: readonly AngularRouteGuard[]
  readonly data: Readonly<Record<string, AngularDataValue>>
  readonly dataMaps: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly outlet: string | null
  readonly matcher: boolean
  readonly children: readonly AngularRouteNode[]
  readonly unreadableChildren: readonly AngularUnreadable[]
  readonly conditions: readonly string[]
  readonly canMatchGroup: boolean
}

export type AngularRouteRecords = {
  readonly nodes: readonly AngularRouteNode[]
  readonly unreadable: readonly AngularUnreadable[]
}

const ROUTE_KEYS = {
  path: "path",
  component: "component",
  loadComponent: "loadComponent",
  loadChildren: "loadChildren",
  redirectTo: "redirectTo",
  pathMatch: "pathMatch",
  title: "title",
  data: "data",
  outlet: "outlet",
  matcher: "matcher",
  children: "children",
} as const

const PATH_MATCHES = ["full", "prefix"] as const satisfies readonly AngularPathMatch[]

const ACCESS_METHODS: ReadonlySet<string> = new Set(["canActivate", "canActivateChild", "canMatch"] as const)

const DEFAULT_EXPORT = "default"

const MODULE_SUFFIX = "Module"

const LEGACY_SEPARATOR = "#"

const RXJS_PACKAGE = "rxjs"

const RXJS_OF = "of"

const PROMISE_GLOBAL = "Promise"

const PROMISE_RESOLVE = "resolve"

const FUNCTION_REDIRECT: AngularRedirect = { kind: "function" }

const EMPTY_RECORDS: AngularRouteRecords = { nodes: [], unreadable: [] }

type Members = readonly ObjectMember[]

type FunctionNode = ts.SignatureDeclaration & { readonly body?: ts.Node | undefined }

type ResolvedDeclaration = { readonly node: TsNode; readonly file: string; readonly name: string | null }

type ElementRead = { readonly node: AngularRouteNode | null; readonly unreadable: readonly AngularUnreadable[] }

type ChildrenRead = { readonly value: LoadChildren | null; readonly unreadable: readonly AngularUnreadable[] }

const combine = (records: readonly AngularRouteRecords[]): AngularRouteRecords => ({
  nodes: records.flatMap((record) => record.nodes),
  unreadable: records.flatMap((record) => record.unreadable),
})

const isPathMatch = (value: string | null): value is AngularPathMatch =>
  PATH_MATCHES.some((candidate) => candidate === value)

const isGuardKind = (name: string): name is AngularRouteGuard["kind"] =>
  ANGULAR_GUARD_KINDS.some((kind) => kind === name)

const memberNamed = (members: Members, name: string): ObjectMember | null =>
  members.find((member) => member.name === name) ?? null

const sharesPath = (node: AngularRouteNode, siblings: readonly AngularRouteNode[]): boolean =>
  node.path !== null && siblings.some((sibling) => sibling !== node && sibling.path === node.path)

const hasCanMatch = (node: AngularRouteNode): boolean => node.guards.some((guard) => guard.kind === "canMatch")

const withCanMatchGroups = (nodes: readonly AngularRouteNode[]): readonly AngularRouteNode[] =>
  nodes.map((node) => ({ ...node, canMatchGroup: hasCanMatch(node) && sharesPath(node, nodes) }))

const unresolvedKind = (exportName: string): LoadChildren["kind"] =>
  exportName.endsWith(MODULE_SUFFIX) ? "module" : "routes"

export const createAngularRouteReader = (ctx: DiscoverContext, values: AngularValues = createAngularValues(ctx)) => {
  const { resolver } = values
  const readString = createStringValueReader(ctx)

  const isFunctionLike = (node: TsNode): node is FunctionNode =>
    ctx.ts.isArrowFunction(node) ||
    ctx.ts.isFunctionExpression(node) ||
    ctx.ts.isFunctionDeclaration(node) ||
    ctx.ts.isMethodDeclaration(node)

  const isTrueLiteral = (node: TsNode | undefined): boolean =>
    node !== undefined && ctx.unwrap(node).kind === ctx.ts.SyntaxKind.TrueKeyword

  const unreadableAt = (node: TsNode, file: string): AngularUnreadable => resolver.unreadableAt(node, file)

  const stringOf = (member: ObjectMember | null): string | null =>
    member === null ? null : values.stringOf(member.value.node, member.value.file, member.env)

  const literalString = (member: ObjectMember | null): string | null => {
    if (member === null) return null
    return ctx.ast.asStringLiteralLike(member.value.node)?.text ?? null
  }

  const declarationIn = (file: string, name: string): ResolvedDeclaration | null => {
    const source = ctx.sourceFile(file)
    const node = source === null ? null : ctx.ast.declarationOf(source, name)
    if (node === null) return null
    const declared = ctx.ts.isClassDeclaration(node) || ctx.ts.isFunctionDeclaration(node) ? node.name?.text : null
    return { node, file, name: declared ?? (name === DEFAULT_EXPORT ? null : name) }
  }

  const followDefault = (declaration: ResolvedDeclaration): ResolvedDeclaration => {
    if (!ctx.ts.isExportAssignment(declaration.node)) return declaration
    const identifier = ctx.ast.asIdentifier(declaration.node.expression)
    const local = identifier === null ? null : declarationIn(declaration.file, identifier.text)
    return local ?? declaration
  }

  const declarationOfIdentifier = (identifier: ts.Identifier, file: string): ResolvedDeclaration | null => {
    const imported = importedBindingOf(ctx.bindingsFor(file).get(identifier.text))
    if (imported === null) return declarationIn(file, identifier.text)
    const declaring = ctx.resolveModule(file, imported.module)
    if (declaring === null) return null
    const exported = ctx.declaredExport(declaring, imported.imported)
    const found = declarationIn(exported.file, exported.exportName)
    return found === null ? null : followDefault(found)
  }

  const functionBody = (node: TsNode): FunctionNode | null => {
    const inner = ctx.unwrap(node)
    if (isFunctionLike(inner)) return inner
    if (!ctx.ts.isVariableDeclaration(inner) || inner.initializer === undefined) return null
    const initializer = ctx.unwrap(inner.initializer)
    return isFunctionLike(initializer) ? initializer : null
  }

  const returnsIn = (body: ts.Block): readonly ts.ReturnStatement[] => {
    const found: ts.ReturnStatement[] = []
    const visit = (node: TsNode): void => {
      if (ctx.ts.isReturnStatement(node)) found.push(node)
      if (isFunctionLike(node) || ctx.ts.isClassLike(node)) return
      node.forEachChild(visit)
    }
    body.forEachChild(visit)
    return found
  }

  const methodsOf = (owner: ts.ClassLikeDeclaration | null): ReadonlyMap<string, ts.MethodDeclaration> =>
    new Map(
      (owner?.members ?? []).flatMap((member) => {
        if (!ctx.ts.isMethodDeclaration(member)) return []
        const name = ctx.ast.asIdentifier(member.name)?.text
        return name === undefined ? [] : [[name, member] as const]
      }),
    )

  const delegatedMethod = (expression: TsNode, owner: ts.ClassLikeDeclaration | null): ts.MethodDeclaration | null => {
    const call = ctx.ast.asCallExpression(expression)
    const callee = call === null ? null : ctx.ast.asPropertyAccess(call.expression)
    if (callee === null || callee.expression.kind !== ctx.ts.SyntaxKind.ThisKeyword) return null
    return methodsOf(owner).get(callee.name.text) ?? null
  }

  const alwaysTrue = (fn: FunctionNode, owner: ts.ClassLikeDeclaration | null, seen: readonly TsNode[]): boolean => {
    const body = fn.body
    if (body === undefined || seen.includes(fn)) return false
    const next = [...seen, fn]
    const returnsTrue = (expression: TsNode | undefined): boolean => {
      if (expression === undefined) return false
      if (isTrueLiteral(expression)) return true
      const method = delegatedMethod(ctx.unwrap(expression), owner)
      return method !== null && alwaysTrue(method, owner, next)
    }
    if (!ctx.ts.isBlock(body)) return returnsTrue(body)
    const last = body.statements.at(-1)
    if (last === undefined || !ctx.ts.isReturnStatement(last)) return false
    return returnsIn(body).every((statement) => returnsTrue(statement.expression))
  }

  const classIsTrivial = (owner: ts.ClassLikeDeclaration): boolean => {
    const access = [...methodsOf(owner).entries()].filter(([name]) => ACCESS_METHODS.has(name))
    return access.length > 0 && access.every(([, method]) => alwaysTrue(method, owner, []))
  }

  const isTrivialDeclaration = (node: TsNode): boolean => {
    if (ctx.ts.isClassLike(node)) return classIsTrivial(node)
    const fn = functionBody(node)
    return fn !== null && alwaysTrue(fn, null, [])
  }

  const guardOf =
    (kind: AngularRouteGuard["kind"]) =>
    (element: AngularElement): AngularRouteGuard => {
      const inner = ctx.unwrap(element.node)
      if (isFunctionLike(inner)) return { kind, name: null, file: element.file, trivial: alwaysTrue(inner, null, []) }
      const call = ctx.ast.asCallExpression(inner)
      const identifier = ctx.ast.asIdentifier(call === null ? inner : call.expression)
      if (identifier === null) return { kind, name: null, file: null, trivial: false }
      const declaration = declarationOfIdentifier(identifier, element.file)
      if (declaration === null) return { kind, name: identifier.text, file: null, trivial: false }
      const trivial = call === null && isTrivialDeclaration(declaration.node)
      return { kind, name: declaration.name ?? identifier.text, file: declaration.file, trivial }
    }

  const unreadableGuard =
    (kind: AngularRouteGuard["kind"]) =>
    (): AngularRouteGuard => ({ kind, name: null, file: null, trivial: false })

  const guardsOf = (members: Members): readonly AngularRouteGuard[] =>
    members.flatMap((member) => {
      if (!isGuardKind(member.name)) return []
      const fold = values.arrayOf(member.value.node, member.value.file, member.env)
      return [...fold.elements.map(guardOf(member.name)), ...fold.unreadable.map(unreadableGuard(member.name))]
    })

  const chainText = (node: TsNode): string | null => {
    const inner = ctx.unwrap(node)
    const identifier = ctx.ast.asIdentifier(inner)
    if (identifier !== null) return identifier.text
    const access = ctx.ast.asPropertyAccess(inner)
    if (access === null) return null
    const head = chainText(access.expression)
    return head === null ? null : `${head}.${access.name.text}`
  }

  const arrayItemText = (node: TsNode): string | null => {
    const inner = ctx.unwrap(node)
    const literal = ctx.ast.asStringLiteralLike(inner)
    if (literal !== null) return literal.text
    return ctx.ast.asPropertyAccess(inner) === null ? null : chainText(inner)
  }

  const stringArray = (array: ts.ArrayLiteralExpression): readonly string[] | null => {
    const texts = array.elements.map(arrayItemText)
    return texts.every((text): text is string => text !== null) ? texts : null
  }

  const booleanOf = (node: TsNode): boolean | null => {
    const kind = ctx.unwrap(node).kind
    if (kind === ctx.ts.SyntaxKind.TrueKeyword) return true
    if (kind === ctx.ts.SyntaxKind.FalseKeyword) return false
    return null
  }

  const dataValue = (member: ObjectMember): AngularDataValue | null => {
    const node = member.value.node
    const flag = booleanOf(node)
    if (flag !== null) return flag
    const array = ctx.ast.asArrayLiteral(node)
    if (array !== null) return stringArray(array)
    if (ctx.ast.asObjectLiteral(node) !== null) return null
    return readString(node, member.value.file)
  }

  const stringMap = (member: ObjectMember): Readonly<Record<string, string>> | null => {
    if (ctx.ast.asObjectLiteral(member.value.node) === null) return null
    const list = values.membersOf(member.value.node, member.value.file, member.env)
    const entries = list.members.flatMap((entry) => {
      const value = readString(entry.value.node, entry.value.file)
      return value === null ? [] : [[entry.name, value] as const]
    })
    if (list.unreadable.length > 0 || entries.length !== list.members.length) return null
    return Object.fromEntries(entries)
  }

  const dataMembers = (members: Members): Members => {
    const data = memberNamed(members, ROUTE_KEYS.data)
    if (data === null || values.objectOf(data.value.node, data.value.file, data.env) === null) return []
    return values.membersOf(data.value.node, data.value.file, data.env).members
  }

  const dataOf = (data: Members): Readonly<Record<string, AngularDataValue>> =>
    Object.fromEntries(
      data.flatMap((member) => {
        const value = dataValue(member)
        return value === null ? [] : [[member.name, value] as const]
      }),
    )

  const dataMapsOf = (data: Members): Readonly<Record<string, Readonly<Record<string, string>>>> =>
    Object.fromEntries(
      data.flatMap((member) => {
        const map = stringMap(member)
        return map === null ? [] : [[member.name, map] as const]
      }),
    )

  const opaqueEntry = (member: ObjectMember): EntryRef => {
    const item = unreadableAt(member.value.node, member.value.file)
    return { kind: "opaque", expr: item.text, file: item.file, line: item.line }
  }

  const componentOf = (member: ObjectMember | null): EntryRef | null => {
    if (member === null) return null
    const identifier = ctx.ast.asIdentifier(member.value.node)
    if (identifier !== null) return { kind: "binding", from: member.value.file, local: identifier.text }
    return opaqueEntry(member)
  }

  const lazyNode = (member: ObjectMember): Located => {
    const inner = member.value.node
    const fn = resolver.functionOf(inner, member.value.file)
    return fn ?? { node: inner, file: member.value.file }
  }

  const exportPicked = (selector: TsNode | undefined): string | null => {
    if (selector === undefined) return null
    const fn = ctx.unwrap(selector)
    if (!ctx.ts.isArrowFunction(fn) && !ctx.ts.isFunctionExpression(fn)) return null
    const parameter = ctx.ast.asIdentifier(fn.parameters[0]?.name)?.text
    const body = ctx.ts.isBlock(fn.body) ? returnsIn(fn.body)[0]?.expression : fn.body
    const access = ctx.ast.asPropertyAccess(body)
    if (access === null || ctx.ast.asIdentifier(access.expression)?.text !== parameter) return null
    return access.name.text
  }

  const isImportCall = (node: TsNode): boolean =>
    ctx.ast.asCallExpression(node)?.expression.kind === ctx.ts.SyntaxKind.ImportKeyword

  const thenExport = (node: TsNode): string | null => {
    const picked: string[] = []
    walk(node, (candidate) => {
      const call = ctx.ast.asCallExpression(candidate)
      const access = call === null ? null : ctx.ast.asPropertyAccess(call.expression)
      if (call === null || access?.name.text !== "then" || !isImportCall(ctx.unwrap(access.expression))) return
      const name = exportPicked(call.arguments[0])
      if (name !== null) picked.push(name)
    })
    return picked[0] ?? null
  }

  const importSpecsIn = (node: TsNode, file: string): readonly string[] => {
    const specs: string[] = []
    walk(node, (candidate) => {
      const call = ctx.ast.asCallExpression(candidate)
      if (call === null || !isImportCall(call)) return
      const spec = readString(call.arguments[0], file)
      if (spec !== null) specs.push(spec)
    })
    return specs
  }

  const lazySpec = (member: ObjectMember): { spec: string; exportName: string; file: string } | null => {
    const located = lazyNode(member)
    const [spec] = importSpecsIn(located.node, located.file)
    if (spec === undefined) return null
    return { spec, exportName: thenExport(located.node) ?? DEFAULT_EXPORT, file: located.file }
  }

  const isNullish = (node: TsNode | undefined): boolean => {
    if (node === undefined) return false
    const inner = ctx.unwrap(node)
    return inner.kind === ctx.ts.SyntaxKind.NullKeyword || ctx.ast.asIdentifier(inner)?.text === "undefined"
  }

  const isRxjsOf = (callee: TsNode, file: string): boolean => {
    const identifier = ctx.ast.asIdentifier(callee)
    const imported = identifier === null ? null : importedBindingOf(ctx.bindingsFor(file).get(identifier.text))
    return imported?.module === RXJS_PACKAGE && imported.imported === RXJS_OF
  }

  const isPromiseResolve = (callee: TsNode): boolean => {
    const access = ctx.ast.asPropertyAccess(callee)
    return access?.name.text === PROMISE_RESOLVE && ctx.ast.asIdentifier(access.expression)?.text === PROMISE_GLOBAL
  }

  const yieldsNothing = (returned: TsNode, file: string): boolean => {
    if (isNullish(returned)) return true
    const call = ctx.ast.asCallExpression(returned)
    if (call === null || call.arguments.length !== 1 || !isNullish(call.arguments[0])) return false
    return isRxjsOf(call.expression, file) || isPromiseResolve(call.expression)
  }

  const loadsNothing = (member: ObjectMember | null): boolean => {
    if (member === null) return false
    const fn = resolver.functionOf(member.value.node, member.value.file)
    const returned = fn === null ? null : resolver.returnedBy(fn.node)
    return fn !== null && returned !== null && yieldsNothing(returned, fn.file)
  }

  const loadComponentOf = (member: ObjectMember | null): EntryRef | null => {
    if (member === null || loadsNothing(member)) return null
    const lazy = lazySpec(member)
    return lazy === null ? opaqueEntry(member) : lazyModuleEntry(ctx, lazy.file, lazy.spec, lazy.exportName).entry
  }

  const targetKind = (file: string, exportName: string): LoadChildren["kind"] => {
    const declaration = declarationIn(file, exportName)
    if (declaration === null) return unresolvedKind(exportName)
    return ctx.ts.isClassLike(followDefault(declaration).node) ? "module" : "routes"
  }

  const childrenTarget = (file: string, spec: string, exportName: string): LoadChildren => {
    const { target } = lazyModuleEntry(ctx, file, spec, exportName)
    if (target === null) return { kind: unresolvedKind(exportName), file: null, exportName, unresolvedSpec: spec }
    return { kind: targetKind(target.file, target.exportName), file: target.file, exportName: target.exportName }
  }

  const legacyChildren = (member: ObjectMember): LoadChildren | null => {
    const text = literalString(member)
    if (text === null) return null
    const [spec = "", exportName = DEFAULT_EXPORT] = text.split(LEGACY_SEPARATOR)
    return childrenTarget(member.value.file, spec, exportName)
  }

  const loadChildrenOf = (member: ObjectMember | null): ChildrenRead => {
    if (member === null) return { value: null, unreadable: [] }
    const legacy = legacyChildren(member)
    if (legacy !== null) return { value: legacy, unreadable: [] }
    const lazy = lazySpec(member)
    if (lazy !== null) return { value: childrenTarget(lazy.file, lazy.spec, lazy.exportName), unreadable: [] }
    return { value: null, unreadable: [unreadableAt(member.value.node, member.value.file)] }
  }

  const redirectOf = (member: ObjectMember | null): AngularRedirect | null => {
    if (member === null) return null
    if (resolver.functionOf(member.value.node, member.value.file) !== null) return FUNCTION_REDIRECT
    const value = stringOf(member)
    return value === null ? null : { kind: "path", value }
  }

  const pathMatchOf = (member: ObjectMember | null): AngularPathMatch | null => {
    const value = stringOf(member)
    return isPathMatch(value) ? value : null
  }

  const childrenOf = (member: ObjectMember | null): AngularRouteRecords => {
    if (member === null) return EMPTY_RECORDS
    return foldRoutes(member.value, member.env)
  }

  const readRoute = (members: Members, file: string, line: number, conditions: readonly string[]): ElementRead => {
    const member = (name: string): ObjectMember | null => memberNamed(members, name)
    const loadComponent = loadComponentOf(member(ROUTE_KEYS.loadComponent))
    const loadChildren = loadChildrenOf(member(ROUTE_KEYS.loadChildren))
    const children = childrenOf(member(ROUTE_KEYS.children))
    const data = dataMembers(members)
    const node: AngularRouteNode = {
      path: stringOf(member(ROUTE_KEYS.path)),
      file,
      line,
      component: componentOf(member(ROUTE_KEYS.component)),
      loadComponent,
      loadsNothing: loadsNothing(member(ROUTE_KEYS.loadComponent)),
      loadChildren: loadChildren.value,
      redirectTo: redirectOf(member(ROUTE_KEYS.redirectTo)),
      pathMatch: pathMatchOf(member(ROUTE_KEYS.pathMatch)),
      title: literalString(member(ROUTE_KEYS.title)),
      guards: guardsOf(members),
      data: dataOf(data),
      dataMaps: dataMapsOf(data),
      outlet: stringOf(member(ROUTE_KEYS.outlet)),
      matcher: member(ROUTE_KEYS.matcher) !== null,
      children: children.nodes,
      unreadableChildren: children.unreadable,
      conditions,
      canMatchGroup: false,
    }
    return { node, unreadable: loadChildren.unreadable }
  }

  const elementRead = (element: AngularElement): ElementRead => {
    const object = values.objectOf(element.node, element.file, element.env)
    if (object === null) return { node: null, unreadable: [unreadableAt(element.node, element.file)] }
    const list = values.membersOf(object.node, object.file, object.env)
    const read = readRoute(list.members, object.file, ctx.lineOf(object.file, object.node), element.conditions)
    return { node: read.node, unreadable: [...list.unreadable, ...read.unreadable] }
  }

  const foldRoutes = (located: Located, env: Env): AngularRouteRecords => {
    const fold = values.arrayOf(located.node, located.file, env)
    const reads = fold.elements.map(elementRead)
    const records = combine(
      reads.map((read) => ({ nodes: read.node === null ? [] : [read.node], unreadable: read.unreadable })),
    )
    return { nodes: withCanMatchGroups(records.nodes), unreadable: [...fold.unreadable, ...records.unreadable] }
  }

  return {
    readRoutes: (node: Located, env: Env = EMPTY_ENV): AngularRouteRecords => foldRoutes(node, env),
  }
}

export type AngularRouteReader = ReturnType<typeof createAngularRouteReader>
