import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createAngularAdapter, detectAngular } from "../../src/adapters/angular/router.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { Screen } from "../../src/core/model.js"
import { createProjectProbe } from "../../src/detect/project.js"
import type { PipelineResult } from "../../src/pipeline/run.js"
import { ROOT, TSCONFIG, run } from "../pipeline/harness.js"

const lines = (...rows: readonly string[]): string => [...rows, ""].join("\n")

const manifest = (dependencies: Readonly<Record<string, string>> = {}): string =>
  JSON.stringify({
    name: "fixture",
    dependencies: {
      "@angular/core": "^20.0.0",
      "@angular/router": "^20.0.0",
      "@angular/platform-browser": "^20.0.0",
      ...dependencies,
    },
  })

const component = (name: string, selector: string): string =>
  lines(
    `import { Component } from '@angular/core';`,
    `@Component({ selector: '${selector}', template: '<router-outlet></router-outlet>' })`,
    `export class ${name} {}`,
  )

const routingModule = (name: string, method: "forRoot" | "forChild", body: readonly string[]): string =>
  lines(
    `import { NgModule } from '@angular/core';`,
    `import { RouterModule, Routes } from '@angular/router';`,
    ...body,
    `@NgModule({ imports: [RouterModule.${method}(routes)], exports: [RouterModule] })`,
    `export class ${name} {}`,
  )

const PEERTUBE = {
  "package.json": manifest(),
  "src/main.ts": lines(
    `import { bootstrapApplication } from '@angular/platform-browser';`,
    `import { provideRouter } from '@angular/router';`,
    `import { AppComponent } from './app/app.component';`,
    `import routes from './app/app.routes';`,
    `bootstrapApplication(AppComponent, { providers: [provideRouter(routes)] });`,
  ),
  "src/app/app.component.ts": component("AppComponent", "my-app"),
  "src/app/core/meta-guard.service.ts": lines(
    `export class MetaGuard {`,
    `  canActivate () {`,
    `    return true`,
    `  }`,
    `  canActivateChild () {`,
    `    return this.canActivate()`,
    `  }`,
    `}`,
  ),
  "src/app/core/login-guard.service.ts": lines(
    `export class LoginGuard {`,
    `  canActivate () {`,
    `    if (this.auth.isLoggedIn()) return true`,
    `    return false`,
    `  }`,
    `}`,
  ),
  "src/app/core/unlogged-guard.service.ts": lines(
    `export class UnloggedGuard {`,
    `  canActivate () {`,
    `    return !this.auth.isLoggedIn()`,
    `  }`,
    `}`,
  ),
  "src/app/core/index.ts": lines(
    `export { MetaGuard } from './meta-guard.service'`,
    `export { LoginGuard } from './login-guard.service'`,
    `export { UnloggedGuard } from './unlogged-guard.service'`,
  ),
  "src/app/login.component.ts": component("LoginComponent", "my-login"),
  "src/app/about.component.ts": component("AboutComponent", "my-about"),
  "src/app/videos-parent.component.ts": component("VideosParentComponent", "my-videos-parent"),
  "src/app/error-page.component.ts": component("ErrorPageComponent", "my-error-page"),
  "src/app/homepage-redirect.component.ts": component("HomepageRedirectComponent", "my-homepage-redirect"),
  "src/app/app.routes.ts": lines(
    `import { Routes, UrlMatchResult } from '@angular/router'`,
    `import { MetaGuard, UnloggedGuard } from './core'`,
    `import { LoginComponent } from './login.component'`,
    `import { VideosParentComponent } from './videos-parent.component'`,
    `import { ErrorPageComponent } from './error-page.component'`,
    `import { HomepageRedirectComponent } from './homepage-redirect.component'`,
    `const routes: Routes = [`,
    `  { path: 'admin', loadChildren: () => import('./+admin/routes'), canActivateChild: [ MetaGuard ] },`,
    `  { path: 'login', component: LoginComponent, canActivate: [ UnloggedGuard ] },`,
    `  {`,
    `    path: 'about',`,
    `    loadComponent: () => import('./about.component').then(m => m.AboutComponent),`,
    `    canActivate: [ MetaGuard ]`,
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
    `routes.push({ path: '**', component: ErrorPageComponent })`,
    `export default routes`,
  ),
  "src/app/+admin/admin.component.ts": component("AdminComponent", "my-admin"),
  "src/app/+admin/admin-moderation.component.ts": component("AdminModerationComponent", "my-admin-moderation"),
  "src/app/+admin/moderation.component.ts": component("ModerationComponent", "my-moderation"),
  "src/app/+admin/overview.component.ts": component("OverviewComponent", "my-overview"),
  "src/app/+admin/legacy-overview.component.ts": component("LegacyOverviewComponent", "my-legacy-overview"),
  "src/app/+admin/moderation.routes.ts": lines(
    `import { Routes } from '@angular/router'`,
    `import { LoginGuard } from '../core'`,
    `import { ModerationComponent } from './moderation.component'`,
    `export const moderationRoutes: Routes = [`,
    `  { path: 'moderation', component: ModerationComponent, canActivate: [ LoginGuard ], title: 'Moderation' }`,
    `]`,
  ),
  "src/app/+admin/routes.ts": lines(
    `import { Route, Routes, UrlSegment } from '@angular/router'`,
    `import { LoginGuard } from '../core'`,
    `import { moderationRoutes } from './moderation.routes'`,
    `import { AdminComponent } from './admin.component'`,
    `import { AdminModerationComponent } from './admin-moderation.component'`,
    `import { OverviewComponent } from './overview.component'`,
    `import { LegacyOverviewComponent } from './legacy-overview.component'`,
    `const commonConfig = { path: 'section', providers: [] }`,
    `function settingsRedirect ({ url }: { url: UrlSegment[] }) {`,
    `  return '/admin/settings/' + url.map(u => u.path).join('/')`,
    `}`,
    `export default [`,
    `  {`,
    `    path: '',`,
    `    component: AdminComponent,`,
    `    children: [`,
    `      { path: '', pathMatch: 'full', redirectTo: 'section/moderation' },`,
    `      { ...commonConfig, component: AdminModerationComponent, children: moderationRoutes },`,
    `      { path: 'overview', component: OverviewComponent, canMatch: [ LoginGuard ] },`,
    `      { path: 'overview', component: LegacyOverviewComponent, canMatch: [ (_route: Route, segments: UrlSegment[]) => isLegacy(segments) ] },`,
    `      { path: 'config', pathMatch: 'prefix', redirectTo: settingsRedirect }`,
    `    ]`,
    `  }`,
    `] satisfies Routes`,
  ),
} as const

