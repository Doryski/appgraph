import type ts from "typescript"
import { walk } from "../core/ast.js"
import type { AncestorRef, Evidence } from "../core/model.js"
import { sortedUnique, uniqueBy } from "../core/order.js"
import { isExcludedFile, isNonAppFile } from "../core/project.js"
import { lineAt, type ObjectMember } from "./source-utils.js"
import type { PathConversion } from "../core/url.js"
import { convertTanStackRoutePath, tanStackRoutesRootIndex } from "../core/url.js"
import type { LoaderGuard } from "./loader-guards.js"
import { CODE_ROUTE_MENTION, ROOT_ROUTE_FACTORIES, discoverCodeRoutes } from "./tanstack-code-routes.js"
import { DEV_ONLY_EVIDENCE, createBuildModeReader, devOnlyNestedEvidence } from "./route-conditions.js"
import type { PathlessRole, PathlessRoles, RouteOptionsReader } from "./tanstack-route-options.js"
import {
  DEFAULT_PATHLESS_ROLES,
  authOfLayers,
  createRouteOptionsReader,
  guardAuthTexts,
  guardedAuth,
  ownGuard,
  passedGuard,
  redirectOfGuard,
  type InheritedGuard,
} from "./tanstack-route-options.js"
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
import { SCRIPT_GLOB, stripSourceExtension } from "../core/extensions.js"

export const SOURCE_NAME = "tanstack-router"

const LAZY_FILE_FACTORY = "createLazyFileRoute"

export const ROUTE_FACTORIES = ["createFileRoute", LAZY_FILE_FACTORY] as const

export const TANSTACK_MODULES = ["@tanstack/react-router", "@tanstack/react-start"] as const

/** The detect probe, verbatim: the call as written. */
const FACTORY_CALL = /\b(create(?:Lazy)?FileRoute)\s*\(/

/** Code-based routing: a route tree assembled from `createRootRoute`/`createRoute` calls. */
const CODE_ROUTE_CALL = /\b(createRoute|createRootRoute(?:WithContext)?)\s*[(<]/

/** The discovery probe is wider: an aliased `createFileRoute as fileRoute` never writes `(` after it. */
const FACTORY_MENTION = /\bcreate(?:Lazy)?FileRoute\b/

const ROUTES_SEGMENT = "routes"

const ROOT_ROUTE_BASE = "__root"

const ROUTE_EXTENSIONS = ["tsx", "ts", "jsx", "js"] as const

const RESERVED_TAIL = ["lazy", "route"] as const

const INDEX_TOKEN = "index"

const ROUTE_EXPORT = "Route"

const SERVER_ROUTE_OPTION = "server"

const DETECT_SCORE_FILE = 100

const DETECT_SCORE_CODE = 90

const ROOT_CONFIG_FILES = [
  "tsr.config.json",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "app.config.ts",
  "app.config.js",
] as const

const VIRTUAL_CONFIG_KEY = /\bvirtualRouteConfig\b/

const GENERATED_TREE_KEY = /\bgeneratedRouteTree["']?\s*:\s*["']([^"']+)["']/

const DEFAULT_GENERATED_TREE = "src/routeTree.gen.ts"

const TSR_CONFIG_FILE = "tsr.config.json"

const ROUTES_DIRECTORY_KEY = "routesDirectory"

const ROUTER_PLUGINS = ["tanstackRouter", "TanStackRouterVite"] as const

const START_PLUGIN = "tanstackStart"

const START_DEFAULTS = { srcDirectory: "src", routesDirectory: ROUTES_SEGMENT } as const

const LISTED_ROUTES = 5

/** TanStack's filename escape: `sitemap[.]xml.tsx` is `/sitemap.xml`, `org.[_].tsx` is `/org/_`. */
const ESCAPED_SPAN = /\[([^\]]*)\]/g

/**
 * A route LITERAL is a URL path, not a filename: a `.` in it is a character, and a whole segment named
 * `routes`, `route`, `lazy` or a bare `_` is a URL segment, never the filename convention's routes
 * directory, reserved tail or pathless marker.
 */
const LITERAL_SPAN = /(\.|(?<=^|\/)(?:routes|route|lazy|_)(?=\/|$))/g

const HELD_SPAN = /\uE000(\d+)\uE001/g

// ---------------------------------------------------------------------------
// Pathless segments — configuration, not hardcoding (§16.3)
// ---------------------------------------------------------------------------

export { DEFAULT_PATHLESS_ROLES }
export type { PathlessRole, PathlessRoles }

export type TanStackRouterOptions = {
  /** Replaces (does not extend) `DEFAULT_PATHLESS_ROLES` when given. */
  readonly pathless?: PathlessRoles
  readonly factories?: readonly string[]
  /** Config `redirects.unauthenticated`: only conditional `beforeLoad` redirects to it protect a route. */
  readonly unauthenticatedTarget?: string | null
}

const guardOptionsOf = (options: TanStackRouterOptions) => ({ unauthenticatedTarget: options.unauthenticatedTarget ?? null })

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const routerDependencyOf = (ctx: ProjectContext): string | null =>
  TANSTACK_MODULES.find((module) => ctx.hasDependency(module)) ?? null

const probeCalls = (ctx: ProjectContext, pattern: RegExp): readonly Evidence[] =>
  ctx.glob(SCRIPT_GLOB).flatMap((file): readonly Evidence[] => {
    if (isExcludedFile(file) || ctx.isGenerated(file)) return []
    const text = ctx.readFile(file)
    const call = text === null ? null : pattern.exec(text)
    return text === null || call === null ? [] : [{ what: `${call[1] ?? ""} call`, file, line: lineAt(text, call.index) }]
  })

/**
 * §10.1: the file convention is framework ground truth (100); a code-based tree is a literal parse of
 * the app's own `createRoute` calls, scored like react-router's data router (90).
 */
export const detectTanStackRouter = (ctx: ProjectContext): DetectResult => {
  const dependency = routerDependencyOf(ctx)
  if (dependency === null) return { score: 0, evidence: [] }

  const dependencyEvidence: Evidence = { what: `${dependency} dependency`, file: "package.json", line: 1 }

  const fileRoutes = probeCalls(ctx, FACTORY_CALL)
  if (fileRoutes.length > 0) return { score: DETECT_SCORE_FILE, evidence: [dependencyEvidence, ...fileRoutes] }

  const codeRoutes = probeCalls(ctx, CODE_ROUTE_CALL)
  if (codeRoutes.length > 0) return { score: DETECT_SCORE_CODE, evidence: [dependencyEvidence, ...codeRoutes] }

  return { score: 0, evidence: [] }
}

type ConfigFile = {
  readonly file: string
  readonly text: string
}

/** The analyzed root's own router-plugin configs — never a nested package's. */
const rootConfigsOf = (ctx: ProjectContext): readonly ConfigFile[] =>
  ROOT_CONFIG_FILES.flatMap((file): readonly ConfigFile[] => {
    const text = ctx.readFile(file)
    return text === null ? [] : [{ file, text }]
  })

/**
 * `@tanstack/virtual-file-routes` maps routes to files in a config, so a route file's name and place say
 * nothing about its URL. A `virtualRouteConfig` key in the root's router-plugin config is the switch;
 * the package dependency alone switches nothing.
 */
const virtualRoutesEvidence = (configs: readonly ConfigFile[]): Evidence | null =>
  configs.flatMap(({ file, text }): readonly Evidence[] => {
    const key = VIRTUAL_CONFIG_KEY.exec(text)
    return key === null ? [] : [{ what: "virtual file routes ('virtualRouteConfig')", file, line: lineAt(text, key.index) }]
  })[0] ?? null

const generatedTreeFileOf = (configs: readonly ConfigFile[]): string => {
  const named = configs.map(({ text }) => GENERATED_TREE_KEY.exec(text)?.[1]).find((value) => value !== undefined)
  return named === undefined ? DEFAULT_GENERATED_TREE : named.replace(/^\.\//, "")
}

// ---------------------------------------------------------------------------
// The routes directory — `routesDirectory` in the router-plugin config
// ---------------------------------------------------------------------------

type RoutesDirReading =
  | { readonly kind: "dir"; readonly dir: string; readonly file: string; readonly line: number }
  | { readonly kind: "unreadable"; readonly why: string; readonly file: string; readonly line: number }

/** Why the configured routes directory was not used; empty when it was, or when none is configured. */
type RoutesDirFallback = {
  readonly why: string
  readonly file: string
  readonly line: number
}

type RoutesDirectory = {
  /** Project-relative and posix; `undefined` keeps the default (the last `routes` directory in a path). */
  readonly dir: string | undefined
  readonly fallbacks: readonly RoutesDirFallback[]
}

/** `base` joined with `value`, posix-normalised; `null` when it is absolute, leaves the root or is the root. */
const normalizedDirOf = (base: string, value: string): string | null => {
  if (value.startsWith("/")) return null
  const parts = [...base.split("/"), ...value.split("/")].filter((part) => part !== "" && part !== ".")
  const resolved = parts.reduce<readonly string[] | null>((done, part) => {
    if (done === null) return null
    if (part !== "..") return [...done, part]
    return done.length === 0 ? null : done.slice(0, -1)
  }, [])
  return resolved === null || resolved.length === 0 ? null : resolved.join("/")
}

const readingOf = (base: string, value: string, file: string, line: number): RoutesDirReading => {
  const dir = normalizedDirOf(base, value)
  return dir === null
    ? { kind: "unreadable", why: `'${value}' does not name a directory inside the analyzed root`, file, line }
    : { kind: "dir", dir, file, line }
}

const tsrConfigReadings = ({ file, text }: ConfigFile): readonly RoutesDirReading[] => {
  const keyAt = text.indexOf(ROUTES_DIRECTORY_KEY)
  if (keyAt === -1) return []
  const line = lineAt(text, keyAt)
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  })()
  if (typeof parsed !== "object" || parsed === null)
    return [{ kind: "unreadable", why: "the file does not parse as a JSON object", file, line }]
  const value: unknown = Object.entries(parsed).find(([key]) => key === ROUTES_DIRECTORY_KEY)?.[1]
  if (value === undefined) return []
  return typeof value === "string"
    ? [readingOf("", value, file, line)]
    : [{ kind: "unreadable", why: "its value is not a string", file, line }]
}

