import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createMemoryHost, createNodeHost } from "../../src/core/host.js"
import { VUE_TEMPLATE_FRAMEWORK } from "../../src/core/vue-compiler.js"
import { TEMPLATE_FRAMEWORKS } from "../../src/pipeline/template-frameworks.js"
import { TEMPLATE_FRAMEWORK_IDENTITIES } from "../../src/core/template-framework-ids.js"
import {
  FINGERPRINT_FILE,
  computeGraphFingerprint,
  computeRunFingerprint,
  formatSidecar,
  graphStateOf,
  parseSidecar,
  readSidecar,
  sidecarWithGraph,
  stickyGraphOptions,
  isStale,
  isUpToDate,
  missingArtifacts,
  readPreviousFingerprint,
  readPreviousRun,
  statSourceRoot,
} from "../../src/cli/stale.js"
import type { FingerprintInput, GraphRecord, GraphStateInput, RunRecord } from "../../src/cli/stale.js"

const ROOT = "/repo"

const FILES = {
  [`${ROOT}/tsconfig.base.json`]: JSON.stringify({ compilerOptions: { strict: true } }),
  [`${ROOT}/tsconfig.json`]: JSON.stringify({ extends: "./tsconfig.base.json" }),
  [`${ROOT}/src/App.tsx`]: "export const App = () => null",
  [`${ROOT}/src/pages/Home.tsx`]: "export const Home = () => null",
  [`${ROOT}/node_modules/dep/index.js`]: "module.exports = {}",
  [`${ROOT}/dist/App.js`]: "export const App = () => null",
}

const MTIMES = {
  [`${ROOT}/src/App.tsx`]: 1000,
  [`${ROOT}/src/pages/Home.tsx`]: 2000,
}

const inputFor = (
  overrides: Partial<FingerprintInput> = {},
  files: Readonly<Record<string, string>> = FILES,
  mtimes: Readonly<Record<string, number>> = MTIMES,
): FingerprintInput => ({
  host: createMemoryHost({ files, mtimes }),
  appgraphVersion: "0.1.0",
  root: ROOT,
  sourceRoots: ["src"],
  config: { out: "docs/appgraph", formats: ["full"] },
  tsconfigFiles: ["tsconfig.base.json", "tsconfig.json"],
  ...overrides,
})

