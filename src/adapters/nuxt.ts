import * as path from "node:path"
import type ts from "typescript"
import { walk } from "../core/ast.js"
import { stripSourceExtension } from "../core/extensions.js"
import type { FileHost } from "../core/host.js"
import { toPosix } from "../core/host.js"
import type { AncestorRef, Evidence, SpliceMode } from "../core/model.js"
import { type NuxtDirs, resolveNuxtDirs } from "../core/nuxt-project.js"
import { sortBy, sortedUnique } from "../core/order.js"
import { templateBlock } from "../core/sfc.js"
import { scanTags } from "../core/tag-scan.js"
import { VUE_TEMPLATE_TAGS } from "../core/vue-compiler.js"
import { convertVueFileRoutePath, convertVueRouterPath, joinUrl, paramsOf } from "../core/url.js"
import { buildNuxtComponentIndex, type NuxtComponentCollision } from "./nuxt-components.js"
import type {
  Adapter,
  AmbientComponent,
  DetectResult,
  DiscoverContext,
  ProjectContext,
  ScreenDraft,
  ScreenSource,
  TsNode,
} from "./types.js"
import { type VueAuthRules, type VueAuthVerdict, authOf, resolveVueAuthRules } from "./vue-auth.js"

export const SOURCE_NAME = "nuxt"

const NUXT_DEPENDENCY = "nuxt"

const DETECT_SCORE_FILE_CONVENTION = 100

const PAGE_EXTENSIONS = ["vue", "tsx", "jsx", "ts", "js", "mjs"] as const

const COMPONENT_EXTENSIONS = ["vue", "tsx", "jsx", "ts", "js"] as const

const LAYOUT_EXTENSIONS = ["vue", "tsx", "jsx", "ts", "js"] as const

const IGNORED_FILE = /(?:^|\/)-[^/]*$|\.(?:spec|test|stories)\.[^/]+$|\.d\.[cm]?ts$/

const GLOBAL_MIDDLEWARE = /\.global\.[^/.]+$/

const DEFINE_PAGE_META = "definePageMeta"

const APP_FILE = "app.vue"

const DEFAULT_LAYOUT = "default"

const INDEX_SEGMENT = "index"

const ROOT_ROUTE_NAME = "index"

const LAYOUT_TAG = "NuxtLayout"

const PAGE_TAG = "NuxtPage"

const SLOT_TAG = "slot"

const outletAliasesOf = (tag: string): readonly string[] =>
  VUE_TEMPLATE_TAGS.outlets.find((group) => group.includes(tag)) ?? [tag]

const LAYOUT_TAGS = outletAliasesOf(LAYOUT_TAG)

const PAGE_TAGS = outletAliasesOf(PAGE_TAG)

const SLOT_TAGS = [SLOT_TAG] as const

const templateMentions = (text: string, tags: readonly string[]): boolean => {
  const block = templateBlock(text)
  if (block === null) return false
  return scanTags(text, { tags, from: block.start, to: block.end }).length > 0
}

const MAX_LISTED = 5

const NUXT_PAGE_SPLICE: SpliceMode = { kind: "outlet", tag: "NuxtPage" }

const NUXT_LAYOUT_SPLICE: SpliceMode = { kind: "outlet", tag: "NuxtLayout" }

const SLOT_SPLICE: SpliceMode = { kind: "children" }

const NO_DETECTION: DetectResult = { score: 0, evidence: [] }

export type NuxtOptions = {
  readonly authRules?: VueAuthRules
}

type Redirect = { readonly kind: "path"; readonly value: string } | { readonly kind: "opaque"; readonly text: string }

type PageMeta = {
  readonly line: number
  readonly middleware: readonly string[]
  readonly inlineMiddleware: boolean
  readonly flags: Readonly<Record<string, boolean>>
  readonly layout: string | false | null
  readonly path: string | null
  readonly name: string | null
  readonly redirect: Redirect | null
  readonly aliases: readonly string[]
}