const pluginNameOf = (ctx: DiscoverContext, call: ts.CallExpression): string | null =>
  ctx.ast.asIdentifier(call.expression)?.text ?? ctx.ast.asPropertyAccess(call.expression)?.name.text ?? null

const literalOf = (ctx: DiscoverContext, member: ObjectMember | null): string | null =>
  member === null ? null : (ctx.ast.asStringLiteralLike(member.value)?.text ?? null)

const isNonLiteral = (ctx: DiscoverContext, member: ObjectMember): boolean => literalOf(ctx, member) === null

const nonLiteral = (ctx: DiscoverContext, file: string, member: ObjectMember, name: string): RoutesDirReading => ({
  kind: "unreadable",
  why: `'${name}' is not a string literal`,
  file,
  line: ctx.lineOf(file, member.node),
})

const routerPluginReadings = (
  ctx: DiscoverContext,
  reader: RouteOptionsReader,
  file: string,
  call: ts.CallExpression,
): readonly RoutesDirReading[] => {
  const member = reader.memberNamed(call.arguments[0] ?? null, ROUTES_DIRECTORY_KEY)
  const value = literalOf(ctx, member)
  if (member === null) return []
  return value === null
    ? [nonLiteral(ctx, file, member, ROUTES_DIRECTORY_KEY)]
    : [readingOf("", value, file, ctx.lineOf(file, member.node))]
}

/** `tanstackStart({ srcDirectory, router: { routesDirectory } })`: the routes directory is relative to `srcDirectory`. */
const startPluginReadings = (
  ctx: DiscoverContext,
  reader: RouteOptionsReader,
  file: string,
  call: ts.CallExpression,
): readonly RoutesDirReading[] => {
  const options = call.arguments[0] ?? null
  const srcMember = reader.memberNamed(options, "srcDirectory")
  const routerMember = reader.memberNamed(options, "router")
  const routesMember = reader.memberNamed(routerMember?.value ?? null, ROUTES_DIRECTORY_KEY)
  if (routerMember !== null && ctx.ast.asObjectLiteral(routerMember.value) === null)
    return [nonLiteral(ctx, file, routerMember, "router")]
  if (srcMember !== null && isNonLiteral(ctx, srcMember)) return [nonLiteral(ctx, file, srcMember, "srcDirectory")]
  if (routesMember !== null && isNonLiteral(ctx, routesMember)) return [nonLiteral(ctx, file, routesMember, ROUTES_DIRECTORY_KEY)]

  const written = routesMember ?? srcMember
  if (written === null) return []
  const line = ctx.lineOf(file, written.node)
  const srcDir = normalizedDirOf("", literalOf(ctx, srcMember) ?? START_DEFAULTS.srcDirectory)
  if (srcDir === null)
    return [{ kind: "unreadable", why: "'srcDirectory' does not name a directory inside the analyzed root", file, line }]
  return [readingOf(srcDir, literalOf(ctx, routesMember) ?? START_DEFAULTS.routesDirectory, file, line)]
}

