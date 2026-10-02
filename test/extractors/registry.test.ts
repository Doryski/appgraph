import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import ts from "typescript"
import { createExtractContext, createRegistry } from "../../src/extractors/registry.js"
import { anchorOf, createTagMask } from "../../src/extractors/types.js"
import type { TemplateDoc } from "../../src/core/template-doc.js"
import { EMPTY_TEMPLATE_TAGS } from "../../src/core/template-doc.js"
import type { TemplateFrameworkSpec } from "../../src/core/template-frameworks.js"
import { bindingTableFor } from "../../src/extractors/imported-declaration.js"
import type { FactExtractor } from "../../src/extractors/types.js"
import { createDefaultExtractors } from "../../src/pipeline/registry.js"
import { createMemoryHost } from "../../src/core/host.js"
import { resolveConfig } from "../../src/config/types.js"
import type { Adapter } from "../../src/adapters/types.js"
import { createEnv } from "../../src/pipeline/context.js"
import type { PipelineEnv } from "../../src/pipeline/context.js"
import { createFactSource, discover } from "../../src/pipeline/phases.js"
import { createPipelineRegistry } from "../../src/pipeline/registry.js"
import { ROOT, maskedValuesOf, parse, realVueCompiler, run, runVue, valuesOf } from "./harness.js"

const collector = (name: string, channel: string): FactExtractor => ({
  name,
  provides: [channel],
  enter: (node, ctx) => {
    if (ctx.ts.isStringLiteral(node)) ctx.emitFact(channel, node.text)
  },
})

const testIds: FactExtractor = {
  name: "test-ids",
  provides: ["testIds"],
  enter: (node, ctx) => {
    if (!ctx.ts.isJsxOpeningElement(node) && !ctx.ts.isJsxSelfClosingElement(node)) return
    const value = ctx.ast.attributeString(node, "data-testid", ctx.strings)
    if (value !== null) ctx.emitFact("testIds", value)
  },
}

describe("phase graph — prepass settles string folding before any main extractor asks", () => {
  const folded: FactExtractor = {
    name: "folded",
    provides: ["queryKeys"],
    requires: ["stringConstants"],
    enter: (node, ctx) => {
      const call = ctx.ast.asCallExpression(node)
      if (call === null || call !== node) return
      if (ctx.ast.asIdentifier(call.expression)?.text !== "track") return
      const flat = ctx.flattenString(call.arguments[0])
      if (flat !== null) ctx.emitFact("queryKeys", flat.value)
    },
  }

  it("folds a constant DECLARED BELOW its use — the silent-drop failure the phase graph prevents", () => {
    const result = run([folded], ["track(KEY)", "const KEY = '/orders'"].join("\n"))
    expect(valuesOf(result, "queryKeys")).toEqual(["/orders"])
  })

  it("folds a constant defined in terms of two constants declared after it", () => {
    const result = run(
      [folded],
      [
        "track(FULL)",
        "const FULL = `${BASE}${SUFFIX}`",
        "const BASE = '/api'",
        "const SUFFIX = '/orders'",
      ].join("\n"),
    )

    expect(valuesOf(result, "queryKeys")).toEqual(["/api/orders"])
  })

  it("still reports null for something that genuinely is not a string", () => {
    const result = run([folded], ["const KEY = someRuntimeThing", "track(KEY)"].join("\n"))
    expect(valuesOf(result, "queryKeys")).toEqual([])
  })
})

