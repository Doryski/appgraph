import * as path from "node:path"
import type { AppGraph, AppgraphConfig, Diagnostic, KindRule } from "../core/model.js"
import { createDiagnosticCollector } from "../core/diagnostics.js"
import type { FileHost } from "../core/host.js"
import { createCachingHost, createNodeHost } from "../core/host.js"
import { findProjectRoot } from "../core/project.js"
import type { Exclusion } from "../core/project.js"
import type { TypeScriptApi } from "../core/tsconfig.js"
import { assertCompilerSupported, loadCompiler } from "../core/compiler-support.js"
import { by } from "../core/order.js"
import type { TemplateCompilerApis, TemplateCompilerSet, TemplateCompilerStatus } from "../core/template-frameworks.js"
import type { FactExtractor } from "../extractors/types.js"
import type { Adapter, Emitter, EmitFile } from "../adapters/types.js"
import type { ResolvedConfig, SourceDetection } from "../config/types.js"
import { resolveAppgraphConfig } from "../config/resolve.js"
import { loadConfigFile, validateConfig, validationDiagnostics } from "../config/load.js"
import type { TestIdCount } from "../detect/conventions.js"
import { runDetection } from "../detect/index.js"
import type { Detection, NestedPackage, SourceProbe } from "../detect/index.js"
import type { Locale } from "../emit/strings.js"
import type { HtmlRenderer } from "./registry.js"
import type { GlobAttempt, NearMiss, PipelineEnv } from "./context.js"
import { createEnv, readDependencies } from "./context.js"
import { EMPTY_TEMPLATE_COMPILERS, loadTemplateCompilers } from "./template-frameworks.js"
import type { PipelineRegistry } from "./registry.js"
import {
  builtinAdapterOptionsOf,
  createBuiltinAdapters,
  createBuiltinEmitters,
  createDefaultExtractors,
  createPipelineRegistry,
} from "./registry.js"
import {
  aggregate,
  configure,
  createFactSource,
  discover,
  emit,
  expandFormats,
  normalize,
  resolveEntries,
  walk,
} from "./phases.js"
import { UNKNOWN_SCREEN_CODE, exitCodeFor } from "./exit-codes.js"

export const APPGRAPH_VERSION = "0.1.0"

/** `null` keeps every registered extractor; a list keeps the named ones, in registry order. */
export const selectExtractors = (
  registered: readonly FactExtractor[],
  names: readonly string[] | null,
): readonly FactExtractor[] => {
  if (names === null) return registered
  const wanted = new Set(names)
  return registered.filter((extractor) => wanted.has(extractor.name))
}

const unknownExtractorNames = (registered: readonly FactExtractor[], names: readonly string[] | null): readonly string[] => {
  if (names === null) return []
  const known = new Set(registered.map((extractor) => extractor.name))
  return names.filter((name) => !known.has(name))
}

const unknownExtractorMessage = (registered: readonly FactExtractor[], unknown: readonly string[]): string =>
  `config 'extractors' names ${unknown.map((name) => `'${name}'`).join(", ")}, which no registered extractor is called. Known: ${registered.map((extractor) => extractor.name).join(", ")}`

const NEAR_MISS_LIMIT = 5

export const PIPELINE_PHASES = [
  "compiler",
  "config",
  "detection",
  "templates",
  "load-html",
  "configure",
  "discover",
  "normalize",
  "entries",
  "walk",
  "walk-masked",
  "aggregate",
  "emit",
] as const

export type PipelinePhase = (typeof PIPELINE_PHASES)[number]

export type PhaseListener = (name: PipelinePhase, ms: number) => void

export type Clock = () => number

type PhaseTimer = <T>(name: PipelinePhase, run: () => T) => T

type AsyncPhaseTimer = <T>(name: PipelinePhase, run: () => Promise<T>) => Promise<T>

type PhaseTiming = {
  readonly onPhase?: PhaseListener
  readonly clock?: Clock
}

const defaultClock: Clock = () => performance.now()

const untimed: PhaseTimer = (_name, run) => run()

const phaseTimerOf = (timing: PhaseTiming): PhaseTimer => {
  const { onPhase } = timing
  if (onPhase === undefined) return untimed
  const clock = timing.clock ?? defaultClock
  return (name, run) => {
    const start = clock()
    const value = run()
    onPhase(name, clock() - start)
    return value
  }
}