const pluginConfigReadings = (
  ctx: DiscoverContext,
  reader: RouteOptionsReader,
  { file }: ConfigFile,
): readonly RoutesDirReading[] => {
  const source = ctx.sourceFile(file)
  if (source === null) return []
  return callsIn(ctx, source).flatMap((call) => {
    const name = pluginNameOf(ctx, call)
    if (name === START_PLUGIN) return startPluginReadings(ctx, reader, file, call)
    return ROUTER_PLUGINS.some((plugin) => plugin === name) ? routerPluginReadings(ctx, reader, file, call) : []
  })
}

const placeOf = ({ file, line }: { readonly file: string; readonly line: number }): string => `${file}:${String(line)}`

const conflictOf = (readings: readonly Extract<RoutesDirReading, { kind: "dir" }>[]): RoutesDirFallback => {
  const listed = readings.map((reading) => `'${reading.dir}' (${placeOf(reading)})`).join(", ")
  const [first] = readings
  return {
    why: `the configured routes directories disagree: ${listed}`,
    file: first?.file ?? TSR_CONFIG_FILE,
    line: first?.line ?? 1,
  }
}

/**
 * The routes directory the root's router-plugin configs name: `tsr.config.json`'s `routesDirectory`, a
 * literal `routesDirectory` in `tanstackRouter(…)`/`TanStackRouterVite(…)`, or `tanstackStart(…)`'s
 * `srcDirectory` + `router.routesDirectory`. A non-literal or conflicting value keeps the default.
 */
const routesDirectoryOf = (
  ctx: DiscoverContext,
  reader: RouteOptionsReader,
  configs: readonly ConfigFile[],
): RoutesDirectory => {
  const readings = configs.flatMap((config) =>
    config.file === TSR_CONFIG_FILE ? tsrConfigReadings(config) : pluginConfigReadings(ctx, reader, config),
  )
  const unreadable = readings.flatMap((reading) =>
    reading.kind === "unreadable" ? [{ why: `'${ROUTES_DIRECTORY_KEY}' is not readable: ${reading.why}`, file: reading.file, line: reading.line }] : [],
  )
  if (unreadable.length > 0) return { dir: undefined, fallbacks: unreadable }

  const dirs = readings.flatMap((reading) => (reading.kind === "dir" ? [reading] : []))
  const distinct = sortedUnique(dirs.map((reading) => reading.dir))
  if (distinct.length > 1) return { dir: undefined, fallbacks: [conflictOf(dirs)] }
  return { dir: distinct[0], fallbacks: [] }
}

// ---------------------------------------------------------------------------
// Route files
// ---------------------------------------------------------------------------

type RoutePath = {
  readonly conversion: PathConversion
  /** The string the conversion was read from — a route literal or the route file's own path. */
  readonly raw: string
  /** `raw` as route tokens, every held-out span still opaque, so it never reads as `_x`, `(x)` or `index`. */
  readonly tokens: readonly string[]
}

/** A held-out span: `escaped` when the filename's `[x]` escape wrote it, so the route location keeps its brackets. */
type HeldSpan = {
  readonly text: string
  readonly escaped: boolean
}

/** A path with spans held out of the separator and segment rules as opaque placeholders. */
type HeldPath = {
  readonly text: string
  readonly spans: readonly HeldSpan[]
}

/** Where a route sits in the tree: its root route file and its parent routes, outermost first. */
type Placement = {
  readonly root: string | null
  readonly parents: readonly RouteUnit[]
}

type FileRoute = {
  readonly file: string
  readonly call: ts.CallExpression
  readonly options: TsNode | null
  readonly lazy: boolean
  readonly ordinal: number
  readonly count: number
}

/** One route as TanStack sees it: the critical file plus its optional `.lazy` companion. */
type RouteUnit = {
  readonly primary: FileRoute
  readonly lazy: FileRoute | null
}

export type RouteLocation = {
  readonly routesDir: string
  /** Separator-agnostic tokens, the reserved `lazy`/`route` tail and a trailing `index` removed. */
  readonly tokens: readonly string[]
  readonly index: boolean
}

const stripRouteExtension = (value: string): string => stripSourceExtension(value)

const withoutReservedTail = (tokens: readonly string[]): readonly string[] =>
  RESERVED_TAIL.reduce<readonly string[]>(
    (rest, reserved) => (rest[rest.length - 1] === reserved ? rest.slice(0, -1) : rest),
    tokens,
  )

const routeTokensOf = (raw: string): readonly string[] =>
  withoutReservedTail(
    stripRouteExtension(raw)
      .split("/")
      .flatMap((part) => part.split(".")),
  )

const holdOut = (path: HeldPath, pattern: RegExp, escaped: boolean): HeldPath => {
  const spans: HeldSpan[] = [...path.spans]
  const text = path.text.replace(pattern, (_match: string, span: string) => {
    spans.push({ text: span, escaped })
    return `\uE000${String(spans.length - 1)}\uE001`
  })
  return { text, spans }
}

const holdEscapes = (raw: string): HeldPath => holdOut({ text: raw, spans: [] }, ESCAPED_SPAN, true)

const plainSpan = ({ text }: HeldSpan): string => text

/** `posts.[_]foo.tsx` and `posts/_foo/` are different routes, so a location keeps the escape's brackets. */
const bracketedSpan = ({ text, escaped }: HeldSpan): string => (escaped ? `[${text}]` : text)

const restoreSpans = (text: string, spans: readonly HeldSpan[], form: (span: HeldSpan) => string = plainSpan): string =>
  text.replace(HELD_SPAN, (_match: string, at: string) => {
    const span = spans[Number(at)]
    return span === undefined ? "" : form(span)
  })

const isHeldToken = (token: string): boolean => token.includes("\uE000")

const convertHeld = ({ text, spans }: HeldPath, routesDir?: string): PathConversion => {
  const { url, extras } = convertTanStackRoutePath(text, routesDir)
  const restore = (value: string): string => restoreSpans(value, spans)
  return {
    url: restore(url),
    extras: {
      ...extras,
      params: extras.params.map((param) => ({ ...param, name: restore(param.name) })),
      droppedGroups: extras.droppedGroups.map(restore),
      pathlessLayers: extras.pathlessLayers.map(restore),
    },
  }
}

const routePathOf = (raw: string, held: HeldPath, routesDir?: string): RoutePath => ({
  conversion: convertHeld(held, routesDir),
  raw,
  tokens: routeTokensOf(held.text),
})

const filenamePathOf = (file: string, routesDir?: string): RoutePath => routePathOf(file, holdEscapes(file), routesDir)

