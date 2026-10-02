import { describe, expect, it } from "vitest"
import type { ClassRef, RouteSource } from "../../src/adapters/angular/project.js"
import { createAngularProject } from "../../src/adapters/angular/project.js"
import { discoverBench } from "./discover-harness.js"

const lines = (...rows: readonly string[]): string => [...rows, ""].join("\n")

const routingModule = (method: "forRoot" | "forChild", routes: string, extra = ""): string =>
  lines(
    `import { NgModule } from '@angular/core';`,
    `import { RouterModule, Routes } from '@angular/router';`,
    extra,
    `const routes: Routes = ${routes};`,
    `@NgModule({ imports: [RouterModule.${method}(routes)], exports: [RouterModule] })`,
  )

const THINGSBOARD = {
  "src/main.ts": lines(
    `import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';`,
    `import { AppModule } from './app/app.module';`,
    `platformBrowserDynamic().bootstrapModule(AppModule).catch((err) => console.error(err));`,
  ),
  "src/app/app.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { BrowserModule } from '@angular/platform-browser';`,
    `import { TranslateModule } from '@ngx-translate/core';`,
    `import { AppRoutingModule } from './app-routing.module';`,
    `import { CoreModule } from './core/core.module';`,
    `import { LoginModule } from './modules/login/login.module';`,
    `import { HomeModule } from './modules/home/home.module';`,
    `import { PageNotFoundRoutingModule } from './page-not-found-routing.module';`,
    `import { AppComponent } from './app.component';`,
    `@NgModule({`,
    `  declarations: [AppComponent],`,
    `  imports: [BrowserModule, AppRoutingModule, CoreModule, LoginModule, HomeModule, TranslateModule.forRoot(), PageNotFoundRoutingModule],`,
    `  bootstrap: [AppComponent]`,
    `})`,
    `export class AppModule {}`,
  ),
  "src/app/app.component.ts": lines(
    `import { Component } from '@angular/core';`,
    `@Component({ selector: 'tb-root', templateUrl: './app.component.html', standalone: false })`,
    `export class AppComponent {}`,
  ),
  "src/app/app-routing.module.ts": `${routingModule("forRoot", `[{ path: '', redirectTo: 'home', pathMatch: 'full' }]`)}export class AppRoutingModule {}\n`,
  "src/app/page-not-found-routing.module.ts": `${routingModule("forChild", `[{ path: '**', redirectTo: 'home' }]`)}export class PageNotFoundRoutingModule {}\n`,
  "src/app/core/core.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { StoreDevtoolsModule } from '@ngrx/store-devtools';`,
    `@NgModule({ imports: [StoreDevtoolsModule.instrument({ maxAge: 25 })] })`,
    `export class CoreModule {}`,
  ),
  "src/app/modules/login/login.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { LoginRoutingModule } from './login-routing.module';`,
    `@NgModule({ imports: [LoginRoutingModule] })`,
    `export class LoginModule {}`,
  ),
  "src/app/modules/login/login-routing.module.ts": `${routingModule("forChild", `[{ path: 'login' }]`)}export class LoginRoutingModule {}\n`,
  "src/app/modules/home/home.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { HomeRoutingModule } from './home-routing.module';`,
    `@NgModule({ imports: [HomeRoutingModule] })`,
    `export class HomeModule {}`,
  ),
  "src/app/modules/home/home-routing.module.ts": `${routingModule(
    "forChild",
    `[{ path: '', children: [{ path: '', loadChildren: () => import('./pages/home-pages.module').then((m) => m.HomePagesModule) }] }]`,
  )}export class HomeRoutingModule {}\n`,
  "src/app/modules/home/pages/home-pages.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { DeviceModule } from './device/device.module';`,
    `import { DashboardModule } from './dashboard/dashboard.module';`,
    `import { GroupModule } from './group/group.module';`,
    `@NgModule({ exports: [DeviceModule, DashboardModule, GroupModule, DeviceModule] })`,
    `export class HomePagesModule {}`,
  ),
  "src/app/modules/home/pages/device/device.module.ts": lines(
    `import { NgModule as Module } from '@angular/core';`,
    `import { DeviceRoutingModule } from './device-routing.module';`,
    `import { DeviceComponent } from './device.component';`,
    `const COMPONENTS = [DeviceComponent];`,
    `@Module({ declarations: [COMPONENTS], imports: [DeviceRoutingModule] })`,
    `export class DeviceModule {}`,
  ),
  "src/app/modules/home/pages/device/device-routing.module.ts": `${routingModule("forChild", `[{ path: 'devices' }]`)}export class DeviceRoutingModule {}\n`,
  "src/app/modules/home/pages/device/device.component.ts": lines(
    `import { Component as NgComponent } from '@angular/core';`,
    `@NgComponent({ selector: 'tb-device', template: '<div>{{ name }}</div>' })`,
    `export class DeviceComponent {}`,
  ),
  "src/app/modules/home/pages/dashboard/dashboard.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { DashboardRoutingModule } from './dashboard-routing.module';`,
    `@NgModule({ imports: [DashboardRoutingModule] })`,
    `export class DashboardModule {}`,
  ),
  "src/app/modules/home/pages/dashboard/dashboard-routing.module.ts": `${routingModule("forChild", `[{ path: 'dashboards' }]`)}export class DashboardRoutingModule {}\n`,
  "src/app/modules/home/pages/group/group.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { DashboardRoutingModule } from './dashboard-routing.module';`,
    `@NgModule({ imports: [DashboardRoutingModule] })`,
    `export class GroupModule {}`,
  ),
  "src/app/modules/home/pages/group/dashboard-routing.module.ts": `${routingModule("forChild", `[{ path: 'groupDashboards' }]`)}export class DashboardRoutingModule {}\n`,
} as const

