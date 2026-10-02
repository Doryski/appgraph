import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createScriptSource, scriptKindFor } from "../../src/core/source-file.js"
import { isSourceFile } from "../../src/core/extensions.js"

const SFC = [
  "<template>",
  "  <div>{{ users.length }}</div>",
  "</template>",
  "",
  '<script setup lang="ts">',
  'import axios from "axios"',
  "const users: string[] = []",
  'axios.get("/api/users")',
  "</script>",
  "",
  "<style scoped>",
  ".a { color: red }",
  "</style>",
].join("\n")

const lineOf = (source: ts.SourceFile, needle: string): number =>
  source.getLineAndCharacterOfPosition(source.text.indexOf(needle)).line + 1

const callsIn = (source: ts.SourceFile): readonly ts.CallExpression[] => {
  const found: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe("createScriptSource — the single parse door", () => {
  it("parses a .vue file as its virtual script with offsets and lines preserved", () => {
    const source = createScriptSource(ts, "/repo/src/Users.vue", SFC)
    const call = callsIn(source)[0]

    expect(source.text).toHaveLength(SFC.length)
    expect(source.fileName).toBe("/repo/src/Users.vue")
    expect(call?.getStart(source)).toBe(SFC.indexOf('axios.get("/api/users")'))
    expect(source.getLineAndCharacterOfPosition(call?.getStart(source) ?? 0).line + 1).toBe(8)
    expect(lineOf(source, "const users")).toBe(7)
    expect(source.text).not.toContain("<template>")
    expect(source.text).not.toContain("color: red")
  })

  it("picks the ScriptKind from the script block's lang, and JS when lang is missing", () => {
    const kindOf = (text: string) => createScriptSource(ts, "/repo/A.vue", text).languageVariant
    expect(createScriptSource(ts, "/repo/A.vue", SFC).statements).toHaveLength(3)
    expect(kindOf('<script setup lang="ts">const a = <T,>(x: T) => x</script>')).toBe(ts.LanguageVariant.Standard)
    expect(kindOf('<script setup lang="tsx">const a = <div /></script>')).toBe(ts.LanguageVariant.JSX)
    expect(kindOf("<script setup>const a = 1</script>")).toBe(ts.LanguageVariant.JSX)
  })

  it("parses a template-only .vue file as an empty script of the same length", () => {
    const text = "<template>\n  <p>hi</p>\n</template>\n"
    const source = createScriptSource(ts, "/repo/Only.vue", text)
    expect(source.statements).toHaveLength(0)
    expect(source.text).toHaveLength(text.length)
  })

  it("keeps the resolver's script kinds for script files", () => {
    expect(scriptKindFor(ts, "a.tsx")).toBe(ts.ScriptKind.TSX)
    expect(scriptKindFor(ts, "a.jsx")).toBe(ts.ScriptKind.TSX)
    expect(scriptKindFor(ts, "a.ts")).toBe(ts.ScriptKind.TS)
    expect(scriptKindFor(ts, "a.js")).toBe(ts.ScriptKind.TS)
    expect(scriptKindFor(ts, "a.json")).toBe(ts.ScriptKind.JSON)
    expect(createScriptSource(ts, "/repo/a.ts", "const a = <T>(b)").languageVariant).toBe(ts.LanguageVariant.Standard)
  })

  it("lets phase 0 infer the kind from the extension, as it always has", () => {
    const text = "export const nav = [{ path: '/x', icon: <Icon /> }]"
    const inferred = createScriptSource(ts, "/repo/nav.js", text, { inferKind: true })
    expect(inferred.languageVariant).toBe(ts.LanguageVariant.JSX)
  })

  it("recognises every source extension, .vue included", () => {
    expect(["a.ts", "a.tsx", "a.mts", "a.cjs", "a.js", "a.jsx", "a.vue"].every(isSourceFile)).toBe(true)
    expect(["a.json", "a.css", "a.d.vue.bak"].some(isSourceFile)).toBe(false)
  })
})
