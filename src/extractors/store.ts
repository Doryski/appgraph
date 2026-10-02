import type ts from "typescript"
import type { FileBindingTable, ModulePattern } from "../core/bindings.js"
import type { CrossFileResolve, ExtractContext, FactExtractor } from "./types.js"
import type { ExportedConst } from "./imported-declaration.js"
import { exportedConstIn, importedConstOf } from "./imported-declaration.js"

export const DEFAULT_ZUSTAND_MODULE: ModulePattern = /^zustand(\/.*)?$/
export const DEFAULT_PINIA_MODULE: ModulePattern = /^pinia$/
export const DEFAULT_REDUX_MODULE: ModulePattern = /^react-redux$/
export const DEFAULT_JOTAI_MODULE: ModulePattern = /^jotai(\/.*)?$/
export const DEFAULT_MOBX_MODULE: ModulePattern = /^mobx$/
export const DEFAULT_MOBX_REACT_MODULE: ModulePattern = /^mobx-react(-lite)?$/
export const DEFAULT_VALTIO_MODULE: ModulePattern = /^valtio(\/.*)?$/
export const DEFAULT_REDUX_TOOLKIT_MODULE: ModulePattern = /^@reduxjs\/toolkit$/
export const DEFAULT_REDUX_CORE_MODULE: ModulePattern = /^redux$/
export const DEFAULT_NGRX_MODULE: ModulePattern = /^@ngrx\/store$/

export const NGRX_STORE = { module: "@ngrx/store", imported: "Store" } as const
export const NGRX_FALLBACK_STORE = "ngrx"

// A name test restricted to hook names (`use…Store`) so factories such as `configureStore` or
// solid-js `createStore` never match. It is a fallback: it fires ONLY when the binding
// table cannot prove the call resolves to zustand's `create` (an import from a file this pass never
// parses), and it fires ONLY on an actual import binding — never on a same-file local, which the
// creation-site scan below can and does verify precisely.
const DEFAULT_FALLBACK_PATTERN = /^use\w*Store$/
export const DEFAULT_NON_STORE_MODULE: ModulePattern = /^(react|react-dom|preact(\/compat)?|use-sync-external-store)(\/.*)?$/

const MOBX_CREATORS = new Set(["makeAutoObservable", "makeObservable", "observable"])
const REDUX_HOOKS = new Set(["useSelector", "useDispatch", "useStore"])
const REDUX_STORE_CREATORS = new Set(["configureStore", "createStore", "legacy_createStore"])
const REDUX_STORE = "redux"
const HOOK_NAME = /^use[A-Z]/
const VALTIO_STORE = "valtio"
const ZUSTAND_CREATORS = new Set(["create", "createStore"])
const NGRX_SELECT_METHODS = new Set(["select", "selectSignal"])
const NGRX_SELECT_OPERATOR = "select"
const NGRX_MODULE_FEATURE_METHOD = "forFeature"
const NGRX_STORE_MODULE = "StoreModule"
const NGRX_SELECTOR_HOPS = 6

export type StoreOptions = {
  readonly zustandModule?: ModulePattern
  readonly piniaModule?: ModulePattern
  readonly reduxModule?: ModulePattern
  readonly jotaiModule?: ModulePattern
  readonly mobxModule?: ModulePattern
  readonly mobxReactModule?: ModulePattern
  readonly valtioModule?: ModulePattern
  readonly reduxToolkitModule?: ModulePattern
  readonly reduxCoreModule?: ModulePattern
  readonly ngrxModule?: ModulePattern
  readonly fallbackPattern?: RegExp
  readonly nonStoreModule?: ModulePattern
}

const importedIn = (table: FileBindingTable, local: string, module: ModulePattern): string | null => {
  const binding = table.get(local)
  if (binding === null || (binding.kind !== "import" && binding.kind !== "dynamic-import")) return null
  if (!table.rootsInModule(local, module)) return null
  return binding.imported === "default" || binding.imported === "*" ? local : binding.imported
}

const importedName = (local: string, module: ModulePattern, ctx: ExtractContext): string | null =>
  importedIn(ctx.bindings, local, module)

const returnedExpression = (node: ts.Node, ctx: ExtractContext): ts.Node | null => {
  if (!ctx.ts.isArrowFunction(node) && !ctx.ts.isFunctionExpression(node)) return null
  if (!ctx.ts.isBlock(node.body)) return ctx.ast.unwrap(node.body)

  const [only] = node.body.statements
  if (node.body.statements.length !== 1 || only === undefined || !ctx.ts.isReturnStatement(only)) return null
  return only.expression === undefined ? null : ctx.ast.unwrap(only.expression)
}

