import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ESLint } from "eslint"
import { afterAll, describe, expect, it } from "vitest"
import {
  ElementTypes,
  NodeTypes,
  SUPPORTED_VUE_RANGE,
  VUE_TEMPLATE_FRAMEWORK,
  isSupportedVueVersion,
  loadVueCompiler,
  projectVueMajor,
  type VueModuleLoad,
} from "../../src/core/vue-compiler.js"

const ROOT = "/project"
const PROJECT_BASE = path.join(ROOT, "package.json")

const notFound = (specifier: string): Error =>
  Object.assign(new Error(`Cannot find module '${specifier}'`), { code: "MODULE_NOT_FOUND" })

const fakeCompiler = (version: string | undefined) => ({
  ...(version === undefined ? {} : { version }),
  parse: () => ({ descriptor: { filename: "a.vue", template: null, script: null, scriptSetup: null }, errors: [] }),
})

const loaderOf =
  (modules: Readonly<Record<string, unknown>>): VueModuleLoad =>
  (specifier, base) => {
    const key = `${base}::${specifier}`
    if (key in modules) return modules[key]
    throw notFound(specifier)
  }

const missingEverywhere: VueModuleLoad = (specifier) => {
  throw notFound(specifier)
}

const emptyRoot = mkdtempSync(path.join(tmpdir(), "appgraph-vue-"))

afterAll(() => {
  rmSync(emptyRoot, { recursive: true, force: true })
})

describe("vue-compiler: the declared range", () => {
  it("matches the optional peer range", () => {
    expect(SUPPORTED_VUE_RANGE).toBe(">=3.4.0 <4.0.0")
  })

  it.each([
    ["3.4.0", true],
    ["3.5.43", true],
    ["3.6.0-beta.1", true],
    ["3.3.13", false],
    ["2.7.16", false],
    ["4.0.0", false],
    ["unknown", false],
  ])("judges %s supported=%s", (version, supported) => {
    expect(isSupportedVueVersion(version)).toBe(supported)
  })

  it("mirrors the compiler's numeric node and element kinds", () => {
    expect(NodeTypes.ELEMENT).toBe(1)
    expect(NodeTypes.DIRECTIVE).toBe(7)
    expect(ElementTypes.COMPONENT).toBe(1)
  })
})

describe("vue-compiler: loadVueCompiler with a fake loader", () => {
  it("reports missing with every attempted candidate and never throws", () => {
    const result = loadVueCompiler({ root: ROOT, load: missingEverywhere })
    expect(result.kind).toBe("missing")
    if (result.kind !== "missing") return
    expect(result.detail).toContain("vue/compiler-sfc (project)")
    expect(result.detail).toContain("@vue/compiler-sfc (project)")
    expect(result.detail).toContain("vue/compiler-sfc (appgraph)")
  })

  it("marks a Vue 2.7 project compiler unsupported instead of falling back", () => {
    const load = loaderOf({ [`${PROJECT_BASE}::vue/compiler-sfc`]: fakeCompiler("2.7.16") })
    expect(loadVueCompiler({ root: ROOT, load })).toEqual({
      kind: "unsupported",
      version: "2.7.16",
      reason: `outside the supported range ${SUPPORTED_VUE_RANGE}`,
    })
  })

  it("marks a 3.3 compiler unsupported", () => {
    const load = loaderOf({ [`${PROJECT_BASE}::@vue/compiler-sfc`]: fakeCompiler("3.3.13") })
    const result = loadVueCompiler({ root: ROOT, load })
    expect(result).toMatchObject({ kind: "unsupported", version: "3.3.13" })
  })

  it("marks a compiler without parse unsupported", () => {
    const load = loaderOf({ [`${PROJECT_BASE}::vue/compiler-sfc`]: { version: "3.5.0" } })
    expect(loadVueCompiler({ root: ROOT, load })).toEqual({
      kind: "unsupported",
      version: "3.5.0",
      reason: "missing the expected Vue compiler API",
    })
  })

  it("reads the version from the package manifest when the compiler does not export one", () => {
    const load = loaderOf({
      [`${PROJECT_BASE}::vue/compiler-sfc`]: fakeCompiler(undefined),
      [`${PROJECT_BASE}::vue/package.json`]: { version: "3.4.21" },
    })
    expect(loadVueCompiler({ root: ROOT, load })).toMatchObject({ kind: "loaded", version: "3.4.21", from: "project" })
  })

  it("prefers the project compiler over the appgraph fallback", () => {
    const load: VueModuleLoad = (specifier, base) => {
      if (specifier !== "vue/compiler-sfc") throw notFound(specifier)
      return fakeCompiler(base === PROJECT_BASE ? "3.4.0" : "3.5.0")
    }
    expect(loadVueCompiler({ root: ROOT, load })).toMatchObject({ kind: "loaded", version: "3.4.0", from: "project" })
  })

  it("falls back to appgraph's install when the project has none", () => {
    const load: VueModuleLoad = (specifier, base) => {
      if (base === PROJECT_BASE) throw notFound(specifier)
      return fakeCompiler("3.5.1")
    }
    expect(loadVueCompiler({ root: ROOT, load })).toMatchObject({ kind: "loaded", from: "appgraph" })
  })
})

