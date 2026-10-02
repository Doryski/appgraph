import * as path from "node:path"
import type ts from "typescript"
import { walk } from "../core/ast.js"
import type { AncestorRef, Evidence, SpliceMode } from "../core/model.js"
import { stableUnique, uniqueBy } from "../core/order.js"
import { EXCLUDED_FILE, NON_APP_PATH } from "../core/project.js"
import { SCRIPT_GLOB } from "../core/extensions.js"
import { convertVueRouterPath, joinUrl, paramsOf } from "../core/url.js"
import { createValueResolver } from "./array-values.js"
import { DEV_GUARD } from "./route-conditions.js"
import type {
  Adapter,
  AmbientComponent,
  DetectResult,
  DiscoverContext,
  EntryRef,
  ProjectContext,
  ScreenDraft,
  ScreenSource,
  TsNode,
} from "./types.js"
import { importedBindingOf } from "./values.js"
import { type VueAuthRules, type VueAuthVerdict, authOf, resolveVueAuthRules } from "./vue-auth.js"
import { type RouteNode, readRoutes } from "./vue-route-records.js"
import {
  UNPLUGIN_DEPENDENCY,
  fileRouteTrigger,
  importsAutoRoutes,
  readFileRoutes,
  referencesAutoRoutes,
} from "./vue-router-files.js"
import type { UnreadableItem } from "./array-values.js"

export const SOURCE_NAME = "vue-router"

const ROUTER_MODULE = "vue-router"

const VUE_MODULE = "vue"

const NUXT_DEPENDENCY = "nuxt"

const ROUTER_FACTORY = "createRouter"

const APP_FACTORY = "createApp"

const ROUTES_KEY = "routes"

const COMPONENT_METHOD = "component"

const DETECT_SCORE_DATA_ROUTER = 90

const DETECT_SCORE_FILE_ROUTES = 100

