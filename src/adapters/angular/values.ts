import type ts from "typescript"
import { createArrayFolder, createValueResolver, negateCondition } from "../array-values.js"
import type { ArrayElement, ArrayFold, Located, UnreadableItem } from "../array-values.js"
import type { DiscoverContext, TsNode } from "../types.js"
import { createStringValueReader, importedBindingOf } from "../values.js"

export type Env = ReadonlyMap<TsNode, Located>

export type AngularUnreadable = UnreadableItem & { readonly dynamic?: true }

export type AngularElement = ArrayElement & { readonly env: Env }

export type AngularFold = {
  readonly elements: readonly AngularElement[]
  readonly unreadable: readonly AngularUnreadable[]
}

export type BoundObject = Located & { readonly node: ts.ObjectLiteralExpression; readonly env: Env }

export type ObjectMember = {
  readonly name: string
  readonly value: Located
  readonly conditions: readonly string[]
  readonly env: Env
}

export type MemberList = {
  readonly members: readonly ObjectMember[]
  readonly unreadable: readonly AngularUnreadable[]
}

export const EMPTY_ENV: Env = new Map()

const MAX_DEPTH = 16

const EMPTY_FOLD: AngularFold = { elements: [], unreadable: [] }

const EMPTY_MEMBERS: MemberList = { members: [], unreadable: [] }

type Trail = readonly TsNode[]

type FunctionNode = ts.SignatureDeclaration & { readonly body?: ts.Node }

type Scope = ts.Block | ts.SourceFile

type Target = { readonly name: string; readonly path: readonly string[]; readonly scope: Scope }

type CallTarget = { readonly returned: Located; readonly env: Env }

type ScanItem = {
  readonly kind: "expression" | "loop"
  readonly statement: ts.Statement
  readonly conditions: readonly string[]
}

const combine = (folds: readonly AngularFold[]): AngularFold => ({
  elements: folds.flatMap((fold) => fold.elements),
  unreadable: folds.flatMap((fold) => fold.unreadable),
})

const combineMembers = (lists: readonly MemberList[]): MemberList => ({
  members: lists.flatMap((list) => list.members),
  unreadable: lists.flatMap((list) => list.unreadable),
})

const withConditions = (fold: AngularFold, conditions: readonly string[]): AngularFold =>
  conditions.length === 0
    ? fold
    : {
        ...fold,
        elements: fold.elements.map((element) => ({ ...element, conditions: [...conditions, ...element.conditions] })),
      }

const sameChain = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index])

const overrides =
  (next: ObjectMember) =>
  (earlier: ObjectMember): boolean =>
    earlier.name === next.name && next.conditions.every((condition) => earlier.conditions.includes(condition))

const mergeMember = (members: readonly ObjectMember[], next: ObjectMember): readonly ObjectMember[] => {
  const replaced = overrides(next)
  const index = members.findIndex(replaced)
  if (index === -1) return [...members, next]
  return members.flatMap((member, at) => {
    if (at === index) return [next]
    return replaced(member) ? [] : [member]
  })
}

const isAngularElement = (element: ArrayElement): element is AngularElement => "env" in element

