import { describe, expect, it } from "vitest"
import ts from "typescript"
import { createMemoryHost } from "../../src/core/host.js"
import { createAst, walk } from "../../src/core/ast.js"
import { createBindingTable } from "../../src/core/bindings.js"
import {
  EXCLUDED_FILE,
  createProjectPaths,
  isExcludedFile,
  isNonAppFile,
  normalizePathEntry,
  partitionExcludes,
} from "../../src/core/project.js"
import { UNRESOLVED_IMPORT_CODE, createResolver } from "../../src/core/resolver.js"
import { loadTsconfig } from "../../src/core/tsconfig.js"
import { analyze } from "../../src/pipeline/run.js"

const ROOT = "/repo"

const prefixed = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).map(([file, text]) => [`${ROOT}/${file}`, text]))

const buildResolver = (files: Record<string, string>, sourceRoots: readonly string[] = ["src"]) => {
  const host = createMemoryHost({ files: prefixed(files) })
  const paths = createProjectPaths({ host, root: ROOT, sourceRoots })
  const { chain } = loadTsconfig({ ts, host, root: ROOT })
  return createResolver({ ts, host, paths, tsconfig: chain })
}

const analyzeFiles = (files: Record<string, string>, config: Record<string, unknown> = {}) =>
  analyze({ root: ROOT, ts, host: createMemoryHost({ files: prefixed(files) }), timestamp: null, ...config })

const NEXT_PACKAGE = JSON.stringify({ name: "x", dependencies: { next: "15.0.0", react: "19.0.0", axios: "1.0.0" } })

const ALIAS_TSCONFIG = JSON.stringify({
  compilerOptions: { paths: { "@/*": ["./src/*"] }, jsx: "preserve" },
  include: ["src"],
})

const parse = (code: string): ts.SourceFile =>
  ts.createSourceFile("/repo/src/file.tsx", code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)

const ast = createAst(ts)