const THINGSBOARD = {
  "package.json": manifest(),
  "src/main.ts": lines(
    `import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';`,
    `import { AppModule } from './app/app.module';`,
    `platformBrowserDynamic().bootstrapModule(AppModule).catch((err) => console.error(err));`,
  ),
  "src/app/app.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { BrowserModule } from '@angular/platform-browser';`,
    `import { AppRoutingModule } from './app-routing.module';`,
    `import { LoginModule } from './modules/login/login.module';`,
    `import { HomeModule } from './modules/home/home.module';`,
    `import { PageNotFoundRoutingModule } from './page-not-found-routing.module';`,
    `import { AppComponent } from './app.component';`,
    `@NgModule({`,
    `  declarations: [AppComponent],`,
    `  imports: [BrowserModule, AppRoutingModule, LoginModule, HomeModule, PageNotFoundRoutingModule],`,
    `  bootstrap: [AppComponent]`,
    `})`,
    `export class AppModule {}`,
  ),
  "src/app/app.component.ts": component("AppComponent", "tb-root"),
  "src/app/core/auth.guard.ts": lines(
    `export class AuthGuard {`,
    `  canActivate(next: ActivatedRouteSnapshot) {`,
    `    return this.getAuthState().pipe(map(() => next.data.module === 'public'))`,
    `  }`,
    `}`,
  ),
  "src/app/app-routing.module.ts": routingModule("AppRoutingModule", "forRoot", [
    `const routes: Routes = [{ path: '', redirectTo: 'home', pathMatch: 'full' }];`,
  ]),
  "src/app/page-not-found-routing.module.ts": routingModule("PageNotFoundRoutingModule", "forChild", [
    `const routes: Routes = [{ path: '**', redirectTo: 'home' }];`,
  ]),
  "src/app/modules/login/login.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { LoginRoutingModule } from './login-routing.module';`,
    `@NgModule({ imports: [LoginRoutingModule] })`,
    `export class LoginModule {}`,
  ),
  "src/app/modules/login/login.component.ts": component("LoginComponent", "tb-login"),
  "src/app/modules/login/login-routing.module.ts": routingModule("LoginRoutingModule", "forChild", [
    `import { AuthGuard } from '../../core/auth.guard';`,
    `import { LoginComponent } from './login.component';`,
    `const routes: Routes = [`,
    `  { path: 'login', component: LoginComponent, canActivate: [AuthGuard], data: { title: 'login.login', module: 'public' } }`,
    `];`,
  ]),
  "src/app/modules/home/home.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { HomeRoutingModule } from './home-routing.module';`,
    `@NgModule({ imports: [HomeRoutingModule] })`,
    `export class HomeModule {}`,
  ),
  "src/app/modules/home/home.component.ts": component("HomeComponent", "tb-home"),
  "src/app/modules/home/home-routing.module.ts": routingModule("HomeRoutingModule", "forChild", [
    `import { AuthGuard } from '../../core/auth.guard';`,
    `import { HomeComponent } from './home.component';`,
    `const routes: Routes = [`,
    `  {`,
    `    path: '',`,
    `    component: HomeComponent,`,
    `    canActivate: [AuthGuard],`,
    `    loadChildren: () => import('./pages/home-pages.module').then(m => m.HomePagesModule)`,
    `  }`,
    `];`,
  ]),
  "src/app/modules/home/pages/home-pages.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { DeviceModule } from './device/device.module';`,
    `@NgModule({ exports: [DeviceModule] })`,
    `export class HomePagesModule {}`,
  ),
  "src/app/modules/home/pages/device/device.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { DeviceRoutingModule } from './device-routing.module';`,
    `@NgModule({ imports: [DeviceRoutingModule] })`,
    `export class DeviceModule {}`,
  ),
  "src/app/modules/home/pages/device/router-tabs.component.ts": component("RouterTabsComponent", "tb-router-tabs"),
  "src/app/modules/home/pages/device/devices-table.component.ts": component("DevicesTableComponent", "tb-devices-table"),
  "src/app/modules/home/pages/device/shared-groups.component.ts": component("SharedGroupsComponent", "tb-shared-groups"),
  "src/app/modules/home/pages/device/assets.component.ts": component("AssetsComponent", "tb-assets"),
  "src/app/modules/home/pages/device/images.component.ts": component("ImagesComponent", "tb-images"),
  "src/app/modules/home/pages/device/home-links.component.ts": component("HomeLinksComponent", "tb-home-links"),
  "src/app/modules/home/pages/device/rulechain-page.component.ts": component("RuleChainPageComponent", "tb-rulechain-page"),
  "src/app/modules/home/pages/device/rulechain-page.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `@NgModule({ declarations: [] })`,
    `export class RuleChainPageModule {}`,
  ),
  "src/app/modules/home/pages/device/device-routing.module.ts": routingModule("DeviceRoutingModule", "forChild", [
    `import { RouterTabsComponent } from './router-tabs.component';`,
    `import { DevicesTableComponent } from './devices-table.component';`,
    `import { SharedGroupsComponent } from './shared-groups.component';`,
    `import { AssetsComponent } from './assets.component';`,
    `import { ImagesComponent } from './images.component';`,
    `import { HomeLinksComponent } from './home-links.component';`,
    `import { RuleChainPageComponent } from './rulechain-page.component';`,
    `const sharedRoute: Route = { path: 'shared', component: SharedGroupsComponent };`,
    `export const devicesRoute = (root = false): Route => {`,
    `  const routeConfig: Route = {`,
    `    path: 'devices',`,
    `    component: RouterTabsComponent,`,
    `    data: { auth: ['TENANT_ADMIN', 'CUSTOMER_USER'] },`,
    `    children: [{ path: '', component: DevicesTableComponent }]`,
    `  };`,
    `  if (root) {`,
    `    routeConfig.children.push(sharedRoute);`,
    `  }`,
    `  return routeConfig;`,
    `};`,
    `const routes: Routes = [`,
    `  { path: 'home', component: HomeLinksComponent },`,
    `  devicesRoute(true),`,
    `  {`,
    `    path: 'entities',`,
    `    children: [`,
    `      { path: '', children: [], data: { auth: ['TENANT_ADMIN'], redirectTo: '/devices' } },`,
    `      { path: 'assets', component: AssetsComponent }`,
    `    ]`,
    `  },`,
    `  {`,
    `    path: 'resources',`,
    `    data: {`,
    `      auth: ['SYS_ADMIN', 'CUSTOMER_USER'],`,
    `      redirectTo: { SYS_ADMIN: '/resources/widgets-library', CUSTOMER_USER: '/resources/images' }`,
    `    },`,
    `    children: []`,
    `  },`,
    `  { path: 'resources/images', component: ImagesComponent },`,
    `  {`,
    `    path: 'ruleChains/:ruleChainId',`,
    `    component: RuleChainPageComponent,`,
    `    loadChildren: () => import('./rulechain-page.module').then(m => m.RuleChainPageModule)`,
    `  }`,
    `];`,
  ]),
} as const

