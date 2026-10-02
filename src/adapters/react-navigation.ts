import type { Activation, Evidence, PathTableSpec } from "../core/model.js"
import { by, sortBy, sortStrings, sortedUnique, stableUnique, thenBy } from "../core/order.js"
import { convertReactRouterPath, paramsOf } from "../core/url.js"
import type { UnreadableItem } from "./array-values.js"
import { sharedRouteWinner } from "./expo-routes.js"
import {
  authFromGuard,
  authFromOptions,
  resolveNativeAuthRules,
  type NativeAuthRules,
  type NativeAuthVerdict,
} from "./native-auth.js"
import { UNREADABLE_SITE_LIMIT } from "./next-config.js"
import { readRegistrations, type NavigatorRef, type Registration } from "./react-navigation-registry.js"
import { DETECT_SCORE_DATA_ROUTER, appFiles } from "./react-router/constants.js"
import { autoLinkingPaths, readLinking, readPathTables, type LinkingTable } from "./route-tables.js"
import { lineAt } from "./source-utils.js"
import type {
  Adapter,
  DetectResult,
  DiscoverContext,
  EntryRef,
  ProjectContext,
  ScreenDraft,
  ScreenSource,
  TsNode,
} from "./types.js"

export const REACT_NAVIGATION_SOURCE = "react-navigation"

const REACT_NAVIGATION_DEPENDENCY = /^@react-navigation\//

const EXPO_ROUTER_PACKAGE = "expo-router"

const NAVIGATOR_CALL = /\b(create\w+Navigator\w*)\s*(?:<[^()]*>)?\s*\(/

const STATIC_NAVIGATION_LOCAL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createStaticNavigation\s*\(/g

const CONTAINER_TAG = "NavigationContainer"

const LINKING_ATTRIBUTE = "linking"

const ROUTE_ID_MARKER = "#route:"

const NO_DETECTION: DetectResult = { score: 0, evidence: [] }

export type ReactNavigationOptions = {
  readonly pathTables?: readonly PathTableSpec[]
  readonly authRules?: NativeAuthRules
}

type Named = Registration & { readonly name: string }

type PathMap = ReadonlyMap<string, readonly string[]>

type Located = { readonly file: string; readonly node: TsNode }

type PathRead = { readonly paths: PathMap; readonly unreadable: readonly UnreadableItem[] }

type Claim = { readonly name: string; readonly file: string; readonly routeNames: readonly string[] }

const appliesTo = (ctx: ProjectContext): boolean =>
  ctx.hasDependency(REACT_NAVIGATION_DEPENDENCY) && !ctx.hasDependency(EXPO_ROUTER_PACKAGE)

const factoryEvidenceIn = (file: string, text: string | null): Evidence | null => {
  const match = text === null ? null : NAVIGATOR_CALL.exec(text)
  if (text === null || match === null) return null
  return { what: `${match[1] ?? match[0]} call`, file, line: lineAt(text, match.index) }
}

const factoryEvidenceOf = (ctx: ProjectContext): Evidence | null => {
  for (const file of appFiles(ctx)) {
    const evidence = factoryEvidenceIn(file, ctx.readFile(file))
    if (evidence !== null) return evidence
  }
  return null
}

export const detectReactNavigation = (ctx: ProjectContext): DetectResult => {
  if (!appliesTo(ctx)) return NO_DETECTION
  const evidence = factoryEvidenceOf(ctx)
  return evidence === null ? NO_DETECTION : { score: DETECT_SCORE_DATA_ROUTER, evidence: [evidence] }
}

const isNamed = (registration: Registration): registration is Named => registration.name !== null

const registrationOrder = thenBy<Registration>(
  by((registration) => registration.file),
  (a, b) => a.line - b.line,
)

const groupByName = (registrations: readonly Named[]): ReadonlyMap<string, readonly Named[]> => {
  const groups = new Map<string, Named[]>()
  for (const registration of [...registrations].sort(registrationOrder))
    groups.set(registration.name, [...(groups.get(registration.name) ?? []), registration])
  return new Map(sortBy([...groups], ([name]) => name))
}

const mergePaths = (maps: readonly PathMap[]): PathMap => {
  const merged = new Map<string, readonly string[]>()
  for (const map of maps)
    for (const [name, paths] of map) merged.set(name, stableUnique([...(merged.get(name) ?? []), ...paths]))
  return merged
}

const toUrl = (raw: string): string => convertReactRouterPath(raw.startsWith("/") ? raw : `/${raw}`).url

const staticNavigationLocals = (text: string): ReadonlySet<string> =>
  new Set([...text.matchAll(STATIC_NAVIGATION_LOCAL)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])))

