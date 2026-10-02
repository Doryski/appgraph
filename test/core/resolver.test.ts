import { describe, expect, it } from "vitest"
import ts from "typescript"
import { createMemoryHost } from "../../src/core/host.js"
import { createProjectPaths } from "../../src/core/project.js"
import { createResolver } from "../../src/core/resolver.js"
import { loadTsconfig } from "../../src/core/tsconfig.js"
import type { ResolverOptions } from "../../src/core/resolver.js"

const ROOT = "/repo"

type Overrides = Omit<Partial<ResolverOptions>, "ts" | "host" | "paths" | "tsconfig">

const build = (files: Record<string, string>, sourceRoots: readonly string[] = ["src"], overrides: Overrides = {}) => {
  const host = createMemoryHost({ files })
  const paths = createProjectPaths({ host, root: ROOT, sourceRoots })
  const { chain } = loadTsconfig({ ts, host, root: ROOT })
  return createResolver({ ts, host, paths, tsconfig: chain, ...overrides })
}

const NODENEXT_TSCONFIG = JSON.stringify({
  compilerOptions: {
    module: "nodenext",
    moduleResolution: "nodenext",
    baseUrl: ".",
    paths: { "@/*": ["src/*"], "@/config": ["src/config.tsx"] },
  },
})

describe("createResolver — nodenext .js specifiers", () => {
  const files = {
    "/repo/tsconfig.json": NODENEXT_TSCONFIG,
    "/repo/src/admin/options.ts": [
      "import { componentLoader } from './component-loader.js'",
      "import { Dashboard } from './foo.component.js'",
      "import { helper } from '../shared/helper.js'",
      "export const options = { componentLoader, Dashboard, helper }",
    ].join("\n"),
    "/repo/src/admin/component-loader.tsx": "export const componentLoader = {}",
    "/repo/src/admin/foo.component.tsx": "export const Dashboard = () => null",
    "/repo/src/shared/helper.ts": "export const helper = 1",
  }

  it("resolves './foo.component.js' to the .tsx file", () => {
    const resolver = build(files)
    expect(resolver.resolveModule("/repo/src/admin/options.ts", "./foo.component.js")).toBe(
      "/repo/src/admin/foo.component.tsx",
    )
  })

  it("resolves .js specifiers to both .ts and .tsx sources", () => {
    const resolver = build(files)
    const from = "/repo/src/admin/options.ts"
    expect(resolver.resolveModule(from, "./component-loader.js")).toBe("/repo/src/admin/component-loader.tsx")
    expect(resolver.resolveModule(from, "../shared/helper.js")).toBe("/repo/src/shared/helper.ts")
  })

  it("reports non-zero imports resolved and non-zero bindings for the nodenext file", () => {
    const resolver = build(files)
    const result = resolver.imports("/repo/src/admin/options.ts")

    expect(result.files).toHaveLength(3)
    expect(result.bindings.size).toBe(3)
    expect(result.unresolved).toEqual([])
    expect(result.bindings.get("Dashboard")).toEqual({
      file: "/repo/src/admin/foo.component.tsx",
      imported: "Dashboard",
    })
  })

  it("leaves .js specifiers unresolved when extension rewrites are disabled", () => {
    const resolver = build(files, ["src"], { extensionRewrites: [] })
    expect(resolver.resolveModule("/repo/src/admin/options.ts", "./foo.component.js")).toBeNull()
    expect(resolver.imports("/repo/src/admin/options.ts").bindings.size).toBe(0)
  })

  it("probes rewritten specifiers before the raw candidate suffixes", () => {
    const resolver = build(files)
    const trace = resolver.probeTrace("/repo/src/admin/options.ts", "./foo.component.js")

    expect(trace.slice(0, 2)).toEqual([
      "/repo/src/admin/foo.component.ts",
      "/repo/src/admin/foo.component.tsx",
    ])
    expect(trace).toContain("/repo/src/admin/foo.component.js.tsx")
    expect(trace.indexOf("/repo/src/admin/foo.component.tsx")).toBeLessThan(
      trace.indexOf("/repo/src/admin/foo.component.js.tsx"),
    )
  })

  it("rewrites .jsx and .mjs specifiers too", () => {
    const resolver = build({
      "/repo/tsconfig.json": NODENEXT_TSCONFIG,
      "/repo/src/a.ts": "",
      "/repo/src/widget.tsx": "export const Widget = () => null",
      "/repo/src/util.mts": "export const util = 1",
    })

    expect(resolver.resolveModule("/repo/src/a.ts", "./widget.jsx")).toBe("/repo/src/widget.tsx")
    expect(resolver.resolveModule("/repo/src/a.ts", "./util.mjs")).toBe("/repo/src/util.mts")
  })
})

