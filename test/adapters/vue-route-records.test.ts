import { describe, expect, it } from "vitest"
import type { DiscoverContext, ScreenSource, TsNode } from "../../src/adapters/types.js"
import { type RouteNode, type RouteRecords, readRoutes } from "../../src/adapters/vue-route-records.js"
import { adapterFor, run } from "../pipeline/harness.js"

const view = (name: string): string =>
  `<template><div class="${name}" /></template>\n<script setup lang="ts">\nconst label = "${name}"\n</script>\n`

const PACKAGE_JSON = JSON.stringify({ name: "fixture", dependencies: { vue: "3.5.0", "vue-router": "4.4.0" } })

const N8N_CONSTANTS = `export enum VIEWS {
  HOMEPAGE = 'Homepage',
  WORKFLOW_EXECUTIONS = 'WorkflowExecutions',
  EXECUTION_HOME = 'ExecutionsLandingPage',
  EXECUTION_PREVIEW = 'ExecutionPreview',
  SIGNIN = 'SigninView',
  SETTINGS = 'Settings',
  USAGE = 'Usage',
  PERSONAL_SETTINGS = 'PersonalSettings',
  EXTERNAL_SECRETS = 'ExternalSecrets',
  PROJECTS = 'Projects',
  PROJECT_DETAILS = 'ProjectDetails',
  PROJECTS_WORKFLOWS = 'ProjectsWorkflows',
  PROJECT_SETTINGS = 'ProjectSettings',
  NOT_FOUND = 'NotFoundView',
}
`

const N8N_ROUTER = `import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { VIEWS } from '@/app/constants'
import { projectsRoutes } from '@/features/projects/projects.routes'
import { useSettingsStore } from '@/stores/settings'

const ErrorView = async () => await import('@/app/views/ErrorView.vue')
const SigninView = async () => await import('@/app/views/SigninView.vue')
const WorkflowExecutionsView = async () =>
\tawait import('@/app/views/WorkflowExecutionsView.vue')
const WorkflowExecutionsLandingPage = async () => await import('@/app/views/WorkflowExecutionsLandingPage.vue')
const WorkflowExecutionsPreview = async () => await import('@/app/views/WorkflowExecutionsPreview.vue')
const SettingsUsageAndPlan = () => import('@/app/views/SettingsUsageAndPlan.vue')
const SettingsExternalSecrets = async () => {
\tconst settingsStore = useSettingsStore()
\tconst moduleConfig = settingsStore.moduleSettings['external-secrets']
\tif (moduleConfig?.multipleConnections) {
\t\treturn await import('@/app/views/SettingsSecretsProviders.vue')
\t}
\treturn await import('@/app/views/SettingsExternalSecrets.vue')
}

export const routes: RouteRecordRaw[] = [
\t{
\t\tpath: '/workflow/:workflowId/executions',
\t\tname: VIEWS.WORKFLOW_EXECUTIONS,
\t\tcomponent: WorkflowExecutionsView,
\t\tmeta: { layout: 'workflow', keepWorkflowAlive: true, middleware: ['authenticated'] },
\t\tchildren: [
\t\t\t{
\t\t\t\tpath: '',
\t\t\t\tname: VIEWS.EXECUTION_HOME,
\t\t\t\tcomponents: { executionPreview: WorkflowExecutionsLandingPage },
\t\t\t\tmeta: { middleware: ['authenticated'] },
\t\t\t},
\t\t\t{
\t\t\t\tpath: ':executionId/:nodeId?',
\t\t\t\tname: VIEWS.EXECUTION_PREVIEW,
\t\t\t\tcomponents: { sidebar: SigninView, executionPreview: WorkflowExecutionsPreview, default: ErrorView },
\t\t\t},
\t\t],
\t},
\t{
\t\tpath: '/workflow',
\t\tredirect: '/workflow/new',
\t},
\t{
\t\tpath: '/signin',
\t\tname: VIEWS.SIGNIN,
\t\tcomponent: SigninView,
\t\tmeta: { layout: 'auth', middleware: 'guest' },
\t},
\t{
\t\tpath: '/settings',
\t\tname: VIEWS.SETTINGS,
\t\tredirect: () => {
\t\t\tconst settingsStore = useSettingsStore()
\t\t\tif (settingsStore.settings.hideUsagePage) {
\t\t\t\treturn { name: VIEWS.PERSONAL_SETTINGS }
\t\t\t}
\t\t\treturn { name: VIEWS.USAGE }
\t\t},
\t\tchildren: [
\t\t\t{
\t\t\t\tpath: 'usage',
\t\t\t\tname: VIEWS.USAGE,
\t\t\t\tcomponent: SettingsUsageAndPlan,
\t\t\t\tmeta: { middleware: ['authenticated', 'custom'], middlewareOptions: { custom: () => true } },
\t\t\t},
\t\t\t{
\t\t\t\tpath: 'external-secrets',
\t\t\t\tname: VIEWS.EXTERNAL_SECRETS,
\t\t\t\tcomponent: SettingsExternalSecrets,
\t\t\t},
\t\t],
\t},
\t...projectsRoutes,
\t{
\t\tpath: '/:pathMatch(.*)*',
\t\tname: VIEWS.NOT_FOUND,
\t\tcomponent: ErrorView,
\t\tprops: { messageKey: 'error.pageNotFound' },
\t\tmeta: { nodeView: true, telemetry: { disabled: true } },
\t},
]

function withCanvasReadOnlyMeta(route: RouteRecordRaw) {
\troute.meta = { ...route.meta, readOnlyCanvas: true }
\treturn route
}

export const router = createRouter({
\thistory: createWebHistory('/'),
\troutes: routes.map(withCanvasReadOnlyMeta),
})
`

