import type { FileHost } from "../core/host.js"
import type { Exclusion } from "../core/project.js"
import { deriveDefaultKindRules } from "../core/kinds.js"
import type { Diagnostic, KindRule, TsconfigChain } from "../core/model.js"
import { sortedUnique } from "../core/order.js"
import type { TypeScriptApi } from "../core/tsconfig.js"
import type { DetectResult, ProjectContext } from "../adapters/types.js"
import { builtinScreenSources } from "../adapters/builtin.js"
import { nextPagesSource } from "../adapters/next-pages.js"
import type { SourceDetection } from "../config/types.js"
import { LIVE_SOURCE_SCORE } from "../config/types.js"
import type { SourceChoiceOptions } from "../config/source-choice.js"
import { byDisplayOrder, formatSourceChoice } from "../config/source-choice.js"
import type { LibraryDetection, TestIdProbe, TestIdProbeOptions } from "./conventions.js"
import { detectLibraries, probeTestIdAttribute } from "./conventions.js"
import type { StringSourceProbe, StringSourceProbeOptions } from "./strings.js"
import { formatStringSourceTrace, probeStringSources } from "./strings.js"
import type { DependencyUnion, GeneratedFile, GlobAttempt, ProjectProbe } from "./project.js"
import { createProjectProbe, isInNestedPackage } from "./project.js"

/**
 * The probes ARE the adapters' own `detect` functions; this module owns none of its own. They are
 * re-exported so a caller can reach one probe without reaching into `adapters/` (§5.0).
 */
export { detectAdminJs } from "../adapters/adminjs.js"
export { detectNuxt } from "../adapters/nuxt.js"
export { detectReactRouter, detectWouter } from "../adapters/react-router.js"
export { detectReactRouterFramework } from "../adapters/react-router-framework.js"
export { detectStateScreens } from "../adapters/state-screens.js"
export { detectTanStackRouter } from "../adapters/tanstack-router.js"
export { detectVueRouter } from "../adapters/vue-router.js"
export { detectAngular } from "../adapters/angular/router.js"
export { MULTIPLE_SOURCES_CODE, formatSourceChoice } from "../config/source-choice.js"
export type { SourceChoiceOptions }

/** `next-pages` keeps its probe private; its source's `detect` IS that probe. */
export const detectNextPages = nextPagesSource.detect

/**
 * §10.1: file-convention sources are framework ground truth, a code-literal parse is a guess about
 * which of several router calls is live — ground truth outranks a guess IN CONFIDENCE. It never
 * licenses deleting the other app, so these numbers order the display and set the live threshold; they
 * do not pick a winner.
 */
export const SOURCE_SCORES = {
  fileConvention: 100,
  dataRouter: 90,
  jsxRouter: 80,
  manifestV3: 50,
  lastResort: 1,
  none: 0,
} as const

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type SourceProbe = {
  readonly name: string
  readonly detect: (ctx: ProjectContext) => DetectResult
}

/**
 * Derived from the built-in adapter list, never hand-written: an adapter's own `detect` IS the probe, so
 * phase 0 and the run that follows it can never disagree about what a source scores.
 */
export const BUILTIN_SOURCE_PROBES: readonly SourceProbe[] = builtinScreenSources().map((source) => ({
  name: source.name,
  detect: source.detect,
}))

export type Detection = {
  readonly root: string
  readonly rootLabel: string
  readonly sourceRoots: readonly string[]
  readonly tsconfig: TsconfigChain
  readonly detections: readonly SourceDetection[]
  readonly liveSources: readonly string[]
  readonly nearMisses: readonly SourceDetection[]
  readonly kindRules: readonly KindRule[]
  /** Files whose path-constant members feed the `StringTable` — every candidate, never one guess. */
  readonly stringSources: readonly string[]
  readonly stringSourceProbe: StringSourceProbe | null
  readonly testIds: TestIdProbe | null
  readonly libraries: readonly LibraryDetection[]
  readonly dependencies: DependencyUnion
  readonly extensionRewrites: ProjectProbe["extensionRewrites"]
  readonly candidateSuffixes: readonly string[]
  readonly excludedDirs: readonly string[]
  readonly nestedPackages: readonly NestedPackage[]
  /** Every directory-exclusion rule with its reason — dot-dirs, `.gitignore` and `distDir` included. */
  readonly exclusions: readonly Exclusion[]
  readonly skippedDirs: readonly string[]
  readonly symlinks: readonly string[]
  readonly generated: readonly GeneratedFile[]
  readonly globs: readonly GlobAttempt[]
  readonly diagnostics: readonly Diagnostic[]
  readonly probe: ProjectProbe
}

