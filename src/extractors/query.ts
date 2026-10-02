import type ts from "typescript"
import type { FileBindingTable, ModulePattern } from "../core/bindings.js"
import type { ExtractContext, FactExtractor } from "./types.js"
import { condense } from "../core/ast.js"
import { importedConstOf } from "./imported-declaration.js"

// Cut short for the `getText()` fallback. The trailing
// ellipsis is the marker: a query key that is a factory reference or an inline object rather than a
// clean literal is exactly the kind of value the YAML layer must quote rather than emit as a plain
// scalar.
const QUERY_KEY_MAX = 60
const TRUNCATION_MARK = "…"

export const DEFAULT_QUERY_MODULE: ModulePattern = /^(@tanstack\/(react-query|vue-query|query-core)|react-query)$/
export const DEFAULT_SWR_MODULE: ModulePattern = /^swr(\/.*)?$/

const QUERY_KEY_HOOKS = new Set(["useQuery", "useInfiniteQuery", "useSuspenseQuery"])
const MUTATION_HOOKS = new Set(["useMutation"])
const OPTIONS_FACTORIES = new Set(["queryOptions", "infiniteQueryOptions"])
const CLIENT_KEY_METHODS = new Set([
  "fetchQuery",
  "prefetchQuery",
  "ensureQueryData",
  "fetchInfiniteQuery",
  "prefetchInfiniteQuery",
  "ensureInfiniteQueryData",
])
const QUERY_CLIENT_CLASS = "QueryClient"
const QUERY_CLIENT_HOOK = "useQueryClient"
const SWR_QUERY_HOOKS = new Set(["useSWR"])
const SWR_MUTATION_HOOKS = new Set(["useSWRMutation"])

export type QueryOptions = {
  readonly queryModule?: ModulePattern
  readonly swrModule?: ModulePattern
}

const clip = (text: string): string =>
  text.length > QUERY_KEY_MAX ? `${text.slice(0, QUERY_KEY_MAX)}${TRUNCATION_MARK}` : text

const importedIn = (table: FileBindingTable, local: string, module: ModulePattern): string | null => {
  const binding = table.get(local)
  if (binding === null || (binding.kind !== "import" && binding.kind !== "dynamic-import")) return null
  if (!table.rootsInModule(local, module)) return null
  return binding.imported === "default" || binding.imported === "*" ? local : binding.imported
}

const importedName = (local: string, module: ModulePattern, ctx: ExtractContext): string | null =>
  importedIn(ctx.bindings, local, module)

// A `queryClient.prefetchQuery({ queryKey })` whose receiver is an import from a project module: it is
// a QueryClient only once that module's `export const queryClient = new QueryClient()` is read (§5.4).
type ClientCall = {
  readonly receiver: string
  readonly key: string
  readonly node: ts.CallExpression
}

