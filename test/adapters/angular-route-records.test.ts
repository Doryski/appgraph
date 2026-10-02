import { describe, expect, it } from "vitest"
import type { AngularRouteNode, AngularRouteRecords } from "../../src/adapters/angular/route-records.js"
import { createAngularRouteReader } from "../../src/adapters/angular/route-records.js"
import { createAngularValues } from "../../src/adapters/angular/values.js"
import { discoverBench } from "./discover-harness.js"

const META_GUARD = "src/app/core/meta-guard.service.ts"
const LOGIN_GUARD = "src/app/core/login-guard.service.ts"
const CORE_INDEX = "src/app/core/index.ts"
const ADMIN = "src/app/+admin/routes.ts"
const MODERATION = "src/app/+admin/moderation.routes.ts"
const ABOUT = "src/app/about.component.ts"
const APP = "src/app/app.routes.ts"
const AUTHORITY = "src/tb/authority.ts"
const AUTH_GUARD = "src/tb/auth.guard.ts"
const DEVICE = "src/tb/device-routing.module.ts"
const HOME_PAGES = "src/tb/home-pages.module.ts"
const PROFILE = "src/tb/profile.routes.ts"
const TB_APP = "src/tb/app-routing.module.ts"
const TB_ACTION = "src/tb/action-routing.module.ts"
const OPPIA_COMMON = "assets/constants.ts"
const OPPIA_CONSTANTS = "src/oppia/app.constants.ts"
const OPPIA_SPLASH = "src/oppia/pages/splash-page/splash-page.module.ts"
const OPPIA_ROUTING = "src/oppia/app.routing.module.ts"

const META_GUARD_SOURCE = [
  `@Injectable()`,
  `export class MetaGuard {`,
  `  private meta = inject(MetaService)`,
  `  canActivate (route: ActivatedRouteSnapshot): boolean {`,
  `    const metaSettings = route.data?.meta`,
  `    if (metaSettings) {`,
  `      this.meta.update(metaSettings)`,
  `    }`,
  `    return true`,
  `  }`,
  `  canActivateChild (route: ActivatedRouteSnapshot): boolean {`,
  `    return this.canActivate(route)`,
  `  }`,
  `}`,
  "",
].join("\n")

const LOGIN_GUARD_SOURCE = [
  `@Injectable()`,
  `export class LoginGuard {`,
  `  canActivate (route: ActivatedRouteSnapshot, state: RouterStateSnapshot) {`,
  `    if (this.auth.isLoggedIn() === true) return true`,
  `    this.redirectService.replaceBy401(new Error(''))`,
  `    return false`,
  `  }`,
  `  canActivateChild (route: ActivatedRouteSnapshot, state: RouterStateSnapshot) {`,
  `    return this.canActivate(route, state)`,
  `  }`,
  `}`,
  "",
].join("\n")

const CORE_INDEX_SOURCE = [
  `export { MetaGuard } from './meta-guard.service'`,
  `export { LoginGuard } from './login-guard.service'`,
  "",
].join("\n")

const ADMIN_SOURCE = [
  `import { Route, Routes, UrlSegment } from '@angular/router'`,
  `import { moderationRoutes } from './moderation.routes'`,
  `import { AdminModerationComponent } from './admin-moderation.component'`,
  `import { AdminOverviewComponent } from './admin-overview.component'`,
  `const commonConfig = {`,
  `  path: '',`,
  `  providers: [BlocklistService]`,
  `}`,
  `function baseSettingsPathRedirect ({ url }: { url: UrlSegment[] }) {`,
  `  return '/admin/settings/' + url.map(u => u.path).join('/')`,
  `}`,
  `export default [`,
  `  { path: '', pathMatch: 'full', redirectTo: 'overview' },`,
  `  {`,
  `    ...commonConfig,`,
  `    component: AdminModerationComponent,`,
  `    canMatch: [`,
  `      (_route: Route, segments: UrlSegment[]) => {`,
  `        return isModerationRoute(segments)`,
  `      }`,
  `    ],`,
  `    children: moderationRoutes`,
  `  },`,
  `  {`,
  `    ...commonConfig,`,
  `    component: AdminOverviewComponent,`,
  `    canMatch: [(_route: Route, segments: UrlSegment[]) => isOverviewRoute(segments)],`,
  `    children: []`,
  `  },`,
  `  { path: 'config', pathMatch: 'prefix', redirectTo: baseSettingsPathRedirect }`,
  `] satisfies Routes`,
  "",
].join("\n")

