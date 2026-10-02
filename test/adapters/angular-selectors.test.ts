import { describe, expect, it } from "vitest"
import type { ClassRef } from "../../src/adapters/angular/project.js"
import { createAngularProject } from "../../src/adapters/angular/project.js"
import { createSelectorIndex, parseSelector } from "../../src/adapters/angular/selectors.js"
import { discoverBench } from "./discover-harness.js"

const lines = (...rows: readonly string[]): string => [...rows, ""].join("\n")

const indexOf = (files: Readonly<Record<string, string>>) => {
  const { ctx } = discoverBench(files)
  return createSelectorIndex(createAngularProject(ctx), ctx)
}

const names = (refs: readonly ClassRef[] | null): readonly string[] | null =>
  refs === null ? null : refs.map((ref) => ref.name)

const component = (name: string, selector: string, extra = ""): string =>
  lines(
    `import { Component } from '@angular/core';`,
    `@Component({ selector: '${selector}', template: '' ${extra} })`,
    `export class ${name} {}`,
  )

const declared = (name: string, selector: string): string => component(name, selector, ", standalone: false")

const STANDALONE = {
  "src/app/card.component.ts": component("CardComponent", "app-card"),
  "src/app/widgets/widget.component.ts": declared("WidgetComponent", "app-widget"),
  "src/app/widgets/hidden.component.ts": declared("HiddenComponent", "app-hidden"),
  "src/app/widgets/widgets.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { CommonModule } from '@angular/common';`,
    `import { WidgetComponent } from './widget.component';`,
    `import { HiddenComponent } from './hidden.component';`,
    `@NgModule({ declarations: [WidgetComponent, HiddenComponent], imports: [CommonModule], exports: [WidgetComponent] })`,
    `export class WidgetsModule {}`,
  ),
  "src/app/page.component.ts": lines(
    `import { Component } from '@angular/core';`,
    `import { MatButtonModule } from '@angular/material/button';`,
    `import { CardComponent } from './card.component';`,
    `import { WidgetsModule } from './widgets/widgets.module';`,
    `@Component({ selector: 'app-page', template: '', imports: [CardComponent, WidgetsModule, MatButtonModule] })`,
    `export class PageComponent {}`,
  ),
  "src/app/dynamic.component.ts": lines(
    `import { Component } from '@angular/core';`,
    `import { pickImports } from './pick';`,
    `@Component({ selector: 'app-dynamic', template: '', imports: pickImports() })`,
    `export class DynamicComponent {}`,
  ),
}

const THINGSBOARD = {
  "src/app/shared/components/breadcrumb.component.ts": declared("BreadcrumbComponent", "tb-breadcrumb"),
  "src/app/shared/components/help-popup.directive.ts": lines(
    `import { Directive } from '@angular/core';`,
    `@Directive({ selector: '[tb-help-popup], tb-help-popup-host', standalone: false })`,
    `export class HelpPopupDirective {}`,
  ),
  "src/app/shared/shared.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { MatButtonModule } from '@angular/material/button';`,
    `import { BreadcrumbComponent } from './components/breadcrumb.component';`,
    `import { HelpPopupDirective } from './components/help-popup.directive';`,
    `@NgModule({`,
    `  declarations: [BreadcrumbComponent, HelpPopupDirective],`,
    `  imports: [MatButtonModule],`,
    `  exports: [MatButtonModule, BreadcrumbComponent, HelpPopupDirective]`,
    `})`,
    `export class SharedModule {}`,
  ),
  "src/app/modules/home/components/x.component.ts": declared("XComponent", "tb-x"),
  "src/app/modules/home/components/home-components.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { SharedModule } from '../../../shared/shared.module';`,
    `import { XComponent } from './x.component';`,
    `@NgModule({ declarations: [XComponent], imports: [SharedModule], exports: [XComponent, SharedModule] })`,
    `export class HomeComponentsModule {}`,
  ),
  "src/app/modules/home/pages/feature/feature.component.ts": declared("FeatureComponent", "tb-feature"),
  "src/app/modules/home/pages/feature/feature.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { HomeComponentsModule } from '../../components/home-components.module';`,
    `import { FeatureComponent } from './feature.component';`,
    `@NgModule({ declarations: [FeatureComponent], imports: [HomeComponentsModule] })`,
    `export class FeatureModule {}`,
  ),
  "src/app/orphan.component.ts": declared("OrphanComponent", "tb-orphan"),
}

