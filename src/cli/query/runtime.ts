import * as path from "node:path"
import type { AppGraph, AppgraphConfig } from "../../core/model.js"
import type { FileHost } from "../../core/host.js"
import { createNodeHost, toPosix } from "../../core/host.js"
import { GRAPH_CACHE_FILE, readGraphCache } from "../../emit/graph-cache.js"
import type { AnalyzeInternalOptions, AnalyzeResult } from "../../pipeline/run.js"
import {
  EXIT_CACHE_UNAVAILABLE,
  EXIT_DIAGNOSTIC_ERROR,
  EXIT_FAILURE,
  EXIT_NO_SCREENS,
  exitCodeFor,
} from "../../pipeline/exit-codes.js"
import type { QueryContext } from "../commands.js"
import type { Project } from "../index.js"
import {
  CliError,
  ERROR_HINTS,
  analyzerOf,
  assertCompilerReady,
  batchWriterFor,
  graphStateAfterRun,
  graphStateFor,
  resolveProject,
  tsconfigChainFiles,
  writeFailure,
} from "../index.js"
import { formatDiagnostics } from "../print.js"
import type { GraphOptions, GraphState, Sidecar } from "../stale.js"
import { formatSidecar, isGraphFresh, readSidecar, sidecarPath, sidecarWithGraph, stickyGraphOptions } from "../stale.js"
import { selectedFields } from "./output.js"

export const CACHE_STATUSES = ["fresh", "refreshed", "built"] as const

export type CacheStatus = (typeof CACHE_STATUSES)[number]

export type CacheInfo = {
  readonly status: CacheStatus
  readonly path: string
  readonly fingerprint: string
}

export type LoadedGraph = {
  readonly graph: AppGraph
  readonly cache: CacheInfo
}

export const CACHE_PROBLEMS = {
  missing: { status: "built", label: "cache missing" },
  stale: { status: "refreshed", label: "cache stale" },
  incompatible: { status: "refreshed", label: "cache incompatible" },
  corrupt: { status: "built", label: "cache corrupt" },
} as const satisfies Readonly<Record<string, { readonly status: CacheStatus; readonly label: string }>>

export type CacheProblem = keyof typeof CACHE_PROBLEMS

export const CACHED_HINT = "drop --cached to analyse now, or run appgraph to rebuild the graph cache"

const REFUSAL_HINT = "pass --source <name> to pick one screen source, or --all-sources to run them all"

const NO_GRAPH_CACHE_CODE = "cache/not-emitted"

const GRAPH_FORMAT = "graph"

type EmitFile = AnalyzeResult["files"][number]

type CacheProbe =
  | { readonly kind: "fresh"; readonly graph: AppGraph }
  | { readonly kind: "unavailable"; readonly problem: CacheProblem; readonly detail: string }

type Workspace = {
  readonly context: QueryContext
  readonly host: FileHost
  readonly project: Project
  readonly previous: Sidecar | null
  readonly options: GraphOptions
  readonly state: GraphState
  readonly cachePath: string
}

const unavailable = (problem: CacheProblem, detail: string): CacheProbe => ({ kind: "unavailable", problem, detail })

const hostOf = (context: QueryContext): FileHost => context.deps.host ?? createNodeHost()

const cacheLabel = (workspace: Workspace): string => {
  const relative = path.relative(workspace.project.root, workspace.cachePath)
  return toPosix(relative.startsWith("..") ? workspace.cachePath : relative)
}

const openWorkspace = async (context: QueryContext): Promise<Workspace> => {
  const host = hostOf(context)
  const project = await resolveProject({
    host,
    options: context.options,
    cwd: context.cwd,
    ...(context.deps.loadConfig === undefined ? {} : { loadConfig: context.deps.loadConfig }),
  })
  const previous = readSidecar({ host, outDir: project.outDir })
  const options = stickyGraphOptions(context.options, previous?.graph ?? null)
  const state = graphStateFor({
    host,
    version: context.version,
    project,
    options,
    tsconfigFiles: previous?.graph?.tsconfigFiles ?? [],
  })
  return { context, host, project, previous, options, state, cachePath: path.join(project.outDir, GRAPH_CACHE_FILE) }
}

const probeCache = (workspace: Workspace): CacheProbe => {
  const label = cacheLabel(workspace)
  const text = workspace.host.readFile(workspace.cachePath)
  if (text === null) return unavailable("missing", `no graph cache at ${label}`)
  if (!isGraphFresh(workspace.previous?.graph ?? null, workspace.state.fingerprint.value))
    return unavailable("stale", `${label} no longer matches the project`)
  const read = readGraphCache(text, workspace.context.version)
  if (read.kind === "ok") return { kind: "fresh", graph: read.graph }
  return unavailable(read.kind, `${label}: ${read.reason}`)
}

const cachedError = (probe: Extract<CacheProbe, { readonly kind: "unavailable" }>): CliError =>
  new CliError(`graph cache unavailable (${CACHE_PROBLEMS[probe.problem].label}): ${probe.detail}`, EXIT_CACHE_UNAVAILABLE, {
    code: `cache/${probe.problem}`,
    hint: CACHED_HINT,
  })

