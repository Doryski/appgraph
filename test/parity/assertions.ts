import type { ParityExpectations } from "./expectations.js"
import type { ParitySnapshot } from "./model.js"
import { byUrl } from "./model.js"
import type { ObservedSnapshot } from "./observed.js"
import { firstOrderDivergence, setDiff } from "./compare.js"
import { readYaml } from "./yaml-read.js"

/**
 * Gate 3 (§12.3): one NAMED, FALSIFIABLE assertion per §8 defect of the reference implementation. Not an
 * accepted-diff list — a claim. Each entry states an observable fact the reference output gets wrong and
 * appgraph must get right, so a regression fails the gate by itself, without anyone maintaining a diff
 * inventory.
 *
 * Scope: these are the assertions the parity application can exhibit. §12.3's A3 (adminjs resolver),
 * A6 (TanStack ancestors), A7 and A8 (browser-extension sub-file roots and masking) name other
 * acceptance apps and belong with those apps' goldens; they are listed in `NOT_APPLICABLE_HERE` so
 * nothing looks forgotten.
 *
 * Nothing here names the application. Every app-specific expectation — route names, module paths,
 * endpoint URLs — arrives as a `ParityExpectations` argument, read from the external golden.
 */

export type AssertionResult = {
  readonly id: string
  readonly claim: string
  readonly pass: boolean
  readonly detail: string
}

export const NOT_APPLICABLE_HERE = [
  "A3 (§8.10 resolver) — asserts on an AdminJS app, which has no golden here",
  "A6 (§6.3.1 ancestor chains) — asserts on a TanStack Start app",
  "A7 (§6.3.2 sub-file roots) — asserts on a browser-extension app",
  "A8 (§5.4 masking) — asserts on a browser-extension app",
  "A5c (§8.3 entryless tagging) — needs a route with NEITHER an entry NOR a redirect; the parity app has none (every screen has one or the other), so it runs on the committed fixture only",
] as const

const ok = (id: string, claim: string, detail: string): AssertionResult => ({ id, claim, pass: true, detail })
const no = (id: string, claim: string, detail: string): AssertionResult => ({ id, claim, pass: false, detail })

/**
 * A1 — §8.1: endpoints detected by HTTP method name alone.
 *
 * Client-identity awareness keeps `someMap.get('/x')` from minting a phantom endpoint. On the parity
 * app the expected removal list is **empty**, and that is a measurement, not an assumption:
 *
 *   grep -rnoE "[A-Za-z_$][A-Za-z0-9_$.]*\.(get|post|put|patch|delete)\(\s*['\`]/" src
 *
 * returns only genuine HTTP clients, and every Map-typed receiver there is called with a non-literal
 * key, which `flattenString` rejects.
 *
 * The claim, therefore: **no golden endpoint disappears.** If one does, either the client identity
 * table is over-eager or the extraction lost coverage — both are failures, and this assertion, not a
 * diff list, is what says so.
 */
export const a1Endpoints = (golden: ParitySnapshot, observed: ParitySnapshot): AssertionResult => {
  const claim =
    "A1 (§8.1): the phantom-endpoint set is EMPTY on the parity app — every `.get|post|put|patch|delete('/…')` receiver is a genuine HTTP client — so no golden endpoint disappears"
  const missing: string[] = []
  for (const [url, endpoints] of Object.entries(golden.endpointsByScreen)) {
    const seen = new Set(observed.endpointsByScreen[url] ?? [])
    for (const endpoint of endpoints) if (!seen.has(endpoint)) missing.push(`${url}: ${endpoint}`)
  }
  const goldenTotal = new Set(Object.values(golden.endpointsByScreen).flat()).size
  const observedTotal = new Set(Object.values(observed.endpointsByScreen).flat()).size
  const detail = `distinct endpoints golden=${String(goldenTotal)} observed=${String(observedTotal)}; per-screen endpoints missing=${String(missing.length)}${missing.length === 0 ? "" : `\nfirst 15: ${missing.slice(0, 15).join(", ")}`}`
  return missing.length === 0 ? ok("A1", claim, detail) : no("A1", claim, detail)
}

