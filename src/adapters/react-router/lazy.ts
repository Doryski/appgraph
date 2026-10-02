import { walk } from "../../core/ast.js"
import { uniqueBy } from "../../core/order.js"
import type { LazyModuleEntry } from "../dynamic-imports.js"
import { dynamicImportsIn, lazyModuleEntry } from "../dynamic-imports.js"
import type { RouteMode } from "../route-dialects.js"
import type { TsNode } from "../types.js"
import { LAZY_EXPORT, THEN_METHOD } from "./constants.js"
import type { ElementsApi } from "./elements.js"
import type { ElementInfo, ItemScope, RouteValue } from "./model.js"
import { EMPTY_ELEMENT, layoutAncestor, mergeInfo } from "./model.js"
import type { ResolveApi } from "./resolve.js"
import type { DiscoveryState } from "./state.js"
import type ts from "typescript"

export const createLazy = (deps: DiscoveryState & ResolveApi & ElementsApi) => {
  const { ctx, unwrapCallOf, analyzeTags, analyzeElement } = deps

  /**
   * `Component: X` / `Component={X}` names the entry directly, classified exactly like `<X/>`. A dialect
   * also reads through its unwrap calls (`errorHandler(X)`) and a factory's dynamic imports
   * (`make(() => import("./X"))`).
   */
  const analyzeComponent = (value: RouteValue | null, mode: RouteMode): ElementInfo => {
    if (value?.value === undefined) return EMPTY_ELEMENT
    const identifier = ctx.ast.asIdentifier(value.value)
    if (identifier !== null)
      return analyzeTags([{ tag: identifier.text, element: null, from: value.file }], value.file, null)
    const wrapped = unwrapCallOf(value.value, mode.unwrapCalls)?.arguments[0]
    if (wrapped !== undefined) return analyzeComponent({ ...value, value: wrapped }, mode)
    return mode.dialect ? analyzeLazyModules(value.value, value.file) : EMPTY_ELEMENT
  }

  type ImportBinder = {
    readonly name: ts.BindingName
    readonly spec: string
  }

  type ImportBinding = {
    readonly spec: string
    readonly exported: string | null
  }

  type NamedImport = {
    readonly spec: string
    readonly exported: string
  }

  const importedSpecOf = (node: TsNode | undefined): string | null => {
    if (node === undefined) return null
    const inner = ctx.unwrap(node)
    const awaited = ctx.ts.isAwaitExpression(inner) ? ctx.unwrap(inner.expression) : inner
    const call = ctx.ast.asCallExpression(awaited)
    if (call === null || call.expression.kind !== ctx.ts.SyntaxKind.ImportKeyword) return null
    return ctx.ast.asStringLiteralLike(call.arguments[0])?.text ?? null
  }

  const callbackOf = (node: TsNode | undefined): ts.ArrowFunction | ts.FunctionExpression | null => {
    const inner = node === undefined ? null : ctx.unwrap(node)
    if (inner === null) return null
    return ctx.ts.isArrowFunction(inner) || ctx.ts.isFunctionExpression(inner) ? inner : null
  }

  const thenBinderOf = (node: TsNode): ImportBinder | null => {
    if (!ctx.ts.isCallExpression(node)) return null
    const access = ctx.ast.asPropertyAccess(node.expression)
    const spec = access === null || access.name.text !== THEN_METHOD ? null : importedSpecOf(access.expression)
    const parameter = callbackOf(node.arguments[0])?.parameters[0]
    return spec === null || parameter === undefined ? null : { name: parameter.name, spec }
  }

  const importBinderOf = (node: TsNode): ImportBinder | null => {
    if (!ctx.ts.isVariableDeclaration(node)) return thenBinderOf(node)
    const spec = importedSpecOf(node.initializer)
    return spec === null ? null : { name: node.name, spec }
  }

  const bindingKeyOf = (element: ts.BindingElement): string | null => {
    const key = element.propertyName ?? element.name
    return ctx.ast.asIdentifier(key)?.text ?? ctx.ast.asStringLiteralLike(key)?.text ?? null
  }

  const importBindingsOf = (binder: ImportBinder): readonly (readonly [string, ImportBinding])[] => {
    if (ctx.ts.isIdentifier(binder.name)) return [[binder.name.text, { spec: binder.spec, exported: null }]]
    if (!ctx.ts.isObjectBindingPattern(binder.name)) return []
    return binder.name.elements.flatMap((element) => {
      const local = ctx.ast.asIdentifier(element.name)
      const exported = element.dotDotDotToken === undefined ? bindingKeyOf(element) : null
      return local === null || exported === null ? [] : [[local.text, { spec: binder.spec, exported }] as const]
    })
  }

  const importBindingsIn = (lazy: TsNode): ReadonlyMap<string, ImportBinding> => {
    const bindings = new Map<string, ImportBinding>()
    walk(lazy, (node) => {
      const binder = importBinderOf(node)
      if (binder === null) return
      for (const [local, binding] of importBindingsOf(binder)) bindings.set(local, binding)
    })
    return bindings
  }

  const namedImportOf = (value: TsNode, bindings: ReadonlyMap<string, ImportBinding>): NamedImport | null => {
    const identifier = ctx.ast.asIdentifier(value)
    const bound = identifier === null ? undefined : bindings.get(identifier.text)
    if (bound !== undefined) return bound.exported === null ? null : { spec: bound.spec, exported: bound.exported }
    const access = ctx.ast.asPropertyAccess(value)
    if (access === null) return null
    const direct = importedSpecOf(access.expression)
    if (direct !== null) return { spec: direct, exported: access.name.text }
    const namespace = ctx.ast.asIdentifier(access.expression)
    const owner = namespace === null ? undefined : bindings.get(namespace.text)
    return owner?.exported === null ? { spec: owner.spec, exported: access.name.text } : null
  }

  const lazyExportValueOf = (property: ts.ObjectLiteralElementLike): TsNode | null => {
    if (ctx.ts.isShorthandPropertyAssignment(property)) return property.name.text === LAZY_EXPORT ? property.name : null
    if (!ctx.ts.isPropertyAssignment(property)) return null
    const key = ctx.ast.asIdentifier(property.name)?.text ?? ctx.ast.asStringLiteralLike(property.name)?.text
    return key === LAZY_EXPORT ? property.initializer : null
  }

  const returnedImportsIn = (lazy: TsNode): readonly NamedImport[] => {
    const bindings = importBindingsIn(lazy)
    const found: NamedImport[] = []
    walk(lazy, (node) => {
      if (!ctx.ts.isObjectLiteralExpression(node)) return
      for (const property of node.properties) {
        const value = lazyExportValueOf(property)
        const named = value === null ? null : namedImportOf(value, bindings)
        if (named !== null) found.push(named)
      }
    })
    return uniqueBy(found, (named) => `${named.spec}|${named.exported}`)
  }

  const namedLazyEntry = (file: string, named: NamedImport): LazyModuleEntry => {
    const declaring = ctx.resolveModule(file, named.spec)
    if (declaring === null)
      return { entry: { kind: "module", from: file, spec: named.spec, exported: named.exported }, target: null }
    const target = ctx.declaredExport(declaring, named.exported)
    return { entry: { kind: "file", ...target }, target }
  }

  const lazyEntriesIn = (lazy: TsNode, file: string): readonly LazyModuleEntry[] => {
    const returned = returnedImportsIn(lazy)
    const covered = new Set(returned.map((named) => named.spec))
    const fallback = uniqueBy(dynamicImportsIn(ctx, lazy), (spec) => spec).filter((spec) => !covered.has(spec))
    return [
      ...returned.map((named) => namedLazyEntry(file, named)),
      ...fallback.map((spec) => lazyModuleEntry(ctx, file, spec, LAZY_EXPORT)),
    ]
  }

  const analyzeLazyModules = (lazy: TsNode, file: string): ElementInfo => {
    const found = lazyEntriesIn(lazy, file)
    if (found.length === 0) return EMPTY_ELEMENT
    return {
      ...EMPTY_ELEMENT,
      entries: found.map((item) => item.entry),
      entryAncestors: found.flatMap((item) =>
        item.target === null ? [] : [layoutAncestor(item.target)],
      ),
    }
  }

  const analyzeLazy = (lazy: RouteValue | null, scope: ItemScope | null): ElementInfo => {
    if (lazy?.value === undefined) return EMPTY_ELEMENT
    const rendered = analyzeElement(lazy.value, lazy.file, scope)
    const rendersNothing = rendered.entries.length === 0 && rendered.redirectTo === null
    return rendersNothing ? mergeInfo(rendered, analyzeLazyModules(lazy.value, lazy.file)) : rendered
  }

  const analyzeValue = (value: RouteValue | null, scope: ItemScope | null): ElementInfo =>
    value?.value === undefined ? EMPTY_ELEMENT : analyzeElement(value.value, value.file, scope)

  return { analyzeComponent, analyzeLazy, analyzeValue }
}

export type LazyApi = ReturnType<typeof createLazy>
