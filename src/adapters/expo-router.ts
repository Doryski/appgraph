import type ts from "typescript"
import type { Activation, AncestorRef, EntryRef, Evidence, SpliceMode } from "../core/model.js"
import { sortBy, sortStrings, sortedUnique, stableUnique } from "../core/order.js"
import { platformsFor } from "../core/platform.js"
import { convertExpoRoutePath, type ExpoRouteOptions } from "../core/url.js"
import { planExpoRoutes, type ExpoLayoutPlan, type ExpoRouteIssue, type ExpoScreenPlan } from "./expo-routes.js"
import { conventionChain, type FileRouteConvention } from "./file-routes.js"
import { authFromGuard, resolveNativeAuthRules, type NativeAuthRules, type NativeAuthVerdict } from "./native-auth.js"
import { memoPerRun } from "./next-conventions.js"
import type {
  Adapter,
  DetectResult,
  DiscoverContext,
  EntryContext,
  ProjectContext,
  ScreenDraft,
  ScreenShape,
  ScreenSource,
} from "./types.js"
import { isFileEntry } from "./types.js"

export const EXPO_ROUTER_SOURCE = "expo-router"

const EXPO_ROUTER_PACKAGE = "expo-router"

const ROUTE_EXTENSIONS = ["tsx", "ts", "jsx", "js"] as const

const ROUTE_GLOB = `**/*.{${ROUTE_EXTENSIONS.join(",")}}`

const DEFAULT_ROOTS = ["app", "src/app"] as const

const APP_JSON = "app.json"

const APP_CONFIG_JSON = "app.config.json"

const APP_CONFIG_SCRIPTS = ["app.config.ts", "app.config.js", "app.config.mjs", "app.config.cjs"] as const

const LAYOUT_BASE = "_layout"

const EXCLUDED_ROUTE_FILE = /(?:\.d\.ts|\.(?:test|spec)\.[cm]?[jt]sx?)$|(?:^|\/)__tests__\//

const NAVIGATOR_MODULES: ReadonlySet<string> = new Set([
  "expo-router",
  "expo-router/drawer",
  "expo-router/stack",
  "expo-router/tabs",
  "expo-router/unstable-native-tabs",
])

const NAVIGATOR_EXPORTS: ReadonlySet<string> = new Set(["Stack", "Tabs", "Drawer", "Slot", "NativeTabs"])

const LAYOUT_CONTEXT_FACTORY = "withLayoutContext"

const SCREEN_MEMBER = "Screen"

const PROTECTED_MEMBER = "Protected"

const GUARD_ATTRIBUTE = "guard"

const REDIRECT_EXPORT = "Redirect"

const SEGMENTS_HOOK = "useSegments"

const REPLACE_METHOD = "replace"

const CHILDREN_SPLICE: SpliceMode = { kind: "children" }

const NO_DETECTION: DetectResult = { score: 0, evidence: [] }

export type ExpoRouterOptions = {
  readonly root?: string
  readonly authRules?: NativeAuthRules
}

type RoutesDir = { readonly dir: string; readonly files: readonly string[] }

type PluginRoot =
  | { readonly kind: "absent" }
  | { readonly kind: "literal"; readonly root: string }
  | { readonly kind: "dynamic" }

const ABSENT: PluginRoot = { kind: "absent" }

const DYNAMIC: PluginRoot = { kind: "dynamic" }

type ExpoConfig = { readonly root: string | null; readonly dynamicFile: string | null }

type NavigatorKind = "builtin" | "context"

type ScreenDeclaration = {
  readonly name: string
  readonly node: ts.JsxOpeningLikeElement
  readonly guard: ts.Expression | null
}

type FileFacts = {
  readonly outletTag: string | null
  readonly screens: readonly ScreenDeclaration[]
  readonly guardEvidence: readonly Evidence[]
}

type LayoutScope = { readonly file: string; readonly prefixes: readonly string[]; readonly facts: FileFacts }

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value)

const normalizeDir = (dir: string): string => dir.replace(/^\.\//, "").replace(/\/+$/, "")

const parseJson = (text: string | null): unknown => {
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return null
  }
}

