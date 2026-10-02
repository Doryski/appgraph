import { describe, expect, it } from "vitest"
import type { ScreenSource } from "../../src/adapters/types.js"
import type { FactExtractor } from "../../src/extractors/types.js"
import { createTagMask } from "../../src/extractors/types.js"
import { createComponentTreeExtractor } from "../../src/extractors/component-tree.js"
import { adapterFor, codes, run } from "./harness.js"

/**
 * `Content.tsx` renders `DevStatesPreview`, a dev-only preview of every dialog state whose
 * `data-testid`s are real strings in real JSX.
 * Advertising them to an agent as selectors for the shipping UI is actively harmful.
 */
const FILES = {
  "src/content/Content.tsx": `
import Panel from "./Panel"
import DevStatesPreview from "../dev/DevStatesPreview"

export default function Content() {
  return (
    <div data-testid="content-root">
      <Panel />
      <DevStatesPreview />
    </div>
  )
}
`,
  "src/content/Panel.tsx": `
import Dialog from "../ui/Dialog"

export default function Panel() {
  return (
    <section data-testid="panel">
      <Dialog />
    </section>
  )
}
`,
  "src/dev/DevStatesPreview.tsx": `
import Dialog from "../ui/Dialog"

export default function DevStatesPreview() {
  return (
    <div data-testid="dev-preview-root">
      <Dialog />
      <button data-testid="dev-open-confirm" />
    </div>
  )
}
`,
  "src/ui/Dialog.tsx": `export default function Dialog() { return <dialog data-testid="dialog" /> }`,
}

const testIds: FactExtractor = {
  name: "test-ids",
  provides: ["testIds"],
  stage: "main",
  enter: (node, ctx) => {
    const api = ctx.ts
    if (!api.isJsxOpeningElement(node) && !api.isJsxSelfClosingElement(node)) return
    const value = ctx.ast.attributeString(node, "data-testid", ctx.strings)
    if (value !== null) ctx.emitFact("testIds", value, node)
  },
}

const previewMask = createTagMask({
  name: "dev-preview-mask",
  tags: ["DevStatesPreview"],
  reason: "dev-only preview of dialog states",
  channels: ["testIds"],
})

const contentSource: ScreenSource = {
  name: "test-content",
  detect: () => ({ score: 100, evidence: [] }),
  discover: () => [
    {
      localId: "src/content/Content.tsx",
      activations: [{ kind: "url", template: "/content", params: [] }],
      entries: [{ kind: "file", file: "src/content/Content.tsx", exportName: "default" }],
      evidence: [],
    },
  ],
}

const analyse = () =>
  run({
    files: FILES,
    adapters: [adapterFor(contentSource)],
    extractors: [createComponentTreeExtractor(), testIds, previewMask],
  })

describe("pipeline/mask", () => {
  it("suppresses the masked subtree's testIds AND the masked component's own file", () => {
    const result = analyse()
    const screen = result.graph.screens[0]

    expect(screen?.facts.testIds).toEqual(["content-root", "dialog", "panel"])
    // The cross-file half of the seam: subtree masking only reaches JSX written inline in
    // Content.tsx, so the preview's OWN file must be suppressed too.
    expect(screen?.facts.testIds).not.toContain("dev-preview-root")
    expect(screen?.facts.testIds).not.toContain("dev-open-confirm")
    // A component the preview renders is NOT suppressed: `Dialog` is shipping UI that the preview
    // merely also uses, and deleting its selector everywhere would be the worse error.
    expect(screen?.facts.testIds).toContain("dialog")
  })

  it("keeps the masked component in the tree and in reachable", () => {
    const result = analyse()
    const screen = result.graph.screens[0]

    expect(screen?.reachable).toContain("src/dev/DevStatesPreview.tsx")
    expect(screen?.tree[0]?.children.map((child) => child.file)).toContain("src/dev/DevStatesPreview.tsx")

    // Masking suppresses FACTS, never structure: the render edge out of the masked file survives.
    const preview = result.graph.components["src/dev/DevStatesPreview.tsx"]
    expect(preview?.testIds).toEqual([])
    expect(preview?.renders.map((edge) => edge.file)).toEqual(["src/ui/Dialog.tsx"])
  })

  it("reports the mask as an info diagnostic naming the reason", () => {
    const result = analyse()
    expect(codes(result)).toContain("facts/masked")
    const masked = result.diagnostics.find((diagnostic) => diagnostic.code === "facts/masked")
    expect(masked?.severity).toBe("info")
    expect(masked?.message).toContain("dev-only preview of dialog states")
    expect(masked?.file).toBe("src/content/Content.tsx")
  })

  it("leaves unmasked runs untouched", () => {
    const result = run({
      files: FILES,
      adapters: [adapterFor(contentSource)],
      extractors: [createComponentTreeExtractor(), testIds],
    })

    expect(result.graph.screens[0]?.facts.testIds).toEqual([
      "content-root",
      "dev-open-confirm",
      "dev-preview-root",
      "dialog",
      "panel",
    ])
    expect(codes(result)).not.toContain("facts/masked")
  })
})
