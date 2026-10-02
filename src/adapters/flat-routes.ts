import { globToRegExp } from "../core/host.js"
import { byCodepoint, sortBy } from "../core/order.js"
import { convertFlatRouteName, normalizeUrl, splitFlatRouteName } from "../core/url.js"
import type ts from "typescript"
import type { FlatRoutesConvention, FlatRoutesRequest, ReadFlatRoutes, RouteNode } from "./route-config.js"
import type { DiscoverContext } from "./types.js"

const CODE = "screens/unsupported-router-style"

/** remix-flat-routes options this reader cannot honour, with the default each may safely repeat. */
const UNSUPPORTED_OPTIONS = {
  paramPrefixChar: "$",
  nestedDirectoryChar: "+",
  routeRegex: null,
} as const satisfies Record<string, string | null>

const EXTENSIONS = {
  "react-router": ["tsx", "ts", "jsx", "js"],
  "remix-flat-routes": ["tsx", "ts", "jsx", "js", "md", "mdx"],
} as const satisfies Record<FlatRoutesConvention, readonly string[]>

const FLATTEN_SUFFIX = "+"

const INDEX_FILE = "_index"

const HYBRID_ROUTE_FILE = /^(?:index|route|layout|page|_[^/]*|.*\.route)$/

/** Lower wins when two files claim one id: a folder's `route` beats a direct file, which beats `index`. */
const FILE_RANK = { route: 0, file: 1, index: 2 } as const

type FileRank = keyof typeof FILE_RANK

type Candidate = {
  readonly id: string
  readonly file: string
  readonly rank: FileRank
}

type FlatRoute = Candidate & {
  readonly path: string | null
  readonly index: boolean
  readonly parent: string | null
}

const joinDir = (...parts: readonly string[]): string =>
  parts
    .flatMap((part) => part.split("/"))
    .filter((part) => part !== "" && part !== ".")
    .join("/")

const stripExtension = (name: string, extensions: readonly string[]): string | null => {
  const extension = extensions.find((candidate) => name.endsWith(`.${candidate}`))
  return extension === undefined ? null : name.slice(0, -extension.length - 1)
}

const unflattened = (dir: string): string => (dir.endsWith(FLATTEN_SUFFIX) ? dir.slice(0, -1) : dir)

const prefixOf = (dirs: readonly string[]): string => dirs.map(unflattened).join(".")

const reactRouterCandidate = (dirs: readonly string[], name: string, file: string): Candidate | null => {
  if (dirs.length === 0) return { id: name, file, rank: "file" }
  if (dirs.length !== 1 || (name !== "route" && name !== "index")) return null
  return { id: dirs[0] ?? "", file, rank: name }
}

/** Inside a `+` folder a trailing `_`-segment (`_layout`, `settings._layout`) is dropped, so the file becomes the route of what precedes it. */
const isTrailingLayoutSegment = (segment: string): boolean => segment.startsWith("_") && segment !== INDEX_FILE

const remixFlatCandidate =(dirs: readonly string[], name: string, file: string): Candidate | null => {
  if (dirs.length === 0) return { id: name, file, rank: "file" }
  const prefix = prefixOf(dirs)
  if (!(dirs[dirs.length - 1] ?? "").endsWith(FLATTEN_SUFFIX)) {
    if (!HYBRID_ROUTE_FILE.test(name)) return null
    return { id: prefix, file, rank: name === "index" ? "index" : "route" }
  }
  const segments = splitFlatRouteName(`${prefix}.${name}`)
  if (!isTrailingLayoutSegment(segments.at(-1) ?? "")) return { id: segments.join("."), file, rank: "file" }
  return { id: segments.slice(0, -1).join("."), file, rank: "route" }
}

const CANDIDATE_OF = {
  "react-router": reactRouterCandidate,
  "remix-flat-routes": remixFlatCandidate,
} as const

const isIgnored = (matchers: readonly RegExp[], paths: readonly string[]): boolean =>
  matchers.some((matcher) => paths.some((candidate) => matcher.test(candidate)))

