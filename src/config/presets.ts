import type { AppgraphConfig, KindRule, WrapperRule } from "../core/model.js"
import { DEFAULT_WRAPPER_RULES } from "../core/model.js"
import { TRAVERSABLE_VOCABULARY } from "../core/kinds.js"
import { sortStrings, sortedUnique } from "../core/order.js"
import { DEFAULT_CANDIDATE_SUFFIXES } from "../core/resolver.js"
import { SFC_EXTENSIONS } from "../core/extensions.js"

/**
 * A preset is a per-stack BUNDLE: which screen source runs, which wrapper roles that stack declares,
 * and the kind rules its directory layout needs. It does NOT pick fact extractors: every extractor runs
 * on every stack, because several emit facts with no library bound at all (store-hook names, `*Field`
 * tags, locale aggregators, bare `fetch`) and a per-stack list would silently drop them. It is a
 * layer in the merge (§10), never a prerequisite — every value in it is also derivable
 * or overridable, and a repo with no preset and no config still resolves.
 */
export type Preset = {
  readonly name: string
  /** REPLACE semantics: a preset names the sources it is a preset FOR. */
  readonly screenSources: readonly string[]
  /**
   * Sources that always co-run with this stack's own (the Next family: `next-app` ↔ `next-pages`). A
   * companion joins the selection whether or not it is live, and a live set inside one bundle is not
   * a §10.1 multi-source refusal — the two are one app, not a choice.
   */
  readonly companions?: readonly string[]
  /** MERGE semantics: appended to whatever earlier layers contributed. */
  readonly wrapperRoles: readonly WrapperRule[]
  /** REPLACE semantics, like `screenSources`: the nav sources this stack runs. Omit to run them all. */
  readonly nav?: readonly string[]
  readonly kindRules: readonly KindRule[]
  readonly config: AppgraphConfig
}

const rule = (
  pathPrefix: string,
  kind: KindRule["kind"],
  options: { readonly traversable?: boolean; readonly screenEntry?: boolean; readonly priority?: number } = {},
): KindRule => ({
  match: { pathPrefix },
  kind,
  traversable: options.traversable ?? false,
  screenEntry: options.screenEntry ?? false,
  priority: options.priority ?? 20,
})

/**
 * The `uses` reachability closure must not rest on a filename regex. `HOOK_FILE` only ever sees files
 * NAMED `use…`; a kebab-case repo whose data layer is `src/server/orders.ts` would match nothing, leave
 * `traversable` `false` everywhere and keep the data layer out of the graph. Every preset
 * therefore states the data-layer directories as rules, at the preset's own priority, so the default
 * holds whatever a repo names its files. Both `src/<dir>/` and a root-level `<dir>/` are covered
 * because `sourceRoots` is not always `src` (`next-app` already declares `app/` twice for the same
 * reason).
 */
const DATA_LAYER_RULES: readonly KindRule[] = TRAVERSABLE_VOCABULARY.flatMap((entry) =>
  entry.names.flatMap((name) =>
    [`src/${name}/`, `${name}/`].map((pathPrefix) => rule(pathPrefix, entry.kind, { traversable: true })),
  ),
)

const fileRule = (fileRegex: string, kind: KindRule["kind"]): KindRule => ({
  match: { fileRegex },
  kind,
  traversable: true,
  screenEntry: false,
  priority: 20,
})

const ANGULAR_DATA_LAYER_RULES: readonly KindRule[] = [
  fileRule("\\.(?:service|resolver|guard|interceptor)\\.[cm]?[jt]s$", "service"),
  fileRule("\\.(?:store|state|selectors|reducer|reducers|actions|effects|facade|feature)\\.[cm]?[jt]s$", "store"),
]

