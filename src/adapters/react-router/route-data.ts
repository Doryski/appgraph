import type { TsNode } from "../types.js"
import { ARRAY_GROWTH, STATE_HOOK } from "./constants.js"
import type { ResolveApi } from "./resolve.js"
import type { DiscoveryState } from "./state.js"
import type ts from "typescript"

type GrowthMethod = keyof typeof ARRAY_GROWTH

/** One `routes.push(…)`/`routes.unshift(…)`; `gate` is the condition of the innermost `if` around it. */
export type ArrayGrowth = {
  readonly call: ts.CallExpression
  readonly placement: (typeof ARRAY_GROWTH)[GrowthMethod]
  readonly gate: TsNode | null
}

export type StateInit = {
  readonly init: TsNode
  readonly call: ts.CallExpression
}

const isGrowthMethod = (name: string): name is GrowthMethod => Object.hasOwn(ARRAY_GROWTH, name)

export const createRouteData = (deps: DiscoveryState & ResolveApi) => {
  const { ctx, calleeName, isFunctionLike, returnedBy } = deps

  const stateCallOf = (declaration: ts.VariableDeclaration, name: string): ts.CallExpression | null => {
    const pattern = declaration.name
    const first = ctx.ts.isArrayBindingPattern(pattern) ? pattern.elements[0] : undefined
    const bound = first === undefined || ctx.ts.isOmittedExpression(first) ? null : ctx.ast.asIdentifier(first.name)
    const call = declaration.initializer === undefined ? null : ctx.ast.asCallExpression(declaration.initializer)
    return bound?.text === name && call !== null && calleeName(call) === STATE_HOOK ? call : null
  }

  const stateCallIn = (statements: readonly ts.Statement[], name: string): ts.CallExpression | null => {
    for (const statement of statements) {
      if (!ctx.ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        const call = stateCallOf(declaration, name)
        if (call !== null) return call
      }
    }
    return null
  }

  /** `const [routes, setRoutes] = useState(init)` or `useState(() => init)`: `routes` starts out as `init`. */
  const stateInitOf = (identifier: ts.Identifier): StateInit | null => {
    for (let scope: TsNode | undefined = identifier.parent; scope !== undefined; scope = scope.parent) {
      if (!ctx.ts.isBlock(scope) && !ctx.ts.isSourceFile(scope)) continue
      const call = stateCallIn(scope.statements, identifier.text)
      const argument = call?.arguments[0]
      if (call === null || argument === undefined) continue
      const value = ctx.unwrap(argument)
      const init = isFunctionLike(value) ? returnedBy(value) : value
      return init === null ? null : { init, call }
    }
    return null
  }

  const growthIn = (statement: ts.Statement, name: string, gate: TsNode | null): readonly ArrayGrowth[] => {
    if (ctx.ts.isBlock(statement)) return statement.statements.flatMap((inner) => growthIn(inner, name, gate))
    if (ctx.ts.isIfStatement(statement))
      return [statement.thenStatement, statement.elseStatement].flatMap((branch) =>
        branch === undefined ? [] : growthIn(branch, name, statement.expression),
      )
    if (!ctx.ts.isExpressionStatement(statement)) return []
    const call = ctx.ast.asCallExpression(statement.expression)
    const access = call === null ? null : ctx.ast.asPropertyAccess(call.expression)
    const receiver = access === null ? null : ctx.ast.asIdentifier(access.expression)
    const method = access?.name.text ?? ""
    if (call === null || receiver?.text !== name || !isGrowthMethod(method)) return []
    return [{ call, placement: ARRAY_GROWTH[method], gate }]
  }

  const growthCache = new Map<TsNode, readonly ArrayGrowth[]>()

  /**
   * The `push`/`unshift` calls growing the array a `const` initializer declares, read in the statements
   * beside the declaration and inside the `if` blocks among them; calls anywhere else are not followed.
   */
  const growthOf = (initializer: TsNode): readonly ArrayGrowth[] => {
    const cached = growthCache.get(initializer)
    if (cached !== undefined) return cached
    const declaration = initializer.parent
    const name = declaration !== undefined && ctx.ts.isVariableDeclaration(declaration) ? ctx.ast.asIdentifier(declaration.name) : null
    const container = declaration?.parent?.parent?.parent
    const statements =
      container !== undefined && (ctx.ts.isBlock(container) || ctx.ts.isSourceFile(container)) ? container.statements : []
    const growth = name === null ? [] : statements.flatMap((statement) => growthIn(statement, name.text, null))
    growthCache.set(initializer, growth)
    return growth
  }

  return { stateInitOf, growthOf }
}

export type RouteDataApi = ReturnType<typeof createRouteData>
