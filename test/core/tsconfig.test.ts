import { describe, expect, it } from "vitest"
import ts from "typescript"
import { createMemoryHost } from "../../src/core/host.js"
import { EMPTY_TSCONFIG_CHAIN, isNodeStyleModuleResolution, loadTsconfig } from "../../src/core/tsconfig.js"

const load = (files: Record<string, string>, root = "/repo") =>
  loadTsconfig({ ts, host: createMemoryHost({ files }), root })

describe("loadTsconfig", () => {
  it("follows extends and merges compilerOptions from the whole chain", () => {
    const result = load({
      "/repo/tsconfig.base.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["src/*"] },
          moduleResolution: "bundler",
        },
      }),
      "/repo/tsconfig.json": JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { jsx: "react-jsx" },
        include: ["src"],
      }),
      "/repo/src/index.ts": "",
    })

    expect(result.diagnostics).toEqual([])
    expect(result.chain.files).toEqual(["tsconfig.base.json", "tsconfig.json"])
    expect(result.chain.baseUrl).toBe("")
    expect(result.chain.paths).toEqual({ "@/*": ["src/*"] })
    expect(result.chain.include).toEqual(["src"])
    expect(result.chain.moduleResolution).toBe("bundler")
    expect(result.chain.jsx).toBe("reactjsx")
  })

  it("keeps ALL targets of a paths entry, in declaration order", () => {
    const result = load({
      "/repo/tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["src/*", "vendor/*", "generated/*"] },
        },
      }),
    })

    expect(result.chain.paths["@/*"]).toEqual(["src/*", "vendor/*", "generated/*"])
  })

  it("preserves non-wildcard path entries alongside wildcard ones", () => {
    const result = load({
      "/repo/tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["src/*"],
            "@/config": ["src/config.tsx"],
            "@/env": ["src/env.ts"],
          },
        },
      }),
    })

    expect(Object.keys(result.chain.paths)).toEqual(["@/*", "@/config", "@/env"])
    expect(result.chain.paths["@/config"]).toEqual(["src/config.tsx"])
  })

  it("reports a child override of an inherited paths key", () => {
    const result = load({
      "/repo/tsconfig.base.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["base/*"] } },
      }),
      "/repo/tsconfig.json": JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { paths: { "@/*": ["src/*"] } },
      }),
    })

    expect(result.chain.paths["@/*"]).toEqual(["src/*"])
  })

  it("reports a missing tsconfig as a diagnostic instead of throwing", () => {
    const result = load({ "/repo/package.json": "{}" })

    expect(result.chain).toEqual(EMPTY_TSCONFIG_CHAIN)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.code).toBe("project/no-tsconfig")
    expect(result.diagnostics[0]?.file).toBe("tsconfig.json")
  })

  it("surfaces nodenext module resolution, which drives extension rewrites", () => {
    const result = load({
      "/repo/tsconfig.json": JSON.stringify({
        compilerOptions: { module: "nodenext", moduleResolution: "nodenext" },
      }),
    })

    expect(result.chain.moduleResolution).toBe("nodenext")
    expect(isNodeStyleModuleResolution(result.chain.moduleResolution)).toBe(true)
    expect(isNodeStyleModuleResolution("bundler")).toBe(false)
  })

  describe("project references (solution-style root)", () => {
    const viteTemplate = (rootOptions: Record<string, unknown> = {}) => ({
      "/repo/tsconfig.json": `{
        // JSONC, as the Vite template ships it
        "files": [],
        "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.app.json" }],
        "compilerOptions": ${JSON.stringify(rootOptions)},
      }`,
      "/repo/tsconfig.base.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
      "/repo/tsconfig.app.json": JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { moduleResolution: "bundler", paths: { "@/*": ["./src/*"] } },
        include: ["src"],
      }),
      "/repo/tsconfig.node.json": JSON.stringify({
        compilerOptions: { moduleResolution: "node16" },
        include: ["vite.config.ts"],
      }),
      "/repo/vite.config.ts": "",
      "/repo/src/main.tsx": "",
      "/repo/src/components/Button.tsx": "",
    })

    it("follows the reference covering the most source files and keeps its extends chain", () => {
      const result = load(viteTemplate())

      expect(result.diagnostics).toEqual([])
      expect(result.chain.files).toEqual(["tsconfig.json", "tsconfig.base.json", "tsconfig.app.json"])
      expect(result.chain.paths).toEqual({ "@/*": ["./src/*"] })
      expect(result.chain.include).toEqual(["src"])
      expect(result.chain.moduleResolution).toBe("bundler")
      expect(result.chain.jsx).toBe("reactjsx")
    })

    it("keeps the root's paths when the picked reference declares none", () => {
      const files = {
        ...viteTemplate({ baseUrl: ".", paths: { "~/*": ["./src/*"] } }),
        "/repo/tsconfig.app.json": JSON.stringify({ include: ["src"] }),
      }
      const result = load(files)

      expect(result.chain.paths).toEqual({ "~/*": ["./src/*"] })
      expect(result.chain.baseUrl).toBe("")
      expect(result.chain.files.at(-1)).toBe("tsconfig.json")
    })

    it("resolves a directory reference to its tsconfig.json and rebases its include", () => {
      const result = load({
        "/repo/tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./web" }] }),
        "/repo/web/tsconfig.json": JSON.stringify({
          compilerOptions: { paths: { "@/*": ["./src/*"] } },
          include: ["src"],
        }),
        "/repo/web/src/main.tsx": "",
      })

      expect(result.chain.files).toEqual(["tsconfig.json", "web/tsconfig.json"])
      expect(result.chain.include).toEqual(["web/src"])
    })

    it("breaks ties by reference order and ignores references that cover nothing", () => {
      const result = load({
        "/repo/tsconfig.json": JSON.stringify({
          files: [],
          references: [{ path: "./missing.json" }, { path: "./a.json" }, { path: "./b.json" }],
        }),
        "/repo/a.json": JSON.stringify({ compilerOptions: { paths: { "a/*": ["src/*"] } }, include: ["src"] }),
        "/repo/b.json": JSON.stringify({ compilerOptions: { paths: { "b/*": ["src/*"] } }, include: ["src/**/*"] }),
        "/repo/src/main.tsx": "",
      })

      expect(Object.keys(result.chain.paths)).toEqual(["a/*"])
    })

    it("matches a single-segment glob against direct children only", () => {
      const result = load({
        "/repo/tsconfig.json": JSON.stringify({
          files: [],
          references: [{ path: "./tsconfig.dev.json" }, { path: "./tsconfig.app.json" }],
        }),
        "/repo/tsconfig.dev.json": JSON.stringify({ compilerOptions: { paths: { "dev/*": ["./*"] } }, include: ["./*.ts"] }),
        "/repo/tsconfig.app.json": JSON.stringify({ compilerOptions: { paths: { "src/*": ["./src/*"] } }, include: ["src"] }),
        "/repo/vite.config.ts": "",
        "/repo/src/main.tsx": "",
        "/repo/src/router.tsx": "",
      })

      expect(Object.keys(result.chain.paths)).toEqual(["src/*"])
    })

    it.each([
      { name: "a globbed directory include covers the files under it", include: ["apps/*/src"] },
      { name: "a bracketed directory name is literal, as tsc reads it", include: ["app/[locale]"] },
      { name: "a trailing ** covers everything below it", include: ["apps/**"] },
    ])("$name", ({ include }) => {
      const result = load({
        "/repo/tsconfig.json": JSON.stringify({
          files: [],
          references: [{ path: "./tsconfig.node.json" }, { path: "./tsconfig.app.json" }],
        }),
        "/repo/tsconfig.node.json": JSON.stringify({ compilerOptions: { paths: { "node/*": ["./*"] } }, include: ["vite.config.ts"] }),
        "/repo/tsconfig.app.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } }, include }),
        "/repo/vite.config.ts": "",
        "/repo/apps/web/src/main.tsx": "",
        "/repo/apps/web/src/router.tsx": "",
        "/repo/app/[locale]/page.tsx": "",
        "/repo/app/[locale]/layout.tsx": "",
      })

      expect(Object.keys(result.chain.paths)).toEqual(["@/*"])
    })

    it("counts coverage with discovery's exclusion rules (.gitignore, dot-directories)", () => {
      const result = load({
        "/repo/.gitignore": "out/\n",
        "/repo/tsconfig.json": JSON.stringify({
          files: [],
          references: [{ path: "./out.json" }, { path: "./dot.json" }, { path: "./app.json" }],
        }),
        "/repo/out.json": JSON.stringify({ compilerOptions: { paths: { "out/*": ["out/*"] } }, include: ["out"] }),
        "/repo/dot.json": JSON.stringify({ compilerOptions: { paths: { "dot/*": [".gen/*"] } }, include: [".gen"] }),
        "/repo/app.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } }, include: ["src"] }),
        "/repo/out/a.tsx": "",
        "/repo/out/b.tsx": "",
        "/repo/.gen/a.tsx": "",
        "/repo/.gen/b.tsx": "",
        "/repo/src/main.tsx": "",
      })

      expect(Object.keys(result.chain.paths)).toEqual(["@/*"])
    })

    it("does not follow references from a root that includes files itself", () => {
      const result = load({
        "/repo/tsconfig.json": JSON.stringify({
          compilerOptions: { paths: { "root/*": ["src/*"] } },
          include: ["src"],
          references: [{ path: "./tsconfig.app.json" }],
        }),
        "/repo/tsconfig.app.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }),
        "/repo/src/main.tsx": "",
      })

      expect(result.chain.files).toEqual(["tsconfig.json"])
      expect(Object.keys(result.chain.paths)).toEqual(["root/*"])
    })

    it("ignores a referenced solution that covers no files itself", () => {
      const result = load({
        "/repo/tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./inner.json" }] }),
        "/repo/inner.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.json" }] }),
        "/repo/src/main.tsx": "",
      })

      expect(result.chain.files).toEqual(["tsconfig.json"])
    })
  })

  describe("package extends", () => {
    const appConfig = (extendsSpec: string) =>
      JSON.stringify({ extends: extendsSpec, compilerOptions: { paths: { "@/*": ["./src/*"] } }, include: ["src"] })
    const sharedConfig = JSON.stringify({ compilerOptions: { moduleResolution: "bundler", jsx: "react-jsx" } })

    it("resolves through an installed node_modules package", () => {
      const result = load(
        {
          "/mono/apps/web/src/main.tsx": "",
          "/mono/apps/web/tsconfig.json": appConfig("@acme/tsconfig/react.json"),
          "/mono/node_modules/@acme/tsconfig/package.json": JSON.stringify({ name: "@acme/tsconfig" }),
          "/mono/node_modules/@acme/tsconfig/react.json": sharedConfig,
        },
        "/mono/apps/web",
      )

      expect(result.diagnostics).toEqual([])
      expect(result.chain.files).toEqual(["../../node_modules/@acme/tsconfig/react.json", "tsconfig.json"])
      expect(result.chain.moduleResolution).toBe("bundler")
    })

    it.each([
      ["pnpm-workspace.yaml", { "/mono/pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - \"packages/*\"\n" }],
      ["package.json workspaces", { "/mono/package.json": JSON.stringify({ workspaces: ["apps/*", "packages/*"] }) }],
      [
        "package.json workspaces.packages",
        { "/mono/package.json": JSON.stringify({ workspaces: { packages: ["apps/*", "packages/*"] } }) },
      ],
    ])("falls back to the workspace package by name when nothing is installed (%s)", (_label, workspace) => {
      const result = load(
        {
          ...workspace,
          "/mono/apps/web/src/main.tsx": "",
          "/mono/apps/web/tsconfig.json": appConfig("@acme/tsconfig/react.json"),
          "/mono/packages/config/package.json": JSON.stringify({ name: "@acme/tsconfig" }),
          "/mono/packages/config/react.json": sharedConfig,
        },
        "/mono/apps/web",
      )

      expect(result.diagnostics).toEqual([])
      expect(result.chain.files).toEqual(["../../packages/config/react.json", "tsconfig.json"])
      expect(result.chain.jsx).toBe("reactjsx")
    })

    it("finds a workspace package nested deeper than one level through a `**` pattern", () => {
      const result = load(
        {
          "/mono/pnpm-workspace.yaml": "packages:\n  - 'packages/**'\n",
          "/mono/apps/web/src/main.tsx": "",
          "/mono/apps/web/tsconfig.json": appConfig("@acme/tsconfig/react.json"),
          "/mono/packages/tooling/config/package.json": JSON.stringify({ name: "@acme/tsconfig" }),
          "/mono/packages/tooling/config/react.json": sharedConfig,
        },
        "/mono/apps/web",
      )

      expect(result.diagnostics).toEqual([])
      expect(result.chain.files).toEqual(["../../packages/tooling/config/react.json", "tsconfig.json"])
    })

    it("honours a `!` negation, so an excluded directory never answers for a package name", () => {
      const result = load(
        {
          "/mono/package.json": JSON.stringify({ workspaces: ["packages/*", "!packages/legacy"] }),
          "/mono/apps/web/src/main.tsx": "",
          "/mono/apps/web/tsconfig.json": appConfig("@acme/tsconfig/react.json"),
          "/mono/packages/legacy/package.json": JSON.stringify({ name: "@acme/tsconfig" }),
          "/mono/packages/legacy/react.json": sharedConfig,
        },
        "/mono/apps/web",
      )

      expect(result.diagnostics).toHaveLength(1)
      expect(result.diagnostics[0]).toMatchObject({ severity: "warning", code: "project/tsconfig-error" })
    })

    it("resolves a bare workspace package to its tsconfig.json", () => {
      const result = load(
        {
          "/mono/pnpm-workspace.yaml": "packages:\n  - packages/*\n",
          "/mono/apps/web/src/main.tsx": "",
          "/mono/apps/web/tsconfig.json": appConfig("@acme/tsconfig"),
          "/mono/packages/config/package.json": JSON.stringify({ name: "@acme/tsconfig" }),
          "/mono/packages/config/tsconfig.json": sharedConfig,
        },
        "/mono/apps/web",
      )

      expect(result.chain.files).toEqual(["../../packages/config/tsconfig.json", "tsconfig.json"])
    })

    it("downgrades an unresolvable extends to one warning, through references too, and keeps its own options", () => {
      const result = load({
        "/repo/tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }),
        "/repo/tsconfig.app.json": appConfig("@missing/tsconfig/react.json"),
        "/repo/src/main.tsx": "",
      })

      expect(result.diagnostics).toHaveLength(1)
      expect(result.diagnostics[0]).toMatchObject({
        severity: "warning",
        code: "project/tsconfig-error",
        file: "tsconfig.app.json",
      })
      expect(result.chain.paths).toEqual({ "@/*": ["./src/*"] })
    })
  })

  it("emits no absolute paths in the chain", () => {
    const result = load({
      "/repo/tsconfig.base.json": JSON.stringify({ compilerOptions: { baseUrl: "./src" } }),
      "/repo/tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json" }),
    })

    expect(result.chain.files.every((file) => !file.startsWith("/"))).toBe(true)
    expect(result.chain.baseUrl).toBe("src")
  })

  describe("Nuxt projects", () => {
    const nuxtManifest = JSON.stringify({ devDependencies: { nuxt: "^3.17.1" } })

    const opnFormShape = {
      "/repo/package.json": nuxtManifest,
      "/repo/tsconfig.json": `{
        // https://nuxt.com/docs/guide/concepts/typescript
        "extends": "./.nuxt/tsconfig.json"
      }`,
      "/repo/nuxt.config.ts": "export default defineNuxtConfig({ components: ['~/components'] })",
      "/repo/pages/index.vue": "",
      "/repo/components/Button.vue": "",
    }

    it("downgrades the ungenerated .nuxt tsconfig to an info and applies the default aliases", () => {
      const result = load(opnFormShape)

      expect(result.diagnostics).toEqual([
        {
          severity: "info",
          code: "project/tsconfig-error",
          message: ".nuxt/tsconfig.json is generated by `nuxi prepare`; default aliases applied.",
          plugin: null,
          file: "tsconfig.json",
        },
      ])
      expect(result.chain.paths).toEqual({
        "@/*": ["./*"],
        "@@/*": ["./*"],
        "~/*": ["./*"],
        "~~/*": ["./*"],
      })
    })

    it("points the srcDir aliases at app/ for the Nuxt 4 references shape", () => {
      const result = load({
        "/repo/package.json": JSON.stringify({ dependencies: { nuxt: "^4.4.7" } }),
        "/repo/tsconfig.json": JSON.stringify({
          references: [{ path: "./.nuxt/tsconfig.app.json" }, { path: "./.nuxt/tsconfig.server.json" }],
          files: [],
        }),
        "/repo/nuxt.config.ts": "export default defineNuxtConfig({ extends: ['@kungal/ui-nuxt'] })",
        "/repo/app/app.vue": "",
        "/repo/app/pages/index.vue": "",
      })

      expect(result.diagnostics).toEqual([])
      expect(result.chain.paths).toEqual({
        "@/*": ["./app/*"],
        "@@/*": ["./*"],
        "~/*": ["./app/*"],
        "~~/*": ["./*"],
      })
    })

    it("keeps an alias the tsconfig already declares", () => {
      const result = load({
        "/repo/package.json": nuxtManifest,
        "/repo/tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      })

      expect(result.chain.paths).toEqual({
        "@/*": ["./src/*"],
        "@@/*": ["./*"],
        "~/*": ["./*"],
        "~~/*": ["./*"],
      })
    })

    it("leaves a non-Nuxt project's missing extends an error without aliases", () => {
      const result = load({ ...opnFormShape, "/repo/package.json": JSON.stringify({ dependencies: { vue: "^3.5.0" } }) })

      expect(result.diagnostics).toHaveLength(1)
      expect(result.diagnostics[0]).toMatchObject({ severity: "error", code: "project/tsconfig-error" })
      expect(result.diagnostics[0]?.message).toMatch(/^Cannot read file '.*\/\.nuxt\/tsconfig\.json'\.$/)
      expect(result.chain.paths).toEqual({})
    })
  })
})

describe("moduleSuffixes", () => {
  const SUFFIXES = [".ios", ".android", ".native", ""]

  it("reads moduleSuffixes into the chain", () => {
    const result = load({
      "/repo/tsconfig.json": JSON.stringify({ compilerOptions: { moduleSuffixes: SUFFIXES }, include: ["src"] }),
    })
    expect(result.chain.moduleSuffixes).toEqual(SUFFIXES)
  })

  it("omits moduleSuffixes when unset", () => {
    const result = load({ "/repo/tsconfig.json": JSON.stringify({ include: ["src"] }) })
    expect(result.chain).not.toHaveProperty("moduleSuffixes")
    expect(EMPTY_TSCONFIG_CHAIN).not.toHaveProperty("moduleSuffixes")
  })

  it("lets a referenced config win over the solution", () => {
    const result = load({
      "/repo/tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }),
      "/repo/tsconfig.app.json": JSON.stringify({ compilerOptions: { moduleSuffixes: SUFFIXES }, include: ["src"] }),
      "/repo/src/index.ts": "",
    })
    expect(result.chain.moduleSuffixes).toEqual(SUFFIXES)
  })
})
