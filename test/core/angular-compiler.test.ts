import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import {
  ANGULAR_TEMPLATE_FRAMEWORK,
  adaptAngularCompiler,
  angularParseOptions,
  checkAngularVersion,
  projectAngularMajor,
} from "../../src/core/angular-compiler.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { PeerLoad } from "../../src/core/peer-loader.js"
import {
  TEMPLATE_COMPILER_MISSING_CODE,
  TEMPLATE_COMPILER_UNSUPPORTED_CODE,
  loadTemplateCompilers,
  templateApiOf,
} from "../../src/pipeline/template-frameworks.js"

const ROOT = "/repo"

const PROJECT_BASE = `${ROOT}/package.json`

class FakeCssSelector {
  static parse(): FakeCssSelector[] {
    return [new FakeCssSelector()]
  }
}

class FakeSelectorMatcher {
  addSelectables(): void {}
  match(): boolean {
    return false
  }
}

const fakeCompiler = () => ({
  parseTemplate: () => ({ errors: null, nodes: [] }),
  CssSelector: FakeCssSelector,
  SelectorMatcher: FakeSelectorMatcher,
})

const isManifest = (specifier: string): boolean => specifier.endsWith("/package.json")

const versionedLoad =
  (versionOf: (base: string) => string, moduleOf: (base: string) => unknown = fakeCompiler): PeerLoad =>
  (specifier, base) =>
    isManifest(specifier) ? { version: versionOf(base) } : moduleOf(base)

const loadWith = (load: PeerLoad, manifest = "{}") =>
  loadTemplateCompilers({
    root: ROOT,
    host: createMemoryHost({ files: { [PROJECT_BASE]: manifest } }),
    dependencies: new Set(["@angular/core"]),
    files: [],
    inject: { angular: load },
    frameworks: [ANGULAR_TEMPLATE_FRAMEWORK],
  })

describe("ANGULAR_TEMPLATE_FRAMEWORK loading", () => {
  it("reports a missing compiler when neither the project nor appgraph has one", async () => {
    const load: PeerLoad = (specifier) => {
      throw new Error(`Cannot find module '${specifier}'`)
    }

    const set = await loadWith(load)

    expect(set.statuses).toEqual([{ framework: "angular", status: "missing", version: null, from: null }])
    expect(set.diagnostics).toEqual([expect.objectContaining({ code: TEMPLATE_COMPILER_MISSING_CODE })])
    expect(set.apis).toEqual({})
  })

  it("falls back to the appgraph compiler when the project's is v13, and says so", async () => {
    const load = versionedLoad((base) => (base === PROJECT_BASE ? "13.4.0" : "22.2.1"))

    const set = await loadWith(load, JSON.stringify({ dependencies: { "@angular/core": "^13.4.0" } }))

    expect(set.statuses).toEqual([{ framework: "angular", status: "loaded", version: "22.2.1", from: "appgraph" }])
    expect(set.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([TEMPLATE_COMPILER_UNSUPPORTED_CODE])
    expect(templateApiOf(set.apis, ANGULAR_TEMPLATE_FRAMEWORK)).not.toBeNull()
  })

  it("keeps the unsupported verdict when every available compiler is v13", async () => {
    const set = await loadWith(versionedLoad(() => "13.4.0"))

    expect(set.statuses).toEqual([{ framework: "angular", status: "unsupported", version: "13.4.0", from: null }])
    expect(set.diagnostics).toEqual([expect.objectContaining({ code: TEMPLATE_COMPILER_UNSUPPORTED_CODE })])
  })

  it("rejects a module that misses the expected compiler API", async () => {
    const load = versionedLoad(
      () => "22.2.1",
      () => ({ parseTemplate: () => ({ errors: null, nodes: [] }) }),
    )

    const set = await loadWith(load)

    expect(set.statuses).toEqual([{ framework: "angular", status: "unsupported", version: "22.2.1", from: null }])
    expect(set.diagnostics).toEqual([
      expect.objectContaining({
        code: TEMPLATE_COMPILER_UNSUPPORTED_CODE,
        message: expect.stringContaining("missing the expected Angular compiler API"),
      }),
    ])
  })

  it("loads the real devDependency from appgraph and parses a router outlet", async () => {
    const root = tmpdir()
    const set = await loadTemplateCompilers({
      root,
      host: createMemoryHost({ files: {} }),
      dependencies: new Set(["@angular/core"]),
      files: [],
      frameworks: [ANGULAR_TEMPLATE_FRAMEWORK],
    })

    expect(set.statuses).toEqual([
      { framework: "angular", status: "loaded", version: expect.stringMatching(/^\d+\./), from: "appgraph" },
    ])
    const compiler = templateApiOf(set.apis, ANGULAR_TEMPLATE_FRAMEWORK)
    const parsed = compiler?.parseTemplate("<router-outlet></router-outlet>", "app.component.html", angularParseOptions(null))
    expect(parsed?.errors ?? []).toHaveLength(0)
    expect(parsed?.nodes).toHaveLength(1)
    expect(compiler?.createCssSelectorFromNode).toBeTypeOf("function")
  })
})

describe("adaptAngularCompiler", () => {
  it("records an absent createCssSelectorFromNode as null", () => {
    expect(adaptAngularCompiler(fakeCompiler())?.createCssSelectorFromNode).toBeNull()
  })

  it.each([
    ["parseTemplate", { ...fakeCompiler(), parseTemplate: "nope" }],
    ["CssSelector.parse", { ...fakeCompiler(), CssSelector: class {} }],
    ["SelectorMatcher", { ...fakeCompiler(), SelectorMatcher: {} }],
  ])("returns null without %s", (_name, module) => {
    expect(adaptAngularCompiler(module)).toBeNull()
  })
})

describe("angularParseOptions", () => {
  it.each([
    [null, true, true],
    [16, false, false],
    [17, true, true],
    [18, true, true],
  ])("project major %s → block %s, let %s (let follows block: block without let hangs @angular/compiler 22)", (major, enableBlockSyntax, enableLetSyntax) => {
    expect(angularParseOptions(major)).toEqual({ preserveWhitespaces: false, enableBlockSyntax, enableLetSyntax })
  })
})

describe("checkAngularVersion", () => {
  it.each([
    ["13.4.0", false],
    ["14.0.0", true],
    ["22.2.1", true],
  ])("compiler %s supported: %s", (version, supported) => {
    expect(checkAngularVersion(version) === null).toBe(supported)
  })

  it("never rejects on the project major alone", () => {
    expect(ANGULAR_TEMPLATE_FRAMEWORK.checkVersion(null, 11)).toBeNull()
  })
})

describe("projectAngularMajor", () => {
  it("reads the @angular/core range", () => {
    expect(projectAngularMajor(JSON.stringify({ dependencies: { "@angular/core": "~11.2.0" } }))).toBe(11)
    expect(projectAngularMajor("{}")).toBeNull()
  })
})
