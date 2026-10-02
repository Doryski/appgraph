import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import type { CliDeps } from "../../src/cli/index.js"
import { runCli } from "../../src/cli/index.js"
import { FINGERPRINT_FILE, parseSidecar } from "../../src/cli/stale.js"
import { GRAPH_CACHE_FILE, decodeGraphCache } from "../../src/emit/graph-cache.js"
import { PIPELINE_PHASES } from "../../src/pipeline/run.js"

const ROOT = "/repo"

const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: ".", jsx: "react-jsx" }, include: ["src"] })

const PACKAGE = JSON.stringify({ name: "fixture", dependencies: { "react-router-dom": "6.0.0" } })

const ROUTER = `import { createBrowserRouter } from "react-router-dom"
import Home from "./pages/Home"
import About from "./pages/About"

export const router = createBrowserRouter([
  { path: "/home", element: <Home /> },
  { path: "/about", element: <About /> },
])
`

const page = (name: string): string =>
  `export default function ${name}() {\n  return <section data-testid="${name.toLowerCase()}" />\n}\n`

const MV3 = JSON.stringify({ manifest_version: 3, action: { default_popup: "popup.html" } }, null, 2)

// The popup chain has to actually resolve: `manifest-activation` runs beside `state-screens` as the
// browser-extension preset's companion, and a broken chain is an honest `screens/opaque-entry` error —
// which would make --all-sources exit non-zero for a reason that has nothing to do with the refusal.
const EXTENSION_FILES: Readonly<Record<string, string>> = {
  "public/manifest.json": MV3,
  "public/popup.html": '<script type="module" src="/src/popup.tsx"></script>',
  "src/popup.tsx": "export default function Popup() {\n  return <main />\n}\n",
}

const BASE_FILES: Readonly<Record<string, string>> = {
  "package.json": PACKAGE,
  "tsconfig.json": TSCONFIG,
  "src/router.tsx": ROUTER,
  "src/pages/Home.tsx": page("Home"),
  "src/pages/About.tsx": page("About"),
}

type Bench = {
  readonly deps: CliDeps
  readonly out: string[]
  readonly err: string[]
  readonly written: Map<string, string>
}

const bench = (extra: Readonly<Record<string, string>> = {}, now = "2026-01-01T00:00:00.000Z"): Bench => {
  const out: string[] = []
  const err: string[] = []
  const written = new Map<string, string>()
  const files = Object.fromEntries(
    Object.entries({ ...BASE_FILES, ...extra }).map(([file, text]) => [`${ROOT}/${file}`, text]),
  )

  return {
    out,
    err,
    written,
    deps: {
      host: createMemoryHost({ files }),
      writer: { out: (line) => out.push(line), err: (line) => err.push(line) },
      writeFile: (absPath, content) => {
        written.set(absPath, content)
      },
      cwd: ROOT,
      version: "0.1.0-test",
      now: () => now,
    },
  }
}

const fileOf = (harness: Bench, name: string): string => harness.written.get(`${ROOT}/docs/appgraph/${name}`) ?? ""

describe("the wired CLI runs the built-in sources end to end", () => {
  it("finds the react-router screens with no config and no injected adapters", async () => {
    const harness = bench()
    const code = await runCli(["--root", ROOT], harness.deps)

    expect(code).toBe(0)
    expect(fileOf(harness, "appgraph.index.yaml")).toContain("/home")
    expect(fileOf(harness, "appgraph.index.yaml")).toContain("/about")
    expect(fileOf(harness, "appgraph.html")).toContain("<html")
    expect(fileOf(harness, "appgraph.yaml")).toBe("")
    expect(harness.out.join("\n")).toContain("screens=2")
  })

  it("writes a graph cache that decodes to the analysed screens, and the sidecar that judges it", async () => {
    const harness = bench()
    expect(await runCli(["--root", ROOT, "--format", "index"], harness.deps)).toBe(0)

    const graph = decodeGraphCache(fileOf(harness, GRAPH_CACHE_FILE))
    expect(graph.screens.map((screen) => screen.url).sort()).toEqual(["/about", "/home"])
    expect(graph.meta.schemaVersion).toBe(2)
    expect(parseSidecar(fileOf(harness, FINGERPRINT_FILE))?.graph).toMatchObject({ tsconfigFiles: ["tsconfig.json"] })
  })
})

