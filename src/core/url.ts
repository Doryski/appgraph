import { stripSourceExtension } from "./extensions.js"

export type UrlParam = {
  readonly name: string
  readonly catchAll: boolean
  readonly optional: boolean
}

export type ConversionExtras = {
  readonly params: readonly UrlParam[]
  readonly droppedGroups: readonly string[]
  readonly pathlessLayers: readonly string[]
  /** Next.js `_folder` segments: private folders opt their whole subtree out of routing. */
  readonly privateFolders: readonly string[]
  /** Flat-route `(seg)` optional static segments: kept out of the URL, reported for the caller. */
  readonly optionalStatics?: readonly string[]
}

export type PathConversion = {
  readonly url: string
  readonly extras: ConversionExtras
}

const EMPTY_EXTRAS: ConversionExtras = { params: [], droppedGroups: [], pathlessLayers: [], privateFolders: [] }

/** `:id?` or `en?` closing a segment is an OPTIONAL-SEGMENT marker, not the start of a query string. */
const isOptionalMarker = (path: string, index: number): boolean =>
  /(?::[\w-]+|(?:^|\/)[\w-]+)$/.test(path.slice(0, index)) && /^(?:\/|$)/.test(path.slice(index + 1))

const stripQuery = (path: string): string => {
  let index = path.indexOf("?")
  while (index !== -1 && isOptionalMarker(path, index)) index = path.indexOf("?", index + 1)
  return index === -1 ? path : path.slice(0, index)
}

/**
 * Strips query and hash, collapses repeated slashes and drops a trailing slash. An optional param
 * keeps its marker (`/users/:id?/edit`): the `?` closing a `:param` segment is path syntax.
 */
export const normalizeUrl = (raw: string): string => {
  const collapsed = stripQuery(raw.split("#")[0] ?? "").replace(/\/{2,}/g, "/")
  if (collapsed.length > 1 && collapsed.endsWith("/")) return collapsed.slice(0, -1)
  return collapsed
}

export const joinUrl = (parent: string | null, own: string | null): string | null => {
  if (own === null) return parent
  if (own.startsWith("/")) return normalizeUrl(own)
  return normalizeUrl(`${parent ?? ""}/${own}`)
}

const WHOLE_SEGMENT_PARAM = /^:([\w-]+)\??$/

const paramsOfSegment = (segment: string): readonly string[] => {
  const whole = WHOLE_SEGMENT_PARAM.exec(segment)?.[1]
  if (whole !== undefined) return [whole]
  return [...segment.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1] ?? "")
}

export const paramsOf = (url: string): readonly string[] => url.split("/").flatMap(paramsOfSegment)

const escapeRegExpSegment = (segment: string): string => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export type CatchAllOptions = {
  /**
   * Whether a `*` catch-all also matches its base path (`/docs/*` ↔ `/docs`). True for react-router
   * `*`, TanStack `$` and Next `[[...slug]]`; false only for a Next required `[...slug]`.
   */
  readonly catchAllOptional?: boolean
}

const catchAllPiece = (options: CatchAllOptions): string =>
  options.catchAllOptional === false ? "/.*" : "(?:/.*)?"

const EMBEDDED_PARAM = /(:[A-Za-z0-9_]+)/

const embeddedParamPattern = (segment: string): string =>
  segment
    .split(EMBEDDED_PARAM)
    .map((part) => (EMBEDDED_PARAM.test(part) ? "[^/]+" : escapeRegExpSegment(part)))
    .join("")

const OPTIONAL_PARAM_SEGMENT = /^:[\w-]+\?$/

const OPTIONAL_STATIC_SEGMENT = /^[\w-]+\?$/

const patternPiece = (segment: string, options: CatchAllOptions): string => {
  if (OPTIONAL_PARAM_SEGMENT.test(segment)) return "(?:/[^/]+)?"
  if (OPTIONAL_STATIC_SEGMENT.test(segment)) return `(?:/${escapeRegExpSegment(segment.slice(0, -1))})?`
  if (segment.startsWith(":")) return "/[^/]+"
  if (segment === "*") return catchAllPiece(options)
  return `/${embeddedParamPattern(segment)}`
}

export const patternToRegex = (pattern: string, options: CatchAllOptions = {}): RegExp => {
  const [first = "", ...rest] = pattern.split("/")
  const pieces = rest.map((segment) => patternPiece(segment, options)).join("")
  return new RegExp(`^${escapeRegExpSegment(first)}${pieces}$`)
}

export type RouteLike = CatchAllOptions & {
  readonly url: string
}

type RouteCandidate = {
  readonly url: string
  readonly regex: RegExp
  readonly tier: number
  readonly ranks: readonly number[]
}

// A pattern's specificity tier: fully static (0), a named `:param` segment (1), a `*` catch-all
// segment anywhere (2, least specific — tried last against the probe URL).
const routeTier = (url: string): number => {
  if (url.split("/").some((segment) => segment === "*")) return 2
  if (/:[A-Za-z0-9_]+/.test(url)) return 1
  if (url.split("/").some((segment) => OPTIONAL_STATIC_SEGMENT.test(segment))) return 1
  return 0
}

