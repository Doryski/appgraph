import { tmpdir } from "node:os"
import ts from "typescript"
import { beforeAll, describe, expect, it } from "vitest"
import { createAngularProject } from "../../src/adapters/angular/project.js"
import { createAngularAdapter } from "../../src/adapters/angular/router.js"
import { createAngularTemplateProducer } from "../../src/adapters/angular/template.js"
import { createAngularTagResolver } from "../../src/adapters/angular/template-resolve.js"
import { resolveConfig } from "../../src/config/types.js"
import type { AngularCompiler } from "../../src/core/angular-compiler.js"
import { ANGULAR_TEMPLATE_FRAMEWORK } from "../../src/core/angular-compiler.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { TreeNode } from "../../src/core/model.js"
import type { TemplateCompilerSet } from "../../src/core/template-frameworks.js"
import { createDiscoverContext, createEnv } from "../../src/pipeline/context.js"
import type { PipelineResult } from "../../src/pipeline/run.js"
import { loadTemplateCompilers, templateApiOf } from "../../src/pipeline/template-frameworks.js"
import { ROOT, TSCONFIG, codes, run } from "../pipeline/harness.js"

const lines = (...rows: readonly string[]): string => [...rows, ""].join("\n")

const MANIFEST = JSON.stringify({
  name: "fixture",
  dependencies: {
    "@angular/core": "^20.0.0",
    "@angular/router": "^20.0.0",
    "@angular/platform-browser": "^20.0.0",
  },
})

const leaf = (name: string, selector: string, extra = ""): string =>
  lines(
    `import { Component } from '@angular/core';`,
    `@Component({ selector: '${selector}', template: '<p>${name}</p>'${extra} })`,
    `export class ${name} {}`,
  )

const FILES: Readonly<Record<string, string>> = {
  "package.json": MANIFEST,
  "src/main.ts": lines(
    `import { bootstrapApplication } from '@angular/platform-browser';`,
    `import { provideRouter } from '@angular/router';`,
    `import { AppComponent } from './app/app.component';`,
    `import { routes } from './app/app.routes';`,
    `bootstrapApplication(AppComponent, { providers: [provideRouter(routes)] });`,
  ),
  "src/app/app.component.ts": lines(
    `import { Component } from '@angular/core';`,
    `import { RouterOutlet } from '@angular/router';`,
    `@Component({ selector: 'app-root', imports: [RouterOutlet], template: '<router-outlet></router-outlet>' })`,
    `export class AppComponent {}`,
  ),
  "src/app/app.routes.ts": lines(
    `import { Routes } from '@angular/router';`,
    `import { HomeComponent } from './home/home.component';`,
    `import { FeatureComponent } from './feature/feature.component';`,
    `import { DupHostComponent } from './dup/dup-host.component';`,
    `export const routes: Routes = [`,
    `  { path: 'home', component: HomeComponent },`,
    `  { path: 'feature', component: FeatureComponent },`,
    `  { path: 'dup', component: DupHostComponent },`,
    `];`,
  ),
  "src/app/home/home.component.ts": lines(
    `import { Component } from '@angular/core';`,
    `import { ChildComponent } from './child.component';`,
    `import { GuardedComponent } from './guarded.component';`,
    `import { FooComponent } from './foo.component';`,
    `import DefaultChildComponent from './default-child.component';`,
    `import AliasedComponent from './aliased.component';`,
    `@Component({`,
    `  selector: 'app-home',`,
    `  imports: [ChildComponent, GuardedComponent, FooComponent, DefaultChildComponent, AliasedComponent],`,
    `  templateUrl: './home.component.html',`,
    `})`,
    `export class HomeComponent { show = true }`,
  ),
  "src/app/home/home.component.html": lines(
    `<app-child></app-child>`,
    `@if (show) {`,
    `  <app-guarded></app-guarded>`,
    `}`,
    `<mat-button></mat-button>`,
    `<unknown-tag></unknown-tag>`,
    `<div tbFoo></div>`,
    `<app-default-child></app-default-child>`,
    `<app-aliased></app-aliased>`,
  ),
  "src/app/home/default-child.component.ts": lines(
    `import { Component } from '@angular/core';`,
    `@Component({ selector: 'app-default-child', template: '<p>default</p>' })`,
    `export default class DefaultChildComponent {}`,
  ),
  "src/app/home/aliased.component.ts": lines(
    `import { Component } from '@angular/core';`,
    `@Component({ selector: 'app-aliased', template: '<p>aliased</p>' })`,
    `class AliasedComponent {}`,
    `export default AliasedComponent;`,
  ),
  "src/app/home/child.component.ts": leaf("ChildComponent", "app-child"),
  "src/app/home/guarded.component.ts": leaf("GuardedComponent", "app-guarded"),
  "src/app/home/foo.component.ts": leaf("FooComponent", "[tbFoo]"),
  "src/app/feature/feature.component.ts": lines(
    `import { Component } from '@angular/core';`,
    `@Component({ selector: 'app-feature', standalone: false, template: '<tb-breadcrumb></tb-breadcrumb>' })`,
    `export class FeatureComponent {}`,
  ),
  "src/app/feature/feature.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { FeatureComponent } from './feature.component';`,
    `import { HomeComponentsModule } from '../shared/home-components.module';`,
    `@NgModule({ declarations: [FeatureComponent], imports: [HomeComponentsModule] })`,
    `export class FeatureModule {}`,
  ),
  "src/app/shared/home-components.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { SharedModule } from './shared.module';`,
    `@NgModule({ imports: [SharedModule], exports: [SharedModule] })`,
    `export class HomeComponentsModule {}`,
  ),
  "src/app/shared/shared.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { BreadcrumbComponent } from './breadcrumb.component';`,
    `@NgModule({ declarations: [BreadcrumbComponent], exports: [BreadcrumbComponent] })`,
    `export class SharedModule {}`,
  ),
  "src/app/shared/breadcrumb.component.ts": leaf("BreadcrumbComponent", "tb-breadcrumb", ", standalone: false"),
  "src/app/dup/dup-host.component.ts": lines(
    `import { Component } from '@angular/core';`,
    `import { pickImports } from '@acme/imports';`,
    `@Component({ selector: 'app-dup', imports: pickImports(), template: '<tb-dup></tb-dup><tb-solo></tb-solo>' })`,
    `export class DupHostComponent {}`,
  ),
  "src/app/dup/first.component.ts": leaf("FirstDupComponent", "tb-dup"),
  "src/app/dup/second.component.ts": leaf("SecondDupComponent", "tb-dup"),
  "src/app/dup/solo.component.ts": leaf("SoloComponent", "tb-solo"),
}

