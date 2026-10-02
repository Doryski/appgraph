import type ts from "typescript"
import type { Ast } from "../ast.js"
import type { DiagnosticCollector } from "../diagnostics.js"
import type {
  FileFacts,
  KindRule,
  NavEntry,
  NodeLocator,
  RedirectRule,
  ScreenDraft,
  SectionConfidence,
} from "../model.js"
import type { SplicePoint, SpliceRef } from "./model.js"

export type ConflictPolicy = "merge" | "first" | "error"

export type ImportedBinding = {
  readonly imported: string
}

export type ScreenContribution = {
  readonly source: string
  readonly draft: ScreenDraft
}

export type NavGroupDraft = {
  readonly name: string
  readonly source: string
  /**
   * An auto-discovered CANDIDATE (§10.6), kept only if its resolution score clears
   * `NAV_CANDIDATE_MIN_SCORE`. A nav source may not resolve screens (§9.1), so the score it is judged on
   * can only be computed here — which is also why a rejected candidate contributes no dead links: an
   * array that resolves to nothing is not a menu whose links are broken, it is not a menu.
   */
  readonly auto?: true
  readonly entries: readonly Omit<NavEntry, "resolvedScreen">[]
}

export type GraphProviders = {
  readonly ast: Ast
  /** Whole-file facts, keyed by project-relative POSIX path. Must be total. */
  readonly facts: (file: string) => FileFacts
  /** Parsed source for a project-relative path. Absent = splice points are trusted, not verified. */
  readonly sourceOf?: (file: string) => ts.SourceFile | null
  readonly spliceCandidatesOf?: (ref: SpliceRef) => readonly SplicePoint[] | null
  /** Non-render facts scoped to a sub-file root's subtree (§6.3.2). */
  readonly subtreeFacts?: (file: string, locator: NodeLocator) => FileFacts | null
  /** The files the templates an export of `file` owns render, project-relative. */
  readonly templateTargetsOf?: (file: string, exportName: string) => readonly string[] | null
  /** The file a JSX component tag used in `file` resolves to, project-relative. */
  readonly declaringFileOf?: (file: string, tag: string) => string | null
  /** The imported name a local binding in `file` was imported under (alias resolution). */
  readonly importedNameOf?: (file: string, local: string) => ImportedBinding | null
  /** Files imported by `file`, project-relative. Feeds nav-group shell attachment (§7.10). */
  readonly importsOf?: (file: string) => readonly string[]
}

export type GraphMetaInput = {
  readonly appgraphVersion: string
  readonly root: string
  /** Omitted = the caller could not determine a name; `meta.appName` is then null. */
  readonly appName?: string | null
  readonly sourceRoots: readonly string[]
  readonly screenSources: readonly string[]
  readonly fingerprint: string
  readonly confidence?: readonly SectionConfidence[]
  readonly limitations?: readonly string[]
  readonly emptyResult?: true
  readonly emptyReason?: string
}

export type BuildGraphInput = {
  readonly providers: GraphProviders
  readonly contributions: readonly ScreenContribution[]
  readonly navGroups?: readonly NavGroupDraft[]
  readonly maxDepth?: number
  readonly conflicts?: ConflictPolicy
  /**
   * Optional. When supplied, `uses` edges are additionally gated by `KindRule.traversable`. Left
   * undefined the walk trusts the extractor, which already applied the same rules (§6.4) — gating
   * with a *different* rule set silently collapses reachability to render edges, so the gate is opt-in rather than on by default.
   */
  readonly kindRules?: readonly KindRule[]
  /**
   * Redirect rules in Next.js syntax. A navigation or menu target that matches no screen follows the
   * first matching eligible rule (at most `MAX_REDIRECT_HOPS`); every rule is listed in `redirects`.
   */
  readonly redirectRules?: readonly RedirectRule[]
  readonly diagnostics?: DiagnosticCollector
  readonly meta: GraphMetaInput
}
