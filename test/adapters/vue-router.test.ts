import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import type { Screen } from "../../src/core/model.js"
import { createVueRouterAdapter, detectVueRouter } from "../../src/adapters/vue-router.js"
import { resolveVueAuthRules } from "../../src/adapters/vue-auth.js"
import { SOURCE_SCORES } from "../../src/detect/index.js"
import { createProjectProbe } from "../../src/detect/project.js"
import { ROOT, TSCONFIG, codes, run } from "../pipeline/harness.js"

const view = (name: string): string => `<template><div class="${name}" /></template>\n<script setup lang="ts">\nconst label = "${name}"\n</script>\n`

const shell = (name: string): string =>
  `<template><div class="${name}"><RouterView /></div></template>\n<script setup lang="ts">\nconst label = "${name}"\n</script>\n`

const manifest = (dependencies: Readonly<Record<string, string>>): string =>
  JSON.stringify({ name: "fixture", dependencies: { vue: "3.5.0", "vue-router": "4.4.0", ...dependencies } })

const PACKAGE_JSON = manifest({})

const N8N_ROUTER = `import { createRouter, createWebHistory, RouterView } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { VIEWS } from '@/app/constants'
import { projectsRoutes } from '@/app/projects.routes'

const ErrorView = async () => await import('@/app/views/ErrorView.vue')
const SigninView = async () => await import('@/app/views/SigninView.vue')
const ExecutionsView = async () => await import('@/app/views/ExecutionsView.vue')
const ExecutionPreview = async () => await import('@/app/views/ExecutionPreview.vue')

export const routes: RouteRecordRaw[] = [
\t{
\t\tpath: '/workflow/:workflowId/executions',
\t\tname: VIEWS.EXECUTIONS,
\t\tcomponent: ExecutionsView,
\t\tmeta: { middleware: ['authenticated'] },
\t\tchildren: [
\t\t\t{
\t\t\t\tpath: ':executionId',
\t\t\t\tname: VIEWS.EXECUTION_PREVIEW,
\t\t\t\tcomponents: { executionPreview: ExecutionPreview, default: ErrorView },
\t\t\t},
\t\t],
\t},
\t{ path: '/workflow', redirect: '/workflow/new' },
\t{ path: '/signin', name: VIEWS.SIGNIN, component: SigninView, meta: { middleware: ['guest'] } },
\t{
\t\tpath: '/settings',
\t\tredirect: () => ({ name: VIEWS.SIGNIN }),
\t\tbeforeEnter: () => true,
\t},
\t{
\t\tpath: '/home',
\t\tcomponent: RouterView,
\t\tchildren: [{ path: 'workflows', component: ExecutionPreview }],
\t},
\t...projectsRoutes,
\t{ path: '/:pathMatch(.*)*', name: VIEWS.NOT_FOUND, component: ErrorView },
]

function withMeta(route: RouteRecordRaw) {
\treturn route
}

const router = createRouter({
\thistory: createWebHistory('/'),
\troutes: routes.map(withMeta),
})

router.beforeEach(async () => true)

export default router
`

const N8N_PROJECTS = `import type { RouteRecordRaw } from 'vue-router'
import { VIEWS } from '@/app/constants'

const WorkflowsView = async () => await import('@/app/views/WorkflowsView.vue')

export const projectsRoutes: RouteRecordRaw[] = [
\t{
\t\tpath: '/projects',
\t\tname: VIEWS.PROJECTS,
\t\tmeta: { middleware: ['authenticated'] },
\t\tredirect: { name: VIEWS.PROJECT_WORKFLOWS },
\t\tchildren: [{ path: ':projectId/workflows', name: VIEWS.PROJECT_WORKFLOWS, component: WorkflowsView }],
\t},
]
`

const N8N_CONSTANTS = `export enum VIEWS {
  EXECUTIONS = 'Executions',
  EXECUTION_PREVIEW = 'ExecutionPreview',
  SIGNIN = 'SigninView',
  PROJECTS = 'Projects',
  PROJECT_WORKFLOWS = 'ProjectWorkflows',
  NOT_FOUND = 'NotFoundView',
}
`

const N8N_MAIN = `import { createApp } from 'vue'
import App from '@/app/App.vue'
import router from '@/app/router'

const app = createApp(App)
app.use(router)
app.mount('#app')
`

