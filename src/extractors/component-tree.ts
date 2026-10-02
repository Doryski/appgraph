import type ts from "typescript"
import type { Binding, KindRule, RenderEdge } from "../core/model.js"
import type { CrossFileResolve, ExtractContext, FactExtractor } from "./types.js"
import type { FileBindingTable, LazyTarget } from "../core/bindings.js"
import type { Ast } from "../core/ast.js"
import type { TypeScriptApi } from "../core/tsconfig.js"
import type { TagResolution, TagResolutionVia, TemplateDoc, TemplateElement } from "../core/template-doc.js"
import { primaryNameOf } from "../core/template-doc.js"
import type { GuardResult } from "../core/ast.js"
import { sortBy, sortedUnique } from "../core/order.js"
import { isSfcFile } from "../core/extensions.js"
import { toPascal } from "../core/vue-template.js"
import { isComponentTag, isHookName } from "../core/ast.js"
import { bindingTableFor } from "./imported-declaration.js"
import { strongerVia, withVia } from "../core/graph.js"
import { HOOK_FILE, isTraversable as isTraversableByRule } from "../core/kinds.js"

// The `uses` classification seam (§6.4). Preference order: an explicit predicate, then
// `core/kinds.ts`'s `isTraversable` (`KindRule.traversable` unioned with the React hook-naming rule
// of §7.8), then the hook-naming rule alone when no rules were supplied. No fixed
// directory regex (`/^src\/(services|stores|shared\/hooks)\//`) is used anywhere here: it matches
// nothing on most real layouts.
export const DEFAULT_TRAVERSABLE = (file: string): boolean => HOOK_FILE.test(file)

export type ComponentTreeOptions = {
  readonly isTraversable?: (file: string) => boolean
  readonly kindRules?: readonly KindRule[]
}

type Via = RenderEdge["via"]

type PendingEdge = {
  readonly local: string
  readonly absFile: string
  readonly imported: string
  readonly member: string | null
  readonly via: Via
  readonly projectFile: string | null
  readonly conditions: Set<string>
  alwaysRendered: boolean
  repeated: boolean
}

type ValueReference = {
  readonly absFile: string
  readonly imported: string
}

type AmbiguousTag = {
  readonly tag: string
  readonly files: readonly string[]
  readonly line: number
}

type State = {
  readonly pending: Map<string, PendingEdge>
  readonly references: Map<string, ValueReference>
  readonly hooks: Set<string>
  readonly ambiguous: Map<string, Map<string, AmbiguousTag>>
}

const emptyState = (): State => ({ pending: new Map(), references: new Map(), hooks: new Set(), ambiguous: new Map() })

export const REACT_BUILTIN_HOOKS = [
  "use",
  "useActionState",
  "useCallback",
  "useContext",
  "useDebugValue",
  "useDeferredValue",
  "useEffect",
  "useFormStatus",
  "useId",
  "useImperativeHandle",
  "useInsertionEffect",
  "useLayoutEffect",
  "useMemo",
  "useOptimistic",
  "useReducer",
  "useRef",
  "useState",
  "useSyncExternalStore",
  "useTransition",
] as const

const BUILTIN_HOOKS: ReadonlySet<string> = new Set(REACT_BUILTIN_HOOKS)

const customHookCalled = (ast: Ast, node: ts.Node): string | null => {
  const call = ast.asCallExpression(node)
  const callee = call === null ? null : ast.asIdentifier(call.expression)
  if (callee === null || !isHookName(callee.text) || BUILTIN_HOOKS.has(callee.text)) return null
  return callee.text
}

// A component passed around as a VALUE (`{ Panel: SummaryPanel }`, `component={X}`, `VIEWS[mode]`)
// renders only when runtime selection picks it, so the edge is never `alwaysRendered` and carries
// this text in place of a guard.
export const REFERENCE_CONDITION = "referenced as a value, not JSX; renders only if selected at runtime"

const MAX_DECLARATION_HOPS = 4

const lazyExportEdges = (targets: readonly LazyTarget[]): readonly PendingEdge[] =>
  targets.flatMap((target) =>
    target.file === null
      ? []
      : [
          {
            local: target.imported,
            absFile: target.file,
            imported: target.imported,
            member: null,
            via: "lazy" as const,
            projectFile: null,
            conditions: new Set<string>(),
            alwaysRendered: true,
            repeated: false,
          },
        ],
  )

const mergeInto = (edges: Map<string, RenderEdge>, file: string, pending: PendingEdge): void => {
  const existing = edges.get(file)
  const edge = {
    file,
    // Conditions from different usage sites are ALTERNATIVES (OR), never a conjunction (§7.9).
    conditions: sortedUnique([...(existing?.conditions ?? []), ...pending.conditions]),
    alwaysRendered: (existing?.alwaysRendered ?? false) || pending.alwaysRendered,
    repeated: (existing?.repeated ?? false) || pending.repeated,
  }
  edges.set(file, withVia(edge, existing === undefined ? pending.via : strongerVia(existing.via, pending.via)))
}

