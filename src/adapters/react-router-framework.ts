import * as path from "node:path"
import type ts from "typescript"
import { walk } from "../core/ast.js"
import type { AncestorRef, Evidence } from "../core/model.js"
import { uniqueBy } from "../core/order.js"
import { convertReactRouterPath, joinUrl, normalizeUrl, paramsOf } from "../core/url.js"
import { createValueResolver } from "./array-values.js"
import { createConfigFileReader } from "./config-file.js"
import { readFlatRoutes } from "./flat-routes.js"
import { type LoaderGuard, guardOfExports } from "./loader-guards.js"
import { OUTLET_SPLICE } from "./react-router/constants.js"
import { type DeclaredAt, type RouteNode, readRouteConfig } from "./route-config.js"
import { type InheritedGuard, ownGuard, passedGuard, redirectOfGuard } from "./tanstack-route-options.js"
import type { Adapter, DetectResult, DiscoverContext, ProjectContext, ScreenDraft, ScreenSource, TsNode } from "./types.js"
import { importedBindingOf } from "./values.js"

/**
 * React Router v7/v8 framework mode and Remix v2: the route tree comes from `<appDirectory>/routes.ts`
 * (or, without one, the Remix v2 flat-file convention), `root.tsx` wraps every route, and route-module
 * `loader`/`clientLoader` redirects decide auth by the loader-guard rule.
 */

export const SOURCE_NAME = "react-router-framework"

const DEPENDENCIES = ["@react-router/dev", "@remix-run/dev"] as const

const DEFAULT_APP_DIRECTORY = "app"

const FLAT_ROOT_DIRECTORY = "routes"

const DETECT_SCORE = 100

const NO_DETECTION: DetectResult = { score: 0, evidence: [] }

const CONFIG_FILES = {
  reactRouter: ["react-router.config.ts", "react-router.config.js", "react-router.config.mjs"],
  remix: ["remix.config.js", "remix.config.cjs", "remix.config.mjs", "remix.config.ts"],
  vite: ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"],
} as const

const ROUTES_FILE_EXTENSIONS = ["ts", "tsx", "js", "mjs"] as const

const ROOT_FILE_EXTENSIONS = ["tsx", "jsx", "ts", "js"] as const

const FLAT_ROUTE_EXTENSIONS = "{tsx,ts,jsx,js,md,mdx}"

