import { describe, expect, it } from "vitest"
import type { ScreenDraft, ScreenSource } from "../../src/adapters/types.js"
import { adapterFor, codes, run, staticSource } from "./harness.js"

const HOLDER = `// @appgraph-id login
const login = <Login />
const main = <Main />
`

const urlDraft = (url: string, overrides: Partial<ScreenDraft> = {}): ScreenDraft => ({
  localId: `${url}.tsx`,
  activations: [{ kind: "url", template: url, params: [] }],
  entries: [],
  evidence: [],
  ...overrides,
})

/** Mints structural localIds the way the state-screens adapter must. */
const stateSource: ScreenSource = {
  name: "state-screens",
  detect: () => ({ score: 50, evidence: [] }),
  discover: (ctx) => {
    const file = "src/App.tsx"
    const source = ctx.sourceFile(file)
    if (source === null) return []

    return source.statements.map((statement, ordinal) => ({
      localId: ctx.localId(file, { ordinal, node: statement }),
      activations: [{ kind: "state" as const, holder: "App", expr: "isAuthenticated" }],
      entries: [{ kind: "file" as const, file, exportName: "default" }],
      evidence: [ctx.evidence("guarded branch", file, statement)],
    }))
  },
}

describe("pipeline/normalize", () => {
  it("mints structural localIds and honours the @appgraph-id pragma", () => {
    const result = run({ files: { "src/App.tsx": HOLDER }, adapters: [adapterFor(stateSource)] })

    expect(result.graph.screens.map((screen) => screen.localId)).toEqual([
      "src/App.tsx#1",
      "src/App.tsx#login",
    ])
    // A non-addressable screen is namespaced by source, and the localId is URI-encoded.
    expect(result.graph.screens.map((screen) => screen.id)).toEqual([
      "screen://state-screens/src%2FApp.tsx%231",
      "screen://state-screens/src%2FApp.tsx%23login",
    ])
    expect(result.graph.screens.every((screen) => !screen.addressable)).toBe(true)
  })

  it("canonicalises URLs and derives params from the template", () => {
    const source = staticSource("test-urls", [
      urlDraft("/orders//:orderId/?tab=1", { localId: "src/Order.tsx" }),
    ])
    const result = run({ files: { "src/App.tsx": HOLDER }, adapters: [adapterFor(source)] })

    const screen = result.graph.screens[0]
    expect(screen?.id).toBe("/orders/:orderId")
    expect(screen?.url).toBe("/orders/:orderId")
    expect(screen?.params).toEqual(["orderId"])
  })

  it("merges two sources claiming one URL and records the provenance", () => {
    const first = staticSource("a-source", [urlDraft("/invoices", { title: "Invoices" })])
    const second = staticSource("b-source", [
      urlDraft("/invoices", { localId: "other.tsx", auth: "protected", title: "Ignored" }),
    ])

    const result = run({
      files: { "src/App.tsx": HOLDER },
      adapters: [adapterFor(first), adapterFor(second)],
    })

    expect(result.graph.screens).toHaveLength(1)
    const screen = result.graph.screens[0]
    // First present wins per field, in contributing-source order.
    expect(screen?.title).toBe("Invoices")
    expect(screen?.auth).toBe("protected")
    expect(screen?.provenance.sources).toEqual(["a-source", "b-source"])
    expect(screen?.provenance.mergedFrom.map((entry) => entry.localId)).toEqual(["/invoices.tsx", "other.tsx"])
    expect(screen?.provenance.decisions.join(" ")).toContain("conflicts:merge")
    expect(codes(result)).toContain("screens/merged")
  })

  it("keeps the first contribution under conflicts:first and names the loser", () => {
    const first = staticSource("a-source", [urlDraft("/invoices", { title: "Invoices" })])
    const second = staticSource("b-source", [urlDraft("/invoices", { localId: "other.tsx", title: "Other" })])

    const result = run({
      files: { "src/App.tsx": HOLDER },
      adapters: [adapterFor(first), adapterFor(second)],
      config: { conflicts: "first" },
    })

    expect(result.graph.screens[0]?.title).toBe("Invoices")
    expect(codes(result)).toContain("screens/conflict-dropped")
  })

  it("treats a same-source duplicate as an error in every mode", () => {
    const source = staticSource("a-source", [urlDraft("/invoices"), urlDraft("/invoices", { localId: "dup.tsx" })])
    const result = run({ files: { "src/App.tsx": HOLDER }, adapters: [adapterFor(source)] })

    expect(codes(result)).toContain("screens/duplicate-id")
  })
})