const STREAMPIPES = {
  "package.json": manifest(),
  "src/main.ts": lines(
    `import { bootstrapApplication } from '@angular/platform-browser';`,
    `import { AppComponent } from './app/app.component';`,
    `import { appConfig } from './app/app.config';`,
    `bootstrapApplication(AppComponent, appConfig);`,
  ),
  "src/app/app.component.ts": component("AppComponent", "sp-root"),
  "src/app/app.config.ts": lines(
    `import { ApplicationConfig } from '@angular/core';`,
    `import { provideRouter } from '@angular/router';`,
    `import { routes } from './app.routes';`,
    `export const appConfig: ApplicationConfig = {`,
    `  providers: [provideRouter(routes)]`,
    `};`,
  ),
  "deployment/app.routes.mst": `export const routes = [{{#modules}}{{/modules}}];\n`,
} as const

const STREAMPIPES_SPREAD = {
  ...STREAMPIPES,
  "src/main.ts": lines(
    `import { provideZoneChangeDetection } from '@angular/core';`,
    `import { bootstrapApplication } from '@angular/platform-browser';`,
    `import { AppComponent } from './app/app.component';`,
    `import { appConfig } from './app/app.config';`,
    `bootstrapApplication(AppComponent, {`,
    `  ...appConfig,`,
    `  providers: [provideZoneChangeDetection(), ...appConfig.providers],`,
    `});`,
  ),
} as const

