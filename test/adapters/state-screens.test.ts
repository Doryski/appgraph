import ts from "typescript"
import { describe, expect, it } from "vitest"
import { resolveConfig } from "../../src/config/types.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { Screen, TreeNode } from "../../src/core/model.js"
import { createEnv, createProjectContext } from "../../src/pipeline/context.js"
import {
  DETECT_SCORE_LAST_RESORT,
  DETECT_SCORE_MV3_BONUS,
  createStateScreensAdapter,
  detectStateScreens,
} from "../../src/adapters/state-screens.js"
import { ROOT, codes, run } from "../pipeline/harness.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Holder = { readonly file: string; readonly exportName?: string }

const analyze = (files: Readonly<Record<string, string>>, entryComponents?: readonly Holder[]) =>
  run({
    files,
    adapters: [
      createStateScreensAdapter(entryComponents === undefined ? {} : { entryComponents }),
    ],
  })

const screensOf = (files: Readonly<Record<string, string>>, entryComponents?: readonly Holder[]) =>
  analyze(files, entryComponents).graph.screens

const exprsOf = (screens: readonly Screen[]): readonly string[] =>
  screens.flatMap((screen) =>
    screen.activations.flatMap((activation) => (activation.kind === "state" ? [activation.expr] : [])),
  )

const flatten = (nodes: readonly TreeNode[]): readonly TreeNode[] =>
  nodes.flatMap((node) => [node, ...flatten(node.children)])

const filesInTree = (screen: Screen): readonly string[] => flatten(screen.tree).map((node) => node.file)

const screenRendering = (screens: readonly Screen[], file: string): Screen | undefined =>
  screens.find((screen) => filesInTree(screen).includes(file))

const detectOn = (files: Readonly<Record<string, string>>) => {
  const host = createMemoryHost({
    files: Object.fromEntries(Object.entries(files).map(([file, text]) => [`${ROOT}/${file}`, text])),
  })
  const env = createEnv({ ts, config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }), host })
  return detectStateScreens(createProjectContext(env))
}

const PANELS = {
  "src/ui/Spinner.tsx": "export default function Spinner() { return <div /> }\n",
  "src/ui/ErrorPanel.tsx": "export default function ErrorPanel() { return <div /> }\n",
  "src/ui/ResultDialog.tsx": "export default function ResultDialog() { return <div /> }\n",
} as const

const CONTENT_FILE = "src/content/Content.tsx"

const CONTENT_IMPORTS = `import Spinner from "../ui/Spinner"
import ErrorPanel from "../ui/ErrorPanel"
import ResultDialog from "../ui/ResultDialog"
`

/** An extension's `content/Content.tsx`: three panels selected in ONE file. */
const CONTENT = `${CONTENT_IMPORTS}
export const Content = () => {
  const state = useViewState()
  return (
    <div>
      {state === 'loading' && <Spinner />}
      {state === 'error' && <ErrorPanel />}
      {state === 'ready' && <ResultDialog />}
    </div>
  )
}
`

const contentFiles = (text: string) => ({ ...PANELS, [CONTENT_FILE]: text })

const CONTENT_HOLDER: readonly Holder[] = [{ file: CONTENT_FILE, exportName: "Content" }]

const contentScreens = (text: string = CONTENT) => screensOf(contentFiles(text), CONTENT_HOLDER)

// ---------------------------------------------------------------------------
// Three branches in one file
// ---------------------------------------------------------------------------

