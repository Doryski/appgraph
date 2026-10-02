import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import type { ScreenDraft, ScreenSource } from "../../src/adapters/types.js"
import type { FactExtractor } from "../../src/extractors/types.js"
import { confidenceStatus } from "../../src/core/confidence.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { VueCompiler, VueModuleLoad } from "../../src/core/vue-compiler.js"
import type { TemplateCompilerApis } from "../../src/core/template-frameworks.js"
import type { AnalyzeInternalOptions, AnalyzeResult, PipelinePhase } from "../../src/pipeline/run.js"
import { PIPELINE_PHASES, analyze } from "../../src/pipeline/run.js"
import {
  TEMPLATE_COMPILER_MISSING_CODE,
  TEMPLATE_COMPILER_UNSUPPORTED_CODE,
} from "../../src/pipeline/template-frameworks.js"
import { EXIT_DIAGNOSTIC_ERROR, EXIT_NO_SCREENS } from "../../src/pipeline/exit-codes.js"
import { ROOT, TSCONFIG, adapterFor, codes, evidence, fileOf, run, staticSource } from "./harness.js"

const APP = `
import Sidebar from "./Sidebar"
import Table from "./Table"

export default function Invoices() {
  return (
    <div>
      <Sidebar />
      {ready && <Table />}
    </div>
  )
}
`

const SIDEBAR = `export default function Sidebar() { return <nav /> }`
const TABLE = `export default function Table() { return <table /> }`

const FILES = {
  "src/pages/Invoices.tsx": APP,
  "src/pages/Sidebar.tsx": SIDEBAR,
  "src/pages/Table.tsx": TABLE,
}

/** Globs its screens out of the project, the way a real file-convention adapter does. */
const globSource: ScreenSource = {
  name: "test-pages",
  detect: () => ({ score: 100, evidence: [] }),
  discover: (ctx) =>
    ctx
      .glob("src/pages/Invoices.tsx")
      .map((file) => ({
        localId: ctx.localId(file),
        activations: [{ kind: "url" as const, template: "/invoices/", params: [] }],
        entries: [{ kind: "file" as const, file, exportName: "default" }],
        evidence: [ctx.evidence("fixture page", file)],
        title: "Invoices",
      })),
}

// A router-less MV3 extension's ONLY navigation is the MessageType chain, so a projection that drops
// the channel silently deletes the whole edge graph of the extension.
const MESSAGE_FILES = {
  "src/pages/Popup.tsx": `
enum MessageType {
  OpenPopup = "OPEN_POPUP",
  AuthDone = "AUTH_DONE",
}

export default function Popup() {
  chrome.runtime.sendMessage({ type: MessageType.OpenPopup })

  const handle = (message: { type: string }) => {
    switch (message.type) {
      case MessageType.AuthDone:
        return 1
      default:
        return 0
    }
  }

  return <main onClick={() => handle({ type: "x" })} />
}
`,
}

const messageSource: ScreenSource = {
  name: "test-popup",
  detect: () => ({ score: 100, evidence: [] }),
  discover: (ctx) => [
    {
      localId: ctx.localId("src/pages/Popup.tsx"),
      activations: [{ kind: "state" as const, holder: "Popup", expr: "open" }],
      entries: [{ kind: "file" as const, file: "src/pages/Popup.tsx", exportName: "default" }],
      evidence: [ctx.evidence("fixture popup", "src/pages/Popup.tsx")],
    },
  ],
}