const asyncPhaseTimerOf = (timing: PhaseTiming): AsyncPhaseTimer => {
  const { onPhase } = timing
  if (onPhase === undefined) return (_name, run) => run()
  const clock = timing.clock ?? defaultClock
  return async (name, run) => {
    const start = clock()
    const value = await run()
    onPhase(name, clock() - start)
    return value
  }
}

/** What the kernel lets a caller say about the built-in emitters without replacing the set (§14.1). */
export type EmitSettings = {
  readonly locale?: Locale
}

export type PipelineInput = {
  readonly ts: TypeScriptApi
  readonly config: ResolvedConfig
  readonly host?: FileHost
  readonly adapters?: readonly Adapter[]
  readonly extractors?: readonly FactExtractor[]
  readonly emitters?: readonly Emitter[]
  readonly emit?: EmitSettings
  readonly emitOptions?: Readonly<Record<string, unknown>>
  /** Diagnostics phase 0 produced before the pipeline existed; reported as the run's own. */
  readonly diagnostics?: readonly Diagnostic[]
  /** The phase-0 test-id histogram, carried into the trace so `doctor` can print it (§10.4). */
  readonly testIds?: readonly TestIdCount[]
  readonly exclusions?: readonly Exclusion[]
  readonly nestedPackages?: readonly NestedPackage[]
  /** §10.1 rule 4's refusal text. Non-null makes the run write NOTHING and exit non-zero (§10.2). */
  readonly refusal?: string | null
  readonly templates?: TemplateCompilerSet
  readonly renderHtml?: HtmlRenderer
  readonly onPhase?: PhaseListener
  readonly clock?: Clock
}

/**
 * §10.4: every number `doctor` needs to answer "why did it guess that?" — per-source `detect()` scores
 * with evidence, the globs that were attempted, the files a glob matched and a probe rejected, and the
 * test-id histogram. It is returned on EVERY run, not only the zero-screen one: the guess is just as
 * wrong when it produced screens from the wrong source.
 */
const diagnosticKey = (diagnostic: Diagnostic): string =>
  [diagnostic.code, diagnostic.file ?? "", diagnostic.message].join("\u0000")

export type DetectionTrace = {
  readonly detections: readonly SourceDetection[]
  readonly sourcesRun: readonly string[]
  readonly globs: readonly GlobAttempt[]
  readonly nearMisses: readonly NearMiss[]
  readonly testIdAttribute: string | null
  readonly testIds: readonly TestIdCount[]
  readonly exclusions: readonly Exclusion[]
  readonly nestedPackages: readonly NestedPackage[]
  readonly templateCompilers: readonly TemplateCompilerStatus[]
}

export const EMPTY_DETECTION_TRACE: DetectionTrace = {
  detections: [],
  sourcesRun: [],
  globs: [],
  nearMisses: [],
  testIdAttribute: null,
  testIds: [],
  exclusions: [],
  nestedPackages: [],
  templateCompilers: [],
}

export type PipelineResult = {
  readonly graph: AppGraph
  readonly files: readonly EmitFile[]
  readonly diagnostics: readonly Diagnostic[]
  readonly emptyResult: boolean
  /** True when §10.1 rule 4 refused to choose between live sources. No files were produced. */
  readonly refused: boolean
  readonly exitCode: number
  /** The §10.2 trace, for a zero-screen run and for a refusal alike. Empty when neither happened. */
  readonly trace: string
  readonly detection: DetectionTrace
}

/** The same live / near-miss / no classification `doctor`'s `formatDetectionTrace` prints. */
export const detectionStatus = (detection: SourceDetection): "live" | "near-miss" | "no" => {
  if (detection.live) return "live"
  if (detection.score > 0) return "near-miss"
  return "no"
}

/**
 * The shared body of both §10.2 traces: what was resolved, what was probed, what nearly matched. The
 * headline differs; the evidence an operator needs to act does not.
 */