/**
 * A2 — §8.2: `navigate(...)` matched by identifier name only.
 *
 * Binding resolution follows an aliased `useNavigate()` result and ignores a same-named non-navigate
 * identifier. Every `useNavigate()` call site in the parity app binds the canonical name
 * `const navigate = useNavigate()`, so no NEW edge can come from de-aliasing there — but one detail page
 * passes `navigate` as a PROP typed `ReturnType<typeof useNavigate>`, which name-only matching catches
 * only by accident.
 *
 * The claim is the direction §12.3 asserts, stated so it is falsifiable on this app: **every golden
 * edge is retained, and the count does not fall.** A rise is allowed and reported; a loss is a failure.
 */
export const a2Navigation = (golden: ParitySnapshot, observed: ParitySnapshot): AssertionResult => {
  const claim =
    "A2 (§8.2): binding-resolved `navigate()` retains every golden navigation edge and never lowers the count"
  const differences = setDiff(golden.navigationEdges, observed.navigationEdges)
  const detail = `golden=${String(golden.navigationEdges.length)} observed=${String(observed.navigationEdges.length)}\n  lost: ${JSON.stringify(differences.onlyLeft)}\n  gained: ${JSON.stringify(differences.onlyRight)}`
  return differences.onlyLeft.length === 0 && observed.navigationEdges.length >= golden.navigationEdges.length
    ? ok("A2", claim, detail)
    : no("A2", claim, detail)
}

/**
 * A2b — `via` is part of a navigation edge's identity.
 *
 * `graph.navigation` deduplicates on `from|to|trigger|via`. Without `via`, when two reachable files
 * navigate one screen to one target only the first survives: a logo component in the shell that
 * navigates to `/` on every screen would shadow each page's own edge to `/`.
 *
 * ## Why A2 alone is not enough
 *
 * A2 checks that no golden edge is LOST. But A2 would also pass on an implementation that got the right
 * total by luck, and it says nothing about WHY an edge went missing — a dedup bug reads as an extraction
 * bug under A2 alone.
 *
 * This assertion names the mechanism instead: a `(from, to, trigger)` triple reached by two distinct
 * files must yield TWO edges. It fails as soon as `via` leaves the key, and it is checked on witness
 * screens named in the external `expectations.json`, not here.
 */
export const a2NavigationViaShadowing = (
  observed: ObservedSnapshot,
  witnesses: ParityExpectations["navShadowingWitnesses"],
): AssertionResult => {
  const claim =
    "A2b (§8.2 aggregation): `via` is part of a navigation edge's identity — a shell file and a page file that navigate the same screen to the same target produce TWO edges, so the shell's cannot shadow the page's"
  const failures: string[] = []
  const seen: Record<string, readonly string[]> = {}

  for (const witness of witnesses) {
    const matching = observed.graph.navigation.filter(
      (edge) => edge.from === witness.from && edge.to === witness.to && edge.trigger === witness.trigger,
    )
    const vias = [...matching.map((edge) => edge.via)].sort()
    seen[`${witness.from} -> ${witness.to} (${witness.trigger})`] = vias
    const differences = setDiff([...witness.via].sort(), vias)
    for (const via of differences.onlyLeft)
      failures.push(`${witness.from} -> ${witness.to}: edge via '${via}' is MISSING (shadowed?)`)
    for (const via of differences.onlyRight)
      failures.push(`${witness.from} -> ${witness.to}: unexpected edge via '${via}'`)
  }

  const detail = `${JSON.stringify(seen)}${failures.length === 0 ? "" : `\n  ${failures.join("\n  ")}`}`
  return failures.length === 0 ? ok("A2b", claim, detail) : no("A2b", claim, detail)
}