const N8N_PROJECTS = `import type { RouteRecordRaw } from 'vue-router'
import { VIEWS } from '@/app/constants'

const WorkflowsView = async () => await import('@/app/views/WorkflowsView.vue')
const ProjectSettings = async () => await import('./views/ProjectSettings.vue')

const commonChildRoutes: RouteRecordRaw[] = [
\t{
\t\tpath: 'workflows',
\t\tcomponent: WorkflowsView,
\t\tmeta: { middleware: ['authenticated', 'custom'] },
\t},
]

export const projectsRoutes: RouteRecordRaw[] = [
\t{
\t\tpath: '/projects',
\t\tname: VIEWS.PROJECTS,
\t\tmeta: { middleware: ['authenticated'] },
\t\tredirect: '/home/workflows',
\t\tchildren: [
\t\t\t{
\t\t\t\tname: VIEWS.PROJECT_DETAILS,
\t\t\t\tpath: ':projectId',
\t\t\t\tredirect: { name: VIEWS.PROJECTS_WORKFLOWS },
\t\t\t\tchildren: commonChildRoutes
\t\t\t\t\t.map((route, idx) => ({ ...route, name: String(idx) }))
\t\t\t\t\t.concat([
\t\t\t\t\t\t{
\t\t\t\t\t\t\tpath: 'settings',
\t\t\t\t\t\t\tname: VIEWS.PROJECT_SETTINGS,
\t\t\t\t\t\t\tcomponent: ProjectSettings,
\t\t\t\t\t\t},
\t\t\t\t\t]),
\t\t\t},
\t\t],
\t},
]
`

const N8N_FILES = {
  "package.json": PACKAGE_JSON,
  "src/app/constants.ts": N8N_CONSTANTS,
  "src/app/router.ts": N8N_ROUTER,
  "src/features/projects/projects.routes.ts": N8N_PROJECTS,
  "src/features/projects/views/ProjectSettings.vue": view("ProjectSettings"),
  "src/stores/settings.ts": "export const useSettingsStore = () => ({ settings: {}, moduleSettings: {} })\n",
  ...Object.fromEntries(
    [
      "ErrorView",
      "SigninView",
      "WorkflowExecutionsView",
      "WorkflowExecutionsLandingPage",
      "WorkflowExecutionsPreview",
      "SettingsUsageAndPlan",
      "SettingsSecretsProviders",
      "SettingsExternalSecrets",
      "WorkflowsView",
    ].map((name) => [`src/app/views/${name}.vue`, view(name)]),
  ),
}

