import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import { createDiagnosticCollector } from "../../src/core/diagnostics.js"
import type { AppGraph, FactChannel } from "../../src/core/model.js"
import { resolveConfig } from "../../src/config/types.js"
import type { Emitter, EmitFile } from "../../src/adapters/types.js"
import type { FactExtractor } from "../../src/extractors/types.js"
import { createEnv } from "../../src/pipeline/context.js"
import type { PipelineEnv } from "../../src/pipeline/context.js"
import { createPipelineRegistry } from "../../src/pipeline/registry.js"
import {
  ALL_FORMATS,
  SCREEN_SCALED_CHANNELS,
  SPARSE_SCREEN_RATIO,
  aggregate,
  emit,
  expandFormats,
  isSparseForScale,
  probeOf,
  providersByChannel,
} from "../../src/pipeline/phases.js"
import type { AggregateInput, FactSource } from "../../src/pipeline/phases.js"
import { ROOT } from "./harness.js"

const extractor = (name: string, provides: readonly FactChannel[], enablingDependency?: string | readonly string[]): FactExtractor => ({
  name,
  provides,
  ...(enablingDependency === undefined ? {} : { enablingDependency }),
})

describe("pipeline/phases isSparseForScale", () => {
  it("flags only a per-screen channel with a non-zero count below one fact per SPARSE_SCREEN_RATIO screens", () => {
    expect(SCREEN_SCALED_CHANNELS).toContain("endpoints")
    expect(isSparseForScale("endpoints", 1, 99)).toBe(true)
    expect(isSparseForScale("endpoints", 9, 100)).toBe(true)
  })

  it("is not sparse at exactly the ratio, above it, or for a small app", () => {
    expect(isSparseForScale("endpoints", 10, 100)).toBe(false)
    expect(isSparseForScale("endpoints", 50, 100)).toBe(false)
    expect(isSparseForScale("endpoints", 1, SPARSE_SCREEN_RATIO)).toBe(false)
    expect(isSparseForScale("endpoints", 1, 1)).toBe(false)
  })

  it("never fires for count 0 (that is the suspect/low path), nor for other channels, nor with no screens", () => {
    expect(isSparseForScale("endpoints", 0, 500)).toBe(false)
    expect(isSparseForScale("stores", 1, 500)).toBe(false)
    expect(isSparseForScale("screens", 1, 500)).toBe(false)
    expect(isSparseForScale("endpoints", 1, 0)).toBe(false)
  })
})

describe("pipeline/phases providersByChannel", () => {
  it("unions the dependencies of ALL providers of a channel, in registration order, without duplicates", () => {
    const providers = providersByChannel([
      extractor("http", ["endpoints"], "axios"),
      extractor("server-fn", ["endpoints"], ["@tanstack/start", "axios"]),
      extractor("convex", ["endpoints"], "convex"),
    ])

    expect(providers.get("endpoints")).toEqual({ dependencies: ["axios", "@tanstack/start", "convex"], alwaysOn: false })
  })

  it("marks a channel always-on as soon as ONE provider declares no dependency, whatever the order", () => {
    const first = providersByChannel([extractor("free", ["stores"]), extractor("gated", ["stores"], "zustand")])
    const last = providersByChannel([extractor("gated", ["stores"], "zustand"), extractor("free", ["stores"])])

    expect(first.get("stores")).toEqual({ dependencies: ["zustand"], alwaysOn: true })
    expect(last.get("stores")).toEqual({ dependencies: ["zustand"], alwaysOn: true })
  })

  it("treats an empty dependency array as no dependency", () => {
    expect(providersByChannel([extractor("e", ["stores"], [])]).get("stores")).toEqual({ dependencies: [], alwaysOn: true })
  })

  it("registers one entry per provided channel, and nothing for no extractors", () => {
    const providers = providersByChannel([extractor("multi", ["stores", "forms"], "dep")])

    expect([...providers.keys()]).toEqual(["stores", "forms"])
    expect(providersByChannel([]).size).toBe(0)
  })
})

