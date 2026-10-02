import type { AppgraphConfig, Diagnostic, ExtensionRewrite, KindRule, WrapperRule } from "../core/model.js"
import { CONFIG_KIND_RULE_PRIORITY } from "../core/kinds.js"
import { sortedUnique } from "../core/order.js"
import type { MergedPresets, Preset } from "./presets.js"
import { isOneBundle, mergePresets, presetsForSources } from "./presets.js"
import { mergeByName } from "./merge.js"
import { MULTIPLE_SOURCES_CODE, formatSourceChoice } from "./source-choice.js"
import type { ResolveConfigInput, ResolvedConfig, SourceDetection } from "./types.js"
import { resolveConfig } from "./types.js"

export const NO_SOURCE_CODE = "project/no-screen-source"

/**
 * One layer of the config merge. `config` fields override earlier layers key by key; the three
 * list dimensions have explicitly different semantics — `wrapperRoles` and `kindRules` MERGE, `sources`,
 * `nav` and `formats` REPLACE — because a repo that adds one wrapper role must not lose the six the
 * stack already declared, while a repo that asks for one format must not also get the default three.
 */
export type ConfigLayer = {
  readonly name: string
  readonly config?: AppgraphConfig
  readonly wrapperRoles?: readonly WrapperRule[]
  readonly nav?: readonly string[]
}

export const LAYER_ORDER = [
  "source-defaults",
  "preset",
  "conventions",
  "config-file",
  "analyze-options",
  "cli",
] as const

export type LayerName = (typeof LAYER_ORDER)[number]

/** Values that are not part of `AppgraphConfig` because they are run-scoped, not project-scoped. */
export type RuntimeOverrides = {
  readonly allSources?: boolean
  readonly includeTestIds?: boolean
  readonly disabledChannels?: readonly string[]
  readonly appgraphVersion?: string
  readonly binName?: string
  readonly fingerprint?: string
  readonly timestamp?: string | null
  readonly verifyEmit?: boolean
}

export type DetectionSummary = {
  readonly root: string
  readonly sourceRoots: readonly string[]
  readonly detections: readonly SourceDetection[]
  readonly kindRules: readonly KindRule[]
  readonly stringSources: readonly string[]
  readonly testIds: { readonly attribute: string | null } | null
  readonly extensionRewrites: readonly ExtensionRewrite[]
  readonly candidateSuffixes: readonly string[]
  readonly diagnostics: readonly Diagnostic[]
}

export type ResolveInput = {
  readonly root?: string
  readonly detection?: DetectionSummary
  /** Overrides the presets detection would have selected. */
  readonly presets?: readonly Preset[]
  readonly sourceDefaults?: ConfigLayer
  readonly configFile?: AppgraphConfig
  readonly options?: AppgraphConfig
  readonly cli?: AppgraphConfig
  readonly extraLayers?: readonly ConfigLayer[]
  readonly runtime?: RuntimeOverrides
  readonly detections?: readonly SourceDetection[]
}

export type LayerReport = {
  readonly name: string
  readonly fields: readonly string[]
}

export type ResolvedSetup = {
  readonly config: ResolvedConfig
  readonly wrapperRoles: readonly WrapperRule[]
  readonly nav: readonly string[]
  readonly presets: readonly string[]
  readonly layers: readonly LayerReport[]
  readonly diagnostics: readonly Diagnostic[]
  /** The §10.1 trace when detection found more than one live source and nothing chose. */
  readonly refusal: string | null
}

export const REPLACED_LIST_FIELDS = ["formats", "screenSources", "sourceRoots"] as const

export const MERGED_LIST_FIELDS = [
  "kindRules",
  "exclude",
  "generated",
  "extensionRewrites",
  "candidateSuffixes",
  "stringSources",
  "redirectRules",
  "wrapperRoles",
  "pathlessRoles",
  "adminjs",
  "reactRouter",
  "vueAuth",
  "angular",
  "expoRouter",
  "reactNavigation",
  "nativeAuth",
  "featureFlags",
] as const

const joined = <T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): readonly T[] | undefined => (left === undefined ? right : right === undefined ? left : [...left, ...right])

const keyed = <T extends object>(left: T | undefined, right: T | undefined): T | undefined =>
  left === undefined || right === undefined ? (right ?? left) : { ...left, ...right }

