import { createHash } from "node:crypto"
import type { AppGraph, Diagnostic, FeatureFlagsConfig, KindRule, WrapperRule } from "../core/model.js"
import { sortedUnique } from "../core/order.js"
import type { FactExtractor } from "../extractors/types.js"
import { createComponentTreeExtractor } from "../extractors/component-tree.js"
import { createConvexExtractor } from "../extractors/convex.js"
import { DEFAULT_LOOKUP_FUNCTIONS, createFeatureFlagsExtractor } from "../extractors/feature-flags.js"
import { createFormsExtractor } from "../extractors/forms.js"
import { createHttpClientExtractor } from "../extractors/http-client.js"
import { createI18nExtractor } from "../extractors/i18n.js"
import { createMessagesExtractor } from "../extractors/messages.js"
import { createNavigationExtractor } from "../extractors/navigation.js"
import { createQueryExtractor } from "../extractors/query.js"
import { createServerFnExtractor } from "../extractors/server-fn.js"
import { createStoreExtractor } from "../extractors/store.js"
import { createTestIdsExtractor } from "../extractors/test-ids.js"
import type { Adapter, Emitter, EmitFile, NavSource, RedirectSource, ScreenSource } from "../adapters/types.js"
import type { BuiltinAdapterOptions } from "../adapters/builtin.js"
import { builtinScreenSources, createBuiltinAdapters } from "../adapters/builtin.js"
import { byAdapterPrecedence } from "../adapters/precedence.js"
import { resolveAngularAuthRules } from "../adapters/angular/auth.js"
import { resolveVueAuthRules } from "../adapters/vue-auth.js"
import { resolveNativeAuthRules } from "../adapters/native-auth.js"
import { emitDetailView } from "../emit/view-detail.js"
import { emitFullView } from "../emit/view-full.js"
import type { ViewOptions } from "../emit/view-index.js"
import { emitIndexView } from "../emit/view-index.js"
import { encodeGraphCache } from "../emit/graph-cache.js"
import type { RenderHtmlOptions } from "../emit/html.js"
import type { Locale } from "../emit/strings.js"
import type { ResolvedConfig } from "../config/types.js"

export { SOURCE_PRECEDENCE } from "../core/sources.js"
export type { BuiltinAdapterOptions }
export { builtinScreenSources, createBuiltinAdapters }

export type OwnedScreenSource = { readonly adapter: string; readonly source: ScreenSource }

export type OwnedNavSource = { readonly adapter: string; readonly source: NavSource }

export type OwnedRedirectSource = { readonly adapter: string; readonly source: RedirectSource }

export type OwnedEmitter = { readonly adapter: string; readonly emitter: Emitter }

export type PipelineRegistry = {
  readonly adapters: readonly Adapter[]
  readonly screenSources: readonly OwnedScreenSource[]
  readonly navSources: readonly OwnedNavSource[]
  readonly redirectSources: readonly OwnedRedirectSource[]
  readonly emitters: readonly OwnedEmitter[]
  readonly extractors: readonly FactExtractor[]
  readonly kindRules: readonly KindRule[]
  readonly diagnostics: readonly Diagnostic[]
  readonly emitterFor: (format: string) => OwnedEmitter | null
}

export type RegistryInput = {
  readonly adapters: readonly Adapter[]
  readonly extractors?: readonly FactExtractor[]
  readonly emitters?: readonly Emitter[]
  /** Screen sources to keep. Empty keeps every registered source. */
  readonly screenSources?: readonly string[]
  /** Nav sources to keep. Empty keeps every registered source. */
  readonly navSources?: readonly string[]
  readonly kindRules?: readonly KindRule[]
}

/**
 * §6.5. Every adapter, extractor and emitter call goes through this. A throw becomes one
 * `plugin/threw` diagnostic naming the component and the hook, and the run continues with the
 * fallback — a broken extractor degrades one fact channel, never the report.
 */
export const safeCall = <T>(
  plugin: string,
  hook: string,
  fallback: T,
  fn: () => T,
  report: (diagnostic: Diagnostic) => void,
): T => {
  try {
    return fn()
  } catch (error) {
    report({
      severity: "error",
      code: "plugin/threw",
      message: `${hook}: ${error instanceof Error ? error.message : String(error)}`,
      plugin,
    })
    return fallback
  }
}

