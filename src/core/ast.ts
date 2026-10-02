import type ts from "typescript"
import type { FlatString, NodeLocator } from "./model.js"
import type { TypeScriptApi } from "./tsconfig.js"

export const DYNAMIC_PLACEHOLDER = ":param"

export const CONDITION_MAX = 110

const childrenOf = (node: ts.Node) => {
  const children: ts.Node[] = []
  node.forEachChild((child) => {
    children.push(child)
  })
  return children
}

export const walk = (node: ts.Node, visit: (node: ts.Node) => void): void => {
  const pending: ts.Node[] = [node]
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    visit(current)
    for (const child of childrenOf(current).reverse()) pending.push(child)
  }
}

export const isComponentTag = (name: string | null): boolean => name !== null && /^[A-Z]/.test(name)

export const isHookName = (name: string): boolean => /^use[A-Z]/.test(name)

export const condense = (text: string): string => text.replace(/\s+/g, " ").trim()

export type StringContext = {
  readonly constants: ReadonlyMap<string, string>
  readonly members: ReadonlyMap<string, string>
  readonly partialMembers?: ReadonlyMap<string, string>
}

export const hasStaticModifier = (api: TypeScriptApi, node: ts.Node): boolean =>
  api.canHaveModifiers(node) &&
  (api.getModifiers(node) ?? []).some((modifier) => modifier.kind === api.SyntaxKind.StaticKeyword)

export const EMPTY_STRING_CONTEXT: StringContext = { constants: new Map(), members: new Map() }

export type GuardResult = {
  readonly condition: string | null
  readonly repeated: boolean
}

export type ImportedOrigin = {
  readonly kind: "imported"
  readonly module: string
  readonly imported: string
}

export type ExportOrigin =
  | { readonly kind: "declared"; readonly name: string; readonly node: ts.Node }
  | ImportedOrigin

export type ModuleReference = {
  readonly specifier: string
  readonly typeOnly: boolean
  readonly reExport: boolean
}

export type Ast = {
  readonly ts: TypeScriptApi
  readonly unwrap: (node: ts.Node) => ts.Node
  readonly asArrayLiteral: (node: ts.Node | undefined) => ts.ArrayLiteralExpression | null
  readonly asObjectLiteral: (node: ts.Node | undefined) => ts.ObjectLiteralExpression | null
  readonly asCallExpression: (node: ts.Node | undefined) => ts.CallExpression | null
  readonly asNewExpression: (node: ts.Node | undefined) => ts.NewExpression | null
  readonly asIdentifier: (node: ts.Node | undefined) => ts.Identifier | null
  readonly asPropertyAccess: (node: ts.Node | undefined) => ts.PropertyAccessExpression | null
  readonly asStringLiteralLike: (node: ts.Node | undefined) => ts.StringLiteralLike | null
  readonly asArrowFunction: (node: ts.Node | undefined) => ts.ArrowFunction | null
  readonly flattenString: (node: ts.Node | undefined, context: StringContext) => FlatString | null
  readonly jsxAttributes: (node: ts.JsxOpeningLikeElement) => readonly ts.JsxAttribute[]
  readonly attributeByName: (node: ts.JsxOpeningLikeElement, name: string) => ts.JsxAttribute | undefined
  readonly attributeString: (
    node: ts.JsxOpeningLikeElement,
    name: string,
    context: StringContext,
  ) => string | null
  readonly tagName: (node: ts.JsxOpeningLikeElement) => string | null
  readonly jsxElementsIn: (node: ts.Node) => readonly ts.JsxOpeningLikeElement[]
  readonly containsJsx: (node: ts.Node) => boolean
  readonly conditionText: (node: ts.Node) => string
  readonly guardOf: (element: ts.Node, stopAt?: ts.Node) => GuardResult
  readonly nullGuardsIn: (source: ts.SourceFile) => readonly string[]
  readonly declarationOf: (source: ts.SourceFile, exportName: string) => ts.Node | null
  readonly decoratorsOf: (node: ts.Node) => readonly ts.Decorator[]
  readonly decoratorArgument: (node: ts.Node, name: string) => ts.ObjectLiteralExpression | null
  readonly exportOrigin: (source: ts.SourceFile, exportName: string) => ExportOrigin | null
  readonly moduleReferences: (source: ts.SourceFile) => readonly ModuleReference[]
  readonly locate: (node: ts.Node) => NodeLocator
  readonly resolveLocator: (source: ts.SourceFile, locator: NodeLocator) => ts.Node | null
}

