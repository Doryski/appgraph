import { condense, isComponentTag, walk } from "../core/ast.js"
import { SCRIPT_GLOB } from "../core/extensions.js"
import { lazyModuleEntry } from "./dynamic-imports.js"
import type { DiscoverContext, EntryRef, TsNode } from "./types.js"
import { importedBindingOf } from "./values.js"
import type ts from "typescript"

const NAVIGATOR_FACTORY = /^create\w+Navigator\w*$/

const SCREEN_FACTORY = /^create\w+Screen$/

const FILE_PROBE = /create\w+Navigator|\.Screen\b/

const SCREEN_MEMBER = "Screen"

const REQUIRE_CALL = "require"

const ATTRIBUTES = {
  name: "name",
  component: "component",
  getComponent: "getComponent",
  children: "children",
  options: "options",
} as const

const STATIC_KEYS = {
  screens: "screens",
  groups: "groups",
  screen: "screen",
  linking: "linking",
  guard: "if",
  options: "options",
  path: "path",
} as const

export type NavigatorRef = {
  readonly id: string
  readonly file: string
  readonly line: number
  readonly factory: string
  readonly call: ts.CallExpression
  readonly config: ts.ObjectLiteralExpression | null
}

export type Registration = {
  readonly name: string | null
  readonly navigator: string
  readonly file: string
  readonly line: number
  readonly entry: EntryRef | null
  readonly optionKeys: Readonly<Record<string, boolean>>
  readonly guardExpr: string | null
  readonly linkingPath: string | null
  readonly linkingNode?: TsNode
  readonly nestedNavigator: string | null
  readonly node: TsNode
}

export type RegistryRead = {
  readonly registrations: readonly Registration[]
  readonly navigators: readonly NavigatorRef[]
}

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration

type HelperScreen = {
  readonly index: number
  readonly element: ts.JsxOpeningLikeElement
}

type ScreenTarget = {
  readonly entry: EntryRef | null
  readonly nested: string | null
}

type StaticScreen = ScreenTarget & {
  readonly options: TsNode | undefined
  readonly linking: TsNode | undefined
  readonly guard: TsNode | undefined
}

const EMPTY_TARGET: ScreenTarget = { entry: null, nested: null }

const joinGuards = (guards: readonly (string | null)[]): string | null => {
  const present = guards.filter((guard): guard is string => guard !== null)
  return present.length === 0 ? null : present.join(" && ")
}

