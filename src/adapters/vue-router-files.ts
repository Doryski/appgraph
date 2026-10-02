import type ts from "typescript"
import { walk } from "../core/ast.js"
import { stripSourceExtension } from "../core/extensions.js"
import { sortBy, sortedUnique, stableUnique } from "../core/order.js"
import { splitSfc } from "../core/sfc.js"
import { convertVueFileRoutePath } from "../core/url.js"
import type { DiscoverContext, ProjectContext, TsNode } from "./types.js"
import { importedBindingOf } from "./values.js"
import type { VueAuthSignals } from "./vue-auth.js"
import type { RouteNode, RouteRedirect } from "./vue-route-records.js"

export const UNPLUGIN_DEPENDENCY = "unplugin-vue-router"

export const AUTO_ROUTES_MODULES: readonly string[] = ["vue-router/auto-routes", "vue-router/auto"]

const VITE_PLUGIN_MODULES: readonly string[] = ["unplugin-vue-router/vite", "vue-router/vite"]

const VITE_CONFIGS = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"] as const

const DEFAULT_ROUTES_FOLDER = "src/pages"

const PAGE_EXTENSION = ".vue"

const INDEX_TOKEN = "index"

const DEFINE_PAGE = "definePage"

const ROUTE_BLOCK = "route"

const JSON_LANGS: readonly string[] = ["json", "json5"]

const FILE_ROUTE_IMPORT = /\bfrom\s*["'](?:vue-router\/auto-routes|vue-router\/auto|unplugin-vue-router(?:\/[^"']*)?)["']/

