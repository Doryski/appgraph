import type { AppGraph, FileFacts, Screen } from "../src/core/model.js"
import { buildFixtureGraph } from "./fixture-graph.js"

export const LARGE_SCREEN_COUNT = 3000
export const LARGE_COMPONENT_COUNT = 3000
export const LARGE_FAR_SCREEN_ID = "screen-bulk-2500"
export const LARGE_FAR_SCREEN_LABEL = "/bulk/page-2500"
export const LARGE_FAR_COMPONENT = "BulkComponent2500"

const pad = (n: number) => String(n).padStart(4, "0")

const bulkScreen = (template: Screen, i: number): Screen => {
  const id = `screen-bulk-${pad(i)}`
  const url = `/bulk/page-${pad(i)}`
  return {
    ...template,
    id,
    localId: id,
    url,
    title: `Bulk screen ${pad(i)}`,
    activations: [{ kind: "url", template: url, params: [] }],
    params: [],
    navigatesTo: [],
    facts: { ...template.facts, navigations: [] },
  }
}

const bulkComponent = (template: FileFacts, i: number): readonly [string, FileFacts] => {
  const file = `src/bulk/BulkComponent${pad(i)}.tsx`
  return [file, { ...template, file, component: `BulkComponent${pad(i)}`, renders: [], uses: [] }]
}

export const buildLargeFixtureGraph = (): AppGraph => {
  const base = buildFixtureGraph()
  const screenTemplate = base.screens.find((screen) => screen.kindTag === null && screen.tree.length > 0)!
  const componentTemplate = Object.values(base.components)[0]!
  const bulkScreens = Array.from({ length: LARGE_SCREEN_COUNT }, (_, i) => bulkScreen(screenTemplate, i))
  const bulkComponents = Object.fromEntries(Array.from({ length: LARGE_COMPONENT_COUNT }, (_, i) => bulkComponent(componentTemplate, i)))
  return {
    ...base,
    meta: { ...base.meta, counts: { screens: LARGE_SCREEN_COUNT, components: LARGE_COMPONENT_COUNT } },
    screens: bulkScreens,
    components: bulkComponents,
    navGroups: [],
    navigation: [],
    deadNavLinks: [],
    orphanScreens: [],
    redirects: [],
  }
}
