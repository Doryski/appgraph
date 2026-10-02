import type ts from "typescript"
import type { DiagnosticCode } from "../diagnostics.js"
import type { AncestorRef, FileFacts, Severity, SlotBranch, SpliceMode, TreeNode } from "../model.js"

export type SpliceCandidate = {
  readonly node?: ts.Node
  readonly pos: number
  readonly line: number
}

export type SpliceHost = {
  readonly file: string
  readonly candidates: readonly SpliceCandidate[]
}

/**
 * The component element that encloses a splice point as its children, matched to a node the host renders.
 * `splices: false` = its own declaration never renders `children`, so the next level does not land in it.
 */
export type SpliceWrapper = {
  readonly file: string
  readonly component: string
  readonly splices: boolean
}

/** A splice candidate and where it puts the next level: inside `wrapper`, or directly under the host. */
export type Placement = {
  readonly candidate: SpliceCandidate
  readonly wrapper: SpliceWrapper | null
}

/**
 * Where the next level goes: inside `wrapper` only when every splice candidate agrees on it; otherwise
 * directly under the host, with `ambiguous` set so the screen says its placement is uncertain.
 */
export type PlacementDecision = {
  readonly wrapper: SpliceWrapper | null
  readonly ambiguous: boolean
}

/**
 * An ancestor that splices, the root its node is built from (the whole file, or its own export when
 * the file declares several route components), the file whose node receives the next level (itself, or
 * an `<Outlet/>` host) and, when the splice point sits inside a component element, the file of the
 * host's child node that receives it instead.
 */
export type ChainLink = {
  readonly ancestor: AncestorRef
  readonly root: ResolvedRoot
  readonly host: string
  readonly wrapper?: string
  readonly branches?: readonly ResolvedBranch[]
  /**
   * Files this ancestor's route list renders on the way to the screens it mounts. They are not its own
   * children here: this screen's branch is spliced in at the host, and its sibling pages do not render.
   */
  readonly mountedFiles?: ReadonlySet<string>
}

/** A subtree to splice and the host child it goes inside, if any. */
export type Placed = {
  readonly node: TreeNode
  readonly wrapper?: string
}

export const wrapperOf = (item: { readonly wrapper?: string }) =>
  item.wrapper === undefined ? {} : { wrapper: item.wrapper }

export type KeptBranch = {
  readonly branch: SlotBranch
  readonly wrapper?: string
  readonly ambiguous?: true
}

export type ResolvedBranch = KeptBranch & {
  readonly root: ResolvedRoot
}

export type SpliceProblem = {
  readonly severity: Extract<Severity, "error" | "warning">
  readonly code: DiagnosticCode
  readonly message: string
  readonly line?: number
}

/** `link: null` = transparent. */
export type SpliceVerdict = {
  readonly link: ChainLink | null
  readonly problem: SpliceProblem | null
  readonly ambiguous: boolean
}

/** `kept: false` = the layout renders no splice point for the slot; the branch is dropped. */
export type BranchVerdict = {
  readonly kept: boolean
  readonly problem: SpliceProblem | null
  readonly ambiguous: boolean
  readonly wrapper?: string
}

export type ResolvedRoot = {
  readonly file: string
  readonly expandKey: string
  readonly label: string | null
  readonly facts: FileFacts | null
}

export const wholeFileRoot = (file: string): ResolvedRoot => ({
  file,
  expandKey: file,
  label: null,
  facts: null,
})

export type SplicePoint = {
  readonly pos: number
  readonly line: number
}

export type SpliceRef = {
  readonly file: string
  readonly exportName: string | null
  readonly splice: SpliceMode
}