describe("projection carries the messages and extra fact channels", () => {
  it("lands MessageType names on screen facts and the handler/send edges in extra", () => {
    const result = run({ files: MESSAGE_FILES, adapters: [adapterFor(messageSource)], formats: ["full"] })

    const screen = result.graph.screens[0]
    expect(screen?.facts.messages).toEqual(["AUTH_DONE", "OPEN_POPUP"])
    expect(Object.keys(screen?.facts.extra ?? {})).toEqual(["messageHandlers", "messageSends"])

    const component = result.graph.components["src/pages/Popup.tsx"]
    expect(component?.messages).toEqual(["AUTH_DONE", "OPEN_POPUP"])
    expect(Object.keys(component?.extra ?? {})).toEqual(["messageHandlers", "messageSends"])

    const yaml = fileOf(result, "appgraph.yaml")
    expect(yaml).toContain("OPEN_POPUP")
    expect(yaml).toContain("AUTH_DONE")
    expect(yaml).toContain("messageHandlers")
    expect(yaml).toContain("messageSends")
  })

  it("keeps the tool's own control channels out of extra", () => {
    const result = run({ files: MESSAGE_FILES, adapters: [adapterFor(messageSource)], formats: ["full"] })
    const keys = Object.keys(result.graph.components["src/pages/Popup.tsx"]?.extra ?? {})

    expect(keys).not.toContain("maskedComponents")
    expect(keys).not.toContain("testIdAttributeHistogram")
  })
})

