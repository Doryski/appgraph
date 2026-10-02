import type { Diagnostic, NavGroup, SectionConfidence, Severity, TsconfigChain } from "../core/model.js"
import { by, byCodepoint, thenBy } from "../core/order.js"
import type { SourceDetection } from "../config/types.js"
import type { GlobAttempt, NearMiss } from "../pipeline/context.js"
import type { TemplateCompilerStatus } from "../core/template-frameworks.js"
import type { Exclusion } from "../core/project.js"
import type { NestedPackage } from "../detect/index.js"

export type Writer = {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

export const createConsoleWriter = (): Writer => ({
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
})

export type WrittenFile = {
  readonly path: string
  readonly bytes: number
}

const SEVERITY_ORDER: readonly Severity[] = ["error", "warning", "info"]

const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  error: "errors",
  warning: "warnings",
  info: "info",
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

const escapeControl = (char: string): string => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`

/** Repo-controlled text reaches the terminal here: every C0 (bar `\n` and `\t`), DEL and C1 char is escaped. */
export const sanitizeForTerminal = (text: string): string => text.replace(CONTROL_CHARS, escapeControl)

const at = (diagnostic: Diagnostic): string => {
  if (diagnostic.file === undefined) return ""
  const line = diagnostic.line === undefined ? "" : `:${String(diagnostic.line)}`
  return `  ${sanitizeForTerminal(diagnostic.file)}${line}`
}

export const formatDiagnostic = (diagnostic: Diagnostic): string =>
  `    ${sanitizeForTerminal(diagnostic.code)}  ${sanitizeForTerminal(diagnostic.message)}${at(diagnostic)}`

export type DiagnosticPrintOptions = {
  /** `--quiet`: everything but `error` is dropped. */
  readonly quiet: boolean
}

export const formatDiagnostics = (
  diagnostics: readonly Diagnostic[],
  options: DiagnosticPrintOptions,
): readonly string[] => {
  const severities = options.quiet ? (["error"] as const) : SEVERITY_ORDER
  const lines: string[] = []

  for (const severity of severities) {
    const group = diagnostics
      .filter((diagnostic) => diagnostic.severity === severity)
      .sort(thenBy(by((diagnostic: Diagnostic) => diagnostic.code), by((diagnostic: Diagnostic) => diagnostic.message)))
    if (group.length === 0) continue

    lines.push(`  ${SEVERITY_LABEL[severity]} (${String(group.length)}):`)
    for (const diagnostic of group) lines.push(formatDiagnostic(diagnostic))
  }

  return lines
}

export const countBySeverity = (diagnostics: readonly Diagnostic[], severity: Severity): number =>
  diagnostics.filter((diagnostic) => diagnostic.severity === severity).length

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`

export const formatWritten = (files: readonly WrittenFile[], outLabel: string): readonly string[] => {
  if (files.length === 0) return [`  wrote nothing to ${outLabel}`]

  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  return [
    `  wrote ${String(files.length)} file(s) to ${outLabel}:`,
    ...files.map((file) => `    ${file.path}  ${String(file.bytes)} B  (${kb(file.bytes)})`),
    `  total ${String(total)} B (${kb(total)})`,
  ]
}

export type SummaryInput = {
  readonly root: string
  readonly formats: readonly string[]
  readonly counts: Readonly<Record<string, number>>
}

export const formatSummary = (input: SummaryInput): readonly string[] => {
  const counts = Object.entries(input.counts)
    .sort(([a], [b]) => byCodepoint(a, b))
    .map(([key, value]) => `${key}=${String(value)}`)
  return [
    `appgraph ${input.root}  formats: ${input.formats.join(", ")}`,
    ...(counts.length === 0 ? [] : [`  ${counts.join("  ")}`]),
  ]
}

export type DoctorReport = {
  readonly appgraphVersion: string
  readonly root: string
  readonly rootReason: string
  readonly cwd: string
  readonly configFile: string | null
  readonly sourceRoots: readonly string[]
  readonly tsconfig: TsconfigChain | null
  readonly templateCompilers: readonly TemplateCompilerStatus[]
  readonly screenSources: readonly string[]
  /** Every source the registry ran, whether or not it produced a screen. */
  readonly sourcesRun: readonly string[]
  /** §10.4: the per-source detect() scores WITH evidence, on every run — not only the empty one. */
  readonly detections: readonly SourceDetection[]
  readonly globs: readonly GlobAttempt[]
  readonly nearMisses: readonly NearMiss[]
  readonly exclusions: readonly Exclusion[]
  readonly nestedPackages: readonly NestedPackage[]
  readonly counts: Readonly<Record<string, number>>
  readonly confidence: readonly SectionConfidence[]
  readonly navGroups: readonly NavGroup[]
  readonly testIdAttributes: readonly { readonly attribute: string; readonly count: number }[]
  readonly limitations: readonly string[]
  readonly diagnostics: readonly Diagnostic[]
  readonly trace: string
  readonly fingerprint: string | null
  readonly fingerprintParts: readonly string[]
  readonly failure: string | null
  readonly notes: readonly string[]
}

const formatDetections = (detections: readonly SourceDetection[]): readonly string[] =>
  [...detections]
    .sort(by((entry: SourceDetection) => entry.source))
    .flatMap((entry) => [
      `  ${entry.source}  score ${String(entry.score)}  ${entry.live ? "live" : entry.score > 0 ? "near-miss" : "no"}`,
      ...entry.evidence.map((evidence) => `    ${evidence.file}:${String(evidence.line)}  ${evidence.what}`),
    ])

const formatExclusion = (exclusion: Exclusion): string =>
  `  ${exclusion.pattern}  (${exclusion.reason}${exclusion.source === undefined ? "" : `: ${exclusion.source}`})`

const formatNestedPackage = (nested: NestedPackage): string =>
  `  ${nested.dir}/  run appgraph --root ${nested.dir} to map it  (evidence for: ${nested.sources.join(", ")})`

const section = (title: string, body: readonly string[]): readonly string[] => [
  "",
  title,
  ...(body.length === 0 ? ["  (none)"] : body),
]

const formatTsconfig = (chain: TsconfigChain | null): readonly string[] => {
  if (chain === null) return []
  const paths = Object.entries(chain.paths)
    .sort(([a], [b]) => byCodepoint(a, b))
    .map(([key, targets]) => `    ${key} -> ${targets.join(", ")}`)

  return [
    ...chain.files.map((file, index) => `  ${String(index + 1)}. ${file}`),
    `  baseUrl:          ${chain.baseUrl ?? "(none)"}`,
    `  moduleResolution: ${chain.moduleResolution ?? "(none)"}`,
    `  jsx:              ${chain.jsx ?? "(none)"}`,
    `  include:          ${chain.include.length === 0 ? "(none)" : chain.include.join(", ")}`,
    "  paths:",
    ...(paths.length === 0 ? ["    (none)"] : paths),
  ]
}

const TEMPLATE_COMPILER_ORIGIN = { project: "project", appgraph: "appgraph fallback" } as const

const describeTemplateCompiler = (compiler: TemplateCompilerStatus): string => {
  const version = compiler.version ?? "unknown"
  if (compiler.status === "missing") return "missing — template facts skipped"
  if (compiler.status === "unsupported") return `unsupported ${version}`
  return compiler.from === null ? version : `${version} (${TEMPLATE_COMPILER_ORIGIN[compiler.from]})`
}

const formatTemplateCompilers = (compilers: readonly TemplateCompilerStatus[]): readonly string[] =>
  compilers.map((compiler) => `  ${compiler.framework} compiler: ${describeTemplateCompiler(compiler)}`)

export const formatDoctor = (report: DoctorReport): readonly string[] => [
  `appgraph doctor — v${report.appgraphVersion}`,
  "",
  "resolution",
  `  cwd:          ${report.cwd}`,
  `  root:         ${report.root}  (${report.rootReason})`,
  `  config file:  ${report.configFile ?? "(none found)"}`,
  `  source roots: ${report.sourceRoots.length === 0 ? "(none)" : report.sourceRoots.join(", ")}`,
  ...formatTemplateCompilers(report.templateCompilers),
  ...section("tsconfig chain", formatTsconfig(report.tsconfig)),
  ...section(
    "screen sources that ran",
    report.sourcesRun.length === 0
      ? report.screenSources.map((name) => `  ${name}`)
      : report.sourcesRun.map((name) => `  ${name}`),
  ),
  ...section("screen sources that produced screens", report.screenSources.map((name) => `  ${name}`)),
  ...section("detection (score, live, evidence)", formatDetections(report.detections)),
  ...section("excluded from discovery (pattern, reason)", report.exclusions.map(formatExclusion)),
  ...section("nested packages (not scored for this root)", report.nestedPackages.map(formatNestedPackage)),
  ...section(
    "globs attempted",
    report.globs.map((attempt) => `  ${attempt.pattern} -> ${String(attempt.matches)} match(es)`),
  ),
  ...section(
    "near-miss files (matched a glob, failed a content probe)",
    report.nearMisses.map((miss) => `  ${sanitizeForTerminal(miss.file)}  (probe: ${sanitizeForTerminal(miss.probe)})`),
  ),
  ...section(
    "counts",
    Object.entries(report.counts)
      .sort(([a], [b]) => byCodepoint(a, b))
      .map(([key, value]) => `  ${key}: ${String(value)}`),
  ),
  ...section(
    "section confidence (channel, facts, enabling dependency)",
    [...report.confidence]
      .sort(by((entry: SectionConfidence) => entry.section))
      .map(
        (entry) =>
          `  ${entry.section}  count=${String(entry.count)}  level=${entry.level}  dep=${entry.enablingDependency ?? "(none)"}  installed=${String(entry.dependencyInstalled)}`,
      ),
  ),
  ...section(
    "nav candidates (score, entries, resolved)",
    [...report.navGroups]
      .sort(thenBy(by((group: NavGroup) => group.source), by((group: NavGroup) => group.name)))
      .map(
        (group) =>
          `  ${group.source}#${group.name}  score=${group.score.toFixed(2)}  entries=${String(group.entries.length)}  resolved=${String(group.entries.filter((entry) => entry.resolvedScreen !== null).length)}`,
      ),
  ),
  ...section(
    "test-id attribute histogram",
    report.testIdAttributes.map((entry) => `  ${entry.attribute}: ${String(entry.count)}`),
  ),
  ...section(
    "limitations",
    report.limitations.map((line) => `  ${line}`),
  ),
  ...section("diagnostics", formatDiagnostics(report.diagnostics, { quiet: false })),
  ...section(
    "staleness fingerprint",
    report.fingerprint === null
      ? []
      : [`  ${report.fingerprint}`, ...report.fingerprintParts.map((part) => `    ${part}`)],
  ),
  ...(report.trace === "" ? [] : ["", "zero-screen trace", ...report.trace.split("\n").map((line) => `  ${sanitizeForTerminal(line)}`)]),
  ...(report.failure === null ? [] : ["", "analysis failed", `  ${sanitizeForTerminal(report.failure)}`]),
  ...section(
    "notes",
    report.notes.map((line) => `  ${line}`),
  ),
]