const ACTION = {
  "package.json": manifest({ rxjs: "^7.8.0" }),
  "src/main.ts": lines(
    `import { bootstrapApplication } from '@angular/platform-browser';`,
    `import { provideRouter } from '@angular/router';`,
    `import AppComponent from './app/app.component';`,
    `import { routes } from './app/app.routes';`,
    `bootstrapApplication(AppComponent, { providers: [provideRouter(routes)] });`,
  ),
  "src/app/app.component.ts": lines(
    `import { Component } from '@angular/core';`,
    `@Component({ selector: 'tb-root', template: '<router-outlet></router-outlet>' })`,
    `export default class AppComponent {}`,
  ),
  "src/app/action.guard.ts": lines(`export class ActionGuard {}`),
  "src/app/app.routes.ts": lines(
    `import { Routes } from '@angular/router';`,
    `import { of } from 'rxjs';`,
    `import { ActionGuard } from './action.guard';`,
    `export const routes: Routes = [`,
    `  { path: 'action/addonAccessRequest', loadComponent: () => of(null), canActivate: [ActionGuard] },`,
    `];`,
  ),
} as const

const HYBRID = {
  "package.json": manifest({ angular: "^1.8.0" }),
  "src/main.ts": lines(
    `import { bootstrapApplication } from '@angular/platform-browser';`,
    `import { provideRouter } from '@angular/router';`,
    `import { AppComponent } from './app/app.component';`,
    `import { HomeComponent } from './app/home.component';`,
    `bootstrapApplication(AppComponent, { providers: [provideRouter([{ path: '', component: HomeComponent }])] });`,
  ),
  "src/app/app.component.ts": component("AppComponent", "oppia-root"),
  "src/app/home.component.ts": component("HomeComponent", "oppia-home"),
} as const

const analyze = (files: Readonly<Record<string, string>>): PipelineResult =>
  run({ files, adapters: [createAngularAdapter()] })

const urlsOf = (result: PipelineResult): readonly string[] =>
  result.graph.screens.flatMap((screen) => (screen.url === null ? [] : [screen.url]))

const screenAt = (result: PipelineResult, url: string): Screen => {
  const found = result.graph.screens.find((screen) => screen.url === url)
  if (found === undefined) throw new Error(`no screen at ${url}`)
  return found
}