/**
 * The `kindRules` path prefixes below (`src/routes/`, `src/layouts/`, `src/admin/`, `app/`, `src/app/`)
 * are CONVENTIONS of each stack's own documentation and scaffolding, not any one repository's layout —
 * which is why they are a preset layer rather than a hardcode. A repo that puts its routes elsewhere
 * states so in `appgraph.config`, whose `kindRules` merge over these (§10), and a repo
 * with no preset and no config still resolves.
 */
const definePresets = <T extends Readonly<Record<string, Preset>>>(presets: T): T => presets

export const PRESETS = definePresets({
  "react-router": {
    name: "react-router",
    screenSources: ["react-router"],
    wrapperRoles: DEFAULT_WRAPPER_RULES,
    kindRules: [...DATA_LAYER_RULES, rule("src/routes/", "shared"), rule("src/layouts/", "layout")],
    config: {},
  },
  wouter: {
    name: "wouter",
    screenSources: ["wouter"],
    wrapperRoles: DEFAULT_WRAPPER_RULES,
    kindRules: [...DATA_LAYER_RULES, rule("src/routes/", "shared"), rule("src/layouts/", "layout")],
    config: {},
  },
  "next-app": {
    name: "next-app",
    screenSources: ["next-app"],
    companions: ["next-pages"],
    wrapperRoles: [],
    kindRules: [
      ...DATA_LAYER_RULES,
      rule("app/", "module", { screenEntry: true }),
      rule("src/app/", "module", { screenEntry: true }),
    ],
    config: {},
  },
  "next-pages": {
    name: "next-pages",
    screenSources: ["next-pages"],
    companions: ["next-app"],
    wrapperRoles: [],
    kindRules: [
      ...DATA_LAYER_RULES,
      rule("pages/", "module", { screenEntry: true }),
      rule("src/pages/", "module", { screenEntry: true }),
    ],
    config: {},
  },
  "expo-router": {
    name: "expo-router",
    screenSources: ["expo-router"],
    wrapperRoles: [],
    kindRules: [
      ...DATA_LAYER_RULES,
      rule("app/", "module", { screenEntry: true }),
      rule("src/app/", "module", { screenEntry: true }),
    ],
    config: {},
  },
  "react-navigation": {
    name: "react-navigation",
    screenSources: ["react-navigation"],
    wrapperRoles: [],
    kindRules: [...DATA_LAYER_RULES, rule("src/screens/", "module", { screenEntry: true })],
    config: {},
  },
  "react-router-framework": {
    name: "react-router-framework",
    screenSources: ["react-router-framework"],
    wrapperRoles: [],
    kindRules: [...DATA_LAYER_RULES, rule("app/routes/", "module", { screenEntry: true })],
    // `react-router typegen` writes `.react-router/types/**/+types/*.ts` — one per route module, so
    // reading them would double every route's imports.
    config: { generated: ["**/.react-router/**", "**/+types/**"] },
  },
  "tanstack-router": {
    name: "tanstack-router",
    screenSources: ["tanstack-router"],
    wrapperRoles: [],
    kindRules: [...DATA_LAYER_RULES, rule("src/routes/", "module", { screenEntry: true })],
    // The generated route tree duplicates every route; §10.7's basename rule already catches
    // `routeTree.gen.ts`, and this states the intent for a differently-named generator.
    config: { generated: ["**/routeTree.gen.ts"] },
  },
  "vue-router": {
    name: "vue-router",
    screenSources: ["vue-router"],
    wrapperRoles: [],
    kindRules: [
      ...DATA_LAYER_RULES,
      rule("src/views/", "module", { screenEntry: true }),
      rule("src/layouts/", "layout"),
    ],
    config: {},
  },
  angular: {
    name: "angular",
    screenSources: ["angular"],
    wrapperRoles: [],
    kindRules: [...DATA_LAYER_RULES, ...ANGULAR_DATA_LAYER_RULES],
    config: {},
  },
  nuxt: {
    name: "nuxt",
    screenSources: ["nuxt"],
    wrapperRoles: [],
    kindRules: [
      ...DATA_LAYER_RULES,
      rule("pages/", "module", { screenEntry: true }),
      rule("app/pages/", "module", { screenEntry: true }),
      rule("layouts/", "layout"),
      rule("app/layouts/", "layout"),
    ],
    config: { candidateSuffixes: [...DEFAULT_CANDIDATE_SUFFIXES, ...SFC_EXTENSIONS, ...SFC_EXTENSIONS.map((extension) => `/index${extension}`)] },
  },
  adminjs: {
    name: "adminjs",
    screenSources: ["adminjs"],
    wrapperRoles: [],
    kindRules: [...DATA_LAYER_RULES, rule("src/admin/", "module", { screenEntry: true })],
    config: {},
  },
  // Two sources, one stack: `state-screens` is the live one (51 on an MV3 manifest) and
  // `manifest-activation` is its last-resort companion — the popup, the service worker and the content
  // scripts are screens no guarded-JSX probe can see. Only `state-screens` scores live, so the pair
  // never trips the §10.1 multi-source refusal on a bare run.
  "browser-extension": {
    name: "browser-extension",
    screenSources: ["state-screens", "manifest-activation"],
    wrapperRoles: [],
    kindRules: [...DATA_LAYER_RULES],
    config: {},
  },
})

