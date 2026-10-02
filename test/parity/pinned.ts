import type { AnalyzeResult } from "../../src/pipeline/run.js"
import { analyze } from "../../src/pipeline/run.js"
import type { AppgraphConfig } from "../../src/core/model.js"
import { DEFAULT_WRAPPER_RULES } from "../../src/adapters/react-router.js"
import { createBuiltinAdapters } from "../../src/pipeline/registry.js"

/**
 * §12.4's pinned run: every value the reference implementation is given explicitly, as appgraph config.
 *
 * The config has two halves:
 *
 *   generic          `PINNED_BASE` below — depth 3, the react-router source, `src` as the source root,
 *                    `data-testid`, and the reference route wrappers and layout tag (as wrapper roles)
 *   target-specific  the string sources and the directory -> kind rules in first-match-wins order. These
 *                    describe one application's layout, so each target supplies its own: the synthetic
 *                    fixture in `fixture/mini-app.ts`, the real checkout in its untracked pointer
 *                    (`target.ts`)
 *
 * WHAT CANNOT BE PINNED, and why that matters for the zero-config comparison:
 *
 *   - the router FILE. `AppgraphConfig` has no `router` key: the react-router source globs for
 *     `createBrowserRouter` (`ROUTER_FACTORIES` in the react-router adapter). Naming
 *     `screenSources: ['react-router']` pins WHICH source runs, not which file it reads. The comparison
 *     is therefore weaker than §12.4 describes on this one axis — it cannot distinguish "detection found
 *     the right router file" from "there is only one router file to find".
 *   - the menu source. `AppgraphConfig` has no `nav` key, so both runs discover the menu through
 *     nav-source scoring and their agreement says nothing about which menu file was read. That is why
 *     the menu is asserted separately against the golden's items.
 */
export const PINNED_BASE = {
  formats: ["full", "index", "html"],
  depth: 3,
  // A bare run is single-source too (a nested package never scores for the root), so this pins the
  // choice rather than suppressing a refusal.
  screenSources: ["react-router"],
  // The reference implementation roots every path rule at `<root>/src`.
  sourceRoots: ["src"],
  testIdAttribute: "data-testid",
} as const satisfies AppgraphConfig

/** The full pinned config for one target: the generic half plus that target's own string sources and kind rules. */
export const pinnedConfig = (targetSpecific: AppgraphConfig): AppgraphConfig => ({ ...PINNED_BASE, ...targetSpecific })

/** The pinned run. `adapters` is how wrapper roles get named — there is no config key. */
export const runPinned = async (root: string, targetSpecific: AppgraphConfig): Promise<AnalyzeResult> =>
  analyze({
    root,
    config: pinnedConfig(targetSpecific),
    // The reference route wrappers and layout tag, as appgraph's wrapper-role vocabulary.
    adapters: createBuiltinAdapters({ wrapperRoles: DEFAULT_WRAPPER_RULES }),
    timestamp: null,
  })

/** The zero-config run: `analyze({ root })` and NOTHING else. Any extra option here invalidates the test. */
export const runZeroConfig = async (root: string): Promise<AnalyzeResult> => analyze({ root })