const analysisConfig = (project: Project, options: GraphOptions): AppgraphConfig => ({
  ...project.effective,
  formats: [GRAPH_FORMAT],
  ...(options.depth === null ? {} : { depth: options.depth }),
  ...(options.source === null ? {} : { screenSource: options.source }),
  ...(options.allowEmpty ? { allowEmpty: true } : {}),
})

const analyzeOptionsOf = (workspace: Workspace): AnalyzeInternalOptions => {
  const { project } = workspace
  return {
    root: project.root,
    cwd: workspace.context.cwd,
    config: analysisConfig(project, workspace.options),
    ...(project.configFile === null ? {} : { configFile: toPosix(path.relative(project.root, project.configFile)) }),
    host: workspace.host,
    allSources: workspace.options.allSources,
    timestamp: null,
  }
}

const isProgressShown = (context: QueryContext): boolean => !context.options.quiet && !context.options.json

const progressLine = (workspace: Workspace, problem: CacheProblem): string =>
  `appgraph: analysing ${workspace.project.root} (${CACHE_PROBLEMS[problem].label})`

const emitLines = (sink: (line: string) => void, lines: readonly string[]): void => {
  for (const line of lines) sink(line)
}

const traceLines = (result: AnalyzeResult): readonly string[] => (result.trace === "" ? [] : result.trace.split("\n"))

const cacheFileOf = (result: AnalyzeResult): EmitFile | undefined => result.files.find((file) => file.path === GRAPH_CACHE_FILE)

const errorDiagnostics = (result: AnalyzeResult) => result.diagnostics.filter((entry) => entry.severity === "error")

const refusalError = (result: AnalyzeResult): CliError =>
  new CliError("appgraph refused to choose between live screen sources", EXIT_DIAGNOSTIC_ERROR, {
    code: "analysis/refused",
    hint: REFUSAL_HINT,
    diagnostics: errorDiagnostics(result),
  })

const noScreensError = (): CliError =>
  new CliError("appgraph found no screens, so there is no graph to query", EXIT_NO_SCREENS, {
    code: "analysis/no-screens",
    hint: ERROR_HINTS.doctor,
  })

const notEmittedError = (): CliError =>
  new CliError("the analysis produced no graph cache", EXIT_FAILURE, { code: NO_GRAPH_CACHE_CODE, hint: ERROR_HINTS.doctor })

const assertAnswerable = (result: AnalyzeResult, cacheFile: EmitFile | undefined): EmitFile => {
  if (result.refused) throw refusalError(result)
  if (cacheFile !== undefined) return cacheFile
  if (exitCodeFor(result, false) === EXIT_NO_SCREENS) throw noScreensError()
  throw notEmittedError()
}

const decodeWritten = (content: string): AppGraph => {
  const read = readGraphCache(content)
  if (read.kind !== "ok") throw new CliError(`the analysis wrote an unreadable graph cache: ${read.reason}`, EXIT_FAILURE, { code: NO_GRAPH_CACHE_CODE })
  return read.graph
}

const persist = (workspace: Workspace, content: string, state: GraphState): void => {
  const writeAll = batchWriterFor(workspace.context.deps.writeFile)
  try {
    writeAll([
      { absPath: workspace.cachePath, content },
      { absPath: sidecarPath(workspace.project.outDir), content: formatSidecar(sidecarWithGraph(workspace.previous, state.record)) },
    ])
  } catch (error) {
    throw writeFailure(workspace.project, error)
  }
}

const recordedState = async (workspace: Workspace): Promise<GraphState> =>
  graphStateAfterRun({
    host: workspace.host,
    version: workspace.context.version,
    project: workspace.project,
    options: workspace.options,
    tsconfigFiles: await tsconfigChainFiles(workspace.context.deps, workspace.host, workspace.project.root),
    before: workspace.state,
  })

const rebuild = async (workspace: Workspace, problem: CacheProblem): Promise<LoadedGraph> => {
  const { context } = workspace
  await assertCompilerReady(context.deps)
  if (isProgressShown(context)) context.writer.err(progressLine(workspace, problem))

  const result = await analyzerOf(context.deps)(analyzeOptionsOf(workspace))
  emitLines(context.writer.err, traceLines(result))
  const cacheFile = assertAnswerable(result, cacheFileOf(result))
  emitLines(context.writer.err, formatDiagnostics(result.diagnostics, { quiet: true }))

  const graph = decodeWritten(cacheFile.content)
  const state = await recordedState(workspace)
  persist(workspace, cacheFile.content, state)

  return {
    graph,
    cache: { status: CACHE_PROBLEMS[problem].status, path: cacheLabel(workspace), fingerprint: state.fingerprint.value },
  }
}

export const loadGraph = async (context: QueryContext): Promise<LoadedGraph> => {
  selectedFields(context.spec, context.query.fields)
  const workspace = await openWorkspace(context)
  const probe = probeCache(workspace)
  if (probe.kind === "fresh")
    return {
      graph: probe.graph,
      cache: { status: "fresh", path: cacheLabel(workspace), fingerprint: workspace.state.fingerprint.value },
    }
  if (context.query.cached) throw cachedError(probe)
  return rebuild(workspace, probe.problem)
}