const linkingNodesIn = (ctx: DiscoverContext, file: string): readonly Located[] => {
  const text = ctx.readFile(file)
  const source = text === null || !text.includes(LINKING_ATTRIBUTE) ? null : ctx.sourceFile(file)
  if (text === null || source === null) return []
  const locals = staticNavigationLocals(text)
  return ctx.ast.jsxElementsIn(source).flatMap((element) => {
    const tag = ctx.ast.asIdentifier(element.tagName)?.text
    if (tag === undefined || (tag !== CONTAINER_TAG && !locals.has(tag))) return []
    const initializer = ctx.ast.attributeByName(element, LINKING_ATTRIBUTE)?.initializer
    if (initializer === undefined || !ctx.ts.isJsxExpression(initializer) || initializer.expression === undefined)
      return []
    return [{ file, node: initializer.expression }]
  })
}

const rootStaticNavigators = (
  navigators: readonly NavigatorRef[],
  registrations: readonly Registration[],
): readonly NavigatorRef[] => {
  const nested = new Set(registrations.flatMap((registration) => registration.nestedNavigator ?? []))
  return navigators.filter((navigator) => navigator.config !== null && !nested.has(navigator.id))
}

const registeredPaths = (registrations: readonly Named[]): PathMap =>
  mergePaths(
    registrations.flatMap((registration) =>
      registration.linkingPath === null ? [] : [new Map([[registration.name, [toUrl(registration.linkingPath)]]])],
    ),
  )

const withoutKnown = (paths: PathMap, known: PathMap): PathMap =>
  new Map([...paths].filter(([name]) => !known.has(name)))

const linkingTablesOf = (
  ctx: DiscoverContext,
  navigators: readonly NavigatorRef[],
  registrations: readonly Registration[],
): readonly LinkingTable[] => [
  ...appFiles(ctx)
    .flatMap((file) => linkingNodesIn(ctx, file))
    .map((located) => readLinking(ctx, located.file, located.node)),
  ...rootStaticNavigators(navigators, registrations).map((navigator) => readLinking(ctx, navigator.file, navigator.call)),
]

const pathsOf = (
  ctx: DiscoverContext,
  specs: readonly PathTableSpec[],
  navigators: readonly NavigatorRef[],
  registrations: readonly Named[],
): PathRead => {
  const tables = readPathTables(ctx, specs)
  const linking = linkingTablesOf(ctx, navigators, registrations)
  const declared = mergePaths([tables.paths, ...linking.map((table) => table.paths)])
  const explicit = mergePaths([declared, withoutKnown(registeredPaths(registrations), declared)])
  const names = sortedUnique(registrations.map((registration) => registration.name))
  const auto = linking.some((table) => table.auto) ? autoLinkingPaths(names, explicit) : new Map<string, string[]>()
  return {
    paths: mergePaths([explicit, auto]),
    unreadable: [...tables.unreadable, ...linking.flatMap((table) => table.unreadable)],
  }
}

const urlOwnersOf = (paths: PathMap, groups: ReadonlyMap<string, readonly Named[]>): ReadonlyMap<string, string> => {
  const claims = new Map<string, Claim[]>()
  for (const [name, registrations] of groups) {
    const file = registrations[0]?.file ?? ""
    for (const url of paths.get(name) ?? []) claims.set(url, [...(claims.get(url) ?? []), { name, file, routeNames: [name] }])
  }
  return new Map(
    [...claims].flatMap(([url, candidates]) => {
      const owner = sharedRouteWinner(candidates)
      return owner === null ? [] : [[url, owner.name] as const]
    }),
  )
}

const urlActivationOf = (url: string): Activation => ({
  kind: "url",
  template: url,
  params: paramsOf(url),
})