const SEGMENT_RANK = { static: 0, optionalStatic: 1, param: 2, optionalParam: 3, catchAll: 4 } as const

const segmentRank = (segment: string): number => {
  if (segment === "*") return SEGMENT_RANK.catchAll
  if (OPTIONAL_PARAM_SEGMENT.test(segment)) return SEGMENT_RANK.optionalParam
  if (segment.includes(":")) return SEGMENT_RANK.param
  if (OPTIONAL_STATIC_SEGMENT.test(segment)) return SEGMENT_RANK.optionalStatic
  return SEGMENT_RANK.static
}

const segmentRanks = (url: string): readonly number[] =>
  url
    .split("/")
    .filter((segment) => segment !== "")
    .map(segmentRank)

const staticCount = (ranks: readonly number[]): number => ranks.filter((rank) => rank === SEGMENT_RANK.static).length

const compareRanks = (a: readonly number[], b: readonly number[]): number => {
  const at = a.findIndex((rank, index) => rank !== b[index])
  if (at === -1) return a.length - b.length
  return at >= b.length ? 1 : (a[at] ?? 0) - (b[at] ?? 0)
}

const compareText = (a: string, b: string): number => {
  if (a === b) return 0
  return a < b ? -1 : 1
}

const compareCandidates = (a: RouteCandidate, b: RouteCandidate): number =>
  a.tier - b.tier ||
  staticCount(b.ranks) - staticCount(a.ranks) ||
  compareRanks(a.ranks, b.ranks) ||
  compareText(a.url, b.url)

export const createRouteMatcher = (routes: readonly RouteLike[]): ((url: string) => string | null) => {
  // A route whose ENTIRE pattern is the bare catch-all
  // `/*` is excluded from the candidate set outright, so a top-level "everything else" route never
  // swallows a navigation target that should have resolved to "no match".
  const eligible = routes.filter((route) => route.url !== "/*")
  const candidates: readonly RouteCandidate[] = eligible.map((route) => ({
    url: route.url,
    regex: patternToRegex(route.url, route),
    tier: routeTier(route.url),
    ranks: segmentRanks(route.url),
  }))
  const ordered = [...candidates].sort(compareCandidates)

  return (url: string): string | null => {
    const exact = candidates.find((candidate) => candidate.url === url)
    if (exact) return exact.url

    const probe = url.replace(/:param/g, "value")
    return ordered.find((candidate) => candidate.regex.test(probe))?.url ?? null
  }
}

const NEXT_APP_SEGMENT = "app"

export const nextAppRootIndex = (dirSegments: readonly string[]): number => dirSegments.indexOf(NEXT_APP_SEGMENT)

type NextSegmentResult = {
  readonly segment: string | null
  readonly param?: UrlParam
  readonly droppedGroup?: string
  readonly privateFolder?: string
}

const ESCAPED_UNDERSCORE = /^%5F/i

/** The bracket rules App and Pages Router share: `[[...n]]`, `[...n]` and `[n]`; anything else is literal. */
const convertNextBracketSegment = (raw: string): NextSegmentResult => {
  if (raw.startsWith("[[...") && raw.endsWith("]]")) {
    const name = raw.slice(5, -2)
    return { segment: "*", param: { name, catchAll: true, optional: true } }
  }
  if (raw.startsWith("[...") && raw.endsWith("]")) {
    const name = raw.slice(4, -1)
    return { segment: "*", param: { name, catchAll: true, optional: false } }
  }
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const name = raw.slice(1, -1)
    return { segment: `:${name}`, param: { name, catchAll: false, optional: false } }
  }
  return { segment: raw }
}

const convertNextSegment = (raw: string): NextSegmentResult => {
  if (raw.startsWith("_")) return { segment: null, privateFolder: raw }
  if (ESCAPED_UNDERSCORE.test(raw)) return { segment: raw.replace(ESCAPED_UNDERSCORE, "_") }
  if (raw.startsWith("(") && raw.endsWith(")")) {
    return { segment: null, droppedGroup: raw.slice(1, -1) }
  }
  return convertNextBracketSegment(raw)
}

const present = <T>(value: T | undefined): readonly T[] => (value === undefined ? [] : [value])

const urlOfSegments = (segments: readonly (string | null)[]): string =>
  normalizeUrl(`/${segments.filter((segment) => segment !== null).join("/")}`)

const conversionOfNextSegments = (results: readonly NextSegmentResult[]): PathConversion => ({
  url: urlOfSegments(results.map((result) => result.segment)),
  extras: {
    params: results.flatMap((result) => present(result.param)),
    droppedGroups: results.flatMap((result) => present(result.droppedGroup)),
    pathlessLayers: [],
    privateFolders: results.flatMap((result) => present(result.privateFolder)),
  },
})

