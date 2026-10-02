import * as path from "node:path"
import type { ConflictPolicy } from "../core/graph.js"
import { toPosix } from "../core/host.js"
import type {
  AdminJsConfig,
  VueAuthConfig,
  AngularConfig,
  AppgraphConfig,
  Evidence,
  ExpoRouterConfig,
  ExtensionRewrite,
  FeatureFlagsConfig,
  HolderSpec,
  KindRule,
  MenuSpec,
  NativeAuthConfig,
  PathlessRole,
  ReactNavigationConfig,
  ReactRouterConfig,
  RedirectRuleSpec,
} from "../core/model.js"
import { DEFAULT_PATHLESS_ROLES } from "../core/model.js"
import { sortedUnique } from "../core/order.js"
import { companionsOf } from "./presets.js"

export const DEFAULT_OUT_DIR = "docs/appgraph"

export const DEFAULT_FORMATS = ["index", "html"] as const

export const DEFAULT_DEPTH = 3

export const DEFAULT_BIN = "appgraph"

/** §10.1: a source scoring >= 50 is live; [1,50) is a near-miss and never runs on its own. */
export const LIVE_SOURCE_SCORE = 50

export type SourceDetection = {
  readonly source: string
  readonly score: number
  readonly live: boolean
  readonly evidence: readonly Evidence[]
}

export type ConfiguredRedirects = {
  readonly unauthenticated: string | null
  readonly flagOff: string | null
}

/**
 * The frozen options object every phase reads. Phase 0 (detection) and the config file both produce
 * exactly this shape, which is what makes the zero-config layer testable by the same gate as a
 * hand-written config (§1). Nothing downstream of `resolveConfig` may mutate it.
 */
export type ResolvedConfig = {
  /** Absolute. Never emitted. */
  readonly root: string
  /** The root directory's basename — this is what `meta.root` carries (§11 rule 5). */
  readonly rootLabel: string
  /** Project-relative POSIX, codepoint-sorted. */
  readonly sourceRoots: readonly string[]
  /** Screen sources selected to run. Empty = every registered source that detection called live. */
  readonly screenSources: readonly string[]
  /** True when the selection came from config/CLI rather than detection (§10.1 rule 4). */
  readonly explicitSource: boolean
  readonly allSources: boolean
  readonly detections: readonly SourceDetection[]
  readonly depth: number
  readonly out: string
  readonly formats: readonly string[]
  readonly conflicts: ConflictPolicy
  readonly kindRules: readonly KindRule[]
  /** Nav sources selected to run. Empty = every registered nav source. */
  readonly navSources: readonly string[]
  /** Menu configs named explicitly; §10.6 auto-discovery runs alongside them, never instead of them. */
  readonly menus: readonly MenuSpec[]
  readonly stringSources: readonly string[]
  readonly testIdAttribute: string | null
  readonly includeTestIds: boolean
  readonly redirects: ConfiguredRedirects
  /** Config-supplied redirect rules, in declaration order; the graph orders them. */
  readonly redirectRules: readonly RedirectRuleSpec[]
  readonly strict: boolean
  readonly allowEmpty: boolean
  readonly extensionRewrites: readonly ExtensionRewrite[]
  readonly candidateSuffixes: readonly string[]
  readonly exclude: readonly string[]
  readonly generated: readonly string[]
  readonly disabledChannels: readonly string[]
  /** Merged over `DEFAULT_PATHLESS_ROLES`; what the TanStack source reads a `_`-segment as. */
  readonly pathlessRoles: Readonly<Record<string, PathlessRole>>
  /** `null` = derive holders from an MV3 manifest. */
  readonly entryComponents: readonly HolderSpec[] | null
  readonly adminjs: AdminJsConfig
  readonly reactRouter: ReactRouterConfig
  readonly vueAuth: VueAuthConfig
  readonly angular: AngularConfig
  readonly expoRouter: ExpoRouterConfig
  readonly reactNavigation: ReactNavigationConfig
  readonly nativeAuth: NativeAuthConfig
  readonly featureFlags: FeatureFlagsConfig
  /** Extractor names to run. `null` = every registered extractor. */
  readonly extractors: readonly string[] | null
  readonly appgraphVersion: string
  readonly binName: string
  /** Computed by `cli/stale.ts`; the pipeline only carries it into `meta.fingerprint`. */
  readonly fingerprint: string
  /** `null` under `--no-timestamp`; never reaches YAML (§11 rule 3). */
  readonly timestamp: string | null
  readonly verifyEmit: boolean
}

export type ResolveConfigInput = {
  readonly root: string
  readonly config?: AppgraphConfig
  readonly appgraphVersion?: string
  readonly detections?: readonly SourceDetection[]
  /** Screen sources the selected presets bundle; unioned into the detected selection, never explicit. */
  readonly presetSources?: readonly string[]
  readonly sourceRoots?: readonly string[]
  readonly kindRules?: readonly KindRule[]
  readonly navSources?: readonly string[]
  readonly extensionRewrites?: readonly ExtensionRewrite[]
  readonly candidateSuffixes?: readonly string[]
  readonly stringSources?: readonly string[]
  readonly testIdAttribute?: string | null
  readonly formats?: readonly string[]
  readonly allSources?: boolean
  readonly includeTestIds?: boolean
  readonly disabledChannels?: readonly string[]
  readonly fingerprint?: string
  readonly timestamp?: string | null
  readonly verifyEmit?: boolean
  readonly binName?: string
}