const isTransparentParent = (api: TypeScriptApi, parent: ts.Node, child: ts.Node): boolean => {
  if (
    api.isParenthesizedExpression(parent) ||
    api.isAsExpression(parent) ||
    api.isSatisfiesExpression(parent) ||
    api.isNonNullExpression(parent) ||
    api.isTypeAssertionExpression(parent)
  )
    return true
  if (api.isConditionalExpression(parent)) return parent.condition !== child
  if (api.isElementAccessExpression(parent)) return parent.expression === child
  if (!api.isBinaryExpression(parent)) return false
  const operator = parent.operatorToken.kind
  if (operator === api.SyntaxKind.QuestionQuestionToken || operator === api.SyntaxKind.BarBarToken) return true
  return operator === api.SyntaxKind.AmpersandAmpersandToken && parent.right === child
}

// `Object.assign(Root, { Body: TableBody })` builds a compound namespace: the parts render where a
// consumer writes `<Root.Body/>`, never inside `Root`, so they are not `Root`'s children.
const isCompoundAssembly = (api: TypeScriptApi, object: ts.Node): boolean => {
  const call = object.parent
  if (!api.isCallExpression(call) || !api.isPropertyAccessExpression(call.expression)) return false
  const target = call.expression
  return api.isIdentifier(target.expression) && target.expression.text === "Object" && target.name.text === "assign"
}

const isValueSlot = (api: TypeScriptApi, parent: ts.Node, child: ts.Node): boolean => {
  if (api.isPropertyAssignment(parent)) return parent.initializer === child && !isCompoundAssembly(api, parent.parent)
  if (api.isShorthandPropertyAssignment(parent)) return parent.name === child && !isCompoundAssembly(api, parent.parent)
  if (api.isArrayLiteralExpression(parent)) return true
  if (api.isVariableDeclaration(parent)) return parent.initializer === child
  return api.isJsxExpression(parent) && api.isJsxAttribute(parent.parent)
}

const isValueReference = (api: TypeScriptApi, identifier: ts.Identifier): boolean => {
  let child: ts.Node = identifier
  let parent = identifier.parent
  while (isTransparentParent(api, parent, child)) {
    child = parent
    parent = parent.parent
  }
  return isValueSlot(api, parent, child)
}

// `buildColumns(config)`, `columns.map(...)`, `[...columns]`: a lowercase value is also consumed by
// calling it, reading it or spreading it — never only through a value slot.
const isConsumedValue = (api: TypeScriptApi, identifier: ts.Identifier): boolean => {
  const parent = identifier.parent
  if (api.isCallExpression(parent)) return parent.expression === identifier
  if (api.isPropertyAccessExpression(parent)) return parent.expression === identifier
  return api.isSpreadElement(parent) || isValueReference(api, identifier)
}

const isReferenceSite = (api: TypeScriptApi, identifier: ts.Identifier): boolean => {
  if (isComponentTag(identifier.text)) return isValueReference(api, identifier)
  return !isHookName(identifier.text) && isConsumedValue(api, identifier)
}

const extendsSomething = (node: ts.ClassLikeDeclaration): boolean => (node.heritageClauses?.length ?? 0) > 0

const isComponentDeclaration = (ast: Ast, source: ts.SourceFile, node: ts.Node | null, hops: number): boolean => {
  const api = ast.ts
  if (node === null || hops > MAX_DECLARATION_HOPS) return false
  const inner = ast.unwrap(node)
  const next = (target: ts.Node | undefined): boolean =>
    target !== undefined && isComponentDeclaration(ast, source, target, hops + 1)

  if (api.isExportAssignment(inner)) return next(inner.expression)
  if (api.isVariableDeclaration(inner)) return next(inner.initializer)
  if (api.isFunctionDeclaration(inner) || api.isFunctionExpression(inner) || api.isArrowFunction(inner))
    return ast.containsJsx(inner)
  if (api.isClassDeclaration(inner) || api.isClassExpression(inner))
    return extendsSomething(inner) && ast.containsJsx(inner)
  if (api.isIdentifier(inner)) return next(ast.declarationOf(source, inner.text) ?? undefined)
  if (api.isCallExpression(inner)) return inner.arguments.some((argument) => next(argument)) || next(inner.expression)
  return false
}

type ImportedName = { readonly specifier: string; readonly imported: string }

const importedNameOf = (api: TypeScriptApi, source: ts.SourceFile, local: string): ImportedName | null => {
  for (const statement of source.statements) {
    if (!api.isImportDeclaration(statement) || !api.isStringLiteral(statement.moduleSpecifier)) continue
    const clause = statement.importClause
    if (clause === undefined || clause.isTypeOnly) continue
    const specifier = statement.moduleSpecifier.text
    if (clause.name?.text === local) return { specifier, imported: "default" }
    const named = clause.namedBindings
    if (named === undefined || !api.isNamedImports(named)) continue
    const element = named.elements.find((candidate) => candidate.name.text === local && !candidate.isTypeOnly)
    if (element !== undefined) return { specifier, imported: (element.propertyName ?? element.name).text }
  }
  return null
}

