import ts from "typescript"
import { describe, expect, it } from "vitest"
import { LOOKUP_LIMITS, createTargetLookup } from "../../src/extractors/navigation-lookup.js"
import type { LookupValue } from "../../src/extractors/navigation-lookup.js"
import type { ExtractContext } from "../../src/extractors/types.js"
import { createExtractContext } from "../../src/extractors/registry.js"
import { ROOT, parse } from "./harness.js"

const abs = (file: string): string => `${ROOT}/${file}`

type Options = {
  readonly sources?: Readonly<Record<string, string>>
  readonly modules?: Readonly<Record<string, string>>
}

const setup = (code: string, options: Options = {}) => {
  const sources = options.sources ?? {}
  const modules = options.modules ?? {}
  const parsed = new Map<string, ts.SourceFile>()
  const source = parse(code)
  const input = createExtractContext({
    ts,
    file: "src/File.tsx",
    source,
    resolveModule: (specifier) => modules[specifier] ?? null,
    resolve: {
      declarationFile: (file) => file,
      relative: (file) => file,
      resolveModule: (_from, specifier) => modules[specifier] ?? null,
      sourceFile: (file) => {
        const text = sources[file]
        if (text === undefined) return null
        const known = parsed.get(file) ?? ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
        parsed.set(file, known)
        return known
      },
    },
  })
  const ctx: ExtractContext = { ...input, emitFact: () => undefined, diagnostic: () => undefined }
  return { ctx, source, lookup: createTargetLookup(ctx) }
}

const lastNodeWithText = (root: ts.Node, text: string): ts.Node | null => {
  let found: ts.Node | null = null
  const visit = (node: ts.Node): void => {
    if (node.getText() === text && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isConditionalExpression(node)))
      found = node
    node.forEachChild(visit)
  }
  visit(root)
  return found
}

const lookupAt = (code: string, text: string, options: Options = {}): readonly LookupValue[] | null => {
  const { source, lookup } = setup(code, options)
  const node = lastNodeWithText(source, text)
  if (node === null) throw new Error(`no node for ${text}`)
  return lookup.valuesOf(node)
}

const values = (result: readonly LookupValue[] | null): readonly string[] | null =>
  result === null ? null : result.map((entry) => entry.value).sort()

describe("extractors/navigation-lookup: static keys", () => {
  const MAP = `const MAP = { home: "/", orders: "/orders", nested: { path: "/n" } }\n`

  it("resolves a literal property key to exactly that value, as NOT dynamic", () => {
    expect(lookupAt(`${MAP}MAP.orders`, "MAP.orders")).toEqual([{ value: "/orders", dynamic: false }])
    expect(lookupAt(`${MAP}MAP["orders"]`, `MAP["orders"]`)).toEqual([{ value: "/orders", dynamic: false }])
    expect(lookupAt(`${MAP}MAP.nested.path`, "MAP.nested.path")).toEqual([{ value: "/n", dynamic: false }])
  })

  it("yields nothing (not null) for a literal key the object lacks", () => {
    expect(lookupAt(`${MAP}MAP.missing`, "MAP.missing")).toEqual([])
  })

  it("resolves a numeric array index precisely and treats an out-of-range index as unknown", () => {
    const code = `const ARR = ["/a", "/b"]\n`

    expect(lookupAt(`${code}ARR[1]`, "ARR[1]")).toEqual([{ value: "/b", dynamic: false }])
    expect(lookupAt(`${code}ARR[5]`, "ARR[5]")).toBeNull()
  })

  it("sees through Object.freeze and as const", () => {
    expect(lookupAt(`const M = Object.freeze({ a: "/a" })\nM.a`, "M.a")).toEqual([{ value: "/a", dynamic: false }])
    expect(lookupAt(`const M = { a: "/a" } as const\nM.a`, "M.a")).toEqual([{ value: "/a", dynamic: false }])
    expect(lookupAt(`const M = (Object.freeze({ a: "/a" }) as const);\nM.a`, "M.a")).toEqual([{ value: "/a", dynamic: false }])
  })

  it("reads quoted, numeric and shorthand property names", () => {
    const code = `const x = "/x"\nconst M = { "a-b": "/ab", 7: "/seven", x }\n`

    expect(lookupAt(`${code}M["a-b"]`, `M["a-b"]`)).toEqual([{ value: "/ab", dynamic: false }])
    expect(lookupAt(`${code}M[7]`, "M[7]")).toEqual([{ value: "/seven", dynamic: false }])
    expect(lookupAt(`${code}M.x`, "M.x")).toEqual([{ value: "/x", dynamic: false }])
  })
})