export const createRegistryReader = (ctx: DiscoverContext) => {
  const navigatorMemo = new Map<string, readonly NavigatorRef[]>()
  const helperMemo = new Map<string, ReadonlyMap<string, readonly HelperScreen[]>>()

  const keyText = (name: ts.PropertyName): string | null =>
    ctx.ast.asIdentifier(name)?.text ?? ctx.ast.asStringLiteralLike(name)?.text ?? null

  const calleeName = (call: ts.CallExpression): string | null => {
    const callee = ctx.unwrap(call.expression)
    return ctx.ast.asIdentifier(callee)?.text ?? ctx.ast.asPropertyAccess(callee)?.name.text ?? null
  }

  const callMatching = (node: TsNode | undefined, pattern: RegExp): ts.CallExpression | null => {
    const call = ctx.ast.asCallExpression(node)
    const name = call === null ? null : calleeName(call)
    return call !== null && name !== null && pattern.test(name) ? call : null
  }

  const isFunctionLike = (node: TsNode): node is FunctionLike =>
    ctx.ts.isFunctionDeclaration(node) ||
    ctx.ts.isArrowFunction(node) ||
    ctx.ts.isFunctionExpression(node) ||
    ctx.ts.isMethodDeclaration(node)

  const isScopeBoundary = (node: TsNode): boolean =>
    ctx.ts.isSourceFile(node) || ctx.ts.isBlock(node) || isFunctionLike(node)

  const ownerKeyOf = (call: ts.CallExpression): string | null => {
    for (let node: TsNode = call, parent = call.parent; !isScopeBoundary(parent); node = parent, parent = parent.parent) {
      if (ctx.ts.isVariableDeclaration(parent)) return ctx.ast.asIdentifier(parent.name)?.text ?? null
      if (ctx.ts.isPropertyAssignment(parent) && parent.initializer === node) {
        const key = keyText(parent.name)
        if (key !== STATIC_KEYS.screen) return key
      }
      if (ctx.ts.isCallExpression(parent) && callMatching(parent, SCREEN_FACTORY) === null) return null
    }
    return null
  }

  const navigatorOf = (call: ts.CallExpression, file: string): NavigatorRef => {
    const factory = calleeName(call) ?? ""
    const line = ctx.lineOf(file, call)
    return {
      id: ownerKeyOf(call) ?? `${factory}@${line}`,
      file,
      line,
      factory,
      call,
      config: ctx.ast.asObjectLiteral(call.arguments[0]),
    }
  }

  const navigatorsIn = (file: string): readonly NavigatorRef[] => {
    const cached = navigatorMemo.get(file)
    if (cached !== undefined) return cached
    const source = ctx.sourceFile(file)
    const found: NavigatorRef[] = []
    if (source !== null)
      walk(source, (node) => {
        if (ctx.ts.isCallExpression(node) && callMatching(node, NAVIGATOR_FACTORY) !== null)
          found.push(navigatorOf(node, file))
      })
    navigatorMemo.set(file, found)
    return found
  }

  const isExpressionWrapper = (node: TsNode): boolean =>
    ctx.ts.isAsExpression(node) ||
    ctx.ts.isSatisfiesExpression(node) ||
    ctx.ts.isParenthesizedExpression(node) ||
    ctx.ts.isNonNullExpression(node)

  const declarationHolding = (node: TsNode): TsNode => {
    let holder = node.parent
    while (isExpressionWrapper(holder)) holder = holder.parent
    return holder
  }

  const boundNavigator = (file: string, local: string): string | null => {
    const bound = navigatorsIn(file).find(
      (navigator) => ctx.ts.isVariableDeclaration(declarationHolding(navigator.call)) && navigator.id === local,
    )
    return bound?.id ?? null
  }

  const importedTarget = (file: string, local: string): { readonly file: string; readonly imported: string } | null => {
    const binding = ctx.bindingsFor(file).get(local)
    const imported = importedBindingOf(binding)
    if (imported === null) return null
    const declaring = binding?.kind === "import" && binding.file !== null ? binding.file : ctx.resolveModule(file, imported.module)
    return declaring === null ? null : { file: declaring, imported: imported.imported }
  }

  const navigatorIdOf = (file: string, local: string): string | null => {
    const own = boundNavigator(file, local)
    if (own !== null) return own
    const target = importedTarget(file, local)
    return target === null ? null : boundNavigator(target.file, target.imported)
  }

  const entryOf = (file: string, local: string): EntryRef => {
    if (importedBindingOf(ctx.bindingsFor(file).get(local)) !== null) return { kind: "binding", from: file, local }
    const source = ctx.sourceFile(file)
    const declared = source === null ? null : ctx.ast.declarationOf(source, local)
    return declared === null ? { kind: "binding", from: file, local } : { kind: "file", file, exportName: local }
  }

  const opaqueOf = (node: TsNode, file: string): EntryRef => ({
    kind: "opaque",
    expr: condense(node.getText()),
    file,
    line: ctx.lineOf(file, node),
  })

  const requiredEntry = (node: TsNode, file: string): EntryRef | null => {
    const access = ctx.ast.asPropertyAccess(node)
    const call = ctx.ast.asCallExpression(access === null ? node : access.expression)
    if (call === null || ctx.ast.asIdentifier(call.expression)?.text !== REQUIRE_CALL) return null
    const spec = ctx.ast.asStringLiteralLike(call.arguments[0])?.text
    if (spec === undefined) return null
    return access === null ? lazyModuleEntry(ctx, file, spec).entry : lazyModuleEntry(ctx, file, spec, access.name.text).entry
  }

  const componentEntry = (node: TsNode | undefined, file: string): EntryRef | null => {
    if (node === undefined) return null
    const identifier = ctx.ast.asIdentifier(node)
    if (identifier !== null) return entryOf(file, identifier.text)
    return requiredEntry(ctx.unwrap(node), file) ?? opaqueOf(ctx.unwrap(node), file)
  }

  const asFunction = (node: TsNode | undefined): FunctionLike | null => {
    const inner = node === undefined ? null : ctx.unwrap(node)
    return inner !== null && isFunctionLike(inner) ? inner : null
  }

  const returnedBy = (fn: FunctionLike): TsNode | undefined => {
    const body = fn.body
    if (body === undefined) return undefined
    if (!ctx.ts.isBlock(body)) return body
    return body.statements.find(ctx.ts.isReturnStatement)?.expression
  }

  const getComponentEntry = (node: TsNode | undefined, file: string): EntryRef | null => {
    if (node === undefined) return null
    const fn = asFunction(node)
    if (fn === null) return opaqueOf(ctx.unwrap(node), file)
    const returned = returnedBy(fn)
    return returned === undefined ? opaqueOf(fn, file) : componentEntry(returned, file)
  }

  const renderedEntry = (element: ts.JsxOpeningLikeElement, file: string): EntryRef | null => {
    const holder = ctx.ast.attributeByName(element, ATTRIBUTES.children)?.initializer ?? (ctx.ts.isJsxOpeningElement(element) ? element.parent : undefined)
    if (holder === undefined) return null
    const rendered = ctx.ast
      .jsxElementsIn(holder)
      .filter((candidate) => candidate !== element)
      .map((candidate) => ctx.ast.asIdentifier(candidate.tagName)?.text ?? null)
      .find((tag) => isComponentTag(tag))
    return rendered === undefined || rendered === null ? null : entryOf(file, rendered)
  }

  const attributeValue = (element: ts.JsxOpeningLikeElement, name: string): TsNode | undefined =>
    ctx.ast.attributeByName(element, name)?.initializer

  const jsxEntryOf = (element: ts.JsxOpeningLikeElement, file: string): EntryRef | null => {
    const component = attributeValue(element, ATTRIBUTES.component)
    if (component !== undefined) return componentEntry(component, file)
    const lazy = attributeValue(element, ATTRIBUTES.getComponent)
    if (lazy !== undefined) return getComponentEntry(lazy, file)
    return renderedEntry(element, file)
  }

  const stringOf = (node: TsNode | undefined, file: string): string | null => {
    if (node === undefined) return null
    const literal = ctx.ast.asStringLiteralLike(node)
    if (literal !== null) return literal.text
    const flat = ctx.flattenString(ctx.unwrap(node), file)
    return flat === null || flat.dynamic ? null : flat.value
  }

  const booleanOf = (node: TsNode): boolean | null => {
    const inner = ctx.unwrap(node)
    if (inner.kind === ctx.ts.SyntaxKind.TrueKeyword) return true
    if (inner.kind === ctx.ts.SyntaxKind.FalseKeyword) return false
    return null
  }

  const optionsObject = (node: TsNode | undefined): ts.ObjectLiteralExpression | null => {
    if (node === undefined) return null
    const fn = asFunction(node)
    return ctx.ast.asObjectLiteral(fn === null ? node : returnedBy(fn))
  }

  const optionKeysOf = (node: TsNode | undefined): Readonly<Record<string, boolean>> => {
    const object = optionsObject(node)
    if (object === null) return {}
    const pairs = object.properties.flatMap((property): readonly (readonly [string, boolean])[] => {
      if (!ctx.ts.isPropertyAssignment(property)) return []
      const key = keyText(property.name)
      const value = booleanOf(property.initializer)
      return key === null || value === null ? [] : [[key, value]]
    })
    return Object.fromEntries(pairs)
  }

  const guardText = (node: TsNode | undefined): string | null =>
    node === undefined ? null : ctx.ast.conditionText(ctx.unwrap(node))

  const screenNodeOf = (element: ts.JsxOpeningLikeElement): TsNode =>
    ctx.ts.isJsxOpeningElement(element) ? element.parent : element

  const jsxRegistration = (
    element: ts.JsxOpeningLikeElement,
    file: string,
    navigator: string,
    outerGuard: string | null,
  ): Registration => ({
    name: stringOf(attributeValue(element, ATTRIBUTES.name), file),
    navigator,
    file,
    line: ctx.lineOf(file, element),
    entry: jsxEntryOf(element, file),
    optionKeys: optionKeysOf(attributeValue(element, ATTRIBUTES.options)),
    guardExpr: joinGuards([outerGuard, ctx.guardOf(screenNodeOf(element)).condition]),
    linkingPath: null,
    nestedNavigator: null,
    node: element,
  })

  const screenOwner = (element: ts.JsxOpeningLikeElement): ts.Identifier | null => {
    const access = ctx.ts.isPropertyAccessExpression(element.tagName) ? element.tagName : null
    if (access === null || access.name.text !== SCREEN_MEMBER) return null
    return ctx.ast.asIdentifier(access.expression)
  }

  const parameterIndex = (fn: FunctionLike, local: string): number =>
    fn.parameters.findIndex((parameter) => ctx.ast.asIdentifier(parameter.name)?.text === local)

  const enclosingParameter = (node: TsNode, local: string): { readonly fn: FunctionLike; readonly index: number } | null => {
    for (let current = node.parent; !ctx.ts.isSourceFile(current); current = current.parent) {
      if (!isFunctionLike(current)) continue
      const index = parameterIndex(current, local)
      if (index >= 0) return { fn: current, index }
    }
    return null
  }

  const functionName = (fn: FunctionLike): string | null => {
    if (ctx.ts.isFunctionDeclaration(fn)) return fn.name?.text ?? null
    const holder = declarationHolding(fn)
    return ctx.ts.isVariableDeclaration(holder) ? (ctx.ast.asIdentifier(holder.name)?.text ?? null) : null
  }

  const screenElementsIn = (source: TsNode): readonly ts.JsxOpeningLikeElement[] =>
    ctx.ast.jsxElementsIn(source).filter((element) => screenOwner(element) !== null)

  const helpersIn = (file: string): ReadonlyMap<string, readonly HelperScreen[]> => {
    const cached = helperMemo.get(file)
    if (cached !== undefined) return cached
    const helpers = new Map<string, HelperScreen[]>()
    const source = ctx.sourceFile(file)
    for (const element of source === null ? [] : screenElementsIn(source)) {
      const owner = screenOwner(element)
      const parameter = owner === null ? null : enclosingParameter(element, owner.text)
      const name = parameter === null ? null : functionName(parameter.fn)
      if (parameter === null || name === null) continue
      helpers.set(name, [...(helpers.get(name) ?? []), { index: parameter.index, element }])
    }
    helperMemo.set(file, helpers)
    return helpers
  }

  const helperAt = (call: ts.CallExpression, file: string): { readonly file: string; readonly screens: readonly HelperScreen[] } | null => {
    const callee = ctx.ast.asIdentifier(call.expression)?.text
    if (callee === undefined) return null
    const local = helpersIn(file).get(callee)
    if (local !== undefined) return { file, screens: local }
    const target = importedTarget(file, callee)
    const imported = target === null ? undefined : helpersIn(target.file).get(target.imported)
    return target === null || imported === undefined ? null : { file: target.file, screens: imported }
  }

  const helperRegistrations = (call: ts.CallExpression, file: string): readonly Registration[] => {
    const helper = helperAt(call, file)
    if (helper === null) return []
    const outerGuard = ctx.guardOf(call).condition
    return helper.screens.flatMap((screen) => {
      const argument = ctx.ast.asIdentifier(call.arguments[screen.index])
      const navigator = argument === null ? null : navigatorIdOf(file, argument.text)
      return navigator === null ? [] : [jsxRegistration(screen.element, helper.file, navigator, outerGuard)]
    })
  }

  const directRegistration = (element: ts.JsxOpeningLikeElement, file: string): Registration | null => {
    const owner = screenOwner(element)
    if (owner === null || enclosingParameter(element, owner.text) !== null) return null
    const navigator = navigatorIdOf(file, owner.text)
    return navigator === null ? null : jsxRegistration(element, file, navigator, null)
  }

  const initializerOf = (property: ts.ObjectLiteralElementLike): TsNode | undefined => {
    if (ctx.ts.isPropertyAssignment(property)) return property.initializer
    return ctx.ts.isShorthandPropertyAssignment(property) ? property.name : undefined
  }

  const propertyValue = (object: ts.ObjectLiteralExpression | null, key: string): TsNode | undefined => {
    const property = object?.properties.find((candidate) => candidate.name !== undefined && keyText(candidate.name) === key)
    return property === undefined ? undefined : initializerOf(property)
  }

  const targetOf = (node: TsNode | undefined, file: string): ScreenTarget => {
    if (node === undefined) return EMPTY_TARGET
    const nested = callMatching(node, NAVIGATOR_FACTORY)
    if (nested !== null) return { entry: null, nested: navigatorOf(nested, file).id }
    const identifier = ctx.ast.asIdentifier(node)
    const navigator = identifier === null ? null : navigatorIdOf(file, identifier.text)
    if (navigator !== null) return { entry: null, nested: navigator }
    return { entry: componentEntry(node, file), nested: null }
  }

  const configOf = (object: ts.ObjectLiteralExpression, file: string): StaticScreen => ({
    ...targetOf(propertyValue(object, STATIC_KEYS.screen), file),
    options: propertyValue(object, STATIC_KEYS.options),
    linking: propertyValue(object, STATIC_KEYS.linking),
    guard: propertyValue(object, STATIC_KEYS.guard),
  })

  const staticScreenOf = (node: TsNode, file: string): StaticScreen => {
    const screenCall = callMatching(node, SCREEN_FACTORY)
    const object = ctx.ast.asObjectLiteral(screenCall === null ? node : screenCall.arguments[0])
    if (object !== null) return configOf(object, file)
    return { ...targetOf(node, file), options: undefined, linking: undefined, guard: undefined }
  }

  const linkingPathOf = (node: TsNode | undefined, file: string): string | null => {
    const object = node === undefined ? null : ctx.ast.asObjectLiteral(node)
    return stringOf(object === null ? node : propertyValue(object, STATIC_KEYS.path), file)
  }

  const staticRegistration = (
    property: ts.ObjectLiteralElementLike,
    value: TsNode,
    file: string,
    navigator: string,
    groupGuard: string | null,
  ): Registration => {
    const screen = staticScreenOf(value, file)
    return {
      name: property.name === undefined ? null : keyText(property.name),
      navigator,
      file,
      line: ctx.lineOf(file, property),
      entry: screen.entry,
      optionKeys: optionKeysOf(screen.options),
      guardExpr: joinGuards([groupGuard, guardText(screen.guard)]),
      linkingPath: linkingPathOf(screen.linking, file),
      ...(screen.linking === undefined ? {} : { linkingNode: screen.linking }),
      nestedNavigator: screen.nested,
      node: property,
    }
  }

  const staticScreensIn = (
    screens: TsNode | undefined,
    file: string,
    navigator: string,
    groupGuard: string | null,
  ): readonly Registration[] => {
    const object = screens === undefined ? null : ctx.ast.asObjectLiteral(screens)
    return (object?.properties ?? []).flatMap((property) => {
      const value = initializerOf(property)
      return value === undefined ? [] : [staticRegistration(property, value, file, navigator, groupGuard)]
    })
  }

  const staticGroupsIn = (groups: TsNode | undefined, file: string, navigator: string): readonly Registration[] => {
    const object = groups === undefined ? null : ctx.ast.asObjectLiteral(groups)
    return (object?.properties ?? []).flatMap((property) => {
      if (!ctx.ts.isPropertyAssignment(property)) return []
      const group = ctx.ast.asObjectLiteral(property.initializer)
      const guard = guardText(propertyValue(group, STATIC_KEYS.guard))
      return staticScreensIn(propertyValue(group, STATIC_KEYS.screens), file, navigator, guard)
    })
  }

  const staticRegistrations = (navigator: NavigatorRef): readonly Registration[] => [
    ...staticScreensIn(propertyValue(navigator.config, STATIC_KEYS.screens), navigator.file, navigator.id, null),
    ...staticGroupsIn(propertyValue(navigator.config, STATIC_KEYS.groups), navigator.file, navigator.id),
  ]

  const registrationsAt = (node: TsNode, file: string, navigators: ReadonlyMap<TsNode, NavigatorRef>): readonly Registration[] => {
    const navigator = navigators.get(node)
    if (navigator !== undefined) return staticRegistrations(navigator)
    if (ctx.ts.isCallExpression(node)) return helperRegistrations(node, file)
    if (!ctx.ts.isJsxOpeningElement(node) && !ctx.ts.isJsxSelfClosingElement(node)) return []
    const direct = directRegistration(node, file)
    return direct === null ? [] : [direct]
  }

  const registrationsIn = (file: string): readonly Registration[] => {
    const source = ctx.sourceFile(file)
    if (source === null) return []
    const navigators = new Map<TsNode, NavigatorRef>(navigatorsIn(file).map((navigator) => [navigator.call, navigator]))
    const found: Registration[] = []
    walk(source, (node) => {
      found.push(...registrationsAt(node, file, navigators))
    })
    return found
  }

  const candidateFiles = (): readonly string[] =>
    ctx.glob(SCRIPT_GLOB).filter((file) => !ctx.isGenerated(file) && FILE_PROBE.test(ctx.readFile(file) ?? ""))

  const read = (): RegistryRead => {
    const files = candidateFiles()
    return {
      registrations: files.flatMap(registrationsIn),
      navigators: files.flatMap(navigatorsIn),
    }
  }

  return { read }
}

export const readRegistrations = (ctx: DiscoverContext): RegistryRead => createRegistryReader(ctx).read()
