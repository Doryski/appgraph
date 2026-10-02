import ts from "typescript"
import { describe, expect, it } from "vitest"
import {
  REQUIRED_COMPILER_FUNCTIONS,
  REQUIRED_COMPILER_NAMESPACES,
  SUPPORTED_TYPESCRIPT_RANGE,
  UnsupportedCompilerError,
  assertCompilerSupported,
  checkCompilerApi,
  compilerSupportMessage,
  loadCompiler,
  missingCompilerApis,
} from "../../src/core/compiler-support.js"
import { analyze } from "../../src/pipeline/run.js"
import { createMemoryHost } from "../../src/core/host.js"
import type { TypeScriptApi } from "../../src/core/tsconfig.js"

/** TypeScript 7.0.2: the whole JS API surface reads back `undefined`. */
const GUTTED_COMPILER = { version: "7.0.2" }

describe("compiler-support: the declared range", () => {
  it("is bounded above, so npm's peer auto-install cannot resolve a 7.x", () => {
    expect(SUPPORTED_TYPESCRIPT_RANGE).toBe(">=5.0.0 <7.0.0")
  })

  it("names every member the package actually reads off the injected api", () => {
    expect(REQUIRED_COMPILER_FUNCTIONS).toContain("readJsonConfigFile")
    expect(REQUIRED_COMPILER_FUNCTIONS).toContain("createSourceFile")
    expect(REQUIRED_COMPILER_FUNCTIONS).toContain("parseJsonSourceFileConfigFileContent")
    expect(REQUIRED_COMPILER_NAMESPACES).toContain("SyntaxKind")
  })
})

describe("compiler-support: the check", () => {
  it("passes the compiler this repo is developed against", () => {
    expect(missingCompilerApis(ts)).toEqual([])
    expect(checkCompilerApi(ts).kind).toBe("supported")
    expect(compilerSupportMessage(checkCompilerApi(ts))).toBeNull()
  })

  it("rejects a compiler whose JS API is gutted, and names what is missing", () => {
    const check = checkCompilerApi(GUTTED_COMPILER)

    expect(check.kind).toBe("unsupported")
    expect(missingCompilerApis(GUTTED_COMPILER)).toContain("readJsonConfigFile")
    expect(missingCompilerApis(GUTTED_COMPILER)).toContain("createSourceFile")
  })

  it("does not silently degrade — the message carries range, version found and the install command", () => {
    const message = compilerSupportMessage(checkCompilerApi(GUTTED_COMPILER)) ?? ""

    expect(message).toContain(">=5.0.0 <7.0.0")
    expect(message).toContain("typescript@7.0.2")
    expect(message).toContain("readJsonConfigFile")
    expect(message).toContain('npm  install --save-dev "typescript@>=5.0.0 <7.0.0"')
    expect(message).toContain('pnpm add -D "typescript@>=5.0.0 <7.0.0"')
  })

  it("covers the pnpm case: a peer that was never installed at all", () => {
    const message =
      compilerSupportMessage({ kind: "not-installed", detail: "Cannot find package 'typescript'" }) ?? ""

    expect(message).toContain("required peer dependency")
    expect(message).toContain("Cannot find package 'typescript'")
    expect(message).toContain("do not auto-install peer dependencies")
    expect(message).toContain('pnpm add -D "typescript@>=5.0.0 <7.0.0"')
  })

  it("turns an import failure into the same message shape, not a module-resolution stack", async () => {
    const failure = await loadCompiler({
      load: () => Promise.reject(new Error("Cannot find package 'typescript'")),
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(UnsupportedCompilerError)
    expect(String(failure)).toContain("required peer dependency")
  })

  it("returns the api unchanged when it is supported", () => {
    expect(assertCompilerSupported(ts)).toBe(ts)
  })
})

describe("compiler-support: the guard fires before any analysis", () => {
  it("throws on a gutted compiler instead of reaching api.readJsonConfigFile", async () => {
    const host = createMemoryHost({
      files: {
        "/repo/package.json": JSON.stringify({ name: "fixture" }),
        "/repo/tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      },
    })

    // The assertion is the point: this is what a real 7.x resolves to at runtime while still
    // type-checking as the compiler, because the peer's TYPES are not what got gutted.
    const gutted = GUTTED_COMPILER as unknown as TypeScriptApi

    const failure = await analyze({ root: "/repo", host, ts: gutted }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(UnsupportedCompilerError)
    expect(String(failure)).not.toContain("is not a function")
    expect(String(failure)).toContain(SUPPORTED_TYPESCRIPT_RANGE)
  })
})
