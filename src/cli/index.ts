#!/usr/bin/env node
import * as fs from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import type { AppGraph, AppgraphConfig, Diagnostic, TsconfigChain } from "../core/model.js"
import type { FileHost } from "../core/host.js"
import { createNodeHost, toPosix } from "../core/host.js"
import { findProjectRoot } from "../core/project.js"
import type { CompilerCheck } from "../core/compiler-support.js"
import {
  SUPPORTED_TYPESCRIPT_RANGE,
  checkCompilerApi,
  compilerSupportMessage,
  importTypeScript,
  loadCompiler,
} from "../core/compiler-support.js"
import { DEFAULT_FORMATS, DEFAULT_OUT_DIR } from "../config/types.js"
import { CONFIG_BASENAMES, importConfigFile } from "../config/load.js"
import { GRAPH_CACHE_FILE } from "../emit/graph-cache.js"
import { EXIT_CACHE_UNAVAILABLE, EXIT_NO_SCREENS, exitCodeFor } from "../pipeline/exit-codes.js"
import type { AnalyzeInternalOptions, AnalyzeResult, DetectionTrace } from "../pipeline/run.js"
import type { CliOptions, ParsedCli } from "./args.js"
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, parseArgv, readPackageVersion } from "./args.js"
import type { QueryCommandName, QueryRun } from "./commands.js"
import { COMMAND_NAMES, commandSpec, isCommandName, isQueryCommandName, isQueryModule } from "./commands.js"
import type { DoctorReport, Writer, WrittenFile } from "./print.js"
import {
  countBySeverity,
  createConsoleWriter,
  formatDiagnostics,
  formatDoctor,
  formatSummary,
  formatWritten,
} from "./print.js"
import type { Fingerprint, GraphOptions, GraphRecord, GraphState, RunRecord, Sidecar } from "./stale.js"
import {
  computeRunFingerprint,
  formatSidecar,
  graphStateOf,
  graphTsconfigFiles,
  isUpToDate,
  readPreviousRun,
  readSidecar,
  runConfigOf,
  sidecarPath,
} from "./stale.js"

export type TsconfigProbe = {
  readonly host: FileHost
  readonly root: string
  readonly configPath?: string
}

export type CliDeps = {
  readonly analyze?: (options: AnalyzeInternalOptions) => Promise<AnalyzeResult>
  readonly host?: FileHost
  readonly writer?: Writer
  /** In-memory in the tests; in production every file is staged to a temp sibling, then renamed into place. */
  readonly writeFile?: (absPath: string, content: string) => void
  readonly loadConfig?: (absPath: string) => Promise<AppgraphConfig>
  /** Injected so the startup compiler guard can be exercised without a second `typescript` on disk. */
  readonly compiler?: () => Promise<CompilerCheck>
  readonly tsconfig?: (probe: TsconfigProbe) => Promise<TsconfigChain | null>
  readonly cwd?: string
  readonly version?: string
  /** §5.5: the ONLY clock. Injected so a run can be made byte-reproducible in a test. */
  readonly now?: () => string
  readonly clock?: () => number
}

const loadPipeline = () => import("../pipeline/run.js")

const lazyAnalyze = async (options: AnalyzeInternalOptions): Promise<AnalyzeResult> =>
  (await loadPipeline()).analyze(options)

export const analyzerOf = (deps: CliDeps): ((options: AnalyzeInternalOptions) => Promise<AnalyzeResult>) =>
  deps.analyze ?? lazyAnalyze

type TimingEntry = {
  readonly phase: string
  readonly ms: number
}

type TimingLog = {
  readonly record: (phase: string, ms: number) => void
  readonly entries: () => readonly TimingEntry[]
}

const createTimingLog = (): TimingLog => {
  const entries: TimingEntry[] = []
  return {
    record: (phase, ms) => {
      entries.push({ phase, ms })
    },
    entries: () => [...entries],
  }
}

const roundMs = (ms: number): number => Math.round(ms * 10) / 10

const TOTAL_PHASE = "total"

const timingRecord = (entries: readonly TimingEntry[]): Readonly<Record<string, number>> =>
  Object.fromEntries(entries.map((entry) => [entry.phase, roundMs(entry.ms)]))