export const createQueryExtractor = (options: QueryOptions = {}): FactExtractor => {
  const queryModule = options.queryModule ?? DEFAULT_QUERY_MODULE
  const swrModule = options.swrModule ?? DEFAULT_SWR_MODULE

  const seenKeys = new Set<string>()
  let localClients = new Set<string>()
  let importedClientCalls: ClientCall[] = []

  const emitKey = (value: string, node: ts.Node, ctx: ExtractContext): void => {
    const key = clip(condense(value))
    if (seenKeys.has(key)) return
    seenKeys.add(key)
    ctx.emitFact("queryKeys", key, node)
  }

  // The one array element that names the key: a plain string/template
  // literal, or a spread of a key-factory (`[...invoicesQueryKeys.all, 'infinite']`) whose leading
  // `...` is stripped so the factory reference reads as the key it stands in for.
  const firstElementOf = (array: ts.ArrayLiteralExpression, ctx: ExtractContext): string | null => {
    const first = array.elements[0]
    if (first === undefined) return null

    if (ctx.ts.isSpreadElement(first)) return condense(first.expression.getText())

    const flat = ctx.flattenString(first)
    if (flat !== null) return flat.value

    return condense(first.getText())
  }

  // `queryKey: ordersKeys.detail(id)` / `queryKey: ordersKeys.all` — the whole key is a key-factory
  // member, recorded as the reference the spread form already yields (`ordersKeys.detail`). A bare
  // identifier (`queryKey: key`) names nothing stable and is not a key.
  const keyFactoryReference = (node: ts.Node, ctx: ExtractContext): string | null => {
    const inner = ctx.ast.unwrap(node)
    const call = ctx.ast.asCallExpression(inner)
    const target = call === null ? inner : ctx.ast.unwrap(call.expression)
    return ctx.ts.isPropertyAccessExpression(target) ? condense(target.getText()) : null
  }

  const objectQueryKey = (argument: ts.Node | undefined, ctx: ExtractContext): string | null => {
    const object = ctx.ast.asObjectLiteral(argument)
    if (object === null) return null

    const property = object.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ctx.ts.isPropertyAssignment(candidate) &&
        ctx.ts.isIdentifier(candidate.name) &&
        candidate.name.text === "queryKey",
    )
    if (property === undefined) return null

    const array = ctx.ast.asArrayLiteral(property.initializer)
    return array === null ? keyFactoryReference(property.initializer, ctx) : firstElementOf(array, ctx)
  }

  // SWR's key is the bare first argument, not wrapped in `{ queryKey }`. A function key (conditional
  // fetching, `() => shouldFetch ? key : null`) cannot be flattened without evaluating a condition,
  // which is out of scope here (§13) — it is silently not a key, never a wrong one.
  const bareQueryKey = (argument: ts.Node | undefined, ctx: ExtractContext): string | null => {
    const array = ctx.ast.asArrayLiteral(argument)
    if (array !== null) return firstElementOf(array, ctx)

    const flat = ctx.flattenString(argument)
    return flat === null ? null : flat.value
  }

  const hookQueryKey = (argument: ts.Node | undefined, ctx: ExtractContext): string | null =>
    ctx.ast.asObjectLiteral(argument) === null ? bareQueryKey(argument, ctx) : objectQueryKey(argument, ctx)

  const isQueryClientConstruction = (node: ts.Node, table: FileBindingTable, ctx: ExtractContext): boolean => {
    const created = ctx.ast.asNewExpression(node)
    const constructor = created === null ? null : ctx.ast.asIdentifier(created.expression)
    return constructor !== null && importedIn(table, constructor.text, queryModule) === QUERY_CLIENT_CLASS
  }

  const visitVariableDeclaration = (node: ts.VariableDeclaration, ctx: ExtractContext): void => {
    if (!ctx.ts.isIdentifier(node.name) || node.initializer === undefined) return
    if (isQueryClientConstruction(node.initializer, ctx.bindings, ctx)) localClients.add(node.name.text)
  }

  const isProvenClient = (receiver: ts.Node, ctx: ExtractContext): boolean => {
    const call = ctx.ast.asCallExpression(receiver)
    const hook = call === null ? null : ctx.ast.asIdentifier(call.expression)
    if (hook !== null) return importedName(hook.text, queryModule, ctx) === QUERY_CLIENT_HOOK

    const identifier = ctx.ast.asIdentifier(receiver)
    if (identifier === null) return isQueryClientConstruction(receiver, ctx.bindings, ctx)
    return (
      localClients.has(identifier.text) || ctx.bindings.isHookResult(identifier.text, QUERY_CLIENT_HOOK, queryModule)
    )
  }

  const visitClientMethodCall = (call: ts.CallExpression, ctx: ExtractContext): void => {
    const access = ctx.ast.asPropertyAccess(call.expression)
    if (access === null || !CLIENT_KEY_METHODS.has(access.name.text)) return

    const key = objectQueryKey(call.arguments[0], ctx)
    if (key === null) return

    const receiver = ctx.ast.unwrap(access.expression)
    if (isProvenClient(receiver, ctx)) {
      emitKey(key, call, ctx)
      return
    }

    const identifier = ctx.ast.asIdentifier(receiver)
    if (identifier !== null) importedClientCalls.push({ receiver: identifier.text, key, node: call })
  }

  const visitCall = (call: ts.CallExpression, ctx: ExtractContext): void => {
    const identifier = ctx.ast.asIdentifier(call.expression)
    if (identifier === null) {
      visitClientMethodCall(call, ctx)
      return
    }
    const local = identifier.text

    const reactQueryName = importedName(local, queryModule, ctx)
    if (reactQueryName !== null) {
      if (QUERY_KEY_HOOKS.has(reactQueryName)) {
        const key = hookQueryKey(call.arguments[0], ctx)
        if (key !== null) emitKey(key, call, ctx)
        return
      }
      if (OPTIONS_FACTORIES.has(reactQueryName)) {
        const key = objectQueryKey(call.arguments[0], ctx)
        if (key !== null) emitKey(key, call, ctx)
        return
      }
      if (MUTATION_HOOKS.has(reactQueryName)) {
        ctx.emitFact("mutations", 1, call)
        return
      }
      return
    }

    const swrName = importedName(local, swrModule, ctx)
    if (swrName !== null) {
      if (SWR_QUERY_HOOKS.has(swrName)) {
        const key = bareQueryKey(call.arguments[0], ctx)
        if (key !== null) emitKey(key, call, ctx)
        return
      }
      if (SWR_MUTATION_HOOKS.has(swrName)) {
        const key = bareQueryKey(call.arguments[0], ctx)
        if (key !== null) emitKey(key, call, ctx)
        ctx.emitFact("mutations", 1, call)
      }
    }
  }

  return {
    name: "query",
    provides: ["queryKeys", "mutations"],
    enablingDependency: ["@tanstack/react-query", "@tanstack/vue-query"],
    requires: ["bindings", "stringConstants"],
    stage: "main",

    start: () => {
      seenKeys.clear()
      localClients = new Set()
      importedClientCalls = []
    },

    enter: (node, ctx) => {
      if (ctx.ts.isVariableDeclaration(node)) {
        visitVariableDeclaration(node, ctx)
        return
      }

      const call = ctx.ast.asCallExpression(node)
      if (call !== null && call === node) visitCall(call, ctx)
    },

    finish: (ctx) => {
      const verdicts = new Map<string, boolean>()
      const isImportedClient = (receiver: string): boolean => {
        const exported = importedConstOf(receiver, ctx)
        return exported !== null && isQueryClientConstruction(exported.initializer, exported.table, ctx)
      }

      for (const { receiver, key, node } of importedClientCalls) {
        const verdict = verdicts.get(receiver) ?? isImportedClient(receiver)
        verdicts.set(receiver, verdict)
        if (verdict) emitKey(key, node, ctx)
      }

      importedClientCalls = []
    },
  }
}
