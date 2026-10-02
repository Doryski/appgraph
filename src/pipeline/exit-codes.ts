import type { Diagnostic, Severity } from "../core/model.js"

export const EXIT_OK = 0
export const EXIT_DIAGNOSTIC_ERROR = 1
export const EXIT_USAGE = 2
export const EXIT_NO_SCREENS = 3
export const EXIT_STRICT_WARNING = 4
export const EXIT_FAILURE = 5
export const EXIT_CACHE_UNAVAILABLE = 6

export const EXIT_CODE_DESCRIPTIONS = {
  [EXIT_OK]: "success: a clean run, or the query was answered",
  [EXIT_DIAGNOSTIC_ERROR]: "at least one 'error' diagnostic, or a refusal to choose between live screen sources",
  [EXIT_USAGE]: "usage error (unknown command or flag, bad value, unknown screen)",
  [EXIT_NO_SCREENS]: "no screens found — the full detection trace is printed",
  [EXIT_STRICT_WARNING]: "--strict and at least one 'warning' diagnostic",
  [EXIT_FAILURE]: "the run itself failed (unsupported compiler, config load, unwritable output dir)",
  [EXIT_CACHE_UNAVAILABLE]: "--cached and the graph cache is missing, stale, incompatible or corrupt",
} as const

export type ExitCode = keyof typeof EXIT_CODE_DESCRIPTIONS

export const EXIT_CODES = [
  EXIT_OK,
  EXIT_DIAGNOSTIC_ERROR,
  EXIT_USAGE,
  EXIT_NO_SCREENS,
  EXIT_STRICT_WARNING,
  EXIT_FAILURE,
  EXIT_CACHE_UNAVAILABLE,
] as const satisfies readonly ExitCode[]

export const EXIT_PRECEDENCE = [
  EXIT_USAGE,
  EXIT_CACHE_UNAVAILABLE,
  EXIT_FAILURE,
  EXIT_NO_SCREENS,
  EXIT_DIAGNOSTIC_ERROR,
  EXIT_STRICT_WARNING,
] as const satisfies readonly ExitCode[]

export const UNKNOWN_SCREEN_CODE = "emit/unknown-screen"

/** Error diagnostics that mean the caller asked for something impossible, not that the project is broken. */
export const USAGE_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([UNKNOWN_SCREEN_CODE])

export type ExitInput = {
  readonly refused: boolean
  readonly emptyResult: boolean
  readonly diagnostics: readonly Diagnostic[]
}

const hasSeverity = (diagnostics: readonly Diagnostic[], severity: Severity): boolean =>
  diagnostics.some((entry) => entry.severity === severity)

const hasUsageError = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((entry) => entry.severity === "error" && USAGE_DIAGNOSTIC_CODES.has(entry.code))

/**
 * The ONE mapping from a run to its exit code, shared by `analyze().exitCode` and the CLI. Precedence:
 * usage > refusal > no screens > error diagnostic > strict warning > ok.
 */
export const exitCodeFor = (result: ExitInput, strict: boolean): number => {
  if (hasUsageError(result.diagnostics)) return EXIT_USAGE
  if (result.refused) return EXIT_DIAGNOSTIC_ERROR
  if (result.emptyResult) return EXIT_NO_SCREENS
  if (hasSeverity(result.diagnostics, "error")) return EXIT_DIAGNOSTIC_ERROR
  if (strict && hasSeverity(result.diagnostics, "warning")) return EXIT_STRICT_WARNING
  return EXIT_OK
}