describe("extractors/navigation-lookup: runtime keys", () => {
  it("returns every value of the literal, each marked dynamic", () => {
    const result = lookupAt(`const MAP = { a: "/a", b: "/b" }\nfunction f(key) { return MAP[key] }`, "MAP[key]")

    expect(result).toEqual([
      { value: "/a", dynamic: true },
      { value: "/b", dynamic: true },
    ])
  })

  it("applies a runtime key at the right level of a nested lookup", () => {
    const code = `const R = { x: { path: "/x", title: "T" }, y: { path: "/y", title: "U" } }\nfunction f(k) { return R[k].path }`

    expect(values(lookupAt(code, "R[k].path"))).toEqual(["/x", "/y"])
  })

  it("collects array elements dynamically, and yields their spread members too", () => {
    const code = `const A = ["/a", "/b"]\nconst ALL = ["/z", ...A]\nfunction f(i) { return ALL[i] }`

    expect(lookupAt(code, "ALL[i]")).toEqual([
      { value: "/z", dynamic: true },
      { value: "/a", dynamic: true },
      { value: "/b", dynamic: true },
    ])
  })

  it("merges object spreads for a named key, later spreads included", () => {
    const code = `const BASE = { a: "/a" }\nconst M = { ...BASE, b: "/b" }\nM.a`

    expect(lookupAt(code, "M.a")).toEqual([{ value: "/a", dynamic: false }])
  })

  it("marks both branches of a conditional dynamic", () => {
    const code = `const flag = Math.random()\nconst T = flag ? "/a" : "/b"\nT`

    expect(lookupAt(code, "T")).toEqual([
      { value: "/a", dynamic: true },
      { value: "/b", dynamic: true },
    ])
  })

  it("collapses duplicate values to one entry", () => {
    const result = lookupAt(`const A = ["/a", "/a", "/b"]\nfunction f(i) { return A[i] }`, "A[i]")

    expect(values(result)).toEqual(["/a", "/b"])
  })

  it("returns an empty list (not null) for an empty literal", () => {
    expect(lookupAt(`const M = {}\nfunction f(k) { return M[k] }`, "M[k]")).toEqual([])
  })
})

describe("extractors/navigation-lookup: iteration", () => {
  const ITEMS = `const items = [{ to: "/a", label: "A" }, { to: "/b", label: "B" }]\n`

  it("resolves a callback parameter through map, flatMap and forEach receivers", () => {
    for (const method of ["map", "flatMap", "forEach"])
      expect(values(lookupAt(`${ITEMS}items.${method}((item) => item.to)`, "item.to"))).toEqual(["/a", "/b"])
  })

  it("resolves a destructured callback parameter, honouring renames", () => {
    expect(values(lookupAt(`${ITEMS}items.map(({ to }) => to)`, "to"))).toEqual(["/a", "/b"])
    expect(values(lookupAt(`${ITEMS}items.map(({ to: href }) => href)`, "href"))).toEqual(["/a", "/b"])
  })

  it("resolves a for-of binding", () => {
    expect(values(lookupAt(`${ITEMS}for (const item of items) { item.to }`, "item.to"))).toEqual(["/a", "/b"])
  })

  it("looks through filter/slice/sort style pass-through calls on the receiver", () => {
    const code = `${ITEMS}items.filter(Boolean).slice(0).map((item) => item.to)`

    expect(values(lookupAt(code, "item.to"))).toEqual(["/a", "/b"])
  })

  it("is unknown for a non-first parameter such as the index, and for an unrelated receiver call", () => {
    expect(lookupAt(`${ITEMS}items.map((item, index) => index)`, "index")).toBeNull()
    expect(lookupAt(`${ITEMS}items.reduce((acc, item) => item.to, "")`, "item.to")).toBeNull()
  })
})

