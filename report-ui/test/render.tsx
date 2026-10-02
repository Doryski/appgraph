import { render } from "@testing-library/react"
import type { ReactElement } from "react"
import type { AppGraph, ScreenFacts } from "@appgraph/core/model.js"
import { buildReportPayload, serializePayload } from "@appgraph/emit/report-payload.js"
import type { Locale } from "@appgraph/emit/strings.js"

const PAYLOAD_ELEMENT_ID = "appgraph-data"

export const emptyScreenFacts: ScreenFacts = {
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

const baseGraph: AppGraph = {
  meta: {
    schemaVersion: 2,
    appgraphVersion: "0.0.0-test",
    root: "app",
    appName: null,
    sourceRoots: ["src"],
    screenSources: ["react-router"],
    maxDepth: 3,
    fingerprint: "fixture",
    counts: {},
    confidence: [],
    limitations: [],
  },
  screens: [],
  redirects: [],
  shells: {},
  components: {},
  navGroups: [],
  navigation: [],
  deadNavLinks: [],
  orphanScreens: [],
  diagnostics: [],
}

export const makeGraph = (overrides: Partial<AppGraph> = {}): AppGraph => ({ ...baseGraph, ...overrides })

type RenderOptions = {
  readonly locale?: Locale
  readonly generatedAt?: string | null
}

const injectPayload = (graph: AppGraph, { locale = "en", generatedAt = null }: RenderOptions) => {
  document.getElementById(PAYLOAD_ELEMENT_ID)?.remove()
  const script = document.createElement("script")
  script.type = "application/json"
  script.id = PAYLOAD_ELEMENT_ID
  script.textContent = serializePayload(buildReportPayload(graph, { locale, generatedAt }))
  document.body.appendChild(script)
}

export const renderWithPayload = (ui: ReactElement, graph: AppGraph = makeGraph(), options: RenderOptions = {}) => {
  injectPayload(graph, options)
  return render(ui)
}
