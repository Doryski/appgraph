import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import ts from "typescript"
import { afterEach, describe, expect, it } from "vitest"
import { createMemoryHost, createNodeHost } from "../../src/core/host.js"
import type { ConfigLoaderIo } from "../../src/config/load.js"
import {
  CONFIG_BASENAMES,
  CONFIG_IMPORT_LIMITATION,
  findConfigFile,
  importConfigFile,
  loadConfigFile,
  nodeConfigLoaderIo,
  nodeStripTypes,
  suggestField,
  unknownFieldMessage,
  validateConfig,
} from "../../src/config/load.js"

const created: string[] = []

const workspace = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appgraph-load-test-"))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
  }
})

const CONFIG_TS = `import { defineConfig } from "../../src/config/define.js"

export default defineConfig({ depth: 7, formats: ["index"], stringSources: ["src/paths.ts"] })
`

const PLAIN_TS = (depth: number): string =>
  `type Config = { depth: number }
const config: Config = { depth: ${String(depth)} }
export default config
`

describe("finding the config file", () => {
  it("probes the documented basenames in order", () => {
    const host = createMemoryHost({
      files: { "/repo/appgraph.config.mjs": "export default {}", "/repo/appgraph.config.js": "export default {}" },
    })
    expect(findConfigFile(host, "/repo")).toBe("appgraph.config.mjs")
    expect(CONFIG_BASENAMES[0]).toBe("appgraph.config.ts")
  })

  it("returns null when there is none, and no diagnostic unless required", async () => {
    const host = createMemoryHost({ files: { "/repo/package.json": "{}" } })
    expect(findConfigFile(host, "/repo")).toBeNull()

    const optional = await loadConfigFile({ ts, root: "/repo", host })
    expect(optional).toEqual({ file: null, config: null, diagnostics: [], unknownFields: [] })

    const required = await loadConfigFile({ ts, root: "/repo", host, required: true })
    expect(required.diagnostics.map((entry) => entry.code)).toEqual(["config/not-found"])
  })
})