const timingLines = (entries: readonly TimingEntry[]): readonly string[] => {
  const width = Math.max(...entries.map((entry) => entry.phase.length))
  return ["appgraph: timing", ...entries.map((entry) => `  ${entry.phase.padEnd(width)}  ${roundMs(entry.ms).toFixed(1)} ms`)]
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error"

export const ERROR_HINTS = {
  doctor: "run appgraph doctor for the full detection trace",
  out: "check that --out names a writable directory",
  root: "pass an existing directory to --root",
  compiler: `install a supported compiler in the project: typescript@${SUPPORTED_TYPESCRIPT_RANGE}`,
  config: "fix the config file, or run appgraph doctor to see how it was resolved",
} as const

const DEFAULT_ERROR_CODES: Readonly<Record<number, string>> = {
  [EXIT_USAGE]: "cli/usage",
  [EXIT_CACHE_UNAVAILABLE]: "cache/unavailable",
}

export type CliErrorDetail = {
  readonly code?: string
  readonly hint?: string
  readonly diagnostics?: readonly Diagnostic[]
}

export class CliError extends Error {
  readonly exitCode: number
  readonly code: string
  readonly hint: string | null
  readonly diagnostics: readonly Diagnostic[]

  constructor(message: string, exitCode: number, detail: CliErrorDetail = {}) {
    super(message)
    this.exitCode = exitCode
    this.code = detail.code ?? detail.diagnostics?.[0]?.code ?? DEFAULT_ERROR_CODES[exitCode] ?? "cli/failure"
    this.hint = detail.hint ?? null
    this.diagnostics = detail.diagnostics ?? []
  }
}

export type FileWrite = {
  readonly absPath: string
  readonly content: string
}

export type BatchWriter = (writes: readonly FileWrite[]) => void

const isSymlink = (absPath: string): boolean => fs.lstatSync(absPath, { throwIfNoEntry: false })?.isSymbolicLink() ?? false

const isDirectory = (absPath: string): boolean => fs.lstatSync(absPath, { throwIfNoEntry: false })?.isDirectory() ?? false

const assertWritableTarget = (absPath: string): void => {
  const symlinked = [absPath, path.dirname(absPath)].find(isSymlink)
  if (symlinked !== undefined) throw new Error(`refusing to write through the symlink ${symlinked}`)
  if (isDirectory(absPath)) throw new Error(`cannot replace ${absPath}: it is a directory`)
}

const stagingPathFor = (absPath: string): string =>
  path.join(path.dirname(absPath), `.${path.basename(absPath)}.${String(process.pid)}.tmp`)

const stage = (write: FileWrite, staged: string[]): void => {
  assertWritableTarget(write.absPath)
  fs.mkdirSync(path.dirname(write.absPath), { recursive: true })
  const temp = stagingPathFor(write.absPath)
  fs.rmSync(temp, { force: true })
  staged.push(temp)
  fs.writeFileSync(temp, write.content, { encoding: "utf8", flag: "wx" })
}

const discard = (staged: readonly string[]): void => {
  for (const temp of staged) fs.rmSync(temp, { force: true })
}

type Swap = {
  readonly target: string
  readonly backup: string | null
}

const backupPathFor = (absPath: string): string =>
  path.join(path.dirname(absPath), `.${path.basename(absPath)}.${String(process.pid)}.bak`)

const swapIn = (temp: string, target: string): Swap => {
  const backup = fs.existsSync(target) ? backupPathFor(target) : null
  if (backup !== null) fs.renameSync(target, backup)
  try {
    fs.renameSync(temp, target)
  } catch (error) {
    if (backup !== null) fs.renameSync(backup, target)
    throw error
  }
  return { target, backup }
}

const rollBack = (swap: Swap): void => {
  if (swap.backup === null) {
    fs.rmSync(swap.target, { force: true })
    return
  }
  fs.renameSync(swap.backup, swap.target)
}

/** All-or-nothing: every artifact is staged first, and a failed swap restores the ones already replaced. */
const nodeWriteAll: BatchWriter = (writes) => {
  const staged: string[] = []
  try {
    for (const write of writes) stage(write, staged)
  } catch (error) {
    discard(staged)
    throw error
  }
  const swapped: Swap[] = []
  try {
    writes.forEach((write, index) => swapped.push(swapIn(staged[index] ?? "", write.absPath)))
  } catch (error) {
    swapped.reverse().forEach(rollBack)
    discard(staged)
    throw error
  }
  swapped.forEach((swap) => discard(swap.backup === null ? [] : [swap.backup]))
}

export const batchWriterFor = (writeFile: CliDeps["writeFile"]): BatchWriter =>
  writeFile === undefined
    ? nodeWriteAll
    : (writes) => {
        for (const write of writes) writeFile(write.absPath, write.content)
      }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const noDefaultExport = (absPath: string): Diagnostic => ({
  severity: "error",
  code: "config/no-default-export",
  message: `${absPath} has no default export object; use 'export default defineConfig({...})'`,
  plugin: null,
})

/** The same loader `analyze()` uses (§15.2); a `.ts`/`.mts` config loads without the compiler where Node can strip its types. */
export const importConfig = async (absPath: string): Promise<AppgraphConfig> => {
  const imported = await importConfigFile({ root: path.dirname(absPath), file: absPath })
  const failure = { hint: ERROR_HINTS.config }
  if (imported.diagnostics.length > 0)
    throw new CliError(`cannot load ${absPath}`, EXIT_FAILURE, { ...failure, diagnostics: imported.diagnostics })
  if (!isRecord(imported.exported))
    throw new CliError(`cannot load ${absPath}`, EXIT_FAILURE, { ...failure, diagnostics: [noDefaultExport(absPath)] })
  return imported.exported
}

export const loadTsconfigChain = async (probe: TsconfigProbe): Promise<TsconfigChain | null> => {
  const [ts, { loadTsconfig }] = await Promise.all([loadCompiler(), import("../core/tsconfig.js")])
  const { chain } = loadTsconfig({
    ts,
    host: probe.host,
    root: probe.root,
    ...(probe.configPath === undefined ? {} : { configPath: probe.configPath }),
  })
  return chain.files.length === 0 ? null : chain
}

type Resolved = {
  readonly root: string
  readonly rootReason: string
  readonly configFile: string | null
  readonly config: AppgraphConfig | null
}

const resolveRoot = (
  host: FileHost,
  options: CliOptions,
  cwd: string,
): { readonly root: string; readonly reason: string } => {
  if (options.root !== undefined) return { root: path.resolve(cwd, options.root), reason: "--root" }
  const found = findProjectRoot(host, cwd)
  return found === null
    ? { root: path.resolve(cwd), reason: "cwd (no ancestor with package.json + tsconfig.json)" }
    : { root: found, reason: "nearest ancestor with package.json + tsconfig.json" }
}

const assertRootExists = (host: FileHost, options: CliOptions, cwd: string): void => {
  if (options.root === undefined) return
  const root = path.resolve(cwd, options.root)
  if (!host.isDirectory(root))
    throw new CliError(`--root ${options.root} is not a directory (resolved to ${root})`, EXIT_USAGE, {
      code: "cli/root-not-found",
      hint: ERROR_HINTS.root,
    })
}

const findConfigFile = (host: FileHost, root: string, options: CliOptions, cwd: string): string | null => {
  if (options.config !== undefined) return path.resolve(cwd, options.config)
  const found = CONFIG_BASENAMES.find((candidate) => host.isFile(path.join(root, candidate)))
  return found === undefined ? null : path.join(root, found)
}

/** Root order: `--root` -> the config file's own `root` -> nearest package.json + tsconfig.json -> cwd. */
const resolveInputs = async (
  host: FileHost,
  options: CliOptions,
  cwd: string,
  loadConfig: (absPath: string) => Promise<AppgraphConfig>,
): Promise<Resolved> => {
  const fromCli = resolveRoot(host, options, cwd)
  const configFile = findConfigFile(host, fromCli.root, options, cwd)
  const loaded = configFile === null ? null : await loadConfig(configFile)
  const configDir = configFile === null ? fromCli.root : path.dirname(configFile)

  return {
    root: loaded?.root === undefined ? fromCli.root : path.resolve(configDir, loaded.root),
    rootReason: loaded?.root === undefined ? fromCli.reason : "config file `root`",
    configFile,
    config: loaded,
  }
}

/** CLI flags win over the config file; everything the pipeline reads flows through this one object. */
const effectiveConfig = (base: AppgraphConfig | null, options: CliOptions): AppgraphConfig => ({
  ...(base ?? {}),
  ...(options.formats.length === 0 ? {} : { formats: options.formats }),
  ...(options.out === undefined ? {} : { out: options.out }),
  ...(options.depth === undefined ? {} : { depth: options.depth }),
  ...(options.source === undefined ? {} : { screenSource: options.source }),
  ...(options.strict ? { strict: true } : {}),
  ...(options.allowEmpty ? { allowEmpty: true } : {}),
})

const formatsOf = (config: AppgraphConfig): readonly string[] => config.formats ?? [...DEFAULT_FORMATS]

const GRAPH_FORMAT = "graph"

const ALL_FORMAT = "all"

export const withGraphFormat = (formats: readonly string[]): readonly string[] =>
  formats.includes(GRAPH_FORMAT) || formats.includes(ALL_FORMAT) ? formats : [...formats, GRAPH_FORMAT]

const outDirOf = (root: string, config: AppgraphConfig): string => path.resolve(root, config.out ?? DEFAULT_OUT_DIR)

export type Project = Resolved & {
  readonly effective: AppgraphConfig
  readonly outDir: string
  readonly outLabel: string
}

export type ProjectInput = {
  readonly host: FileHost
  readonly options: CliOptions
  readonly cwd: string
  readonly loadConfig?: (absPath: string) => Promise<AppgraphConfig>
}

export const resolveProject = async (input: ProjectInput): Promise<Project> => {
  assertRootExists(input.host, input.options, input.cwd)
  const resolved = await resolveInputs(input.host, input.options, input.cwd, input.loadConfig ?? importConfig)
  return projectOf(resolved, input.options)
}

const projectOf = (resolved: Resolved, options: CliOptions): Project => {
  const effective = effectiveConfig(resolved.config, options)
  const outDir = outDirOf(resolved.root, effective)
  return { ...resolved, effective, outDir, outLabel: toPosix(path.relative(resolved.root, outDir)) || "." }
}

const configFileLabel = (project: Resolved): string | null =>
  project.configFile === null ? null : toPosix(path.relative(project.root, project.configFile))

export const graphOptionsOf = (options: CliOptions): GraphOptions => ({
  source: options.source ?? null,
  depth: options.depth ?? null,
  allSources: options.allSources,
  allowEmpty: options.allowEmpty,
})

export type GraphStateRequest = {
  readonly host: FileHost
  readonly version: string
  readonly project: Project
  readonly options: GraphOptions
  readonly tsconfigFiles: readonly string[]
}

export const graphStateFor = (request: GraphStateRequest): GraphState =>
  graphStateOf({
    host: request.host,
    appgraphVersion: request.version,
    root: request.project.root,
    outDir: request.project.outDir,
    sourceRoots: request.project.config?.sourceRoots ?? ["."],
    config: request.project.config,
    configFile: configFileLabel(request.project),
    options: request.options,
    tsconfigFiles: request.tsconfigFiles,
  })

/** Only fields that can change the artifacts beyond the graph feed the run hash — never `--quiet` or `--json`. */
const runOptionsOf = (options: CliOptions, project: Project) => ({
  cli: {
    formats: options.formats,
    screen: options.screen ?? null,
    out: options.out ?? null,
    locale: options.locale ?? null,
    allowEmpty: options.allowEmpty,
    strict: options.strict,
    timestamp: options.timestamp,
  },
  config: runConfigOf(project.config),
})

type Fingerprints = {
  readonly graph: GraphState
  readonly run: Fingerprint
}

const fingerprintsOf = (graph: GraphState, options: CliOptions, project: Project): Fingerprints => ({
  graph,
  run: computeRunFingerprint(graph.fingerprint, runOptionsOf(options, project)),
})

type AnalyzeContext = {
  readonly host: FileHost
  readonly cwd: string
  readonly resolved: Resolved
  readonly options: CliOptions
  readonly config: AppgraphConfig
  /** The generation timestamp, already suppressed by `--no-timestamp`. */
  readonly timestamp: string | null
  readonly timing: TimingLog | null
  readonly clock: () => number
}

/**
 * The kernel owns the emitter set; `--locale` reaches it as an emit SETTING, so the CLI never replaces
 * the built-in emitters and can never discard a detected `testIdAttribute` by doing so.
 */
const analyzeOptionsFor = (context: AnalyzeContext): AnalyzeInternalOptions => {
  const { options } = context
  const emitOptions = {
    ...(options.screen === undefined ? {} : { screen: options.screen }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
  }

  return {
    root: context.resolved.root,
    cwd: context.cwd,
    config: context.config,
    ...(context.resolved.configFile === null
      ? {}
      : { configFile: toPosix(path.relative(context.resolved.root, context.resolved.configFile)) }),
    host: context.host,
    allSources: options.allSources,
    timestamp: context.timestamp,
    ...(options.locale === undefined ? {} : { emit: { locale: options.locale } }),
    ...(Object.keys(emitOptions).length === 0 ? {} : { emitOptions }),
    ...(context.timing === null ? {} : { onPhase: context.timing.record, clock: context.clock }),
  }
}

const sizeOf = (file: FileWrite, outDir: string): WrittenFile => ({
  path: toPosix(path.relative(outDir, file.absPath)),
  bytes: Buffer.byteLength(file.content, "utf8"),
})

type Sinks = {
  readonly human: (line: string) => void
  readonly machine: (line: string) => void
  readonly problem: (line: string) => void
}

/** `--json`: stdout carries exactly one object, so every prose line moves to stderr. */
const sinksFor = (writer: Writer, options: CliOptions): Sinks => ({
  human: options.json ? writer.err : writer.out,
  machine: writer.out,
  problem: writer.err,
})

const emitLines = (sink: (line: string) => void, lines: readonly string[]): void => {
  for (const line of lines) sink(line)
}

/**
 * Phase 0's own histogram when there is one — every candidate attribute with its occurrence count. The
 * graph-derived single row is the fallback for a caller that supplied its own detections and so ran no
 * probe.
 */
const testIdHistogram = (
  detection: DetectionTrace,
  graph: AppGraph | null,
  config: AppgraphConfig | null,
): readonly { readonly attribute: string; readonly count: number }[] => {
  if (detection.testIds.length > 0)
    return detection.testIds.map((entry) => ({ attribute: entry.attribute, count: entry.count }))
  if (graph === null) return []
  const count = graph.screens.reduce((sum, screen) => sum + screen.facts.testIds.length, 0)
  return [{ attribute: config?.testIdAttribute ?? detection.testIdAttribute ?? "(auto-detected)", count }]
}

const DOCTOR_NOTES = [
  "Scores order the display and set the live threshold; they never pick a winner.",
  "A source scoring in [1, 50) is a near-miss and never runs on its own — select it with --source.",
] as const

type RunContext = {
  readonly options: CliOptions
  readonly host: FileHost
  readonly writer: Writer
  readonly sinks: Sinks
  readonly cwd: string
  readonly version: string
  readonly now: () => string
  readonly clock: () => number
  readonly timing: TimingLog | null
  readonly started: number
  readonly deps: CliDeps
}

const timedStep = async <T>(context: RunContext, phase: string, run: () => Promise<T>): Promise<T> => {
  const { timing } = context
  if (timing === null) return run()
  const start = context.clock()
  const value = await run()
  timing.record(phase, context.clock() - start)
  return value
}

const timedSync = <T>(context: RunContext, phase: string, run: () => T): T => {
  const { timing } = context
  if (timing === null) return run()
  const start = context.clock()
  const value = run()
  timing.record(phase, context.clock() - start)
  return value
}

const finishTiming = (context: RunContext): readonly TimingEntry[] | null => {
  const { timing } = context
  if (timing === null) return null
  return [...timing.entries(), { phase: TOTAL_PHASE, ms: context.clock() - context.started }]
}

const reportTiming = (context: RunContext, entries: readonly TimingEntry[] | null): void => {
  if (entries === null) return
  emitLines(context.sinks.problem, timingLines(entries))
}

const timingField = (entries: readonly TimingEntry[] | null) =>
  entries === null ? {} : { timing: timingRecord(entries) }

const probeCompiler = async (): Promise<CompilerCheck> =>
  importTypeScript()
    .then(checkCompilerApi)
    .catch((error: unknown): CompilerCheck => ({ kind: "not-installed", detail: messageOf(error) }))

/**
 * Only paths that analyse call this — before detection globs anything, so the failure names the compiler
 * rather than surfacing as `api.readJsonConfigFile is not a function` from three phases in.
 */
export const assertCompilerReady = async (deps: CliDeps): Promise<void> => {
  const message = compilerSupportMessage(await (deps.compiler ?? probeCompiler)())
  if (message !== null)
    throw new CliError(message, EXIT_FAILURE, { code: "cli/compiler-unsupported", hint: ERROR_HINTS.compiler })
}

export const tsconfigChainFiles = async (deps: CliDeps, host: FileHost, root: string): Promise<readonly string[]> => {
  const chain = await (deps.tsconfig ?? loadTsconfigChain)({ host, root }).catch(() => null)
  return chain?.files ?? []
}

const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry, index) => entry === right[index])