/**
 * ATEST — §10.7: `*.test.*`, `*.spec.*`, `*.stories.*` and `*.d.ts` are excluded from DISCOVERY, not
 * merely from module resolution.
 *
 * A discovered `*.test.tsx` file that claims real URLs raises `screens/duplicate-id` errors, and the
 * merge corrupts both screens — one loses its entry, the other takes the test file's sibling as
 * `entries[0]` and can fall from protected to public.
 *
 * Asserting particular screens' contract rows would only catch one symptom. The claim here is the
 * general one — NO excluded file appears anywhere in the graph, as a screen entry or as a component key —
 * so a test file claiming some OTHER route fails too.
 */
export const EXCLUDED_FROM_DISCOVERY = /\.(?:test|spec|stories)\.[cm]?[jt]sx?$|\.d\.ts$/

export const aTestFilesExcluded = (observed: ObservedSnapshot): AssertionResult => {
  const claim =
    "ATEST (§10.7): no `*.test.*` / `*.spec.*` / `*.stories.*` / `*.d.ts` file is a screen entry or a component-map key — the exclusion applies to discovery, not only to module resolution"
  const entries = observed.graph.screens.flatMap((screen) =>
    screen.entries.flatMap((entry) => (entry.kind === "file" ? [entry.file] : [])),
  )
  const badEntries = entries.filter((file) => EXCLUDED_FROM_DISCOVERY.test(file))
  const badComponents = Object.keys(observed.graph.components).filter((file) =>
    EXCLUDED_FROM_DISCOVERY.test(file),
  )
  const detail = `screen entries checked=${String(entries.length)} components checked=${String(Object.keys(observed.graph.components).length)}; offending entries=${JSON.stringify(badEntries)} offending components=${JSON.stringify(badComponents)}`
  return badEntries.length === 0 && badComponents.length === 0
    ? ok("ATEST", claim, detail)
    : no("ATEST", claim, detail)
}

/**
 * A5 — §8.3: routes with neither a screen entry nor a redirect are silently dropped.
 *
 * On the parity app the four zero-entry URLs are REDIRECTS, not entryless routes. Each carries a
 * `redirectTo` (the four URL pairs are named in the external `expectations.json`), each is
 * `element: <Navigate to={…} replace />` in the router, and `MANIFEST.md` counts them as `redirects`.
 * The golden retains them — `routes:` contains all four.
 *
 * §12.3's A5 therefore asserts retention plus the golden redirect target, and no `entryless` kindTag:
 * tagging a redirect `entryless` would tell an agent that a URL renders nothing, when in fact it bounces
 * somewhere specific — which `redirectTo` already says, better.
 *
 * A route with NEITHER an entry NOR a redirect is `a5cEntrylessTagged`'s job: the parity app does not
 * contain that shape, and the committed fixture does (`/entryless`).
 */
export const a5Entryless = (
  observed: ObservedSnapshot,
  redirects: ParityExpectations["zeroEntryRedirects"],
): AssertionResult => {
  const claim =
    "A5 (§8.3): the four zero-entry URLs are present in `screens` and each carries its golden `redirectTo` — they are redirects, not entryless routes, so no 'entryless' kindTag is expected"
  const failures: string[] = []
  const seen: Record<string, unknown> = {}
  for (const [url, target] of Object.entries(redirects)) {
    const screen = observed.graph.screens.find((entry) => entry.url === url)
    seen[url] = screen === undefined ? "ABSENT" : { redirectTo: screen.redirectTo, kindTag: screen.kindTag }
    if (screen === undefined) {
      failures.push(`${url} is absent`)
      continue
    }
    if (screen.redirectTo !== target) failures.push(`${url}: redirectTo ${String(screen.redirectTo)} != ${target}`)
    if (screen.entries.length !== 0) failures.push(`${url}: expected 0 entries, got ${String(screen.entries.length)}`)
  }
  const detail = `${JSON.stringify(seen)}${failures.length === 0 ? "" : `\n  ${failures.join("\n  ")}`}`
  return failures.length === 0 ? ok("A5", claim, detail) : no("A5", claim, detail)
}

