import ts from "typescript"
import { describe, expect, it } from "vitest"
import { bindingTableFor, exportedConstIn, importedConstOf } from "../../src/extractors/imported-declaration.js"
import type { CrossFileResolve, ExtractContext } from "../../src/extractors/types.js"
import { createExtractContext } from "../../src/extractors/registry.js"
import { ROOT, parse } from "./harness.js"

const abs = (file: string): string => `${ROOT}/${file}`

type Setup = {
  readonly code: string
  readonly sources?: Readonly<Record<string, string>>
  readonly modules?: Readonly<Record<string, string>>
  readonly declarationFile?: (abs: string, exportName: string) => string
}

const contextOf = (setup: Setup): { ctx: ExtractContext; resolve: CrossFileResolve; reads: string[] } => {
  const reads: string[] = []
  const sources = setup.sources ?? {}
  const modules = setup.modules ?? {}
  const parsed = new Map<string, ts.SourceFile>()
  const resolve: CrossFileResolve = {
    declarationFile: setup.declarationFile ?? ((file) => file),
    relative: (file) => file,
    resolveModule: (_from, specifier) => modules[specifier] ?? null,
    sourceFile: (file) => {
      reads.push(file)
      const text = sources[file]
      if (text === undefined) return null
      const known = parsed.get(file) ?? ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
      parsed.set(file, known)
      return known
    },
  }
  const input = createExtractContext({
    ts,
    file: "src/File.tsx",
    source: parse(setup.code),
    resolve,
    resolveModule: (specifier) => modules[specifier] ?? null,
  })
  return { ctx: { ...input, emitFact: () => undefined, diagnostic: () => undefined }, resolve, reads }
}

describe("extractors/imported-declaration bindingTableFor", () => {
  const source = parse("import { a } from './a'\nconst local = 1")

  it("returns the very same table for the same SourceFile (per-file cache)", () => {
    const first = bindingTableFor(ts, source, () => null)
    const second = bindingTableFor(ts, source, () => null)

    expect(second).toBe(first)
  })

  it("keeps separate tables for separate SourceFiles, even with identical text", () => {
    const one = parse("const x = 1", "src/One.tsx")
    const two = parse("const x = 1", "src/Two.tsx")

    expect(bindingTableFor(ts, one, () => null)).not.toBe(bindingTableFor(ts, two, () => null))
  })

  it("does not re-resolve imports on a cache hit", () => {
    const fresh = parse("import { a } from './a'", "src/Fresh.tsx")
    let calls = 0
    const resolver = (specifier: string): string | null => {
      calls += 1
      return specifier === "./a" ? abs("src/a.ts") : null
    }

    bindingTableFor(ts, fresh, resolver)
    const afterFirst = calls
    bindingTableFor(ts, fresh, resolver)

    expect(afterFirst).toBeGreaterThan(0)
    expect(calls).toBe(afterFirst)
  })

  it("resolves imports through the supplied resolver and leaves unresolved ones file-less", () => {
    const fresh = parse("import { a } from './a'\nimport { b } from 'pkg'", "src/Resolved.tsx")
    const table = bindingTableFor(ts, fresh, (specifier) => (specifier === "./a" ? abs("src/a.ts") : null))

    const a = table.get("a")
    const b = table.get("b")
    expect(a?.kind === "import" ? a.file : "wrong").toBe(abs("src/a.ts"))
    expect(b?.kind === "import" ? b.file : "wrong").toBeNull()
  })

  it("knows nothing about unrelated names", () => {
    expect(bindingTableFor(ts, source, () => null).get("nope")).toBeNull()
  })
})

