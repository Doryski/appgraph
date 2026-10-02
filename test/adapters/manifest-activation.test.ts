import ts from "typescript"
import { describe, expect, it } from "vitest"
import { LIVE_SOURCE_SCORE, resolveConfig } from "../../src/config/types.js"
import { PRESETS, presetForSource } from "../../src/config/presets.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { Activation, Screen } from "../../src/core/model.js"
import { createEnv, createProjectContext } from "../../src/pipeline/context.js"
import { runDetection } from "../../src/detect/index.js"
import {
  DETECT_SCORE_LAST_RESORT,
  SOURCE_NAME,
  detectManifestActivation,
  manifestActivationAdapter,
} from "../../src/adapters/manifest-activation.js"
import { ROOT, codes, run } from "../pipeline/harness.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const analyze = (files: Readonly<Record<string, string>>) =>
  run({ files, adapters: [manifestActivationAdapter] })

const detectOn = (files: Readonly<Record<string, string>>) => {
  const host = createMemoryHost({
    files: Object.fromEntries(Object.entries(files).map(([file, text]) => [`${ROOT}/${file}`, text])),
  })
  const env = createEnv({ ts, config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }), host })
  return detectManifestActivation(createProjectContext(env))
}

const detectionsOn = (files: Readonly<Record<string, string>>) =>
  runDetection({
    ts,
    root: ROOT,
    host: createMemoryHost({
      files: Object.fromEntries(Object.entries(files).map(([file, text]) => [`${ROOT}/${file}`, text])),
    }),
  }).detections

const byKindTag = (screens: readonly Screen[], kindTag: string): readonly Screen[] =>
  screens.filter((screen) => screen.kindTag === kindTag)

const entryFilesOf = (screen: Screen | undefined): readonly string[] =>
  (screen?.entries ?? []).flatMap((entry) => (entry.kind === "file" ? [entry.file] : []))

const hostsOf = (screen: Screen | undefined): readonly string[] =>
  (screen?.activations ?? []).flatMap((activation: Activation) =>
    activation.kind === "host" ? [activation.pattern] : [],
  )

// ---------------------------------------------------------------------------
// An MV3 extension manifest
// ---------------------------------------------------------------------------

const MANIFEST = JSON.stringify(
  {
    manifest_version: 3,
    name: "Acme Dashboard",
    action: { default_popup: "index.html" },
    background: { service_worker: "assets/background.js", type: "module" },
    content_scripts: [
      {
        matches: ["https://*.example.com/*", "https://app.example.com/*"],
        js: ["assets/content-run.js"],
      },
      {
        matches: ["https://lab.example.org/*"],
        js: ["assets/uidl-interceptor.js"],
        run_at: "document_start",
      },
    ],
  },
  null,
  2,
)

const PWA_MANIFEST = JSON.stringify({ name: "Acme Dashboard", start_url: "/", display: "standalone" })

const POPUP_HTML = `<!doctype html>
<html>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`

const FILES = {
  "public/manifest.json": MANIFEST,
  "index.html": POPUP_HTML,
  "src/main.tsx": 'import App from "./App"\nexport const boot = () => <App />\n',
  "src/App.tsx": "export default function App() { return <div /> }\n",
  "src/background.ts": "export const wake = () => 1\n",
  "src/content-run.ts": "export const inject = () => 2\n",
  "src/content/uidl-interceptor.ts": "export const patch = () => 3\n",
} as const

