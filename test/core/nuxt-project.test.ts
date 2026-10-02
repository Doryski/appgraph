import { describe, expect, it } from "vitest"
import ts from "typescript"
import { createMemoryHost } from "../../src/core/host.js"
import { hasNuxtDependency, resolveNuxtDirs } from "../../src/core/nuxt-project.js"

const resolve = (files: Record<string, string>, root = "/repo") =>
  resolveNuxtDirs({ ts, host: createMemoryHost({ files }), root })

describe("resolveNuxtDirs", () => {
  it("defaults to the root srcDir with one prefixed components dir when no config exists", () => {
    expect(resolve({ "/repo/pages/index.vue": "" })).toEqual({
      srcDir: ".",
      pagesDir: "pages",
      layoutsDir: "layouts",
      middlewareDir: "middleware",
      componentDirs: [{ path: "components", pathPrefix: true }],
      extends: [],
      unreadable: [],
    })
  })

  it.each([
    ["app/pages", "/repo/app/pages/index.vue"],
    ["app/app.vue", "/repo/app/app.vue"],
  ])("defaults srcDir to app/ when %s exists (Nuxt 4)", (_label, file) => {
    const dirs = resolve({ [file]: "", "/repo/nuxt.config.ts": "export default defineNuxtConfig({})" })

    expect(dirs.srcDir).toBe("app")
    expect(dirs.pagesDir).toBe("app/pages")
    expect(dirs.componentDirs).toEqual([{ path: "app/components", pathPrefix: true }])
  })

  it("reads the OpnForm components array of strings and objects against srcDir", () => {
    const dirs = resolve({
      "/repo/nuxt.config.ts": `export default defineNuxtConfig({
        components: [
          { path: '~/components/forms/core', pathPrefix: false, global: true },
          { path: '~/components/global', pathPrefix: false },
          { path: '@/components/ui', prefix: 'Ui' },
          '~/components',
        ],
      })`,
    })

    expect(dirs.componentDirs).toEqual([
      { path: "components/forms/core", pathPrefix: false },
      { path: "components/global", pathPrefix: false },
      { path: "components/ui", pathPrefix: true, prefix: "Ui" },
      { path: "components", pathPrefix: true },
    ])
    expect(dirs.unreadable).toEqual([])
  })

  it("reads literal srcDir, dir.* and components.dirs, resolving ~~ against the root", () => {
    const dirs = resolve({
      "/repo/nuxt.config.mjs": `const config = {
        srcDir: 'src/',
        dir: { pages: 'views', layouts: 'shells' },
        components: { dirs: ['~/widgets', '~~/shared/components'] },
      }
      export default config`,
    })

    expect(dirs).toMatchObject({
      srcDir: "src",
      pagesDir: "src/views",
      layoutsDir: "src/shells",
      middlewareDir: "src/middleware",
      componentDirs: [
        { path: "src/widgets", pathPrefix: true },
        { path: "shared/components", pathPrefix: true },
      ],
      unreadable: [],
    })
  })

  it("reads extends as a string or an array", () => {
    expect(resolve({ "/repo/nuxt.config.ts": "export default defineNuxtConfig({ extends: '../base' })" }).extends).toEqual([
      "../base",
    ])
    expect(
      resolve({
        "/repo/nuxt.config.ts": "export default defineNuxtConfig({ extends: ['@kungal/ui-nuxt', '@kungal/editor-nuxt'] })",
      }).extends,
    ).toEqual(["@kungal/ui-nuxt", "@kungal/editor-nuxt"])
  })

  it("records non-literal values as unreadable and falls back to defaults", () => {
    const dirs = resolve({
      "/repo/app/app.vue": "",
      "/repo/nuxt.config.ts": `export default defineNuxtConfig({
        srcDir: process.env.SRC,
        dir: { pages: pagesDir() },
        components: [...extra, { path: resolveDir('x') }, '~/components'],
        extends: ['./base', layer],
      })`,
    })

    expect(dirs).toMatchObject({
      srcDir: "app",
      pagesDir: "app/pages",
      componentDirs: [{ path: "app/components", pathPrefix: true }],
      extends: ["./base"],
      unreadable: ["srcDir", "dir.pages", "components[0]", "components[1]", "extends[1]"],
    })
  })

  it("disables component dirs with components: false", () => {
    expect(resolve({ "/repo/nuxt.config.ts": "export default { components: false }" }).componentDirs).toEqual([])
  })

  it("marks a config it cannot locate an object in as unreadable", () => {
    expect(resolve({ "/repo/nuxt.config.ts": "export default createConfig()" }).unreadable).toEqual(["nuxt.config"])
  })
})

describe("hasNuxtDependency", () => {
  it.each([
    [{ dependencies: { nuxt: "^4.0.0" } }, true],
    [{ devDependencies: { nuxt: "^3.17.1" } }, true],
    [{ dependencies: { vue: "^3.5.0" } }, false],
  ])("reads %j as %s", (manifest, expected) => {
    expect(hasNuxtDependency(createMemoryHost({ files: { "/repo/package.json": JSON.stringify(manifest) } }), "/repo")).toBe(
      expected,
    )
  })

  it("is false without a manifest", () => {
    expect(hasNuxtDependency(createMemoryHost({ files: {} }), "/repo")).toBe(false)
  })
})