/**
 * A5c — the half of §8.3 the parity app cannot test: a `path:` with no element, no lazy and no
 * redirect. The reference output drops this shape entirely; appgraph keeps it and tags it, because
 * "exists but renders nothing" and "not found" are different answers to an agent.
 */
export const a5cEntrylessTagged = (observed: ObservedSnapshot, url: string): AssertionResult => {
  const claim = `A5c (§8.3): the entryless route '${url}' — no element, no lazy, no redirect — is retained and tagged 'layout' or 'entryless'`
  const screen = observed.graph.screens.find((entry) => entry.url === url)
  const detail =
    screen === undefined
      ? `'${url}' is absent from screens`
      : `kindTag=${JSON.stringify(screen.kindTag)} entries=${String(screen.entries.length)} redirectTo=${JSON.stringify(screen.redirectTo)}`
  const tagged = screen !== undefined && (screen.kindTag === "layout" || screen.kindTag === "entryless")
  return tagged ? ok("A5c", claim, detail) : no("A5c", claim, detail)
}

/**
 * A5b — the screen-count rise §12.3 names: a PATHLESS layout route is retained. The golden's
 * `routes:` array holds only URL-addressable entries; a pathless layout route has no URL to key on, so
 * the reference output cannot represent it at all.
 */
export const a5bPathlessLayout = (observed: ObservedSnapshot): AssertionResult => {
  const claim =
    "A5b (§8.3): at least one pathless layout route is retained as a non-addressable screen the reference output cannot represent"
  const pathless = observed.graph.screens.filter((screen) => screen.url === null)
  const detail = `non-addressable screens=${String(pathless.length)}: ${JSON.stringify(pathless.map((screen) => ({ id: screen.id, source: screen.source, kindTag: screen.kindTag, shell: screen.shell })))}`
  return pathless.length >= 1 ? ok("A5b", claim, detail) : no("A5b", claim, detail)
}

/**
 * A4 (parity-app half) — §8.11: the traversable directory set is expressed as `KindRule.traversable`.
 *
 * §12.3 states this as: on the parity app, every screen's `reachable` length is identical to the golden —
 * the derived rules reproduce the reference traversable set exactly. That is a strong claim and it is checked literally,
 * because the whole point of A4 is that generalising the rule must not change the answer on the app
 * whose hardcoded regex it generalises.
 */
export const a4Traversable = (golden: ParitySnapshot, observed: ParitySnapshot): AssertionResult => {
  const claim =
    "A4 (§8.11): every screen's `reachable` length is IDENTICAL to the golden — the derived traversable rules reproduce the reference traversable set exactly"
  const observedRows = byUrl(observed.coverage)
  const differing = golden.coverage.flatMap((row) => {
    const seen = observedRows.get(row.url)
    if (seen === undefined || seen.reachable === row.reachable) return []
    return [`${row.url}: golden ${String(row.reachable)} observed ${String(seen.reachable)}`]
  })
  const detail = `screens with a different reachable count: ${String(differing.length)}/${String(golden.coverage.length)}${differing.length === 0 ? "" : `\n  ${differing.slice(0, 40).join("\n  ")}`}`
  return differing.length === 0 ? ok("A4", claim, detail) : no("A4", claim, detail)
}

/**
 * A9 — §10.5 test-id derivation. `N` is pinned from the golden: the witness screen and its count are
 * recorded in the external `expectations.json`.
 */
export const a9TestIds = (
  observed: ParitySnapshot,
  witness: ParityExpectations["testIdWitness"],
): AssertionResult => {
  const claim = `A9 (§10.5): the witness screen has testIds.length >= ${String(witness.count)} (pinned from the golden)`
  const row = byUrl(observed.coverage).get(witness.url)
  const detail = `observed testIds=${row === undefined ? "screen absent" : String(row.testIds)}`
  return row !== undefined && row.testIds >= witness.count ? ok("A9", claim, detail) : no("A9", claim, detail)
}