const MODERATION_SOURCE = [
  `import { LoginGuard } from '../core'`,
  `export const moderationRoutes: Routes = [`,
  `  { path: 'moderation', component: ModerationComponent, canActivate: [LoginGuard], title: 'Moderation' }`,
  `]`,
  "",
].join("\n")

const ABOUT_SOURCE = `export class AboutComponent {}\n`

const APP_SOURCE = [
  `import { Routes, UrlMatchResult } from '@angular/router'`,
  `import { MetaGuard } from './core'`,
  `import { VideosParentComponent } from './videos-parent.component'`,
  `const openGuard = () => true`,
  `const routes: Routes = [`,
  `  {`,
  `    path: 'admin',`,
  `    loadChildren: () => import('./+admin/routes'),`,
  `    canActivateChild: [ MetaGuard ]`,
  `  },`,
  `  {`,
  `    path: 'about',`,
  `    loadComponent: () => import('./about.component').then(m => m.AboutComponent),`,
  `    canActivate: [openGuard, () => true, UnknownGuard],`,
  `    outlet: 'side'`,
  `  },`,
  `  {`,
  `    matcher: (url): UrlMatchResult => {`,
  `      if (url.length < 1) return null`,
  `      return { consumed: [] }`,
  `    },`,
  `    component: VideosParentComponent,`,
  `    children: [{ path: 'home', loadChildren: () => import('./+home/routes') }]`,
  `  }`,
  `]`,
  `for (const locale of AVAILABLE_LOCALES) {`,
  `  routes.push({ path: locale, component: HomepageRedirectComponent })`,
  `}`,
  `routes.push({`,
  `  path: '**',`,
  `  loadChildren: () => import('./+error-page/routes')`,
  `})`,
  `export default routes`,
  "",
].join("\n")

const AUTHORITY_SOURCE = [
  `export enum Authority {`,
  `  SYS_ADMIN = 'SYS_ADMIN',`,
  `  TENANT_ADMIN = 'TENANT_ADMIN',`,
  `  CUSTOMER_USER = 'CUSTOMER_USER'`,
  `}`,
  "",
].join("\n")

const AUTH_GUARD_SOURCE = [
  `export class AuthGuard {`,
  `  canActivate(next: ActivatedRouteSnapshot) {`,
  `    return this.getAuthState().pipe(map(() => next.data.module === 'public'))`,
  `  }`,
  `}`,
  "",
].join("\n")

const DEVICE_SOURCE = [
  `import { Authority } from './authority'`,
  `import { RouterTabsComponent } from './router-tabs.component'`,
  `const deviceSharedGroupsRoute: Route = { path: 'shared', children: [] };`,
  `export const devicesRoute = (root = false): Route => {`,
  `  const routeConfig: Route = {`,
  `    path: 'devices',`,
  `    component: RouterTabsComponent,`,
  `    data: {`,
  `      auth: [Authority.TENANT_ADMIN, Authority.CUSTOMER_USER],`,
  `      breadcrumb: { labelFunction: (route) => route.data.title, icon: 'devices_other' },`,
  `      hideTabs: true`,
  `    },`,
  `    children: [`,
  `      {`,
  `        path: '',`,
  `        children: [],`,
  `        data: {`,
  `          auth: [Authority.TENANT_ADMIN, Authority.CUSTOMER_USER],`,
  `          redirectTo: 'all'`,
  `        }`,
  `      },`,
  `      { path: 'all', component: EntitiesTableComponent, data: { title: entityGroupsTitle(true) } }`,
  `    ]`,
  `  };`,
  `  if (root) {`,
  `    routeConfig.children.push(deviceSharedGroupsRoute);`,
  `  }`,
  `  return routeConfig;`,
  `};`,
  `const routes: Routes = [`,
  `  devicesRoute(true),`,
  `  {`,
  `    path: 'resources',`,
  `    data: {`,
  `      auth: ['SYS_ADMIN'],`,
  `      redirectTo: {`,
  `        SYS_ADMIN: '/resources/widgets-library',`,
  `        CUSTOMER_USER: '/resources/images'`,
  `      }`,
  `    },`,
  `    children: []`,
  `  }`,
  `];`,
  `export const DEVICE_ROUTES = routes;`,
  "",
].join("\n")

