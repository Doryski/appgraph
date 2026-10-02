import { createHash } from "node:crypto"
import * as path from "node:path"
import type { FileHost } from "../core/host.js"
import { toPosix } from "../core/host.js"
import { DEFAULT_EXCLUDED_DIRS } from "../core/project.js"
import { byCodepoint } from "../core/order.js"
import type { PeerResolveResult } from "../core/peer-loader.js"
import { resolvePeer } from "../core/peer-loader.js"
import { readDependencies } from "../core/dependencies.js"
import type { TemplateFrameworkIdentity } from "../core/template-framework-ids.js"
import { TEMPLATE_FRAMEWORK_IDENTITIES, applicableFrameworks } from "../core/template-framework-ids.js"

export const FINGERPRINT_FILE = ".appgraph-fingerprint"

const FINGERPRINT_IN_YAML = /^\s*fingerprint:\s*"?([0-9a-f]{8,64})"?\s*$/m

export type SourceRootStat = {
  readonly root: string
  readonly files: number
  /** sha256 over the sorted `(relative path, mtime)` list, so a rename or a move changes it too. */
  readonly digest: string
}

export type FingerprintInput = {
  readonly host: FileHost
  /** The analyzer's OWN version is part of the hash, so upgrading it invalidates its cache. */
  readonly appgraphVersion: string
  readonly root: string
  /** Project-relative POSIX. Every entry is walked — not just `src/`. */
  readonly sourceRoots: readonly string[]
  /** The effective options: CLI flags merged over the loaded config file. */
  readonly config: unknown
  /** Project-relative POSIX, in `extends` chain order. */
  readonly tsconfigFiles: readonly string[]
  /**
   * Directories the walk must not descend into, resolved against `root`. The output dir belongs here:
   * a `docs/appgraph` inside a source root would otherwise change the file count on every run and no
   * `--if-stale` comparison would ever match.
   */
  readonly excluded?: readonly string[]
  readonly templateFrameworks?: readonly TemplateFrameworkIdentity[]
}

