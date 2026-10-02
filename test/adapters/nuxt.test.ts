import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import type { Screen } from "../../src/core/model.js"
import { createNuxtAdapter, detectNuxt, nuxtRouteNameOf } from "../../src/adapters/nuxt.js"
import { SOURCE_SCORES } from "../../src/detect/index.js"
import { createProjectProbe } from "../../src/detect/project.js"
import { ROOT, run, withProject } from "../pipeline/harness.js"
import { realVueCompiler } from "../extractors/harness.js"
import { resolveConfig } from "../../src/config/types.js"
import { runPipeline } from "../../src/pipeline/run.js"

const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: "." }, include: ["**/*"] })

const manifest = (dependencies: Readonly<Record<string, string>>): string =>
  JSON.stringify({ name: "fixture", dependencies: { vue: "3.5.0", ...dependencies } })

const NUXT_MANIFEST = manifest({ nuxt: "4.0.0" })

const page = (name: string, script = "", lang = ' lang="ts"'): string =>
  `<template><div class="${name}" /></template>\n<script setup${lang}>\n${script}\n</script>\n`

const parent = (name: string, script = ""): string =>
  `<template><div class="${name}"><NuxtPage /></div></template>\n<script setup lang="ts">\n${script}\n</script>\n`

const layout = (name: string): string => `<template><main class="${name}"><slot /></main></template>\n`

const APP_WITH_LAYOUT = "<template>\n  <NuxtLayout>\n    <NuxtPage />\n  </NuxtLayout>\n</template>\n"

const KUN_FILES: Readonly<Record<string, string>> = {
  "package.json": NUXT_MANIFEST,
  "tsconfig.json": TSCONFIG,
  "nuxt.config.ts": "export default defineNuxtConfig({\n  extends: ['@kungal/ui-nuxt', '@kungal/editor-nuxt'],\n})\n",
  "app/app.vue": APP_WITH_LAYOUT,
  "app/layouts/default.vue": "<template><main class=\"default\"><NuxtPage /></main></template>\n",
  "app/layouts/blank.vue": layout("blank"),
  "app/middleware/auth.ts": "export default defineNuxtRouteMiddleware(() => {})\n",
  "app/middleware/permission.ts": "export default defineNuxtRouteMiddleware(() => {})\n",
  "app/pages/index.vue": page("home", "definePageMeta({ keepalive: true })"),
  "app/pages/admin.vue": parent("admin", "definePageMeta({ middleware: 'auth' })"),
  "app/pages/admin/index.vue": page("admin-index"),
  "app/pages/admin/moderation.vue": page(
    "moderation",
    "definePageMeta({\n  middleware: 'permission',\n  permissions: ['trust.review']\n})",
  ),
  "app/pages/category.vue": parent("category"),
  "app/pages/category/[name].vue": page("category-name"),
  "app/pages/messages/[[id]].vue": page("messages", "definePageMeta({ middleware: 'auth', key: 'messages' })"),
  "app/pages/doc/[...slug].vue": page("doc"),
  "app/pages/auth/callback.vue": page("callback", "definePageMeta({ layout: false })"),
  "app/pages/update.vue": parent("update"),
  "app/pages/update/index.vue": page("update-index", "definePageMeta({ redirect: '/update/todo' })"),
  "app/pages/update/todo.vue": page("todo"),
  "app/pages/blank.vue": page("blank", "definePageMeta({ layout: 'blank', name: 'empty-page' })"),
  "app/pages/inline.vue": page("inline", "definePageMeta({ middleware: [() => {}] })"),
  "app/pages/galgame/[id]/index.vue": page("galgame"),
  "app/components/KunButton.vue": page("kun-button"),
  "app/components/kun/Button.vue": page("kun-button-2"),
  "app/components/kun/Card.vue": page("kun-card"),
}