/**
 * Next.js App Router file path → canonical URL. Takes the directory chain between the outermost `app/`
 * segment and the leaf filename (`page.tsx` / `route.ts` — the distinction is the caller's to make). `(group)` segments are dropped from the URL and reported in `droppedGroups` so the
 * caller can still record which layout groups applied. A `_folder` is PRIVATE — it and everything
 * under it is opted out of routing, reported in `privateFolders` for the caller to skip — while
 * `%5Ffolder` is the escape for a real URL segment starting with `_`.
 */
export const convertNextAppPath = (filePath: string): PathConversion => {
  const segments = filePath.split("/")
  const appIndex = nextAppRootIndex(segments.slice(0, -1))
  const dirSegments = appIndex === -1 ? segments.slice(0, -1) : segments.slice(appIndex + 1, -1)
  return conversionOfNextSegments(dirSegments.map(convertNextSegment))
}

export const NEXT_PAGES_ROOTS = ["pages", "src/pages"] as const

export const NEXT_DEFAULT_PAGE_EXTENSIONS = ["tsx", "jsx", "ts", "js"] as const

/**
 * Next.js Pages Router path under the pages root, extension already stripped → canonical URL. A leaf
 * `index` is the folder's own URL; only the bracket rules apply, so `_x`, `(x)` and `api` stay literal
 * (special files like `_app` are the caller's to skip).
 */
export const convertNextPagesPath = (relUnderRoot: string): PathConversion => {
  const segments = relUnderRoot.split("/").filter((segment) => segment !== "")
  const routed = segments[segments.length - 1] === "index" ? segments.slice(0, -1) : segments
  return conversionOfNextSegments(routed.map(convertNextBracketSegment))
}

const pagesRootRest = (file: string): string | null => {
  const root = NEXT_PAGES_ROOTS.find((candidate) => file.startsWith(`${candidate}/`))
  return root === undefined ? null : file.slice(root.length + 1)
}

/** Strips the longest `.ext` in `extensions` (Next `pageExtensions`, with or without a leading dot). */
const stripPageExtension = (file: string, extensions: readonly string[]): string | null => {
  const suffixes = extensions
    .map((extension) => `.${extension.replace(/^\./, "")}`)
    .sort((a, b) => b.length - a.length)
  const suffix = suffixes.find((candidate) => file.length > candidate.length && file.endsWith(candidate))
  return suffix === undefined ? null : file.slice(0, -suffix.length)
}

/**
 * A project-relative Next.js Pages Router file (`pages/…` or `src/pages/…`) → canonical URL, or `null`
 * when the file is outside a pages root or carries none of the page extensions.
 */
export const convertNextPagesFile = (
  file: string,
  extensions: readonly string[] = NEXT_DEFAULT_PAGE_EXTENSIONS,
): PathConversion | null => {
  const rest = pagesRootRest(file)
  if (rest === null) return null
  const route = stripPageExtension(rest, extensions)
  return route === null ? null : convertNextPagesPath(route)
}

const isRequiredCatchAll = (param: UrlParam): boolean => param.catchAll && !param.optional

const reproducesRequiredCatchAll = (template: string, conversion: PathConversion | null): boolean =>
  conversion !== null && conversion.url === template && conversion.extras.params.some(isRequiredCatchAll)

/**
 * Whether a screen's `*` is a Next.js REQUIRED catch-all (`[...slug]`, which never matches its base
 * path). Read back from the entry file: only a file whose App (then Pages) Router conversion reproduces
 * the screen's template exactly counts, so a react-router or TanStack screen can never be mistaken for one.
 */
export const isRequiredNextCatchAll = (template: string, file: string): boolean =>
  reproducesRequiredCatchAll(template, convertNextAppPath(file)) ||
  reproducesRequiredCatchAll(template, convertNextPagesFile(file))

const TANSTACK_ROUTES_SEGMENT = "routes"

export const tanStackRoutesRootIndex = (dirSegments: readonly string[]): number =>
  dirSegments.indexOf(TANSTACK_ROUTES_SEGMENT)

const stripKnownExtension = (name: string): string => stripSourceExtension(name)

type TanStackSegment = {
  readonly segment: string
  readonly params: readonly UrlParam[]
}

const TANSTACK_SPLAT_TOKENS: readonly string[] = ["$", "{$}"]

const TANSTACK_BRACED_PARAM = /\{(-?)\$([A-Za-z0-9_]+)\}/g

const bracedParamsOf = (token: string): readonly UrlParam[] =>
  [...token.matchAll(TANSTACK_BRACED_PARAM)].map((match) => ({
    name: match[2] ?? "",
    catchAll: false,
    optional: match[1] === "-",
  }))

const convertBracedSegment = (token: string): TanStackSegment => ({
  segment: token.replace(TANSTACK_BRACED_PARAM, (_match, _optional: string, name: string) => `:${name}`),
  params: bracedParamsOf(token),
})