describe("pipeline/phases probeOf", () => {
  const installedOnly = (...names: string[]) => (dependency: string) => names.includes(dependency)

  it("names every INSTALLED dependency, comma-joined, as installed", () => {
    expect(probeOf({ dependencies: ["a", "b", "c"], alwaysOn: false }, installedOnly("a", "c"))).toEqual({
      enablingDependency: "a, c",
      dependencyInstalled: true,
    })
  })

  it("installed dependencies win even when a provider is always-on", () => {
    expect(probeOf({ dependencies: ["a"], alwaysOn: true }, installedOnly("a"))).toEqual({
      enablingDependency: "a",
      dependencyInstalled: true,
    })
  })

  it("reports nothing to probe for an always-on channel with no installed dependency", () => {
    expect(probeOf({ dependencies: ["a"], alwaysOn: true }, installedOnly())).toEqual({
      enablingDependency: null,
      dependencyInstalled: false,
    })
  })

  it("keeps naming the FIRST gated dependency when none is installed", () => {
    expect(probeOf({ dependencies: ["a", "b"], alwaysOn: false }, installedOnly())).toEqual({
      enablingDependency: "a",
      dependencyInstalled: false,
    })
  })

  it("yields null for a provider-less channel", () => {
    expect(probeOf({ dependencies: [], alwaysOn: false }, installedOnly())).toEqual({
      enablingDependency: null,
      dependencyInstalled: false,
    })
  })
})

describe("pipeline/phases expandFormats", () => {
  it("expands `all` to every built-in format, sorted", () => {
    expect(ALL_FORMATS).toEqual(["full", "index", "html", "graph"])
    expect(expandFormats(["all"])).toEqual(["full", "graph", "html", "index"])
  })

  it("deduplicates and sorts mixed requests, folding explicit formats into `all`", () => {
    expect(expandFormats(["index", "all", "full", "index"])).toEqual(["full", "graph", "html", "index"])
    expect(expandFormats(["zzz", "aaa", "zzz"])).toEqual(["aaa", "zzz"])
  })

  it("returns nothing for no formats and keeps unknown names for the emitter lookup to reject", () => {
    expect(expandFormats([])).toEqual([])
    expect(expandFormats(["ALL"])).toEqual(["ALL"])
  })
})

const envOf = (dependencies: readonly string[] = []): PipelineEnv =>
  ({ dependencies: new Set(dependencies), diagnostics: createDiagnosticCollector() }) as unknown as PipelineEnv

const factSource = (channels: Readonly<Record<string, number>>, extractors: Readonly<Record<string, number>> = {}, masked = 0): FactSource =>
  ({
    channelCount: (channel: string) => channels[channel] ?? 0,
    extractorCount: (name: string) => extractors[name] ?? 0,
    maskedComponents: () => Array.from({ length: masked }, () => ({})),
  }) as unknown as FactSource

const graphOf = (screenIds: readonly string[], limitations: readonly string[] = []): AppGraph =>
  ({
    screens: screenIds.map((id) => ({ id, kindTag: null, redirectTo: null, provenance: { sources: ["orig"] } })),
    meta: { limitations },
    diagnostics: [],
  }) as unknown as AppGraph

const aggregateOf = (overrides: Partial<AggregateInput> & { readonly env: PipelineEnv }) => {
  const input: AggregateInput = {
    graph: graphOf(["/a"]),
    facts: factSource({}),
    extractors: [],
    screens: [],
    navGroupCount: 0,
    ...overrides,
  }
  return aggregate(input)
}

