import type ts from "typescript"
import { walk } from "../core/ast.js"
import type { TypeScriptApi } from "../core/tsconfig.js"

/**
 * Build-mode conditions a route registry is gated by. `devOnly` on a screen means "registered or
 * reachable only in a development build" — every router adapter derives it from the helpers here, so
 * the set of recognised guards is one list, not one regex per adapter.
 */
export type BuildMode = "dev" | "prod"

/** Text probe for a guard anywhere inside an expression (react-router's spread / JSX-child check). */
export const DEV_GUARD = /isDevelopment|import\.meta\.env\.DEV|NODE_ENV|__DEV__/

export const mentionsDevGuard = (node: ts.Node): boolean => DEV_GUARD.test(node.getText())

export const DEV_ONLY_EVIDENCE = {
  declared: "dev-only: the route is declared under a development-build condition",
  blocked: "dev-only: beforeLoad throws in a production build",
  registered: "dev-only: registered (addChildren) only under a development-build condition",
} as const

export const devOnlyNestedEvidence = (parent: string): string => `dev-only: nested under the dev-only route '${parent}'`

const FLAG_MODES: Readonly<Record<string, BuildMode>> = {
  __DEV__: "dev",
  isDevelopment: "dev",
  "import.meta.env.DEV": "dev",
  "import.meta.env.PROD": "prod",
}

const MODE_READS = ["process.env.NODE_ENV", "import.meta.env.MODE"] as const

const MODE_VALUES: Readonly<Record<string, BuildMode>> = { development: "dev", production: "prod" }

const flip = (mode: BuildMode | null): BuildMode | null => {
  if (mode === null) return null
  return mode === "dev" ? "prod" : "dev"
}

const normalized = (node: ts.Node): string => node.getText().replace(/[\s?!]/g, "")

export const createBuildModeReader = (api: TypeScriptApi) => {
  const isModeRead = (node: ts.Node): boolean => (MODE_READS as readonly string[]).includes(normalized(node))

  const modeOfComparison = (expression: ts.BinaryExpression): BuildMode | null => {
    const operator = expression.operatorToken.kind
    const equal =
      operator === api.SyntaxKind.EqualsEqualsEqualsToken || operator === api.SyntaxKind.EqualsEqualsToken
    const unequal =
      operator === api.SyntaxKind.ExclamationEqualsEqualsToken || operator === api.SyntaxKind.ExclamationEqualsToken
    if (!equal && !unequal) return null

    const [read, value] = isModeRead(expression.left)
      ? [expression.left, expression.right]
      : [expression.right, expression.left]
    if (!isModeRead(read) || !api.isStringLiteralLike(value)) return null

    const mode = MODE_VALUES[value.text] ?? null
    return equal ? mode : flip(mode)
  }

  const modeOfLogical = (expression: ts.BinaryExpression): BuildMode | null => {
    const left = modeOf(expression.left)
    const right = modeOf(expression.right)
    if (expression.operatorToken.kind === api.SyntaxKind.AmpersandAmpersandToken) return left ?? right
    if (expression.operatorToken.kind === api.SyntaxKind.BarBarToken) return left === right ? left : null
    return modeOfComparison(expression)
  }

  /** The build mode a condition being TRUE implies, or null when it says nothing about the build. */
  const modeOf = (condition: ts.Node): BuildMode | null => {
    if (api.isParenthesizedExpression(condition)) return modeOf(condition.expression)
    if (api.isPrefixUnaryExpression(condition) && condition.operator === api.SyntaxKind.ExclamationToken)
      return flip(modeOf(condition.operand))
    if (api.isBinaryExpression(condition)) return modeOfLogical(condition)
    return FLAG_MODES[normalized(condition)] ?? null
  }

  const branchMode = (child: ts.Node, parent: ts.Node): BuildMode | null => {
    if (api.isConditionalExpression(parent)) {
      if (child === parent.whenTrue) return modeOf(parent.condition)
      return child === parent.whenFalse ? flip(modeOf(parent.condition)) : null
    }
    if (api.isIfStatement(parent)) {
      if (child === parent.thenStatement) return modeOf(parent.expression)
      return child === parent.elseStatement ? flip(modeOf(parent.expression)) : null
    }
    if (!api.isBinaryExpression(parent) || child !== parent.right) return null
    if (parent.operatorToken.kind === api.SyntaxKind.AmpersandAmpersandToken) return modeOf(parent.left)
    return parent.operatorToken.kind === api.SyntaxKind.BarBarToken ? flip(modeOf(parent.left)) : null
  }

  /**
   * The build mode `node` only runs in: the nearest enclosing ternary branch, `&&`/`||` right operand
   * or `if`/`else` branch whose condition names one. `stopAt` bounds the walk (exclusive).
   */
  const requiredModeAt = (node: ts.Node, stopAt?: ts.Node): BuildMode | null => {
    let child = node
    let parent: ts.Node | undefined = node.parent
    while (parent !== undefined && parent !== stopAt) {
      const mode = branchMode(child, parent)
      if (mode !== null) return mode
      child = parent
      parent = parent.parent
    }
    return null
  }

  const isDevGated = (node: ts.Node, stopAt?: ts.Node): boolean => requiredModeAt(node, stopAt) === "dev"

  /** A route option (`beforeLoad`) that throws — `notFound()`, `redirect()` — only in a production build. */
  const blocksProduction = (scope: ts.Node): boolean => {
    let blocked = false
    walk(scope, (node) => {
      if (blocked || !api.isThrowStatement(node)) return
      blocked = requiredModeAt(node, scope) === "prod"
    })
    return blocked
  }

  return { modeOf, requiredModeAt, isDevGated, blocksProduction }
}

export type BuildModeReader = ReturnType<typeof createBuildModeReader>
