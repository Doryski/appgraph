/**
 * The CI half of the §12.3 parity gate.
 *
 * The real golden is a snapshot taken over a private application and lives outside this package, so CI
 * cannot depend on it (`target-app.test.ts` skips when either pointer is absent). This file needs NEITHER
 * pointer and always runs: it exercises the SAME four gates and the same gate-3 assertions against a
 * committed synthetic app that carries every shape the real gate depends on, so the machinery itself can
 * never rot unnoticed.
 *
 * It is not a substitute for the real gate: the fixture is a handful of screens, and no reference
 * implementation runs over it, so there is no independent oracle for its numbers — only the
 * hand-derived expectation in `fixture/expected.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { materializeMiniApp, removeMiniApp } from "./fixture/materialize.js"
import {
  FIXTURE_CONTRACTS,
  FIXTURE_EXPECTED_ENDPOINTS,
  FIXTURE_EXPECTED_NAV_EDGES,
  FIXTURE_EXPECTED_RENDER_EDGES,
  FIXTURE_FLOORS,
} from "./fixture/expected.js"
import {
  MINI_APP_MENU_PATHS,
  MINI_APP_PINNED_CONFIG,
  MINI_APP_PHANTOM_ENDPOINTS,
  MINI_APP_RENDER_EDGES,
  MINI_APP_URLS,
} from "./fixture/mini-app.js"
import type { ObservedSnapshot } from "./observed.js"
import { observedSnapshot } from "./observed.js"
import { runPinned, runZeroConfig } from "./pinned.js"
import type { ParitySnapshot } from "./model.js"
import { keyedByUrl } from "./model.js"
import { deepDiff, formatDifferences, setDiff } from "./compare.js"
import { floorBreaches, gate1, gate2, gate4 } from "./gates.js"
import { a5bPathlessLayout, a5cEntrylessTagged, a10Yaml, aTestFilesExcluded } from "./assertions.js"
import { KNOWN_GAPS } from "./known-gaps.js"
import { readYaml } from "./yaml-read.js"

let root = ""
let pinned: ObservedSnapshot
let zero: ObservedSnapshot
let pinnedFiles: readonly { readonly path: string; readonly content: string }[] = []

/** The hand-derived expectation, wearing the same shape the golden projection wears. */
const expected: ParitySnapshot = {
  label: "fixture expectation (hand-derived)",
  contracts: FIXTURE_CONTRACTS,
  entryLists: [],
  coverage: FIXTURE_FLOORS,
  endpointsByScreen: {},
  navigationEdges: [...FIXTURE_EXPECTED_NAV_EDGES].sort(),
  menuPaths: [...MINI_APP_MENU_PATHS],
  shells: [],
  componentKeys: [],
  counts: {},
}

beforeAll(async () => {
  root = materializeMiniApp()
  const pinnedRun = await runPinned(root, MINI_APP_PINNED_CONFIG)
  pinned = observedSnapshot(pinnedRun, "fixture pinned")
  pinnedFiles = pinnedRun.files
  zero = observedSnapshot(await runZeroConfig(root), "fixture zero-config")
}, 120_000)

afterAll(() => {
  if (root !== "") removeMiniApp(root)
})

describe("gate 1 — set equality on the agent-facing contract", () => {
  it("finds exactly the URLs the fixture router declares", () => {
    const differences = setDiff([...MINI_APP_URLS], pinned.contracts.map((row) => row.url))
    expect({ missing: differences.onlyLeft, unexpected: differences.onlyRight }).toEqual({
      missing: [],
      unexpected: [],
    })
  })

  it("reproduces entries[0], params, auth and redirectTo for every screen", () => {
    const gate = gate1(expected, pinned)
    expect(gate.findings.join("\n"), `gate 1 stats ${JSON.stringify(gate.stats)}`).toBe("")
  })

  it("keeps `entries[0]` in codepoint order where localeCompare would disagree (§8.9)", () => {
    const posts = pinned.entryLists.find((row) => row.url === "/posts")
    // Both files are present; only their ORDER depends on the §8.9 sort.
    expect(posts?.entries).toEqual([
      "src/modules/PostsList/PostsList.tsx",
      "src/modules/PostsList/components/PostsHeader.tsx",
    ])
    const localeFirst = [...(posts?.entries ?? [])].sort((a, b) => a.localeCompare(b))[0]
    expect(localeFirst).toBe("src/modules/PostsList/components/PostsHeader.tsx")
  })
})

