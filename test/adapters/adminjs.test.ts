import ts from "typescript"
import { describe, expect, it } from "vitest"
import { resolveConfig } from "../../src/config/types.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { Screen } from "../../src/core/model.js"
import { createEnv, createProjectContext } from "../../src/pipeline/context.js"
import type { Adapter, ScreenSource } from "../../src/adapters/types.js"
import {
  DEFAULT_ACTIONS,
  GENERATED_KIND_TAG,
  createAdminJsAdapter,
  createAdminJsSource,
  detectAdminJs,
} from "../../src/adapters/adminjs.js"
import { ROOT, codes, run } from "../pipeline/harness.js"

type Files = Readonly<Record<string, string>>

const PACKAGE_JSON = JSON.stringify({ name: "admin", dependencies: { adminjs: "7.0.0" } })

const analyze = (files: Files, options: Parameters<typeof createAdminJsAdapter>[0] = {}, stringSources?: readonly string[]) =>
  run({
    files: { "package.json": PACKAGE_JSON, ...files },
    adapters: [createAdminJsAdapter(options)],
    ...(stringSources === undefined ? {} : { config: { stringSources } }),
  })

const urlsOf = (screens: readonly Screen[]): readonly (string | null)[] => screens.map((screen) => screen.url)

const screenAt = (screens: readonly Screen[], url: string): Screen | undefined =>
  screens.find((screen) => screen.url === url)

const entryFilesOf = (screen: Screen | undefined): readonly string[] =>
  (screen?.entries ?? []).flatMap((entry) => (entry.kind === "file" ? [entry.file] : []))

const opaqueExprsOf = (screen: Screen | undefined): readonly string[] =>
  (screen?.entries ?? []).flatMap((entry) => (entry.kind === "opaque" ? [entry.expr] : []))

// ---------------------------------------------------------------------------
// An admin-shaped fixture: options file, factory files, component loader, Resource enum.
// Every registered component path is written with the `.js` specifier `moduleResolution: nodenext`
// demands, while the file on disk is `.tsx`.
// ---------------------------------------------------------------------------

const COMPONENT_LOADER = `
import { ComponentLoader } from "adminjs"

const componentLoader = new ComponentLoader()

componentLoader.override("Application", "./components/app-layout.component.js")

const Components = {
  OrdersPage: componentLoader.add("OrdersPage", "./components/orders-page.component.js"),
  BookEditor: componentLoader.add(
    "BookEditorComponent",
    "./components/book-editor.component.js"
  ),
  BestsellersPage: componentLoader.add("BestsellersPage", "./components/bestsellers-page.component.js"),
}

export { componentLoader, Components }
`

const component = (name: string): string => `export default function ${name}() { return null }\n`

const ORDERS_RESOURCE = `
import { Resource } from "../../enums/resource.enum.js"
import { Components } from "../../component-loader.js"

export const createOrdersResource = () => ({
  resource: "ActivityLog",
  options: {
    id: Resource.Orders,
    actions: {
      list: { component: Components.OrdersPage },
      fetchOrders: { actionType: "resource", isVisible: false, component: false },
    },
  },
})
`

const BOOK_RESOURCE = `
import { Resource } from "../../enums/resource.enum.js"
import { Components } from "../../component-loader.js"

export const createBookResource = () => ({
  resource: "Book",
  options: {
    id: Resource.Books,
    actions: {
      edit: { component: Components.BookEditor },
    },
  },
})
`

const optionsFile = (rootPath: string): string => `
import { AdminJSOptions } from "adminjs"

import { componentLoader, Components } from "./component-loader.js"
import { createOrdersResource } from "./resources/orders/orders.resource.js"
import { createBookResource } from "./resources/book/book.resource.js"

const options: AdminJSOptions = {
  componentLoader,
  rootPath: "${rootPath}",
  loginPath: "/login",
  resources: [createOrdersResource(), createBookResource()],
  pages: {
    Dashboards: { component: Components.BestsellersPage, icon: "Layout" },
    "Bestsellers": { component: Components.BestsellersPage, icon: "MessageSquare" },
  },
}

export default options
`