/**
 * `$` is a catch-all, `$id` a param, `{-$id}` an optional param — written `:id?`, the same marker an
 * optional react-router param keeps. A braced param inside a segment (`user-{$id}.json`) embeds `:id`
 * in it; anything else is a literal segment.
 */
const convertTanStackParamSegment = (token: string): TanStackSegment => {
  if (TANSTACK_SPLAT_TOKENS.includes(token))
    return { segment: "*", params: [{ name: "", catchAll: true, optional: true }] }
  const optional = /^\{-\$([A-Za-z0-9_]+)\}$/.exec(token)
  if (optional?.[1] !== undefined)
    return { segment: `:${optional[1]}?`, params: [{ name: optional[1], catchAll: false, optional: true }] }
  if (token.startsWith("$")) {
    const name = token.slice(1)
    return { segment: `:${name}`, params: [{ name, catchAll: false, optional: false }] }
  }
  return convertBracedSegment(token)
}

const TANSTACK_RESERVED_TAIL = ["lazy", "route"] as const

const withoutReservedTail = (tokens: readonly string[]): readonly string[] =>
  TANSTACK_RESERVED_TAIL.reduce<readonly string[]>(
    (rest, reserved) => (rest[rest.length - 1] === reserved ? rest.slice(0, -1) : rest),
    tokens,
  )

/**
 * The path below the routes directory. The default is the outermost `routes` directory in the path;
 * a configured, project-relative `routesDir` is an exact prefix. A path outside it converts whole.
 */
const routeSegmentsUnder = (segments: readonly string[], routesDir: string): readonly string[] => {
  if (routesDir === TANSTACK_ROUTES_SEGMENT) {
    const routesIndex = tanStackRoutesRootIndex(segments.slice(0, -1))
    return routesIndex === -1 ? segments : segments.slice(routesIndex + 1)
  }
  const prefix = routesDir.split("/")
  return prefix.every((part, at) => segments[at] === part) ? segments.slice(prefix.length) : segments
}

/**
 * TanStack Router file path → canonical URL. Both `/` (real directories) and `.` (dot-notation
 * filename segments) are path separators; they are flattened into one token list before
 * conversion. A leading-underscore token is a pathless layer — dropped from the URL, reported in
 * `pathlessLayers` — a `(group)` token is a route group, dropped and reported in `droppedGroups`, a
 * trailing `_` un-nests a segment without renaming it, and the reserved tail tokens `lazy`, `route`
 * and `index` are dropped (`x.lazy.tsx` and `x/route.tsx` configure `x` itself).
 */
export const convertTanStackRoutePath = (filePath: string, routesDir: string = TANSTACK_ROUTES_SEGMENT): PathConversion => {
  const rest = routeSegmentsUnder(filePath.split("/"), routesDir)

  const tokens = withoutReservedTail(
    rest.flatMap((part, index) => {
      const cleaned = index === rest.length - 1 ? stripKnownExtension(part) : part
      return cleaned.split(".")
    }),
  )

  const params: UrlParam[] = []
  const pathlessLayers: string[] = []
  const droppedGroups: string[] = []
  const urlSegments: string[] = []

  tokens.forEach((token, index) => {
    if (token === "") return
    if (token.startsWith("_")) {
      pathlessLayers.push(token)
      return
    }
    if (token.startsWith("(") && token.endsWith(")")) {
      droppedGroups.push(token.slice(1, -1))
      return
    }
    if (token === "index" && index === tokens.length - 1) return
    const converted = convertTanStackParamSegment(token.length > 1 ? token.replace(/_$/, "") : token)
    params.push(...converted.params)
    urlSegments.push(converted.segment)
  })

  return {
    url: normalizeUrl(`/${urlSegments.join("/")}`),
    extras: { params, droppedGroups, pathlessLayers, privateFolders: [] },
  }
}

/**
 * A code-based route's `path` option → canonical URL segments, relative to its parent. TanStack
 * nests every code route under its parent's path whether or not the literal starts with `/`, so the
 * caller joins; `/` and `''` both mean the parent's own URL (an index route).
 */
export const convertTanStackCodePath = (raw: string): PathConversion => {
  const params: UrlParam[] = []
  const urlSegments = raw
    .split("/")
    .filter((token) => token !== "")
    .map((token) => {
      const converted = convertTanStackParamSegment(token)
      params.push(...converted.params)
      return converted.segment
    })

  return {
    url: normalizeUrl(`/${urlSegments.join("/")}`),
    extras: { params, droppedGroups: [], pathlessLayers: [], privateFolders: [] },
  }
}

/**
 * react-router path → canonical URL. Already speaks `:param` / `*`, and the optional-param `?` suffix
 * SURVIVES into the template (`/users/:id?/edit`) as the canonical optional marker, recorded as
 * `optional: true` on the param too — dropping it would merge `/users/:id?` with `/users/:id`.
 */