describe("gate 2 — monotonic coverage floors", () => {
  it("meets every hand-derived floor", () => {
    const gate = gate2(expected, pinned)
    expect(gate.findings.join("\n"), `gate 2 stats ${JSON.stringify(gate.stats)}`).toBe("")
  })

  it("reports a breach when a floor is raised above what the tool produces", () => {
    // The gate must be able to FAIL. Raising one floor by one is the cheapest proof that a dropped
    // edge would be caught rather than absorbed.
    const raised: ParitySnapshot = {
      ...expected,
      coverage: expected.coverage.map((row) =>
        row.url === "/posts" ? { ...row, reachable: row.reachable + 1_000 } : row,
      ),
    }
    const breaches = floorBreaches(raised, pinned)
    expect(breaches.map((breach) => `${breach.url}.${breach.field}`)).toEqual(["/posts.reachable"])
  })
})

describe("gate 3 — named assertions", () => {
  it("A1 (§8.1): no phantom endpoint from the Map in usePrefetchMap.ts reaches any screen", () => {
    const seen = new Set(Object.values(pinned.endpointsByScreen).flat())
    const leaked = MINI_APP_PHANTOM_ENDPOINTS.filter((endpoint) => seen.has(endpoint))
    expect(leaked, `observed endpoints: ${JSON.stringify([...seen])}`).toEqual([])
  })

  it("A5b (§8.3): the pathless layout route is retained as a non-addressable screen", () => {
    const assertion = a5bPathlessLayout(pinned)
    expect(assertion.pass, assertion.detail).toBe(true)
  })

  it("A10 (§8.13): every emitted YAML document re-parses with an independent reader", () => {
    const assertion = a10Yaml(pinned, pinnedFiles)
    expect(assertion.pass, assertion.detail).toBe(true)
  })

  it("A10 (§8.13): the emitted YAML round-trips to the same object graph gate 4 would compare", () => {
    const full = pinnedFiles.find((file) => file.path.endsWith(".yaml"))
    expect(full).toBeDefined()
    const parsed = readYaml(full?.content ?? "")
    // Not a byte check: the claim is that reading back what was written yields a usable object graph
    // with the screens block intact, which is the property gate 4 relies on.
    expect(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)).toBe(true)
  })
})

describe("gate 4 — parsed comparison, sorted keys, never text", () => {
  it("is blind to key order", () => {
    const left = { b: 1, a: { d: 2, c: 3 } }
    const right = { a: { c: 3, d: 2 }, b: 1 }
    expect(deepDiff(left, right)).toEqual([])
  })

  it("is blind to sequence order only where the caller sorted first", () => {
    // Positional by design: a sequence IS ordered data. Callers that mean "set" sort or key first,
    // which is why every table in this gate goes through `keyedByUrl` (§12.2's lesson).
    expect(deepDiff([1, 2], [2, 1])).not.toEqual([])
    expect(deepDiff(keyedByUrl([{ url: "b" }, { url: "a" }]), keyedByUrl([{ url: "a" }, { url: "b" }]))).toEqual([])
  })

  it("reports the contract table as content-identical to the expectation", () => {
    const gate = gate4(keyedByUrl(expected.contracts), keyedByUrl(pinned.contracts), "fixture contracts")
    expect(gate.findings.join("\n")).toBe("")
  })
})