describe("computeGraphFingerprint", () => {
  it("is stable across runs with identical inputs", () => {
    expect(computeGraphFingerprint(inputFor()).value).toBe(computeGraphFingerprint(inputFor()).value)
  })

  it("changes when the analyzer's own version changes", () => {
    const before = computeGraphFingerprint(inputFor()).value
    const after = computeGraphFingerprint(inputFor({ appgraphVersion: "0.1.1" })).value
    expect(after).not.toBe(before)
    expect(isStale(before, after)).toBe(true)
  })

  it("changes when the resolved config changes", () => {
    expect(computeGraphFingerprint(inputFor({ config: { out: "other" } })).value).not.toBe(
      computeGraphFingerprint(inputFor()).value,
    )
  })

  it("changes when any file in the tsconfig chain changes", () => {
    const edited = { ...FILES, [`${ROOT}/tsconfig.base.json`]: JSON.stringify({ compilerOptions: {} }) }
    expect(computeGraphFingerprint(inputFor({}, edited)).value).not.toBe(computeGraphFingerprint(inputFor()).value)
  })

  it("changes when a source file's mtime or count changes, in any source root", () => {
    const touched = computeGraphFingerprint(inputFor({}, FILES, { ...MTIMES, [`${ROOT}/src/App.tsx`]: 9999 })).value
    expect(touched).not.toBe(computeGraphFingerprint(inputFor()).value)

    const added = computeGraphFingerprint(
      inputFor({}, { ...FILES, [`${ROOT}/src/pages/List.tsx`]: "export const List = () => null" }),
    ).value
    expect(added).not.toBe(computeGraphFingerprint(inputFor()).value)
  })

  it("covers every source root, not just src/", () => {
    const files = { ...FILES, [`${ROOT}/app/Root.tsx`]: "export const Root = () => null" }
    const base = computeGraphFingerprint(inputFor({ sourceRoots: ["src", "app"] }, files)).value
    const changed = computeGraphFingerprint(
      inputFor({ sourceRoots: ["src", "app"] }, { ...files, [`${ROOT}/app/Root.tsx`]: "changed" }, {
        ...MTIMES,
        [`${ROOT}/app/Root.tsx`]: 4242,
      }),
    ).value
    expect(changed).not.toBe(base)
  })

  it("records each hashed part so doctor can print them", () => {
    const parts = computeGraphFingerprint(inputFor()).parts
    expect(parts[0]).toBe("appgraphVersion=0.1.0")
    expect(parts.some((part) => part.startsWith("config="))).toBe(true)
    expect(parts.filter((part) => part.startsWith("tsconfig=")).length).toBe(2)
    expect(parts.some((part) => /^sourceRoot=src:files=2:entries=[0-9a-f]{64}$/.test(part))).toBe(true)
  })

  it("changes when a file is renamed or moved, even with the same count and mtimes", () => {
    const { [`${ROOT}/src/pages/Home.tsx`]: home, ...rest } = FILES
    const { [`${ROOT}/src/pages/Home.tsx`]: mtime, ...restMtimes } = MTIMES
    const moved = computeGraphFingerprint(
      inputFor({}, { ...rest, [`${ROOT}/src/screens/Home.tsx`]: home ?? "" }, {
        ...restMtimes,
        [`${ROOT}/src/screens/Home.tsx`]: mtime ?? 0,
      }),
    ).value
    expect(moved).not.toBe(computeGraphFingerprint(inputFor()).value)
  })
})

describe("computeGraphFingerprint: root config manifests", () => {
  const expoInput = (appJson: string, sourceRoots: readonly string[] = ["src"]): FingerprintInput =>
    inputFor({ sourceRoots }, { ...FILES, [`${ROOT}/app.json`]: appJson })

  it("changes when app.json outside sourceRoots changes", () => {
    const before = computeGraphFingerprint(expoInput('{"expo":{"plugins":[["expo-router",{"root":"src/app"}]]}}')).value
    const after = computeGraphFingerprint(expoInput('{"expo":{"plugins":[["expo-router",{"root":"src/screens"}]]}}')).value

    expect(after).not.toBe(before)
  })

  it("adds nothing for manifests that are absent or already stamped by a source root", () => {
    expect(computeGraphFingerprint(inputFor({ sourceRoots: ["src"] }, FILES)).parts.some((part) => part.startsWith("rootManifest="))).toBe(false)
    expect(computeGraphFingerprint(expoInput("{}", ["."])).parts.some((part) => part.startsWith("rootManifest="))).toBe(false)
  })
})