export const createPipelineRegistry = (input: RegistryInput): PipelineRegistry => {
  const diagnostics: Diagnostic[] = []
  const seenAdapters = new Set<string>()
  const adapters: Adapter[] = []

  for (const adapter of input.adapters) {
    if (seenAdapters.has(adapter.name)) {
      diagnostics.push({
        severity: "error",
        code: "plugin/duplicate-name",
        message: "Duplicate adapter name; the later registration is skipped.",
        plugin: adapter.name,
      })
      continue
    }
    seenAdapters.add(adapter.name)
    adapters.push(adapter)
  }

  const ordered = [...adapters].sort(byAdapterPrecedence)

  const wanted = new Set(input.screenSources ?? [])

  const registeredScreenNames = new Set(ordered.flatMap((adapter) => (adapter.screens ?? []).map((source) => source.name)))
  const unknownScreenNames = [...wanted].filter((name) => !registeredScreenNames.has(name))
  if (unknownScreenNames.length > 0)
    diagnostics.push({
      severity: "error",
      code: "config/invalid-field",
      message: `Unknown screen source ${unknownScreenNames.map((name) => `'${name}'`).join(", ")}; valid names: ${[...registeredScreenNames].sort().join(", ")}.`,
      plugin: null,
    })

  const screenSources: OwnedScreenSource[] = []
  const seenSources = new Set<string>()
  for (const adapter of ordered)
    for (const source of adapter.screens ?? []) {
      if (wanted.size > 0 && !wanted.has(source.name)) continue
      if (seenSources.has(source.name)) {
        diagnostics.push({
          severity: "error",
          code: "plugin/duplicate-name",
          message: `Duplicate screen source name '${source.name}'; the later registration is skipped.`,
          plugin: adapter.name,
        })
        continue
      }
      seenSources.add(source.name)
      screenSources.push({ adapter: adapter.name, source })
    }

  const navSources: OwnedNavSource[] = []
  const wantedNav = new Set(input.navSources ?? [])
  const seenNav = new Set<string>()
  for (const adapter of ordered)
    for (const source of adapter.nav ?? []) {
      if (wantedNav.size > 0 && !wantedNav.has(source.name)) continue
      if (seenNav.has(source.name)) continue
      seenNav.add(source.name)
      navSources.push({ adapter: adapter.name, source })
    }

  const redirectSources: OwnedRedirectSource[] = []
  const seenRedirects = new Set<string>()
  for (const adapter of ordered)
    for (const source of adapter.redirects ?? []) {
      if (seenRedirects.has(source.name)) continue
      seenRedirects.add(source.name)
      redirectSources.push({ adapter: adapter.name, source })
    }

  const emitters: OwnedEmitter[] = []
  const seenEmitters = new Set<string>()
  const addEmitter = (adapter: string, emitter: Emitter): void => {
    if (seenEmitters.has(emitter.name)) return
    seenEmitters.add(emitter.name)
    emitters.push({ adapter, emitter })
  }
  for (const adapter of ordered) for (const emitter of adapter.emitters ?? []) addEmitter(adapter.name, emitter)
  for (const emitter of input.emitters ?? []) addEmitter("appgraph", emitter)

  const kindRules = [...ordered.flatMap((adapter) => adapter.kindRules ?? []), ...(input.kindRules ?? [])]

  return {
    adapters: ordered,
    screenSources,
    navSources,
    redirectSources,
    emitters,
    extractors: input.extractors ?? [],
    kindRules,
    diagnostics,
    emitterFor: (format) => emitters.find((entry) => entry.emitter.name === format) ?? null,
  }
}

/** The adapter options a resolved config implies — the one mapping from config keys to adapter factories. */
export const builtinAdapterOptionsOf = (
  config: Pick<
    ResolvedConfig,
    | "menus"
    | "pathlessRoles"
    | "entryComponents"
    | "adminjs"
    | "reactRouter"
    | "vueAuth"
    | "angular"
    | "redirects"
    | "expoRouter"
    | "reactNavigation"
    | "nativeAuth"
  >,
  wrapperRoles: readonly WrapperRule[] = [],
): BuiltinAdapterOptions => ({
  wrapperRoles,
  menus: config.menus,
  pathlessRoles: config.pathlessRoles,
  entryComponents: config.entryComponents,
  adminjs: config.adminjs,
  vueAuthRules: resolveVueAuthRules(config),
  angularAuthRules: resolveAngularAuthRules(config),
  nativeAuthRules: resolveNativeAuthRules(config),
  expoRouter: config.expoRouter,
  reactNavigation: config.reactNavigation.pathTables === undefined ? {} : { pathTables: config.reactNavigation.pathTables },
  unauthenticatedTarget: config.redirects.unauthenticated,
  ...(config.reactRouter.routeDialect === undefined ? {} : { routeDialect: config.reactRouter.routeDialect }),
})

