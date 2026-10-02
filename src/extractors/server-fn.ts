import type ts from "typescript"
import type { ModulePattern } from "../core/bindings.js"
import type { Endpoint } from "../core/model.js"
import type { ExtractContext, FactExtractor } from "./types.js"
import { convertNextAppPath } from "../core/url.js"
import { SCRIPT_EXTENSION_PATTERN } from "../core/extensions.js"

export const SERVER_DIRECTIVE = "use server"

export const HTTP_HANDLER_EXPORTS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const

const ROUTE_FILE = new RegExp(`(^|/)route\\.${SCRIPT_EXTENSION_PATTERN}$`)

const HANDLERS = new Set<string>(HTTP_HANDLER_EXPORTS)

export type ServerFnOptions = {
  readonly factories?: readonly string[]
  readonly factoryModules?: ModulePattern
  readonly routeFile?: RegExp
}

const DEFAULTS = {
  factories: ["createServerFn"],
  factoryModules: /^@tanstack\/(react-)?start$/,
} as const

// `src/app/api/orders/[id]/route.ts` → `/api/orders/:id`, via the core path converter. Parallel
// slots (`@slot`) are stripped first: they are a rendering concern with no URL segment.
// Returns null when the file is not under an `app/` segment, so the caller can fall back.
export const routeHandlerUrl = (file: string): string | null => {
  const segments = file.split("/")
  if (!segments.includes("app")) return null
  return convertNextAppPath(segments.filter((segment) => !segment.startsWith("@")).join("/")).url
}

const hasExportModifier = (api: ExtractContext["ts"], node: ts.Node): boolean =>
  api.canHaveModifiers(node) &&
  (api.getModifiers(node) ?? []).some((modifier) => modifier.kind === api.SyntaxKind.ExportKeyword)

const hasDefaultModifier = (api: ExtractContext["ts"], node: ts.Node): boolean =>
  api.canHaveModifiers(node) &&
  (api.getModifiers(node) ?? []).some((modifier) => modifier.kind === api.SyntaxKind.DefaultKeyword)

const directiveAt = (api: ExtractContext["ts"], statements: readonly ts.Statement[]): boolean => {
  for (const statement of statements) {
    if (!api.isExpressionStatement(statement)) return false
    if (!api.isStringLiteral(statement.expression)) return false
    if (statement.expression.text === SERVER_DIRECTIVE) return true
  }
  return false
}