describe("computeGraphFingerprint: root package.json dependency manifest", () => {
  const angularManifest = (core: string, indent = 0): string =>
    JSON.stringify({ name: "app", dependencies: { "@angular/core": core, rxjs: "^7.8.0" }, devDependencies: { typescript: "^5.4.0" } }, null, indent)

  const angularInput = (manifest: string, overrides: Partial<FingerprintInput> = {}): FingerprintInput =>
    inputFor({ sourceRoots: ["src"], ...overrides }, { ...FILES, [`${ROOT}/package.json`]: manifest })

  it("changes when only the @angular/core major changes, even with package.json outside sourceRoots", () => {
    const before = computeGraphFingerprint(angularInput(angularManifest("^16.0.0"))).value
    const after = computeGraphFingerprint(angularInput(angularManifest("^17.0.0"))).value

    expect(after).not.toBe(before)
  })

  it("ignores a whitespace-only package.json change that leaves the dependencies the same", () => {
    const compact = computeGraphFingerprint(angularInput(angularManifest("^16.0.0"))).value
    const pretty = computeGraphFingerprint(angularInput(`${angularManifest("^16.0.0", 2)}\n`)).value

    expect(pretty).toBe(compact)
  })

  it("ignores manifest fields outside the dependency sections", () => {
    const base = computeGraphFingerprint(angularInput(angularManifest("^16.0.0"))).value
    const renamed = JSON.stringify({ name: "renamed", dependencies: { "@angular/core": "^16.0.0", rxjs: "^7.8.0" }, devDependencies: { typescript: "^5.4.0" } })

    expect(computeGraphFingerprint(angularInput(renamed)).value).toBe(base)
  })

  it("does not hash the manifest again when a source root already stamps package.json", () => {
    const parts = computeGraphFingerprint(angularInput(angularManifest("^16.0.0"), { sourceRoots: ["."] })).parts

    expect(parts.some((part) => part.startsWith("packageDependencies="))).toBe(false)
  })

  it("records a missing package.json as missing", () => {
    expect(computeGraphFingerprint(inputFor()).parts).toContain("packageDependencies=missing")
  })
})

const REACT_FILES = {
  [`${ROOT}/package.json`]: JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" } }),
  [`${ROOT}/tsconfig.json`]: JSON.stringify({ compilerOptions: { strict: true } }),
  [`${ROOT}/src/App.tsx`]: "export const App = () => null",
}

const REACT_FINGERPRINT = "9351a11731d9fab680caafe4ae2a9978112c9c7b9d8b2cc08d2726c97c06e664"

describe("computeGraphFingerprint: template compiler peers", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "appgraph-stale-"))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  const writeFiles = (root: string, files: Readonly<Record<string, string>>) => {
    for (const [file, text] of Object.entries(files)) {
      const full = path.join(root, file)
      mkdirSync(path.dirname(full), { recursive: true })
      writeFileSync(full, text)
    }
  }

  const vueProject = (name: string): string => {
    const root = path.join(scratch, name)
    writeFiles(root, {
      "package.json": JSON.stringify({ dependencies: { vue: "^3.3.0" } }),
      "src/App.vue": "<template><div /></template>\n",
    })
    return root
  }

  const installVue = (root: string, version: string) =>
    writeFiles(root, {
      "node_modules/vue/package.json": JSON.stringify({ name: "vue", version, main: "index.js" }),
      "node_modules/vue/index.js": "throw new Error('evaluated')\n",
      "node_modules/vue/compiler-sfc/index.js": "throw new Error('evaluated')\n",
    })

  const vueInputFor = (root: string, overrides: Partial<FingerprintInput> = {}): FingerprintInput => ({
    host: createNodeHost(),
    appgraphVersion: "0.1.0",
    root,
    sourceRoots: ["src"],
    config: {},
    tsconfigFiles: [],
    ...overrides,
  })

  const compilerPart = (input: FingerprintInput): string | undefined =>
    computeGraphFingerprint(input).parts.find((part) => part.startsWith("templateCompiler="))

  it("pins the fingerprint of a project without a template framework, which hashes no compiler part", () => {
    const input = inputFor({ tsconfigFiles: ["tsconfig.json"], config: { out: "docs/appgraph" } }, REACT_FILES, {
      [`${ROOT}/src/App.tsx`]: 1000,
    })

    expect(computeGraphFingerprint(input).value).toBe(REACT_FINGERPRINT)
    expect(computeGraphFingerprint(input).parts.some((part) => part.startsWith("templateCompiler="))).toBe(false)
  })

  it("changes when the project's vue appears after an install that ran later", () => {
    const root = vueProject("appears")
    const before = computeGraphFingerprint(vueInputFor(root))
    expect(compilerPart(vueInputFor(root))).toMatch(/^templateCompiler=vue:appgraph:/)

    installVue(root, "3.3.4")

    expect(compilerPart(vueInputFor(root))).toBe("templateCompiler=vue:project:vue/compiler-sfc@3.3.4")
    expect(computeGraphFingerprint(vueInputFor(root)).value).not.toBe(before.value)
  })

  it("changes on a lockfile-only vue upgrade that touches no source file", () => {
    const root = vueProject("upgrade")
    installVue(root, "3.3.4")
    const before = computeGraphFingerprint(vueInputFor(root)).value

    installVue(root, "3.5.13")

    expect(compilerPart(vueInputFor(root))).toBe("templateCompiler=vue:project:vue/compiler-sfc@3.5.13")
    expect(computeGraphFingerprint(vueInputFor(root)).value).not.toBe(before)
  })

  it("records a compiler no source can resolve as missing", () => {
    const root = vueProject("missing")
    const unresolvable = { ...VUE_TEMPLATE_FRAMEWORK, packages: [{ specifier: "no-such-peer", manifest: "no-such-peer/package.json" }] }

    expect(compilerPart(vueInputFor(root, { templateFrameworks: [unresolvable] }))).toBe("templateCompiler=vue:missing")
  })
})