describe("extractors/navigation-lookup: unknown shapes return null", () => {
  it("does not read a reassignable let/var object as a constant (the shared string-member table folds it first, src/core/strings.ts:73-79)", () => {
    expect(lookupAt(`let M = { a: "/a" }\nM.a`, "M.a")).toBeNull()
    expect(lookupAt(`var M = { a: "/a" }\nM.a`, "M.a")).toBeNull()
  })

  it("is null for undeclared names and values produced by calls", () => {
    expect(lookupAt(`MAP.a`, "MAP.a")).toBeNull()
    expect(lookupAt(`let M = { a: "/a" }\nfunction f(k) { return M[k] }`, "M[k]")).toBeNull()
    expect(lookupAt(`function f() { return { a: "/a" } }\nconst M = f()\nM.a`, "M.a")).toBeNull()
  })

  it("is null when any branch of the literal is not statically known", () => {
    expect(lookupAt(`const M = { a: "/a", b: compute() }\nfunction f(k) { return M[k] }`, "M[k]")).toBeNull()
    expect(lookupAt(`const M = { a: "/a", ...unknown }\nfunction f(k) { return M[k] }`, "M[k]")).toBeNull()
    expect(lookupAt(`const M = ["/a", ...unknown]\nfunction f(k) { return M[k] }`, "M[k]")).toBeNull()
  })

  it("is null for a method-shaped property matching the key, and ignores a non-matching one", () => {
    expect(lookupAt(`const M = { a() { return "/a" }, b: "/b" }\nM.a`, "M.a")).toBeNull()
    expect(lookupAt(`const M = { a() { return "/a" }, b: "/b" }\nM.b`, "M.b")).toEqual([{ value: "/b", dynamic: false }])
  })

  it("is null for a spread element hit by a numeric index", () => {
    expect(lookupAt(`const A = ["/a"]\nconst B = [...A]\nB[0]`, "B[0]")).toBeNull()
  })
})

describe("extractors/navigation-lookup: limits", () => {
  const objectOf = (count: number): string =>
    `const M = { ${Array.from({ length: count }, (_, index) => `k${String(index)}: "/p${String(index)}"`).join(", ")} }\nfunction f(k) { return M[k] }`

  it("accepts exactly maxValues distinct values and rejects one more", () => {
    expect(lookupAt(objectOf(LOOKUP_LIMITS.maxValues), "M[k]")).toHaveLength(LOOKUP_LIMITS.maxValues)
    expect(lookupAt(objectOf(LOOKUP_LIMITS.maxValues + 1), "M[k]")).toBeNull()
  })

  it("counts distinct values, so many duplicates stay under the cap", () => {
    const elements = Array.from({ length: LOOKUP_LIMITS.maxValues * 2 }, () => `"/same"`).join(", ")

    expect(lookupAt(`const A = [${elements}]\nfunction f(i) { return A[i] }`, "A[i]")).toEqual([{ value: "/same", dynamic: true }])
  })

  it("gives up on an alias chain deeper than maxDepth, and follows a shallow one", () => {
    const chain = (length: number): string =>
      [`const c0 = { a: "/a" }`, ...Array.from({ length }, (_, index) => `const c${String(index + 1)} = c${String(index)}`), `c${String(length)}.a`].join("\n")

    expect(lookupAt(chain(2), "c2.a")).toEqual([{ value: "/a", dynamic: false }])
    expect(lookupAt(chain(LOOKUP_LIMITS.maxDepth + 4), `c${String(LOOKUP_LIMITS.maxDepth + 4)}.a`)).toBeNull()
  })

  it("terminates on a self-referential or cyclic declaration instead of recursing forever", () => {
    expect(lookupAt(`const a = b.x\nconst b = a.x\na`, "a")).toBeNull()
    expect(lookupAt(`const a = { x: b }\nconst b = { y: a }\na.x.y.x`, "a.x.y.x")).toEqual([])
    expect(lookupAt(`const M = { ...M, a: "/a" }\nfunction f(k) { return M[k] }`, "M[k]")).toBeNull()
  })
})

