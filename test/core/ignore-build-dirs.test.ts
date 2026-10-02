import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import { distDirsInNextConfig, normalizeDistDir, readNextDistDirs } from "../../src/core/ignore-build-dirs.js"

describe("distDirsInNextConfig — string-literal distDir only", () => {
  it("reads a property literal", () => {
    expect(distDirsInNextConfig(`module.exports = { distDir: "build-next" }`)).toEqual(["build-next"])
    expect(distDirsInNextConfig(`export default { distDir: './out/next/' }`)).toEqual(["out/next"])
  })

  it("reads both branches of a conditional and ignores the compared operand", () => {
    const text = `const distDir = process.env.NODE_ENV === "production" ? ".next-build" : ".next";
const nextConfig = { distDir, turbopack: { root: "." } }`
    expect(distDirsInNextConfig(text)).toEqual([".next", ".next-build"])
  })

  it("ignores comments, templates with substitutions and escapes above the root", () => {
    expect(distDirsInNextConfig(`// distDir: "commented"\nexport default {}`)).toEqual([])
    expect(distDirsInNextConfig("export default { distDir: `${base}/next` }")).toEqual([])
    expect(distDirsInNextConfig(`export default { distDir: "../shared" }`)).toEqual([])
    expect(distDirsInNextConfig(`export default { distDir: process.env.DIST }`)).toEqual([])
  })
})

describe("normalizeDistDir", () => {
  it("rejects the root, parents and absolute paths", () => {
    expect(normalizeDistDir(".")).toBeNull()
    expect(normalizeDistDir("..")).toBeNull()
    expect(normalizeDistDir("/abs")).toBeNull()
    expect(normalizeDistDir("./a//b/")).toBe("a/b")
  })
})

describe("readNextDistDirs", () => {
  it("names the config file each directory came from", () => {
    const host = createMemoryHost({ files: { "/app/next.config.ts": `export default { distDir: ".nb" }` } })
    expect(readNextDistDirs(host, "/app")).toEqual([{ dir: ".nb", config: "next.config.ts" }])
  })
})