describe("createResolver — tsconfig paths", () => {
  const files = {
    "/repo/tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@/*": ["src/*"],
          "@/modules/*": ["src/modules/*"],
          "@/config": ["src/config.tsx"],
          "@/env": ["src/env.ts"],
          "~/*": ["missing/*", "src/*"],
        },
      },
    }),
    "/repo/src/app.ts": "",
    "/repo/src/config.tsx": "export const config = 1",
    "/repo/src/env.ts": "export const env = 1",
    "/repo/src/modules/Invoices/index.tsx": "export const Invoices = () => null",
    "/repo/src/shared/util.ts": "export const util = 1",
  }

  it("resolves NON-wildcard entries by full-specifier equality (@/config -> src/config.tsx)", () => {
    const resolver = build(files)
    expect(resolver.resolveModule("/repo/src/app.ts", "@/config")).toBe("/repo/src/config.tsx")
    expect(resolver.resolveModule("/repo/src/app.ts", "@/env")).toBe("/repo/src/env.ts")
  })

  it("does not let a non-wildcard entry swallow a longer specifier", () => {
    const resolver = build(files)
    expect(resolver.resolveModule("/repo/src/app.ts", "@/config/nested")).toBeNull()
  })

  it("sorts aliases longest-prefix-first so @/modules/* beats @/*", () => {
    const resolver = build(files)
    expect(resolver.aliases[0]?.prefix).toBe("@/modules/")
    expect(resolver.resolveModule("/repo/src/app.ts", "@/modules/Invoices")).toBe(
      "/repo/src/modules/Invoices/index.tsx",
    )
  })

  it("probes every target of a paths entry in declaration order", () => {
    const resolver = build(files)
    expect(resolver.resolveModule("/repo/src/app.ts", "~/shared/util")).toBe("/repo/src/shared/util.ts")
  })

  it("resolves wildcard aliases and index barrels", () => {
    const resolver = build(files)
    expect(resolver.resolveModule("/repo/src/app.ts", "@/shared/util")).toBe("/repo/src/shared/util.ts")
  })
})

describe("createResolver — scope, ignores and source roots", () => {
  const files = {
    "/repo/tsconfig.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"], "#lib/*": ["lib/*"] } },
    }),
    "/repo/src/app.ts": "",
    "/repo/lib/thing.ts": "export const thing = 1",
    "/repo/src/thing.test.ts": "export const thing = 1",
    "/repo/src/types.d.ts": "export type T = 1",
    "/repo/src/generated/routeTree.gen.ts": "export const tree = 1",
    "/repo/node_modules/pkg/index.ts": "export const pkg = 1",
  }

  it("refuses files outside the configured source roots", () => {
    const resolver = build(files, ["src"])
    expect(resolver.resolveModule("/repo/src/app.ts", "#lib/thing")).toBeNull()
  })

  it("accepts them once the source root is configured — replacing the hardcoded <root>/src check", () => {
    const resolver = build(files, ["src", "lib"])
    expect(resolver.resolveModule("/repo/src/app.ts", "#lib/thing")).toBe("/repo/lib/thing.ts")
  })

  it("ignores test, spec and declaration files", () => {
    const resolver = build(files)
    expect(resolver.resolveModule("/repo/src/app.ts", "./thing.test")).toBeNull()
    expect(resolver.resolveModule("/repo/src/app.ts", "./types")).toBeNull()
  })

  it("never resolves into an excluded directory", () => {
    const resolver = build(files, ["src", "node_modules"])
    expect(resolver.resolveModule("/repo/src/app.ts", "../node_modules/pkg")).toBeNull()
  })

  it("honours a custom candidateSuffixes order", () => {
    const resolver = build(
      {
        "/repo/tsconfig.json": JSON.stringify({ compilerOptions: {} }),
        "/repo/src/app.ts": "",
        "/repo/src/thing/index.ts": "export const thing = 1",
      },
      ["src"],
      { candidateSuffixes: ["", "/index.ts"] },
    )

    expect(resolver.resolveModule("/repo/src/app.ts", "./thing")).toBe("/repo/src/thing/index.ts")
  })
})