const jsonPluginRoot = (plugin: unknown): string | null => {
  if (!isList(plugin) || plugin[0] !== EXPO_ROUTER_PACKAGE) return null
  const options = plugin[1]
  return isRecord(options) && typeof options.root === "string" ? options.root : null
}

const pluginRootOfJson = (value: unknown): PluginRoot => {
  const expo = isRecord(value) && isRecord(value.expo) ? value.expo : value
  const plugins = isRecord(expo) ? expo.plugins : undefined
  if (!isList(plugins)) return ABSENT
  const root = plugins.map(jsonPluginRoot).find((found) => found !== null)
  return root === undefined || root === null ? ABSENT : { kind: "literal", root }
}

const unwrapExpression = (api: ProjectContext["ts"], node: ts.Expression): ts.Expression => {
  if (api.isParenthesizedExpression(node) || api.isAsExpression(node) || api.isSatisfiesExpression(node))
    return unwrapExpression(api, node.expression)
  return node
}

const isModuleExportsTarget = (api: ProjectContext["ts"], node: ts.Expression): boolean =>
  api.isPropertyAccessExpression(node) &&
  api.isIdentifier(node.expression) &&
  node.expression.text === "module" &&
  node.name.text === "exports"

const exportedExpressionOf = (api: ProjectContext["ts"], source: ts.SourceFile): ts.Expression | null => {
  for (const statement of source.statements) {
    if (api.isExportAssignment(statement)) return statement.expression
    if (!api.isExpressionStatement(statement) || !api.isBinaryExpression(statement.expression)) continue
    const assignment = statement.expression
    if (assignment.operatorToken.kind === api.SyntaxKind.EqualsToken && isModuleExportsTarget(api, assignment.left))
      return assignment.right
  }
  return null
}

const propertyNameOf = (api: ProjectContext["ts"], member: ts.ObjectLiteralElementLike): string | null => {
  const name = member.name
  if (name === undefined) return null
  if (api.isIdentifier(name) || api.isStringLiteral(name)) return name.text
  return null
}

