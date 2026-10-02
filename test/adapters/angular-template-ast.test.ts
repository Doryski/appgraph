import { tmpdir } from "node:os"
import { beforeAll, describe, expect, it } from "vitest"
import type { AngularTemplateContent } from "../../src/adapters/angular/template-ast.js"
import { angularTemplateContentOf } from "../../src/adapters/angular/template-ast.js"
import type { AngularCompiler } from "../../src/core/angular-compiler.js"
import { ANGULAR_TEMPLATE_FRAMEWORK } from "../../src/core/angular-compiler.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { TemplateElement } from "../../src/core/template-doc.js"
import { loadTemplateCompilers, templateApiOf } from "../../src/pipeline/template-frameworks.js"

let compiler: AngularCompiler

beforeAll(async () => {
  const set = await loadTemplateCompilers({
    root: tmpdir(),
    host: createMemoryHost({ files: {} }),
    dependencies: new Set(["@angular/core"]),
    files: [],
    frameworks: [ANGULAR_TEMPLATE_FRAMEWORK],
  })
  const loaded = templateApiOf(set.apis, ANGULAR_TEMPLATE_FRAMEWORK)
  if (loaded === null) throw new Error("expected the @angular/compiler devDependency")
  compiler = loaded
})

const parse = (text: string, projectMajor: number | null = 22): AngularTemplateContent =>
  angularTemplateContentOf(compiler, { text, url: "a.component.html", base: 0, firstLine: 1 }, projectMajor)

const guardsOf = (content: AngularTemplateContent) =>
  content.elements.map((element) => [element.tag, element.guard.condition, element.guard.repeated, element.guard.lazy])

const elementNamed = (content: AngularTemplateContent, tag: string): TemplateElement => {
  const found = content.elements.find((element) => element.tag === tag)
  if (found === undefined) throw new Error(`expected <${tag}>`)
  return found
}

describe("angularTemplateContentOf — guards", () => {
  it("phrases an @if / @else if / @else chain like Vue's", () => {
    const content = parse("@if (a) {<x-a></x-a>} @else if (b) {<x-b></x-b>} @else {<x-c></x-c>}")

    expect(guardsOf(content)).toEqual([
      ["x-a", "a", false, false],
      ["x-b", "!(a) && b", false, false],
      ["x-c", "!(a) && !(b)", false, false],
    ])
    expect(content.failed).toBe(false)
  })

  it("guards *ngIf hosts and negates the else template resolved by reference", () => {
    const content = parse(
      '<div *ngIf="user; else anon"><x-profile></x-profile></div><ng-template #anon><x-login></x-login></ng-template>',
    )

    expect(guardsOf(content)).toEqual([
      ["div", "user", false, false],
      ["x-profile", "user", false, false],
      ["ng-template", "!(user)", false, false],
      ["x-login", "!(user)", false, false],
    ])
    expect(elementNamed(content, "div").attributes.map((attribute) => [attribute.name, attribute.kind, attribute.expression])).toEqual([
      ["ngIf", "structural", "user"],
      ["ngIfElse", "structural", "anon"],
    ])
    expect(elementNamed(content, "ng-template").kind).toBe("fragment")
  })

  it("marks @for and *ngFor content repeated, outermost guard first", () => {
    const content = parse(
      '@if (ready) {@for (item of items; track item.id) {<x-row></x-row>} @empty {<x-none></x-none>}}<li *ngFor="let i of list">{{ i }}</li>',
    )

    expect(guardsOf(content)).toEqual([
      ["x-row", "ready", true, false],
      ["x-none", "ready", false, false],
      ["li", null, true, false],
    ])
  })

  it("turns @switch cases into equality conditions and @default into their negation", () => {
    const content = parse("@switch (mode) { @case ('a') {<x-a></x-a>} @case ('b') {<x-b></x-b>} @default {<x-d></x-d>} }")

    expect(guardsOf(content)).toEqual([
      ["x-a", "mode === 'a'", false, false],
      ["x-b", "mode === 'b'", false, false],
      ["x-d", "!(mode === 'a') && !(mode === 'b')", false, false],
    ])
  })

  it("marks @defer content and its sub-blocks lazy, and ignores @let", () => {
    const content = parse(
      "@let total = 1;@defer (on viewport) {<x-chart></x-chart>} @placeholder {<x-ph></x-ph>} @loading {<x-ld></x-ld>} @error {<x-er></x-er>}",
    )

    expect(guardsOf(content)).toEqual([
      ["x-chart", null, false, true],
      ["x-ph", null, false, true],
      ["x-ld", null, false, true],
      ["x-er", null, false, true],
    ])
  })
})