const traceBody = (env: PipelineEnv, registry: PipelineRegistry, config: ResolvedConfig): readonly string[] => {
  const lines: string[] = []

  lines.push(`  root:         ${config.rootLabel}`)
  lines.push(`  source roots: ${config.sourceRoots.join(", ")}`)

  const sources = registry.screenSources.map((owned) => owned.source.name)
  lines.push(`  sources run:  ${sources.length === 0 ? "(none registered)" : sources.join(", ")}`)

  if (config.detections.length > 0) {
    lines.push("  detection:")
    for (const detection of [...config.detections].sort(by((entry) => entry.source))) {
      lines.push(`    ${detection.source}  score ${String(detection.score)}  ${detectionStatus(detection)}`)
      for (const evidence of detection.evidence)
        lines.push(`      ${evidence.file}:${String(evidence.line)}  ${evidence.what}`)
    }
  }

  const globs = env.globs()
  if (globs.length > 0) {
    lines.push("  globs attempted:")
    for (const attempt of globs) lines.push(`    ${attempt.pattern} -> ${String(attempt.matches)} match(es)`)
  }

  const nearMisses = env.nearMisses()
  if (nearMisses.length > 0) {
    lines.push("  near-miss files (matched a glob, failed a content probe):")
    for (const miss of nearMisses.slice(0, NEAR_MISS_LIMIT))
      lines.push(`    ${miss.file}  (probe: ${miss.probe})`)
  }

  return lines
}

const formatTrace = (env: PipelineEnv, registry: PipelineRegistry, config: ResolvedConfig, reason: string | undefined): string =>
  [
    "appgraph found no screens.",
    ...(reason === undefined ? [] : [`  Reason: ${reason}.`]),
    "",
    ...traceBody(env, registry, config),
    "",
    "  Discovery narrows every node through the unwrap-baked helpers (ctx.ast.asArrayLiteral etc.),",
    "  so `as const` / `satisfies` annotations cannot silently zero this run.",
    config.allowEmpty
      ? "  --allow-empty: an explicitly marked zero-screen artifact was written (meta.emptyResult: true)."
      : "  Re-run with --allow-empty to record this as an explicit zero-screen artifact.",
  ].join("\n")

/**
 * §10.1 rule 4 + §10.2: a refusal writes nothing, so the trace is the entire output. `--allow-empty` has
 * no say here — the run is not empty, it is ambiguous, and an artifact built from one arbitrary source
 * would be exactly the partial map §10.2 exists to prevent.
 */
const formatRefusal = (
  env: PipelineEnv,
  registry: PipelineRegistry,
  config: ResolvedConfig,
  refusal: string,
): string =>
  [
    refusal,
    "",
    ...traceBody(env, registry, config),
    "",
    "  No output file was written. Nothing already in the output dir was overwritten.",
  ].join("\n")

const DETAIL_FORMAT = "detail"

const requestedScreenOf = (options: PipelineInput["emitOptions"]): string | null => {
  const requested = options?.["screen"]
  return typeof requested === "string" && requested !== "" ? requested : null
}

/** A `--screen` naming no screen is the caller's mistake, reported as one diagnostic rather than an emitter crash. */
const unknownRequestedScreen = (
  graph: AppGraph,
  formats: readonly string[],
  options: PipelineInput["emitOptions"],
): string | null => {
  if (!expandFormats(formats).includes(DETAIL_FORMAT)) return null
  const requested = requestedScreenOf(options)
  if (requested === null) return null
  return graph.screens.some((screen) => screen.id === requested) ? null : requested
}

const unknownScreenMessage = (screenId: string): string =>
  `no screen with id '${screenId}'; the detail view was not emitted. Run without --screen (or see the index view) for the known screen ids`

const withoutDetail = (formats: readonly string[]): readonly string[] =>
  expandFormats(formats).filter((format) => format !== DETAIL_FORMAT)

/**
 * The ONLY place the phases are sequenced: configure -> discover -> normalize -> resolve-entries ->
 * walk -> extract -> aggregate -> emit. Extraction is demand-driven by the walk, which is what makes
 * "input: the reachable file set" (§6.1 phase 6) true without a second reachability computation.
 */
type Analysed = {
  readonly env: PipelineEnv
  readonly registry: PipelineRegistry
  readonly diagnostics: PipelineEnv["diagnostics"]
  readonly aggregated: AppGraph
}

