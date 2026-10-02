import { isSfcFile } from "../extensions.js"
import type { AncestorRef, SlotBranch, SpliceMode } from "../model.js"
import { sortedUnique } from "../order.js"
import type { GraphContext } from "./context.js"
import type { BranchVerdict, SpliceCandidate, SpliceHost, SpliceRef, SpliceVerdict } from "./model.js"
import { wholeFileRoot } from "./model.js"
import type { createPlacement } from "./placement.js"
import type { createRoots } from "./roots.js"
import type { createSpliceScanner } from "./splice-scan.js"
import { describeSplice } from "./splice-scan.js"

export type { SplicePoint, SpliceRef } from "./model.js"

type OutletSplice = Extract<SpliceMode, { kind: "outlet" }>

export const createSpliceJudge = (
  { providers, maxDepth, factsOf }: GraphContext,
  { byPosition, outletCandidatesIn, spliceCandidatesIn }: ReturnType<typeof createSpliceScanner>,
  { placementsIn, decidePlacement, wrapperFields, directAmbiguity, hostedAmbiguity }: ReturnType<
    typeof createPlacement
  >,
  { ancestorRootOf }: ReturnType<typeof createRoots>,
) => {
  const providedCandidatesOf = (ref: SpliceRef): readonly SpliceCandidate[] | null => {
    const points = providers.spliceCandidatesOf?.(ref) ?? null
    return points === null ? null : byPosition(points.map(({ pos, line }) => ({ pos, line })))
  }

  const spliceRefOf = (ancestor: AncestorRef, splice: SpliceMode): SpliceRef => ({
    file: ancestor.file,
    exportName: ancestor.exportName === "" ? null : ancestor.exportName,
    splice,
  })

  const isUnverifiableSfc = (file: string, splice: SpliceMode, provided: readonly SpliceCandidate[] | null): boolean =>
    provided === null && isSfcFile(file) && splice.kind !== "at"

  const hostedCandidatesOf = (file: string, splice: OutletSplice): readonly SpliceCandidate[] => {
    const provided = providedCandidatesOf({ file, exportName: null, splice })
    if (provided !== null) return provided
    const source = providers.sourceOf?.(file) ?? null
    return source === null ? [] : outletCandidatesIn(file, source, source, splice.tag)
  }

  /**
   * `<Outlet/>` reads the router's context, so a component the ancestor renders may host it
   * (`<AppShell/>` → `<main><Outlet/></main>`). Searched breadth-first over render edges up to
   * `maxDepth` levels; the shallowest level that has any host wins. `{children}` gets no such search:
   * a child component cannot receive `children` it was never passed, and passing is found directly.
   * The first level is the ancestor's own rendered files, so an export-scoped ancestor searches only
   * what its export renders.
   */
  const outletHostsAmong = (
    rendered: readonly string[],
    seen: ReadonlySet<string>,
    splice: OutletSplice,
    depth: number,
  ): readonly SpliceHost[] => {
    const next = sortedUnique(rendered).filter((file) => !seen.has(file))
    if (depth >= maxDepth || next.length === 0) return []
    const hosts = next.flatMap((file): readonly SpliceHost[] => {
      const candidates = hostedCandidatesOf(file, splice)
      return candidates.length === 0 ? [] : [{ file, candidates }]
    })
    if (hosts.length > 0) return hosts
    return outletHostsAmong(
      next.flatMap((file) => factsOf(file).renders.map((edge) => edge.file)),
      new Set([...seen, ...next]),
      splice,
      depth + 1,
    )
  }

  /**
   * §6.3.1. An ancestor with no splice point is TRANSPARENT: it is skipped in the chain (the next
   * level splices into its parent instead) and its file is kept in `reachable`, because it does run.
   * A hole in the chain beats no chain — the alternative is `shells: {}` on every screen.
   *
   * Severity: an UNREADABLE ancestor is an error — the adapter named a file the project cannot parse,
   * which is a defect in the run. A readable ancestor with no splice point found is a warning: the output
   * is complete and the hole is visible (`reachable` keeps the file); what is uncertain is only where the
   * page sits. An adapter that KNOWS the level is transparent (a component-less route) says so with
   * `role: 'transparent'` and nothing is reported.
   */
  const trustedVerdict = (ancestor: AncestorRef): SpliceVerdict => ({
    link: {
      ancestor,
      root: wholeFileRoot(ancestor.file),
      host: ancestor.file,
    },
    problem: null,
    ambiguous: false,
  })

  const judgeAncestor = (ancestor: AncestorRef): SpliceVerdict => {
    if (ancestor.role === "transparent") return { link: null, problem: null, ambiguous: false }

    // No `sourceOf` (or no SFC template) means the splice point cannot be verified at all; trusting the
    // adapter beats erasing every chain it supplied.
    const provided = providedCandidatesOf(spliceRefOf(ancestor, ancestor.splice))
    if (providers.sourceOf === undefined || isUnverifiableSfc(ancestor.file, ancestor.splice, provided))
      return trustedVerdict(ancestor)

    const source = providers.sourceOf(ancestor.file)
    if (source === null)
      return {
        link: null,
        problem: {
          severity: "error",
          code: "walk/no-splice-point",
          message: `ancestor '${ancestor.file}' could not be read; looked for ${describeSplice(ancestor)}; treated as transparent`,
        },
        ambiguous: false,
      }

    const root = ancestorRootOf(ancestor, source)
    const renders = (root.facts ?? factsOf(ancestor.file)).renders
    const direct = provided ?? spliceCandidatesIn(ancestor, source)
    if (direct.length > 0) {
      const placements = placementsIn(ancestor.file, renders, direct)
      const decision = decidePlacement(placements)
      return {
        link: {
          ancestor,
          root,
          host: ancestor.file,
          ...wrapperFields(decision),
        },
        problem: directAmbiguity(ancestor, placements, decision),
        ambiguous: decision.ambiguous,
      }
    }

    const hosts =
      ancestor.splice.kind === "outlet"
        ? outletHostsAmong(
            renders.map((edge) => edge.file),
            new Set([ancestor.file]),
            ancestor.splice,
            0,
          )
        : []
    const host = hosts[0]
    if (host !== undefined) {
      const decision = decidePlacement(placementsIn(host.file, factsOf(host.file).renders, host.candidates))
      return {
        link: { ancestor, root, host: host.file, ...wrapperFields(decision) },
        problem: hostedAmbiguity(ancestor, hosts, decision),
        ambiguous: decision.ambiguous || hosts.length > 1,
      }
    }

    return {
      link: null,
      problem: {
        severity: "warning",
        code: "walk/no-splice-point",
        message: `ancestor '${ancestor.file}' renders no ${describeSplice(ancestor)}; treated as transparent`,
      },
      ambiguous: false,
    }
  }

  /**
   * A slot branch is judged apart from its link: the layout may render `{children}` but not `{modal}`,
   * which drops the branch and keeps the chain. Only called for a link that splices, so the layout's
   * source was readable (or unverifiable, when the branch is trusted like its link).
   */
  const judgeBranch = (ancestor: AncestorRef, branch: SlotBranch): BranchVerdict => {
    const provided = providedCandidatesOf(spliceRefOf(ancestor, branch.splice))
    const source = providers.sourceOf?.(ancestor.file) ?? null
    if (source === null || isUnverifiableSfc(ancestor.file, branch.splice, provided))
      return { kept: true, problem: null, ambiguous: false }
    const candidates = provided ?? spliceCandidatesIn({ ...ancestor, splice: branch.splice }, source)
    if (candidates.length > 0) {
      const renders = (ancestorRootOf(ancestor, source).facts ?? factsOf(ancestor.file)).renders
      const decision = decidePlacement(placementsIn(ancestor.file, renders, candidates))
      return {
        kept: true,
        problem: null,
        ambiguous: decision.ambiguous,
        ...wrapperFields(decision),
      }
    }
    return {
      kept: false,
      ambiguous: false,
      problem: {
        severity: "warning",
        code: "walk/no-splice-point",
        message: `ancestor '${ancestor.file}' renders no ${describeSplice(branch)}; slot branch '${branch.file}' dropped`,
      },
    }
  }

  return { hostedCandidatesOf, judgeAncestor, judgeBranch }
}
