import type ts from "typescript"
import { walk } from "../core/ast.js"
import type { Binding, Evidence } from "../core/model.js"
import { collectStringMembers } from "../core/strings.js"
import { convertAdminJsUrl, expandAdminJsTemplate, paramsOf } from "../core/url.js"
import type {
  Adapter,
  DetectResult,
  DiscoverContext,
  EntryContext,
  EntryRef,
  FileEntryRef,
  ProjectContext,
  ScreenDraft,
  ScreenSource,
  TsNode,
} from "./types.js"
import { SCRIPT_GLOB } from "../core/extensions.js"
import { lineAt, objectMembers, type ObjectMember } from "./source-utils.js"

export const SOURCE_NAME = "adminjs"

/**
 * An action with no custom component still gets a screen, because its URL is real and
 * discoverable — the render tree is empty because AdminJS renders it from library-internal components
 * this tool never sees. "URL reachable, render tree empty" is the honest answer; a fabricated tree is
 * not.
 */
export const GENERATED_KIND_TAG = "generated"

const OPTIONS_TYPE = /\bAdminJSOptions\b/

const ROOT_PATH_MEMBER = /\brootPath\s*:/

const RESOURCES_MEMBER = /\bresources\s*:/

const DETECT_SCORE = 100

const DEFAULT_ROOT_PATH = "/"

const LIST_ACTION = "list"

/**
 * `ADMINJS_RESOURCE_TEMPLATE` covers the resource landing page (`list`). The other two are the same
 * template family for the remaining actions: AdminJS addresses a resource-scoped action under
 * `actions/` and a record-scoped one under `records/<id>/`. Keeping one screen per (resource, action)
 * REQUIRES distinct templates — a shared template would collapse every action of a resource into one
 * screen, because a URL activation IS the screen identity (§4.1).
 */
export const RESOURCE_ACTION_TEMPLATE = "${rootPath}resources/${id}/actions/${action}"

export const RECORD_ACTION_TEMPLATE = "${rootPath}resources/${id}/records/${recordId}/${action}"

export const BULK_ACTION_TEMPLATE = "${rootPath}resources/${id}/bulk/${action}"

const RECORD_ID_PARAM = ":recordId"

export type ActionScope = "resource" | "record" | "bulk"

export type AdminJsActionSpec = {
  readonly name: string
  readonly scope: ActionScope
}

/**
 * AdminJS's own record-scoped built-ins. This is a fact about AdminJS, so it is NOT part of the
 * configurable default list: replacing which actions get synthesized must not silently re-scope
 * `edit` and move its URL out of `records/`.
 */
const BUILTIN_RECORD_ACTIONS: readonly string[] = ["show", "edit", "delete"]

const BUILTIN_BULK_ACTIONS: readonly string[] = ["bulkDelete"]

const DECLARED_SCOPES: ReadonlyMap<string, ActionScope> = new Map([
  ["record", "record"],
  ["bulk", "bulk"],
])

const ACTION_TEMPLATES: Readonly<Record<ActionScope, string>> = {
  resource: RESOURCE_ACTION_TEMPLATE,
  record: RECORD_ACTION_TEMPLATE,
  bulk: BULK_ACTION_TEMPLATE,
}

/** The AdminJS actions that have a navigable URL even when the resource declares nothing. */
export const DEFAULT_ACTIONS: readonly AdminJsActionSpec[] = [
  { name: LIST_ACTION, scope: "resource" },
  { name: "new", scope: "resource" },
  { name: "show", scope: "record" },
  { name: "edit", scope: "record" },
]