describe("loading a .ts config with zero runtime dependencies", () => {
  it("transpiles, imports and returns the default export", async () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, "appgraph.config.ts"), PLAIN_TS(3), "utf8")

    const loaded = await loadConfigFile({ ts, root: dir })
    expect(loaded.file).toBe("appgraph.config.ts")
    expect(loaded.config).toEqual({ depth: 3 })
    expect(loaded.diagnostics).toEqual([])
  })

  it("cache-busts, so a second load does not return the stale module", async () => {
    const dir = workspace()
    const file = path.join(dir, "appgraph.config.ts")

    fs.writeFileSync(file, PLAIN_TS(1), "utf8")
    const first = await loadConfigFile({ ts, root: dir })

    fs.writeFileSync(file, PLAIN_TS(2), "utf8")
    const second = await loadConfigFile({ ts, root: dir })

    expect(first.config).toEqual({ depth: 1 })
    expect(second.config).toEqual({ depth: 2 })
  })

  it("cache-busts a .mjs config, which is imported in place with no temp file", async () => {
    const dir = workspace()
    const file = path.join(dir, "appgraph.config.mjs")
    const io: ConfigLoaderIo = { ...nodeConfigLoaderIo, writeFile: () => expect.fail("no temp file for .mjs") }

    fs.writeFileSync(file, "export default { depth: 1 }", "utf8")
    const first = await loadConfigFile({ ts, root: dir, io })

    fs.writeFileSync(file, "export default { depth: 2 }", "utf8")
    const second = await loadConfigFile({ ts, root: dir, io })

    expect([first.config, second.config]).toEqual([{ depth: 1 }, { depth: 2 }])
  })

  it("reads the config text through the injected host", async () => {
    const dir = workspace()
    const host = createMemoryHost({ files: { [path.join(dir, "appgraph.config.ts")]: PLAIN_TS(9) } })
    const loaded = await loadConfigFile({ ts, root: dir, host })
    expect(loaded.config).toEqual({ depth: 9 })
  })

  it("imports through a file:// URL, never a bare path", async () => {
    const specifiers: string[] = []
    const io: ConfigLoaderIo = {
      ...nodeConfigLoaderIo,
      importModule: (specifier) => {
        specifiers.push(specifier)
        return nodeConfigLoaderIo.importModule(specifier)
      },
    }

    const dir = workspace()
    const host = createMemoryHost({ files: { [path.join(dir, "appgraph.config.ts")]: PLAIN_TS(4) } })
    await loadConfigFile({ ts, root: dir, host, io })
    await loadConfigFile({ ts, root: dir, host, io })

    expect(specifiers.every((specifier) => specifier.startsWith("file://"))).toBe(true)
    expect(specifiers[0]).not.toBe(specifiers[1])
    expect(specifiers.every((specifier) => specifier.includes("?appgraph="))).toBe(true)
  })

  it("removes the temp file even when the import throws", async () => {
    const removed: string[] = []
    const io: ConfigLoaderIo = {
      ...nodeConfigLoaderIo,
      rm: (abs) => {
        removed.push(abs)
        nodeConfigLoaderIo.rm(abs)
      },
      importModule: () => Promise.reject(new Error("boom")),
    }

    const dir = workspace()
    const host = createMemoryHost({ files: { [path.join(dir, "appgraph.config.ts")]: PLAIN_TS(1) } })
    const loaded = await loadConfigFile({ ts, root: dir, host, io })

    expect(loaded.diagnostics.map((entry) => entry.code)).toEqual(["config/load-failed"])
    expect(removed).toHaveLength(1)
    expect(path.dirname(removed[0] ?? "")).toBe(dir)
    expect(fs.existsSync(removed[0] ?? "")).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it("names the specifier and the documented limitation on an unresolvable import", async () => {
    const io: ConfigLoaderIo = {
      ...nodeConfigLoaderIo,
      importModule: () =>
        Promise.reject(new Error("Cannot find module './helpers.ts' imported from /tmp/x.mjs [ERR_MODULE_NOT_FOUND]")),
    }

    const dir = workspace()
    const host = createMemoryHost({ files: { [path.join(dir, "appgraph.config.ts")]: PLAIN_TS(1) } })
    const loaded = await loadConfigFile({ ts, root: dir, host, io })
    const [diagnostic] = loaded.diagnostics

    expect(diagnostic?.code).toBe("config/unresolvable-import")
    expect(diagnostic?.message).toContain("'./helpers.ts'")
    expect(diagnostic?.message).toContain(CONFIG_IMPORT_LIMITATION)
  })

  it("reports a missing default export", async () => {
    const dir = workspace()
    const host = createMemoryHost({ files: { [path.join(dir, "appgraph.config.ts")]: "export const config = { depth: 1 }" } })
    const loaded = await loadConfigFile({ ts, root: dir, host })

    expect(loaded.config).toBeNull()
    expect(loaded.diagnostics.map((entry) => entry.code)).toEqual(["config/no-default-export"])
  })

  it("transpiles next to the config, so a relative import of a sibling .mjs resolves, and leaves nothing behind", async () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, "shared.mjs"), "export const depth = 6\n", "utf8")
    fs.writeFileSync(
      path.join(dir, "appgraph.config.mts"),
      'import { depth } from "./shared.mjs"\nconst config: { depth: number } = { depth }\nexport default config\n',
      "utf8",
    )

    const loaded = await loadConfigFile({ ts, root: dir })
    expect(loaded.diagnostics).toEqual([])
    expect(loaded.config).toEqual({ depth: 6 })
    expect(fs.readdirSync(dir).sort()).toEqual(["appgraph.config.mts", "shared.mjs"])
  })

  it("loads a .cts config as an ES module", async () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, "appgraph.config.cts"), "const config: { depth: number } = { depth: 4 }\nexport default config\n", "utf8")

    const loaded = await loadConfigFile({ ts, root: dir, file: "appgraph.config.cts" })
    expect(loaded.diagnostics).toEqual([])
    expect(loaded.config).toEqual({ depth: 4 })
  })

  it("reports config/not-found for an explicitly named file that does not exist", async () => {
    const host = createMemoryHost({ files: { "/repo/package.json": "{}" } })
    const loaded = await loadConfigFile({ ts, root: "/repo", host, file: "missing.config.ts" })
    expect(loaded.diagnostics.map((entry) => entry.code)).toEqual(["config/not-found"])
    expect(loaded.diagnostics[0]?.message).toContain("missing.config.ts")
  })

  it("importConfigFile returns the raw default export without validating it", async () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, "appgraph.config.mjs"), "export default { depth: 'deep', bogus: 1 }", "utf8")
    const imported = await importConfigFile({ ts, root: dir })
    expect(imported).toEqual({ file: "appgraph.config.mjs", exported: { depth: "deep", bogus: 1 }, diagnostics: [] })
  })

  it("loads a config that imports defineConfig from a module specifier", async () => {
    const dir = workspace()
    const importPath = path.resolve("src/config/define.ts").replace(/\.ts$/, ".js")
    fs.writeFileSync(
      path.join(dir, "appgraph.config.ts"),
      CONFIG_TS.replace('"../../src/config/define.js"', JSON.stringify(importPath)),
      "utf8",
    )

    const loaded = await loadConfigFile({ ts, root: dir })
    expect(loaded.config).toEqual({ depth: 7, formats: ["index"], stringSources: ["src/paths.ts"] })
  })
})