const routeActivationsOf = (name: string, registrations: readonly Named[]): readonly Activation[] =>
  sortedUnique(registrations.map((registration) => registration.navigator)).map((navigator) => ({
    kind: "route",
    name,
    navigator,
  }))

const entryKeyOf = (ctx: DiscoverContext, entry: EntryRef): string => {
  if (entry.kind === "file") return `file:${entry.file}#${entry.exportName}`
  if (entry.kind === "opaque") return `opaque:${entry.expr}`
  if (entry.kind === "module") return `module:${entry.from}|${entry.spec}#${entry.exported ?? "default"}`
  const binding = ctx.bindingsFor(entry.from).get(entry.local) ?? null
  if (binding?.kind === "import" && binding.file !== null) return `file:${binding.file}#${binding.imported}`
  if (binding?.kind === "import") return `module:${binding.module}#${binding.imported}`
  return `file:${entry.from}#${entry.local}`
}

type Keyed = { readonly key: string; readonly entry: EntryRef; readonly file: string }

const ENTRY_KEY_KIND = /^(?:file|module):/

const distinctEntriesOf = (ctx: DiscoverContext, registrations: readonly Named[]): readonly Keyed[] => {
  const keyed = registrations.flatMap((registration) =>
    registration.entry === null
      ? []
      : [{ key: entryKeyOf(ctx, registration.entry), entry: registration.entry, file: registration.file }],
  )
  return keyed.filter((candidate, index) => keyed.findIndex((other) => other.key === candidate.key) === index)
}

const verdictOf = (registration: Registration, rules: NativeAuthRules): NativeAuthVerdict =>
  authFromOptions(registration.optionKeys, rules) ??
  (registration.guardExpr === null ? null : authFromGuard(registration.guardExpr, rules))

const authOf = (registrations: readonly Named[], rules: NativeAuthRules): NativeAuthVerdict => {
  const verdicts = [
    ...new Set(registrations.flatMap((registration) => verdictOf(registration, rules) ?? [])),
  ]
  return verdicts.length === 1 ? (verdicts[0] ?? null) : null
}

const optionText = (registration: Registration, rules: NativeAuthRules): string =>
  rules.authOptionKeys
    .flatMap((key) => {
      const value = registration.optionKeys[key]
      return value === undefined ? [] : [` options.${key}=${String(value)}`]
    })
    .join("")

const registrationEvidence = (ctx: DiscoverContext, registration: Named, rules: NativeAuthRules): Evidence => {
  const nested = registration.nestedNavigator === null ? "" : ` nests navigator ${registration.nestedNavigator}`
  const guard = registration.guardExpr === null ? "" : ` if ${registration.guardExpr}`
  return ctx.evidence(
    `react-navigation screen '${registration.name}' in navigator ${registration.navigator}${nested}${guard}${optionText(registration, rules)}`,
    registration.file,
    registration.node,
  )
}

const reportAmbiguous = (ctx: DiscoverContext, name: string, entries: readonly Keyed[]): void => {
  if (entries.length < 2) return
  const components = sortedUnique(entries.map((entry) => entry.key.replace(ENTRY_KEY_KIND, "").replace(`${ctx.root}/`, "")))
  const files = sortedUnique(entries.map((entry) => entry.file))
  ctx.diagnostic({
    severity: "warning",
    code: "screens/ambiguous-route-name",
    message: `React Navigation route name '${name}' is registered with ${String(entries.length)} different components (${components.map((component) => `'${component}'`).join(", ")}) in ${files.map((file) => `'${file}'`).join(", ")}; one screen keeps every entry`,
    file: files[0] ?? "",
  })
}

const reportSharedUrls = (
  ctx: DiscoverContext,
  name: string,
  file: string,
  lost: readonly string[],
  owners: ReadonlyMap<string, string>,
): void => {
  for (const url of lost)
    ctx.diagnostic({
      severity: "info",
      code: "screens/shared-route",
      message: `React Navigation route '${name}' declares '${url}', which '${owners.get(url) ?? ""}' owns; '${name}' does not get that URL and stays addressable by its route name`,
      file,
    })
}

type DraftEnv = {
  readonly ctx: DiscoverContext
  readonly paths: PathMap
  readonly owners: ReadonlyMap<string, string>
  readonly rules: NativeAuthRules
}

