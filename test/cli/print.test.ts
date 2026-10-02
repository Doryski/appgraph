import { describe, expect, it } from "vitest"
import type { Diagnostic, Severity } from "../../src/core/model.js"
import {
  countBySeverity,
  formatDiagnostic,
  formatDiagnostics,
  formatDoctor,
  formatSummary,
  formatWritten,
  sanitizeForTerminal,
} from "../../src/cli/print.js"
import type { DoctorReport } from "../../src/cli/print.js"

const diagnostic = (severity: Severity, code: string, message = "m", extra: Partial<Diagnostic> = {}): Diagnostic => ({
  severity,
  code,
  message,
  plugin: null,
  ...extra,
})

const baseReport = (overrides: Partial<DoctorReport> = {}): DoctorReport => ({
  appgraphVersion: "1.2.3",
  root: "/repo",
  rootReason: "--root flag",
  cwd: "/cwd",
  configFile: null,
  sourceRoots: [],
  tsconfig: null,
  templateCompilers: [],
  screenSources: [],
  sourcesRun: [],
  detections: [],
  globs: [],
  nearMisses: [],
  exclusions: [],
  nestedPackages: [],
  counts: {},
  confidence: [],
  navGroups: [],
  testIdAttributes: [],
  limitations: [],
  diagnostics: [],
  trace: "",
  fingerprint: null,
  fingerprintParts: [],
  failure: null,
  notes: [],
  ...overrides,
})

// eslint-disable-next-line no-control-regex
const CONTROL_ONLY = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

describe("cli/print sanitizeForTerminal", () => {
  it("escapes every C0 control except tab and newline, as lowercase two-digit hex", () => {
    for (let code = 0; code <= 0x1f; code++) {
      const char = String.fromCharCode(code)
      const out = sanitizeForTerminal(char)
      if (char === "\n" || char === "\t") {
        expect(out).toBe(char)
        continue
      }
      expect(out).toBe(`\\x${code.toString(16).padStart(2, "0")}`)
    }
  })

  it("escapes DEL and the whole C1 range 0x7f-0x9f, and nothing just outside it", () => {
    for (let code = 0x7f; code <= 0x9f; code++) {
      expect(sanitizeForTerminal(String.fromCharCode(code))).toBe(`\\x${code.toString(16)}`)
    }
    expect(sanitizeForTerminal(" ")).toBe(" ")
    expect(sanitizeForTerminal("~")).toBe("~")
  })

  it("escapes a carriage return, so a line cannot be overwritten in place", () => {
    expect(sanitizeForTerminal("ok\rEVIL")).toBe("ok\\x0dEVIL")
  })

  it("returns empty, plain and non-ASCII text unchanged", () => {
    expect(sanitizeForTerminal("")).toBe("")
    expect(sanitizeForTerminal("src/ścieżka/🙂.ts")).toBe("src/ścieżka/🙂.ts")
  })

  it("is idempotent: its own escapes contain no control characters to re-escape", () => {
    const once = sanitizeForTerminal("\u001b[2J\u0000\u009b")

    expect(sanitizeForTerminal(once)).toBe(once)
    expect(once).not.toMatch(CONTROL_ONLY)
  })
})

describe("cli/print formatDiagnostic", () => {
  it("renders code, message and the file with its line", () => {
    expect(formatDiagnostic(diagnostic("error", "a/b", "boom", { file: "src/x.ts", line: 7 }))).toBe(
      "    a/b  boom  src/x.ts:7",
    )
  })

  it("omits the location with no file, and the line when only a file is known", () => {
    expect(formatDiagnostic(diagnostic("info", "a/b", "boom"))).toBe("    a/b  boom")
    expect(formatDiagnostic(diagnostic("info", "a/b", "boom", { file: "src/x.ts" }))).toBe("    a/b  boom  src/x.ts")
  })

  it("keeps a line of 0 rather than treating it as absent", () => {
    expect(formatDiagnostic(diagnostic("info", "a/b", "boom", { file: "f.ts", line: 0 }))).toContain("f.ts:0")
  })
})