const builtinEmittersFor = (input: PipelineInput): readonly Emitter[] => {
  const { config } = input
  return createBuiltinEmitters({
    binName: config.binName,
    includeTestIds: config.includeTestIds,
    testIdAttribute: config.testIdAttribute,
    ...(input.emit?.locale === undefined ? {} : { locale: input.emit.locale }),
    ...(input.renderHtml === undefined ? {} : { renderHtml: input.renderHtml }),
    redirects: {
      ...(config.redirects.unauthenticated === null ? {} : { unauthenticated: config.redirects.unauthenticated }),
      ...(config.redirects.flagOff === null ? {} : { flagOff: config.redirects.flagOff }),
    },
  })
}

const analysePipeline = (input: PipelineInput, timed: PhaseTimer): Analysed => {
  const config = input.config
  const diagnostics = createDiagnosticCollector()

  const env = createEnv({
    ts: input.ts,
    config,
    diagnostics,
    templates: (input.templates ?? EMPTY_TEMPLATE_COMPILERS).apis,
    ...(input.host === undefined ? {} : { host: input.host }),
  })

  const registry = createPipelineRegistry({
    adapters: input.adapters ?? [],
    emitters: input.emitters ?? builtinEmittersFor(input),
    ...(config.screenSources.length > 0 ? { screenSources: config.screenSources } : {}),
    ...(config.navSources.length > 0 ? { navSources: config.navSources } : {}),
  })

  const alreadyReported = new Set(diagnostics.all().map(diagnosticKey))
  for (const diagnostic of input.diagnostics ?? []) {
    if (!alreadyReported.has(diagnosticKey(diagnostic))) diagnostics.report(diagnostic)
  }
  for (const diagnostic of registry.diagnostics) diagnostics.report(diagnostic)

  const { kindRules } = timed("configure", () => configure({ env, registry }))
  const registered =
    input.extractors ??
    createDefaultExtractors({ kindRules, testIdAttribute: config.testIdAttribute, featureFlags: config.featureFlags })
  const unknownExtractors = unknownExtractorNames(registered, config.extractors)
  if (unknownExtractors.length > 0)
    diagnostics.error("config/unknown-extractor", unknownExtractorMessage(registered, unknownExtractors))
  const extractors = selectExtractors(registered, config.extractors)

  const discovered = timed("discover", () => discover({ env, registry }))
  const normalized = timed("normalize", () => normalize({ env, contributions: discovered.contributions }))
  const screens = timed("entries", () => resolveEntries({ env, registry, screens: normalized }))

  const facts = createFactSource({ env, extractors, kindRules })

  const walkOnce = (collector: PipelineEnv["diagnostics"]): AppGraph =>
    walk({
      env,
      screens,
      navGroups: discovered.navGroups,
      discoveredRedirectRules: discovered.redirectRules,
      facts,
      kindRules,
      diagnostics: collector,
    })

  // The cross-file mask seam (§5.4): pass 1 discovers which components were masked and resolves each
  // to its declaring file; pass 2 re-projects the cached extraction results with those files' fact
  // channels suppressed. Reachability is unaffected by masking, so two passes reach the fixpoint.
  const scratch = createDiagnosticCollector()
  const probe = timed("walk", () => walkOnce(scratch))
  const masked = facts.maskedComponents().length > 0
  const graph = masked ? timed("walk-masked", () => walkOnce(diagnostics)) : probe
  if (!masked) for (const diagnostic of scratch.all()) diagnostics.report(diagnostic)

  for (const diagnostic of facts.diagnostics()) diagnostics.report(diagnostic)

  const aggregated = timed("aggregate", () =>
    aggregate({
      env,
      graph,
      facts,
      extractors,
      screens,
      navGroupCount: graph.navGroups.length,
    }),
  )

  return { env, registry, diagnostics, aggregated }
}