describe("statSourceRoot", () => {
  it("skips node_modules and build output", () => {
    const host = createMemoryHost({ files: FILES, mtimes: MTIMES })
    expect(statSourceRoot(host, ROOT, ".")).toMatchObject({ root: ".", files: 4 })
  })

  it("skips dot-directories, the same rule discovery applies", () => {
    const host = createMemoryHost({
      files: { ...FILES, [`${ROOT}/.tool-cache/bundle.js`]: "x", [`${ROOT}/src/.cache/a.js`]: "x" },
      mtimes: MTIMES,
    })
    expect(statSourceRoot(host, ROOT, ".")).toMatchObject({ root: ".", files: 4 })
  })
})

const runRecord = (fingerprint: string, artifacts: readonly string[]): RunRecord => ({
  fingerprint,
  artifacts,
  exitCode: 0,
  counts: { screens: 2 },
})

const GRAPH_RECORD: GraphRecord = {
  fingerprint: "feedface",
  options: { source: "react-router", depth: 4, allSources: false, allowEmpty: false },
  tsconfigFiles: ["tsconfig.base.json", "tsconfig.json"],
  configFile: "appgraph.config.ts",
}

describe("readPreviousFingerprint", () => {
  const OUT = `${ROOT}/docs/appgraph`

  it("reads the run fingerprint from a v2 sidecar", () => {
    const host = createMemoryHost({ files: { [`${OUT}/${FINGERPRINT_FILE}`]: formatSidecar({ run: runRecord("abc123def456", ["appgraph.yaml"]), graph: null }) } })
    expect(readPreviousFingerprint({ host, outDir: OUT })).toBe("abc123def456")
  })

  it("treats a v1 text sidecar as stale, without falling back to the YAML", () => {
    const host = createMemoryHost({
      files: {
        [`${OUT}/${FINGERPRINT_FILE}`]: "abc123def456\nappgraph.yaml\n",
        [`${OUT}/appgraph.yaml`]: 'meta:\n  fingerprint: "deadbeefcafe"\n',
      },
    })
    expect(readPreviousFingerprint({ host, outDir: OUT })).toBeNull()
    expect(readSidecar({ host, outDir: OUT })).toBeNull()
  })

  it("falls back to meta.fingerprint in an existing artifact when there is no sidecar", () => {
    const host = createMemoryHost({
      files: { [`${OUT}/appgraph.yaml`]: 'meta:\n  schemaVersion: 2\n  fingerprint: "deadbeefcafe"\n' },
    })
    expect(readPreviousFingerprint({ host, outDir: OUT })).toBe("deadbeefcafe")
  })

  it("reads the recorded run and graph back from the sidecar", () => {
    const run = runRecord("abc123def456", ["appgraph.yaml", "appgraph.html"])
    const host = createMemoryHost({ files: { [`${OUT}/${FINGERPRINT_FILE}`]: formatSidecar({ run, graph: GRAPH_RECORD }) } })
    expect(readPreviousRun({ host, outDir: OUT })).toEqual(run)
    expect(readSidecar({ host, outDir: OUT })).toEqual({ run, graph: GRAPH_RECORD })
  })

  it("is up to date only when the fingerprint matches and every recorded artifact still exists", () => {
    const previous = runRecord("abc", ["appgraph.yaml", "appgraph.html"])
    const both = createMemoryHost({ files: { [`${OUT}/appgraph.yaml`]: "x", [`${OUT}/appgraph.html`]: "y" } })
    const one = createMemoryHost({ files: { [`${OUT}/appgraph.yaml`]: "x" } })

    expect(isUpToDate(both, OUT, previous, "abc")).toBe(true)
    expect(isUpToDate(both, OUT, previous, "abd")).toBe(false)
    expect(isUpToDate(one, OUT, previous, "abc")).toBe(false)
    expect(missingArtifacts(one, OUT, previous.artifacts)).toEqual(["appgraph.html"])
    expect(isUpToDate(both, OUT, runRecord("abc", []), "abc")).toBe(false)
    expect(isUpToDate(both, OUT, null, "abc")).toBe(false)
  })

  it("returns null when the output dir has no history, which counts as stale", () => {
    const host = createMemoryHost({ files: {} })
    expect(readPreviousFingerprint({ host, outDir: OUT })).toBeNull()
    expect(isStale(null, "anything")).toBe(true)
  })
})

