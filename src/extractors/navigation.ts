import type ts from "typescript"
import type { MemberBinding, ModulePattern } from "../core/bindings.js"
import type { FlatString, NavTrigger, Navigation } from "../core/model.js"
import type { TemplateDoc, TemplateElement, TemplateExpression, TemplateTags } from "../core/template-doc.js"
import { expressionsFrom, primaryNameOf } from "../core/template-doc.js"
import type { ExtractContext, FactAnchor, FactExtractor } from "./types.js"
import { anchorOf as templateAnchorOf } from "./types.js"
import { CONDITION_MAX, DYNAMIC_PLACEHOLDER, condense } from "../core/ast.js"
import { routeNameSuffix } from "../core/model.js"
import { createTargetLookup } from "./navigation-lookup.js"
import { expoHrefToUrl } from "../core/url.js"

export const ROUTER_METHOD_TRIGGERS: Readonly<Record<string, NavTrigger>> = {
  push: "navigate",
  replace: "replace",
}

// A target that cannot be flattened is recorded here, never dropped — an agent needs to know a
// navigation happens even when the destination is only knowable at runtime.
export type UnresolvedNavigation = {
  readonly expr: string
  readonly trigger: NavTrigger
  readonly file: string
  readonly line: number
  readonly truncated: boolean
}

// A navigator that only counts when imported from `module`: wouter's `navigate` must not claim
// every function of that name.
export type ScopedName = { readonly name: string; readonly module: ModulePattern }

// A hook returning a tuple whose element at `index` navigates: wouter's `const [, navigate] = useLocation()`.
// Module-scoped so react-router's `useLocation`, which returns a location object, never navigates.
export type TupleNavigator = { readonly hook: string; readonly module: ModulePattern; readonly index: number }

export type NavigationOptions = {
  readonly navigateHooks?: readonly string[]
  readonly routerHooks?: readonly string[]
  readonly redirectFunctions?: readonly string[]
  readonly navigateFunctions?: readonly (string | ScopedName)[]
  readonly navigateTuples?: readonly TupleNavigator[]
  readonly linkTags?: readonly string[]
  readonly redirectTags?: readonly string[]
  readonly targetAttributes?: readonly string[]
  // Optional module restriction. Left unset, any module providing `useNavigate` counts, which is what
  // lets one extractor cover react-router v6/v7, TanStack Router and a project-local re-export.
  readonly module?: ModulePattern
}

const DEFAULTS = {
  navigateHooks: ["useNavigate"],
  routerHooks: ["useRouter", "useHistory"],
  redirectFunctions: ["redirect", "permanentRedirect"],
  navigateFunctions: ["navigateTo", { name: "navigate", module: /^wouter(\/|$)/ }],
  navigateTuples: [{ hook: "useLocation", module: /^wouter(\/preact)?$/, index: 1 }],
  linkTags: ["Link", "NavLink", "RouterLink", "NuxtLink"],
  redirectTags: ["Navigate", "Redirect"],
  targetAttributes: ["to", "href"],
} as const

const OBJECT_PATH_KEY = "path"
const OBJECT_NAME_KEY = "name"
const GLOBAL_ROUTER = "$router"
const ANGULAR_ROUTER = { module: "@angular/router", imported: "Router" } as const
const ANGULAR_NAVIGATE_METHODS: readonly string[] = ["navigate", "navigateByUrl"] as const
const DEFAULT_OWNER = "default"
const BROWSER_GLOBALS: ReadonlySet<string> = new Set(["window", "document", "globalThis", "self"])
const LOCATION = "location"
const LOCATION_GLOBALS: ReadonlySet<string> = new Set([LOCATION])
const LOCATION_METHOD_TRIGGERS: Readonly<Record<string, NavTrigger>> = { assign: "navigate", replace: "replace" }
const WINDOW_OPEN = "open"
const WINDOW_GLOBALS: ReadonlySet<string> = new Set(["window"])
const LOCATION_TARGET_PROPERTY = "href"
const EXTERNAL_URL = /^[a-z][a-z0-9+.-]*:/i
const OUT_OF_APP_PREFIXES: readonly string[] = ["#", "//"]
const ANCHOR = { tag: "a", target: "href", download: "download" } as const

type Dialect = "web" | "expo" | "native"

const EXPO_ROUTER = { module: "expo-router", singleton: "router", hook: "useRouter", pathKey: "pathname" } as const
const EXPO_METHOD_TRIGGERS: Readonly<Record<string, NavTrigger>> = {
  ...ROUTER_METHOD_TRIGGERS,
  navigate: "navigate",
  dismissTo: "navigate",
}
const NATIVE_MODULE = /^@react-navigation\//
const NATIVE_HOOK_MODULE = /^(@react-navigation\/.+|expo-router)$/
const NATIVE_HOOK = "useNavigation"
const NATIVE_PARAMETER = "navigation"
const NATIVE_SCREEN_KEY = "screen"
const NATIVE_PARAMS_KEY = "params"
const NATIVE_METHOD_TRIGGERS: Readonly<Record<string, NavTrigger>> = {
  navigate: "navigate",
  push: "navigate",
  replace: "replace",
  popTo: "navigate",
}
const NATIVE_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  StackActions: ["push", "replace", "popTo"],
  CommonActions: ["navigate"],
}

