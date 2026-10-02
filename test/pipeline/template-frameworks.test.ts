import { describe, expect, it, vi } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import type { PeerLoad } from "../../src/core/peer-loader.js"
import type { TemplateFrameworkSpec } from "../../src/core/template-frameworks.js"
import { EMPTY_TEMPLATE_TAGS } from "../../src/core/template-doc.js"
import {
  TEMPLATE_COMPILER_UNSUPPORTED_CODE,
  loadTemplateCompilers,
  templateApiOf,
} from "../../src/pipeline/template-frameworks.js"

const ROOT = "/repo"

type FakeApi = { readonly compile: () => string; readonly version: string }

const isFakeApi = (module: unknown): module is FakeApi =>
  typeof module === "object" && module !== null && "compile" in module && typeof module.compile === "function"

const fakeSpec = (overrides: Partial<TemplateFrameworkSpec<FakeApi>> = {}): TemplateFrameworkSpec<FakeApi> => ({
  id: "angular",
  label: "Angular",
  packages: [{ specifier: "@angular/compiler", manifest: "@angular/compiler/package.json" }],
  moduleKind: "esm",
  installHint: "install @angular/compiler",
  skippedNote: "",
  appliesTo: ({ dependencies }) => dependencies.has("@angular/core"),
  projectMajor: () => null,
  checkVersion: (version) => (version === null || version.startsWith("22.") ? null : "outside the supported range 22.x"),
  fallbackOnUnsupported: true,
  adapt: (module) => (isFakeApi(module) ? module : null),
  producer: () => null,
  tags: EMPTY_TEMPLATE_TAGS,
  ...overrides,
})

const fakeApi = (version: string): FakeApi => ({ compile: () => "ok", version })

const loadWith = (load: PeerLoad, spec: TemplateFrameworkSpec<FakeApi>, dependencies: readonly string[]) =>
  loadTemplateCompilers({
    root: ROOT,
    host: createMemoryHost({ files: { [`${ROOT}/package.json`]: "{}" } }),
    dependencies: new Set(dependencies),
    files: [],
    inject: { [spec.id]: load },
    frameworks: [spec],
  })

describe("loadTemplateCompilers", () => {
  it("never calls a loader for a framework that does not apply", async () => {
    const load = vi.fn<PeerLoad>(() => fakeApi("22.0.1"))

    const set = await loadWith(load, fakeSpec(), ["react"])

    expect(load).not.toHaveBeenCalled()
    expect(set).toEqual({ apis: {}, statuses: [], diagnostics: [] })
  })

  it("retries the appgraph copy when the project's is unsupported and the spec allows it", async () => {
    const load: PeerLoad = (_specifier, base) => fakeApi(base === `${ROOT}/package.json` ? "17.3.0" : "22.0.1")
    const spec = fakeSpec()

    const set = await loadWith(load, spec, ["@angular/core"])

    expect(set.statuses).toEqual([{ framework: "angular", status: "loaded", version: "22.0.1", from: "appgraph" }])
    expect(set.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message])).toEqual([
      [
        "project/template-compiler-unsupported",
        "Angular 17.3.0 in the project is outside the supported range 22.x: templates are parsed with appgraph's own Angular compiler 22.0.1 instead.",
      ],
    ])
    expect(templateApiOf(set.apis, spec)?.version).toBe("22.0.1")
  })

  it("keeps the project's unsupported verdict when the spec forbids the fallback", async () => {
    const load: PeerLoad = (_specifier, base) => fakeApi(base === `${ROOT}/package.json` ? "17.3.0" : "22.0.1")

    const set = await loadWith(load, fakeSpec({ fallbackOnUnsupported: false }), ["@angular/core"])

    expect(set.statuses).toEqual([{ framework: "angular", status: "unsupported", version: "17.3.0", from: null }])
    expect(set.diagnostics).toEqual([
      expect.objectContaining({ code: TEMPLATE_COMPILER_UNSUPPORTED_CODE, message: expect.stringMatching(/^Angular 17\.3\.0 is outside/) }),
    ])
    expect(set.apis).toEqual({})
  })
})