export type AdminJsOptions = {
  /** Project-relative path of the `AdminJSOptions` file. Supplied, the content probe is skipped. */
  readonly optionsFile?: string
  /** Project-relative path of the `componentLoader` file, when it is not reachable by import. */
  readonly componentLoaderFile?: string
  readonly defaultActions?: readonly AdminJsActionSpec[]
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const propertyNamesOf = (ctx: ProjectContext, node: ts.ObjectLiteralExpression): ReadonlySet<string> =>
  new Set(
    node.properties.flatMap((property) => {
      const { name } = property
      if (name === undefined) return []
      if (ctx.ts.isIdentifier(name)) return [name.text]
      if (ctx.ts.isStringLiteralLike(name)) return [name.text]
      return []
    }),
  )

/**
 * The regexes are a prefilter; ONE object literal must carry both members. Two unrelated objects in a
 * file, one with `resources` and one with `rootPath`, are not an AdminJS options object.
 */
const hasOptionsObject = (ctx: ProjectContext, file: string, text: string): boolean => {
  const source = ctx.ts.createSourceFile(file, text, ctx.ts.ScriptTarget.Latest, true)
  let found = false

  walk(source, (node) => {
    if (found) return
    if (!ctx.ts.isObjectLiteralExpression(node)) return
    const names = propertyNamesOf(ctx, node)
    if (names.has("resources") && names.has("rootPath")) found = true
  })

  return found
}

const matchesOptionsShape = (
  ctx: ProjectContext,
  file: string,
  text: string,
): { readonly what: string; readonly index: number } | null => {
  const typed = OPTIONS_TYPE.exec(text)
  if (typed !== null) return { what: "AdminJSOptions type reference", index: typed.index }

  const root = ROOT_PATH_MEMBER.exec(text)
  if (root === null || !RESOURCES_MEMBER.test(text)) return null
  if (!hasOptionsObject(ctx, file, text)) return null
  return { what: "options literal with resources and rootPath", index: root.index }
}

const probeOptions = (ctx: ProjectContext): readonly Evidence[] => {
  const hits: Evidence[] = []

  for (const file of ctx.glob(SCRIPT_GLOB)) {
    if (ctx.isGenerated(file)) continue
    const text = ctx.readFile(file)
    if (text === null) continue

    const hit = matchesOptionsShape(ctx, file, text)
    if (hit !== null) hits.push({ what: hit.what, file, line: lineAt(text, hit.index) })
  }

  return hits
}

export const detectAdminJs = (ctx: ProjectContext, options: AdminJsOptions = {}): DetectResult => {
  if (!ctx.hasDependency("adminjs")) return { score: 0, evidence: [] }

  const dependency: Evidence = { what: "adminjs dependency", file: "package.json", line: 1 }
  const configured = options.optionsFile

  if (configured !== undefined)
    return ctx.exists(configured)
      ? {
          score: DETECT_SCORE,
          evidence: [dependency, { what: "configured AdminJS options file", file: configured, line: 1 }],
        }
      : { score: 0, evidence: [] }

  const hits = probeOptions(ctx)
  return hits.length === 0 ? { score: 0, evidence: [] } : { score: DETECT_SCORE, evidence: [dependency, ...hits] }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

type DeclarationSite = {
  readonly file: string
  readonly exportName: string
}

type ResourceSite = {
  readonly file: string
  readonly options: ts.ObjectLiteralExpression
  readonly at: TsNode
  readonly expr: string
}

type ActionSite = {
  readonly name: string
  readonly scope: ActionScope
  readonly node: TsNode | null
  readonly component: ObjectMember | null
}

type ComponentResolution =
  | { readonly kind: "entry"; readonly local: string; readonly resolved: FileEntryRef }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly expr: string }

type Discovery = {
  readonly drafts: readonly ScreenDraft[]
  readonly components: ReadonlyMap<string, FileEntryRef>
}

const componentKey = (from: string, local: string): string => `${from}|${local}`

const importedBinding = (binding: Binding | null): { module: string; imported: string } | null =>
  binding !== null && (binding.kind === "import" || binding.kind === "dynamic-import")
    ? { module: binding.module, imported: binding.imported }
    : null

const withTrailingSlash = (rootPath: string): string =>
  rootPath.endsWith("/") ? rootPath : `${rootPath}/`

const runDiscovery = (ctx: DiscoverContext, options: AdminJsOptions): Discovery => {
  const defaultActions = options.defaultActions ?? DEFAULT_ACTIONS

  const drafts: ScreenDraft[] = []
  const components = new Map<string, FileEntryRef>()
  const ordinals = new Map<string, number>()
  const loaderMaps = new Map<string, ReadonlyMap<string, string>>()
  const memberTables = new Map<string, ReadonlyMap<string, string>>()
  const reportedSpecs = new Set<string>()

  const nextOrdinal = (file: string): number => {
    const ordinal = ordinals.get(file) ?? 0
    ordinals.set(file, ordinal + 1)
    return ordinal
  }

  const membersFor = (file: string): ReadonlyMap<string, string> => {
    const cached = memberTables.get(file)
    if (cached !== undefined) return cached

    const source = ctx.sourceFile(file)
    const table = source === null ? new Map<string, string>() : collectStringMembers(ctx.ts, source)
    memberTables.set(file, table)
    return table
  }

  const membersOf = (object: ts.ObjectLiteralExpression): readonly ObjectMember[] => objectMembers(ctx.ast, object)

  const memberValue = (object: ts.ObjectLiteralExpression, name: string): ObjectMember | null =>
    membersOf(object).find((member) => member.name === name) ?? null

  const memberNames = (object: ts.ObjectLiteralExpression): readonly string[] =>
    membersOf(object).map((member) => member.name)

  /**
   * A `Resource.Orders` enum member folds through the shared `StringTable` when the enum file was
   * configured as a string source; the member-table fallback reads it out of whichever file actually
   * declares the enum, so a zero-config run resolves the same id.
   */
  const stringOf = (node: TsNode | undefined, file: string): string | null => {
    if (node === undefined) return null

    const flat = ctx.flattenString(node, file)
    if (flat !== null && !flat.dynamic) return flat.value

    const access = ctx.ast.asPropertyAccess(node)
    if (access === null) return null
    const root = ctx.ast.asIdentifier(access.expression)
    if (root === null) return null

    const shared = ctx.strings.get(`${root.text}.${access.name.text}`)
    if (shared !== null) return shared

    const own = membersFor(file).get(`${root.text}.${access.name.text}`)
    if (own !== undefined) return own

    const imported = importedBinding(ctx.bindingsFor(file).get(root.text))
    if (imported === null) return null
    const declaring = ctx.resolveModule(file, imported.module)
    if (declaring === null) return null
    return membersFor(declaring).get(`${imported.imported}.${access.name.text}`) ?? null
  }

  // ---- Pass A: the componentLoader table -----------------------------------

  const addCallOf = (node: TsNode): { readonly name: string; readonly spec: string } | null => {
    const call = ctx.ast.asCallExpression(node)
    if (call === null) return null

    const callee = ctx.ast.asPropertyAccess(call.expression)
    if (callee === null) return null
    if (callee.name.text !== "add" && callee.name.text !== "override") return null

    const name = ctx.ast.asStringLiteralLike(call.arguments[0])
    const spec = ctx.ast.asStringLiteralLike(call.arguments[1])
    if (name === null || spec === null) return null
    return { name: name.text, spec: spec.text }
  }

  const loaderMapFor = (loaderFile: string): ReadonlyMap<string, string> => {
    const cached = loaderMaps.get(loaderFile)
    if (cached !== undefined) return cached

    const table = new Map<string, string>()
    loaderMaps.set(loaderFile, table)

    const source = ctx.sourceFile(loaderFile)
    if (source === null) return table

    const record = (key: string, spec: string, node: TsNode): void => {
      if (table.has(key)) return

      // Every registered path is written with the `.js` specifier `nodenext` demands while the file on
      // disk is `.tsx`. The core resolver's `extensionRewrites` own that rewrite; no extension
      // is ever string-manipulated here.
      const file = ctx.resolveModule(loaderFile, spec)
      if (file === null) {
        const reportKey = `${loaderFile}|${spec}`
        if (!reportedSpecs.has(reportKey)) {
          reportedSpecs.add(reportKey)
          ctx.diagnostic({
            severity: "warning",
            code: "screens/dynamic-registry",
            message: `componentLoader registered '${key}' as '${spec}', which resolves to no file in this project`,
            file: loaderFile,
            line: ctx.lineOf(loaderFile, node),
          })
        }
        return
      }
      table.set(key, file)
    }

    // The key a resource writes is the `Components` PROPERTY name, which is routinely different from
    // the name handed to `componentLoader.add` (`BookEditor` vs `BookEditorComponent`).
    // Both are recorded, property names first.
    walk(source, (node) => {
      const object = ctx.ast.asObjectLiteral(node)
      if (object === null) return
      for (const member of membersOf(object)) {
        const add = addCallOf(member.value)
        if (add !== null) record(member.name, add.spec, member.node)
      }
    })

    walk(source, (node) => {
      const add = addCallOf(node)
      if (add !== null) record(add.name, add.spec, node)
    })

    return table
  }

  const loaderFileFrom = (file: string, local: string): string | null => {
    const imported = importedBinding(ctx.bindingsFor(file).get(local))
    if (imported === null) return null
    return ctx.resolveModule(file, imported.module)
  }

  const loaderFileFor = (file: string): string | null =>
    options.componentLoaderFile ??
    loaderFileFrom(file, "Components") ??
    loaderFileFrom(file, "componentLoader")

  // ---- Pass B: the options literal and its resources array -----------------

  const lastArrayChild = (node: TsNode): ts.ArrayLiteralExpression | null => {
    let found: ts.ArrayLiteralExpression | null = null
    node.forEachChild((child) => {
      const array = ctx.ast.asArrayLiteral(child)
      if (array !== null) found = array
    })
    return found
  }

  const resolveArray = (
    node: TsNode | undefined,
    file: string,
  ): { readonly array: ts.ArrayLiteralExpression; readonly file: string } | null => {
    if (node === undefined) return null

    const direct = ctx.ast.asArrayLiteral(node)
    if (direct !== null) return { array: direct, file }

    const identifier = ctx.ast.asIdentifier(node)
    if (identifier === null) return null

    const imported = importedBinding(ctx.bindingsFor(file).get(identifier.text))
    const declaring = imported === null ? file : ctx.resolveModule(file, imported.module)
    if (declaring === null) return null

    const source = ctx.sourceFile(declaring)
    const declaration =
      source === null ? null : ctx.ast.declarationOf(source, imported?.imported ?? identifier.text)
    const array = declaration === null ? null : lastArrayChild(declaration)
    return array === null ? null : { array, file: declaring }
  }

  const newAdminJsArgument = (source: ts.SourceFile): ts.ObjectLiteralExpression | null => {
    let found: ts.ObjectLiteralExpression | null = null
    walk(source, (node) => {
      if (found !== null) return
      const created = ctx.ast.asNewExpression(node)
      if (created === null) return
      if (ctx.ast.asIdentifier(created.expression)?.text !== "AdminJS") return
      found = ctx.ast.asObjectLiteral(created.arguments?.[0])
    })
    return found
  }

  /** `walk` visits a parent before its children, so the OUTERMOST candidate literal is found first. */
  const optionsLiteralIn = (file: string): ts.ObjectLiteralExpression | null => {
    const source = ctx.sourceFile(file)
    if (source === null) return null

    const constructed = newAdminJsArgument(source)
    if (constructed !== null) return constructed

    let found: ts.ObjectLiteralExpression | null = null
    walk(source, (node) => {
      if (found !== null) return
      const object = ctx.ast.asObjectLiteral(node)
      if (object === null) return
      const names = memberNames(object)
      if (names.includes("resources") || names.includes("pages")) found = object
    })
    return found
  }

  const declarationSiteOf = (file: string, local: string): DeclarationSite | null => {
    const imported = importedBinding(ctx.bindingsFor(file).get(local))
    if (imported !== null) {
      const module = ctx.resolveModule(file, imported.module)
      if (module === null) return null
      return ctx.declaredExport(module, imported.imported)
    }

    const source = ctx.sourceFile(file)
    if (source === null || ctx.ast.declarationOf(source, local) === null) return null
    return { file, exportName: local }
  }

  const resourceOptionsIn = (declaration: TsNode): ts.ObjectLiteralExpression | null => {
    let found: ts.ObjectLiteralExpression | null = null
    walk(declaration, (node) => {
      if (found !== null) return
      const object = ctx.ast.asObjectLiteral(node)
      if (object === null) return

      const nested = ctx.ast.asObjectLiteral(memberValue(object, "options")?.value)
      if (nested !== null) {
        found = nested
        return
      }
      if (memberValue(object, "id") !== null || memberValue(object, "actions") !== null) found = object
    })
    return found
  }

  const resourceSiteOf = (element: TsNode, file: string): ResourceSite | null => {
    const expr = ctx.ast.conditionText(element)

    const inline = ctx.ast.asObjectLiteral(element)
    if (inline !== null) {
      const own = resourceOptionsIn(inline)
      return own === null ? null : { file, options: own, at: inline, expr }
    }

    const call = ctx.ast.asCallExpression(element)
    const callee = call === null ? null : ctx.ast.asIdentifier(call.expression)
    if (callee === null) return null

    const target = declarationSiteOf(file, callee.text)
    if (target === null) return null

    const source = ctx.sourceFile(target.file)
    const declaration = source === null ? null : ctx.ast.declarationOf(source, target.exportName)
    if (declaration === null) return null

    const resourceOptions = resourceOptionsIn(declaration)
    return resourceOptions === null
      ? null
      : { file: target.file, options: resourceOptions, at: resourceOptions, expr }
  }

  // ---- Pass C: ids, actions and their components ---------------------------

  const scopeOf = (name: string, actionType: string | null): ActionScope => {
    if (actionType !== null) return DECLARED_SCOPES.get(actionType) ?? "resource"
    if (BUILTIN_BULK_ACTIONS.includes(name)) return "bulk"
    // An undeclared `actionType` on a custom action: AdminJS resolves it from the action
    // it extends, which is not readable here. Resource scope is assumed so no `:recordId` param is
    // invented for an action that may not take one.
    return BUILTIN_RECORD_ACTIONS.includes(name) ? "record" : "resource"
  }

  const componentOf = (
    member: ObjectMember | null,
    file: string,
    fallbackLoader: string | null,
  ): ComponentResolution => {
    if (member === null) return { kind: "absent" }

    const value = ctx.unwrap(member.value)
    if (value.kind === ctx.ts.SyntaxKind.FalseKeyword) return { kind: "absent" }

    const fileEntry = (target: string): FileEntryRef => ({ kind: "file", ...ctx.declaredExport(target, "default") })

    const access = ctx.ast.asPropertyAccess(value)
    if (access !== null) {
      const root = ctx.ast.asIdentifier(access.expression)
      if (root === null) return { kind: "unknown", expr: ctx.ast.conditionText(value) }

      const loader = loaderFileFor(file) ?? fallbackLoader
      const target = loader === null ? undefined : loaderMapFor(loader).get(access.name.text)
      if (target === undefined) return { kind: "unknown", expr: ctx.ast.conditionText(value) }
      return { kind: "entry", local: `${root.text}.${access.name.text}`, resolved: fileEntry(target) }
    }

    const literal = ctx.ast.asStringLiteralLike(value)
    if (literal !== null) {
      const loader = loaderFileFor(file) ?? fallbackLoader
      const target = loader === null ? undefined : loaderMapFor(loader).get(literal.text)
      if (target === undefined) return { kind: "unknown", expr: ctx.ast.conditionText(value) }
      return { kind: "entry", local: literal.text, resolved: fileEntry(target) }
    }

    return { kind: "unknown", expr: ctx.ast.conditionText(value) }
  }

  const actionsOf = (resourceOptions: ts.ObjectLiteralExpression, file: string): readonly ActionSite[] => {
    const object = ctx.ast.asObjectLiteral(memberValue(resourceOptions, "actions")?.value)

    const declared: readonly ActionSite[] =
      object === null
        ? []
        : membersOf(object).map((member): ActionSite => {
            const body = ctx.ast.asObjectLiteral(member.value)
            const component = body === null ? null : memberValue(body, "component")
            const actionType = body === null ? null : memberValue(body, "actionType")
            return {
              name: member.name,
              scope: scopeOf(member.name, actionType === null ? null : stringOf(actionType.value, file)),
              node: member.node,
              component,
            }
          })

    const names = new Set(declared.map((action) => action.name))
    const missing = defaultActions
      .filter((action) => !names.has(action.name))
      .map((action): ActionSite => ({ name: action.name, scope: action.scope, node: null, component: null }))

    return [...declared, ...missing]
  }

  const urlOf = (rootPath: string, id: string, action: ActionSite): string => {
    if (action.name === LIST_ACTION)
      return convertAdminJsUrl({ templateKind: "resource", rootPath, substitution: id }).url

    return expandAdminJsTemplate(ACTION_TEMPLATES[action.scope], {
      rootPath,
      id,
      recordId: RECORD_ID_PARAM,
      action: action.name,
    }).url
  }

  const entriesFor = (
    resolution: ComponentResolution,
    file: string,
    node: TsNode,
  ): readonly EntryRef[] => {
    if (resolution.kind === "absent") return []

    if (resolution.kind === "unknown") {
      const line = ctx.lineOf(file, node)
      ctx.diagnostic({
        severity: "info",
        code: "screens/dynamic-registry",
        message: `component '${resolution.expr}' is not a componentLoader key this source can read`,
        file,
        line,
      })
      return [{ kind: "opaque", expr: resolution.expr, file, line }]
    }

    components.set(componentKey(file, resolution.local), resolution.resolved)
    return [{ kind: "binding", from: file, local: resolution.local }]
  }

  const pushScreen = (input: {
    readonly file: string
    readonly node: TsNode
    readonly url: string | null
    readonly entries: readonly EntryRef[]
    readonly evidence: readonly Evidence[]
    readonly generated: boolean
    readonly auth?: "public"
  }): void => {
    drafts.push({
      localId: ctx.localId(input.file, { ordinal: nextOrdinal(input.file), node: input.node }),
      activations:
        input.url === null ? [] : [{ kind: "url", template: input.url, params: [...paramsOf(input.url)] }],
      entries: input.entries,
      // AdminJS renders every screen inside a library-internal shell that is not in this
      // source tree. `[]` ASSERTS that absence (§4.3) so `shell` is null and no missing splice point
      // is reported for a chain that does not exist.
      ancestors: [],
      evidence: input.evidence,
      ...(input.generated ? { kindTag: GENERATED_KIND_TAG } : {}),
      ...(input.auth === undefined ? {} : { auth: input.auth }),
    })
  }

  const emitResource = (site: ResourceSite, rootPath: string, fallbackLoader: string | null): void => {
    const idMember = memberValue(site.options, "id")
    if (idMember === null) {
      ctx.diagnostic({
        severity: "warning",
        code: "screens/dynamic-registry",
        message: `AdminJS resource '${site.expr}' declares no options.id; AdminJS takes the id from its database adapter (model or table name), which this source does not read, so no resource URL can be built — set options.id to map it`,
        file: site.file,
        line: ctx.lineOf(site.file, site.at),
      })
      return
    }

    const id = stringOf(idMember.value, site.file)

    if (id === null) {
      const expr = ctx.ast.conditionText(idMember.value)
      const line = ctx.lineOf(site.file, idMember.node)
      ctx.diagnostic({
        severity: "warning",
        code: "screens/dynamic-registry",
        message: `AdminJS resource id '${expr}' does not fold to a literal, so no resource URL can be built`,
        file: site.file,
        line,
      })
      pushScreen({
        file: site.file,
        node: site.at,
        url: null,
        entries: [{ kind: "opaque", expr, file: site.file, line }],
        evidence: [ctx.evidence("adminjs resource with an unresolved id", site.file, site.at)],
        generated: false,
      })
      return
    }

    for (const action of actionsOf(site.options, site.file)) {
      const resolution = componentOf(action.component, site.file, fallbackLoader)
      const anchor = action.component?.node ?? action.node ?? site.at
      const entries = entriesFor(resolution, site.file, anchor)

      const evidence: Evidence[] = [
        ctx.evidence(`adminjs resource '${id}'`, site.file, idMember?.node ?? site.at),
        ctx.evidence(`action '${action.name}'`, site.file, anchor),
      ]
      if (resolution.kind === "absent" && action.component !== null)
        evidence.push(ctx.evidence(`action '${action.name}' declares no component`, site.file, anchor))

      pushScreen({
        file: site.file,
        node: anchor,
        url: urlOf(rootPath, id, action),
        entries,
        evidence,
        generated: resolution.kind === "absent",
      })
    }
  }

  const emitPages = (
    optionsLiteral: ts.ObjectLiteralExpression,
    file: string,
    rootPath: string,
    fallbackLoader: string | null,
  ): void => {
    const pages = ctx.ast.asObjectLiteral(memberValue(optionsLiteral, "pages")?.value)
    if (pages === null) return

    for (const page of membersOf(pages)) {
      const body = ctx.ast.asObjectLiteral(page.value)
      const component = body === null ? null : memberValue(body, "component")
      const resolution = componentOf(component, file, fallbackLoader)

      pushScreen({
        file,
        node: page.node,
        url: convertAdminJsUrl({ templateKind: "page", rootPath, substitution: page.name }).url,
        entries: entriesFor(resolution, file, component?.node ?? page.node),
        evidence: [ctx.evidence(`adminjs page '${page.name}'`, file, page.node)],
        generated: resolution.kind === "absent",
      })
    }
  }

  const emitLogin = (optionsLiteral: ts.ObjectLiteralExpression, file: string): void => {
    const member = memberValue(optionsLiteral, "loginPath")
    const loginPath = member === null ? null : stringOf(member.value, file)
    if (member === null || loginPath === null) return

    pushScreen({
      file,
      node: member.node,
      url: ctx.normalizeUrl(loginPath),
      entries: [],
      evidence: [ctx.evidence("adminjs loginPath", file, member.node)],
      generated: true,
      auth: "public",
    })
  }

  const optionsCandidates = (): readonly string[] => {
    const configured = options.optionsFile
    if (configured !== undefined) return ctx.exists(configured) ? [configured] : []

    return ctx.glob(SCRIPT_GLOB).filter((file) => {
      if (ctx.isGenerated(file)) return false
      const text = ctx.readFile(file)
      return text !== null && matchesOptionsShape(ctx, file, text) !== null
    })
  }

  for (const file of optionsCandidates()) {
    const optionsLiteral = optionsLiteralIn(file)
    if (optionsLiteral === null) {
      ctx.nearMiss(file, "file mentions AdminJSOptions but declares no resources/pages literal")
      continue
    }

    // Pass A runs FIRST and unconditionally, so an unresolvable registered path is reported even when
    // no action ends up referencing it.
    const fallbackLoader = loaderFileFor(file)
    if (fallbackLoader !== null) loaderMapFor(fallbackLoader)

    const rawRoot = stringOf(memberValue(optionsLiteral, "rootPath")?.value, file) ?? DEFAULT_ROOT_PATH
    const rootPath = withTrailingSlash(rawRoot)

    const resources = resolveArray(memberValue(optionsLiteral, "resources")?.value, file)
    if (memberValue(optionsLiteral, "resources") !== null && resources === null)
      ctx.diagnostic({
        severity: "warning",
        code: "screens/dynamic-registry",
        message: "AdminJS `resources` is not an array literal this source can read",
        file,
        line: ctx.lineOf(file, optionsLiteral),
      })

    for (const element of resources?.array.elements ?? []) {
      const site = resourceSiteOf(element, resources?.file ?? file)
      if (site === null) {
        ctx.diagnostic({
          severity: "warning",
          code: "screens/dynamic-registry",
          message: `AdminJS resource '${ctx.ast.conditionText(element)}' does not resolve to a factory this source can read`,
          file,
          line: ctx.lineOf(file, element),
        })
        continue
      }
      emitResource(site, rootPath, fallbackLoader)
    }

    emitPages(optionsLiteral, file, rootPath, fallbackLoader)
    emitLogin(optionsLiteral, file)
  }

  return { drafts, components }
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export const createAdminJsSource = (options: AdminJsOptions = {}): ScreenSource => {
  const components = new Map<string, FileEntryRef>()

  return {
    name: SOURCE_NAME,
    detect: (ctx): DetectResult => detectAdminJs(ctx, options),
    discover: (ctx): readonly ScreenDraft[] => {
      const discovery = runDiscovery(ctx, options)
      for (const [key, entry] of discovery.components) components.set(key, entry)
      return discovery.drafts
    },
    /**
     * The seam §16.4 names: a `Components.X` key is a value in a registry object, so the core
     * resolver cannot see through it on its own. Everything else is left for the core to resolve.
     */
    resolveEntries: (refs, ctx: EntryContext): readonly EntryRef[] =>
      refs.map((ref) => {
        if (ref.kind !== "binding") return ref
        const resolved = components.get(componentKey(ref.from, ref.local))
        return resolved ?? ctx.opaque(ref.local, ref.from, 1)
      }),
  }
}

export const createAdminJsAdapter = (options: AdminJsOptions = {}): Adapter => ({
  name: SOURCE_NAME,
  screens: [createAdminJsSource(options)],
})
