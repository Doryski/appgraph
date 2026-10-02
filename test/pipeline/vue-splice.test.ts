import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import ts from "typescript"
import { afterAll, describe, expect, it } from "vitest"
import type { AncestorRef } from "../../src/core/model.js"
import { createMemoryHost } from "../../src/core/host.js"
import { loadVueCompiler, type VueCompiler } from "../../src/core/vue-compiler.js"
import { resolveConfig } from "../../src/config/types.js"
import { runPipeline } from "../../src/pipeline/run.js"
import { EMPTY_TEMPLATE_COMPILERS } from "../../src/pipeline/template-frameworks.js"
import { ROOT, adapterFor, codes, staticSource, withProject } from "./harness.js"

const scratch = mkdtempSync(path.join(tmpdir(), "appgraph-vue-splice-"))

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const compilerOf = (): VueCompiler => {
  const result = loadVueCompiler({ root: scratch })
  if (result.kind !== "loaded") throw new Error(`vue compiler unavailable: ${result.kind}`)
  return result.api
}

const FILES = {
  "src/App.vue": [
    "<template>",
    "  <DefaultLayout />",
    "</template>",
    "<script setup>",
    'import DefaultLayout from "./layouts/DefaultLayout.vue"',
    "</script>",
    "",
  ].join("\n"),
  "src/layouts/DefaultLayout.vue": [
    "<template>",
    "  <main>",
    "    <AppHeader />",
    "    <router-view />",
    "  </main>",
    "</template>",
    "<script setup>",
    'import AppHeader from "../ui/AppHeader.vue"',
    "</script>",
    "",
  ].join("\n"),
  "src/layouts/SlotLayout.vue": "<template>\n  <section><slot /></section>\n</template>\n",
  "src/layouts/Bare.vue": "<template>\n  <section />\n</template>\n",
  "src/layouts/NamedOutlet.vue": '<template>\n  <router-view name="aside" />\n</template>\n',
  "src/layouts/EmptyNamedOutlet.vue": '<template>\n  <RouterView name="" />\n</template>\n',
  "src/layouts/HostsNamedOutlet.vue": [
    "<template>",
    "  <section><NamedOutlet /></section>",
    "</template>",
    "<script setup>",
    'import NamedOutlet from "./NamedOutlet.vue"',
    "</script>",
    "",
  ].join("\n"),
  "src/layouts/NamedSlot.vue": '<template>\n  <aside><slot name="aside" /></aside>\n</template>\n',
  "src/ui/AppHeader.vue": "<template><header /></template>\n",
  "src/pages/Orders.vue": "<template><table /></template>\n",
}

const runWith = (ancestor: Pick<AncestorRef, "file" | "splice">, vue: VueCompiler | null) =>
  runPipeline({
    ts,
    host: createMemoryHost({ files: withProject(FILES) }),
    config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test", formats: ["full"] }),
    adapters: [
      adapterFor(
        staticSource("vue-routes", [
          {
            localId: "src/pages/Orders.vue",
            activations: [{ kind: "url", template: "/orders", params: [] }],
            entries: [{ kind: "file", file: "src/pages/Orders.vue", exportName: "default" }],
            ancestors: [{ exportName: "default", role: "layout", ...ancestor }],
            evidence: [],
          },
        ]),
      ),
    ],
    ...(vue === null ? {} : { templates: { ...EMPTY_TEMPLATE_COMPILERS, apis: { vue } } }),
  })

const treeFilesOf = (result: ReturnType<typeof runWith>): readonly string[] => {
  const visit = (nodes: (typeof result.graph.screens)[number]["tree"]): readonly string[] =>
    nodes.flatMap((node) => [node.file, ...visit(node.children)])
  return visit(result.graph.screens[0]?.tree ?? [])
}

const walkCodes = (result: ReturnType<typeof runWith>): readonly string[] =>
  codes(result).filter((code) => code.startsWith("walk/"))