describe("--all-sources", () => {
  it("refuses to choose between two live sources, and stops refusing when --all-sources is given", async () => {
    const refused = bench(EXTENSION_FILES)
    const refusedCode = await runCli(["--root", ROOT], refused.deps)

    expect(refusedCode).toBe(1)
    expect(refused.err.join("\n")).toContain("project/multiple-screen-sources")
    // The refusal writes NOTHING, and prints the full trace instead of a summary.
    expect(refused.written.size).toBe(0)
    expect(refused.err.join("\n")).toContain("No output file was written.")
    expect(refused.err.join("\n")).toContain("sources run:")
    expect(refused.out.join("\n")).not.toContain("screens=")

    const all = bench(EXTENSION_FILES)
    const allCode = await runCli(["--root", ROOT, "--all-sources"], all.deps)

    expect(allCode).toBe(0)
    expect(all.err.join("\n")).not.toContain("project/multiple-screen-sources")
  })
})

describe("meta.appName", () => {
  it("titles the report with the package name, not the root directory label", async () => {
    const harness = bench()

    // The two must differ, or the assertion cannot tell the wiring from the fallback.
    expect(ROOT.split("/").pop()).not.toBe("fixture")
    expect(await runCli(["--root", ROOT, "--format", "html", "--format", "full"], harness.deps)).toBe(0)

    expect(fileOf(harness, "appgraph.html")).toContain("<title>fixture — screen &amp; component map</title>")
    expect(fileOf(harness, "appgraph.yaml")).toContain("appName: fixture")
  })

  it("falls back to the root label when the manifest carries no name", async () => {
    const harness = bench({ "package.json": JSON.stringify({ dependencies: { "react-router-dom": "6.0.0" } }) })

    expect(await runCli(["--root", ROOT, "--format", "full"], harness.deps)).toBe(0)
    expect(fileOf(harness, "appgraph.yaml")).toContain("appName: repo")
  })
})

describe("--no-timestamp", () => {
  it("produces byte-identical HTML across two runs", async () => {
    const first = bench({}, "2026-01-01T00:00:00.000Z")
    const second = bench({}, "2027-07-07T07:07:07.000Z")

    expect(await runCli(["--root", ROOT, "--no-timestamp", "--format", "html"], first.deps)).toBe(0)
    expect(await runCli(["--root", ROOT, "--no-timestamp", "--format", "html"], second.deps)).toBe(0)

    const a = fileOf(first, "appgraph.html")
    expect(a).not.toBe("")
    expect(a).toBe(fileOf(second, "appgraph.html"))
    expect(a).not.toContain("2026-01-01T00:00:00.000Z")
  })

  it("carries the CLI's timestamp into the report when the flag is absent", async () => {
    const harness = bench({}, "2026-01-01T00:00:00.000Z")

    expect(await runCli(["--root", ROOT, "--format", "html"], harness.deps)).toBe(0)
    expect(fileOf(harness, "appgraph.html")).toContain("2026-01-01T00:00:00.000Z")
  })
})