/**
 * A value whose declaration carries JSX — column definitions with `cell` renderers, a render-prop
 * function — is rendered by whoever receives it, so the file it lives in belongs to the tree. The JSX
 * may sit one import away (`[...sharedColumns, ...kindColumns]`), so imported names are followed too,
 * bounded by `MAX_DECLARATION_HOPS` and a visited set.
 */
const memoisedByNode = <T>(compute: (api: TypeScriptApi, node: ts.Node) => T) => {
  const cache = new WeakMap<ts.Node, { readonly value: T }>()
  return (api: TypeScriptApi, node: ts.Node): T => {
    const cached = cache.get(node)
    if (cached !== undefined) return cached.value
    const value = compute(api, node)
    cache.set(node, { value })
    return value
  }
}

const collectLazyImports = (api: TypeScriptApi, root: ts.Node): readonly string[] => {
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      api.isCallExpression(node) &&
      node.expression.kind === api.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      api.isStringLiteralLike(node.arguments[0])
    )
      specifiers.push(node.arguments[0].text)
    api.forEachChild(node, visit)
  }
  visit(root)
  return specifiers
}

const lazyImportsOf = memoisedByNode(collectLazyImports)

const collectIdentifiers = (api: TypeScriptApi, node: ts.Node): readonly string[] => {
  if (api.isIdentifier(node)) return [node.text]
  if (api.isPropertyAccessExpression(node)) return collectIdentifiers(api, node.expression)
  const found: string[] = []
  api.forEachChild(node, (child) => {
    found.push(...collectIdentifiers(api, child))
  })
  return found
}

const identifiersIn = memoisedByNode(collectIdentifiers)

const createRenderableCheck = (ast: Ast, resolve: CrossFileResolve) => {
  const api = ast.ts
  const visited = new Set<string>()

  const importedRenderable = (absFile: string, source: ts.SourceFile, local: string, hops: number): boolean => {
    const imported = importedNameOf(api, source, local)
    if (imported === null) return false
    const target = resolve.resolveModule(absFile, imported.specifier)
    if (target === null) return false
    const declaring = resolve.declarationFile(target, imported.imported)
    const declaringSource = resolve.sourceFile(declaring)
    if (declaringSource === null) return false
    return renderable(declaring, declaringSource, ast.declarationOf(declaringSource, imported.imported), hops + 1)
  }

  const lazyLoadsJsx = (absFile: string, specifier: string): boolean => {
    const target = resolve.resolveModule(absFile, specifier)
    const targetSource = target === null ? null : resolve.sourceFile(target)
    return targetSource !== null && ast.containsJsx(targetSource)
  }

  const renderable = (absFile: string, source: ts.SourceFile, node: ts.Node | null, hops: number): boolean => {
    if (node === null || hops > MAX_DECLARATION_HOPS) return false
    const key = `${absFile}:${String(node.pos)}`
    if (visited.has(key)) return false
    visited.add(key)
    const inner = ast.unwrap(node)
    if (api.isExportAssignment(inner)) return renderable(absFile, source, inner.expression, hops)
    if (api.isVariableDeclaration(inner)) return renderable(absFile, source, inner.initializer ?? null, hops)
    if (ast.containsJsx(inner)) return true
    if (lazyImportsOf(api, inner).some((specifier) => lazyLoadsJsx(absFile, specifier))) return true
    return [...new Set(identifiersIn(api, inner))].some((name) => {
      const local = ast.declarationOf(source, name)
      if (local !== null && local !== node) return renderable(absFile, source, local, hops + 1)
      return importedRenderable(absFile, source, name, hops)
    })
  }

  return (absFile: string, source: ts.SourceFile, node: ts.Node | null): boolean => renderable(absFile, source, node, 0)
}

const referencesComponent = (
  ast: Ast,
  resolve: CrossFileResolve,
  declaring: string,
  source: ts.SourceFile,
  candidates: readonly string[],
): boolean => {
  const isRenderable = createRenderableCheck(ast, resolve)
  return candidates.some((name) => {
    const declaration = ast.declarationOf(source, name)
    return isComponentDeclaration(ast, source, declaration, 0) || isRenderable(declaring, source, declaration)
  })
}

const referencedMemos = new WeakMap<ts.SourceFile, Map<string, boolean>>()

const referencedMemoOf = (source: ts.SourceFile): Map<string, boolean> => {
  const existing = referencedMemos.get(source)
  if (existing !== undefined) return existing
  const created = new Map<string, boolean>()
  referencedMemos.set(source, created)
  return created
}

const exportCandidates = (reference: ValueReference, declaring: string): readonly string[] =>
  declaring === reference.absFile || reference.imported === "default"
    ? [reference.imported]
    : [reference.imported, "default"]