export const runPipeline = (input: PipelineInput): PipelineResult => {
  const config = input.config
  const timed = phaseTimerOf(input)
  const { env, registry, diagnostics, aggregated } = analysePipeline(input, timed)
  env.release()

  const refusal = input.refusal ?? null
  const refused = refusal !== null && refusal !== ""
  const emptyResult = aggregated.meta.emptyResult === true
  const trace = refused
    ? formatRefusal(env, registry, config, refusal)
    : emptyResult
      ? formatTrace(env, registry, config, aggregated.meta.emptyReason)
      : ""

  const writes = !(refused || (emptyResult && !config.allowEmpty))
  const missingScreen = writes ? unknownRequestedScreen(aggregated, config.formats, input.emitOptions) : null
  if (missingScreen !== null) diagnostics.error(UNKNOWN_SCREEN_CODE, unknownScreenMessage(missingScreen))

  const files = writes
    ? timed("emit", () =>
        emit({
          env,
          registry,
          graph: aggregated,
          formats: missingScreen === null ? config.formats : withoutDetail(config.formats),
          ...(input.emitOptions === undefined ? {} : { options: input.emitOptions }),
        }),
      )
    : []

  const final = { ...aggregated, diagnostics: diagnostics.all() }

  return {
    graph: final,
    files,
    diagnostics: final.diagnostics,
    emptyResult,
    refused,
    exitCode: exitCodeFor({ refused, emptyResult, diagnostics: final.diagnostics }, config.strict),
    trace,
    detection: {
      detections: config.detections,
      sourcesRun: registry.screenSources.map((owned) => owned.source.name),
      globs: env.globs(),
      nearMisses: env.nearMisses(),
      testIdAttribute: config.testIdAttribute,
      testIds: input.testIds ?? [],
      exclusions: input.exclusions ?? env.paths.exclusions(),
      nestedPackages: input.nestedPackages ?? [],
      templateCompilers: (input.templates ?? EMPTY_TEMPLATE_COMPILERS).statuses,
    },
  }
}

/** The documented public options (README "API reference"). Nothing here is typed with an internal contract. */
export type AnalyzeOptions = {
  /** Resolved against `cwd`; wins over the config's own `root`. */
  readonly root?: string
  readonly cwd?: string
  /** Supplying a config object SKIPS loading `appgraph.config.*`; omit it to load the file the CLI would. */
  readonly config?: AppgraphConfig
  /** Root-relative or absolute. Labels `config` diagnostics, or names the file to load when `config` is omitted. */
  readonly configFile?: string
  /** Settings for the BUILT-IN emitters, so a caller need not replace the set to pick a locale. */
  readonly emit?: EmitSettings
  readonly kindRules?: readonly KindRule[]
  readonly sourceRoots?: readonly string[]
  readonly appgraphVersion?: string
  /** §10.1 rule 4: run every live source instead of refusing to choose between them. */
  readonly allSources?: boolean
  /** Computed by the caller (`cli/stale.ts`); carried into `meta.fingerprint`. */
  readonly fingerprint?: string
  /** The generation timestamp for the HTML report. `null` (the default) omits it (§5.5, §11 rule 3). */
  readonly timestamp?: string | null
  readonly emitOptions?: Readonly<Record<string, unknown>>
}

/**
 * The injection points the CLI and the tests use. NOT exported from the package entry: they are typed
 * with internal, unstable contracts, and exporting them would be the plugin contract 0.1 does not make.
 */
export type AnalyzeInternalOptions = AnalyzeOptions & {
  /** The injected compiler realm (§5.6). Defaults to the host's `typescript`. */
  readonly ts?: TypeScriptApi
  readonly host?: FileHost
  /** Replaces the built-in adapter set; omit to run the five shipped sources. */
  readonly adapters?: readonly Adapter[]
  readonly extractors?: readonly FactExtractor[]
  readonly emitters?: readonly Emitter[]
  /** Supplying these SKIPS phase 0; omit to let `analyze` detect. */
  readonly detections?: readonly SourceDetection[]
  readonly templateCompilers?: TemplateCompilerApis
  readonly onPhase?: PhaseListener
  readonly clock?: Clock
}

export type AnalyzeResult = PipelineResult

/** Every project-relative file path a config field names, keyed by the field's dotted name. */
const configuredFiles = (config: AppgraphConfig): readonly { readonly field: string; readonly file: string }[] => [
  ...(config.adminjs?.optionsFile === undefined ? [] : [{ field: "adminjs.optionsFile", file: config.adminjs.optionsFile }]),
  ...(config.adminjs?.componentLoaderFile === undefined
    ? []
    : [{ field: "adminjs.componentLoaderFile", file: config.adminjs.componentLoaderFile }]),
  ...(config.entryComponents ?? []).map((spec) => ({ field: "entryComponents", file: spec.file })),
  ...(config.menus ?? []).map((spec, index) => ({ field: `menus[${index}].file`, file: spec.file })),
]