/**
 * The route file's escaped tokens, keyed by their unescaped text. The generator writes `posts.[_]foo.tsx`
 * as `createFileRoute('/posts/_foo')`, which on its own reads as a pathless layout.
 */
const escapedTokensOf = (file: string): ReadonlyMap<string, string> => {
  const held = holdEscapes(file)
  return new Map(
    routeTokensOf(held.text)
      .filter(isHeldToken)
      .map((token) => [restoreSpans(token, held.spans), restoreSpans(token, held.spans, bracketedSpan)] as const),
  )
}

/** Either literal form converts alike: `/posts/[_]foo`, and `/posts/_foo` when the filename escapes `_foo`. */
const literalPathOf = (literal: string, escapedTokens: ReadonlyMap<string, string>): RoutePath => {
  const hinted = literal
    .split("/")
    .map((segment) => escapedTokens.get(segment) ?? segment)
    .join("/")
  return routePathOf(literal, holdOut(holdEscapes(hinted), LITERAL_SPAN, false))
}

/**
 * A route whose path contributes no URL segment of its own is either a PATHLESS LAYOUT (`_authed`,
 * `__root`, a `(group)` with its own `route.tsx`) or an INDEX route (`posts.index.tsx`, whose literal is
 * `/posts/`). Both convert to the parent URL, so the raw path is what separates them: an index route is
 * addressable at that URL, a pathless layout is not addressable at all and is retained with `url: null`.
 */
const isIndexPath = ({ tokens }: RoutePath): boolean =>
  tokens[tokens.length - 1] === "" || tokens[tokens.length - 1] === INDEX_TOKEN

const isRouteGroup = (token: string): boolean => token.startsWith("(") && token.endsWith(")")

const isPathlessPath = ({ tokens }: RoutePath): boolean => {
  const last = tokens.filter((token) => token !== "").at(-1)
  return last !== undefined && (last.startsWith("_") || isRouteGroup(last))
}

/**
 * The route file's position in the `routes/` tree, as TOKENS: both `/` and the dot-notation `.` are
 * separators in this convention, so `_authed/companies/$id.edit.tsx` is four tokens. This is
 * directory bookkeeping for the ancestor walk, distinct from `convertTanStackRoutePath`'s URL
 * conversion. `x.lazy.tsx`, `x/route.tsx` and `x.route.tsx` all locate route `x`. A configured
 * `routesDir` is an exact project-relative prefix; without one, the outermost `routes` directory is the root.
 */
const routesDirIndexOf = (segments: readonly string[], routesDir: string | undefined): number => {
  if (routesDir === undefined) return tanStackRoutesRootIndex(segments.slice(0, -1))
  const prefix = routesDir.split("/")
  return prefix.every((part, at) => segments[at] === part) ? prefix.length - 1 : -1
}

export const routeLocationOf = (filePath: string, routesDir?: string): RouteLocation | null => {
  const segments = filePath.split("/")
  const routesIndex = routesDirIndexOf(segments, routesDir)
  if (routesIndex === -1) return null

  const held = holdEscapes(segments.slice(routesIndex + 1).join("/"))
  const tokens = routeTokensOf(held.text).filter((token) => token !== "")
  const index = tokens[tokens.length - 1] === INDEX_TOKEN
  return {
    routesDir: segments.slice(0, routesIndex + 1).join("/"),
    tokens: (index ? tokens.slice(0, -1) : tokens).map((token) => restoreSpans(token, held.spans, bracketedSpan)),
    index,
  }
}

const locationKey = (routesDir: string, tokens: readonly string[]): string => `${routesDir}|${tokens.join("/")}`

const companionBaseOf = (file: string): string => stripRouteExtension(file).replace(/\.lazy$/, "")

const existingRouteFile = (ctx: Pick<ProjectContext, "exists">, base: string): string | null =>
  ROUTE_EXTENSIONS.map((extension) => `${base}.${extension}`).find((candidate) => ctx.exists(candidate)) ?? null

const ancestorKey = (ref: AncestorRef): string => `${ref.file}|${ref.exportName}|${ref.role}|${ref.splice.kind}`

// ---------------------------------------------------------------------------
// The generated route tree — parentage under virtual file routes
// ---------------------------------------------------------------------------

/** One `const XRoute = XImport.update({ id, path, getParentRoute: () => P })` of the generated tree. */
type TreeNode = {
  readonly id: string
  readonly parent: string
  readonly files: readonly string[]
}

type GeneratedTree = {
  readonly file: string
  readonly nodes: ReadonlyMap<string, TreeNode>
  readonly roots: ReadonlyMap<string, string>
  readonly byFile: ReadonlyMap<string, string>
}

/** A route's line in the generated tree: its root route file and its nodes, outermost first, its own last. */
type TreeLineage = {
  readonly root: string
  readonly nodes: readonly TreeNode[]
}

const callsIn = (ctx: DiscoverContext, node: TsNode): readonly ts.CallExpression[] => {
  const calls: ts.CallExpression[] = []
  walk(node, (candidate) => {
    const call = ctx.ast.asCallExpression(candidate)
    if (call !== null) calls.push(call)
  })
  return calls
}

const methodCallIn = (ctx: DiscoverContext, calls: readonly ts.CallExpression[], method: string): ts.CallExpression | null =>
  calls.find((call) => ctx.ast.asPropertyAccess(call.expression)?.name.text === method) ?? null

const importedFileOf = (ctx: DiscoverContext, file: string, local: string): string | null => {
  const binding = ctx.bindingsFor(file).get(local)
  if (binding === null || binding.kind !== "import") return null
  return ctx.resolveModule(file, binding.module)
}

const treeNodeOf = (
  ctx: DiscoverContext,
  reader: RouteOptionsReader,
  file: string,
  initializer: TsNode,
): TreeNode | null => {
  const calls = callsIn(ctx, initializer)
  const update = methodCallIn(ctx, calls, "update")
  const options = update?.arguments[0] ?? null
  const receiver = ctx.ast.asIdentifier(ctx.ast.asPropertyAccess(update?.expression)?.expression)
  const literalOf = (name: string): string | null =>
    ctx.ast.asStringLiteralLike(reader.memberNamed(options, name)?.value)?.text ?? null
  const getParent = reader.memberNamed(options, "getParentRoute")
  const parent = ctx.ast.asIdentifier(ctx.ast.asArrowFunction(getParent?.value)?.body)
  const id = literalOf("id") ?? literalOf("path")
  if (receiver === null || parent === null || id === null) return null

  const lazy = methodCallIn(ctx, calls, "lazy")?.arguments[0]
  const lazySpec = lazy === undefined ? null : reader.dynamicImportSpec(lazy)
  const files = [
    importedFileOf(ctx, file, receiver.text),
    lazySpec === null ? null : ctx.resolveModule(file, lazySpec),
  ].filter((found): found is string => found !== null)
  return { id, parent: parent.text, files }
}

