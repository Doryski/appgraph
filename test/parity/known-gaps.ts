/**
 * Gaps the parity gate MEASURED and cannot yet assert green.
 *
 * This is NOT the "accepted diffs" list §12.2 rejects. An accepted-diff list says "this difference is
 * fine". Each entry here says "this is broken, here is the measurement, here is what must become true",
 * and it is wired to a test that flips when it does.
 *
 * Three kinds of entry live here, and the `id` prefix says which:
 *
 *   GAP-*    A real defect or accepted limitation of the tool. Wired to a `test.fails` where the fixture
 *            can exhibit it, so the moment it closes the `test.fails` turns RED and whoever fixed it
 *            must come here and promote the expectation to a normal assertion.
 *   SPEC-*   The tool is right and §12.3's wording is wrong. Wired to a PASSING assertion stating the
 *            corrected claim; the entry survives until docs/architecture.md is amended by its owner.
 *   FIXED-*  A resolved defect whose cause is easy to misattribute. Records the actual mechanism and is
 *            always paired with the assertion that guards it.
 *
 * `pnpm test` is the arbiter, not this file: a `GAP-*` with no red `test.fails` behind it is stale
 * bookkeeping and must be promoted or reclassified, never left to rot.
 */
export type KnownGap = {
  readonly id: string
  readonly spec: string
  readonly measured: string
  readonly whenFixed: string
}

export const KNOWN_GAPS: readonly KnownGap[] = [
  {
    id: "SPEC-A4-MISREADS-ANCESTOR-REACHABLE",
    spec: "§12.3 gate 3, assertion A4; §6.3.1 ancestor chains",
    measured:
      "A4 demands that every screen's `reachable` length be IDENTICAL to the golden's. It cannot be, and not because of a defect: the golden's tree is built from the screen entries ALONE, while the port splices the §6.3.1 ancestor chain — the root layout, the error boundary, the auth guard, the layout wrapper — in at depth 0 and counts its whole closure as reachable. Every screen differs, always UPWARD, and the excess tracks the chain: a pure redirect gains its chain's whole closure, and the screen with the shortest chain has the smallest delta. Gate 2's floors pass on every screen with 0 breaches, so nothing is lost — the set grows. A4 as worded is unsatisfiable by any correct implementation of §6.3.1.",
    whenFixed:
      "This is a SPEC defect, not a tool defect: §12.3's A4 wording needs correcting to 'reachable is a SUPERSET of the golden's per screen, and the excess is exactly the ancestor chain's closure' (owner: whoever owns docs/architecture.md). Gate 2 already asserts the superset half and passes. When §12.3 is corrected, replace `a4Traversable`'s equality with that claim and delete this entry.",
  },
] as const

export const gapById = (id: string): KnownGap => {
  const gap = KNOWN_GAPS.find((entry) => entry.id === id)
  if (gap === undefined) throw new Error(`unknown gap '${id}'`)
  return gap
}