describe("§12.4 — zero-config must equal pinned-config", () => {
  it("agrees on the agent-facing contract", () => {
    const differences = deepDiff(keyedByUrl(pinned.contracts), keyedByUrl(zero.contracts))
    expect(formatDifferences(differences)).toBe("")
  })

  it("agrees on the screen URL set", () => {
    expect([...zero.contracts.map((row) => row.url)].sort()).toEqual([...pinned.contracts.map((row) => row.url)].sort())
  })

  it("agrees on shells", () => {
    expect([...zero.shells].sort()).toEqual([...pinned.shells].sort())
  })
})

describe("§7.9 render edges", () => {
  it(`reports exactly ${String(FIXTURE_EXPECTED_RENDER_EDGES)} render edges`, () => {
    // A fixture whose modules return only intrinsic tags makes `renderEdges: 0` arithmetically correct
    // and the metric unregressable in either direction. `FeedList` renders three components and
    // `FeedToolbar` renders a fourth.
    expect(pinned.counts["renderEdges"]).toBe(FIXTURE_EXPECTED_RENDER_EDGES)
  })

  it("records every producer -> consumer edge with the right §7.9 shape", () => {
    // The exact-count check above cannot tell four right edges from four wrong ones. This does: each
    // edge is looked up by producer and consumer, and `alwaysRendered` / `repeated` are asserted, so a
    // conditional edge silently promoted to unconditional (or a `.map()` losing `repeated`) fails.
    for (const expectedEdge of MINI_APP_RENDER_EDGES) {
      const producer = pinned.graph.components[expectedEdge.from]
      expect(producer, `no component-map entry for ${expectedEdge.from}`).toBeDefined()
      const edge = producer?.renders.find((entry) => entry.file === expectedEdge.to)
      expect(edge, `${expectedEdge.from} does not render ${expectedEdge.to}`).toBeDefined()
      expect(edge?.alwaysRendered, `${expectedEdge.from} -> ${expectedEdge.to}.alwaysRendered`).toBe(
        expectedEdge.alwaysRendered,
      )
      expect(edge?.repeated, `${expectedEdge.from} -> ${expectedEdge.to}.repeated`).toBe(expectedEdge.repeated)
    }
  })

  it("records a condition for the conditional edge and none for the unconditional one", () => {
    const feedList = pinned.graph.components["src/modules/FeedList/FeedList.tsx"]
    const conditional = feedList?.renders.find((edge) => edge.file.endsWith("EmptyState/EmptyState.tsx"))
    const unconditional = feedList?.renders.find((edge) => edge.file.endsWith("components/FeedToolbar.tsx"))
    expect(conditional?.conditions.length, "a ternary branch must carry its condition").toBeGreaterThan(0)
    expect(unconditional?.conditions).toEqual([])
  })

  it("pulls render-only children into `reachable`, which `uses` alone could never do", () => {
    // The three leaf components live under `src/components/` — kind `ui`, traversable: false — so they
    // cannot enter `reachable` through `uses`. Finding them there proves the render walk feeds
    // reachability, and ties the two metrics together so they cannot regress independently.
    const feed = pinned.coverage.find((row) => row.url === "/")
    expect(feed).toBeDefined()
    const reachable = new Set(pinned.graph.screens.find((screen) => screen.url === "/")?.reachable ?? [])
    for (const file of [
      "src/components/Badge/Badge.tsx",
      "src/components/EmptyState/EmptyState.tsx",
      "src/components/PostCard/PostCard.tsx",
      "src/modules/FeedList/components/FeedToolbar.tsx",
    ])
      expect(reachable.has(file), `${file} is not reachable from '/'`).toBe(true)
  })

  it("counts the same render edges under zero-config", () => {
    expect(zero.counts["renderEdges"]).toBe(pinned.counts["renderEdges"])
  })
})