describe("extractors/navigation-lookup: cross-file", () => {
  const ROUTES = abs("src/routes.ts")
  const modules = { "./routes": ROUTES }

  it("resolves a named import through the injected resolver, preserving dynamic-ness", () => {
    const sources = { [ROUTES]: `export const ROUTES = { home: "/", cart: "/cart" }` }

    expect(lookupAt(`import { ROUTES } from "./routes"\nROUTES.cart`, "ROUTES.cart", { sources, modules })).toEqual([
      { value: "/cart", dynamic: false },
    ])
    expect(values(lookupAt(`import { ROUTES } from "./routes"\nfunction f(k) { return ROUTES[k] }`, "ROUTES[k]", { sources, modules }))).toEqual(["/", "/cart"])
  })

  it("resolves aliased and default imports", () => {
    const sources = { [ROUTES]: `export const ROUTES = { a: "/a" }\nexport default { b: "/b" }` }

    expect(lookupAt(`import { ROUTES as R } from "./routes"\nR.a`, "R.a", { sources, modules })).toEqual([{ value: "/a", dynamic: false }])
    expect(lookupAt(`import D from "./routes"\nD.b`, "D.b", { sources, modules })).toEqual([{ value: "/b", dynamic: false }])
  })

  it("is null when the module is unresolved, unreadable, type-only, or the export is not a const", () => {
    const code = `import { ROUTES } from "./routes"\nROUTES.a`

    expect(lookupAt(code, "ROUTES.a", { sources: { [ROUTES]: `export const ROUTES = { a: "/a" }` } })).toBeNull()
    expect(lookupAt(code, "ROUTES.a", { modules })).toBeNull()
    expect(lookupAt(`import type { ROUTES } from "./routes"\nROUTES.a`, "ROUTES.a", { sources: { [ROUTES]: `export const ROUTES = { a: "/a" }` }, modules })).toBeNull()
    expect(lookupAt(code, "ROUTES.a", { sources: { [ROUTES]: `export let ROUTES = { a: "/a" }` }, modules })).toBeNull()
  })

  it("folds string constants declared in the imported file when reading its values", () => {
    const sources = { [ROUTES]: `const BASE = "/shop"\nexport const ROUTES = { cart: BASE + "/cart" }` }

    expect(lookupAt(`import { ROUTES } from "./routes"\nROUTES.cart`, "ROUTES.cart", { sources, modules })).toEqual([
      { value: "/shop/cart", dynamic: false },
    ])
  })
})

describe("extractors/navigation-lookup accepts", () => {
  const acceptsOf = (code: string, text: string): boolean => {
    const { source, lookup } = setup(code)
    const node = lastNodeWithText(source, text)
    if (node === null) throw new Error(`no node for ${text}`)
    return lookup.accepts(node)
  }

  it("accepts identifiers and property/element access chains", () => {
    expect(acceptsOf("const x = 1\nx", "x")).toBe(true)
    expect(acceptsOf("a.b.c", "a.b.c")).toBe(true)
    expect(acceptsOf("a[k].c", "a[k].c")).toBe(true)
  })

  it("rejects calls, literals and other expression shapes", () => {
    const { source, lookup } = setup(`f();\n"/x";\n\`/x/\${y}\`;\na + b;\n`)
    const statements = source.statements.filter(ts.isExpressionStatement).map((statement) => statement.expression)

    expect(statements).toHaveLength(4)
    for (const expression of statements) expect(lookup.accepts(expression)).toBe(false)
  })

  it("rejects a chain with a call in the middle", () => {
    expect(acceptsOf("a.b().c", "a.b().c")).toBe(false)
  })
})