export type GraphStateAfterRun = GraphStateRequest & {
  readonly before: GraphState
}

export const graphStateAfterRun = (request: GraphStateAfterRun): GraphState => {
  const { host, project, before, tsconfigFiles } = request
  const unchanged = sameList(
    graphTsconfigFiles(host, project.root, before.record.tsconfigFiles),
    graphTsconfigFiles(host, project.root, tsconfigFiles),
  )
  if (unchanged) return { ...before, record: { ...before.record, tsconfigFiles } }
  return graphStateFor(request)
}

const recordedFingerprints = (context: RunContext, project: Project, before: Fingerprints, chainFiles: readonly string[]): Fingerprints =>
  fingerprintsOf(
    graphStateAfterRun({
      host: context.host,
      version: context.version,
      project,
      options: graphOptionsOf(context.options),
      tsconfigFiles: chainFiles,
      before: before.graph,
    }),
    context.options,
    project,
  )

const writesGraphCache = (exitCode: number): boolean => exitCode !== EXIT_USAGE

const runRecordOf = (fingerprint: string, written: readonly WrittenFile[], exitCode: number, graph: AppGraph): RunRecord => ({
  fingerprint,
  artifacts: written.map((file) => file.path),
  exitCode,
  counts: graph.meta.counts,
})

