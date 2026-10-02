import { describe, expect, it } from "vitest"
import { REGISTERED_COMMANDS } from "../../src/cli/commands.js"
import {
  COMMANDS,
  EXIT_OK,
  EXIT_USAGE,
  FORMATS,
  LOCALES,
  parseArgv,
  readPackageVersion,
} from "../../src/cli/args.js"

const sink = () => {
  const lines: string[] = []
  return { lines, write: (text: string) => lines.push(text) }
}

const io = () => {
  const out = sink()
  const err = sink()
  return { out, err, ports: { writeOut: out.write, writeErr: err.write } }
}

const parsed = (argv: readonly string[]) => {
  const outcome = parseArgv(argv, io().ports)
  if (outcome.kind !== "run") throw new Error(`expected a run outcome, got ${outcome.kind}`)
  return outcome.parsed
}

describe("parseArgv", () => {
  it("defaults to the analyze command with no formats selected", () => {
    const result = parsed([])
    expect(result.command).toBe("analyze")
    expect(result.options).toMatchObject({
      formats: [],
      allSources: false,
      allowEmpty: false,
      ifStale: false,
      timestamp: true,
      strict: false,
      quiet: false,
      json: false,
      timing: false,
    })
    expect(result.options.root).toBeUndefined()
    expect(result.options.out).toBeUndefined()
  })

  it("parses every documented flag", () => {
    const result = parsed([
      "--root",
      "./frontend",
      "--config",
      "./appgraph.config.ts",
      "--screen",
      "/invoices/:id",
      "--source",
      "react-router",
      "--out",
      "docs/map",
      "--depth",
      "5",
      "--locale",
      "pl",
      "--all-sources",
      "--allow-empty",
      "--if-stale",
      "--no-timestamp",
      "--strict",
      "--quiet",
      "--json",
      "--timing",
      "--format",
      "detail",
    ])

    expect(result.options).toEqual({
      root: "./frontend",
      config: "./appgraph.config.ts",
      formats: ["detail"],
      screen: "/invoices/:id",
      source: "react-router",
      out: "docs/map",
      depth: 5,
      locale: "pl",
      allSources: true,
      allowEmpty: true,
      ifStale: true,
      timestamp: false,
      strict: true,
      quiet: true,
      json: true,
      timing: true,
    })
  })

  it("collects a repeatable --format in order", () => {
    expect(parsed(["--format", "index", "--format", "html", "--format", "full"]).options.formats).toEqual([
      "index",
      "html",
      "full",
    ])
  })

  it("accepts every documented format and locale", () => {
    for (const format of FORMATS) {
      const argv = format === "detail" ? ["--format", format, "--screen", "/x"] : ["--format", format]
      expect(parsed(argv).options.formats).toEqual([format])
    }
    for (const locale of LOCALES) expect(parsed(["--locale", locale]).options.locale).toBe(locale)
  })

  it("rejects an unknown format, locale, depth and flag as usage errors", () => {
    for (const argv of [
      ["--format", "yaml"],
      ["--locale", "de"],
      ["--depth", "-1"],
      ["--depth", "two"],
      ["--nope"],
    ]) {
      const outcome = parseArgv(argv, io().ports)
      expect(outcome.kind).toBe("error")
      if (outcome.kind === "error") expect(outcome.code).toBe(EXIT_USAGE)
    }
  })

  it("rejects --format detail without --screen", () => {
    const outcome = parseArgv(["--format", "detail"], io().ports)
    expect(outcome).toEqual({
      kind: "error",
      code: EXIT_USAGE,
      message: "--format detail requires --screen <id>",
    })
  })

  it("rejects --screen with a format that does not restrict anything", () => {
    for (const format of ["index", "full", "html", "all"]) {
      const outcome = parseArgv(["--format", format, "--screen", "/x"], io().ports)
      expect(outcome.kind).toBe("error")
      if (outcome.kind !== "error") continue
      expect(outcome.code).toBe(EXIT_USAGE)
      expect(outcome.message).toContain("--screen requires --format detail")
      expect(outcome.message).toContain(format)
    }
  })

  it("rejects a bare --screen, naming the default formats it would not have restricted", () => {
    const outcome = parseArgv(["--screen", "/x"], io().ports)

    expect(outcome.kind).toBe("error")
    if (outcome.kind !== "error") return
    expect(outcome.code).toBe(EXIT_USAGE)
    expect(outcome.message).toContain("--screen requires --format detail")
    expect(outcome.message).toContain("index, html")
  })

  it("accepts --screen with --format detail alone", () => {
    expect(parsed(["--format", "detail", "--screen", "/x"]).options.screen).toBe("/x")
  })

  it("parses the doctor command with the same shared options", () => {
    const result = parsed(["doctor", "--root", "/repo", "--json"])
    expect(result.command).toBe("doctor")
    expect(result.options.root).toBe("/repo")
    expect(result.options.json).toBe(true)
  })

  it("accepts --timing on doctor as well as analyze", () => {
    expect(parsed(["doctor", "--timing"]).options.timing).toBe(true)
    expect(parsed(["--timing"]).options.timing).toBe(true)
  })

  it("--help exits 0 and documents every exit code, the commands and their precedence", () => {
    const ports = io()
    const outcome = parseArgv(["--help"], ports.ports)
    expect(outcome).toEqual({ kind: "exit", code: EXIT_OK })

    const help = ports.out.lines.join("\n")
    for (const fragment of ["Exit codes:", "Precedence when several apply: 2 > 6 > 5 > 3 > 1 > 4.", ...COMMANDS])
      expect(help).toContain(fragment)
    for (const code of ["0", "1", "2", "3", "4", "5", "6"]) expect(help).toMatch(new RegExp(`^\\s{2}${code}\\s{2}`, "m"))
    expect(help).not.toContain("§")
  })

  it("analyze --help lists the analysis flags, examples and output", () => {
    const ports = io()
    expect(parseArgv(["analyze", "--help"], ports.ports)).toEqual({ kind: "exit", code: EXIT_OK })
    const help = ports.out.lines.join("\n")
    for (const fragment of ["--if-stale", "--allow-empty", "--json", "--format", "Output:", "Examples:", "Exit codes:"])
      expect(help).toContain(fragment)
    expect(help).not.toContain("§")
  })

  it("generates every command's help from the registry", () => {
    for (const spec of REGISTERED_COMMANDS) {
      const ports = io()
      expect(parseArgv([spec.name, "--help"], ports.ports)).toEqual({ kind: "exit", code: EXIT_OK })
      const help = ports.out.lines.join("\n")
      expect(help).toContain(spec.output)
      for (const example of spec.examples) expect(help).toContain(`$ ${example}`)
      for (const code of spec.exitCodes) expect(help).toMatch(new RegExp(`^\\s{2}${String(code)}\\s{2}`, "m"))
    }
  })

  it("--help shows a single default for --format", () => {
    const ports = io()
    parseArgv(["--help"], ports.ports)
    const help = ports.out.lines.join("\n")
    expect(help).not.toContain("(default: [])")
  })

  it("doctor rejects the flags it would ignore", () => {
    for (const argv of [["--if-stale"], ["--strict"], ["--allow-empty"], ["--format", "index"], ["--screen", "/x"], ["--locale", "pl"], ["--no-timestamp"], ["--quiet"]]) {
      const outcome = parseArgv(["doctor", ...argv], io().ports)
      expect(outcome.kind).toBe("error")
      if (outcome.kind === "error") expect(outcome.code).toBe(EXIT_USAGE)
    }
  })

  it("doctor takes the project and graph flags plus --json and --timing", () => {
    expect(parsed(["doctor", "--source", "react-router", "--all-sources", "--depth", "2", "--out", "o", "--config", "c.ts"]).options).toMatchObject({
      source: "react-router",
      allSources: true,
      depth: 2,
      out: "o",
      config: "c.ts",
      timestamp: true,
    })
  })

  it("still analyses on bare flags, and on the explicit analyze command", () => {
    expect(parsed(["--format", "index"])).toMatchObject({ command: "analyze", options: { formats: ["index"] } })
    expect(parsed(["analyze", "--format", "index"])).toMatchObject({ command: "analyze", options: { formats: ["index"] } })
  })

  it("accepts shared options before the command name", () => {
    expect(parsed(["--root", "frontend", "--out", "o", "screens", "--json"])).toMatchObject({
      command: "screens",
      options: { root: "frontend", out: "o", json: true },
    })
    expect(parsed(["--cached", "--root=frontend", "screen", "/orders/:id"])).toMatchObject({
      command: "screen",
      args: { target: "/orders/:id" },
      query: { cached: true },
    })
    expect(parsed(["--source", "stats", "--format", "index"])).toMatchObject({ command: "analyze" })
  })

  it("rejects an unknown command as a usage error naming the commands", () => {
    const outcome = parseArgv(["nope"], io().ports)
    expect(outcome).toMatchObject({ kind: "error", code: EXIT_USAGE })
    if (outcome.kind === "error") expect(outcome.message).toContain("screens")
  })

  it("parses a query command's positional argument, query options and own options", () => {
    expect(parsed(["screen", "/orders/:id", "--sections", "endpoints, tree", "--tree-depth", "2", "--limit", "5"])).toMatchObject({
      command: "screen",
      args: { target: "/orders/:id" },
      query: { cached: false, limit: 5, offset: 0, fields: null },
      own: { sections: ["endpoints", "tree"], treeDepth: 2 },
    })
    expect(parsed(["screens", "--no-api", "--flag", "--fields", "id,url", "--cached"])).toMatchObject({
      args: {},
      query: { cached: true, limit: 50, fields: ["id", "url"] },
      own: { api: false, flag: true },
    })
    expect(parsed(["screens", "--flag", "beta"]).own).toMatchObject({ flag: "beta", api: undefined })
    expect(parsed(["components"]).own).toEqual({ kind: undefined, sort: "renders", search: undefined })
    expect(parsed(["glossary"]).args).toEqual({})
  })

  it("rejects a query command's missing argument, bad choice or bad count", () => {
    for (const argv of [["screen"], ["findings", "--section", "nope"], ["screens", "--limit", "0"], ["components", "--sort", "size"], ["glossary", "--root", "."]]) {
      const outcome = parseArgv(argv, io().ports)
      expect(outcome).toMatchObject({ kind: "error", code: EXIT_USAGE })
    }
  })

  it("leaves printing a commander error to the caller, so it appears once", () => {
    const ports = io()
    const outcome = parseArgv(["--nope"], ports.ports)
    expect(outcome.kind).toBe("error")
    expect(ports.err.lines.join("")).toBe("")
  })

  it("--version exits 0 and prints the package's own version", () => {
    const ports = io()
    const outcome = parseArgv(["--version"], ports.ports)
    expect(outcome).toEqual({ kind: "exit", code: EXIT_OK })
    expect(ports.out.lines.join("")).toContain(readPackageVersion())
  })
})

describe("readPackageVersion", () => {
  it("reads a real semver-shaped version at runtime rather than a hardcoded literal", () => {
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