describe("extractors/imported-declaration exportedConstIn", () => {
  const CONSTS = abs("src/consts.ts")

  it("returns the declaring module, the initializer and that module's binding table", () => {
    const { ctx, resolve } = contextOf({
      code: "",
      sources: { [CONSTS]: "import { base } from './base'\nexport const PATH = base + '/x'" },
      modules: { "./base": abs("src/base.ts") },
    })

    const found = exportedConstIn(resolve, CONSTS, "PATH", ctx)

    expect(found?.declaring).toBe(CONSTS)
    expect(found?.initializer.getText()).toBe("base + '/x'")
    const base = found?.table.get("base")
    expect(base?.kind === "import" ? base.file : "wrong").toBe(abs("src/base.ts"))
  })

  it("follows declarationFile to the module that really declares a re-exported const", () => {
    const BARREL = abs("src/index.ts")
    const { ctx, resolve } = contextOf({
      code: "",
      sources: { [CONSTS]: "export const PATH = '/p'", [BARREL]: "export { PATH } from './consts'" },
      declarationFile: (file) => (file === BARREL ? CONSTS : file),
    })

    expect(exportedConstIn(resolve, BARREL, "PATH", ctx)?.declaring).toBe(CONSTS)
  })

  it("reuses one binding table across lookups of the same module", () => {
    const { ctx, resolve } = contextOf({
      code: "",
      sources: { [CONSTS]: "export const A = 1\nexport const B = 2" },
    })

    const a = exportedConstIn(resolve, CONSTS, "A", ctx)
    const b = exportedConstIn(resolve, CONSTS, "B", ctx)

    expect(a?.table).toBeDefined()
    expect(b?.table).toBe(a?.table)
  })

  it("is null for an unreadable module, a missing export, a non-variable export and a declaration without initializer", () => {
    const { ctx, resolve } = contextOf({
      code: "",
      sources: { [CONSTS]: "export function fn() {}\nexport let late: string\nexport const OK = 1" },
    })

    expect(exportedConstIn(resolve, abs("src/missing.ts"), "OK", ctx)).toBeNull()
    expect(exportedConstIn(resolve, CONSTS, "absent", ctx)).toBeNull()
    expect(exportedConstIn(resolve, CONSTS, "fn", ctx)).toBeNull()
    expect(exportedConstIn(resolve, CONSTS, "late", ctx)).toBeNull()
    expect(exportedConstIn(resolve, CONSTS, "OK", ctx)).not.toBeNull()
  })
})

describe("extractors/imported-declaration importedConstOf", () => {
  const CONSTS = abs("src/consts.ts")

  it("reads the const behind an imported local, using the IMPORTED name for an aliased import", () => {
    const { ctx } = contextOf({
      code: "import { PATH as P } from './consts'",
      sources: { [CONSTS]: "export const PATH = '/p'" },
      modules: { "./consts": CONSTS },
    })

    const found = importedConstOf("P", ctx)

    expect(found?.declaring).toBe(CONSTS)
    expect(found?.initializer.getText()).toBe("'/p'")
  })

  it("is null for a local, an unknown name, an unresolved import and a dynamic import", () => {
    const { ctx, reads } = contextOf({
      code: [
        "import { PATH } from './unresolved'",
        "const local = 1",
        "const lazy = () => import('./consts')",
      ].join("\n"),
      sources: { [CONSTS]: "export const PATH = '/p'" },
    })

    expect(importedConstOf("local", ctx)).toBeNull()
    expect(importedConstOf("ghost", ctx)).toBeNull()
    expect(importedConstOf("PATH", ctx)).toBeNull()
    expect(reads).toEqual([])
  })

  it("is null without a cross-file resolver", () => {
    const { ctx } = contextOf({ code: "import { PATH } from './consts'", modules: { "./consts": CONSTS } })

    expect(importedConstOf("PATH", { ...ctx, resolve: null })).toBeNull()
  })

  it("is null when the imported const has no initializer", () => {
    const { ctx } = contextOf({
      code: "import { late } from './consts'",
      sources: { [CONSTS]: "export let late: string" },
      modules: { "./consts": CONSTS },
    })

    expect(importedConstOf("late", ctx)).toBeNull()
  })
})