type SidecarInput = {
  readonly previous: Sidecar | null
  readonly run: RunRecord | null
  readonly graph: GraphRecord | null
}

/**
 * Only a clean run is recorded for `--if-stale`: a later run must never skip past an error, a strict
 * warning or the zero-screen signal just because nothing changed since the run that produced it.
 */
const nextSidecar = (input: SidecarInput): Sidecar => ({
  run: input.run,
  graph: input.graph ?? input.previous?.graph ?? null,
})

const skippedJson = (
  context: RunContext,
  project: Project,
  formats: readonly string[],
  fingerprint: string,
  run: RunRecord,
  timing: readonly TimingEntry[] | null,
): string =>
  JSON.stringify({
    command: "analyze",
    appgraphVersion: context.version,
    root: project.root,
    out: project.outLabel,
    formats,
    skipped: true,
    fingerprint,
    emptyResult: run.exitCode === EXIT_NO_SCREENS,
    refused: false,
    counts: run.counts,
    wrote: [],
    diagnostics: [],
    exitCode: EXIT_OK,
    ...timingField(timing),
  })

const analysisContext = (context: RunContext, project: Project, config: AppgraphConfig): AnalyzeContext => ({
  host: context.host,
  cwd: context.cwd,
  resolved: project,
  options: context.options,
  config,
  timestamp: context.options.timestamp ? context.now() : null,
  timing: context.timing,
  clock: context.clock,
})