describe("C1 — reachability continues through barrel re-exports", () => {
  it("lists `export * from` and `export { x } from` targets as imported files", () => {
    const table = createBindingTable({
      ts,
      source: parse(['export * from "./useOrders"', 'export { useUsers } from "./useUsers"'].join("\n")),
      resolveModule: (specifier) => `/repo/src/hooks/${specifier.slice(2)}.ts`,
    })
    expect(table.importedFiles).toEqual(["/repo/src/hooks/useOrders.ts", "/repo/src/hooks/useUsers.ts"])
    expect(table.importedModules).toEqual(["./useOrders", "./useUsers"])
  })

  it("reaches the endpoint behind a hooks barrel", async () => {
    const result = await analyzeFiles({
      "package.json": NEXT_PACKAGE,
      "tsconfig.json": ALIAS_TSCONFIG,
      "src/app/page.tsx": `import { useOrders } from "@/hooks"\nexport default function Page(){ const o = useOrders(); return <div>{String(o)}</div> }`,
      "src/hooks/index.ts": `export * from "./useOrders"\n`,
      "src/hooks/useOrders.ts": `import axios from "axios"\nexport function useOrders(){ return axios.get("/api/orders") }`,
    })
    const [screen] = result.graph.screens
    expect(screen?.reachable).toContain("src/hooks/useOrders.ts")
    expect(screen?.facts.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.url}`)).toEqual(["GET /api/orders"])
  })
})

describe("C14 — type-only imports are not dependencies", () => {
  it("skips `import type`, all-type named imports and type-only re-exports", () => {
    const table = createBindingTable({
      ts,
      source: parse(
        [
          'import type { Order } from "./types"',
          'import { type User, type Role } from "./users"',
          'import { type Team, loadTeam } from "./teams"',
          'export type { Invoice } from "./invoices"',
          'export { type Plan } from "./plans"',
        ].join("\n"),
      ),
      resolveModule: (specifier) => `/repo/src/${specifier.slice(2)}.ts`,
    })
    expect(table.importedFiles).toEqual(["/repo/src/teams.ts"])
    expect(table.get("Order")).toMatchObject({ kind: "import", imported: "Order" })
  })

  it("keeps a service imported only for its types out of the screen", async () => {
    const result = await analyzeFiles({
      "package.json": NEXT_PACKAGE,
      "tsconfig.json": ALIAS_TSCONFIG,
      "src/app/page.tsx": `import type { Order } from "@/services/api"\nexport default function P(){ const o: Order | null = null; return <div>{String(o)}</div> }`,
      "src/services/api.ts": `import axios from "axios"\nexport type Order = { id: string }\nexport const deleteAll = () => axios.delete("/api/everything")`,
    })
    const [screen] = result.graph.screens
    expect(screen?.reachable).toEqual(["src/app/page.tsx"])
    expect(screen?.facts.endpoints).toEqual([])
  })
})

describe("paths declared in an extended config elsewhere resolve against that config", () => {
  const files = {
    "config/tsconfig.base.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["../src/*"] } } }),
    "tsconfig.json": JSON.stringify({ extends: "./config/tsconfig.base.json", include: ["src"] }),
    "src/app/page.tsx": `import Card from "@/components/Card"`,
    "src/components/Card.tsx": "export default function Card(){ return null }",
  }

  it("rebases the targets onto the entry config directory", () => {
    const { chain } = loadTsconfig({ ts, host: createMemoryHost({ files: prefixed(files) }), root: ROOT })
    expect(chain.paths).toEqual({ "@/*": ["./src/*"] })
  })

  it("resolves the alias to the real file", () => {
    expect(buildResolver(files).resolveModule("/repo/src/app/page.tsx", "@/components/Card")).toBe(
      "/repo/src/components/Card.tsx",
    )
  })

  it("leaves targets alone when the extended config sets baseUrl", () => {
    const { chain } = loadTsconfig({
      ts,
      host: createMemoryHost({
        files: prefixed({
          "config/tsconfig.base.json": JSON.stringify({ compilerOptions: { baseUrl: "..", paths: { "@/*": ["src/*"] } } }),
          "tsconfig.json": JSON.stringify({ extends: "./config/tsconfig.base.json" }),
        }),
      }),
      root: ROOT,
    })
    expect(chain.paths).toEqual({ "@/*": ["src/*"] })
  })
})

describe("C3 — bare specifiers resolve through baseUrl; unresolved project imports are reported", () => {
  const files = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "src", paths: { "@/*": ["./*"] } } }),
    "src/app/page.tsx": [
      'import Card from "components/Card"',
      'import axios from "axios"',
      'import Gone from "./Gone"',
      'import Lost from "@/lost/Thing"',
      'import "./styles.css"',
      'import type { T } from "./types"',
      'import Raw from "./icon.svg?react"',
      'import Ambient from "./ambient"',
    ].join("\n"),
    "src/app/styles.css": "",
    "src/app/ambient.d.ts": "export declare const Ambient: number",
    "src/components/Card.tsx": "export default function Card(){ return null }",
  }

  it("falls back to baseUrl when no alias matches and the target exists", () => {
    const resolver = buildResolver(files)
    expect(resolver.resolveModule("/repo/src/app/page.tsx", "components/Card")).toBe("/repo/src/components/Card.tsx")
    expect(resolver.resolveModule("/repo/src/app/page.tsx", "axios")).toBeNull()
  })

  it("reports relative and alias specifiers that resolve nowhere, never packages, assets or types", () => {
    const resolver = buildResolver(files)
    expect(resolver.unresolvedImports("/repo/src/app/page.tsx")).toEqual([
      { specifier: "./Gone", reason: "missing" },
      { specifier: "@/lost/Thing", reason: "missing" },
    ])
    expect(resolver.unresolvedImportDiagnostics(["/repo/src/app/page.tsx"])).toEqual([
      {
        severity: "info",
        code: UNRESOLVED_IMPORT_CODE,
        message: "Import './Gone' does not resolve to any file; reachability stops there.",
        file: "src/app/page.tsx",
      },
      {
        severity: "info",
        code: UNRESOLVED_IMPORT_CODE,
        message: "Import '@/lost/Thing' does not resolve to any file; reachability stops there.",
        file: "src/app/page.tsx",
      },
    ])
  })

  it("distinguishes a file that exists outside the source roots", () => {
    const resolver = buildResolver({
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "src/page.tsx": 'import shared from "../shared/util"',
      "shared/util.ts": "export default 1",
    })
    expect(resolver.unresolvedImports("/repo/src/page.tsx")).toEqual([
      { specifier: "../shared/util", reason: "outside-sources" },
    ])
  })
})

describe("C4 — default output directory names are anchored, overridable", () => {
  const files = {
    "package.json": "{}",
    "src/app/builds/page.tsx": "export default () => null",
    "src/features/coverage/Card.tsx": "export default () => null",
    "dist/index.js": "",
    "coverage/lcov.ts": "",
    "packages/ui/package.json": "{}",
    "packages/ui/dist/index.ts": "",
    "packages/ui/src/out/Thing.tsx": "",
  }
  const build = (exclude?: readonly string[]) =>
    createProjectPaths({
      host: createMemoryHost({ files: prefixed(files) }),
      root: ROOT,
      ...(exclude === undefined ? {} : { exclude }),
    })

  it("keeps output-named directories nested in sources and drops them at package roots", () => {
    expect(build().glob("**/*.{ts,tsx,js}")).toEqual([
      "packages/ui/src/out/Thing.tsx",
      "src/app/builds/page.tsx",
      "src/features/coverage/Card.tsx",
    ])
    expect(build().isExcluded("/repo/src/app/builds/page.tsx")).toBe(false)
    expect(build().isExcluded("/repo/packages/ui/dist/index.ts")).toBe(true)
  })

  it("excludes output names outside the source roots", () => {
    const paths = createProjectPaths({
      host: createMemoryHost({ files: prefixed({ ...files, "tools/build/x.ts": "" }) }),
      root: ROOT,
      sourceRoots: ["src"],
    })
    expect(paths.isExcludedDir("tools/build")).toBe(true)
    expect(paths.isExcludedDir("src/app/builds")).toBe(false)
  })

  it("lets `!name` restore a default and a plain name exclude it at any depth", () => {
    expect(build(["!dist"]).isExcludedDir("dist")).toBe(false)
    expect(build(["builds"]).isExcludedDir("src/app/builds")).toBe(true)
    expect(build(["!node_modules"]).excludedDirs).toContain("node_modules")
  })

  it("explains anchored defaults in exclusions()", () => {
    expect(build().exclusions()).toContainEqual({ pattern: "/dist/", reason: "default" })
    expect(build(["!dist"]).exclusions()).not.toContainEqual({ pattern: "/dist/", reason: "default" })
  })
})

describe("path-shaped exclude entries are root-relative prefixes or globs", () => {
  const files = {
    "src/app/page.tsx": "",
    "src/app/legacy/page.tsx": "",
    "src/app/legacy-two/page.tsx": "",
    "src/app/old/deep/page.tsx": "",
    "src/app/x.legacy.tsx": "",
  }
  const build = (exclude: readonly string[]) =>
    createProjectPaths({ host: createMemoryHost({ files: prefixed(files) }), root: ROOT, exclude })

  it.each([["src/app/legacy"], ["src/app/legacy/"], ["/src/app/legacy"], ["./src/app/legacy/**"]])(
    "excludes the directory for %s without touching siblings",
    (entry) => {
      const paths = build([entry])
      expect(paths.glob("**/*.tsx")).not.toContain("src/app/legacy/page.tsx")
      expect(paths.glob("**/*.tsx")).toContain("src/app/legacy-two/page.tsx")
      expect(paths.isExcluded("/repo/src/app/legacy/page.tsx")).toBe(true)
    },
  )

  it("supports globs for directories and files", () => {
    expect(build(["**/old"]).isExcludedDir("src/app/old/deep")).toBe(true)
    expect(build(["src/**/*.legacy.tsx"]).glob("**/*.tsx")).not.toContain("src/app/x.legacy.tsx")
    expect(build(["src/**/*.legacy.tsx"]).isExcluded("/repo/src/app/x.legacy.tsx")).toBe(true)
  })

  it("ignores an entry that normalises to the whole root", () => {
    expect(build(["/**"]).glob("**/*.tsx")).toHaveLength(5)
  })

  it("partitions and normalises entries", () => {
    expect(partitionExcludes(["vendor", "src/x", "!dist"])).toEqual({
      names: ["vendor"],
      paths: ["src/x"],
      restored: new Set(["dist"]),
    })
    expect(normalizePathEntry("./src/a/**")).toBe("src/a")
    expect(normalizePathEntry("/**")).toBe("")
  })

  it("accepts Windows-style separators in a path entry", () => {
    expect(partitionExcludes(["src\\app\\legacy"]).paths).toEqual(["src/app/legacy"])
  })
})

describe("A7 — test-utils files and Cypress component tests are not app files", () => {
  it("treats test-utils.* as a non-app file and *.cy.* as excluded everywhere", () => {
    expect(isNonAppFile("src/test-utils.tsx")).toBe(true)
    expect(isExcludedFile("src/components/Button.cy.tsx")).toBe(true)
    expect(isNonAppFile("src/my-test-utils.tsx")).toBe(false)
    expect(isExcludedFile("src/fancy.tsx")).toBe(false)
  })

  it("keeps a file-route named test-utils discoverable", () => {
    expect(isExcludedFile("src/routes/test-utils.tsx")).toBe(false)
    expect(EXCLUDED_FILE.test("test-utils.vue")).toBe(false)
  })
})

describe("C7 / C19 — exportOrigin follows a barrel's own import binding", () => {
  const files = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    "src/components/Button.tsx": "export function Button(){ return null }",
    "src/components/Card.tsx": "export default function Card(){ return null }",
    "src/components/index.ts": 'import { Button } from "./Button"\nimport Card from "./Card"\nexport { Button, Card as Tile }',
    "src/components/card/index.ts": 'import Card from "../Card"\nexport default Card',
    "src/components/local.ts": "const Inner = 1\nexport { Inner as Outer }\nexport default Inner",
  }

  it("resolves named, renamed and default forwards to the declaring file", () => {
    const resolver = buildResolver(files)
    expect(resolver.declaredExport("/repo/src/components/index.ts", "Button")).toEqual({
      file: "/repo/src/components/Button.tsx",
      exportName: "Button",
    })
    expect(resolver.declaredExport("/repo/src/components/index.ts", "Tile")).toEqual({
      file: "/repo/src/components/Card.tsx",
      exportName: "default",
    })
    expect(resolver.declaredExport("/repo/src/components/card/index.ts", "default")).toEqual({
      file: "/repo/src/components/Card.tsx",
      exportName: "default",
    })
  })

  it("reports local declarations and aliases through one helper", () => {
    const source = parse("const Inner = 1\nexport { Inner as Outer }\nexport default Inner")
    expect(ast.exportOrigin(source, "Outer")).toMatchObject({ kind: "declared", name: "Inner" })
    expect(ast.exportOrigin(source, "default")).toMatchObject({ kind: "declared", name: "default" })
    expect(ast.exportOrigin(source, "Missing")).toBeNull()
    expect(ast.exportOrigin(parse('import { A as B } from "./a"\nexport { B as C }'), "C")).toEqual({
      kind: "imported",
      module: "./a",
      imported: "A",
    })
    expect(ast.exportOrigin(parse('import * as NS from "./a"\nexport { NS }'), "NS")).toBeNull()
  })
})

describe("C9 — walk is iterative and keeps pre-order", () => {
  it("visits a deep binary expression without overflowing the stack", () => {
    const expression = Array.from({ length: 20000 }, (_, index) => `"s${String(index)}"`).join(" + ")
    const source = ts.createSourceFile("/repo/big.ts", `export const BIG = ${expression}`, ts.ScriptTarget.ESNext, true)
    let count = 0
    walk(source, () => {
      count += 1
    })
    expect(count).toBeGreaterThan(40000)
  })

  it("visits nodes in the same order as a recursive forEachChild walk", () => {
    const source = parse("function A(){ if (x) return <B c={d ? 1 : [2, 3]} />; return null }\nconst e = { f: g(h, i) }")
    const recursive: ts.SyntaxKind[] = []
    const visit = (node: ts.Node): void => {
      recursive.push(node.kind)
      node.forEachChild(visit)
    }
    visit(source)
    const iterative: ts.SyntaxKind[] = []
    walk(source, (node) => {
      iterative.push(node.kind)
    })
    expect(iterative).toEqual(recursive)
  })
})
