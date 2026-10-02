import type ts from "typescript"
import type { FlatString } from "../core/model.js"
import { baseMembersOf, fileStrings } from "../core/strings.js"
import type { ExtractContext } from "./types.js"

/**
 * A navigation target read out of a statically known literal: `tabToPath[tab]`, `ROUTES[key].path`,
 * `items.map((item) => <Link to={item.to} />)`. The lookup key is a runtime value, so every value the
 * literal CAN yield is returned, and each one is dynamic unless no step of the lookup was a runtime key.
 */
export const LOOKUP_LIMITS = {
  maxValues: 64,
  maxDepth: 8,
} as const

type Step = { readonly kind: "name"; readonly name: string } | { readonly kind: "any" }

type AccessPath = {
  readonly root: ts.Identifier
  readonly steps: readonly Step[]
}

type Origin = {
  readonly expr: ts.Node
  readonly steps: readonly Step[]
}

export type LookupValue = {
  readonly value: string
  readonly dynamic: boolean
}

type Values = readonly LookupValue[] | null

const ANY: Step = { kind: "any" }

const ITERATORS: ReadonlySet<string> = new Set(["map", "flatMap", "forEach"])

const PASSTHROUGH: ReadonlySet<string> = new Set(["filter", "slice", "toSorted", "toReversed", "sort", "reverse"])

const nameStep = (name: string): Step => ({ kind: "name", name })

const union = (parts: readonly Values[]): Values => {
  const values: LookupValue[] = []
  for (const part of parts) {
    if (part === null) return null
    values.push(...part)
  }
  return values
}

const dedupe = (values: readonly LookupValue[]): readonly LookupValue[] => {
  const byValue = new Map<string, LookupValue>()
  for (const entry of values) {
    const known = byValue.get(entry.value)
    if (known === undefined || (known.dynamic && !entry.dynamic)) byValue.set(entry.value, entry)
  }
  return [...byValue.values()]
}

export type TargetLookup = {
  /** True when `node` is shaped like a lookup this reader may resolve — decided without cross-file work. */
  readonly accepts: (node: ts.Node) => boolean
  /** Every value the lookup can yield, or `null` when any branch of it is not statically known. */
  readonly valuesOf: (node: ts.Node) => readonly LookupValue[] | null
}