describe("phase graph — stage ordering and lifecycle", () => {
  const order: string[] = []

  const trace = (name: string, stage: FactExtractor["stage"]): FactExtractor => ({
    name,
    provides: [`channel-${name}`],
    ...(stage === undefined ? {} : { stage }),
    start: () => order.push(`${name}:start`),
    enter: () => {
      if (!order.includes(`${name}:enter`)) order.push(`${name}:enter`)
    },
    finish: () => order.push(`${name}:finish`),
  })

  it("runs prepass walk+finish, then the shared main walk, then every finalize", () => {
    order.length = 0
    run([trace("m", "main"), trace("p", "prepass"), trace("f", "finalize")], "const a = 1")

    expect(order).toEqual([
      "m:start",
      "p:start",
      "f:start",
      "p:enter",
      "p:finish",
      "m:enter",
      "m:finish",
      "f:finish",
    ])
  })

  it("walks the file exactly once for all main extractors regardless of extractor count", () => {
    let nodes = 0
    const counting = (name: string): FactExtractor => ({
      name,
      provides: [name],
      enter: () => {
        nodes += 1
      },
    })

    const source = parse("const a = 1")
    createRegistry({ extractors: [counting("a")] }).run(
      createExtractContext({ ts, file: "src/File.tsx", source }),
    )
    const total = nodes
    nodes = 0
    createRegistry({ extractors: [counting("a"), counting("b"), counting("c")] }).run(
      createExtractContext({ ts, file: "src/File.tsx", source }),
    )

    expect(nodes).toBe(total * 3)
  })
})

describe("registry — enable/disable resolution", () => {
  const a = collector("a", "stores")
  const b = collector("b", "hooks")

  it("keeps registration order", () => {
    expect(createRegistry({ extractors: [b, a] }).extractors.map((entry) => entry.name)).toEqual(["b", "a"])
  })

  it("honours an allow-list, a deny-list and a disabled channel", () => {
    expect(createRegistry({ extractors: [a, b], enabled: ["b"] }).extractors.map((e) => e.name)).toEqual(["b"])
    expect(createRegistry({ extractors: [a, b], disabled: ["b"] }).extractors.map((e) => e.name)).toEqual(["a"])
    expect(
      createRegistry({ extractors: [a, b], disabledChannels: ["stores"] }).extractors.map((e) => e.name),
    ).toEqual(["b"])
  })

  it("skips an extractor requiring a channel no prepass provides, with an error diagnostic", () => {
    const registry = createRegistry({
      extractors: [{ name: "needs", provides: ["stores"], requires: ["enumTable"] }],
    })

    expect(registry.extractors).toEqual([])
    expect(registry.diagnostics[0]).toMatchObject({
      severity: "error",
      code: "plugin/missing-requirement",
      plugin: "needs",
    })
  })

  it("accepts a requirement satisfied by a registered prepass extractor", () => {
    const registry = createRegistry({
      extractors: [
        { name: "enums", provides: ["enumTable"], stage: "prepass" },
        { name: "needs", provides: ["stores"], requires: ["enumTable"] },
      ],
    })

    expect(registry.extractors.map((entry) => entry.name)).toEqual(["enums", "needs"])
  })

  it("rejects a duplicate name and reports it", () => {
    const registry = createRegistry({ extractors: [a, { ...b, name: "a" }] })
    expect(registry.extractors).toHaveLength(1)
    expect(registry.diagnostics[0]?.code).toBe("plugin/duplicate-name")
  })

  it("skips a whole file for an extractor whose `accepts` gate says no", () => {
    const gated: FactExtractor = { ...testIds, accepts: (handle) => handle.file.endsWith(".jsx") }
    const code = '<div data-testid="row" />'

    expect(valuesOf(run([testIds], code), "testIds")).toEqual(["row"])
    expect(valuesOf(run([gated], code), "testIds")).toEqual([])
  })
})

describe("registry — error containment", () => {
  it("turns a throwing extractor into one diagnostic and keeps the other channels", () => {
    const broken: FactExtractor = {
      name: "broken",
      provides: ["stores"],
      enter: () => {
        throw new Error("boom")
      },
    }

    const result = run([broken, testIds], '<div data-testid="row" />')

    expect(valuesOf(result, "testIds")).toEqual(["row"])
    expect(result.diagnostics.some((entry) => entry.code === "plugin/threw" && entry.plugin === "broken")).toBe(
      true,
    )
  })
})

