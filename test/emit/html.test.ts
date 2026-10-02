import { describe, expect, it } from "vitest"
import type { AppGraph, FileFacts, Screen, ScreenFacts } from "../../src/core/model.js"
import { renderHtml } from "../../src/emit/html.js"
import { buildReportPayload, toSerializedPayload } from "../../src/emit/report-payload.js"

const HOSTILE_APP_NAME = "</title><script>alert(1)</script> $& $' __APPGRAPH_DATA__ __APPGRAPH_TITLE__"

const HOSTILE_TEXT = `</script><!-- <script>alert(1)</script> "quotes" 'apostrophes' \u2028 __APPGRAPH_PALETTE__ $&`

const STAMP = "2026-01-01T12:34:56.000Z"

const DATA_SCRIPT_PATTERN = /<script type="application\/json" id="appgraph-data">([\s\S]*?)<\/script>/g

const emptyFacts: ScreenFacts = {
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

const screenOf = (id: string, overrides: Partial<Screen> = {}): Screen => ({
  id,
  localId: `src/screens${id}.tsx`,
  source: "react-router",
  activations: [{ kind: "url", template: id, params: [] }],
  url: id,
  params: [],
  title: "Home",
  kindTag: null,
  entries: [{ kind: "file", file: `src/screens${id}.tsx`, exportName: "default" }],
  ancestors: [],
  shell: null,
  auth: "public",
  featureFlag: null,
  redirectTo: null,
  devOnly: false,
  addressable: true,
  tree: [],
  reachable: [],
  facts: emptyFacts,
  navigatesTo: [],
  provenance: { sources: ["react-router"], evidence: [], mergedFrom: [], decisions: [] },
  ...overrides,
})

const componentOf = (file: string, kind: string, endpoints: FileFacts["endpoints"] = []): FileFacts => ({
  file,
  component: file.slice(file.lastIndexOf("/") + 1, file.lastIndexOf(".")),
  kind,
  renders: [],
  nullGuards: [],
  uses: [],
  hooks: [],
  stores: [],
  queryKeys: [],
  mutations: 0,
  endpoints,
  navigations: [],
  i18nNamespaces: [],
  testIds: [],
  formSchemas: [],
  formFields: [],
  featureGates: [],
  messages: [],
  extra: {},
})

const baseMeta: AppGraph["meta"] = {
  schemaVersion: 2,
  appgraphVersion: "0.1.0",
  root: "frontend",
  appName: "frontend",
  sourceRoots: ["src"],
  screenSources: ["react-router"],
  maxDepth: 3,
  fingerprint: "fixture",
  counts: {},
  confidence: [],
  limitations: [],
}

const baseGraph: AppGraph = {
  meta: baseMeta,
  screens: [screenOf("/home")],
  redirects: [],
  shells: {},
  components: {},
  navGroups: [],
  navigation: [],
  deadNavLinks: [],
  orphanScreens: [],
  diagnostics: [],
}

const hostileTree: Screen["tree"] = [
  {
    file: "src/screens/Home.tsx",
    component: "Home",
    kind: "screen",
    conditions: [HOSTILE_TEXT],
    alwaysRendered: false,
    repeated: false,
    nullGuards: [HOSTILE_TEXT],
    children: [],
    truncated: false,
    repeat: false,
  },
]

const hostileGraph: AppGraph = {
  ...baseGraph,
  meta: { ...baseMeta, appName: HOSTILE_APP_NAME },
  screens: [screenOf("/home", { title: HOSTILE_TEXT, tree: hostileTree })],
}

const paletteGraph: AppGraph = {
  ...baseGraph,
  screens: [
    screenOf("/home", {
      facts: { ...emptyFacts, endpoints: [{ method: "POST", url: "/api/save", transport: "http", client: null }] },
    }),
  ],
  components: {
    "src/x.tsx": componentOf("src/x.tsx", "screen"),
    "src/y.tsx": componentOf("src/y.tsx", "totally-custom-kind", [
      { method: "call", url: "doThing", transport: "rpc", client: null },
      { method: "GET", url: "/api/x", transport: "http", client: "fetch" },
    ]),
  },
}

const quiet = { noTimestamp: true } as const

const occurrences = (text: string, token: string): number => text.split(token).length - 1

const dataScripts = (html: string): readonly string[] => [...html.matchAll(DATA_SCRIPT_PATTERN)].map((match) => match[1] ?? "")

const titleOf = (html: string): string | undefined => /<title>([\s\S]*?)<\/title>/.exec(html)?.[1]

const paletteOf = (html: string): string => /<style id="appgraph-palette">([\s\S]*?)<\/style>/.exec(html)?.[1] ?? ""

const colorOf = (palette: string, variable: string): string | undefined =>
  new RegExp(`${variable}:\\s*(#[0-9a-f]+)`).exec(palette)?.[1]

describe("renderHtml — escaping", () => {
  it("contains a hostile app name inside the title", () => {
    const html = renderHtml(hostileGraph, quiet)
    expect(occurrences(html, "</title>")).toBe(1)
    expect(titleOf(html)).toContain("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(titleOf(html)).toContain("$&amp; $&#39;")
    expect(titleOf(html)).toContain("__APPGRAPH_DATA__")
  })

  it("keeps hostile screen data inside one JSON script that round-trips to the payload", () => {
    const html = renderHtml(hostileGraph, { ...quiet, locale: "pl" })
    const scripts = dataScripts(html)
    expect(scripts).toHaveLength(1)
    const [json = ""] = scripts
    expect(json).not.toContain("</script")
    expect(json).not.toContain("<!--")
    expect(json).not.toMatch(/[<>&\u2028\u2029]/)
    expect(JSON.parse(json)).toEqual(toSerializedPayload(buildReportPayload(hostileGraph, { locale: "pl", generatedAt: null })))
  })

  it("never lets hostile data open a script tag", () => {
    const html = renderHtml(hostileGraph, quiet)
    expect(html).not.toContain("<script>alert(1)")
    for (const tag of html.match(/<script(?:\s[^>]*)?>/g) ?? []) expect(tag).not.toContain("alert")
  })

  it("fills every placeholder", () => {
    expect(renderHtml(baseGraph, quiet)).not.toContain("__APPGRAPH_")
    expect(renderHtml(baseGraph, { generatedAt: STAMP })).not.toContain("__APPGRAPH_")
  })
})

describe("renderHtml — palette", () => {
  const html = renderHtml(paletteGraph, quiet)
  const palette = paletteOf(html)
  const payload = buildReportPayload(paletteGraph, { locale: "en", generatedAt: null })

  it("declares a colour for every kind and every transport:method in the graph", () => {
    expect(payload.kinds.map((kind) => kind.key)).toEqual(["screen", "totally-custom-kind"])
    expect(payload.methods.map((method) => method.key)).toEqual(["http:get", "http:post", "rpc:call"])
    for (const { slug } of payload.kinds) expect(palette).toContain(`--kind-color-${slug}:`)
    for (const { slug } of payload.methods) expect(palette).toContain(`--method-color-${slug}:`)
  })

  it("gives distinct kinds distinct colours and defines a dark variant", () => {
    const screenColor = colorOf(palette, "--kind-color-screen")
    expect(screenColor).toBeDefined()
    expect(screenColor).not.toBe(colorOf(palette, "--kind-color-totally-custom-kind"))
    expect(palette).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[^}]*--kind-color-screen:/)
    expect(palette).toContain(":root[data-theme='dark']")
  })

  it("keeps the palette style free of markup", () => {
    expect(palette).not.toContain("<")
  })
})