type Page = {
  readonly file: string
  readonly stem: string
  readonly parents: readonly string[]
}

const EMPTY_META: PageMeta = {
  line: 1,
  middleware: [],
  inlineMiddleware: false,
  flags: {},
  layout: null,
  path: null,
  name: null,
  redirect: null,
  aliases: [],
}

const relativeOf = (ctx: ProjectContext, abs: string): string => toPosix(path.relative(ctx.root, abs))

const hostOf = (ctx: ProjectContext): FileHost => ({
  readFile: (abs) => ctx.readFile(relativeOf(ctx, abs)),
  exists: (abs) => ctx.exists(relativeOf(ctx, abs)),
  isFile: (abs) => ctx.readFile(relativeOf(ctx, abs)) !== null,
  isDirectory: (abs) => ctx.exists(relativeOf(ctx, abs)) && ctx.readFile(relativeOf(ctx, abs)) === null,
  mtimeMs: () => null,
  readDir: () => [],
  glob: () => [],
  symlinksSeen: () => [],
})

const dirsOf = (ctx: ProjectContext): NuxtDirs => resolveNuxtDirs({ ts: ctx.ts, host: hostOf(ctx), root: ctx.root })

const prefixOf = (dir: string): string => (dir === "." ? "" : `${dir}/`)

const globOf = (dir: string, extensions: readonly string[]): string =>
  `${prefixOf(dir)}**/*.{${extensions.join(",")}}`

const pageFilesOf = (ctx: ProjectContext, dirs: NuxtDirs): readonly string[] => {
  const prefix = prefixOf(dirs.pagesDir)
  return ctx
    .glob(globOf(dirs.pagesDir, PAGE_EXTENSIONS))
    .filter((file) => !ctx.isGenerated(file) && !IGNORED_FILE.test(file.slice(prefix.length)))
}

const appFileOf = (ctx: ProjectContext, dirs: NuxtDirs): string | null => {
  const file = `${prefixOf(dirs.srcDir)}${APP_FILE}`
  return ctx.readFile(file) === null ? null : file
}

const isNuxtProject = (ctx: ProjectContext): boolean => ctx.hasDependency(NUXT_DEPENDENCY)

export const detectNuxt = (ctx: ProjectContext): DetectResult => {
  if (!isNuxtProject(ctx)) return NO_DETECTION
  const dirs = dirsOf(ctx)
  const first = pageFilesOf(ctx, dirs)[0] ?? appFileOf(ctx, dirs)
  if (first === null) return NO_DETECTION
  return {
    score: DETECT_SCORE_FILE_CONVENTION,
    evidence: [
      { what: "nuxt dependency", file: "package.json", line: 1 },
      { what: "nuxt pages directory or app.vue", file: first, line: 1 },
    ],
  }
}

const keyOf = (ctx: DiscoverContext, name: ts.PropertyName): string | null =>
  ctx.ast.asIdentifier(name)?.text ?? ctx.ast.asStringLiteralLike(name)?.text ?? null

const membersOf = (ctx: DiscoverContext, object: ts.ObjectLiteralExpression): ReadonlyMap<string, TsNode> =>
  new Map(
    object.properties.flatMap((member): [string, TsNode][] => {
      if (!ctx.ts.isPropertyAssignment(member)) return []
      const key = keyOf(ctx, member.name)
      return key === null ? [] : [[key, member.initializer]]
    }),
  )

const stringOf = (ctx: DiscoverContext, node: TsNode | undefined): string | null =>
  ctx.ast.asStringLiteralLike(node === undefined ? undefined : ctx.unwrap(node))?.text ?? null

const booleanOf = (ctx: DiscoverContext, node: TsNode | undefined): boolean | null => {
  if (node === undefined) return null
  const kind = ctx.unwrap(node).kind
  if (kind === ctx.ts.SyntaxKind.TrueKeyword) return true
  if (kind === ctx.ts.SyntaxKind.FalseKeyword) return false
  return null
}