const propertyNamed = (
  api: TypeScriptApi,
  object: ts.ObjectLiteralExpression,
  member: string,
): ts.Node | null => {
  for (const property of object.properties) {
    if (api.isShorthandPropertyAssignment(property) && property.name.text === member) return property.name
    if (!api.isPropertyAssignment(property)) continue
    const name = property.name
    if ((api.isIdentifier(name) || api.isStringLiteral(name)) && name.text === member) return property.initializer
  }
  return null
}

const isObjectAssign = (api: TypeScriptApi, call: ts.CallExpression): boolean => {
  const callee = call.expression
  return (
    api.isPropertyAccessExpression(callee) &&
    api.isIdentifier(callee.expression) &&
    callee.expression.text === "Object" &&
    callee.name.text === "assign"
  )
}

// The value a compound namespace attaches under `member`: a property of `Object.assign(Root, {…})`'s
// later arguments or of a plain object literal.
const memberOfInitializer = (ast: Ast, initializer: ts.Node, member: string): ts.Node | null => {
  const api = ast.ts
  const inner = ast.unwrap(initializer)
  const object = ast.asObjectLiteral(inner)
  if (object !== null) return propertyNamed(api, object, member)

  const call = ast.asCallExpression(inner)
  if (call === null || !isObjectAssign(api, call)) return null
  for (const argument of call.arguments.slice(1).reverse()) {
    const parts = ast.asObjectLiteral(ast.unwrap(argument))
    const found = parts === null ? null : propertyNamed(api, parts, member)
    if (found !== null) return found
  }
  return null
}

// `Root.Body = Body` written at the top level of the namespace's own file.
const staticAssignment = (ast: Ast, source: ts.SourceFile, local: string, member: string): ts.Node | null => {
  const api = ast.ts
  for (const statement of source.statements) {
    if (!api.isExpressionStatement(statement)) continue
    const assignment = statement.expression
    if (!api.isBinaryExpression(assignment) || assignment.operatorToken.kind !== api.SyntaxKind.EqualsToken) continue
    const target = assignment.left
    if (!api.isPropertyAccessExpression(target) || target.name.text !== member) continue
    if (api.isIdentifier(target.expression) && target.expression.text === local) return assignment.right
  }
  return null
}

const localDeclarationOf = (ast: Ast, source: ts.SourceFile, exportName: string): ts.Node | null => {
  const origin = ast.exportOrigin(source, exportName)
  const declaration = origin === null || origin.kind !== "declared" ? null : origin.node
  if (declaration === null || !ast.ts.isExportAssignment(declaration)) return declaration
  const expression = ast.unwrap(declaration.expression)
  return ast.ts.isIdentifier(expression) ? ast.declarationOf(source, expression.text) : expression
}

const namedDeclarationText = (api: TypeScriptApi, declaration: ts.Node): string | null => {
  if (api.isVariableDeclaration(declaration)) return api.isIdentifier(declaration.name) ? declaration.name.text : null
  if (api.isFunctionDeclaration(declaration) || api.isClassDeclaration(declaration))
    return declaration.name?.text ?? null
  return null
}

const memberValueOf = (ast: Ast, source: ts.SourceFile, exportName: string, member: string): ts.Node | null => {
  const api = ast.ts
  const declaration = localDeclarationOf(ast, source, exportName)
  if (declaration === null) return null
  const initializer = api.isVariableDeclaration(declaration) ? declaration.initializer : declaration
  const attached = initializer === undefined ? null : memberOfInitializer(ast, initializer, member)
  if (attached !== null) return attached
  const local = namedDeclarationText(api, declaration)
  return local === null ? null : staticAssignment(ast, source, local, member)
}

const namespaceReExport = (api: TypeScriptApi, source: ts.SourceFile, exportName: string): string | null => {
  for (const statement of source.statements) {
    if (!api.isExportDeclaration(statement) || statement.exportClause === undefined) continue
    if (!api.isNamespaceExport(statement.exportClause) || statement.exportClause.name.text !== exportName) continue
    const specifier = statement.moduleSpecifier
    if (specifier !== undefined && api.isStringLiteral(specifier)) return specifier.text
  }
  return null
}

type Target = { readonly kind: "file"; readonly file: string } | { readonly kind: "library" }

type TableOf = (declaring: string, source: ts.SourceFile, resolve: CrossFileResolve) => FileBindingTable

const LIBRARY: Target = { kind: "library" }

const importTarget = (binding: Binding | null, member: string | null, resolve: CrossFileResolve): Target | null => {
  if (binding === null || (binding.kind !== "import" && binding.kind !== "dynamic-import")) return null
  if (binding.file === null) return LIBRARY
  const exportName = binding.imported === "*" ? member : binding.imported
  return exportName === null ? null : { kind: "file", file: resolve.declarationFile(binding.file, exportName) }
}