const ROUTER_CALL = /\bcreateRouter\s*\(/

const ROUTER_IMPORT = /\bfrom\s*["']vue-router["']/

const ROUTES_MENTION = /\broutes\b/

const APP_CALL = /\bcreateApp\s*\(/

const ADD_ROUTE_CALL = /\.addRoute\s*\(/g

const GLOBAL_GUARD_CALL = /\.beforeEach\s*\(/

const MAX_SITES = 5

const ROUTER_VIEW_TAG = "RouterView"

const NO_DETECTION: DetectResult = { score: 0, evidence: [] }

const HTML_ENTRY_GLOB = "**/index.html"

const SCRIPT_TAG = /<script\b[^>]*>/gi

const MODULE_TYPE = /\btype\s*=\s*["']module["']/i

const SCRIPT_SRC = /\bsrc\s*=\s*["']([^"']+)["']/i

const EXTERNAL_SRC = /^(?:[a-z]+:)?\/\//i

const PUBLIC_DIR = "public"

const USE_METHOD = "use"

const RENDER_KEY = "render"

const RENDER_HELPER = "h"

const NAMESPACE_IMPORT = "*"

export type VueRouterOptions = {
  readonly authRules?: VueAuthRules
}

type Site = { readonly file: string; readonly line: number }

type ComponentTarget = { readonly file: string; readonly exportName: string }

type RouterCall = {
  readonly file: string
  readonly call: ts.CallExpression
  readonly guarded: boolean
  readonly auto: boolean
}

type RouterTable = {
  readonly file: string
  readonly routes: readonly RouteNode[]
  readonly unreadable: readonly UnreadableItem[]
  readonly guarded: boolean
}

type Frame = {
  readonly url: string | null
  readonly raw: string
  readonly auth: VueAuthVerdict
  readonly ancestors: readonly AncestorRef[]
  readonly host: ComponentTarget | null
  readonly conditions: readonly string[]
  readonly guarded: boolean
  readonly notes: readonly string[]
}

type Visit = {
  readonly node: RouteNode
  readonly entries: readonly EntryRef[]
  readonly url: string
  readonly raw: string
  readonly parentUrl: string | null
  readonly ownsUrl: boolean
  readonly auth: VueAuthVerdict
  readonly ancestors: readonly AncestorRef[]
  readonly conditions: readonly string[]
  readonly guarded: boolean
  readonly notes: readonly string[]
}

type Placed = { readonly draft: ScreenDraft; readonly raw: string }

type RenderFunction = ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration

type AppCandidate = {
  readonly site: Site
  readonly target: ComponentTarget | null
  readonly entry: boolean
  readonly topLevel: boolean
  readonly usedFiles: readonly string[]
}

type RootChoice = {
  readonly host: ComponentTarget | null
  readonly candidates: readonly AppCandidate[]
  readonly notes: readonly string[]
}

const scriptSourcesOf = (html: string): readonly string[] =>
  [...html.matchAll(SCRIPT_TAG)].flatMap(([tag]) => {
    const src = MODULE_TYPE.test(tag) ? SCRIPT_SRC.exec(tag)?.[1] : undefined
    return src === undefined || EXTERNAL_SRC.test(src) ? [] : [src.split(/[?#]/)[0] ?? src]
  })

const scriptBasesOf = (htmlFile: string, src: string): readonly string[] => {
  const dir = path.posix.dirname(htmlFile)
  if (!src.startsWith("/")) return [dir]
  return path.posix.basename(dir) === PUBLIC_DIR ? [dir, path.posix.dirname(dir)] : [dir]
}

const htmlEntryFiles = (ctx: ProjectContext): readonly string[] =>
  stableUnique(
    ctx.glob(HTML_ENTRY_GLOB).flatMap((htmlFile) =>
      scriptSourcesOf(ctx.readFile(htmlFile) ?? "").flatMap((src) =>
        scriptBasesOf(htmlFile, src)
          .map((base) => path.posix.join(base, src.replace(/^\//, "")))
          .filter((file) => ctx.exists(file)),
      ),
    ),
  )

const narrowed = <T>(list: readonly T[], keep: (item: T) => boolean): readonly T[] => {
  const kept = list.filter(keep)
  return kept.length > 0 ? kept : list
}

const settled = (all: readonly AppCandidate[], using: readonly AppCandidate[]): readonly AppCandidate[] => {
  const topLevel = all.filter((candidate) => candidate.topLevel)
  if (using.length === 0) return topLevel.length > 0 ? topLevel : all
  if (topLevel.length === 0) return using
  return using.filter((candidate) => candidate.topLevel)
}

const targetKey = (target: ComponentTarget): string => `${target.file}|${target.exportName}`

const rootNotes = (candidates: readonly AppCandidate[]): readonly string[] =>
  candidates.length === 0
    ? []
    : [`no createApp root layout is asserted; candidate createApp call(s): ${siteList(candidates.map((candidate) => candidate.site))}`]

const chooseRoot = (
  candidates: readonly AppCandidate[],
  tableFile: string | null,
  tableFiles: readonly string[],
): RootChoice => {
  const usesThis = (candidate: AppCandidate): boolean => tableFile !== null && candidate.usedFiles.includes(tableFile)
  const usesOther = (candidate: AppCandidate): boolean =>
    candidate.usedFiles.some((file) => file !== tableFile && tableFiles.includes(file))
  const compatible = candidates.filter((candidate) => usesThis(candidate) || !usesOther(candidate))
  const ranked = narrowed(compatible, (candidate) => candidate.entry)
  const chosen = settled(ranked, ranked.filter(usesThis))
  const targets = chosen.map((candidate) => candidate.target)
  const distinct = uniqueBy(
    targets.flatMap((target) => target ?? []),
    targetKey,
  )
  const [host] = distinct
  if (host !== undefined && distinct.length === 1 && !targets.includes(null)) return { host, candidates: chosen, notes: [] }
  return { host: null, candidates: chosen, notes: rootNotes(chosen.length > 0 ? chosen : compatible) }
}

const routerViewSplice = (name: string | undefined): SpliceMode =>
  name === undefined ? { kind: "outlet", tag: ROUTER_VIEW_TAG } : { kind: "outlet", tag: ROUTER_VIEW_TAG, name }

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length

const isAppFile = (file: string): boolean => !NON_APP_PATH.test(file) && !EXCLUDED_FILE.test(file)

const appFiles = (ctx: ProjectContext): readonly string[] =>
  ctx.glob(SCRIPT_GLOB).filter((file) => isAppFile(file) && !ctx.isGenerated(file))

const filesMatching = (ctx: ProjectContext, test: (text: string) => boolean): readonly string[] =>
  appFiles(ctx).filter((file) => {
    const text = ctx.readFile(file)
    return text !== null && test(text)
  })

const isRouterText = (text: string): boolean =>
  ROUTER_CALL.test(text) && ROUTER_IMPORT.test(text) && ROUTES_MENTION.test(text)

const routerEvidence = (ctx: ProjectContext, file: string): Evidence => {
  const text = ctx.readFile(file) ?? ""
  return { what: "createRouter call from vue-router", file, line: lineAt(text, ROUTER_CALL.exec(text)?.index ?? 0) }
}

const isVueRouterProject = (ctx: ProjectContext): boolean =>
  (ctx.hasDependency(ROUTER_MODULE) || ctx.hasDependency(UNPLUGIN_DEPENDENCY)) && !ctx.hasDependency(NUXT_DEPENDENCY)

const fileRoutesSite = (ctx: ProjectContext, routerFiles: readonly string[]): string | null => {
  const trigger = fileRouteTrigger(ctx, appFiles(ctx))
  if (trigger === null) return null
  const usesAuto = routerFiles.some((file) => importsAutoRoutes(ctx.readFile(file) ?? ""))
  return routerFiles.length === 0 || usesAuto ? trigger : null
}

const fileRoutesDetection = (trigger: string): DetectResult => ({
  score: DETECT_SCORE_FILE_ROUTES,
  evidence: [{ what: "vue-router file-based routes (unplugin-vue-router / vue-router/auto-routes)", file: trigger, line: 1 }],
})

export const detectVueRouter = (ctx: ProjectContext): DetectResult => {
  if (!isVueRouterProject(ctx)) return NO_DETECTION
  const files = filesMatching(ctx, isRouterText)
  const trigger = fileRoutesSite(ctx, files)
  if (trigger !== null) return fileRoutesDetection(trigger)
  if (files.length === 0) return NO_DETECTION
  return {
    score: DETECT_SCORE_DATA_ROUTER,
    evidence: [
      { what: "vue-router dependency", file: "package.json", line: 1 },
      ...files.map((file) => routerEvidence(ctx, file)),
    ],
  }
}

const sitesOf = (ctx: ProjectContext, pattern: RegExp): readonly Site[] =>
  appFiles(ctx).flatMap((file) => {
    const text = ctx.readFile(file) ?? ""
    return [...text.matchAll(pattern)].map((match) => ({ file, line: lineAt(text, match.index) }))
  })

const siteList = (sites: readonly Site[]): string =>
  sites
    .slice(0, MAX_SITES)
    .map((site) => `${site.file}:${String(site.line)}`)
    .join(", ")

const isCallOf = (ctx: DiscoverContext, file: string, node: TsNode, module: string, name: string): boolean => {
  const call = ctx.ast.asCallExpression(node)
  const callee = call === null ? null : ctx.ast.asIdentifier(call.expression)
  if (callee === null) return false
  const imported = importedBindingOf(ctx.bindingsFor(file).get(callee.text))
  return imported !== null && imported.module === module && imported.imported === name
}

const callsOf = (ctx: DiscoverContext, file: string, module: string, name: string): readonly ts.CallExpression[] => {
  const source = ctx.sourceFile(file)
  if (source === null) return []
  const found: ts.CallExpression[] = []
  walk(source, (node) => {
    const call = ctx.ast.asCallExpression(node)
    if (call !== null && isCallOf(ctx, file, node, module, name)) found.push(call)
  })
  return found
}

const keyOf = (ctx: DiscoverContext, name: ts.PropertyName): string | null =>
  ctx.ast.asIdentifier(name)?.text ?? ctx.ast.asStringLiteralLike(name)?.text ?? null

const memberValue = (ctx: DiscoverContext, object: ts.ObjectLiteralExpression, key: string): TsNode | null => {
  for (const member of object.properties) {
    if (ctx.ts.isSpreadAssignment(member) || keyOf(ctx, member.name) !== key) continue
    if (ctx.ts.isPropertyAssignment(member)) return member.initializer
    if (ctx.ts.isShorthandPropertyAssignment(member)) return member.name
  }
  return null
}

const createDiscovery = (ctx: DiscoverContext, rules: VueAuthRules) => {
  const resolver = createValueResolver(ctx)

  const objectOf = (node: TsNode | undefined, file: string): { object: ts.ObjectLiteralExpression; file: string } | null => {
    if (node === undefined) return null
    const inner = ctx.unwrap(node)
    const identifier = ctx.ast.asIdentifier(inner)
    const located = identifier === null ? { node: inner, file } : resolver.valueOf(identifier, file)
    const object = located === null ? null : ctx.ast.asObjectLiteral(ctx.unwrap(located.node))
    return object === null || located === null ? null : { object, file: located.file }
  }

  const reportDynamic = (file: string, call: ts.CallExpression): void =>
    ctx.diagnostic({
      severity: "warning",
      code: "screens/dynamic-registry",
      message: `${ROUTER_FACTORY}(...) has no literal 'routes' option this source can read`,
      file,
      line: ctx.lineOf(file, call),
    })

  const tableOf = (file: string, call: ts.CallExpression, guarded: boolean): RouterTable | null => {
    const options = objectOf(call.arguments[0], file)
    const routes = options === null ? null : memberValue(ctx, options.object, ROUTES_KEY)
    if (options === null || routes === null) {
      reportDynamic(file, call)
      return null
    }
    const records = readRoutes(ctx, options.file, routes)
    return { file, routes: records.routes, unreadable: records.unreadable, guarded }
  }

  const usesAutoRoutes = (file: string, call: ts.CallExpression): boolean => {
    const options = objectOf(call.arguments[0], file)
    const routes = options === null ? null : memberValue(ctx, options.object, ROUTES_KEY)
    return options !== null && routes !== null && referencesAutoRoutes(ctx, options.file, routes)
  }

  const routerCalls = (files: readonly string[]): readonly RouterCall[] =>
    files.flatMap((file) => {
      const guarded = GLOBAL_GUARD_CALL.test(ctx.readFile(file) ?? "")
      return callsOf(ctx, file, ROUTER_MODULE, ROUTER_FACTORY).map((call) => ({
        file,
        call,
        guarded,
        auto: usesAutoRoutes(file, call),
      }))
    })

  const routerTables = (calls: readonly RouterCall[]): readonly RouterTable[] =>
    calls.flatMap((entry) => (entry.auto ? [] : (tableOf(entry.file, entry.call, entry.guarded) ?? [])))

  const bindingTarget = (from: string, local: string): ComponentTarget | null => {
    const binding = ctx.bindingsFor(from).get(local)
    if (binding === null || (binding.kind !== "import" && binding.kind !== "dynamic-import")) return null
    if (binding.file === null) return null
    return ctx.declaredExport(binding.file, binding.imported)
  }

  const entryTarget = (entry: EntryRef): ComponentTarget | null => {
    if (entry.kind === "file") return { file: entry.file, exportName: entry.exportName }
    if (entry.kind === "binding") return bindingTarget(entry.from, entry.local)
    return null
  }

  const componentTargetOf = (node: TsNode | undefined, file: string): ComponentTarget | null => {
    const identifier = node === undefined ? null : ctx.ast.asIdentifier(ctx.unwrap(node))
    return identifier === null ? null : bindingTarget(file, identifier.text)
  }

  const outletOf = (target: ComponentTarget, child: RouteNode): AncestorRef => ({
    ...target,
    splice: routerViewSplice(child.outletName),
    role: "layout",
  })

  const ancestorsUnder = (parent: Frame, child: RouteNode): readonly AncestorRef[] =>
    parent.host === null
      ? parent.ancestors
      : uniqueBy([...parent.ancestors, outletOf(parent.host, child)], (ref) => `${ref.file}|${ref.exportName}`)

  const isRouterViewEntry = (entry: EntryRef): boolean => {
    if (entry.kind !== "binding") return false
    const imported = importedBindingOf(ctx.bindingsFor(entry.from).get(entry.local))
    return imported !== null && imported.module === ROUTER_MODULE
  }

  const entriesOf = (node: RouteNode): readonly EntryRef[] => node.entries.filter((entry) => !isRouterViewEntry(entry))

  const recordHost = (node: RouteNode): ComponentTarget | null => {
    if (node.children.length === 0) return null
    return entriesOf(node).map(entryTarget).find((found) => found !== null) ?? null
  }

  const renderFunctionOf = (object: ts.ObjectLiteralExpression): RenderFunction | null => {
    for (const member of object.properties) {
      if (ctx.ts.isSpreadAssignment(member) || keyOf(ctx, member.name) !== RENDER_KEY) continue
      if (ctx.ts.isMethodDeclaration(member)) return member
      if (!ctx.ts.isPropertyAssignment(member)) return null
      const value = ctx.unwrap(member.initializer)
      return ctx.ts.isArrowFunction(value) || ctx.ts.isFunctionExpression(value) ? value : null
    }
    return null
  }

  const returnedOf = (body: ts.ConciseBody | undefined): TsNode | null => {
    if (body === undefined) return null
    if (!ctx.ts.isBlock(body)) return body
    return body.statements.find(ctx.ts.isReturnStatement)?.expression ?? null
  }

  const isRenderHelper = (callee: ts.Identifier, render: RenderFunction, file: string): boolean => {
    if (ctx.ast.asIdentifier(render.parameters[0]?.name)?.text === callee.text) return true
    const imported = importedBindingOf(ctx.bindingsFor(file).get(callee.text))
    return imported !== null && imported.module === VUE_MODULE && imported.imported === RENDER_HELPER
  }

  const renderTargetOf = (object: ts.ObjectLiteralExpression, file: string): ComponentTarget | null => {
    const render = renderFunctionOf(object)
    const call = render === null ? null : ctx.ast.asCallExpression(returnedOf(render.body) ?? undefined)
    const callee = call === null ? null : ctx.ast.asIdentifier(call.expression)
    if (render === null || call === null || callee === null || !isRenderHelper(callee, render, file)) return null
    return componentTargetOf(call.arguments[0], file)
  }

  const appTargetOf = (node: TsNode | undefined, file: string): ComponentTarget | null => {
    const object = ctx.ast.asObjectLiteral(node)
    return object === null ? componentTargetOf(node, file) : renderTargetOf(object, file)
  }

  const isTopLevel = (node: TsNode): boolean => {
    for (let current = node.parent; !ctx.ts.isSourceFile(current); current = current.parent)
      if (ctx.ts.isFunctionLike(current)) return false
    return true
  }

  const receiverRoot = (node: TsNode): TsNode => {
    const call = ctx.ast.asCallExpression(node)
    const access = call === null ? null : ctx.ast.asPropertyAccess(call.expression)
    return access === null ? ctx.unwrap(node) : receiverRoot(access.expression)
  }

  const chainTopOf = (node: TsNode): TsNode => {
    const access = ctx.ast.asPropertyAccess(node.parent)
    const call = access === null ? null : ctx.ast.asCallExpression(access.parent)
    return access === null || call === null || call.expression !== access ? node : chainTopOf(call)
  }

  const appVariableOf = (call: ts.CallExpression): string | null => {
    const declaration = chainTopOf(call).parent
    if (!ctx.ts.isVariableDeclaration(declaration)) return null
    return ctx.ast.asIdentifier(declaration.name)?.text ?? null
  }

  const routerFileOf = (node: TsNode | undefined, file: string): string | null => {
    if (node === undefined) return null
    if (isCallOf(ctx, file, node, ROUTER_MODULE, ROUTER_FACTORY)) return file
    const identifier = ctx.ast.asIdentifier(node)
    const binding = identifier === null ? null : ctx.bindingsFor(file).get(identifier.text)
    if (binding === null) return null
    if (binding.kind === "local" || binding.kind === "hook-result") return file
    if (binding.file === null || binding.imported === NAMESPACE_IMPORT) return binding.file
    return ctx.declaredExport(binding.file, binding.imported).file
  }

  const usedFilesOf = (file: string, app: ts.CallExpression): readonly string[] => {
    const source = ctx.sourceFile(file)
    if (source === null) return []
    const variable = appVariableOf(app)
    const ownsReceiver = (root: TsNode): boolean =>
      root === app || (variable !== null && ctx.ast.asIdentifier(root)?.text === variable)
    const found: string[] = []
    walk(source, (node) => {
      const call = ctx.ast.asCallExpression(node)
      const access = call === null ? null : ctx.ast.asPropertyAccess(call.expression)
      if (call === null || access === null || access.name.text !== USE_METHOD) return
      if (!ownsReceiver(receiverRoot(access.expression))) return
      const used = routerFileOf(call.arguments[0], file)
      if (used !== null) found.push(used)
    })
    return stableUnique(found)
  }

  const appCandidates = (): readonly AppCandidate[] => {
    const entries = new Set(htmlEntryFiles(ctx))
    return filesMatching(ctx, (text) => APP_CALL.test(text)).flatMap((file) =>
      callsOf(ctx, file, VUE_MODULE, APP_FACTORY).map((call) => ({
        site: { file, line: ctx.lineOf(file, call) },
        target: appTargetOf(call.arguments[0], file),
        entry: entries.has(file),
        topLevel: isTopLevel(call),
        usedFiles: usedFilesOf(file, call),
      })),
    )
  }

  const rootChoices = new Map<string, RootChoice>()

  const rootFor = (tableFile: string | null, tableFiles: readonly string[]): RootChoice => {
    const key = tableFile ?? ""
    const cached = rootChoices.get(key)
    if (cached !== undefined) return cached
    const choice = chooseRoot(appCandidates(), tableFile, tableFiles)
    rootChoices.set(key, choice)
    return choice
  }

  const ambientIn = (file: string): readonly AmbientComponent[] => {
    const source = ctx.sourceFile(file)
    if (source === null) return []
    const found: AmbientComponent[] = []
    walk(source, (node) => {
      const call = ctx.ast.asCallExpression(node)
      const access = call === null ? null : ctx.ast.asPropertyAccess(call.expression)
      if (call === null || access === null || access.name.text !== COMPONENT_METHOD) return
      const name = ctx.ast.asStringLiteralLike(call.arguments[0])
      const target = componentTargetOf(call.arguments[1], file)
      if (name !== null && target !== null) found.push({ name: name.text, file: target.file })
    })
    return found
  }

  const ambientComponents = (): readonly AmbientComponent[] => {
    const routerFiles = filesMatching(ctx, isRouterText)
    const tableFiles = routerFiles.length === 0 ? [null] : routerFiles
    const files = stableUnique(
      tableFiles.flatMap((file) => rootFor(file, routerFiles).candidates.map((candidate) => candidate.site.file)),
    )
    return uniqueBy(
      files.flatMap((file) => ambientIn(file)),
      (component) => `${component.name}|${component.file}`,
    )
  }

  return { routerCalls, routerTables, rootFor, recordHost, ancestorsUnder, entriesOf, ambientComponents, rules }
}

type Discovery = ReturnType<typeof createDiscovery>

const urlOf = (parent: string | null, path: string): string =>
  joinUrl(parent, convertVueRouterPath(path).url) ?? "/"

const rawOf = (parent: string, path: string): string => (path.startsWith("/") ? path : `${parent}/${path}`)

const ownsUrl = (node: RouteNode, url: string): boolean =>
  !node.children.some((child) => child.path !== null && urlOf(url, child.path) === url)

const reportUnreadable = (ctx: DiscoverContext, item: UnreadableItem): void =>
  ctx.diagnostic({
    severity: "warning",
    code: "screens/unsupported-router-style",
    message: `route item {${item.text}} is not a route record this source can read; it and its children are not discovered`,
    file: item.file,
    line: item.line,
  })

const reportUnreadablePath = (ctx: DiscoverContext, node: RouteNode): void =>
  ctx.diagnostic({
    severity: "warning",
    code: "screens/unsupported-router-style",
    message: "route path is not a string this source can read; the route and its children are not discovered",
    file: node.file,
    line: node.line,
  })

const visitTree = (ctx: DiscoverContext, discovery: Discovery) => {
  const visitNode = (node: RouteNode, parent: Frame): readonly Visit[] => {
    node.unreadableChildren.forEach((item) => {
      reportUnreadable(ctx, item)
    })
    if (node.path === null) {
      reportUnreadablePath(ctx, node)
      return []
    }
    const url = urlOf(parent.url, node.path)
    const raw = rawOf(parent.raw, node.path)
    const auth = authOf(node.authSignals, discovery.rules) ?? parent.auth
    const conditions = [...parent.conditions, ...node.conditions]
    const visit: Visit = {
      node,
      entries: discovery.entriesOf(node),
      url,
      raw,
      parentUrl: parent.url,
      ownsUrl: ownsUrl(node, url),
      auth,
      ancestors: discovery.ancestorsUnder(parent, node),
      conditions,
      guarded: parent.guarded,
      notes: parent.notes,
    }
    const frame: Frame = {
      ...parent,
      url,
      raw,
      auth,
      conditions,
      ancestors: visit.ancestors,
      host: discovery.recordHost(node),
    }
    return [visit, ...node.children.flatMap((child) => visitNode(child, frame))]
  }
  return visitNode
}

const nameTableOf = (visits: readonly Visit[]): ReadonlyMap<string, string> => {
  const table = new Map<string, string>()
  for (const visit of visits)
    if (visit.node.name !== null && !table.has(visit.node.name)) table.set(visit.node.name, visit.url)
  return table
}

type RedirectRead = { readonly to: string | null; readonly evidence: readonly string[] }

const redirectOf = (visit: Visit, names: ReadonlyMap<string, string>): RedirectRead => {
  const redirect = visit.node.redirect
  if (redirect === null) return { to: null, evidence: [] }
  if (!visit.ownsUrl) return { to: null, evidence: ["redirect is shadowed by the empty-path child route at this url"] }
  if (redirect.kind === "path") return { to: urlOf(visit.parentUrl, redirect.value), evidence: [] }
  if (redirect.kind === "function") return { to: null, evidence: ["redirect is a function; its target is decided at runtime"] }
  if (redirect.kind === "opaque") return { to: null, evidence: [`redirect target {${redirect.text}} is not readable`] }
  const target = names.get(redirect.value) ?? null
  if (target !== null) return { to: target, evidence: [`redirect to route name '${redirect.value}'`] }
  return { to: null, evidence: [`redirect to route name '${redirect.value}', which no route of this router declares`] }
}

const evidenceTexts = (visit: Visit, redirect: RedirectRead): readonly string[] => [
  "vue-router route record",
  ...(visit.node.name === null ? [] : [`route name '${visit.node.name}'`]),
  ...visit.conditions.map((condition) => `registered only when ${condition}`),
  ...visit.node.entryConditions.map((condition) => `component chosen at runtime by ${condition}`),
  ...(visit.node.inlineComponents ?? []).map((site) => `inline component definition at ${site.file}:${String(site.line)}`),
  ...(visit.entries.length < visit.node.entries.length ? ["component is a bare RouterView; children render in the parent's outlet"] : []),
  ...(visit.node.hasBeforeEnter ? ["per-route beforeEnter guard; evidence only, not asserted as protection"] : []),
  ...(visit.auth === null && visit.guarded
    ? ["a global router.beforeEach guard decides access at runtime; auth is not asserted"]
    : []),
  ...redirect.evidence,
  ...visit.notes,
]

const kindTagOf = (visit: Visit, redirectTo: string | null): string | null => {
  if (visit.entries.length > 0 || redirectTo !== null) return null
  return visit.node.children.length > 0 ? "layout" : "entryless"
}

const draftOf = (ctx: DiscoverContext, visit: Visit, localId: string, names: ReadonlyMap<string, string>): ScreenDraft => {
  const redirect = redirectOf(visit, names)
  const kindTag = kindTagOf(visit, redirect.to)
  const url = visit.ownsUrl ? visit.url : null
  const { node } = visit
  return {
    localId,
    activations: url === null ? [] : [{ kind: "url", template: url, params: [...paramsOf(url)] }],
    entries: visit.entries,
    auth: visit.auth,
    evidence: evidenceTexts(visit, redirect).map((what) => ({ what, file: node.file, line: node.line })),
    ...(visit.ancestors.length === 0 ? {} : { ancestors: visit.ancestors }),
    ...(kindTag === null ? {} : { kindTag }),
    ...(redirect.to === null ? {} : { redirectTo: ctx.normalizeUrl(redirect.to) }),
    ...(node.name === null ? {} : { routeName: node.name }),
    ...(visit.conditions.some((condition) => DEV_GUARD.test(condition)) ? { devOnly: true } : {}),
  }
}

const entryKey = (entry: EntryRef): string => JSON.stringify(entry)

const draftRouteNames = (draft: ScreenDraft): readonly string[] => [
  ...(draft.routeName === undefined ? [] : [draft.routeName]),
  ...(draft.routeNameAliases ?? []),
]

const routeNameFields = (kept: ScreenDraft, other: ScreenDraft) => {
  const [routeName, ...aliases] = stableUnique([...draftRouteNames(kept), ...draftRouteNames(other)])
  if (routeName === undefined) return {}
  return aliases.length === 0 ? { routeName } : { routeName, routeNameAliases: aliases }
}

const mergeDrafts = (kept: ScreenDraft, other: ScreenDraft): ScreenDraft => {
  const entries = uniqueBy([...kept.entries, ...other.entries], entryKey)
  const { kindTag, auth, ...rest } = kept
  const redirectTo = kept.redirectTo ?? other.redirectTo ?? null
  return {
    ...rest,
    entries,
    auth: auth === other.auth ? (auth ?? null) : null,
    evidence: [...kept.evidence, ...other.evidence],
    ...routeNameFields(kept, other),
    ...(entries.length === 0 && redirectTo === null && kindTag !== undefined ? { kindTag } : {}),
    ...(redirectTo === null ? {} : { redirectTo }),
  }
}

const urlOfDraft = (draft: ScreenDraft): string | null =>
  draft.activations.find((activation) => activation.kind === "url")?.template ?? null

const reportShadowed = (ctx: DiscoverContext, visit: Visit, kept: ScreenDraft): void =>
  ctx.diagnostic({
    severity: "warning",
    code: "screens/conflict-dropped",
    message: `route '${visit.raw}' is declared again; vue-router matches the first declaration (${kept.localId}), so this one is never reached`,
    file: visit.node.file,
    line: visit.node.line,
  })

const placeDrafts = (ctx: DiscoverContext, visits: readonly Visit[], drafts: readonly ScreenDraft[]): readonly ScreenDraft[] => {
  const placed: Placed[] = []
  const byUrl = new Map<string, number>()
  visits.forEach((visit, index) => {
    const draft = drafts[index]
    if (draft === undefined) return
    const url = urlOfDraft(draft)
    const at = url === null ? undefined : byUrl.get(url)
    const kept = at === undefined ? undefined : placed[at]
    if (at === undefined || kept === undefined) {
      if (url !== null) byUrl.set(url, placed.length)
      placed.push({ draft, raw: visit.raw })
      return
    }
    if (kept.raw === visit.raw) {
      reportShadowed(ctx, visit, kept.draft)
      return
    }
    placed[at] = { draft: mergeDrafts(kept.draft, draft), raw: kept.raw }
  })
  return placed.map((entry) => entry.draft)
}

const localIdsOf = (ctx: DiscoverContext, visits: readonly Visit[]): readonly string[] => {
  const ordinals = new Map<string, number>()
  return visits.map((visit) => {
    const ordinal = ordinals.get(visit.node.file) ?? 0
    ordinals.set(visit.node.file, ordinal + 1)
    return ctx.localId(visit.node.file, { ordinal })
  })
}

const reportAliases = (ctx: DiscoverContext, visits: readonly Visit[]): void => {
  const aliased = visits.filter((visit) => visit.node.alias.length > 0)
  if (aliased.length === 0) return
  const count = aliased.reduce((sum, visit) => sum + visit.node.alias.length, 0)
  ctx.diagnostic({
    severity: "info",
    code: "screens/unsupported-router-style",
    message: `${String(count)} vue-router route alias(es) are not mapped as screens (${siteList(aliased.map((visit) => ({ file: visit.node.file, line: visit.node.line })))})`,
  })
}

const reportAddRoute = (ctx: DiscoverContext): void => {
  const sites = sitesOf(ctx, ADD_ROUTE_CALL)
  if (sites.length === 0) return
  ctx.diagnostic({
    severity: "info",
    code: "screens/dynamic-registry",
    message: `${String(sites.length)} router.addRoute call(s) register routes at runtime; they are not discovered (${siteList(sites)})`,
  })
}

const fileRouteTables = (
  ctx: DiscoverContext,
  routerFiles: readonly string[],
  calls: readonly RouterCall[],
): readonly RouterTable[] => {
  const trigger = fileRouteTrigger(ctx, appFiles(ctx))
  const autoCalls = calls.filter((entry) => entry.auto)
  if (trigger === null || (calls.length > 0 && autoCalls.length === 0)) return []
  const [first] = autoCalls
  return [
    {
      file: first?.file ?? routerFiles[0] ?? trigger,
      routes: readFileRoutes(ctx),
      unreadable: [],
      guarded: autoCalls.some((entry) => entry.guarded),
    },
  ]
}

const discoverVueRouter = (ctx: DiscoverContext, rules: VueAuthRules): readonly ScreenDraft[] => {
  const discovery = createDiscovery(ctx, rules)
  const routerFiles = filesMatching(ctx, isRouterText)
  const calls = discovery.routerCalls(routerFiles)
  const tables = [...discovery.routerTables(calls), ...fileRouteTables(ctx, routerFiles, calls)]
  const tableFiles = stableUnique(tables.map((table) => table.file))
  const visitNode = visitTree(ctx, discovery)
  const visits = tables.flatMap((table) => {
    table.unreadable.forEach((item) => {
      reportUnreadable(ctx, item)
    })
    const root = discovery.rootFor(table.file, tableFiles)
    const frame: Frame = {
      url: null,
      raw: "",
      auth: null,
      ancestors: [],
      host: root.host,
      conditions: [],
      guarded: table.guarded,
      notes: root.notes,
    }
    return table.routes.flatMap((node) => visitNode(node, frame))
  })
  reportAliases(ctx, visits)
  reportAddRoute(ctx)
  const names = nameTableOf(visits)
  const localIds = localIdsOf(ctx, visits)
  const drafts = visits.map((visit, index) => draftOf(ctx, visit, localIds[index] ?? "", names))
  return placeDrafts(ctx, visits, drafts)
}

export const createVueRouterSource = (options: VueRouterOptions = {}): ScreenSource => {
  const rules = options.authRules ?? resolveVueAuthRules({})
  return {
    name: SOURCE_NAME,
    detect: detectVueRouter,
    discover: (ctx) => discoverVueRouter(ctx, rules),
  }
}

const ambientComponentsOf = (ctx: DiscoverContext): readonly AmbientComponent[] =>
  isVueRouterProject(ctx) ? createDiscovery(ctx, resolveVueAuthRules({})).ambientComponents() : []

export const createVueRouterAdapter = (options: VueRouterOptions = {}): Adapter => ({
  name: SOURCE_NAME,
  screens: [createVueRouterSource(options)],
  ambientComponents: ambientComponentsOf,
})