const OPNFORM_FILES: Readonly<Record<string, string>> = {
  "package.json": NUXT_MANIFEST,
  "tsconfig.json": TSCONFIG,
  "nuxt.config.ts":
    "export default defineNuxtConfig({\n  components: [\n    { path: '~/components/global', pathPrefix: false },\n    '~/components',\n  ],\n})\n",
  "app.vue": APP_WITH_LAYOUT,
  "layouts/default.vue": layout("default"),
  "layouts/dashboard.vue": layout("dashboard"),
  "layouts/empty.vue": layout("empty"),
  "middleware/01.check-auth.global.js": "export default defineNuxtRouteMiddleware(() => {})\n",
  "middleware/auth.js": "export default defineNuxtRouteMiddleware(() => {})\n",
  "middleware/guest.js": "export default defineNuxtRouteMiddleware(() => {})\n",
  "pages/[...all].vue": page("not-found", "", ""),
  "pages/index.vue": page("index", 'definePageMeta({\n  layout: "default",\n  middleware: ["root-redirect"],\n})', ""),
  "pages/home.vue": page("home", 'definePageMeta({\n  middleware: ["auth"],\n  layout: "dashboard",\n})', ""),
  "pages/login.vue": page("login", 'definePageMeta({\n  middleware: "guest",\n})', ""),
  "pages/forms/[slug]/index.vue": page("form", "", ""),
  "pages/forms/[slug]/show.vue": parent("show", 'definePageMeta({ middleware: "auth", layout: "empty" })'),
  "pages/forms/[slug]/show/index.vue": page("show-index", "", ""),
  "pages/forms/[slug]/show/share.vue": page("share", "", ""),
  "components/global/OpenForm.vue": page("open-form", "", ""),
  "components/forms/TextInput.vue": page("text-input", "", ""),
}

const NO_PAGES_FILES: Readonly<Record<string, string>> = {
  "package.json": NUXT_MANIFEST,
  "tsconfig.json": TSCONFIG,
  "app.vue": "<template><div>hello</div></template>\n",
}

const analyze = (files: Readonly<Record<string, string>>) => run({ files, adapters: [createNuxtAdapter()] })

const screenAt = (screens: readonly Screen[], url: string): Screen => {
  const found = screens.find((screen) => screen.url === url)
  if (found === undefined) throw new Error(`no screen at ${url}`)
  return found
}

const urls = (screens: readonly Screen[]): readonly string[] =>
  screens.flatMap((screen) => (screen.url === null ? [] : [screen.url])).sort()

const ancestorsOf = (screen: Screen): readonly string[] =>
  screen.ancestors.map((ancestor) => {
    const splice = ancestor.splice.kind === "outlet" ? ancestor.splice.tag : ancestor.splice.kind
    return `${ancestor.file}@${splice}`
  })

const probe = (files: Readonly<Record<string, string>>) =>
  createProjectProbe({
    ts,
    root: ROOT,
    host: createMemoryHost({
      files: Object.fromEntries(Object.entries(files).map(([file, text]) => [`${ROOT}/${file}`, text])),
    }),
  }).context

const captureAmbient = (files: Readonly<Record<string, string>>): readonly string[] => {
  const adapter = createNuxtAdapter()
  const captured: string[] = []
  run({
    files,
    adapters: [
      {
        ...adapter,
        ambientComponents: (ctx) => {
          const found = adapter.ambientComponents?.(ctx) ?? []
          captured.push(...found.map((component) => `${component.name}=${component.file}`))
          return found
        },
      },
    ],
  })
  return captured
}

describe("detectNuxt", () => {
  it("scores a nuxt dependency with a pages directory as a file convention", () => {
    const result = detectNuxt(probe(KUN_FILES))
    expect(result.score).toBe(SOURCE_SCORES.fileConvention)
    expect(result.evidence.map((entry) => entry.file)).toEqual(["package.json", "app/pages/admin.vue"])
  })

  it("scores an app.vue without pages", () => {
    expect(detectNuxt(probe(NO_PAGES_FILES)).score).toBe(SOURCE_SCORES.fileConvention)
  })

  it("scores 0 without the nuxt dependency", () => {
    expect(detectNuxt(probe({ ...KUN_FILES, "package.json": manifest({}) })).score).toBe(0)
  })

  it("scores 0 with neither pages nor app.vue", () => {
    expect(detectNuxt(probe({ "package.json": NUXT_MANIFEST, "tsconfig.json": TSCONFIG })).score).toBe(0)
  })
})

describe("nuxtRouteNameOf", () => {
  it.each([
    ["index", "index"],
    ["admin/index", "admin"],
    ["admin/moderation", "admin-moderation"],
    ["category/[name]", "category-name"],
    ["messages/[[id]]", "messages-id"],
    ["doc/[...slug]", "doc-slug"],
    ["galgame/[id]/index", "galgame-id"],
    ["users-[group]/[id]", "users-group-id"],
    ["(marketing)/about", "about"],
  ])("names %s as %s", (stem, name) => {
    expect(nuxtRouteNameOf(stem)).toBe(name)
  })
})