const candidatesOf = (ctx: DiscoverContext, request: FlatRoutesRequest): readonly Candidate[] => {
  const routesRoot = joinDir(request.appDirectory, request.rootDirectory)
  const extensions = EXTENSIONS[request.convention]
  const appRoot = joinDir(request.appDirectory)
  const ignored = request.ignoredRouteFiles.map(globToRegExp)
  return ctx.glob(`${routesRoot}/**/*.{${extensions.join(",")}}`).flatMap((file) => {
    const rel = file.slice(routesRoot.length + 1)
    const underApp = appRoot === "" ? file : file.slice(appRoot.length + 1)
    if (isIgnored(ignored, [rel, underApp, file])) return []
    const parts = rel.split("/")
    const name = stripExtension(parts[parts.length - 1] ?? "", extensions)
    if (name === null) return []
    const candidate = CANDIDATE_OF[request.convention](parts.slice(0, -1), name, file)
    return candidate === null ? [] : [candidate]
  })
}

const byRankThenFile = (a: Candidate, b: Candidate): number =>
  FILE_RANK[a.rank] - FILE_RANK[b.rank] || byCodepoint(a.file, b.file)

const groupById = (candidates: readonly Candidate[]): ReadonlyMap<string, readonly Candidate[]> =>
  candidates.reduce((groups, candidate) => {
    groups.set(candidate.id, [...(groups.get(candidate.id) ?? []), candidate])
    return groups
  }, new Map<string, Candidate[]>())

const reportShadowed = (ctx: DiscoverContext, winner: Candidate, losers: readonly Candidate[]): void => {
  losers.forEach((loser) =>
    ctx.diagnostic({
      severity: "info",
      code: CODE,
      message: `Flat route id '${winner.id}' is claimed by both '${winner.file}' and '${loser.file}'; '${winner.file}' wins and '${loser.file}' is not read as a route`,
      file: loser.file,
      line: 1,
    }),
  )
}

const uniqueIds = (ctx: DiscoverContext, candidates: readonly Candidate[]): readonly Candidate[] =>
  [...groupById(candidates).values()].flatMap((group) => {
    const [winner, ...losers] = [...group].sort(byRankThenFile)
    if (winner === undefined) return []
    reportShadowed(ctx, winner, losers)
    return [winner]
  })

/** The longest other id that prefixes `id` at a segment boundary, never reaching past a `seg_` break. */
const parentOf = (id: string, nestingBreaks: readonly number[], ids: ReadonlySet<string>): string | null => {
  const segments = splitFlatRouteName(id)
  const longest = Math.min(segments.length - 1, ...nestingBreaks)
  const lengths = Array.from({ length: Math.max(longest, 0) }, (_unused, at) => longest - at)
  const found = lengths.map((length) => segments.slice(0, length).join(".")).find((prefix) => ids.has(prefix))
  return found ?? null
}

const isPathless = (id: string, index: boolean): boolean =>
  !index && (splitFlatRouteName(id).at(-1) ?? "").startsWith("_")

const withBasePath = (url: string, basePath: string | undefined): string =>
  basePath === undefined ? url : normalizeUrl(`/${basePath}/${url}`)

const reportOptionalStatics = (ctx: DiscoverContext, file: string, statics: readonly string[]): void => {
  if (statics.length === 0) return
  ctx.diagnostic({
    severity: "info",
    code: CODE,
    message: `Flat route '${file}' has optional static segment(s) ${statics.map((value) => `'(${value})'`).join(", ")}; the route is mapped without them`,
    file,
    line: 1,
  })
}

const flatRoutesOf = (
  ctx: DiscoverContext,
  candidates: readonly Candidate[],
  basePath: string | undefined,
): readonly FlatRoute[] => {
  const ids = new Set(candidates.map((candidate) => candidate.id))
  return candidates.map((candidate) => {
    const conversion = convertFlatRouteName(candidate.id)
    reportOptionalStatics(ctx, candidate.file, conversion.extras.optionalStatics ?? [])
    return {
      ...candidate,
      path: isPathless(candidate.id, conversion.index) ? null : withBasePath(conversion.url, basePath),
      index: conversion.index,
      parent: parentOf(candidate.id, conversion.nestingBreaks, ids),
    }
  })
}