const mergeConfigs = (base: AppgraphConfig, next: AppgraphConfig): AppgraphConfig => {
  const kindRules = joined(next.kindRules, base.kindRules)
  const exclude = joined(base.exclude, next.exclude)
  const generated = joined(base.generated, next.generated)
  const extensionRewrites = joined(base.extensionRewrites, next.extensionRewrites)
  const candidateSuffixes = joined(base.candidateSuffixes, next.candidateSuffixes)
  const stringSources = joined(base.stringSources, next.stringSources)
  const redirectRules = joined(base.redirectRules, next.redirectRules)
  const pathlessRoles = keyed(base.pathlessRoles, next.pathlessRoles)
  const adminjs = keyed(base.adminjs, next.adminjs)
  const reactRouter = keyed(base.reactRouter, next.reactRouter)
  const vueAuth = keyed(base.vueAuth, next.vueAuth)
  const angular = keyed(base.angular, next.angular)
  const expoRouter = keyed(base.expoRouter, next.expoRouter)
  const reactNavigation = keyed(base.reactNavigation, next.reactNavigation)
  const nativeAuth = keyed(base.nativeAuth, next.nativeAuth)
  const featureFlags = keyed(base.featureFlags, next.featureFlags)

  return {
    ...base,
    ...next,
    ...(kindRules === undefined ? {} : { kindRules }),
    ...(exclude === undefined ? {} : { exclude }),
    ...(generated === undefined ? {} : { generated }),
    ...(extensionRewrites === undefined ? {} : { extensionRewrites }),
    ...(candidateSuffixes === undefined ? {} : { candidateSuffixes }),
    ...(stringSources === undefined ? {} : { stringSources }),
    ...(redirectRules === undefined ? {} : { redirectRules }),
    ...(pathlessRoles === undefined ? {} : { pathlessRoles }),
    ...(adminjs === undefined ? {} : { adminjs }),
    ...(reactRouter === undefined ? {} : { reactRouter }),
    ...(vueAuth === undefined ? {} : { vueAuth }),
    ...(angular === undefined ? {} : { angular }),
    ...(expoRouter === undefined ? {} : { expoRouter }),
    ...(reactNavigation === undefined ? {} : { reactNavigation }),
    ...(nativeAuth === undefined ? {} : { nativeAuth }),
    ...(featureFlags === undefined ? {} : { featureFlags }),
  }
}

const conventionsLayer = (detection: DetectionSummary | undefined): ConfigLayer => {
  if (detection === undefined) return { name: "conventions" }

  const attribute = detection.testIds?.attribute ?? null

  return {
    name: "conventions",
    config: {
      sourceRoots: [...detection.sourceRoots],
      kindRules: [...detection.kindRules],
      ...(attribute === null ? {} : { testIdAttribute: attribute }),
      ...(detection.stringSources.length === 0 ? {} : { stringSources: [...detection.stringSources] }),
      ...(detection.extensionRewrites.length === 0 ? {} : { extensionRewrites: [...detection.extensionRewrites] }),
      ...(detection.candidateSuffixes.length === 0 ? {} : { candidateSuffixes: [...detection.candidateSuffixes] }),
    },
  }
}

const withUserPriority = (rule: KindRule): KindRule =>
  rule.priority === undefined ? { ...rule, priority: CONFIG_KIND_RULE_PRIORITY } : rule

const userLayerConfig = (config: AppgraphConfig): AppgraphConfig =>
  config.kindRules === undefined ? config : { ...config, kindRules: config.kindRules.map(withUserPriority) }

const named = (name: LayerName, config: AppgraphConfig | undefined): ConfigLayer =>
  config === undefined ? { name } : { name, config: userLayerConfig(config) }

const presetLayer = (merged: MergedPresets): ConfigLayer => ({
  name: "preset",
  config: { ...merged.config, kindRules: [...merged.kindRules] },
  wrapperRoles: merged.wrapperRoles,
  ...(merged.nav.length === 0 ? {} : { nav: merged.nav }),
})