describe("renderHtml — determinism and timestamp", () => {
  it("is byte-identical across renders under noTimestamp", () => {
    expect(renderHtml(hostileGraph, { ...quiet, generatedAt: STAMP })).toBe(
      renderHtml(hostileGraph, { ...quiet, generatedAt: STAMP }),
    )
  })

  it("omits the timestamp under noTimestamp even when generatedAt is passed", () => {
    expect(renderHtml(baseGraph, { ...quiet, generatedAt: STAMP })).not.toContain(STAMP)
    expect(renderHtml(baseGraph)).toBe(renderHtml(baseGraph, quiet))
  })

  it("embeds the timestamp when provided", () => {
    const html = renderHtml(baseGraph, { generatedAt: STAMP })
    expect(html).toContain(STAMP)
    const [json = ""] = dataScripts(html)
    expect(JSON.parse(json).meta.generatedAt).toBe(STAMP)
  })
})

describe("renderHtml — locale", () => {
  it.each([
    { locale: "en", title: "frontend — screen &amp; component map" },
    { locale: "pl", title: "frontend — mapa ścieżek i komponentów" },
  ] as const)("sets lang and title for $locale", ({ locale, title }) => {
    const html = renderHtml(baseGraph, { ...quiet, locale })
    expect(html).toContain(`<html lang="${locale}">`)
    expect(titleOf(html)).toBe(title)
  })

  it("defaults to English", () => {
    expect(renderHtml(baseGraph, quiet)).toContain('<html lang="en">')
  })
})

describe("renderHtml — app name", () => {
  it("titles the report with meta.appName, not the root label", () => {
    const html = renderHtml({ ...baseGraph, meta: { ...baseMeta, appName: "@acme/admin", root: "admin-app" } }, quiet)
    expect(titleOf(html)).toBe("@acme/admin — screen &amp; component map")
  })

  it("falls back to meta.root when appName is null", () => {
    const html = renderHtml({ ...baseGraph, meta: { ...baseMeta, appName: null, root: "admin" } }, quiet)
    expect(titleOf(html)).toBe("admin — screen &amp; component map")
  })
})

describe("renderHtml — document shell", () => {
  it("restores the saved theme in <head> before the app mounts", () => {
    const html = renderHtml(baseGraph, quiet)
    const head = html.slice(0, html.indexOf("</head>"))
    expect(head).toContain("appgraph-theme")
    expect(html).toContain('<div id="root">')
  })
})
