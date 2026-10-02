import type { ParitySnapshot, ScreenContract, ScreenCoverage } from "./model.js"
import { byUrl } from "./model.js"
import type { Difference } from "./compare.js"
import { deepDiff, firstOrderDivergence, formatDifferences, setDiff } from "./compare.js"

export type GateResult = {
  readonly gate: string
  readonly pass: boolean
  /** Human-readable, one finding per line. Empty when the gate passed. */
  readonly findings: readonly string[]
  /** Numbers the report quotes verbatim, whether or not the gate passed. */
  readonly stats: Readonly<Record<string, number>>
}

const result = (
  gate: string,
  findings: readonly string[],
  stats: Readonly<Record<string, number>>,
): GateResult => ({ gate, pass: findings.length === 0, findings, stats })

// ---------------------------------------------------------------------------
// Gate 4 first: it is the comparison primitive gates 1 and 2 are expressed in.
// ---------------------------------------------------------------------------

/**
 * Gate 4 (§12.3): compare parsed object graphs with keys sorted by codepoint at every level, never
 * text. `deepDiff` walks both sides key-sorted, so key ORDER cannot produce a finding — content can.
 */
export const gate4 = (golden: unknown, observed: unknown, what: string): GateResult => {
  const differences = deepDiff(golden, observed)
  return result(
    `gate 4 — parsed comparison (${what})`,
    differences.length === 0 ? [] : [formatDifferences(differences)],
    { differences: differences.length },
  )
}

const contractRows = (snapshot: ParitySnapshot): ReadonlyMap<string, ScreenContract> => byUrl(snapshot.contracts)

/**
 * Gate 1 (§12.3): exact SET equality on the agent-facing contract — the screen URL set, and per screen
 * `entries[0]`, `params`, `auth`, `redirectTo`. Ordering is deliberately not asserted (that is the
 * determinism tests' job). The comparison itself runs through gate 4's key-sorted `deepDiff`, so a
 * finding here is always a content finding.
 */
export const gate1 = (golden: ParitySnapshot, observed: ParitySnapshot): GateResult => {
  const goldenRows = contractRows(golden)
  const observedRows = contractRows(observed)
  const urls = setDiff([...goldenRows.keys()], [...observedRows.keys()])

  const findings: string[] = []
  for (const url of urls.onlyLeft) findings.push(`URL missing from observed: ${url}`)
  for (const url of urls.onlyRight) findings.push(`URL only in observed: ${url}`)

  let fieldDifferences = 0
  for (const [url, goldenRow] of [...goldenRows].sort()) {
    const observedRow = observedRows.get(url)
    if (observedRow === undefined) continue
    const differences: readonly Difference[] = deepDiff(goldenRow, observedRow)
    fieldDifferences += differences.length
    if (differences.length > 0) findings.push(`${url}:\n${formatDifferences(differences)}`)
  }

  return result(
    "gate 1 — set equality on the agent-facing contract",
    findings,
    {
      goldenUrls: goldenRows.size,
      observedUrls: observedRows.size,
      urlsOnlyInGolden: urls.onlyLeft.length,
      urlsOnlyInObserved: urls.onlyRight.length,
      fieldDifferences,
    },
  )
}

const COVERAGE_FIELDS = [
  "reachable",
  "endpoints",
  "testIds",
  "stores",
  "queryKeys",
  "i18nNamespaces",
  "formSchemas",
  "formFields",
  "featureGates",
] as const satisfies readonly (keyof ScreenCoverage)[]

export type FloorBreach = {
  readonly url: string
  readonly field: (typeof COVERAGE_FIELDS)[number]
  readonly golden: number
  readonly observed: number
}

export const floorBreaches = (golden: ParitySnapshot, observed: ParitySnapshot): readonly FloorBreach[] => {
  const observedRows = byUrl(observed.coverage)
  return golden.coverage.flatMap((goldenRow) => {
    const observedRow = observedRows.get(goldenRow.url)
    if (observedRow === undefined) return []
    return COVERAGE_FIELDS.flatMap((field) =>
      observedRow[field] < goldenRow[field]
        ? [{ url: goldenRow.url, field, golden: goldenRow[field], observed: observedRow[field] }]
        : [],
    )
  })
}

/**
 * Gate 2 (§12.3): monotonic coverage floors. Every §8 fix either adds coverage or is neutral; a fix
 * that legitimately removes coverage must claim it as a gate-3 assertion, which is why `waived` exists
 * and why it takes explicit `{url, field}` pairs rather than a wildcard.
 */
export const gate2 = (
  golden: ParitySnapshot,
  observed: ParitySnapshot,
  waived: readonly { readonly url: string; readonly field: string; readonly why: string }[] = [],
): GateResult => {
  const breaches = floorBreaches(golden, observed)
  const isWaived = (breach: FloorBreach): boolean =>
    waived.some((entry) => entry.url === breach.url && entry.field === breach.field)

  const findings = breaches
    .filter((breach) => !isWaived(breach))
    .map(
      (breach) =>
        `${breach.url}.${breach.field}: golden ${String(breach.golden)} > observed ${String(breach.observed)}`,
    )

  return result("gate 2 — monotonic coverage floors", findings, {
    breaches: breaches.length,
    waived: breaches.length - findings.length,
    screensCompared: golden.coverage.length,
  })
}

// ---------------------------------------------------------------------------
// Supplementary, non-gate observations the report needs. These are NOT one of the
// four gates; they are the numbers §12.1's baseline table records, checked so the
// report can state them rather than guess.
// ---------------------------------------------------------------------------