export const createTargetLookup = (ctx: ExtractContext): TargetLookup => {
  const api = ctx.ts
  const baseMembers = baseMembersOf(ctx.strings)

  const flatten = (node: ts.Node): FlatString | null => {
    const source = node.getSourceFile()
    if (source === ctx.source) return ctx.flattenString(node)
    return ctx.ast.flattenString(node, fileStrings(api, source, baseMembers).contextAt(node))
  }

  const keyStep = (key: ts.Expression): Step => {
    const inner = ctx.ast.unwrap(key)
    if (api.isStringLiteralLike(inner) || api.isNumericLiteral(inner)) return nameStep(inner.text)
    return ANY
  }

  const accessPathOf = (node: ts.Node): AccessPath | null => {
    const inner = ctx.ast.unwrap(node)
    if (api.isIdentifier(inner)) return { root: inner, steps: [] }

    const access = api.isPropertyAccessExpression(inner) || api.isElementAccessExpression(inner) ? inner : null
    if (access === null) return null

    const base = accessPathOf(access.expression)
    if (base === null) return null
    const step = api.isPropertyAccessExpression(access) ? nameStep(access.name.text) : keyStep(access.argumentExpression)
    return { root: base.root, steps: [...base.steps, step] }
  }

  const peel = (node: ts.Node): ts.Node => {
    const inner = ctx.ast.unwrap(node)
    const call = ctx.ast.asCallExpression(inner)
    const callee = call === null ? null : ctx.ast.asPropertyAccess(call.expression)
    if (call === null || callee === null || callee.name.text !== "freeze") return inner
    if (ctx.ast.asIdentifier(callee.expression)?.text !== "Object" || call.arguments[0] === undefined) return inner
    return peel(call.arguments[0])
  }

  const iteratorReceiver = (fn: ts.SignatureDeclaration): ts.Expression | null => {
    const call = fn.parent
    if (!api.isCallExpression(call) || call.arguments[0] !== fn) return null
    const callee = ctx.ast.asPropertyAccess(call.expression)
    return callee !== null && ITERATORS.has(callee.name.text) ? callee.expression : null
  }

  const bindingPropertyOf = (pattern: ts.BindingName, name: string): string | null => {
    if (!api.isObjectBindingPattern(pattern)) return null
    for (const element of pattern.elements) {
      if (element.dotDotDotToken !== undefined || !api.isIdentifier(element.name) || element.name.text !== name) continue
      const property = element.propertyName
      if (property === undefined) return name
      return api.isIdentifier(property) || api.isStringLiteralLike(property) ? property.text : null
    }
    return null
  }

  const declares = (binding: ts.BindingName, name: string): boolean =>
    api.isIdentifier(binding) ? binding.text === name : bindingPropertyOf(binding, name) !== null

  const iteratedOrigin = (binding: ts.BindingName, name: string, receiver: ts.Expression): Origin | null => {
    if (api.isIdentifier(binding)) return { expr: receiver, steps: [ANY] }
    const property = bindingPropertyOf(binding, name)
    return property === null ? null : { expr: receiver, steps: [ANY, nameStep(property)] }
  }

  type Scan = { readonly found: false } | { readonly found: true; readonly origin: Origin | null }

  const NOT_FOUND: Scan = { found: false }

  const parameterScan = (fn: ts.SignatureDeclaration, name: string): Scan => {
    const index = fn.parameters.findIndex((parameter) => declares(parameter.name, name))
    const parameter = fn.parameters[index]
    if (parameter === undefined) return NOT_FOUND
    const receiver = index === 0 ? iteratorReceiver(fn) : null
    return { found: true, origin: receiver === null ? null : iteratedOrigin(parameter.name, name, receiver) }
  }

  const isConst = (list: ts.VariableDeclarationList): boolean => (list.flags & api.NodeFlags.Const) !== 0

  const declarationScan = (list: ts.VariableDeclarationList, name: string): Scan => {
    const declaration = list.declarations.find((candidate) => declares(candidate.name, name))
    if (declaration === undefined) return NOT_FOUND
    if (!isConst(list) || declaration.initializer === undefined) return { found: true, origin: null }
    if (api.isIdentifier(declaration.name)) return { found: true, origin: { expr: declaration.initializer, steps: [] } }
    const property = bindingPropertyOf(declaration.name, name)
    return {
      found: true,
      origin: property === null ? null : { expr: declaration.initializer, steps: [nameStep(property)] },
    }
  }

  const statementsScan = (statements: readonly ts.Statement[], name: string): Scan => {
    for (const statement of statements) {
      if (!api.isVariableStatement(statement)) continue
      const scan = declarationScan(statement.declarationList, name)
      if (scan.found) return scan
    }
    return NOT_FOUND
  }

  const forOfScan = (loop: ts.ForOfStatement, name: string): Scan => {
    const list = loop.initializer
    if (!api.isVariableDeclarationList(list)) return NOT_FOUND
    const declaration = list.declarations.find((candidate) => declares(candidate.name, name))
    if (declaration === undefined) return NOT_FOUND
    return { found: true, origin: iteratedOrigin(declaration.name, name, loop.expression) }
  }

  const scopeScan = (scope: ts.Node, name: string): Scan => {
    if (api.isArrowFunction(scope) || api.isFunctionExpression(scope) || api.isFunctionDeclaration(scope))
      return parameterScan(scope, name)
    if (api.isMethodDeclaration(scope)) return parameterScan(scope, name)
    if (api.isForOfStatement(scope)) return forOfScan(scope, name)
    if (api.isBlock(scope) || api.isSourceFile(scope) || api.isModuleBlock(scope))
      return statementsScan(scope.statements, name)
    return NOT_FOUND
  }

  type ImportRef = { readonly spec: string; readonly imported: string }

  const importOf = (source: ts.SourceFile, name: string): ImportRef | null => {
    for (const statement of source.statements) {
      if (!api.isImportDeclaration(statement) || !api.isStringLiteral(statement.moduleSpecifier)) continue
      const clause = statement.importClause
      if (clause === undefined || clause.isTypeOnly) continue
      const spec = statement.moduleSpecifier.text
      if (clause.name?.text === name) return { spec, imported: "default" }
      const named = clause.namedBindings
      if (named === undefined || !api.isNamedImports(named)) continue
      const element = named.elements.find((candidate) => candidate.name.text === name)
      if (element !== undefined) return { spec, imported: element.propertyName?.text ?? name }
    }
    return null
  }

  const importedFile = (source: ts.SourceFile, name: string, spec: string): string | null => {
    if (source === ctx.source) {
      const binding = ctx.bindings.get(name)
      return binding !== null && (binding.kind === "import" || binding.kind === "dynamic-import") ? binding.file : null
    }
    return ctx.resolve?.resolveModule(source.fileName, spec) ?? null
  }

  const exportedOrigin = (declaration: ts.Node | null): Origin | null => {
    if (declaration === null) return null
    if (api.isExportAssignment(declaration)) return { expr: declaration.expression, steps: [] }
    if (!api.isVariableDeclaration(declaration) || declaration.initializer === undefined) return null
    const list = declaration.parent
    if (!api.isVariableDeclarationList(list) || !isConst(list)) return null
    return { expr: declaration.initializer, steps: [] }
  }

  const importedOrigin = (source: ts.SourceFile, name: string): Origin | null => {
    const resolve = ctx.resolve
    const ref = importOf(source, name)
    if (resolve === null || ref === null) return null
    const file = importedFile(source, name, ref.spec)
    if (file === null) return null
    const declaring = resolve.sourceFile(resolve.declarationFile(file, ref.imported))
    if (declaring === null) return null
    return exportedOrigin(ctx.ast.declarationOf(declaring, ref.imported))
  }

  const originOf = (identifier: ts.Identifier): Origin | null => {
    for (let scope: ts.Node | undefined = identifier.parent; scope !== undefined; scope = scope.parent) {
      const scan = scopeScan(scope, identifier.text)
      if (scan.found) return scan.origin
    }
    return importedOrigin(identifier.getSourceFile(), identifier.text)
  }

  const evaluatePath = (path: AccessPath, steps: readonly Step[], depth: number, dynamic: boolean): Values => {
    const origin = originOf(path.root)
    if (origin === null) return null
    return evaluate(origin.expr, [...origin.steps, ...path.steps, ...steps], depth + 1, dynamic)
  }

  const leaf = (node: ts.Node, depth: number, dynamic: boolean): Values => {
    if (ctx.ast.asObjectLiteral(node) !== null || ctx.ast.asArrayLiteral(node) !== null) return []

    const flat = flatten(node)
    if (flat !== null) return [{ value: flat.value, dynamic: dynamic || flat.dynamic }]

    const path = accessPathOf(node)
    return path === null ? null : evaluatePath(path, [], depth, dynamic)
  }

  const propertyName = (name: ts.PropertyName): string | null =>
    api.isIdentifier(name) || api.isStringLiteralLike(name) || api.isNumericLiteral(name) ? name.text : null

  const objectValues = (
    object: ts.ObjectLiteralExpression,
    step: Step,
    rest: readonly Step[],
    depth: number,
    dynamic: boolean,
  ): Values => {
    const reached = dynamic || step.kind === "any"
    const matches = (name: string | null): boolean => step.kind === "any" || name === step.name

    return union(
      object.properties.map((property): Values => {
        if (api.isSpreadAssignment(property)) return evaluate(property.expression, [step, ...rest], depth + 1, dynamic)
        if (api.isPropertyAssignment(property))
          return matches(propertyName(property.name)) ? evaluate(property.initializer, rest, depth + 1, reached) : []
        if (api.isShorthandPropertyAssignment(property))
          return matches(property.name.text) ? evaluate(property.name, rest, depth + 1, reached) : []
        return matches(property.name === undefined ? null : propertyName(property.name)) ? null : []
      }),
    )
  }

  const arrayValues = (
    array: ts.ArrayLiteralExpression,
    step: Step,
    rest: readonly Step[],
    depth: number,
    dynamic: boolean,
  ): Values => {
    if (step.kind === "name") {
      const element = /^\d+$/.test(step.name) ? array.elements[Number(step.name)] : undefined
      return element === undefined || api.isSpreadElement(element) ? null : evaluate(element, rest, depth + 1, dynamic)
    }

    return union(
      array.elements.map((element): Values => {
        if (api.isOmittedExpression(element)) return []
        if (api.isSpreadElement(element)) return evaluate(element.expression, [ANY, ...rest], depth + 1, dynamic)
        return evaluate(element, rest, depth + 1, true)
      }),
    )
  }

  const passthroughReceiver = (node: ts.Node): ts.Expression | null => {
    const call = ctx.ast.asCallExpression(node)
    const callee = call === null ? null : ctx.ast.asPropertyAccess(call.expression)
    return callee !== null && PASSTHROUGH.has(callee.name.text) ? callee.expression : null
  }

  const evaluate = (expr: ts.Node, steps: readonly Step[], depth: number, dynamic: boolean): Values => {
    if (depth > LOOKUP_LIMITS.maxDepth) return null
    const node = peel(expr)

    if (api.isConditionalExpression(node))
      return union([evaluate(node.whenTrue, steps, depth + 1, true), evaluate(node.whenFalse, steps, depth + 1, true)])

    const [step, ...rest] = steps
    if (step === undefined) return leaf(node, depth, dynamic)

    const object = ctx.ast.asObjectLiteral(node)
    if (object !== null) return objectValues(object, step, rest, depth, dynamic)

    const array = ctx.ast.asArrayLiteral(node)
    if (array !== null) return arrayValues(array, step, rest, depth, dynamic)

    const receiver = step.kind === "any" ? passthroughReceiver(node) : null
    if (receiver !== null) return evaluate(receiver, steps, depth + 1, dynamic)

    const path = accessPathOf(node)
    return path === null ? null : evaluatePath(path, steps, depth, dynamic)
  }

  return {
    accepts: (node) => accessPathOf(node) !== null,
    valuesOf: (node) => {
      const values = evaluate(node, [], 0, false)
      if (values === null) return null
      const unique = dedupe(values)
      return unique.length > LOOKUP_LIMITS.maxValues ? null : unique
    },
  }
}