const HOME_PAGES_SOURCE = `export class HomePagesModule {}\n`

const PROFILE_SOURCE = `export const PROFILE_ROUTES: Routes = [{ path: 'profile' }];\n`

const TB_APP_SOURCE = [
  `import { AuthGuard } from './auth.guard'`,
  `const routes: Routes = [`,
  `  {`,
  `    path: '',`,
  `    canActivate: [AuthGuard],`,
  `    loadChildren: () => import('./home-pages.module').then(m => m.HomePagesModule)`,
  `  },`,
  `  { path: 'profile', loadChildren: () => import('./profile.routes').then((m) => m.PROFILE_ROUTES) },`,
  `  { path: 'gone', loadChildren: () => import('./missing.module').then(m => m.MissingModule) }`,
  `];`,
  `export const TB_ROUTES = routes;`,
  "",
].join("\n")

const TB_ACTION_SOURCE = [
  `import { of } from 'rxjs';`,
  `const routes: Routes = [`,
  `  { path: 'action/addonAccessRequest', loadComponent: () => of(null), canActivate: [ActionGuard] },`,
  `  { path: 'action/resolved', loadComponent: () => Promise.resolve(null) },`,
  `  { path: 'action/factory', loadComponent: () => build(null) },`,
  `];`,
  `export const ACTION_ROUTES = routes;`,
  "",
].join("\n")

const OPPIA_COMMON_SOURCE = [
  `export default {`,
  `  "PAGES_REGISTERED_WITH_FRONTEND": {`,
  `    "SPLASH": { "ROUTE": "" },`,
  `    "PENDING_ACCOUNT_DELETION": { "ROUTE": "pending-account-deletion" }`,
  `  }`,
  `};`,
  "",
].join("\n")

const OPPIA_CONSTANTS_SOURCE = [
  `import commonConstants from 'assets/constants';`,
  `export const AppConstants = { ...commonConstants, STEWARDS_LANDING_PAGE: { ROUTES: ['parents'] } } as const;`,
  "",
].join("\n")

const OPPIA_SPLASH_SOURCE = `export class SplashPageModule {}\n`

const OPPIA_ROUTING_SOURCE = [
  `import { AppConstants } from './app.constants';`,
  `const routes: Route[] = [`,
  `  {`,
  `    path: AppConstants.PAGES_REGISTERED_WITH_FRONTEND.SPLASH.ROUTE,`,
  `    loadChildren: () => import('./pages/splash-page/' + 'splash-page.module').then(m => m.SplashPageModule),`,
  `  },`,
  `  {`,
  `    path: AppConstants.PAGES_REGISTERED_WITH_FRONTEND`,
  `      .PENDING_ACCOUNT_DELETION.ROUTE,`,
  `    loadChildren: () => import('./pages/splash-page/splash-page.module').then(m => m.SplashPageModule),`,
  `  },`,
  `  { path: AppConstants.STEWARDS_LANDING_PAGE.ROUTES[0] },`,
  `];`,
  `export const OPPIA_ROUTES = routes;`,
  "",
].join("\n")