const N8N_MODULES = `import router from '@/app/router'
export const registerModuleRoutes = (route: never) => {
\trouter.addRoute('Projects', route)
}
`

const N8N_FILES = {
  "package.json": PACKAGE_JSON,
  "src/main.ts": N8N_MAIN,
  "src/app/App.vue": shell("App"),
  "src/app/router.ts": N8N_ROUTER,
  "src/app/projects.routes.ts": N8N_PROJECTS,
  "src/app/constants.ts": N8N_CONSTANTS,
  "src/app/modules.ts": N8N_MODULES,
  "src/app/views/ExecutionsView.vue": shell("ExecutionsView"),
  ...Object.fromEntries(
    ["ErrorView", "SigninView", "ExecutionPreview", "WorkflowsView"].map((name) => [
      `src/app/views/${name}.vue`,
      view(name),
    ]),
  ),
}

const VIKUNJA_ROUTER = `import { createRouter, createWebHistory } from 'vue-router'
import Login from '@/views/user/Login.vue'
import NotFound from '@/views/404.vue'

const router = createRouter({
\thistory: createWebHistory(import.meta.env.BASE_URL),
\troutes: [
\t\t{ path: '/', name: 'home', component: () => import('@/views/Home.vue') },
\t\t{ path: '/:pathMatch(.*)*', name: 'not-found', component: NotFound },
\t\t{ path: '/:pathMatch(.*)', name: 'bad-not-found', component: NotFound },
\t\t{ path: '/login', name: 'user.login', alias: ['/signin'], component: Login, meta: { requiresAuth: false } },
\t\t{
\t\t\tpath: '/user/settings',
\t\t\tname: 'user.settings',
\t\t\tcomponent: () => import('@/views/user/Settings.vue'),
\t\t\tredirect: { name: 'user.settings.general' },
\t\t\tchildren: [
\t\t\t\t{ path: '/user/settings/general', name: 'user.settings.general', component: () => import('@/views/user/General.vue') },
\t\t\t],
\t\t},
\t\t{ path: '/lists:pathMatch(.*)*', name: 'lists', redirect(to) { return { path: to.path } } },
\t\t{ path: '/old', redirect: { name: 'nowhere' } },
\t\t{ path: '/projects/:projectId(\\\\d+)/edit', name: 'project.edit', component: () => import('@/views/ProjectEdit.vue') },
\t\t{ path: '/projects/:projectId(-\\\\d+)/edit', name: 'filter.edit', component: () => import('@/views/FilterEdit.vue') },
\t\t{ path: '/login', name: 'user.login.again', component: Login },
\t\t{
\t\t\tpath: '/admin',
\t\t\tcomponent: () => import('@/views/admin/AdminShell.vue'),
\t\t\tchildren: [
\t\t\t\t{ path: '', name: 'admin.overview', component: () => import('@/views/admin/Overview.vue') },
\t\t\t\t{ path: 'users', name: 'admin.users', component: () => import('@/views/admin/Users.vue') },
\t\t\t],
\t\t},
\t],
})

router.beforeEach(async () => true)

export default router
`

const VIKUNJA_MAIN = `import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import Button from '@/components/Button.vue'
import Card from '@/components/Card.vue'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'

const app = createApp(App)
app.component('XButton', Button as import('vue').Component)
app.component('Card', Card)
app.component('Icon', FontAwesomeIcon)
app.use(router)
`

const VIKUNJA_FILES = {
  "package.json": PACKAGE_JSON,
  "src/main.ts": VIKUNJA_MAIN,
  "src/App.vue": shell("App"),
  "src/router/index.ts": VIKUNJA_ROUTER,
  "src/components/Button.vue": view("Button"),
  "src/components/Card.vue": view("Card"),
  "src/views/admin/AdminShell.vue": shell("AdminShell"),
  "src/views/user/Settings.vue": shell("Settings"),
  ...Object.fromEntries(
    ["user/Login", "404", "Home", "user/General", "ProjectEdit", "FilterEdit", "admin/Overview", "admin/Users"].map(
      (name) => [`src/views/${name}.vue`, view(name)],
    ),
  ),
}

const analyze = (files: Readonly<Record<string, string>>, vueAuth?: { protectedMiddleware: readonly string[] }) =>
  run({
    files,
    adapters: [
      createVueRouterAdapter(vueAuth === undefined ? {} : { authRules: resolveVueAuthRules({ vueAuth }) }),
    ],
  })