describe("pipeline/phases aggregate", () => {
  it("emits confidence sorted by section, deduplicated across providers of one channel", () => {
    const result = aggregateOf({
      env: envOf(),
      extractors: [extractor("s1", ["stores"]), extractor("s2", ["stores"]), extractor("f", ["forms"])],
      facts: factSource({ stores: 2, forms: 1 }),
    })

    expect(result.meta.confidence.map((entry) => entry.section)).toEqual(["forms", "nav", "screens", "stores"])
    expect(result.meta.confidence.find((entry) => entry.section === "stores")).toMatchObject({ count: 2, level: "high" })
  })

  it.each([
    { label: "API routes", extra: { kindTag: "apiRoute", redirectTo: null } },
    { label: "api-tagged routes", extra: { kindTag: "api", redirectTo: null } },
    { label: "redirects", extra: { kindTag: null, redirectTo: "/a" } },
  ])("counts only page screens in the `screens` confidence section, not $label", ({ extra }) => {
    const page = { id: "/a", kindTag: null, redirectTo: null, provenance: { sources: ["orig"] } }
    const other = { id: "/b", ...extra, provenance: { sources: ["orig"] } }
    const graph = { screens: [page, other], meta: { limitations: [] }, diagnostics: [] } as unknown as AppGraph

    const result = aggregateOf({ env: envOf(), graph })

    expect(result.meta.confidence.find((entry) => entry.section === "screens")).toMatchObject({ count: 1 })
  })

  it("rates an empty section `low` without its dependency and `suspect` (with a warning) when the dependency is installed", () => {
    const low = aggregateOf({ env: envOf(), extractors: [extractor("s", ["stores"], "zustand")] })
    const env = envOf(["zustand"])
    const suspect = aggregateOf({ env, extractors: [extractor("s", ["stores"], "zustand")] })

    expect(low.meta.confidence.find((entry) => entry.section === "stores")).toMatchObject({ level: "low", dependencyInstalled: false })
    expect(suspect.meta.confidence.find((entry) => entry.section === "stores")).toMatchObject({ level: "suspect", dependencyInstalled: true })
    expect(suspect.diagnostics).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "confidence/empty-section",
        message: "section 'stores' produced no facts while 'zustand' is installed",
      }),
    ])
    expect(low.diagnostics).toEqual([])
  })

  it("pluralises the installed phrase for several dependencies", () => {
    const result = aggregateOf({ env: envOf(["a", "b"]), extractors: [extractor("s", ["stores"], ["a", "b"])] })

    expect(result.diagnostics[0]?.message).toBe("section 'stores' produced no facts while 'a', 'b' are installed")
  })

  it("downgrades a sparse per-screen section to `low` with an info diagnostic naming the counts", () => {
    const ids = Array.from({ length: 30 }, (_, index) => `/s${String(index).padStart(2, "0")}`)
    const result = aggregateOf({
      env: envOf(),
      graph: graphOf(ids),
      extractors: [extractor("http", ["endpoints"], "axios")],
      facts: factSource({ endpoints: 1 }),
    })

    expect(result.meta.confidence.find((entry) => entry.section === "endpoints")?.level).toBe("low")
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: "info", code: "confidence/sparse-section" }),
    ])
    expect(result.diagnostics[0]?.message).toContain("1 fact(s) across 30 screens")
  })

  it("warns about an extractor whose library is installed but which found nothing while a sibling filled its sections", () => {
    const result = aggregateOf({
      env: envOf(["convex"]),
      extractors: [extractor("http", ["endpoints"]), extractor("convex", ["endpoints"], "convex")],
      facts: factSource({ endpoints: 5 }, { http: 5, convex: 0 }),
    })

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "confidence/empty-section", severity: "warning" }),
    ])
    expect(result.diagnostics[0]?.message).toContain("extractor 'convex' produced no facts while 'convex' is installed")
  })

  it("stays quiet for a silent extractor when its channel is itself empty (the section already warned) or its library is absent", () => {
    const empty = aggregateOf({
      env: envOf(["convex"]),
      extractors: [extractor("convex", ["endpoints"], "convex")],
      facts: factSource({ endpoints: 0 }),
    })
    const absent = aggregateOf({
      env: envOf(),
      extractors: [extractor("http", ["endpoints"]), extractor("convex", ["endpoints"], "convex")],
      facts: factSource({ endpoints: 5 }, { http: 5 }),
    })

    expect(empty.diagnostics.map((entry) => entry.message)).toEqual(["section 'endpoints' produced no facts while 'convex' is installed"])
    expect(absent.diagnostics).toEqual([])
  })

  it("re-sorts screens by id and patches provenance from the merged draft, leaving others untouched", () => {
    const result = aggregateOf({
      env: envOf(),
      graph: graphOf(["/c", "/a", "/b"]),
      screens: [{ merged: { id: "/a", provenance: { sources: ["patched"] } } }] as unknown as AggregateInput["screens"],
    })

    expect(result.screens.map((screen) => screen.id)).toEqual(["/a", "/b", "/c"])
    expect(result.screens.map((screen) => screen.provenance.sources)).toEqual([["patched"], ["orig"], ["orig"]])
  })

  it("adds the mask limitation once, sorted into the existing limitations, only when something is masked", () => {
    const masked = aggregateOf({ env: envOf(), graph: graphOf(["/a"], ["zzz"]), facts: factSource({}, {}, 3) })
    const plain = aggregateOf({ env: envOf(), graph: graphOf(["/a"], ["zzz"]) })

    expect(masked.meta.limitations).toHaveLength(2)
    expect(masked.meta.limitations).toEqual([...masked.meta.limitations].sort())
    expect(masked.meta.limitations).toContain("zzz")
    expect(plain.meta.limitations).toEqual(["zzz"])
  })

  it("marks an empty graph and distinguishes 'no drafts' from 'all drafts dropped'", () => {
    const noDrafts = aggregateOf({ env: envOf(), graph: graphOf([]), screens: [] })
    const dropped = aggregateOf({
      env: envOf(),
      graph: graphOf([]),
      screens: [{ merged: { id: "/gone", provenance: {} } }] as unknown as AggregateInput["screens"],
    })
    const populated = aggregateOf({ env: envOf() })

    expect(noDrafts.meta).toMatchObject({ emptyResult: true, emptyReason: "no screen source produced a draft" })
    expect(dropped.meta).toMatchObject({ emptyResult: true, emptyReason: "every discovered screen draft was dropped during normalization" })
    expect(populated.meta).not.toHaveProperty("emptyResult")
  })

  const screenOf = (id: string, overrides: { readonly kindTag?: string; readonly redirectTo?: string } = {}) => ({
    id,
    kindTag: overrides.kindTag ?? null,
    redirectTo: overrides.redirectTo ?? null,
    provenance: { sources: ["orig"] },
  })
  const graphWith = (...screens: readonly ReturnType<typeof screenOf>[]): AppGraph =>
    ({ screens, meta: { limitations: [] }, diagnostics: [] }) as unknown as AppGraph

  it.each([
    ["only an apiRoute", [screenOf("/api/items", { kindTag: "apiRoute" })]],
    ["only an api", [screenOf("/api/items", { kindTag: "api" })]],
    ["only a redirect", [screenOf("/old", { redirectTo: "/new" })]],
    ["an apiRoute and a redirect", [screenOf("/api/items", { kindTag: "apiRoute" }), screenOf("/old", { redirectTo: "/new" })]],
  ])("treats %s as a zero-screen result", (_name, screens) => {
    const result = aggregateOf({ env: envOf(), graph: graphWith(...screens) })

    expect(result.meta).toMatchObject({
      emptyResult: true,
      emptyReason: "only API routes or redirects were found, no page screen",
    })
  })

  it("keeps a graph with a page next to an API route non-empty", () => {
    const result = aggregateOf({
      env: envOf(),
      graph: graphWith(screenOf("/api/items", { kindTag: "apiRoute" }), screenOf("/home")),
    })

    expect(result.meta).not.toHaveProperty("emptyResult")
    expect(result.meta).not.toHaveProperty("emptyReason")
  })
})