const PEERTUBE_COMPONENT = lines(
  `import { Component } from '@angular/core';`,
  `import { HeaderComponent } from './header/header.component';`,
  `@Component({ selector: 'my-app', templateUrl: './app.component.html', imports: [HeaderComponent] })`,
  `export class AppComponent {}`,
)

const PEERTUBE_SHARED = {
  "src/app/app.component.ts": PEERTUBE_COMPONENT,
  "src/app/header/header.component.ts": lines(
    `import { Component } from '@angular/core';`,
    `@Component({ selector: 'my-header', template: '<nav></nav>' })`,
    `export class HeaderComponent {}`,
  ),
  "src/app/app.routes.ts": `export const routes = [{ path: 'home' }];\n`,
} as const

const PEERTUBE_INLINE = {
  ...PEERTUBE_SHARED,
  "src/main.ts": lines(
    `import { bootstrapApplication } from '@angular/platform-browser';`,
    `import { provideRouter, withPreloading } from '@angular/router';`,
    `import { AppComponent } from './app/app.component';`,
    `import { routes } from './app/app.routes';`,
    `import { PreloadSelectedModulesList } from './app/core';`,
    `bootstrapApplication(AppComponent, { providers: [provideHttpClient(), provideRouter(routes, withPreloading(PreloadSelectedModulesList))] });`,
  ),
} as const

const PEERTUBE_CONFIG = {
  ...PEERTUBE_SHARED,
  "src/app/app.config.ts": lines(
    `import { provideRouter } from '@angular/router';`,
    `import { routes } from './app.routes';`,
    `export const appConfig = { providers: [provideRouter(routes)] };`,
  ),
  "src/main.ts": lines(
    `import { bootstrapApplication } from '@angular/platform-browser';`,
    `import { AppComponent } from './app/app.component';`,
    `import { appConfig } from './app/app.config';`,
    `bootstrapApplication(AppComponent, appConfig);`,
  ),
  "package.json": JSON.stringify({ name: "peertube", dependencies: { "@angular/core": "^18.2.0" } }),
} as const

const ref = (file: string, name: string): ClassRef => ({ file, name })

const describeSource = (source: RouteSource): string =>
  `${source.kind} ${source.owner?.name ?? "-"} ${source.node.file} ${source.node.node.getText()}`

const tb = createAngularProject(discoverBench(THINGSBOARD).ctx)

const APP_MODULE = ref("src/app/app.module.ts", "AppModule")
const HOME_PAGES = ref("src/app/modules/home/pages/home-pages.module.ts", "HomePagesModule")
const DASHBOARD_ROUTING = ref("src/app/modules/home/pages/dashboard/dashboard-routing.module.ts", "DashboardRoutingModule")
const GROUP_ROUTING = ref("src/app/modules/home/pages/group/dashboard-routing.module.ts", "DashboardRoutingModule")

