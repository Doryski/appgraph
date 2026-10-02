import type ts from "typescript"
import type { TypeScriptApi } from "./tsconfig.js"
import type { StringContext } from "./ast.js"
import { createAst, hasStaticModifier, walk } from "./ast.js"
import { sortedEntries } from "./order.js"

const FOLD_PASSES = 3

const MAX_MEMBER_DEPTH = 4

export type StringTable = {
  readonly add: (source: ts.SourceFile) => void
  readonly get: (key: string) => string | null
  readonly has: (key: string) => boolean
  readonly size: () => number
  readonly entries: () => readonly (readonly [string, string])[]
  readonly members: ReadonlyMap<string, string>
  readonly partialMembers: ReadonlyMap<string, string>
  readonly contextFor: (source: ts.SourceFile) => StringContext
}

export type MemberTables = {
  readonly members: ReadonlyMap<string, string>
  readonly partialMembers: ReadonlyMap<string, string>
}

const EMPTY_MEMBERS: ReadonlyMap<string, string> = new Map()

const partialRegistry = new WeakMap<ReadonlyMap<string, string>, ReadonlyMap<string, string>>()

export const partialMembersOf = (members: ReadonlyMap<string, string>): ReadonlyMap<string, string> =>
  partialRegistry.get(members) ?? EMPTY_MEMBERS

export const collectStringMembers = (
  api: TypeScriptApi,
  source: ts.SourceFile,
): ReadonlyMap<string, string> => {
  const ast = createAst(api)
  const members = new Map<string, string>()

  const propertyKey = (name: ts.PropertyName): string | null => {
    if (api.isIdentifier(name) || api.isStringLiteral(name) || api.isNumericLiteral(name)) return name.text
    if (api.isNoSubstitutionTemplateLiteral(name)) return name.text
    return null
  }

  const frozenObject = (node: ts.Node): ts.ObjectLiteralExpression | null => {
    const direct = ast.asObjectLiteral(node)
    if (direct !== null) return direct

    const call = ast.asCallExpression(node)
    const callee = call === null ? null : ast.asPropertyAccess(call.expression)
    if (call === null || callee === null) return null
    if (callee.name.text !== "freeze") return null
    if (!api.isIdentifier(callee.expression) || callee.expression.text !== "Object") return null
    return ast.asObjectLiteral(call.arguments[0])
  }

  const readObject = (object: ts.ObjectLiteralExpression, prefix: string, depth: number): void => {
    if (depth > MAX_MEMBER_DEPTH) return

    for (const property of object.properties) {
      if (!api.isPropertyAssignment(property)) continue
      const key = propertyKey(property.name)
      if (key === null) continue

      const value = ast.unwrap(property.initializer)
      if (api.isStringLiteral(value) || api.isNoSubstitutionTemplateLiteral(value)) {
        members.set(`${prefix}.${key}`, value.text)
        continue
      }

      const nested = frozenObject(value)
      if (nested !== null) readObject(nested, `${prefix}.${key}`, depth + 1)
    }
  }

  walk(source, (node) => {
    if (!api.isEnumDeclaration(node)) return
    for (const member of node.members) {
      if (!api.isIdentifier(member.name) || !member.initializer) continue
      if (!api.isStringLiteral(member.initializer)) continue
      members.set(`${node.name.text}.${member.name.text}`, member.initializer.text)
    }
  })

  for (const statement of source.statements) {
    if (!api.isVariableStatement(statement)) continue
    if ((statement.declarationList.flags & api.NodeFlags.Const) === 0) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!api.isIdentifier(declaration.name) || declaration.initializer === undefined) continue
      const object = frozenObject(declaration.initializer)
      if (object !== null) readObject(object, declaration.name.text, 0)
    }
  }

  return members
}

type Slot = {
  readonly name: string
  readonly scope: ts.Node
  readonly initializer: ts.Expression | null
}

export type ScopedStrings = {
  readonly context: StringContext
  readonly contextAt: (node: ts.Node | undefined) => StringContext
}

