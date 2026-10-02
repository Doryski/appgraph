import * as path from "node:path"
import { ANGULAR_CORE_PACKAGE } from "../../core/angular-compiler.js"
import type { DiagnosticInput } from "../../core/diagnostics.js"
import { SCRIPT_GLOB } from "../../core/extensions.js"
import type { AncestorRef, Evidence, RedirectRule, SpliceMode } from "../../core/model.js"
import { uniqueBy } from "../../core/order.js"
import { projectMajorOf } from "../../core/peer-loader.js"
import { isNonAppFile } from "../../core/project.js"
import { convertAngularPath, convertNextRedirectPath, joinUrl, paramsOf } from "../../core/url.js"
import type { Located } from "../array-values.js"
import type {
  Adapter,
  DetectResult,
  DiscoverContext,
  EntryRef,
  ProjectContext,
  RedirectSource,
  ScreenDraft,
  ScreenSource,
} from "../types.js"
import { type AngularAuthRules, angularAuthOf, resolveAngularAuthRules } from "./auth.js"
import { type AngularProject, type ClassRef, type RouteSource, createAngularProject } from "./project.js"
import { type AngularRouteNode, type AngularRouteRecords, createAngularRouteReader } from "./route-records.js"
import { createAngularTagResolver } from "./template-resolve.js"
import type { AngularUnreadable } from "./values.js"

export const SOURCE_NAME = "angular"

const ROUTER_PACKAGE = "@angular/router"

const UPGRADE_PACKAGE = "@angular/upgrade"

const ANGULARJS_PACKAGE = "angular"

const ANGULARJS_MAJOR = 1

const DETECT_SCORE_DATA_ROUTER = 90

