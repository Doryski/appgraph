import type ts from "typescript"
import { byCodepoint } from "../core/order.js"
import { createValueResolver, negateCondition, type Located, type ValueResolver } from "./array-values.js"
import { objectMembers } from "./source-utils.js"
import type { DiscoverContext, TsNode } from "./types.js"
import { importedBindingOf } from "./values.js"

/**
 * Reads the redirects a data function (`loader`, `clientLoader`, `getServerSideProps`, TanStack
 * `beforeLoad`) performs and classifies them by AS21. A redirect is unconditional only as a top-level
 * statement with no earlier top-level exit; anything else is a conditional guard. Helpers are followed
 * one hop. Nested functions are not read, except promise `.then`/`.catch`/`.finally` callbacks (conditional).
 * Parser-only: no type checker, no evaluation.
 */

export type LoaderGuardKind = "none" | "conditional" | "unconditional"

export type LoaderGuard = {
  readonly kind: LoaderGuardKind
  readonly to: string | null
  readonly condition: string | null
  readonly line: number | null
  /** Ready evidence text; empty only when no redirect was found. */
  readonly label: string
  /** The one-hop helper the redirect lives in. */
  readonly via: string | null
  /** A conditional redirect aimed away from `unauthenticatedTarget`: evidence only, `kind: "none"`. */
  readonly scopedOut: boolean
  readonly file: string | null
  readonly node: TsNode | null
}

export type LoaderGuardOptions = {
  /** Config `redirects.unauthenticated`; narrows conditional guards to redirects aimed at it. */
  readonly unauthenticatedTarget: string | null
  /** Evidence subject for `guardOfFunction`; defaults to `beforeLoad`. */
  readonly subject?: string
}

type Site = {
  readonly node: TsNode
  readonly file: string
  readonly to: string | null
  readonly conditional: boolean
  readonly condition: string | null
  readonly via: string | null
}

type FunctionNode = ts.SignatureDeclaration & { readonly body?: ts.Node }

const REDIRECT_CALLEES: ReadonlySet<string> = new Set(["redirect", "redirectDocument", "replace"])

const PROMISE_CALLBACKS: ReadonlySet<string> = new Set(["then", "catch", "finally"])

const ROUTER_MODULE = /^(?:react-router(?:-dom)?|@remix-run\/.+|@tanstack\/.+|next\/navigation)$/

const CONDITION_TEXT_MAX = 80

const DEFAULT_SUBJECT = "beforeLoad"

const NO_GUARD: LoaderGuard = {
  kind: "none",
  to: null,
  condition: null,
  line: null,
  label: "",
  via: null,
  scopedOut: false,
  file: null,
  node: null,
}

