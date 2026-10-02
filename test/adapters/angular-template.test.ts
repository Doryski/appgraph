import { tmpdir } from "node:os"
import ts from "typescript"
import { beforeAll, describe, expect, it } from "vitest"
import { createAngularTemplateProducer } from "../../src/adapters/angular/template.js"
import type { AngularCompiler } from "../../src/core/angular-compiler.js"
import { ANGULAR_TEMPLATE_FRAMEWORK } from "../../src/core/angular-compiler.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { TemplateDoc } from "../../src/core/template-doc.js"
import { TEMPLATE_FRAMEWORKS, loadTemplateCompilers, templateApiOf } from "../../src/pipeline/template-frameworks.js"
import type { Adapter } from "../../src/adapters/types.js"
import { resolveConfig } from "../../src/config/types.js"
import { createDiagnosticCollector } from "../../src/core/diagnostics.js"
import type { AppGraph } from "../../src/core/model.js"
import type { TemplateCompilerApis } from "../../src/core/template-frameworks.js"
import { createEnv } from "../../src/pipeline/context.js"
import { configure, createFactSource, discover, normalize, resolveEntries, walk } from "../../src/pipeline/phases.js"
import { createDefaultExtractors, createPipelineRegistry } from "../../src/pipeline/registry.js"

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

const producerOf = (files: Readonly<Record<string, string>>, api: AngularCompiler | null) =>
  createAngularTemplateProducer({
    api,
    env: { readFile: (file) => files[file] ?? null, ts },
    projectMajor: 22,
  })

const summaryOf = (doc: TemplateDoc) => ({
  file: doc.file,
  owner: doc.owner,
  partial: doc.partial,
  unsupported: doc.unsupported,
  elements: doc.elements.map((element) => [element.tag, element.kind, element.line]),
})

const SHELL_TS = [
  'import { Component } from "@angular/core"',
  "",
  "@Component({",
  '  selector: "app-shell",',
  '  templateUrl: "./shell.component.html",',
  "})",
  "export class ShellComponent {}",
  "",
].join("\n")

const SHELL_HTML = ["<header>", "  <app-nav></app-nav>", "</header>", '<router-outlet name="aux"></router-outlet>', "<router-outlet></router-outlet>", ""].join("\n")

const INLINE_TS = [
  'import { Component as Cmp } from "@angular/core"',
  "",
  "@Cmp({",
  '  selector: "app-card",',
  "  template: `",
  "    <section>",
  '      <ng-content select="[card-title]"></ng-content>',
  "      <ng-content></ng-content>",
  "    </section>`,",
  "})",
  "export class CardComponent {}",
  "",
].join("\n")

const TWO_TS = [
  'import * as ng from "@angular/core"',
  "",
  '@ng.Component({ selector: "a-one", template: "<router-outlet></router-outlet>" })',
  "export class OneComponent {}",
  "",
  "@ng.Directive({ selector: \"[x]\" })",
  "export class XDirective {}",
  "",
  '@ng.Component({ selector: "a-two", template: \'<p>two</p>\' })',
  "export default class TwoComponent {}",
  "",
].join("\n")

const FILES: Readonly<Record<string, string>> = {
  "src/app/shell.component.ts": SHELL_TS,
  "src/app/shell.component.html": SHELL_HTML,
  "src/app/card.component.ts": INLINE_TS,
  "src/app/two.component.ts": TWO_TS,
  "src/app/missing.component.ts": SHELL_TS.replace("./shell.component.html", "../views/missing.html"),
  "src/app/interpolated.component.ts": [
    'import { Component } from "@angular/core"',
    "const tag = 'p'",
    "@Component({ selector: 'x-i', template: `<${tag}></${tag}>` })",
    "export class InterpolatedComponent {}",
  ].join("\n"),
  "src/app/foreign.component.ts": [
    'import { Component } from "vue-property-decorator"',
    "@Component({ template: '<router-outlet></router-outlet>' })",
    "export class Foreign {}",
  ].join("\n"),
  "src/app/bare.component.ts": ["@Component({ template: '<router-outlet></router-outlet>' })", "export class Bare {}"].join("\n"),
}

const lineOf = (text: string, needle: string): number => text.slice(0, text.indexOf(needle)).split("\n").length