/**
 * A nested package's evidence, kept OUT of the root's scores: `extension/` with its own `package.json`
 * is a second project, so its MV3 manifest must not make the root app look multi-source.
 */
export type NestedPackage = {
  readonly dir: string
  readonly sources: readonly string[]
}

export type DetectionInput = {
  readonly ts: TypeScriptApi
  readonly root: string
  readonly host?: FileHost
  readonly sourceRoots?: readonly string[]
  readonly exclude?: readonly string[]
  readonly generated?: readonly string[]
  /**
   * Registered screen sources. A registered source's own `detect` always wins over the built-in probe
   * of the same name; the built-ins stand in for the adapters that have not landed yet.
   */
  readonly sources?: readonly SourceProbe[]
  readonly probe?: ProjectProbe
  readonly testIds?: TestIdProbeOptions | false
  readonly stringSources?: StringSourceProbeOptions | false
}

const scopedToRoot = (context: ProjectContext, nestedDirs: readonly string[]): ProjectContext =>
  nestedDirs.length === 0
    ? context
    : { ...context, glob: (pattern) => context.glob(pattern).filter((file) => !isInNestedPackage(file, nestedDirs)) }

const nestedPackageEvidence = (
  probes: readonly SourceProbe[],
  context: ProjectContext,
  nestedDirs: readonly string[],
): readonly NestedPackage[] => {
  if (nestedDirs.length === 0) return []
  const evidence = probes.flatMap((source) =>
    source.detect(context).evidence.map((entry) => ({ source: source.name, file: entry.file })),
  )
  return nestedDirs.flatMap((dir): NestedPackage[] => {
    const sources = sortedUnique(
      evidence.filter((entry) => isInNestedPackage(entry.file, [dir])).map((entry) => entry.source),
    )
    return sources.length === 0 ? [] : [{ dir, sources }]
  })
}

const probesFor = (sources: readonly SourceProbe[] | undefined): readonly SourceProbe[] => {
  if (sources === undefined) return BUILTIN_SOURCE_PROBES
  const overridden = new Set(sources.map((source) => source.name))
  return [...sources, ...BUILTIN_SOURCE_PROBES.filter((builtin) => !overridden.has(builtin.name))]
}

/**
 * Phase 0. It runs EVERY source's `detect`, records every score with its evidence including the zeros,
 * and returns them all — deciding which to run belongs to `config/resolve.ts`, which is the only layer
 * that knows whether `--all-sources` or an explicit selection was given (§10.1 rule 4).
 */