const memberOf = (
  api: ProjectContext["ts"],
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | null => object.properties.find((member) => propertyNameOf(api, member) === name) ?? null

const hasSpread = (api: ProjectContext["ts"], object: ts.ObjectLiteralExpression): boolean =>
  object.properties.some((member) => api.isSpreadAssignment(member))

const literalObjectOf = (api: ProjectContext["ts"], node: ts.Expression): ts.ObjectLiteralExpression | null => {
  const inner = unwrapExpression(api, node)
  return api.isObjectLiteralExpression(inner) ? inner : null
}

const initializerOf = (api: ProjectContext["ts"], member: ts.ObjectLiteralElementLike): ts.Expression | null =>
  api.isPropertyAssignment(member) ? member.initializer : null

const configObjectOf = (api: ProjectContext["ts"], root: ts.ObjectLiteralExpression): ts.ObjectLiteralExpression | null => {
  const expo = memberOf(api, root, "expo")
  if (expo === null) return root
  const initializer = initializerOf(api, expo)
  return initializer === null ? null : literalObjectOf(api, initializer)
}

const scriptPluginRoot = (api: ProjectContext["ts"], plugin: ts.Expression): PluginRoot => {
  const inner = unwrapExpression(api, plugin)
  if (api.isStringLiteralLike(inner)) return ABSENT
  if (!api.isArrayLiteralExpression(inner)) return DYNAMIC
  const [name, options] = inner.elements
  if (name === undefined || !api.isStringLiteralLike(name) || name.text !== EXPO_ROUTER_PACKAGE) return ABSENT
  if (options === undefined) return ABSENT
  const object = literalObjectOf(api, options)
  if (object === null) return DYNAMIC
  const rootMember = memberOf(api, object, "root")
  if (rootMember === null) return hasSpread(api, object) ? DYNAMIC : ABSENT
  const value = initializerOf(api, rootMember)
  return value !== null && api.isStringLiteralLike(value) ? { kind: "literal", root: value.text } : DYNAMIC
}

const firstDecided = (roots: readonly PluginRoot[]): PluginRoot =>
  roots.find((root) => root.kind === "dynamic") ?? roots.find((root) => root.kind === "literal") ?? ABSENT

const pluginRootOfObject = (api: ProjectContext["ts"], config: ts.ObjectLiteralExpression): PluginRoot => {
  const plugins = memberOf(api, config, "plugins")
  if (plugins === null) return hasSpread(api, config) ? DYNAMIC : ABSENT
  const initializer = initializerOf(api, plugins)
  const array = initializer === null ? null : unwrapExpression(api, initializer)
  if (array === null || !api.isArrayLiteralExpression(array)) return DYNAMIC
  return firstDecided(array.elements.map((element) => scriptPluginRoot(api, element)))
}

const pluginRootOfScript = (ctx: ProjectContext, file: string): PluginRoot => {
  const text = ctx.readFile(file)
  if (text === null) return ABSENT
  const api = ctx.ts
  const source = api.createSourceFile(file, text, api.ScriptTarget.Latest, true)
  const exported = exportedExpressionOf(api, source)
  const root = exported === null ? null : literalObjectOf(api, exported)
  const config = root === null ? null : configObjectOf(api, root)
  return config === null ? DYNAMIC : pluginRootOfObject(api, config)
}

const literalRootOf = (root: PluginRoot): string | null => (root.kind === "literal" ? root.root : null)

const expoConfigOf = (ctx: ProjectContext): ExpoConfig => {
  const appJson = pluginRootOfJson(parseJson(ctx.readFile(APP_JSON)))
  const configJson = pluginRootOfJson(parseJson(ctx.readFile(APP_CONFIG_JSON)))
  const script = APP_CONFIG_SCRIPTS.find((file) => ctx.exists(file)) ?? null
  const scripted = script === null ? ABSENT : pluginRootOfScript(ctx, script)
  return {
    root: literalRootOf(scripted) ?? literalRootOf(configJson) ?? literalRootOf(appJson),
    dynamicFile: scripted.kind === "dynamic" ? script : null,
  }
}

const routeFilesUnder = (ctx: ProjectContext, dir: string): readonly string[] =>
  ctx.glob(`${dir}/${ROUTE_GLOB}`).filter((file) => !ctx.isGenerated(file) && !EXCLUDED_ROUTE_FILE.test(file))

const rootCandidatesOf = (ctx: ProjectContext, options: ExpoRouterOptions): readonly string[] =>
  stableUnique(
    [expoConfigOf(ctx).root, options.root ?? null, ...DEFAULT_ROOTS]
      .flatMap((dir) => (dir === null ? [] : [normalizeDir(dir)]))
      .filter((dir) => dir !== ""),
  )

const routesDirOf = (ctx: ProjectContext, options: ExpoRouterOptions): RoutesDir | null => {
  for (const dir of rootCandidatesOf(ctx, options)) {
    const files = routeFilesUnder(ctx, dir)
    if (files.length > 0) return { dir, files }
  }
  return null
}

const detectExpoRouterWith = (ctx: ProjectContext, options: ExpoRouterOptions): DetectResult => {
  if (!ctx.hasDependency(EXPO_ROUTER_PACKAGE)) return NO_DETECTION
  const routes = routesDirOf(ctx, options)
  const first = routes?.files[0]
  if (routes === null || first === undefined) return NO_DETECTION
  return {
    score: 100,
    evidence: [{ what: `expo-router dependency with route files under ${routes.dir}/`, file: first, line: 1 }],
  }
}

export const detectExpoRouter = (ctx: ProjectContext): DetectResult => detectExpoRouterWith(ctx, {})

const layoutExtensionsOf = (platforms: readonly string[]): readonly string[] => [
  ...ROUTE_EXTENSIONS,
  ...platforms.flatMap((platform) => ROUTE_EXTENSIONS.map((extension) => `${platform}.${extension}`)),
]

const conventionOf = (dir: string, platforms: readonly string[]): FileRouteConvention => ({
  root: { kind: "dir", dir },
  extensions: layoutExtensionsOf(platforms),
})

const projectPath = (dir: string, rel: string): string => (rel === "" ? dir : `${dir}/${rel}`)

const relativeTo = (dir: string, file: string): string => file.slice(dir.length + 1)

const dirOf = (path: string): string => {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? "" : path.slice(0, slash)
}

const platformsOf = (ctx: ProjectContext): ExpoRouteOptions => ({
  platforms: platformsFor({ dependencies: ctx.dependencies, manifestText: ctx.readFile("package.json") ?? "" }),
})

const importBindingOf = (ctx: DiscoverContext, file: string, local: string) => {
  const binding = ctx.bindingsFor(file).get(local)
  return binding !== null && binding.kind === "import" ? binding : null
}

const isImportOf = (ctx: DiscoverContext, file: string, local: string, modules: ReadonlySet<string>, name: string) => {
  const binding = importBindingOf(ctx, file, local)
  return binding !== null && modules.has(binding.module) && binding.imported === name
}

const EXPO_ROUTER_MODULES: ReadonlySet<string> = new Set([EXPO_ROUTER_PACKAGE])

const layoutContextLocals = (ctx: DiscoverContext, file: string): ReadonlySet<string> => {
  const source = ctx.sourceFile(file)
  if (source === null) return new Set()
  const found = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ctx.ts.isVariableDeclaration(node) && ctx.ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const call = ctx.ast.asCallExpression(node.initializer)
      const callee = call === null ? null : ctx.ast.asIdentifier(call.expression)
      if (callee !== null && isImportOf(ctx, file, callee.text, EXPO_ROUTER_MODULES, LAYOUT_CONTEXT_FACTORY))
        found.add(node.name.text)
    }
    ctx.ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const navigatorKindOf = (ctx: DiscoverContext, file: string, local: string): NavigatorKind | null => {
  if (layoutContextLocals(ctx, file).has(local)) return "context"
  const binding = importBindingOf(ctx, file, local)
  if (binding === null) return null
  if (NAVIGATOR_MODULES.has(binding.module) && NAVIGATOR_EXPORTS.has(binding.imported)) return "builtin"
  if (binding.file !== null && layoutContextLocals(ctx, binding.file).has(binding.imported)) return "context"
  return null
}

const memberTagOf = (ctx: DiscoverContext, element: ts.JsxOpeningLikeElement) => {
  const tag = element.tagName
  if (!ctx.ts.isPropertyAccessExpression(tag) || !ctx.ts.isIdentifier(tag.expression)) return null
  return { root: tag.expression.text, member: tag.name.text }
}

const identifierTagOf = (ctx: DiscoverContext, element: ts.JsxOpeningLikeElement): string | null =>
  ctx.ts.isIdentifier(element.tagName) ? element.tagName.text : null

const outletTagOf = (ctx: DiscoverContext, file: string, elements: readonly ts.JsxOpeningLikeElement[]) => {
  const navigators = elements.flatMap((element) => {
    const tag = identifierTagOf(ctx, element)
    const kind = tag === null ? null : navigatorKindOf(ctx, file, tag)
    return tag === null || kind === null ? [] : [{ tag, kind }]
  })
  return (navigators.find((navigator) => navigator.kind === "context") ?? navigators[0])?.tag ?? null
}

const enclosingProtected = (ctx: DiscoverContext, file: string, node: ts.Node): ts.JsxOpeningElement | null => {
  const parent = node.parent
  if (parent === undefined || ctx.ts.isSourceFile(parent)) return null
  if (ctx.ts.isJsxElement(parent) && parent.openingElement !== node) {
    const member = memberTagOf(ctx, parent.openingElement)
    if (member !== null && member.member === PROTECTED_MEMBER && navigatorKindOf(ctx, file, member.root) !== null)
      return parent.openingElement
  }
  return enclosingProtected(ctx, file, parent)
}

const guardExpressionOf = (ctx: DiscoverContext, element: ts.JsxOpeningElement | null): ts.Expression | null => {
  if (element === null) return null
  const initializer = ctx.ast.attributeByName(element, GUARD_ATTRIBUTE)?.initializer
  if (initializer === undefined) return null
  if (ctx.ts.isJsxExpression(initializer)) return initializer.expression ?? null
  return ctx.ts.isStringLiteral(initializer) ? initializer : null
}

const screenNameOf = (ctx: DiscoverContext, file: string, element: ts.JsxOpeningLikeElement): string | null => {
  const initializer = ctx.ast.attributeByName(element, "name")?.initializer
  if (initializer === undefined) return null
  const flat = ctx.flattenString(initializer, file)
  return flat === null || flat.dynamic ? null : flat.value
}

const screenDeclarationsOf = (
  ctx: DiscoverContext,
  file: string,
  elements: readonly ts.JsxOpeningLikeElement[],
): readonly ScreenDeclaration[] =>
  elements.flatMap((element) => {
    const member = memberTagOf(ctx, element)
    if (member === null || member.member !== SCREEN_MEMBER || navigatorKindOf(ctx, file, member.root) === null) return []
    const name = screenNameOf(ctx, file, element)
    if (name === null) return []
    return [{ name, node: element, guard: guardExpressionOf(ctx, enclosingProtected(ctx, file, element)) }]
  })

const redirectEvidenceOf = (
  ctx: DiscoverContext,
  file: string,
  elements: readonly ts.JsxOpeningLikeElement[],
): readonly Evidence[] =>
  elements.flatMap((element) => {
    const tag = identifierTagOf(ctx, element)
    if (tag === null || !isImportOf(ctx, file, tag, EXPO_ROUTER_MODULES, REDIRECT_EXPORT)) return []
    const condition = ctx.guardOf(element).condition ?? earlyReturnGuardOf(ctx, element)
    if (condition === null) return []
    return [ctx.evidence(`conditional <Redirect> guard (${condition}); auth unknown`, file, element)]
  })

const returnStatementOf = (ctx: DiscoverContext, node: ts.Node): ts.ReturnStatement | null => {
  const parent = node.parent
  if (parent === undefined) return null
  if (ctx.ts.isReturnStatement(parent)) return parent
  const passesThrough = ctx.ts.isJsxElement(parent) || ctx.ts.isParenthesizedExpression(parent)
  return passesThrough ? returnStatementOf(ctx, parent) : null
}

const negated = (condition: string): string => `!(${condition})`

const branchGuardOf = (ctx: DiscoverContext, returned: ts.ReturnStatement): string | null => {
  const holder = ctx.ts.isBlock(returned.parent) ? returned.parent : returned
  const statement = holder.parent
  if (statement === undefined || !ctx.ts.isIfStatement(statement)) return null
  const condition = statement.expression.getText()
  return statement.thenStatement === holder ? condition : negated(condition)
}

const alwaysReturns = (ctx: DiscoverContext, statement: ts.Statement): boolean =>
  ctx.ts.isReturnStatement(statement) ||
  (ctx.ts.isBlock(statement) && statement.statements.some((inner) => ctx.ts.isReturnStatement(inner)))

const fallThroughGuardOf = (ctx: DiscoverContext, returned: ts.ReturnStatement): string | null => {
  const block = returned.parent
  if (!ctx.ts.isBlock(block)) return null
  const previous = block.statements[block.statements.indexOf(returned) - 1]
  if (previous === undefined || !ctx.ts.isIfStatement(previous) || previous.elseStatement !== undefined) return null
  return alwaysReturns(ctx, previous.thenStatement) ? negated(previous.expression.getText()) : null
}

const earlyReturnGuardOf = (ctx: DiscoverContext, element: ts.Node): string | null => {
  const returned = returnStatementOf(ctx, element)
  if (returned === null) return null
  return branchGuardOf(ctx, returned) ?? fallThroughGuardOf(ctx, returned)
}

const callsOf = (ctx: DiscoverContext, source: ts.SourceFile): readonly ts.CallExpression[] => {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ctx.ts.isCallExpression(node)) calls.push(node)
    ctx.ts.forEachChild(node, visit)
  }
  visit(source)
  return calls
}