describe("createAngularTemplateProducer — pairing and scan mode", () => {
  const scan = producerOf(FILES, null)

  it("claims script files with an @Component class from @angular/core, aliased, namespaced or bare", () => {
    expect(scan.claims("src/app/shell.component.ts")).toBe(true)
    expect(scan.claims("src/app/card.component.ts")).toBe(true)
    expect(scan.claims("src/app/two.component.ts")).toBe(true)
    expect(scan.claims("src/app/bare.component.ts")).toBe(true)
    expect(scan.claims("src/app/foreign.component.ts")).toBe(false)
    expect(scan.claims("src/app/shell.component.html")).toBe(false)
  })

  it("pairs a templateUrl with its .html file and scans only outlets and slots with no compiler", () => {
    const docs = scan.docsOf("src/app/shell.component.ts")

    expect(docs.map(summaryOf)).toEqual([
      {
        file: "src/app/shell.component.html",
        owner: "ShellComponent",
        partial: true,
        unsupported: [],
        elements: [
          ["router-outlet", "element", 4],
          ["router-outlet", "element", 5],
        ],
      },
    ])
    expect(docs[0]?.elements[0]).toMatchObject({
      names: ["router-outlet", "RouterOutlet"],
      attributes: [{ name: "name", kind: "static", static: "aux" }],
      pos: SHELL_HTML.indexOf("<router-outlet"),
    })
    expect(docs[0]?.expressions).toEqual([])
  })

  it("scans an inline template with offsets and lines of the .ts file", () => {
    const [doc] = scan.docsOf("src/app/card.component.ts")

    expect(doc === undefined ? null : summaryOf(doc)).toEqual({
      file: "src/app/card.component.ts",
      owner: "CardComponent",
      partial: true,
      unsupported: [],
      elements: [
        ["ng-content", "slot", lineOf(INLINE_TS, "<ng-content select")],
        ["ng-content", "slot", lineOf(INLINE_TS, "<ng-content></")],
      ],
    })
    expect(doc?.elements.map((element) => [element.slotName, element.pos])).toEqual([
      ["[card-title]", INLINE_TS.indexOf("<ng-content select")],
      ["default", INLINE_TS.indexOf("<ng-content></")],
    ])
  })

  it("gives a missing templateUrl an unsupported doc on the .ts file", () => {
    expect(scan.docsOf("src/app/missing.component.ts").map(summaryOf)).toEqual([
      {
        file: "src/app/missing.component.ts",
        owner: "ShellComponent",
        partial: true,
        unsupported: ["template-url-missing"],
        elements: [],
      },
    ])
  })

  it("marks an inline template with substitutions unsupported", () => {
    expect(scan.docsOf("src/app/interpolated.component.ts").map((doc) => doc.unsupported)).toEqual([
      ["interpolated-inline-template"],
    ])
  })

  it("emits one doc per @Component class with its owner, skipping other decorators", () => {
    expect(scan.docsOf("src/app/two.component.ts").map((doc) => [doc.owner, doc.elements.map((element) => element.tag)])).toEqual([
      ["OneComponent", ["router-outlet"]],
      ["default", []],
    ])
  })

  it("names a component by its class only when the file has exactly one", () => {
    expect(scan.componentNameOf?.("src/app/shell.component.ts")).toBe("ShellComponent")
    expect(scan.componentNameOf?.("src/app/two.component.ts")).toBeNull()
    expect(scan.componentNameOf?.("src/app/foreign.component.ts")).toBeNull()
  })
})

describe("createAngularTemplateProducer — compiler mode", () => {
  let compiler: AngularCompiler

  beforeAll(async () => {
    compiler = await loadCompiler()
  })

  it("parses a templateUrl file into a full doc", () => {
    const [doc] = producerOf(FILES, compiler).docsOf("src/app/shell.component.ts")

    expect(doc === undefined ? null : summaryOf(doc)).toEqual({
      file: "src/app/shell.component.html",
      owner: "ShellComponent",
      partial: false,
      unsupported: [],
      elements: [
        ["header", "element", 1],
        ["app-nav", "component", 2],
        ["router-outlet", "component", 4],
        ["router-outlet", "component", 5],
      ],
    })
  })

  it("keeps inline template lines and offsets on the .ts file", () => {
    const [doc] = producerOf(FILES, compiler).docsOf("src/app/card.component.ts")

    expect(doc?.elements.map((element) => [element.tag, element.kind, element.line, element.pos, element.slotName])).toEqual([
      ["section", "element", lineOf(INLINE_TS, "<section>"), INLINE_TS.indexOf("<section>"), null],
      ["ng-content", "slot", lineOf(INLINE_TS, "<ng-content select"), INLINE_TS.indexOf("<ng-content select"), "[card-title]"],
      ["ng-content", "slot", lineOf(INLINE_TS, "<ng-content></"), INLINE_TS.indexOf("<ng-content></"), "default"],
    ])
  })
})