/**
 * The golden's menu paths must all be FOUND. Extra ones are not a failure, and that is a specified
 * behaviour rather than a concession.
 *
 * §10.6 discovers nav sources by scoring and §10.1 says detect ALL, report ALL, never silently pick, so
 * an app with two legitimate menus gets two `navGroups`. The parity app has exactly that: a primary
 * navigation array in its config and a second, smaller menu in a layout wrapper. The reference run is
 * given one menu file and so cannot represent a second; demanding equality would demand appgraph throw
 * away a real menu to match a limitation of its oracle.
 *
 * A pure superset check would be too weak on its own — it cannot tell "a second real menu" from
 * "scoring went haywire and found nine" — so the subset claim is paired with `extraMenuReport`, which
 * names the extra group and its entries exactly. Together they still fail if any golden path is lost.
 */
export const menuReport = (golden: ParitySnapshot, observed: ParitySnapshot): GateResult => {
  const differences = setDiff(golden.menuPaths, observed.menuPaths)
  const findings = differences.onlyLeft.map((path) => `golden menu path missing from observed: ${path}`)
  return result("menu items (§12.1 baseline: the golden's paths are a SUBSET of what is found)", findings, {
    golden: golden.menuPaths.length,
    observed: observed.menuPaths.length,
    goldenPathsMissing: differences.onlyLeft.length,
    extraPaths: differences.onlyRight.length,
  })
}

/**
 * The other half of the menu claim: every path found beyond the golden's is accounted for BY NAME.
 *
 * This is what keeps `menuReport`'s subset check honest. The expectation is passed in rather than
 * hardcoded here so the fixture and the real repo can both use it, and it is exact — a third menu, or a
 * different extra path, fails.
 */
export const extraMenuReport = (
  golden: ParitySnapshot,
  observed: ParitySnapshot,
  expectedExtras: readonly string[],
): GateResult => {
  const goldenPaths = new Set(golden.menuPaths)
  const extras = [...new Set(observed.menuPaths.filter((path) => !goldenPaths.has(path)))].sort()
  const differences = setDiff([...expectedExtras].sort(), extras)
  const findings = [
    ...differences.onlyLeft.map((path) => `expected extra menu path is absent: ${path}`),
    ...differences.onlyRight.map((path) => `unaccounted extra menu path: ${path}`),
  ]
  return result("menu items — the extra group's paths are named, not merely tolerated", findings, {
    expected: expectedExtras.length,
    observed: extras.length,
  })
}

export const shellReport = (golden: ParitySnapshot, observed: ParitySnapshot): GateResult => {
  const differences = setDiff(golden.shells, observed.shells)
  const findings = [
    ...differences.onlyLeft.map((file) => `shell missing from observed: ${file}`),
    ...differences.onlyRight.map((file) => `shell only in observed: ${file}`),
  ]
  return result("shells (§12.1 baseline)", findings, {
    golden: golden.shells.length,
    observed: observed.shells.length,
  })
}

/**
 * Supplementary to gate 1, and the reason an `entries[0]` difference can be classified rather than
 * merely reported: if the entry SETS agree while `entries[0]` differs, the difference is the §8.9
 * localeCompare -> codepoint sort, not a lost or invented entry.
 */
export const entriesSetReport = (golden: ParitySnapshot, observed: ParitySnapshot): GateResult => {
  const observedRows = new Map(observed.entryLists.map((row) => [row.url, row.entries]))
  const findings: string[] = []
  let reordered = 0
  for (const row of golden.entryLists) {
    const seen = observedRows.get(row.url)
    if (seen === undefined) continue
    const differences = setDiff(row.entries, seen)
    if (differences.onlyLeft.length > 0 || differences.onlyRight.length > 0) {
      findings.push(
        `${row.url}: lost=${JSON.stringify(differences.onlyLeft)} gained=${JSON.stringify(differences.onlyRight)}`,
      )
      continue
    }
    if (firstOrderDivergence(row.entries, seen) !== -1) reordered += 1
  }
  return result("entries — set equality (classifies gate 1's entries[0] diffs)", findings, {
    screensCompared: golden.entryLists.length,
    reorderedOnly: reordered,
  })
}

/**
 * §8.9 / §12.2: the golden's component keys were sorted with `localeCompare`; the port sorts by
 * codepoint. The two orders diverge at index 4, which is why byte equality cannot hold. This states
 * the divergence as a positive claim instead: the SETS agree up to the port's known
 * coverage delta, and the ORDER differs exactly where codepoint order differs from `localeCompare`.
 */
export const orderingReport = (golden: ParitySnapshot, observed: ParitySnapshot): GateResult => {
  const codepoint = [...golden.componentKeys].sort()
  const locale = [...golden.componentKeys].sort((a, b) => a.localeCompare(b))
  const divergence = firstOrderDivergence(locale, codepoint)
  const goldenIsLocaleSorted = firstOrderDivergence(golden.componentKeys, locale) === -1
  const observedIsCodepointSorted =
    firstOrderDivergence(observed.componentKeys, [...observed.componentKeys].sort()) === -1

  const findings = [
    ...(goldenIsLocaleSorted ? [] : ["golden component keys are NOT in localeCompare order"]),
    ...(observedIsCodepointSorted ? [] : ["observed component keys are NOT in codepoint order"]),
    ...(divergence === -1 ? ["localeCompare and codepoint order do NOT diverge on this key set"] : []),
  ]

  return result("ordering — localeCompare vs codepoint (§8.9)", findings, {
    goldenKeys: golden.componentKeys.length,
    observedKeys: observed.componentKeys.length,
    firstDivergenceIndex: divergence,
  })
}