const VIKUNJA_ROUTER = `import { createRouter, createWebHistory } from 'vue-router'
import { defineAsyncComponent } from 'vue'
import Login from '@/views/user/Login.vue'
import NotFoundComponent from '@/views/404.vue'
import { makeRoute } from '@/router/factory'

const devRoute = {
\tpath: '/dev',
\tname: 'dev',
\tcomponent: () => import('@/views/Dev.vue'),
}

const router = createRouter({
\thistory: createWebHistory(import.meta.env.BASE_URL),
\troutes: [
\t\t{
\t\t\tpath: '/',
\t\t\tname: 'home',
\t\t\tcomponent: () => import('@/views/Home.vue'),
\t\t},
\t\t{
\t\t\tpath: '/:pathMatch(.*)*',
\t\t\tname: 'not-found',
\t\t\tcomponent: NotFoundComponent,
\t\t},
\t\t{
\t\t\tpath: '/login',
\t\t\tname: 'user.login',
\t\t\talias: ['/signin', '/sign-in'],
\t\t\tcomponent: Login,
\t\t\tmeta: { title: 'user.auth.login', requiresAuth: false },
\t\t},
\t\t{
\t\t\tpath: '/user/settings',
\t\t\tname: 'user.settings',
\t\t\tcomponent: () => import('@/views/user/Settings.vue'),
\t\t\tredirect: {name: 'user.settings.general'},
\t\t\tchildren: [
\t\t\t\t{
\t\t\t\t\tpath: '/user/settings/general',
\t\t\t\t\tname: 'user.settings.general',
\t\t\t\t\tcomponent: defineAsyncComponent(() => import('@/views/user/settings/General.vue')),
\t\t\t\t},
\t\t\t\t{
\t\t\t\t\tpath: '/user/settings/caldav',
\t\t\t\t\tname: 'user.settings.caldav',
\t\t\t\t\tcomponent: () => import('@/views/user/settings/Caldav.vue'),
\t\t\t\t\tbeforeEnter: async () => {
\t\t\t\t\t\tconst {useConfigStore} = await import('@/stores/config')
\t\t\t\t\t\tif (!useConfigStore().caldav_enabled) {
\t\t\t\t\t\t\treturn {name: 'user.settings.general'}
\t\t\t\t\t\t}
\t\t\t\t\t},
\t\t\t\t},
\t\t\t],
\t\t},
\t\t{
\t\t\tpath: '/lists:pathMatch(.*)*',
\t\t\tname: 'lists',
\t\t\tredirect(to) {
\t\t\t\treturn { path: to.path.replace('/lists', '/projects') }
\t\t\t},
\t\t},
\t\t{
\t\t\tpath: '/old-home',
\t\t\tredirect: { path: '/' },
\t\t},
\t\t{
\t\t\tpath: '/admin',
\t\t\tname: 'admin',
\t\t\tcomponent: () => import('@/views/admin/Admin.vue'),
\t\t\tmeta: { requiresAuth: true, title: 'admin' },
\t\t\tchildren: [
\t\t\t\t{
\t\t\t\t\tpath: 'users',
\t\t\t\t\tname: 'admin.users',
\t\t\t\t\tcomponent: () => import('@/views/admin/Users.vue'),
\t\t\t\t},
\t\t\t\tmakeRoute('projects'),
\t\t\t],
\t\t},
\t\t...(import.meta.env.DEV ? [devRoute] : []),
\t\tmakeRoute('teams'),
\t],
})

export default router
`

const VIKUNJA_FILES = {
  "package.json": PACKAGE_JSON,
  "src/router/index.ts": VIKUNJA_ROUTER,
  "src/router/factory.ts": "export const makeRoute = (path: string) => ({ path })\n",
  "src/stores/config.ts": "export const useConfigStore = () => ({ caldav_enabled: true })\n",
  ...Object.fromEntries(
    [
      "user/Login",
      "404",
      "Dev",
      "Home",
      "user/Settings",
      "user/settings/General",
      "user/settings/Caldav",
      "admin/Admin",
      "admin/Users",
    ].map((name) => [`src/views/${name}.vue`, view(name)]),
  ),
}

const lineOf = (text: string, needle: string, from = 0): number =>
  text.slice(0, text.indexOf(needle, from)).split("\n").length

const vueFile = (name: string) => ({ kind: "file", file: `src/views/${name}.vue`, exportName: "default" })