const triggerIn = (table: Readonly<Record<string, NavTrigger>>, method: string): NavTrigger | null =>
  Object.hasOwn(table, method) ? (table[method] ?? null) : null

const actionMethodsOf = (action: string): readonly string[] =>
  Object.hasOwn(NATIVE_ACTIONS, action) ? (NATIVE_ACTIONS[action] ?? []) : []

const routeNamePart = (target: { readonly routeName?: string }): { readonly routeName?: string } =>
  target.routeName === undefined ? {} : { routeName: target.routeName }

const isOutOfApp = (value: string): boolean =>
  value.trim() === "" || EXTERNAL_URL.test(value) || OUT_OF_APP_PREFIXES.some((prefix) => value.startsWith(prefix))

const INTERPOLATION_ONLY = /^\s*\{\{([\s\S]*)\}\}\s*$/

type TemplateSite = {
  readonly at: FactAnchor
  readonly line: number
  readonly owner?: string | null
}

type Site = TemplateSite | null

export const createNavigationExtractor = (options: NavigationOptions = {}): FactExtractor => {
  const navigateHooks = new Set(options.navigateHooks ?? DEFAULTS.navigateHooks)
  const routerHooks = new Set(options.routerHooks ?? DEFAULTS.routerHooks)
  const redirectFunctions = new Set(options.redirectFunctions ?? DEFAULTS.redirectFunctions)
  const navigateFunctionList = options.navigateFunctions ?? DEFAULTS.navigateFunctions
  const navigateFunctions = new Set(navigateFunctionList.filter((entry) => typeof entry === "string"))
  const scopedNavigators = navigateFunctionList.filter((entry): entry is ScopedName => typeof entry !== "string")
  const navigateTuples = options.navigateTuples ?? DEFAULTS.navigateTuples
  const linkTags = new Set(options.linkTags ?? DEFAULTS.linkTags)
  const redirectTags = new Set(options.redirectTags ?? DEFAULTS.redirectTags)
  const targetAttributes = options.targetAttributes ?? DEFAULTS.targetAttributes
  const objectPathKeys = [OBJECT_PATH_KEY, ...targetAttributes]
  const objectKeys: Readonly<Record<Dialect, { readonly path: readonly string[]; readonly name: readonly string[] }>> = {
    web: { path: objectPathKeys, name: [OBJECT_NAME_KEY] },
    expo: { path: [...objectPathKeys, EXPO_ROUTER.pathKey], name: [OBJECT_NAME_KEY] },
    native: { path: objectPathKeys, name: [OBJECT_NAME_KEY, NATIVE_SCREEN_KEY] },
  }
  const jsxKeys: Readonly<Record<Dialect, readonly string[]>> = {
    web: targetAttributes,
    expo: targetAttributes,
    native: [...targetAttributes, NATIVE_SCREEN_KEY],
  }

  const seen = new Set<string>()

  const isHook = (local: string, hooks: ReadonlySet<string>, ctx: ExtractContext): boolean => {
    for (const hook of hooks)
      if (
        options.module === undefined
          ? ctx.bindings.isHookResult(local, hook)
          : ctx.bindings.isHookResult(local, hook, options.module)
      )
        return true
    return false
  }

  const importedName = (local: string, ctx: ExtractContext): string | null => {
    const binding = ctx.bindings.get(local)
    if (binding === null) return null
    if (binding.kind !== "import" && binding.kind !== "dynamic-import") return null
    if (options.module !== undefined && !ctx.bindings.rootsInModule(local, options.module)) return null
    return binding.imported === "default" || binding.imported === "*" ? local : binding.imported
  }

  const anchorOf = (node: ts.Node, site: Site): ts.Node | FactAnchor => site?.at ?? node

  const lineOf = (node: ts.Node, site: Site, ctx: ExtractContext): number => site?.line ?? ctx.lineOf(node)

  const pendingLookups: {
    readonly node: ts.Node
    readonly trigger: NavTrigger
    readonly site: Site
    readonly dialect: Dialect
  }[] = []

  const targetOf = (value: string, dialect: Dialect, ctx: ExtractContext): { readonly to: string; readonly routeName?: string } => {
    if (dialect !== "expo" || !value.startsWith("/")) return { to: ctx.normalizeUrl(value) }
    const converted = expoHrefToUrl(value)
    const to = ctx.normalizeUrl(converted.url)
    return converted.routeName === null ? { to } : { to, routeName: converted.routeName }
  }

  const emitTarget = (at: ts.Node | FactAnchor, navigation: Navigation, ctx: ExtractContext): void => {
    const key = `nav|${navigation.to}|${navigation.trigger}${routeNameSuffix(navigation)}`
    if (seen.has(key)) return
    seen.add(key)
    ctx.emitFact("navigations", navigation, at)
  }

  const recordUnresolved = (node: ts.Node, trigger: NavTrigger, site: Site, ctx: ExtractContext): void => {
    const text = condense(node.getText())
    const expr = text.slice(0, CONDITION_MAX)
    const key = `unresolved|${expr}|${trigger}`
    if (seen.has(key)) return
    seen.add(key)

    const unresolved: UnresolvedNavigation = {
      expr,
      trigger,
      file: site?.at.file ?? ctx.file,
      line: lineOf(node, site, ctx),
      truncated: text.length > CONDITION_MAX,
    }
    ctx.emitFact("unresolvedNavigations", unresolved, anchorOf(node, site))
  }

  const recordFlat = (
    node: ts.Node,
    flat: FlatString,
    trigger: NavTrigger,
    site: Site,
    ctx: ExtractContext,
    dialect: Dialect = "web",
  ): void => {
    const target = targetOf(flat.value, dialect, ctx)
    if (!target.to.startsWith("/")) {
      recordUnresolved(node, trigger, site, ctx)
      return
    }
    emitTarget(anchorOf(node, site), { to: target.to, trigger, dynamic: flat.dynamic, ...routeNamePart(target) }, ctx)
  }

  const record = (
    node: ts.Node | undefined,
    trigger: NavTrigger,
    site: Site,
    ctx: ExtractContext,
    dialect: Dialect = "web",
  ): void => {
    if (node === undefined) return

    const flat = ctx.flattenString(node)
    if (flat !== null) {
      recordFlat(node, flat, trigger, site, ctx, dialect)
      return
    }

    // `tabToPath[tab]`, `ROUTES[key].path`, `item.to` inside `items.map(...)`: the literal may live in
    // another module, and cross-file reads are confined to `finish` (§5.4).
    if (createTargetLookup(ctx).accepts(node)) {
      pendingLookups.push({ node, trigger, site, dialect })
      return
    }

    recordUnresolved(node, trigger, site, ctx)
  }

  const isAlternative = (node: ts.Node, ctx: ExtractContext): node is ts.BinaryExpression =>
    ctx.ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ctx.ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ctx.ts.SyntaxKind.QuestionQuestionToken)

  const nameBranches = (node: ts.Node, ctx: ExtractContext): readonly ts.Node[] => {
    const inner = ctx.ast.unwrap(node)
    if (ctx.ts.isConditionalExpression(inner))
      return [...nameBranches(inner.whenTrue, ctx), ...nameBranches(inner.whenFalse, ctx)]
    if (isAlternative(inner, ctx)) return [...nameBranches(inner.left, ctx), ...nameBranches(inner.right, ctx)]
    return [node]
  }

  const recordNameBranch = (node: ts.Node, trigger: NavTrigger, site: Site, ctx: ExtractContext): void => {
    const flat = ctx.flattenString(node)
    if (flat === null || flat.dynamic) {
      recordUnresolved(node, trigger, site, ctx)
      return
    }
    emitTarget(anchorOf(node, site), { to: "", trigger, dynamic: false, routeName: flat.value }, ctx)
  }

  const recordName = (node: ts.Node, trigger: NavTrigger, site: Site, ctx: ExtractContext): void => {
    for (const branch of nameBranches(node, ctx)) recordNameBranch(branch, trigger, site, ctx)
  }

  const resolveLookups = (ctx: ExtractContext): void => {
    const lookup = createTargetLookup(ctx)

    for (const { node, trigger, site, dialect } of pendingLookups) {
      const targets = (lookup.valuesOf(node) ?? [])
        .map((entry) => ({ ...targetOf(entry.value, dialect, ctx), dynamic: entry.dynamic }))
        .filter((entry) => entry.to.startsWith("/"))

      if (targets.length === 0) {
        recordUnresolved(node, trigger, site, ctx)
        continue
      }
      const expr = condense(node.getText()).slice(0, CONDITION_MAX)
      for (const target of targets)
        emitTarget(
          anchorOf(node, site),
          { to: target.to, trigger, dynamic: target.dynamic, expr, ...routeNamePart(target) },
          ctx,
        )
    }
  }

  const propertyValue = (object: ts.ObjectLiteralExpression, key: string, ctx: ExtractContext): ts.Node | undefined => {
    const property = object.properties.find(
      (candidate): candidate is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
        (ctx.ts.isPropertyAssignment(candidate) || ctx.ts.isShorthandPropertyAssignment(candidate)) &&
        ctx.ts.isIdentifier(candidate.name) &&
        candidate.name.text === key,
    )
    if (property === undefined) return undefined
    return ctx.ts.isPropertyAssignment(property) ? property.initializer : property.name
  }

  // `navigate('/x')`, `navigate({ to: '/x' })` (TanStack), `redirect({ to: '/x' })`.
  const firstPropertyValue = (
    object: ts.ObjectLiteralExpression,
    keys: readonly string[],
    ctx: ExtractContext,
  ): ts.Node | undefined => keys.map((key) => propertyValue(object, key, ctx)).find((value) => value !== undefined)

  const nestedScreen = (params: ts.Node | undefined, ctx: ExtractContext): ts.Node | undefined => {
    const object = ctx.ast.asObjectLiteral(params)
    if (object === null) return undefined
    const screen = propertyValue(object, NATIVE_SCREEN_KEY, ctx)
    if (screen === undefined) return undefined
    return nestedScreen(propertyValue(object, NATIVE_PARAMS_KEY, ctx), ctx) ?? screen
  }

  const nameValue = (object: ts.ObjectLiteralExpression, dialect: Dialect, ctx: ExtractContext): ts.Node | undefined => {
    const name = firstPropertyValue(object, objectKeys[dialect].name, ctx)
    if (dialect !== "native" || name === undefined) return name
    return nestedScreen(propertyValue(object, NATIVE_PARAMS_KEY, ctx), ctx) ?? name
  }

  const recordTarget = (
    argument: ts.Node | undefined,
    trigger: NavTrigger,
    site: Site,
    ctx: ExtractContext,
    dialect: Dialect = "web",
  ): void => {
    if (argument === undefined) return

    const object = ctx.ast.asObjectLiteral(argument)
    if (object === null) {
      record(argument, trigger, site, ctx, dialect)
      return
    }

    const path = firstPropertyValue(object, objectKeys[dialect].path, ctx)
    if (path !== undefined) {
      record(path, trigger, site, ctx, dialect)
      return
    }

    const name = nameValue(object, dialect, ctx)
    if (name !== undefined) {
      recordName(name, trigger, site, ctx)
      return
    }

    record(argument, trigger, site, ctx, dialect)
  }

  const recordNativeCall = (
    args: readonly ts.Node[],
    trigger: NavTrigger,
    site: Site,
    ctx: ExtractContext,
  ): void => {
    const [first, second] = args
    if (first === undefined) return
    if (ctx.ast.asObjectLiteral(first) !== null) {
      recordTarget(first, trigger, site, ctx, "native")
      return
    }
    recordName(nestedScreen(second, ctx) ?? first, trigger, site, ctx)
  }

  const commandSegment = (element: ts.Expression, ctx: ExtractContext): FlatString => {
    const inner = ctx.ast.unwrap(element)
    if (ctx.ts.isNumericLiteral(inner)) return { value: inner.text, dynamic: false }
    return ctx.flattenString(inner) ?? { value: DYNAMIC_PLACEHOLDER, dynamic: true }
  }

  const joinCommands = (commands: ts.ArrayLiteralExpression, ctx: ExtractContext): FlatString | null => {
    const segments = commands.elements
      .filter((element) => ctx.ast.asObjectLiteral(element) === null)
      .map((element) => commandSegment(element, ctx))
    if (segments.length === 0) return null
    return {
      value: segments.map((segment) => segment.value).join("/"),
      dynamic: segments.some((segment) => segment.dynamic),
    }
  }

  const recordCommands = (node: ts.Node | undefined, trigger: NavTrigger, site: Site, ctx: ExtractContext): void => {
    const commands = ctx.ast.asArrayLiteral(node)
    if (commands === null) {
      record(node, trigger, site, ctx)
      return
    }
    const joined = joinCommands(commands, ctx)
    if (joined !== null) recordFlat(commands, joined, trigger, site, ctx)
  }

  const isBindingOf = (binding: MemberBinding | null, expected: MemberBinding): boolean =>
    binding !== null && binding.module === expected.module && binding.imported === expected.imported

  const isDefaultExport = (declaration: ts.ClassDeclaration, ctx: ExtractContext): boolean => {
    const kinds = (ctx.ts.getModifiers(declaration) ?? []).map((modifier) => modifier.kind)
    return kinds.includes(ctx.ts.SyntaxKind.ExportKeyword) && kinds.includes(ctx.ts.SyntaxKind.DefaultKeyword)
  }

  const ownerClass = (owner: string, ctx: ExtractContext): ts.ClassDeclaration | undefined => {
    const classes = ctx.source.statements.filter(ctx.ts.isClassDeclaration)
    const named = classes.find((declaration) => declaration.name?.text === owner)
    if (named !== undefined || owner !== DEFAULT_OWNER) return named
    return classes.find((declaration) => isDefaultExport(declaration, ctx))
  }

  const templateMemberName = (receiver: ts.Expression, ctx: ExtractContext): string | null => {
    const identifier = ctx.ast.asIdentifier(receiver)
    if (identifier !== null) return identifier.text
    const access = ctx.ast.asPropertyAccess(receiver)
    if (access === null || ctx.ast.unwrap(access.expression).kind !== ctx.ts.SyntaxKind.ThisKeyword) return null
    return access.name.text
  }

  const ownerMemberBinding = (receiver: ts.Expression, site: Site, ctx: ExtractContext): MemberBinding | null => {
    const owner = site?.owner ?? null
    const name = templateMemberName(receiver, ctx)
    if (owner === null || name === null) return null
    const declaration = ownerClass(owner, ctx)
    return declaration === undefined ? null : ctx.bindings.classMemberBinding(declaration, name)
  }

  const isAngularRouter = (receiver: ts.Expression, site: Site, ctx: ExtractContext): boolean =>
    isBindingOf(ctx.bindings.memberBinding(receiver) ?? ownerMemberBinding(receiver, site, ctx), ANGULAR_ROUTER)

  const isAngularNavigation = (callee: ts.PropertyAccessExpression, site: Site, ctx: ExtractContext): boolean =>
    ANGULAR_NAVIGATE_METHODS.includes(callee.name.text) && isAngularRouter(callee.expression, site, ctx)

  const isGlobalNavigator = (local: string, imported: string | null, ctx: ExtractContext): boolean => {
    if (imported !== null) return navigateFunctions.has(imported)
    return navigateFunctions.has(local) && ctx.bindings.get(local) === null
  }

  const isScopedNavigator = (local: string, ctx: ExtractContext): boolean => {
    const binding = ctx.bindings.get(local)
    if (binding === null || (binding.kind !== "import" && binding.kind !== "dynamic-import")) return false
    return scopedNavigators.some(
      (entry) => entry.name === binding.imported && ctx.bindings.rootsInModule(local, entry.module),
    )
  }

  const isTupleNavigator = (local: string, ctx: ExtractContext): boolean =>
    navigateTuples.some((entry) => ctx.bindings.isHookResult(local, entry.hook, entry.module, entry.index))

  const isGlobalRouter = (receiver: ts.Expression, ctx: ExtractContext): boolean => {
    const inner = ctx.ast.unwrap(receiver)
    const identifier = ctx.ast.asIdentifier(inner)
    if (identifier !== null) return identifier.text === GLOBAL_ROUTER && ctx.bindings.get(GLOBAL_ROUTER) === null
    const access = ctx.ast.asPropertyAccess(inner)
    if (access === null || access.name.text !== GLOBAL_ROUTER) return false
    return ctx.ast.unwrap(access.expression).kind === ctx.ts.SyntaxKind.ThisKeyword
  }

  const isRouterReceiver = (receiver: ts.Expression, ctx: ExtractContext): boolean => {
    if (isGlobalRouter(receiver, ctx)) return true
    const root = ctx.bindings.rootIdentifier(receiver)
    return root !== null && isHook(root, routerHooks, ctx)
  }

  const importsModule = (pattern: RegExp, ctx: ExtractContext): boolean =>
    ctx.source.statements.some(
      (statement) =>
        ctx.ts.isImportDeclaration(statement) &&
        ctx.ts.isStringLiteral(statement.moduleSpecifier) &&
        pattern.test(statement.moduleSpecifier.text),
    )

  const isExpoSingleton = (local: string, ctx: ExtractContext): boolean => {
    const binding = ctx.bindings.get(local)
    return (
      binding !== null &&
      binding.kind === "import" &&
      binding.module === EXPO_ROUTER.module &&
      binding.imported === EXPO_ROUTER.singleton
    )
  }

  const isExpoRouterHook = (local: string, ctx: ExtractContext): boolean =>
    ctx.bindings.isHookResult(local, EXPO_ROUTER.hook, EXPO_ROUTER.module)

  const isExpoRouter = (receiver: ts.Expression, ctx: ExtractContext): boolean => {
    const root = ctx.bindings.rootIdentifier(receiver)
    return root !== null && (isExpoSingleton(root, ctx) || isExpoRouterHook(root, ctx))
  }

  const isNativeHook = (local: string, ctx: ExtractContext): boolean =>
    ctx.bindings.isHookResult(local, NATIVE_HOOK, NATIVE_HOOK_MODULE)

  const bindsName = (binding: ts.BindingName, name: string, ctx: ExtractContext): boolean => {
    if (ctx.ts.isIdentifier(binding)) return binding.text === name
    if (ctx.ts.isObjectBindingPattern(binding))
      return binding.elements.some((element) => bindsName(element.name, name, ctx))
    return false
  }

  const declaresParameter = (node: ts.Node, name: string, ctx: ExtractContext): boolean =>
    ctx.ts.isFunctionLike(node) && node.parameters.some((parameter) => bindsName(parameter.name, name, ctx))

  const isParameterInScope = (node: ts.Node | undefined, name: string, ctx: ExtractContext): boolean => {
    if (node === undefined) return false
    return declaresParameter(node, name, ctx) || isParameterInScope(node.parent, name, ctx)
  }

  const isNativeParameter = (root: string, receiver: ts.Expression, ctx: ExtractContext): boolean =>
    root === NATIVE_PARAMETER && importsModule(NATIVE_MODULE, ctx) && isParameterInScope(receiver, root, ctx)

  const isNativeNavigation = (receiver: ts.Expression, ctx: ExtractContext): boolean => {
    const root = ctx.bindings.rootIdentifier(receiver)
    return root !== null && (isNativeHook(root, ctx) || isNativeParameter(root, receiver, ctx))
  }

  const isNativeAction = (callee: ts.PropertyAccessExpression, ctx: ExtractContext): boolean => {
    const action = ctx.ast.asIdentifier(ctx.ast.unwrap(callee.expression))
    if (action === null || !ctx.bindings.rootsInModule(action.text, NATIVE_MODULE)) return false
    const imported = importedName(action.text, ctx) ?? action.text
    return actionMethodsOf(imported).includes(callee.name.text)
  }

  const expoCallTrigger = (callee: ts.PropertyAccessExpression, ctx: ExtractContext): NavTrigger | null =>
    isExpoRouter(callee.expression, ctx) ? triggerIn(EXPO_METHOD_TRIGGERS, callee.name.text) : null

  const nativeCallTrigger = (callee: ts.PropertyAccessExpression, ctx: ExtractContext): NavTrigger | null =>
    isNativeNavigation(callee.expression, ctx) || isNativeAction(callee, ctx)
      ? triggerIn(NATIVE_METHOD_TRIGGERS, callee.name.text)
      : null

  const expoLocalTrigger = (local: string, ctx: ExtractContext): NavTrigger | null =>
    isExpoRouterHook(local, ctx) ? triggerIn(EXPO_METHOD_TRIGGERS, local) : null

  const nativeLocalTrigger = (local: string, ctx: ExtractContext): NavTrigger | null =>
    isNativeHook(local, ctx) ? triggerIn(NATIVE_METHOD_TRIGGERS, local) : null

  const jsxDialect = (tag: string, ctx: ExtractContext): Dialect => {
    if (ctx.bindings.rootsInModule(tag, EXPO_ROUTER.module)) return "expo"
    if (ctx.bindings.rootsInModule(tag, NATIVE_MODULE) || importsModule(NATIVE_MODULE, ctx)) return "native"
    return "web"
  }

  const isUnboundGlobal = (node: ts.Node, names: ReadonlySet<string>, ctx: ExtractContext): boolean => {
    const identifier = ctx.ast.asIdentifier(ctx.ast.unwrap(node))
    return identifier !== null && names.has(identifier.text) && ctx.bindings.get(identifier.text) === null
  }

  // `location`, `window.location`, `document.location` — the browser's own, never a local of that name.
  const isBrowserLocation = (expression: ts.Expression, ctx: ExtractContext): boolean => {
    const inner = ctx.ast.unwrap(expression)
    if (isUnboundGlobal(inner, LOCATION_GLOBALS, ctx)) return true
    const access = ctx.ast.asPropertyAccess(inner)
    return access !== null && access.name.text === LOCATION && isUnboundGlobal(access.expression, BROWSER_GLOBALS, ctx)
  }

  // `window.open('https://…')`, `<a href="#top">`: a target outside the app is no in-app navigation,
  // resolved or not.
  const recordInAppTarget = (argument: ts.Node | undefined, trigger: NavTrigger, site: Site, ctx: ExtractContext): void => {
    if (argument === undefined) return
    const flat = ctx.flattenString(argument)
    if (flat !== null && isOutOfApp(flat.value)) return
    record(argument, trigger, site, ctx)
  }

  const browserCallTrigger = (callee: ts.PropertyAccessExpression, ctx: ExtractContext): NavTrigger | null => {
    const method = callee.name.text
    if (method === WINDOW_OPEN && isUnboundGlobal(callee.expression, WINDOW_GLOBALS, ctx)) return "navigate"
    const trigger = LOCATION_METHOD_TRIGGERS[method]
    return trigger !== undefined && isBrowserLocation(callee.expression, ctx) ? trigger : null
  }

  // `location.href = '/x'`, `window.location = '/x'`.
  const isLocationTarget = (left: ts.Expression, ctx: ExtractContext): boolean => {
    if (isBrowserLocation(left, ctx) && ctx.ast.asIdentifier(ctx.ast.unwrap(left)) === null) return true
    const access = ctx.ast.asPropertyAccess(ctx.ast.unwrap(left))
    return access !== null && access.name.text === LOCATION_TARGET_PROPERTY && isBrowserLocation(access.expression, ctx)
  }

  const visitAssignment = (node: ts.BinaryExpression, ctx: ExtractContext): void => {
    if (node.operatorToken.kind !== ctx.ts.SyntaxKind.EqualsToken) return
    if (isLocationTarget(node.left, ctx)) recordInAppTarget(node.right, "navigate", null, ctx)
  }

  const visitCall = (call: ts.CallExpression, ctx: ExtractContext, site: Site): void => {
    const identifier = ctx.ast.asIdentifier(call.expression)

    if (identifier !== null) {
      const local = identifier.text

      const expoTrigger = expoLocalTrigger(local, ctx)
      if (expoTrigger !== null) {
        recordTarget(call.arguments[0], expoTrigger, site, ctx, "expo")
        return
      }

      const nativeTrigger = nativeLocalTrigger(local, ctx)
      if (nativeTrigger !== null) {
        recordNativeCall(call.arguments, nativeTrigger, site, ctx)
        return
      }

      // Never match the literal identifier `navigate` — ask the binding table.
      if (isHook(local, navigateHooks, ctx) || isTupleNavigator(local, ctx)) {
        recordTarget(call.arguments[0], "navigate", site, ctx)
        return
      }

      // A destructured router: `const { push, replace } = useRouter()`.
      if (isHook(local, routerHooks, ctx)) {
        const trigger = ROUTER_METHOD_TRIGGERS[local]
        if (trigger !== undefined) recordTarget(call.arguments[0], trigger, site, ctx)
        return
      }

      const imported = importedName(local, ctx)
      if (imported !== null && redirectFunctions.has(imported)) {
        recordTarget(call.arguments[0], "redirect", site, ctx)
        return
      }
      if (isGlobalNavigator(local, imported, ctx) || isScopedNavigator(local, ctx))
        recordTarget(call.arguments[0], "navigate", site, ctx)
      return
    }

    const callee = ctx.ast.asPropertyAccess(call.expression)
    if (callee === null) return

    if (isAngularNavigation(callee, site, ctx)) {
      recordCommands(call.arguments[0], "navigate", site, ctx)
      return
    }

    const browserTrigger = site === null ? browserCallTrigger(callee, ctx) : null
    if (browserTrigger !== null) {
      recordInAppTarget(call.arguments[0], browserTrigger, null, ctx)
      return
    }

    const expoTrigger = expoCallTrigger(callee, ctx)
    if (expoTrigger !== null) {
      recordTarget(call.arguments[0], expoTrigger, site, ctx, "expo")
      return
    }

    const nativeTrigger = nativeCallTrigger(callee, ctx)
    if (nativeTrigger !== null) {
      recordNativeCall(call.arguments, nativeTrigger, site, ctx)
      return
    }

    const trigger = ROUTER_METHOD_TRIGGERS[callee.name.text]
    if (trigger === undefined || !isRouterReceiver(callee.expression, ctx)) return

    recordTarget(call.arguments[0], trigger, site, ctx)
  }

  const tagTrigger = (name: string): NavTrigger | null => {
    if (linkTags.has(name)) return "link"
    if (redirectTags.has(name)) return "redirect"
    return null
  }

  // A plain `<a href>` (never a `download` link) is a link too; a binding named `a` is not the element.
  const visitAnchor = (node: ts.JsxOpeningLikeElement, ctx: ExtractContext): void => {
    if (ctx.ast.attributeByName(node, ANCHOR.download) !== undefined) return
    recordInAppTarget(ctx.ast.attributeByName(node, ANCHOR.target)?.initializer, "link", null, ctx)
  }

  const visitJsx = (node: ts.JsxOpeningLikeElement, ctx: ExtractContext): void => {
    const tag = ctx.ast.tagName(node)
    if (tag === null) return
    if (tag === ANCHOR.tag && ctx.bindings.get(tag) === null) {
      visitAnchor(node, ctx)
      return
    }

    // Resolve through the import so `import { Link as RouterLink }` is still a link, and a local
    // component that merely happens to be called `Link` is judged on its own binding.
    const trigger = tagTrigger(importedName(tag, ctx) ?? tag)
    if (trigger === null) return

    const dialect = jsxDialect(tag, ctx)
    const target = jsxTarget(node, jsxKeys[dialect], ctx)
    if (target === null) return
    if (dialect === "web") {
      record(target.initializer, trigger, null, ctx)
      return
    }
    if (target.key === NATIVE_SCREEN_KEY) {
      recordName(target.initializer, trigger, null, ctx)
      return
    }
    recordTarget(target.initializer, trigger, null, ctx, dialect)
  }

  const jsxTarget = (node: ts.JsxOpeningLikeElement, keys: readonly string[], ctx: ExtractContext) => {
    for (const key of keys) {
      const initializer = ctx.ast.attributeByName(node, key)?.initializer
      if (initializer !== undefined) return { key, initializer }
    }
    return null
  }

  const interpolatedExpression = (text: string): string | null => INTERPOLATION_ONLY.exec(text)?.[1]?.trim() ?? null

  const templateTargetText = (element: TemplateElement, keys: readonly string[]): string | null => {
    for (const key of keys) {
      const attribute = element.attributes.find((candidate) => candidate.name === key && candidate.kind !== "event")
      if (attribute === undefined) continue
      if (attribute.static !== null) return interpolatedExpression(attribute.static) ?? JSON.stringify(attribute.static)
      return attribute.expression === null ? null : (interpolatedExpression(attribute.expression) ?? attribute.expression)
    }
    return null
  }

  const callsIn = (root: ts.Node, ctx: ExtractContext): readonly ts.CallExpression[] => {
    const calls: ts.CallExpression[] = []
    const visit = (node: ts.Node): void => {
      if (ctx.ts.isCallExpression(node)) calls.push(node)
      ctx.ts.forEachChild(node, visit)
    }
    visit(root)
    return calls
  }

  const visitTemplateEvent = (event: TemplateExpression, doc: TemplateDoc, ctx: ExtractContext): void => {
    const expression = ctx.templateExpression(event.text)
    if (expression === null) return
    const site: TemplateSite = { at: templateAnchorOf(doc, event), line: event.line, owner: doc.owner }
    for (const call of callsIn(expression, ctx)) visitCall(call, ctx, site)
  }

  const templateLinkOf = (
    element: TemplateElement,
    tags: TemplateTags,
    ctx: ExtractContext,
  ): { readonly trigger: NavTrigger; readonly keys: readonly string[]; readonly commands: boolean } | null => {
    const name = primaryNameOf(element)
    const resolved = importedName(name, ctx) ?? name
    if (tags.linkTags.includes(resolved)) return { trigger: "link", keys: tags.targetAttributes, commands: false }
    if (redirectTags.has(resolved)) return { trigger: "redirect", keys: tags.targetAttributes, commands: false }
    const linkAttribute = tags.linkAttributes.find((key) => element.attributes.some((attribute) => attribute.name === key))
    if (linkAttribute === undefined) return null
    return { trigger: "link", keys: [linkAttribute], commands: true }
  }

  const isTemplateAnchor = (element: TemplateElement): boolean =>
    element.kind === "element" &&
    element.tag.toLowerCase() === ANCHOR.tag &&
    !element.attributes.some((attribute) => attribute.name === ANCHOR.download)

  const visitTemplateAnchor = (element: TemplateElement, doc: TemplateDoc, ctx: ExtractContext): void => {
    const text = templateTargetText(element, [ANCHOR.target])
    const expression = text === null ? null : ctx.templateExpression(text)
    if (expression === null) return
    recordInAppTarget(expression, "link", { at: templateAnchorOf(doc, element), line: element.line }, ctx)
  }

  const visitTemplateLink = (element: TemplateElement, doc: TemplateDoc, tags: TemplateTags, ctx: ExtractContext): void => {
    const link = templateLinkOf(element, tags, ctx)
    if (link === null && isTemplateAnchor(element)) {
      visitTemplateAnchor(element, doc, ctx)
      return
    }
    if (link === null) return
    const text = templateTargetText(element, link.keys)
    if (text === null) return
    const expression = ctx.templateExpression(text)
    if (expression === null) return
    const site: TemplateSite = { at: templateAnchorOf(doc, element), line: element.line }
    if (link.commands) {
      recordCommands(expression, link.trigger, site, ctx)
      return
    }
    recordTarget(expression, link.trigger, site, ctx)
  }

  return {
    name: "navigation",
    provides: ["navigations", "unresolvedNavigations"],
    requires: ["bindings", "stringConstants"],
    stage: "main",

    start: () => {
      seen.clear()
      pendingLookups.length = 0
    },

    enter: (node, ctx) => {
      const api = ctx.ts
      if (api.isJsxOpeningElement(node) || api.isJsxSelfClosingElement(node)) {
        visitJsx(node, ctx)
        return
      }

      if (api.isBinaryExpression(node)) {
        visitAssignment(node, ctx)
        return
      }

      const call = ctx.ast.asCallExpression(node)
      if (call !== null && call === node) visitCall(call, ctx, null)
    },

    template: (doc, ctx) => {
      const tags = ctx.tagsOf(doc.framework)
      for (const element of doc.elements) visitTemplateLink(element, doc, tags, ctx)
      for (const event of expressionsFrom(doc, "event")) visitTemplateEvent(event, doc, ctx)
    },

    finish: resolveLookups,
  }
}