describe("manifest-activation: content script host patterns", () => {
  it("turns content_scripts[].matches into host activations on the injected script's screen", () => {
    const screens = byKindTag(analyze(FILES).graph.screens, "contentScript")

    expect(screens).toHaveLength(2)
    const injected = screens.find((screen) => entryFilesOf(screen).includes("src/content-run.ts"))
    expect(hostsOf(injected)).toEqual(["https://*.example.com/*", "https://app.example.com/*"])
  })

  it("keeps one content script's patterns off another's screen", () => {
    const screens = byKindTag(analyze(FILES).graph.screens, "contentScript")
    const interceptor = screens.find((screen) =>
      entryFilesOf(screen).includes("src/content/uidl-interceptor.ts"),
    )

    expect(hostsOf(interceptor)).toEqual(["https://lab.example.org/*"])
    expect(hostsOf(interceptor)).not.toContain("https://app.example.com/*")
  })

  it("has no url and is not addressable — a host pattern is not a URL to navigate to", () => {
    for (const screen of analyze(FILES).graph.screens) {
      expect(screen.url).toBeNull()
      expect(screen.addressable).toBe(false)
    }
  })

  it("maps a BUILT asset name onto its unique source file and says which manifest key it came from", () => {
    const screens = byKindTag(analyze(FILES).graph.screens, "contentScript")
    const injected = screens.find((screen) => entryFilesOf(screen).includes("src/content-run.ts"))

    expect(injected?.provenance.evidence.map((entry) => entry.what)).toContain(
      "manifest content_scripts[0].js[0]",
    )
    expect(codes(analyze(FILES))).not.toContain("screens/unresolvable-script")
  })
})

describe("manifest-activation: popup and background surfaces", () => {
  it("follows action.default_popup through the HTML's script tag to the popup module", () => {
    const popup = byKindTag(analyze(FILES).graph.screens, "popup")[0]

    expect(entryFilesOf(popup)).toEqual(["src/main.tsx"])
    expect(popup?.activations).toEqual([])
  })

  it("roots the background surface in the service worker's source file", () => {
    const background = byKindTag(analyze(FILES).graph.screens, "background")[0]
    expect(entryFilesOf(background)).toEqual(["src/background.ts"])
  })

  it("gives every surface a localId anchored on the manifest, in surface order", () => {
    expect(analyze(FILES).graph.screens.map((screen) => screen.localId).sort()).toEqual([
      "public/manifest.json#0",
      "public/manifest.json#1",
      "public/manifest.json#2",
      "public/manifest.json#3",
    ])
  })
})

describe("manifest-activation: detect", () => {
  // `state-screens` scores 51 on the SAME file, and two live sources would make every browser extension
  // trip the multi-source refusal on a bare `appgraph` run. So this source scores in the last-resort tier
  // and reaches the run as the `browser-extension` preset's companion to `state-screens`.
  it("scores in the last-resort tier for a manifest_version: 3 file with at least one surface", () => {
    const result = detectOn(FILES)

    expect(result.score).toBe(DETECT_SCORE_LAST_RESORT)
    expect(result.score).toBeLessThan(LIVE_SOURCE_SCORE)
    expect(result.evidence).toEqual([
      { what: '"manifest_version": 3', file: "public/manifest.json", line: 2 },
    ])
  })

  it("is never live on its own, so an MV3 repo has exactly one live source", () => {
    const detections = detectionsOn(FILES)

    expect(detections.filter((entry) => entry.live).map((entry) => entry.source)).toEqual([
      "state-screens",
    ])
    expect(detections.find((entry) => entry.source === SOURCE_NAME)?.score).toBe(
      DETECT_SCORE_LAST_RESORT,
    )
  })

  it("is selected anyway: the browser-extension preset names it beside state-screens", () => {
    expect(PRESETS["browser-extension"].screenSources).toEqual([
      "state-screens",
      "manifest-activation",
    ])
    expect(presetForSource(SOURCE_NAME)?.name).toBe("browser-extension")
  })

  // A real extension repo can hold several manifest.json files, some of them PWA manifests.
  it("scores 0 for a PWA manifest.json with no manifest_version — the FIELD, not the filename", () => {
    const result = detectOn({ "public/manifest.json": PWA_MANIFEST })

    expect(result.score).toBe(0)
    expect(result.evidence).toEqual([])
    expect(analyze({ "public/manifest.json": PWA_MANIFEST }).graph.screens).toEqual([])
  })

  it("scores 0 for an MV3 manifest that declares no surface at all", () => {
    expect(detectOn({ "public/manifest.json": JSON.stringify({ manifest_version: 3, name: "x" }) }).score).toBe(0)
  })

  it("never sees a manifest under build output", () => {
    const buildOutput = { "dist/manifest.json": MANIFEST, "builds/mv3/manifest.json": MANIFEST }

    expect(detectOn(buildOutput).score).toBe(0)
    expect(analyze(buildOutput).graph.screens).toEqual([])
  })

  it("is unmoved by a manifest_version given as a string", () => {
    expect(
      detectOn({
        "public/manifest.json": JSON.stringify({ manifest_version: "3", action: { default_popup: "p.html" } }),
      }).score,
    ).toBe(0)
  })
})