describe("structural validation of the default export", () => {
  it("keeps every well-typed field", () => {
    const result = validateConfig({
      depth: 3,
      out: "docs/appgraph",
      formats: ["full", "index"],
      conflicts: "first",
      strict: true,
      redirects: { unauthenticated: "/login" },
      kindRules: [{ match: { pathPrefix: "src/" }, kind: "module", traversable: false, screenEntry: true }],
      extensionRewrites: [{ from: ".js", to: [".ts"] }],
    })

    expect(result.issues).toEqual([])
    expect(result.config.depth).toBe(3)
    expect(result.config.kindRules).toHaveLength(1)
  })

  it("drops a mistyped field with a named issue instead of trusting it", () => {
    const result = validateConfig({ depth: "three", formats: "index", conflicts: "sometimes" })

    expect(result.config).toEqual({})
    expect(result.issues.map((issue) => issue.field)).toEqual(["depth", "formats", "conflicts"])
    expect(result.issues[0]?.message).toContain("finite number")
  })

  it("accepts the adapter option keys and the extractor selection", () => {
    const result = validateConfig({
      wrapperRoles: [{ name: "require-auth", role: "guard", tagRegex: "^RequireAuth$", reads: "flag" }],
      pathlessRoles: { _admin: { auth: "protected" }, _public: {} },
      entryComponents: [{ file: "src/App.tsx", exportName: "App" }, { file: "src/Popup.tsx" }],
      adminjs: { optionsFile: "src/admin/options.ts", componentLoaderFile: "src/admin/components.ts" },
      extractors: ["component-tree", "http-client"],
    })

    expect(result.issues).toEqual([])
    expect(Object.keys(result.config).sort()).toEqual([
      "adminjs",
      "entryComponents",
      "extractors",
      "pathlessRoles",
      "wrapperRoles",
    ])
  })

  it("drops a malformed adapter option with an issue naming the expected shape", () => {
    const result = validateConfig({
      wrapperRoles: [{ name: "x", role: "bouncer" }],
      pathlessRoles: { _admin: { auth: "sometimes" } },
      entryComponents: [{ exportName: "App" }],
      adminjs: { optionsFile: "a.ts", options: "b.ts" },
    })

    expect(result.config).toEqual({})
    expect(result.issues.map((issue) => issue.field)).toEqual(["wrapperRoles", "pathlessRoles", "entryComponents", "adminjs"])
    expect(result.issues[0]?.message).toContain("guard")
    expect(result.issues[3]?.message).toContain("'options'")
  })

  it("accepts vueAuth and rejects unknown sub-keys and non-string-array members", () => {
    const good = validateConfig({ vueAuth: { protectedMiddleware: ["staff"], authMetaKeys: ["needsLogin"] } })
    expect(good.issues).toEqual([])
    expect(good.config.vueAuth).toEqual({ protectedMiddleware: ["staff"], authMetaKeys: ["needsLogin"] })

    const unknown = validateConfig({ vueAuth: { guards: ["x"] } })
    expect(unknown.config).toEqual({})
    expect(unknown.issues.map((issue) => issue.field)).toEqual(["vueAuth"])
    expect(unknown.issues[0]?.message).toContain("'guards'")

    const wrong = validateConfig({ vueAuth: { publicMiddleware: "guest" } })
    expect(wrong.config).toEqual({})
    expect(wrong.issues[0]?.message).toContain("arrays of strings")
  })

  it("accepts angular and rejects unknown sub-keys, bad lists and bad publicData", () => {
    const angular = {
      protectedGuards: ["UserRightGuard"],
      publicData: [{ key: "module", value: "open" }, { key: "free", value: true }],
    }
    const good = validateConfig({ angular })
    expect(good.issues).toEqual([])
    expect(good.config.angular).toEqual(angular)

    const unknown = validateConfig({ angular: { guards: ["x"] } })
    expect(unknown.config).toEqual({})
    expect(unknown.issues.map((issue) => issue.field)).toEqual(["angular"])
    expect(unknown.issues[0]?.message).toContain("'guards'")

    const wrongList = validateConfig({ angular: { publicGuards: "guest" } })
    expect(wrongList.issues[0]?.message).toContain("arrays of strings")

    const wrongData = validateConfig({ angular: { publicData: [{ key: "a", value: 1 }] } })
    expect(wrongData.config).toEqual({})
    expect(wrongData.issues[0]?.message).toContain("publicData")
  })

  it("accepts the native keys expoRouter, reactNavigation, nativeAuth and featureFlags", () => {
    const config = {
      expoRouter: { root: "src/app" },
      reactNavigation: { pathTables: [{ callee: "Router", argument: 0 }], authOptionKeys: ["needsLogin"] },
      nativeAuth: { signedIn: ["isAuthed"] },
      featureFlags: { lookupFunctions: ["enabled"] },
    }
    const result = validateConfig(config)
    expect(result.issues).toEqual([])
    expect(result.config).toEqual(config)
  })

  it("rejects unknown sub-keys of the native keys", () => {
    const result = validateConfig({
      expoRouter: { routesDir: "app" },
      reactNavigation: { linking: [] },
      nativeAuth: { signedInPattern: ["x"] },
      featureFlags: { functions: ["x"] },
    })
    expect(result.config).toEqual({})
    expect(result.issues.map((issue) => issue.field)).toEqual([
      "expoRouter",
      "reactNavigation",
      "nativeAuth",
      "featureFlags",
    ])
    expect(result.issues[0]?.message).toContain("'routesDir'")
    expect(result.issues[2]?.message).toContain("'signedInPattern'")
  })

  it("rejects wrong types inside the native keys", () => {
    const cases = [
      { expoRouter: { root: 1 } },
      { reactNavigation: { authOptionKeys: "requireAuth" } },
      { reactNavigation: { pathTables: [{ callee: "Router" }] } },
      { reactNavigation: { pathTables: [{ callee: "Router", argument: -1 }] } },
      { reactNavigation: { pathTables: [{ callee: "Router", argument: 0, extra: true }] } },
      { nativeAuth: { signedIn: "isSignedIn" } },
      { featureFlags: { lookupFunctions: [1] } },
      { featureFlags: ["enabled"] },
    ]
    for (const config of cases) {
      const result = validateConfig(config)
      expect(result.config).toEqual({})
      expect(result.issues).toHaveLength(1)
    }
  })

  it("suggests the nested native key for a top-level sub-key", () => {
    expect(suggestField("lookupFunctions")).toBe("featureFlags.lookupFunctions")
    expect(suggestField("signedIn")).toBe("nativeAuth.signedIn")
    expect(suggestField("pathTables")).toBe("reactNavigation.pathTables")
  })

  it("keeps redirectRules apart from redirects and rejects a bad shape in the loader's style", () => {
    const good = validateConfig({
      redirects: { unauthenticated: "/login" },
      redirectRules: [{ source: "/org/:slug", destination: "/org/:slug/general" }],
    })
    expect(good.issues).toEqual([])
    expect(good.config.redirectRules).toEqual([{ source: "/org/:slug", destination: "/org/:slug/general" }])
    expect(good.config.redirects).toEqual({ unauthenticated: "/login" })

    for (const redirectRules of [{ source: "/a", destination: "/b" }, [{ source: "/a" }], [{ source: "/a", destination: 1 }], ["/a"]]) {
      const bad = validateConfig({ redirectRules })
      expect(bad.config).toEqual({})
      expect(bad.issues).toEqual([{ field: "redirectRules", message: "expected an array of { source, destination }" }])
    }
  })

  it("accepts a reactRouter route dialect", () => {
    const reactRouter = {
      routeDialect: {
        name: "sentry",
        fields: { component: "component", redirect: "redirectTo" },
        translators: ["translateSentryRoute"],
        unwrapCalls: ["errorHandler", "memoize"],
        prefixRules: [{ flag: "withOrgPath", prefix: "/organizations/:orgId", keepPlain: true }],
      },
    }
    const result = validateConfig({ reactRouter })

    expect(result.issues).toEqual([])
    expect(result.config.reactRouter).toEqual(reactRouter)
    expect(validateConfig({ reactRouter: {} }).issues).toEqual([])
  })

  it("rejects an unknown key or a wrong type in reactRouter with the exact message", () => {
    const cases = [
      [[], "expected an object"],
      [{ dialect: {} }, "expected only 'routeDialect' (got 'dialect')"],
      [{ routeDialect: "sentry" }, "expected 'routeDialect' to be an object"],
      [
        { routeDialect: { name: "x", aliases: {} } },
        "expected 'routeDialect' to have only 'name', 'fields', 'translators', 'unwrapCalls' and 'prefixRules' (got 'aliases')",
      ],
      [{ routeDialect: { name: 1 } }, "expected 'routeDialect.name' to be a string"],
      [{ routeDialect: { fields: [] } }, "expected 'routeDialect.fields' to be an object"],
      [
        { routeDialect: { fields: { path: "p", loader: "l" } } },
        "expected 'routeDialect.fields' to have only 'path', 'element', 'component', 'children', 'redirect', 'index' and 'lazy' (got 'loader')",
      ],
      [{ routeDialect: { fields: { path: 1 } } }, "expected 'routeDialect.fields' values to be strings"],
      [{ routeDialect: { translators: "translate" } }, "expected 'routeDialect.translators' to be an array of strings"],
      [{ routeDialect: { unwrapCalls: [1] } }, "expected 'routeDialect.unwrapCalls' to be an array of strings"],
      [
        { routeDialect: { prefixRules: [{ flag: "withOrgPath", prefix: "/o" }] } },
        "expected 'routeDialect.prefixRules' to be an array of { flag: string, prefix: string, keepPlain: boolean }",
      ],
    ] as const

    for (const [reactRouter, message] of cases) {
      const result = validateConfig({ reactRouter })
      expect(result.config).toEqual({})
      expect(result.issues).toEqual([{ field: "reactRouter", message }])
    }
  })

  it("accepts entryFrom on a wrapper rule and rejects a non-string one", () => {
    const wrapperRoles = [{ name: "protected-route", role: "guard", entryFrom: "component" }]
    expect(validateConfig({ wrapperRoles }).config.wrapperRoles).toEqual(wrapperRoles)

    const bad = validateConfig({ wrapperRoles: [{ name: "protected-route", role: "guard", entryFrom: 1 }] })
    expect(bad.config).toEqual({})
    expect(bad.issues[0]?.message).toContain("entryFrom?")
  })

  it("rejects a kind rule or wrapper rule whose regex does not compile, naming the entry", () => {
    const kind = validateConfig({
      kindRules: [
        { match: { pathPrefix: "src/" }, kind: "module", traversable: false, screenEntry: true },
        { match: { pathRegex: "([" }, kind: "module", traversable: false, screenEntry: true },
      ],
    })
    expect(kind.config).toEqual({})
    expect(kind.issues[0]?.field).toBe("kindRules")
    expect(kind.issues[0]?.message).toContain("kindRules[1].match.pathRegex to be a valid regular expression")

    const fileRegex = validateConfig({ kindRules: [{ match: { fileRegex: "*" }, kind: "ui", traversable: false, screenEntry: false }] })
    expect(fileRegex.issues[0]?.message).toContain("kindRules[0].match.fileRegex")

    const wrapper = validateConfig({ wrapperRoles: [{ name: "x", role: "guard", tagRegex: "([" }] })
    expect(wrapper.config).toEqual({})
    expect(wrapper.issues[0]?.message).toContain("wrapperRoles[0].tagRegex to be a valid regular expression")
  })

  it("rejects a kind rule with a non-string match field or a non-numeric priority", () => {
    for (const rule of [
      { match: { pathPrefix: 5 }, kind: "ui", traversable: false, screenEntry: false },
      { match: {}, kind: "ui", traversable: false, screenEntry: false, priority: "high" },
    ])
      expect(validateConfig({ kindRules: [rule] }).issues.map((issue) => issue.field)).toEqual(["kindRules"])
  })

  it("validates menu name, basePath and fields types", () => {
    const good = validateConfig({
      menus: [{ file: "src/nav.ts", export: "menu", name: "Main", basePath: "/admin", fields: { target: "href" } }],
    })
    expect(good.issues).toEqual([])

    for (const menu of [
      { file: "src/nav.ts", export: "menu", basePath: 5 },
      { file: "src/nav.ts", export: "menu", name: [] },
      { file: "src/nav.ts", export: "menu", fields: "href" },
      { file: "src/nav.ts", export: "menu", fields: { target: 1 } },
      { file: "src/nav.ts", export: "menu", fields: { url: "href" } },
    ]) {
      const bad = validateConfig({ menus: [menu] })
      expect(bad.config).toEqual({})
      expect(bad.issues.map((issue) => issue.field)).toEqual(["menus"])
    }
  })

  it("hints reactRouter.routeDialect for a top-level routeDialect", () => {
    expect(suggestField("routeDialect")).toBe("reactRouter.routeDialect")
    expect(unknownFieldMessage("routeDialect")).toBe("unknown config field 'routeDialect' ignored. Did you mean 'reactRouter.routeDialect'?")
  })

  it("suggests the field an unknown key most plausibly meant", () => {
    expect(suggestField("pathless")).toBe("pathlessRoles")
    expect(suggestField("optionsFile")).toBe("adminjs.optionsFile")
    expect(suggestField("wraperRoles")).toBe("wrapperRoles")
    expect(suggestField("extractor")).toBe("extractors")
    expect(suggestField("somethingElseEntirely")).toBeNull()
  })

  it("reports an unknown field as an error and ignores it", async () => {
    const dir = workspace()
    const host = createMemoryHost({
      files: { [path.join(dir, "appgraph.config.ts")]: "export default { plugins: [], depth: 2 }" },
    })
    const loaded = await loadConfigFile({ ts, root: dir, host })

    expect(loaded.config).toEqual({ depth: 2 })
    expect(loaded.unknownFields).toEqual(["plugins"])
    expect(loaded.diagnostics.map((entry) => entry.code)).toEqual(["config/unknown-field"])
    expect(loaded.diagnostics[0]?.severity).toBe("error")
    expect(loaded.diagnostics[0]?.message).toContain("Known fields:")
  })

  it("rejects a non-object default export", () => {
    expect(validateConfig(["nope"]).issues.map((issue) => issue.field)).toEqual(["default"])
    expect(validateConfig(null).config).toEqual({})
  })

  it("treats a config that sets nothing as no config at all", () => {
    expect(validateConfig({}).config).toEqual({})
  })

  it("uses the node host by default", () => {
    expect(findConfigFile(createNodeHost(), os.tmpdir())).toBeNull()
  })
})