describe("createResolver — declarationFile barrel chasing", () => {
  it("follows named re-exports through a barrel", () => {
    const resolver = build({
      "/repo/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
      "/repo/src/app.ts": "",
      "/repo/src/modules/index.ts": "export { Invoices } from './Invoices/Invoices.js'",
      "/repo/src/modules/Invoices/Invoices.tsx": "export const Invoices = () => null",
    })

    expect(resolver.declarationFile("/repo/src/modules/index.ts", "Invoices")).toBe(
      "/repo/src/modules/Invoices/Invoices.tsx",
    )
  })

  it("maps through propertyName on a renamed re-export", () => {
    const resolver = build({
      "/repo/tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "/repo/src/index.ts": "export { Inner as Outer } from './inner.js'",
      "/repo/src/inner.tsx": "export const Inner = () => null",
    })

    expect(resolver.declarationFile("/repo/src/index.ts", "Outer")).toBe("/repo/src/inner.tsx")
  })

  it("follows star re-exports and stops on a local declaration", () => {
    const resolver = build({
      "/repo/tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "/repo/src/index.ts": "export * from './inner.js'",
      "/repo/src/inner.ts": "export const value = 1",
      "/repo/src/local.ts": "export const value = 2",
    })

    expect(resolver.declarationFile("/repo/src/index.ts", "value")).toBe("/repo/src/inner.ts")
    expect(resolver.declarationFile("/repo/src/local.ts", "value")).toBe("/repo/src/local.ts")
  })

  it("returns the starting file when nothing declares the name", () => {
    const resolver = build({
      "/repo/tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "/repo/src/index.ts": "export const other = 1",
    })

    expect(resolver.declarationFile("/repo/src/index.ts", "Missing")).toBe("/repo/src/index.ts")
  })
})