const SPLICE_FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify({ name: "fixture", dependencies: { "@angular/core": "^22.0.0" } }),
  "tsconfig.json": JSON.stringify({ include: ["src"] }),
  "src/app/shell.component.ts": SHELL_TS,
  "src/app/shell.component.html": SHELL_HTML,
  "src/app/orders.component.ts": [
    'import { Component } from "@angular/core"',
    '@Component({ selector: "app-orders", template: "<p>orders</p>" })',
    "export class OrdersComponent {}",
  ].join("\n"),
}

const spliceAdapter: Adapter = {
  name: "fake-angular-routes",
  screens: [
    {
      name: "fake-angular-routes",
      detect: () => ({ score: 100, evidence: [] }),
      discover: () => [
        {
          localId: "src/app/orders.component.ts",
          activations: [{ kind: "url", template: "/orders", params: [] }],
          entries: [{ kind: "file", file: "src/app/orders.component.ts", exportName: "OrdersComponent" }],
          ancestors: [
            {
              file: "src/app/shell.component.ts",
              exportName: "ShellComponent",
              role: "layout",
              splice: { kind: "outlet", tag: "router-outlet" },
            },
          ],
          evidence: [],
        },
      ],
    },
  ],
}

const angularSpec = TEMPLATE_FRAMEWORKS.filter((spec) => spec.id === "angular")

const splicedTree = (templates: TemplateCompilerApis, frameworks = angularSpec) => {
  const root = "/repo"
  const diagnostics = createDiagnosticCollector()
  const env = createEnv({
    ts,
    config: resolveConfig({ root, appgraphVersion: "0.1.0-test" }),
    host: createMemoryHost({ files: Object.fromEntries(Object.entries(SPLICE_FILES).map(([file, text]) => [`${root}/${file}`, text])) }),
    diagnostics,
    frameworks,
    templates,
  })
  const registry = createPipelineRegistry({ adapters: [spliceAdapter] })
  const { kindRules } = configure({ env, registry })
  const discovered = discover({ env, registry })
  const screens = resolveEntries({ env, registry, screens: normalize({ env, contributions: discovered.contributions }) })
  const facts = createFactSource({ env, extractors: createDefaultExtractors({ kindRules }), kindRules })
  const graph = walk({ env, screens, navGroups: discovered.navGroups, facts, kindRules, diagnostics })
  const visit = (nodes: AppGraph["screens"][number]["tree"]): readonly string[] => nodes.flatMap((node) => [node.file, ...visit(node.children)])
  return {
    files: visit(graph.screens[0]?.tree ?? []),
    walkCodes: diagnostics
      .all()
      .map((diagnostic) => diagnostic.code)
      .filter((code) => code.startsWith("walk/")),
  }
}

describe("Angular router-outlet splice", () => {
  let compilerForSplice: AngularCompiler

  beforeAll(async () => {
    compilerForSplice = await loadCompiler()
  })

  it.each([
    ["scan mode", (): TemplateCompilerApis => ({})],
    ["compiler mode", (): TemplateCompilerApis => ({ angular: compilerForSplice })],
  ])("splices the routed child into the parent's <router-outlet> in %s", (_mode, apis) => {
    expect(splicedTree(apis())).toEqual({
      files: ["src/app/shell.component.ts", "src/app/orders.component.ts"],
      walkCodes: [],
    })
  })

  it("does not splice without the Angular template framework", () => {
    expect(splicedTree({}, []).files).not.toEqual(["src/app/shell.component.ts", "src/app/orders.component.ts"])
  })
})
