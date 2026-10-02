import { condense } from "../../core/ast.js"
import type { RouteMode } from "../route-dialects.js"
import type { RouteFlavour } from "../route-flavours.js"
import { ROUTE_FLAVOURS } from "../route-flavours.js"
import type { TsNode } from "../types.js"
import { createStringValueReader, importedBindingOf } from "../values.js"
import { MAX_HOPS, ROUTE_CHILD_TEXT_MAX } from "./constants.js"
import type { Bindings, ComponentRef, ObjectMember, RouteElement, RouteList } from "./model.js"
import { NO_BINDINGS } from "./model.js"
import type { DiscoveryState } from "./state.js"
import { regexOf, within } from "./wrappers.js"
import type ts from "typescript"

export const createResolve = (deps: DiscoveryState) => {
  const { ctx, profile, elementFactories, translators, unwrapCalls } = deps

  const stringValue = createStringValueReader(ctx)

  /** A string with no unresolved part: a template hole this source cannot fold is not read as a `:param`. */
  const exactString = (node: TsNode | undefined, file: string): string | null => {
    const flat = node === undefined ? null : ctx.flattenString(node, file)
    if (flat !== null) return flat.dynamic ? null : flat.value
    return stringValue(node, file)
  }

  // Every member is read through `forEachChild`'s LAST child rather than a raw `ts.isX` cast, so a
  // `path:` wrapped in `as const`, a `lazy()` method and a `lazy: async () => …` all yield a value.
  const membersOf = (object: ts.ObjectLiteralExpression): readonly ObjectMember[] =>
    object.properties.flatMap((property): readonly ObjectMember[] => {
      const nameNode = property.name
      if (nameNode === undefined) return []
      const name = ctx.ast.asIdentifier(nameNode)?.text ?? ctx.ast.asStringLiteralLike(nameNode)?.text ?? null
      if (name === null) return []

      let value: TsNode = nameNode
      property.forEachChild((child) => {
        value = child
      })
      return [{ name, value, node: property }]
    })

  const memberValue = (object: ts.ObjectLiteralExpression, name: string): ObjectMember | null =>
    membersOf(object).find((member) => member.name === name) ?? null

  const lastChild = (node: TsNode): TsNode | null => {
    let found: TsNode | null = null
    node.forEachChild((child) => {
      found = child
    })
    return found
  }

  const calleeName = (call: ts.CallExpression): string | null =>
    ctx.ast.asIdentifier(call.expression)?.text ?? ctx.ast.asPropertyAccess(call.expression)?.name.text ?? null

  const isTrue = (node: TsNode): boolean => ctx.unwrap(node).kind === ctx.ts.SyntaxKind.TrueKeyword

  const asRouteElement = (node: TsNode): RouteElement | null =>
    ctx.ts.isJsxElement(node) || ctx.ts.isJsxSelfClosingElement(node) ? node : null

  const openingOf = (element: RouteElement): ts.JsxOpeningLikeElement =>
    ctx.ts.isJsxElement(element) ? element.openingElement : element

  const isRouterTag = (file: string, opening: ts.JsxOpeningLikeElement, name: string): boolean => {
    const tag = ctx.ast.tagName(opening)
    if (tag === null) return false
    const imported = importedBindingOf(ctx.bindingsFor(file).get(tag))
    if (imported === null) return tag === name
    return imported.imported === name && regexOf(profile.module).test(imported.module)
  }

  const isImportedRouterTag = (file: string, opening: ts.JsxOpeningLikeElement, name: string): boolean => {
    const tag = ctx.ast.tagName(opening)
    const imported = tag === null ? null : importedBindingOf(ctx.bindingsFor(file).get(tag))
    return imported !== null && imported.imported === name && regexOf(profile.module).test(imported.module)
  }

  /** The flavour whose route list `opening` roots — `<Routes>` (v6) or an imported `<Switch>` (v5) — else `null`. */
  const rootFlavourOf = (file: string, opening: ts.JsxOpeningLikeElement): RouteFlavour | null =>
    profile.flavours.find((flavour) =>
      flavour.rootImported
        ? isImportedRouterTag(file, opening, flavour.rootTag)
        : isRouterTag(file, opening, flavour.rootTag),
    ) ?? null

  /** The flavour under which an imported `<Route>` renders on its own, outside every root (wouter), else `null`. */
  const looseFlavourOf = (file: string, opening: ts.JsxOpeningLikeElement): RouteFlavour | null =>
    profile.flavours.find((flavour) => flavour.looseRoutes && isImportedRouterTag(file, opening, flavour.routeTag)) ?? null

  const isRouteTag = (file: string, opening: ts.JsxOpeningLikeElement): boolean =>
    profile.flavours.some((flavour) => isRouterTag(file, opening, flavour.routeTag))

  const isFragmentTag = (opening: ts.JsxOpeningLikeElement): boolean => {
    const tag = ctx.ast.tagName(opening)
    return tag === "Fragment" || tag === "React.Fragment"
  }

  const isFunctionLike = (node: TsNode): node is ts.SignatureDeclaration & { readonly body?: ts.Node } =>
    ctx.ts.isArrowFunction(node) || ctx.ts.isFunctionExpression(node) || ctx.ts.isFunctionDeclaration(node)

  const isConst = (statement: ts.VariableStatement): boolean =>
    (statement.declarationList.flags & ctx.ts.NodeFlags.Const) !== 0

  const declaresParameter = (node: TsNode, name: string): boolean =>
    ctx.ts.isFunctionLike(node) &&
    node.parameters.some((parameter) => ctx.ast.asIdentifier(parameter.name)?.text === name)

  const constIn = (statements: readonly ts.Statement[], name: string): TsNode | null => {
    for (const statement of statements) {
      if (!ctx.ts.isVariableStatement(statement) || !isConst(statement)) continue
      const declaration = statement.declarationList.declarations.find(
        (candidate) => ctx.ast.asIdentifier(candidate.name)?.text === name,
      )
      if (declaration?.initializer !== undefined) return declaration.initializer
    }
    return null
  }

  const functionIn = (statements: readonly ts.Statement[], name: string): TsNode | null =>
    statements.find((statement) => ctx.ts.isFunctionDeclaration(statement) && statement.name?.text === name) ?? null

  const enclosingDeclaration = (
    identifier: ts.Identifier,
    lookup: (statements: readonly ts.Statement[], name: string) => TsNode | null,
  ): TsNode | null => {
    for (let scope: TsNode | undefined = identifier.parent; scope !== undefined; scope = scope.parent) {
      if (declaresParameter(scope, identifier.text)) return null
      if (!ctx.ts.isBlock(scope)) continue
      const found = lookup(scope.statements, identifier.text)
      if (found !== null) return found
    }
    return null
  }

  /** A `const` declared in a block enclosing the use — `const availableRoutes = …` inside a component. */
  const enclosingConst = (identifier: ts.Identifier): TsNode | null => enclosingDeclaration(identifier, constIn)

  const localFunction = (identifier: ts.Identifier, file: string): { node: TsNode; file: string } | null => {
    const declared = enclosingDeclaration(
      identifier,
      (statements, name) => functionIn(statements, name) ?? constIn(statements, name),
    )
    const fn = declared === null ? null : ctx.unwrap(declared)
    return fn !== null && isFunctionLike(fn) ? { node: fn, file } : null
  }

  const boundValue = (identifier: ts.Identifier, bindings: Bindings): TsNode | null =>
    bindings
      .filter(
        (binding) =>
          binding.name === identifier.text &&
          binding.scope.getSourceFile() === identifier.getSourceFile() &&
          within(identifier, binding.scope),
      )
      .at(-1)?.value ?? null

  const truthOf = (node: TsNode, bindings: Bindings): boolean | null => {
    const target = ctx.unwrap(node)
    if (target.kind === ctx.ts.SyntaxKind.TrueKeyword) return true
    if (target.kind === ctx.ts.SyntaxKind.FalseKeyword || target.kind === ctx.ts.SyntaxKind.NullKeyword) return false
    if (ctx.ts.isStringLiteralLike(target)) return target.text !== ""
    if (ctx.ts.isNumericLiteral(target)) return Number(target.text) !== 0
    if (ctx.ts.isPrefixUnaryExpression(target) && target.operator === ctx.ts.SyntaxKind.ExclamationToken) {
      const operand = truthOf(target.operand, bindings)
      return operand === null ? null : !operand
    }
    const identifier = ctx.ast.asIdentifier(target)
    if (identifier === null) return null
    if (identifier.text === "undefined") return false
    const bound = boundValue(identifier, bindings)
    return bound === null ? null : truthOf(bound, bindings)
  }

  const literalOf = (node: TsNode, bindings: Bindings): TsNode | null => {
    const target = ctx.unwrap(node)
    const identifier = ctx.ast.asIdentifier(target)
    const bound = identifier === null ? null : boundValue(identifier, bindings)
    if (bound !== null) return bound
    return truthOf(target, NO_BINDINGS) === null ? null : target
  }

  const bindingsOf = (fn: TsNode, call: ts.CallExpression, outer: Bindings): Bindings => {
    if (!isFunctionLike(fn)) return outer
    const own = fn.parameters.flatMap((parameter, index): Bindings => {
      const name = ctx.ast.asIdentifier(parameter.name)
      const argument = call.arguments[index] ?? parameter.initializer
      const value = argument === undefined ? null : literalOf(argument, outer)
      return name === null || value === null ? [] : [{ scope: fn, name: name.text, value }]
    })
    return [...outer, ...own]
  }

  const folded = (node: TsNode, bindings: Bindings): TsNode => {
    if (bindings.length === 0) return node
    const target = ctx.unwrap(node)
    const identifier = ctx.ast.asIdentifier(target)
    const bound = identifier === null ? null : boundValue(identifier, bindings)
    if (bound !== null) return bound
    if (!ctx.ts.isConditionalExpression(target)) return node
    const truth = truthOf(target.condition, bindings)
    if (truth === null) return node
    return folded(truth ? target.whenTrue : target.whenFalse, bindings)
  }

  /** The declaration a name refers to: in this file, or in the module that declares its import. */
  const declarationNamed = (name: string, file: string): { node: TsNode; file: string } | null => {
    const imported = importedBindingOf(ctx.bindingsFor(file).get(name))
    const declaring = imported === null ? file : ctx.resolveModule(file, imported.module)
    if (declaring === null) return null
    const source = ctx.sourceFile(declaring)
    const declaration = source === null ? null : ctx.ast.declarationOf(source, imported?.imported ?? name)
    return declaration === null ? null : { node: declaration, file: declaring }
  }

  const valueOf = (identifier: ts.Identifier, file: string): { node: TsNode; file: string } | null => {
    const local = enclosingConst(identifier)
    if (local !== null) return { node: local, file }
    const declared = declarationNamed(identifier.text, file)
    const initializer = declared === null ? null : lastChild(declared.node)
    return declared === null || initializer === null ? null : { node: initializer, file: declared.file }
  }

  /** A call to one of `names` — a wrapper whose first argument is the real function, route or component. */
  const unwrapCallOf = (node: TsNode, names: readonly string[]): ts.CallExpression | null => {
    const call = ctx.ast.asCallExpression(node)
    const name = call === null ? null : calleeName(call)
    return call !== null && name !== null && names.includes(name) ? call : null
  }

  /** `const routes = memoize(buildRoutes)`: an unwrap-call initializer names the function it wraps. */
  const functionByName = (name: string, file: string, depth = 0): { node: TsNode; file: string } | null => {
    const declared = depth > MAX_HOPS ? null : declarationNamed(name, file)
    if (declared === null) return null
    if (isFunctionLike(declared.node)) return declared
    const initializer = lastChild(declared.node)
    const fn = initializer === null ? null : ctx.unwrap(initializer)
    if (fn !== null && isFunctionLike(fn)) return { node: fn, file: declared.file }
    const wrapped = fn === null ? null : unwrapCallOf(fn, unwrapCalls)
    const argument = wrapped?.arguments[0] === undefined ? null : ctx.ast.asIdentifier(wrapped.arguments[0])
    return argument === null ? null : functionByName(argument.text, declared.file, depth + 1)
  }

  const functionNamed = (call: ts.CallExpression, file: string): { node: TsNode; file: string } | null => {
    const identifier = ctx.ast.asIdentifier(call.expression)
    if (identifier === null) return null
    return localFunction(identifier, file) ?? functionByName(identifier.text, file)
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

  /** The ONE expression a function can return; a second `return` is a branch this source cannot pick. */
  const returnedBy = (fn: TsNode): TsNode | null => {
    const body = isFunctionLike(fn) ? fn.body : undefined
    if (body === undefined) return null
    if (!ctx.ts.isBlock(body)) return ctx.unwrap(body)
    const returns = returnsIn(body)
    const only = returns.length === 1 ? returns[0]?.expression : undefined
    return only === undefined ? null : ctx.unwrap(only)
  }

  /** `getRoutes()` / `buildRoutes()`: the call reads as whatever the called function's single return is. */
  const returnedByCall = (
    node: TsNode,
    file: string,
  ): { node: TsNode; file: string; fn: TsNode; call: ts.CallExpression } | null => {
    const call = ctx.ast.asCallExpression(node)
    const called = call === null ? null : functionNamed(call, file)
    const returned = called === null ? null : returnedBy(called.node)
    if (call === null || called === null || returned === null) return null
    return { node: returned, file: called.file, fn: called.node, call }
  }

  /**
   * §6.2 site 1 + 2: the list is reached through `unwrap`, a local const, an imported const, a
   * `createRoutesFromElements(<Route …/>)` call whose JSX reads into the same model, or a call to a
   * function whose single return is one of these.
   */
  const resolveRouteList = (
    node: TsNode | undefined,
    file: string,
    mode: RouteMode,
    bindings: Bindings = NO_BINDINGS,
    depth = 0,
  ): RouteList | null => {
    if (node === undefined || depth > MAX_HOPS) return null

    const direct = ctx.ast.asArrayLiteral(node)
    if (direct !== null) return { kind: "array", array: direct, file, anchor: direct, mode, bindings }

    const call = ctx.ast.asCallExpression(node)
    if (call !== null) {
      const name = calleeName(call)
      const argument = call.arguments[0]
      if (name !== null && elementFactories.includes(name) && argument !== undefined)
        return { kind: "jsx", nodes: [ctx.unwrap(argument)], file, anchor: call, scope: null, flavour: ROUTE_FLAVOURS.v6 }
      const returned = returnedByCall(call, file)
      if (returned === null) return null
      const bound = bindingsOf(returned.fn, returned.call, bindings)
      return resolveRouteList(returned.node, returned.file, mode, bound, depth + 1)
    }

    const access = ctx.ast.asPropertyAccess(node)
    if (access !== null) {
      const owner = namedRouteObject(access.expression, file)
      const member = owner === null ? null : memberValue(owner.object, access.name.text)
      return owner === null || member === null
        ? null
        : resolveRouteList(member.value, owner.file, mode, bindings, depth + 1)
    }

    const identifier = ctx.ast.asIdentifier(node)
    if (identifier === null) return null

    const declared = valueOf(identifier, file)
    return declared === null ? null : resolveRouteList(declared.node, declared.file, mode, bindings, depth + 1)
  }

  const fileOfTag = (file: string, tag: string): ComponentRef | null => {
    const imported = importedBindingOf(ctx.bindingsFor(file).get(tag))
    if (imported === null) return null
    const declaring = ctx.resolveModule(file, imported.module)
    if (declaring === null) return null
    return ctx.declaredExport(declaring, imported.imported)
  }

  const excerpt = (node: TsNode): string => condense(node.getText()).slice(0, ROUTE_CHILD_TEXT_MAX)

  /** `[…, pluginRoute]`: an entry naming a `const` route object, local or imported. */
  const namedRouteObject = (node: TsNode, file: string): { object: ts.ObjectLiteralExpression; file: string } | null => {
    const identifier = ctx.ast.asIdentifier(node)
    const declared = identifier === null ? null : valueOf(identifier, file)
    const object = declared === null ? null : ctx.ast.asObjectLiteral(declared.node)
    return declared === null || object === null ? null : { object, file: declared.file }
  }

  /** `translateSentryRoute(appRoutes)`: the translator's argument is a route object in the dialect's names. */
  const translatedRoute = (element: TsNode, file: string): { object: ts.ObjectLiteralExpression; file: string } | null => {
    const argument = unwrapCallOf(element, translators)?.arguments[0]
    if (argument === undefined) return null
    const object = ctx.ast.asObjectLiteral(argument)
    return object === null ? namedRouteObject(argument, file) : { object, file }
  }

  return { stringValue, exactString, memberValue, lastChild, calleeName, isTrue, asRouteElement, openingOf, isRouterTag, isImportedRouterTag, rootFlavourOf, looseFlavourOf, isRouteTag, isFragmentTag, isFunctionLike, folded, valueOf, unwrapCallOf, returnedBy, returnedByCall, resolveRouteList, fileOfTag, excerpt, namedRouteObject, translatedRoute }
}

export type ResolveApi = ReturnType<typeof createResolve>