// The file a namespace member's value comes from: an imported part, a part read off an imported
// namespace (`Parts.Body`), or the namespace's own file when the part is declared there.
const valueTarget = (
  ast: Ast,
  value: ts.Node,
  declaring: string,
  table: FileBindingTable,
  resolve: CrossFileResolve,
): Target => {
  const inner = ast.unwrap(value)
  const identifier = ast.asIdentifier(inner)
  if (identifier !== null) return importTarget(table.get(identifier.text), null, resolve) ?? { kind: "file", file: declaring }

  const access = ast.asPropertyAccess(inner)
  const root = access === null ? null : ast.asIdentifier(access.expression)
  if (access === null || root === null) return { kind: "file", file: declaring }
  return importTarget(table.get(root.text), access.name.text, resolve) ?? { kind: "file", file: declaring }
}

const memberTarget = (
  pending: PendingEdge,
  member: string,
  ctx: ExtractContext,
  resolve: CrossFileResolve,
  tableOf: TableOf,
): Target | null => {
  if (pending.imported === "*") return { kind: "file", file: resolve.declarationFile(pending.absFile, member) }

  const declaring = resolve.declarationFile(pending.absFile, pending.imported)
  const source = resolve.sourceFile(declaring)
  if (source === null) return null

  const reExported = namespaceReExport(ctx.ts, source, pending.imported)
  if (reExported !== null) {
    const module = resolve.resolveModule(declaring, reExported)
    return module === null ? LIBRARY : { kind: "file", file: resolve.declarationFile(module, member) }
  }

  const value = memberValueOf(ctx.ast, source, pending.imported, member)
  return value === null ? null : valueTarget(ctx.ast, value, declaring, tableOf(declaring, source, resolve), resolve)
}

// `<Root.Body/>` renders the part attached under `Body`; when the namespace cannot be read the tag
// falls back to the namespace's own declaring file.
const targetOf = (pending: PendingEdge, ctx: ExtractContext, resolve: CrossFileResolve, tableOf: TableOf): Target => {
  const fallback: Target = { kind: "file", file: resolve.declarationFile(pending.absFile, pending.imported) }
  if (pending.member === null) return fallback
  return memberTarget(pending, pending.member, ctx, resolve, tableOf) ?? fallback
}

export const AMBIGUOUS_COMPONENT_NAME_CODE = "facts/ambiguous-component-name" as const

const DYNAMIC_COMPONENT_TAG = "Component"

const IS_ATTRIBUTE = "is"

type FileBinding = Extract<Binding, { kind: "import" | "dynamic-import" }> & { readonly file: string }

type TemplateTarget =
  | { readonly kind: "binding"; readonly binding: FileBinding }
  | { readonly kind: "resolved"; readonly file: string; readonly exportName: string; readonly via: Via }
  | { readonly kind: "ambiguous"; readonly files: readonly string[] }

const asFileBinding = (binding: Binding | null): FileBinding | null => {
  if (binding === null || (binding.kind !== "import" && binding.kind !== "dynamic-import")) return null
  return binding.file === null ? null : { ...binding, file: binding.file }
}

const firstFileBinding = (bindings: FileBindingTable, names: readonly string[]): FileBinding | null =>
  names.reduce<FileBinding | null>((found, name) => found ?? asFileBinding(bindings.get(name)), null)

const camelOf = (pascal: string): string => pascal.charAt(0).toLowerCase() + pascal.slice(1)

const tagNames = (element: TemplateElement): readonly string[] => [
  ...new Set([...element.names, camelOf(primaryNameOf(element))]),
]

const optionsObjectOf = (ast: Ast, source: ts.SourceFile): ts.ObjectLiteralExpression | null => {
  const api = ast.ts
  const assignment = source.statements.find(api.isExportAssignment)
  if (assignment === undefined) return null
  const expression = ast.unwrap(assignment.expression)
  const identifier = ast.asIdentifier(expression)
  const declared = identifier === null ? null : ast.declarationOf(source, identifier.text)
  const value = declared !== null && api.isVariableDeclaration(declared) ? declared.initializer : expression
  if (value === undefined) return null
  const inner = ast.unwrap(value)
  const call = ast.asCallExpression(inner)
  const [first] = call === null ? [inner] : call.arguments
  return first === undefined ? null : ast.asObjectLiteral(ast.unwrap(first))
}

const registrationOf = (api: TypeScriptApi, property: ts.ObjectLiteralElementLike): [string, string] | null => {
  if (api.isShorthandPropertyAssignment(property)) return [toPascal(property.name.text), property.name.text]
  if (!api.isPropertyAssignment(property) || !api.isIdentifier(property.initializer)) return null
  const name = property.name
  if (!api.isIdentifier(name) && !api.isStringLiteral(name)) return null
  return [toPascal(name.text), property.initializer.text]
}