const loadCompiler = async (): Promise<AngularCompiler> => {
  const set = await loadTemplateCompilers({
    root: tmpdir(),
    host: createMemoryHost({ files: {} }),
    dependencies: new Set(["@angular/core"]),
    files: [],
    frameworks: [ANGULAR_TEMPLATE_FRAMEWORK],
  })
  const compiler = templateApiOf(set.apis, ANGULAR_TEMPLATE_FRAMEWORK)
  if (compiler === null) throw new Error("expected the @angular/compiler devDependency")
  return compiler
}

const compilerSet = (compiler: AngularCompiler): TemplateCompilerSet => ({ apis: { angular: compiler }, statuses: [], diagnostics: [] })

type EdgeRow = readonly [file: string, conditions: readonly string[]]

const rowsOf = (nodes: readonly TreeNode[]): readonly EdgeRow[] =>
  nodes.flatMap((node) => [[node.file, node.conditions] as const, ...rowsOf(node.children)])

const screenRows = (result: PipelineResult, url: string): readonly EdgeRow[] =>
  rowsOf(result.graph.screens.find((screen) => screen.url === url)?.tree ?? [])

const resolverFixture = (compiler: AngularCompiler) => {
  const files: Readonly<Record<string, string>> = { ...FILES, "tsconfig.json": TSCONFIG }
  const env = createEnv({
    ts,
    config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }),
    host: createMemoryHost({ files: Object.fromEntries(Object.entries(files).map(([file, text]) => [`${ROOT}/${file}`, text])) }),
  })
  const ctx = createDiscoverContext({ env, plugin: "angular" })
  const resolve = createAngularTagResolver(createAngularProject(ctx), ctx)
  const producer = createAngularTemplateProducer({ api: compiler, env: { readFile: (file) => files[file] ?? null, ts }, projectMajor: 20 })
  return (file: string, tag: string) => {
    const doc = producer.docsOf(file)[0]
    const element = doc?.elements.find((candidate) => candidate.tag === tag)
    return doc === undefined || element === undefined ? undefined : resolve(doc, element)
  }
}