const hookGuardEvidenceOf = (ctx: DiscoverContext, file: string, source: ts.SourceFile): readonly Evidence[] => {
  const calls = callsOf(ctx, source)
  const segments = calls.find((call) => {
    const callee = ctx.ast.asIdentifier(call.expression)
    return callee !== null && isImportOf(ctx, file, callee.text, EXPO_ROUTER_MODULES, SEGMENTS_HOOK)
  })
  const replaces = calls.some((call) => ctx.ast.asPropertyAccess(call.expression)?.name.text === REPLACE_METHOD)
  if (segments === undefined || !replaces) return []
  return [ctx.evidence("useSegments() + router.replace hook guard; auth unknown", file, segments)]
}

const factsOf = (ctx: DiscoverContext, file: string): FileFacts => {
  const source = ctx.sourceFile(file)
  if (source === null) return { outletTag: null, screens: [], guardEvidence: [] }
  const elements = ctx.ast.jsxElementsIn(source)
  return {
    outletTag: outletTagOf(ctx, file, elements),
    screens: screenDeclarationsOf(ctx, file, elements),
    guardEvidence: [...redirectEvidenceOf(ctx, file, elements), ...hookGuardEvidenceOf(ctx, file, source)],
  }
}

const createFactsCache = () => {
  const perRun = memoPerRun<Pick<DiscoverContext, "strings">, Map<string, FileFacts>>(() => new Map())
  return (ctx: DiscoverContext, file: string): FileFacts => {
    const cache = perRun(ctx)
    const cached = cache.get(file)
    if (cached !== undefined) return cached
    const facts = factsOf(ctx, file)
    cache.set(file, facts)
    return facts
  }
}