describe("masking — DevStatesPreview", () => {
  const mask = createTagMask({
    name: "dev-preview-mask",
    tags: ["DevStatesPreview"],
    reason: "dev-only preview; its data-testids are not selectors for the shipping UI",
  })

  const code = [
    "export const Content = () => (",
    "  <div data-testid='content-root'>",
    "    <DevStatesPreview>",
    "      <div data-testid='dialog-preview-error' />",
    "      <span data-testid='dialog-preview-loading' />",
    "    </DevStatesPreview>",
    "  </div>",
    ")",
  ].join("\n")

  it("drops facts emitted inside the masked subtree and keeps everything outside it", () => {
    const result = run([testIds, mask], code)

    expect(valuesOf(result, "testIds")).toEqual(["content-root"])
    expect(maskedValuesOf(result, "testIds")).toEqual(["dialog-preview-error", "dialog-preview-loading"])
  })

  it("emits one info facts/masked diagnostic naming the reason, file and line", () => {
    const result = run([testIds, mask], code)
    const diagnostic = result.diagnostics.find((entry) => entry.code === "facts/masked")

    expect(diagnostic).toMatchObject({ severity: "info", plugin: "dev-preview-mask", file: "src/File.tsx" })
    expect(diagnostic?.message).toContain("dev-only preview")
    expect(diagnostic?.line).toBe(3)
  })

  it("records the masked component so a consumer can suppress its own file too", () => {
    const result = run([testIds, mask], code)
    expect(valuesOf(result, "maskedComponents")).toEqual([
      {
        tag: "DevStatesPreview",
        reason: "dev-only preview; its data-testids are not selectors for the shipping UI",
        channels: "all",
      },
    ])
  })

  it("masks only the named channels when the decision names channels", () => {
    const narrow = createTagMask({
      name: "narrow",
      tags: ["DevStatesPreview"],
      reason: "preview",
      channels: ["stores"],
    })

    const result = run([testIds, narrow], code)
    expect(valuesOf(result, "testIds")).toHaveLength(3)
  })

  it("never masks structure — renders, uses and nullGuards survive an `all` mask", () => {
    const structural: FactExtractor = {
      name: "structural",
      provides: ["renders"],
      enter: (node, ctx) => {
        if (!ctx.ts.isJsxSelfClosingElement(node)) return
        ctx.emitFact("renders", {
          file: "src/Child.tsx",
          conditions: [],
          alwaysRendered: true,
          repeated: false,
        })
      },
    }

    const result = run([structural, mask], code)
    expect(valuesOf(result, "renders")).toHaveLength(2)
    expect(result.masked).toHaveLength(0)
  })

  it("unions the channels of overlapping masks and records the innermost reason first", () => {
    const outer = createTagMask({ name: "outer", tags: ["Outer"], reason: "outer reason" })
    const inner = createTagMask({ name: "inner", tags: ["Inner"], reason: "inner reason" })

    const nested = [
      "export const App = () => (",
      "  <Outer>",
      "    <Inner>",
      "      <div data-testid='deep' />",
      "    </Inner>",
      "  </Outer>",
      ")",
    ].join("\n")

    const result = run([testIds, outer, inner], nested)

    expect(valuesOf(result, "testIds")).toEqual([])
    expect(result.masked[0]?.reasons).toEqual(["inner reason", "outer reason"])
  })

  it("cannot be un-masked: a later extractor emitting the same fact is still dropped", () => {
    const second: FactExtractor = { ...testIds, name: "test-ids-2" }
    const result = run([testIds, mask, second], code)

    expect(valuesOf(result, "testIds")).toEqual(["content-root", "content-root"])
  })
})

/**
 * The host boundary: `typescript` reaches an extractor only as `ctx.ts`, and every file an
 * extractor looks at reaches it through the resolver — which reads through the injected `FileHost`.
 * A direct `ts.sys.readFile` / `node:fs` call would make one extractor see a different filesystem
 * than the resolver did, and would break every hermetic and virtual-filesystem run.
 */