describe("manifest-activation: holes stay visible", () => {
  it("warns and mints an opaque entry when a script maps to no source file", () => {
    const result = analyze({
      "public/manifest.json": JSON.stringify({
        manifest_version: 3,
        content_scripts: [{ matches: ["https://example.com/*"], js: ["assets/ghost.js"] }],
      }),
    })

    const diagnostic = result.diagnostics.find((entry) => entry.code === "screens/unresolvable-script")
    expect(diagnostic?.severity).toBe("warning")
    expect(diagnostic?.message).toContain("assets/ghost.js")
    expect(result.graph.screens[0]?.entries[0]?.kind).toBe("opaque")
    expect(codes(result)).toContain("screens/opaque-entry")
    expect(hostsOf(result.graph.screens[0])).toEqual(["https://example.com/*"])
  })

  it("refuses to choose between two files with the injected script's basename", () => {
    const result = analyze({
      "public/manifest.json": JSON.stringify({
        manifest_version: 3,
        content_scripts: [{ matches: ["https://example.com/*"], js: ["assets/inject.js"] }],
      }),
      "src/a/inject.ts": "export const a = 1\n",
      "src/b/inject.ts": "export const b = 2\n",
    })

    const diagnostic = result.diagnostics.find((entry) => entry.code === "screens/unresolvable-script")
    expect(diagnostic?.message).toContain("src/a/inject.ts")
    expect(diagnostic?.message).toContain("src/b/inject.ts")
  })

  it("reports which link of the popup chain broke instead of inventing a module", () => {
    const result = analyze({
      "public/manifest.json": JSON.stringify({ manifest_version: 3, action: { default_popup: "index.html" } }),
    })

    const diagnostic = result.diagnostics.find((entry) => entry.code === "screens/unresolvable-script")
    expect(diagnostic?.message).toContain("html")
  })

  it("reports a popup HTML whose script tag points nowhere", () => {
    const result = analyze({
      "public/manifest.json": JSON.stringify({ manifest_version: 3, action: { default_popup: "index.html" } }),
      "index.html": '<script type="module" src="/src/missing.tsx"></script>',
    })

    const diagnostic = result.diagnostics.find((entry) => entry.code === "screens/unresolvable-script")
    expect(diagnostic?.message).toContain("script")
  })
})

// ---------------------------------------------------------------------------
// The offscreen document — the fourth MV3 surface
// ---------------------------------------------------------------------------

const OFFSCREEN_MANIFEST = JSON.stringify(
  {
    manifest_version: 3,
    name: "Acme Dashboard",
    permissions: ["identity", "offscreen", "storage"],
    background: { service_worker: "assets/background.js", type: "module" },
    web_accessible_resources: [{ resources: ["assets/*"], matches: ["https://example.com/*"] }, { resources: ["offscreen.html"], matches: ["https://example.com/*"] }],
  },
  null,
  2,
)