type FactsOf = ReturnType<typeof createFactsCache>

const layoutChainOf = (ctx: ProjectContext, dir: string, file: string): readonly AncestorRef[] =>
  conventionChain(ctx, file, conventionOf(dir, platformsOf(ctx).platforms), [{ base: LAYOUT_BASE, role: "layout" }])

const spliceOf = (facts: FileFacts): SpliceMode =>
  facts.outletTag === null ? CHILDREN_SPLICE : { kind: "outlet", tag: facts.outletTag }

const layoutPrefixesOf = (dir: string, layoutFile: string, options: ExpoRouteOptions): readonly string[] =>
  sortedUnique(convertExpoRoutePath(relativeTo(dir, layoutFile), options).routeNames.map(dirOf))

const relativeName = (prefix: string, routeName: string): string | null => {
  if (prefix === "") return routeName
  return routeName.startsWith(`${prefix}/`) ? routeName.slice(prefix.length + 1) : null
}

const coversName = (declared: string, relative: string): boolean =>
  relative === declared || relative.startsWith(`${declared}/`)

const declaresRoute = (scope: LayoutScope, declaration: ScreenDeclaration, routeNames: readonly string[]): boolean =>
  scope.prefixes.some((prefix) =>
    routeNames.some((routeName) => {
      const relative = relativeName(prefix, routeName)
      return relative !== null && coversName(declaration.name, relative)
    }),
  )

