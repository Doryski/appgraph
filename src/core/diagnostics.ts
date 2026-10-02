import type { Diagnostic, ScreenId, Severity } from "./model.js"
import { byCodepoint, byNumber, thenBy } from "./order.js"

/**
 * Every diagnostic code the package can emit — and nothing else.
 *
 * This list is checked, not decorative. `test/core/diagnostic-codes.test.ts` extracts the codes at the
 * emit sites in `src/**` and asserts set-equality with this array in both directions, so a code that is
 * declared here and never emitted is a test failure, as is a code emitted without being declared here.
 */
export const DIAGNOSTIC_CODES = [
  "analysis/no-screens",
  "analysis/refused",
  "cache/not-emitted",
  "cli/command-unavailable",
  "cli/compiler-unsupported",
  "cli/failure",
  "cli/root-not-found",
  "cli/write-failed",
  "confidence/empty-section",
  "confidence/sparse-section",
  "config/dialect-overrides-preset",
  "config/invalid-field",
  "config/load-failed",
  "config/missing-file",
  "config/no-default-export",
  "config/not-found",
  "config/unknown-extractor",
  "config/unknown-field",
  "config/unreadable",
  "config/unresolvable-import",
  "emit/unknown-format",
  "emit/unknown-screen",
  "emit/unwritable-output",
  "facts/ambiguous-component-name",
  "facts/convex-unknown-function",
  "facts/masked",
  "facts/needs-typechecker",
  "facts/unsupported-template",
  "nav/candidate-rejected",
  "nav/config-empty",
  "nav/config-unreadable",
  "nav/dead-link",
  "nav/redirect-unreadable",
  "plugin/duplicate-name",
  "plugin/missing-requirement",
  "plugin/threw",
  "project/angularjs-hybrid",
  "project/expo-config-dynamic",
  "project/multiple-screen-sources",
  "project/no-screen-source",
  "project/no-tsconfig",
  "project/nuxt-layer-skipped",
  "project/template-compiler-missing",
  "project/template-compiler-unsupported",
  "project/tsconfig-error",
  "project/unresolved-import",
  "screens/ambiguous-route-name",
  "screens/conflict-dropped",
  "screens/duplicate-id",
  "screens/dynamic-registry",
  "screens/entry-from-unresolved",
  "screens/merged",
  "screens/no-entry-component",
  "screens/opaque-entry",
  "screens/orphan",
  "screens/orphan-platform-variant",
  "screens/path-table-unreadable",
  "screens/route-conflict",
  "screens/route-module-missing",
  "screens/route-parent-mismatch",
  "screens/shared-route",
  "screens/stale-route-literal",
  "screens/unmatched-layout-screen",
  "screens/unmounted-route",
  "screens/unresolvable-locator",
  "screens/unresolvable-script",
  "screens/unsupported-next-convention",
  "screens/unsupported-router-style",
  "stores/name-fallback",
  "usage/invalid-combination",
  "usage/unknown-command",
  "usage/unknown-field",
  "usage/unknown-group",
  "usage/unknown-kind",
  "usage/unknown-section",
  "usage/unknown-source",
  "usage/unknown-term",
  "walk/ambiguous-splice",
  "walk/no-splice-point",
] as const

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number] | (string & {})

export type DiagnosticInput = {
  readonly severity: Severity
  readonly code: DiagnosticCode
  readonly message: string
  readonly file?: string
  readonly line?: number
  readonly screenId?: ScreenId
}

export type DiagnosticSink = {
  readonly report: (input: DiagnosticInput) => void
  readonly error: (code: DiagnosticCode, message: string, where?: DiagnosticWhere) => void
  readonly warning: (code: DiagnosticCode, message: string, where?: DiagnosticWhere) => void
  readonly info: (code: DiagnosticCode, message: string, where?: DiagnosticWhere) => void
}

export type DiagnosticWhere = {
  readonly file?: string
  readonly line?: number
  readonly screenId?: ScreenId
}

export type DiagnosticCollector = DiagnosticSink & {
  readonly forPlugin: (plugin: string) => DiagnosticSink
  readonly all: () => readonly Diagnostic[]
  readonly count: (severity: Severity) => number
  readonly hasErrors: () => boolean
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
}

export const compareDiagnostics = thenBy<Diagnostic>(
  (a, b) => byNumber(SEVERITY_RANK[a.severity], SEVERITY_RANK[b.severity]),
  (a, b) => byCodepoint(a.code, b.code),
  (a, b) => byCodepoint(a.file ?? "", b.file ?? ""),
  (a, b) => byNumber(a.line ?? 0, b.line ?? 0),
  (a, b) => byCodepoint(a.plugin ?? "", b.plugin ?? ""),
  (a, b) => byCodepoint(a.screenId ?? "", b.screenId ?? ""),
  (a, b) => byCodepoint(a.message, b.message),
)

export const sortDiagnostics = (diagnostics: Iterable<Diagnostic>): Diagnostic[] =>
  [...diagnostics].sort(compareDiagnostics)

const toDiagnostic = (input: DiagnosticInput, plugin: string | null): Diagnostic => ({
  severity: input.severity,
  code: input.code,
  message: input.message,
  plugin,
  ...(input.file !== undefined ? { file: input.file } : {}),
  ...(input.line !== undefined ? { line: input.line } : {}),
  ...(input.screenId !== undefined ? { screenId: input.screenId } : {}),
})

const sinkFor = (push: (input: DiagnosticInput) => void): DiagnosticSink => {
  const at = (severity: Severity) => (code: DiagnosticCode, message: string, where?: DiagnosticWhere) =>
    push({
      severity,
      code,
      message,
      ...(where?.file !== undefined ? { file: where.file } : {}),
      ...(where?.line !== undefined ? { line: where.line } : {}),
      ...(where?.screenId !== undefined ? { screenId: where.screenId } : {}),
    })

  return {
    report: push,
    error: at("error"),
    warning: at("warning"),
    info: at("info"),
  }
}

export const createDiagnosticCollector = (): DiagnosticCollector => {
  const collected: Diagnostic[] = []

  const pushFor = (plugin: string | null) => (input: DiagnosticInput) => {
    collected.push(toDiagnostic(input, plugin))
  }

  const kernel = sinkFor(pushFor(null))

  return {
    ...kernel,
    forPlugin: (plugin: string) => sinkFor(pushFor(plugin)),
    all: () => sortDiagnostics(collected),
    count: (severity: Severity) => collected.filter((entry) => entry.severity === severity).length,
    hasErrors: () => collected.some((entry) => entry.severity === "error"),
  }
}