describe("the v2 sidecar", () => {
  it("round-trips the run and graph parts as one JSON object", () => {
    const sidecar = { run: runRecord("abc", ["appgraph.graph.json"]), graph: GRAPH_RECORD }
    const text = formatSidecar(sidecar)
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: 2 })
    expect(parseSidecar(text)).toEqual(sidecar)
  })

  it("parses anything that is not a v2 object as null", () => {
    for (const text of ["", "abc123\n", "123456\n", "[]", JSON.stringify({ schemaVersion: 1, run: null, graph: null })])
      expect(parseSidecar(text)).toBeNull()
  })

  it("drops a malformed part rather than trusting it", () => {
    const text = JSON.stringify({ schemaVersion: 2, run: { fingerprint: 1 }, graph: GRAPH_RECORD })
    expect(parseSidecar(text)).toEqual({ run: null, graph: GRAPH_RECORD })
  })

  it("replaces only the graph part on a query refresh", () => {
    const run = runRecord("abc", ["appgraph.yaml"])
    const next = { ...GRAPH_RECORD, fingerprint: "cafe" }
    expect(sidecarWithGraph({ run, graph: GRAPH_RECORD }, next)).toEqual({ run, graph: next })
    expect(sidecarWithGraph(null, next)).toEqual({ run: null, graph: next })
  })
})