export const writeFailure = (project: Project, error: unknown): CliError =>
  new CliError(`cannot write to ${project.outDir}: ${messageOf(error)}`, EXIT_FAILURE, {
    code: "cli/write-failed",
    hint: ERROR_HINTS.out,
  })

const runAnalyze = async (context: RunContext): Promise<number> => {
  const { options, host, sinks } = context
  const analyzeFn = analyzerOf(context.deps)
  const writeAll = batchWriterFor(context.deps.writeFile)

  const project = await resolveProject({ host, options, cwd: context.cwd, ...(context.deps.loadConfig === undefined ? {} : { loadConfig: context.deps.loadConfig }) })
  const formats = withGraphFormat(formatsOf(project.effective))
  const previous = readSidecar({ host, outDir: project.outDir })
  const recordedFiles = previous?.graph?.tsconfigFiles ?? []

  const fingerprints = await timedStep(context, "fingerprint", () =>
    Promise.resolve(
      fingerprintsOf(
        graphStateFor({ host, version: context.version, project, options: graphOptionsOf(options), tsconfigFiles: recordedFiles }),
        options,
        project,
      ),
    ),
  )

  const previousRun = readPreviousRun({ host, outDir: project.outDir })
  if (options.ifStale && previousRun !== null && isUpToDate(host, project.outDir, previousRun, fingerprints.run.value)) {
    if (!options.quiet) sinks.human(`appgraph: up to date (fingerprint ${fingerprints.run.value})`)
    const timing = finishTiming(context)
    reportTiming(context, timing)
    if (options.json) sinks.machine(skippedJson(context, project, formats, fingerprints.run.value, previousRun, timing))
    return EXIT_OK
  }

  await timedStep(context, "probe", () => assertCompilerReady(context.deps))

  const result = await analyzeFn(analyzeOptionsFor(analysisContext(context, project, { ...project.effective, formats })))

  if (!options.quiet && !result.refused)
    emitLines(sinks.human, formatSummary({ root: project.root, formats, counts: result.graph.meta.counts }))

  const hasErrors = countBySeverity(result.diagnostics, "error") > 0
  emitLines(hasErrors ? sinks.problem : sinks.human, formatDiagnostics(result.diagnostics, { quiet: options.quiet }))

  if (result.trace !== "") emitLines(sinks.problem, result.trace.split("\n"))

  const exitCode = exitCodeFor(result, options.strict)
  const files = writesGraphCache(exitCode) ? result.files : result.files.filter((file) => file.path !== GRAPH_CACHE_FILE)
  const artifacts = files.map((file) => ({ absPath: path.join(project.outDir, file.path), content: file.content }))
  const written = artifacts.map((file) => sizeOf(file, project.outDir))

  const recorded =
    artifacts.length === 0
      ? fingerprints
      : await timedStep(context, "tsconfig", async () =>
          recordedFingerprints(context, project, fingerprints, await tsconfigChainFiles(context.deps, host, project.root)),
        )

  const sidecar = nextSidecar({
    previous,
    run: exitCode === EXIT_OK ? runRecordOf(recorded.run.value, written, exitCode, result.graph) : null,
    graph: files.some((file) => file.path === GRAPH_CACHE_FILE) ? recorded.graph.record : null,
  })
  const writes = artifacts.length === 0 ? [] : [...artifacts, { absPath: sidecarPath(project.outDir), content: formatSidecar(sidecar) }]

  timedSync(context, "write", () => {
    try {
      writeAll(writes)
    } catch (error) {
      throw writeFailure(project, error)
    }
  })

  if (!options.quiet) emitLines(sinks.human, formatWritten(written, project.outLabel))

  const timing = finishTiming(context)
  reportTiming(context, timing)

  if (options.json)
    sinks.machine(
      JSON.stringify({
        command: "analyze",
        appgraphVersion: context.version,
        root: project.root,
        out: project.outLabel,
        formats,
        skipped: false,
        fingerprint: recorded.run.value,
        emptyResult: result.emptyResult,
        refused: result.refused,
        counts: result.graph.meta.counts,
        wrote: written,
        diagnostics: result.diagnostics,
        exitCode,
        ...(result.trace === "" ? {} : { trace: result.trace }),
        ...timingField(timing),
      }),
    )

  return exitCode
}