type GuardMatch = { readonly scope: LayoutScope; readonly declaration: ScreenDeclaration; readonly guard: ts.Expression }

const guardMatchOf = (scopes: readonly LayoutScope[], routeNames: readonly string[]): GuardMatch | null => {
  for (const scope of [...scopes].reverse()) {
    const declaration = scope.facts.screens.find(
      (candidate) => candidate.guard !== null && declaresRoute(scope, candidate, routeNames),
    )
    if (declaration?.guard !== undefined && declaration.guard !== null)
      return { scope, declaration, guard: declaration.guard }
  }
  return null
}

const authOf = (ctx: DiscoverContext, match: GuardMatch | null, rules: NativeAuthRules) => {
  if (match === null) return { verdict: null, evidence: [] }
  const text = match.guard.getText()
  const verdict: NativeAuthVerdict = authFromGuard(text, rules)
  const navigator = memberTagOf(ctx, match.declaration.node)?.root ?? ""
  return {
    verdict,
    evidence: [ctx.evidence(`${navigator}.Protected guard={${text}}`, match.scope.file, match.guard)],
  }
}

const urlActivationOf = (screen: ExpoScreenPlan): readonly Activation[] =>
  screen.url === null ? [] : [{ kind: "url", template: screen.url, params: screen.params }]

const routeActivationsOf = (dir: string, screen: ExpoScreenPlan): readonly Activation[] =>
  screen.routes.map((route) => ({ kind: "route", name: route.name, navigator: projectPath(dir, route.navigator) }))