const ancestorNames = (screen: Screen): readonly string[] => screen.ancestors.map((ancestor) => ancestor.exportName)

const diagnosticsOf = (result: PipelineResult, code: string) =>
  result.diagnostics.filter((diagnostic) => diagnostic.code === code)

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

describe("detectAngular", () => {
  it("scores an @angular/router project with a provideRouter call as a data router", () => {
    const result = detectAngular(probe(PEERTUBE))
    expect(result.score).toBe(90)
    expect(result.evidence).toContainEqual({ what: "Angular router registration", file: "src/main.ts", line: 5 })
  })

  it("scores a RouterModule.forRoot project", () => {
    expect(detectAngular(probe(THINGSBOARD)).score).toBe(90)
  })

  it("scores an AngularJS-only project 0", () => {
    const files = {
      "package.json": JSON.stringify({ name: "fixture", dependencies: { angular: "^1.8.0", "@angular/router": "^20.0.0" } }),
      "src/app.ts": `RouterModule.forRoot(routes)\n`,
    }
    expect(detectAngular(probe(files))).toEqual({ score: 0, evidence: [] })
  })

  it("does not report an AngularJS hybrid for an AngularJS-only project", () => {
    const files = {
      "package.json": JSON.stringify({ name: "fixture", dependencies: { angular: "^1.8.0" } }),
      "src/app.ts": "export const x = 1\n",
    }
    expect(diagnosticsOf(analyze(files), "project/angularjs-hybrid")).toEqual([])
  })
})

describe("angular router: PeerTube shape (standalone, provideRouter)", () => {
  const result = analyze(PEERTUBE)

  it("maps the route tree under '/', skipping the matcher and the loop-pushed routes", () => {
    expect([...urlsOf(result)].sort()).toEqual(
      [
        "/*",
        "/about",
        "/admin",
        "/admin/config",
        "/admin/overview",
        "/admin/section/moderation",
        "/login",
      ].sort(),
    )
  })

  it("derives auth from LoginGuard, UnloggedGuard and the always-true MetaGuard", () => {
    expect(screenAt(result, "/admin/section/moderation").auth).toBe("protected")
    expect(screenAt(result, "/login").auth).toBe("public")
    expect(screenAt(result, "/about").auth).toBe("public")
  })

  it("nests layout ancestors with AppComponent outermost and router-outlet splices", () => {
    const moderation = screenAt(result, "/admin/section/moderation")
    expect(ancestorNames(moderation)).toEqual(["AppComponent", "AdminComponent", "AdminModerationComponent"])
    expect(moderation.ancestors.map((ancestor) => ancestor.splice)).toEqual([
      { kind: "outlet", tag: "router-outlet" },
      { kind: "outlet", tag: "router-outlet" },
      { kind: "outlet", tag: "router-outlet" },
    ])
    expect(ancestorNames(screenAt(result, "/login"))).toEqual(["AppComponent"])
  })

  it("merges canMatch siblings into one screen with both entries and no asserted auth", () => {
    const overview = screenAt(result, "/admin/overview")
    expect(overview.entries.map((entry) => (entry.kind === "file" ? entry.exportName : entry.kind)).sort()).toEqual([
      "LegacyOverviewComponent",
      "OverviewComponent",
    ])
    expect(overview.auth).toBe("unknown")
    expect(overview.provenance.evidence.map((entry) => entry.what)).toContainEqual(
      "matched only when canMatch allows it (LoginGuard)",
    )
  })

  it("follows literal redirects and keeps function redirects as evidence only", () => {
    expect(screenAt(result, "/admin").redirectTo).toBe("/admin/section/moderation")
    const config = screenAt(result, "/admin/config")
    expect(config.redirectTo).toBeNull()
    expect(config.provenance.evidence.map((entry) => entry.what)).toContainEqual(
      "redirectTo is a function; its target is decided at runtime",
    )
  })

  it("reports the matcher as unsupported and the for…of push as a dynamic registry", () => {
    const matcher = diagnosticsOf(result, "screens/unsupported-router-style")
    expect(matcher.map((diagnostic) => [diagnostic.severity, diagnostic.file])).toEqual([["info", "src/app/app.routes.ts"]])
    const dynamic = diagnosticsOf(result, "screens/dynamic-registry")
    expect(dynamic.map((diagnostic) => [diagnostic.severity, diagnostic.file, diagnostic.line])).toEqual([
      ["info", "src/app/app.routes.ts", 25],
    ])
  })
})