describe("pipeline/run", () => {
  it("walks the tree, aggregates facts and emits", () => {
    const result = run({ files: FILES, adapters: [adapterFor(globSource)], formats: ["full", "index"] })

    expect(result.exitCode).toBe(0)
    expect(result.emptyResult).toBe(false)
    expect(result.graph.screens).toHaveLength(1)

    const screen = result.graph.screens[0]
    // `normalizeUrl` canonicalises the trailing slash away, and the id IS the canonical URL.
    expect(screen?.id).toBe("/invoices")
    expect(screen?.url).toBe("/invoices")
    expect(screen?.title).toBe("Invoices")
    expect(screen?.source).toBe("test-pages")
    expect(screen?.provenance.sources).toEqual(["test-pages"])

    expect(screen?.tree[0]?.file).toBe("src/pages/Invoices.tsx")
    expect(screen?.tree[0]?.children.map((child) => child.file)).toEqual([
      "src/pages/Sidebar.tsx",
      "src/pages/Table.tsx",
    ])
    expect(screen?.reachable).toContain("src/pages/Table.tsx")

    expect(result.files.map((file) => file.path)).toEqual(["appgraph.index.yaml", "appgraph.yaml"])
    expect(fileOf(result, "appgraph.yaml")).toContain("/invoices")
  })

  it("is deterministic and writes no timestamp", () => {
    const first = run({ files: FILES, adapters: [adapterFor(globSource)], formats: ["all"] })
    const second = run({ files: FILES, adapters: [adapterFor(globSource)], formats: ["all"] })

    expect(first.files).toEqual(second.files)
    expect(fileOf(first, "appgraph.yaml")).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it("orders emitted formats and screens independently of registration order", () => {
    const a: ScreenDraft = {
      localId: "src/b.tsx",
      activations: [{ kind: "url", template: "/b", params: [] }],
      entries: [],
      evidence: [],
    }
    const b: ScreenDraft = { ...a, localId: "src/a.tsx", activations: [{ kind: "url", template: "/a", params: [] }] }

    const result = run({ files: FILES, adapters: [adapterFor(staticSource("test-static", [a, b]))] })
    expect(result.graph.screens.map((screen) => screen.id)).toEqual(["/a", "/b"])
  })

  it("fails loudly on zero screens and writes no artifact", () => {
    const empty: ScreenSource = {
      name: "test-empty",
      detect: () => ({ score: 100, evidence: [] }),
      discover: (ctx) => {
        ctx.glob("src/routes/**/*.tsx")
        ctx.nearMiss("src/App.tsx", "createBrowserRouter literal")
        return []
      },
    }

    const result = run({
      files: FILES,
      adapters: [adapterFor(empty)],
      detections: [{ source: "test-empty", score: 90, live: true, evidence: [evidence("src/App.tsx")] }],
    })

    expect(result.exitCode).toBe(EXIT_NO_SCREENS)
    expect(result.files).toEqual([])
    expect(result.emptyResult).toBe(true)
    expect(result.trace).toContain("appgraph found no screens.")
    expect(result.trace).toContain("src/routes/**/*.tsx -> 0 match(es)")
    expect(result.trace).toContain("createBrowserRouter literal")
    expect(result.trace).toContain("unwrap-baked helpers")
  })

  // A partial map an agent will trust is worse than no map at all.
  it("writes NOTHING when the multi-source refusal fired, even though screens were found", () => {
    const refusal = "2 screen sources matched in repo. appgraph will not guess which one you meant."
    const result = run({
      files: FILES,
      adapters: [adapterFor(globSource)],
      formats: ["full", "index", "html"],
      refusal,
    })

    expect(result.graph.screens).toHaveLength(1)
    expect(result.refused).toBe(true)
    expect(result.files).toEqual([])
    expect(result.exitCode).not.toBe(0)
    expect(result.trace).toContain(refusal)
    expect(result.trace).toContain("No output file was written.")
    // The same shape as the zero-screen trace: what was resolved, what ran, what was probed.
    expect(result.trace).toContain("root:")
    expect(result.trace).toContain("sources run:")
  })

  it("keeps refusing to write under allowEmpty — the run is ambiguous, not empty", () => {
    const result = run({
      files: FILES,
      adapters: [adapterFor(globSource)],
      config: { allowEmpty: true },
      formats: ["full"],
      refusal: "2 screen sources matched.",
    })

    expect(result.files).toEqual([])
    expect(result.emptyResult).toBe(false)
    expect(result.graph.meta.emptyResult).toBeUndefined()
  })

  it("writes an unambiguously marked zero-screen artifact under allowEmpty", () => {
    const result = run({
      files: FILES,
      adapters: [adapterFor(staticSource("test-empty", []))],
      config: { allowEmpty: true },
      formats: ["full"],
    })

    expect(result.exitCode).toBe(EXIT_NO_SCREENS)
    expect(result.emptyResult).toBe(true)
    expect(result.graph.meta.emptyResult).toBe(true)
    expect(result.graph.meta.emptyReason).toBe("no screen source produced a draft")

    const yaml = fileOf(result, "appgraph.yaml")
    expect(yaml).toContain("emptyResult: true")
    expect(yaml).toContain("screens: []")
  })

  describe("API-route-only apps", () => {
    const draftOf = (localId: string, template: string, kindTag?: string): ScreenDraft => ({
      localId,
      activations: [{ kind: "url", template, params: [] }],
      entries: [],
      evidence: [],
      ...(kindTag ? { kindTag } : {}),
    })
    const apiOnly = () => [adapterFor(staticSource("test-api", [draftOf("app/api/items/route.ts", "/api/items", "apiRoute")]))]
    const REASON = "only API routes or redirects were found, no page screen"

    it("fails loudly like a zero-screen run and names the reason", () => {
      const result = run({ files: FILES, adapters: apiOnly(), formats: ["full"] })

      expect(result.graph.screens).toHaveLength(1)
      expect(result.exitCode).toBe(EXIT_NO_SCREENS)
      expect(result.files).toEqual([])
      expect(result.emptyResult).toBe(true)
      expect(result.trace).toContain("appgraph found no screens.")
      expect(result.trace).toContain(`Reason: ${REASON}.`)
    })

    it("writes a marked artifact under allowEmpty", () => {
      const result = run({ files: FILES, adapters: apiOnly(), config: { allowEmpty: true }, formats: ["full"] })

      expect(result.exitCode).toBe(EXIT_NO_SCREENS)
      expect(result.emptyResult).toBe(true)
      expect(result.graph.meta.emptyResult).toBe(true)
      expect(result.graph.meta.emptyReason).toBe(REASON)
      expect(fileOf(result, "appgraph.yaml")).toContain("emptyResult: true")
    })

    it("exits 0 when a page sits next to the API route", () => {
      const result = run({
        files: FILES,
        adapters: [
          adapterFor(
            staticSource("test-mixed", [
              draftOf("app/api/items/route.ts", "/api/items", "apiRoute"),
              draftOf("app/page.tsx", "/"),
            ]),
          ),
        ],
        formats: ["full"],
      })

      expect(result.exitCode).toBe(0)
      expect(result.emptyResult).toBe(false)
      expect(result.graph.meta.emptyResult).toBeUndefined()
    })
  })

  it("contains an adapter throw as one diagnostic and keeps the other source", () => {
    const broken: ScreenSource = {
      name: "test-broken",
      detect: () => ({ score: 100, evidence: [] }),
      discover: () => {
        throw new Error("boom")
      },
    }

    const result = run({ files: FILES, adapters: [adapterFor(broken), adapterFor(globSource)] })

    expect(result.graph.screens).toHaveLength(1)
    expect(codes(result)).toContain("plugin/threw")
    const threw = result.diagnostics.find((diagnostic) => diagnostic.code === "plugin/threw")
    expect(threw?.plugin).toBe("test-broken")
    expect(threw?.message).toContain("boom")
  })

  it("runs the shipped fact extractors by default", () => {
    const files = {
      ...FILES,
      "src/pages/Invoices.tsx": `
import Sidebar from "./Sidebar"

export default function Invoices() {
  return (
    <div data-testid="invoices-root">
      <Sidebar />
    </div>
  )
}
`,
    }

    const result = run({ files, adapters: [adapterFor(globSource)] })
    expect(result.graph.screens[0]?.facts.testIds).toContain("invoices-root")
    expect(result.graph.meta.confidence.map((entry) => entry.section)).toContain("testIds")
  })

  /**
   * 1 endpoint across 99 screens must not report `level=high`, i.e. `ok`. An
   * `enablingDependency` cannot catch it (that route to `suspect` needs `count === 0`), so
   * the rule is size-aware instead.
   */
  it("reports a per-screen channel that is tiny relative to the screen count as partial, not ok", () => {
    const screens = Array.from({ length: 12 }, (_unused, index) => ({
      localId: `src/screens/s${String(index)}.tsx`,
      activations: [{ kind: "url" as const, template: `/s${String(index)}`, params: [] }],
      entries: [{ kind: "file" as const, file: `src/screens/s${String(index)}.tsx`, exportName: "default" }],
      evidence: [],
    }))

    const files = Object.fromEntries(
      screens.map((screen) => [screen.localId, "export default function S() { return <div /> }\n"]),
    )

    let emitted = 0
    const oneEndpoint: FactExtractor = {
      name: "one-endpoint",
      provides: ["endpoints"],
      enter: (_node, ctx) => {
        if (emitted > 0) return
        emitted += 1
        ctx.emitFact("endpoints", { method: "GET", url: "/api/only", transport: "http", client: null })
      },
    }

    const result = run({
      files,
      adapters: [adapterFor(staticSource("many-screens", screens))],
      extractors: [oneEndpoint],
    })

    const endpoints = result.graph.meta.confidence.find((entry) => entry.section === "endpoints")
    expect(result.graph.screens.length).toBe(12)
    expect(endpoints?.count).toBe(1)
    expect(endpoints?.level).toBe("low")
    expect(confidenceStatus(endpoints ?? { section: "endpoints", count: 0, enablingDependency: null, dependencyInstalled: false, level: "low" })).toBe("partial")
    expect(codes(result)).toContain("confidence/sparse-section")
  })

  it("exits 1 on an error diagnostic with or without strict, exactly as the CLI does", () => {
    const opaque = staticSource("test-opaque", [
      {
        localId: "src/x.tsx",
        activations: [{ kind: "url", template: "/x", params: [] }],
        entries: [{ kind: "opaque", expr: "registry.get(key)", file: "src/x.tsx", line: 4 }],
        evidence: [],
      },
    ])

    const loose = run({ files: FILES, adapters: [adapterFor(opaque)] })
    expect(loose.diagnostics.some((entry) => entry.severity === "error")).toBe(true)
    expect(loose.exitCode).toBe(EXIT_DIAGNOSTIC_ERROR)

    const strict = run({ files: FILES, adapters: [adapterFor(opaque)], config: { strict: true } })
    expect(strict.exitCode).toBe(EXIT_DIAGNOSTIC_ERROR)
  })
})

describe("empty-section confidence considers every provider of a channel", () => {
  const emitsOnce = (name: string, enablingDependency?: string): FactExtractor => {
    let emitted = false
    return {
      name,
      provides: ["endpoints"],
      ...(enablingDependency === undefined ? {} : { enablingDependency }),
      enter: (_node, ctx) => {
        if (emitted) return
        emitted = true
        ctx.emitFact("endpoints", { method: "GET", url: `/api/${name}`, transport: "http", client: null })
      },
    }
  }

  const silent = (name: string, enablingDependency: string | readonly string[], provides: FactExtractor["provides"]): FactExtractor => ({
    name,
    provides,
    enablingDependency,
  })

  const confidenceOf = (result: ReturnType<typeof run>, section: string) =>
    result.graph.meta.confidence.find((entry) => entry.section === section)

  it("names an installed dependency of a LATER provider when the channel is empty", () => {
    const result = run({
      files: FILES,
      adapters: [adapterFor(globSource)],
      extractors: [silent("first", "not-installed", ["stores"]), silent("second", "react", ["stores"])],
    })

    const stores = confidenceOf(result, "stores")
    expect(stores).toMatchObject({ enablingDependency: "react", dependencyInstalled: true, level: "suspect" })
    expect(result.diagnostics.find((entry) => entry.code === "confidence/empty-section")?.message).toBe(
      "section 'stores' produced no facts while 'react' is installed",
    )
  })

  it("keeps an always-on provider's section unprobed when no gated dependency is installed", () => {
    const result = run({
      files: FILES,
      adapters: [adapterFor(globSource)],
      extractors: [emitsOnce("http"), silent("convex", "convex", ["endpoints"])],
    })

    expect(confidenceOf(result, "endpoints")).toMatchObject({ enablingDependency: null, dependencyInstalled: false })
    expect(codes(result)).not.toContain("confidence/empty-section")
  })

  it("warns about an installed extractor that found nothing while a sibling filled its sections", () => {
    const result = run({
      files: FILES,
      adapters: [adapterFor(globSource)],
      extractors: [emitsOnce("http"), silent("convex", "react", ["endpoints"])],
    })

    expect(confidenceOf(result, "endpoints")).toMatchObject({ enablingDependency: "react", level: "high" })
    expect(result.diagnostics.find((entry) => entry.code === "confidence/empty-section")?.message).toContain(
      "extractor 'convex' produced no facts while 'react' is installed",
    )
  })

  it("treats an array dependency as installed when ANY entry is installed", () => {
    const result = run({
      files: FILES,
      adapters: [adapterFor(globSource)],
      extractors: [silent("multi", ["not-installed", "react"], ["stores"])],
    })

    expect(confidenceOf(result, "stores")).toMatchObject({
      enablingDependency: "react",
      dependencyInstalled: true,
      level: "suspect",
    })
    expect(result.diagnostics.find((entry) => entry.code === "confidence/empty-section")?.message).toBe(
      "section 'stores' produced no facts while 'react' is installed",
    )
  })

  it("is not installed when no array entry is installed, naming the first", () => {
    const result = run({
      files: FILES,
      adapters: [adapterFor(globSource)],
      extractors: [silent("multi", ["not-installed", "also-missing"], ["stores"])],
    })

    expect(confidenceOf(result, "stores")).toMatchObject({
      enablingDependency: "not-installed",
      dependencyInstalled: false,
      level: "low",
    })
  })
})

describe("config 'extractors'", () => {
  const named = (name: string): FactExtractor => ({ name, provides: [name === "a" ? "stores" : "hooks"] })

  it("runs only the named extractors and drops the rest from confidence", () => {
    const result = run({
      files: FILES,
      adapters: [adapterFor(globSource)],
      extractors: [named("a"), named("b")],
      config: { extractors: ["a"] },
    })

    const sections = result.graph.meta.confidence.map((entry) => entry.section)
    expect(sections).toContain("stores")
    expect(sections).not.toContain("hooks")
    expect(codes(result)).not.toContain("config/unknown-extractor")
  })

  it("reports a name no registered extractor carries, listing the known ones", () => {
    const result = run({
      files: FILES,
      adapters: [adapterFor(globSource)],
      extractors: [named("a"), named("b")],
      config: { extractors: ["a", "nope"] },
    })

    const diagnostic = result.diagnostics.find((entry) => entry.code === "config/unknown-extractor")
    expect(diagnostic?.severity).toBe("error")
    expect(diagnostic?.message).toContain("'nope'")
    expect(diagnostic?.message).toContain("Known: a, b")
  })
})

describe("vue compiler loading inside analyze()", () => {
  const VUE_CODES = [TEMPLATE_COMPILER_MISSING_CODE, TEMPLATE_COMPILER_UNSUPPORTED_CODE]

  const fakeCompiler = (version: string): VueCompiler => ({
    parse: (_source, options) => ({
      descriptor: { filename: options.filename, template: null, script: null, scriptSetup: null },
      errors: [],
    }),
    version,
  })

  const analyzeWith = (
    dependencies: Readonly<Record<string, string>>,
    vueCompiler: TemplateCompilerApis["vue"],
    extra: Readonly<Record<string, string>> = {},
  ): Promise<AnalyzeResult> =>
    analyze({
      ts,
      root: ROOT,
      host: createMemoryHost({
        files: {
          [`${ROOT}/package.json`]: JSON.stringify({ name: "fixture", dependencies }),
          [`${ROOT}/tsconfig.json`]: TSCONFIG,
          ...Object.fromEntries(
            Object.entries({ ...FILES, ...extra }).map(([file, text]) => [`${ROOT}/${file}`, text]),
          ),
        },
      }),
      adapters: [adapterFor(globSource)],
      ...(vueCompiler === undefined ? {} : { templateCompilers: { vue: vueCompiler } }),
    })

  const vueDiagnostics = (result: AnalyzeResult) => result.diagnostics.filter((entry) => VUE_CODES.includes(entry.code))

  it("warns exactly once when the compiler is missing and keeps the run successful", async () => {
    const load = vi.fn<VueModuleLoad>(() => {
      throw new Error("Cannot find module 'vue/compiler-sfc'")
    })
    const result = await analyzeWith({ vue: "^3.5.0" }, load, { "src/App.vue": "<template><div /></template>" })

    expect(load).toHaveBeenCalled()
    expect(vueDiagnostics(result)).toEqual([expect.objectContaining({ severity: "warning", code: TEMPLATE_COMPILER_MISSING_CODE })])
    expect(vueDiagnostics(result)[0]?.message).toMatch(/^Vue compiler \(vue\/compiler-sfc\) could not be loaded/)
    expect(vueDiagnostics(result)[0]?.message).toContain("template facts skipped; install vue in the project")
    expect(result.exitCode).toBe(0)
    expect(result.detection.templateCompilers).toEqual([{ framework: "vue", status: "missing", version: null, from: null }])
  })

  it("treats an explicit null as a missing compiler", async () => {
    const result = await analyzeWith({ nuxt: "^3.12.0" }, null)

    expect(codes(result).filter((code) => code === TEMPLATE_COMPILER_MISSING_CODE)).toHaveLength(1)
    expect(result.exitCode).toBe(0)
  })

  it("reports a Vue 2 manifest as unsupported without loading the compiler", async () => {
    const load = vi.fn<VueModuleLoad>(() => fakeCompiler("3.5.43"))
    const result = await analyzeWith({ vue: "^2.7.16" }, load)

    expect(load).not.toHaveBeenCalled()
    expect(vueDiagnostics(result)).toEqual([expect.objectContaining({ severity: "warning", code: TEMPLATE_COMPILER_UNSUPPORTED_CODE })])
    expect(result.detection.templateCompilers).toEqual([{ framework: "vue", status: "unsupported", version: "2.x", from: null }])
    expect(result.exitCode).toBe(0)
  })

  it("reports a compiler outside the supported range as unsupported", async () => {
    const result = await analyzeWith({ vue: "^3.3.0" }, fakeCompiler("3.3.4"))

    expect(codes(result).filter((code) => code === TEMPLATE_COMPILER_UNSUPPORTED_CODE)).toHaveLength(1)
    expect(vueDiagnostics(result)[0]?.message).toMatch(/^Vue 3\.3\.4 is outside the supported range >=3\.4\.0 <4\.0\.0/)
    expect(result.detection.templateCompilers).toEqual([{ framework: "vue", status: "unsupported", version: "3.3.4", from: null }])
  })

  it("records a loaded compiler without any diagnostic", async () => {
    const result = await analyzeWith({ vue: "^3.5.0" }, fakeCompiler("3.5.43"))

    expect(vueDiagnostics(result)).toEqual([])
    expect(result.detection.templateCompilers).toEqual([{ framework: "vue", status: "loaded", version: "3.5.43", from: "project" }])
  })

  it("ignores a stray .vue file in a project without a vue dependency", async () => {
    const load = vi.fn<VueModuleLoad>(() => {
      throw new Error("not installed")
    })
    const result = await analyzeWith({ react: "19.0.0" }, load, { "src/Widget.vue": "<template><p /></template>" })

    expect(load).not.toHaveBeenCalled()
    expect(vueDiagnostics(result)).toEqual([])
    expect(result.detection.templateCompilers).toEqual([])
  })

  it("never calls the loader for a React project", async () => {
    const load = vi.fn<VueModuleLoad>(() => fakeCompiler("3.5.43"))
    const result = await analyzeWith({ react: "19.0.0", "react-router-dom": "6.0.0" }, load)

    expect(load).not.toHaveBeenCalled()
    expect(vueDiagnostics(result)).toEqual([])
    expect(result.detection.templateCompilers).toEqual([])
  })
})

describe("analyze() phase timing, html loading and host caching", () => {
  const files = {
    [`${ROOT}/package.json`]: JSON.stringify({ name: "fixture" }),
    [`${ROOT}/tsconfig.json`]: TSCONFIG,
    ...Object.fromEntries(Object.entries(FILES).map(([file, text]) => [`${ROOT}/${file}`, text])),
  }

  const analyzeFixture = (extra: Partial<AnalyzeInternalOptions> = {}): Promise<AnalyzeResult> =>
    analyze({
      ts,
      root: ROOT,
      host: createMemoryHost({ files }),
      adapters: [adapterFor(globSource)],
      config: { formats: ["index"] },
      ...extra,
    })

  const tickingClock = () => {
    const state = { now: 0 }
    return () => {
      state.now += 5
      return state.now
    }
  }

  it("reports every phase except the masked walk exactly once, in pipeline order, with the injected clock", async () => {
    const seen: { readonly name: PipelinePhase; readonly ms: number }[] = []
    await analyzeFixture({ onPhase: (name, ms) => seen.push({ name, ms }), clock: tickingClock() })

    expect(seen.map((entry) => entry.name)).toEqual(PIPELINE_PHASES.filter((phase) => phase !== "walk-masked"))
    expect(seen.every((entry) => entry.ms > 0)).toBe(true)
  })

  it("produces the same result with or without a phase listener", async () => {
    const plain = await analyzeFixture()
    const timed = await analyzeFixture({ onPhase: () => undefined, clock: tickingClock() })

    expect(timed.files).toEqual(plain.files)
    expect(timed.diagnostics).toEqual(plain.diagnostics)
  })

  it("renders the html format through the lazily loaded renderer", async () => {
    const result = await analyzeFixture({ config: { formats: ["html", "index"] } })

    expect(result.files.map((file) => file.path)).toEqual(["appgraph.html", "appgraph.index.yaml"])
    expect(fileOf(result, "appgraph.html")).toContain("<html")
    expect(codes(result)).not.toContain("emit/unknown-format")
  })

  it("reads each file at most once through the caching host", async () => {
    const inner = createMemoryHost({ files })
    const reads = new Map<string, number>()
    const counting = {
      ...inner,
      readFile: (abs: string) => {
        reads.set(abs, (reads.get(abs) ?? 0) + 1)
        return inner.readFile(abs)
      },
    }
    await analyzeFixture({ host: counting })

    expect([...reads.values()].every((count) => count === 1)).toBe(true)
    expect(reads.size).toBeGreaterThan(0)
  })
})