const fieldsOf = (layer: ConfigLayer): readonly string[] =>
  sortedUnique([
    ...Object.keys(layer.config ?? {}),
    ...(layer.wrapperRoles === undefined ? [] : ["wrapperRoles"]),
    ...(layer.nav === undefined ? [] : ["nav"]),
  ])

const freezeDeep = <T>(value: T): T => {
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry)
    return Object.freeze(value)
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) freezeDeep(entry)
    return Object.freeze(value)
  }
  return value
}

/**
 * The single place the six layers collapse into the frozen object every phase reads. It is pure: no
 * filesystem, no clock, no module loading — detection and config loading happen before it, which is what
 * lets a test feed a pinned config through the same function.
 */
export const resolveAppgraphConfig = (input: ResolveInput): ResolvedSetup => {
  const { detection } = input
  const detections = input.detections ?? detection?.detections ?? []
  const live = detections.filter((entry) => entry.live)

  const presets =
    input.presets ?? presetsForSources(live.length > 0 ? live.map((entry) => entry.source) : [])
  const mergedPresets = mergePresets(presets)

  const layers: readonly ConfigLayer[] = [
    input.sourceDefaults ?? { name: "source-defaults" },
    presetLayer(mergedPresets),
    conventionsLayer(detection),
    named("config-file", input.configFile),
    named("analyze-options", input.options),
    named("cli", input.cli),
    ...(input.extraLayers ?? []),
  ]

  const collapsed = layers.reduce<AppgraphConfig>(
    (carry, layer) => mergeConfigs(carry, layer.config ?? {}),
    {},
  )

  const wrapperRoles = mergeByName(...layers.flatMap((layer) => [layer.wrapperRoles, layer.config?.wrapperRoles]))
  const nav = collapsed.navSources ?? layers.reduce<readonly string[]>((carry, layer) => layer.nav ?? carry, [])

  const runtime = input.runtime ?? {}
  const root = collapsed.root ?? input.root ?? detection?.root ?? "."

  const resolveInput: ResolveConfigInput = {
    root,
    config: collapsed,
    detections,
    presetSources: mergedPresets.screenSources,
    ...(nav.length === 0 ? {} : { navSources: nav }),
    ...(runtime.allSources === undefined ? {} : { allSources: runtime.allSources }),
    ...(runtime.includeTestIds === undefined ? {} : { includeTestIds: runtime.includeTestIds }),
    ...(runtime.disabledChannels === undefined ? {} : { disabledChannels: runtime.disabledChannels }),
    ...(runtime.appgraphVersion === undefined ? {} : { appgraphVersion: runtime.appgraphVersion }),
    ...(runtime.binName === undefined ? {} : { binName: runtime.binName }),
    ...(runtime.fingerprint === undefined ? {} : { fingerprint: runtime.fingerprint }),
    ...(runtime.timestamp === undefined ? {} : { timestamp: runtime.timestamp }),
    ...(runtime.verifyEmit === undefined ? {} : { verifyEmit: runtime.verifyEmit }),
  }

  const config = freezeDeep(resolveConfig(resolveInput))

  const diagnostics: Diagnostic[] = [...(detection?.diagnostics ?? [])]
  const refuses =
    live.length > 1 && !config.allSources && !config.explicitSource && !isOneBundle(live.map((entry) => entry.source))
  const refusal = refuses
    ? formatSourceChoice(detections, { ...(config.binName === "" ? {} : { binName: config.binName }), rootLabel: config.rootLabel })
    : null

  if (refusal !== null)
    diagnostics.push({
      severity: "error",
      code: MULTIPLE_SOURCES_CODE,
      message: refusal,
      plugin: null,
    })

  if (live.length === 0 && detections.length > 0)
    diagnostics.push({
      severity: "warning",
      code: NO_SOURCE_CODE,
      message: `No screen source scored 50 or higher. Near misses: ${
        detections
          .filter((entry) => entry.score > 0)
          .map((entry) => `${entry.source} (${String(entry.score)})`)
          .join(", ") || "none"
      }`,
      plugin: null,
    })

  return {
    config,
    wrapperRoles,
    nav,
    presets: mergedPresets.names,
    layers: layers
      .filter((layer) => fieldsOf(layer).length > 0)
      .map((layer) => ({ name: layer.name, fields: fieldsOf(layer) })),
    diagnostics,
    refusal,
  }
}