const emitHarness = (emitters: readonly Emitter[], files: Readonly<Record<string, string>> = {}) => {
  const host = createMemoryHost({ files: { [`${ROOT}/package.json`]: "{}", ...files } })
  const env = createEnv({ ts, config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }), host })
  const registry = createPipelineRegistry({ adapters: [{ name: "test", emitters }] })
  const graph = {} as AppGraph
  return {
    env,
    run: (formats: readonly string[]) => emit({ env, registry, graph, formats }),
  }
}

const emitterFor = (name: string, produce: (format: string) => readonly EmitFile[]): Emitter => ({
  name,
  emit: (_graph, ctx) => produce(ctx.format),
})

describe("pipeline/phases emit", () => {
  it("runs each requested format once, deduplicated, and returns files sorted by path", () => {
    const calls: string[] = []
    const e = emitHarness([
      emitterFor("fmt", (format) => {
        calls.push(format)
        return [{ path: `${format}/z.txt`, content: "z" }, { path: `${format}/a.txt`, content: "a" }]
      }),
    ])

    expect(e.run(["fmt", "fmt"]).map((file) => file.path)).toEqual(["fmt/a.txt", "fmt/z.txt"])
    expect(calls).toEqual(["fmt"])
  })

  it("warns once per unknown format and still serves the known ones", () => {
    const e = emitHarness([emitterFor("fmt", () => [{ path: "x.txt", content: "x" }])])
    const files = e.run(["nope", "fmt", "nope"])
    const warnings = e.env.diagnostics.all().filter((entry) => entry.code === "emit/unknown-format")

    expect(files.map((file) => file.path)).toEqual(["x.txt"])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain("'nope'")
  })

  it("returns nothing for no formats", () => {
    expect(emitHarness([emitterFor("fmt", () => [])]).run([])).toEqual([])
  })

  it("rejects absolute paths and any `..` segment, keeping the legitimate files of the same emitter", () => {
    const e = emitHarness([
      emitterFor("fmt", () => [
        { path: "/etc/passwd", content: "x" },
        { path: "../escape.txt", content: "x" },
        { path: "a/../../escape.txt", content: "x" },
        { path: "ok/a..b.txt", content: "x" },
        { path: "ok/fine.txt", content: "x" },
      ]),
    ])

    expect(e.run(["fmt"]).map((file) => file.path)).toEqual(["ok/a..b.txt", "ok/fine.txt"])
    const errors = e.env.diagnostics.all().filter((entry) => entry.code === "emit/unwritable-output")
    expect(errors).toHaveLength(3)
    expect(errors[0]?.severity).toBe("error")
    expect(errors[0]?.message).toContain("'fmt'")
  })

  it("rejects backslash traversal and Windows absolute paths, which escape the output dir on Windows", () => {
    const e = emitHarness([
      emitterFor("fmt", () => [
        { path: "..\\..\\escape.txt", content: "x" },
        { path: "a\\..\\..\\escape.txt", content: "x" },
        { path: "C:\\Windows\\escape.txt", content: "x" },
        { path: "\\\\server\\share\\escape.txt", content: "x" },
        { path: "ok\\fine.txt", content: "x" },
      ]),
    ])

    expect(e.run(["fmt"]).map((file) => file.path)).toEqual(["ok\\fine.txt"])
    expect(e.env.diagnostics.all().filter((entry) => entry.code === "emit/unwritable-output")).toHaveLength(4)
  })

  it("isolates a throwing emitter as plugin/threw and keeps other formats", () => {
    const e = emitHarness([
      emitterFor("boom", (format) => {
        if (format === "boom") throw new Error("kaput")
        return [{ path: "ok.txt", content: "ok" }]
      }),
    ])
    const files = e.run(["boom", "other"])
    const threw = e.env.diagnostics.all().filter((entry) => entry.code === "plugin/threw")

    expect(files).toEqual([])
    expect(threw).toHaveLength(1)
    expect(threw[0]?.plugin).toBe("boom")
  })

  it("hands emitters the config timestamp and an asset reader that yields '' for a missing file", () => {
    let seen: { timestamp: string | null; missing: string; present: string } | null = null
    const host = createMemoryHost({ files: { [`${ROOT}/package.json`]: "{}", [`${ROOT}/asset.css`]: "body{}" } })
    const env = createEnv({
      ts,
      config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test", timestamp: "2026-01-01T00:00:00Z" }),
      host,
    })
    const spy: Emitter = {
      name: "spy",
      emit: (_graph, ctx) => {
        seen = { timestamp: ctx.timestamp, missing: ctx.asset(`${ROOT}/missing.css`), present: ctx.asset(`${ROOT}/asset.css`) }
        return []
      },
    }
    const registry = createPipelineRegistry({ adapters: [{ name: "t", emitters: [spy] }] })
    emit({ env, registry, graph: {} as AppGraph, formats: ["spy"] })

    expect(seen).toEqual({ timestamp: "2026-01-01T00:00:00Z", missing: "", present: "body{}" })
  })

  it("expands `all` against the registered emitters, warning for the built-in formats nobody registered", () => {
    const e = emitHarness([emitterFor("fmt", () => [])])
    e.run(["all"])

    expect(
      e.env.diagnostics
        .all()
        .filter((entry) => entry.code === "emit/unknown-format")
        .map((entry) => entry.message.match(/'([^']+)'/)?.[1]),
    ).toEqual(["full", "graph", "html", "index"])
  })
})