describe("cli/print formatDiagnostics", () => {
  const mixed = [
    diagnostic("info", "z/info"),
    diagnostic("warning", "b/warn", "second"),
    diagnostic("error", "e/two", "b"),
    diagnostic("warning", "b/warn", "first"),
    diagnostic("error", "e/one", "z"),
  ]

  it("groups errors, then warnings, then info, each with its count", () => {
    const lines = formatDiagnostics(mixed, { quiet: false })

    expect(lines.filter((line) => !line.startsWith("    "))).toEqual(["  errors (2):", "  warnings (2):", "  info (1):"])
  })

  it("sorts inside a group by code and then by message, regardless of input order", () => {
    const forward = formatDiagnostics(mixed, { quiet: false })
    const backward = formatDiagnostics([...mixed].reverse(), { quiet: false })

    expect(backward).toEqual(forward)
    expect(forward.indexOf("    e/one  z")).toBeLessThan(forward.indexOf("    e/two  b"))
    expect(forward.indexOf("    b/warn  first")).toBeLessThan(forward.indexOf("    b/warn  second"))
  })

  it("quiet keeps only errors", () => {
    const lines = formatDiagnostics(mixed, { quiet: true })

    expect(lines[0]).toBe("  errors (2):")
    expect(lines.join("\n")).not.toContain("warn")
    expect(lines.join("\n")).not.toContain("z/info")
  })

  it("returns nothing for no diagnostics, and for quiet with only non-errors", () => {
    expect(formatDiagnostics([], { quiet: false })).toEqual([])
    expect(formatDiagnostics([diagnostic("warning", "w/x")], { quiet: true })).toEqual([])
  })

  it("does not reorder the caller's array", () => {
    const input = [diagnostic("error", "b"), diagnostic("error", "a")]
    formatDiagnostics(input, { quiet: false })

    expect(input.map((entry) => entry.code)).toEqual(["b", "a"])
  })
})

describe("cli/print countBySeverity", () => {
  it("counts exactly the requested severity", () => {
    const all = [diagnostic("error", "a"), diagnostic("error", "b"), diagnostic("info", "c")]

    expect(countBySeverity(all, "error")).toBe(2)
    expect(countBySeverity(all, "info")).toBe(1)
    expect(countBySeverity(all, "warning")).toBe(0)
    expect(countBySeverity([], "error")).toBe(0)
  })
})

describe("cli/print formatWritten", () => {
  it("says so when nothing was written", () => {
    expect(formatWritten([], "docs/appgraph")).toEqual(["  wrote nothing to docs/appgraph"])
  })

  it("lists each file with bytes and KB (one decimal) and a total", () => {
    expect(
      formatWritten(
        [
          { path: "a.yaml", bytes: 1024 },
          { path: "b.html", bytes: 1536 },
        ],
        "out",
      ),
    ).toEqual([
      "  wrote 2 file(s) to out:",
      "    a.yaml  1024 B  (1.0 KB)",
      "    b.html  1536 B  (1.5 KB)",
      "  total 2560 B (2.5 KB)",
    ])
  })

  it("handles a zero-byte file", () => {
    expect(formatWritten([{ path: "e", bytes: 0 }], "o")).toContain("    e  0 B  (0.0 KB)")
  })
})

describe("cli/print formatSummary", () => {
  it("sorts counts by code point so output is deterministic", () => {
    expect(formatSummary({ root: "/r", formats: ["full", "html"], counts: { screens: 3, Zed: 1, api: 0 } })).toEqual([
      "appgraph /r  formats: full, html",
      "  Zed=1  api=0  screens=3",
    ])
  })

  it("drops the counts line when there are none", () => {
    expect(formatSummary({ root: "/r", formats: [], counts: {} })).toEqual(["appgraph /r  formats: "])
  })
})