const optionsRegistrations = (ast: Ast, source: ts.SourceFile): ReadonlyMap<string, string> => {
  const options = optionsObjectOf(ast, source)
  const components = options === null ? null : propertyNamed(ast.ts, options, "components")
  const object = components === null ? null : ast.asObjectLiteral(ast.unwrap(components))
  if (object === null) return new Map()
  return new Map(
    object.properties.flatMap((property) => {
      const registration = registrationOf(ast.ts, property)
      return registration === null ? [] : [registration]
    }),
  )
}

const registeredBinding = (
  ctx: ExtractContext,
  registrations: ReadonlyMap<string, string>,
  name: string,
): FileBinding | null => {
  const local = registrations.get(toPascal(name))
  return local === undefined ? null : asFileBinding(ctx.bindings.get(local))
}

const SHADOWABLE_VIAS: ReadonlySet<string> = new Set(["ambient", "lazy"])

const EDGE_VIA_BY_RESOLUTION = {
  selector: "selector",
  "selector-global": "selector-global",
  lazy: "lazy",
  ambient: undefined,
} as const satisfies Record<TagResolutionVia, Via>

const edgeViaOf = (via: TagResolutionVia): Via => EDGE_VIA_BY_RESOLUTION[via]

const resolutionTargetOf = (resolution: TagResolution): TemplateTarget => {
  if (resolution.kind === "ambiguous") return { kind: "ambiguous", files: sortedUnique(resolution.files) }
  return { kind: "resolved", file: resolution.file, exportName: resolution.exportName, via: edgeViaOf(resolution.via) }
}

const isAuthoritative = (resolution: TagResolution): boolean =>
  resolution.kind === "file" && !SHADOWABLE_VIAS.has(resolution.via)

const templateTargetOf = (
  ctx: ExtractContext,
  registrations: ReadonlyMap<string, string>,
  doc: TemplateDoc,
  element: TemplateElement,
): TemplateTarget | null => {
  const resolution = ctx.resolveTag(doc, element)
  if (resolution !== null && isAuthoritative(resolution)) return resolutionTargetOf(resolution)
  const binding = firstFileBinding(ctx.bindings, tagNames(element)) ?? registeredBinding(ctx, registrations, element.tag)
  if (binding !== null) return { kind: "binding", binding }
  return resolution === null ? null : resolutionTargetOf(resolution)
}

const plainElementTargetOf = (ctx: ExtractContext, doc: TemplateDoc, element: TemplateElement): TemplateTarget | null => {
  const resolution = ctx.resolveTag(doc, element)
  if (resolution === null) return null
  return resolution.kind === "ambiguous" || isAuthoritative(resolution) ? resolutionTargetOf(resolution) : null
}

const dynamicComponentNames = (ctx: ExtractContext, element: TemplateElement): readonly string[] =>
  element.attributes
    .filter((attribute) => attribute.kind === "bound" && attribute.name === IS_ATTRIBUTE && attribute.expression !== null)
    .flatMap((attribute) => {
      const expression = ctx.templateExpression(attribute.expression ?? "")
      return expression === null ? [] : identifiersIn(ctx.ts, expression)
    })

const isRenderableTag = (element: TemplateElement, builtins: ReadonlySet<string>): boolean =>
  element.kind === "component" && !element.names.some((name) => builtins.has(name))

const elementTargetOf = (
  element: TemplateElement,
  builtins: ReadonlySet<string>,
  ctx: ExtractContext,
  registrations: ReadonlyMap<string, string>,
  doc: TemplateDoc,
): TemplateTarget | null => {
  if (element.kind === "element") return plainElementTargetOf(ctx, doc, element)
  return isRenderableTag(element, builtins) ? templateTargetOf(ctx, registrations, doc, element) : null
}

type EdgeTarget = Exclude<TemplateTarget, { readonly kind: "ambiguous" }>

const lazyVia = (lazy: boolean): Via => (lazy ? "lazy" : undefined)

const templateSeed = (target: EdgeTarget, element: TemplateElement): { key: string; seed: PendingSeed } => {
  const local = primaryNameOf(element)
  if (target.kind === "resolved")
    return {
      key: `resolved:${target.file}`,
      seed: {
        local,
        absFile: target.file,
        imported: target.exportName,
        member: null,
        via: element.guard.lazy ? "lazy" : target.via,
        projectFile: target.file,
      },
    }
  const binding = target.binding
  return {
    key: `${binding.file}#${binding.imported}#`,
    seed: {
      local,
      absFile: binding.file,
      imported: binding.imported,
      member: null,
      via: lazyVia(binding.kind === "dynamic-import" || element.guard.lazy),
      projectFile: null,
    },
  }
}

const ambiguityText = (entry: AmbiguousTag): string => `<${entry.tag}> (${entry.files.join(", ")})`

const ambiguityMessage = (entries: readonly AmbiguousTag[]): string =>
  `${String(entries.length)} template tag(s) match more than one component file; no render edge is drawn for them: ${entries.map(ambiguityText).join("; ")}`

type PendingSeed = Omit<PendingEdge, "conditions" | "alwaysRendered" | "repeated">