describe("angular router: thingsboard shape (NgModule closure)", () => {
  const result = analyze(THINGSBOARD)

  it("mounts forRoot and every forChild at the root and the lazy module under its route", () => {
    expect([...urlsOf(result)].sort()).toEqual(
      [
        "/",
        "/*",
        "/devices",
        "/devices/shared",
        "/entities/assets",
        "/home",
        "/login",
        "/resources/images",
        "/ruleChains/:ruleChainId",
      ].sort(),
    )
  })

  it("reads auth from AuthGuard and data.module = 'public'", () => {
    expect(screenAt(result, "/login").auth).toBe("public")
    expect(screenAt(result, "/devices").auth).toBe("protected")
    expect(screenAt(result, "/ruleChains/:ruleChainId").auth).toBe("protected")
  })

  it("puts HomeComponent between AppComponent and the feature layout", () => {
    expect(ancestorNames(screenAt(result, "/devices"))).toEqual(["AppComponent", "HomeComponent", "RouterTabsComponent"])
    expect(ancestorNames(screenAt(result, "/ruleChains/:ruleChainId"))).toEqual(["AppComponent", "HomeComponent"])
  })

  it("keeps route redirects on their screens", () => {
    expect(screenAt(result, "/").redirectTo).toBe("/home")
    expect(screenAt(result, "/*").redirectTo).toBe("/home")
  })

  it("turns data.redirectTo leaves into redirect rules, one per authority", () => {
    const fromData = result.graph.redirects.filter((redirect) => redirect.declaredAt?.includes("device-routing") === true)
    expect(fromData.map((redirect) => [redirect.from, redirect.to, redirect.condition ?? null])).toEqual([
      ["/entities", "/devices", null],
      ["/resources", "/resources/images", "authority = CUSTOMER_USER"],
      ["/resources", "/resources/widgets-library", "authority = SYS_ADMIN"],
    ])
    expect(fromData.every((redirect) => redirect.conditional === undefined)).toBe(true)
    expect(fromData[0]?.declaredAt).toBe("src/app/modules/home/pages/device/device-routing.module.ts:29")
  })
})

describe("angular router: diagnostics", () => {
  it("names the generated sibling of a missing routes import (StreamPipes)", () => {
    const missing = diagnosticsOf(analyze(STREAMPIPES), "screens/route-module-missing")
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({ severity: "warning", file: "src/app/app.config.ts", line: 5 })
    expect(missing[0]?.message).toContain("'./app.routes'")
    expect(missing[0]?.message).toContain("deployment/app.routes.mst")
  })

  it("reads provideRouter through a spread config's providers member", () => {
    const missing = diagnosticsOf(analyze(STREAMPIPES_SPREAD), "screens/route-module-missing")
    expect(missing.map((diagnostic) => [diagnostic.file, diagnostic.line])).toEqual([["src/app/app.config.ts", 5]])
    expect(missing[0]?.message).toContain("deployment/app.routes.mst")
  })

  it("maps a loadComponent that yields of(null) as an entryless screen, not an opaque entry", () => {
    const result = analyze(ACTION)
    const action = screenAt(result, "/action/addonAccessRequest")
    expect(action.entries).toEqual([])
    expect(action.provenance.evidence.map((entry) => entry.what)).toContainEqual(
      "loadComponent resolves to no component; the route renders nothing of its own and its guards decide the outcome",
    )
    expect(diagnosticsOf(result, "screens/opaque-entry")).toEqual([])
  })

  it("names a default-exported root component 'default' in the ancestor chain", () => {
    expect(ancestorNames(screenAt(analyze(ACTION), "/action/addonAccessRequest"))).toEqual(["default"])
  })

  it("reports an AngularJS hybrid and still maps the Angular routes", () => {
    const result = analyze(HYBRID)
    expect(diagnosticsOf(result, "project/angularjs-hybrid").map((diagnostic) => diagnostic.severity)).toEqual(["info"])
    expect(urlsOf(result)).toEqual(["/"])
  })

  it("does not report a hybrid for a plain Angular project", () => {
    expect(diagnosticsOf(analyze(PEERTUBE), "project/angularjs-hybrid")).toEqual([])
  })
})