const screenAt = (screens: readonly Screen[], url: string): Screen => {
  const found = screens.find((screen) => screen.url === url)
  if (found === undefined) throw new Error(`no screen at ${url}`)
  return found
}

const entryFiles = (screen: Screen): readonly string[] =>
  screen.entries.flatMap((entry) => (entry.kind === "file" ? [entry.file] : []))

const ancestorFiles = (screen: Screen): readonly string[] => screen.ancestors.map((ancestor) => ancestor.file)

const urls = (screens: readonly Screen[]): readonly string[] =>
  screens.flatMap((screen) => (screen.url === null ? [] : [screen.url])).sort()

const probe = (files: Readonly<Record<string, string>>) =>
  createProjectProbe({
    ts,
    root: ROOT,
    host: createMemoryHost({
      files: Object.fromEntries(
        Object.entries({ "tsconfig.json": TSCONFIG, ...files }).map(([file, text]) => [`${ROOT}/${file}`, text]),
      ),
    }),
  }).context

describe("detectVueRouter", () => {
  it("scores a createRouter call from vue-router as a data router, with its line", () => {
    const result = detectVueRouter(probe(N8N_FILES))
    expect(result.score).toBe(SOURCE_SCORES.dataRouter)
    expect(result.evidence).toEqual([
      { what: "vue-router dependency", file: "package.json", line: 1 },
      { what: "createRouter call from vue-router", file: "src/app/router.ts", line: 45 },
    ])
  })

  it("scores 0 without the vue-router dependency", () => {
    expect(detectVueRouter(probe({ ...N8N_FILES, "package.json": JSON.stringify({ dependencies: { vue: "3" } }) })).score).toBe(0)
  })

  it("scores 0 when nuxt is a dependency, so a Nuxt repo never has two live sources", () => {
    expect(detectVueRouter(probe({ ...N8N_FILES, "package.json": manifest({ nuxt: "3.0.0" }) })).score).toBe(0)
  })

  it("scores 0 when nothing calls createRouter", () => {
    expect(detectVueRouter(probe({ "package.json": PACKAGE_JSON, "src/main.ts": N8N_MAIN })).score).toBe(0)
  })
})

describe("vue-router discovery (n8n-shaped)", () => {
  const result = analyze(N8N_FILES)
  const { screens } = result.graph

  it("maps every literal record with a path, joining relative children and the spread file", () => {
    expect(urls(screens)).toEqual([
      "/*",
      "/home",
      "/home/workflows",
      "/projects",
      "/projects/:projectId/workflows",
      "/settings",
      "/signin",
      "/workflow",
      "/workflow/:workflowId/executions",
      "/workflow/:workflowId/executions/:executionId",
    ].sort())
  })

  it("gives named views default first and carries the route name", () => {
    const preview = screenAt(screens, "/workflow/:workflowId/executions/:executionId")
    expect(entryFiles(preview)).toEqual(["src/app/views/ErrorView.vue", "src/app/views/ExecutionPreview.vue"])
    expect(preview.routeName).toBe("ExecutionPreview")
  })

  it("chains the createApp root and each parent component as RouterView outlets, outermost first", () => {
    const preview = screenAt(screens, "/workflow/:workflowId/executions/:executionId")
    expect(ancestorFiles(preview)).toEqual(["src/app/App.vue", "src/app/views/ExecutionsView.vue"])
    expect(preview.ancestors.map((ancestor) => ancestor.splice)).toEqual([
      { kind: "outlet", tag: "RouterView" },
      { kind: "outlet", tag: "RouterView" },
    ])
    expect(ancestorFiles(screenAt(screens, "/signin"))).toEqual(["src/app/App.vue"])
  })

  it("reads meta.middleware: authenticated is protected and inherited, guest is public", () => {
    expect(screenAt(screens, "/workflow/:workflowId/executions").auth).toBe("protected")
    expect(screenAt(screens, "/workflow/:workflowId/executions/:executionId").auth).toBe("protected")
    expect(screenAt(screens, "/signin").auth).toBe("public")
    expect(screenAt(screens, "/projects/:projectId/workflows").auth).toBe("protected")
  })

  it("leaves auth unknown under a global beforeEach with no meta signal, and keeps beforeEnter as evidence", () => {
    const settings = screenAt(screens, "/settings")
    expect(settings.auth).toBe("unknown")
    expect(settings.provenance.evidence.map((entry) => entry.what)).toEqual(
      expect.arrayContaining([
        "a global router.beforeEach guard decides access at runtime; auth is not asserted",
        "per-route beforeEnter guard; evidence only, not asserted as protection",
        "redirect is a function; its target is decided at runtime",
      ]),
    )
  })

  it("treats a bare RouterView component as a pass-through, not an entry or an ancestor", () => {
    const home = screenAt(screens, "/home")
    expect(home.entries).toEqual([])
    expect(home.kindTag).toBe("layout")
    expect(ancestorFiles(screenAt(screens, "/home/workflows"))).toEqual(["src/app/App.vue"])
    expect(result.diagnostics.filter((entry) => entry.code === "screens/opaque-entry")).toEqual([])
  })

  it("maps string redirects and resolves name redirects through the router's own name table", () => {
    expect(screenAt(screens, "/workflow").redirectTo).toBe("/workflow/new")
    expect(screenAt(screens, "/projects").redirectTo).toBe("/projects/:projectId/workflows")
    expect(screenAt(screens, "/settings").redirectTo).toBeNull()
  })

  it("reports router.addRoute as one dynamic-registry info with its site", () => {
    const infos = result.diagnostics.filter((entry) => entry.code === "screens/dynamic-registry")
    expect(infos).toHaveLength(1)
    expect(infos[0]?.severity).toBe("info")
    expect(infos[0]?.message).toContain("src/app/modules.ts:3")
  })

  it("lets configured middleware names decide auth", () => {
    const custom = {
      ...N8N_FILES,
      "src/app/projects.routes.ts": N8N_PROJECTS.replace("['authenticated']", "['signedIn']"),
    }
    expect(screenAt(analyze(custom).graph.screens, "/projects").auth).toBe("unknown")
    expect(screenAt(analyze(custom, { protectedMiddleware: ["signedIn"] }).graph.screens, "/projects").auth).toBe(
      "protected",
    )
  })
})