const firstFileOf = (registrations: readonly Named[]): string =>
  sortStrings(registrations.map((registration) => registration.file))[0] ?? ""

const draftOf = (env: DraftEnv, name: string, registrations: readonly Named[]): ScreenDraft => {
  const { ctx, rules } = env
  const owned = (env.paths.get(name) ?? []).filter((url) => env.owners.get(url) === name)
  const auth = authOf(registrations, rules)
  return {
    localId: [firstFileOf(registrations), ROUTE_ID_MARKER, name].join(""),
    activations: [...owned.map(urlActivationOf), ...routeActivationsOf(name, registrations)],
    entries: distinctEntriesOf(ctx, registrations).map((entry) => entry.entry),
    evidence: registrations.map((registration) => registrationEvidence(ctx, registration, rules)),
    ...(auth === null ? {} : { auth }),
  }
}

const reportName = (env: DraftEnv, name: string, registrations: readonly Named[]): void => {
  reportAmbiguous(env.ctx, name, distinctEntriesOf(env.ctx, registrations))
  reportSharedUrls(
    env.ctx,
    name,
    firstFileOf(registrations),
    (env.paths.get(name) ?? []).filter((url) => env.owners.get(url) !== name),
    env.owners,
  )
}

const siteOrder = thenBy<UnreadableItem>(
  by((item) => item.file),
  (a, b) => a.line - b.line,
)

const siteListOf = (sites: readonly { readonly file: string; readonly line: number }[]): string => {
  const listed = sites.slice(0, UNREADABLE_SITE_LIMIT).map((site) => `${site.file}:${String(site.line)}`)
  const rest = sites.length - UNREADABLE_SITE_LIMIT
  return `${listed.join(", ")}${rest > 0 ? ` and ${String(rest)} more` : ""}`
}

const reportUnreadable = (ctx: DiscoverContext, unreadable: readonly UnreadableItem[]): void => {
  const sites = [...unreadable].sort(siteOrder)
  const first = sites[0]
  if (first === undefined) return
  ctx.diagnostic({
    severity: "warning",
    code: "screens/path-table-unreadable",
    message: `${String(sites.length)} React Navigation path entr${sites.length === 1 ? "y" : "ies"} could not be read statically, so their screens get no URL from them: ${siteListOf(sites)}.`,
    file: first.file,
  })
}

const reportDynamicNames = (ctx: DiscoverContext, registrations: readonly Registration[]): void => {
  const sites = registrations.filter((registration) => registration.name === null).sort(registrationOrder)
  const first = sites[0]
  if (first === undefined) return
  ctx.diagnostic({
    severity: "info",
    code: "screens/dynamic-registry",
    message: `${String(sites.length)} React Navigation screen registration(s) have a non-literal name and are not mapped: ${siteListOf(sites)}`,
    file: first.file,
  })
}

const discoverReactNavigation = (ctx: DiscoverContext, specs: readonly PathTableSpec[], rules: NativeAuthRules) => {
  if (!appliesTo(ctx)) return []
  const { registrations, navigators } = readRegistrations(ctx)
  reportDynamicNames(ctx, registrations)
  const named = registrations.filter(isNamed)
  if (named.length === 0) return []
  const groups = groupByName(named)
  const read = pathsOf(ctx, specs, navigators, named)
  reportUnreadable(ctx, read.unreadable)
  const env: DraftEnv = { ctx, paths: read.paths, owners: urlOwnersOf(read.paths, groups), rules }
  for (const [name, group] of groups) reportName(env, name, group)
  return sortBy(
    [...groups].map(([name, group]) => draftOf(env, name, group)),
    (draft) => draft.localId,
  )
}

export const createReactNavigationSource = (options: ReactNavigationOptions = {}): ScreenSource => {
  const rules = options.authRules ?? resolveNativeAuthRules({})
  const specs = options.pathTables ?? []
  return {
    name: REACT_NAVIGATION_SOURCE,
    detect: detectReactNavigation,
    discover: (ctx) => discoverReactNavigation(ctx, specs, rules),
  }
}

export const createReactNavigationAdapter = (options: ReactNavigationOptions = {}): Adapter => ({
  name: REACT_NAVIGATION_SOURCE,
  screens: [createReactNavigationSource(options)],
})