const stringsOf = (ctx: DiscoverContext, node: TsNode | undefined): { values: string[]; other: boolean } => {
  if (node === undefined) return { values: [], other: false }
  const single = stringOf(ctx, node)
  if (single !== null) return { values: [single], other: false }
  const array = ctx.ast.asArrayLiteral(ctx.unwrap(node))
  if (array === null) return { values: [], other: true }
  const values = array.elements.flatMap((element) => stringOf(ctx, element) ?? [])
  return { values, other: values.length < array.elements.length }
}

const layoutOf = (ctx: DiscoverContext, node: TsNode | undefined): string | false | null =>
  booleanOf(ctx, node) === false ? false : stringOf(ctx, node)

const redirectOf = (ctx: DiscoverContext, file: string, node: TsNode | undefined): Redirect | null => {
  if (node === undefined) return null
  const value = stringOf(ctx, node)
  if (value !== null) return { kind: "path", value }
  return { kind: "opaque", text: ctx.unwrap(node).getText(ctx.sourceFile(file) ?? undefined) }
}

const isMetaCall = (ctx: DiscoverContext, node: TsNode): ts.CallExpression | null => {
  const call = ctx.ast.asCallExpression(node)
  return call !== null && ctx.ast.asIdentifier(call.expression)?.text === DEFINE_PAGE_META ? call : null
}

const metaCallOf = (ctx: DiscoverContext, file: string): ts.CallExpression | null => {
  const source = ctx.sourceFile(file)
  if (source === null) return null
  let found: ts.CallExpression | null = null
  walk(source, (node) => {
    found ??= isMetaCall(ctx, node)
  })
  return found
}

const flagsOf = (
  ctx: DiscoverContext,
  members: ReadonlyMap<string, TsNode>,
  rules: VueAuthRules,
): Readonly<Record<string, boolean>> =>
  Object.fromEntries(
    rules.authMetaKeys.flatMap((key): [string, boolean][] => {
      const value = booleanOf(ctx, members.get(key))
      return value === null ? [] : [[key, value]]
    }),
  )

const readMeta = (ctx: DiscoverContext, file: string, rules: VueAuthRules): PageMeta => {
  const call = metaCallOf(ctx, file)
  const object = call === null ? null : ctx.ast.asObjectLiteral(call.arguments[0])
  if (call === null || object === null) return EMPTY_META
  const members = membersOf(ctx, object)
  const middleware = stringsOf(ctx, members.get("middleware"))
  return {
    line: ctx.lineOf(file, call),
    middleware: middleware.values,
    inlineMiddleware: middleware.other,
    flags: flagsOf(ctx, members, rules),
    layout: layoutOf(ctx, members.get("layout")),
    path: stringOf(ctx, members.get("path")),
    name: stringOf(ctx, members.get("name")),
    redirect: redirectOf(ctx, file, members.get("redirect")),
    aliases: stringsOf(ctx, members.get("alias")).values,
  }
}

const parentStemsOf = (stem: string, stems: ReadonlySet<string>): readonly string[] => {
  const segments = stem.split("/")
  return segments
    .slice(0, -1)
    .map((_, index) => segments.slice(0, index + 1).join("/"))
    .filter((candidate) => stems.has(candidate))
}

const pagesOf = (ctx: ProjectContext, dirs: NuxtDirs): readonly Page[] => {
  const prefix = prefixOf(dirs.pagesDir)
  const files = pageFilesOf(ctx, dirs)
  const stems = new Set(files.map((file) => stripSourceExtension(file.slice(prefix.length))))
  return files.map((file) => {
    const stem = stripSourceExtension(file.slice(prefix.length))
    return { file, stem, parents: parentStemsOf(stem, stems) }
  })
}

const isNestingParent = (page: Page, stems: ReadonlySet<string>): boolean => stems.has(`${page.stem}/${INDEX_SEGMENT}`)