const declarationsIn = (ctx: DiscoverContext, source: ts.SourceFile): readonly ts.VariableDeclaration[] =>
  source.statements.flatMap((statement) =>
    ctx.ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
  )

/** Files claimed by exactly one node; a file two nodes claim places neither. */
const nodesByFile = (nodes: ReadonlyMap<string, TreeNode>): ReadonlyMap<string, string> => {
  const claims = [...nodes].flatMap(([name, node]) => node.files.map((file) => [file, name] as const))
  const counts = new Map<string, number>()
  claims.forEach(([file]) => counts.set(file, (counts.get(file) ?? 0) + 1))
  return new Map(claims.filter(([file]) => counts.get(file) === 1))
}

const readGeneratedTree = (ctx: DiscoverContext, reader: RouteOptionsReader, file: string): GeneratedTree | null => {
  const source = ctx.exists(file) ? ctx.sourceFile(file) : null
  if (source === null) return null

  const nodes = new Map(
    declarationsIn(ctx, source).flatMap((declaration) => {
      const name = ctx.ast.asIdentifier(declaration.name)?.text
      const node = name === undefined || declaration.initializer === undefined
        ? null
        : treeNodeOf(ctx, reader, file, declaration.initializer)
      return name === undefined || node === null ? [] : [[name, node] as const]
    }),
  )
  const roots = new Map(
    [...nodes.values()].flatMap(({ parent }) => {
      const root = nodes.has(parent) ? null : importedFileOf(ctx, file, parent)
      return root === null ? [] : [[parent, root] as const]
    }),
  )
  return { file, nodes, roots, byFile: nodesByFile(nodes) }
}

const lineageOf = (tree: GeneratedTree, routeFile: string): TreeLineage | null => {
  const climb = (name: string, below: readonly TreeNode[]): TreeLineage | null => {
    const node = tree.nodes.get(name)
    if (node === undefined || below.length > tree.nodes.size) return null
    const line = [node, ...below]
    const root = tree.roots.get(node.parent)
    return root === undefined ? climb(node.parent, line) : { root, nodes: line }
  }
  const own = tree.byFile.get(routeFile)
  return own === undefined ? null : climb(own, [])
}

const withoutTrailingSlash = (path: string): string => path.replace(/\/+$/, "") || "/"

/** The generated tree is current for a route when its ids, joined root-down, spell the route's literal. */
const agreesWithLiteral = (lineage: TreeLineage, literal: string): boolean =>
  withoutTrailingSlash(lineage.nodes.map((node) => node.id).join("")) === withoutTrailingSlash(literal)

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const collectFileRoutes = (
  ctx: DiscoverContext,
  reader: RouteOptionsReader,
  factories: readonly string[],
): readonly FileRoute[] => {
  /**
   * `createFileRoute('/x')({ … })` is two calls. The inner one identifies the route and carries the
   * authoritative literal; the outer one carries the options object.
   */
  const routeCallsIn = (source: ts.SourceFile, file: string) => {
    const calls: { call: ts.CallExpression; lazy: boolean }[] = []
    const optionsFor = new Map<ts.CallExpression, TsNode>()

    walk(source, (node) => {
      const call = ctx.ast.asCallExpression(node)
      if (call === null) return

      const name = reader.calleeName(call, file)
      if (name !== null && factories.includes(name)) {
        calls.push({ call, lazy: name === LAZY_FILE_FACTORY })
        return
      }

      const inner = ctx.ast.asCallExpression(call.expression)
      const innerName = inner === null ? null : reader.calleeName(inner, file)
      if (inner === null || innerName === null || !factories.includes(innerName)) return
      const supplied = call.arguments[0]
      if (supplied !== undefined) optionsFor.set(inner, supplied)
    })

    return calls.map((found) => ({ ...found, options: optionsFor.get(found.call) ?? null }))
  }

  return ctx.glob(SCRIPT_GLOB).flatMap((file): readonly FileRoute[] => {
    // §10.7: `src/routeTree.gen.ts` is generated and re-declares every route.
    // The check runs BEFORE `readFile`, so the generated tree is never even opened.
    if (isExcludedFile(file) || ctx.isGenerated(file)) return []

    const text = ctx.readFile(file)
    if (text === null || !FACTORY_MENTION.test(text)) return []

    const source = ctx.sourceFile(file)
    if (source === null) {
      ctx.nearMiss(file, "file mentioned createFileRoute but did not parse")
      return []
    }

    const calls = routeCallsIn(source, file)
    if (calls.length === 0) ctx.nearMiss(file, "file mentioned createFileRoute but calls no route factory")
    return calls.map((found, ordinal) => ({ file, ...found, ordinal, count: calls.length }))
  })
}

const routesOf = (unit: RouteUnit): readonly FileRoute[] => (unit.lazy === null ? [unit.primary] : [unit.primary, unit.lazy])

/** A `.lazy` file is the code-split half of the route in the same-named critical file, when one exists. */
const groupUnits = (routes: readonly FileRoute[]): readonly RouteUnit[] => {
  const critical = new Map(
    routes.filter((route) => !route.lazy && route.count === 1).map((route) => [companionBaseOf(route.file), route]),
  )
  const lazyFor = new Map(
    routes
      .filter((route) => route.lazy && route.count === 1 && critical.has(companionBaseOf(route.file)))
      .map((route) => [companionBaseOf(route.file), route]),
  )

  return routes.flatMap((route): readonly RouteUnit[] => {
    if (route.lazy && lazyFor.get(companionBaseOf(route.file)) === route) return []
    const lazy = route.lazy || route.count !== 1 ? null : (lazyFor.get(companionBaseOf(route.file)) ?? null)
    return [{ primary: route, lazy }]
  })
}

const NO_ESCAPED_TOKENS: ReadonlyMap<string, string> = new Map()

const NO_ROUTES_DIRECTORY: RoutesDirectory = { dir: undefined, fallbacks: [] }

const reportRoutesDirFallbacks = (ctx: DiscoverContext, { fallbacks }: RoutesDirectory): void =>
  fallbacks.forEach(({ why, file, line }) =>
    ctx.diagnostic({
      severity: "info",
      code: "screens/dynamic-registry",
      message: `the TanStack routes directory configured in '${file}:${String(line)}' is not used: ${why}; route files are placed under their outermost '${ROUTES_SEGMENT}' directory instead`,
      file,
      line,
    }),
  )

