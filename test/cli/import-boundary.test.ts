import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const REPO = fileURLToPath(new URL("../../", import.meta.url))

const LIGHT_ROOT_FILES = ["src/cli/bin.ts", "src/cli/args.ts", "src/cli/commands.ts", "src/cli/stale.ts", "src/cli/index.ts"] as const

const LIGHT_ROOT_DIRS = ["src/cli/query"] as const

const QUERY_RUNTIME_FILES = ["src/cli/query/runtime.ts", "src/cli/query/output.ts"] as const

const FORBIDDEN_PACKAGES = ["typescript"] as const

const FORBIDDEN_FILES = ["src/pipeline/run.ts", "src/emit/assets/generated.ts"] as const

const FORBIDDEN_DIRS = ["src/adapters/", "src/extractors/"] as const

const REPORT_UI_SRC = "report-ui/src"

const REPORT_UI_ALIAS = "@appgraph/"

const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const

type ModuleEdges = {
  readonly files: readonly string[]
  readonly packages: readonly string[]
}

const toRepoPath = (abs: string): string => path.relative(REPO, abs).split(path.sep).join("/")

const isTypeOnlyImport = (node: ts.ImportDeclaration): boolean => node.importClause?.isTypeOnly === true

const valueSpecifiers = (source: ts.SourceFile): readonly string[] =>
  source.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement) && !isTypeOnlyImport(statement) && ts.isStringLiteral(statement.moduleSpecifier))
      return [statement.moduleSpecifier.text]
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    )
      return [statement.moduleSpecifier.text]
    return []
  })

const parse = (abs: string): ts.SourceFile =>
  ts.createSourceFile(abs, fs.readFileSync(abs, "utf8"), ts.ScriptTarget.ESNext, false)

const resolveRelative = (from: string, specifier: string): string => {
  const target = path.resolve(path.dirname(from), specifier)
  const stem = target.replace(/\.js$/, "")
  const candidates = [...SOURCE_EXTENSIONS.map((extension) => `${stem}${extension}`), ...SOURCE_EXTENSIONS.map((extension) => path.join(stem, `index${extension}`))]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (found === undefined) throw new Error(`cannot resolve ${specifier} from ${toRepoPath(from)}`)
  return found
}

const packageNameOf = (specifier: string): string => {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier)
}

const edgesOf = (abs: string): ModuleEdges => {
  const specifiers = valueSpecifiers(parse(abs))
  return {
    files: specifiers.filter((specifier) => specifier.startsWith(".")).map((specifier) => resolveRelative(abs, specifier)),
    packages: specifiers.filter((specifier) => !specifier.startsWith(".")).map(packageNameOf),
  }
}

type Reach = {
  readonly files: ReadonlySet<string>
  readonly packagesByFile: ReadonlyMap<string, readonly string[]>
}

const reachFrom = (roots: readonly string[]): Reach => {
  const files = new Set<string>()
  const packagesByFile = new Map<string, readonly string[]>()
  const pending = [...roots]
  while (pending.length > 0) {
    const next = pending.pop()
    if (next === undefined || files.has(next)) continue
    files.add(next)
    const edges = edgesOf(next)
    packagesByFile.set(next, edges.packages)
    pending.push(...edges.files)
  }
  return { files, packagesByFile }
}

const sourceFilesUnder = (dirAbs: string): readonly string[] => {
  if (!fs.existsSync(dirAbs)) return []
  return fs
    .readdirSync(dirAbs, { recursive: true, encoding: "utf8" })
    .filter((entry) => SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension)))
    .filter((entry) => !entry.endsWith(".d.ts"))
    .map((entry) => path.join(dirAbs, entry))
    .sort()
}

const lightRoots = (): readonly string[] => [
  ...LIGHT_ROOT_FILES.map((file) => path.join(REPO, file)),
  ...LIGHT_ROOT_DIRS.flatMap((dir) => sourceFilesUnder(path.join(REPO, dir))),
]

const isForbiddenFile = (repoPath: string): boolean =>
  FORBIDDEN_FILES.some((file) => file === repoPath) || FORBIDDEN_DIRS.some((dir) => repoPath.startsWith(dir))

const forbiddenPackageUses = (reach: Reach): readonly string[] =>
  [...reach.packagesByFile].flatMap(([file, packages]) =>
    packages
      .filter((name) => FORBIDDEN_PACKAGES.some((forbidden) => forbidden === name))
      .map((name) => `${toRepoPath(file)} -> ${name}`),
  )

const nodeBuiltinUses = (reach: Reach): readonly string[] =>
  [...reach.packagesByFile].flatMap(([file, packages]) =>
    packages.filter((name) => name.startsWith("node:")).map((name) => `${toRepoPath(file)} -> ${name}`),
  )

const reportUiAliasRoots = (): readonly string[] =>
  sourceFilesUnder(path.join(REPO, REPORT_UI_SRC)).flatMap((file) =>
    valueSpecifiers(parse(file))
      .filter((specifier) => specifier.startsWith(REPORT_UI_ALIAS))
      .map((specifier) => resolveRelative(path.join(REPO, "src", "index.ts"), `./${specifier.slice(REPORT_UI_ALIAS.length)}`)),
  )

describe("CLI import boundary", () => {
  const reach = reachFrom(lightRoots())

  it("walks at least the bin and args entries", () => {
    const reached = [...reach.files].map(toRepoPath)
    for (const root of LIGHT_ROOT_FILES) expect(reached).toContain(root)
  })

  it("walks the query runtime and its output helpers", () => {
    const reached = [...reach.files].map(toRepoPath)
    for (const file of QUERY_RUNTIME_FILES) expect(reached).toContain(file)
  })

  it("never statically reaches the pipeline, the HTML template, adapters or extractors", () => {
    expect([...reach.files].map(toRepoPath).filter(isForbiddenFile)).toEqual([])
  })

  it("never imports the typescript compiler as a value", () => {
    expect(forbiddenPackageUses(reach)).toEqual([])
  })

  it("keeps bin.ts free of static imports into the CLI body", () => {
    expect(edgesOf(path.join(REPO, "src/cli/bin.ts")).files).toEqual([])
  })
})

describe("report-ui shared modules", () => {
  const roots = reportUiAliasRoots()

  it("finds the src modules report-ui imports through the alias", () => {
    expect(roots.length).toBeGreaterThan(0)
  })

  it("have no node: imports anywhere in their static graph", () => {
    expect(nodeBuiltinUses(reachFrom(roots))).toEqual([])
  })
})