describe("the host boundary — no extractor touches the filesystem itself", () => {
  const directory = new URL("../../src/extractors/", import.meta.url)
  const files = readdirSync(directory).filter((name) => name.endsWith(".ts"))

  it("has extractor sources to check", () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(files)("%s reads no file outside the injected host", (name) => {
    const source = readFileSync(new URL(name, directory), "utf8")

    expect(source).not.toContain("node:fs")
    expect(source).not.toContain("sys.readFile")
    expect(source).not.toContain("readFileSync")
  })
})

describe("built-in extractor registration", () => {
  it("runs convex right after query, so query keeps the first claim on queryKeys and mutations confidence", () => {
    const names = createDefaultExtractors().map((extractor) => extractor.name)
    expect(names.indexOf("convex")).toBe(names.indexOf("query") + 1)
  })
})

const componentTags: FactExtractor = {
  name: "component-tags",
  provides: ["uses"],
  template: (doc, ctx) => {
    for (const element of doc.elements)
      if (element.kind === "component") ctx.emitFact("testIds", element.tag, { pos: element.pos, end: element.end })
  },
}

const SFC = [
  "<script setup lang=\"ts\">",
  "const greeting = 'hi'",
  "</script>",
  "",
  "<template>",
  "  <div>",
  "    <UserCard :name=\"greeting\" />",
  "  </div>",
  "</template>",
].join("\n")

describe("template hook — .vue templates feed the same extractors (AS4)", () => {
  it("anchors a template fact to the line of its element in the .vue file", () => {
    const result = runVue([componentTags], SFC)

    expect(result.facts).toMatchObject([{ channel: "testIds", value: "UserCard", line: 7, file: "src/File.vue" }])
  })

  it("runs after the TS walk and before finish", () => {
    const order: string[] = []
    const lifecycle: FactExtractor = {
      name: "lifecycle",
      provides: ["uses"],
      enter: (node, ctx) => {
        if (ctx.ts.isSourceFile(node)) order.push("enter")
      },
      template: () => order.push("template"),
      finish: () => order.push("finish"),
    }

    runVue([lifecycle], SFC)

    expect(order).toEqual(["enter", "template", "finish"])
  })

  it("never lets a script mask drop a template fact, even when the mask span covers its offset", () => {
    const sfc = ["<template>", "  <UserCard />", "</template>", "<script setup>", "const a = 'x'", "</script>"].join("\n")
    const maskFirstStatement: FactExtractor = {
      name: "mask-first-statement",
      provides: ["maskedComponents"],
      mask: (node, ctx) => (ctx.ts.isVariableStatement(node) ? { channels: "all", reason: "script mask" } : null),
    }
    const scriptIds: FactExtractor = {
      name: "script-ids",
      provides: ["testIds"],
      enter: (node, ctx) => {
        if (ctx.ts.isStringLiteral(node)) ctx.emitFact("testIds", node.text)
      },
    }

    const result = runVue([maskFirstStatement, scriptIds, componentTags], sfc)
    const templatePos = sfc.indexOf("<UserCard")

    expect(result.masks[0]?.span.pos).toBeLessThanOrEqual(templatePos)
    expect(valuesOf(result, "testIds")).toEqual(["UserCard"])
    expect(maskedValuesOf(result, "testIds")).toEqual(["x"])
  })

  it("turns a throwing template hook into plugin/threw and keeps the other extractors' facts", () => {
    const broken: FactExtractor = {
      name: "broken-template",
      provides: ["stores"],
      template: () => {
        throw new Error("bad template")
      },
    }

    const result = runVue([broken, componentTags], SFC)

    expect(valuesOf(result, "testIds")).toEqual(["UserCard"])
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "plugin/threw", plugin: "broken-template", message: "template: bad template" }),
    )
  })

  it("never calls a template hook without a compiler", () => {
    const calls: string[] = []
    const spy: FactExtractor = { name: "spy", provides: ["uses"], template: () => calls.push("template") }

    const result = runVue([spy], SFC, { compiler: null })

    expect(calls).toEqual([])
    expect(result.facts).toEqual([])
  })

  it("never calls a template hook for a non-.vue file", () => {
    const calls: string[] = []
    const spy: FactExtractor = { name: "spy", provides: ["uses"], template: () => calls.push("template") }

    run([spy], "export const a = 1")

    expect(calls).toEqual([])
  })

  it("parses a template expression so script constants fold through flattenString", () => {
    const sfc = [
      "<script setup>",
      "const BASE = '/users'",
      "</script>",
      "<template>",
      "  <RouterLink :to=\"BASE + '/new'\" />",
      "</template>",
    ].join("\n")
    const links: FactExtractor = {
      name: "links",
      provides: ["queryKeys"],
      template: (doc, ctx) => {
        for (const element of doc.elements)
          for (const attribute of element.attributes) {
            if (attribute.expression === null) continue
            const flat = ctx.flattenString(ctx.templateExpression(attribute.expression) ?? undefined)
            if (flat !== null) ctx.emitFact("queryKeys", flat.value, { pos: attribute.pos, end: attribute.pos })
          }
      },
    }

    expect(valuesOf(runVue([links], sfc), "queryKeys")).toEqual(["/users/new"])
  })

  it("returns null for template expression text that is not one expression", () => {
    let parsed: unknown = "unset"
    const probe: FactExtractor = {
      name: "probe",
      provides: ["uses"],
      template: (_doc, ctx) => {
        parsed = ctx.templateExpression("a) + (b")
      },
    }

    runVue([probe], SFC)

    expect(parsed).toBeNull()
  })
})

