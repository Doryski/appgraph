import { describe, expect, it } from "vitest"
import {
  globOf,
  isSfcFile,
  JSX_EXTENSIONS,
  SCRIPT_EXTENSIONS,
  SCRIPT_FILE,
  SCRIPT_GLOB,
  SFC_EXTENSIONS,
  SOURCE_EXTENSIONS,
  stripSourceExtension,
} from "../../src/core/extensions.js"

describe("extension constants", () => {
  it("lists every script extension and keeps .vue out of the script set", () => {
    expect(SCRIPT_EXTENSIONS).toEqual([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])
    expect(SCRIPT_EXTENSIONS).not.toContain(".vue")
    expect(JSX_EXTENSIONS).toEqual([".tsx", ".jsx"])
    expect(SFC_EXTENSIONS).toEqual([".vue"])
  })

  it("builds SOURCE_EXTENSIONS from scripts then SFCs", () => {
    expect(SOURCE_EXTENSIONS).toEqual([...SCRIPT_EXTENSIONS, ".vue"])
  })
})

describe("globOf", () => {
  it("renders a brace glob", () => {
    expect(globOf(JSX_EXTENSIONS)).toBe("**/*.{tsx,jsx}")
    expect(SCRIPT_GLOB).toBe("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}")
  })

  it("renders a single extension without braces", () => {
    expect(globOf(SFC_EXTENSIONS)).toBe("**/*.vue")
  })
})

describe("SCRIPT_FILE", () => {
  it.each(["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs", "dir/a.b.ts"])("matches %s", (file) => {
    expect(SCRIPT_FILE.test(file)).toBe(true)
  })

  it.each(["a.vue", "a.json", "a.tsx.map", "a.css", "ts"])("rejects %s", (file) => {
    expect(SCRIPT_FILE.test(file)).toBe(false)
  })
})

describe("stripSourceExtension", () => {
  it("strips script and SFC extensions once", () => {
    expect(stripSourceExtension("UserCard.tsx")).toBe("UserCard")
    expect(stripSourceExtension("x.lazy.mjs")).toBe("x.lazy")
    expect(stripSourceExtension("UserCard.vue")).toBe("UserCard")
  })

  it("leaves other names untouched", () => {
    expect(stripSourceExtension("data.json")).toBe("data.json")
  })
})

describe("isSfcFile", () => {
  it("only accepts .vue", () => {
    expect(isSfcFile("a/b.vue")).toBe(true)
    expect(isSfcFile("a/b.ts")).toBe(false)
  })
})