describe("state-screens: guarded branches in one file", () => {
  it("emits one screen per guarded branch with a state activation naming the holder", () => {
    const screens = contentScreens()

    expect(screens).toHaveLength(3)
    expect(exprsOf(screens)).toEqual([
      "state === 'loading'",
      "state === 'error'",
      "state === 'ready'",
    ])
    for (const screen of screens)
      expect(screen.activations).toEqual([
        { kind: "state", holder: "Content", expr: exprsOf([screen])[0] },
      ])
  })

  it("gives every screen a locator into the branch, not just the file", () => {
    for (const screen of contentScreens())
      for (const entry of screen.entries) {
        expect(entry.kind).toBe("file")
        if (entry.kind !== "file") continue
        expect(entry.file).toBe(CONTENT_FILE)
        expect(entry.at?.export).toBe("Content")
        expect(entry.at?.path.length).toBeGreaterThan(0)
      }
  })

  // Without `EntryRef.at` these three screens would be byte-identical.
  it("gives three roots in the SAME file three DIFFERENT trees", () => {
    const screens = contentScreens()
    const trees = screens.map((screen) => JSON.stringify(screen.tree))

    expect(new Set(trees).size).toBe(3)
    expect(filesInTree(screens[0] as Screen)).toContain("src/ui/Spinner.tsx")
    expect(filesInTree(screens[0] as Screen)).not.toContain("src/ui/ErrorPanel.tsx")
    expect(filesInTree(screens[1] as Screen)).toContain("src/ui/ErrorPanel.tsx")
    expect(filesInTree(screens[1] as Screen)).not.toContain("src/ui/Spinner.tsx")
    expect(filesInTree(screens[2] as Screen)).toContain("src/ui/ResultDialog.tsx")
  })

  it("never repeats a screen's own activation guard as a condition on its child nodes", () => {
    for (const screen of contentScreens())
      for (const node of flatten(screen.tree)) expect(node.conditions).toEqual([])
  })

  it("does not emit the unguarded wrapper as a fourth screen", () => {
    expect(codes(analyze(contentFiles(CONTENT), CONTENT_HOLDER))).not.toContain("screens/unresolvable-locator")
    expect(contentScreens().map((screen) => screen.localId)).toEqual([
      `${CONTENT_FILE}#0`,
      `${CONTENT_FILE}#1`,
      `${CONTENT_FILE}#2`,
    ])
  })
})

// ---------------------------------------------------------------------------
// Identity: structural, never the guard text
// ---------------------------------------------------------------------------

const RENAMED = CONTENT.replace(/state/g, "viewState")

const REFORMATTED = `${CONTENT_IMPORTS}
export const Content = () => {
  const state = useViewState()

  return (
    <div>
      {state === 'loading' && (
        <Spinner
        />
      )}

      {state === 'error' && <ErrorPanel />}

      {state === 'ready' && (
        <ResultDialog />
      )}
    </div>
  )
}
`

const REORDERED = `${CONTENT_IMPORTS}
export const Content = () => {
  const state = useViewState()
  return (
    <div>
      {state === 'error' && <ErrorPanel />}
      {state === 'loading' && <Spinner />}
      {state === 'ready' && <ResultDialog />}
    </div>
  )
}
`

const localIdRendering = (text: string, file: string): string | undefined =>
  screenRendering(contentScreens(text), file)?.localId

describe("state-screens: localId is structural", () => {
  it("survives RENAMING the guard variable", () => {
    expect(exprsOf(contentScreens(RENAMED))).toContain("viewState === 'loading'")
    expect(localIdRendering(RENAMED, "src/ui/Spinner.tsx")).toBe(`${CONTENT_FILE}#0`)
    expect(localIdRendering(RENAMED, "src/ui/ResultDialog.tsx")).toBe(`${CONTENT_FILE}#2`)
  })

  it("survives REFORMATTING the file", () => {
    expect(localIdRendering(REFORMATTED, "src/ui/Spinner.tsx")).toBe(`${CONTENT_FILE}#0`)
    expect(localIdRendering(REFORMATTED, "src/ui/ResultDialog.tsx")).toBe(`${CONTENT_FILE}#2`)
  })

  it("changes when the BRANCH ORDER changes, and only then", () => {
    expect(localIdRendering(REORDERED, "src/ui/Spinner.tsx")).toBe(`${CONTENT_FILE}#1`)
    expect(localIdRendering(REORDERED, "src/ui/ErrorPanel.tsx")).toBe(`${CONTENT_FILE}#0`)
  })

  it("lets an `@appgraph-id` pragma pin a branch against reordering (escape hatch)", () => {
    const pinned = `${CONTENT_IMPORTS}
export const Content = () => {
  const state = useViewState()
  return (
    <div>
      {state === 'loading' && /* @appgraph-id loading */ <Spinner />}
      {state === 'error' && <ErrorPanel />}
    </div>
  )
}
`
    expect(localIdRendering(pinned, "src/ui/Spinner.tsx")).toBe(`${CONTENT_FILE}#loading`)
  })
})

