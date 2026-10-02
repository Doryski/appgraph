import type ts from "typescript"
import type { ModulePattern } from "../core/bindings.js"
import type { Endpoint } from "../core/model.js"
import type { FlatString } from "../core/model.js"
import type { TypeScriptApi } from "../core/tsconfig.js"
import type { CrossFileResolve, ExtractContext, FactExtractor } from "./types.js"
import { exportedConstIn } from "./imported-declaration.js"
import { DYNAMIC_PLACEHOLDER, walk } from "../core/ast.js"
import { DEFAULT_SWR_MODULE } from "./query.js"

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const

export type HttpMethod = (typeof HTTP_METHODS)[number]

// The single list both `detectLibraries` (the `http` group) and this extractor's default module
// patterns read, so a package can never be detected without being extracted or the reverse.
export const HTTP_CLIENT_PACKAGES = ["axios", "ky", "got", "node-fetch", "superagent", "undici", "ofetch"] as const

export const DEFAULT_HTTP_CLIENT_MODULES: readonly ModulePattern[] = HTTP_CLIENT_PACKAGES

export const ANGULAR_HTTP_PACKAGE = "@angular/common"

export const ANGULAR_HTTP_CLIENT = { module: "@angular/common/http", imported: "HttpClient" } as const

export const ANGULAR_REQUEST_METHOD = "request"

export type HttpClientOptions = {
  // Replaces the defaults. Project-local wrapper modules belong in `wrappers`, which is additive.
  readonly clients?: readonly ModulePattern[]
  readonly wrappers?: readonly ModulePattern[]
  readonly allowGlobalFetch?: boolean
}

const METHODS = new Set<string>(HTTP_METHODS)

export const NUXT_FETCH_GLOBALS = ["$fetch", "useFetch", "useLazyFetch"] as const

const NUXT_FETCH_GLOBAL_NAMES = new Set<string>(NUXT_FETCH_GLOBALS)

const SWR_CLIENT = "swr"
const SWR_FETCH_HOOKS = new Set(["default", "useSWR", "useSWRImmutable"])

// `/api/domains${queryString}`: a placeholder glued onto the last path segment is a query-string builder.
const GLUED_QUERY_TAIL = new RegExp(`(?<=[^/?&=])${DYNAMIC_PLACEHOLDER}$`)

const withoutGluedQuery = (url: string): string => url.replace(GLUED_QUERY_TAIL, "")

// A project-local client is reached through at most this many module hops of `const c = other` aliasing
// before the search gives up; `declarationFile` already collapses re-export barrels on its own.
const CLIENT_ALIAS_HOPS = 4

const INTERPOLATED_BASE = `${DYNAMIC_PLACEHOLDER}/`