export type PresetName = keyof typeof PRESETS

export const PRESET_NAMES: readonly string[] = sortStrings(Object.keys(PRESETS))

export const isPresetName = (name: string): name is PresetName => Object.hasOwn(PRESETS, name)

export const presetByName = (name: string): Preset | null => (isPresetName(name) ? PRESETS[name] : null)

/** The preset that owns a screen source, so detection alone selects the bundle (§10 zero-config). */
export const presetForSource = (source: string): Preset | null =>
  Object.values(PRESETS).find((preset) => preset.screenSources.includes(source)) ?? null

export const presetsForSources = (sources: readonly string[]): readonly Preset[] => {
  const names = new Set<string>()
  const found: Preset[] = []

  for (const source of sources) {
    const preset = presetForSource(source)
    if (preset === null || names.has(preset.name)) continue
    names.add(preset.name)
    found.push(preset)
  }

  return found
}

/** Every source a bundle runs: its own and its companions. */
const bundleOf = (preset: Preset): readonly string[] => [...preset.screenSources, ...(preset.companions ?? [])]

/** The companions the presets owning `sources` bring along (AS10). */
export const companionsOf = (sources: readonly string[]): readonly string[] =>
  sortedUnique(presetsForSources(sources).flatMap((preset) => preset.companions ?? []))

/** True when one preset's bundle covers every source — one app, so no §10.1 refusal. */
export const isOneBundle = (sources: readonly string[]): boolean =>
  Object.values(PRESETS).some((preset) => sources.every((source) => bundleOf(preset).includes(source)))

export type MergedPresets = {
  readonly names: readonly string[]
  /** Every source the selected bundles run, companions included — NOT an explicit user selection. */
  readonly screenSources: readonly string[]
  readonly wrapperRoles: readonly WrapperRule[]
  readonly nav: readonly string[]
  readonly kindRules: readonly KindRule[]
  readonly config: AppgraphConfig
}

export const mergePresets = (presets: readonly Preset[]): MergedPresets => ({
  names: presets.map((preset) => preset.name),
  screenSources: sortedUnique(presets.flatMap(bundleOf)),
  wrapperRoles: presets.flatMap((preset) => preset.wrapperRoles),
  nav: sortedUnique(presets.flatMap((preset) => preset.nav ?? [])),
  kindRules: presets.flatMap((preset) => preset.kindRules),
  config: presets.reduce<AppgraphConfig>(
    (merged, preset) => ({
      ...merged,
      ...preset.config,
      ...(preset.config.generated === undefined && merged.generated === undefined
        ? {}
        : { generated: [...(merged.generated ?? []), ...(preset.config.generated ?? [])] }),
    }),
    {},
  ),
})