// A project's typed redux hook, in the three shapes the react-redux docs prescribe:
// `useSelector.withTypes<S>()`, `const useAppSelector: TypedUseSelectorHook<S> = useSelector`, and
// `() => useDispatch<D>()`. Read against whichever file declares it, through that file's own table.
const isTypedReduxHook = (
  initializer: ts.Node,
  table: FileBindingTable,
  reduxModule: ModulePattern,
  ctx: ExtractContext,
): boolean => {
  const isReduxHook = (node: ts.Node | undefined): boolean => {
    const identifier = ctx.ast.asIdentifier(node)
    if (identifier === null) return false
    const imported = importedIn(table, identifier.text, reduxModule)
    return imported !== null && REDUX_HOOKS.has(imported)
  }

  const node = ctx.ast.unwrap(initializer)
  if (isReduxHook(node)) return true

  const call = ctx.ast.asCallExpression(node)
  const access = call === null ? null : ctx.ast.asPropertyAccess(call.expression)
  if (access !== null && access.name.text === "withTypes") return isReduxHook(access.expression)

  const returned = returnedExpression(node, ctx)
  const returnedCall = returned === null ? null : ctx.ast.asCallExpression(returned)
  return returnedCall !== null && isReduxHook(returnedCall.expression)
}

const nameProperty = (node: ts.Node | undefined, ctx: ExtractContext): ts.Expression | undefined =>
  ctx.ast
    .asObjectLiteral(node)
    ?.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ctx.ts.isPropertyAssignment(candidate) && ctx.ts.isIdentifier(candidate.name) && candidate.name.text === "name",
    )?.initializer

const stringLiteralOf = (node: ts.Node | undefined, ctx: ExtractContext): string | null => {
  if (node === undefined) return null
  const literal = ctx.ast.unwrap(node)
  return ctx.ts.isStringLiteralLike(literal) ? literal.text : null
}

type SelectorScope = {
  readonly resolve: CrossFileResolve
  readonly ngrxModule: ModulePattern
  readonly ctx: ExtractContext
}

const referencedConst = (
  name: string,
  owner: Pick<ExportedConst, "declaring" | "table">,
  scope: SelectorScope,
): ExportedConst | null => {
  const binding = owner.table.get(name)
  if (binding !== null && binding.kind === "import")
    return binding.file === null ? null : exportedConstIn(scope.resolve, binding.file, binding.imported, scope.ctx)
  return exportedConstIn(scope.resolve, owner.declaring, name, scope.ctx)
}

const featuresOfReference = (
  node: ts.Node,
  owner: Pick<ExportedConst, "declaring" | "table">,
  scope: SelectorScope,
  hops: number,
): readonly string[] => {
  const ctx = scope.ctx
  const unwrapped = ctx.ast.unwrap(node)
  const access = ctx.ast.asPropertyAccess(unwrapped)
  const identifier = ctx.ast.asIdentifier(access === null ? unwrapped : access.expression)
  if (identifier === null || hops > NGRX_SELECTOR_HOPS) return []
  const target = referencedConst(identifier.text, owner, scope)
  return target === null ? [] : featuresOfSelector(target, scope, hops + 1)
}

const featuresOfSelector = (selector: ExportedConst, scope: SelectorScope, hops: number): readonly string[] => {
  const ctx = scope.ctx
  const initializer = ctx.ast.unwrap(selector.initializer)
  const call = ctx.ast.asCallExpression(initializer)
  if (call === null) return featuresOfReference(initializer, selector, scope, hops)

  const root = selector.table.rootIdentifier(call.expression)
  const creator = root === null ? null : importedIn(selector.table, root, scope.ngrxModule)
  if (creator === "createFeatureSelector") return [stringLiteralOf(call.arguments[0], ctx)].filter((name) => name !== null)
  if (creator === "createFeature") return [stringLiteralOf(nameProperty(call.arguments[0], ctx), ctx)].filter((name) => name !== null)
  if (creator !== "createSelector") return []
  return call.arguments.flatMap((argument) => featuresOfReference(argument, selector, scope, hops))
}

const enclosingClassName = (node: ts.Node, ctx: ExtractContext): string | null => {
  let current: ts.Node | undefined = node.parent
  while (current !== undefined) {
    if (ctx.ts.isClassDeclaration(current)) return current.name?.text ?? null
    current = current.parent
  }
  return null
}

