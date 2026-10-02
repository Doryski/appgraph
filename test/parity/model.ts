/**
 * The one shape both sides of the parity gate are projected into.
 *
 * The golden's document and appgraph's document are NOT the same document — `routes:` corresponds to
 * `screens:` + `stateScreens:`, per-route aggregates live under `facts:`, and endpoints are split by
 * transport. The gate therefore compares *projections*, not documents: a projection names exactly the
 * facts §12.3 says must hold, and nothing else. That is what keeps gate 1 reviewable by eye and stops
 * a schema change from reading as a parity failure.
 */

/** Gate 1: the agent-facing contract. One row of short strings per screen. */
export type ScreenContract = {
  readonly url: string
  /** `entries[0]` as a project-relative POSIX path, or null when there is no file entry. */
  readonly entry0: string | null
  readonly params: readonly string[]
  readonly auth: string
  readonly redirectTo: string | null
}

/**
 * The full `entries` list per screen, kept OUT of `ScreenContract` on purpose.
 *
 * §12.3's gate 1 asserts `entries[0]`, and `entries[0]` is order-dependent: the §8.9 sort change moves
 * it whenever a screen has more than one entry whose `localeCompare` and codepoint order differ. Gate 1
 * still asserts exactly what §12.3 says it asserts — but this list lets the report prove an `entries[0]`
 * difference is ordering-only rather than a lost or invented entry, which is the distinction between an
 * expected consequence and a regression.
 */
export type ScreenEntries = {
  readonly url: string
  readonly entries: readonly string[]
}

/** Gate 2: the per-screen coverage floors. */
export type ScreenCoverage = {
  readonly url: string
  readonly reachable: number
  readonly endpoints: number
  readonly testIds: number
  readonly stores: number
  readonly queryKeys: number
  readonly i18nNamespaces: number
  readonly formSchemas: number
  readonly formFields: number
  readonly featureGates: number
}

export type ParitySnapshot = {
  readonly label: string
  readonly contracts: readonly ScreenContract[]
  readonly entryLists: readonly ScreenEntries[]
  readonly coverage: readonly ScreenCoverage[]
  /** `${METHOD} ${url}` per screen url, for gate 3's A1 phantom-endpoint claims. */
  readonly endpointsByScreen: Readonly<Record<string, readonly string[]>>
  /** `${from} -> ${to}` navigation edges, for gate 3's A2 claim. */
  readonly navigationEdges: readonly string[]
  /** Menu item paths in the order the source declares them. */
  readonly menuPaths: readonly string[]
  readonly shells: readonly string[]
  /** Codepoint-relevant: the component-map keys in the order the document lists them. */
  readonly componentKeys: readonly string[]
  readonly counts: Readonly<Record<string, number>>
}

export const byUrl = <T extends { readonly url: string }>(rows: readonly T[]): ReadonlyMap<string, T> =>
  new Map(rows.map((row) => [row.url, row]))

/**
 * Gate 4 compares object graphs with sorted keys. Feeding it two ARRAYS of screen rows would compare
 * them positionally, which reintroduces exactly the ordering-versus-content confusion §12.2 warns about:
 * the golden lists routes in document order, appgraph lists screens sorted by URL, and a positional diff
 * then reports dozens of "differences" that are one reordering. Keying by URL first is what
 * makes the comparison about content.
 */
export const keyedByUrl = <T extends { readonly url: string }>(
  rows: readonly T[],
): Readonly<Record<string, T>> => Object.fromEntries(rows.map((row) => [row.url, row]))