describe("Angular selector tag resolution", () => {
  let compiler: AngularCompiler

  beforeAll(async () => {
    compiler = await loadCompiler()
  })

  const runFixture = () => run({ files: FILES, adapters: [createAngularAdapter()], templates: compilerSet(compiler) })

  it("draws in-scope edges for a standalone component, guarded by @if, and for attribute selectors", () => {
    expect(screenRows(runFixture(), "/home")).toEqual([
      ["src/app/app.component.ts", []],
      ["src/app/home/home.component.ts", []],
      ["src/app/home/aliased.component.ts", []],
      ["src/app/home/child.component.ts", []],
      ["src/app/home/default-child.component.ts", []],
      ["src/app/home/foo.component.ts", []],
      ["src/app/home/guarded.component.ts", ["show"]],
    ])
  })

  it("follows the NgModule export chain to the declaring SharedModule", () => {
    expect(screenRows(runFixture(), "/feature")).toEqual([
      ["src/app/app.component.ts", []],
      ["src/app/feature/feature.component.ts", []],
      ["src/app/shared/breadcrumb.component.ts", []],
    ])
  })

  it("draws no edge for a duplicate selector and reports the ambiguity", () => {
    const result = runFixture()
    expect(screenRows(result, "/dup")).toEqual([
      ["src/app/app.component.ts", []],
      ["src/app/dup/dup-host.component.ts", []],
      ["src/app/dup/solo.component.ts", []],
    ])
    expect(codes(result)).toContain("facts/ambiguous-component-name")
  })

  it("names the matching rule in the resolution", () => {
    const resolveIn = resolverFixture(compiler)
    expect(resolveIn("src/app/home/home.component.ts", "app-child")).toEqual({
      kind: "file",
      file: "src/app/home/child.component.ts",
      exportName: "ChildComponent",
      via: "selector",
    })
    expect(resolveIn("src/app/home/home.component.ts", "div")).toEqual({
      kind: "file",
      file: "src/app/home/foo.component.ts",
      exportName: "FooComponent",
      via: "selector",
    })
    expect(resolveIn("src/app/feature/feature.component.ts", "tb-breadcrumb")).toEqual({
      kind: "file",
      file: "src/app/shared/breadcrumb.component.ts",
      exportName: "BreadcrumbComponent",
      via: "selector",
    })
    expect(resolveIn("src/app/dup/dup-host.component.ts", "tb-solo")).toEqual({
      kind: "file",
      file: "src/app/dup/solo.component.ts",
      exportName: "SoloComponent",
      via: "selector-global",
    })
    expect(resolveIn("src/app/dup/dup-host.component.ts", "tb-dup")).toEqual({
      kind: "ambiguous",
      files: ["src/app/dup/first.component.ts", "src/app/dup/second.component.ts"],
    })
    expect(resolveIn("src/app/home/home.component.ts", "app-default-child")).toEqual({
      kind: "file",
      file: "src/app/home/default-child.component.ts",
      exportName: "default",
      via: "selector",
    })
    expect(resolveIn("src/app/home/home.component.ts", "app-aliased")).toEqual({
      kind: "file",
      file: "src/app/home/aliased.component.ts",
      exportName: "default",
      via: "selector",
    })
    expect(resolveIn("src/app/home/home.component.ts", "mat-button")).toBeNull()
    expect(resolveIn("src/app/home/home.component.ts", "unknown-tag")).toBeNull()
  })
})