const importedLocals = (api: TypeScriptApi, statement: ts.Statement): readonly string[] => {
  if (!api.isImportDeclaration(statement) || statement.importClause === undefined) return []
  const clause = statement.importClause
  if (clause.isTypeOnly) return []
  const named = clause.namedBindings
  const own = clause.name === undefined ? [] : [clause.name.text]
  if (named === undefined) return own
  if (api.isNamespaceImport(named)) return [...own, named.name.text]
  return [...own, ...named.elements.filter((element) => !element.isTypeOnly).map((element) => element.name.text)]
}

const declaringFileOf = (binding: Binding | null, resolve: CrossFileResolve): readonly [string, string] | null => {
  if (binding === null || binding.kind !== "import" || binding.file === null) return null
  const declaring = binding.imported === "*" ? binding.file : resolve.declarationFile(binding.file, binding.imported)
  return [binding.file, declaring]
}

const usedFiles = (ctx: ExtractContext, resolve: CrossFileResolve): readonly string[] => {
  const declaring = new Map<string, Set<string>>()
  for (const local of ctx.source.statements.flatMap((statement) => importedLocals(ctx.ts, statement))) {
    const pair = declaringFileOf(ctx.bindings.get(local), resolve)
    if (pair === null) continue
    const [module, file] = pair
    declaring.set(module, (declaring.get(module) ?? new Set<string>()).add(file))
  }
  return ctx.bindings.importedFiles.flatMap((file) => [...(declaring.get(file) ?? [file])])
}