const AUTO_ROUTES_IMPORT = /\bfrom\s*["']vue-router\/auto(?:-routes)?["']/

const DOT_OUTSIDE_BRACKETS = /\.(?![^[]*\])/

const PAGE_KEYS = {
  name: "name",
  path: "path",
  meta: "meta",
  alias: "alias",
  redirect: "redirect",
  middleware: "middleware",
  routesFolder: "routesFolder",
  src: "src",
} as const

const NO_SIGNALS: VueAuthSignals = { middleware: [], flags: {} }

type PageOverrides = {
  readonly line: number
  readonly name?: string | null
  readonly path?: string
  readonly alias?: readonly string[]
  readonly redirect?: RouteRedirect
  readonly authSignals?: VueAuthSignals
}

type PageFile = {
  readonly file: string
  readonly tokens: readonly string[]
}

type FolderRead = { readonly folders: readonly string[]; readonly dynamic: { file: string; line: number } | null }

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringsOfValue = (value: unknown): readonly string[] => {
  if (typeof value === "string") return [value]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

export const importsAutoRoutes = (text: string): boolean => AUTO_ROUTES_IMPORT.test(text)

export const fileRouteTrigger = (ctx: ProjectContext, files: readonly string[]): string | null => {
  const importer = files.find((file) => FILE_ROUTE_IMPORT.test(ctx.readFile(file) ?? ""))
  if (importer !== undefined) return importer
  return ctx.hasDependency(UNPLUGIN_DEPENDENCY) ? "package.json" : null
}

export const referencesAutoRoutes = (ctx: DiscoverContext, file: string, node: TsNode): boolean => {
  const bindings = ctx.bindingsFor(file)
  let found = false
  walk(node, (current) => {
    const identifier = ctx.ast.asIdentifier(current)
    const imported = identifier === null ? null : importedBindingOf(bindings.get(identifier.text))
    if (imported !== null && AUTO_ROUTES_MODULES.includes(imported.module)) found = true
  })
  return found
}

const normalizeFolder = (raw: string): string => raw.replace(/^\.\//, "").replace(/\/+$/, "")

const keyOf = (ctx: DiscoverContext, name: ts.PropertyName): string | null =>
  ctx.ast.asIdentifier(name)?.text ?? ctx.ast.asStringLiteralLike(name)?.text ?? null

const membersOf = (ctx: DiscoverContext, object: ts.ObjectLiteralExpression): ReadonlyMap<string, TsNode> =>
  new Map(
    object.properties.flatMap((member) => {
      if (!ctx.ts.isPropertyAssignment(member)) return []
      const key = keyOf(ctx, member.name)
      return key === null ? [] : [[key, member.initializer] as const]
    }),
  )

const literalOf = (ctx: DiscoverContext, node: TsNode | undefined): string | null =>
  ctx.ast.asStringLiteralLike(node)?.text ?? null

const folderOfElement = (ctx: DiscoverContext, element: TsNode): string | null => {
  const direct = literalOf(ctx, element)
  if (direct !== null) return direct
  const object = ctx.ast.asObjectLiteral(element)
  return object === null ? null : literalOf(ctx, membersOf(ctx, object).get(PAGE_KEYS.src))
}

const foldersOfValue = (ctx: DiscoverContext, node: TsNode): readonly string[] | null => {
  const array = ctx.ast.asArrayLiteral(node)
  const elements = array === null ? [node] : [...array.elements]
  const folders = elements.map((element) => folderOfElement(ctx, element))
  if (folders.some((folder) => folder === null)) return null
  return folders.flatMap((folder) => (folder === null ? [] : [normalizeFolder(folder)]))
}

const pluginCalls = (ctx: DiscoverContext, file: string): readonly ts.CallExpression[] => {
  const source = ctx.sourceFile(file)
  if (source === null) return []
  const bindings = ctx.bindingsFor(file)
  const found: ts.CallExpression[] = []
  walk(source, (node) => {
    const call = ctx.ast.asCallExpression(node)
    const callee = call === null ? null : ctx.ast.asIdentifier(call.expression)
    const imported = callee === null ? null : importedBindingOf(bindings.get(callee.text))
    if (call !== null && imported !== null && VITE_PLUGIN_MODULES.includes(imported.module)) found.push(call)
  })
  return found
}

const foldersOfCall = (ctx: DiscoverContext, file: string, call: ts.CallExpression): FolderRead => {
  const options = ctx.ast.asObjectLiteral(call.arguments[0])
  const value = options === null ? undefined : membersOf(ctx, options).get(PAGE_KEYS.routesFolder)
  if (options === null && call.arguments.length === 0) return { folders: [], dynamic: null }
  if (options !== null && value === undefined) return { folders: [], dynamic: null }
  const folders = value === undefined ? null : foldersOfValue(ctx, value)
  if (folders === null) return { folders: [], dynamic: { file, line: ctx.lineOf(file, call) } }
  return { folders, dynamic: null }
}

const readFolders = (ctx: DiscoverContext): FolderRead => {
  const reads = VITE_CONFIGS.filter((file) => ctx.exists(file)).flatMap((file) =>
    pluginCalls(ctx, file).map((call) => foldersOfCall(ctx, file, call)),
  )
  const dynamic = reads.find((read) => read.dynamic !== null)?.dynamic ?? null
  const folders = stableUnique(reads.flatMap((read) => read.folders))
  return { folders: folders.length === 0 ? [DEFAULT_ROUTES_FOLDER] : folders, dynamic }
}

const reportDynamicFolder = (ctx: DiscoverContext, site: { file: string; line: number }): void =>
  ctx.diagnostic({
    severity: "info",
    code: "screens/dynamic-registry",
    message: `the vue-router file-routes plugin has a routesFolder option this source cannot read; only literal folders (or ${DEFAULT_ROUTES_FOLDER} when none) are scanned`,
    file: site.file,
    line: site.line,
  })

const tokensOf = (relPath: string): readonly string[] => {
  const parts = relPath.split("/")
  const last = parts[parts.length - 1] ?? ""
  return [...parts.slice(0, -1), ...stripSourceExtension(last).split(DOT_OUTSIDE_BRACKETS)].filter((token) => token !== "")
}

const pagesIn = (ctx: DiscoverContext, folders: readonly string[]): readonly PageFile[] =>
  folders.flatMap((folder) =>
    ctx
      .glob(`${folder}/**/*${PAGE_EXTENSION}`)
      .filter((file) => file.startsWith(`${folder}/`))
      .map((file) => ({ file, tokens: tokensOf(file.slice(folder.length + 1)) })),
  )

const tokenKey = (tokens: readonly string[]): string => tokens.join("/")

const isIndex = (page: PageFile): boolean => page.tokens[page.tokens.length - 1] === INDEX_TOKEN

const parentKeyOf = (page: PageFile, parents: ReadonlyMap<string, PageFile>): string | null => {
  for (let length = page.tokens.length - 1; length > 0; length -= 1) {
    const key = tokenKey(page.tokens.slice(0, length))
    if (parents.has(key)) return key
  }
  return null
}

export const defaultRouteName = (tokens: readonly string[]): string =>
  tokens.map((token) => `/${token === INDEX_TOKEN ? "" : token}`).join("")

const urlOfTokens = (tokens: readonly string[]): string =>
  convertVueFileRoutePath(`${tokenKey(tokens)}${PAGE_EXTENSION}`, { dialect: "unplugin" }).url

const flagOf = (ctx: DiscoverContext, node: TsNode): boolean | null => {
  const inner = ctx.unwrap(node)
  if (inner.kind === ctx.ts.SyntaxKind.TrueKeyword) return true
  if (inner.kind === ctx.ts.SyntaxKind.FalseKeyword) return false
  return null
}

const stringsOfNode = (ctx: DiscoverContext, node: TsNode | undefined): readonly string[] => {
  const single = literalOf(ctx, node)
  if (single !== null) return [single]
  const array = ctx.ast.asArrayLiteral(node)
  return array === null ? [] : array.elements.flatMap((element) => literalOf(ctx, element) ?? [])
}

const signalsOfNode = (ctx: DiscoverContext, node: TsNode | undefined): VueAuthSignals => {
  const meta = ctx.ast.asObjectLiteral(node)
  if (meta === null) return NO_SIGNALS
  const members = membersOf(ctx, meta)
  const flags = sortBy([...members.entries()], ([key]) => key).flatMap(([key, value]) => {
    const flag = flagOf(ctx, value)
    return flag === null ? [] : [[key, flag] as const]
  })
  return {
    middleware: sortedUnique(stringsOfNode(ctx, members.get(PAGE_KEYS.middleware))),
    flags: Object.fromEntries(flags),
  }
}

const signalsOfJson = (meta: unknown): VueAuthSignals => {
  if (!isRecord(meta)) return NO_SIGNALS
  const flags = sortBy(Object.entries(meta), ([key]) => key).flatMap(([key, value]) =>
    typeof value === "boolean" ? [[key, value] as const] : [],
  )
  return { middleware: sortedUnique(stringsOfValue(meta[PAGE_KEYS.middleware])), flags: Object.fromEntries(flags) }
}

const redirectOfNode = (ctx: DiscoverContext, node: TsNode): RouteRedirect => {
  const literal = literalOf(ctx, node)
  if (literal !== null) return { kind: "path", value: literal }
  const object = ctx.ast.asObjectLiteral(node)
  const members = object === null ? null : membersOf(ctx, object)
  const name = literalOf(ctx, members?.get(PAGE_KEYS.name))
  if (name !== null) return { kind: "name", value: name }
  const path = literalOf(ctx, members?.get(PAGE_KEYS.path))
  if (path !== null) return { kind: "path", value: path }
  const inner = ctx.unwrap(node)
  if (ctx.ts.isArrowFunction(inner) || ctx.ts.isFunctionExpression(inner)) return { kind: "function" }
  return { kind: "opaque", text: inner.getText() }
}

const redirectOfJson = (value: unknown): RouteRedirect | null => {
  if (typeof value === "string") return { kind: "path", value }
  if (!isRecord(value)) return null
  const { name, path } = value
  if (typeof name === "string") return { kind: "name", value: name }
  if (typeof path === "string") return { kind: "path", value: path }
  return { kind: "opaque", text: JSON.stringify(value) }
}

const nameOfNode = (ctx: DiscoverContext, node: TsNode): string | null | undefined => {
  if (flagOf(ctx, node) === false) return null
  return literalOf(ctx, node) ?? undefined
}

const definePageOverrides = (ctx: DiscoverContext, file: string, object: ts.ObjectLiteralExpression): PageOverrides => {
  const members = membersOf(ctx, object)
  const name = members.get(PAGE_KEYS.name)
  const path = literalOf(ctx, members.get(PAGE_KEYS.path))
  const alias = members.get(PAGE_KEYS.alias)
  const redirect = members.get(PAGE_KEYS.redirect)
  const meta = members.get(PAGE_KEYS.meta)
  const pageName = name === undefined ? undefined : nameOfNode(ctx, name)
  return {
    line: ctx.lineOf(file, object),
    ...(pageName === undefined ? {} : { name: pageName }),
    ...(path === null ? {} : { path }),
    ...(alias === undefined ? {} : { alias: stringsOfNode(ctx, alias) }),
    ...(redirect === undefined ? {} : { redirect: redirectOfNode(ctx, redirect) }),
    ...(meta === undefined ? {} : { authSignals: signalsOfNode(ctx, meta) }),
  }
}

const reportUnreadablePage = (ctx: DiscoverContext, file: string, line: number, what: string): void =>
  ctx.diagnostic({
    severity: "info",
    code: "screens/unsupported-router-style",
    message: `${what}; the page keeps its file-based name, path and meta`,
    file,
    line,
  })

const readDefinePage = (ctx: DiscoverContext, file: string): PageOverrides | null => {
  const source = ctx.sourceFile(file)
  if (source === null) return null
  const calls: ts.CallExpression[] = []
  walk(source, (node) => {
    const call = ctx.ast.asCallExpression(node)
    if (call !== null && ctx.ast.asIdentifier(call.expression)?.text === DEFINE_PAGE) calls.push(call)
  })
  const [call] = calls
  if (call === undefined) return null
  const object = ctx.ast.asObjectLiteral(call.arguments[0])
  if (object !== null) return definePageOverrides(ctx, file, object)
  reportUnreadablePage(ctx, file, ctx.lineOf(file, call), `${DEFINE_PAGE}(...) has no literal object argument`)
  return null
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const jsonOverrides = (value: Readonly<Record<string, unknown>>, line: number): PageOverrides => {
  const { name, path, alias, redirect, meta } = value
  const pageRedirect = redirectOfJson(redirect)
  return {
    line,
    ...(typeof name === "string" ? { name } : {}),
    ...(name === false ? { name: null } : {}),
    ...(typeof path === "string" ? { path } : {}),
    ...(alias === undefined ? {} : { alias: stringsOfValue(alias) }),
    ...(pageRedirect === null ? {} : { redirect: pageRedirect }),
    ...(meta === undefined ? {} : { authSignals: signalsOfJson(meta) }),
  }
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length

const readRouteBlock = (ctx: DiscoverContext, file: string): PageOverrides | null => {
  const text = ctx.readFile(file)
  const block = text === null ? undefined : splitSfc(text).find((candidate) => candidate.type === ROUTE_BLOCK)
  if (text === null || block === undefined) return null
  const line = lineAt(text, block.start)
  const lang = block.attrs["lang"]
  const langName = typeof lang === "string" ? lang.trim().toLowerCase() : "json5"
  const parsed = JSON_LANGS.includes(langName) ? parseJson(text.slice(block.contentStart, block.contentEnd)) : undefined
  if (isRecord(parsed)) return jsonOverrides(parsed, line)
  reportUnreadablePage(ctx, file, line, `<${ROUTE_BLOCK} lang="${langName}"> block is not JSON this source can read`)
  return null
}

const mergeOverrides = (block: PageOverrides | null, page: PageOverrides | null): PageOverrides | null => {
  if (block === null || page === null) return page ?? block
  const authSignals =
    block.authSignals === undefined || page.authSignals === undefined
      ? (page.authSignals ?? block.authSignals)
      : {
          middleware: sortedUnique([...block.authSignals.middleware, ...page.authSignals.middleware]),
          flags: { ...block.authSignals.flags, ...page.authSignals.flags },
        }
  return { ...block, ...page, ...(authSignals === undefined ? {} : { authSignals }) }
}

const pathOf = (page: PageFile, overrides: PageOverrides | null): string => overrides?.path ?? urlOfTokens(page.tokens)

const nameOf = (page: PageFile, overrides: PageOverrides | null): string | null =>
  overrides?.name === undefined ? defaultRouteName(page.tokens) : overrides.name

const nodeOf = (ctx: DiscoverContext, page: PageFile, children: readonly RouteNode[]): RouteNode => {
  const overrides = mergeOverrides(readRouteBlock(ctx, page.file), readDefinePage(ctx, page.file))
  return {
    file: page.file,
    line: overrides?.line ?? 1,
    conditions: [],
    path: pathOf(page, overrides),
    name: nameOf(page, overrides),
    entries: [{ kind: "file", file: page.file, exportName: "default" }],
    entryConditions: [],
    redirect: overrides?.redirect ?? null,
    alias: overrides?.alias ?? [],
    authSignals: overrides?.authSignals ?? NO_SIGNALS,
    hasBeforeEnter: false,
    children,
    unreadableChildren: [],
  }
}

const buildTree = (ctx: DiscoverContext, pages: readonly PageFile[]): readonly RouteNode[] => {
  const parents = new Map<string, PageFile>()
  for (const page of pages) {
    const key = tokenKey(page.tokens)
    if (!isIndex(page) && !parents.has(key)) parents.set(key, page)
  }
  const childrenOf = new Map<string, PageFile[]>()
  const roots: PageFile[] = []
  for (const page of pages) {
    const parentKey = parentKeyOf(page, parents)
    if (parentKey === null) {
      roots.push(page)
      continue
    }
    childrenOf.set(parentKey, [...(childrenOf.get(parentKey) ?? []), page])
  }
  const build = (page: PageFile): RouteNode => {
    const key = tokenKey(page.tokens)
    const own = isIndex(page) || parents.get(key) !== page ? [] : (childrenOf.get(key) ?? [])
    return nodeOf(ctx, page, own.map(build))
  }
  return roots.map(build)
}

export const readFileRoutes = (ctx: DiscoverContext): readonly RouteNode[] => {
  const { folders, dynamic } = readFolders(ctx)
  if (dynamic !== null) reportDynamicFolder(ctx, dynamic)
  return buildTree(ctx, pagesIn(ctx, folders))
}