const APP_FILES: Files = {
  "src/admin/component-loader.ts": COMPONENT_LOADER,
  "src/admin/components/app-layout.component.tsx": component("AppLayout"),
  "src/admin/components/orders-page.component.tsx": component("OrdersPage"),
  "src/admin/components/book-editor.component.tsx": component("BookEditor"),
  "src/admin/components/bestsellers-page.component.tsx": component("BestsellersPage"),
  "src/admin/enums/resource.enum.ts": `export enum Resource { Orders = "orders", Books = "books" }\n`,
  "src/admin/resources/orders/orders.resource.ts": ORDERS_RESOURCE,
  "src/admin/resources/book/book.resource.ts": BOOK_RESOURCE,
  "src/admin/options.ts": optionsFile("/"),
}

const appRun = () => analyze(APP_FILES)

const RESOURCE_ENUM = "src/admin/enums/resource.enum.ts"

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const detectOn = (files: Files, options: Parameters<typeof detectAdminJs>[1] = {}) => {
  const host = createMemoryHost({
    files: Object.fromEntries(Object.entries(files).map(([file, text]) => [`${ROOT}/${file}`, text])),
  })
  const env = createEnv({ ts, config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }), host })
  return detectAdminJs(createProjectContext(env), options)
}

const DEPS = { "package.json": PACKAGE_JSON }

const PLAIN_OPTIONS = `
const options = {
  rootPath: "/",
  resources: [],
}
export default options
`