describe("createResolver — declarationFile default-export forwarding", () => {
  const resolverFor = (files: Record<string, string>) =>
    build({ "/repo/tsconfig.json": JSON.stringify({ compilerOptions: {} }), ...files })

  it("follows `export default <identifier>` when the identifier is a named import", () => {
    const resolver = resolverFor({
      "/repo/src/LazyAdminExport.tsx": "import { Admin } from './Admin.tsx'\nexport default Admin",
      "/repo/src/Admin.tsx": "export const Admin = () => null",
    })

    expect(resolver.declarationFile("/repo/src/LazyAdminExport.tsx", "default")).toBe("/repo/src/Admin.tsx")
  })

  it("follows `export default <identifier>` when the identifier is a default import", () => {
    const resolver = resolverFor({
      "/repo/src/barrel.ts": "import Page from './Page'\nexport default Page",
      "/repo/src/Page.tsx": "export default function Page() { return null }",
    })

    expect(resolver.declarationFile("/repo/src/barrel.ts", "default")).toBe("/repo/src/Page.tsx")
  })

  it("keeps a default export of a local identifier in the exporting file", () => {
    const resolver = resolverFor({
      "/repo/src/Local.tsx": "import { helper } from './helper'\nconst Local = () => helper\nexport default Local",
      "/repo/src/helper.ts": "export const helper = null",
    })

    expect(resolver.declarationFile("/repo/src/Local.tsx", "default")).toBe("/repo/src/Local.tsx")
  })

  it("keeps a default export of a namespace import in the exporting file", () => {
    const resolver = resolverFor({
      "/repo/src/barrel.ts": "import * as Parts from './parts'\nexport default Parts",
      "/repo/src/parts.ts": "export const Body = 1",
    })

    expect(resolver.declarationFile("/repo/src/barrel.ts", "default")).toBe("/repo/src/barrel.ts")
  })

  it("follows `export { default } from`", () => {
    const resolver = resolverFor({
      "/repo/src/index.ts": "export { default } from './X'",
      "/repo/src/X.tsx": "export default function X() { return null }",
    })

    expect(resolver.declarationFile("/repo/src/index.ts", "default")).toBe("/repo/src/X.tsx")
  })

  it("follows `export { X as default } from`", () => {
    const resolver = resolverFor({
      "/repo/src/index.ts": "export { X as default } from './X'",
      "/repo/src/X.tsx": "export const X = () => null",
    })

    expect(resolver.declarationFile("/repo/src/index.ts", "default")).toBe("/repo/src/X.tsx")
  })

  it("follows `export { default as Y } from` for a named lookup", () => {
    const resolver = resolverFor({
      "/repo/src/index.ts": "export { default as Y } from './X'",
      "/repo/src/X.tsx": "export default function X() { return null }",
    })

    expect(resolver.declarationFile("/repo/src/index.ts", "Y")).toBe("/repo/src/X.tsx")
  })

  it("follows a local `export { Imported as default }` clause of an import binding", () => {
    const resolver = resolverFor({
      "/repo/src/index.ts": "import { X } from './X'\nexport { X as default }",
      "/repo/src/X.tsx": "export const X = () => null",
    })

    expect(resolver.declarationFile("/repo/src/index.ts", "default")).toBe("/repo/src/X.tsx")
  })

  it("chains a default re-export into a default-exported import", () => {
    const resolver = resolverFor({
      "/repo/src/index.ts": "export { default as Admin } from './LazyAdminExport'",
      "/repo/src/LazyAdminExport.tsx": "import { Admin } from './Admin'\nexport default Admin",
      "/repo/src/Admin.tsx": "export const Admin = () => null",
    })

    expect(resolver.declarationFile("/repo/src/index.ts", "Admin")).toBe("/repo/src/Admin.tsx")
  })

  it("does not forward `default` through a star re-export", () => {
    const resolver = resolverFor({
      "/repo/src/index.ts": "export * from './X'",
      "/repo/src/X.tsx": "export default function X() { return null }",
    })

    expect(resolver.declarationFile("/repo/src/index.ts", "default")).toBe("/repo/src/index.ts")
  })

  it("stops on a default-export cycle with a deterministic result", () => {
    const files = {
      "/repo/src/a.ts": "import b from './b'\nexport default b",
      "/repo/src/b.ts": "export { default } from './a'",
    }

    const first = resolverFor(files).declarationFile("/repo/src/a.ts", "default")
    expect(["/repo/src/a.ts", "/repo/src/b.ts"]).toContain(first)
    expect(resolverFor(files).declarationFile("/repo/src/a.ts", "default")).toBe(first)
  })
})