const reportDuplicateUrl = (ctx: DiscoverContext, kept: FlatRoute, dropped: FlatRoute): void => {
  ctx.diagnostic({
    severity: "info",
    code: CODE,
    message: `Flat routes '${kept.file}' and '${dropped.file}' both resolve to '${kept.path ?? ""}'; '${kept.file}' is kept`,
    file: dropped.file,
    line: 1,
  })
}

/** Two leaf routes with one URL: the first id by code point is kept, the rest are dropped. */
const withoutDuplicateLeaves = (ctx: DiscoverContext, routes: readonly FlatRoute[]): readonly FlatRoute[] => {
  const parents = new Set(routes.map((route) => route.parent))
  const keptByUrl = new Map<string, FlatRoute>()
  return sortBy(routes, (route) => route.id).filter((route) => {
    if (route.path === null || parents.has(route.id)) return true
    const kept = keptByUrl.get(route.path)
    if (kept === undefined) {
      keptByUrl.set(route.path, route)
      return true
    }
    reportDuplicateUrl(ctx, kept, route)
    return false
  })
}

const treeOf = (routes: readonly FlatRoute[], convention: FlatRoutesConvention, parent: string | null): readonly RouteNode[] =>
  routes
    .filter((route) => route.parent === parent)
    .map((route) => ({
      file: route.file,
      path: route.path,
      index: route.index,
      id: route.id,
      children: treeOf(routes, convention, route.id),
      declaredAt: { file: route.file, line: 1 },
      evidence: [`flat route file ${route.file} (${convention})`],
    }))

const memberName = (ctx: DiscoverContext, member: ts.ObjectLiteralElementLike): string | null => {
  if (member.name === undefined) return null
  return ctx.ast.asIdentifier(member.name)?.text ?? ctx.ast.asStringLiteralLike(member.name)?.text ?? null
}

/** A member keeps the default only as a literal string equal to it; any `routeRegex` is unsupported. */
const isNonDefault = (ctx: DiscoverContext, member: ts.ObjectLiteralElementLike, fallback: string | null): boolean => {
  if (fallback === null || !ctx.ts.isPropertyAssignment(member)) return true
  return ctx.ast.asStringLiteralLike(member.initializer)?.text !== fallback
}

const isUnsupportedOption = (name: string): name is keyof typeof UNSUPPORTED_OPTIONS =>
  Object.hasOwn(UNSUPPORTED_OPTIONS, name)

const unsupportedOptionsOf =(ctx: DiscoverContext, options: ts.ObjectLiteralExpression | null): readonly string[] =>
  (options?.properties ?? []).flatMap((member) => {
    const name = memberName(ctx, member)
    if (name === null || !isUnsupportedOption(name)) return []
    return isNonDefault(ctx, member, UNSUPPORTED_OPTIONS[name]) ? [name] : []
  })

const reportUnsupportedOptions = (ctx: DiscoverContext, request: FlatRoutesRequest, names: readonly string[]): void => {
  ctx.diagnostic({
    severity: "warning",
    code: CODE,
    message: `${request.convention} option(s) ${names.map((name) => `'${name}'`).join(", ")} are set to non-default values; no flat routes are read from '${joinDir(request.appDirectory, request.rootDirectory)}'`,
    file: request.declaredAt.file,
    line: request.declaredAt.line,
  })
}

/**
 * React Router `flatRoutes()`, the Remix v2 default convention and remix-flat-routes → the route tree
 * below `root.tsx` (which the caller adds). Flat nodes carry ABSOLUTE paths: a flat route id spells its
 * whole URL. Children are sorted by id code point.
 */
export const readFlatRoutes =
  (ctx: DiscoverContext): ReadFlatRoutes =>
  (request) => {
    const unsupported = unsupportedOptionsOf(ctx, request.options)
    if (unsupported.length > 0) {
      reportUnsupportedOptions(ctx, request, unsupported)
      return []
    }
    const candidates = uniqueIds(ctx, sortBy(candidatesOf(ctx, request), (candidate) => candidate.file))
    const routes = withoutDuplicateLeaves(ctx, flatRoutesOf(ctx, candidates, request.basePath))
    return treeOf(routes, request.convention, null)
  }