export const convertReactRouterPath = (raw: string): PathConversion => {
  const params: UrlParam[] = []

  const segments = raw.split("/").map((segment) => {
    if (segment.startsWith(":") && segment.endsWith("?") && segment.length > 2) {
      params.push({ name: segment.slice(1, -1), catchAll: false, optional: true })
      return segment
    }
    if (segment.startsWith(":")) {
      params.push({ name: segment.slice(1), catchAll: false, optional: false })
      return segment
    }
    if (segment === "*") {
      params.push({ name: "", catchAll: true, optional: true })
      return segment
    }
    return segment
  })

  return {
    url: normalizeUrl(segments.join("/")),
    extras: { params, droppedGroups: [], pathlessLayers: [], privateFolders: [] },
  }
}

/**
 * A React Router / Remix v2 flat route id → its raw segments: an unescaped `.` separates them, and a
 * `[...]` escape keeps its contents (dots included) inside one segment, brackets still on.
 */
export const splitFlatRouteName = (name: string): readonly string[] => {
  const parts: string[] = []
  let escaped = false
  let current = ""
  for (const char of name) {
    if (char === "[") escaped = true
    if (char === "]") escaped = false
    if (char === "." && !escaped) {
      parts.push(current)
      current = ""
      continue
    }
    current += char
  }
  return [...parts, current]
}

const unescapeFlat = (raw: string): string => raw.replace(/\[([^\]]*)\]/g, "$1")

type FlatSegment = {
  readonly segment: string | null
  readonly param?: UrlParam
  readonly pathlessLayer?: string
  readonly optionalStatic?: string
  readonly index?: boolean
  readonly nestingBreak?: boolean
}

const FLAT_OPTIONAL_PARAM = /^\(\$([^)]+)\)$/

const FLAT_OPTIONAL_STATIC = /^\(([^)]+)\)$/

const convertFlatToken = (token: string): FlatSegment => {
  if (token === "$") return { segment: "*", param: { name: "", catchAll: true, optional: true } }
  const optionalParam = FLAT_OPTIONAL_PARAM.exec(token)?.[1]
  if (optionalParam !== undefined) {
    const name = unescapeFlat(optionalParam)
    return { segment: `:${name}?`, param: { name, catchAll: false, optional: true } }
  }
  const optionalStatic = FLAT_OPTIONAL_STATIC.exec(token)?.[1]
  if (optionalStatic !== undefined) return { segment: null, optionalStatic: unescapeFlat(optionalStatic) }
  if (token.startsWith("$")) {
    const name = unescapeFlat(token.slice(1))
    return { segment: `:${name}`, param: { name, catchAll: false, optional: false } }
  }
  return { segment: unescapeFlat(token) }
}

const convertFlatSegment = (raw: string, isLast: boolean): FlatSegment => {
  if (raw === "") return { segment: null }
  if (raw === "_index" && isLast) return { segment: null, index: true }
  if (raw.startsWith("_")) return { segment: null, pathlessLayer: raw }
  if (raw.length > 1 && raw.endsWith("_")) return { ...convertFlatToken(raw.slice(0, -1)), nestingBreak: true }
  return convertFlatToken(raw)
}

export type FlatRouteConversion = PathConversion & {
  /** The id ends in `_index`: its parent's index route. */
  readonly index: boolean
  /** Indexes (into `splitFlatRouteName`) of `seg_` segments that opt out of nesting under their parent id. */
  readonly nestingBreaks: readonly number[]
}

/**
 * React Router / Remix v2 flat route id (no extension, folders already collapsed to dots) → canonical
 * URL. `$` is a splat, `$x` a param, `($x)` an optional param; `[...]` escapes literally
 * (`sitemap[.]xml`, `[_]`, `[$]`). A leading-`_` segment is a pathless layout (`pathlessLayers`), a
 * trailing `_` is stripped and reported in `nestingBreaks`, a leaf `_index` sets `index`, and an
 * optional static `(seg)` stays out of the URL, reported in `optionalStatics`.
 */
export const convertFlatRouteName = (name: string): FlatRouteConversion => {
  const raw = splitFlatRouteName(name)
  const converted = raw.map((segment, at) => convertFlatSegment(segment, at === raw.length - 1))
  return {
    url: urlOfSegments(converted.map((entry) => entry.segment)),
    extras: {
      ...EMPTY_EXTRAS,
      params: converted.flatMap((entry) => present(entry.param)),
      pathlessLayers: converted.flatMap((entry) => present(entry.pathlessLayer)),
      optionalStatics: converted.flatMap((entry) => present(entry.optionalStatic)),
    },
    index: converted.some((entry) => entry.index === true),
    nestingBreaks: converted.flatMap((entry, at) => (entry.nestingBreak === true ? [at] : [])),
  }
}

export type CatchAllPathConversion = PathConversion & { readonly catchAllOptional: boolean }

type WouterSegment = {
  readonly segment: string
  readonly param?: UrlParam
}

const WOUTER_PARAM = /^:([A-Za-z0-9_]+)(\??)$/