const VITE_CONFIG = [
  "import { resolve } from 'path'",
  "export default {",
  "  build: {",
  "    rollupOptions: {",
  "      input: {",
  "        background: resolve(__dirname, 'src/background.ts'),",
  "        offscreen: resolve(__dirname, 'src/offscreen.ts'),",
  "        'content-run': resolve(__dirname, 'src/content-run.ts'),",
  "        content: resolve(__dirname, 'src/content/index.tsx'),",
  "      },",
  "    },",
  "  },",
  "}",
].join("\n")

const OFFSCREEN_FILES = {
  "public/manifest.json": OFFSCREEN_MANIFEST,
  "public/offscreen.html": '<!doctype html>\n<script src="offscreen.js" type="module"></script>\n',
  "src/offscreen.ts": "export const boot = () => 1\n",
  "src/background.ts": "export const wake = () => 2\n",
  "vite.config.ts": VITE_CONFIG,
} as const

describe("manifest-activation: the offscreen document is a surface", () => {
  it("models it from the offscreen permission and the HTML it makes reachable", () => {
    const offscreen = byKindTag(analyze(OFFSCREEN_FILES).graph.screens, "offscreen")

    expect(offscreen).toHaveLength(1)
    expect(entryFilesOf(offscreen[0])).toEqual(["src/offscreen.ts"])
    expect(offscreen[0]?.activations).toEqual([])
  })

  it("cites the permission-or-resource literal it came from", () => {
    const offscreen = byKindTag(analyze(OFFSCREEN_FILES).graph.screens, "offscreen")[0]

    expect(offscreen?.provenance.evidence.map((entry) => entry.what)).toContain(
      "manifest permissions [\"offscreen\"] document 'offscreen.html'",
    )
  })

  it("is appended after the other surfaces, so no existing localId is renumbered", () => {
    const screens = analyze(OFFSCREEN_FILES).graph.screens
    const background = byKindTag(screens, "background")[0]
    const offscreen = byKindTag(screens, "offscreen")[0]

    expect(background?.localId).toBe("public/manifest.json#0")
    expect(offscreen?.localId).toBe("public/manifest.json#1")
  })

  it("is absent when the manifest never asks for the offscreen permission", () => {
    expect(byKindTag(analyze(FILES).graph.screens, "offscreen")).toEqual([])
  })

  it("reports the broken chain rather than inventing a module", () => {
    const result = analyze({
      "public/manifest.json": OFFSCREEN_MANIFEST,
      "src/background.ts": "export const wake = () => 2\n",
    })

    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "screens/unresolvable-script" && entry.message.includes("offscreen"),
    )
    expect(diagnostic?.severity).toBe("warning")
    expect(byKindTag(result.graph.screens, "offscreen")[0]?.entries[0]?.kind).toBe("opaque")
  })
})

// ---------------------------------------------------------------------------
// Built asset name → source entry
// ---------------------------------------------------------------------------

describe("manifest-activation: the bundler's input map is read, not guessed", () => {
  it("resolves a built name whose source file shares no basename with it", () => {
    const result = analyze({
      ...OFFSCREEN_FILES,
      "public/manifest.json": JSON.stringify({
        manifest_version: 3,
        content_scripts: [{ matches: ["https://example.com/*"], js: ["assets/content.js"] }],
      }),
      "src/content/index.tsx": "export const Content = () => <div />\n",
    })

    expect(entryFilesOf(byKindTag(result.graph.screens, "contentScript")[0])).toContain("src/content/index.tsx")
    expect(codes(result)).not.toContain("screens/unresolvable-script")
  })

  it("cites the config entry it resolved through", () => {
    const result = analyze({
      ...OFFSCREEN_FILES,
      "public/manifest.json": JSON.stringify({
        manifest_version: 3,
        content_scripts: [{ matches: ["https://example.com/*"], js: ["assets/content.js"] }],
      }),
      "src/content/index.tsx": "export const Content = () => <div />\n",
    })

    expect(
      byKindTag(result.graph.screens, "contentScript")[0]?.provenance.evidence.map((entry) => entry.what),
    ).toContain("bundler input 'content'")
  })

  it("refuses a name two configs map to different files, and resolves it when only one does", () => {
    const files = {
      "public/manifest.json": JSON.stringify({
        manifest_version: 3,
        content_scripts: [{ matches: ["https://example.com/*"], js: ["assets/content.js"] }],
      }),
      "vite.config.ts": "export default { build: { rollupOptions: { input: { content: 'src/a/entry.ts' } } } }",
      "src/a/entry.ts": "export const a = 1\n",
      "src/b/entry.ts": "export const b = 2\n",
    }

    expect(entryFilesOf(analyze(files).graph.screens[0])).toEqual(["src/a/entry.ts"])

    const contested = analyze({ ...files, "rollup.config.ts": "export default { input: { content: 'src/b/entry.ts' } }" })
    expect(contested.graph.screens[0]?.entries[0]?.kind).toBe("opaque")
    expect(codes(contested)).toContain("screens/unresolvable-script")
  })
})