const vueEnv = (files: Readonly<Record<string, string>>): PipelineEnv =>
  createEnv({
    ts,
    templates: { vue: realVueCompiler() },
    config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }),
    host: createMemoryHost({
      files: Object.fromEntries(Object.entries(files).map(([file, text]) => [`${ROOT}/${file}`, text])),
    }),
  })

const PUG_SFC = ["<template lang=\"pug\">", "div", "</template>", "<script setup>", "const a = 1", "</script>"].join("\n")
const SRC_SFC = ["<template><div /></template>", "<script src=\"./logic.ts\"></script>"].join("\n")

describe("facts/unsupported-template — aggregated once per framework per run", () => {
  it("reports one info listing at most five files plus a count", () => {
    const files = {
      ...Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`src/Pug${String(index)}.vue`, PUG_SFC])),
      "src/Src.vue": SRC_SFC,
      "src/Plain.vue": SFC,
    }
    const facts = createFactSource({ env: vueEnv(files), extractors: [componentTags], kindRules: [] })
    for (const file of Object.keys(files)) facts.factsOf(file)

    const reported = facts.diagnostics().filter((entry) => entry.code === "facts/unsupported-template")

    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({ severity: "info", plugin: null })
    expect(reported[0]?.message).toMatch(/^Vue templates in 7 file\(s\) use features appgraph cannot read/)
    expect(reported[0]?.message).toContain("src/Pug0.vue (pug)")
    expect(reported[0]?.message).toContain("(+2 more)")
    expect(reported[0]?.message).not.toContain("src/Plain.vue")
  })

  it("names script-src for a .vue whose script is external", () => {
    const facts = createFactSource({ env: vueEnv({ "src/Src.vue": SRC_SFC }), extractors: [componentTags], kindRules: [] })
    facts.factsOf("src/Src.vue")

    expect(facts.diagnostics().find((entry) => entry.code === "facts/unsupported-template")?.message).toContain(
      "src/Src.vue (script-src)",
    )
  })

  it("stays silent when every .vue file is readable", () => {
    const facts = createFactSource({ env: vueEnv({ "src/Plain.vue": SFC }), extractors: [componentTags], kindRules: [] })
    facts.factsOf("src/Plain.vue")

    expect(facts.diagnostics()).toEqual([])
  })
})