const n8nView = (name: string) => ({ kind: "file", file: `src/app/views/${name}.vue`, exportName: "default" })

const routesProperty = (ctx: DiscoverContext, node: TsNode): TsNode | null => {
  const object = ctx.ast.asObjectLiteral(node)
  const member = object?.properties.find(
    (property) => ctx.ts.isPropertyAssignment(property) && ctx.ast.asIdentifier(property.name)?.text === "routes",
  )
  if (member !== undefined && ctx.ts.isPropertyAssignment(member)) return member.initializer
  let found: TsNode | null = null
  node.forEachChild((child) => {
    found ??= routesProperty(ctx, child)
  })
  return found
}

const readFixture = (files: Readonly<Record<string, string>>, file: string): RouteRecords => {
  const captured: RouteRecords[] = []
  const probe: ScreenSource = {
    name: "vue-route-probe",
    detect: () => ({ score: 100, evidence: [] }),
    discover: (ctx) => {
      const source = ctx.sourceFile(file)
      const routes = source === null ? null : routesProperty(ctx, source)
      if (routes !== null) captured.push(readRoutes(ctx, file, routes))
      return []
    },
  }
  run({ files, adapters: [adapterFor(probe)] })
  const [records] = captured
  if (records === undefined) throw new Error(`no routes read from ${file}`)
  return records
}

const byPath = (routes: readonly RouteNode[], path: string): RouteNode => {
  const found = routes.find((route) => route.path === path)
  if (found === undefined) throw new Error(`no route ${path}`)
  return found
}

describe("readRoutes (n8n-shaped)", () => {
  const records = readFixture(N8N_FILES, "src/app/router.ts")

  it("unwraps routes.map(fn) and follows the imported spread, in source order", () => {
    expect(records.routes.map((route) => route.path)).toEqual([
      "/workflow/:workflowId/executions",
      "/workflow",
      "/signin",
      "/settings",
      "/projects",
      "/:pathMatch(.*)*",
    ])
    expect(records.unreadable).toEqual([])
  })

  it("resolves enum names and lazy const entries, with lines and auth signals", () => {
    const executions = byPath(records.routes, "/workflow/:workflowId/executions")
    expect(executions).toMatchObject({
      file: "src/app/router.ts",
      line: lineOf(N8N_ROUTER, "\t{\n\t\tpath: '/workflow/:workflowId/executions'"),
      name: "WorkflowExecutions",
      entries: [n8nView("WorkflowExecutionsView")],
      entryConditions: [],
      redirect: null,
      alias: [],
      hasBeforeEnter: false,
      authSignals: { middleware: ["authenticated"], flags: { keepWorkflowAlive: true } },
    })
  })

  it("orders named views default first, then by name", () => {
    const [home, preview] = byPath(records.routes, "/workflow/:workflowId/executions").children
    expect(home).toMatchObject({ path: "", name: "ExecutionsLandingPage", entries: [n8nView("WorkflowExecutionsLandingPage")] })
    expect(preview?.entries).toEqual([
      n8nView("ErrorView"),
      n8nView("WorkflowExecutionsPreview"),
      n8nView("SigninView"),
    ])
  })

  it("reads string redirects, function redirects and a string middleware", () => {
    expect(byPath(records.routes, "/workflow").redirect).toEqual({ kind: "path", value: "/workflow/new" })
    expect(byPath(records.routes, "/settings").redirect).toEqual({ kind: "function" })
    expect(byPath(records.routes, "/signin").authSignals).toEqual({ middleware: ["guest"], flags: {} })
  })

  it("gives a conditional lazy component both imports and the branch condition", () => {
    const secrets = byPath(byPath(records.routes, "/settings").children, "external-secrets")
    expect(secrets.entries).toEqual([n8nView("SettingsSecretsProviders"), n8nView("SettingsExternalSecrets")])
    expect(secrets.entryConditions).toEqual(["moduleConfig?.multipleConnections"])
    const usage = byPath(byPath(records.routes, "/settings").children, "usage")
    expect(usage.entries).toEqual([n8nView("SettingsUsageAndPlan")])
    expect(usage.authSignals.middleware).toEqual(["authenticated", "custom"])
  })

  it("reads the spread file's records in their own file, through .map().concat() children", () => {
    const projects = byPath(records.routes, "/projects")
    expect(projects).toMatchObject({
      file: "src/features/projects/projects.routes.ts",
      line: lineOf(N8N_PROJECTS, "\t{\n\t\tpath: '/projects'"),
      name: "Projects",
      redirect: { kind: "path", value: "/home/workflows" },
      entries: [],
    })
    const [details] = projects.children
    expect(details).toMatchObject({
      path: ":projectId",
      redirect: { kind: "name", value: "ProjectsWorkflows" },
    })
    expect(details?.children.map((child) => [child.path, child.name, child.entries])).toEqual([
      ["workflows", null, [n8nView("WorkflowsView")]],
      [
        "settings",
        "ProjectSettings",
        [{ kind: "file", file: "src/features/projects/views/ProjectSettings.vue", exportName: "default" }],
      ],
    ])
    expect(details?.unreadableChildren).toEqual([])
  })

  it("keeps a catch-all path raw and ignores non-boolean meta", () => {
    expect(byPath(records.routes, "/:pathMatch(.*)*")).toMatchObject({
      name: "NotFoundView",
      entries: [n8nView("ErrorView")],
      authSignals: { middleware: [], flags: { nodeView: true } },
    })
  })
})

