import type ts from "typescript"
import { condense, isComponentTag } from "../core/ast.js"
import type { AncestorRef, Evidence, SpliceMode } from "../core/model.js"
import { convertNextPagesFile } from "../core/url.js"
import { createValueResolver, type Located, type ValueResolver } from "./array-values.js"
import { guardOfExports, type LoaderGuard } from "./loader-guards.js"
import { nextAppPageUrls } from "./next-app.js"
import {
  findConventionFile,
  memoPerRun,
  NEXT_DEFAULT_PAGE_EXTENSIONS,
  nextPageExtensions,
  nextPagesRootOf,
  pageEntryOf,
  pagesRootsIn,
} from "./next-conventions.js"
import type {
  DetectResult,
  DiscoverContext,
  EntryContext,
  FileEntryRef,
  ProjectContext,
  ScreenDraft,
  ScreenShape,
  ScreenSource,
  TsNode,
} from "./types.js"
import { importedBindingOf } from "./values.js"

/**
 * The Next.js Pages Router: one screen per file under the active `pages/` root, `pages/api/**` as API
 * routes, `_app` as the outermost layout and a literal `Page.getLayout` as the layouts inside it. A
 * `getServerSideProps` redirect guards (conditional) or redirects (unconditional) the page.
 */

const NAME = "next-pages"

/** Root files Next renders itself, never as a URL. */
const SPECIAL_URLS: ReadonlySet<string> = new Set(["/_app", "/_document", "/_error", "/404", "/500", "/_middleware"])

const DATA_FUNCTIONS = ["getServerSideProps"] as const

const APP_FILE = "_app"
const COMPONENT_PROP = "Component"
const GET_LAYOUT = "getLayout"
const SKIP_APP_LAYOUT = "skipAppLayout"
const MAX_WRAPPER_DEPTH = 8

const LAYOUT_SPLICE: SpliceMode = { kind: "children" }

export type NextPagesOptions = {
  /** Config `redirects.unauthenticated`; scopes `getServerSideProps` guards to redirects aimed at it. */
  readonly unauthenticatedTarget?: string | null
}

type PageFile = {
  readonly file: string
  readonly url: string
  readonly params: readonly string[]
  readonly isApi: boolean
}

const pageFileOf = (root: string, extensions: readonly string[], file: string): PageFile | null => {
  if (file.endsWith(".d.ts")) return null
  const conversion = convertNextPagesFile(file, extensions)
  if (conversion === null || !file.startsWith(`${root}/`) || SPECIAL_URLS.has(conversion.url)) return null
  return {
    file,
    url: conversion.url,
    params: conversion.extras.params.map((param) => param.name),
    isApi: file.startsWith(`${root}/api/`),
  }
}

const pageFilesOf = (
  ctx: Pick<ProjectContext, "glob" | "isGenerated">,
  root: string,
  extensions: readonly string[],
): readonly PageFile[] =>
  ctx
    .glob(`${root}/**/*.{${NEXT_DEFAULT_PAGE_EXTENSIONS.join(",")}}`)
    .filter((file) => !ctx.isGenerated(file))
    .map((file) => pageFileOf(root, extensions, file))
    .filter((page) => page !== null)

const detectNextPages = (ctx: ProjectContext): DetectResult => {
  const root = pagesRootsIn(ctx).value
  if (!ctx.hasDependency("next") || root === null) return { score: 0, evidence: [] }

  const files = pageFilesOf(ctx, root, NEXT_DEFAULT_PAGE_EXTENSIONS)
  const page = files.find((candidate) => !candidate.isApi)
  if (page !== undefined)
    return { score: 100, evidence: [{ what: "next.js dependency with a pages-router page", file: page.file, line: 1 }] }

  const api = files[0]
  if (api === undefined) return { score: 0, evidence: [] }
  return { score: 1, evidence: [{ what: "next.js dependency with pages-router API routes only", file: api.file, line: 1 }] }
}

// ---------------------------------------------------------------------------
// Component reading shared by `_app` and `getLayout`
// ---------------------------------------------------------------------------

type FunctionNode = ts.SignatureDeclaration & { readonly body?: ts.Node }

const isFunctionNode = (ctx: DiscoverContext, node: TsNode): node is FunctionNode =>
  ctx.ts.isArrowFunction(node) || ctx.ts.isFunctionExpression(node) || ctx.ts.isFunctionDeclaration(node)