const convertWouterSegment = (raw: string): WouterSegment => {
  if (raw === "*") return { segment: "*", param: { name: "", catchAll: true, optional: false } }
  if (raw === "*?") return { segment: "*", param: { name: "", catchAll: true, optional: true } }
  const match = WOUTER_PARAM.exec(raw)
  if (match === null) return { segment: raw }
  return { segment: raw, param: { name: match[1] ?? "", catchAll: false, optional: match[2] === "?" } }
}

/**
 * wouter (regexparam) path → canonical URL. `:id` and `:id?` survive; `*` is a REQUIRED wildcard and
 * `*?` an optional one, both written `*` and told apart by `catchAllOptional`.
 */
export const convertWouterPath = (raw: string): CatchAllPathConversion => {
  const converted = raw.split("/").map(convertWouterSegment)
  const params = converted.flatMap((entry) => present(entry.param))
  return {
    url: normalizeUrl(converted.map((entry) => entry.segment).join("/")),
    catchAllOptional: !params.some(isRequiredCatchAll),
    extras: { ...EMPTY_EXTRAS, params },
  }
}

type VueSegment = {
  readonly segments: readonly string[]
  readonly param?: UrlParam
}

const VUE_PARAM_NAME = /^[A-Za-z0-9_]+/

const splitTopLevel = (raw: string): readonly string[] => {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw.charAt(index)
    if (char === "\\") {
      current += char + raw.charAt(index + 1)
      index += 1
      continue
    }
    if (char === "(") depth += 1
    if (char === ")") depth = Math.max(0, depth - 1)
    if (char === "/" && depth === 0) {
      parts.push(current)
      current = ""
      continue
    }
    current += char
  }
  return [...parts, current]
}

const balancedGroupEnd = (text: string): number => {
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (char === "\\") index += 1
    else if (char === "(") depth += 1
    else if (char === ")") {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return text.length
}

const CATCH_ALL_PATTERN = /^\((?:\.\*|\[\^?\\?\/?\]\*|\.\+)\)$/

const convertVueSegment = (raw: string): VueSegment => {
  const colon = raw.indexOf(":")
  if (colon === -1) return { segments: [raw] }
  const prefix = raw.slice(0, colon)
  const afterColon = raw.slice(colon + 1)
  const name = VUE_PARAM_NAME.exec(afterColon)?.[0]
  if (name === undefined) return { segments: [raw] }
  const afterName = afterColon.slice(name.length)
  const group = afterName.startsWith("(") ? afterName.slice(0, balancedGroupEnd(afterName)) : ""
  const afterGroup = afterName.slice(group.length)
  const modifier = /^[?+*]/.exec(afterGroup)?.[0] ?? ""
  const suffix = afterGroup.slice(modifier.length)
  const prefixSegments = prefix === "" ? [] : [prefix]
  const repeatable = modifier === "+" || modifier === "*"
  if (repeatable || CATCH_ALL_PATTERN.test(group)) {
    const optional = modifier !== "+"
    return { segments: [...prefixSegments, "*"], param: { name, catchAll: true, optional } }
  }
  const optional = modifier === "?"
  return {
    segments: [`${prefix}:${name}${optional ? "?" : ""}${suffix}`],
    param: { name, catchAll: false, optional },
  }
}

const convertVueSegments = (rawSegments: readonly string[]): PathConversion => {
  const converted = rawSegments.map(convertVueSegment)
  const params = converted.flatMap((entry) => (entry.param === undefined ? [] : [entry.param]))
  const segments = converted.flatMap((entry) => entry.segments)
  return {
    url: normalizeUrl(segments.join("/")),
    extras: { ...EMPTY_EXTRAS, params },
  }
}

/**
 * path-to-regexp path (Vue Router, react-router v5) → canonical URL. `:id` and `:id?` survive; a custom
 * regex is stripped (`:id(\\d+)` → `:id`); a repeatable (`:id+`, `:id*`) or an any-match regex (`:id(.*)`)
 * becomes `*` (`+` required, the rest optional). A catch-all glued to a literal (`lists:pathMatch(.*)*`)
 * splits into the literal segment followed by `*` (`/lists/*`).
 */
export const convertPathToRegexpPath = (raw: string): PathConversion => convertVueSegments(splitTopLevel(raw))

export const convertVueRouterPath = convertPathToRegexpPath

export type VueFileDialect = "nuxt" | "unplugin"

export type VueFileRouteOptions = {
  readonly dialect: VueFileDialect
}

const FILE_PARAM_FORMS: readonly (readonly [RegExp, string])[] = [
  [/\[\[([A-Za-z0-9_]+)\]\]\+/g, ":$1*"],
  [/\[\[([A-Za-z0-9_]+)\]\]/g, ":$1?"],
  [/\[\.\.\.([A-Za-z0-9_]+)\]/g, ":$1(.*)"],
  [/\[([A-Za-z0-9_]+)\]\+/g, ":$1+"],
  [/\[([A-Za-z0-9_]+)\]/g, ":$1"],
]

const fileSegmentToVuePath = (segment: string): string =>
  FILE_PARAM_FORMS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), segment)