const createGuardReader = (ctx: DiscoverContext, resolver: ValueResolver) => {
  const isFunctionNode = (node: TsNode): node is FunctionNode =>
    ctx.ts.isArrowFunction(node) ||
    ctx.ts.isFunctionExpression(node) ||
    ctx.ts.isFunctionDeclaration(node) ||
    ctx.ts.isMethodDeclaration(node)

  const promiseCallbackOf = (node: TsNode): string | null => {
    const call = node.parent
    if (call === undefined || !ctx.ts.isCallExpression(call) || !call.arguments.some((arg) => arg === node)) return null
    if (!ctx.ts.isPropertyAccessExpression(call.expression)) return null
    const method = call.expression.name.text
    return PROMISE_CALLBACKS.has(method) ? method : null
  }

  const isOwnCallback = (node: TsNode): boolean =>
    (ctx.ts.isArrowFunction(node) || ctx.ts.isFunctionExpression(node)) && promiseCallbackOf(node) !== null

  const walkOwn = (node: TsNode, visit: (node: TsNode) => void): void =>
    node.forEachChild((child) => {
      if (ctx.ts.isFunctionLike(child) && !isOwnCallback(child)) return
      visit(child)
      walkOwn(child, visit)
    })

  const textOf = (node: TsNode): string => ctx.ast.conditionText(node).slice(0, CONDITION_TEXT_MAX)

  const redirectName = (call: ts.CallExpression, file: string): string | null => {
    const callee = ctx.ast.asIdentifier(call.expression)
    if (callee === null) return null
    const binding = ctx.bindingsFor(file).get(callee.text)
    const imported = importedBindingOf(binding)
    if (imported !== null && ROUTER_MODULE.test(imported.module)) return imported.imported
    if (callee.text === "redirect") return callee.text
    return binding === null ? callee.text : null
  }

  const isRedirectCall = (call: ts.CallExpression, file: string): boolean =>
    REDIRECT_CALLEES.has(redirectName(call, file) ?? "")

  const templatePath = (node: TsNode | undefined): string | null => {
    if (node === undefined || !ctx.ts.isTemplateExpression(node)) return null
    const end = node.head.text.search(/[?#]/)
    return end < 0 ? null : node.head.text.slice(0, end)
  }

  const literalTarget = (node: TsNode | undefined): string | null => {
    const text = ctx.ast.asStringLiteralLike(node)?.text ?? templatePath(node)
    return text === null ? null : ctx.normalizeUrl(text)
  }

  const memberValue = (node: TsNode | undefined, name: string): TsNode | undefined => {
    const object = ctx.ast.asObjectLiteral(node)
    return object === null ? undefined : objectMembers(ctx.ast, object).find((member) => member.name === name)?.value
  }

  const callTarget = (call: ts.CallExpression): string | null => {
    const argument = call.arguments[0]
    const object = ctx.ast.asObjectLiteral(argument)
    return literalTarget(object === null ? argument : memberValue(object, "to"))
  }

  const objectRedirectOf = (node: TsNode): { readonly to: string | null } | null => {
    if (!ctx.ts.isReturnStatement(node) || node.expression === undefined) return null
    const redirect = memberValue(ctx.unwrap(node.expression), "redirect")
    return redirect === undefined ? null : { to: literalTarget(memberValue(redirect, "destination")) }
  }

  const isTransparent = (node: TsNode): boolean =>
    ctx.ts.isAwaitExpression(node) || ctx.unwrap(node) !== node

  const liftedOf = (node: TsNode): TsNode => {
    let current = node
    while (current.parent !== undefined && isTransparent(current.parent)) current = current.parent
    return current
  }

  const statementOf = (node: TsNode): TsNode | null => {
    if (ctx.ts.isReturnStatement(node)) return node
    const lifted = liftedOf(node)
    const parent = lifted.parent
    if (parent === undefined) return null
    if (ctx.ts.isExpressionStatement(parent) || ctx.ts.isReturnStatement(parent) || ctx.ts.isThrowStatement(parent))
      return parent
    if (ctx.ts.isVariableDeclaration(parent) && parent.initializer === lifted)
      return parent.parent.parent
    return lifted
  }

  const containsExit = (node: TsNode): boolean => {
    let found = ctx.ts.isReturnStatement(node) || ctx.ts.isThrowStatement(node)
    walkOwn(node, (child) => {
      found = found || ctx.ts.isReturnStatement(child) || ctx.ts.isThrowStatement(child)
    })
    return found
  }

  const earlierExits = (body: TsNode, statement: TsNode | null): readonly TsNode[] | null => {
    if (statement === body) return []
    if (statement === null || statement.parent !== body || !ctx.ts.isBlock(body)) return null
    const index = body.statements.findIndex((candidate) => candidate === statement)
    return body.statements.slice(0, index).filter(containsExit)
  }

  const exitConditionOf = (exit: TsNode): string | null =>
    ctx.ts.isIfStatement(exit) && exit.elseStatement === undefined ? negateCondition(textOf(exit.expression)) : null

  const fallthroughCondition = (exits: readonly TsNode[] | null): string | null => {
    if (exits === null || exits.length === 0) return null
    const conditions = exits.map(exitConditionOf)
    if (conditions.some((condition) => condition === null)) return null
    return conditions.join(" && ").slice(0, CONDITION_TEXT_MAX)
  }

  const caseCondition = (clause: ts.CaseOrDefaultClause): string => {
    const subject = textOf(clause.parent.parent.expression)
    return ctx.ts.isCaseClause(clause) ? `${subject} === ${textOf(clause.expression)}` : `${subject} (default case)`
  }

  const branchCondition = (parent: TsNode, child: TsNode): string | null => {
    if (ctx.ts.isCatchClause(parent)) return "in catch clause"
    const callback = isOwnCallback(child) ? promiseCallbackOf(child) : null
    if (callback !== null) return `in .${callback} callback`
    if (ctx.ts.isIfStatement(parent) && child !== parent.expression) {
      const text = textOf(parent.expression)
      return child === parent.thenStatement ? text : negateCondition(text)
    }
    if (ctx.ts.isConditionalExpression(parent) && child !== parent.condition) {
      const text = textOf(parent.condition)
      return child === parent.whenTrue ? text : negateCondition(text)
    }
    if (ctx.ts.isCaseClause(parent) || ctx.ts.isDefaultClause(parent)) return caseCondition(parent)
    if (!ctx.ts.isBinaryExpression(parent) || child !== parent.right) return null
    const operator = parent.operatorToken.kind
    if (operator === ctx.ts.SyntaxKind.AmpersandAmpersandToken) return textOf(parent.left)
    if (operator === ctx.ts.SyntaxKind.BarBarToken) return negateCondition(textOf(parent.left))
    return null
  }

  const enclosingCondition = (node: TsNode, body: TsNode): string | null => {
    for (let child = node; child !== body && child.parent !== undefined; child = child.parent) {
      const condition = branchCondition(child.parent, child)
      if (condition !== null) return condition
    }
    return null
  }

  const positionOf = (node: TsNode, body: TsNode) => {
    const exits = earlierExits(body, statementOf(node))
    const conditional = exits === null || exits.length > 0
    return { conditional, condition: enclosingCondition(node, body) ?? fallthroughCondition(exits) }
  }

  const directSites = (fn: Located): readonly Site[] => {
    const body = isFunctionNode(fn.node) ? fn.node.body : undefined
    if (body === undefined) return []
    const sites: Site[] = []
    const record = (node: TsNode, to: string | null): void => {
      sites.push({ node, file: fn.file, to, via: null, ...positionOf(node, body) })
    }
    const visit = (node: TsNode): void => {
      const call = ctx.ast.asCallExpression(node)
      if (call !== null && isRedirectCall(call, fn.file)) return record(call, callTarget(call))
      const object = objectRedirectOf(node)
      if (object !== null) record(node, object.to)
    }
    visit(body)
    walkOwn(body, visit)
    return sites
  }

  const helperOf = (call: ts.CallExpression, fn: Located): Located | null => {
    if (ctx.ast.asIdentifier(call.expression) === null || isRedirectCall(call, fn.file)) return null
    const helper = resolver.functionOf(call.expression, fn.file)
    if (helper === null || helper.node === fn.node || helper.file.includes("node_modules/")) return null
    return helper
  }

  const helperSites = (fn: Located): readonly Site[] => {
    const body = isFunctionNode(fn.node) ? fn.node.body : undefined
    if (body === undefined) return []
    const sites: Site[] = []
    const visit = (node: TsNode): void => {
      const call = ctx.ast.asCallExpression(node)
      const helper = call === null ? null : helperOf(call, fn)
      if (call === null || helper === null) return
      const via = call.expression.getText()
      const position = positionOf(call, body)
      for (const site of directSites(helper))
        sites.push({ ...(site.conditional ? site : position), node: call, file: fn.file, to: site.to, via })
    }
    visit(body)
    walkOwn(body, visit)
    return sites
  }

  const sitesOf = (fn: Located): readonly Site[] => [...directSites(fn), ...helperSites(fn)]

  return { sitesOf }
}

const labelOf = (subject: string, site: Site): string => {
  const target = site.to === null ? "redirect (target is not a readable literal)" : `redirect to '${site.to}'`
  const condition = site.condition === null ? "(conditional)" : `(conditional: ${site.condition})`
  const via = site.via === null ? "" : ` via ${site.via}`
  return `${subject} ${target}${site.conditional ? ` ${condition}` : ""}${via}`
}

const guardOfSite = (ctx: DiscoverContext, site: Site, subject: string, options: LoaderGuardOptions): LoaderGuard => {
  const scope = options.unauthenticatedTarget === null ? null : ctx.normalizeUrl(options.unauthenticatedTarget)
  const scopedOut = site.conditional && scope !== null && site.to !== scope
  const kind: LoaderGuardKind = site.conditional ? "conditional" : "unconditional"
  return {
    kind: scopedOut ? "none" : kind,
    to: site.to,
    condition: site.conditional ? site.condition : null,
    line: ctx.lineOf(site.file, site.node),
    label: labelOf(subject, site),
    via: site.via,
    scopedOut,
    file: site.file,
    node: site.node,
  }
}

const rankOf = (guard: LoaderGuard): number => {
  if (guard.kind === "conditional") return 3
  if (guard.kind === "unconditional") return 2
  return guard.scopedOut ? 1 : 0
}

const compareGuards = (a: LoaderGuard, b: LoaderGuard): number =>
  rankOf(b) - rankOf(a) ||
  byCodepoint(a.file ?? "", b.file ?? "") ||
  (a.node?.getStart() ?? 0) - (b.node?.getStart() ?? 0)

const strongest = (guards: readonly LoaderGuard[]): LoaderGuard => [...guards].sort(compareGuards)[0] ?? NO_GUARD

const guardsOf = (
  ctx: DiscoverContext,
  resolver: ValueResolver,
  fn: Located,
  subject: string,
  options: LoaderGuardOptions,
): readonly LoaderGuard[] =>
  createGuardReader(ctx, resolver)
    .sitesOf(fn)
    .map((site) => guardOfSite(ctx, site, subject, options))

const declarationValue = (ctx: DiscoverContext, declaration: TsNode): TsNode | null => {
  if (ctx.ts.isVariableDeclaration(declaration)) return declaration.initializer ?? null
  if (ctx.ts.isExportAssignment(declaration)) return declaration.expression
  return declaration
}

const exportedFunction = (
  ctx: DiscoverContext,
  resolver: ValueResolver,
  file: string,
  name: string,
): Located | null => {
  const declared = ctx.declaredExport(file, name)
  const source = ctx.sourceFile(declared.file)
  const origin = source === null ? null : ctx.ast.exportOrigin(source, declared.exportName)
  if (origin?.kind !== "declared") return null
  const value = declarationValue(ctx, origin.node)
  return value === null ? null : resolver.functionOf(value, declared.file)
}

/** The strongest guard among the exported functions `names` of `file` (e.g. `loader`, `clientLoader`). */
export const guardOfExports = (
  ctx: DiscoverContext,
  file: string,
  names: readonly string[],
  options: LoaderGuardOptions,
): LoaderGuard => {
  const resolver = createValueResolver(ctx)
  return strongest(
    names.flatMap((name) => {
      const fn = exportedFunction(ctx, resolver, file, name)
      return fn === null ? [] : guardsOf(ctx, resolver, fn, name, options)
    }),
  )
}

/** The strongest guard of one function node, or of a name bound to one (a TanStack `beforeLoad` value). */
export const guardOfFunction = (
  ctx: DiscoverContext,
  fn: TsNode,
  file: string,
  options: LoaderGuardOptions,
): LoaderGuard => {
  const resolver = createValueResolver(ctx)
  const located = resolver.functionOf(fn, file)
  return located === null
    ? NO_GUARD
    : strongest(guardsOf(ctx, resolver, located, options.subject ?? DEFAULT_SUBJECT, options))
}