const DUPLICATES = {
  "src/app/a/title.component.ts": component("TitleComponent", "app-title"),
  "src/app/b/title.component.ts": component("TitleComponent", "app-title"),
  "src/app/b/other-title.component.ts": component("OtherTitleComponent", "app-title"),
  "src/app/button.directive.ts": lines(
    `import { Directive as Dir } from '@angular/core';`,
    `const SELECTOR = 'button[mat-button]';`,
    `@Dir({ selector: 'button[mat-button], a[mat-button]' })`,
    `export class ButtonDirective {}`,
    `@Dir({ selector: SELECTOR })`,
    `export class ComputedDirective {}`,
  ),
}

const CYCLE = {
  "src/app/a/a.component.ts": declared("AComponent", "app-a"),
  "src/app/b/b.component.ts": declared("BComponent", "app-b"),
  "src/app/a/a.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { BModule } from '../b/b.module';`,
    `import { AComponent } from './a.component';`,
    `@NgModule({ declarations: [AComponent], imports: [BModule], exports: [AComponent, BModule] })`,
    `export class AModule {}`,
  ),
  "src/app/b/b.module.ts": lines(
    `import { NgModule } from '@angular/core';`,
    `import { AModule } from '../a/a.module';`,
    `import { BComponent } from './b.component';`,
    `@NgModule({ declarations: [BComponent], imports: [AModule], exports: [BComponent, AModule] })`,
    `export class BModule {}`,
  ),
}

describe("selector entries", () => {
  it("indexes components and directives with literal selectors, ordered by file then class", () => {
    const index = indexOf(DUPLICATES)
    expect(index.entries.map((entry) => [entry.ref.file, entry.ref.name, entry.kind, entry.selector])).toEqual([
      ["src/app/a/title.component.ts", "TitleComponent", "component", "app-title"],
      ["src/app/b/other-title.component.ts", "OtherTitleComponent", "component", "app-title"],
      ["src/app/b/title.component.ts", "TitleComponent", "component", "app-title"],
      ["src/app/button.directive.ts", "ButtonDirective", "directive", "button[mat-button], a[mat-button]"],
    ])
  })

  it("parses comma alternatives with attribute selectors", () => {
    expect(parseSelector("[tb-help-popup], tb-x")).toEqual([
      { element: null, attributes: ["tb-help-popup"], classes: [] },
      { element: "tb-x", attributes: [], classes: [] },
    ])
    expect(parseSelector("button[mat-button]")).toEqual([{ element: "button", attributes: ["mat-button"], classes: [] }])
    expect(parseSelector("input[type=text].wide:not([readonly])")).toEqual([
      { element: "input", attributes: ["type"], classes: ["wide"] },
    ])
  })
})

