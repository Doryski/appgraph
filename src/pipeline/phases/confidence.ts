import type { FactChannel, SectionConfidence } from "../../core/model.js"
import type { FactExtractor } from "../../extractors/types.js"
import { dependenciesOf } from "../../extractors/types.js"
import type { FactSource } from "./facts.js"

/**
 * Channels whose expected size is the SCREEN COUNT, not one. A per-screen channel is the only kind
 * where a small non-zero count is evidence of a broken run rather than a small app.
 */
export const SCREEN_SCALED_CHANNELS: readonly string[] = ["endpoints"]

/** Fewer than one fact per this many screens is `partial`, never `ok`. */
export const SPARSE_SCREEN_RATIO = 10

/**
 * Chosen over giving `endpoints` an `enablingDependency`, and the choice is forced: the dependency
 * route to `suspect` only fires while `count === 0`, so it could not catch `endpoints count=1`
 * on a 99-screen admin panel. There is also no single package to name;
 * endpoints come from axios, from bare `fetch` and from `createServerFn` alike. Scale is the only
 * signal that separates "this app has few endpoints" from "the extractor never saw the data layer".
 */
export const isSparseForScale = (section: string, count: number, screenCount: number): boolean =>
  count > 0 && SCREEN_SCALED_CHANNELS.includes(section) && count * SPARSE_SCREEN_RATIO < screenCount

/** Every extractor feeding one channel: their enabling dependencies, and whether any runs unconditionally. */
export type ChannelProviders = {
  readonly dependencies: readonly string[]
  readonly alwaysOn: boolean
}

export const ALWAYS_ON: ChannelProviders = { dependencies: [], alwaysOn: true }

/**
 * ALL providers count, not the first: `endpoints` is fed by http-client, server-fn AND convex, and keying
 * the section on whichever registered first made convex's `enablingDependency` unreachable.
 */
export const providersByChannel = (extractors: readonly FactExtractor[]): ReadonlyMap<FactChannel, ChannelProviders> => {
  const providers = new Map<FactChannel, ChannelProviders>()
  for (const extractor of extractors)
    for (const channel of extractor.provides) {
      const current = providers.get(channel) ?? { dependencies: [], alwaysOn: false }
      const declared = dependenciesOf(extractor)
      providers.set(channel, {
        dependencies: [...current.dependencies, ...declared.filter((dependency) => !current.dependencies.includes(dependency))],
        alwaysOn: current.alwaysOn || declared.length === 0,
      })
    }
  return providers
}

/**
 * The installed dependencies name the section when there are any. Otherwise an always-on provider means
 * there is nothing to probe, and a section with only gated providers keeps naming its first one.
 */
export const probeOf = (
  providers: ChannelProviders,
  installed: (dependency: string) => boolean,
): Pick<SectionConfidence, "enablingDependency" | "dependencyInstalled"> => {
  const present = providers.dependencies.filter(installed)
  if (present.length > 0) return { enablingDependency: present.join(", "), dependencyInstalled: true }
  if (providers.alwaysOn) return { enablingDependency: null, dependencyInstalled: false }
  return { enablingDependency: providers.dependencies[0] ?? null, dependencyInstalled: false }
}

export const installedPhrase = (dependencies: readonly string[]): string =>
  `${dependencies.map((dependency) => `'${dependency}'`).join(", ")} ${dependencies.length > 1 ? "are" : "is"} installed`

/**
 * An extractor whose library is installed yet which found nothing, hidden because a sibling filled every
 * section it shares (a Convex app whose endpoints all came from axios). A section that is empty outright
 * already warned on its own, so this fires only when none of the extractor's sections did.
 */
export const silentExtractors = (
  extractors: readonly FactExtractor[],
  facts: FactSource,
  installed: (dependency: string) => boolean,
): readonly { readonly extractor: FactExtractor; readonly present: readonly string[] }[] =>
  extractors
    .map((extractor) => ({ extractor, present: dependenciesOf(extractor).filter(installed) }))
    .filter(
      ({ extractor, present }) =>
        present.length > 0 &&
        facts.extractorCount(extractor.name) === 0 &&
        extractor.provides.every((channel) => facts.channelCount(channel) > 0),
    )