export const createAngularValues = (ctx: DiscoverContext) => {
  const resolver = createValueResolver(ctx)
  const readString = createStringValueReader(ctx)

  const isFunctionLike = (node: TsNode): node is FunctionNode =>
    ctx.ts.isArrowFunction(node) ||
    ctx.ts.isFunctionExpression(node) ||
    ctx.ts.isFunctionDeclaration(node) ||
    ctx.ts.isMethodDeclaration(node)

  const isScope = (node: TsNode): node is Scope => ctx.ts.isBlock(node) || ctx.ts.isSourceFile(node)

  const isLoop = (statement: ts.Statement): boolean =>
    ctx.ts.isForOfStatement(statement) ||
    ctx.ts.isForInStatement(statement) ||
    ctx.ts.isForStatement(statement) ||
    ctx.ts.isWhileStatement(statement) ||
    ctx.ts.isDoStatement(statement)

  const isWrapper = (node: TsNode): boolean =>
    ctx.ts.isParenthesizedExpression(node) ||
    ctx.ts.isAsExpression(node) ||
    ctx.ts.isSatisfiesExpression(node) ||
    ctx.ts.isNonNullExpression(node)

  const keyOf = (name: ts.PropertyName): string | null => {
    if (ctx.ts.isNumericLiteral(name)) return name.text
    return ctx.ast.asIdentifier(name)?.text ?? ctx.ast.asStringLiteralLike(name)?.text ?? null
  }

  const declares = (scope: Scope, name: string): boolean =>
    scope.statements.some(
      (statement) =>
        (ctx.ts.isFunctionDeclaration(statement) && statement.name?.text === name) ||
        (ctx.ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (declaration) => ctx.ast.asIdentifier(declaration.name)?.text === name,
          )),
    )

  const parameterNamed = (node: TsNode | undefined, name: string): ts.ParameterDeclaration | null => {
    if (node === undefined) return null
    if (ctx.ts.isBlock(node) && declares(node, name)) return null
    const parameter = isFunctionLike(node)
      ? node.parameters.find((candidate) => ctx.ast.asIdentifier(candidate.name)?.text === name)
      : undefined
    return parameter ?? parameterNamed(node.parent, name)
  }

  const boundValue = (identifier: ts.Identifier, env: Env): Located | null => {
    const parameter = parameterNamed(identifier.parent, identifier.text)
    return parameter === null ? null : (env.get(parameter) ?? null)
  }

  const isConstDeclaration = (declaration: ts.VariableDeclaration): boolean =>
    ctx.ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ctx.ts.NodeFlags.Const) !== 0

  const constValueOf = (declaration: TsNode, file: string): Located | null => {
    if (ctx.ts.isFunctionDeclaration(declaration)) return { node: declaration, file }
    if (ctx.ts.isExportAssignment(declaration)) return { node: declaration.expression, file }
    if (!ctx.ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return null
    return isConstDeclaration(declaration) ? { node: declaration.initializer, file } : null
  }

  const reexportedValue = (identifier: ts.Identifier, file: string): Located | null => {
    if (parameterNamed(identifier.parent, identifier.text) !== null) return null
    const imported = importedBindingOf(ctx.bindingsFor(file).get(identifier.text))
    const module = imported === null ? null : ctx.resolveModule(file, imported.module)
    if (imported === null || module === null) return null
    const declared = ctx.declaredExport(module, imported.imported)
    const source = ctx.sourceFile(declared.file)
    const declaration = source === null ? null : ctx.ast.declarationOf(source, declared.exportName)
    return declaration === null ? null : constValueOf(declaration, declared.file)
  }

  const valueOf = (identifier: ts.Identifier, file: string, env: Env = EMPTY_ENV): Located | null =>
    boundValue(identifier, env) ?? resolver.valueOf(identifier, file) ?? reexportedValue(identifier, file)

  const argumentValue = (argument: ts.Expression, file: string, env: Env): Located => {
    const inner = ctx.unwrap(argument)
    const identifier = ctx.ast.asIdentifier(inner)
    const bound = identifier === null ? null : boundValue(identifier, env)
    return bound ?? { node: inner, file }
  }

  const parameterBinding = (
    call: ts.CallExpression,
    file: string,
    env: Env,
    fnFile: string,
  ): ((parameter: ts.ParameterDeclaration, index: number) => readonly (readonly [TsNode, Located])[]) => {
    const spreadAt = call.arguments.findIndex((argument) => ctx.ts.isSpreadElement(argument))
    return (parameter, index) => {
      if (spreadAt !== -1 && index >= spreadAt) return []
      const argument = call.arguments[index]
      if (argument !== undefined) return [[parameter, argumentValue(argument, file, env)]]
      if (parameter.initializer === undefined) return []
      return [[parameter, { node: ctx.unwrap(parameter.initializer), file: fnFile }]]
    }
  }

  const bindCall = (call: ts.CallExpression, file: string, env: Env, fn: FunctionNode, fnFile: string): Env =>
    new Map([...env, ...fn.parameters.flatMap(parameterBinding(call, file, env, fnFile))])

  const callOf = (node: TsNode): ts.CallExpression | null =>
    ctx.ast.asCallExpression(ctx.ts.isAwaitExpression(node) ? ctx.unwrap(node.expression) : node)

  const calleeOf = (call: ts.CallExpression, file: string, env: Env): CallTarget | null => {
    const fn = resolver.functionOf(call.expression, file)
    if (fn === null || !isFunctionLike(fn.node)) return null
    const returned = resolver.returnedBy(fn.node)
    if (returned === null) return null
    return { returned: { node: returned, file: fn.file }, env: bindCall(call, file, env, fn.node, fn.file) }
  }

  const booleanOf = (node: TsNode, env: Env): boolean | null => {
    const inner = ctx.unwrap(node)
    if (inner.kind === ctx.ts.SyntaxKind.TrueKeyword) return true
    if (inner.kind === ctx.ts.SyntaxKind.FalseKeyword) return false
    if (ctx.ts.isPrefixUnaryExpression(inner) && inner.operator === ctx.ts.SyntaxKind.ExclamationToken) {
      const operand = booleanOf(inner.operand, env)
      return operand === null ? null : !operand
    }
    const identifier = ctx.ast.asIdentifier(inner)
    const bound = identifier === null ? null : boundValue(identifier, env)
    return bound === null ? null : booleanOf(bound.node, EMPTY_ENV)
  }

  const chainOf = (node: TsNode): readonly string[] | null => {
    const inner = ctx.unwrap(node)
    const identifier = ctx.ast.asIdentifier(inner)
    if (identifier !== null) return [identifier.text]
    const access = ctx.ast.asPropertyAccess(inner)
    if (access === null) return null
    const head = chainOf(access.expression)
    return head === null ? null : [...head, access.name.text]
  }

  const pushChainOf = (call: ts.CallExpression): readonly string[] | null => {
    const callee = ctx.ast.asPropertyAccess(call.expression)
    if (callee === null || callee.name.text !== "push") return null
    return chainOf(callee.expression)
  }

  const isPushInto =
    (chain: readonly string[]) =>
    (node: TsNode): node is ts.CallExpression => {
      const call = ctx.ast.asCallExpression(node)
      const target = call === null ? null : pushChainOf(call)
      return target !== null && sameChain(target, chain)
    }

  const firstPushIn = (node: TsNode, chain: readonly string[]): ts.CallExpression | null => {
    const matches = isPushInto(chain)
    const visit = (candidate: TsNode): ts.CallExpression | null =>
      matches(candidate) ? candidate : (candidate.forEachChild(visit) ?? null)
    return visit(node)
  }

  const declaringScope = (node: TsNode | undefined, name: string): Scope | null => {
    if (node === undefined) return null
    if (isScope(node) && declares(node, name)) return node
    return declaringScope(node.parent, name)
  }

  const targetFrom = (name: string, path: readonly string[], at: TsNode): Target | null => {
    const scope = declaringScope(at, name)
    return scope === null ? null : { name, path, scope }
  }

  const targetOf = (node: TsNode, path: readonly string[] = []): Target | null => {
    const parent = node.parent
    if (parent === undefined) return null
    if (isWrapper(parent)) return targetOf(parent, path)
    if (ctx.ts.isPropertyAssignment(parent) && parent.initializer === node) {
      const key = keyOf(parent.name)
      return key === null ? null : targetOf(parent.parent, [key, ...path])
    }
    if (ctx.ts.isVariableDeclaration(parent) && parent.initializer === node) {
      const name = ctx.ast.asIdentifier(parent.name)?.text
      return name === undefined ? null : targetFrom(name, path, parent)
    }
    const assigned =
      ctx.ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ctx.ts.SyntaxKind.EqualsToken &&
      parent.right === node
    const chain = assigned ? chainOf(parent.left) : null
    const [name, ...rest] = chain ?? []
    return name === undefined ? null : targetFrom(name, [...rest, ...path], parent)
  }

  const branchStatements = (statement: ts.Statement | undefined): readonly ts.Statement[] => {
    if (statement === undefined) return []
    return ctx.ts.isBlock(statement) ? statement.statements : [statement]
  }

  const isForEach = (statement: ts.Statement): boolean => {
    if (!ctx.ts.isExpressionStatement(statement)) return false
    const call = ctx.ast.asCallExpression(statement.expression)
    return ctx.ast.asPropertyAccess(call?.expression)?.name.text === "forEach"
  }

  const straightLine = (
    statements: readonly ts.Statement[],
    env: Env,
    conditions: readonly string[],
  ): readonly ScanItem[] =>
    statements.flatMap((statement): readonly ScanItem[] => {
      if (ctx.ts.isIfStatement(statement)) return ifItems(statement, env, conditions)
      if (isLoop(statement) || isForEach(statement)) return [{ kind: "loop", statement, conditions }]
      return ctx.ts.isExpressionStatement(statement) ? [{ kind: "expression", statement, conditions }] : []
    })

  const ifItems = (statement: ts.IfStatement, env: Env, conditions: readonly string[]): readonly ScanItem[] => {
    const thenStatements = branchStatements(statement.thenStatement)
    const elseStatements = branchStatements(statement.elseStatement)
    const verdict = booleanOf(statement.expression, env)
    if (verdict === true) return straightLine(thenStatements, env, conditions)
    if (verdict === false) return straightLine(elseStatements, env, conditions)
    const condition = ctx.ast.conditionText(statement.expression)
    return [
      ...straightLine(thenStatements, env, [...conditions, condition]),
      ...straightLine(elseStatements, env, [...conditions, negateCondition(condition)]),
    ]
  }

  const statementsOf = (scope: TsNode): readonly ts.Statement[] => {
    if (isScope(scope)) return scope.statements
    const body = isFunctionLike(scope) ? scope.body : undefined
    return body !== undefined && ctx.ts.isBlock(body) ? body.statements : []
  }

  const unreadable = (node: TsNode, file: string): AngularFold => ({
    elements: [],
    unreadable: [resolver.unreadableAt(node, file)],
  })

  const element = (node: TsNode, file: string, env: Env, conditions: readonly string[]): AngularFold => ({
    elements: [{ node: ctx.unwrap(node), file, conditions, env }],
    unreadable: [],
  })

  const dynamicPush = (item: ScanItem, chain: readonly string[], file: string): AngularFold => {
    const push = firstPushIn(item.statement, chain)
    if (push === null) return EMPTY_FOLD
    return { elements: [], unreadable: [{ ...resolver.unreadableAt(push, file), dynamic: true }] }
  }

  const pushedArguments = (
    call: ts.CallExpression,
    file: string,
    env: Env,
    conditions: readonly string[],
    trail: Trail,
  ): AngularFold =>
    combine(
      call.arguments.map((argument) =>
        ctx.ts.isSpreadElement(argument)
          ? foldArray(argument.expression, file, env, conditions, trail)
          : element(argument, file, env, conditions),
      ),
    )

  const statementPush = (
    item: ScanItem,
    chain: readonly string[],
    file: string,
    env: Env,
    trail: Trail,
  ): AngularFold => {
    if (!ctx.ts.isExpressionStatement(item.statement)) return EMPTY_FOLD
    const call = ctx.ast.asCallExpression(item.statement.expression)
    if (call === null || !isPushInto(chain)(call)) return EMPTY_FOLD
    return pushedArguments(call, file, env, item.conditions, trail)
  }

  const scanPushes = (
    chain: readonly string[],
    scope: TsNode,
    file: string,
    env: Env,
    trail: Trail,
  ): AngularFold =>
    combine(
      straightLine(statementsOf(scope), env, []).map((item) =>
        item.kind === "loop" ? dynamicPush(item, chain, file) : statementPush(item, chain, file, env, trail),
      ),
    )

  const pushesTargeting = (
    node: TsNode,
    file: string,
    env: Env,
    conditions: readonly string[],
    trail: Trail,
  ): AngularFold => {
    const target = targetOf(node)
    if (target === null) return EMPTY_FOLD
    return withConditions(scanPushes([target.name, ...target.path], target.scope, file, env, trail), conditions)
  }

  const callFold = (
    call: ts.CallExpression,
    file: string,
    env: Env,
    conditions: readonly string[],
    trail: Trail,
  ): AngularFold => {
    const target = calleeOf(call, file, env)
    if (target === null) return unreadable(call, file)
    return withConditions(foldArray(target.returned.node, target.returned.file, target.env, [], trail), conditions)
  }

  const attachEnv = (fold: ArrayFold, env: Env): AngularFold => ({
    elements: fold.elements.map((item) => (isAngularElement(item) ? item : { ...item, env })),
    unreadable: fold.unreadable,
  })

  const delegated = (
    node: TsNode,
    file: string,
    env: Env,
    conditions: readonly string[],
    trail: Trail,
  ): AngularFold => {
    const folder = createArrayFolder(ctx, resolver, {
      onCall: (call, callFile) => callFold(call, callFile, env, conditions, trail),
    })
    return attachEnv(folder(node, file), env)
  }

  const literalElements = (
    array: ts.ArrayLiteralExpression,
    file: string,
    env: Env,
    conditions: readonly string[],
    trail: Trail,
  ): AngularFold =>
    combine(
      array.elements.map((item) => {
        if (ctx.ts.isOmittedExpression(item)) return EMPTY_FOLD
        if (ctx.ts.isSpreadElement(item)) return foldArray(item.expression, file, env, conditions, trail)
        return element(item, file, env, conditions)
      }),
    )

  const baseFold = (
    inner: TsNode,
    file: string,
    env: Env,
    conditions: readonly string[],
    trail: Trail,
  ): AngularFold => {
    const array = ctx.ast.asArrayLiteral(inner)
    if (array !== null) return literalElements(array, file, env, conditions, trail)
    if (ctx.ts.isConditionalExpression(inner)) {
      const condition = ctx.ast.conditionText(inner.condition)
      return combine([
        foldArray(inner.whenTrue, file, env, [...conditions, condition], trail),
        foldArray(inner.whenFalse, file, env, [...conditions, negateCondition(condition)], trail),
      ])
    }
    const access = ctx.ast.asPropertyAccess(inner)
    if (access !== null) return accessFold(access, file, env, conditions, trail)
    const identifier = ctx.ast.asIdentifier(inner)
    if (identifier === null) return delegated(inner, file, env, conditions, trail)
    const bound = valueOf(identifier, file, env)
    return bound === null ? unreadable(inner, file) : foldArray(bound.node, bound.file, env, conditions, trail)
  }

  const accessFold = (
    access: ts.PropertyAccessExpression,
    file: string,
    env: Env,
    conditions: readonly string[],
    trail: Trail,
  ): AngularFold => {
    const members = accessedMembers(access, file, env, trail)
    if (members.length === 0) return delegated(access, file, env, conditions, trail)
    return combine(
      members.map((item) =>
        foldArray(item.value.node, item.value.file, item.env, [...conditions, ...item.conditions], trail),
      ),
    )
  }

  const foldArray = (
    node: TsNode,
    file: string,
    env: Env,
    conditions: readonly string[],
    trail: Trail,
  ): AngularFold => {
    const inner = ctx.unwrap(node)
    if (trail.includes(inner) || trail.length > MAX_DEPTH) return unreadable(inner, file)
    const next = [...trail, inner]
    return combine([
      baseFold(inner, file, env, conditions, next),
      pushesTargeting(inner, file, env, conditions, next),
    ])
  }

  const boundObject = (node: TsNode, file: string, env: Env, trail: Trail): BoundObject | null => {
    const inner = ctx.unwrap(node)
    if (trail.includes(inner) || trail.length > MAX_DEPTH) return null
    const next = [...trail, inner]
    const object = ctx.ast.asObjectLiteral(inner)
    if (object !== null) return { node: object, file, env }
    const identifier = ctx.ast.asIdentifier(inner)
    if (identifier !== null) {
      const bound = valueOf(identifier, file, env)
      return bound === null ? null : boundObject(bound.node, bound.file, env, next)
    }
    const access = ctx.ast.asPropertyAccess(inner)
    if (access !== null) {
      const only = soleMember(accessedMembers(access, file, env, next))
      return only === null ? null : boundObject(only.value.node, only.value.file, only.env, next)
    }
    const call = callOf(inner)
    const target = call === null ? null : calleeOf(call, file, env)
    return target === null ? null : boundObject(target.returned.node, target.returned.file, target.env, next)
  }

  const accessedMembers = (
    access: ts.PropertyAccessExpression,
    file: string,
    env: Env,
    trail: Trail,
  ): readonly ObjectMember[] =>
    readMembers(access.expression, file, env, [], trail).members.filter((item) => item.name === access.name.text)

  const soleMember = (members: readonly ObjectMember[]): ObjectMember | null => {
    const [only, ...rest] = members
    if (only === undefined || rest.length > 0 || only.conditions.length > 0) return null
    return only
  }

  const stringAt = (node: TsNode, file: string, env: Env, trail: Trail): string | null => {
    const direct = readString(node, file)
    if (direct !== null) return direct
    const inner = ctx.unwrap(node)
    if (trail.includes(inner) || trail.length > MAX_DEPTH) return null
    const next = [...trail, inner]
    const identifier = ctx.ast.asIdentifier(inner)
    const bound = identifier === null ? null : valueOf(identifier, file, env)
    if (bound !== null) return stringAt(bound.node, bound.file, env, next)
    const access = ctx.ast.asPropertyAccess(inner)
    const only = access === null ? null : soleMember(accessedMembers(access, file, env, next))
    return only === null ? null : stringAt(only.value.node, only.value.file, only.env, next)
  }

  const member = (name: string, node: TsNode, file: string, env: Env, conditions: readonly string[]): MemberList => ({
    members: [{ name, value: { node: ctx.unwrap(node), file }, conditions, env }],
    unreadable: [],
  })

  const unreadableMembers = (node: TsNode, file: string): MemberList => ({
    members: [],
    unreadable: [resolver.unreadableAt(node, file)],
  })

  const spreadMembers = (
    node: TsNode,
    file: string,
    env: Env,
    conditions: readonly string[],
    trail: Trail,
  ): MemberList => {
    const inner = ctx.unwrap(node)
    if (!ctx.ts.isConditionalExpression(inner)) return readMembers(inner, file, env, conditions, trail)
    const condition = ctx.ast.conditionText(inner.condition)
    return combineMembers([
      spreadMembers(inner.whenTrue, file, env, [...conditions, condition], trail),
      spreadMembers(inner.whenFalse, file, env, [...conditions, negateCondition(condition)], trail),
    ])
  }

  const propertyMembers = (
    property: ts.ObjectLiteralElementLike,
    object: BoundObject,
    conditions: readonly string[],
    trail: Trail,
  ): MemberList => {
    if (ctx.ts.isSpreadAssignment(property))
      return spreadMembers(property.expression, object.file, object.env, conditions, trail)
    const key = keyOf(property.name)
    if (key === null) return unreadableMembers(property, object.file)
    if (ctx.ts.isPropertyAssignment(property))
      return member(key, property.initializer, object.file, object.env, conditions)
    if (ctx.ts.isShorthandPropertyAssignment(property))
      return member(key, property.name, object.file, object.env, conditions)
    return member(key, property, object.file, object.env, conditions)
  }

  const assignedMember =
    (chain: readonly string[], object: BoundObject, conditions: readonly string[]) =>
    (item: ScanItem): MemberList => {
      if (item.kind === "loop" || !ctx.ts.isExpressionStatement(item.statement)) return EMPTY_MEMBERS
      const assignment = item.statement.expression
      if (!ctx.ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ctx.ts.SyntaxKind.EqualsToken)
        return EMPTY_MEMBERS
      const left = chainOf(assignment.left)
      const name = left?.[chain.length]
      if (left === null || name === undefined || left.length !== chain.length + 1) return EMPTY_MEMBERS
      if (!sameChain(left.slice(0, chain.length), chain)) return EMPTY_MEMBERS
      return member(name, assignment.right, object.file, object.env, [...conditions, ...item.conditions])
    }

  const assignedMembers = (object: BoundObject, conditions: readonly string[]): MemberList => {
    const target = targetOf(object.node)
    if (target === null) return EMPTY_MEMBERS
    const chain = [target.name, ...target.path]
    return combineMembers(
      straightLine(statementsOf(target.scope), object.env, []).map(assignedMember(chain, object, conditions)),
    )
  }

  const readMembers = (
    node: TsNode,
    file: string,
    env: Env,
    conditions: readonly string[],
    trail: Trail,
  ): MemberList => {
    const object = boundObject(node, file, env, trail)
    if (object === null) return unreadableMembers(node, file)
    const next = [...trail, object.node]
    const lists = [
      ...object.node.properties.map((property) => propertyMembers(property, object, conditions, next)),
      assignedMembers(object, conditions),
    ]
    const merged = combineMembers(lists)
    return { members: merged.members.reduce(mergeMember, []), unreadable: merged.unreadable }
  }

  const followed = (located: Located, depth: number): Located => {
    const inner = ctx.unwrap(located.node)
    const identifier = ctx.ast.asIdentifier(inner)
    const bound = identifier === null || depth > MAX_DEPTH ? null : resolver.valueOf(identifier, located.file)
    return bound === null ? { node: inner, file: located.file } : followed(bound, depth + 1)
  }

  const declaredValue = (declaration: TsNode, file: string): Located | null => {
    if (ctx.ts.isExportAssignment(declaration)) return followed({ node: declaration.expression, file }, 0)
    if (ctx.ts.isVariableDeclaration(declaration))
      return declaration.initializer === undefined ? null : { node: ctx.unwrap(declaration.initializer), file }
    return { node: declaration, file }
  }

  const exportedValue = (file: string, exportName: string): Located | null => {
    const declaring = ctx.declarationFile(file, exportName)
    const source = ctx.sourceFile(declaring)
    const declaration = source === null ? null : ctx.ast.declarationOf(source, exportName)
    return declaration === null ? null : declaredValue(declaration, declaring)
  }

  return {
    resolver,
    valueOf,
    objectOf: (node: TsNode, file: string, env: Env = EMPTY_ENV): BoundObject | null =>
      boundObject(node, file, env, []),
    membersOf: (node: TsNode, file: string, env: Env = EMPTY_ENV): MemberList =>
      readMembers(node, file, env, [], []),
    pushesInto: (
      name: string,
      path: readonly string[],
      scope: TsNode,
      file: string,
      env: Env = EMPTY_ENV,
    ): AngularFold => scanPushes([name, ...path], scope, file, env, []),
    arrayOf: (node: TsNode, file: string, env: Env = EMPTY_ENV): AngularFold => foldArray(node, file, env, [], []),
    stringOf: (node: TsNode, file: string, env: Env = EMPTY_ENV): string | null => stringAt(node, file, env, []),
    exportedValue,
  }
}

export type AngularValues = ReturnType<typeof createAngularValues>