describe("nuxt discovery (kun-shaped, Nuxt 4 app/)", () => {
  const result = analyze(KUN_FILES)
  const { screens } = result.graph

  it("maps every page file, folding a parent with a child index.vue into the index screen", () => {
    expect(urls(screens)).toEqual(
      [
        "/",
        "/admin",
        "/admin/moderation",
        "/auth/callback",
        "/blank",
        "/category",
        "/category/:name",
        "/doc/*",
        "/galgame/:id",
        "/inline",
        "/messages/:id?",
        "/update",
        "/update/todo",
      ].sort(),
    )
    expect(screenAt(screens, "/admin").entries).toEqual([{ kind: "file", file: "app/pages/admin/index.vue", exportName: "default" }])
    expect(screenAt(screens, "/category").entries).toEqual([{ kind: "file", file: "app/pages/category.vue", exportName: "default" }])
  })

  it("chains app.vue as a NuxtLayout outlet, a layout rendering NuxtPage directly as an outlet, then each parent as a NuxtPage outlet", () => {
    expect(ancestorsOf(screenAt(screens, "/admin/moderation"))).toEqual([
      "app/app.vue@NuxtLayout",
      "app/layouts/default.vue@NuxtPage",
      "app/pages/admin.vue@NuxtPage",
    ])
    expect(ancestorsOf(screenAt(screens, "/category/:name"))).toEqual([
      "app/app.vue@NuxtLayout",
      "app/layouts/default.vue@NuxtPage",
      "app/pages/category.vue@NuxtPage",
    ])
    expect(ancestorsOf(screenAt(screens, "/category"))).toEqual(["app/app.vue@NuxtLayout", "app/layouts/default.vue@NuxtPage"])
  })

  it("honours definePageMeta layout overrides and layout: false", () => {
    expect(ancestorsOf(screenAt(screens, "/blank"))).toEqual(["app/app.vue@NuxtLayout", "app/layouts/blank.vue@children"])
    expect(ancestorsOf(screenAt(screens, "/auth/callback"))).toEqual(["app/app.vue@NuxtLayout"])
  })

  it("reads auth from definePageMeta middleware, inherited from parent pages", () => {
    expect(screenAt(screens, "/admin").auth).toBe("protected")
    expect(screenAt(screens, "/admin/moderation").auth).toBe("protected")
    expect(screenAt(screens, "/messages/:id?").auth).toBe("protected")
    expect(screenAt(screens, "/").auth).toBe("unknown")
  })

  it("ignores inline middleware functions and says so", () => {
    const inline = screenAt(screens, "/inline")
    expect(inline.auth).toBe("unknown")
    expect(inline.provenance.evidence.map((entry) => entry.what)).toContain(
      "definePageMeta has inline middleware functions; their checks are not read",
    )
  })

  it("carries the meta name or Nuxt's generated route name", () => {
    expect(screenAt(screens, "/blank").routeName).toBe("empty-page")
    expect(screenAt(screens, "/category/:name").routeName).toBe("category-name")
    expect(screenAt(screens, "/admin").routeName).toBe("admin")
    expect(screenAt(screens, "/").routeName).toBe("index")
  })

  it("maps a string redirect", () => {
    expect(screenAt(screens, "/update").redirectTo).toBe("/update/todo")
  })

  it("reports each extends layer once and the colliding auto-import name", () => {
    const layers = result.diagnostics.filter((entry) => entry.code === "project/nuxt-layer-skipped")
    expect(layers.map((entry) => entry.severity)).toEqual(["info"])
    expect(layers[0]?.message).toContain("@kungal/ui-nuxt, @kungal/editor-nuxt")
    const ambiguous = result.diagnostics.filter((entry) => entry.code === "facts/ambiguous-component-name")
    expect(ambiguous.map((entry) => entry.message)).toEqual([
      expect.stringContaining("KunButton (app/components/KunButton.vue, app/components/kun/Button.vue)"),
    ])
  })

  it("registers unambiguous auto-import components only", () => {
    expect(captureAmbient(KUN_FILES)).toEqual(["KunCard=app/components/kun/Card.vue"])
  })
})

