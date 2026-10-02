import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { CONDITION_MAX } from "../../src/core/ast.js"
import { loadVueCompiler, VUE_TEMPLATE_FRAMEWORK, VUE_TEMPLATE_TAGS, type VueCompiler } from "../../src/core/vue-compiler.js"
import { createVueTemplateProducer, templateDocOf, toPascal } from "../../src/core/vue-template.js"
import { expressionsFrom, type TemplateDoc, type TemplateElement } from "../../src/core/template-doc.js"

const root = mkdtempSync(path.join(tmpdir(), "appgraph-vue-template-"))

afterAll(() => rmSync(root, { recursive: true, force: true }))

const compilerOf = (): VueCompiler => {
  const result = loadVueCompiler({ root })
  if (result.kind !== "loaded") throw new Error(`vue compiler unavailable: ${result.kind}`)
  return result.api
}

const compiler = compilerOf()

const EMPTY_DOC: TemplateDoc = {
  framework: "vue",
  file: "src/App.vue",
  owner: null,
  partial: false,
  elements: [],
  expressions: [],
  unsupported: [],
}

const sfc = (...templateLines: readonly string[]): string => ["<template>", ...templateLines, "</template>", ""].join("\n")

const docOf = (text: string): TemplateDoc => templateDocOf(compiler, text, "src/App.vue")

const byTag = (doc: TemplateDoc, tag: string): readonly TemplateElement[] =>
  doc.elements.filter((element) => element.tag === tag)

const only = (doc: TemplateDoc, tag: string): TemplateElement => {
  const [element, ...rest] = byTag(doc, tag)
  if (element === undefined || rest.length > 0) throw new Error(`expected exactly one <${tag}>`)
  return element
}

describe("toPascal", () => {
  it("converts kebab tags and keeps Pascal tags", () => {
    expect(toPascal("router-view")).toBe("RouterView")
    expect(toPascal("RouterView")).toBe("RouterView")
    expect(toPascal("my-big-widget")).toBe("MyBigWidget")
    expect(toPascal("div")).toBe("Div")
  })
})