describe("adminjs: detect", () => {
  it("scores 100 for the dependency plus an options literal with resources and rootPath", () => {
    const result = detectOn({ ...DEPS, "src/admin/options.ts": PLAIN_OPTIONS })

    expect(result.score).toBe(100)
    expect(result.evidence.map((entry) => entry.what)).toEqual([
      "adminjs dependency",
      "options literal with resources and rootPath",
    ])
    expect(result.evidence[1]?.file).toBe("src/admin/options.ts")
    expect(result.evidence[1]?.line).toBe(3)
  })

  it("scores 100 for an `AdminJSOptions` type reference alone", () => {
    const result = detectOn({
      ...DEPS,
      "src/admin/options.ts": `import { AdminJSOptions } from "adminjs"\nconst options: AdminJSOptions = { resources: [] }\nexport default options\n`,
    })

    expect(result.score).toBe(100)
    expect(result.evidence[1]?.what).toBe("AdminJSOptions type reference")
  })

  it("scores 0 without the dependency, even with a full options literal", () => {
    const result = detectOn({
      "package.json": JSON.stringify({ dependencies: { express: "4.0.0" } }),
      "src/admin/options.ts": PLAIN_OPTIONS,
    })

    expect(result.score).toBe(0)
    expect(result.evidence).toEqual([])
  })

  it("scores 0 with the dependency but no options object anywhere", () => {
    expect(detectOn({ ...DEPS, "src/admin/index.ts": `export const start = () => null\n` }).score).toBe(0)
  })

  // The spec accepts config for this app: an options file that the zero-config text probe cannot
  // recognise still detects, and the probe is demonstrably not consulted.
  it("skips the content probe entirely when the options file is configured", () => {
    const files = { ...DEPS, "src/admin/setup.ts": `export const config = { pages: {} }\n` }

    expect(detectOn(files).score).toBe(0)
    expect(detectOn(files, { optionsFile: "src/admin/setup.ts" }).score).toBe(100)
    expect(detectOn(files, { optionsFile: "src/admin/setup.ts" }).evidence[1]?.what).toBe(
      "configured AdminJS options file",
    )
  })

  it("scores 0 when the configured options file does not exist", () => {
    expect(detectOn(DEPS, { optionsFile: "src/admin/missing.ts" }).score).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Pass B + C: resources -> URLs through the template
// ---------------------------------------------------------------------------

describe("adminjs: resources become one screen per (resource, action)", () => {
  it("expands the resource template for every action of every factory call", () => {
    expect(urlsOf(appRun().graph.screens)).toEqual([
      "/login",
      "/pages/Bestsellers",
      "/pages/Dashboards",
      "/resources/books",
      "/resources/books/actions/new",
      "/resources/books/records/:recordId/edit",
      "/resources/books/records/:recordId/show",
      "/resources/orders",
      "/resources/orders/actions/fetchOrders",
      "/resources/orders/actions/new",
      "/resources/orders/records/:recordId/edit",
      "/resources/orders/records/:recordId/show",
    ])
  })

  it("reads the resource id out of a `Resource` enum member with no string source configured", () => {
    const screens = appRun().graph.screens
    expect(screenAt(screens, "/resources/orders")).toBeDefined()
    expect(screenAt(screens, "/resources/books")).toBeDefined()
  })

  it("reads the same enum member through `ctx.strings` when the enum file IS a string source", () => {
    const result = analyze(APP_FILES, {}, [RESOURCE_ENUM])
    expect(urlsOf(result.graph.screens)).toContain("/resources/orders")
  })

  it("honours a rootPath other than `/`", () => {
    const result = analyze({ ...APP_FILES, "src/admin/options.ts": optionsFile("/admin") })
    const urls = urlsOf(result.graph.screens)

    expect(urls).toContain("/admin/resources/orders")
    expect(urls).toContain("/admin/resources/orders/records/:recordId/edit")
    expect(urls).toContain("/admin/pages/Dashboards")
    expect(urls.filter((url) => url !== null && !url.startsWith("/admin/") && url !== "/login")).toEqual([])
  })

  it("derives the record param from the template rather than from the adapter", () => {
    expect(screenAt(appRun().graph.screens, "/resources/orders/records/:recordId/edit")?.params).toEqual([
      "recordId",
    ])
  })

  it("ships the four navigable AdminJS actions as DEFAULTS a host project can replace", () => {
    expect(DEFAULT_ACTIONS.map((action) => [action.name, action.scope])).toEqual([
      ["list", "resource"],
      ["new", "resource"],
      ["show", "record"],
      ["edit", "record"],
    ])

    // Replacing the synthesized set must NOT re-scope AdminJS's own `edit`: its URL stays under
    // `records/`, because record-scoping is a fact about AdminJS, not a configurable default.
    const result = analyze(APP_FILES, { defaultActions: [{ name: "list", scope: "resource" }] })
    expect(urlsOf(result.graph.screens)).toEqual([
      "/login",
      "/pages/Bestsellers",
      "/pages/Dashboards",
      "/resources/books",
      "/resources/books/records/:recordId/edit",
      "/resources/orders",
      "/resources/orders/actions/fetchOrders",
    ])
  })

  it("asserts the absence of an ancestor chain instead of staying silent about it", () => {
    for (const screen of appRun().graph.screens) {
      expect(screen.ancestors).toEqual([])
      expect(screen.shell).toBeNull()
    }
    expect(codes(appRun())).not.toContain("walk/no-splice-point")
  })

  it("gives every screen evidence pointing at a real file and line", () => {
    for (const screen of appRun().graph.screens) {
      expect(screen.provenance.evidence.length).toBeGreaterThan(0)
      for (const entry of screen.provenance.evidence) {
        expect(entry.file).toMatch(/^src\/admin\//)
        expect(entry.line).toBeGreaterThan(1)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Pass A: the componentLoader table, and the `.js` -> `.tsx` resolution it depends on
// ---------------------------------------------------------------------------

describe("adminjs: Components.X resolves through a `.js` specifier", () => {
  it("binds `Components.OrdersPage` to the real `.tsx` file", () => {
    expect(entryFilesOf(screenAt(appRun().graph.screens, "/resources/orders"))).toEqual([
      "src/admin/components/orders-page.component.tsx",
    ])
  })

  // The registered specifier ends in `.js`, and no
  // `.js`-suffixed file exists — so an adapter that appended a candidate suffix to the whole
  // specifier would probe `orders-page.component.js.tsx` and resolve nothing.
  it("registers the component with a `.js` specifier that names no file on disk", () => {
    expect(COMPONENT_LOADER).toContain('"./components/orders-page.component.js"')

    const paths = Object.keys(APP_FILES)
    expect(paths).not.toContain("src/admin/components/orders-page.component.js")
    expect(paths).not.toContain("src/admin/components/orders-page.component.js.tsx")
    expect(paths).toContain("src/admin/components/orders-page.component.tsx")
  })

  it("keys the table on the `Components` PROPERTY name, not on the componentLoader.add name", () => {
    expect(COMPONENT_LOADER).toContain('"BookEditorComponent"')
    expect(entryFilesOf(screenAt(appRun().graph.screens, "/resources/books/records/:recordId/edit"))).toEqual(
      ["src/admin/components/book-editor.component.tsx"],
    )
  })

  it("warns when a registered path resolves to no file, instead of inventing one", () => {
    const result = analyze({
      ...APP_FILES,
      "src/admin/component-loader.ts": COMPONENT_LOADER.replace(
        "./components/orders-page.component.js",
        "./components/gone.component.js",
      ),
    })

    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "screens/dynamic-registry" && entry.message.includes("gone.component.js"),
    )
    expect(diagnostic?.severity).toBe("warning")
    expect(diagnostic?.file).toBe("src/admin/component-loader.ts")
    expect(entryFilesOf(screenAt(result.graph.screens, "/resources/orders"))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// resolveEntries is the seam — and it is load-bearing
// ---------------------------------------------------------------------------

/** `export default (<here> satisfies AdminJSOptions)` — the node a raw type test has to accept. */
const exportedExpressionOf = (text: string): ts.Node | null => {
  const source = ts.createSourceFile("options.ts", text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  let found: ts.Node | null = null
  const visit = (node: ts.Node): void => {
    if (found === null && ts.isExportAssignment(node)) found = node.expression
    node.forEachChild(visit)
  }
  visit(source)
  return found
}

const withoutSeam = (): Adapter => {
  const source = createAdminJsSource()
  const bare: ScreenSource = { name: source.name, detect: source.detect, discover: source.discover }
  return { name: "adminjs", screens: [bare] }
}

describe("adminjs: the resolveEntries seam", () => {
  it("is what turns a componentLoader key into a file — without it the core resolver cannot", () => {
    const result = run({ files: { "package.json": PACKAGE_JSON, ...APP_FILES }, adapters: [withoutSeam()] })
    const orders = screenAt(result.graph.screens, "/resources/orders")

    expect(entryFilesOf(orders)).toEqual([])
    expect(opaqueExprsOf(orders)).toEqual(["Components.OrdersPage (in src/admin/resources/orders/orders.resource.ts)"])
    expect(codes(result)).toContain("screens/opaque-entry")
  })

  it("mints a visible hole for a Components key the loader never registered", () => {
    const result = analyze({
      ...APP_FILES,
      "src/admin/resources/orders/orders.resource.ts": ORDERS_RESOURCE.replace(
        "Components.OrdersPage",
        "Components.NeverRegistered",
      ),
    })
    const orders = screenAt(result.graph.screens, "/resources/orders")

    expect(opaqueExprsOf(orders)).toEqual(["Components.NeverRegistered"])
    expect(codes(result)).toContain("screens/opaque-entry")
    expect(
      result.diagnostics.find(
        (entry) => entry.code === "screens/dynamic-registry" && entry.message.includes("NeverRegistered"),
      )?.severity,
    ).toBe("info")
  })
})

// ---------------------------------------------------------------------------
// Component-less actions and unresolvable ids
// ---------------------------------------------------------------------------

describe("adminjs: framework-rendered actions and holes", () => {
  it("emits a component-less action as a real URL with an empty render tree, tagged generated", () => {
    const screens = appRun().graph.screens

    for (const url of [
      "/resources/orders/actions/new",
      "/resources/orders/records/:recordId/show",
      "/resources/books",
    ]) {
      const screen = screenAt(screens, url)
      expect(screen?.entries, url).toEqual([])
      expect(screen?.tree, url).toEqual([])
      expect(screen?.kindTag, url).toBe(GENERATED_KIND_TAG)
      expect(screen?.addressable, url).toBe(true)
    }
  })

  it("treats an explicit `component: false` as an assertion of absence, not as a hole", () => {
    const fetchOrders = screenAt(appRun().graph.screens, "/resources/orders/actions/fetchOrders")

    expect(fetchOrders?.entries).toEqual([])
    expect(fetchOrders?.kindTag).toBe(GENERATED_KIND_TAG)
    expect(fetchOrders?.provenance.evidence.map((entry) => entry.what)).toContain(
      "action 'fetchOrders' declares no component",
    )
  })

  it("keeps the custom-component action untagged, so `generated` means what it says", () => {
    expect(screenAt(appRun().graph.screens, "/resources/orders")?.kindTag).toBeNull()
  })

  it("turns a computed resource id into an opaque entry plus a diagnostic, never a silent drop", () => {
    const result = analyze({
      ...APP_FILES,
      "src/admin/resources/dynamic/dynamic.resource.ts": `
export const createDynamicResource = () => ({
  resource: "Dynamic",
  options: { id: buildId(), actions: { list: { component: false } } },
})
`,
      "src/admin/options.ts": optionsFile("/").replace(
        "createBookResource()]",
        "createBookResource(), createDynamicResource()]\n",
      ).replace(
        'import { createBookResource } from "./resources/book/book.resource.js"',
        'import { createBookResource } from "./resources/book/book.resource.js"\nimport { createDynamicResource } from "./resources/dynamic/dynamic.resource.js"',
      ),
    })

    const hole = result.graph.screens.find((screen) => screen.url === null)
    expect(hole?.entries).toEqual([
      {
        kind: "opaque",
        expr: "buildId()",
        file: "src/admin/resources/dynamic/dynamic.resource.ts",
        line: 4,
      },
    ])
    expect(hole?.addressable).toBe(false)
    expect(codes(result)).toContain("screens/opaque-entry")
    expect(
      result.diagnostics.find(
        (entry) => entry.code === "screens/dynamic-registry" && entry.message.includes("buildId()"),
      )?.severity,
    ).toBe("warning")

    // The rest of the app is unaffected — one bad resource is a hole, not a blackout.
    expect(urlsOf(result.graph.screens)).toContain("/resources/orders")
  })

  it("warns instead of guessing when `resources` is not a readable array literal", () => {
    const result = analyze({
      ...APP_FILES,
      "src/admin/options.ts": optionsFile("/").replace(
        "resources: [createOrdersResource(), createBookResource()],",
        "resources: buildResources(),",
      ),
    })

    expect(
      result.diagnostics.find((entry) => entry.code === "screens/dynamic-registry")?.message,
    ).toContain("`resources` is not an array literal")
    expect(urlsOf(result.graph.screens)).not.toContain("/resources/orders")
    expect(urlsOf(result.graph.screens)).toContain("/pages/Dashboards")
  })

  it("warns when a resources element resolves to no readable factory", () => {
    const result = analyze({
      ...APP_FILES,
      "src/admin/options.ts": optionsFile("/").replace(
        "createBookResource()]",
        "createBookResource(), makeSomething()]",
      ),
    })

    expect(
      result.diagnostics.find(
        (entry) => entry.code === "screens/dynamic-registry" && entry.message.includes("makeSomething()"),
      )?.severity,
    ).toBe("warning")
    expect(urlsOf(result.graph.screens)).toContain("/resources/orders")
  })
})

// ---------------------------------------------------------------------------
// The pages map and the login path
// ---------------------------------------------------------------------------

describe("adminjs: the pages{} map and loginPath", () => {
  it("gives every page its own screen through the page template", () => {
    const screens = appRun().graph.screens

    expect(entryFilesOf(screenAt(screens, "/pages/Dashboards"))).toEqual([
      "src/admin/components/bestsellers-page.component.tsx",
    ])
    expect(entryFilesOf(screenAt(screens, "/pages/Bestsellers"))).toEqual([
      "src/admin/components/bestsellers-page.component.tsx",
    ])
    expect(screenAt(screens, "/pages/Dashboards")?.provenance.evidence.map((entry) => entry.what)).toEqual([
      "adminjs page 'Dashboards'",
    ])
  })

  it("emits a page with no component as a generated screen rather than dropping it", () => {
    const result = analyze({
      ...APP_FILES,
      "src/admin/options.ts": optionsFile("/").replace(
        'Dashboards: { component: Components.BestsellersPage, icon: "Layout" },',
        'Dashboards: { icon: "Layout" },',
      ),
    })

    const page = screenAt(result.graph.screens, "/pages/Dashboards")
    expect(page?.entries).toEqual([])
    expect(page?.kindTag).toBe(GENERATED_KIND_TAG)
  })

  it("emits the loginPath as a public, framework-rendered screen", () => {
    const login = screenAt(appRun().graph.screens, "/login")

    expect(login?.auth).toBe("public")
    expect(login?.entries).toEqual([])
    expect(login?.kindTag).toBe(GENERATED_KIND_TAG)
  })
})

// ---------------------------------------------------------------------------
// Wrapping forms, at this adapter's own discovery site
// ---------------------------------------------------------------------------

describe("adminjs: discovery survives the wrapping forms a raw type test rejects", () => {
  const WRAPPED = `
import { AdminJSOptions } from "adminjs"
import { Components } from "./component-loader.js"
import { createOrdersResource } from "./resources/orders/orders.resource.js"

export default ({
  rootPath: "/",
  resources: ([createOrdersResource()] as const),
  pages: { Dashboards: { component: Components.BestsellersPage } },
} satisfies AdminJSOptions)
`

  it("reads an options literal wrapped in parentheses and `satisfies`, with an `as const` resources array", () => {
    const result = analyze({ ...APP_FILES, "src/admin/options.ts": WRAPPED })

    expect(urlsOf(result.graph.screens)).toContain("/resources/orders")
    expect(urlsOf(result.graph.screens)).toContain("/pages/Dashboards")
    expect(codes(result)).not.toContain("plugin/threw")
  })

  it("a RAW ts.isObjectLiteralExpression rejects the same node discovery accepts", () => {
    const node = exportedExpressionOf(WRAPPED)

    expect(node).not.toBeNull()
    expect(ts.isObjectLiteralExpression(node as ts.Node)).toBe(false)
  })

  it("reads the resources array out of an imported const", () => {
    const result = analyze({
      ...APP_FILES,
      "src/admin/resources/index.ts": `
import { createOrdersResource } from "./orders/orders.resource.js"
export const allResources = [createOrdersResource()]
`,
      "src/admin/options.ts": `
import { AdminJSOptions } from "adminjs"
import { allResources } from "./resources/index.js"

const options: AdminJSOptions = { rootPath: "/", resources: allResources }
export default options
`,
    })

    expect(urlsOf(result.graph.screens)).toContain("/resources/orders")
    expect(entryFilesOf(screenAt(result.graph.screens, "/resources/orders"))).toEqual([
      "src/admin/components/orders-page.component.tsx",
    ])
  })

  it("reads a `new AdminJS({...})` argument as the options literal", () => {
    const result = analyze({
      ...APP_FILES,
      "src/admin/options.ts": `
import AdminJS from "adminjs"
import { createOrdersResource } from "./resources/orders/orders.resource.js"

export const admin = new AdminJS({ rootPath: "/", resources: [createOrdersResource()] })
`,
    })

    expect(urlsOf(result.graph.screens)).toContain("/resources/orders")
  })
})

describe("adminjs: bulk actions and resources without an id", () => {
  const withResource = (body: string): Files => ({
    ...APP_FILES,
    "src/admin/resources/extra/extra.resource.ts": `
export const createExtraResource = () => (${body})
`,
    "src/admin/options.ts": optionsFile("/").replace(
      "createBookResource()]",
      "createBookResource(), createExtraResource()]\n",
    ).replace(
      'import { createBookResource } from "./resources/book/book.resource.js"',
      'import { createBookResource } from "./resources/book/book.resource.js"\nimport { createExtraResource } from "./resources/extra/extra.resource.js"',
    ),
  })

  it("addresses a bulk action under /bulk/, never /actions/", () => {
    const result = analyze(
      withResource(`{
  resource: "Extra",
  options: { id: "extra", actions: { archiveMany: { actionType: "bulk" }, bulkDelete: {} } },
}`),
    )
    const urls = urlsOf(result.graph.screens)
    expect(urls).toContain("/resources/extra/bulk/archiveMany")
    expect(urls).toContain("/resources/extra/bulk/bulkDelete")
    expect(urls).not.toContain("/resources/extra/actions/archiveMany")
    expect(urls).not.toContain("/resources/extra/actions/bulkDelete")
  })

  it("warns about a resource with no options.id and adds no placeholder screen", () => {
    const result = analyze(withResource(`{ resource: "Extra", options: { navigation: "Shop", actions: {} } }`))
    expect(result.graph.screens.filter((screen) => screen.url === null)).toEqual([])
    expect(codes(result)).not.toContain("screens/opaque-entry")
    const warning = result.diagnostics.find(
      (entry) => entry.code === "screens/dynamic-registry" && entry.message.includes("declares no options.id"),
    )
    expect(warning).toMatchObject({ severity: "warning", file: "src/admin/resources/extra/extra.resource.ts" })
    expect(urlsOf(result.graph.screens)).toContain("/resources/orders")
  })
})