describe("createResolver — declaredExport carries the forwarded export name", () => {
  const resolverFor = (files: Record<string, string>) =>
    build({ "/repo/tsconfig.json": JSON.stringify({ compilerOptions: {} }), ...files })

  it("pairs a barrel's `export default <named import>` with the named export, not `default`", () => {
    const resolver = resolverFor({
      "/repo/src/layouts/desktop.ts": "import { DesktopShell } from './shells'\nexport default DesktopShell",
      "/repo/src/layouts/shells.tsx":
        "export function MobileShell() { return null }\nexport function DesktopShell() { return null }",
    })

    expect(resolver.declaredExport("/repo/src/layouts/desktop.ts", "default")).toEqual({
      file: "/repo/src/layouts/shells.tsx",
      exportName: "DesktopShell",
    })
    expect(resolver.declarationFile("/repo/src/layouts/desktop.ts", "default")).toBe("/repo/src/layouts/shells.tsx")
  })

  it("leaves a direct named declaration unchanged", () => {
    const resolver = resolverFor({ "/repo/src/shells.tsx": "export function DesktopShell() { return null }" })

    expect(resolver.declaredExport("/repo/src/shells.tsx", "DesktopShell")).toEqual({
      file: "/repo/src/shells.tsx",
      exportName: "DesktopShell",
    })
  })

  it("carries the final name through a chained default re-export", () => {
    const resolver = resolverFor({
      "/repo/src/index.ts": "export { default } from './middle'",
      "/repo/src/middle.ts": "import { Renamed as Shell } from './shells'\nexport default Shell",
      "/repo/src/shells.tsx": "export { DesktopShell as Renamed } from './desktop'",
      "/repo/src/desktop.tsx": "export function DesktopShell() { return null }",
    })

    expect(resolver.declaredExport("/repo/src/index.ts", "default")).toEqual({
      file: "/repo/src/desktop.tsx",
      exportName: "DesktopShell",
    })
  })

  it("keeps `default` when the chain ends on a default declaration", () => {
    const resolver = resolverFor({
      "/repo/src/index.ts": "export { default as Page } from './Page'",
      "/repo/src/Page.tsx": "export default function Whatever() { return null }",
    })

    expect(resolver.declaredExport("/repo/src/index.ts", "Page")).toEqual({
      file: "/repo/src/Page.tsx",
      exportName: "default",
    })
  })

  it("resolves a local `export { Local as Name }` alias to the local declaration", () => {
    const resolver = resolverFor({
      "/repo/src/Page.tsx": "function Local() { return null }\nexport { Local as default }",
    })

    expect(resolver.declaredExport("/repo/src/Page.tsx", "default")).toEqual({
      file: "/repo/src/Page.tsx",
      exportName: "Local",
    })
  })

  it("returns the lookup itself when nothing declares the name", () => {
    const resolver = resolverFor({ "/repo/src/index.ts": "export * from './X'", "/repo/src/X.tsx": "export const Y = 1" })

    expect(resolver.declaredExport("/repo/src/index.ts", "Missing")).toEqual({
      file: "/repo/src/index.ts",
      exportName: "Missing",
    })
  })
})

describe("createResolver — source cache and determinism", () => {
  it("returns the identical SourceFile instance for repeated reads", () => {
    const resolver = build({
      "/repo/tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "/repo/src/app.ts": "export const a = 1",
    })

    const first = resolver.sourceFile("/repo/src/app.ts")
    expect(first).not.toBeNull()
    expect(resolver.sourceFile("/repo/src/app.ts")).toBe(first)
    expect(resolver.sourceFile("/repo/src/missing.ts")).toBeNull()
  })

  it("returns imported files in codepoint order", () => {
    const resolver = build({
      "/repo/tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "/repo/src/app.ts": ["import './z.js'", "import './a.js'", "import './M.js'"].join("\n"),
      "/repo/src/z.ts": "",
      "/repo/src/a.ts": "",
      "/repo/src/M.ts": "",
    })

    expect(resolver.imports("/repo/src/app.ts").files).toEqual([
      "/repo/src/M.ts",
      "/repo/src/a.ts",
      "/repo/src/z.ts",
    ])
  })

  it("records unresolved specifiers instead of dropping them silently", () => {
    const resolver = build({
      "/repo/tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "/repo/src/app.ts": "import ts from 'typescript'\nimport './nope.js'",
    })

    expect(resolver.imports("/repo/src/app.ts").unresolved).toEqual(["./nope.js", "typescript"])
  })

  it("derives a component name from the file, falling back to the directory for index files", () => {
    const resolver = build({
      "/repo/tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "/repo/src/app.ts": "",
    })

    expect(resolver.componentName("/repo/src/modules/Invoices/Invoices.tsx")).toBe("Invoices")
    expect(resolver.componentName("/repo/src/modules/Invoices/index.tsx")).toBe("Invoices")
  })
})

