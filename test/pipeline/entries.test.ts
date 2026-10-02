import { describe, expect, it } from "vitest"
import type { EntryRef, ScreenSource } from "../../src/adapters/types.js"
import { adapterFor, run } from "./harness.js"

const FILES = {
  "src/router.ts": `import Dashboard from "./pages/Dashboard"\nexport const router = [Dashboard]\n`,
  "src/pages/Dashboard.tsx": `export default function Dashboard() { return <main /> }`,
  "src/pages/index.ts": `export { default as Dashboard } from "./Dashboard"`,
}

const sourceWith = (entries: readonly EntryRef[], name = "test-entries"): ScreenSource => ({
  name,
  detect: () => ({ score: 100, evidence: [] }),
  discover: () => [
    {
      localId: "src/router.ts#0",
      activations: [{ kind: "url", template: "/dashboard", params: [] }],
      entries,
      evidence: [],
    },
  ],
})

const entriesOf = (entries: readonly EntryRef[]) => {
  const result = run({ files: FILES, adapters: [adapterFor(sourceWith(entries))] })
  return { result, entries: result.graph.screens[0]?.entries ?? [] }
}

describe("pipeline/resolve-entries", () => {
  it("passes a file ref through and makes it the tree root", () => {
    const { result, entries } = entriesOf([
      { kind: "file", file: "src/pages/Dashboard.tsx", exportName: "default" },
    ])

    expect(entries).toEqual([{ kind: "file", file: "src/pages/Dashboard.tsx", exportName: "default" }])
    expect(result.graph.screens[0]?.tree[0]?.file).toBe("src/pages/Dashboard.tsx")
  })

  it("resolves a module ref through the resolver", () => {
    const { entries } = entriesOf([{ kind: "module", from: "src/router.ts", spec: "./pages/Dashboard" }])
    expect(entries).toEqual([{ kind: "file", file: "src/pages/Dashboard.tsx", exportName: "default" }])
  })

  it("resolves a module ref through a tsconfig alias", () => {
    const { entries } = entriesOf([{ kind: "module", from: "src/router.ts", spec: "@/pages/Dashboard" }])
    expect(entries[0]).toMatchObject({ kind: "file", file: "src/pages/Dashboard.tsx" })
  })

  it("chases a barrel re-export to the declaring file and the name it is declared under", () => {
    const { entries } = entriesOf([
      { kind: "module", from: "src/router.ts", spec: "./pages", exported: "Dashboard" },
    ])
    expect(entries).toEqual([{ kind: "file", file: "src/pages/Dashboard.tsx", exportName: "default" }])
  })

  it("resolves a binding ref through the binding table", () => {
    const { entries } = entriesOf([{ kind: "binding", from: "src/router.ts", local: "Dashboard" }])
    expect(entries).toEqual([{ kind: "file", file: "src/pages/Dashboard.tsx", exportName: "default" }])
  })

  it("carries a sub-file locator onto the resolved entry", () => {
    const { entries } = entriesOf([
      { kind: "module", from: "src/router.ts", spec: "./pages/Dashboard", at: { export: "default", path: [0] } },
    ])
    expect(entries[0]).toMatchObject({ at: { export: "default", path: [0] } })
  })

  it("turns an unresolvable module ref into a visible hole with a diagnostic", () => {
    const { result, entries } = entriesOf([{ kind: "module", from: "src/router.ts", spec: "./nope" }])

    expect(entries[0]).toMatchObject({ kind: "opaque", file: "src/router.ts" })
    const diagnostic = result.diagnostics.find((entry) => entry.code === "screens/opaque-entry")
    expect(diagnostic?.severity).toBe("error")
    expect(diagnostic?.plugin).toBe("test-entries")
    expect(diagnostic?.message).toContain("./nope")
    // The hole is visible: the screen survives with an entry the reader can see.
    expect(result.graph.screens).toHaveLength(1)
  })

  it("turns an unknown binding into a visible hole", () => {
    const { entries, result } = entriesOf([{ kind: "binding", from: "src/router.ts", local: "Missing" }])
    expect(entries[0]).toMatchObject({ kind: "opaque" })
    expect(result.diagnostics.map((entry) => entry.code)).toContain("screens/opaque-entry")
  })

  it("keeps an adapter-supplied opaque ref and reports it", () => {
    const { entries, result } = entriesOf([
      { kind: "opaque", expr: "componentLoader.get(key)", file: "src/router.ts", line: 7 },
    ])

    expect(entries).toEqual([
      { kind: "opaque", expr: "componentLoader.get(key)", file: "src/router.ts", line: 7 },
    ])
    const diagnostic = result.diagnostics.find((entry) => entry.code === "screens/opaque-entry")
    expect(diagnostic?.line).toBe(7)
  })

  it("lets an adapter resolve refs the core resolver cannot", () => {
    const source: ScreenSource = {
      ...sourceWith([{ kind: "binding", from: "src/router.ts", local: "Components.Dashboard" }]),
      // The AdminJS `componentLoader` case: the key is not a module and not a binding.
      resolveEntries: (refs): readonly EntryRef[] =>
        refs.map((ref) =>
          ref.kind === "binding" && ref.local.startsWith("Components.")
            ? { kind: "file", file: "src/pages/Dashboard.tsx", exportName: "default" }
            : ref,
        ),
    }

    const result = run({ files: FILES, adapters: [adapterFor(source)] })
    expect(result.graph.screens[0]?.entries).toEqual([
      { kind: "file", file: "src/pages/Dashboard.tsx", exportName: "default" },
    ])
    expect(result.diagnostics.map((entry) => entry.code)).not.toContain("screens/opaque-entry")
  })
})