describe("pipeline — splice points in .vue templates", () => {
  const vue = compilerOf()

  it("splices under the layout App.vue renders, at its <router-view>", () => {
    const result = runWith({ file: "src/App.vue", splice: { kind: "outlet", tag: "RouterView" } }, vue)

    expect(treeFilesOf(result)).toEqual([
      "src/App.vue",
      "src/layouts/DefaultLayout.vue",
      "src/ui/AppHeader.vue",
      "src/pages/Orders.vue",
    ])
    expect(walkCodes(result)).toEqual([])
  })

  it("splices children at a layout's default <slot/>", () => {
    const result = runWith({ file: "src/layouts/SlotLayout.vue", splice: { kind: "children" } }, vue)

    expect(treeFilesOf(result)).toEqual(["src/layouts/SlotLayout.vue", "src/pages/Orders.vue"])
    expect(walkCodes(result)).toEqual([])
  })

  it("warns when the layout's template has no outlet", () => {
    const result = runWith({ file: "src/layouts/Bare.vue", splice: { kind: "outlet", tag: "RouterView" } }, vue)

    expect(walkCodes(result)).toEqual(["walk/no-splice-point"])
  })

  it("does not take a named <router-view name> for the default outlet", () => {
    const result = runWith({ file: "src/layouts/NamedOutlet.vue", splice: { kind: "outlet", tag: "RouterView" } }, vue)

    expect(walkCodes(result)).toEqual(["walk/no-splice-point"])
  })

  it("splices a named outlet splice only at the <router-view> with that static name", () => {
    const named = runWith({ file: "src/layouts/NamedOutlet.vue", splice: { kind: "outlet", tag: "RouterView", name: "aside" } }, vue)
    const other = runWith({ file: "src/layouts/NamedOutlet.vue", splice: { kind: "outlet", tag: "RouterView", name: "main" } }, vue)
    const unnamed = runWith({ file: "src/layouts/DefaultLayout.vue", splice: { kind: "outlet", tag: "RouterView", name: "aside" } }, vue)

    expect(treeFilesOf(named)).toEqual(["src/layouts/NamedOutlet.vue", "src/pages/Orders.vue"])
    expect(walkCodes(named)).toEqual([])
    expect(walkCodes(other)).toEqual(["walk/no-splice-point"])
    expect(walkCodes(unnamed)).toEqual(["walk/no-splice-point"])
  })

  it("finds a named outlet hosted by a component the ancestor renders", () => {
    const result = runWith(
      { file: "src/layouts/HostsNamedOutlet.vue", splice: { kind: "outlet", tag: "RouterView", name: "aside" } },
      vue,
    )

    expect(treeFilesOf(result)).toEqual([
      "src/layouts/HostsNamedOutlet.vue",
      "src/layouts/NamedOutlet.vue",
      "src/pages/Orders.vue",
    ])
    expect(walkCodes(result)).toEqual([])
  })

  it("takes an outlet with an empty name for the default outlet, matching the alias of the splice tag", () => {
    const result = runWith({ file: "src/layouts/EmptyNamedOutlet.vue", splice: { kind: "outlet", tag: "router-view" } }, vue)

    expect(treeFilesOf(result)).toEqual(["src/layouts/EmptyNamedOutlet.vue", "src/pages/Orders.vue"])
    expect(walkCodes(result)).toEqual([])
  })

  it("splices a named slot only at its <slot name>", () => {
    const named = runWith({ file: "src/layouts/NamedSlot.vue", splice: { kind: "slot", name: "aside" } }, vue)
    const unnamed = runWith({ file: "src/layouts/NamedSlot.vue", splice: { kind: "children" } }, vue)

    expect(walkCodes(named)).toEqual([])
    expect(walkCodes(unnamed)).toEqual(["walk/no-splice-point"])
  })

  it("trusts the splice point when no compiler can read the template", () => {
    const result = runWith({ file: "src/layouts/Bare.vue", splice: { kind: "outlet", tag: "RouterView" } }, null)

    expect(treeFilesOf(result)).toEqual(["src/layouts/Bare.vue", "src/pages/Orders.vue"])
    expect(walkCodes(result)).toEqual([])
  })
})