describe("templateDocOf", () => {
  it("tags the document with its framework, file and whole-file owner", () => {
    expect(docOf(sfc("<div />"))).toMatchObject({ framework: "vue", file: "src/App.vue", owner: null, partial: false })
  })

  it("lists elements in document order with kinds and Pascal-first binding names", () => {
    const doc = docOf(sfc("<div>", "  <router-view />", "  <UserCard />", "  <span />", "</div>"))

    expect(doc.unsupported).toEqual([])
    expect(doc.elements.map((element) => [element.tag, element.names, element.kind])).toEqual([
      ["div", ["Div", "div"], "element"],
      ["router-view", ["RouterView", "router-view"], "component"],
      ["UserCard", ["UserCard"], "component"],
      ["span", ["Span", "span"], "element"],
    ])
  })

  it("lists text interpolations with their expression, offsets and line", () => {
    const doc = docOf(sfc("<div>", "  <p>{{ $t('a') }}</p>", "  {{ count }}", "</div>"))

    expect(expressionsFrom(doc, "interpolation").map(({ text, line, pipes }) => [text, line, pipes])).toEqual([
      ["$t('a')", 3, []],
      ["count", 4, []],
    ])
  })

  it("lists directive expressions in document order with their origin", () => {
    const text = sfc('<div :title="t(\'x\')" @click="go()">', "  {{ label }}", '  <A v-if="ready" />', "</div>")
    const doc = docOf(text)

    expect(doc.expressions.map(({ text: expression, origin, line }) => [expression, origin, line])).toEqual([
      ["t('x')", "attribute", 2],
      ["go()", "event", 2],
      ["label", "interpolation", 3],
      ["ready", "attribute", 4],
    ])
    expect(doc.expressions.map((expression) => text.slice(expression.pos, expression.end))).toEqual([
      "t('x')",
      "go()",
      "{{ label }}",
      "ready",
    ])
  })

  it("builds v-if / v-else-if / v-else chain guards", () => {
    const doc = docOf(
      sfc('<A v-if="user.isAdmin" />', "<!-- note -->", '<B v-else-if="user.isEditor" />', "<C v-else />", "<D />"),
    )

    expect(only(doc, "A").guard).toEqual({ condition: "user.isAdmin", repeated: false, lazy: false })
    expect(only(doc, "B").guard).toEqual({ condition: "!(user.isAdmin) && user.isEditor", repeated: false, lazy: false })
    expect(only(doc, "C").guard).toEqual({ condition: "!(user.isAdmin) && !(user.isEditor)", repeated: false, lazy: false })
    expect(only(doc, "D").guard).toEqual({ condition: null, repeated: false, lazy: false })
  })

  it("joins enclosing conditions outermost first, including template v-if and v-show", () => {
    const doc = docOf(
      sfc('<template v-if="ready">', '  <section v-show="open">', '    <Panel v-if="items.length" />', "  </section>", "</template>"),
    )

    expect(only(doc, "template")).toMatchObject({ kind: "fragment", guard: { condition: "ready" } })
    expect(only(doc, "section").guard.condition).toBe("ready && open")
    expect(only(doc, "Panel").guard.condition).toBe("ready && open && items.length")
  })

  it("applies both v-for and v-if on the same element and propagates repetition", () => {
    const doc = docOf(sfc('<li v-for="item in items" v-if="visible"><Row :item="item" /></li>'))

    expect(only(doc, "li").guard).toEqual({ condition: "visible", repeated: true, lazy: false })
    expect(only(doc, "Row").guard).toEqual({ condition: "visible", repeated: true, lazy: false })
  })

  it("condenses and truncates conditions like ast.guardOf", () => {
    const long = Array.from({ length: 40 }, (_, index) => `flag${index}`).join(" &&\n   ")
    const doc = docOf(sfc(`<A v-if="${long}" />`))
    const condition = only(doc, "A").guard.condition ?? ""

    expect(condition).toHaveLength(CONDITION_MAX)
    expect(condition.startsWith("flag0 && flag1 && flag2")).toBe(true)
  })

  it("reads named, default and bound slot names", () => {
    const doc = docOf(sfc('<slot name="header" />', "<slot />", '<slot :name="dynamic" />'))

    expect(byTag(doc, "slot").map((element) => [element.kind, element.slotName])).toEqual([
      ["slot", "header"],
      ["slot", "default"],
      ["slot", null],
    ])
    expect(doc.elements.every((element) => element.kind === "slot")).toBe(true)
  })

  it("normalises static, bound and event attributes", () => {
    const text = sfc('<component :is="Current" v-bind:title="t" @click="go" v-on:submit="send" class="box" disabled v-model="value" />')
    const element = only(docOf(text), "component")

    expect(element.kind).toBe("component")
    expect(element.slotName).toBeNull()
    expect(
      element.attributes.map(({ name, kind, arg, static: value, expression, line }) => ({ name, kind, arg, value, expression, line })),
    ).toEqual([
      { name: "is", kind: "bound", arg: "is", value: null, expression: "Current", line: 2 },
      { name: "title", kind: "bound", arg: "title", value: null, expression: "t", line: 2 },
      { name: "click", kind: "event", arg: "click", value: null, expression: "go", line: 2 },
      { name: "submit", kind: "event", arg: "submit", value: null, expression: "send", line: 2 },
      { name: "class", kind: "static", arg: null, value: "box", expression: null, line: 2 },
      { name: "disabled", kind: "static", arg: null, value: "", expression: null, line: 2 },
      { name: "model", kind: "directive", arg: null, value: null, expression: "value", line: 2 },
    ])
    expect(element.attributes.map((attribute) => text.slice(attribute.pos, attribute.pos + 4))).toEqual([
      ":is=",
      "v-bi",
      "@cli",
      "v-on",
      "clas",
      "disa",
      "v-mo",
    ])
  })

  it("reports file lines and file offsets with a multi-line script before the template", () => {
    const text = [
      '<script setup lang="ts">',
      "import Child from './Child.vue'",
      "const a = 1",
      "const b = 2",
      "</script>",
      "",
      "<template>",
      "  <div>",
      "    <Child />",
      "  </div>",
      "</template>",
      "",
    ].join("\n")
    const child = only(docOf(text), "Child")

    expect(child.line).toBe(9)
    expect(text.slice(child.pos, child.end)).toBe("<Child />")
  })

  it("marks pug templates unsupported without elements", () => {
    const doc = docOf(['<template lang="pug">', "div", "  router-view", "</template>", ""].join("\n"))

    expect(doc).toEqual({ ...EMPTY_DOC, unsupported: ["pug"] })
  })

  it("marks external template src unsupported", () => {
    expect(docOf('<template src="./App.html"></template>\n')).toEqual({ ...EMPTY_DOC, unsupported: ["template-src"] })
  })

  it("marks parse errors and keeps the recoverable elements", () => {
    const doc = docOf(sfc('<div v-if="a"></span>'))

    expect(doc.unsupported).toEqual(["parse-error"])
    expect(only(doc, "div").guard.condition).toBe("a")
  })

  it("returns an empty document when there is no template", () => {
    expect(docOf("<script setup>\nconst a = 1\n</script>\n")).toEqual(EMPTY_DOC)
  })
})

describe("Vue template producer", () => {
  const files: Readonly<Record<string, string>> = { "src/App.vue": sfc("<RouterView />") }
  const producer = createVueTemplateProducer({
    compiler,
    env: { readFile: (file) => files[file] ?? null },
    tags: VUE_TEMPLATE_TAGS,
  })

  it("claims .vue files only", () => {
    expect(producer.claims("src/App.vue")).toBe(true)
    expect(producer.claims("src/App.ts")).toBe(false)
  })

  it("gives one whole-file document per readable .vue file", () => {
    expect(producer.docsOf("src/App.vue").map((doc) => [doc.file, doc.owner, doc.elements.map((element) => element.names[0])])).toEqual([
      ["src/App.vue", null, ["RouterView"]],
    ])
    expect(producer.docsOf("src/Missing.vue")).toEqual([])
  })

  it("is what the framework spec builds once a compiler is loaded, and nothing without one", () => {
    const env = { readFile: () => null }
    expect(VUE_TEMPLATE_FRAMEWORK.producer(compiler, env)?.framework).toBe("vue")
    expect(VUE_TEMPLATE_FRAMEWORK.producer(null, env)).toBeNull()
    expect(VUE_TEMPLATE_FRAMEWORK.tags.outlets).toContainEqual(["RouterView", "router-view"])
  })
})