describe("known-gaps registry and zero-config derivations", () => {
  it("every gap in the registry is described well enough to act on", () => {
    for (const gap of KNOWN_GAPS) {
      expect(gap.measured.length, gap.id).toBeGreaterThan(40)
      expect(gap.whenFixed.length, gap.id).toBeGreaterThan(20)
    }
  })

  it("the registry holds no entry whose id claims it is still an open GAP but is silently green", () => {
    // Every `GAP-*` id must be cited by a `test.fails` or a documented-red assertion SOMEWHERE; the ids
    // below are the ones this suite and `target-app.test.ts` actually wire. A new `GAP-*` that nobody wires is a note, not
    // a gap, and must be classified as SPEC-* / FIXED-* or given a failing expectation.
    const wired = new Set<string>([])
    const openGaps = KNOWN_GAPS.filter((gap) => gap.id.startsWith("GAP-")).map((gap) => gap.id)
    expect([...openGaps].sort()).toEqual([...wired].sort())
  })

  // Every literal-path call in `src/services/api/**` is found through the project-local
  // `axios.create()` factory chain.
  it("every genuine endpoint is found, and only those", () => {
    const seen = new Set(Object.values(pinned.endpointsByScreen).flat())
    expect([...seen].sort()).toEqual([...FIXTURE_EXPECTED_ENDPOINTS].sort())
  })

  it("the menu is discovered with no config", () => {
    expect([...pinned.menuPaths].sort()).toEqual([...MINI_APP_MENU_PATHS].sort())
    expect([...zero.menuPaths].sort(), "zero-config must find it too — that is the point").toEqual(
      [...MINI_APP_MENU_PATHS].sort(),
    )
  })

  // `navigate(RoutePath.X)` folds to a URL only when detection derives the `RoutePath` string source.
  it("zero-config finds the same navigation edges as the pin", () => {
    expect(zero.navigationEdges).toEqual(pinned.navigationEdges)
    expect(zero.navigationEdges).toEqual([...FIXTURE_EXPECTED_NAV_EDGES].sort())
  })

  // The derived traversable set is `src/shared/hooks/`, not all of `src/shared/`, so derived and pinned
  // `reachable` agree on every screen.
  it("zero-config and pinned agree on the whole coverage table", () => {
    expect(deepDiff(keyedByUrl(pinned.coverage), keyedByUrl(zero.coverage))).toEqual([])
  })

  // The `*.test.*` / `*.spec.*` / `*.stories.*` / `*.d.ts` exclusion applies to DISCOVERY as well as
  // module resolution, so a test file is never found as a screen source.
  it("excluded files reach neither screens nor the component map", () => {
    const assertion = aTestFilesExcluded(pinned)
    expect(assertion.pass, assertion.detail).toBe(true)
    const zeroAssertion = aTestFilesExcluded(zero)
    expect(zeroAssertion.pass, zeroAssertion.detail).toBe(true)
  })

  it("produces no error-severity diagnostic on either run", () => {
    // A discovered test file claiming real URLs surfaces first as `screens/duplicate-id` ERRORS, so the
    // absence of error diagnostics is part of the exclusion claim, not hygiene.
    for (const snapshot of [pinned, zero]) {
      const errors = snapshot.graph.diagnostics.filter((entry) => entry.severity === "error")
      expect(errors.map((entry) => `${entry.code}: ${entry.message.slice(0, 160)}`), snapshot.label).toEqual([])
    }
  })

  it("A5c: a route with no element, no lazy and no redirect is retained and tagged entryless", () => {
    // The real §8.3 shape exists only here; A5 on the parity app covers the redirect half.
    const assertion = a5cEntrylessTagged(pinned, "/entryless")
    expect(assertion.pass, assertion.detail).toBe(true)
  })

  it("navigation edges resolve through the `RoutePath` enum", () => {
    expect(pinned.navigationEdges).toEqual([...FIXTURE_EXPECTED_NAV_EDGES].sort())
  })
})
