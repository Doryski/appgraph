import { describe, expect, it } from "vitest"
import type { FactExtractor } from "../../src/extractors/types.js"
import { createDefaultExtractors } from "../../src/pipeline/registry.js"
import { adapterFor, run, staticSource } from "./harness.js"

const HOME = [
  "<template>",
  "  <main>",
  "    <Child />",
  "  </main>",
  "</template>",
  "",
  '<script setup lang="ts">',
  'import axios from "axios"',
  'import Child from "./Child.vue"',
  "",
  'axios.get("/api/x")',
  "</script>",
].join("\n")

const FILES = {
  "package.json": JSON.stringify({ name: "fixture", dependencies: { vue: "3.5.0", axios: "1.7.0" } }),
  "src/pages/Home.vue": HOME,
  "src/pages/Child.vue": '<template><p /></template>\n<script setup>\naxios.post("/api/child")\n</script>\n',
}

const homeSource = staticSource("vue-entries", [
  {
    localId: "src/pages/Home.vue",
    activations: [{ kind: "url", template: "/", params: [] }],
    entries: [{ kind: "file", file: "src/pages/Home.vue", exportName: "default" }],
    evidence: [],
  },
])

type Seen = { readonly file: string; readonly line: number; readonly text: string }

const recorder = (seen: Seen[], imports: Record<string, readonly string[]>): FactExtractor => ({
  name: "vue-recorder",
  provides: ["messages"],
  enter: (node, ctx) => {
    if (!ctx.ts.isCallExpression(node)) return
    seen.push({ file: ctx.file, line: ctx.lineOf(node), text: node.expression.getText(ctx.source) })
  },
  finish: (ctx) => {
    imports[ctx.file] = ctx.bindings.importedFiles
  },
})

const runHome = () => {
  const seen: Seen[] = []
  const imports: Record<string, readonly string[]> = {}
  const result = run({
    files: FILES,
    adapters: [adapterFor(homeSource)],
    extractors: [...createDefaultExtractors(), recorder(seen, imports)],
  })
  return { result, seen, imports }
}

describe("pipeline — a .vue entry's <script setup>", () => {
  it("yields the axios endpoint fact from the virtual script", () => {
    const { result } = runHome()
    const screen = result.graph.screens[0]

    expect(screen?.tree[0]?.file).toBe("src/pages/Home.vue")
    expect(screen?.facts.endpoints).toContainEqual({ method: "GET", url: "/api/x", transport: "http", client: "axios" })
  })

  it("reports script facts on the line they sit on in the .vue file", () => {
    const { seen } = runHome()
    expect(seen).toContainEqual({ file: "src/pages/Home.vue", line: 11, text: "axios.get" })
  })

  it("resolves the imported ./Child.vue to its file", () => {
    const { imports } = runHome()
    expect(imports["src/pages/Home.vue"]).toEqual(["/repo/src/pages/Child.vue"])
  })
})