describe("adapters/angular/project — thingsboard shape", () => {
  it("finds the bootstrapModule root module and its bootstrap component", () => {
    const found = tb.bootstrap()

    expect(found?.kind).toBe("module")
    expect(found?.rootModule).toEqual(APP_MODULE)
    expect(found?.rootComponent).toEqual(ref("src/app/app.component.ts", "AppComponent"))
  })

  it("orders route sources depth-first over imports at their array position", () => {
    const walked = tb.routeModules(APP_MODULE)

    expect(walked.routes.map(describeSource)).toEqual([
      "forRoot AppRoutingModule src/app/app-routing.module.ts routes",
      "forChild LoginRoutingModule src/app/modules/login/login-routing.module.ts routes",
      "forChild HomeRoutingModule src/app/modules/home/home-routing.module.ts routes",
      "forChild PageNotFoundRoutingModule src/app/page-not-found-routing.module.ts routes",
    ])
    expect(walked.unreadable.map((item) => item.text)).toEqual(["StoreDevtoolsModule.instrument({ maxAge: 25 })"])
  })

  it("reaches forChild modules through an exports-only module and keeps duplicate class names distinct", () => {
    expect(tb.routeModules(HOME_PAGES).routes.map(describeSource)).toEqual([
      "forChild DeviceRoutingModule src/app/modules/home/pages/device/device-routing.module.ts routes",
      "forChild DashboardRoutingModule src/app/modules/home/pages/dashboard/dashboard-routing.module.ts routes",
      "forChild DashboardRoutingModule src/app/modules/home/pages/group/dashboard-routing.module.ts routes",
    ])
    expect(tb.ngModuleOf(DASHBOARD_ROUTING)?.routes[0]?.owner).toEqual(DASHBOARD_ROUTING)
    expect(tb.ngModuleOf(GROUP_ROUTING)?.routes[0]?.owner).toEqual(GROUP_ROUTING)
    expect(tb.classKey(DASHBOARD_ROUTING)).not.toBe(tb.classKey(GROUP_ROUTING))
  })

  it("reads NgModule metadata, skipping external modules and folding nested arrays", () => {
    const app = tb.ngModuleOf(APP_MODULE)
    const device = tb.ngModuleOf(ref("src/app/modules/home/pages/device/device.module.ts", "DeviceModule"))

    expect(app?.imports.map((item) => item.name)).toEqual([
      "AppRoutingModule",
      "CoreModule",
      "LoginModule",
      "HomeModule",
      "PageNotFoundRoutingModule",
    ])
    expect(app?.bootstrap).toEqual([ref("src/app/app.component.ts", "AppComponent")])
    expect(app?.unreadable).toEqual([])
    expect(device?.declarations).toEqual([ref("src/app/modules/home/pages/device/device.component.ts", "DeviceComponent")])
  })

  it("does not crash on StoreDevtoolsModule.instrument and reports it unreadable", () => {
    const core = tb.ngModuleOf(ref("src/app/core/core.module.ts", "CoreModule"))

    expect(core?.imports).toEqual([])
    expect(core?.unreadable).toHaveLength(1)
  })

  it("resolves decorator local names, including aliases and the bare fallback", () => {
    expect(tb.decoratorLocalName("src/app/modules/home/pages/device/device.module.ts", "NgModule")).toBe("Module")
    expect(tb.decoratorLocalName("src/app/modules/home/pages/device/device.component.ts", "Component")).toBe(
      "NgComponent",
    )
    expect(tb.decoratorLocalName("src/app/app.routes.ts", "Pipe")).toBe("Pipe")
  })

  it("reads component metadata with templateUrl, inline template and explicit standalone: false", () => {
    const app = tb.componentOf(ref("src/app/app.component.ts", "AppComponent"))
    const device = tb.componentOf(ref("src/app/modules/home/pages/device/device.component.ts", "DeviceComponent"))

    expect(app).toMatchObject({ selector: "tb-root", templateUrl: "./app.component.html", standalone: false })
    expect(app?.inlineTemplate).toBeNull()
    expect(device).toMatchObject({ selector: "tb-device", templateUrl: null, standalone: null, imports: [] })
    expect(device?.inlineTemplate?.node.getText()).toBe("'<div>{{ name }}</div>'")
    expect(tb.isStandalone(ref("src/app/app.component.ts", "AppComponent"), 20)).toBe(false)
  })

  it("indexes declaring modules by file then class name", () => {
    expect(tb.declaringModuleOf(ref("src/app/app.component.ts", "AppComponent"))).toEqual(APP_MODULE)
    expect(tb.declaringModuleOf(ref("src/app/modules/home/pages/device/device.component.ts", "DeviceComponent"))).toEqual(
      ref("src/app/modules/home/pages/device/device.module.ts", "DeviceModule"),
    )
    expect(tb.declaringModuleOf(ref("src/app/core/core.module.ts", "CoreModule"))).toBeNull()
  })
})

describe("adapters/angular/project — PeerTube shape", () => {
  const APP_COMPONENT = ref("src/app/app.component.ts", "AppComponent")

  it("reads provideRouter from inline bootstrapApplication providers", () => {
    const found = createAngularProject(discoverBench(PEERTUBE_INLINE).ctx).bootstrap()

    expect(found?.kind).toBe("standalone")
    expect(found?.rootComponent).toEqual(APP_COMPONENT)
    expect(found?.rootModule).toBeNull()
    expect(found?.routes.map(describeSource)).toEqual(["provideRouter - src/main.ts routes"])
  })

  it("follows an imported appConfig to its providers", () => {
    const found = createAngularProject(discoverBench(PEERTUBE_CONFIG).ctx).bootstrap()

    expect(found?.rootComponent).toEqual(APP_COMPONENT)
    expect(found?.routes.map(describeSource)).toEqual(["provideRouter - src/app/app.config.ts routes"])
  })

  it("reads standalone imports and defaults standalone from the project major", () => {
    const inline = createAngularProject(discoverBench(PEERTUBE_INLINE).ctx)
    const configured = createAngularProject(discoverBench(PEERTUBE_CONFIG).ctx)

    expect(inline.componentOf(APP_COMPONENT)?.imports).toEqual([
      ref("src/app/header/header.component.ts", "HeaderComponent"),
    ])
    expect(inline.projectMajor()).toBeNull()
    expect(inline.isStandalone(APP_COMPONENT)).toBe(true)
    expect(configured.projectMajor()).toBe(18)
    expect(configured.isStandalone(APP_COMPONENT)).toBe(false)
    expect(configured.isStandalone(APP_COMPONENT, 19)).toBe(true)
  })
})