const relativeTo = (root: string, entry: string): string => {
  const rel = toPosix(path.relative(root, path.resolve(root, entry)))
  return rel === "" ? "." : rel
}

/** An explicit `--source X` still runs X's preset companions (AS10): the Next family is one app. */
const explicitSelection = (names: readonly string[]): { names: readonly string[]; explicit: boolean } => ({
  names: sortedUnique([...names, ...companionsOf(names)]),
  explicit: true,
})

const selectedSources = (input: ResolveConfigInput): { names: readonly string[]; explicit: boolean } => {
  const config = input.config ?? {}
  if (config.screenSources !== undefined && config.screenSources.length > 0)
    return explicitSelection(config.screenSources)
  if (config.screenSource !== undefined) return explicitSelection([config.screenSource])

  const live = (input.detections ?? []).filter((entry) => entry.live).map((entry) => entry.source)
  if (live.length === 0) return { names: [], explicit: false }

  // A preset is a per-stack BUNDLE (§presets.ts), so a companion source it names runs alongside the live
  // one that selected the bundle. It stays non-explicit: the §10.1 refusal counts LIVE sources, and a
  // companion that is never live on its own must not look like a user's `--source` choice.
  return { names: sortedUnique([...live, ...(input.presetSources ?? [])]), explicit: false }
}

/**
 * Pure. It merges an `AppgraphConfig` over supplied derivations and never touches the filesystem —
 * deriving the defaults is phase 0's job, and keeping the merge separate is what lets a test
 * compare a derived config against a pinned one.
 */
export const resolveConfig = (input: ResolveConfigInput): ResolvedConfig => {
  const config = input.config ?? {}
  const root = path.resolve(config.root ?? input.root)
  const sources = selectedSources(input)

  const sourceRoots = sortedUnique(
    (config.sourceRoots ?? input.sourceRoots ?? ["."]).map((entry) => relativeTo(root, entry)),
  )

  return {
    root,
    rootLabel: path.basename(root),
    sourceRoots,
    screenSources: sources.names,
    explicitSource: sources.explicit,
    allSources: input.allSources ?? false,
    detections: input.detections ?? [],
    depth: config.depth ?? DEFAULT_DEPTH,
    out: config.out ?? DEFAULT_OUT_DIR,
    formats: config.formats ?? input.formats ?? [...DEFAULT_FORMATS],
    conflicts: config.conflicts ?? "merge",
    kindRules: [...(input.kindRules ?? []), ...(config.kindRules ?? [])],
    navSources: sortedUnique(config.navSources ?? input.navSources ?? []),
    menus: config.menus ?? [],
    stringSources: sortedUnique(config.stringSources ?? input.stringSources ?? []),
    testIdAttribute: config.testIdAttribute ?? input.testIdAttribute ?? null,
    includeTestIds: input.includeTestIds ?? true,
    redirects: {
      unauthenticated: config.redirects?.unauthenticated ?? null,
      flagOff: config.redirects?.flagOff ?? null,
    },
    redirectRules: config.redirectRules ?? [],
    strict: config.strict ?? false,
    allowEmpty: config.allowEmpty ?? false,
    // Config-supplied resolution options are merged OVER the derived defaults, never replacing them
    // (§15.1), so a repo that adds one rewrite does not lose the `nodenext` set phase 0 derived.
    extensionRewrites: [...(input.extensionRewrites ?? []), ...(config.extensionRewrites ?? [])],
    candidateSuffixes: [...(input.candidateSuffixes ?? []), ...(config.candidateSuffixes ?? [])],
    exclude: sortedUnique(config.exclude ?? []),
    generated: sortedUnique(config.generated ?? []),
    disabledChannels: sortedUnique(input.disabledChannels ?? []),
    pathlessRoles: { ...DEFAULT_PATHLESS_ROLES, ...(config.pathlessRoles ?? {}) },
    entryComponents: config.entryComponents ?? null,
    adminjs: config.adminjs ?? {},
    reactRouter: config.reactRouter ?? {},
    vueAuth: config.vueAuth ?? {},
    angular: config.angular ?? {},
    expoRouter: config.expoRouter ?? {},
    reactNavigation: config.reactNavigation ?? {},
    nativeAuth: config.nativeAuth ?? {},
    featureFlags: config.featureFlags ?? {},
    extractors: config.extractors === undefined ? null : sortedUnique(config.extractors),
    appgraphVersion: input.appgraphVersion ?? "0.0.0",
    binName: input.binName ?? DEFAULT_BIN,
    fingerprint: input.fingerprint ?? "",
    timestamp: input.timestamp ?? null,
    verifyEmit: input.verifyEmit ?? true,
  }
}