describe("the fingerprint stays out of the artifact", () => {
  it("embeds no mtime-derived fingerprint in appgraph.yaml or the cache, and records it in the sidecar", async () => {
    const plain = bench()
    expect(await runCli(["--root", ROOT, "--format", "full"], plain.deps)).toBe(0)

    expect(fileOf(plain, "appgraph.yaml")).not.toMatch(/fingerprint:\s*"?[0-9a-f]{8,}/)
    expect(fileOf(plain, GRAPH_CACHE_FILE)).not.toMatch(/[0-9a-f]{64}/)

    const stale = bench()
    expect(await runCli(["--root", ROOT, "--format", "full", "--if-stale"], stale.deps)).toBe(0)
    const sidecar = parseSidecar(stale.written.get(`${ROOT}/docs/appgraph/${FINGERPRINT_FILE}`) ?? "")
    expect(sidecar?.run?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(sidecar?.graph?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(sidecar?.run?.artifacts).toEqual(["appgraph.graph.json", "appgraph.yaml"])
    expect(fileOf(stale, "appgraph.yaml")).toBe(fileOf(plain, "appgraph.yaml"))
  })

  it("produces a byte-identical graph cache under --no-timestamp across clocks", async () => {
    const first = bench({}, "2026-01-01T00:00:00.000Z")
    const second = bench({}, "2027-07-07T07:07:07.000Z")
    expect(await runCli(["--root", ROOT, "--no-timestamp", "--format", "index"], first.deps)).toBe(0)
    expect(await runCli(["--root", ROOT, "--format", "index"], second.deps)).toBe(0)
    expect(fileOf(first, GRAPH_CACHE_FILE)).not.toBe("")
    expect(fileOf(first, GRAPH_CACHE_FILE)).toBe(fileOf(second, GRAPH_CACHE_FILE))
  })

  it("produces a byte-identical appgraph.yaml under --no-timestamp when only source mtimes differ", async () => {
    const run = async (mtime: number): Promise<string> => {
      const harness = bench()
      const host = createMemoryHost({
        files: Object.fromEntries(Object.entries(BASE_FILES).map(([file, text]) => [`${ROOT}/${file}`, text])),
        mtimes: { [`${ROOT}/src/pages/Home.tsx`]: mtime },
      })
      expect(await runCli(["--root", ROOT, "--format", "full", "--no-timestamp"], { ...harness.deps, host })).toBe(0)
      return fileOf(harness, "appgraph.yaml")
    }

    expect(await run(1000)).toBe(await run(2000))
  })
})

describe("--locale", () => {
  it("renders the report in the locale without the CLI replacing the emitter set", async () => {
    const harness = bench()
    expect(await runCli(["--root", ROOT, "--locale", "pl", "--format", "html", "--format", "full"], harness.deps)).toBe(
      0,
    )

    expect(fileOf(harness, "appgraph.html")).toContain("Ekrany")
    // The detected test-id attribute still reaches the emitters: replacing them would have dropped it.
    expect(fileOf(harness, "appgraph.yaml")).toContain("data-testid")
  })
})

describe("doctor on a successful run", () => {
  it("prints the per-source detect scores, the globs and the test-id histogram", async () => {
    const harness = bench()
    const code = await runCli(["doctor", "--root", ROOT], harness.deps)
    const printed = harness.out.join("\n")

    expect(code).toBe(0)
    expect(harness.written.size).toBe(0)
    expect(printed).toContain("detection (score, live, evidence)")
    expect(printed).toContain("react-router  score 90  live")
    expect(printed).toContain("next-app  score 0  no")
    expect(printed).toContain("src/router.tsx")
    expect(printed).toContain("globs attempted")
    expect(printed).toContain("data-testid")
    expect(printed).toContain("screen sources that ran")
  })
})

const timingOf = (payload: unknown): Readonly<Record<string, unknown>> => {
  if (typeof payload !== "object" || payload === null || !("timing" in payload)) return {}
  const { timing } = payload
  return typeof timing === "object" && timing !== null ? Object.fromEntries(Object.entries(timing)) : {}
}

describe("--timing on the wired pipeline (P0)", () => {
  const tickingClock = () => {
    const state = { now: 0 }
    return () => {
      state.now += 1
      return state.now
    }
  }

  it("reports every CLI and pipeline phase in the JSON and on stderr", async () => {
    const harness = bench()
    const code = await runCli(["--root", ROOT, "--json", "--timing", "--format", "html"], {
      ...harness.deps,
      clock: tickingClock(),
    })

    expect(code).toBe(0)
    const timing = timingOf(JSON.parse(harness.out.join("")))
    const expected = ["fingerprint", "probe", ...PIPELINE_PHASES.filter((phase) => phase !== "walk-masked"), "tsconfig", "write", "total"]
    expect(Object.keys(timing)).toEqual(expected)
    expect(Object.values(timing).every((ms) => typeof ms === "number" && ms > 0)).toBe(true)
    expect(harness.err).toContain("appgraph: timing")
    expect(fileOf(harness, "appgraph.html")).toContain("<html")
  })

  it("adds timing to doctor --json only when asked", async () => {
    const plain = bench()
    await runCli(["doctor", "--root", ROOT, "--json"], plain.deps)
    expect(JSON.parse(plain.out.join(""))).not.toHaveProperty("timing")

    const timed = bench()
    await runCli(["doctor", "--root", ROOT, "--json", "--timing"], { ...timed.deps, clock: tickingClock() })
    expect(JSON.parse(timed.out.join(""))).toHaveProperty("timing.fingerprint")
    expect(JSON.parse(timed.out.join(""))).toHaveProperty("timing.discover")
  })
})
