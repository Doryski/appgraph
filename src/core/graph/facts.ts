import type { FileFacts, ScreenFacts } from "../model.js"
import { sortedRecord, sortedUniqueBy } from "../order.js"

export const EMPTY_SCREEN_FACTS: ScreenFacts = {
  endpoints: [],
  navigations: [],
  stores: [],
  queryKeys: [],
  mutations: 0,
  i18nNamespaces: [],
  testIds: [],
  formSchemas: [],
  formFields: [],
  featureGates: [],
  hooks: [],
  messages: [],
  extra: {},
}

const extraValueKey = (value: unknown): string => JSON.stringify(value) ?? String(value)

export const mergeExtraChannels = (facts: readonly FileFacts[]): Readonly<Record<string, readonly unknown[]>> => {
  const channels = new Map<string, unknown[]>()
  for (const file of facts) {
    for (const [channel, values] of Object.entries(file.extra)) {
      const bucket = channels.get(channel)
      if (bucket === undefined) channels.set(channel, [...values])
      else bucket.push(...values)
    }
  }
  return sortedRecord(
    Object.fromEntries(
      [...channels].map(([channel, values]): [string, readonly unknown[]] => [
        channel,
        sortedUniqueBy(values, extraValueKey),
      ]),
    ),
  )
}

export const emptyFileFacts = (file: string, component: string): FileFacts => ({
  file,
  component,
  kind: "other",
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