/** `doctor` reports; it never judges. It always exits 0 once the flags themselves parsed. */
const runDoctor = async (context: RunContext): Promise<number> => {
  const { options, host, sinks } = context
  const analyzeFn = analyzerOf(context.deps)
  const loadConfig = context.deps.loadConfig ?? importConfig

  await timedStep(context, "probe", () => assertCompilerReady(context.deps))

  assertRootExists(host, options, context.cwd)
  const resolved = await resolveInputs(host, options, context.cwd, loadConfig).catch(
    (error: unknown): Resolved => ({
      root: path.resolve(context.cwd, options.root ?? "."),
      rootReason: `config load failed: ${messageOf(error)}`,
      configFile: null,
      config: null,
    }),
  )
  const project = projectOf(resolved, options)

  const { tsconfig, fingerprint } = await timedStep(context, "fingerprint", async () => {
    const chain = await (context.deps.tsconfig ?? loadTsconfigChain)({ host, root: resolved.root }).catch(() => null)
    const graph = graphStateFor({ host, version: context.version, project, options: graphOptionsOf(options), tsconfigFiles: chain?.files ?? [] })
    return { tsconfig: chain, fingerprint: graph.fingerprint }
  })

  const outcome = await analyzeFn(analyzeOptionsFor(analysisContext(context, project, project.effective)))
    .then((result): { readonly result: AnalyzeResult | null; readonly failure: string | null } => ({
      result,
      failure: null,
    }))
    .catch((error: unknown) => ({ result: null, failure: messageOf(error) }))

  const graph: AppGraph | null = outcome.result?.graph ?? null
  const diagnostics: readonly Diagnostic[] = outcome.result?.diagnostics ?? []
  const detection: DetectionTrace = outcome.result?.detection ?? (await loadPipeline()).EMPTY_DETECTION_TRACE

  const report: DoctorReport = {
    appgraphVersion: context.version,
    root: resolved.root,
    rootReason: resolved.rootReason,
    cwd: context.cwd,
    configFile: resolved.configFile,
    sourceRoots: graph?.meta.sourceRoots ?? resolved.config?.sourceRoots ?? ["."],
    tsconfig,
    templateCompilers: detection.templateCompilers,
    screenSources: graph?.meta.screenSources ?? [],
    sourcesRun: detection.sourcesRun,
    counts: graph?.meta.counts ?? {},
    confidence: graph?.meta.confidence ?? [],
    navGroups: graph?.navGroups ?? [],
    detections: detection.detections,
    globs: detection.globs,
    nearMisses: detection.nearMisses,
    exclusions: detection.exclusions,
    nestedPackages: detection.nestedPackages,
    testIdAttributes: testIdHistogram(detection, graph, resolved.config),
    limitations: graph?.meta.limitations ?? [],
    diagnostics,
    trace: outcome.result?.trace ?? "",
    fingerprint: fingerprint.value,
    fingerprintParts: fingerprint.parts,
    failure: outcome.failure,
    notes: [...DOCTOR_NOTES],
  }

  emitLines(sinks.human, formatDoctor(report))
  const timing = finishTiming(context)
  reportTiming(context, timing)
  if (options.json) sinks.machine(JSON.stringify({ command: "doctor", ...report, exitCode: EXIT_OK, ...timingField(timing) }))

  return EXIT_OK
}