export const runDetection = (input: DetectionInput): Detection => {
  const probe =
    input.probe ??
    createProjectProbe({
      ts: input.ts,
      root: input.root,
      ...(input.host === undefined ? {} : { host: input.host }),
      ...(input.sourceRoots === undefined ? {} : { sourceRoots: input.sourceRoots }),
      ...(input.exclude === undefined ? {} : { exclude: input.exclude }),
      ...(input.generated === undefined ? {} : { generated: input.generated }),
    })

  const probes = probesFor(input.sources)
  const nestedDirs = probe.nestedPackages()
  const rootContext = scopedToRoot(probe.context, nestedDirs)

  const detections = probes
    .map((source): SourceDetection => {
      const result = source.detect(rootContext)
      return {
        source: source.name,
        score: result.score,
        live: result.score >= LIVE_SOURCE_SCORE,
        evidence: result.evidence,
      }
    })
    .sort(byDisplayOrder)

  const live = detections.filter((entry) => entry.live)
  const nearMisses = detections.filter((entry) => !entry.live && entry.score > 0)

  const diagnostics: Diagnostic[] = [...probe.tsconfigDiagnostics]

  const testIds = input.testIds === false ? null : probeTestIdAttribute(probe, input.testIds ?? {})
  const strings =
    input.stringSources === false ? null : probeStringSources(probe, input.stringSources ?? {})
  const scan = probe.scan()

  return {
    root: probe.paths.root,
    rootLabel: probe.paths.label,
    sourceRoots: probe.paths.sourceRootsRel,
    tsconfig: probe.tsconfig,
    detections,
    liveSources: sortedUnique(live.map((entry) => entry.source)),
    nearMisses,
    kindRules: deriveDefaultKindRules({
      tsconfigPaths: probe.tsconfig.paths,
      sourceRootsRel: probe.paths.sourceRootsRel,
    }),
    stringSources: strings?.files ?? [],
    stringSourceProbe: strings,
    testIds,
    libraries: detectLibraries(probe.dependencies.names),
    dependencies: probe.dependencies,
    extensionRewrites: probe.extensionRewrites,
    candidateSuffixes: probe.candidateSuffixes,
    excludedDirs: probe.excludedDirs,
    nestedPackages: nestedPackageEvidence(probes, probe.context, nestedDirs),
    exclusions: probe.paths.exclusions(),
    skippedDirs: scan.skippedDirs,
    symlinks: scan.symlinks,
    generated: probe.generatedFiles(),
    globs: probe.globs(),
    diagnostics,
    probe,
  }
}

/** The full phase-0 trace `doctor` prints (§10.4). */
export const formatDetectionTrace = (detection: Detection, options: SourceChoiceOptions = {}): string => {
  const lines: string[] = []

  lines.push(`root:          ${detection.rootLabel}`)
  lines.push(`source roots:  ${detection.sourceRoots.join(", ")}`)
  lines.push(`tsconfig:      ${detection.tsconfig.files.join(" <- ") || "(none)"}`)
  lines.push(`baseUrl:       ${detection.tsconfig.baseUrl ?? "(unset)"}`)
  lines.push("detection:")
  for (const entry of detection.detections) {
    const status = entry.live ? "live" : entry.score > 0 ? "near-miss" : "no"
    lines.push(`  ${entry.source}  score ${String(entry.score)}  ${status}`)
    for (const evidence of entry.evidence)
      lines.push(`    ${evidence.file}:${String(evidence.line)}  ${evidence.what}`)
  }

  lines.push(`exclusions:    ${detection.excludedDirs.join(", ")}`)
  for (const nested of detection.nestedPackages)
    lines.push(
      `nested package: ${nested.dir}/ — run ${options.binName ?? "appgraph"} --root ${nested.dir} to map it  (evidence for: ${nested.sources.join(", ")})`,
    )
  if (detection.skippedDirs.length > 0) lines.push(`skipped dirs:  ${detection.skippedDirs.join(", ")}`)
  if (detection.symlinks.length > 0) lines.push(`symlinks:      ${detection.symlinks.join(", ")}`)
  for (const entry of detection.generated) lines.push(`generated:     ${entry.file}  (${entry.reason})`)
  for (const alias of detection.dependencies.aliases)
    lines.push(`npm: alias:    ${alias.name} -> ${alias.target}@${alias.range}  (${alias.spec})`)

  const { testIds } = detection
  if (testIds === null) lines.push("test-id probe: not run")
  else {
    lines.push(
      `test-id probe: ${testIds.attribute ?? "none"}  (${String(testIds.filesScanned)} file(s) scanned)`,
    )
    for (const entry of testIds.histogram)
      lines.push(`  ${entry.attribute}  ${String(entry.count)} occurrence(s) in ${String(entry.files)} file(s)`)
  }

  for (const line of formatStringSourceTrace(detection.stringSourceProbe)) lines.push(line)

  for (const group of detection.libraries)
    lines.push(`library ${group.group}: ${group.enabled ? group.matched.join(", ") : "(none)"}`)

  for (const attempt of detection.globs)
    lines.push(`glob:          ${attempt.pattern} -> ${String(attempt.matches)} match(es)`)

  if (detection.liveSources.length > 1) {
    lines.push("")
    lines.push(formatSourceChoice(detection.detections, options))
  }

  return lines.join("\n")
}