const runDiscovery = (ctx: DiscoverContext, options: TanStackRouterOptions): readonly ScreenDraft[] => {
  const reader = createRouteOptionsReader(ctx, guardOptionsOf(options))
  const buildMode = createBuildModeReader(ctx.ts)
  const factories: readonly string[] = options.factories ?? ROUTE_FACTORIES
  const pathlessRoles = options.pathless ?? DEFAULT_PATHLESS_ROLES

  const units = groupUnits(collectFileRoutes(ctx, reader, factories))
  const configs = rootConfigsOf(ctx)
  const virtualRoutes = virtualRoutesEvidence(configs)
  const routesDirectory = virtualRoutes === null ? routesDirectoryOf(ctx, reader, configs) : NO_ROUTES_DIRECTORY
  const routesDir = routesDirectory.dir
  reportRoutesDirFallbacks(ctx, routesDirectory)

  // Under a virtual route config the filename places a route nowhere: no tree position, no cross-check.
  const located = units.map((unit) => ({
    unit,
    location: unit.primary.count === 1 && virtualRoutes === null ? routeLocationOf(unit.primary.file, routesDir) : null,
  }))

  const parentUnits = new Map(
    located.flatMap(({ unit, location }) =>
      location === null || location.index ? [] : [[locationKey(location.routesDir, location.tokens), unit] as const],
    ),
  )

  const indexOwners = new Set(
    located.flatMap(({ location }) =>
      location === null || !location.index ? [] : [locationKey(location.routesDir, location.tokens)],
    ),
  )

  const readLiteralPath = (call: ts.CallExpression, file: string): RoutePath | null => {
    // `ctx.ast` is unwrap-baked (§6.2), so `('/x')`, `'/x' as const` and `'/x' satisfies string` all
    // narrow — a raw `ts.isStringLiteral` on the argument sees a wrapper and falls through to the
    // filename, which is exactly the staleness cross-check going quiet.
    const escapedTokens = virtualRoutes === null ? escapedTokensOf(file) : NO_ESCAPED_TOKENS
    const literal = ctx.ast.asStringLiteralLike(call.arguments[0])
    if (literal !== null) return literalPathOf(literal.text, escapedTokens)

    const flat = ctx.flattenString(call.arguments[0], file)
    if (flat === null || flat.dynamic) return null
    return literalPathOf(flat.value, escapedTokens)
  }

  /** TanStack `Object.assign`s the lazy half's options over the critical file's, so its component wins. */
  const componentRouteOf = (unit: RouteUnit): FileRoute | null =>
    [...routesOf(unit)].reverse().find((route) => reader.componentOf(route.options, route.file).kind !== "none") ??
    null

  const componentFileOf = (unit: RouteUnit): string | null => componentRouteOf(unit)?.file ?? null

  const isServerRoute = (unit: RouteUnit): boolean =>
    componentRouteOf(unit) === null &&
    routesOf(unit).some((route) => reader.memberNamed(route.options, SERVER_ROUTE_OPTION) !== null)

  const routeModuleEntries = (unit: RouteUnit): readonly EntryRef[] =>
    routesOf(unit).map((route) => ({ kind: "file", file: route.file, exportName: ROUTE_EXPORT }))

  /**
   * The page component itself — `component: X`, resolved through imports — not the route module that
   * names it: a `.lazy.tsx` file is two lines of wiring, and walking it renders X as a mere value
   * reference. A route with no readable component keeps its route module(s) as the entry.
   */
  const entriesOf = (unit: RouteUnit): readonly EntryRef[] => {
    const route = componentRouteOf(unit)
    const page = route === null ? null : reader.pageEntryOf(reader.componentOf(route.options, route.file))
    return page === null ? routeModuleEntries(unit) : [page]
  }

  const blocksProduction = (route: FileRoute): boolean => {
    const beforeLoad = reader.memberNamed(route.options, "beforeLoad")
    return beforeLoad !== null && buildMode.blocksProduction(beforeLoad.value)
  }

  const devEvidenceOf = (unit: RouteUnit): readonly Evidence[] =>
    routesOf(unit).flatMap((route): readonly Evidence[] => {
      if (buildMode.isDevGated(route.call)) return [ctx.evidence(DEV_ONLY_EVIDENCE.declared, route.file, route.call)]
      if (blocksProduction(route)) return [ctx.evidence(DEV_ONLY_EVIDENCE.blocked, route.file, route.call)]
      return []
    })

  /**
   * The links one route contributes to its descendants' chains. The whole file is the splice scope
   * (`exportName: ''`): a TanStack route file declares `Route` and its component SEPARATELY, so scoping
   * the `<Outlet/>` search to the `Route` declaration would find nothing (§6.3.1). A route with no
   * component anywhere renders an implicit `<Outlet/>`, which is a TRANSPARENT link; so is the critical
   * file whose component lives in its `.lazy` half — it still runs, so it stays reachable.
   */
  const linksOf = (unit: RouteUnit): readonly AncestorRef[] => {
    const file = componentFileOf(unit)
    if (file === null) return [reader.transparentAt(unit.primary.file, "")]
    const own = reader.outletAncestors({ file, exportName: "" })
    return file === unit.primary.file ? own : [reader.transparentAt(unit.primary.file, ""), ...own]
  }

  const rootOptionsOf = (file: string): { found: boolean; options: TsNode | null } => {
    const source = ctx.sourceFile(file)
    let found = false
    let options: TsNode | null = null
    if (source === null) return { found, options }

    walk(source, (node) => {
      const call = ctx.ast.asCallExpression(node)
      if (found || call === null) return
      const name = reader.calleeName(call, file)
      if (name === ROOT_ROUTE_FACTORIES[0]) {
        found = true
        options = call.arguments[0] ?? null
        return
      }
      const inner = ctx.ast.asCallExpression(call.expression)
      if (inner === null || reader.calleeName(inner, file) !== ROOT_ROUTE_FACTORIES[1]) return
      found = true
      options = call.arguments[0] ?? null
    })
    return { found, options }
  }

  const rootLinks = (file: string): readonly AncestorRef[] => {
    const root = rootOptionsOf(file)
    if (root.found && reader.componentOf(root.options, file).kind === "none")
      return [reader.transparentAt(file, "")]
    return reader.outletAncestors({ file, exportName: "" })
  }

  /** The route files above this one in the `routes/` tree, outermost first (`__root` excluded). */
  const parentsOf = (unit: RouteUnit, location: RouteLocation): readonly RouteUnit[] => {
    const deepest = location.index ? location.tokens.length : location.tokens.length - 1
    return Array.from({ length: Math.max(deepest, 0) }, (_, at) =>
      parentUnits.get(locationKey(location.routesDir, location.tokens.slice(0, at + 1))),
    ).filter((parent): parent is RouteUnit => parent !== undefined && parent !== unit)
  }

  const filenamePlacementOf = (unit: RouteUnit, location: RouteLocation | null): Placement | null =>
    location === null
      ? null
      : {
          root: existingRouteFile(ctx, `${location.routesDir}/${ROOT_ROUTE_BASE}`),
          parents: parentsOf(unit, location),
        }

  const unitsByFile = new Map(units.flatMap((unit) => routesOf(unit).map((route) => [route.file, unit] as const)))

  const unitsOfLineage = (unit: RouteUnit, lineage: TreeLineage): readonly RouteUnit[] | null => {
    const parents = lineage.nodes.slice(0, -1).filter((node) => node.files.length > 0)
    const found = parents.flatMap((node) => {
      const parent = node.files.map((file) => unitsByFile.get(file)).find((candidate) => candidate !== undefined)
      return parent === undefined || parent === unit ? [] : [parent]
    })
    return found.length === parents.length ? found : null
  }

  const treePlacementOf = (tree: GeneratedTree, unit: RouteUnit): Placement | null => {
    if (unit.primary.count !== 1) return null
    const literal = readLiteralPath(unit.primary.call, unit.primary.file)
    const lineage = routesOf(unit)
      .map((route) => lineageOf(tree, route.file))
      .find((candidate) => candidate !== null) ?? null
    if (literal === null || lineage === null || !agreesWithLiteral(lineage, literal.raw)) return null
    const parents = unitsOfLineage(unit, lineage)
    return parents === null ? null : { root: lineage.root, parents }
  }

  const generatedTreeFile = generatedTreeFileOf(configs)
  const generatedTree = virtualRoutes === null ? null : readGeneratedTree(ctx, reader, generatedTreeFile)
  const treePlacements = new Map(
    units.map((unit) => [unit, generatedTree === null ? null : treePlacementOf(generatedTree, unit)] as const),
  )

  const placementOf = (unit: RouteUnit, location: RouteLocation | null): Placement | null =>
    virtualRoutes === null ? filenamePlacementOf(unit, location) : (treePlacements.get(unit) ?? null)

  const chainOf = (unit: RouteUnit, placement: Placement | null): readonly AncestorRef[] => {
    if (placement === null) return []

    const { root } = placement
    const rootChain = root === null || root === unit.primary.file ? [] : rootLinks(root)
    return uniqueBy([...rootChain, ...placement.parents.flatMap(linksOf)], ancestorKey)
  }

  const unitGuards = new Map<RouteUnit, readonly LoaderGuard[]>()

  const guardsOfUnit = (unit: RouteUnit): readonly LoaderGuard[] => {
    const cached = unitGuards.get(unit)
    if (cached !== undefined) return cached
    const guards = routesOf(unit).flatMap((route) => reader.beforeLoadGuardOf(route.options, route.file) ?? [])
    unitGuards.set(unit, guards)
    return guards
  }

  const ownGuardOf = (unit: RouteUnit): InheritedGuard | null =>
    guardsOfUnit(unit).map(ownGuard).find((guard) => guard !== null) ?? null

  const redirectOf = (unit: RouteUnit): string | null =>
    guardsOfUnit(unit).map(redirectOfGuard).find((to) => to !== null) ?? null

  /** The route's own conditional guard, else the nearest guarded route above it (a layout guard covers its children). */
  const inheritedGuardOf = (unit: RouteUnit, placement: Placement | null): InheritedGuard | null => {
    const own = ownGuardOf(unit)
    if (own !== null || placement === null) return own
    const guarded = [...placement.parents].reverse().find((parent) => ownGuardOf(parent) !== null)
    return guarded === undefined ? null : passedGuard(ownGuardOf(guarded), guarded.primary.file)
  }

  /** Dev-only evidence: the route's own gate, else the nearest gated route above it (a child of a gated layout is gated too). */
  const devOnlyEvidence = (unit: RouteUnit, placement: Placement | null): readonly Evidence[] => {
    const own = devEvidenceOf(unit)
    if (own.length > 0 || placement === null) return own
    const gated = placement.parents.find((parent) => devEvidenceOf(parent).length > 0)
    return gated === undefined
      ? []
      : [ctx.evidence(devOnlyNestedEvidence(gated.primary.file), unit.primary.file, unit.primary.call)]
  }

  const layoutEvidence = (unit: RouteUnit, url: string): string => {
    const file = componentFileOf(unit)
    if (file === null) return `layout route: no component (implicit <Outlet/>) and has an index child, which owns '${url}'`
    if (reader.rendersOutlet({ file, exportName: "" }))
      return `layout route: renders <Outlet/> and has an index child, which owns '${url}'`
    return `layout route: has an index child, which owns '${url}'`
  }

  const reportUnplaceable = (route: FileRoute, virtual: Evidence): void =>
    ctx.diagnostic({
      severity: "warning",
      code: "screens/dynamic-registry",
      message: `${route.lazy ? LAZY_FILE_FACTORY : "createFileRoute"} path in '${route.file}' is not a readable literal, and ${virtual.what} (${virtual.file}:${String(virtual.line)}) means the filename does not determine it; the route is skipped`,
      file: route.file,
      line: ctx.lineOf(route.file, route.call),
    })

  const unchainedRoutes = sortedUnique(
    units
      .filter(() => virtualRoutes !== null)
      .filter((unit) => readLiteralPath(unit.primary.call, unit.primary.file) !== null && treePlacements.get(unit) === null)
      .map((unit) => unit.primary.file),
  )

  const reportUnknownChains = (virtual: Evidence): void => {
    if (unchainedRoutes.length === 0) return
    const listed = unchainedRoutes.slice(0, LISTED_ROUTES).map((file) => `'${file}'`).join(", ")
    const more = unchainedRoutes.length > LISTED_ROUTES ? ` and ${String(unchainedRoutes.length - LISTED_ROUTES)} more` : ""
    const why =
      generatedTree === null
        ? `no generated route tree was found at '${generatedTreeFile}'`
        : `'${generatedTreeFile}' does not place them, disagrees with their createFileRoute literal, or places them under a route this source did not read`
    ctx.diagnostic({
      severity: "warning",
      code: "screens/dynamic-registry",
      message: `${virtual.what} (${virtual.file}:${String(virtual.line)}) maps routes in a config this source does not read, and ${why}; their layout chains are unknown, so ${String(unchainedRoutes.length)} route(s) carry no ancestors: ${listed}${more}`,
      file: virtual.file,
      line: virtual.line,
    })
  }

  if (virtualRoutes !== null) reportUnknownChains(virtualRoutes)

  return located.flatMap(({ unit, location }): readonly ScreenDraft[] => {
    const route = unit.primary
    const placement = placementOf(unit, location)
    const file = route.file
    const fromFilename = filenamePathOf(file, routesDir)
    const fromLiteral = readLiteralPath(route.call, file)

    if (fromLiteral === null && virtualRoutes !== null) {
      reportUnplaceable(route, virtualRoutes)
      return []
    }
    const chosen = fromLiteral ?? fromFilename

    if (virtualRoutes === null && fromLiteral !== null && fromLiteral.conversion.url !== fromFilename.conversion.url)
      ctx.diagnostic({
        severity: "warning",
        code: "screens/stale-route-literal",
        message: `createFileRoute('${fromLiteral.raw}') resolves to '${fromLiteral.conversion.url}' but the filename '${file}' implies '${fromFilename.conversion.url}'; the literal wins`,
        file,
        line: ctx.lineOf(file, route.call),
      })

    const pathless = chosen.conversion.extras.pathlessLayers
    const index = isIndexPath(chosen)
    const pathlessLayout = !index && isPathlessPath(chosen)
    // A route that owns an `index` child is that child's LAYOUT, not a second screen at the same URL:
    // TanStack nests the index route under it, and the index child is what is addressable there.
    const parentLayout =
      !index &&
      !pathlessLayout &&
      location !== null &&
      !location.index &&
      indexOwners.has(locationKey(location.routesDir, location.tokens))
    const layout = pathlessLayout || parentLayout
    const apiRoute = !layout && isServerRoute(unit)
    const layerAuth = authOfLayers(pathlessRoles, pathless)
    const guard = inheritedGuardOf(unit, placement)
    const auth = guardedAuth(layerAuth, guard)
    const redirectTo = redirectOf(unit)
    const devOnly = devOnlyEvidence(unit, placement)

    const evidence: Evidence[] = [
      ctx.evidence(
        fromLiteral === null
          ? "tanstack route file (path from the filename; the literal is not readable)"
          : `tanstack route ${route.lazy ? LAZY_FILE_FACTORY : "createFileRoute"}('${fromLiteral.raw}')`,
        file,
        route.call,
      ),
      ...pathless.map((layer) => ctx.evidence(`pathless segment '${layer}' (no URL segment)`, file, route.call)),
      ...(virtualRoutes === null
        ? []
        : [
            ctx.evidence(
              `${virtualRoutes.what} (${virtualRoutes.file}:${String(virtualRoutes.line)}): the filename does not determine the path and is not cross-checked`,
              file,
              route.call,
            ),
          ]),
      ...(virtualRoutes !== null && placement !== null
        ? [ctx.evidence(`layout chain from the generated route tree '${generatedTreeFile}'`, file, route.call)]
        : []),
    ]

    if (unit.lazy !== null)
      evidence.push(ctx.evidence(`lazy companion '${unit.lazy.file}'`, unit.lazy.file, unit.lazy.call))
    if (parentLayout) evidence.push(ctx.evidence(layoutEvidence(unit, chosen.conversion.url), file, route.call))
    if (apiRoute) evidence.push(ctx.evidence("tanstack start server route (server handlers, no component)", file, route.call))
    if (!apiRoute && componentFileOf(unit) === null)
      evidence.push(ctx.evidence("no component: renders an implicit <Outlet/>", file, route.call))

    evidence.push(...devOnly, ...reader.optionEvidence(route.options, file, route.call))
    evidence.push(...guardAuthTexts(layerAuth, guard).map((text) => ctx.evidence(text, file, route.call)))
    reader.reportSearchParams(route.options, file, file, route.call)

    return [{
      localId: route.count === 1 ? ctx.localId(file) : ctx.localId(file, { ordinal: route.ordinal, node: route.call }),
      activations: layout
        ? []
        : [
            {
              kind: "url",
              template: chosen.conversion.url,
              params: chosen.conversion.extras.params.map((param) => param.name),
            },
          ],
      entries: entriesOf(unit),
      ancestors: apiRoute ? [] : chainOf(unit, placement),
      evidence,
      ...(layout ? { kindTag: "layout" } : {}),
      ...(apiRoute ? { kindTag: "apiRoute" } : {}),
      ...(auth === null ? {} : { auth }),
      ...(redirectTo === null ? {} : { redirectTo }),
      ...(devOnly.length > 0 ? { devOnly: true } : {}),
    }]
  })
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

const ROUTE_FACTORY_MENTION = new RegExp(`${FACTORY_MENTION.source}|${CODE_ROUTE_MENTION.source}`)

/**
 * A factory-named callee the app declares as a wrapper around the real TanStack factory creates a real
 * route, but neither discovery reads through it; each call is named here instead of dropped silently.
 */
const reportFactoryWrappers = (ctx: DiscoverContext, reader: RouteOptionsReader): void => {
  const files = ctx
    .glob(SCRIPT_GLOB)
    .filter((file) => !isNonAppFile(file) && !ctx.isGenerated(file) && ROUTE_FACTORY_MENTION.test(ctx.readFile(file) ?? ""))
  files.forEach((file) => {
    const source = ctx.sourceFile(file)
    if (source === null) return
    callsIn(ctx, source).forEach((call) => {
      const wrapper = reader.wrappedFactoryOf(call, file)
      if (wrapper === null) return
      ctx.diagnostic({
        severity: "warning",
        code: "screens/dynamic-registry",
        message: `'${wrapper.name}' is an app wrapper declared in '${wrapper.file}' around TanStack ${wrapper.factory}; the route this call creates is not read, so it is missing from the map`,
        file,
        line: ctx.lineOf(file, call),
      })
    })
  })
}

const discoverAll = (ctx: DiscoverContext, options: TanStackRouterOptions): readonly ScreenDraft[] => {
  const reader = createRouteOptionsReader(ctx, guardOptionsOf(options))
  const drafts = [
    ...runDiscovery(ctx, options),
    ...discoverCodeRoutes(ctx, reader, { pathless: options.pathless ?? DEFAULT_PATHLESS_ROLES }),
  ]
  reportFactoryWrappers(ctx, reader)
  return drafts
}

export const createTanStackRouterSource = (options: TanStackRouterOptions = {}): ScreenSource => ({
  name: SOURCE_NAME,
  detect: detectTanStackRouter,
  discover: (ctx) => discoverAll(ctx, options),
})

export const createTanStackRouterAdapter = (options: TanStackRouterOptions = {}): Adapter => ({
  name: SOURCE_NAME,
  screens: [createTanStackRouterSource(options)],
})