const isScopeNode = (api: TypeScriptApi, node: ts.Node): boolean =>
  api.isSourceFile(node) ||
  api.isBlock(node) ||
  api.isModuleBlock(node) ||
  api.isCaseBlock(node) ||
  api.isCatchClause(node) ||
  api.isForStatement(node) ||
  api.isForInStatement(node) ||
  api.isForOfStatement(node) ||
  api.isFunctionLike(node)

const isFunctionScopeNode = (api: TypeScriptApi, node: ts.Node): boolean =>
  api.isSourceFile(node) || api.isModuleBlock(node) || api.isFunctionLike(node)

const nearest = (node: ts.Node, accepts: (candidate: ts.Node) => boolean): ts.Node => {
  let current = node
  while (!accepts(current) && current.parent !== undefined) current = current.parent
  return current
}

const bindingNamesOf = (api: TypeScriptApi, name: ts.BindingName): readonly string[] => {
  if (api.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((element) =>
    api.isOmittedExpression(element) ? [] : bindingNamesOf(api, element.name),
  )
}

const isBlockScopedDeclaration = (api: TypeScriptApi, node: ts.VariableDeclaration): boolean =>
  !api.isVariableDeclarationList(node.parent) || (node.parent.flags & api.NodeFlags.BlockScoped) !== 0

const importedNamesOf = (api: TypeScriptApi, node: ts.Node): readonly string[] => {
  if (api.isImportClause(node)) return node.name === undefined ? [] : [node.name.text]
  if (api.isNamespaceImport(node) || api.isImportSpecifier(node) || api.isImportEqualsDeclaration(node))
    return [node.name.text]
  return []
}

const slotsOf = (api: TypeScriptApi, source: ts.SourceFile, node: ts.Node): readonly Slot[] => {
  const scopeOf = (from: ts.Node): ts.Node => nearest(from, (candidate) => isScopeNode(api, candidate))
  const opaque = (scope: ts.Node, names: readonly string[]): readonly Slot[] =>
    names.map((name) => ({ name, scope, initializer: null }))

  if (api.isVariableDeclaration(node)) {
    const scope = isBlockScopedDeclaration(api, node)
      ? scopeOf(node.parent)
      : nearest(node.parent, (candidate) => isFunctionScopeNode(api, candidate))
    if (!api.isIdentifier(node.name)) return opaque(scope, bindingNamesOf(api, node.name))
    return [{ name: node.name.text, scope, initializer: node.initializer ?? null }]
  }
  if (api.isParameter(node)) return opaque(scopeOf(node.parent), bindingNamesOf(api, node.name))
  if ((api.isFunctionDeclaration(node) || api.isClassDeclaration(node)) && node.name !== undefined)
    return opaque(scopeOf(node.parent), [node.name.text])
  if (api.isFunctionExpression(node) && node.name !== undefined) return opaque(node, [node.name.text])
  return opaque(source, importedNamesOf(api, node))
}

const resolvedFileConstants = (
  source: ts.SourceFile,
  slots: readonly Slot[],
  values: ReadonlyMap<Slot, string>,
): ReadonlyMap<string, string> => {
  const byName = new Map<string, Slot[]>()
  for (const slot of slots) byName.set(slot.name, [...(byName.get(slot.name) ?? []), slot])

  const valueOf = (named: readonly Slot[]): string | undefined => {
    const moduleSlot = named.find((slot) => slot.scope === source)
    if (moduleSlot !== undefined) return values.get(moduleSlot)
    const distinct = new Set(named.map((slot) => values.get(slot)))
    const [only] = distinct
    return distinct.size === 1 ? only : undefined
  }

  const constants = new Map<string, string>()
  for (const [name, named] of byName) {
    const value = valueOf(named)
    if (value !== undefined) constants.set(name, value)
  }
  return constants
}

const scopeView = (lookup: (name: string) => string | undefined, names: () => readonly string[]): ReadonlyMap<string, string> => {
  const materialize = (): ReadonlyMap<string, string> =>
    new Map(names().flatMap((name) => {
      const value = lookup(name)
      return value === undefined ? [] : [[name, value] as const]
    }))
  return {
    get: lookup,
    has: (name) => lookup(name) !== undefined,
    get size() {
      return materialize().size
    },
    forEach: (callback, thisArg) => {
      materialize().forEach(callback, thisArg)
    },
    entries: () => materialize().entries(),
    keys: () => materialize().keys(),
    values: () => materialize().values(),
    [Symbol.iterator]: () => materialize()[Symbol.iterator](),
  }
}

export const createScopedStrings = (
  api: TypeScriptApi,
  source: ts.SourceFile,
  members: ReadonlyMap<string, string> = new Map(),
  partialMembers: ReadonlyMap<string, string> = EMPTY_MEMBERS,
): ScopedStrings => {
  const ast = createAst(api)
  const isScope = (node: ts.Node): boolean => isScopeNode(api, node)

  const scopes = new Map<ts.Node, Map<string, Slot>>()
  const slots: Slot[] = []
  walk(source, (node) => {
    for (const slot of slotsOf(api, source, node)) {
      const own = scopes.get(slot.scope) ?? new Map<string, Slot>()
      if (own.has(slot.name)) continue
      own.set(slot.name, slot)
      scopes.set(slot.scope, own)
      slots.push(slot)
    }
  })

  const values = new Map<Slot, string>()

  const outerScope = (scope: ts.Node): ts.Node | null =>
    scope.parent === undefined ? null : nearest(scope.parent, isScope)

  const lookupFrom = (scope: ts.Node, name: string): string | undefined => {
    for (let current: ts.Node | null = scope; current !== null; current = outerScope(current)) {
      const slot = scopes.get(current)?.get(name)
      if (slot !== undefined) return values.get(slot)
    }
    return undefined
  }

  const names = (): readonly string[] => [...new Set(slots.map((slot) => slot.name))]

  const contexts = new Map<ts.Node, StringContext>()
  const scopedContext = (scope: ts.Node): StringContext => {
    const cached = contexts.get(scope)
    if (cached !== undefined) return cached
    const context: StringContext = {
      constants: scopeView((name) => lookupFrom(scope, name), names),
      members,
      partialMembers,
    }
    contexts.set(scope, context)
    return context
  }

  const foldSlot = (slot: Slot, initializer: ts.Expression): void => {
    try {
      const flat = ast.flattenString(initializer, scopedContext(nearest(initializer, isScope)))
      if (flat && !flat.dynamic) values.set(slot, flat.value)
    } catch {
      return
    }
  }

  for (let pass = 0; pass < FOLD_PASSES; pass += 1)
    for (const slot of slots) {
      if (slot.initializer === null || values.has(slot)) continue
      foldSlot(slot, slot.initializer)
    }

  const context: StringContext = { constants: resolvedFileConstants(source, slots, values), members, partialMembers }

  const contextAt = (node: ts.Node | undefined): StringContext => {
    if (node === undefined || node.getSourceFile() !== source) return context
    return scopedContext(nearest(node, isScope))
  }

  return { context, contextAt }
}

type StaticField = {
  readonly key: string
  readonly initializer: ts.Expression
}

const staticFieldsOf = (api: TypeScriptApi, source: ts.SourceFile): readonly StaticField[] => {
  const fields: StaticField[] = []
  walk(source, (node) => {
    if (!api.isClassLike(node) || node.name === undefined) return
    const owner = node.name.text
    for (const member of node.members) {
      if (!api.isPropertyDeclaration(member) || member.initializer === undefined) continue
      if (!api.isIdentifier(member.name) || !hasStaticModifier(api, member)) continue
      fields.push({ key: `${owner}.${member.name.text}`, initializer: member.initializer })
    }
  })
  return fields
}

export const withStaticMembers = (api: TypeScriptApi, source: ts.SourceFile, base: MemberTables): MemberTables => {
  const fields = staticFieldsOf(api, source).filter((field) => !base.members.has(field.key))
  if (fields.length === 0) return base

  const ast = createAst(api)
  const members = new Map(base.members)
  const partialMembers = new Map(base.partialMembers)
  const scoped = createScopedStrings(api, source, members, partialMembers)

  const flatten = (field: StaticField) => {
    try {
      const constants = scoped.contextAt(field.initializer).constants
      return ast.flattenString(field.initializer, { constants, members, partialMembers })
    } catch {
      return null
    }
  }

  const fold = (field: StaticField): void => {
    const flat = flatten(field)
    if (flat === null) return
    if (flat.dynamic) {
      partialMembers.set(field.key, flat.value)
      return
    }
    members.set(field.key, flat.value)
    partialMembers.delete(field.key)
  }

  for (let pass = 0; pass < FOLD_PASSES; pass += 1) fields.forEach(fold)
  return { members, partialMembers }
}

export const collectStringConstants = (
  api: TypeScriptApi,
  source: ts.SourceFile,
  members: ReadonlyMap<string, string> = new Map(),
): ReadonlyMap<string, string> => createScopedStrings(api, source, members).context.constants

const fileStringsCache = new WeakMap<ReadonlyMap<string, string>, WeakMap<ts.SourceFile, ScopedStrings>>()

const baseMembersCache = new WeakMap<StringContext, ReadonlyMap<string, string>>()

const withOwnMembers = (api: TypeScriptApi, source: ts.SourceFile, base: ReadonlyMap<string, string>): MemberTables => {
  const members = new Map(base)
  for (const [key, value] of collectStringMembers(api, source)) if (!members.has(key)) members.set(key, value)
  return withStaticMembers(api, source, { members, partialMembers: partialMembersOf(base) })
}

export const fileStrings = (
  api: TypeScriptApi,
  source: ts.SourceFile,
  base: ReadonlyMap<string, string>,
): ScopedStrings => {
  const perSource = fileStringsCache.get(base) ?? new WeakMap<ts.SourceFile, ScopedStrings>()
  fileStringsCache.set(base, perSource)
  const cached = perSource.get(source)
  if (cached !== undefined) return cached

  const own = withOwnMembers(api, source, base)
  const scoped = createScopedStrings(api, source, own.members, own.partialMembers)
  perSource.set(source, scoped)
  baseMembersCache.set(scoped.context, base)
  return scoped
}

export const baseMembersOf = (context: StringContext): ReadonlyMap<string, string> =>
  baseMembersCache.get(context) ?? context.members

export const createStringTable = (api: TypeScriptApi): StringTable => {
  const members = new Map<string, string>()
  const partialMembers = new Map<string, string>()
  const contexts = new Map<ts.SourceFile, StringContext>()
  partialRegistry.set(members, partialMembers)

  const addStatics = (source: ts.SourceFile): void => {
    const statics = withStaticMembers(api, source, { members, partialMembers })
    for (const [key, value] of statics.members) members.set(key, value)
    for (const [key, value] of statics.partialMembers) if (!members.has(key)) partialMembers.set(key, value)
  }

  const add = (source: ts.SourceFile): void => {
    for (const [key, value] of collectStringMembers(api, source)) members.set(key, value)
    addStatics(source)
    contexts.clear()
  }

  const contextFor = (source: ts.SourceFile): StringContext => {
    const cached = contexts.get(source)
    if (cached !== undefined) return cached

    const context: StringContext = { constants: collectStringConstants(api, source, members), members, partialMembers }
    contexts.set(source, context)
    return context
  }

  return {
    add,
    get: (key) => members.get(key) ?? null,
    has: (key) => members.has(key),
    size: () => members.size,
    entries: () => sortedEntries(Object.fromEntries(members)).map(([key, value]) => [key, value] as const),
    members,
    partialMembers,
    contextFor,
  }
}