// ---------------------------------------------------------------------------
// The loader stub
// ---------------------------------------------------------------------------

const LOADER_MANIFEST = JSON.stringify({
  manifest_version: 3,
  content_scripts: [{ matches: ["https://example.com/*"], js: ["assets/content-run.js"] }],
})

const LOADER_STUB = [
  "if (!document.getElementById('root')) {",
  "  void (async () => {",
  "    const src = chrome.runtime.getURL('assets/content.js')",
  "    await import(src)",
  "  })()",
  "}",
].join("\n")

describe("manifest-activation: a content script that loads its real module at runtime", () => {
  const LOADER_FILES = {
    "public/manifest.json": LOADER_MANIFEST,
    "src/content-run.ts": LOADER_STUB,
    "src/content/index.tsx": "import Content from './Content'\nexport const boot = () => <Content />\n",
    "src/content/Content.tsx": "export default function Content() { return <div data-testid='content-root' /> }\n",
    "vite.config.ts": VITE_CONFIG,
  } as const

  it("follows chrome.runtime.getURL through the bundler input to the real entry", () => {
    const screen = byKindTag(analyze(LOADER_FILES).graph.screens, "contentScript")[0]

    expect(entryFilesOf(screen)).toEqual(["src/content-run.ts", "src/content/index.tsx"])
    expect(screen?.reachable).toContain("src/content/Content.tsx")
  })

  it("cites the runtime URL and the input it mapped to", () => {
    const screen = byKindTag(analyze(LOADER_FILES).graph.screens, "contentScript")[0]

    expect(screen?.provenance.evidence.map((entry) => entry.what)).toContain(
      "runtime.getURL('assets/content.js') -> bundler input 'content'",
    )
  })

  it("says so instead of staying silent when the loaded module cannot be resolved", () => {
    const result = analyze({
      "public/manifest.json": LOADER_MANIFEST,
      "src/content-run.ts": LOADER_STUB,
      "src/content/index.tsx": "export const boot = () => 1\n",
    })

    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "screens/unresolvable-script" && entry.message.includes("at runtime"),
    )
    expect(diagnostic?.severity).toBe("warning")
    expect(diagnostic?.message).toContain("assets/content.js")
  })

  it("does not mistake a getURL for an image in a module with no dynamic import", () => {
    const result = analyze({
      "public/manifest.json": LOADER_MANIFEST,
      "src/content-run.ts": "const icon = chrome.runtime.getURL('assets/content.js')\nexport const url = icon\n",
      "src/content/index.tsx": "export const boot = () => 1\n",
      "vite.config.ts": VITE_CONFIG,
    })

    expect(entryFilesOf(byKindTag(result.graph.screens, "contentScript")[0])).toEqual(["src/content-run.ts"])
    expect(codes(result)).not.toContain("screens/unresolvable-script")
  })
})