const ROUTER_CALL = /\bprovideRouter\s*\(|\bRouterModule\s*\.\s*forRoot\s*\(/

const ROOT_URL = "/"

const PRIMARY_OUTLET = "primary"

const ROUTER_OUTLET_TAG = "router-outlet"

const OUTLET_SPLICE: SpliceMode = { kind: "outlet", tag: ROUTER_OUTLET_TAG }

const WILDCARD_SEGMENT = "*"

const REST_SEGMENT = ":path*"

const DEFAULT_EXPORT = "default"

const AUTHORITY_CONDITION = "authority = "

const EMPTY_LOAD_EVIDENCE = "loadComponent resolves to no component; the route renders nothing of its own and its guards decide the outcome"

const NO_DETECTION: DetectResult = { score: 0, evidence: [] }

const EMPTY_RECORDS: AngularRouteRecords = { nodes: [], unreadable: [] }

export type AngularRouterOptions = {
  readonly authRules?: AngularAuthRules
}

type Chain = readonly AngularRouteNode[]

type Frame = {
  readonly url: string
  readonly chain: Chain
  readonly ancestors: readonly AncestorRef[]
}

type Leaf = {
  readonly node: AngularRouteNode
  readonly url: string
  readonly parentUrl: string
  readonly chain: Chain
  readonly ancestors: readonly AncestorRef[]
  readonly entries: readonly EntryRef[]
}

type Walk = {
  readonly leaves: readonly Leaf[]
  readonly rules: readonly RedirectRule[]
  readonly diagnostics: readonly DiagnosticInput[]
}

type SourceRead = {
  readonly records: AngularRouteRecords
  readonly diagnostics: readonly DiagnosticInput[]
}

type Target = { readonly file: string; readonly exportName: string }

type RedirectRead = { readonly to: string | null; readonly evidence: readonly string[] }

type Placed = { readonly draft: ScreenDraft; readonly mergeable: boolean }

const EMPTY_WALK: Walk = { leaves: [], rules: [], diagnostics: [] }

const EMPTY_READ: SourceRead = { records: EMPTY_RECORDS, diagnostics: [] }

const combine = (walks: readonly Walk[]): Walk => ({
  leaves: walks.flatMap((walk) => walk.leaves),
  rules: walks.flatMap((walk) => walk.rules),
  diagnostics: walks.flatMap((walk) => walk.diagnostics),
})

const notes = (diagnostics: readonly DiagnosticInput[]): Walk => ({ ...EMPTY_WALK, diagnostics })

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length

const appFiles = (ctx: ProjectContext): readonly string[] =>
  ctx.glob(SCRIPT_GLOB).filter((file) => !isNonAppFile(file) && !ctx.isGenerated(file))

const routerFiles = (ctx: ProjectContext): readonly string[] =>
  appFiles(ctx).filter((file) => ROUTER_CALL.test(ctx.readFile(file) ?? ""))

const routerEvidence = (ctx: ProjectContext, file: string): Evidence => {
  const text = ctx.readFile(file) ?? ""
  return { what: "Angular router registration", file, line: lineAt(text, ROUTER_CALL.exec(text)?.index ?? 0) }
}

const isAngularRouterProject = (ctx: ProjectContext): boolean =>
  ctx.hasDependency(ANGULAR_CORE_PACKAGE) && ctx.hasDependency(ROUTER_PACKAGE)

export const detectAngular = (ctx: ProjectContext): DetectResult => {
  if (!isAngularRouterProject(ctx)) return NO_DETECTION
  const files = routerFiles(ctx)
  if (files.length === 0) return NO_DETECTION
  return {
    score: DETECT_SCORE_DATA_ROUTER,
    evidence: [
      { what: "@angular/core and @angular/router dependencies", file: "package.json", line: 1 },
      ...files.map((file) => routerEvidence(ctx, file)),
    ],
  }
}

const isHybrid = (ctx: ProjectContext): boolean => {
  if (!ctx.hasDependency(ANGULAR_CORE_PACKAGE)) return false
  if (ctx.hasDependency(UPGRADE_PACKAGE)) return true
  const manifest = ctx.readFile("package.json")
  return manifest !== null && projectMajorOf(manifest, ANGULARJS_PACKAGE) === ANGULARJS_MAJOR
}

const hybridDiagnostics = (ctx: ProjectContext): readonly DiagnosticInput[] =>
  isHybrid(ctx)
    ? [
        {
          severity: "info",
          code: "project/angularjs-hybrid",
          message:
            "this project also depends on AngularJS (an 'angular' 1.x or '@angular/upgrade' dependency); only the Angular router is mapped, AngularJS routes and templates are not",
          file: "package.json",
          line: 1,
        },
      ]
    : []

const unreadableDiagnostic = (item: AngularUnreadable): DiagnosticInput =>
  item.dynamic === true
    ? {
        severity: "info",
        code: "screens/dynamic-registry",
        message: `route item {${item.text}} is pushed inside a loop at runtime; its routes are not discovered`,
        file: item.file,
        line: item.line,
      }
    : {
        severity: "warning",
        code: "screens/unsupported-router-style",
        message: `route item {${item.text}} is not a route record this source can read; it and its children are not discovered`,
        file: item.file,
        line: item.line,
      }

const unmappedDiagnostic = (node: AngularRouteNode, what: string): DiagnosticInput => ({
  severity: "info",
  code: "screens/unsupported-router-style",
  message: `${what} is decided at runtime; the route and its children are not mapped`,
  file: node.file,
  line: node.line,
})

const unreadablePathDiagnostic = (node: AngularRouteNode): DiagnosticInput => ({
  severity: "warning",
  code: "screens/unsupported-router-style",
  message: "route path is not a string this source can read; the route and its children are not discovered",
  file: node.file,
  line: node.line,
})

const unreadableExportDiagnostic = (node: AngularRouteNode, file: string, exportName: string): DiagnosticInput => ({
  severity: "warning",
  code: "screens/unsupported-router-style",
  message: `loadChildren target '${exportName}' in ${file} is not a routes array this source can read; its routes are not discovered`,
  file: node.file,
  line: node.line,
})

const isRelativeSpec = (spec: string): boolean => spec.startsWith(".") || spec.startsWith("/")

const stemOf = (spec: string): string => path.posix.basename(spec).replace(/\.[cm]?[jt]sx?$/, "")

const siblingNote = (siblings: readonly string[]): string =>
  siblings.length === 0
    ? ""
    : `; a same-stem file exists (${siblings.join(", ")}), so the routes file is probably generated at build time`

const missingModuleDiagnostic = (
  ctx: ProjectContext,
  spec: string,
  file: string,
  line: number,
): DiagnosticInput => ({
  severity: "warning",
  code: "screens/route-module-missing",
  message: `routes import '${spec}' resolves to no file; none of its routes are mapped${siblingNote(ctx.glob(`**/${stemOf(spec)}.*`))}`,
  file,
  line,
})

const ancestorOf = (target: Target): AncestorRef => ({ ...target, splice: OUTLET_SPLICE, role: "layout" })

const ancestorKey = (ref: AncestorRef): string => `${ref.file}|${ref.exportName}`

const withAncestor = (ancestors: readonly AncestorRef[], ref: AncestorRef): readonly AncestorRef[] =>
  uniqueBy([...ancestors, ref], ancestorKey)

const targetUrl = (parentUrl: string, value: string): string =>
  joinUrl(parentUrl, value.startsWith("/") ? value : convertAngularPath(value).url) ?? parentUrl

const ruleSourceOf = (url: string): string =>
  url
    .split("/")
    .map((segment) => (segment === WILDCARD_SEGMENT ? REST_SEGMENT : segment))
    .join("/")

const hasGuard = (chain: Chain): boolean => chain.some((node) => node.guards.length > 0)

const conditionsOf = (chain: Chain): readonly string[] => chain.flatMap((node) => node.conditions)

const ruleOf = (leafUrl: string, parentUrl: string, node: AngularRouteNode) => {
  const source = ruleSourceOf(leafUrl)
  return (value: string, condition: string | null): readonly RedirectRule[] =>
    convertNextRedirectPath(source) === null
      ? []
      : [
          {
            source,
            destination: targetUrl(parentUrl, value),
            declaredAt: `${node.file}:${String(node.line)}`,
            condition,
            conditional: false,
          },
        ]
}

const dataRedirectRules = (
  node: AngularRouteNode,
  leafUrl: string,
  parentUrl: string,
  chain: Chain,
  rules: AngularAuthRules,
): readonly RedirectRule[] => {
  if (!hasGuard(chain)) return []
  const rule = ruleOf(leafUrl, parentUrl, node)
  return rules.redirectDataKeys.flatMap((key) => {
    const value = node.data[key]
    if (typeof value === "string") return rule(value, null)
    const map = node.dataMaps[key]
    if (map === undefined) return []
    return Object.entries(map).flatMap(([authority, target]) => rule(target, `${AUTHORITY_CONDITION}${authority}`))
  })
}

const createRouteWalk = (ctx: DiscoverContext, project: AngularProject, rules: AngularAuthRules) => {
  const reader = createAngularRouteReader(ctx, project.values)

  const missingImportOf = (located: Located): DiagnosticInput | null => {
    const identifier = ctx.ast.asIdentifier(located.node)
    const binding = identifier === null ? null : ctx.bindingsFor(located.file).get(identifier.text)
    if (binding?.kind !== "import" || binding.file !== null || !isRelativeSpec(binding.module)) return null
    return missingModuleDiagnostic(ctx, binding.module, located.file, ctx.lineOf(located.file, located.node))
  }

  const readSource = (source: RouteSource): SourceRead => {
    const missing = missingImportOf(source.node)
    if (missing !== null) return { records: EMPTY_RECORDS, diagnostics: [missing] }
    return { records: reader.readRoutes(source.node, source.env), diagnostics: [] }
  }

  const combineReads = (reads: readonly SourceRead[]): SourceRead => ({
    records: {
      nodes: reads.flatMap((read) => read.records.nodes),
      unreadable: reads.flatMap((read) => read.records.unreadable),
    },
    diagnostics: reads.flatMap((read) => read.diagnostics),
  })

  const moduleRefOf = (file: string, exportName: string): ClassRef | null => {
    const declared = ctx.declaredExport(file, exportName)
    const name = declared.exportName === DEFAULT_EXPORT ? project.defaultClassName(declared.file) : declared.exportName
    return name === null ? null : { file: declared.file, name }
  }

  const moduleRead = (file: string, exportName: string): SourceRead => {
    const ref = moduleRefOf(file, exportName)
    return ref === null ? EMPTY_READ : combineReads(project.routeModules(ref).routes.map(readSource))
  }

  const routesRead = (node: AngularRouteNode, file: string, exportName: string): SourceRead => {
    const located = project.values.exportedValue(file, exportName)
    if (located === null) return { records: EMPTY_RECORDS, diagnostics: [unreadableExportDiagnostic(node, file, exportName)] }
    return { records: reader.readRoutes(located), diagnostics: [] }
  }

  const loadedChildren = (node: AngularRouteNode): SourceRead => {
    const target = node.loadChildren
    if (target === null) return EMPTY_READ
    if (target.file === null) {
      const spec = target.unresolvedSpec ?? target.exportName
      return { records: EMPTY_RECORDS, diagnostics: [missingModuleDiagnostic(ctx, spec, node.file, node.line)] }
    }
    if (target.kind === "module") return moduleRead(target.file, target.exportName)
    return routesRead(node, target.file, target.exportName)
  }

  const bindingTarget = (from: string, local: string): Target | null => {
    const binding = ctx.bindingsFor(from).get(local)
    if (binding === null || binding.kind === "local") return { file: from, exportName: project.exportNameOf({ file: from, name: local }) }
    if (binding.kind !== "import" && binding.kind !== "dynamic-import") return null
    return binding.file === null ? null : ctx.declaredExport(binding.file, binding.imported)
  }

  const moduleTarget = (from: string, spec: string, exported: string | undefined): Target | null => {
    const file = ctx.resolveModule(from, spec)
    return file === null ? null : ctx.declaredExport(file, exported ?? DEFAULT_EXPORT)
  }

  const entryTarget = (entry: EntryRef): Target | null => {
    if (entry.kind === "file") return { file: entry.file, exportName: entry.exportName }
    if (entry.kind === "binding") return bindingTarget(entry.from, entry.local)
    if (entry.kind === "module") return moduleTarget(entry.from, entry.spec, entry.exported)
    return null
  }

  const entriesOf = (node: AngularRouteNode): readonly EntryRef[] =>
    [node.component, node.loadComponent].filter((entry) => entry !== null)

  const hostOf = (entries: readonly EntryRef[]): AncestorRef | null => {
    const [first] = entries
    const target = first === undefined ? null : entryTarget(first)
    return target === null ? null : ancestorOf(target)
  }

  const walkNodes = (nodes: Chain, unreadable: readonly AngularUnreadable[], frame: Frame): Walk =>
    combine([notes(unreadable.map(unreadableDiagnostic)), ...nodes.map((node) => walkNode(node, frame))])

  const unmappedReason = (node: AngularRouteNode): string | null => {
    if (node.matcher) return "a 'matcher' route's URL"
    if (node.outlet !== null && node.outlet !== PRIMARY_OUTLET) return `the named-outlet route (outlet '${node.outlet}')`
    return null
  }

  const childFrameOf = (frame: Frame, url: string, chain: Chain, host: AncestorRef | null): Frame => ({
    url,
    chain,
    ancestors: host === null ? frame.ancestors : withAncestor(frame.ancestors, host),
  })

  const walkNode = (node: AngularRouteNode, frame: Frame): Walk => {
    const reason = unmappedReason(node)
    if (reason !== null) return notes([unmappedDiagnostic(node, reason)])
    if (node.path === null) return notes([unreadablePathDiagnostic(node)])
    const url = joinUrl(frame.url, convertAngularPath(node.path).url) ?? frame.url
    const chain = [...frame.chain, node]
    const entries = entriesOf(node)
    const loaded = loadedChildren(node)
    const childFrame = childFrameOf(frame, url, chain, hostOf(entries))
    const below = combine([
      walkNodes(node.children, node.unreadableChildren, childFrame),
      notes(loaded.diagnostics),
      walkNodes(loaded.records.nodes, loaded.records.unreadable, childFrame),
    ])
    if (below.leaves.length > 0) return below
    if (entries.length > 0 || node.redirectTo !== null || node.loadsNothing) {
      const leaf: Leaf = { node, url, parentUrl: frame.url, chain, ancestors: frame.ancestors, entries }
      return combine([below, { ...EMPTY_WALK, leaves: [leaf] }])
    }
    const isLeaf = node.children.length === 0 && loaded.records.nodes.length === 0
    if (!isLeaf) return below
    return combine([below, { ...EMPTY_WALK, rules: dataRedirectRules(node, url, frame.url, chain, rules) }])
  }

  const walkSource = (frame: Frame) => (source: RouteSource): Walk => {
    const read = readSource(source)
    return combine([notes(read.diagnostics), walkNodes(read.records.nodes, read.records.unreadable, frame)])
  }

  return (): Walk => {
    const boot = project.bootstrap()
    const hybrid = notes(hybridDiagnostics(ctx))
    if (boot === null) return hybrid
    const root = boot.rootComponent
    const ancestors = root === null ? [] : [ancestorOf({ file: root.file, exportName: project.exportNameOf(root) })]
    const frame: Frame = { url: ROOT_URL, chain: [], ancestors }
    return combine([...boot.routes.map(walkSource(frame)), hybrid])
  }
}

const createProjectCache = () => {
  const cache = new WeakMap<object, AngularProject>()
  return (ctx: DiscoverContext): AngularProject => {
    const hit = cache.get(ctx.sourceFile)
    if (hit !== undefined) return hit
    const project = createAngularProject(ctx)
    cache.set(ctx.sourceFile, project)
    return project
  }
}

type ProjectOf = ReturnType<typeof createProjectCache>

const createModelCache = (rules: AngularAuthRules, projectOf: ProjectOf = createProjectCache()) => {
  const cache = new WeakMap<object, Walk>()
  return (ctx: DiscoverContext): Walk => {
    const hit = cache.get(ctx.sourceFile)
    if (hit !== undefined) return hit
    const walk = createRouteWalk(ctx, projectOf(ctx), rules)()
    cache.set(ctx.sourceFile, walk)
    return walk
  }
}

type ModelOf = ReturnType<typeof createModelCache>

const redirectOf = (leaf: Leaf): RedirectRead => {
  const redirect = leaf.node.redirectTo
  if (redirect === null) return { to: null, evidence: [] }
  if (redirect.kind === "function") return { to: null, evidence: ["redirectTo is a function; its target is decided at runtime"] }
  return { to: targetUrl(leaf.parentUrl, redirect.value), evidence: [] }
}

const guardNames = (node: AngularRouteNode, kind: string): readonly string[] =>
  node.guards.flatMap((guard) => (guard.kind === kind && guard.name !== null ? [guard.name] : []))

const authEvidence = (auth: "protected" | "public" | null, evidence: readonly string[]): readonly string[] => {
  if (auth === null) return ["an unrecognised route guard decides access at runtime; auth is not asserted"]
  return evidence.map((item) => `auth ${auth} from ${item}`)
}

const evidenceTexts = (leaf: Leaf, redirect: RedirectRead, auth: ReturnType<typeof angularAuthOf>): readonly string[] => [
  "Angular route record",
  ...conditionsOf(leaf.chain).map((condition) => `registered only when ${condition}`),
  ...(leaf.node.canMatchGroup
    ? [`matched only when canMatch allows it (${guardNames(leaf.node, "canMatch").join(", ") || "unnamed guard"})`]
    : []),
  ...authEvidence(auth.auth, auth.evidence),
  ...redirect.evidence,
  ...(leaf.node.loadsNothing ? [EMPTY_LOAD_EVIDENCE] : []),
]

const kindTagOf = (leaf: Leaf, redirectTo: string | null): string | null =>
  leaf.entries.length > 0 || redirectTo !== null ? null : "entryless"

const draftOf = (ctx: DiscoverContext, rules: AngularAuthRules) => (leaf: Leaf, localId: string): ScreenDraft => {
  const redirect = redirectOf(leaf)
  const auth = angularAuthOf(leaf.chain, rules)
  const kindTag = kindTagOf(leaf, redirect.to)
  const { node } = leaf
  return {
    localId,
    activations: [{ kind: "url", template: leaf.url, params: [...paramsOf(leaf.url)] }],
    entries: leaf.entries,
    auth: auth.auth,
    evidence: evidenceTexts(leaf, redirect, auth).map((what) => ({ what, file: node.file, line: node.line })),
    ...(leaf.ancestors.length === 0 ? {} : { ancestors: leaf.ancestors }),
    ...(kindTag === null ? {} : { kindTag }),
    ...(redirect.to === null ? {} : { redirectTo: ctx.normalizeUrl(redirect.to) }),
    ...(node.title === null ? {} : { title: node.title }),
  }
}

const entryKey = (entry: EntryRef): string => JSON.stringify(entry)

const evidenceKey = (evidence: Evidence): string => `${evidence.what}|${evidence.file}|${String(evidence.line)}`

const mergeDrafts = (kept: ScreenDraft, other: ScreenDraft): ScreenDraft => {
  const entries = uniqueBy([...kept.entries, ...other.entries], entryKey)
  const { kindTag, auth, ...rest } = kept
  return {
    ...rest,
    entries,
    auth: auth === other.auth ? (auth ?? null) : null,
    evidence: uniqueBy([...kept.evidence, ...other.evidence], evidenceKey),
    ...(entries.length === 0 && kindTag !== undefined ? { kindTag } : {}),
  }
}

const shadowedEvidence = (kept: ScreenDraft, leaf: Leaf): ScreenDraft => ({
  ...kept,
  evidence: [
    ...kept.evidence,
    {
      what: `declared again at ${leaf.node.file}:${String(leaf.node.line)}; Angular matches the first declaration`,
      file: leaf.node.file,
      line: leaf.node.line,
    },
  ],
})

const isMergeable = (leaf: Leaf): boolean => leaf.node.canMatchGroup || conditionsOf(leaf.chain).length > 0

const placeDrafts = (leaves: readonly Leaf[], drafts: readonly ScreenDraft[]): readonly ScreenDraft[] => {
  const placed: Placed[] = []
  const byUrl = new Map<string, number>()
  leaves.forEach((leaf, index) => {
    const draft = drafts[index]
    if (draft === undefined) return
    const at = byUrl.get(leaf.url)
    const kept = at === undefined ? undefined : placed[at]
    if (at === undefined || kept === undefined) {
      byUrl.set(leaf.url, placed.length)
      placed.push({ draft, mergeable: isMergeable(leaf) })
      return
    }
    const merge = kept.mergeable && isMergeable(leaf)
    placed[at] = merge
      ? { draft: mergeDrafts(kept.draft, draft), mergeable: true }
      : { draft: shadowedEvidence(kept.draft, leaf), mergeable: kept.mergeable }
  })
  return placed.map((entry) => entry.draft)
}

const localIdsOf = (ctx: DiscoverContext, leaves: readonly Leaf[]): readonly string[] => {
  const ordinals = new Map<string, number>()
  return leaves.map((leaf) => {
    const ordinal = ordinals.get(leaf.node.file) ?? 0
    ordinals.set(leaf.node.file, ordinal + 1)
    return ctx.localId(leaf.node.file, { ordinal })
  })
}

const diagnosticKey = (item: DiagnosticInput): string =>
  `${item.code}|${item.file ?? ""}|${String(item.line ?? 0)}|${item.message}`

const discoverAngular = (ctx: DiscoverContext, rules: AngularAuthRules, modelOf: ModelOf): readonly ScreenDraft[] => {
  const walk = modelOf(ctx)
  uniqueBy(walk.diagnostics, diagnosticKey).forEach((diagnostic) => {
    ctx.diagnostic(diagnostic)
  })
  const localIds = localIdsOf(ctx, walk.leaves)
  const toDraft = draftOf(ctx, rules)
  return placeDrafts(
    walk.leaves,
    walk.leaves.map((leaf, index) => toDraft(leaf, localIds[index] ?? "")),
  )
}

const sourceWith = (rules: AngularAuthRules, modelOf: ModelOf): ScreenSource => ({
  name: SOURCE_NAME,
  detect: detectAngular,
  discover: (ctx) => discoverAngular(ctx, rules, modelOf),
})

const redirectSourceWith = (modelOf: ModelOf): RedirectSource => ({
  name: SOURCE_NAME,
  discover: (ctx) => (detectAngular(ctx).score === 0 ? [] : modelOf(ctx).rules),
})

const rulesOf = (options: AngularRouterOptions): AngularAuthRules => options.authRules ?? resolveAngularAuthRules({})

export const createAngularSource = (options: AngularRouterOptions = {}): ScreenSource => {
  const rules = rulesOf(options)
  return sourceWith(rules, createModelCache(rules))
}

export const createAngularAdapter = (options: AngularRouterOptions = {}): Adapter => {
  const rules = rulesOf(options)
  const projectOf = createProjectCache()
  const modelOf = createModelCache(rules, projectOf)
  return {
    name: SOURCE_NAME,
    screens: [sourceWith(rules, modelOf)],
    redirects: [redirectSourceWith(modelOf)],
    templateTagResolver: (ctx) => (ctx.hasDependency(ANGULAR_CORE_PACKAGE) ? createAngularTagResolver(projectOf(ctx), ctx) : null),
  }
}