describe("vue-router discovery (vikunja-shaped)", () => {
  const result = analyze(VIKUNJA_FILES)
  const { screens } = result.graph

  it("keeps absolute children absolute, merges catch-alls and regex-only variants, and lets '' own its parent url", () => {
    expect(urls(screens)).toEqual(
      [
        "/",
        "/*",
        "/admin",
        "/admin/users",
        "/lists/*",
        "/login",
        "/old",
        "/projects/:projectId/edit",
        "/user/settings",
        "/user/settings/general",
      ].sort(),
    )
    expect(entryFiles(screenAt(screens, "/admin"))).toEqual(["src/views/admin/Overview.vue"])
    expect(ancestorFiles(screenAt(screens, "/admin"))).toEqual(["src/App.vue", "src/views/admin/AdminShell.vue"])
    expect([...entryFiles(screenAt(screens, "/projects/:projectId/edit"))].sort()).toEqual([
      "src/views/FilterEdit.vue",
      "src/views/ProjectEdit.vue",
    ])
  })

  it("drops a second declaration of the same path with a conflict warning", () => {
    const dropped = result.diagnostics.filter((entry) => entry.code === "screens/conflict-dropped")
    expect(dropped.map((entry) => entry.message)).toEqual([expect.stringContaining("route '/login' is declared again")])
  })

  it("resolves a {name} redirect and leaves an unknown name unresolved with evidence", () => {
    expect(screenAt(screens, "/user/settings").redirectTo).toBe("/user/settings/general")
    const old = screenAt(screens, "/old")
    expect(old.redirectTo).toBeNull()
    expect(old.provenance.evidence.map((entry) => entry.what)).toContain(
      "redirect to route name 'nowhere', which no route of this router declares",
    )
  })

  it("asserts public only from requiresAuth: false and leaves the rest unknown", () => {
    expect(screenAt(screens, "/login").auth).toBe("public")
    expect(screenAt(screens, "/").auth).toBe("unknown")
  })

  it("reports aliases once per run", () => {
    const infos = result.diagnostics.filter(
      (entry) => entry.code === "screens/unsupported-router-style" && entry.severity === "info",
    )
    expect(infos.map((entry) => entry.message)).toEqual([expect.stringContaining("1 vue-router route alias(es)")])
  })

  it("registers literal app.component globals from the createApp file as ambient components", () => {
    const adapter = createVueRouterAdapter()
    const captured: string[] = []
    run({
      files: VIKUNJA_FILES,
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
    expect(captured).toEqual(["XButton=src/components/Button.vue", "Card=src/components/Card.vue"])
  })
})

describe("vue-router root, named views and merged names", () => {
  const DEV_PANEL = `import { createApp } from 'vue'
import DevPanel from './DevPanel.vue'

export const mountDevPanel = () => createApp(DevPanel).mount('#dev')
`

  const NAMED_ROUTER = `import { createRouter, createWebHistory } from 'vue-router'
import ListView from '@/views/ListView.vue'
import Landing from '@/views/Landing.vue'
import Preview from '@/views/Preview.vue'

export default createRouter({
\thistory: createWebHistory(),
\troutes: [
\t\t{ path: '/', component: { render: () => null }, beforeEnter: () => true },
\t\t{
\t\t\tpath: '/executions',
\t\t\tcomponent: ListView,
\t\t\tchildren: [
\t\t\t\t{ path: '', components: { executionPreview: Landing } },
\t\t\t\t{ path: ':id', components: { executionPreview: Preview } },
\t\t\t],
\t\t},
\t],
})
`

  const NAMED_FILES = {
    "package.json": PACKAGE_JSON,
    "src/main.ts": "import { createApp } from 'vue'\nimport App from './App.vue'\nimport router from './router'\n\ncreateApp(App).use(router).mount('#app')\n",
    "src/App.vue": shell("App"),
    "src/router.ts": NAMED_ROUTER,
    "src/views/ListView.vue": shell("ListView"),
    "src/views/Landing.vue": view("Landing"),
    "src/views/Preview.vue": view("Preview"),
  }

  it("takes the createApp root from the file that imports the router when other files call createApp too", () => {
    const files = {
      ...N8N_FILES,
      "src/app/dev/dev-panel/index.ts": DEV_PANEL,
      "src/app/dev/dev-panel/DevPanel.vue": view("DevPanel"),
    }
    const { screens } = analyze(files).graph
    expect(ancestorFiles(screenAt(screens, "/signin"))).toEqual(["src/app/App.vue"])
    expect(ancestorFiles(screenAt(screens, "/workflow/:workflowId/executions/:executionId"))).toEqual([
      "src/app/App.vue",
      "src/app/views/ExecutionsView.vue",
    ])
  })

  it("splices a child that supplies only a named view at the parent's named RouterView", () => {
    const { screens } = analyze(NAMED_FILES).graph
    const preview = screenAt(screens, "/executions/:id")
    expect(ancestorFiles(preview)).toEqual(["src/App.vue", "src/views/ListView.vue"])
    expect(preview.ancestors.map((ancestor) => ancestor.splice)).toEqual([
      { kind: "outlet", tag: "RouterView" },
      { kind: "outlet", tag: "RouterView", name: "executionPreview" },
    ])
    expect(screenAt(screens, "/executions").ancestors.at(-1)?.splice).toEqual({
      kind: "outlet",
      tag: "RouterView",
      name: "executionPreview",
    })
  })

  it("maps an inline object component as an entryless screen with evidence, not an opaque entry", () => {
    const result = analyze(NAMED_FILES)
    const home = screenAt(result.graph.screens, "/")
    expect(home.entries).toEqual([])
    expect(home.kindTag).toBe("entryless")
    expect(home.provenance.evidence.map((entry) => entry.what)).toContain("inline component definition at src/router.ts:9")
    expect(codes(result)).not.toContain("screens/opaque-entry")
  })

  it("resolves every route name of records merged into one screen", () => {
    const files = {
      ...VIKUNJA_FILES,
      "src/views/Home.vue": `<template><div /></template>
<script setup lang="ts">
import { useRouter } from 'vue-router'
const router = useRouter()
router.push({ name: 'filter.edit' })
router.push({ name: 'bad-not-found' })
</script>
`,
    }
    const result = analyze(files)
    const matched = screenAt(result.graph.screens, "/").navigatesTo.map((navigation) => [navigation.routeName, navigation.to])
    expect(matched).toEqual([
      ["bad-not-found", "/*"],
      ["filter.edit", "/projects/:projectId/edit"],
    ])
    expect(codes(result)).not.toContain("nav/dead-link")
  })
})

describe("vue-router createApp root per router table", () => {
  const ROUTER = `import { createRouter, createWebHistory } from 'vue-router'
import Home from '@/views/Home.vue'

export const router = createRouter({ history: createWebHistory(), routes: [{ path: '/', component: Home }] })
export default router
`

  const CONFIRM_HELPER = `import { createApp } from 'vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import router from '@/router'

export const confirm = () => {
\tconst app = createApp(ConfirmDialog)
\tapp.use(router)
\tapp.mount(document.createElement('div'))
}
`

  const PLUGINS = `import type { App } from 'vue'
import router from '@/router'

export { default as router } from '@/router'
export const installPlugins = (app: App) => {
\tapp.use(router)
}
`

  const INDEX_HTML = `<!doctype html>
<html><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>
`

  const BASE = {
    "package.json": PACKAGE_JSON,
    "src/App.vue": shell("App"),
    "src/router/index.ts": ROUTER,
    "src/views/Home.vue": view("Home"),
    "src/components/ConfirmDialog.vue": view("ConfirmDialog"),
    "src/components/Widget.vue": view("Widget"),
    "src/utils/confirm.ts": CONFIRM_HELPER,
    "src/plugins/index.ts": PLUGINS,
  }

  const BARREL_MAIN = `import { createApp } from 'vue'
import App from './App.vue'
import { router } from '@/plugins'

createApp(App).use(router).mount('#app')
`

  const PLUGIN_MAIN = `import { createApp } from 'vue'
import App from './App.vue'
import { installPlugins } from '@/plugins'

const app = createApp(App)
installPlugins(app)
app.mount('#app')
`

  const DIRECT_MAIN = `import { createApp } from 'vue'
import App from './App.vue'
import router from './router'

const app = createApp(App)
app.use(router)
app.mount('#app')
`

  const rootOf = (files: Readonly<Record<string, string>>, url = "/"): readonly string[] =>
    ancestorFiles(screenAt(analyze(files).graph.screens, url))

  const evidenceOf = (files: Readonly<Record<string, string>>, url = "/"): readonly string[] =>
    screenAt(analyze(files).graph.screens, url).provenance.evidence.map((entry) => entry.what)

  it("follows a router imported through a re-export barrel and ignores a dialog helper's createApp", () => {
    expect(rootOf({ ...BASE, "src/main.ts": BARREL_MAIN })).toEqual(["src/App.vue"])
  })

  it("takes the index.html module entry when main.ts installs the router through a plugin function", () => {
    expect(rootOf({ ...BASE, "index.html": INDEX_HTML, "src/main.ts": PLUGIN_MAIN })).toEqual(["src/App.vue"])
  })

  it("asserts no root, with evidence, when only a nested dialog helper uses the router and no entry is known", () => {
    const files = { ...BASE, "src/main.ts": PLUGIN_MAIN }
    expect(rootOf(files)).toEqual([])
    expect(evidenceOf(files)).toContain(
      "no createApp root layout is asserted; candidate createApp call(s): src/main.ts:5, src/utils/confirm.ts:6",
    )
  })

  it("prefers the top-level createApp when a nested dialog helper also uses the router", () => {
    expect(rootOf({ ...BASE, "src/main.ts": DIRECT_MAIN })).toEqual(["src/App.vue"])
  })

  it("takes the createApp that uses a router created in main.ts over another top-level createApp", () => {
    const main = `import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import Home from '@/views/Home.vue'

const router = createRouter({ history: createWebHistory(), routes: [{ path: '/', component: Home }] })
createApp(App).use(router).mount('#app')
`
    const embed = `import { createApp } from 'vue'
import Widget from '@/components/Widget.vue'

createApp(Widget).mount('#widget')
`
    const files = { "package.json": PACKAGE_JSON, "src/App.vue": shell("App"), "src/views/Home.vue": view("Home"), "src/components/Widget.vue": view("Widget"), "src/main.ts": main, "src/embed.ts": embed }
    expect(rootOf(files)).toEqual(["src/App.vue"])
  })

  it("picks a root per router table for micro-frontends with their own routers", () => {
    const app = (name: string, url: string) => ({
      [`src/${name}/router.ts`]: `import { createRouter, createWebHistory } from 'vue-router'\nimport Page from './Page.vue'\n\nexport default createRouter({ history: createWebHistory(), routes: [{ path: '${url}', component: Page }] })\n`,
      [`src/${name}/main.ts`]: `import { createApp } from 'vue'\nimport Root from './Root.vue'\nimport router from './router'\n\ncreateApp(Root).use(router).mount('#${name}')\n`,
      [`src/${name}/Root.vue`]: shell(`${name}Root`),
      [`src/${name}/Page.vue`]: view(`${name}Page`),
    })
    const files = { "package.json": PACKAGE_JSON, ...app("admin", "/admin"), ...app("shop", "/shop") }
    expect(rootOf(files, "/admin")).toEqual(["src/admin/Root.vue"])
    expect(rootOf(files, "/shop")).toEqual(["src/shop/Root.vue"])
    const withEntry = { ...files, "index.html": INDEX_HTML.replace("/src/main.ts", "/src/admin/main.ts") }
    expect(rootOf(withEntry, "/shop")).toEqual(["src/shop/Root.vue"])
  })

  it("reads the root from a render function and asserts none for an inline component", () => {
    const renderMain = `import { createApp, h } from 'vue'
import App from './App.vue'
import router from './router'

createApp({ render: () => h(App) }).use(router).mount('#app')
`
    const inlineMain = `import { createApp, defineComponent } from 'vue'
import router from './router'

createApp(defineComponent({ template: '<RouterView />' })).use(router).mount('#app')
`
    expect(rootOf({ ...BASE, "src/main.ts": renderMain })).toEqual(["src/App.vue"])
    const inline = { ...BASE, "src/main.ts": inlineMain }
    expect(rootOf(inline)).toEqual([])
    expect(evidenceOf(inline)).toContain(
      "no createApp root layout is asserted; candidate createApp call(s): src/main.ts:4",
    )
  })

  it("keeps App.vue as the root of every n8n- and vikunja-shaped screen with an index.html entry", () => {
    const n8n = analyze({
      ...N8N_FILES,
      "index.html": INDEX_HTML,
      "src/app/dev/dev-panel/index.ts": `import { createApp } from 'vue'\nimport DevPanel from './DevPanel.vue'\n\nexport const mountDevPanel = () => createApp(DevPanel).mount('#dev')\n`,
      "src/app/dev/dev-panel/DevPanel.vue": view("DevPanel"),
    }).graph.screens
    const vikunja = analyze({ ...VIKUNJA_FILES, "index.html": INDEX_HTML }).graph.screens
    expect(n8n.map((screen) => ancestorFiles(screen)[0])).toEqual(n8n.map(() => "src/app/App.vue"))
    expect(vikunja.map((screen) => ancestorFiles(screen)[0])).toEqual(vikunja.map(() => "src/App.vue"))
  })
})

describe("vue-router file routes (unplugin-vue-router / Vue Router 5)", () => {
  const FILE_ROUTER = `import { createRouter, createWebHistory } from 'vue-router'
import { routes } from 'vue-router/auto-routes'

export const router = createRouter({ history: createWebHistory(), routes })
`

  const FILE_MAIN = `import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'

createApp(App).use(router).mount('#app')
`

  const SETTINGS_PAGE = `<template><div /></template>
<script setup lang="ts">
definePage({ name: 'settings', path: '/preferences', meta: { requiresAuth: true } })
</script>
`

  const ADMIN_PAGE = `<route lang="json">
{ "name": "admin-home", "meta": { "middleware": ["auth"] } }
</route>
<template><div /></template>
`

  const LEGACY_PAGE = `<route lang="yaml">
name: legacy
</route>
<template><div /></template>
`

  const FILE_FILES = {
    "package.json": manifest({ "vue-router": "5.0.0" }),
    "src/main.ts": FILE_MAIN,
    "src/router.ts": FILE_ROUTER,
    "src/App.vue": shell("App"),
    "src/pages/users.vue": shell("Users"),
    "src/pages/settings.vue": SETTINGS_PAGE,
    "src/pages/admin.vue": ADMIN_PAGE,
    "src/pages/legacy.vue": LEGACY_PAGE,
    ...Object.fromEntries(
      [
        "index",
        "about",
        "users/index",
        "users/[id]",
        "users.create",
        "docs/[[slug]]",
        "[...all]",
        "(marketing)/pricing",
      ].map((name) => [`src/pages/${name}.vue`, view(name)]),
    ),
  }

  const EXPLICIT_ROUTER = `import { createRouter, createWebHistory } from 'vue-router'
import Home from './views/Home.vue'

export const router = createRouter({ history: createWebHistory(), routes: [{ path: '/home', component: Home }] })
`

  const result = analyze(FILE_FILES)
  const { screens } = result.graph

  it("scores fileConvention when a file imports vue-router/auto-routes, and 0 under nuxt", () => {
    expect(detectVueRouter(probe(FILE_FILES)).score).toBe(SOURCE_SCORES.fileConvention)
    expect(detectVueRouter(probe({ ...FILE_FILES, "package.json": manifest({ nuxt: "3.0.0" }) })).score).toBe(0)
  })

  it("maps index, [id], [[slug]], [...all], (group) and dotted file names to urls", () => {
    expect(urls(screens)).toEqual(
      [
        "/",
        "/*",
        "/about",
        "/admin",
        "/docs/:slug?",
        "/legacy",
        "/preferences",
        "/pricing",
        "/users",
        "/users/:id",
        "/users/create",
      ].sort(),
    )
  })

  it("nests foo.vue + foo/ children under foo's RouterView and lets index own the parent url", () => {
    expect(entryFiles(screenAt(screens, "/users"))).toEqual(["src/pages/users/index.vue"])
    expect(ancestorFiles(screenAt(screens, "/users/:id"))).toEqual(["src/App.vue", "src/pages/users.vue"])
    expect(ancestorFiles(screenAt(screens, "/users/create"))).toEqual(["src/App.vue", "src/pages/users.vue"])
    expect(ancestorFiles(screenAt(screens, "/about"))).toEqual(["src/App.vue"])
  })

  it("names routes by file path unless definePage or a <route> block names them", () => {
    expect(screenAt(screens, "/").routeName).toBe("/")
    expect(screenAt(screens, "/users").routeName).toBe("/users/")
    expect(screenAt(screens, "/users/:id").routeName).toBe("/users/[id]")
    expect(screenAt(screens, "/pricing").routeName).toBe("/(marketing)/pricing")
    expect(screenAt(screens, "/preferences").routeName).toBe("settings")
    expect(screenAt(screens, "/admin").routeName).toBe("admin-home")
  })

  it("reads definePage and <route lang=json> meta for auth, and reports a yaml block as unreadable", () => {
    expect(screenAt(screens, "/preferences").auth).toBe("protected")
    expect(screenAt(screens, "/admin").auth).toBe("protected")
    expect(screenAt(screens, "/about").auth).toBe("unknown")
    expect(screenAt(screens, "/legacy").routeName).toBe("/legacy")
    const infos = result.diagnostics.filter(
      (entry) => entry.code === "screens/unsupported-router-style" && entry.file === "src/pages/legacy.vue",
    )
    expect(infos.map((entry) => entry.message)).toEqual([expect.stringContaining('<route lang="yaml">')])
  })

  it("reads a literal routesFolder from the vite plugin call", () => {
    const moved = {
      ...Object.fromEntries(
        Object.entries(FILE_FILES).map(([file, text]) => [file.replace("src/pages/", "src/routes/"), text]),
      ),
      "vite.config.ts": `import { defineConfig } from 'vite'
import VueRouter from 'vue-router/vite'

export default defineConfig({ plugins: [VueRouter({ routesFolder: [{ src: './src/routes' }] })] })
`,
    }
    expect(urls(analyze(moved).graph.screens)).toEqual(urls(screens))
  })

  it("keeps an explicit createRouter table that does not use auto-routes, even with unplugin-vue-router", () => {
    const explicit = {
      ...FILE_FILES,
      "package.json": manifest({ "unplugin-vue-router": "0.10.0" }),
      "src/router.ts": EXPLICIT_ROUTER,
      "src/views/Home.vue": view("Home"),
    }
    expect(detectVueRouter(probe(explicit)).score).toBe(SOURCE_SCORES.dataRouter)
    expect(urls(analyze(explicit).graph.screens)).toEqual(["/home"])
  })

  it("scores fileConvention from the unplugin-vue-router dependency alone", () => {
    const bare = { ...FILE_FILES, "package.json": manifest({ "unplugin-vue-router": "0.10.0" }) }
    const withoutRouter = Object.fromEntries(Object.entries(bare).filter(([file]) => file !== "src/router.ts"))
    expect(detectVueRouter(probe(withoutRouter)).score).toBe(SOURCE_SCORES.fileConvention)
    expect(urls(analyze(withoutRouter).graph.screens)).toContain("/users/:id")
  })
})