const PARAM_SEGMENT = /\[\[?(?:\.\.\.)?([A-Za-z0-9_]+)\]\]?\+?/g

const isGroupSegment = (segment: string): boolean => segment.startsWith("(") && segment.endsWith(")")

export const nuxtRouteNameOf = (stem: string): string => {
  const joined = stem
    .split("/")
    .filter((segment) => !isGroupSegment(segment))
    .map((segment) => segment.replace(PARAM_SEGMENT, "$1"))
    .join("-")
  if (joined === INDEX_SEGMENT || joined === "") return ROOT_ROUTE_NAME
  return joined.endsWith(`-${INDEX_SEGMENT}`) ? joined.slice(0, -INDEX_SEGMENT.length - 1) : joined
}

const fileUrlOf = (dirs: NuxtDirs, file: string): string =>
  convertVueFileRoutePath(file.slice(prefixOf(dirs.pagesDir).length), { dialect: "nuxt" }).url

const findWithExtension = (ctx: ProjectContext, base: string, extensions: readonly string[]): string | null =>
  extensions.map((extension) => `${base}.${extension}`).find((file) => ctx.readFile(file) !== null) ?? null

type Discovery = {
  readonly dirs: NuxtDirs
  readonly pages: readonly Page[]
  readonly byStem: ReadonlyMap<string, Page>
  readonly metaOf: (stem: string) => PageMeta
  readonly appFile: string | null
  readonly appHasLayout: boolean
  readonly globalMiddleware: readonly string[]
}

const createDiscovery = (ctx: DiscoverContext, rules: VueAuthRules): Discovery => {
  const dirs = dirsOf(ctx)
  const pages = pagesOf(ctx, dirs)
  const byStem = new Map(pages.map((page) => [page.stem, page]))
  const metas = new Map<string, PageMeta>()
  const metaOf = (stem: string): PageMeta => {
    const cached = metas.get(stem)
    if (cached !== undefined) return cached
    const page = byStem.get(stem)
    const meta = page === undefined ? EMPTY_META : readMeta(ctx, page.file, rules)
    metas.set(stem, meta)
    return meta
  }
  const appFile = appFileOf(ctx, dirs)
  const globalMiddleware = ctx
    .glob(`${prefixOf(dirs.middlewareDir)}*`)
    .filter((file) => GLOBAL_MIDDLEWARE.test(file))
  return {
    dirs,
    pages,
    byStem,
    metaOf,
    appFile,
    appHasLayout: appFile !== null && templateMentions(ctx.readFile(appFile) ?? "", LAYOUT_TAGS),
    globalMiddleware,
  }
}

const chainOf = (discovery: Discovery, page: Page): readonly PageMeta[] =>
  [...page.parents, page.stem].map(discovery.metaOf)

const ownAuthOf = (meta: PageMeta, rules: VueAuthRules): VueAuthVerdict =>
  authOf({ middleware: meta.middleware, flags: meta.flags }, rules)

const authOfChain = (chain: readonly PageMeta[], rules: VueAuthRules): VueAuthVerdict =>
  [...chain].reverse().reduce<VueAuthVerdict>((found, meta) => found ?? ownAuthOf(meta, rules), null)

const layoutOfChain = (chain: readonly PageMeta[]): string | false =>
  [...chain].reverse().find((meta) => meta.layout !== null)?.layout ?? DEFAULT_LAYOUT

const appAncestors = (discovery: Discovery): readonly AncestorRef[] =>
  discovery.appFile === null
    ? []
    : [
        {
          file: discovery.appFile,
          exportName: "default",
          splice: discovery.appHasLayout ? NUXT_LAYOUT_SPLICE : NUXT_PAGE_SPLICE,
          role: "layout",
        },
      ]

const layoutSpliceOf = (ctx: ProjectContext, file: string): SpliceMode => {
  const text = ctx.readFile(file) ?? ""
  return templateMentions(text, PAGE_TAGS) && !templateMentions(text, SLOT_TAGS) ? NUXT_PAGE_SPLICE : SLOT_SPLICE
}

