import type ts from "typescript"
import type { Ast, GuardResult } from "../core/ast.js"
import type { FileBindingTable } from "../core/bindings.js"
import type { DeclaredExport } from "../core/resolver.js"
import type { DiagnosticInput } from "../core/diagnostics.js"
import type { NavGroupDraft } from "../core/graph.js"
import type {
  AncestorRef,
  AppGraph,
  Evidence,
  FlatString,
  KindRule,
  NavEntry,
  NodeLocator,
  RedirectRule,
  Screen,
  ScreenDraft as CoreScreenDraft,
  EntryRef as ResolvedEntryRef,
  TsconfigChain,
} from "../core/model.js"
import type { StringTable } from "../core/strings.js"
import type { TemplateTagResolverFn } from "../core/template-doc.js"
import type { TypeScriptApi } from "../core/tsconfig.js"
import type { ResolvedConfig } from "../config/types.js"

/**
 * The INTERNAL adapter interface (§5.0). It carries no `apiVersion`, no stability promise and no
 * export-map entry: every adapter lives in this repository and is type-checked against this file by
 * the build. It is extracted into a published contract at 0.3, from five working adapters (§5.9).
 */

export type TsNode = ts.Node

export type { NavGroupDraft, ResolvedEntryRef }

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/**
 * A reference an adapter hands the kernel for a screen entry. `file` and `opaque` are the two shapes
 * that survive into the emitted model; `module` and `binding` are resolved away in phase 4 and never
 * reach an artifact. An unresolvable ref becomes `opaque` — a VISIBLE hole with a diagnostic, never a
 * silent drop.
 */
export type EntryRef =
  | ResolvedEntryRef
  | {
      readonly kind: "module"
      readonly from: string
      readonly spec: string
      readonly exported?: string
      readonly at?: NodeLocator
    }
  | {
      readonly kind: "binding"
      readonly from: string
      readonly local: string
      readonly at?: NodeLocator
    }

export type OpaqueEntryRef = Extract<ResolvedEntryRef, { kind: "opaque" }>

export type FileEntryRef = Extract<ResolvedEntryRef, { kind: "file" }>

/**
 * `?:` = "no opinion, fall through to the next contributing source"; `: T | null` = "this source
 * asserts absence, stop the fallthrough" (§4.3). `exactOptionalPropertyTypes` makes
 * `{ title: undefined }` a compile error, so build drafts with conditional spread.
 */
export type ScreenDraft = Omit<CoreScreenDraft, "entries"> & {
  readonly entries: readonly EntryRef[]
}

export type NavEntryDraft = Omit<NavEntry, "resolvedScreen">

export type ScreenContributionDraft = {
  readonly source: string
  readonly draft: ScreenDraft
}

/** Everything one adapter produced in phase 2. */
export type AdapterResult = {
  readonly adapter: string
  readonly screens: readonly ScreenContributionDraft[]
  readonly navGroups: readonly NavGroupDraft[]
}

/**
 * The screen as it exists between phase 3 and phase 5: identity minted, activations canonical, tree
 * not yet built. It is what `ancestorsOf` and `resolveEntries` are handed.
 */
export type ScreenShape = Pick<
  Screen,
  | "id"
  | "localId"
  | "source"
  | "activations"
  | "url"
  | "params"
  | "title"
  | "kindTag"
  | "ancestors"
  | "shell"
  | "auth"
  | "featureFlag"
  | "redirectTo"
  | "devOnly"
  | "addressable"
  | "provenance"
  | "routeName"
> & {
  readonly entries: readonly EntryRef[]
}

// ---------------------------------------------------------------------------
// Contexts (§5.6). `typescript` is INJECTED as `ctx.ts`; no adapter imports it for its value.
// ---------------------------------------------------------------------------

export type ProjectContext = {
  readonly ts: TypeScriptApi
  /** Absolute; for path math only. Never emitted — `meta.root` is a label (§11 rule 5). */
  readonly root: string
  readonly rootLabel: string
  /** Project-relative POSIX. */
  readonly sourceRoots: readonly string[]
  readonly dependencies: ReadonlySet<string>
  readonly hasDependency: (name: string | RegExp) => boolean
  readonly tsconfig: TsconfigChain
  /** Project-relative POSIX, codepoint-sorted, exclusion list already applied (§10.7, §11 rule 2). */
  readonly glob: (pattern: string) => readonly string[]
  readonly readFile: (relPath: string) => string | null
  readonly exists: (relPath: string) => boolean
  readonly isGenerated: (relPath: string) => boolean
}

export type ConfigureContext = ProjectContext & {
  readonly config: ResolvedConfig
  readonly addKindRule: (rule: KindRule) => void
  readonly diagnostic: (input: DiagnosticInput) => void
}

export type LocalIdOptions = {
  /** 0-based ordinal of the guarded branch, in `node.pos` order. Omit for a whole-file screen. */
  readonly ordinal?: number
  /** The branch node; its `// @appgraph-id <name>` pragma overrides the ordinal (§4.1). */
  readonly node?: TsNode
}

