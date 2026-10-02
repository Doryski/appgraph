import type { DiagnosticCollector } from "../diagnostics.js"
import type { AncestorRef, ScreenId, SlotBranch } from "../model.js"
import { sortBy, sortStrings, sortedUnique } from "../order.js"
import type { BranchVerdict, ChainLink, KeptBranch, SpliceProblem, SpliceVerdict } from "./model.js"
import { wrapperOf } from "./model.js"
import type { createSpliceJudge } from "./splice.js"
import { describeSplice } from "./splice-scan.js"

export const createChainPlanner = (
  diagnostics: DiagnosticCollector,
  { judgeAncestor, judgeBranch }: ReturnType<typeof createSpliceJudge>,
) => {
  const ancestorKey = (ancestor: AncestorRef): string =>
    `${ancestor.file}|${ancestor.exportName}|${ancestor.role}|${describeSplice(ancestor)}`

  const describeBranchSplice = (branch: SlotBranch): string =>
    branch.splice.kind === "slot" ? `slot:${branch.splice.name}` : describeSplice(branch)

  const branchKey = (ancestor: AncestorRef, branch: SlotBranch): string =>
    `${ancestor.file}|${describeBranchSplice(branch)}|${branch.file}`

  const branchOrder = (branch: SlotBranch): string =>
    `${branch.splice.kind === "slot" ? branch.splice.name : ""}\u0000${branch.file}`

  const verdicts = new Map<string, { readonly ancestor: AncestorRef; readonly verdict: SpliceVerdict }>()
  const branchVerdicts = new Map<string, { readonly ancestor: AncestorRef; readonly verdict: BranchVerdict }>()
  const affectedScreens = new Map<string, ScreenId[]>()

  const noteAffected = (key: string, problem: SpliceProblem | null, screenId: ScreenId): void => {
    if (problem !== null) affectedScreens.set(key, [...(affectedScreens.get(key) ?? []), screenId])
  }

  const verdictOf = (ancestor: AncestorRef, screenId: ScreenId): SpliceVerdict => {
    const key = ancestorKey(ancestor)
    const verdict = verdicts.get(key)?.verdict ?? judgeAncestor(ancestor)
    verdicts.set(key, { ancestor, verdict })
    noteAffected(key, verdict.problem, screenId)
    return verdict
  }

  const branchVerdictOf = (ancestor: AncestorRef, branch: SlotBranch, screenId: ScreenId): BranchVerdict => {
    const key = branchKey(ancestor, branch)
    const verdict = branchVerdicts.get(key)?.verdict ?? judgeBranch(ancestor, branch)
    branchVerdicts.set(key, { ancestor, verdict })
    noteAffected(key, verdict.problem, screenId)
    return verdict
  }

  const keptBranchesOf = (ancestor: AncestorRef, screenId: ScreenId): readonly KeptBranch[] =>
    sortBy(ancestor.branches ?? [], branchOrder).flatMap((branch) => {
      const verdict = branchVerdictOf(ancestor, branch, screenId)
      if (!verdict.kept) return []
      return [{ branch, ...wrapperOf(verdict), ...(verdict.ambiguous ? { ambiguous: true as const } : {}) }]
    })

  const planChain = (
    ancestors: readonly AncestorRef[],
    screenId: ScreenId,
  ): {
    readonly chain: readonly ChainLink[]
    readonly branches: readonly (readonly KeptBranch[])[]
    readonly transparent: readonly string[]
    readonly ambiguous: readonly string[]
  } => {
    const verdictsInOrder = ancestors.map((ancestor) => ({
      ancestor,
      verdict: verdictOf(ancestor, screenId),
    }))
    const linked = verdictsInOrder.flatMap(({ ancestor, verdict }) =>
      verdict.link === null
        ? []
        : [{ ancestor, verdict, link: verdict.link, branches: keptBranchesOf(ancestor, screenId) }],
    )
    return {
      chain: linked.map(({ link }) => link),
      branches: linked.map(({ branches }) => branches),
      transparent: verdictsInOrder
        .filter(({ verdict }) => verdict.link === null)
        .map(({ ancestor }) => ancestor.file),
      ambiguous: sortedUnique(
        linked
          .filter(({ verdict, branches }) => verdict.ambiguous || branches.some((kept) => kept.ambiguous === true))
          .map(({ ancestor }) => ancestor.file),
      ),
    }
  }

  const SCREENS_NAMED = 3

  const describeAffected = (screenIds: readonly ScreenId[]): string => {
    const named = screenIds.slice(0, SCREENS_NAMED).join(", ")
    const more = screenIds.length > SCREENS_NAMED ? `, +${String(screenIds.length - SCREENS_NAMED)} more` : ""
    return `${String(screenIds.length)} screen${screenIds.length === 1 ? "" : "s"} (${named}${more})`
  }

  // One diagnostic per ancestor, not per descendant screen: the defect is in the ancestor file, and
  // repeating it for every screen under a layout buried the one line that mattered.
  const reportSpliceProblems = (): void => {
    for (const [key, { ancestor, verdict }] of [...verdicts, ...branchVerdicts]) {
      const problem = verdict.problem
      if (problem === null) continue
      const screenIds = sortStrings(affectedScreens.get(key) ?? [])
      diagnostics.report({
        severity: problem.severity,
        code: problem.code,
        message: `${problem.message}; affects ${describeAffected(screenIds)}`,
        file: ancestor.file,
        ...(problem.line === undefined ? {} : { line: problem.line }),
        ...(screenIds.length === 1 && screenIds[0] !== undefined ? { screenId: screenIds[0] } : {}),
      })
    }
  }

  return { planChain, reportSpliceProblems }
}