const layoutAncestors = (ctx: DiscoverContext, discovery: Discovery, layout: string | false): readonly AncestorRef[] => {
  if (layout === false || (discovery.appFile !== null && !discovery.appHasLayout)) return []
  const file = findWithExtension(ctx, `${prefixOf(discovery.dirs.layoutsDir)}${layout}`, LAYOUT_EXTENSIONS)
  return file === null ? [] : [{ file, exportName: "default", splice: layoutSpliceOf(ctx, file), role: "layout" }]
}

const parentAncestors = (discovery: Discovery, page: Page): readonly AncestorRef[] =>
  page.parents.flatMap((stem) => {
    const parent = discovery.byStem.get(stem)
    return parent === undefined
      ? []
      : [{ file: parent.file, exportName: "default", splice: NUXT_PAGE_SPLICE, role: "layout" as const }]
  })

const parentUrlOf = (discovery: Discovery, page: Page): string | null => {
  const parent = discovery.byStem.get(page.parents[page.parents.length - 1] ?? "")
  return parent === undefined ? null : fileUrlOf(discovery.dirs, parent.file)
}

const urlOf = (discovery: Discovery, page: Page, meta: PageMeta): string => {
  if (meta.path === null) return fileUrlOf(discovery.dirs, page.file)
  const own = convertVueRouterPath(meta.path).url
  if (meta.path.startsWith("/")) return own
  return joinUrl(parentUrlOf(discovery, page), own) ?? "/"
}

const authEvidence = (discovery: Discovery, chain: readonly PageMeta[], auth: VueAuthVerdict): readonly string[] => [
  ...(chain.some((meta) => meta.inlineMiddleware)
    ? ["definePageMeta has inline middleware functions; their checks are not read"]
    : []),
  ...(auth === null && discovery.globalMiddleware.length > 0
    ? [
        `${String(discovery.globalMiddleware.length)} global route middleware (${discovery.globalMiddleware.join(", ")}) decide access at runtime; auth is not asserted`,
      ]
    : []),
]

const redirectEvidence = (redirect: Redirect | null): readonly string[] =>
  redirect?.kind === "opaque" ? [`definePageMeta redirect {${redirect.text}} is not readable`] : []

const draftOf = (ctx: DiscoverContext, discovery: Discovery, page: Page, rules: VueAuthRules): ScreenDraft => {
  const chain = chainOf(discovery, page)
  const meta = discovery.metaOf(page.stem)
  const url = urlOf(discovery, page, meta)
  const auth = authOfChain(chain, rules)
  const layout = layoutOfChain(chain)
  const ancestors = [
    ...appAncestors(discovery),
    ...layoutAncestors(ctx, discovery, layout),
    ...parentAncestors(discovery, page),
  ]
  const texts = [
    "nuxt page",
    ...(layout === false ? ["definePageMeta layout: false"] : [`layout '${layout}'`]),
    ...authEvidence(discovery, chain, auth),
    ...redirectEvidence(meta.redirect),
  ]
  const evidence: readonly Evidence[] = texts.map((what) => ({ what, file: page.file, line: meta.line }))
  return {
    localId: ctx.localId(page.file),
    activations: [{ kind: "url", template: url, params: [...paramsOf(url)] }],
    entries: [{ kind: "file", file: page.file, exportName: "default" }],
    auth,
    evidence,
    ...(ancestors.length === 0 ? {} : { ancestors }),
    ...(meta.redirect?.kind === "path" ? { redirectTo: ctx.normalizeUrl(meta.redirect.value) } : {}),
    routeName: meta.name ?? nuxtRouteNameOf(page.stem),
  }
}

const appScreenOf = (ctx: DiscoverContext, appFile: string): ScreenDraft => ({
  localId: ctx.localId(appFile),
  activations: [{ kind: "url", template: "/", params: [] }],
  entries: [{ kind: "file", file: appFile, exportName: "default" }],
  auth: null,
  evidence: [ctx.evidence("nuxt app.vue with no pages directory", appFile)],
})