const loadQuery = async (name: QueryCommandName) => {
  const load = commandSpec(name).load
  const loaded: unknown = await (load === undefined ? Promise.resolve(null) : load()).catch((error: unknown) => {
    throw new CliError(`cannot load the ${name} command: ${messageOf(error)}`, EXIT_FAILURE, { code: "cli/command-unavailable" })
  })
  if (!isQueryModule(loaded))
    throw new CliError(`the ${name} command has no default-exported run(context)`, EXIT_FAILURE, { code: "cli/command-unavailable" })
  return loaded.default
}

const runQuery = async (context: RunContext, parsed: ParsedCli, command: QueryCommandName): Promise<number> => {
  const run = await timedStep(context, "load-command", () => loadQuery(command))
  const exitCode = await timedStep(context, "query", () => runQueryHandler(context, parsed, command, run))
  reportTiming(context, finishTiming(context))
  return exitCode
}

const runQueryHandler = (context: RunContext, parsed: ParsedCli, command: QueryCommandName, run: QueryRun): Promise<number> =>
  run({
    command,
    spec: commandSpec(command),
    args: parsed.args,
    options: parsed.options,
    query: parsed.query,
    own: parsed.own,
    writer: context.writer,
    deps: context.deps,
    cwd: context.cwd,
    version: context.version,
    clock: context.clock,
  })