describe("createResolver — aliases declared in a referenced tsconfig (Vite template)", () => {
  it("resolves '@/…' through the app reference of a solution-style root", () => {
    const resolver = build({
      "/repo/tsconfig.json": JSON.stringify({
        files: [],
        references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }],
      }),
      "/repo/tsconfig.app.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } }, include: ["src"] }),
      "/repo/tsconfig.node.json": JSON.stringify({ include: ["vite.config.ts"] }),
      "/repo/vite.config.ts": "",
      "/repo/src/App.tsx": "import { Button } from '@/components/Button'",
      "/repo/src/components/Button.tsx": "export const Button = () => null",
    })

    expect(resolver.resolveModule("/repo/src/App.tsx", "@/components/Button")).toBe("/repo/src/components/Button.tsx")
  })
})

describe("createResolver — Vue single-file components", () => {
  const files = {
    "/repo/src/App.vue": [
      "<template><UserCard /></template>",
      '<script setup lang="ts">',
      'import UserCard from "./components/UserCard.vue"',
      'import Panel from "./panel/index.vue"',
      'import { helper } from "./legacy"',
      "</script>",
    ].join("\n"),
    "/repo/src/components/UserCard.vue": "<template><div /></template>",
    "/repo/src/components/UserCard.story.vue": "<template><Story /></template>",
    "/repo/src/components/UserCard.spec.vue": "<template><div /></template>",
    "/repo/src/panel/index.vue": "<template><div /></template>",
    "/repo/src/legacy.js": "export const helper = 1",
  }

  it("resolves an explicit ./Foo.vue import and reads its script imports", () => {
    const resolver = build(files)
    expect(resolver.resolveModule("/repo/src/App.vue", "./components/UserCard.vue")).toBe(
      "/repo/src/components/UserCard.vue",
    )
    expect(resolver.imports("/repo/src/App.vue").files).toEqual([
      "/repo/src/components/UserCard.vue",
      "/repo/src/legacy.js",
      "/repo/src/panel/index.vue",
    ])
  })

  it("names a .vue component after its file, and index.vue after its directory", () => {
    const resolver = build(files)
    expect(resolver.componentName("/repo/src/components/UserCard.vue")).toBe("UserCard")
    expect(resolver.componentName("/repo/src/panel/index.vue")).toBe("panel")
  })

  it("never resolves a histoire *.story.vue or a .spec.vue file", () => {
    const resolver = build(files)
    expect(resolver.resolveModule("/repo/src/App.vue", "./components/UserCard.story.vue")).toBeNull()
    expect(resolver.resolveModule("/repo/src/App.vue", "./components/UserCard.spec.vue")).toBeNull()
  })

  it("does not probe .vue for an extensionless specifier", () => {
    const resolver = build(files)
    expect(resolver.resolveModule("/repo/src/App.vue", "./components/UserCard")).toBeNull()
  })
})

describe("createResolver — JavaScript suffixes after the TS ones", () => {
  it("resolves ./x to x.js, x.jsx and x/index.js", () => {
    const resolver = build({
      "/repo/src/main.js": "",
      "/repo/src/x.js": "",
      "/repo/src/y.jsx": "",
      "/repo/src/z/index.js": "",
    })
    expect(resolver.resolveModule("/repo/src/main.js", "./x")).toBe("/repo/src/x.js")
    expect(resolver.resolveModule("/repo/src/main.js", "./y")).toBe("/repo/src/y.jsx")
    expect(resolver.resolveModule("/repo/src/main.js", "./z")).toBe("/repo/src/z/index.js")
  })

  it("still prefers the TS sources when both exist", () => {
    const resolver = build({ "/repo/src/main.ts": "", "/repo/src/x.ts": "", "/repo/src/x.js": "" })
    expect(resolver.resolveModule("/repo/src/main.ts", "./x")).toBe("/repo/src/x.ts")
  })
})

describe("createResolver — imports()", () => {
  it("parses a file's imports once and returns the same result on repeat calls", () => {
    const resolver = build({
      "/repo/tsconfig.json": "{}",
      "/repo/src/a.ts": "import { b } from './b'\nimport { gone } from './gone'\nexport const a = b + gone",
      "/repo/src/b.ts": "export const b = 1",
    })

    const first = resolver.imports("/repo/src/a.ts")

    expect(first.files).toEqual(["/repo/src/b.ts"])
    expect(first.unresolved).toEqual(["./gone"])
    expect(resolver.imports("/repo/src/a.ts")).toBe(first)
  })
})