const childIndexOf = (parent: ts.Node, child: ts.Node): number => {
  let index = -1
  let found = -1
  parent.forEachChild((candidate) => {
    index += 1
    if (candidate === child) found = index
  })
  return found
}

const childAt = (parent: ts.Node, wanted: number): ts.Node | null => {
  let index = -1
  let found: ts.Node | null = null
  parent.forEachChild((candidate) => {
    index += 1
    if (index === wanted) found = candidate
  })
  return found
}

type DeclarationIndex = {
  readonly named: ReadonlyMap<string, ts.Node>
  readonly defaultDeclaration: ts.Node | null
}

const declarationIndexes = new WeakMap<ts.SourceFile, DeclarationIndex>()

const jsxPresence = new WeakMap<ts.Node, boolean>()

export const createAst = (api: TypeScriptApi): Ast => {
  const unwrap = (node: ts.Node): ts.Node => {
    if (
      api.isParenthesizedExpression(node) ||
      api.isAsExpression(node) ||
      api.isSatisfiesExpression(node) ||
      api.isNonNullExpression(node)
    ) {
      return unwrap(node.expression)
    }
    if (api.isJsxExpression(node) && node.expression) return unwrap(node.expression)
    return node
  }

  const narrow =
    <T extends ts.Node>(guard: (node: ts.Node) => node is T) =>
    (node: ts.Node | undefined): T | null => {
      if (node === undefined) return null
      const inner = unwrap(node)
      return guard(inner) ? inner : null
    }

  const asArrayLiteral = narrow(api.isArrayLiteralExpression)
  const asObjectLiteral = narrow(api.isObjectLiteralExpression)
  const asCallExpression = narrow(api.isCallExpression)
  const asNewExpression = narrow(api.isNewExpression)
  const asIdentifier = narrow(api.isIdentifier)
  const asPropertyAccess = narrow(api.isPropertyAccessExpression)
  const asStringLiteralLike = narrow(api.isStringLiteralLike)
  const asArrowFunction = narrow(api.isArrowFunction)

  const bindsThis = (node: ts.Node): boolean =>
    api.isClassElement(node) || (api.isFunctionLike(node) && !api.isArrowFunction(node))

  const thisOwner = (node: ts.Node): ts.Node | null => {
    let current = node.parent
    while (current !== undefined && !bindsThis(current)) current = current.parent
    return current ?? null
  }

  const staticClassName = (node: ts.Node): string | null => {
    const owner = thisOwner(node)
    if (owner === null || !api.isClassElement(owner)) return null
    if (!api.isClassStaticBlockDeclaration(owner) && !hasStaticModifier(api, owner)) return null
    const declaration = owner.parent
    return api.isClassLike(declaration) && declaration.name !== undefined ? declaration.name.text : null
  }

  const memberOwner = (node: ts.Expression): string | null => {
    if (api.isIdentifier(node)) return node.text
    return node.kind === api.SyntaxKind.ThisKeyword ? staticClassName(node) : null
  }

  const memberKey = (node: ts.PropertyAccessExpression): string | null => {
    const owner = memberOwner(node.expression)
    return owner === null ? null : `${owner}.${node.name.text}`
  }

  const memberValue = (key: string, context: StringContext): FlatString | null => {
    const value = context.members.get(key)
    if (value !== undefined) return { value, dynamic: false }
    const partial = context.partialMembers?.get(key)
    return partial === undefined ? null : { value: partial, dynamic: true }
  }

  const flattenString = (input: ts.Node | undefined, context: StringContext): FlatString | null => {
    if (!input) return null
    const node = unwrap(input)

    if (api.isStringLiteral(node) || api.isNoSubstitutionTemplateLiteral(node))
      return { value: node.text, dynamic: false }

    if (api.isIdentifier(node)) {
      const value = context.constants.get(node.text)
      return value === undefined ? null : { value, dynamic: false }
    }

    if (api.isPropertyAccessExpression(node)) {
      const key = memberKey(node)
      return key === null ? null : memberValue(key, context)
    }

    if (api.isTemplateExpression(node)) {
      let value = node.head.text
      let dynamic = false

      for (const span of node.templateSpans) {
        const part = flattenString(span.expression, context)
        if (part) {
          value += part.value
          dynamic = dynamic || part.dynamic
        } else {
          value += DYNAMIC_PLACEHOLDER
          dynamic = true
        }
        value += span.literal.text
      }

      return { value, dynamic }
    }

    if (api.isBinaryExpression(node) && node.operatorToken.kind === api.SyntaxKind.PlusToken) {
      const left = flattenString(node.left, context)
      const right = flattenString(node.right, context)
      if (!left && !right) return null
      return {
        value: `${left?.value ?? DYNAMIC_PLACEHOLDER}${right?.value ?? DYNAMIC_PLACEHOLDER}`,
        dynamic: (left?.dynamic ?? true) || (right?.dynamic ?? true),
      }
    }

    if (api.isConditionalExpression(node)) {
      const branch = flattenString(node.whenTrue, context) ?? flattenString(node.whenFalse, context)
      return branch ? { value: branch.value, dynamic: true } : null
    }

    if (api.isBinaryExpression(node) && node.operatorToken.kind === api.SyntaxKind.AmpersandAmpersandToken) {
      const guarded = flattenString(node.right, context)
      return guarded ? { value: guarded.value, dynamic: true } : null
    }

    const replaceCall = asCallExpression(node)
    if (replaceCall !== null) {
      const callee = asPropertyAccess(replaceCall.expression)
      if (callee !== null && callee.name.text === "replace") {
        const base = flattenString(callee.expression, context)
        return base ? { value: base.value, dynamic: true } : null
      }
    }

    return null
  }

  const jsxAttributes = (node: ts.JsxOpeningLikeElement): readonly ts.JsxAttribute[] =>
    node.attributes.properties.filter(api.isJsxAttribute)

  const attributeByName = (node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined =>
    jsxAttributes(node).find((attribute) => api.isIdentifier(attribute.name) && attribute.name.text === name)

  const attributeString = (
    node: ts.JsxOpeningLikeElement,
    name: string,
    context: StringContext,
  ): string | null => flattenString(attributeByName(node, name)?.initializer, context)?.value ?? null

  const tagName = (node: ts.JsxOpeningLikeElement): string | null => {
    const tag = node.tagName
    if (api.isIdentifier(tag)) return tag.text
    if (api.isPropertyAccessExpression(tag) && api.isIdentifier(tag.expression)) return tag.expression.text
    return null
  }

  const jsxElementsIn = (node: ts.Node): readonly ts.JsxOpeningLikeElement[] => {
    const elements: ts.JsxOpeningLikeElement[] = []
    walk(node, (child) => {
      if (api.isJsxOpeningElement(child) || api.isJsxSelfClosingElement(child)) elements.push(child)
    })
    return elements
  }

  const scanForJsx = (node: ts.Node): boolean => {
    let found = false
    walk(node, (child) => {
      if (api.isJsxOpeningElement(child) || api.isJsxSelfClosingElement(child) || api.isJsxFragment(child))
        found = true
    })
    return found
  }

  const containsJsx = (node: ts.Node): boolean => {
    const cached = jsxPresence.get(node)
    if (cached !== undefined) return cached
    const found = scanForJsx(node)
    jsxPresence.set(node, found)
    return found
  }

  const conditionText = (node: ts.Node): string => condense(node.getText()).slice(0, CONDITION_MAX)

  const isFunctionBoundary = (node: ts.Node): boolean =>
    api.isFunctionDeclaration(node) ||
    api.isArrowFunction(node) ||
    api.isFunctionExpression(node) ||
    api.isMethodDeclaration(node)

  const isCallbackArgument = (node: ts.Node): boolean =>
    node.parent !== undefined &&
    api.isCallExpression(node.parent) &&
    node.parent.arguments.includes(node as ts.Expression)

  const guardOf = (element: ts.Node, stopAt?: ts.Node): GuardResult => {
    const conditions: string[] = []
    let repeated = false
    let child = element
    let current: ts.Node | undefined = element.parent

    while (
      current !== undefined &&
      current !== stopAt &&
      (!isFunctionBoundary(current) || isCallbackArgument(current))
    ) {
      if (api.isBinaryExpression(current) && child === current.right) {
        const operator = current.operatorToken.kind
        if (
          operator === api.SyntaxKind.AmpersandAmpersandToken ||
          operator === api.SyntaxKind.QuestionQuestionToken
        )
          conditions.push(conditionText(current.left))
        if (operator === api.SyntaxKind.BarBarToken) conditions.push(`!(${conditionText(current.left)})`)
      }

      if (api.isConditionalExpression(current)) {
        if (child === current.whenTrue) conditions.push(conditionText(current.condition))
        if (child === current.whenFalse) conditions.push(`!(${conditionText(current.condition)})`)
      }

      if (
        api.isCallExpression(current) &&
        api.isPropertyAccessExpression(current.expression) &&
        current.expression.name.text === "map"
      )
        repeated = true

      child = current
      current = current.parent
    }

    return { condition: conditions.length ? conditions.reverse().join(" && ") : null, repeated }
  }

  const enclosingFunction = (node: ts.Node): ts.Node | null => {
    let current: ts.Node | undefined = node.parent
    while (current !== undefined && !isFunctionBoundary(current)) current = current.parent
    return current ?? null
  }

  const nullGuardsIn = (source: ts.SourceFile): readonly string[] => {
    const guards = new Set<string>()
    const renderingFunctions = new Map<ts.Node, boolean>()

    const rendersJsx = (node: ts.Node): boolean => {
      const cached = renderingFunctions.get(node)
      if (cached !== undefined) return cached

      const result = containsJsx(node)
      renderingFunctions.set(node, result)
      return result
    }

    walk(source, (node) => {
      if (!api.isIfStatement(node) || node.elseStatement) return

      const body = api.isBlock(node.thenStatement) ? node.thenStatement.statements : [node.thenStatement]
      const returnsNothing = body.some(
        (statement) =>
          api.isReturnStatement(statement) &&
          statement.expression !== undefined &&
          (statement.expression.kind === api.SyntaxKind.NullKeyword ||
            (api.isJsxFragment(statement.expression) && statement.expression.children.length === 0)),
      )
      if (!returnsNothing) return

      const owner = enclosingFunction(node)
      if (owner && rendersJsx(owner)) guards.add(conditionText(node.expression))
    })

    return [...guards]
  }

  const hasDefaultModifier = (statement: ts.FunctionDeclaration | ts.ClassDeclaration): boolean =>
    statement.modifiers?.some((modifier) => modifier.kind === api.SyntaxKind.DefaultKeyword) === true

  const decoratorsOf = (node: ts.Node): readonly ts.Decorator[] =>
    api.canHaveDecorators(node) ? (api.getDecorators(node) ?? []) : []

  const decoratorCallNamed = (decorator: ts.Decorator, name: string): ts.CallExpression | null => {
    const call = asCallExpression(decorator.expression)
    if (call === null) return null
    return api.isIdentifier(call.expression) && call.expression.text === name ? call : null
  }

  const decoratorArgument = (node: ts.Node, name: string): ts.ObjectLiteralExpression | null => {
    const call = decoratorsOf(node)
      .map((decorator) => decoratorCallNamed(decorator, name))
      .find((candidate) => candidate !== null)
    return call ? asObjectLiteral(call.arguments[0]) : null
  }

  const isDefaultDeclaration = (statement: ts.Statement): boolean =>
    api.isExportAssignment(statement) ||
    ((api.isFunctionDeclaration(statement) || api.isClassDeclaration(statement)) && hasDefaultModifier(statement))

  const namedDeclarationName = (statement: ts.Statement): string | undefined => {
    if (
      api.isFunctionDeclaration(statement) ||
      api.isClassDeclaration(statement) ||
      api.isEnumDeclaration(statement) ||
      api.isTypeAliasDeclaration(statement) ||
      api.isInterfaceDeclaration(statement)
    )
      return statement.name?.text
    return undefined
  }

  const declarationEntries = (statement: ts.Statement): readonly (readonly [string, ts.Node])[] => {
    const name = namedDeclarationName(statement)
    if (name !== undefined) return [[name, statement]]
    if (!api.isVariableStatement(statement)) return []
    return statement.declarationList.declarations.flatMap((declaration) =>
      api.isIdentifier(declaration.name) ? [[declaration.name.text, declaration] as const] : [],
    )
  }

  const buildDeclarationIndex = (source: ts.SourceFile): DeclarationIndex => {
    const named = new Map<string, ts.Node>()
    for (const [name, node] of source.statements.flatMap(declarationEntries)) {
      if (!named.has(name)) named.set(name, node)
    }
    return { named, defaultDeclaration: source.statements.find(isDefaultDeclaration) ?? null }
  }

  const declarationIndexOf = (source: ts.SourceFile): DeclarationIndex => {
    const cached = declarationIndexes.get(source)
    if (cached !== undefined) return cached
    const index = buildDeclarationIndex(source)
    declarationIndexes.set(source, index)
    return index
  }

  const declarationOf = (source: ts.SourceFile, exportName: string): ts.Node | null => {
    if (exportName === "") return source
    const index = declarationIndexOf(source)
    if (exportName === "default") return index.defaultDeclaration
    return index.named.get(exportName) ?? null
  }

  const localExportElements = (source: ts.SourceFile): readonly ts.ExportSpecifier[] =>
    source.statements
      .filter(api.isExportDeclaration)
      .filter((statement) => statement.moduleSpecifier === undefined && !statement.isTypeOnly)
      .flatMap((statement) =>
        statement.exportClause !== undefined && api.isNamedExports(statement.exportClause)
          ? [...statement.exportClause.elements]
          : [],
      )

  const defaultExportedIdentifier = (source: ts.SourceFile): string | null => {
    const assignment = source.statements
      .filter(api.isExportAssignment)
      .find((statement) => !statement.isExportEquals && api.isIdentifier(statement.expression))
    return assignment === undefined || !api.isIdentifier(assignment.expression) ? null : assignment.expression.text
  }

  const exportedLocalName = (source: ts.SourceFile, exportName: string): string | null => {
    const element = localExportElements(source).find(
      (candidate) => candidate.name.text === exportName && !candidate.isTypeOnly,
    )
    if (element !== undefined) return (element.propertyName ?? element.name).text
    return exportName === "default" ? defaultExportedIdentifier(source) : null
  }

  const importedAs = (clause: ts.ImportClause, local: string): string | null => {
    if (clause.name?.text === local) return "default"
    const named = clause.namedBindings
    if (named === undefined || !api.isNamedImports(named)) return null
    const element = named.elements.find((candidate) => candidate.name.text === local)
    return element === undefined ? null : (element.propertyName ?? element.name).text
  }

  const importBindingOf = (source: ts.SourceFile, local: string): ImportedOrigin | null => {
    for (const statement of source.statements) {
      if (!api.isImportDeclaration(statement) || !api.isStringLiteral(statement.moduleSpecifier)) continue
      const imported = statement.importClause === undefined ? null : importedAs(statement.importClause, local)
      if (imported !== null) return { kind: "imported", module: statement.moduleSpecifier.text, imported }
    }
    return null
  }

  const declaredOrigin = (source: ts.SourceFile, name: string): ExportOrigin | null => {
    const node = declarationOf(source, name)
    return node === null ? null : { kind: "declared", name, node }
  }

  const exportOrigin = (source: ts.SourceFile, exportName: string): ExportOrigin | null => {
    const local = exportedLocalName(source, exportName)
    const imported = local === null ? null : importBindingOf(source, local)
    if (imported !== null) return imported
    const own = declaredOrigin(source, exportName)
    if (own !== null || local === null || local === exportName) return own
    return declaredOrigin(source, local)
  }

  const isTypeOnlyImport = (statement: ts.ImportDeclaration): boolean => {
    const clause = statement.importClause
    if (clause === undefined) return false
    if (clause.isTypeOnly) return true
    const named = clause.namedBindings
    if (clause.name !== undefined || named === undefined || !api.isNamedImports(named)) return false
    return named.elements.length > 0 && named.elements.every((element) => element.isTypeOnly)
  }

  const isTypeOnlyExport = (statement: ts.ExportDeclaration): boolean => {
    if (statement.isTypeOnly) return true
    const clause = statement.exportClause
    if (clause === undefined || !api.isNamedExports(clause)) return false
    return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly)
  }

  const moduleReferenceOf = (statement: ts.Statement): ModuleReference | null => {
    if (api.isImportDeclaration(statement) && api.isStringLiteral(statement.moduleSpecifier))
      return { specifier: statement.moduleSpecifier.text, typeOnly: isTypeOnlyImport(statement), reExport: false }
    if (!api.isExportDeclaration(statement) || statement.moduleSpecifier === undefined) return null
    if (!api.isStringLiteral(statement.moduleSpecifier)) return null
    return { specifier: statement.moduleSpecifier.text, typeOnly: isTypeOnlyExport(statement), reExport: true }
  }

  const moduleReferences = (source: ts.SourceFile): readonly ModuleReference[] =>
    source.statements.flatMap((statement) => {
      const reference = moduleReferenceOf(statement)
      return reference === null ? [] : [reference]
    })

  const anchorNameOf =(statement: ts.Node, chain: readonly ts.Node[]): { anchor: ts.Node; name: string } | null => {
    if (api.isExportAssignment(statement)) return { anchor: statement, name: "default" }

    if (api.isFunctionDeclaration(statement) || api.isClassDeclaration(statement)) {
      if (hasDefaultModifier(statement)) return { anchor: statement, name: "default" }
      const name = statement.name?.text
      return name === undefined ? null : { anchor: statement, name }
    }

    if (api.isEnumDeclaration(statement)) return { anchor: statement, name: statement.name.text }

    if (!api.isVariableStatement(statement)) return null

    const declaration = chain.find(
      (node) => api.isVariableDeclaration(node) && node.parent === statement.declarationList,
    )
    if (declaration === undefined || !api.isVariableDeclaration(declaration)) return null
    if (!api.isIdentifier(declaration.name)) return null
    return { anchor: declaration, name: declaration.name.text }
  }

  // An `export` of `""` addresses the source file itself; it is the fallback for a node that sits in
  // no named top-level declaration (a bare expression statement, a re-export, module-level JSX).
  const locate = (node: ts.Node): NodeLocator => {
    const source = node.getSourceFile()
    const chain: ts.Node[] = []
    let current: ts.Node = node

    while (current.parent !== undefined && !api.isSourceFile(current.parent)) {
      chain.push(current)
      current = current.parent
    }

    const statement = current
    const anchored = api.isSourceFile(statement) ? null : anchorNameOf(statement, chain)
    const anchor = anchored?.anchor ?? source
    const name = anchored?.name ?? ""

    const path: number[] = []
    let cursor: ts.Node = node
    while (cursor !== anchor && cursor.parent !== undefined) {
      path.unshift(childIndexOf(cursor.parent, cursor))
      cursor = cursor.parent
    }

    return { export: name, path }
  }

  const resolveLocator = (source: ts.SourceFile, locator: NodeLocator): ts.Node | null => {
    let current = declarationOf(source, locator.export)
    if (current === null) return null

    for (const index of locator.path) {
      const next = childAt(current, index)
      if (next === null) return null
      current = next
    }

    return current
  }

  return {
    ts: api,
    unwrap,
    asArrayLiteral,
    asObjectLiteral,
    asCallExpression,
    asNewExpression,
    asIdentifier,
    asPropertyAccess,
    asStringLiteralLike,
    asArrowFunction,
    flattenString,
    jsxAttributes,
    attributeByName,
    attributeString,
    tagName,
    jsxElementsIn,
    containsJsx,
    conditionText,
    guardOf,
    nullGuardsIn,
    declarationOf,
    decoratorsOf,
    decoratorArgument,
    exportOrigin,
    moduleReferences,
    locate,
    resolveLocator,
  }
}