export type DiscoverContext = ProjectContext & {
  /**
   * Every `asX` narrower here is `unwrap`-baked (§6.2): `(X)`, `X as const`, `X satisfies T`, `X!`
   * and `{X}` all narrow identically. Never type-test a raw node with `ctx.ts.isX`.
   */
  readonly ast: Ast
  readonly unwrap: (node: TsNode) => TsNode
  readonly sourceFile: (relPath: string) => ts.SourceFile | null
  readonly resolveModule: (fromRel: string, spec: string) => string | null
  readonly declarationFile: (relPath: string, exportName: string) => string
  readonly declaredExport: (relPath: string, exportName: string) => DeclaredExport
  readonly bindingsFor: (relPath: string) => FileBindingTable
  readonly strings: StringTable
  readonly locate: (relPath: string, at: NodeLocator) => TsNode | null
  readonly locatorOf: (node: TsNode) => NodeLocator
  readonly flattenString: (node: TsNode | undefined, relPath: string) => FlatString | null
  readonly guardOf: (node: TsNode, stopAt?: TsNode) => GuardResult
  readonly normalizeUrl: (raw: string) => string
  readonly lineOf: (relPath: string, node: TsNode) => number
  /** Structural identity (§4.1). NEVER derive a localId from expression text. */
  readonly localId: (relPath: string, options?: LocalIdOptions) => string
  readonly evidence: (what: string, relPath: string, node?: TsNode) => Evidence
  /** A file a glob matched but a content probe rejected; printed in the zero-screen trace (§10.2). */
  readonly nearMiss: (relPath: string, probe: string) => void
  readonly diagnostic: (input: DiagnosticInput) => void
}

export type EntryContext = DiscoverContext & {
  readonly screen: ScreenShape
  /** Mint a visible hole. The kernel emits `screens/opaque-entry` for every one of these. */
  readonly opaque: (expr: string, relPath: string, line: number) => OpaqueEntryRef
}

export type EmitContext = {
  readonly format: string
  /** `null` under `--no-timestamp`. The only legitimate clock in the package (§5.5). */
  readonly timestamp: string | null
  readonly options: Readonly<Record<string, unknown>>
  readonly asset: (name: string) => string
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type DetectResult = {
  /** 0..100. 0 means "not this stack". >= 50 is a live source (§10.1). */
  readonly score: number
  readonly evidence: readonly Evidence[]
}

export type ScreenSource = {
  readonly name: string
  readonly detect: (ctx: ProjectContext) => DetectResult
  readonly discover: (ctx: DiscoverContext) => readonly ScreenDraft[]
  /**
   * Runs BEFORE core entry resolution, on one screen's whole ref list. Return the list with the refs
   * this source can resolve rewritten to `file` (AdminJS `componentLoader` keys); leave the rest
   * untouched and the core resolver handles them.
   */
  readonly resolveEntries?: (refs: readonly EntryRef[], ctx: EntryContext) => readonly EntryRef[]
  /**
   * The wrapper chain for one screen, OUTERMOST FIRST. Runs in phase 4, so it may consult resolved
   * entry files. A source that knows the chain at discovery time puts it on the draft instead.
   * An adapter NEVER builds a tree; it names files and splice modes (§5.2, §6.3.1).
   */
  readonly ancestorsOf?: (screen: ScreenShape, ctx: EntryContext) => readonly AncestorRef[]
}

export type NavSource = {
  readonly name: string
  /** `resolvedScreen` is filled by the kernel in phase 7. A nav source never resolves screens (§9.1). */
  readonly discover: (ctx: DiscoverContext) => readonly NavGroupDraft[]
}

/**
 * An always-run source of redirect rules found in the analysed code (`next.config`'s `redirects()`). It
 * runs whatever the live screen source is; a rule it cannot read is counted in a diagnostic, never guessed.
 */
export type RedirectSource = {
  readonly name: string
  readonly discover: (ctx: DiscoverContext) => readonly RedirectRule[]
}

export type EmitFile = {
  /** Relative to the output dir; `..` is rejected by the kernel. */
  readonly path: string
  readonly content: string
}

/** Pure: no `fs`, no `path.resolve`, no clock. The kernel does all I/O (§5.5). */
export type Emitter = {
  readonly name: string
  readonly emit: (graph: AppGraph, ctx: EmitContext) => readonly EmitFile[]
}

export type AmbientComponent = {
  readonly name: string
  readonly file: string
}

export type Adapter = {
  readonly name: string
  readonly screens?: readonly ScreenSource[]
  readonly nav?: readonly NavSource[]
  readonly redirects?: readonly RedirectSource[]
  readonly emitters?: readonly Emitter[]
  readonly kindRules?: readonly KindRule[]
  readonly configure?: (ctx: ConfigureContext) => void
  readonly ambientComponents?: (ctx: DiscoverContext) => readonly AmbientComponent[]
  readonly templateTagResolver?: (ctx: DiscoverContext) => TemplateTagResolverFn | null
}

export const isFileEntry = (ref: EntryRef): ref is FileEntryRef => ref.kind === "file"

export const isOpaqueEntry = (ref: EntryRef): ref is OpaqueEntryRef => ref.kind === "opaque"

export const isResolvedEntry = (ref: EntryRef): ref is ResolvedEntryRef =>
  ref.kind === "file" || ref.kind === "opaque"