describe("globalMatches", () => {
  it("returns every class sharing a duplicate selector", () => {
    const matches = indexOf(DUPLICATES).globalMatches("app-title", [])
    expect(matches.map((entry) => entry.ref.file)).toEqual([
      "src/app/a/title.component.ts",
      "src/app/b/other-title.component.ts",
      "src/app/b/title.component.ts",
    ])
  })

  it("requires the element and every attribute, case-sensitively", () => {
    const index = indexOf(DUPLICATES)
    expect(index.globalMatches("button", ["mat-button"]).map((entry) => entry.ref.name)).toEqual(["ButtonDirective"])
    expect(index.globalMatches("a", ["mat-button", "href"]).map((entry) => entry.ref.name)).toEqual([
      "ButtonDirective",
    ])
    expect(index.globalMatches("button", [])).toEqual([])
    expect(index.globalMatches("div", ["mat-button"])).toEqual([])
    expect(index.globalMatches("button", ["Mat-Button"])).toEqual([])
  })

  it("matches attribute-only alternatives on any element", () => {
    const index = indexOf(THINGSBOARD)
    expect(index.globalMatches("span", ["tb-help-popup"]).map((entry) => entry.ref.name)).toEqual([
      "HelpPopupDirective",
    ])
    expect(index.globalMatches("tb-help-popup-host", []).map((entry) => entry.ref.name)).toEqual([
      "HelpPopupDirective",
    ])
    expect(index.globalMatches("tb-unknown", [])).toEqual([])
  })
})

describe("scopeOf", () => {
  it("scopes a standalone component to its imports and the exports of imported NgModules", () => {
    const index = indexOf(STANDALONE)
    expect(names(index.scopeOf({ file: "src/app/page.component.ts", name: "PageComponent" }))).toEqual([
      "CardComponent",
      "WidgetComponent",
    ])
  })

  it("gives null for a non-literal standalone imports list", () => {
    const index = indexOf(STANDALONE)
    expect(index.scopeOf({ file: "src/app/dynamic.component.ts", name: "DynamicComponent" })).toBeNull()
  })

  it("follows the thingsboard re-export chain to SharedModule", () => {
    const index = indexOf(THINGSBOARD)
    const scope = index.scopeOf({ file: "src/app/modules/home/pages/feature/feature.component.ts", name: "FeatureComponent" })
    expect(names(scope)).toEqual(["XComponent", "FeatureComponent", "BreadcrumbComponent", "HelpPopupDirective"])
    expect(scope?.map((ref) => ref.file)).toEqual([
      "src/app/modules/home/components/x.component.ts",
      "src/app/modules/home/pages/feature/feature.component.ts",
      "src/app/shared/components/breadcrumb.component.ts",
      "src/app/shared/components/help-popup.directive.ts",
    ])
  })

  it("scopes a declared component to its module's declarations plus imported exports", () => {
    const index = indexOf(THINGSBOARD)
    expect(
      names(index.scopeOf({ file: "src/app/modules/home/components/x.component.ts", name: "XComponent" })),
    ).toEqual(["XComponent", "BreadcrumbComponent", "HelpPopupDirective"])
    expect(
      names(index.scopeOf({ file: "src/app/shared/components/breadcrumb.component.ts", name: "BreadcrumbComponent" })),
    ).toEqual(["BreadcrumbComponent", "HelpPopupDirective"])
  })

  it("gives null for a declared component without a declaring module", () => {
    const index = indexOf(THINGSBOARD)
    expect(index.scopeOf({ file: "src/app/orphan.component.ts", name: "OrphanComponent" })).toBeNull()
  })

  it("memoises module export scopes", () => {
    const index = indexOf(THINGSBOARD)
    const module = { file: "src/app/modules/home/components/home-components.module.ts", name: "HomeComponentsModule" }
    expect(index.exportedScopeOf(module)).toBe(index.exportedScopeOf(module))
    expect(names(index.exportedScopeOf(module))).toEqual(["XComponent", "BreadcrumbComponent", "HelpPopupDirective"])
  })

  it("terminates on modules that export each other", () => {
    const index = indexOf(CYCLE)
    expect(names(index.scopeOf({ file: "src/app/a/a.component.ts", name: "AComponent" }))).toEqual([
      "AComponent",
      "BComponent",
    ])
    expect(names(index.exportedScopeOf({ file: "src/app/b/b.module.ts", name: "BModule" }))).toEqual([
      "AComponent",
      "BComponent",
    ])
  })
})