describe("nuxt discovery (OpnForm-shaped, root pages/, plain JS)", () => {
  const result = analyze(OPNFORM_FILES)
  const { screens } = result.graph

  it("maps root pages, the catch-all and the show.vue parent", () => {
    expect(urls(screens)).toEqual(
      ["/", "/*", "/forms/:slug", "/forms/:slug/show", "/forms/:slug/show/share", "/home", "/login"].sort(),
    )
    expect(ancestorsOf(screenAt(screens, "/forms/:slug/show/share"))).toEqual([
      "app.vue@NuxtLayout",
      "layouts/empty.vue@children",
      "pages/forms/[slug]/show.vue@NuxtPage",
    ])
    expect(ancestorsOf(screenAt(screens, "/home"))).toEqual(["app.vue@NuxtLayout", "layouts/dashboard.vue@children"])
  })

  it("leaves auth unknown when only global middleware applies, with evidence", () => {
    const index = screenAt(screens, "/")
    expect(index.auth).toBe("unknown")
    expect(index.provenance.evidence.map((entry) => entry.what)).toContain(
      "1 global route middleware (middleware/01.check-auth.global.js) decide access at runtime; auth is not asserted",
    )
    expect(screenAt(screens, "/home").auth).toBe("protected")
    expect(screenAt(screens, "/login").auth).toBe("public")
    expect(screenAt(screens, "/forms/:slug/show/share").auth).toBe("protected")
  })

  it("resolves pathPrefix: false component dirs before the prefixed default dir", () => {
    expect(captureAmbient(OPNFORM_FILES)).toEqual([
      "FormsTextInput=components/forms/TextInput.vue",
      "OpenForm=components/global/OpenForm.vue",
    ])
  })

  it("reports no nuxt layer when the config has no extends", () => {
    expect(result.diagnostics.map((entry) => entry.code)).not.toContain("project/nuxt-layer-skipped")
  })
})

describe("nuxt discovery without a pages directory", () => {
  it("maps app.vue as /", () => {
    const { screens } = analyze(NO_PAGES_FILES).graph
    expect(urls(screens)).toEqual(["/"])
    expect(screenAt(screens, "/").entries).toEqual([{ kind: "file", file: "app.vue", exportName: "default" }])
  })
})

describe("nuxt app.vue layout probe", () => {
  const withApp = (app: string): Readonly<Record<string, string>> => ({ ...NO_PAGES_FILES, "app.vue": app, "pages/index.vue": page("index") })

  it.each([
    ["a kebab-case <nuxt-layout>", "<template>\n  <nuxt-layout>\n    <nuxt-page />\n  </nuxt-layout>\n</template>\n", "app.vue@NuxtLayout"],
    ["a commented-out <NuxtLayout>", "<template>\n  <!-- <NuxtLayout> -->\n  <NuxtPage />\n</template>\n", "app.vue@NuxtPage"],
    ["<NuxtLayout> only outside the template", "<template><NuxtPage /></template>\n<script setup>\nconst tag = '<NuxtLayout>'\n</script>\n", "app.vue@NuxtPage"],
  ])("reads %s from the template", (_label, app, expected) => {
    const { screens } = analyze(withApp(app)).graph
    expect(ancestorsOf(screenAt(screens, "/"))[0]).toBe(expected)
  })
})

describe("nuxt auto-import collisions reach one emitter", () => {
  const files = {
    ...KUN_FILES,
    "app/pages/galgame/[id]/index.vue": "<template><div><KunButton /><kun-card /></div></template>\n<script setup lang=\"ts\">\n</script>\n",
  }
  const result = runPipeline({
    ts,
    host: createMemoryHost({ files: withProject(files) }),
    config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test", formats: ["full"] }),
    adapters: [createNuxtAdapter()],
    templates: { apis: { vue: realVueCompiler() }, statuses: [], diagnostics: [] },
  })

  it("reports a used colliding name once, from the adapter, and draws no edge to either file", () => {
    const ambiguous = result.diagnostics.filter((entry) => entry.code === "facts/ambiguous-component-name")
    expect(ambiguous).toHaveLength(1)
    expect(ambiguous[0]?.message).toContain("KunButton (app/components/KunButton.vue, app/components/kun/Button.vue)")
    expect(result.graph.components["app/pages/galgame/[id]/index.vue"]?.renders.map((edge) => edge.file)).toEqual([
      "app/components/kun/Card.vue",
    ])
  })
})
