import * as path from "node:path"
import type ts from "typescript"
import type { DiscoverContext, TsNode } from "./types.js"
import { importedBindingOf } from "./values.js"

/**
 * Folds an expression to the elements of the array it statically denotes. A reader built on this (the
 * `next.config` redirect reader today) decides what an element means; this module only decides which
 * elements exist, under which ternary branch, and which parts it could not read. It never evaluates.
 */

export type Located = {
  readonly node: TsNode
  readonly file: string
}

export type ArrayElement = Located & {
  /** Ternary branch texts on the way to this element, outermost first: `c` for the true branch, `!c` for the false one. */
  readonly conditions: readonly string[]
}

export type UnreadableItem = {
  readonly file: string
  readonly line: number
  readonly text: string
}

export type ArrayFold = {
  readonly elements: readonly ArrayElement[]
  readonly unreadable: readonly UnreadableItem[]
}

export type ValueResolver = {
  /** The value a name is bound to: an enclosing `const`, a module-level `const`, or an imported one. */
  readonly valueOf: (identifier: ts.Identifier, file: string) => Located | null
  /** A function expression, or a name bound to one. */
  readonly functionOf: (node: TsNode, file: string) => Located | null
  /** The ONE expression a function returns; a second `return` is a branch a static reader cannot pick. */
  readonly returnedBy: (fn: TsNode) => TsNode | null
  readonly unreadableAt: (node: TsNode, file: string) => UnreadableItem
}

export type ArrayFolder = (node: TsNode, file: string) => ArrayFold

export type ArrayFolderOptions = {
  /** Interprets a call before the single-return-function fold; `null` falls through to it. */
  readonly onCall?: (call: ts.CallExpression, file: string) => ArrayFold | null
}

const MAX_FOLD_DEPTH = 16

const ROOT_RELATIVE_SUFFIXES = ["", ".ts", ".mts", ".js", ".mjs"] as const

const UNREADABLE_TEXT_MAX = 80

const SIMPLE_CONDITION = /^[\w$.]+$/

const EMPTY_FOLD: ArrayFold = { elements: [], unreadable: [] }

export const negateCondition = (condition: string): string =>
  SIMPLE_CONDITION.test(condition) ? `!${condition}` : `!(${condition})`

const combine = (folds: readonly ArrayFold[]): ArrayFold => ({
  elements: folds.flatMap((fold) => fold.elements),
  unreadable: folds.flatMap((fold) => fold.unreadable),
})

type FunctionNode = ts.SignatureDeclaration & { readonly body?: ts.Node }

export const createValueResolver = (ctx: DiscoverContext): ValueResolver => {
  const isFunctionLike = (node: TsNode): node is FunctionNode =>
    ctx.ts.isArrowFunction(node) ||
    ctx.ts.isFunctionExpression(node) ||
    ctx.ts.isFunctionDeclaration(node) ||
    ctx.ts.isMethodDeclaration(node)

  const isConstDeclaration = (declaration: ts.VariableDeclaration): boolean =>
    ctx.ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ctx.ts.NodeFlags.Const) !== 0

  const valueOfDeclaration = (declaration: TsNode, file: string): Located | null => {
    if (ctx.ts.isFunctionDeclaration(declaration)) return { node: declaration, file }
    if (ctx.ts.isExportAssignment(declaration)) return { node: declaration.expression, file }
    if (!ctx.ts.isVariableDeclaration(declaration) || !isConstDeclaration(declaration)) return null
    return declaration.initializer === undefined ? null : { node: declaration.initializer, file }
  }

  const declaresParameter = (node: TsNode, name: string): boolean =>
    isFunctionLike(node) && node.parameters.some((parameter) => ctx.ast.asIdentifier(parameter.name)?.text === name)

  const declarationIn = (statements: readonly ts.Statement[], name: string): TsNode | null => {
    for (const statement of statements) {
      if (ctx.ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement
      if (!ctx.ts.isVariableStatement(statement)) continue
      const declaration = statement.declarationList.declarations.find(
        (candidate) => ctx.ast.asIdentifier(candidate.name)?.text === name,
      )
      if (declaration !== undefined) return declaration
    }
    return null
  }

  /** A declaration in a block enclosing the use; `undefined` = keep looking at module scope, `null` = shadowed. */
  const enclosingDeclaration = (identifier: ts.Identifier): TsNode | null | undefined => {
    for (let scope: TsNode | undefined = identifier.parent; scope !== undefined; scope = scope.parent) {
      if (declaresParameter(scope, identifier.text)) return null
      if (!ctx.ts.isBlock(scope)) continue
      const found = declarationIn(scope.statements, identifier.text)
      if (found !== null) return found
    }
    return undefined
  }

  const rootRelativeModule = (file: string, spec: string): string | null => {
    if (!spec.startsWith(".")) return null
    const base = path.posix.join(path.posix.dirname(file), spec)
    if (base.startsWith("../")) return null
    return (
      ROOT_RELATIVE_SUFFIXES.map((suffix) => `${base}${suffix}`).find(
        (candidate) => ctx.sourceFile(candidate) !== null,
      ) ?? null
    )
  }

  const moduleFile = (file: string, spec: string): string | null =>
    ctx.resolveModule(file, spec) ?? rootRelativeModule(file, spec)

  const declarationNamed = (name: string, file: string): Located | null => {
    const imported = importedBindingOf(ctx.bindingsFor(file).get(name))
    const declaring = imported === null ? file : moduleFile(file, imported.module)
    if (declaring === null) return null
    const source = ctx.sourceFile(declaring)
    const declaration = source === null ? null : ctx.ast.declarationOf(source, imported?.imported ?? name)
    return declaration === null ? null : { node: declaration, file: declaring }
  }

  const valueOf = (identifier: ts.Identifier, file: string): Located | null => {
    const local = enclosingDeclaration(identifier)
    if (local === null) return null
    if (local !== undefined) return valueOfDeclaration(local, file)
    const declared = declarationNamed(identifier.text, file)
    return declared === null ? null : valueOfDeclaration(declared.node, declared.file)
  }

  const functionOf = (node: TsNode, file: string): Located | null => {
    const inner = ctx.unwrap(node)
    if (isFunctionLike(inner)) return { node: inner, file }
    const identifier = ctx.ast.asIdentifier(inner)
    const bound = identifier === null ? null : valueOf(identifier, file)
    if (bound === null) return null
    const value = ctx.unwrap(bound.node)
    return isFunctionLike(value) ? { node: value, file: bound.file } : null
  }

  const returnsIn = (body: TsNode): readonly ts.ReturnStatement[] => {
    const found: ts.ReturnStatement[] = []
    const visit = (node: TsNode): void => {
      if (ctx.ts.isReturnStatement(node)) found.push(node)
      if (!isFunctionLike(node)) node.forEachChild(visit)
    }
    body.forEachChild(visit)
    return found
  }

  const returnedBy = (fn: TsNode): TsNode | null => {
    const body = isFunctionLike(fn) ? fn.body : undefined
    if (body === undefined) return null
    if (!ctx.ts.isBlock(body)) return ctx.unwrap(body)
    const returns = returnsIn(body)
    const only = returns.length === 1 ? returns[0]?.expression : undefined
    return only === undefined ? null : ctx.unwrap(only)
  }

  const unreadableAt = (node: TsNode, file: string): UnreadableItem => ({
    file,
    line: ctx.lineOf(file, node),
    text: ctx.ast.conditionText(node).slice(0, UNREADABLE_TEXT_MAX),
  })

  return { valueOf, functionOf, returnedBy, unreadableAt }
}

