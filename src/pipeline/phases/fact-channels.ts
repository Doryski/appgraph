import type { FileFacts } from "../../core/model.js"
import { sortStrings, sortedUniqueBy } from "../../core/order.js"
import type { Fact, FactSpan } from "../../extractors/types.js"

export type MaskedComponentFact = {
  readonly tag: string
  readonly reason: string
}

export const asMaskedComponentFact = (value: unknown): MaskedComponentFact | null => {
  if (typeof value !== "object" || value === null) return null
  const record = value as Record<string, unknown>
  const tag = record["tag"]
  const reason = record["reason"]
  if (typeof tag !== "string") return null
  return { tag, reason: typeof reason === "string" ? reason : "masked" }
}

export const spanInside = (span: FactSpan | null, outer: FactSpan): boolean =>
  span !== null && span.pos >= outer.pos && span.end <= outer.end

export const emptyFacts = (file: string, component: string, kind: string): FileFacts => ({
  file,
  component,
  kind,
  renders: [],
  nullGuards: [],
  uses: [],
  hooks: [],
  stores: [],
  queryKeys: [],
  mutations: 0,
  endpoints: [],
  navigations: [],
  i18nNamespaces: [],
  testIds: [],
  formSchemas: [],
  formFields: [],
  featureGates: [],
  messages: [],
  extra: {},
})

/**
 * The channels `FileFacts` names as fields. Anything else an extractor emitted lands in `extra` — that is
 * how `messageHandlers` / `messageSends` / `unresolvedNavigations` reach the artifact without a schema
 * change per channel.
 *
 * Two channels are excluded because they describe the TOOL, not the app: `maskedComponents` drives the
 * §5.4 mask closure and is already reported as a `facts/masked` diagnostic, and
 * `testIdAttributeHistogram` feeds phase 0's attribute election, which `doctor` prints from the probe.
 * Neither is a fact about a screen, and putting them on every screen's `extra` would only add noise an
 * agent has to learn to ignore.
 */
export const NAMED_FACT_CHANNELS: ReadonlySet<string> = new Set([
  "renders",
  "nullGuards",
  "uses",
  "hooks",
  "stores",
  "queryKeys",
  "mutations",
  "endpoints",
  "navigations",
  "i18nNamespaces",
  "testIds",
  "formSchemas",
  "formFields",
  "featureGates",
  "messages",
  "maskedComponents",
  "testIdAttributeHistogram",
])

export const extraChannelsOf = (facts: readonly Fact[]): Readonly<Record<string, readonly unknown[]>> => {
  const channels = new Map<string, unknown[]>()

  for (const fact of facts) {
    if (NAMED_FACT_CHANNELS.has(fact.channel)) continue
    const bucket = channels.get(fact.channel)
    if (bucket === undefined) channels.set(fact.channel, [fact.value])
    else bucket.push(fact.value)
  }

  return Object.fromEntries(
    sortStrings([...channels.keys()]).map((channel): [string, readonly unknown[]] => [
      channel,
      sortedUniqueBy(channels.get(channel) ?? [], (value) => JSON.stringify(value) ?? String(value)),
    ]),
  )
}