describe("readRoutes (vikunja-shaped)", () => {
  const records = readFixture(VIKUNJA_FILES, "src/router/index.ts")

  it("reads inline lazy, imported and defineAsyncComponent entries", () => {
    expect(byPath(records.routes, "/").entries).toEqual([vueFile("Home")])
    expect(byPath(records.routes, "/:pathMatch(.*)*").entries).toEqual([
      { kind: "binding", from: "src/router/index.ts", local: "NotFoundComponent" },
    ])
    const settings = byPath(records.routes, "/user/settings")
    expect(byPath(settings.children, "/user/settings/general").entries).toEqual([vueFile("user/settings/General")])
  })

  it("keeps absolute and relative child paths raw", () => {
    expect(byPath(records.routes, "/user/settings").children.map((child) => child.path)).toEqual([
      "/user/settings/general",
      "/user/settings/caldav",
    ])
    expect(byPath(records.routes, "/admin").children.map((child) => child.path)).toEqual(["users"])
  })

  it("reads every redirect kind", () => {
    expect(byPath(records.routes, "/user/settings").redirect).toEqual({ kind: "name", value: "user.settings.general" })
    expect(byPath(records.routes, "/lists:pathMatch(.*)*").redirect).toEqual({ kind: "function" })
    expect(byPath(records.routes, "/old-home").redirect).toEqual({ kind: "path", value: "/" })
  })

  it("reads alias, boolean auth flags and beforeEnter evidence", () => {
    expect(byPath(records.routes, "/login")).toMatchObject({
      alias: ["/signin", "/sign-in"],
      authSignals: { middleware: [], flags: { requiresAuth: false } },
      hasBeforeEnter: false,
    })
    expect(byPath(records.routes, "/admin").authSignals.flags).toEqual({ requiresAuth: true })
    const caldav = byPath(byPath(records.routes, "/user/settings").children, "/user/settings/caldav")
    expect(caldav).toMatchObject({ hasBeforeEnter: true, entries: [vueFile("user/settings/Caldav")], entryConditions: [] })
  })

  it("follows a ternary spread to a const route object, tagging its condition", () => {
    expect(byPath(records.routes, "/dev")).toMatchObject({
      conditions: ["import.meta.env.DEV"],
      line: lineOf(VIKUNJA_ROUTER, "const devRoute = {"),
      entries: [vueFile("Dev")],
    })
  })

  it("reports non-literal route elements as unreadable with their line", () => {
    expect(records.unreadable).toEqual([
      { file: "src/router/index.ts", line: lineOf(VIKUNJA_ROUTER, "makeRoute('teams')"), text: "makeRoute('teams')" },
    ])
    expect(byPath(records.routes, "/admin").unreadableChildren).toEqual([
      { file: "src/router/index.ts", line: lineOf(VIKUNJA_ROUTER, "makeRoute('projects')"), text: "makeRoute('projects')" },
    ])
  })
})