const createComponentReader = (ctx: DiscoverContext, resolver: ValueResolver) => {
  /** `export default withTRPC(MyApp)` → `MyApp`; a declaration names itself. */
  const expressionName = (node: TsNode, depth: number): string | null => {
    const inner = ctx.unwrap(node)
    const identifier = ctx.ast.asIdentifier(inner)
    if (identifier !== null) return identifier.text
    const wrapped = ctx.ast.asCallExpression(inner)?.arguments[0]
    return wrapped === undefined || depth > MAX_WRAPPER_DEPTH ? null : expressionName(wrapped, depth + 1)
  }

  const declarationName = (declaration: TsNode): string | null => {
    if (ctx.ts.isExportAssignment(declaration)) return expressionName(declaration.expression, 0)
    if (ctx.ts.isFunctionDeclaration(declaration) || ctx.ts.isClassDeclaration(declaration))
      return declaration.name?.text ?? null
    if (ctx.ts.isVariableDeclaration(declaration)) return ctx.ast.asIdentifier(declaration.name)?.text ?? null
    return null
  }

  /** The local name the export `exportName` of `file` is declared under. */
  const componentNameOf = (file: string, exportName: string): string | null => {
    const source = ctx.sourceFile(file)
    const origin = source === null ? null : ctx.ast.exportOrigin(source, exportName)
    return origin?.kind === "declared" ? declarationName(origin.node) : null
  }

  const functionNodeOf = (node: TsNode, file: string): FunctionNode | null => {
    const located = resolver.functionOf(node, file)
    return located !== null && isFunctionNode(ctx, located.node) ? located.node : null
  }

  const componentFunctionOf = (file: string, exportName: string): FunctionNode | null => {
    const source = ctx.sourceFile(file)
    const name = componentNameOf(file, exportName)
    const declaration = source === null || name === null ? null : ctx.ast.declarationOf(source, name)
    if (declaration === null) return null
    if (ctx.ts.isFunctionDeclaration(declaration)) return declaration
    if (!ctx.ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return null
    return functionNodeOf(declaration.initializer, file)
  }

  /** A tag's declaring component: an import followed to its declaration, else a declaration in `file`. */
  const componentOfTag = (file: string, tag: string): Pick<AncestorRef, "file" | "exportName"> | null => {
    const imported = importedBindingOf(ctx.bindingsFor(file).get(tag))
    if (imported === null) {
      const source = ctx.sourceFile(file)
      return source !== null && ctx.ast.declarationOf(source, tag) !== null ? { file, exportName: tag } : null
    }
    const declaring = ctx.resolveModule(file, imported.module)
    return declaring === null ? null : ctx.declaredExport(declaring, imported.imported)
  }

  return { componentNameOf, componentFunctionOf, componentOfTag }
}

type ComponentReader = ReturnType<typeof createComponentReader>

// ---------------------------------------------------------------------------
// `_app`
// ---------------------------------------------------------------------------

type ComponentTags = { readonly tags: readonly string[]; readonly outletTag: string }

const bindingLocal = (ctx: DiscoverContext, pattern: ts.ObjectBindingPattern): string | null => {
  const element = pattern.elements.find(
    (candidate) => ctx.ast.asIdentifier(candidate.propertyName ?? candidate.name)?.text === COMPONENT_PROP,
  )
  return element === undefined ? null : (ctx.ast.asIdentifier(element.name)?.text ?? null)
}

/** `const { Component } = props` inside the body. */
const destructuredFrom = (ctx: DiscoverContext, body: TsNode, param: string): readonly string[] => {
  const found: string[] = []
  const visit = (node: TsNode): void => {
    if (
      ctx.ts.isVariableDeclaration(node) &&
      ctx.ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      ctx.ast.asIdentifier(ctx.unwrap(node.initializer))?.text === param
    ) {
      const local = bindingLocal(ctx, node.name)
      if (local !== null) found.push(local)
    }
    node.forEachChild(visit)
  }
  visit(body)
  return found
}

/** Every tag text naming the `Component` prop: a destructured local or `props.Component`. */
const componentTagsOf = (ctx: DiscoverContext, fn: FunctionNode): ComponentTags => {
  const parameter = fn.parameters[0]
  if (parameter === undefined || fn.body === undefined) return { tags: [], outletTag: COMPONENT_PROP }
  if (ctx.ts.isObjectBindingPattern(parameter.name)) {
    const local = bindingLocal(ctx, parameter.name)
    return local === null ? { tags: [], outletTag: COMPONENT_PROP } : { tags: [local], outletTag: local }
  }
  const param = ctx.ast.asIdentifier(parameter.name)?.text
  if (param === undefined) return { tags: [], outletTag: COMPONENT_PROP }
  const locals = destructuredFrom(ctx, fn.body, param)
  return { tags: [`${param}.${COMPONENT_PROP}`, ...locals], outletTag: locals[0] ?? param }
}

const renderSiteOf = (ctx: DiscoverContext, fn: FunctionNode, tags: readonly string[]): TsNode | null => {
  if (fn.body === undefined) return null
  const sites = ctx.ast.jsxElementsIn(fn.body).filter((element) => tags.includes(condense(element.tagName.getText())))
  const only = sites.length === 1 ? sites[0] : undefined
  if (only === undefined) return null
  return ctx.ts.isJsxOpeningElement(only) ? only.parent : only
}

/** The `<Component …/>` site as an `at` splice; with zero or several sites, an outlet the kernel reports on. */
const appSpliceOf = (ctx: DiscoverContext, reader: ComponentReader, file: string): SpliceMode => {
  const fn = reader.componentFunctionOf(file, "default")
  if (fn === null) return { kind: "outlet", tag: COMPONENT_PROP }
  const { tags, outletTag } = componentTagsOf(ctx, fn)
  const site = renderSiteOf(ctx, fn, tags)
  return site === null ? { kind: "outlet", tag: outletTag } : { kind: "at", locator: ctx.locatorOf(site) }
}

const appAncestorOf = memoPerRun((ctx: DiscoverContext): AncestorRef | null => {
  const root = nextPagesRootOf(ctx).value
  const file = root === null ? null : findConventionFile(ctx, root, APP_FILE, nextPageExtensions(ctx).value)
  if (file === null) return null
  const reader = createComponentReader(ctx, createValueResolver(ctx))
  return { file, exportName: "default", splice: appSpliceOf(ctx, reader, file), role: "layout" }
})

// ---------------------------------------------------------------------------
// `Page.getLayout` / `Page.skipAppLayout`
// ---------------------------------------------------------------------------

type StaticAssignment = { readonly member: string; readonly value: TsNode; readonly node: TsNode }

const staticAssignmentsOf = (ctx: DiscoverContext, file: string, name: string): readonly StaticAssignment[] => {
  const source = ctx.sourceFile(file)
  if (source === null) return []
  return source.statements.flatMap((statement): readonly StaticAssignment[] => {
    if (!ctx.ts.isExpressionStatement(statement)) return []
    const assignment = statement.expression
    if (!ctx.ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ctx.ts.SyntaxKind.EqualsToken)
      return []
    const target = ctx.ast.asPropertyAccess(assignment.left)
    if (target === null || ctx.ast.asIdentifier(target.expression)?.text !== name) return []
    return [{ member: target.name.text, value: assignment.right, node: statement }]
  })
}

const isBlankChild = (ctx: DiscoverContext, child: ts.JsxChild): boolean =>
  (ctx.ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces) ||
  (ctx.ts.isJsxExpression(child) && child.expression === undefined)

const referencesName = (ctx: DiscoverContext, node: TsNode, name: string): boolean => {
  let found = ctx.ast.asIdentifier(node)?.text === name
  node.forEachChild((child) => {
    found = found || referencesName(ctx, child, name)
  })
  return found
}

/** `<A><B>{page}</B></A>` → the opening elements down to `{page}`, outermost first; `null` for any other shape. */
const wrapperChainOf = (ctx: DiscoverContext, node: TsNode, page: string): readonly ts.JsxOpeningElement[] | null => {
  const inner = ctx.unwrap(node)
  if (ctx.ast.asIdentifier(inner)?.text === page) return []
  if (ctx.ts.isJsxFragment(inner)) return childChainOf(ctx, inner.children, page)
  if (!ctx.ts.isJsxElement(inner)) return null
  const rest = childChainOf(ctx, inner.children, page)
  return rest === null ? null : [inner.openingElement, ...rest]
}

const childChainOf = (
  ctx: DiscoverContext,
  children: ts.NodeArray<ts.JsxChild>,
  page: string,
): readonly ts.JsxOpeningElement[] | null => {
  const carriers = children.filter((child) => !isBlankChild(ctx, child) && referencesName(ctx, child, page))
  const only = carriers.length === 1 ? carriers[0] : undefined
  if (only === undefined) return null
  if (!ctx.ts.isJsxExpression(only)) return wrapperChainOf(ctx, only, page)
  return only.expression === undefined ? null : wrapperChainOf(ctx, only.expression, page)
}

type LayoutRead =
  | { readonly kind: "none" }
  | { readonly kind: "chain"; readonly ancestors: readonly AncestorRef[]; readonly tags: readonly string[] }
  | { readonly kind: "unsupported"; readonly reason: string }

const NO_LAYOUT: LayoutRead = { kind: "none" }

const layoutTagsOf = (ctx: DiscoverContext, chain: readonly ts.JsxOpeningElement[]): readonly string[] | null => {
  const tags = chain.flatMap((element) => {
    const tag = ctx.ast.tagName(element)
    return tag !== null && !isComponentTag(tag) ? [] : [ctx.ts.isIdentifier(element.tagName) ? element.tagName.text : null]
  })
  return tags.every((tag) => tag !== null) ? tags.filter((tag) => tag !== null) : null
}

const getLayoutRead = (ctx: DiscoverContext, resolver: ValueResolver, reader: ComponentReader, value: Located): LayoutRead => {
  const fn = resolver.functionOf(value.node, value.file)
  const parameter = fn !== null && isFunctionNode(ctx, fn.node) ? fn.node.parameters[0] : undefined
  const page = ctx.ast.asIdentifier(parameter?.name)?.text
  const returned = fn === null ? null : resolver.returnedBy(fn.node)
  if (fn === null || page === undefined || returned === null)
    return { kind: "unsupported", reason: "is not a `(page) => <Layout>{page}</Layout>` function" }

  const chain = wrapperChainOf(ctx, returned, page)
  if (chain === null) return { kind: "unsupported", reason: "does not return JSX wrapping its page argument as children" }
  const tags = layoutTagsOf(ctx, chain)
  if (tags === null) return { kind: "unsupported", reason: "wraps the page in a member-expression tag" }

  const ancestors = tags.map((tag) => reader.componentOfTag(fn.file, tag))
  const missing = tags.find((_, index) => ancestors[index] === null)
  if (missing !== undefined) return { kind: "unsupported", reason: `wraps the page in <${missing}>, whose file is not resolved` }
  return {
    kind: "chain",
    tags,
    ancestors: ancestors
      .filter((ancestor) => ancestor !== null)
      .map((ancestor) => ({ ...ancestor, splice: LAYOUT_SPLICE, role: "layout" as const })),
  }
}

type PageLayout = {
  readonly entry: FileEntryRef
  readonly getLayout: StaticAssignment | null
  readonly read: LayoutRead
  readonly evidence: readonly Evidence[]
}

const pageLayoutOf = (
  ctx: DiscoverContext,
  resolver: ValueResolver,
  reader: ComponentReader,
  entry: FileEntryRef,
): PageLayout => {
  const name = reader.componentNameOf(entry.file, entry.exportName)
  const statics = name === null ? [] : staticAssignmentsOf(ctx, entry.file, name)
  const getLayout = statics.find((assignment) => assignment.member === GET_LAYOUT) ?? null
  const read =
    getLayout === null
      ? NO_LAYOUT
      : getLayoutRead(ctx, resolver, reader, { node: getLayout.value, file: entry.file })
  const evidence = statics.flatMap((assignment) => {
    if (assignment.member === SKIP_APP_LAYOUT)
      return [ctx.evidence(`${name ?? ""}.${SKIP_APP_LAYOUT} set (read as evidence only; _app stays in the chain)`, entry.file, assignment.node)]
    if (assignment.member !== GET_LAYOUT) return []
    const what =
      read.kind === "chain"
        ? `${GET_LAYOUT} wraps the page in ${read.tags.map((tag) => `<${tag}>`).join(" ") || "nothing"}`
        : `${GET_LAYOUT} not read`
    return [ctx.evidence(what, entry.file, assignment.node)]
  })
  return { entry, getLayout, read, evidence }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const guardFields = (guard: LoaderGuard): Pick<ScreenDraft, "auth" | "redirectTo"> => {
  if (guard.kind === "conditional") return { auth: "protected" }
  if (guard.kind === "unconditional" && guard.to !== null) return { redirectTo: guard.to }
  return {}
}

const guardEvidence = (ctx: DiscoverContext, guard: LoaderGuard): readonly Evidence[] =>
  guard.label === "" || guard.file === null ? [] : [ctx.evidence(guard.label, guard.file, guard.node ?? undefined)]

const reportClash = (ctx: DiscoverContext, page: PageFile, appFile: string): void =>
  ctx.diagnostic({
    severity: "warning",
    code: "screens/unsupported-next-convention",
    message: `Next build error: '${page.url}' is claimed by both app/ ('${appFile}') and pages/ ('${page.file}'); the pages screen is kept`,
    file: page.file,
  })

const reportUnsupportedLayout = (ctx: DiscoverContext, layout: PageLayout): void => {
  if (layout.read.kind !== "unsupported" || layout.getLayout === null) return
  ctx.diagnostic({
    severity: "info",
    code: "screens/unsupported-next-convention",
    message: `${GET_LAYOUT} in '${layout.entry.file}' ${layout.read.reason}; its layouts are not in the tree`,
    file: layout.entry.file,
    line: ctx.lineOf(layout.entry.file, layout.getLayout.node),
  })
}

const apiDraftOf = (ctx: DiscoverContext, page: PageFile): ScreenDraft => ({
  localId: ctx.localId(page.file),
  activations: [{ kind: "url", template: page.url, params: page.params }],
  entries: [{ kind: "file", file: page.file, exportName: "default" }],
  evidence: [ctx.evidence("next.js pages api route", page.file)],
  kindTag: "apiRoute",
})

const createPageDrafter = (ctx: DiscoverContext, options: NextPagesOptions) => {
  const resolver = createValueResolver(ctx)
  const reader = createComponentReader(ctx, resolver)
  const appUrls = nextAppPageUrls(ctx)
  const guardOptions = { unauthenticatedTarget: options.unauthenticatedTarget ?? null }

  return (page: PageFile): ScreenDraft => {
    if (page.isApi) return apiDraftOf(ctx, page)

    const appFile = appUrls.get(page.url)
    if (appFile !== undefined) reportClash(ctx, page, appFile)

    const layout = pageLayoutOf(ctx, resolver, reader, pageEntryOf(ctx, page.file))
    reportUnsupportedLayout(ctx, layout)
    const guard = guardOfExports(ctx, page.file, DATA_FUNCTIONS, guardOptions)

    return {
      localId: ctx.localId(page.file),
      activations: [{ kind: "url", template: page.url, params: page.params }],
      entries: [layout.entry],
      evidence: [ctx.evidence("next.js page", page.file), ...layout.evidence, ...guardEvidence(ctx, guard)],
      ...(layout.read.kind === "chain" && layout.read.ancestors.length > 0 ? { ancestors: layout.read.ancestors } : {}),
      ...guardFields(guard),
    }
  }
}

const discoverNextPages =
  (options: NextPagesOptions) =>
  (ctx: DiscoverContext): readonly ScreenDraft[] => {
    if (!ctx.hasDependency("next")) return []

    const root = nextPagesRootOf(ctx)
    const extensions = nextPageExtensions(ctx)
    for (const notice of [...root.notices, ...extensions.notices]) ctx.diagnostic(notice)
    if (root.value === null) return []

    return pageFilesOf(ctx, root.value, extensions.value).map(createPageDrafter(ctx, options))
  }

/** `_app` outermost, then the page's `getLayout` wrappers (already on the draft). API routes get none. */
const ancestorsOfNextPages = (screen: ScreenShape, ctx: EntryContext): readonly AncestorRef[] => {
  if (screen.kindTag === "apiRoute") return []
  const app = appAncestorOf(ctx)
  return app === null ? screen.ancestors : [app, ...screen.ancestors]
}

export const createNextPagesSource = (options: NextPagesOptions = {}): ScreenSource => ({
  name: NAME,
  detect: detectNextPages,
  discover: discoverNextPages(options),
  ancestorsOf: ancestorsOfNextPages,
})

export const nextPagesSource: ScreenSource = createNextPagesSource()
