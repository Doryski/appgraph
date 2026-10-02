import { posix } from "node:path"
import type ts from "typescript"
import type { ModulePattern } from "../core/bindings.js"
import type { ExtractContext, FactExtractor } from "./types.js"
import { SCRIPT_EXTENSIONS } from "../core/extensions.js"

export const CONVEX_KINDS = ["query", "mutation", "action"] as const

export type ConvexKind = (typeof CONVEX_KINDS)[number]

export const CONVEX_API_MODULE: ModulePattern = /(^|\/)_generated\/api(\.[cm]?js)?$/

export const UNKNOWN_FUNCTION_CODE = "facts/convex-unknown-function"

const API_SUFFIX = /\/?_generated\/api(\.[cm]?js)?$/

const API_EXPORTS = new Set(["api", "internal"])

const CONVEX_CALLEES = [
  {
    module: /^(convex\/react|convex-helpers\/react(\/.*)?)$/,
    names: { useQuery: "query", usePaginatedQuery: "query", useMutation: "mutation", useAction: "action" },
  },
  {
    module: /^convex\/nextjs$/,
    names: { fetchQuery: "query", preloadQuery: "query", fetchMutation: "mutation", fetchAction: "action" },
  },
  {
    module: /^(@convex-dev\/react-query|convex\/react-query)$/,
    names: { convexQuery: "query", convexAction: "action", useConvexMutation: "mutation", useConvexAction: "action" },
  },
] as const satisfies readonly { module: RegExp; names: Readonly<Record<string, ConvexKind>> }[]

const CLIENT_METHODS: Readonly<Record<string, ConvexKind>> = { query: "query", mutation: "mutation", action: "action" }

const SERVER_BUILDER_KINDS = [
  [/query$/i, "query"],
  [/mutation$/i, "mutation"],
  [/action$/i, "action"],
] as const

const ANCHOR_MODULE = "schema"

type FunctionRef = {
  readonly specifier: string
  readonly module: string
  readonly name: string
}

type Reference = FunctionRef & {
  readonly kind: ConvexKind | null
  readonly node: ts.CallExpression
}

type ServerModule = {
  readonly exports: ReadonlyMap<string, ConvexKind | null>
  readonly opaque: boolean
}

export const convexPath = (ref: Pick<FunctionRef, "module" | "name">): string => `${ref.module}:${ref.name}`

const kindOfBuilder = (name: string): ConvexKind | null =>
  SERVER_BUILDER_KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? null

const importedName = (local: string, ctx: ExtractContext): string | null => {
  const binding = ctx.bindings.get(local)
  if (binding === null || (binding.kind !== "import" && binding.kind !== "dynamic-import")) return null
  return binding.imported === "default" || binding.imported === "*" ? local : binding.imported
}

const calleeKind = (call: ts.CallExpression, ctx: ExtractContext): ConvexKind | null => {
  const access = ctx.ast.asPropertyAccess(call.expression)
  if (access !== null) return CLIENT_METHODS[access.name.text] ?? null

  const identifier = ctx.ast.asIdentifier(call.expression)
  if (identifier === null) return null
  const imported = importedName(identifier.text, ctx)
  if (imported === null) return null

  const entry = CONVEX_CALLEES.find((candidate) => ctx.bindings.rootsInModule(identifier.text, candidate.module))
  if (entry === undefined) return null
  const names: Readonly<Record<string, ConvexKind>> = entry.names
  return names[imported] ?? null
}

const propertyChain = (node: ts.Node, ctx: ExtractContext): { root: string; segments: readonly string[] } | null => {
  const segments: string[] = []
  let current = ctx.ast.unwrap(node)

  for (;;) {
    const access = ctx.ast.asPropertyAccess(current)
    if (access === null) break
    segments.unshift(access.name.text)
    current = ctx.ast.unwrap(access.expression)
  }

  const root = ctx.ast.asIdentifier(current)
  return root === null ? null : { root: root.text, segments }
}

const localInitializer = (node: ts.Node, ctx: ExtractContext): ts.Node | null => {
  const identifier = ctx.ast.asIdentifier(ctx.ast.unwrap(node))
  if (identifier === null) return null
  const declaration = ctx.ast.declarationOf(ctx.source, identifier.text)
  if (declaration === null || !ctx.ts.isVariableDeclaration(declaration)) return null
  return declaration.initializer ?? null
}

const asFunctionRef = (node: ts.Node, ctx: ExtractContext): FunctionRef | null => {
  const chain = propertyChain(node, ctx)
  if (chain === null || chain.segments.length < 2) return null

  const binding = ctx.bindings.get(chain.root)
  if (binding === null || binding.kind !== "import") return null
  if (!API_EXPORTS.has(binding.imported) || !ctx.bindings.rootsInModule(chain.root, CONVEX_API_MODULE)) return null

  return {
    specifier: binding.module,
    module: chain.segments.slice(0, -1).join("/"),
    name: chain.segments[chain.segments.length - 1] ?? "",
  }
}

const functionRefOf = (argument: ts.Node | undefined, ctx: ExtractContext): FunctionRef | null => {
  if (argument === undefined) return null
  const direct = asFunctionRef(argument, ctx)
  if (direct !== null) return direct
  const initializer = localInitializer(argument, ctx)
  return initializer === null ? null : asFunctionRef(initializer, ctx)
}