describe("loading a .ts config without the compiler (C1)", () => {
  const noCompiler = () => Promise.reject(new Error("the compiler must not load"))

  const ENUM_TS = `enum Depth { Shallow = 2, Deep = 9 }
export default { depth: Depth.Deep }
`

  it.skipIf(nodeStripTypes() === null)("strips the types natively and never loads typescript", async () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, "appgraph.config.ts"), PLAIN_TS(4), "utf8")

    const loaded = await loadConfigFile({ root: dir, loadTs: noCompiler })
    expect(loaded.diagnostics).toEqual([])
    expect(loaded.config).toEqual({ depth: 4 })
  })

  it("falls back to the compiler for syntax type stripping cannot erase, such as an enum", async () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, "appgraph.config.ts"), ENUM_TS, "utf8")

    const loaded = await loadConfigFile({ root: dir, loadTs: () => Promise.resolve(ts) })
    expect(loaded.diagnostics).toEqual([])
    expect(loaded.config).toEqual({ depth: 9 })
  })

  it.skipIf(nodeStripTypes() === null)("falls back to the compiler when the stripped module fails to link", async () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, "appgraph.config.ts"), PLAIN_TS(6), "utf8")
    const written: string[] = []
    const io: ConfigLoaderIo = {
      ...nodeConfigLoaderIo,
      writeFile: (abs, content) => {
        written.push(content)
        nodeConfigLoaderIo.writeFile(abs, content)
      },
      importModule: (specifier) =>
        written.length === 1
          ? Promise.reject(new SyntaxError("The requested module does not provide an export named 'Config'"))
          : nodeConfigLoaderIo.importModule(specifier),
    }

    const loaded = await loadConfigFile({ root: dir, io, loadTs: () => Promise.resolve(ts) })
    expect(loaded.diagnostics).toEqual([])
    expect(loaded.config).toEqual({ depth: 6 })
    expect(written).toHaveLength(2)
    expect(fs.readdirSync(dir)).toEqual(["appgraph.config.ts"])
  })

  it("uses the compiler when type stripping is unavailable", async () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, "appgraph.config.ts"), PLAIN_TS(5), "utf8")

    const loaded = await loadConfigFile({ root: dir, stripTypes: null, loadTs: () => Promise.resolve(ts) })
    expect(loaded.config).toEqual({ depth: 5 })
    expect(fs.readdirSync(dir)).toEqual(["appgraph.config.ts"])
  })

  it("reports a config the compiler is needed for but cannot load as a load failure", async () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, "appgraph.config.ts"), PLAIN_TS(5), "utf8")

    const loaded = await loadConfigFile({ root: dir, stripTypes: null, loadTs: noCompiler })
    expect(loaded.diagnostics.map((entry) => entry.code)).toEqual(["config/load-failed"])
    expect(fs.readdirSync(dir)).toEqual(["appgraph.config.ts"])
  })
})