export const createStoreExtractor = (options: StoreOptions = {}): FactExtractor => {
  const zustandModule = options.zustandModule ?? DEFAULT_ZUSTAND_MODULE
  const piniaModule = options.piniaModule ?? DEFAULT_PINIA_MODULE
  const reduxModule = options.reduxModule ?? DEFAULT_REDUX_MODULE
  const jotaiModule = options.jotaiModule ?? DEFAULT_JOTAI_MODULE
  const mobxModule = options.mobxModule ?? DEFAULT_MOBX_MODULE
  const mobxReactModule = options.mobxReactModule ?? DEFAULT_MOBX_REACT_MODULE
  const fallbackPattern = options.fallbackPattern ?? DEFAULT_FALLBACK_PATTERN
  const nonStoreModule = options.nonStoreModule ?? DEFAULT_NON_STORE_MODULE
  const valtioModule = options.valtioModule ?? DEFAULT_VALTIO_MODULE
  const reduxToolkitModule = options.reduxToolkitModule ?? DEFAULT_REDUX_TOOLKIT_MODULE
  const reduxCoreModule = options.reduxCoreModule ?? DEFAULT_REDUX_CORE_MODULE
  const ngrxModule = options.ngrxModule ?? DEFAULT_NGRX_MODULE

  let confirmed = new Set<string>()
  let emitted = new Set<string>()
  let typedReduxHooks = new Set<string>()
  let importedHookCalls: { readonly local: string; readonly node: ts.CallExpression }[] = []
  let ngrxInjection: ts.CallExpression | null = null
  let ngrxSelectors: { readonly local: string; readonly node: ts.CallExpression }[] = []

  const emit = (name: string, node: ts.Node, ctx: ExtractContext): void => {
    if (emitted.has(name)) return
    emitted.add(name)
    ctx.emitFact("stores", name, node)
  }

  const isCreationSite = (root: string | null, ctx: ExtractContext): boolean =>
    root !== null &&
    (importedName(root, zustandModule, ctx) === "create" ||
      importedName(root, valtioModule, ctx) === "proxy" ||
      importedName(root, piniaModule, ctx) === "defineStore")

  const isPiniaDefinition = (initializer: ts.Node, table: FileBindingTable): boolean => {
    const root = table.rootIdentifier(initializer)
    return root !== null && importedIn(table, root, piniaModule) === "defineStore"
  }

  const isZustandOrValtioDefinition = (initializer: ts.Node, table: FileBindingTable): boolean => {
    const root = table.rootIdentifier(initializer)
    if (root === null) return false
    const zustandName = importedIn(table, root, zustandModule)
    return (zustandName !== null && ZUSTAND_CREATORS.has(zustandName)) || importedIn(table, root, valtioModule) === "proxy"
  }

  const visitVariableDeclaration = (node: ts.VariableDeclaration, ctx: ExtractContext): void => {
    if (!ctx.ts.isIdentifier(node.name) || node.initializer === undefined) return

    if (isCreationSite(ctx.bindings.rootIdentifier(node.initializer), ctx)) {
      confirmed.add(node.name.text)
      emit(node.name.text, node, ctx)
      return
    }

    if (isTypedReduxHook(node.initializer, ctx.bindings, reduxModule, ctx)) typedReduxHooks.add(node.name.text)
  }

  const sliceName = (call: ts.CallExpression, ctx: ExtractContext): string => {
    const object = ctx.ast.asObjectLiteral(call.arguments[0])
    const property = object?.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ctx.ts.isPropertyAssignment(candidate) && ctx.ts.isIdentifier(candidate.name) && candidate.name.text === "name",
    )
    const flat = ctx.flattenString(property?.initializer)
    return flat === null || flat.dynamic ? REDUX_STORE : flat.value
  }

  const visitReduxCreatorCall = (call: ts.CallExpression, local: string, ctx: ExtractContext): boolean => {
    const toolkitName = importedName(local, reduxToolkitModule, ctx)
    if (toolkitName === "createSlice") {
      emit(sliceName(call, ctx), call, ctx)
      return true
    }

    const creator = toolkitName ?? importedName(local, reduxCoreModule, ctx)
    if (creator === null || !REDUX_STORE_CREATORS.has(creator)) return false
    emit(REDUX_STORE, call, ctx)
    return true
  }

  const visitMobxCreatorCall = (call: ts.CallExpression, ctx: ExtractContext): boolean => {
    const identifier = ctx.ast.asIdentifier(call.expression)
    if (identifier === null) return false

    const imported = importedName(identifier.text, mobxModule, ctx)
    if (imported === null || !MOBX_CREATORS.has(imported)) return false

    const className = enclosingClassName(call, ctx) ?? "mobx"
    confirmed.add(className)
    emit(className, call, ctx)
    return true
  }

  const ngrxFeatureName = (call: ts.CallExpression, creator: string, ctx: ExtractContext): string | null => {
    const node = creator === "createFeature" ? nameProperty(call.arguments[0], ctx) : call.arguments[0]
    const flat = ctx.flattenString(node)
    return flat === null || flat.dynamic ? null : flat.value
  }

  const isStoreModuleFeature = (call: ts.CallExpression, ctx: ExtractContext): boolean => {
    const access = ctx.ast.asPropertyAccess(call.expression)
    const receiver = access === null ? null : ctx.ast.asIdentifier(access.expression)
    if (access === null || receiver === null || access.name.text !== NGRX_MODULE_FEATURE_METHOD) return false
    return importedName(receiver.text, ngrxModule, ctx) === NGRX_STORE_MODULE
  }

  const ngrxCreatorOf = (call: ts.CallExpression, ctx: ExtractContext): string | null => {
    if (isStoreModuleFeature(call, ctx)) return NGRX_MODULE_FEATURE_METHOD
    const identifier = ctx.ast.asIdentifier(call.expression)
    const imported = identifier === null ? null : importedName(identifier.text, ngrxModule, ctx)
    return imported === "createFeature" || imported === "createFeatureSelector" ? imported : null
  }

  const visitNgrxDefinition = (call: ts.CallExpression, ctx: ExtractContext): boolean => {
    const creator = ngrxCreatorOf(call, ctx)
    if (creator === null) return false
    const name = ngrxFeatureName(call, creator, ctx)
    if (name !== null) emit(name, call, ctx)
    return true
  }

  const isInjectedStore = (receiver: ts.Expression, ctx: ExtractContext): boolean => {
    const member = ctx.bindings.memberBinding(receiver)
    return member !== null && member.module === NGRX_STORE.module && member.imported === NGRX_STORE.imported
  }

  const isSelectOperator = (call: ts.CallExpression, ctx: ExtractContext): boolean => {
    const identifier = ctx.ast.asIdentifier(call.expression)
    return identifier !== null && importedName(identifier.text, ngrxModule, ctx) === NGRX_SELECT_OPERATOR
  }

  const selectorLocal = (argument: ts.Expression, ctx: ExtractContext): string | null => {
    const unwrapped = ctx.ast.unwrap(argument)
    const access = ctx.ast.asPropertyAccess(unwrapped)
    const identifier = ctx.ast.asIdentifier(access === null ? unwrapped : access.expression)
    if (identifier === null) return null
    const binding = ctx.bindings.get(identifier.text)
    return binding !== null && binding.kind === "import" && binding.file !== null ? identifier.text : null
  }

  const recordSelectors = (call: ts.CallExpression, ctx: ExtractContext): void => {
    for (const argument of call.arguments) {
      const literal = stringLiteralOf(argument, ctx)
      if (literal !== null) emit(literal, call, ctx)
      const local = selectorLocal(argument, ctx)
      if (local !== null) ngrxSelectors.push({ local, node: call })
    }
  }

  const visitNgrxStoreCall = (call: ts.CallExpression, ctx: ExtractContext): boolean => {
    if (isSelectOperator(call, ctx)) {
      recordSelectors(call, ctx)
      return true
    }

    const access = ctx.ast.asPropertyAccess(call.expression)
    if (access === null || !isInjectedStore(access.expression, ctx)) return false
    ngrxInjection = ngrxInjection ?? call
    if (NGRX_SELECT_METHODS.has(access.name.text)) recordSelectors(call, ctx)
    return true
  }

  const finishNgrx = (ctx: ExtractContext): void => {
    const resolve = ctx.resolve
    const scope = resolve === null ? null : { resolve, ngrxModule, ctx }
    const resolvedFeatures = ngrxSelectors.flatMap(({ local, node }) => {
      const selector = scope === null ? null : importedConstOf(local, ctx)
      if (scope === null || selector === null) return []
      return featuresOfSelector(selector, scope, 0).map((name) => ({ name, node }))
    })

    for (const { name, node } of resolvedFeatures) emit(name, node, ctx)
    if (ngrxInjection === null || resolvedFeatures.length > 0) return

    emit(NGRX_FALLBACK_STORE, ngrxInjection, ctx)
    ctx.diagnostic({
      severity: "info",
      code: "stores/name-fallback",
      message: `an injected @ngrx/store Store is used but none of the selectors it reads resolve to a feature name; recorded as '${NGRX_FALLBACK_STORE}'.`,
      file: ctx.file,
    })
  }

  const visitUsageCall = (call: ts.CallExpression, ctx: ExtractContext): void => {
    const identifier = ctx.ast.asIdentifier(call.expression)
    if (identifier === null) return
    const local = identifier.text

    if (confirmed.has(local)) {
      emit(local, call, ctx)
      return
    }

    // The creation call itself (`create(...)` / an aliased `createStore(...)`) is handled by
    // `visitVariableDeclaration`; without this guard its own call node would fall through to the
    // fallback check below and misfire on any factory alias that happens to end in "Store".
    if (isCreationSite(local, ctx)) return

    const reduxName = importedName(local, reduxModule, ctx)
    if ((reduxName !== null && REDUX_HOOKS.has(reduxName)) || typedReduxHooks.has(local)) {
      emit(REDUX_STORE, call, ctx)
      return
    }

    if (visitReduxCreatorCall(call, local, ctx)) return

    if (importedName(local, valtioModule, ctx) === "useSnapshot") {
      const argument = ctx.ast.asIdentifier(call.arguments[0])
      emit(argument?.text ?? VALTIO_STORE, call, ctx)
      return
    }

    const jotaiName = importedName(local, jotaiModule, ctx)
    if (jotaiName !== null && /^useAtom/.test(jotaiName)) {
      const argument = ctx.ast.asIdentifier(call.arguments[0])
      emit(argument?.text ?? "jotai", call, ctx)
      return
    }

    const mobxReactName = importedName(local, mobxReactModule, ctx)
    if (mobxReactName === "observer") {
      const argument = ctx.ast.asIdentifier(call.arguments[0])
      emit(argument?.text ?? "mobx", call, ctx)
      return
    }

    // The binding-table discipline, one level up: a name that merely LOOKS like a store hook is trusted only
    // when the binding table says it came from somewhere else entirely (an import this pass cannot
    // follow) — never for a plain same-file local, which `confirmed` would already have caught if it
    // really were a zustand store.
    const binding = ctx.bindings.get(local)
    if (binding === null || (binding.kind !== "import" && binding.kind !== "dynamic-import")) return
    if (binding.kind === "import" && binding.file !== null && HOOK_NAME.test(local))
      importedHookCalls.push({ local, node: call })
    if (!fallbackPattern.test(local)) return
    if (ctx.bindings.rootsInModule(local, nonStoreModule)) return

    emit(local, call, ctx)
    ctx.diagnostic({
      severity: "info",
      code: "stores/name-fallback",
      message: `'${local}' looks like a store hook by name (matches /${fallbackPattern.source}/) but its defining module cannot be verified without cross-file resolution.`,
      file: ctx.file,
    })
  }

  return {
    name: "store",
    provides: ["stores"],
    enablingDependency: ["zustand", "pinia", "@ngrx/store"],
    requires: ["bindings", "stringConstants"],
    stage: "main",

    start: () => {
      confirmed = new Set()
      emitted = new Set()
      typedReduxHooks = new Set()
      importedHookCalls = []
      ngrxInjection = null
      ngrxSelectors = []
    },

    enter: (node, ctx) => {
      if (ctx.ts.isVariableDeclaration(node)) {
        visitVariableDeclaration(node, ctx)
        return
      }

      const call = ctx.ast.asCallExpression(node)
      if (call === null || call !== node) return
      if (visitMobxCreatorCall(call, ctx)) return
      if (visitNgrxDefinition(call, ctx)) return
      if (visitNgrxStoreCall(call, ctx)) return
      visitUsageCall(call, ctx)
    },

    // §5.4: a typed hook (`useAppSelector`) imported from the project's own `store/hooks` module is
    // redux only once its declaration is read, which is cross-file work and therefore lives here.
    finish: (ctx) => {
      const verdicts = new Map<string, string | null>()
      const storeNameOf = (local: string): string | null => {
        const exported = importedConstOf(local, ctx)
        if (exported === null) return null
        if (isTypedReduxHook(exported.initializer, exported.table, reduxModule, ctx)) return REDUX_STORE
        const { initializer, table } = exported
        return isPiniaDefinition(initializer, table) || isZustandOrValtioDefinition(initializer, table) ? local : null
      }

      for (const { local, node } of importedHookCalls) {
        const verdict = verdicts.get(local) ?? storeNameOf(local)
        verdicts.set(local, verdict)
        if (verdict !== null) emit(verdict, node, ctx)
      }

      finishNgrx(ctx)
      importedHookCalls = []
      ngrxInjection = null
      ngrxSelectors = []
    },
  }
}