describe("vue-compiler: the real devDependency", () => {
  it("loads through the appgraph fallback for a root without node_modules", () => {
    const result = loadVueCompiler({ root: emptyRoot })
    expect(result.kind).toBe("loaded")
    if (result.kind !== "loaded") return
    expect(result.from).toBe("appgraph")
    expect(isSupportedVueVersion(result.version)).toBe(true)
  })

  it("parses a template into the structural AST shape", () => {
    const result = loadVueCompiler({ root: "/nonexistent" })
    if (result.kind !== "loaded") throw new Error(`expected loaded, got ${result.kind}`)
    const { descriptor, errors } = result.api.parse('<template><RouterLink to="/a" v-if="ok" /></template>', {
      filename: "a.vue",
    })
    expect(errors).toEqual([])
    const element = descriptor.template?.ast?.children[0]
    expect(element?.type).toBe(NodeTypes.ELEMENT)
    if (element?.type !== NodeTypes.ELEMENT) return
    expect(element.tag).toBe("RouterLink")
    expect(element.tagType).toBe(ElementTypes.COMPONENT)
    expect(element.props.map((prop) => prop.type)).toEqual([NodeTypes.ATTRIBUTE, NodeTypes.DIRECTIVE])
    expect(element.loc.start).toEqual({ offset: 10, line: 1, column: 11 })
  })
})

describe("vue-compiler: projectVueMajor", () => {
  const manifest = (fields: Record<string, Record<string, string>>): string => JSON.stringify(fields)

  it.each([
    [manifest({ dependencies: { vue: "^2.7.16" } }), 2],
    [manifest({ dependencies: { vue: "~3.4.0" } }), 3],
    [manifest({ devDependencies: { vue: "3.x" } }), 3],
    [manifest({ peerDependencies: { vue: ">=3.4.0 <4.0.0" } }), 3],
    [manifest({ dependencies: { vue: "catalog:" } }), null],
    [manifest({ dependencies: { vue: "workspace:^3.5.0" } }), null],
    [manifest({ dependencies: { react: "^19.0.0" } }), null],
    ["{ not json", null],
  ])("reads %s as %s", (text, major) => {
    expect(projectVueMajor(text)).toBe(major)
  })

  it("prefers dependencies over devDependencies", () => {
    expect(projectVueMajor(manifest({ dependencies: { vue: "^2.7" }, devDependencies: { vue: "^3.5" } }))).toBe(2)
  })

  it("reads an npm alias range", () => {
    expect(projectVueMajor(manifest({ dependencies: { vue: "npm:vue@^3.5.0" } }))).toBe(3)
  })
})

describe("vue-compiler: the Vue template framework spec", () => {
  const files = (names: readonly string[]) => ({ dependencies: new Set(names), files: [] })

  it.each([
    [["vue"], true],
    [["nuxt"], true],
    [["react"], false],
  ] as const)("applies to dependencies %o: %s", (names, applies) => {
    expect(VUE_TEMPLATE_FRAMEWORK.appliesTo(files(names))).toBe(applies)
  })

  it("does not apply to a project with a stray .vue file and no vue dependency", () => {
    expect(VUE_TEMPLATE_FRAMEWORK.appliesTo({ dependencies: new Set(["react"]), files: ["docs/Widget.vue"] })).toBe(false)
  })

  it.each([
    [null, 2, "outside"],
    [null, 3, null],
    [null, null, null],
    ["3.3.4", 3, "outside"],
    ["3.5.43", null, null],
    ["4.0.0", 4, "outside"],
  ] as const)("checkVersion(%s, major %s) rejects=%s", (version, major, rejects) => {
    const reason = VUE_TEMPLATE_FRAMEWORK.checkVersion(version, major)
    expect(reason === null ? null : "outside").toBe(rejects)
  })

  it("adapts only a module exposing parse", () => {
    const module = fakeCompiler("3.5.0")
    expect(VUE_TEMPLATE_FRAMEWORK.adapt(module)).toBe(module)
    expect(VUE_TEMPLATE_FRAMEWORK.adapt({ version: "3.5.0" })).toBeNull()
  })
})

describe("vue-compiler: the lint guard", { timeout: 30_000 }, () => {
  const lint = async (filePath: string): Promise<readonly string[]> => {
    const eslint = new ESLint({ cwd: process.cwd() })
    const [report] = await eslint.lintText('import { parse } from "@vue/compiler-sfc"\nexport const p = parse\n', {
      filePath,
    })
    return (report?.messages ?? []).map((message) => message.ruleId ?? "")
  }

  it.each(["src/core/probe.ts", "src/adapters/probe.ts"])("rejects a vue import in %s", async (filePath) => {
    expect(await lint(filePath)).toContain("@typescript-eslint/no-restricted-imports")
  })

  it("allows it in the loader", async () => {
    expect(await lint("src/core/vue-compiler.ts")).not.toContain("@typescript-eslint/no-restricted-imports")
  })
})