const entriesOf = (dir: string, screen: ExpoScreenPlan): readonly EntryRef[] =>
  screen.entries.map((entry) => ({
    kind: "file",
    file: projectPath(dir, entry.file),
    exportName: "default",
    ...(entry.platform === null ? {} : { platform: entry.platform }),
  }))

const entryEvidenceOf = (ctx: DiscoverContext, dir: string, screen: ExpoScreenPlan): readonly Evidence[] =>
  screen.entries.map((entry) =>
    ctx.evidence(
      entry.platform === null ? "expo-router route file" : `expo-router ${entry.platform} platform variant`,
      projectPath(dir, entry.file),
    ),
  )

type DiscoverEnv = {
  readonly ctx: DiscoverContext
  readonly dir: string
  readonly options: ExpoRouteOptions
  readonly rules: NativeAuthRules
  readonly factsOf: FactsOf
  readonly layoutsByDir: ReadonlyMap<string, ExpoLayoutPlan>
}

const layoutsByDirOf = (dir: string, layouts: readonly ExpoLayoutPlan[]): ReadonlyMap<string, ExpoLayoutPlan> =>
  new Map(layouts.map((layout) => [projectPath(dir, layout.dir), layout] as const))

const layoutVariantEvidenceOf = (env: DiscoverEnv, scope: LayoutScope): readonly Evidence[] =>
  (env.layoutsByDir.get(dirOf(scope.file))?.entries ?? []).flatMap((entry) => {
    const file = projectPath(env.dir, entry.file)
    if (entry.platform === null || file === scope.file) return []
    return [env.ctx.evidence(`expo-router ${entry.platform} platform variant of layout ${scope.file}`, file)]
  })

const scopesOf = (env: DiscoverEnv, file: string): readonly LayoutScope[] =>
  layoutChainOf(env.ctx, env.dir, file).map((ancestor) => ({
    file: ancestor.file,
    prefixes: layoutPrefixesOf(env.dir, ancestor.file, env.options),
    facts: env.factsOf(env.ctx, ancestor.file),
  }))

const draftOf = (env: DiscoverEnv, screen: ExpoScreenPlan): ScreenDraft => {
  const { ctx, dir } = env
  const file = projectPath(dir, screen.file)
  const scopes = scopesOf(env, file)
  const routeNames = screen.routes.map((route) => route.name)
  const auth = authOf(ctx, guardMatchOf(scopes, routeNames), env.rules)
  const guardEvidence =
    auth.evidence.length > 0
      ? []
      : [...scopes.flatMap((scope) => scope.facts.guardEvidence), ...env.factsOf(ctx, file).guardEvidence]
  return {
    localId: ctx.localId(file),
    activations: [...urlActivationOf(screen), ...routeActivationsOf(dir, screen)],
    entries: entriesOf(dir, screen),
    evidence: [
      ...entryEvidenceOf(ctx, dir, screen),
      ...scopes.flatMap((scope) => layoutVariantEvidenceOf(env, scope)),
      ...auth.evidence,
      ...guardEvidence,
    ],
    ...(screen.kindTag === null ? {} : { kindTag: screen.kindTag }),
    ...(auth.verdict === null ? {} : { auth: auth.verdict }),
  }
}

const ISSUE_DIAGNOSTICS = {
  "shared-route": { severity: "info", code: "screens/shared-route" },
  "orphan-platform-variant": { severity: "warning", code: "screens/orphan-platform-variant" },
  "route-conflict": { severity: "warning", code: "screens/route-conflict" },
  "shadowed-not-found": { severity: "info", code: "screens/route-conflict" },
} as const

const reportIssue = (ctx: DiscoverContext, dir: string, issue: ExpoRouteIssue): void =>
  ctx.diagnostic({ ...ISSUE_DIAGNOSTICS[issue.kind], message: issue.message, file: projectPath(dir, issue.file) })

const unmatchedNamesOf = (env: DiscoverEnv, layout: ExpoLayoutPlan, routeNames: readonly string[]) => {
  const file = projectPath(env.dir, layout.file)
  const scope: LayoutScope = {
    file,
    prefixes: layoutPrefixesOf(env.dir, file, env.options),
    facts: env.factsOf(env.ctx, file),
  }
  return {
    file,
    names: sortedUnique(
      scope.facts.screens
        .filter((declaration) => !declaresRoute(scope, declaration, routeNames))
        .map((declaration) => declaration.name),
    ),
  }
}