const runCommand = (context: RunContext, parsed: ParsedCli): Promise<number> => {
  const { command } = parsed
  if (isQueryCommandName(command)) return runQuery(context, parsed, command)
  return command === "doctor" ? runDoctor(context) : runAnalyze(context)
}

type FailureTarget = {
  readonly command: string
  readonly json: boolean
}

const DEFAULT_COMMAND = "analyze"

const commandOf = (argv: readonly string[]): string => {
  const [first] = argv
  return first !== undefined && isCommandName(first) ? first : DEFAULT_COMMAND
}

const failureLines = (error: unknown): readonly string[] => {
  const head = `appgraph: ${messageOf(error)}`
  if (!(error instanceof CliError)) return [head]
  return [
    head,
    ...(error.diagnostics.length === 0 ? [] : formatDiagnostics(error.diagnostics, { quiet: false })),
    ...(error.hint === null ? [] : [`  hint: ${error.hint}`]),
  ]
}

const errorOf = (error: unknown) =>
  error instanceof CliError
    ? { code: error.code, message: error.message, hint: error.hint }
    : { code: "cli/failure", message: messageOf(error), hint: ERROR_HINTS.doctor }

const failureJson = (target: FailureTarget, error: unknown, exitCode: number): string =>
  JSON.stringify({
    command: target.command,
    exitCode,
    error: errorOf(error),
    diagnostics: error instanceof CliError ? error.diagnostics : [],
  })

/** Every failure path ends here: prose on stderr, and under `--json` still exactly one object on stdout. */
const reportFailure = (writer: Writer, target: FailureTarget, error: unknown): number => {
  const exitCode = error instanceof CliError ? error.exitCode : EXIT_FAILURE
  emitLines(writer.err, failureLines(error))
  if (target.json) writer.out(failureJson(target, error, exitCode))
  return exitCode
}

const usageError = (message: string, command: string): CliError =>
  new CliError(message, EXIT_USAGE, {
    hint: command === DEFAULT_COMMAND ? `run appgraph --help; commands: ${COMMAND_NAMES.join(", ")}` : `run appgraph ${command} --help`,
  })

export const runCli = async (argv: readonly string[], deps: CliDeps = {}): Promise<number> => {
  const clock = deps.clock ?? (() => performance.now())
  const started = clock()
  const writer = deps.writer ?? createConsoleWriter()
  const outcome = parseArgv(argv, {
    writeOut: (text) => writer.out(text.replace(/\n$/, "")),
    writeErr: (text) => writer.err(text.replace(/\n$/, "")),
  })

  const fallback = { command: commandOf(argv), json: argv.includes("--json") }

  if (outcome.kind === "exit") return outcome.code
  if (outcome.kind === "error") return reportFailure(writer, fallback, usageError(outcome.message, fallback.command))

  const parsed: ParsedCli = outcome.parsed

  const context: RunContext = {
    options: parsed.options,
    host: deps.host ?? createNodeHost(),
    writer,
    sinks: sinksFor(writer, parsed.options),
    cwd: deps.cwd ?? process.cwd(),
    version: deps.version ?? readPackageVersion(),
    now: deps.now ?? (() => new Date().toISOString()),
    clock,
    timing: parsed.options.timing ? createTimingLog() : null,
    started,
    deps,
  }

  try {
    return await runCommand(context, parsed)
  } catch (error) {
    return reportFailure(writer, { command: parsed.command, json: parsed.options.json }, error)
  }
}

const isRunAsEntry = (): boolean => {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(invoked)).href
  } catch {
    return import.meta.url === pathToFileURL(invoked).href
  }
}

if (isRunAsEntry()) process.exitCode = await runCli(process.argv.slice(2))