export const createServerFnExtractor = (options: ServerFnOptions = {}): FactExtractor => {
  const factories = new Set(options.factories ?? DEFAULTS.factories)
  const factoryModules = options.factoryModules ?? DEFAULTS.factoryModules
  const routeFile = options.routeFile ?? ROUTE_FILE

  let defined = 0
  const emitted = new Set<string>()

  const emit = (endpoint: Endpoint, node: ts.Node, ctx: ExtractContext): void => {
    const key = `${endpoint.method} ${endpoint.url}`
    if (emitted.has(key)) return
    emitted.add(key)
    if (endpoint.transport === "rpc") defined += 1
    ctx.emitFact("endpoints", endpoint, node)
  }

  const rpc = (name: string, method: string, node: ts.Node, ctx: ExtractContext): void => {
    // Not a URL: a browser agent cannot navigate to it. `transport: 'rpc'` is what makes the two
    // distinguishable in the output, and `client` is null for every rpc endpoint (§4.4).
    emit({ method, url: `${ctx.file}#${name}`, transport: "rpc", client: null }, node, ctx)
  }

  const nameOf = (node: ts.Node, ctx: ExtractContext): string => {
    let current: ts.Node | undefined = node
    while (current !== undefined) {
      if (ctx.ts.isVariableDeclaration(current) && ctx.ts.isIdentifier(current.name)) return current.name.text
      if (ctx.ts.isFunctionDeclaration(current))
        return hasDefaultModifier(ctx.ts, current) ? "default" : (current.name?.text ?? "default")
      current = current.parent
    }
    return "default"
  }

  const methodOption = (node: ts.Node | undefined, ctx: ExtractContext): string => {
    const object = ctx.ast.asObjectLiteral(node)
    if (object === null) return "GET"

    for (const property of object.properties) {
      if (!ctx.ts.isPropertyAssignment(property)) continue
      if (!ctx.ts.isIdentifier(property.name) || property.name.text !== "method") continue
      const flat = ctx.flattenString(property.initializer)
      if (flat !== null && !flat.dynamic) return flat.value.toUpperCase()
    }

    return "GET"
  }

  const isFactoryCall = (call: ts.CallExpression, ctx: ExtractContext): boolean => {
    const identifier = ctx.ast.asIdentifier(call.expression)
    if (identifier === null) return false

    const binding = ctx.bindings.get(identifier.text)
    if (binding === null || (binding.kind !== "import" && binding.kind !== "dynamic-import")) return false
    if (!ctx.bindings.rootsInModule(identifier.text, factoryModules)) return false

    const imported = binding.imported === "default" || binding.imported === "*" ? identifier.text : binding.imported
    return factories.has(imported)
  }

  const visitDirectiveFunction = (node: ts.Node, ctx: ExtractContext): void => {
    const api = ctx.ts
    const body =
      api.isFunctionDeclaration(node) || api.isFunctionExpression(node) || api.isArrowFunction(node)
        ? node.body
        : undefined
    if (body === undefined || !api.isBlock(body)) return
    if (!directiveAt(api, body.statements)) return

    rpc(nameOf(node, ctx), "POST", node, ctx)
  }

  const visitModuleActions = (ctx: ExtractContext): void => {
    const api = ctx.ts

    for (const statement of ctx.source.statements) {
      if (!hasExportModifier(api, statement)) continue

      if (api.isFunctionDeclaration(statement)) {
        const name = hasDefaultModifier(api, statement) ? "default" : (statement.name?.text ?? "default")
        rpc(name, "POST", statement, ctx)
        continue
      }

      if (!api.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!api.isIdentifier(declaration.name) || declaration.initializer === undefined) continue
        const initializer = ctx.ast.unwrap(declaration.initializer)
        if (!api.isArrowFunction(initializer) && !api.isFunctionExpression(initializer)) continue
        rpc(declaration.name.text, "POST", declaration, ctx)
      }
    }
  }

  const visitRouteHandlers = (ctx: ExtractContext): void => {
    const api = ctx.ts
    const url = routeHandlerUrl(ctx.file)

    // Unlike `createServerFn`/`"use server"`, a route handler IS reachable by a plain HTTP request
    // from a browser agent — it is not RPC. `client: null` mirrors the rpc case: a parser-only tool
    // cannot name the fetch wrapper (if any) that actually calls it.
    const handler = (name: string, node: ts.Node): void => {
      if (!HANDLERS.has(name)) return
      emit(
        { method: name, url: url ?? `${ctx.file}#${name}`, transport: "http", client: null },
        node,
        ctx,
      )
    }

    for (const statement of ctx.source.statements) {
      if (!hasExportModifier(api, statement)) continue

      if (api.isFunctionDeclaration(statement) && statement.name !== undefined) {
        handler(statement.name.text, statement)
        continue
      }

      if (!api.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations)
        if (api.isIdentifier(declaration.name)) handler(declaration.name.text, declaration)
    }
  }

  return {
    name: "server-fn",
    provides: ["endpoints"],
    requires: ["bindings", "stringConstants"],
    stage: "main",

    accepts: (handle) =>
      handle.text.includes("createServerFn") ||
      handle.text.includes(SERVER_DIRECTIVE) ||
      routeFile.test(handle.file),

    start: () => {
      defined = 0
      emitted.clear()
    },

    enter: (node, ctx) => {
      const call = ctx.ast.asCallExpression(node)
      if (call !== null && call === node && isFactoryCall(call, ctx)) {
        rpc(nameOf(call, ctx), methodOption(call.arguments[0], ctx), call, ctx)
        return
      }

      visitDirectiveFunction(node, ctx)
    },

    finish: (ctx) => {
      if (directiveAt(ctx.ts, ctx.source.statements)) visitModuleActions(ctx)
      if (routeFile.test(ctx.file)) visitRouteHandlers(ctx)

      if (defined === 0) return
      ctx.diagnostic({
        severity: "info",
        code: "facts/needs-typechecker",
        message: `${defined} rpc endpoint(s) defined here. Client call sites are NOT linked to them: the link needs cross-file type flow, which a parser-only tool cannot establish.`,
        file: ctx.file,
      })
    },
  }
}