const isGroupSegment = (segment: string): boolean =>
  segment.length > 2 && segment.startsWith("(") && segment.endsWith(")")

const DOT_OUTSIDE_BRACKETS = /\.(?![^[]*\])/

const fileTokens = (relPath: string, options: VueFileRouteOptions): readonly string[] => {
  const parts = relPath.split("/")
  return parts.flatMap((part, index) => {
    const isFile = index === parts.length - 1
    const cleaned = isFile ? stripSourceExtension(part) : part
    return isFile && options.dialect === "unplugin" ? cleaned.split(DOT_OUTSIDE_BRACKETS) : [cleaned]
  })
}

/**
 * Vue file-route path (relative to the pages directory) → canonical URL. Nuxt 4 and unplugin-vue-router
 * share `index`, `[id]`, `[[id]]`, `[...slug]` and `(group)`; unplugin also supports `[id]+` / `[[id]]+`
 * and treats `.` in a filename as `/` (`users.create.vue` → `/users/create`). Nuxt documents no dot rule,
 * so a dot stays literal there. Mixed segments (`foo-[id]`) embed the param in the template segment.
 */
export const convertVueFileRoutePath = (relPath: string, options: VueFileRouteOptions): PathConversion => {
  const tokens = fileTokens(relPath, options).filter((token) => token !== "")
  const droppedGroups = tokens.filter(isGroupSegment).map((token) => token.slice(1, -1))
  const routed = tokens.filter((token) => !isGroupSegment(token))
  const last = routed[routed.length - 1]
  const withoutIndex = last === "index" ? routed.slice(0, -1) : routed
  const conversion = convertVueSegments(withoutIndex.map(fileSegmentToVuePath))
  return {
    url: normalizeUrl(`/${conversion.url}`),
    extras: { ...conversion.extras, droppedGroups },
  }
}

export type ExpoRouteOptions = {
  readonly platforms: readonly string[]
}

export type ExpoRouteConversion = {
  readonly url: string
  readonly params: readonly UrlParam[]
  readonly routeNames: readonly string[]
  readonly groups: readonly string[]
  readonly platform: string | null
}

export type ExpoHrefConversion = {
  readonly url: string
  readonly routeName: string | null
}

const EXPO_INDEX = "index"

const EXPO_NOT_FOUND = "+not-found"

const EXPO_API_SUFFIX = "+api"

const groupNamesOfSegment = (segment: string): readonly string[] =>
  segment
    .slice(1, -1)
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")

const expandSegment = (segment: string): readonly string[] =>
  isGroupSegment(segment) ? groupNamesOfSegment(segment).map((name) => `(${name})`) : [segment]

const expandGroupArrays = (segments: readonly string[]): readonly string[] =>
  segments
    .reduce<readonly (readonly string[])[]>(
      (paths, segment) => paths.flatMap((path) => expandSegment(segment).map((expanded) => [...path, expanded])),
      [[]],
    )
    .map((path) => path.join("/"))

const groupsOfSegments = (segments: readonly string[]): readonly string[] => [
  ...new Set(segments.filter(isGroupSegment).flatMap(groupNamesOfSegment)),
]

const splitPlatformSuffix = (
  name: string,
  platforms: readonly string[],
): { readonly base: string; readonly platform: string | null } => {
  const dot = name.lastIndexOf(".")
  const suffix = name.slice(dot + 1)
  if (dot <= 0 || !platforms.includes(suffix)) return { base: name, platform: null }
  return { base: name.slice(0, dot), platform: suffix }
}

const withoutApiSuffix = (segment: string): string =>
  segment.endsWith(EXPO_API_SUFFIX) ? segment.slice(0, -EXPO_API_SUFFIX.length) : segment

const expoUrlSegments = (segments: readonly string[]): readonly string[] => {
  const routed = segments.filter((segment) => !isGroupSegment(segment))
  const leaf = withoutApiSuffix(routed[routed.length - 1] ?? "")
  const head = routed.slice(0, -1)
  return leaf === EXPO_INDEX || leaf === "" ? head : [...head, leaf]
}

const convertExpoSegment = (segment: string): NextSegmentResult => {
  if (segment === EXPO_NOT_FOUND) return { segment: "*", param: { name: "", catchAll: true, optional: false } }
  return convertNextBracketSegment(segment)
}

const conversionOfExpoSegments = (segments: readonly string[]): { readonly url: string; readonly params: readonly UrlParam[] } => {
  const results = expoUrlSegments(segments).map(convertExpoSegment)
  return {
    url: urlOfSegments(results.map((result) => result.segment)),
    params: results.flatMap((result) => present(result.param)),
  }
}

const pathSegments = (path: string): readonly string[] => path.split("/").filter((segment) => segment !== "")

