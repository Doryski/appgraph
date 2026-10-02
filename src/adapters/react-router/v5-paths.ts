import { convertPathToRegexpPath, convertWouterPath } from "../../core/url.js"
import type { TsNode } from "../types.js"
import { LEADING_SLASH, MATCH_HOOK, MATCH_PATH, MATCH_PROP, MAX_HOPS, QUERY_START } from "./constants.js"
import type { RouteValue } from "./model.js"
import type { ResolveApi } from "./resolve.js"
import type { DiscoveryState } from "./state.js"
import type ts from "typescript"

export type QueryPath = {
  readonly raw: string
  readonly path: string
}

export const queryPathOf = (raw: string): QueryPath | null => {
  const index = raw.search(QUERY_START)
  return index === -1 ? null : { raw, path: raw.slice(0, index) }
}

const withoutQuery = (raw: string): string => queryPathOf(raw)?.path ?? raw

export const createV5Paths = (deps: DiscoveryState & ResolveApi) => {
  const { ctx, exactString, calleeName, valueOf, memberValue } = deps

  type ObjectRef = { readonly object: ts.ObjectLiteralExpression; readonly file: string }

  /** The object literal a name or member chain holds, through local, imported and default-exported consts. */
  const objectOf = (node: TsNode, file: string, depth = 0): ObjectRef | null => {
    if (depth > MAX_HOPS) return null
    const object = ctx.ast.asObjectLiteral(node)
    if (object !== null) return { object, file }
    const access = ctx.ast.asPropertyAccess(node)
    const owner = access === null ? null : objectOf(access.expression, file, depth + 1)
    const member = owner === null || access === null ? null : memberValue(owner.object, access.name.text)
    if (owner !== null && member !== null) return objectOf(member.value, owner.file, depth + 1)
    const identifier = ctx.ast.asIdentifier(node)
    const declared = identifier === null ? null : valueOf(identifier, file)
    return declared === null ? null : objectOf(declared.node, declared.file, depth + 1)
  }

  /** `ROUTES.HOME` where `ROUTES` is a const object — default-exported ones included, which `exactString` misses. */
  const memberString = (node: TsNode, file: string): string | null => {
    const access = ctx.ast.asPropertyAccess(node)
    const owner = access === null ? null : objectOf(access.expression, file)
    const member = owner === null || access === null ? null : memberValue(owner.object, access.name.text)
    return owner === null || member === null ? null : exactString(member.value, owner.file)
  }

  const literalOf = (path: RouteValue): string | null =>
    path.value === undefined ? null : (exactString(path.value, path.file) ?? memberString(path.value, path.file))

  type Declared = {
    readonly declaration: ts.VariableDeclaration
    readonly element: ts.BindingElement | null
  }

  const declaredIn = (statements: readonly ts.Statement[], name: string): Declared | null => {
    for (const statement of statements) {
      if (!ctx.ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (ctx.ast.asIdentifier(declaration.name)?.text === name) return { declaration, element: null }
        const pattern = declaration.name
        const element = ctx.ts.isObjectBindingPattern(pattern)
          ? pattern.elements.find((candidate) => ctx.ast.asIdentifier(candidate.name)?.text === name)
          : undefined
        if (element !== undefined) return { declaration, element }
      }
    }
    return null
  }

  /** The `const` in a block enclosing `identifier` that binds its name, whole or destructured. */
  const declaredFor = (identifier: ts.Identifier): Declared | null => {
    for (let scope: TsNode | undefined = identifier.parent; scope !== undefined; scope = scope.parent) {
      const statements = ctx.ts.isBlock(scope) || ctx.ts.isSourceFile(scope) ? scope.statements : null
      const found = statements === null ? null : declaredIn(statements, identifier.text)
      if (found !== null) return found
    }
    return null
  }

  const isMatchCall = (node: TsNode | undefined): boolean => {
    const call = node === undefined ? null : ctx.ast.asCallExpression(node)
    return call !== null && calleeName(call) === MATCH_HOOK
  }

  /** `match`, `props.match`, `useRouteMatch()`, or a `const` holding `useRouteMatch()`. */
  const isMatchObject = (node: TsNode): boolean => {
    const target = ctx.unwrap(node)
    if (isMatchCall(target)) return true
    const access = ctx.ast.asPropertyAccess(target)
    if (access !== null) return access.name.text === MATCH_PROP
    const identifier = ctx.ast.asIdentifier(target)
    if (identifier === null) return false
    if (identifier.text === MATCH_PROP) return true
    const declared = declaredFor(identifier)
    return declared !== null && declared.element === null && isMatchCall(declared.declaration.initializer)
  }

  /** `match.path`, `useRouteMatch().path`, or `path` out of `const { path } = useRouteMatch()`. */
  const isMatchPath = (node: TsNode): boolean => {
    const target = ctx.unwrap(node)
    const access = ctx.ast.asPropertyAccess(target)
    if (access !== null) return access.name.text === MATCH_PATH && isMatchObject(access.expression)
    const identifier = ctx.ast.asIdentifier(target)
    const declared = identifier === null ? null : declaredFor(identifier)
    const element = declared?.element ?? null
    const member = element === null ? null : ctx.ast.asIdentifier(element.propertyName ?? element.name)
    return member?.text === MATCH_PATH && isMatchCall(declared?.declaration.initializer)
  }

  /** What a path written as `${match.path}/rest` adds below the matched route, else `null`. */
  const matchRelativeOf = (node: TsNode): string | null => {
    const target = ctx.unwrap(node)
    if (isMatchPath(target)) return ""
    if (!ctx.ts.isTemplateExpression(target) || target.head.text !== "" || target.templateSpans.length !== 1) return null
    const span = target.templateSpans[0]
    return span !== undefined && isMatchPath(span.expression) ? span.literal.text : null
  }

  /**
   * A v5 path as a react-router url: a literal is converted from path-to-regexp syntax with any query
   * string dropped, and a `${match.path}/rest` path is `rest`, relative to the route that matched.
   */
  const regexpPathOf = (path: RouteValue): string | null => {
    if (path.value === undefined) return null
    const relative = matchRelativeOf(path.value)
    if (relative !== null) return convertPathToRegexpPath(withoutQuery(relative)).url.replace(LEADING_SLASH, "")
    const raw = literalOf(path)
    return raw === null ? null : convertPathToRegexpPath(withoutQuery(raw)).url
  }

  /** A literal v5 path carrying a query string: react-router matches the pathname only. */
  const regexpQueryOf = (path: RouteValue): QueryPath | null => {
    const raw = literalOf(path)
    return raw === null ? null : queryPathOf(raw)
  }

  /**
   * A wouter path as a url relative to the enclosing base: every wouter path is written from the base (`/`
   * included), so it joins onto it rather than replacing it. A regex path is no string and reads as `null`.
   */
  const wouterPathOf = (path: RouteValue): string | null => {
    const raw = literalOf(path)
    return raw === null ? null : convertWouterPath(raw).url.replace(LEADING_SLASH, "")
  }

  return { regexpPathOf, regexpQueryOf, wouterPathOf }
}

export type V5PathsApi = ReturnType<typeof createV5Paths>