/** A mistyped path would otherwise read as "the source is not here": AdminJS just scores 0 and stays silent. */
const missingConfiguredFiles = (config: AppgraphConfig, root: string, host: FileHost): readonly Diagnostic[] =>
  configuredFiles(config)
    .filter((entry) => !host.isFile(path.resolve(root, entry.file)))
    .map((entry) => ({
      severity: "error" as const,
      code: "config/missing-file",
      message: `config '${entry.field}' names '${entry.file}', which is not a file under the project root`,
      plugin: null,
    }))

type TemplateCompilersInput = {
  readonly root: string
  readonly host: FileHost
  readonly detection: Detection | null
  readonly inject: TemplateCompilerApis | undefined
}

const templateCompilersFor = (input: TemplateCompilersInput): Promise<TemplateCompilerSet> =>
  loadTemplateCompilers({
    root: input.root,
    host: input.host,
    dependencies: input.detection?.dependencies.names ?? readDependencies(input.host, [path.join(input.root, "package.json")]),
    files: input.detection?.probe.probeFiles() ?? [],
    ...(input.inject === undefined ? {} : { inject: input.inject }),
  })

/**
 * Phase 0 probes built from the SAME configured adapters the run will use: an `adminjs.optionsFile` in
 * config is what makes AdminJS live on a repo whose options file the content probe cannot recognise.
 */
const configuredProbes = (config: AppgraphConfig): readonly SourceProbe[] =>
  createPipelineRegistry({
    adapters: createBuiltinAdapters({
      ...(config.wrapperRoles === undefined ? {} : { wrapperRoles: config.wrapperRoles }),
      ...(config.pathlessRoles === undefined ? {} : { pathlessRoles: config.pathlessRoles }),
      ...(config.entryComponents === undefined ? {} : { entryComponents: config.entryComponents }),
      ...(config.adminjs === undefined ? {} : { adminjs: config.adminjs }),
      ...(config.expoRouter === undefined ? {} : { expoRouter: config.expoRouter }),
    }),
  }).screenSources.map(({ source }) => ({ name: source.name, detect: source.detect }))

type ConfigSource = {
  readonly config: AppgraphConfig
  readonly diagnostics: readonly Diagnostic[]
  /** What a relative `root` inside the config is resolved against. */
  readonly dir: string
}

const inlineConfig = (config: AppgraphConfig, configFile: string | null, cwd: string): ConfigSource => {
  const validated = validateConfig(config)
  return { config: validated.config, diagnostics: validationDiagnostics(validated, configFile), dir: cwd }
}

type ConfigFileInput = {
  readonly ts: TypeScriptApi
  readonly host: FileHost
  readonly searchRoot: string
  readonly configFile: string | undefined
}

/** The CLI's own loader (§15.2): probes `appgraph.config.*` under the search root unless a file is named. */
const fileConfig = async (input: ConfigFileInput): Promise<ConfigSource> => {
  const loaded = await loadConfigFile({
    ts: input.ts,
    root: input.searchRoot,
    host: input.host,
    ...(input.configFile === undefined ? {} : { file: input.configFile, required: true }),
  })
  return {
    config: loaded.config ?? {},
    diagnostics: loaded.diagnostics,
    dir: loaded.file === null ? input.searchRoot : path.dirname(path.resolve(input.searchRoot, loaded.file)),
  }
}

/** Root order: `root` (against `cwd`) -> the config's own `root` (against its dir) -> the search root. */
const rootOf = (explicit: string | null, source: ConfigSource, searchRoot: string): string => {
  if (explicit !== null) return explicit
  if (source.config.root === undefined) return searchRoot
  return path.resolve(source.dir, source.config.root)
}

/**
 * The public entry (§5.0). It performs no writes: the emitted files come back as `EmitFile[]` and the
 * caller — the CLI — decides where they land. It owns phase 0 and, when no `config` object is passed,
 * loads `appgraph.config.*` with the CLI's loader, so `analyze({ root })` alone resolves the same config
 * the CLI would.
 */
const HTML_FORMAT = "html"