export const convertExpoRoutePath = (relToRoot: string, options: ExpoRouteOptions): ExpoRouteConversion => {
  const parts = pathSegments(relToRoot)
  const leaf = splitPlatformSuffix(stripSourceExtension(parts[parts.length - 1] ?? ""), options.platforms)
  const named = [...parts.slice(0, -1), leaf.base]
  return {
    ...conversionOfExpoSegments(named),
    routeNames: expandGroupArrays(named),
    groups: groupsOfSegments(named),
    platform: leaf.platform,
  }
}

const hrefRouteName = (segments: readonly string[]): string | null => {
  if (!segments.some(isGroupSegment)) return null
  const last = segments[segments.length - 1] ?? ""
  return (isGroupSegment(last) ? [...segments, EXPO_INDEX] : segments).join("/")
}

export const expoHrefToUrl = (href: string): ExpoHrefConversion => {
  const segments = pathSegments(href.split(/[?#]/)[0] ?? "")
  return {
    url: conversionOfExpoSegments(segments).url,
    routeName: hrefRouteName(segments),
  }
}

const NEXT_REDIRECT_PARAM = /^:([A-Za-z0-9_]+)([?*+]?)$/

const NEXT_REDIRECT_LITERAL = /^[^:()[\]{}*+?\\]*$/

type RedirectSegment = {
  readonly segment: string
  readonly param?: UrlParam
}

const convertNextRedirectSegment = (raw: string): RedirectSegment | null => {
  const match = NEXT_REDIRECT_PARAM.exec(raw)
  if (match === null) return NEXT_REDIRECT_LITERAL.test(raw) ? { segment: raw } : null
  const name = match[1] ?? ""
  const modifier = match[2] ?? ""
  if (modifier === "*") return { segment: "*", param: { name, catchAll: true, optional: true } }
  if (modifier === "+") return { segment: "*", param: { name, catchAll: true, optional: false } }
  return { segment: raw, param: { name, catchAll: false, optional: modifier === "?" } }
}

const isRedirectSegment = (segment: RedirectSegment | null): segment is RedirectSegment => segment !== null

export type RedirectPathConversion = CatchAllPathConversion

/**
 * A Next.js `redirects()` `source` (path-to-regexp syntax) → canonical URL. `:p` and `:p?` map as-is,
 * `:p*` becomes a `*` that also matches its base and `:p+` a required `*` (`catchAllOptional: false`).
 * A regex group, a `{…}` group or a param inside a segment is unreadable and returns `null`.
 */
export const convertNextRedirectPath = (source: string): RedirectPathConversion | null => {
  if (!source.startsWith("/")) return null
  const converted = source.split("/").map(convertNextRedirectSegment)
  const segments = converted.filter(isRedirectSegment)
  if (segments.length !== converted.length) return null
  const params = segments.flatMap((segment) => (segment.param === undefined ? [] : [segment.param]))
  return {
    url: normalizeUrl(segments.map((segment) => segment.segment).join("/")),
    catchAllOptional: !params.some(isRequiredCatchAll),
    extras: { ...EMPTY_EXTRAS, params },
  }
}

export type TemplateValues = Readonly<Record<string, string>>

export const ADMINJS_RESOURCE_TEMPLATE = "${rootPath}resources/${id}"
export const ADMINJS_PAGE_TEMPLATE = "${rootPath}pages/${slug}"

/**
 * AdminJS has no route table: the URL comes from a plugin-declared template string
 * (`${rootPath}resources/${id}` or `${rootPath}pages/${slug}`) plus a value map, not from
 * path syntax. This expands any `${key}` template against the supplied values.
 */
export const expandAdminJsTemplate = (template: string, values: TemplateValues): PathConversion => ({
  url: normalizeUrl(template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => values[key] ?? "")),
  extras: EMPTY_EXTRAS,
})

export type AdminJsUrlInput = {
  readonly templateKind: "resource" | "page"
  readonly rootPath: string
  readonly substitution: string
}

export const convertAdminJsUrl = (input: AdminJsUrlInput): PathConversion => {
  const template = input.templateKind === "resource" ? ADMINJS_RESOURCE_TEMPLATE : ADMINJS_PAGE_TEMPLATE
  const key = input.templateKind === "resource" ? "id" : "slug"
  return expandAdminJsTemplate(template, { rootPath: input.rootPath, [key]: input.substitution })
}

const ANGULAR_WILDCARD = "**"

const angularSegment = (segment: string): { readonly text: string; readonly param: UrlParam | null } => {
  if (segment === ANGULAR_WILDCARD) return { text: "*", param: { name: "", catchAll: true, optional: true } }
  if (segment.startsWith(":") && segment.length > 1) {
    return { text: segment, param: { name: segment.slice(1), catchAll: false, optional: false } }
  }
  return { text: segment, param: null }
}

export const convertAngularPath = (raw: string): PathConversion => {
  const converted = raw.split("/").filter((segment) => segment !== "").map(angularSegment)
  return {
    url: converted.map((segment) => segment.text).join("/"),
    extras: { ...EMPTY_EXTRAS, params: converted.flatMap((segment) => (segment.param ? [segment.param] : [])) },
  }
}