export const createComponentTreeExtractor = (options: ComponentTreeOptions = {}): FactExtractor => {
  const rules = options.kindRules
  const isTraversable =
    options.isTraversable ??
    (rules === undefined
      ? DEFAULT_TRAVERSABLE
      : (file: string) => isTraversableByRule(rules, { file }))
  let state = emptyState()

  const visitIdentifier = (node: ts.Identifier, ctx: ExtractContext): void => {
    if (!isReferenceSite(ctx.ts, node)) return
    const binding = asFileBinding(ctx.bindings.get(node.text))
    if (binding !== null) addReference(binding)
  }

  // A lowercase value from a file the walk already reaches as `uses` (a hook file's `preloadX`) stays a
  // `uses` edge: it is consumed there, not rendered.
  const isUsedValue = (reference: ValueReference, file: string): boolean =>
    !isComponentTag(reference.imported) && isTraversable(file)

  const isReferencedComponent = (reference: ValueReference, declaring: string, ctx: ExtractContext): boolean => {
    if (isSfcFile(declaring)) return true
    const resolve = ctx.resolve ?? null
    const source = resolve?.sourceFile(declaring) ?? null
    if (resolve === null || source === null) return false
    const candidates = exportCandidates(reference, declaring)
    const memo = referencedMemoOf(source)
    const key = `${declaring}#${candidates.join("#")}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    const result = referencesComponent(ctx.ast, resolve, declaring, source, candidates)
    memo.set(key, result)
    return result
  }

  const memberOfTag = (node: ts.JsxOpeningLikeElement, api: TypeScriptApi): string | null => {
    const tag = node.tagName
    return api.isPropertyAccessExpression(tag) && api.isIdentifier(tag.expression) ? tag.name.text : null
  }

  const addUsage = (key: string, seed: PendingSeed, guard: GuardResult): void => {
    const existing = state.pending.get(key)
    const pending =
      existing === undefined
        ? { ...seed, conditions: new Set<string>(), alwaysRendered: false, repeated: false }
        : { ...existing, via: strongerVia(existing.via, seed.via) }
    if (guard.condition !== null) pending.conditions.add(guard.condition)
    pending.alwaysRendered = pending.alwaysRendered || guard.condition === null
    pending.repeated = pending.repeated || guard.repeated
    state.pending.set(key, pending)
  }

  const addReference = (binding: FileBinding): void => {
    if (binding.imported === "*") return
    const key = `${binding.file}#${binding.imported}`
    if (!state.references.has(key)) state.references.set(key, { absFile: binding.file, imported: binding.imported })
  }

  const visitJsx = (node: ts.JsxOpeningLikeElement, ctx: ExtractContext): void => {
    const name = ctx.ast.tagName(node)
    if (!isComponentTag(name) || name === null) return

    const binding = asFileBinding(ctx.bindings.get(name))
    if (binding === null) return

    const member = memberOfTag(node, ctx.ts)
    addUsage(
      `${binding.file}#${binding.imported}#${member ?? ""}`,
      {
        local: name,
        absFile: binding.file,
        imported: binding.imported,
        member,
        via: binding.kind === "dynamic-import" ? "lazy" : undefined,
        projectFile: null,
      },
      ctx.guardOf(node),
    )
  }

  const visitHookCall = (node: ts.Node, ctx: ExtractContext): void => {
    const hook = customHookCalled(ctx.ast, node)
    if (hook === null || state.hooks.has(hook)) return
    state.hooks.add(hook)
    ctx.emitFact("hooks", hook, node)
  }

  const visitDynamicComponent = (
    element: TemplateElement,
    ctx: ExtractContext,
    registrations: ReadonlyMap<string, string>,
  ): void => {
    for (const name of dynamicComponentNames(ctx, element)) {
      const binding = firstFileBinding(ctx.bindings, [name]) ?? registeredBinding(ctx, registrations, name)
      if (binding !== null) addReference(binding)
    }
  }

  const addAmbiguous = (doc: TemplateDoc, element: TemplateElement, files: readonly string[]): void => {
    const tag = primaryNameOf(element)
    const byTag = state.ambiguous.get(doc.file) ?? new Map<string, AmbiguousTag>()
    const known = byTag.get(tag)
    const line = known === undefined ? element.line : Math.min(known.line, element.line)
    byTag.set(tag, { tag, files: sortedUnique([...(known?.files ?? []), ...files]), line })
    state.ambiguous.set(doc.file, byTag)
  }

  const reportAmbiguous = (ctx: ExtractContext): void => {
    for (const file of sortedUnique(state.ambiguous.keys())) {
      const entries = sortBy(state.ambiguous.get(file)?.values() ?? [], (entry) => entry.tag)
      if (entries.length === 0) continue
      ctx.diagnostic({
        severity: "info",
        code: AMBIGUOUS_COMPONENT_NAME_CODE,
        message: ambiguityMessage(entries),
        file,
        line: Math.min(...entries.map((entry) => entry.line)),
      })
    }
  }

  const visitTemplate = (doc: TemplateDoc, ctx: ExtractContext): void => {
    const registrations = optionsRegistrations(ctx.ast, ctx.source)
    const builtins = new Set(ctx.tagsOf(doc.framework).builtins)
    for (const element of doc.elements) {
      if (element.kind === "component" && primaryNameOf(element) === DYNAMIC_COMPONENT_TAG)
        visitDynamicComponent(element, ctx, registrations)
      const target = elementTargetOf(element, builtins, ctx, registrations, doc)
      if (target === null) continue
      if (target.kind === "ambiguous") {
        addAmbiguous(doc, element, target.files)
        continue
      }
      const { key, seed } = templateSeed(target, element)
      addUsage(key, seed, element.guard)
    }
  }

  return {
    name: "component-tree",
    provides: ["renders", "nullGuards", "uses", "hooks"],
    requires: ["nullGuards", "bindings"],
    stage: "main",

    start: () => {
      state = emptyState()
    },

    enter: (node, ctx) => {
      const api = ctx.ts
      if (api.isJsxOpeningElement(node) || api.isJsxSelfClosingElement(node)) visitJsx(node, ctx)
      if (api.isIdentifier(node)) visitIdentifier(node, ctx)
      visitHookCall(node, ctx)
    },

    template: visitTemplate,

    // Cross-file resolution (`declarationFile` parses other files) is confined to `finish` (§5.4).
    finish: (ctx) => {
      const resolve = ctx.resolve
      const edges = new Map<string, RenderEdge>()

      const tableOf = (declaring: string, source: ts.SourceFile, cross: CrossFileResolve): FileBindingTable =>
        bindingTableFor(ctx.ts, source, (specifier) => cross.resolveModule(declaring, specifier))

      for (const pending of [...state.pending.values(), ...lazyExportEdges(ctx.bindings.lazyExports)]) {
        if (pending.projectFile !== null) {
          mergeInto(edges, pending.projectFile, pending)
          continue
        }
        if (resolve === null) {
          mergeInto(edges, pending.absFile, pending)
          continue
        }
        const target = targetOf(pending, ctx, resolve, tableOf)
        if (target.kind === "file") mergeInto(edges, resolve.relative(target.file), pending)
      }

      for (const reference of state.references.values()) {
        if (resolve === null) continue
        const declaring = resolve.declarationFile(reference.absFile, reference.imported)
        const file = resolve.relative(declaring)
        if (edges.has(file) || file === ctx.file || isUsedValue(reference, file)) continue
        if (!isReferencedComponent(reference, declaring, ctx)) continue
        edges.set(file, {
          file,
          conditions: [REFERENCE_CONDITION],
          alwaysRendered: false,
          repeated: false,
          via: "reference",
        })
      }

      for (const file of sortedUnique([...edges.keys()])) {
        const edge = edges.get(file)
        if (edge !== undefined) ctx.emitFact("renders", edge)
      }

      for (const guard of ctx.nullGuards) ctx.emitFact("nullGuards", guard)

      reportAmbiguous(ctx)

      const imported = resolve === null ? ctx.bindings.importedFiles : usedFiles(ctx, resolve).map(resolve.relative)
      for (const file of sortedUnique(imported))
        if (isTraversable(file) && !edges.has(file)) ctx.emitFact("uses", file)
    },
  }
}