const bench = discoverBench({
  [META_GUARD]: META_GUARD_SOURCE,
  [LOGIN_GUARD]: LOGIN_GUARD_SOURCE,
  [CORE_INDEX]: CORE_INDEX_SOURCE,
  [ADMIN]: ADMIN_SOURCE,
  [MODERATION]: MODERATION_SOURCE,
  [ABOUT]: ABOUT_SOURCE,
  [APP]: APP_SOURCE,
  [AUTHORITY]: AUTHORITY_SOURCE,
  [AUTH_GUARD]: AUTH_GUARD_SOURCE,
  [DEVICE]: DEVICE_SOURCE,
  [HOME_PAGES]: HOME_PAGES_SOURCE,
  [PROFILE]: PROFILE_SOURCE,
  [TB_APP]: TB_APP_SOURCE,
  [TB_ACTION]: TB_ACTION_SOURCE,
  [OPPIA_COMMON]: OPPIA_COMMON_SOURCE,
  [OPPIA_CONSTANTS]: OPPIA_CONSTANTS_SOURCE,
  [OPPIA_SPLASH]: OPPIA_SPLASH_SOURCE,
  [OPPIA_ROUTING]: OPPIA_ROUTING_SOURCE,
})
const values = createAngularValues(bench.ctx)
const { readRoutes } = createAngularRouteReader(bench.ctx, values)

const routesOf = (file: string, exportName: string): AngularRouteRecords => {
  const exported = values.exportedValue(file, exportName)
  if (exported === null) throw new Error(`no export ${exportName} in ${file}`)
  return readRoutes(exported)
}

const at = (nodes: readonly AngularRouteNode[], index: number): AngularRouteNode => {
  const node = nodes[index]
  if (node === undefined) throw new Error(`no route at ${index}`)
  return node
}

describe("createAngularRouteReader: PeerTube +admin", () => {
  const records = routesOf(ADMIN, "default")

  it("reads redirects, spreads and canMatch lambdas in declaration order", () => {
    expect(records.unreadable).toEqual([])
    expect(records.nodes.map((node) => [node.path, node.pathMatch, node.redirectTo])).toEqual([
      ["", "full", { kind: "path", value: "overview" }],
      ["", null, null],
      ["", null, null],
      ["config", "prefix", { kind: "function" }],
    ])
  })

  it("keeps the spread component binding and inline canMatch guards", () => {
    const moderation = at(records.nodes, 1)
    expect(moderation.component).toEqual({ kind: "binding", from: ADMIN, local: "AdminModerationComponent" })
    expect(moderation.guards).toEqual([{ kind: "canMatch", name: null, file: ADMIN, trivial: false }])
    expect(moderation.line).toBe(14)
  })

  it("marks canMatch siblings sharing a path as a group", () => {
    expect(records.nodes.map((node) => node.canMatchGroup)).toEqual([false, true, true, false])
  })

  it("follows imported children and resolves a guard through a barrel", () => {
    const [child] = at(records.nodes, 1).children
    expect(child).toMatchObject({
      path: "moderation",
      file: MODERATION,
      title: "Moderation",
      guards: [{ kind: "canActivate", name: "LoginGuard", file: LOGIN_GUARD, trivial: false }],
    })
  })
})

describe("createAngularRouteReader: PeerTube app.routes", () => {
  const records = routesOf(APP, "default")

  it("reads a default-export loadChildren as routes and keeps the trivial MetaGuard", () => {
    expect(at(records.nodes, 0)).toMatchObject({
      path: "admin",
      loadChildren: { kind: "routes", file: ADMIN, exportName: "default" },
      guards: [{ kind: "canActivateChild", name: "MetaGuard", file: META_GUARD, trivial: true }],
    })
  })

  it("reads a loadComponent export, guard triviality and the outlet", () => {
    const about = at(records.nodes, 1)
    expect(about.loadComponent).toEqual({ kind: "file", file: ABOUT, exportName: "AboutComponent" })
    expect(about.outlet).toBe("side")
    expect(about.guards).toEqual([
      { kind: "canActivate", name: "openGuard", file: APP, trivial: true },
      { kind: "canActivate", name: null, file: APP, trivial: true },
      { kind: "canActivate", name: "UnknownGuard", file: null, trivial: false },
    ])
  })

  it("flags a matcher route with a null path and keeps its children", () => {
    const matcher = at(records.nodes, 2)
    expect(matcher).toMatchObject({ path: null, matcher: true })
    expect(matcher.children.map((child) => child.loadChildren)).toEqual([
      { kind: "routes", file: null, exportName: "default", unresolvedSpec: "./+home/routes" },
    ])
  })

  it("appends the straight-line push and reports the for…of push as dynamic", () => {
    expect(records.nodes.map((node) => node.path)).toEqual(["admin", "about", null, "**"])
    expect(records.unreadable).toEqual([expect.objectContaining({ file: APP, line: 27, dynamic: true })])
  })
})

