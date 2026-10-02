import type ts from "typescript"
import type { Located, ValueResolver } from "./array-values.js"
import type { DiscoverContext, TsNode } from "./types.js"

/**
 * Reads a project config file (`next.config`, `react-router.config`, `remix.config`, ...) without
 * evaluating it: finds what the file exports, unwraps wrappers down to the config object literal and
 * reads literal members of it.
 */

const MAX_UNWRAP_DEPTH = 16

export type LiteralStringArray =
  | { readonly kind: "absent" }
  | { readonly kind: "literal"; readonly values: readonly string[] }
  | { readonly kind: "dynamic"; readonly node: TsNode }

const ABSENT: LiteralStringArray = { kind: "absent" }

export const configFileOf = (ctx: DiscoverContext, candidates: readonly string[]): string | null =>
  candidates.find((file) => ctx.exists(file)) ?? null

export const createConfigFileReader = (ctx: DiscoverContext, resolver: ValueResolver) => {
  const isModuleExports = (node: TsNode): boolean => {
    const access = ctx.ast.asPropertyAccess(node)
    return access !== null && ctx.ast.asIdentifier(access.expression)?.text === "module" && access.name.text === "exports"
  }

  const moduleExportsOf = (source: ts.SourceFile): TsNode | null => {
    for (const statement of source.statements) {
      if (!ctx.ts.isExpressionStatement(statement)) continue
      const assignment = statement.expression
      if (!ctx.ts.isBinaryExpression(assignment)) continue
      if (assignment.operatorToken.kind !== ctx.ts.SyntaxKind.EqualsToken) continue
      if (isModuleExports(assignment.left)) return assignment.right
    }
    return null
  }

  const exportedOf = (source: ts.SourceFile): TsNode | null => {
    const declaration = ctx.ast.declarationOf(source, "default")
    if (declaration === null) return moduleExportsOf(source)
    return ctx.ts.isExportAssignment(declaration) ? declaration.expression : declaration
  }

  /** `withSentryConfig(withBundleAnalyzer(cfg), opts)`, `flag ? withX(cfg) : cfg`, `(phase) => cfg` down to the literal. */
  const configObjectsOf = (node: TsNode, file: string, depth: number): readonly Located[] => {
    if (depth > MAX_UNWRAP_DEPTH) return []
    const inner = ctx.unwrap(node)

    const object = ctx.ast.asObjectLiteral(inner)
    if (object !== null) return [{ node: object, file }]

    if (ctx.ts.isConditionalExpression(inner))
      return [
        ...configObjectsOf(inner.whenTrue, file, depth + 1),
        ...configObjectsOf(inner.whenFalse, file, depth + 1),
      ]

    const call = ctx.ast.asCallExpression(inner)
    const wrapped = call?.arguments[0]
    if (wrapped !== undefined) return configObjectsOf(wrapped, file, depth + 1)

    const identifier = ctx.ast.asIdentifier(inner)
    const bound = identifier === null ? null : resolver.valueOf(identifier, file)
    if (bound !== null) return configObjectsOf(bound.node, bound.file, depth + 1)

    const fn = resolver.functionOf(call === null ? inner : call.expression, file)
    const returned = fn === null ? null : resolver.returnedBy(fn.node)
    return fn === null || returned === null ? [] : configObjectsOf(returned, fn.file, depth + 1)
  }

  const uniqueObjects = (objects: readonly Located[]): readonly Located[] =>
    objects.filter((object, index) => objects.findIndex((other) => other.node === object.node) === index)

  const memberName = (member: ts.ObjectLiteralElementLike): string | null => {
    const name = member.name
    if (name === undefined) return null
    return ctx.ast.asIdentifier(name)?.text ?? ctx.ast.asStringLiteralLike(name)?.text ?? null
  }

  const memberNamed = (object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | null =>
    object.properties.find((member) => memberName(member) === name) ?? null

  const literalField = (object: ts.ObjectLiteralExpression, name: string): string | null => {
    const member = memberNamed(object, name)
    if (member === null || !ctx.ts.isPropertyAssignment(member)) return null
    return ctx.ast.asStringLiteralLike(member.initializer)?.text ?? null
  }

  const literalStringArray = (object: ts.ObjectLiteralExpression, name: string): LiteralStringArray => {
    const member = memberNamed(object, name)
    if (member === null) return ABSENT
    if (!ctx.ts.isPropertyAssignment(member)) return { kind: "dynamic", node: member }
    const array = ctx.ast.asArrayLiteral(member.initializer)
    if (array === null) return { kind: "dynamic", node: member.initializer }
    const values = array.elements.map((element) => ctx.ast.asStringLiteralLike(element)?.text ?? null)
    const dynamic = array.elements.find((_, index) => values[index] === null)
    if (dynamic !== undefined) return { kind: "dynamic", node: dynamic }
    return { kind: "literal", values: values.filter((value) => value !== null) }
  }

  return { moduleExportsOf, exportedOf, configObjectsOf, uniqueObjects, memberNamed, literalField, literalStringArray }
}