const listed = (items: readonly string[]): string => {
  const more = items.length > MAX_LISTED ? ` (+${String(items.length - MAX_LISTED)} more)` : ""
  return `${items.slice(0, MAX_LISTED).join(", ")}${more}`
}

const reportLayers = (ctx: DiscoverContext, dirs: NuxtDirs): void => {
  if (dirs.extends.length === 0) return
  ctx.diagnostic({
    severity: "info",
    code: "project/nuxt-layer-skipped",
    message: `nuxt.config extends ${String(dirs.extends.length)} layer(s) that are not analysed; their pages, layouts and components are skipped: ${dirs.extends.join(", ")}`,
  })
}

const reportAliases = (ctx: DiscoverContext, discovery: Discovery, pages: readonly Page[]): void => {
  const aliased = pages.filter((page) => discovery.metaOf(page.stem).aliases.length > 0)
  if (aliased.length === 0) return
  ctx.diagnostic({
    severity: "info",
    code: "screens/unsupported-router-style",
    message: `${String(aliased.length)} nuxt page(s) declare definePageMeta alias paths that are not mapped as screens: ${listed(aliased.map((page) => page.file))}`,
  })
}

const discoverNuxt = (ctx: DiscoverContext, rules: VueAuthRules): readonly ScreenDraft[] => {
  if (!isNuxtProject(ctx)) return []
  const discovery = createDiscovery(ctx, rules)
  reportLayers(ctx, discovery.dirs)
  if (discovery.pages.length === 0) return discovery.appFile === null ? [] : [appScreenOf(ctx, discovery.appFile)]
  const stems = new Set(discovery.byStem.keys())
  const screens = sortBy(
    discovery.pages.filter((page) => !isNestingParent(page, stems)),
    (page) => page.file,
  )
  reportAliases(ctx, discovery, screens)
  return screens.map((page) => draftOf(ctx, discovery, page, rules))
}

const componentFilesOf = (ctx: ProjectContext, dirs: NuxtDirs): readonly string[] =>
  sortedUnique(
    dirs.componentDirs.flatMap((dir) =>
      ctx.glob(globOf(dir.path, COMPONENT_EXTENSIONS)).filter((file) => !ctx.isGenerated(file) && !IGNORED_FILE.test(file)),
    ),
  )

const collisionText = (collision: NuxtComponentCollision): string => `${collision.name} (${collision.files.join(", ")})`

const reportCollisions = (ctx: DiscoverContext, collisions: readonly NuxtComponentCollision[]): void => {
  if (collisions.length === 0) return
  ctx.diagnostic({
    severity: "info",
    code: "facts/ambiguous-component-name",
    message: `${String(collisions.length)} Nuxt auto-import component name(s) are claimed by more than one file; no render edge is drawn for them: ${listed(collisions.map(collisionText))}`,
  })
}

const ambientComponentsOf = (ctx: DiscoverContext): readonly AmbientComponent[] => {
  if (detectNuxt(ctx).score === 0) return []
  const dirs = dirsOf(ctx)
  const index = buildNuxtComponentIndex(dirs.componentDirs, componentFilesOf(ctx, dirs))
  reportCollisions(ctx, index.collisions)
  return [...index.byName].map(([name, file]) => ({ name, file }))
}

export const createNuxtSource = (options: NuxtOptions = {}): ScreenSource => {
  const rules = options.authRules ?? resolveVueAuthRules({})
  return {
    name: SOURCE_NAME,
    detect: detectNuxt,
    discover: (ctx) => discoverNuxt(ctx, rules),
  }
}

export const createNuxtAdapter = (options: NuxtOptions = {}): Adapter => ({
  name: SOURCE_NAME,
  screens: [createNuxtSource(options)],
  ambientComponents: ambientComponentsOf,
})