export type Fingerprint = {
  readonly value: string
  /** Every line that fed the hash, in hashed order — `doctor` prints these verbatim. */
  readonly parts: readonly string[]
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => byCodepoint(a, b))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`
}

const EXCLUDED = new Set<string>(DEFAULT_EXCLUDED_DIRS)

const isSkippedDirName = (name: string): boolean => EXCLUDED.has(name) || name.startsWith(".")

type FileStamp = {
  readonly file: string
  readonly mtimeMs: number
}

const collectFiles = (host: FileHost, dir: string, skip: ReadonlySet<string>): readonly string[] =>
  host.readDir(dir).flatMap((entry) => {
    if (entry.kind === "symlink" || entry.kind === "other") return []
    const child = path.join(dir, entry.name)
    if (entry.kind !== "directory") return [child]
    if (isSkippedDirName(entry.name) || skip.has(child)) return []
    return collectFiles(host, child, skip)
  })

const filesUnder = (host: FileHost, abs: string, skip: ReadonlySet<string>): readonly string[] => {
  if (host.isDirectory(abs)) return collectFiles(host, abs, skip)
  return host.isFile(abs) ? [abs] : []
}

const stampLine = (stamp: FileStamp): string => `${JSON.stringify(stamp.file)}:${String(stamp.mtimeMs)}`

export const statSourceRoot = (
  host: FileHost,
  root: string,
  sourceRoot: string,
  excluded: readonly string[] = [],
): SourceRootStat => {
  const abs = path.resolve(root, sourceRoot)
  const skip = new Set(excluded.map((entry) => path.resolve(root, entry)))
  const stamps = filesUnder(host, abs, skip)
    .map((file) => ({ file: toPosix(path.relative(root, file)), mtimeMs: host.mtimeMs(file) ?? 0 }))
    .sort((a, b) => byCodepoint(a.file, b.file))

  return { root: toPosix(sourceRoot), files: stamps.length, digest: sha256(stamps.map(stampLine).join("\n")) }
}

const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies"] as const

const parseJsonObject = (text: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const dependencyManifest = (text: string): string => {
  const manifest = parseJsonObject(text)
  if (manifest === null) return `invalid:${sha256(text)}`
  return stableStringify(Object.fromEntries(DEPENDENCY_SECTIONS.map((section) => [section, manifest[section] ?? null])))
}

const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

const isStampedBySourceRoots = (input: FingerprintInput, file: string): boolean => {
  const excluded = (input.excluded ?? []).map((entry) => path.resolve(input.root, entry))
  if (excluded.some((dir) => isInside(dir, file))) return false
  return input.sourceRoots.some((sourceRoot) => isInside(path.resolve(input.root, sourceRoot), file))
}

const dependencyManifestParts = (input: FingerprintInput): readonly string[] => {
  const manifestPath = path.join(input.root, "package.json")
  if (isStampedBySourceRoots(input, manifestPath)) return []
  const text = input.host.readFile(manifestPath)
  return [`packageDependencies=${text === null ? "missing" : dependencyManifest(text)}`]
}

const ROOT_MANIFESTS = [
  "angular.json",
  "app.config.cjs",
  "app.config.js",
  "app.config.json",
  "app.config.mjs",
  "app.config.ts",
  "app.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.mts",
  "next.config.ts",
  "nuxt.config.js",
  "nuxt.config.mjs",
  "nuxt.config.ts",
  "react-router.config.js",
  "react-router.config.mjs",
  "react-router.config.ts",
  "remix.config.js",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.mts",
  "vite.config.ts",
] as const

const rootManifestParts = (input: FingerprintInput): readonly string[] =>
  ROOT_MANIFESTS.flatMap((file) => {
    const absolute = path.join(input.root, file)
    if (isStampedBySourceRoots(input, absolute)) return []
    const text = input.host.readFile(absolute)
    return text === null ? [] : [`rootManifest=${file}:${sha256(text)}`]
  })

const peerIdentity = (peer: PeerResolveResult): string =>
  peer.kind === "missing" ? "missing" : `${peer.from}:${peer.specifier}@${peer.version}`

const templateCompilerParts = (input: FingerprintInput): readonly string[] =>
  applicableFrameworks(input.templateFrameworks ?? TEMPLATE_FRAMEWORK_IDENTITIES, {
    dependencies: readDependencies(input.host, [path.join(input.root, "package.json")]),
    files: [],
  }).map((spec) => `templateCompiler=${spec.id}:${peerIdentity(resolvePeer({ root: input.root, packages: spec.packages }))}`)

/**
 * Hashing only the host's `src/` would serve a stale map after an analyzer upgrade or a config edit.
 * All four inputs below are mandatory: analyzer version, resolved config,
 * the whole tsconfig chain, and every source root.
 */
export const computeGraphFingerprint = (input: FingerprintInput): Fingerprint => {
  const parts: string[] = [`appgraphVersion=${input.appgraphVersion}`, `config=${stableStringify(input.config)}`]

  for (const file of input.tsconfigFiles) {
    const content = input.host.readFile(path.resolve(input.root, file))
    parts.push(`tsconfig=${toPosix(file)}:${content === null ? "missing" : sha256(content)}`)
  }

  for (const sourceRoot of [...input.sourceRoots].sort(byCodepoint)) {
    const stat = statSourceRoot(input.host, input.root, sourceRoot, input.excluded ?? [])
    parts.push(`sourceRoot=${stat.root}:files=${String(stat.files)}:entries=${stat.digest}`)
  }

  parts.push(...dependencyManifestParts(input))
  parts.push(...rootManifestParts(input))
  parts.push(...templateCompilerParts(input))

  return { value: sha256(parts.join("\n")), parts }
}

export const computeRunFingerprint = (graph: Fingerprint, run: unknown): Fingerprint => {
  const own = [`graph=${graph.value}`, `run=${stableStringify(run)}`]
  return { value: sha256(own.join("\n")), parts: [...graph.parts, ...own] }
}

export const ROOT_TSCONFIG = "tsconfig.json"

export const graphTsconfigFiles = (host: FileHost, root: string, recorded: readonly string[]): readonly string[] => {
  const probed = host.isFile(path.join(root, ROOT_TSCONFIG)) && !recorded.includes(ROOT_TSCONFIG)
  return probed ? [...recorded, ROOT_TSCONFIG] : recorded
}

export type GraphOptions = {
  readonly source: string | null
  readonly depth: number | null
  readonly allSources: boolean
  readonly allowEmpty: boolean
}

export const DEFAULT_GRAPH_OPTIONS: GraphOptions = { source: null, depth: null, allSources: false, allowEmpty: false }

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const RUN_CONFIG_KEYS = ["formats", "out", "strict", "allowEmpty"] as const

const isRunConfigKey = (key: string): boolean => RUN_CONFIG_KEYS.some((runKey) => runKey === key)

const configPart = (config: unknown, keep: (key: string) => boolean): Readonly<Record<string, unknown>> =>
  isRecord(config) ? Object.fromEntries(Object.entries(config).filter(([key]) => keep(key))) : {}

export const graphConfigOf = (config: unknown): Readonly<Record<string, unknown>> =>
  configPart(config, (key) => !isRunConfigKey(key))

export const runConfigOf = (config: unknown): Readonly<Record<string, unknown>> => configPart(config, isRunConfigKey)

export type GraphFlags = {
  readonly source?: string
  readonly depth?: number
  readonly allSources: boolean
  readonly allowEmpty?: boolean
}

export const stickyGraphOptions = (flags: GraphFlags, recorded: GraphRecord | null): GraphOptions => ({
  source: flags.source ?? recorded?.options.source ?? null,
  depth: flags.depth ?? recorded?.options.depth ?? null,
  allSources: flags.allSources || (recorded?.options.allSources ?? false),
  allowEmpty: flags.allowEmpty === true || (recorded?.options.allowEmpty ?? false),
})

export type GraphStateInput = {
  readonly host: FileHost
  readonly appgraphVersion: string
  readonly root: string
  readonly outDir: string
  readonly sourceRoots: readonly string[]
  readonly config: unknown
  readonly configFile: string | null
  readonly options: GraphOptions
  readonly tsconfigFiles: readonly string[]
  readonly templateFrameworks?: readonly TemplateFrameworkIdentity[]
}

export type GraphState = {
  readonly fingerprint: Fingerprint
  readonly record: GraphRecord
}

export const graphStateOf = (input: GraphStateInput): GraphState => {
  const fingerprint = computeGraphFingerprint({
    host: input.host,
    appgraphVersion: input.appgraphVersion,
    root: input.root,
    sourceRoots: input.sourceRoots,
    config: { options: input.options, config: graphConfigOf(input.config), configFile: input.configFile },
    tsconfigFiles: graphTsconfigFiles(input.host, input.root, input.tsconfigFiles),
    excluded: [input.outDir],
    ...(input.templateFrameworks === undefined ? {} : { templateFrameworks: input.templateFrameworks }),
  })
  return {
    fingerprint,
    record: {
      fingerprint: fingerprint.value,
      options: input.options,
      tsconfigFiles: input.tsconfigFiles,
      configFile: input.configFile,
    },
  }
}

export type RunRecord = {
  readonly fingerprint: string
  /** The artifact paths, relative to the output dir, that the recorded run wrote. */
  readonly artifacts: readonly string[]
  readonly exitCode: number
  readonly counts: Readonly<Record<string, number>>
}

export type GraphRecord = {
  readonly fingerprint: string
  readonly options: GraphOptions
  readonly tsconfigFiles: readonly string[]
  readonly configFile: string | null
}

export type Sidecar = {
  readonly run: RunRecord | null
  readonly graph: GraphRecord | null
}

export const SIDECAR_SCHEMA_VERSION = 2

export const EMPTY_SIDECAR: Sidecar = { run: null, graph: null }

export const formatSidecar = (sidecar: Sidecar): string =>
  `${JSON.stringify({ schemaVersion: SIDECAR_SCHEMA_VERSION, run: sidecar.run, graph: sidecar.graph })}\n`

const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")

const isCounts = (value: unknown): value is Readonly<Record<string, number>> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === "number")

const parseRun = (value: unknown): RunRecord | null => {
  if (!isRecord(value)) return null
  const { fingerprint, artifacts, exitCode, counts } = value
  if (typeof fingerprint !== "string" || !isStringList(artifacts) || typeof exitCode !== "number" || !isCounts(counts))
    return null
  return { fingerprint, artifacts, exitCode, counts }
}

const parseGraphOptions = (value: unknown): GraphOptions | null => {
  if (!isRecord(value)) return null
  const { source, depth, allSources, allowEmpty = false } = value
  if (source !== null && typeof source !== "string") return null
  if (depth !== null && typeof depth !== "number") return null
  if (typeof allSources !== "boolean") return null
  if (typeof allowEmpty !== "boolean") return null
  return { source, depth, allSources, allowEmpty }
}

const parseGraph = (value: unknown): GraphRecord | null => {
  if (!isRecord(value)) return null
  const { fingerprint, tsconfigFiles, configFile } = value
  const options = parseGraphOptions(value["options"])
  if (typeof fingerprint !== "string" || options === null || !isStringList(tsconfigFiles)) return null
  if (configFile !== null && typeof configFile !== "string") return null
  return { fingerprint, options, tsconfigFiles, configFile }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const parseSidecar = (text: string): Sidecar | null => {
  const parsed = parseJson(text)
  if (!isRecord(parsed) || parsed["schemaVersion"] !== SIDECAR_SCHEMA_VERSION) return null
  return { run: parseRun(parsed["run"]), graph: parseGraph(parsed["graph"]) }
}

export type PreviousFingerprintInput = {
  readonly host: FileHost
  readonly outDir: string
}

export const sidecarPath = (outDir: string): string => path.join(outDir, FINGERPRINT_FILE)

export const readSidecar = (input: PreviousFingerprintInput): Sidecar | null => {
  const text = input.host.readFile(sidecarPath(input.outDir))
  return text === null ? null : parseSidecar(text)
}

export const readGraphRecord = (input: PreviousFingerprintInput): GraphRecord | null => readSidecar(input)?.graph ?? null

export const sidecarWithGraph = (previous: Sidecar | null, graph: GraphRecord): Sidecar => ({
  run: previous?.run ?? null,
  graph,
})

const yamlFallback = (input: PreviousFingerprintInput): RunRecord | null => {
  if (!input.host.isDirectory(input.outDir)) return null

  const names = input.host
    .readDir(input.outDir)
    .filter((entry) => entry.kind === "file" && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort(byCodepoint)

  for (const name of names) {
    const match = FINGERPRINT_IN_YAML.exec(input.host.readFile(path.join(input.outDir, name)) ?? "")
    if (match?.[1] !== undefined) return { fingerprint: match[1], artifacts: [name], exitCode: 0, counts: {} }
  }

  return null
}

/**
 * The sidecar is authoritative whenever it exists — an unreadable one is stale, never a reason to look
 * elsewhere. The YAML scan covers only an output dir written before the sidecar existed.
 */
export const readPreviousRun = (input: PreviousFingerprintInput): RunRecord | null => {
  if (input.host.isFile(sidecarPath(input.outDir))) return readSidecar(input)?.run ?? null
  return yamlFallback(input)
}

export const readPreviousFingerprint = (input: PreviousFingerprintInput): string | null =>
  readPreviousRun(input)?.fingerprint ?? null

export const isStale = (previous: string | null, current: string): boolean =>
  previous === null || previous !== current

export const isGraphFresh = (previous: GraphRecord | null, current: string): boolean =>
  previous !== null && !isStale(previous.fingerprint, current)

export const missingArtifacts = (host: FileHost, outDir: string, artifacts: readonly string[]): readonly string[] =>
  artifacts.filter((artifact) => !host.isFile(path.join(outDir, artifact)))

/** Artifacts rewritten after the sidecar (a later run without --if-stale) no longer belong to the recorded run. */
export const rewrittenArtifacts = (host: FileHost, outDir: string, artifacts: readonly string[]): readonly string[] => {
  const recordedAt = host.mtimeMs(sidecarPath(outDir)) ?? 0
  return artifacts.filter((artifact) => (host.mtimeMs(path.join(outDir, artifact)) ?? 0) > recordedAt)
}

/** Skippable only when the fingerprint matches AND every artifact the recorded run wrote is still there, untouched since. */
export const isUpToDate = (
  host: FileHost,
  outDir: string,
  previous: RunRecord | null,
  current: string,
): boolean =>
  previous !== null &&
  !isStale(previous.fingerprint, current) &&
  previous.artifacts.length > 0 &&
  missingArtifacts(host, outDir, previous.artifacts).length === 0 &&
  rewrittenArtifacts(host, outDir, previous.artifacts).length === 0