/**
 * Handles an array literal, a spread of a local or imported `const`, `c ? A : B` (the union of both
 * branches, each element tagged `c` / `!c`) and a call to a single-return function. Anything else is
 * one unreadable item at its own `file:line` — never a silent drop.
 */
export const createArrayFolder = (
  ctx: DiscoverContext,
  resolver = createValueResolver(ctx),
  options: ArrayFolderOptions = {},
): ArrayFolder => {
  const unreadable = (node: TsNode, file: string): ArrayFold => ({
    elements: [],
    unreadable: [resolver.unreadableAt(node, file)],
  })

  const hookedCall = (node: TsNode, file: string): ArrayFold | null => {
    if (options.onCall === undefined) return null
    const target = ctx.ts.isAwaitExpression(node) ? ctx.unwrap(node.expression) : node
    const call = ctx.ast.asCallExpression(target)
    return call === null ? null : options.onCall(call, file)
  }

  const fold = (node: TsNode, file: string, conditions: readonly string[], trail: readonly TsNode[]): ArrayFold => {
    const inner = ctx.unwrap(node)
    if (trail.includes(inner) || trail.length > MAX_FOLD_DEPTH) return unreadable(inner, file)
    const next = [...trail, inner]

    const array = ctx.ast.asArrayLiteral(inner)
    if (array !== null)
      return combine(array.elements.map((element) => foldElement(element, file, conditions, next)))

    if (ctx.ts.isConditionalExpression(inner)) {
      const condition = ctx.ast.conditionText(inner.condition)
      return combine([
        fold(inner.whenTrue, file, [...conditions, condition], next),
        fold(inner.whenFalse, file, [...conditions, negateCondition(condition)], next),
      ])
    }

    const identifier = ctx.ast.asIdentifier(inner)
    if (identifier !== null) {
      const bound = resolver.valueOf(identifier, file)
      return bound === null ? unreadable(inner, file) : fold(bound.node, bound.file, conditions, next)
    }

    const hooked = hookedCall(inner, file)
    if (hooked !== null) return hooked

    const call = ctx.ast.asCallExpression(inner)
    const fn = call === null ? null : resolver.functionOf(call.expression, file)
    const returned = fn === null ? null : resolver.returnedBy(fn.node)
    if (fn === null || returned === null) return unreadable(inner, file)
    return fold(returned, fn.file, conditions, next)
  }

  const foldElement = (
    element: ts.Expression,
    file: string,
    conditions: readonly string[],
    trail: readonly TsNode[],
  ): ArrayFold => {
    if (ctx.ts.isOmittedExpression(element)) return EMPTY_FOLD
    if (ctx.ts.isSpreadElement(element)) return fold(element.expression, file, conditions, trail)
    return { elements: [{ node: ctx.unwrap(element), file, conditions }], unreadable: [] }
  }

  return (node, file) => fold(node, file, [], [])
}