describe("graph vs run fingerprint", () => {
  const stateInput = (overrides: Partial<GraphStateInput> = {}, files: Readonly<Record<string, string>> = FILES): GraphStateInput => ({
    host: createMemoryHost({ files, mtimes: MTIMES }),
    appgraphVersion: "0.1.0",
    root: ROOT,
    outDir: `${ROOT}/docs/appgraph`,
    sourceRoots: ["src"],
    config: { depth: 4, formats: ["full"], out: "docs/appgraph", strict: true },
    configFile: "appgraph.config.ts",
    options: { source: null, depth: null, allSources: false, allowEmpty: false },
    tsconfigFiles: ["tsconfig.base.json", "tsconfig.json"],
    ...overrides,
  })

  const graphOf = (overrides: Partial<GraphStateInput> = {}, files?: Readonly<Record<string, string>>): string =>
    graphStateOf(stateInput(overrides, files)).fingerprint.value

  it("ignores the config fields that only shape the artifacts", () => {
    expect(graphOf({ config: { depth: 4, formats: ["index", "html"], out: "elsewhere", allowEmpty: true } })).toBe(graphOf())
    expect(graphOf({ config: { depth: 5, formats: ["full"] } })).not.toBe(graphOf())
  })

  it("changes with the graph flags", () => {
    expect(graphOf({ options: { source: "next-app", depth: null, allSources: false, allowEmpty: false } })).not.toBe(graphOf())
    expect(graphOf({ options: { source: null, depth: 7, allSources: false, allowEmpty: false } })).not.toBe(graphOf())
    expect(graphOf({ options: { source: null, depth: null, allSources: true, allowEmpty: false } })).not.toBe(graphOf())
  })

  it("nests the graph hash in the run hash, which alone sees --format and --locale", () => {
    const graph = graphStateOf(stateInput()).fingerprint
    const run = (cli: unknown) => computeRunFingerprint(graph, { cli }).value
    expect(run({ formats: ["index"] })).not.toBe(run({ formats: ["html"] }))
    expect(run({ locale: "pl" })).not.toBe(run({ locale: "en" }))
    expect(run({ formats: ["index"] })).toBe(run({ formats: ["index"] }))
    expect(computeRunFingerprint(graph, {}).parts).toContain(`graph=${graph.value}`)
  })

  it("is stale when a recorded tsconfig is edited", () => {
    const edited = { ...FILES, [`${ROOT}/tsconfig.base.json`]: JSON.stringify({ compilerOptions: { strict: false } }) }
    expect(graphOf({}, edited)).not.toBe(graphOf())
  })

  it("probes the root tsconfig.json, so one appearing where none was recorded is stale", () => {
    const withoutRoot = Object.fromEntries(Object.entries(FILES).filter(([file]) => file !== `${ROOT}/tsconfig.json`))
    const before = graphOf({ tsconfigFiles: [] }, withoutRoot)
    expect(graphOf({ tsconfigFiles: [] }, FILES)).not.toBe(before)
    expect(graphOf({ tsconfigFiles: [] }, FILES)).toBe(graphOf({ tsconfigFiles: ["tsconfig.json"] }, FILES))
  })

  it("records the chain it was given, not the probed list", () => {
    expect(graphStateOf(stateInput({ tsconfigFiles: [] })).record).toMatchObject({ tsconfigFiles: [], configFile: "appgraph.config.ts" })
  })
})

describe("stickyGraphOptions", () => {
  it("falls back to the recorded graph flags only where none was given", () => {
    expect(stickyGraphOptions({ allSources: false }, GRAPH_RECORD)).toEqual(GRAPH_RECORD.options)
    expect(stickyGraphOptions({ source: "next-app", allSources: true }, GRAPH_RECORD)).toEqual({ source: "next-app", depth: 4, allSources: true, allowEmpty: false })
    expect(stickyGraphOptions({ allSources: false }, null)).toEqual({ source: null, depth: null, allSources: false, allowEmpty: false })
  })
})

describe("light template framework identities", () => {
  it("match the pipeline's framework specs on id, peer packages and applicability", () => {
    expect(TEMPLATE_FRAMEWORK_IDENTITIES.map(({ id, packages }) => ({ id, packages }))).toEqual(
      TEMPLATE_FRAMEWORKS.map(({ id, packages }) => ({ id, packages })),
    )
    for (const dependencies of [["vue"], ["nuxt"], ["@angular/core"], ["react"], []]) {
      const input = { dependencies: new Set(dependencies), files: [] }
      expect(TEMPLATE_FRAMEWORK_IDENTITIES.map((spec) => spec.appliesTo(input))).toEqual(
        TEMPLATE_FRAMEWORKS.map((spec) => spec.appliesTo(input)),
      )
    }
  })
})