describe("createAngularRouteReader: thingsboard", () => {
  const device = routesOf(DEVICE, "DEVICE_ROUTES")

  it("reads a factory element with its bound push", () => {
    const devices = at(device.nodes, 0)
    expect(devices.file).toBe(DEVICE)
    expect(devices.component).toEqual({ kind: "binding", from: DEVICE, local: "RouterTabsComponent" })
    expect(devices.children.map((child) => child.path)).toEqual(["", "all", "shared"])
    expect(devices.children.every((child) => child.conditions.length === 0)).toBe(true)
  })

  it("keeps enum authorities as text and skips non-literal data", () => {
    const devices = at(device.nodes, 0)
    expect(devices.data).toEqual({ auth: ["Authority.TENANT_ADMIN", "Authority.CUSTOMER_USER"], hideTabs: true })
    expect(devices.dataMaps).toEqual({})
    expect(at(devices.children, 1).data).toEqual({})
  })

  it("reads the componentless data.redirectTo leaf", () => {
    expect(at(at(device.nodes, 0).children, 0)).toMatchObject({
      path: "",
      component: null,
      children: [],
      data: { auth: ["Authority.TENANT_ADMIN", "Authority.CUSTOMER_USER"], redirectTo: "all" },
    })
  })

  it("puts a per-authority redirectTo map under dataMaps", () => {
    const resources = at(device.nodes, 1)
    expect(resources.data).toEqual({ auth: ["SYS_ADMIN"] })
    expect(resources.dataMaps).toEqual({
      redirectTo: { SYS_ADMIN: "/resources/widgets-library", CUSTOMER_USER: "/resources/images" },
    })
  })

  it("classifies loadChildren targets as module or routes", () => {
    const app = routesOf(TB_APP, "TB_ROUTES")
    expect(app.nodes.map((node) => node.loadChildren)).toEqual([
      { kind: "module", file: HOME_PAGES, exportName: "HomePagesModule" },
      { kind: "routes", file: PROFILE, exportName: "PROFILE_ROUTES" },
      { kind: "module", file: null, exportName: "MissingModule", unresolvedSpec: "./missing.module" },
    ])
    expect(at(app.nodes, 0).guards).toEqual([
      { kind: "canActivate", name: "AuthGuard", file: AUTH_GUARD, trivial: false },
    ])
  })
})

describe("createAngularRouteReader: componentless loadComponent (thingsboard action)", () => {
  const action = routesOf(TB_ACTION, "ACTION_ROUTES")

  it("marks of(null) and Promise.resolve(null) as loading nothing instead of an opaque entry", () => {
    expect(action.nodes.map((node) => [node.path, node.loadComponent, node.loadsNothing])).toEqual([
      ["action/addonAccessRequest", null, true],
      ["action/resolved", null, true],
      ["action/factory", expect.objectContaining({ kind: "opaque" }), false],
    ])
  })
})

describe("createAngularRouteReader: Oppia constants", () => {
  const oppia = routesOf(OPPIA_ROUTING, "OPPIA_ROUTES")

  it("reads paths through an as-const member chain whose root spreads a default-imported object", () => {
    expect(oppia.nodes.map((node) => node.path)).toEqual(["", "pending-account-deletion", null])
  })

  it("resolves a concatenated dynamic import spec", () => {
    expect(oppia.nodes.map((node) => node.loadChildren)).toEqual([
      { kind: "module", file: OPPIA_SPLASH, exportName: "SplashPageModule" },
      { kind: "module", file: OPPIA_SPLASH, exportName: "SplashPageModule" },
      null,
    ])
    expect(oppia.unreadable).toEqual([])
  })
})