describe("cli/print formatDoctor", () => {
  const text = (report: DoctorReport): string => formatDoctor(report).join("\n")

  it("renders every section with (none) placeholders for an empty report", () => {
    const out = text(baseReport())

    expect(out.startsWith("appgraph doctor — v1.2.3\n")).toBe(true)
    expect(out).toContain("  config file:  (none found)")
    expect(out).toContain("  source roots: (none)")
    expect(out).toContain("  root:         /repo  (--root flag)")
    for (const title of [
      "tsconfig chain",
      "screen sources that ran",
      "screen sources that produced screens",
      "detection (score, live, evidence)",
      "globs attempted",
      "counts",
      "limitations",
      "diagnostics",
      "staleness fingerprint",
      "notes",
    ])
      expect(out).toContain(`\n${title}\n  (none)`)
  })

  it("omits the zero-screen trace and failure blocks when empty, and shows them otherwise", () => {
    const quiet = text(baseReport())
    expect(quiet).not.toContain("zero-screen trace")
    expect(quiet).not.toContain("analysis failed")

    const loud = text(baseReport({ trace: "line one\nline two", failure: "kaboom" }))
    expect(loud).toContain("\nzero-screen trace\n  line one\n  line two")
    expect(loud).toContain("\nanalysis failed\n  kaboom")
  })

  it("sanitizes the zero-screen trace, which carries repo text", () => {
    const out = text(baseReport({ trace: "bad \u001b[31mfile\u0007\nnext" }))

    expect(out).toContain("bad \\x1b[31mfile\\x07")
    expect(out).toContain("\n  next")
  })

  it("sanitizes diagnostics embedded in the report", () => {
    const out = text(baseReport({ diagnostics: [diagnostic("error", "x/\u001b[2J", "m\u009b")] }))

    expect(out).not.toMatch(CONTROL_ONLY)
  })

  it("falls back to the producing sources when the registry reported none as run", () => {
    const fallback = formatDoctor(baseReport({ screenSources: ["next-app"] }))
    const ranIndex = fallback.indexOf("screen sources that ran")

    expect(fallback[ranIndex + 1]).toBe("  next-app")

    const ran = formatDoctor(baseReport({ screenSources: ["next-app"], sourcesRun: ["next-app", "react-router"] }))
    const index = ran.indexOf("screen sources that ran")
    expect(ran.slice(index + 1, index + 3)).toEqual(["  next-app", "  react-router"])
  })

  it("labels detections live, near-miss or no, sorted by source, with evidence lines", () => {
    const out = formatDoctor(
      baseReport({
        detections: [
          { source: "zeta", score: 0, live: false, evidence: [] },
          { source: "beta", score: 40, live: false, evidence: [] },
          { source: "alpha", score: 100, live: true, evidence: [{ what: "dep", file: "package.json", line: 3 }] },
        ],
      }),
    )

    expect(out.slice(out.indexOf("detection (score, live, evidence)") + 1, out.indexOf("detection (score, live, evidence)") + 5)).toEqual([
      "  alpha  score 100  live",
      "    package.json:3  dep",
      "  beta  score 40  near-miss",
      "  zeta  score 0  no",
    ])
  })

  it("describes template compilers by status, version and origin", () => {
    const out = text(
      baseReport({
        templateCompilers: [
          { framework: "vue", status: "loaded", version: "3.5.0", from: "project" },
          { framework: "vue", status: "loaded", version: "3.4.0", from: "appgraph" },
          { framework: "vue", status: "missing", version: null, from: null },
          { framework: "vue", status: "unsupported", version: "2.7.0", from: "project" },
        ] as unknown as DoctorReport["templateCompilers"],
      }),
    )

    expect(out).toContain("vue compiler: 3.5.0 (project)")
    expect(out).toContain("vue compiler: 3.4.0 (appgraph fallback)")
    expect(out).toContain("vue compiler: missing — template facts skipped")
    expect(out).toContain("vue compiler: unsupported 2.7.0")
  })

  it("prints the tsconfig chain numbered, with paths sorted and (none) defaults", () => {
    const out = text(
      baseReport({
        tsconfig: {
          files: ["tsconfig.json", "tsconfig.base.json"],
          baseUrl: null,
          moduleResolution: null,
          jsx: "react-jsx",
          include: [],
          paths: { "~/*": ["src/*", "lib/*"], "@/*": ["app/*"] },
        },
      }),
    )

    expect(out).toContain("  1. tsconfig.json\n  2. tsconfig.base.json")
    expect(out).toContain("  baseUrl:          (none)")
    expect(out).toContain("  jsx:              react-jsx")
    expect(out).toContain("  include:          (none)")
    expect(out.indexOf("@/* -> app/*")).toBeLessThan(out.indexOf("~/* -> src/*, lib/*"))
  })

  it("sorts counts, confidence, and nav candidates deterministically", () => {
    const out = text(
      baseReport({
        counts: { screens: 2, api: 1 },
        confidence: [
          { section: "screens", count: 2, enablingDependency: null, dependencyInstalled: false, level: "high" },
          { section: "nav", count: 0, enablingDependency: "vue", dependencyInstalled: true, level: "suspect" },
        ],
        navGroups: [
          { name: "b", source: "s", score: 0.5, availableOnShells: [], entries: [] },
          {
            name: "a",
            source: "s",
            score: 0.333,
            availableOnShells: [],
            entries: [
              { path: "/x", parentPath: null, label: null, labelKey: null, featureFlag: null, source: "s", file: "f", line: 1, resolvedScreen: "/x" },
              { path: "/y", parentPath: null, label: null, labelKey: null, featureFlag: null, source: "s", file: "f", line: 2, resolvedScreen: null },
            ],
          },
        ],
      }),
    )

    expect(out.indexOf("  api: 1")).toBeLessThan(out.indexOf("  screens: 2"))
    expect(out.indexOf("  nav  count=0")).toBeLessThan(out.indexOf("  screens  count=2"))
    expect(out).toContain("  nav  count=0  level=suspect  dep=vue  installed=true")
    expect(out).toContain("  screens  count=2  level=high  dep=(none)  installed=false")
    expect(out).toContain("  s#a  score=0.33  entries=2  resolved=1")
    expect(out.indexOf("s#a")).toBeLessThan(out.indexOf("s#b"))
  })

  it("renders exclusions with and without a source, and nested packages", () => {
    const out = text(
      baseReport({
        exclusions: [
          { pattern: "dist/", reason: "default" },
          { pattern: "tmp/", reason: "gitignore", source: ".gitignore" },
        ],
        nestedPackages: [{ dir: "packages/web", sources: ["next-app", "react-router"] }],
      }),
    )

    expect(out).toContain("  dist/  (default)")
    expect(out).toContain("  tmp/  (gitignore: .gitignore)")
    expect(out).toContain("  packages/web/  run appgraph --root packages/web to map it  (evidence for: next-app, react-router)")
  })

  it("prints the fingerprint with its parts, and globs with match counts", () => {
    const out = text(
      baseReport({
        fingerprint: "abc123",
        fingerprintParts: ["p1", "p2"],
        globs: [{ pattern: "src/**/*.tsx", matches: 0 }],
        nearMisses: [{ file: "src/a.tsx", probe: "createRoot" }],
      }),
    )

    expect(out).toContain("  abc123\n    p1\n    p2")
    expect(out).toContain("  src/**/*.tsx -> 0 match(es)")
    expect(out).toContain("  src/a.tsx  (probe: createRoot)")
  })

  it("sanitizes the failure message, which can embed repo-controlled text (src/cli/print.ts formatDoctor failure line)", () => {
    const out = text(baseReport({ failure: "cannot parse src/\u001b[2Jevil.ts" }))

    expect(out).not.toMatch(CONTROL_ONLY)
  })

  it("sanitizes near-miss file names from the repo (src/cli/print.ts formatDoctor nearMisses)", () => {
    const out = text(baseReport({ nearMisses: [{ file: "src/\u001b[2Jx.tsx", probe: "p" }] }))

    expect(out).not.toMatch(CONTROL_ONLY)
  })
})
