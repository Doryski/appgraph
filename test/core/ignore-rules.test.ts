import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import { createIgnoreMatcher, matchIgnoreRules, parseIgnoreFile, parseIgnoreLine } from "../../src/core/ignore-rules.js"

const verdict = (text: string, relPath: string, isDirectory = false) =>
  matchIgnoreRules(parseIgnoreFile(text), relPath, isDirectory)

describe("parseIgnoreLine — gitignore(5) line syntax", () => {
  it("skips blanks and comments, keeps escaped # and !", () => {
    expect(parseIgnoreLine("")).toBeNull()
    expect(parseIgnoreLine("   ")).toBeNull()
    expect(parseIgnoreLine("# comment")).toBeNull()
    expect(verdict("\\#hash", "#hash")).toBe(true)
    expect(verdict("\\!bang", "!bang")).toBe(true)
  })

  it("trims unescaped trailing spaces and CR", () => {
    expect(verdict("dist   ", "dist")).toBe(true)
    expect(verdict("dist\r", "dist")).toBe(true)
    expect(verdict("a\\ ", "a ")).toBe(true)
  })
})

describe("matchIgnoreRules — pattern semantics", () => {
  it("matches a slash-free pattern at any depth", () => {
    expect(verdict("uploads", "uploads", true)).toBe(true)
    expect(verdict("uploads", "src/deep/uploads", true)).toBe(true)
    expect(verdict("*.log", "a/b/c.log")).toBe(true)
  })

  it("anchors a pattern with a leading or middle slash", () => {
    expect(verdict("/build", "build", true)).toBe(true)
    expect(verdict("/build", "src/build", true)).toBeUndefined()
    expect(verdict("src/keys/", "src/keys", true)).toBe(true)
    expect(verdict("src/keys/", "lib/src/keys", true)).toBeUndefined()
  })

  it("applies a trailing-slash pattern to directories only", () => {
    expect(verdict(".next-build/", ".next-build", true)).toBe(true)
    expect(verdict(".next-build/", ".next-build", false)).toBeUndefined()
  })

  it("lets the last matching rule win, so negation re-includes", () => {
    const text = ".vscode/*\n!.vscode/extensions.json"
    expect(verdict(text, ".vscode/settings.json")).toBe(true)
    expect(verdict(text, ".vscode/extensions.json")).toBe(false)
  })

  it("supports **, ? and character classes", () => {
    expect(verdict("**/gen", "a/b/gen", true)).toBe(true)
    expect(verdict("a/**/z", "a/z", true)).toBe(true)
    expect(verdict("a/**/z", "a/b/c/z", true)).toBe(true)
    expect(verdict("logs/**", "logs/x/y.txt")).toBe(true)
    expect(verdict("logs/**", "logs", true)).toBeUndefined()
    expect(verdict("file?.ts", "file1.ts")).toBe(true)
    expect(verdict("*.sw[op]", "x.swp")).toBe(true)
    expect(verdict("*.sw[!op]", "x.swp")).toBeUndefined()
    expect(verdict("/\\[project\\]/", "[project]", true)).toBe(true)
  })

  it("never lets a single * cross a slash", () => {
    expect(verdict("/src/*.ts", "src/a.ts")).toBe(true)
    expect(verdict("/src/*.ts", "src/a/b.ts")).toBeUndefined()
  })
})

describe("createIgnoreMatcher — root, nested and ancestor ignore files", () => {
  it("reads nested .gitignore files relative to their own directory", () => {
    const host = createMemoryHost({
      files: {
        "/repo/.git/HEAD": "ref",
        "/repo/.gitignore": "/out\n*.local",
        "/repo/pkg/.gitignore": "generated/\n!keep.local",
        "/repo/pkg/generated/a.ts": "",
      },
    })
    const matcher = createIgnoreMatcher(host, "/repo")
    expect(matcher.isIgnored("out", true)).toBe(true)
    expect(matcher.isIgnored("pkg/out", true)).toBe(false)
    expect(matcher.isIgnored("pkg/generated", true)).toBe(true)
    expect(matcher.isIgnored("generated", true)).toBe(false)
    expect(matcher.isIgnored("pkg/x.local", false)).toBe(true)
    expect(matcher.isIgnored("pkg/keep.local", false)).toBe(false)
    expect(matcher.files()).toEqual([".gitignore", "pkg/.gitignore"])
  })

  it("applies ignore files between the repository root and a nested project root", () => {
    const host = createMemoryHost({
      files: {
        "/mono/.git/HEAD": "ref",
        "/mono/.gitignore": "/apps/web/tmp\nscratch",
        "/mono/apps/web/package.json": "{}",
      },
    })
    const matcher = createIgnoreMatcher(host, "/mono/apps/web")
    expect(matcher.isIgnored("tmp", true)).toBe(true)
    expect(matcher.isIgnored("src/scratch", true)).toBe(true)
    expect(matcher.isIgnored("src", true)).toBe(false)
    expect(matcher.files()).toEqual(["../../.gitignore"])
  })

  it("stays inside the project when no repository is found", () => {
    const host = createMemoryHost({ files: { "/p/.gitignore": "tmp", "/.gitignore": "src" } })
    const matcher = createIgnoreMatcher(host, "/p")
    expect(matcher.isIgnored("tmp", true)).toBe(true)
    expect(matcher.isIgnored("src", true)).toBe(false)
  })
})