const reportUnmatchedScreens = (env: DiscoverEnv, layouts: readonly ExpoLayoutPlan[], routeNames: readonly string[]) => {
  for (const layout of layouts) {
    const unmatched = unmatchedNamesOf(env, layout, routeNames)
    if (unmatched.names.length === 0) continue
    env.ctx.diagnostic({
      severity: "info",
      code: "screens/unmatched-layout-screen",
      message: `Expo Router layout '${unmatched.file}' configures ${unmatched.names.map((name) => `'${name}'`).join(", ")} with no matching route file; the option-only screen entries are ignored`,
      file: unmatched.file,
    })
  }
}

const reportDynamicConfig = (ctx: DiscoverContext): void => {
  const dynamicFile = expoConfigOf(ctx).dynamicFile
  if (dynamicFile === null) return
  ctx.diagnostic({
    severity: "info",
    code: "project/expo-config-dynamic",
    message: `Expo config '${dynamicFile}' is not a literal object, so its expo-router plugin 'root' was not read; routes are looked up in app.json's plugin root, then config expoRouter.root, then app/ and src/app/`,
    file: dynamicFile,
  })
}

const discoverExpoRouter = (
  ctx: DiscoverContext,
  routes: RoutesDir | null,
  rules: NativeAuthRules,
  factsOf: FactsOf,
): readonly ScreenDraft[] => {
  if (!ctx.hasDependency(EXPO_ROUTER_PACKAGE)) return []
  reportDynamicConfig(ctx)
  if (routes === null) return []
  const options = platformsOf(ctx)
  const plan = planExpoRoutes(
    routes.files.map((file) => relativeTo(routes.dir, file)),
    options,
  )
  for (const issue of plan.issues) reportIssue(ctx, routes.dir, issue)
  const env: DiscoverEnv = {
    ctx,
    dir: routes.dir,
    options,
    rules,
    factsOf,
    layoutsByDir: layoutsByDirOf(routes.dir, plan.layouts),
  }
  reportUnmatchedScreens(
    env,
    plan.layouts,
    sortStrings(plan.screens.flatMap((screen) => screen.routes.map((route) => route.name))),
  )
  return sortBy(
    plan.screens.map((screen) => draftOf(env, screen)),
    (draft) => draft.localId,
  )
}

const primaryFileOf = (screen: ScreenShape): string | null => {
  const files = screen.entries.filter(isFileEntry)
  return (files.find((entry) => entry.platform === undefined) ?? files[0])?.file ?? null
}

const ancestorsOfExpoRoute = (
  screen: ScreenShape,
  ctx: EntryContext,
  routes: RoutesDir | null,
  factsOf: FactsOf,
): readonly AncestorRef[] => {
  if (screen.kindTag === "apiRoute" || routes === null) return []
  const file = primaryFileOf(screen)
  if (file === null || !file.startsWith(`${routes.dir}/`)) return []
  return layoutChainOf(ctx, routes.dir, file).map((ancestor) => ({
    ...ancestor,
    splice: spliceOf(factsOf(ctx, ancestor.file)),
  }))
}

export const createExpoRouterSource = (options: ExpoRouterOptions = {}): ScreenSource => {
  const rules = options.authRules ?? resolveNativeAuthRules({})
  const routesOf = memoPerRun((ctx: DiscoverContext) => routesDirOf(ctx, options))
  const factsOf = createFactsCache()
  return {
    name: EXPO_ROUTER_SOURCE,
    detect: (ctx) => detectExpoRouterWith(ctx, options),
    discover: (ctx) => discoverExpoRouter(ctx, routesOf(ctx), rules, factsOf),
    ancestorsOf: (screen, ctx) => ancestorsOfExpoRoute(screen, ctx, routesOf(ctx), factsOf),
  }
}

export const createExpoRouterAdapter = (options: ExpoRouterOptions = {}): Adapter => ({
  name: EXPO_ROUTER_SOURCE,
  screens: [createExpoRouterSource(options)],
})