const VITE_PLUGIN_CALL = /\b(?:remix|reactRouter)\s*\(/

const APP_DIRECTORY_TEXT = /\bappDirectory\s*:\s*["'`]([^"'`]+)["'`]/

const REMIX_PLUGIN = { name: "remix", module: "@remix-run/dev", imported: "vitePlugin" } as const

const OPTION_KEYS = {
  appDirectory: "appDirectory",
  ignoredRouteFiles: "ignoredRouteFiles",
  routes: "routes",
} as const

const DATA_EXPORTS = ["loader", "clientLoader"] as const

const DEFAULT_EXPORT = "default"

export type ReactRouterFrameworkOptions = {
  /** Config `redirects.unauthenticated`: only conditional loader redirects to it protect a route. */
  readonly unauthenticatedTarget?: string | null
}

type AppConfig = {
  readonly appDirectory: string
  readonly ignoredRouteFiles: readonly string[]
  readonly file: string | null
}

type Frame = {
  /** The URL children resolve relative paths against. */
  readonly url: string | null
  readonly chain: readonly AncestorRef[]
  readonly guard: InheritedGuard | null
  /** Ancestor redirects that do not protect (unconditional on a layout, or scoped out), as evidence. */
  readonly notes: readonly Evidence[]
}

type Placed = {
  readonly file: string
  readonly draft: Omit<ScreenDraft, "localId">
}

const DEFAULT_CONFIG: AppConfig = { appDirectory: DEFAULT_APP_DIRECTORY, ignoredRouteFiles: [], file: null }

const firstExisting = (ctx: ProjectContext, candidates: readonly string[]): string | null =>
  candidates.find((file) => ctx.exists(file)) ?? null

const filesIn = (directory: string, base: string, extensions: readonly string[]): readonly string[] =>
  extensions.map((extension) => path.posix.join(directory, `${base}.${extension}`))

const cleanDirectory = (raw: string): string => path.posix.normalize(raw).replace(/^\.\//, "").replace(/\/+$/, "")

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length

const evidenceAt = (what: string, at: DeclaredAt): Evidence => ({ what, file: at.file, line: at.line })

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const dependencyOf = (ctx: ProjectContext): string | null => DEPENDENCIES.find((name) => ctx.hasDependency(name)) ?? null

const textAppDirectory = (ctx: ProjectContext): string => {
  const file = firstExisting(ctx, [...CONFIG_FILES.reactRouter, ...CONFIG_FILES.remix])
  const literal = file === null ? undefined : APP_DIRECTORY_TEXT.exec(ctx.readFile(file) ?? "")?.[1]
  return literal === undefined ? DEFAULT_APP_DIRECTORY : cleanDirectory(literal)
}

type Trigger = (ctx: ProjectContext, appDirectory: string) => Evidence | null

const routesConfigTrigger: Trigger = (ctx, appDirectory) => {
  const file = firstExisting(ctx, filesIn(appDirectory, "routes", ROUTES_FILE_EXTENSIONS))
  return file === null ? null : { what: "React Router framework routes config", file, line: 1 }
}

const routesFolderTrigger: Trigger = (ctx, appDirectory) => {
  const [file] = ctx.glob(`${appDirectory}/${FLAT_ROOT_DIRECTORY}/**/*.${FLAT_ROUTE_EXTENSIONS}`)
  return file === undefined ? null : { what: "file-system routes folder", file, line: 1 }
}

const remixConfigTrigger: Trigger = (ctx) => {
  const file = firstExisting(ctx, CONFIG_FILES.remix)
  return file === null ? null : { what: "Remix config file", file, line: 1 }
}

const vitePluginTrigger: Trigger = (ctx) =>
  CONFIG_FILES.vite.flatMap((file): readonly Evidence[] => {
    const text = ctx.readFile(file) ?? ""
    const match = VITE_PLUGIN_CALL.exec(text)
    return match === null ? [] : [{ what: "vite remix()/reactRouter() plugin", file, line: lineAt(text, match.index) }]
  })[0] ?? null

const TRIGGERS: readonly Trigger[] = [routesConfigTrigger, routesFolderTrigger, remixConfigTrigger, vitePluginTrigger]

const frameworkEvidenceOf = (ctx: ProjectContext): readonly Evidence[] | null => {
  const dependency = dependencyOf(ctx)
  if (dependency === null) return null
  const appDirectory = textAppDirectory(ctx)
  const trigger = TRIGGERS.map((read) => read(ctx, appDirectory)).find((found) => found !== null) ?? null
  return trigger === null ? null : [{ what: `${dependency} dependency`, file: "package.json", line: 1 }, trigger]
}

/** AS13: a framework dependency plus a routes config, a routes folder, a Remix config or a vite plugin call. */
export const isFrameworkMode = (ctx: ProjectContext): boolean => frameworkEvidenceOf(ctx) !== null

export const detectReactRouterFramework = (ctx: ProjectContext): DetectResult => {
  const evidence = frameworkEvidenceOf(ctx)
  return evidence === null ? NO_DETECTION : { score: DETECT_SCORE, evidence }
}

// ---------------------------------------------------------------------------
// App config
// ---------------------------------------------------------------------------

const createAppConfigReader = (ctx: DiscoverContext) => {
  const resolver = createValueResolver(ctx)
  const { exportedOf, configObjectsOf, memberNamed, literalField, literalStringArray } = createConfigFileReader(ctx, resolver)

  const notice = (severity: "info" | "warning", message: string, file: string, node: TsNode): void =>
    ctx.diagnostic({ severity, code: "screens/dynamic-registry", message, file, line: ctx.lineOf(file, node) })

  const appDirectoryOf = (object: ts.ObjectLiteralExpression, file: string): string => {
    const member = memberNamed(object, OPTION_KEYS.appDirectory)
    if (member === null) return DEFAULT_APP_DIRECTORY
    const value = literalField(object, OPTION_KEYS.appDirectory)
    if (value !== null) return cleanDirectory(value)
    notice("info", `'${OPTION_KEYS.appDirectory}' is not a string literal; the default '${DEFAULT_APP_DIRECTORY}' is used`, file, member)
    return DEFAULT_APP_DIRECTORY
  }

  const ignoredFilesOf = (object: ts.ObjectLiteralExpression, file: string): readonly string[] => {
    const ignored = literalStringArray(object, OPTION_KEYS.ignoredRouteFiles)
    if (ignored.kind === "literal") return ignored.values
    if (ignored.kind === "dynamic")
      notice("info", `'${OPTION_KEYS.ignoredRouteFiles}' is not a literal string array; no route files are ignored`, file, ignored.node)
    return []
  }

  const reportRoutesFunction = (object: ts.ObjectLiteralExpression, file: string): void => {
    const member = memberNamed(object, OPTION_KEYS.routes)
    if (member === null) return
    notice(
      "warning",
      `the Remix '${OPTION_KEYS.routes}' option defines routes in code this source does not evaluate; only the default '${FLAT_ROOT_DIRECTORY}/' convention is read`,
      file,
      member,
    )
  }

  const remixOptionsOf = (object: ts.ObjectLiteralExpression, file: string): AppConfig => {
    reportRoutesFunction(object, file)
    return { appDirectory: appDirectoryOf(object, file), ignoredRouteFiles: ignoredFilesOf(object, file), file }
  }

  const objectOf = (node: TsNode, file: string): { readonly object: ts.ObjectLiteralExpression; readonly file: string } | null => {
    const located = configObjectsOf(node, file, 0)[0]
    const object = located === undefined ? null : ctx.ast.asObjectLiteral(located.node)
    return object === null || located === undefined ? null : { object, file: located.file }
  }

  const exportedObjectOf = (file: string) => {
    const source = ctx.sourceFile(file)
    const exported = source === null ? null : exportedOf(source)
    const found = exported === null ? null : objectOf(exported, file)
    if (found === null && source !== null)
      notice("info", `${file} exports no config object this source can read; the default app directory is used`, file, source)
    return found
  }

  const reactRouterConfigOf = (file: string): AppConfig => {
    const found = exportedObjectOf(file)
    return found === null ? { ...DEFAULT_CONFIG, file } : { ...DEFAULT_CONFIG, appDirectory: appDirectoryOf(found.object, found.file), file }
  }

  const remixConfigOf = (file: string): AppConfig => {
    const found = exportedObjectOf(file)
    return found === null ? { ...DEFAULT_CONFIG, file } : remixOptionsOf(found.object, found.file)
  }

  const isRemixPlugin = (call: ts.CallExpression, file: string): boolean => {
    const callee = ctx.ast.asIdentifier(call.expression)
    if (callee === null) return false
    const imported = importedBindingOf(ctx.bindingsFor(file).get(callee.text))
    if (imported === null) return callee.text === REMIX_PLUGIN.name
    return imported.module === REMIX_PLUGIN.module && imported.imported === REMIX_PLUGIN.imported
  }

  const remixPluginCallOf = (file: string): ts.CallExpression | null => {
    const source = ctx.sourceFile(file)
    if (source === null) return null
    const found: ts.CallExpression[] = []
    walk(source, (node) => {
      const call = ctx.ast.asCallExpression(node)
      if (call !== null && isRemixPlugin(call, file)) found.push(call)
    })
    return found[0] ?? null
  }

  const vitePluginConfigOf = (file: string, call: ts.CallExpression): AppConfig => {
    const [argument] = call.arguments
    if (argument === undefined) return { ...DEFAULT_CONFIG, file }
    const found = objectOf(argument, file)
    if (found !== null) return remixOptionsOf(found.object, found.file)
    notice("info", "the vite remix() plugin options are not an object literal; the default app directory is used", file, argument)
    return { ...DEFAULT_CONFIG, file }
  }

  const viteConfig = (): AppConfig | null => {
    for (const file of CONFIG_FILES.vite.filter((candidate) => ctx.exists(candidate))) {
      const call = remixPluginCallOf(file)
      if (call !== null) return vitePluginConfigOf(file, call)
    }
    return null
  }

  /** `react-router.config` wins, then the vite `remix()` plugin, then a classic `remix.config`. */
  const appConfigOf = (): AppConfig => {
    const reactRouter = firstExisting(ctx, CONFIG_FILES.reactRouter)
    if (reactRouter !== null) return reactRouterConfigOf(reactRouter)
    const vite = viteConfig()
    if (vite !== null) return vite
    const remix = firstExisting(ctx, CONFIG_FILES.remix)
    return remix === null ? DEFAULT_CONFIG : remixConfigOf(remix)
  }

  return appConfigOf
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const routeTreeOf = (ctx: DiscoverContext, config: AppConfig, rootFile: string | null): readonly RouteNode[] => {
  const flat = readFlatRoutes(ctx)
  const routesFile = firstExisting(ctx, filesIn(config.appDirectory, "routes", ROUTES_FILE_EXTENSIONS))
  if (routesFile !== null) return readRouteConfig(ctx, { file: routesFile, appDirectory: config.appDirectory, readFlatRoutes: flat })
  return flat({
    convention: "react-router",
    rootDirectory: FLAT_ROOT_DIRECTORY,
    ignoredRouteFiles: config.ignoredRouteFiles,
    appDirectory: config.appDirectory,
    options: null,
    declaredAt: { file: rootFile ?? config.file ?? config.appDirectory, line: 1 },
  })
}

/** Absolute paths (flat routes) stand alone; relative ones (`routes.ts`) join the parent; an index takes its parent's URL. */
const urlOf = (node: RouteNode, parentUrl: string | null): string | null => {
  if (node.path === null) return node.index ? (parentUrl ?? "/") : null
  if (node.path.startsWith("/")) return normalizeUrl(node.path)
  return joinUrl(parentUrl ?? "/", convertReactRouterPath(node.path).url)
}

const describeRoute = (node: RouteNode): string => {
  if (node.index) return `index route '${node.file}'`
  return node.path === null ? `layout route '${node.file}'` : `route '${node.path}' → '${node.file}'`
}

const createDiscovery = (ctx: DiscoverContext, options: ReactRouterFrameworkOptions) => {
  const guardOptions = { unauthenticatedTarget: options.unauthenticatedTarget ?? null }
  const guards = new Map<string, LoaderGuard>()

  const guardOf = (file: string): LoaderGuard => {
    const cached = guards.get(file)
    if (cached !== undefined) return cached
    const guard = guardOfExports(ctx, file, DATA_EXPORTS, guardOptions)
    guards.set(file, guard)
    return guard
  }

  /** A missing module is kept as a component so the kernel reports the unresolved entry. */
  const rendersComponent = (file: string): boolean => {
    const source = ctx.sourceFile(file)
    return source === null || ctx.ast.exportOrigin(source, DEFAULT_EXPORT) !== null
  }

  const linkOf = (file: string): AncestorRef => ({ ...ctx.declaredExport(file, DEFAULT_EXPORT), splice: OUTLET_SPLICE, role: "layout" })

  const guardEvidence = (guard: LoaderGuard, file: string): readonly Evidence[] =>
    guard.label === "" ? [] : [evidenceAt(guard.label, { file: guard.file ?? file, line: guard.line ?? 1 })]

  /** What descendants learn from a module's redirect that does not protect them. */
  const noteOf = (guard: LoaderGuard, file: string): readonly Evidence[] => {
    if (guard.kind === "unconditional")
      return guardEvidence({ ...guard, label: `ancestor '${file}' redirects unconditionally: ${guard.label}` }, file)
    if (guard.scopedOut) return guardEvidence({ ...guard, label: `ancestor '${file}' (not a guard, scoped out): ${guard.label}` }, file)
    return []
  }

  const childFrame = (frame: Frame, file: string, url: string | null, linked: boolean): Frame => {
    const guard = guardOf(file)
    return {
      url,
      chain: linked ? uniqueBy([...frame.chain, linkOf(file)], (ref) => `${ref.file}|${ref.exportName}`) : frame.chain,
      guard: passedGuard(ownGuard(guard), file) ?? frame.guard,
      notes: [...frame.notes, ...noteOf(guard, file)],
    }
  }

  /** Like TanStack's root `beforeLoad`, a root-module loader guard is not inherited by the routes. */
  const rootFrame = (rootFile: string | null): Frame => {
    const empty: Frame = { url: null, chain: [], guard: null, notes: [] }
    return rootFile === null ? empty : { ...childFrame(empty, rootFile, null, rendersComponent(rootFile)), guard: null }
  }

  const inheritedEvidence = (frame: Frame, own: InheritedGuard | null, at: DeclaredAt): readonly Evidence[] => {
    if (own !== null || frame.guard === null) return []
    const owner = frame.guard.owner ?? "an ancestor"
    return [evidenceAt(`protected by the loader guard of '${owner}': ${frame.guard.guard.label}`, at)]
  }

  const draftOf = (node: RouteNode, url: string, frame: Frame): Omit<ScreenDraft, "localId"> => {
    const component = rendersComponent(node.file)
    const guard = guardOf(node.file)
    const own = ownGuard(guard)
    const redirectTo = redirectOfGuard(guard)
    const evidence = [
      evidenceAt(`react-router framework ${describeRoute(node)}`, node.declaredAt),
      ...node.evidence.map((text) => evidenceAt(text, node.declaredAt)),
      ...(component ? [] : [evidenceAt("resource route: the module has no default export (no UI)", node.declaredAt)]),
      ...guardEvidence(guard, node.file),
      ...inheritedEvidence(frame, own, node.declaredAt),
      ...frame.notes,
    ]
    return {
      activations: [{ kind: "url", template: url, params: [...paramsOf(url)] }],
      entries: component ? [{ kind: "file", ...ctx.declaredExport(node.file, DEFAULT_EXPORT) }] : [],
      ancestors: component ? frame.chain : [],
      evidence,
      ...(component ? {} : { kindTag: "apiRoute" }),
      ...(own === null && frame.guard === null ? {} : { auth: "protected" as const }),
      ...(redirectTo === null ? {} : { redirectTo }),
    }
  }

  /** A routed parent whose index child shares its URL is that child's layout; an index at a deeper flat path leaves the parent addressable. */
  const ownsScreen = (node: RouteNode, url: string): boolean =>
    node.index || !node.children.some((child) => child.index && urlOf(child, url) === url)

  const visit = (node: RouteNode, frame: Frame): readonly Placed[] => {
    const url = urlOf(node, frame.url)
    const own: readonly Placed[] = url === null || !ownsScreen(node, url) ? [] : [{ file: node.file, draft: draftOf(node, url, frame) }]
    const next = childFrame(frame, node.file, url ?? frame.url, rendersComponent(node.file))
    return [...own, ...node.children.flatMap((child) => visit(child, next))]
  }

  const localIdsOf = (placed: readonly Placed[]): readonly string[] => {
    const totals = placed.reduce((counts, { file }) => counts.set(file, (counts.get(file) ?? 0) + 1), new Map<string, number>())
    const seen = new Map<string, number>()
    return placed.map(({ file }) => {
      const ordinal = seen.get(file) ?? 0
      seen.set(file, ordinal + 1)
      return totals.get(file) === 1 ? ctx.localId(file) : ctx.localId(file, { ordinal })
    })
  }

  const reportMissingRoot = (config: AppConfig): void =>
    ctx.diagnostic({
      severity: "info",
      code: "screens/unsupported-router-style",
      message: `no '${config.appDirectory}/root.{${ROOT_FILE_EXTENSIONS.join(",")}}' was found; routes carry no root layout`,
      ...(config.file === null ? {} : { file: config.file }),
    })

  const discover = (): readonly ScreenDraft[] => {
    const config = createAppConfigReader(ctx)()
    const rootFile = firstExisting(ctx, filesIn(config.appDirectory, "root", ROOT_FILE_EXTENSIONS))
    if (rootFile === null) reportMissingRoot(config)
    const frame = rootFrame(rootFile)
    const placed = routeTreeOf(ctx, config, rootFile).flatMap((node) => visit(node, frame))
    const localIds = localIdsOf(placed)
    return placed.map(({ draft }, index) => ({ localId: localIds[index] ?? "", ...draft }))
  }

  return discover
}

const discoverFramework = (ctx: DiscoverContext, options: ReactRouterFrameworkOptions): readonly ScreenDraft[] =>
  isFrameworkMode(ctx) ? createDiscovery(ctx, options)() : []

export const createReactRouterFrameworkSource = (options: ReactRouterFrameworkOptions = {}): ScreenSource => ({
  name: SOURCE_NAME,
  detect: detectReactRouterFramework,
  discover: (ctx) => discoverFramework(ctx, options),
})

export const createReactRouterFrameworkAdapter = (options: ReactRouterFrameworkOptions = {}): Adapter => ({
  name: SOURCE_NAME,
  screens: [createReactRouterFrameworkSource(options)],
})