const exportedNames = (source: ts.SourceFile, ctx: ExtractContext): ServerModule => {
  const exports = new Map<string, ConvexKind | null>()
  let opaque = false

  const builderKind = (initializer: ts.Expression | undefined): ConvexKind | null => {
    const call = initializer === undefined ? null : ctx.ast.asCallExpression(ctx.ast.unwrap(initializer))
    if (call === null) return null
    const callee = ctx.ast.asIdentifier(call.expression) ?? ctx.ast.asPropertyAccess(call.expression)?.name ?? null
    return callee === null ? null : kindOfBuilder(callee.text)
  }

  for (const statement of source.statements) {
    if (ctx.ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      if (clause === undefined || !ctx.ts.isNamedExports(clause)) {
        opaque = true
        continue
      }
      for (const element of clause.elements) if (!exports.has(element.name.text)) exports.set(element.name.text, null)
      continue
    }

    if (ctx.ts.isExportAssignment(statement)) {
      exports.set("default", builderKind(statement.expression))
      continue
    }

    if (ctx.ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      exports.set(statement.name.text, null)
      continue
    }

    if (!ctx.ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations)
      if (ctx.ts.isIdentifier(declaration.name))
        exports.set(declaration.name.text, builderKind(declaration.initializer))
  }

  return { exports, opaque }
}

export const createConvexExtractor = (): FactExtractor => {
  const modules = new WeakMap<ts.SourceFile, ServerModule>()
  const seen = new Set<string>()
  let references: Reference[] = []

  const moduleFile = (specifier: string, module: string, ctx: ExtractContext): string | null => {
    const resolve = ctx.resolve
    if (resolve === null) return null

    const prefix = specifier.replace(API_SUFFIX, "")
    const target = prefix === "" ? module : `${prefix}/${module}`
    const resolved = resolve.resolveModule(ctx.absFile, target)
    if (resolved !== null) return resolved
    if (!target.startsWith(".")) return null

    const base = posix.join(posix.dirname(ctx.absFile), target)
    const candidates = SCRIPT_EXTENSIONS.map((extension) => `${base}${extension}`)
    return candidates.find((file) => resolve.sourceFile(file) !== null) ?? null
  }

  const serverModule = (file: string, ctx: ExtractContext): ServerModule | null => {
    const source = ctx.resolve?.sourceFile(file) ?? null
    if (source === null) return null
    const cached = modules.get(source)
    if (cached !== undefined) return cached
    const parsed = exportedNames(source, ctx)
    modules.set(source, parsed)
    return parsed
  }

  const isAnchored = (specifier: string, ctx: ExtractContext): boolean =>
    moduleFile(specifier, ANCHOR_MODULE, ctx) !== null ||
    references.some(
      (reference) => reference.specifier === specifier && moduleFile(specifier, reference.module, ctx) !== null,
    )

  const reportUnknown = (reference: Reference, reason: string, ctx: ExtractContext): void => {
    ctx.diagnostic({
      severity: "info",
      code: UNKNOWN_FUNCTION_CODE,
      message: `Convex function '${convexPath(reference)}' is referenced but ${reason}; the reference may be stale.`,
      line: ctx.lineOf(reference.node),
    })
  }

  type Check = { readonly kind: ConvexKind | null; readonly missing: string | null }

  const check = (reference: Reference, ctx: ExtractContext): Check => {
    const unchecked = { kind: null, missing: null } as const
    if (ctx.resolve === null) return unchecked

    const file = moduleFile(reference.specifier, reference.module, ctx)
    if (file === null)
      return isAnchored(reference.specifier, ctx)
        ? { kind: null, missing: `no module 'convex/${reference.module}' exists` }
        : unchecked

    const server = serverModule(file, ctx)
    if (server === null || server.opaque) return unchecked
    if (!server.exports.has(reference.name))
      return { kind: null, missing: `'${ctx.resolve.relative(file)}' exports no '${reference.name}'` }
    return { kind: server.exports.get(reference.name) ?? null, missing: null }
  }

  const emitOnce = (key: string, emit: () => void): void => {
    if (seen.has(key)) return
    seen.add(key)
    emit()
  }

  const emit = (reference: Reference, kind: ConvexKind, ctx: ExtractContext): void => {
    const path = convexPath(reference)
    const node = reference.node

    emitOnce(`endpoint ${kind} ${path}`, () =>
      ctx.emitFact("endpoints", { method: kind.toUpperCase(), url: path, transport: "rpc", client: "convex" }, node),
    )

    if (kind === "query") {
      emitOnce(`key ${path}`, () => ctx.emitFact("queryKeys", path, node))
      return
    }

    ctx.emitFact("mutations", 1, node)
  }

  return {
    name: "convex",
    provides: ["endpoints", "queryKeys", "mutations"],
    enablingDependency: "convex",
    requires: ["bindings"],
    stage: "main",

    accepts: (handle) => handle.text.includes("convex") || handle.text.includes("_generated/api"),

    start: () => {
      seen.clear()
      references = []
    },

    enter: (node, ctx) => {
      const call = ctx.ast.asCallExpression(node)
      if (call === null || call !== node) return

      const ref = functionRefOf(call.arguments[0], ctx)
      if (ref === null) return

      references.push({ ...ref, kind: calleeKind(call, ctx), node: call })
    },

    finish: (ctx) => {
      for (const reference of references) {
        const result = check(reference, ctx)
        if (result.missing !== null) reportUnknown(reference, result.missing, ctx)
        const kind = reference.kind ?? result.kind
        if (kind !== null) emit(reference, kind, ctx)
      }
    },
  }
}