const htmlRendererFor = async (formats: readonly string[], emitters: AnalyzeInternalOptions["emitters"]): Promise<HtmlRenderer | undefined> => {
  if (emitters !== undefined || !expandFormats(formats).includes(HTML_FORMAT)) return undefined
  const { renderHtml } = await import("../emit/html.js")
  return renderHtml
}

export const analyze = async (options: AnalyzeInternalOptions = {}): Promise<AnalyzeResult> => {
  const host = createCachingHost(options.host ?? createNodeHost())
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const timed = phaseTimerOf(options)
  const timedAsync = asyncPhaseTimerOf(options)

  // Before detection, before any glob: a compiler missing `readJsonConfigFile` fails 100 lines later
  // with `api.readJsonConfigFile is not a function`, which names neither the cause nor the fix.
  const api = await timedAsync("compiler", () =>
    options.ts === undefined ? loadCompiler() : Promise.resolve(assertCompilerSupported(options.ts)),
  )

  const explicitRoot = options.root === undefined ? null : path.resolve(cwd, options.root)
  const source = await timedAsync("config", async () => {
    const searchRoot = explicitRoot ?? findProjectRoot(host, cwd) ?? cwd
    const loaded =
      options.config === undefined
        ? await fileConfig({ ts: api, host, searchRoot, configFile: options.configFile })
        : inlineConfig(options.config, options.configFile ?? null, cwd)
    return { ...loaded, root: rootOf(explicitRoot, loaded, searchRoot) }
  })
  const root = source.root
  const userConfig = source.config

  const detection = timed("detection", () =>
    options.detections === undefined
      ? runDetection({
          ts: api,
          root,
          host,
          ...(options.adapters === undefined ? { sources: configuredProbes(userConfig) } : {}),
          ...(options.sourceRoots === undefined ? {} : { sourceRoots: options.sourceRoots }),
          ...(userConfig.exclude === undefined ? {} : { exclude: userConfig.exclude }),
          ...(userConfig.generated === undefined ? {} : { generated: userConfig.generated }),
        })
      : null,
  )

  const templates = await timedAsync("templates", () =>
    templateCompilersFor({ root, host, detection, inject: options.templateCompilers }),
  )

  const layer: AppgraphConfig = {
    ...userConfig,
    root,
    ...(options.sourceRoots === undefined ? {} : { sourceRoots: options.sourceRoots }),
    ...(options.kindRules === undefined ? {} : { kindRules: options.kindRules }),
  }

  const setup = resolveAppgraphConfig({
    root,
    ...(detection === null ? {} : { detection }),
    ...(options.detections === undefined ? {} : { detections: options.detections }),
    options: layer,
    runtime: {
      appgraphVersion: options.appgraphVersion ?? APPGRAPH_VERSION,
      ...(options.allSources === undefined ? {} : { allSources: options.allSources }),
      ...(options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint }),
      ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
    },
  })

  const renderHtml = await timedAsync("load-html", () => htmlRendererFor(setup.config.formats, options.emitters))

  return runPipeline({
    ts: api,
    config: setup.config,
    host,
    ...(renderHtml === undefined ? {} : { renderHtml }),
    ...(options.onPhase === undefined ? {} : { onPhase: options.onPhase }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    adapters: options.adapters ?? createBuiltinAdapters(builtinAdapterOptionsOf(setup.config, setup.wrapperRoles)),
    diagnostics: [
      ...source.diagnostics,
      ...missingConfiguredFiles(userConfig, root, host),
      ...setup.diagnostics,
      ...templates.diagnostics,
    ],
    refusal: setup.refusal,
    templates,
    ...(detection?.testIds === undefined || detection.testIds === null
      ? {}
      : { testIds: detection.testIds.histogram }),
    ...(detection === null ? {} : { exclusions: detection.exclusions, nestedPackages: detection.nestedPackages }),
    ...(options.extractors === undefined ? {} : { extractors: options.extractors }),
    ...(options.emitters === undefined ? {} : { emitters: options.emitters }),
    ...(options.emit === undefined ? {} : { emit: options.emit }),
    ...(options.emitOptions === undefined ? {} : { emitOptions: options.emitOptions }),
  })
}

/** `analyze` as the package entry publishes it: only the documented `AnalyzeOptions` (§5.0). */
export const publicAnalyze: (options?: AnalyzeOptions) => Promise<AnalyzeResult> = analyze