/**
 * A10 — §8.13: the YAML emitter can produce unparseable output.
 *
 * Checked with `yaml-read.ts`, an INDEPENDENT reader: `toYaml`'s own round-trip self-check cannot catch
 * a bug it shares with the emitter. Runs only when the emitted files are passed in.
 */
export const a10Yaml = (
  observed: ObservedSnapshot,
  files: readonly { readonly path: string; readonly content: string }[],
): AssertionResult => {
  const claim =
    "A10 (§8.13): at least one YAML document is emitted, and every emitted YAML document re-parses with the independent reader `yaml-read.ts` (checked only when the emitted files are passed in)"
  const failures: string[] = []
  const yamlFiles = files.filter((file) => file.path.endsWith(".yaml") || file.path.endsWith(".yml"))
  for (const file of yamlFiles) {
    try {
      readYaml(file.content)
    } catch (error) {
      failures.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const detail = `yaml documents checked=${String(yamlFiles.length)} (of ${String(files.length)} emitted); screens=${String(observed.graph.screens.length)}${failures.length === 0 ? "" : `\n  ${failures.join("\n  ")}`}`
  return failures.length === 0 && yamlFiles.length > 0 ? ok("A10", claim, detail) : no("A10", claim, detail)
}

/**
 * AORD — §8.9 / §12.2: the ordering claim that stands in for byte equality.
 *
 * The golden was produced with `localeCompare`; the port sorts by codepoint. The two orders diverge at
 * index 4 of the golden's component keys, which is why byte equality is false by design. Asserting the
 * divergence POSITIVELY is what lets the gate stay blind to ordering elsewhere without losing the
 * ability to notice that the sort changed.
 */
export const AORD_EXPECTED_DIVERGENCE_INDEX = 4

export const aOrdering = (golden: ParitySnapshot, observed: ParitySnapshot): AssertionResult => {
  const claim = `AORD (§8.9): the golden's component keys are in localeCompare order, the port's are in codepoint order, and the two orders first diverge at index ${String(AORD_EXPECTED_DIVERGENCE_INDEX)} of the golden's key list`
  const locale = [...golden.componentKeys].sort((a, b) => a.localeCompare(b))
  const codepoint = [...golden.componentKeys].sort()
  const divergence = firstOrderDivergence(locale, codepoint)
  const goldenIsLocale = firstOrderDivergence(golden.componentKeys, locale) === -1
  const observedIsCodepoint = firstOrderDivergence(observed.componentKeys, [...observed.componentKeys].sort()) === -1
  const detail = [
    `golden keys=${String(golden.componentKeys.length)} localeCompare-ordered=${String(goldenIsLocale)}`,
    `observed keys=${String(observed.componentKeys.length)} codepoint-ordered=${String(observedIsCodepoint)}`,
    `first divergence index=${String(divergence)} (expected ${String(AORD_EXPECTED_DIVERGENCE_INDEX)})`,
    `  locale[${String(divergence)}]=${JSON.stringify(locale[divergence])}`,
    `  codepoint[${String(divergence)}]=${JSON.stringify(codepoint[divergence])}`,
  ].join("\n")
  return goldenIsLocale && observedIsCodepoint && divergence === AORD_EXPECTED_DIVERGENCE_INDEX
    ? ok("AORD", claim, detail)
    : no("AORD", claim, detail)
}

export const runAssertions = (
  golden: ParitySnapshot,
  observed: ObservedSnapshot,
  expected: ParityExpectations,
  files: readonly { readonly path: string; readonly content: string }[] = [],
): readonly AssertionResult[] => [
  a1Endpoints(golden, observed),
  a2Navigation(golden, observed),
  a2NavigationViaShadowing(observed, expected.navShadowingWitnesses),
  aTestFilesExcluded(observed),
  a4Traversable(golden, observed),
  a5Entryless(observed, expected.zeroEntryRedirects),
  a5bPathlessLayout(observed),
  a9TestIds(observed, expected.testIdWitness),
  ...(files.length === 0 ? [] : [a10Yaml(observed, files)]),
  aOrdering(golden, observed),
]