/** The built-in nav sources, in registration order. */
export const builtinNavSources = (): readonly NavSource[] =>
  createPipelineRegistry({ adapters: createBuiltinAdapters() }).navSources.map((owned) => owned.source)


// ---------------------------------------------------------------------------
// Built-in fact extractors. Registry order IS execution order (§11 rule 7).
// ---------------------------------------------------------------------------

export type DefaultExtractorOptions = {
  readonly kindRules?: readonly KindRule[]
  readonly testIdAttribute?: string | null
  readonly featureFlags?: FeatureFlagsConfig
}

const featureFlagOptionsOf = (config: FeatureFlagsConfig | undefined) =>
  config?.lookupFunctions === undefined || config.lookupFunctions.length === 0
    ? {}
    : { lookupFunctions: sortedUnique([...DEFAULT_LOOKUP_FUNCTIONS, ...config.lookupFunctions]) }

export const createDefaultExtractors = (options: DefaultExtractorOptions = {}): readonly FactExtractor[] => [
  createComponentTreeExtractor(options.kindRules === undefined ? {} : { kindRules: options.kindRules }),
  createHttpClientExtractor(),
  createServerFnExtractor(),
  createNavigationExtractor(),
  createQueryExtractor(),
  createConvexExtractor(),
  createStoreExtractor(),
  createI18nExtractor(),
  createFormsExtractor(),
  createFeatureFlagsExtractor(featureFlagOptionsOf(options.featureFlags)),
  createMessagesExtractor(),
  createTestIdsExtractor(
    options.testIdAttribute === undefined || options.testIdAttribute === null
      ? {}
      : { attribute: options.testIdAttribute },
  ),
]

// ---------------------------------------------------------------------------
// Built-in emitters (§14.1). Pure `AppGraph -> EmitFile[]`; the kernel writes.
// ---------------------------------------------------------------------------

export const slugOf = (url: string): string =>
  url.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "root"

const shortHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 8)

export const uniqueSlugs = (ids: readonly string[]): ReadonlyMap<string, string> => {
  const counts = new Map<string, number>()
  for (const id of ids) counts.set(slugOf(id), (counts.get(slugOf(id)) ?? 0) + 1)
  return new Map(
    ids.map((id) => {
      const slug = slugOf(id)
      return [id, (counts.get(slug) ?? 0) > 1 ? `${slug}-${shortHash(id)}` : slug] as const
    }),
  )
}

export type HtmlRenderer = (graph: AppGraph, options: RenderHtmlOptions) => string

export type BuiltinEmitterOptions = ViewOptions & {
  readonly locale?: Locale
  readonly artifactName?: string
  readonly renderHtml?: HtmlRenderer
}

const htmlEmitter = (name: string, locale: Locale | undefined, render: HtmlRenderer): Emitter => ({
  name: "html",
  emit: (graph, ctx): readonly EmitFile[] => [
    {
      path: `${name}.html`,
      content: render(graph, {
        ...(locale === undefined ? {} : { locale }),
        ...(ctx.timestamp === null ? { noTimestamp: true } : { generatedAt: ctx.timestamp }),
      }),
    },
  ],
})

const artifact = (options: BuiltinEmitterOptions): string => options.artifactName ?? "appgraph"

export const createBuiltinEmitters = (options: BuiltinEmitterOptions = {}): readonly Emitter[] => {
  const name = artifact(options)
  const view: ViewOptions = options

  return [
    {
      name: "full",
      emit: (graph): readonly EmitFile[] => [{ path: `${name}.yaml`, content: emitFullView(graph, view) }],
    },
    {
      name: "index",
      emit: (graph): readonly EmitFile[] => [
        { path: `${name}.index.yaml`, content: emitIndexView(graph, view) },
      ],
    },
    {
      name: "detail",
      emit: (graph, ctx): readonly EmitFile[] => {
        const requested = ctx.options["screen"]
        const ids =
          typeof requested === "string" && requested !== ""
            ? [requested]
            : graph.screens.map((screen) => screen.id)
        const unique = sortedUnique(ids)
        const slugs = uniqueSlugs(unique)
        return unique.map((id) => ({
          path: `${name}.${slugs.get(id) ?? slugOf(id)}.yaml`,
          content: emitDetailView(graph, id, view),
        }))
      },
    },
    {
      name: "graph",
      emit: (graph): readonly EmitFile[] => [{ path: `${name}.graph.json`, content: encodeGraphCache(graph) }],
    },
    ...(options.renderHtml === undefined ? [] : [htmlEmitter(name, options.locale, options.renderHtml)]),
  ]
}
