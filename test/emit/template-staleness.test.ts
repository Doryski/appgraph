import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  isTemplateStale,
  REPORT_UI_IGNORED,
  renderAssetsModule,
  writeFileAtomic,
  type TemplateSources,
} from "../../scripts/generate-assets.js"

const BASE_TIME = 1_700_000_000
const MODULE_TIME = BASE_TIME + 100
const NEWER_TIME = BASE_TIME + 200

const UI_FILES = ["src/main.tsx", "index.html", "dist/index.html", "test/setup.ts", "src/App.test.tsx"] as const

let root = ""

const at = (relative: string): string => join(root, relative)

const writeAt = (file: string, text: string, seconds: number): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  utimesSync(file, seconds, seconds)
}

const touch = (relative: string, seconds = NEWER_TIME): void => utimesSync(at(relative), seconds, seconds)

const sources = (): TemplateSources => ({
  module: at("generated.ts"),
  trees: [{ root: at("ui"), ignored: REPORT_UI_IGNORED }],
  files: [at("emit/strings.ts")],
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "appgraph-staleness-"))
  UI_FILES.forEach((file) => writeAt(at(`ui/${file}`), file, BASE_TIME))
  writeAt(at("emit/strings.ts"), "strings", BASE_TIME)
  writeAt(at("generated.ts"), renderAssetsModule("<html></html>"), MODULE_TIME)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("isTemplateStale", () => {
  it("is fresh when every input is older than the module", () => {
    expect(isTemplateStale(sources())).toBe(false)
  })

  it("is stale when the module is missing", () => {
    rmSync(at("generated.ts"))
    expect(isTemplateStale(sources())).toBe(true)
  })

  it("is stale when the module has no template", () => {
    writeAt(at("generated.ts"), "export const OTHER = \"\"\n", MODULE_TIME)
    expect(isTemplateStale(sources())).toBe(true)
  })

  it.each(["ui/src/main.tsx", "ui/index.html", "emit/strings.ts"])("is stale when %s is newer", (relative) => {
    touch(relative)
    expect(isTemplateStale(sources())).toBe(true)
  })

  it.each(["ui/dist/index.html", "ui/test/setup.ts", "ui/src/App.test.tsx"])("ignores a newer %s", (relative) => {
    touch(relative)
    expect(isTemplateStale(sources())).toBe(false)
  })

  it("sees a file added in a nested directory", () => {
    writeAt(at("ui/src/deep/nested/Widget.tsx"), "widget", NEWER_TIME)
    expect(isTemplateStale(sources())).toBe(true)
  })
})

describe("writeFileAtomic", () => {
  it("replaces the file and leaves no temporary file behind", () => {
    const file = at("out.ts")
    writeFileSync(file, "old")
    writeFileAtomic(file, "new")
    expect(readFileSync(file, "utf8")).toBe("new")
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it("creates a file that did not exist", () => {
    const file = at("fresh.ts")
    writeFileAtomic(file, "text")
    expect(existsSync(file)).toBe(true)
  })
})