describe("angularTemplateContentOf — elements, attributes and expressions", () => {
  it("normalises static, bound, attr. and event attributes", () => {
    const text = '<a [routerLink]="[\'/x\', id]" routerLink="/y" [attr.data-testid]="tid" (click)="go($event)">go</a>'
    const content = parse(text)
    const anchor = elementNamed(content, "a")

    expect(anchor.attributes.map((attribute) => [attribute.name, attribute.kind, attribute.static, attribute.expression])).toEqual([
      ["routerLink", "bound", null, "['/x', id]"],
      ["routerLink", "static", "/y", null],
      ["data-testid", "bound", null, "tid"],
      ["click", "event", null, "go($event)"],
    ])
    expect(content.expressions.map((expression) => [expression.origin, expression.text])).toEqual([
      ["attribute", "['/x', id]"],
      ["attribute", "tid"],
      ["event", "go($event)"],
    ])
    expect(anchor.kind).toBe("element")
    expect(anchor.attributes[3]?.pos).toBe(text.indexOf("(click)"))
  })

  it("collects pipes of interpolations and bindings", () => {
    const text = "<p>\n  {{ 'home.title' | translate }} and {{ when | date: 'short' | uppercase }}\n</p><x-a [label]=\"'k' | translate\"></x-a>"
    const content = parse(text)

    expect(content.expressions.map((expression) => [expression.origin, expression.text, expression.pipes, expression.line])).toEqual([
      ["interpolation", "'home.title' | translate", ["translate"], 2],
      ["interpolation", "when | date: 'short' | uppercase", ["date", "uppercase"], 2],
      ["attribute", "'k' | translate", ["translate"], 3],
    ])
    expect(content.expressions[0]?.pos).toBe(text.indexOf("'home.title'"))
  })

  it("maps ng-content select to the slot name and classifies tags", () => {
    const content = parse(
      '<ng-content select="[x]"></ng-content><ng-content></ng-content><ng-container></ng-container><router-outlet></router-outlet><Widget></Widget><svg><path d="M0"></path></svg>',
    )

    expect(content.elements.map((element) => [element.tag, element.kind, element.slotName, element.names])).toEqual([
      ["ng-content", "slot", "[x]", ["ng-content", "NgContent"]],
      ["ng-content", "slot", "default", ["ng-content", "NgContent"]],
      ["ng-container", "fragment", null, ["ng-container", "NgContainer"]],
      ["router-outlet", "component", null, ["router-outlet", "RouterOutlet"]],
      ["Widget", "component", null, ["Widget"]],
      ["svg", "element", null, ["svg", "Svg"]],
      ["path", "element", null, ["path", "Path"]],
    ])
  })

  it("offsets positions and lines for an inline template", () => {
    const content = angularTemplateContentOf(compiler, { text: "\n  <x-a></x-a>", url: "a.ts", base: 100, firstLine: 7 }, 22)

    expect(content.elements.map((element) => [element.tag, element.pos, element.line])).toEqual([["x-a", 103, 8]])
  })

  it("restores i18n and i18n-<attr> markers the compiler strips, but not on nested placeholders", () => {
    const content = parse('<h1 i18n="site|Header@@title" title="Hi" i18n-title>Hello <b>you</b></h1><ng-template i18n>x</ng-template><p>plain</p>')
    const staticsOf = (tag: string) =>
      elementNamed(content, tag).attributes.map((attribute) => [attribute.name, attribute.kind, attribute.static])

    expect(staticsOf("h1")).toEqual([
      ["i18n", "static", "site|Header@@title"],
      ["i18n-title", "static", ""],
      ["title", "static", "Hi"],
    ])
    expect(staticsOf("b")).toEqual([])
    expect(staticsOf("ng-template")).toEqual([["i18n", "static", ""]])
    expect(staticsOf("p")).toEqual([])
  })
})

describe("angularTemplateContentOf — project major and errors", () => {
  it("parses literal @ text without block syntax for an Angular 16 project", () => {
    const content = parse("<p>Write to support@example.com @if you can</p><x-a></x-a>", 16)

    expect(content.failed).toBe(false)
    expect(content.elements.map((element) => element.tag)).toEqual(["p", "x-a"])
  })

  it("parses @let in an Angular 17 project without hanging the compiler", () => {
    const content = parse("<div>@let x = a.b;{{ x }}</div><x-c></x-c>", 17)

    expect(content.elements.map((element) => element.tag)).toEqual(["div", "x-c"])
  })

  it("flags a parse error and keeps what parsed", () => {
    const content = parse('<div [x]="a +"></div><x-b></x-b>')

    expect(content.failed).toBe(true)
    expect(content.elements.map((element) => element.tag)).toEqual(["div", "x-b"])
  })
})