const isEndpointUrl = (value: string): boolean =>
  !/\s/.test(value) &&
  (value.startsWith("/") || /^https?:\/\//.test(value) || value.startsWith(INTERPOLATED_BASE))

const QUERY_START = /^[?&#]/

type LocalWrite = {
  readonly kind: "assign" | "append" | "rewrite" | "opaque"
  readonly value: ts.Expression | null
}

type LocalUrl = {
  readonly name: string
  readonly declaration: ts.VariableDeclaration
  readonly scope: ts.Node
}

const OPAQUE_WRITE: LocalWrite = { kind: "opaque", value: null }

const isTopLevel = (api: TypeScriptApi, node: ts.Node): boolean => api.isSourceFile(node) || api.isModuleBlock(node)

const unwrapParens = (api: TypeScriptApi, node: ts.Node): ts.Node =>
  api.isParenthesizedExpression(node) ? unwrapParens(api, node.expression) : node

const declares = (api: TypeScriptApi, name: ts.BindingName, text: string): boolean => {
  if (api.isIdentifier(name)) return name.text === text
  return name.elements.some((element) => !api.isOmittedExpression(element) && declares(api, element.name, text))
}

const hasParameter = (api: TypeScriptApi, node: ts.Node, text: string): boolean =>
  api.isFunctionLike(node) && node.parameters.some((parameter) => declares(api, parameter.name, text))

const declarationAmong = (api: TypeScriptApi, scope: ts.Node, text: string): ts.VariableDeclaration | null => {
  if (!api.isBlock(scope) && !api.isCaseClause(scope) && !api.isDefaultClause(scope)) return null
  const declarations = scope.statements
    .filter(api.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
  return declarations.find((declaration) => declares(api, declaration.name, text)) ?? null
}

const localUrlOf = (api: TypeScriptApi, identifier: ts.Identifier): LocalUrl | null => {
  const name = identifier.text
  for (let scope = identifier.parent; scope !== undefined && !isTopLevel(api, scope); scope = scope.parent) {
    if (hasParameter(api, scope, name)) return null
    const declaration = declarationAmong(api, scope, name)
    if (declaration !== null) return { name, declaration, scope }
  }
  return null
}

const refersTo = (api: TypeScriptApi, node: ts.Node, local: LocalUrl): boolean =>
  api.isIdentifier(node) && node.text === local.name && localUrlOf(api, node)?.declaration === local.declaration

const mentions = (api: TypeScriptApi, node: ts.Node, local: LocalUrl): boolean => {
  let found = false
  walk(node, (child) => {
    found ||= refersTo(api, child, local)
  })
  return found
}

const isAssignment = (api: TypeScriptApi, kind: ts.SyntaxKind): boolean =>
  kind >= api.SyntaxKind.FirstAssignment && kind <= api.SyntaxKind.LastAssignment

const binaryWrite = (api: TypeScriptApi, node: ts.BinaryExpression, local: LocalUrl): LocalWrite | null => {
  const kind = node.operatorToken.kind
  if (!isAssignment(api, kind) || !refersTo(api, unwrapParens(api, node.left), local)) return null
  if (kind === api.SyntaxKind.PlusEqualsToken) return { kind: "append", value: node.right }
  if (kind !== api.SyntaxKind.EqualsToken) return OPAQUE_WRITE
  return { kind: mentions(api, node.right, local) ? "rewrite" : "assign", value: node.right }
}

const unaryWrite = (api: TypeScriptApi, node: ts.Node, local: LocalUrl): LocalWrite | null => {
  if (!api.isPrefixUnaryExpression(node) && !api.isPostfixUnaryExpression(node)) return null
  return refersTo(api, unwrapParens(api, node.operand), local) ? OPAQUE_WRITE : null
}

const writesTo = (api: TypeScriptApi, local: LocalUrl): readonly LocalWrite[] => {
  const writes: LocalWrite[] = []
  walk(local.scope, (node) => {
    const write = api.isBinaryExpression(node) ? binaryWrite(api, node, local) : unaryWrite(api, node, local)
    if (write !== null) writes.push(write)
  })
  return writes
}

type Flatten = (node: ts.Node) => FlatString | null

const isQuery = (node: ts.Node, flatten: Flatten): boolean => QUERY_START.test(flatten(node)?.value ?? "")

const rewriteKeepsPath = (api: TypeScriptApi, input: ts.Node, local: LocalUrl, flatten: Flatten): boolean => {
  const node = unwrapParens(api, input)
  if (api.isConditionalExpression(node))
    return rewriteKeepsPath(api, node.whenTrue, local, flatten) && rewriteKeepsPath(api, node.whenFalse, local, flatten)
  if (api.isBinaryExpression(node) && node.operatorToken.kind === api.SyntaxKind.PlusToken)
    return refersTo(api, unwrapParens(api, node.left), local) && isQuery(node.right, flatten)
  if (!api.isTemplateExpression(node) || node.head.text !== "") return false
  const [first] = node.templateSpans
  return first !== undefined && refersTo(api, unwrapParens(api, first.expression), local) && QUERY_START.test(first.literal.text)
}

const keepsPath = (api: TypeScriptApi, write: LocalWrite, local: LocalUrl, flatten: Flatten): boolean => {
  if (write.kind === "assign") return true
  if (write.value === null) return false
  if (write.kind === "append") return isQuery(write.value, flatten)
  return write.kind === "rewrite" && rewriteKeepsPath(api, write.value, local, flatten)
}

const assignedValue = (write: LocalWrite): readonly ts.Expression[] =>
  write.kind === "assign" && write.value !== null ? [write.value] : []

const withTail = (value: string, tail: string): string => (value.includes("?") ? value : `${value}${tail}`)

const localUrlValues = (api: TypeScriptApi, identifier: ts.Identifier, flatten: Flatten): readonly string[] | null => {
  const local = localUrlOf(api, identifier)
  if (local === null) return null
  if (!api.isIdentifier(local.declaration.name)) return []

  const writes = writesTo(api, local)
  const initial = local.declaration.initializer
  const sources = [...(initial === undefined ? [] : [initial]), ...writes.flatMap(assignedValue)]
  const tail = writes.every((write) => keepsPath(api, write, local, flatten)) ? "" : DYNAMIC_PLACEHOLDER
  return sources.flatMap((node) => flatten(node) ?? []).map((flat) => withTail(flat.value, tail))
}

// §5.4: the `main` walk records the unresolved receiver root; the module it roots in is settled in
// `finish`, which is the only stage allowed to parse other files.
type Candidate = {
  readonly root: string | null
  readonly client: string | null
  readonly method: string
  readonly url: string
  readonly node: ts.CallExpression
}

export const createHttpClientExtractor = (options: HttpClientOptions = {}): FactExtractor => {
  const patterns = [...(options.clients ?? DEFAULT_HTTP_CLIENT_MODULES), ...(options.wrappers ?? [])]
  const allowGlobalFetch = options.allowGlobalFetch ?? true
  const emitted = new Set<string>()
  let candidates: Candidate[] = []

  /**
   * A binding whose module is the project's own api-client module. A project's
   * client is almost never imported from `axios` directly — it is `export const apiClient =
   * axios.create(…)` in a local module, re-exported through a barrel. Proving that chain is what
   * separates a real client from a same-named `Map`; guessing by call-site plurality would not.
   */
  const clientFactoryModule = (
    resolve: CrossFileResolve,
    absFile: string,
    exportName: string,
    ctx: ExtractContext,
    hops: number,
  ): string | null => {
    if (hops > CLIENT_ALIAS_HOPS) return null

    const exported = exportedConstIn(resolve, absFile, exportName, ctx)
    if (exported === null) return null
    const { initializer, table } = exported

    const call = ctx.ast.asCallExpression(initializer)
    if (call !== null) {
      const factoryRoot = table.rootIdentifier(call.expression)
      if (factoryRoot === null) return null
      return patterns.some((pattern) => table.rootsInModule(factoryRoot, pattern))
        ? table.moduleOf(factoryRoot) ?? factoryRoot
        : null
    }

    const alias = ctx.ast.asIdentifier(initializer)
    if (alias === null) return null
    const aliasBinding = table.get(alias.text)
    if (aliasBinding === null || aliasBinding.kind !== "import" || aliasBinding.file === null) return null
    return clientFactoryModule(resolve, aliasBinding.file, aliasBinding.imported, ctx, hops + 1)
  }

  const localClientOf = (root: string, ctx: ExtractContext): string | null => {
    const resolve = ctx.resolve
    if (resolve === null) return null

    const binding = ctx.bindings.get(root)
    if (binding === null) return null
    if (binding.kind !== "import" && binding.kind !== "dynamic-import") return null
    if (binding.file === null) return null

    return clientFactoryModule(resolve, binding.file, binding.imported, ctx, 0) === null
      ? null
      : binding.module
  }

  const clientOf = (root: string, ctx: ExtractContext): string | null => {
    if (patterns.some((pattern) => ctx.bindings.rootsInModule(root, pattern)))
      return ctx.bindings.moduleOf(root) ?? root
    // A bare global `fetch`: no binding at all. A local named `fetch` shadows it and is not a client.
    if (allowGlobalFetch && root === "fetch" && ctx.bindings.get("fetch") === null) return "fetch"
    if (NUXT_FETCH_GLOBAL_NAMES.has(root) && ctx.bindings.get(root) === null) return root
    return localClientOf(root, ctx)
  }

  const methodFromOptions = (node: ts.Node | undefined, ctx: ExtractContext): string => {
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

  const emit = (endpoint: Endpoint, node: ts.Node, ctx: ExtractContext): void => {
    const key = `${endpoint.method} ${endpoint.url} ${endpoint.client ?? ""}`
    if (emitted.has(key)) return
    emitted.add(key)
    ctx.emitFact("endpoints", endpoint, node)
  }

  const urlValues = (node: ts.Expression | undefined, ctx: ExtractContext): readonly string[] => {
    const identifier = ctx.ast.asIdentifier(node)
    const local = identifier === null ? null : localUrlValues(ctx.ts, identifier, ctx.flattenString)
    if (local !== null) return local
    const flat = ctx.flattenString(node)
    return flat === null ? [] : [flat.value]
  }

  const endpointUrls = (node: ts.Expression | undefined, ctx: ExtractContext): readonly string[] =>
    [...new Set(urlValues(node, ctx))].filter(isEndpointUrl)

  const isAngularHttpClient = (receiver: ts.Expression, ctx: ExtractContext): boolean => {
    const member = ctx.bindings.memberBinding(receiver)
    return member !== null && member.module === ANGULAR_HTTP_CLIENT.module && member.imported === ANGULAR_HTTP_CLIENT.imported
  }

  const literalMethod = (node: ts.Expression | undefined, ctx: ExtractContext): string | null => {
    const literal = node === undefined ? null : ctx.ast.unwrap(node)
    if (literal === null || !ctx.ts.isStringLiteralLike(literal)) return null
    const method = literal.text.toLowerCase()
    return METHODS.has(method) ? method.toUpperCase() : null
  }

  const angularRequest = (call: ts.CallExpression, method: string, ctx: ExtractContext) => {
    if (METHODS.has(method)) return { method: method.toUpperCase(), urls: endpointUrls(call.arguments[0], ctx) }
    if (method !== ANGULAR_REQUEST_METHOD) return null
    const verb = literalMethod(call.arguments[0], ctx)
    return verb === null ? null : { method: verb, urls: endpointUrls(call.arguments[1], ctx) }
  }

  const visitAngularCall = (call: ts.CallExpression, callee: ts.PropertyAccessExpression, ctx: ExtractContext): boolean => {
    if (!isAngularHttpClient(callee.expression, ctx)) return false
    const request = angularRequest(call, callee.name.text.toLowerCase(), ctx)
    if (request === null || request.urls.length === 0) return false

    for (const url of request.urls)
      candidates.push({ root: null, client: ANGULAR_HTTP_CLIENT.module, method: request.method, url, node: call })
    return true
  }

  const visitMethodCall = (call: ts.CallExpression, ctx: ExtractContext): boolean => {
    const callee = ctx.ast.asPropertyAccess(call.expression)
    if (callee === null) return false

    // An HTTP-ish method name alone would turn `someMap.get('/x')` into an API endpoint, so the
    // receiver must root in a known client.
    const root = ctx.bindings.rootIdentifier(callee.expression)
    if (root === null) return visitAngularCall(call, callee, ctx)

    const method = callee.name.text.toLowerCase()
    if (!METHODS.has(method)) return false

    const urls = endpointUrls(call.arguments[0], ctx)
    if (urls.length === 0) return false

    for (const url of urls) candidates.push({ root, client: null, method: method.toUpperCase(), url, node: call })
    return true
  }

  const isSwrFetchHook = (local: string, ctx: ExtractContext): boolean => {
    const binding = ctx.bindings.get(local)
    if (binding === null || binding.kind !== "import") return false
    return ctx.bindings.rootsInModule(local, DEFAULT_SWR_MODULE) && SWR_FETCH_HOOKS.has(binding.imported)
  }

  /** `useSWR(key, fetcher)`: the string key is the URL the fetcher GETs. */
  const visitSwrCall = (call: ts.CallExpression, ctx: ExtractContext): boolean => {
    const callee = ctx.ast.asIdentifier(call.expression)
    if (callee === null || !isSwrFetchHook(callee.text, ctx)) return false

    for (const url of endpointUrls(call.arguments[0], ctx))
      candidates.push({ root: null, client: SWR_CLIENT, method: "GET", url: withoutGluedQuery(url), node: call })
    return true
  }

  const visitDirectCall = (call: ts.CallExpression, ctx: ExtractContext): void => {
    const callee = ctx.ast.asIdentifier(call.expression)
    if (callee === null) return

    const method = methodFromOptions(call.arguments[1], ctx)
    for (const url of endpointUrls(call.arguments[0], ctx))
      candidates.push({ root: callee.text, client: null, method, url, node: call })
  }

  return {
    name: "http-client",
    provides: ["endpoints"],
    requires: ["bindings", "stringConstants"],
    stage: "main",

    start: () => {
      emitted.clear()
      candidates = []
    },

    enter: (node, ctx) => {
      const call = ctx.ast.asCallExpression(node)
      if (call === null || call !== node) return
      if (visitMethodCall(call, ctx) || visitSwrCall(call, ctx)) return
      visitDirectCall(call, ctx)
    },

    finish: (ctx) => {
      const resolved = new Map<string, string | null>()

      const resolveRoot = (root: string): string | null => {
        const cached = resolved.get(root)
        if (cached !== undefined) return cached
        const client = clientOf(root, ctx)
        resolved.set(root, client)
        return client
      }

      for (const candidate of candidates) {
        const client = candidate.root === null ? candidate.client : resolveRoot(candidate.root)
        if (client === null) continue
        emit(
          { method: candidate.method, url: candidate.url, transport: "http", client },
          candidate.node,
          ctx,
        )
      }

      candidates = []
    },
  }
}
