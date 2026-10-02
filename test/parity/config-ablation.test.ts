/**
 * What each pinned config key moves, measured one key at a time.
 *
 * "Zero-config != pinned-config" is useless as a finding on its own — the pinned config names six things
 * and any of them could be the cause. This ablation runs the fixture once per pinned key and asserts
 * WHICH key moves WHICH number, so a §12.4 zero-config divergence names a specific missing derivation
 * (§10.5) instead of a vague difference.
 *
 * Two keys depend on derivation doing real work:
 *
 *   stringSources  `navigate(RoutePath.X)` folds to a URL only when detection finds
 *                  `src/shared/routing/routePaths.ts` on its own; both runs then produce the same 2 edges.
 *   kindRules      the derived traversable set is `src/shared/hooks/`, not all of `src/shared/`, so the
 *                  derived run reaches exactly the files the pin does.
 *
 * Asserting the AGREEMENT per key keeps a derivation regression attributable to one key instead of
 * showing up as an unexplained zero-config diff on the real target.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { analyze } from "../../src/pipeline/run.js"
import type { AppgraphConfig } from "../../src/core/model.js"
import { materializeMiniApp, removeMiniApp } from "./fixture/materialize.js"
import { pinnedConfig } from "./pinned.js"
import { MINI_APP_PINNED_CONFIG } from "./fixture/mini-app.js"
import { FIXTURE_EXPECTED_NAV_EDGES } from "./fixture/expected.js"

let root = ""

type Ablation = {
  readonly navigationEdges: readonly string[]
  readonly reachableForPosts: number
}

const run = async (config: AppgraphConfig | undefined): Promise<Ablation> => {
  const result = await analyze({ root, ...(config === undefined ? {} : { config }) })
  const posts = result.graph.screens.find((screen) => screen.url === "/posts")
  return {
    navigationEdges: result.graph.navigation
      .map((edge) => `${edge.from} -> ${edge.to} via ${edge.via} (${edge.trigger})`)
      .sort(),
    reachableForPosts: posts?.reachable.length ?? -1,
  }
}

let zero: Ablation
beforeAll(async () => {
  root = materializeMiniApp()
  zero = await run(undefined)
}, 120_000)

afterAll(() => {
  if (root !== "") removeMiniApp(root)
})

describe("what each pinned key moves, one key at a time", () => {
  it("`stringSources` moves NOTHING — detection derives the same `RoutePath` source", async () => {
    // The edges require the `RoutePath` enum to be folded to a URL, so this is not vacuous: it is the
    // derivation doing the pin's work. Asserting the edges themselves rather than just equality means a
    // derivation that finds the file but reads it wrong still fails.
    expect(zero.navigationEdges).toEqual([...FIXTURE_EXPECTED_NAV_EDGES].sort())

    const withStrings = await run({ stringSources: MINI_APP_PINNED_CONFIG.stringSources })
    expect(withStrings.navigationEdges).toEqual(zero.navigationEdges)
  })

  it("`kindRules` moves NOTHING — the derived traversable set reproduces the pinned one", async () => {
    // Equal, and non-zero, so an over-traversal of `src/shared/` fails, and an accidental collapse of
    // `reachable` to 0 fails rather than trivially matching.
    const withKindRules = await run({ kindRules: MINI_APP_PINNED_CONFIG.kindRules })
    expect(withKindRules.reachableForPosts).toBe(zero.reachableForPosts)
    expect(zero.reachableForPosts).toBeGreaterThan(0)
  })

  it("`depth`, `sourceRoots`, `testIdAttribute` and `screenSources` move nothing on this fixture", async () => {
    const neutral: readonly AppgraphConfig[] = [
      { depth: 3 },
      { sourceRoots: ["src"] },
      { testIdAttribute: "data-testid" },
      { screenSources: ["react-router"] },
    ]
    for (const config of neutral) {
      const result = await run(config)
      expect(result, JSON.stringify(config)).toEqual(zero)
    }
  })

  it("the whole pinned config together moves nothing — zero-config holds key-by-key AND in combination", async () => {
    // The claim §12.4 makes on the real repo, checked here where it is cheap. Ablating one key
    // at a time cannot catch two derivations that are individually right and jointly wrong.
    const withEverything = await run(pinnedConfig(MINI_APP_PINNED_CONFIG))
    expect(withEverything).toEqual(zero)
  })
})