// ---------------------------------------------------------------------------
// The two selection shapes of an extension app
// ---------------------------------------------------------------------------

const APP_PAGES = {
  "src/pages/MainPage.tsx": "export default function MainPage() { return <div /> }\n",
  "src/pages/Login.tsx": "export default function Login() { return <div /> }\n",
} as const

const APP_FILE = "src/App.tsx"

const TERNARY_APP = `import MainPage from "./pages/MainPage"
import Login from "./pages/Login"

export default function App() {
  const { isAuthenticated } = useAuth()
  return isAuthenticated ? <MainPage /> : <Login />
}
`

const EARLY_RETURN_APP = `import MainPage from "./pages/MainPage"
import Login from "./pages/Login"

export default function App() {
  const { isAuthenticated, isAuthCheckComplete } = useAuth()

  if (!isAuthCheckComplete) {
    return <Spinner />
  }

  if (isAuthenticated) {
    return <MainPage />
  }

  return <Login />
}
`

const appScreens = (text: string) => screensOf({ ...APP_PAGES, [APP_FILE]: text }, [{ file: APP_FILE }])

describe("state-screens: both selection shapes", () => {
  it("turns BOTH ternary branches into screens, the else branch negated", () => {
    const screens = appScreens(TERNARY_APP)

    expect(exprsOf(screens)).toEqual(["isAuthenticated", "!(isAuthenticated)"])
    expect(screens.map((screen) => screen.activations[0])).toEqual([
      { kind: "state", holder: "App", expr: "isAuthenticated" },
      { kind: "state", holder: "App", expr: "!(isAuthenticated)" },
    ])
    expect(filesInTree(screenRendering(screens, "src/pages/Login.tsx") as Screen)).toContain(
      "src/pages/Login.tsx",
    )
  })

  it("gives the two ternary branches different trees out of one file", () => {
    const screens = appScreens(TERNARY_APP)
    expect(new Set(screens.map((screen) => JSON.stringify(screen.tree))).size).toBe(2)
  })

  it("reads a sequence of early returns, negating the guards the fall-through survived", () => {
    const screens = appScreens(EARLY_RETURN_APP)

    expect(exprsOf(screens)).toEqual([
      "!isAuthCheckComplete",
      "!(!isAuthCheckComplete) && isAuthenticated",
      "!(!isAuthCheckComplete) && !(isAuthenticated)",
    ])
    expect(screenRendering(screens, "src/pages/Login.tsx")?.activations[0]).toEqual({
      kind: "state",
      holder: "App",
      expr: "!(!isAuthCheckComplete) && !(isAuthenticated)",
    })
  })

  it("keeps an early return's own guard off its subtree", () => {
    for (const screen of appScreens(EARLY_RETURN_APP))
      for (const node of flatten(screen.tree)) expect(node.conditions).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Detection — the FIELD, not the filename
// ---------------------------------------------------------------------------

const PWA_MANIFEST = JSON.stringify({
  name: "Acme Dashboard",
  short_name: "Acme Dashboard",
  icons: [],
  start_url: "/",
  display: "standalone",
})

const MV3_MANIFEST = JSON.stringify(
  {
    manifest_version: 3,
    name: "Acme Dashboard",
    action: { default_popup: "index.html" },
    background: { service_worker: "assets/background.js", type: "module" },
    content_scripts: [{ matches: ["https://*.example.com/*"], js: ["assets/content-run.js"] }],
  },
  null,
  2,
)

describe("state-screens: detect", () => {
  it("is a last resort of 1 on an app with no manifest at all", () => {
    const result = detectOn({ "src/App.tsx": TERNARY_APP })

    expect(result.score).toBe(DETECT_SCORE_LAST_RESORT)
    expect(result.evidence).toEqual([])
  })

  it("adds the MV3 bonus for a manifest_version: 3 file", () => {
    const result = detectOn({ "public/manifest.json": MV3_MANIFEST })

    expect(result.score).toBe(DETECT_SCORE_LAST_RESORT + DETECT_SCORE_MV3_BONUS)
    expect(result.evidence).toEqual([
      { what: '"manifest_version": 3', file: "public/manifest.json", line: 2 },
    ])
  })

  it("does NOT add the bonus for a PWA manifest.json with no manifest_version", () => {
    expect(detectOn({ "public/manifest.json": PWA_MANIFEST }).score).toBe(DETECT_SCORE_LAST_RESORT)
  })

  it("ignores manifest.json files under build output", () => {
    expect(detectOn({ "dist/manifest.json": MV3_MANIFEST, "builds/v1/manifest.json": MV3_MANIFEST }).score).toBe(
      DETECT_SCORE_LAST_RESORT,
    )
  })

  it("keeps the PWA manifest from starving a real MV3 manifest beside it", () => {
    expect(
      detectOn({ "public/pwa/manifest.json": PWA_MANIFEST, "public/manifest.json": MV3_MANIFEST }).score,
    ).toBe(DETECT_SCORE_LAST_RESORT + DETECT_SCORE_MV3_BONUS)
  })
})

// ---------------------------------------------------------------------------
// Entry components: configured, derived, or diagnosed
// ---------------------------------------------------------------------------

const POPUP_HTML = `<!doctype html>
<html>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`

const MAIN = `import App from "./App"
import { createRoot } from "react-dom/client"

createRoot(document.body).render(<App />)
`

describe("state-screens: entry components", () => {
  it("follows manifest popup -> html -> script -> module to the holder component", () => {
    const screens = screensOf({
      ...APP_PAGES,
      "public/manifest.json": MV3_MANIFEST,
      "index.html": POPUP_HTML,
      "src/main.tsx": MAIN,
      [APP_FILE]: TERNARY_APP,
    })

    expect(exprsOf(screens)).toEqual(["isAuthenticated", "!(isAuthenticated)"])
  })

  it("diagnoses a broken popup chain instead of guessing a holder", () => {
    const result = analyze({
      "public/manifest.json": MV3_MANIFEST,
      [APP_FILE]: TERNARY_APP,
    })

    const diagnostic = result.diagnostics.find((entry) => entry.code === "screens/no-entry-component")
    expect(diagnostic?.severity).toBe("warning")
    expect(diagnostic?.message).toContain("html")
    expect(result.graph.screens).toEqual([])
  })

  it("says so when there is neither a configured holder nor a manifest", () => {
    const result = analyze({ [APP_FILE]: TERNARY_APP })

    expect(codes(result)).toContain("screens/no-entry-component")
    expect(result.graph.screens).toEqual([])
  })

  it("warns when a configured holder does not exist in its file", () => {
    const result = analyze({ [APP_FILE]: TERNARY_APP }, [{ file: APP_FILE, exportName: "Missing" }])

    const diagnostic = result.diagnostics.find((entry) => entry.code === "screens/no-entry-component")
    expect(diagnostic?.message).toContain("Missing")
  })

  it("records a near-miss for a holder that has no guarded branch at all", () => {
    const result = analyze(
      { "src/ui/Plain.tsx": "export const Plain = () => <div>always</div>\n" },
      [{ file: "src/ui/Plain.tsx", exportName: "Plain" }],
    )

    expect(result.graph.screens).toEqual([])
    expect(result.trace).toContain("no guarded top-level JSX branch")
  })
})