const SAME_FILE_FILES: Readonly<Record<string, string>> = {
  "package.json": MANIFEST,
  "src/main.ts": FILES["src/main.ts"] ?? "",
  "src/app/app.component.ts": FILES["src/app/app.component.ts"] ?? "",
  "src/app/app.routes.ts": lines(
    `import { Routes } from '@angular/router';`,
    `import { UsersLayoutComponent, UserDetailComponent } from './users/users.component';`,
    `export const routes: Routes = [`,
    `  { path: 'users', component: UsersLayoutComponent, children: [{ path: ':id', component: UserDetailComponent }] },`,
    `];`,
  ),
  "src/app/users/users.component.ts": lines(
    `import { Component } from '@angular/core';`,
    `@Component({ selector: 'app-users-layout', standalone: false, template: '<app-banner></app-banner><router-outlet></router-outlet>' })`,
    `export class UsersLayoutComponent {}`,
    `@Component({ selector: 'app-user-detail', standalone: false, template: '<app-card></app-card>' })`,
    `export class UserDetailComponent {}`,
  ),
  "src/app/users/users.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { RouterModule } from '@angular/router';`,
    `import { BannerComponent } from './banner.component';`,
    `import { CardComponent } from './card.component';`,
    `import { UsersLayoutComponent, UserDetailComponent } from './users.component';`,
    `@NgModule({ imports: [RouterModule], declarations: [UsersLayoutComponent, UserDetailComponent, BannerComponent, CardComponent] })`,
    `export class UsersModule {}`,
  ),
  "src/app/users/banner.component.ts": leaf("BannerComponent", "app-banner", ", standalone: false"),
  "src/app/users/card.component.ts": leaf("CardComponent", "app-card", ", standalone: false"),
}

type ShapeRow = readonly [depth: number, component: string, repeat: boolean]

const shapeRowsOf = (nodes: readonly TreeNode[], depth = 0): readonly ShapeRow[] =>
  nodes.flatMap((node) => [[depth, node.component, node.repeat] as const, ...shapeRowsOf(node.children, depth + 1)])

describe("two routed Angular components declared in one file", () => {
  let compiler: AngularCompiler

  beforeAll(async () => {
    compiler = await loadCompiler()
  })

  it("gives each class its own node, named by the class, with the edges its own template draws", () => {
    const result = run({ files: SAME_FILE_FILES, adapters: [createAngularAdapter()], templates: compilerSet(compiler) })
    const tree = result.graph.screens.find((screen) => screen.url === "/users/:id")?.tree ?? []
    expect(shapeRowsOf(tree)).toEqual([
      [0, "AppComponent", false],
      [1, "UsersLayoutComponent", false],
      [2, "BannerComponent", false],
      [2, "UserDetailComponent", false],
      [3, "CardComponent", false],
    ])
    expect(codes(result)).not.toContain("walk/no-splice-point")
  })
})

const ROUTED_PLUS_HELPER_FILES: Readonly<Record<string, string>> = {
  "package.json": MANIFEST,
  "src/main.ts": FILES["src/main.ts"] ?? "",
  "src/app/app.component.ts": FILES["src/app/app.component.ts"] ?? "",
  "src/app/app.routes.ts": lines(
    `import { Routes } from '@angular/router';`,
    `import { PageOne } from './pages.component';`,
    `export const routes: Routes = [{ path: 'one', component: PageOne }];`,
  ),
  "src/app/pages.component.ts": lines(
    `import { Component } from '@angular/core';`,
    `import { AComponent } from './a.component';`,
    `import { BComponent } from './b.component';`,
    `@Component({ selector: 'page-one', standalone: true, imports: [AComponent], template: '<app-a></app-a>' })`,
    `export class PageOne {}`,
    `@Component({ selector: 'page-helper', standalone: true, imports: [BComponent], template: '<app-b></app-b>' })`,
    `export class HelperComponent {}`,
  ),
  "src/app/a.component.ts": leaf("AComponent", "app-a", ", standalone: true"),
  "src/app/b.component.ts": leaf("BComponent", "app-b", ", standalone: true"),
}

describe("a routed Angular component sharing its file with a non-routed one", () => {
  let compiler: AngularCompiler

  beforeAll(async () => {
    compiler = await loadCompiler()
  })

  it("gives the routed class its own node, named by the class, without the helper's render edges", () => {
    const result = run({ files: ROUTED_PLUS_HELPER_FILES, adapters: [createAngularAdapter()], templates: compilerSet(compiler) })
    const tree = result.graph.screens.find((screen) => screen.url === "/one")?.tree ?? []
    expect(shapeRowsOf(tree)).toEqual([
      [0, "AppComponent", false],
      [1, "PageOne", false],
      [2, "AComponent", false],
    ])
  })
})