describe("ambient components — adapters' auto-imported names reach ctx.resolveTag", () => {
  const ambientProbe: FactExtractor = {
    name: "ambient-probe",
    provides: ["ambient"],
    template: (doc, ctx) => {
      for (const element of doc.elements)
        if (element.kind === "component") ctx.emitFact("ambient", { tag: element.tag, hit: ctx.resolveTag(doc, element) })
    },
  }

  const adapter = (name: string, entries: readonly { name: string; file: string }[]): Adapter => ({
    name,
    ambientComponents: () => entries,
  })

  const page = ["<template>", "  <UserCard />", "  <lazy-user-card />", "  <SharedName />", "  <Missing />", "</template>"].join(
    "\n",
  )

  it("merges every adapter's list, resolves kebab and Lazy tags, and drops cross-adapter collisions", () => {
    const env = vueEnv({ "src/Page.vue": page })
    const registry = createPipelineRegistry({
      adapters: [
        adapter("one", [
          { name: "UserCard", file: "src/components/UserCard.vue" },
          { name: "SharedName", file: "src/a/SharedName.vue" },
        ]),
        adapter("two", [{ name: "SharedName", file: "src/b/SharedName.vue" }]),
      ],
    })
    discover({ env, registry })

    const facts = createFactSource({ env, extractors: [ambientProbe], kindRules: [] })

    expect(facts.factsOf("src/Page.vue").extra["ambient"]).toEqual([
      { tag: "Missing", hit: null },
      { tag: "SharedName", hit: null },
      { tag: "UserCard", hit: { kind: "file", file: "src/components/UserCard.vue", exportName: "default", via: "ambient" } },
      { tag: "lazy-user-card", hit: { kind: "file", file: "src/components/UserCard.vue", exportName: "default", via: "lazy" } },
    ])
  })

  it("contains a throwing ambientComponents hook as plugin/threw", () => {
    const env = vueEnv({ "src/Page.vue": page })
    const broken: Adapter = {
      name: "broken-ambient",
      ambientComponents: () => {
        throw new Error("no index")
      },
    }

    discover({ env, registry: createPipelineRegistry({ adapters: [broken] }) })

    expect(env.diagnostics.all()).toContainEqual(
      expect.objectContaining({ code: "plugin/threw", plugin: "broken-ambient", message: "ambientComponents: no index" }),
    )
  })
})

describe("registry — a failure outside any one extractor (C9)", () => {
  it("turns a throw while preparing the file into a plugin/threw diagnostic instead of aborting", () => {
    const input = createExtractContext({ ts, file: "src/File.tsx", source: parse("<div data-testid=\"row\" />") })
    const failing = Object.defineProperty({ ...input }, "bindings", {
      get: () => {
        throw new RangeError("Maximum call stack size exceeded")
      },
    })

    const result = createRegistry({ extractors: [testIds] }).run(failing)

    expect(result.facts).toEqual([])
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        code: "plugin/threw",
        message: "extract: Maximum call stack size exceeded; the file's facts are dropped",
        plugin: null,
        file: "src/File.tsx",
      },
    ])
  })

  it("prepares strings, bindings and null guards lazily, inside the contained run", () => {
    const input = createExtractContext({ ts, file: "src/File.tsx", source: parse("const A = '/a'") })
    expect(input.strings.constants.get("A")).toBe("/a")
    expect(input.bindings).toBe(input.bindings)
  })
})

describe("binding tables — one per declaring file (C18)", () => {
  it("shares the table between the pipeline env, the registry and cross-file proofs", () => {
    const source = parse("import { x } from './x'")
    const resolveModule = (): string | null => null
    const first = bindingTableFor(ts, source, resolveModule)

    expect(bindingTableFor(ts, source, resolveModule)).toBe(first)
    expect(createExtractContext({ ts, file: "src/File.tsx", source, resolveModule }).bindings).toBe(first)
  })
})

const WIDGET_SCRIPT = "export default function Widget() { return null }"

const htmlDoc = (file: string): TemplateDoc => ({
  framework: "angular",
  file,
  owner: "Widget",
  partial: false,
  elements: [
    {
      tag: "Child",
      names: ["Child"],
      kind: "component",
      pos: 0,
      end: 9,
      line: 12,
      attributes: [],
      guard: { condition: null, repeated: false, lazy: false },
      slotName: null,
    },
  ],
  expressions: [],
  unsupported: [],
})

const crossFile: FactExtractor = {
  name: "cross-file",
  provides: ["testIds"],
  template: (doc, ctx) => {
    for (const element of doc.elements) ctx.emitFact("testIds", element.tag, anchorOf(doc, element))
  },
}

const runWidget = (extractors: readonly FactExtractor[], docs: readonly TemplateDoc[]) =>
  createRegistry({ extractors }).run(
    createExtractContext({ ts, file: "src/widget.ts", source: parse(WIDGET_SCRIPT, "src/widget.ts"), templates: docs }),
  )

const htmlFramework = (docs: Readonly<Record<string, readonly TemplateDoc[]>>): TemplateFrameworkSpec<unknown> => ({
  id: "angular",
  label: "Html",
  packages: [],
  moduleKind: "esm",
  installHint: "",
  skippedNote: "",
  appliesTo: () => true,
  projectMajor: () => null,
  checkVersion: () => null,
  fallbackOnUnsupported: false,
  adapt: (module) => module,
  producer: () => ({
    framework: "angular",
    tags: EMPTY_TEMPLATE_TAGS,
    claims: (file) => file in docs,
    docsOf: (file) => docs[file] ?? [],
  }),
  tags: EMPTY_TEMPLATE_TAGS,
})

describe("cross-file template anchors", () => {
  it("gives a fact anchored in another file that file's line and an origin", () => {
    const result = runWidget([crossFile], [htmlDoc("src/widget.html")])

    expect(result.facts).toEqual([
      {
        channel: "testIds",
        value: "Child",
        extractor: "cross-file",
        file: "src/widget.ts",
        line: 12,
        span: { pos: 0, end: 9 },
        origin: "src/widget.html",
      },
    ])
  })

  it("adds no origin when the template lives in the extracted file", () => {
    const [fact] = runWidget([crossFile], [htmlDoc("src/widget.ts")]).facts

    expect(fact).toMatchObject({ file: "src/widget.ts", line: 12 })
    expect(fact).not.toHaveProperty("origin")
  })

  it("names the template's file on a template hook's diagnostics", () => {
    const noisy: FactExtractor = {
      name: "noisy",
      provides: ["uses"],
      template: (_doc, ctx) => {
        ctx.diagnostic({ severity: "info", code: "facts/masked", message: "seen" })
        throw new Error("boom")
      },
    }

    const result = runWidget([noisy], [htmlDoc("src/widget.html")])

    expect(result.diagnostics.map(({ code, file }) => [code, file])).toEqual([
      ["facts/masked", "src/widget.html"],
      ["plugin/threw", "src/widget.html"],
    ])
  })

  it("keeps a cross-file fact out of a subtree projection of the extracted file", () => {
    const env = createEnv({
      ts,
      frameworks: [htmlFramework({ "src/widget.ts": [htmlDoc("src/widget.html")] })],
      config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }),
      host: createMemoryHost({ files: { [`${ROOT}/src/widget.ts`]: WIDGET_SCRIPT } }),
    })
    const facts = createFactSource({ env, extractors: [crossFile], kindRules: [] })

    expect(facts.factsOf("src/widget.ts").testIds).toEqual(["Child"])
    expect(facts.subtreeFactsOf("src/widget.ts", { export: "default", path: [] })?.testIds).toEqual([])
  })
})
