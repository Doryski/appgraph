import * as path from "node:path"
import type ts from "typescript"
import type { ExtensionRewrite, ModuleResolutionOptions, TsconfigChain } from "./model.js"
import type { FileHost } from "./host.js"
import type { ProjectPaths } from "./project.js"
import type { TypeScriptApi } from "./tsconfig.js"
import type { DiagnosticInput } from "./diagnostics.js"
import { DEFAULT_EXTENSION_REWRITES, pathsBaseDir } from "./tsconfig.js"
import { byCodepoint, sortedUniqueBy, stableUnique } from "./order.js"
import { isSourceFile, stripSourceExtension } from "./extensions.js"
import { createScriptSource } from "./source-file.js"
import { createAst } from "./ast.js"

export const DEFAULT_CANDIDATE_SUFFIXES = [
  "",
  ".tsx",
  ".ts",
  "/index.tsx",
  "/index.ts",
  ".js",
  ".jsx",
  "/index.js",
] as const

const MAX_REEXPORT_HOPS = 6

export type Alias = {
  readonly prefix: string
  readonly suffix: string
  readonly targets: readonly string[]
  readonly wildcard: boolean
}

export type ImportBinding = {
  readonly file: string
  readonly imported: string
}

export type DeclaredExport = {
  readonly file: string
  readonly exportName: string
}

export type ImportsResult = {
  readonly bindings: ReadonlyMap<string, ImportBinding>
  readonly files: readonly string[]
  readonly unresolved: readonly string[]
}

export type ResolverOptions = {
  readonly ts: TypeScriptApi
  readonly host: FileHost
  readonly paths: ProjectPaths
  readonly tsconfig: TsconfigChain
  readonly candidateSuffixes?: readonly string[]
  readonly extensionRewrites?: readonly ExtensionRewrite[]
}

export type Resolver = {
  readonly root: string
  readonly options: ModuleResolutionOptions
  readonly aliases: readonly Alias[]
  readonly relative: (abs: string) => string
  readonly sourceFile: (abs: string) => ts.SourceFile | null
  readonly resolveModule: (fromAbs: string, spec: string) => string | null
  readonly probeTrace: (fromAbs: string, spec: string) => readonly string[]
  readonly declarationFile: (abs: string, name: string) => string
  readonly declaredExport: (abs: string, name: string) => DeclaredExport
  readonly imports: (abs: string) => ImportsResult
  readonly unresolvedImports: (abs: string) => readonly UnresolvedImport[]
  readonly unresolvedImportDiagnostics: (absFiles: readonly string[]) => readonly DiagnosticInput[]
  readonly componentName: (abs: string) => string
  readonly releaseSources: () => void
}

export const UNRESOLVED_IMPORT_CODE = "project/unresolved-import"

export const UNRESOLVED_IMPORT_REASONS = ["missing", "outside-sources"] as const

export type UnresolvedImport = {
  readonly specifier: string
  readonly reason: (typeof UNRESOLVED_IMPORT_REASONS)[number]
}

const UNRESOLVED_IMPORT_MESSAGES = {
  missing: "does not resolve to any file",
  "outside-sources": "resolves to a file outside the analyzed source roots or inside an excluded directory",
} as const satisfies Record<UnresolvedImport["reason"], string>

const DECLARATION_SUFFIXES = [".d.ts", "/index.d.ts"] as const

const unresolvedImportDiagnostic = (file: string, entry: UnresolvedImport): DiagnosticInput => ({
  severity: "info",
  code: UNRESOLVED_IMPORT_CODE,
  message: `Import '${entry.specifier}' ${UNRESOLVED_IMPORT_MESSAGES[entry.reason]}; reachability stops there.`,
  file,
})

export const buildAliases = (root: string, tsconfig: TsconfigChain): readonly Alias[] => {
  const baseDir = pathsBaseDir(root, tsconfig)

  return Object.entries(tsconfig.paths)
    .map(([pattern, targets]) => {
      const star = pattern.indexOf("*")
      const wildcard = star !== -1
      return {
        prefix: wildcard ? pattern.slice(0, star) : pattern,
        suffix: wildcard ? pattern.slice(star + 1) : "",
        wildcard,
        targets: targets.map((target) => path.resolve(baseDir, target)),
      }
    })
    .sort((a, b) =>
      a.prefix.length === b.prefix.length ? byCodepoint(a.prefix, b.prefix) : b.prefix.length - a.prefix.length,
    )
}

const applyRewrite = (base: string, rewrite: ExtensionRewrite): readonly string[] => {
  if (!base.endsWith(rewrite.from)) return []
  const stem = base.slice(0, base.length - rewrite.from.length)
  return rewrite.to.map((extension) => `${stem}${extension}`)
}

export const createResolver = (options: ResolverOptions): Resolver => {
  const { host, paths: project } = options
  const api = options.ts
  const candidateSuffixes = options.candidateSuffixes ?? [...DEFAULT_CANDIDATE_SUFFIXES]
  const extensionRewrites = options.extensionRewrites ?? DEFAULT_EXTENSION_REWRITES
  const aliases = buildAliases(project.root, options.tsconfig)
  const baseUrlDir = options.tsconfig.baseUrl === null ? null : path.resolve(project.root, options.tsconfig.baseUrl)
  const ast = createAst(api)

  const sources = new Map<string, ts.SourceFile | null>()
  const declarations = new Map<string, DeclaredExport>()
  const resolutions = new Map<string, string | null>()

  const sourceFile = (abs: string): ts.SourceFile | null => {
    const cached = sources.get(abs)
    if (cached !== undefined) return cached

    const text = host.readFile(abs)
    const parsed = text === null ? null : createScriptSource(api, abs, text)
    sources.set(abs, parsed)
    return parsed
  }

  const candidatesFor = (base: string): readonly string[] => {
    const rewritten = extensionRewrites.flatMap((rewrite) => applyRewrite(base, rewrite))
    const fallback = candidateSuffixes.map((suffix) => `${base}${suffix}`)
    return stableUnique([...rewritten, ...fallback])
  }

  const basesFor = (fromAbs: string, spec: string): readonly string[] => {
    if (spec.startsWith(".")) return [path.resolve(path.dirname(fromAbs), spec)]

    for (const alias of aliases) {
      if (!alias.wildcard) {
        if (spec === alias.prefix) return alias.targets
        continue
      }
      if (!spec.startsWith(alias.prefix) || !spec.endsWith(alias.suffix)) continue
      const captured = spec.slice(alias.prefix.length, spec.length - alias.suffix.length)
      return alias.targets.map((target) =>
        target.includes("*") ? target.replace("*", captured) : path.join(target, captured),
      )
    }

    return baseUrlDir === null ? [] : [path.resolve(baseUrlDir, spec)]
  }

  const probeTrace = (fromAbs: string, spec: string): readonly string[] =>
    basesFor(fromAbs, spec).flatMap((base) => candidatesFor(base))

  const accept = (candidate: string): boolean =>
    isSourceFile(candidate) &&
    project.contains(candidate) &&
    host.isFile(candidate) &&
    !project.isExcluded(candidate)

  const resolveModule = (fromAbs: string, spec: string): string | null => {
    const key = `${fromAbs}\u0000${spec}`
    const cached = resolutions.get(key)
    if (cached !== undefined) return cached

    const resolved = probeTrace(fromAbs, spec).find(accept) ?? null
    resolutions.set(key, resolved)
    return resolved
  }

  const collectImports = (abs: string): ImportsResult => {
    const bindings = new Map<string, ImportBinding>()
    const files = new Set<string>()
    const unresolved: string[] = []
    const source = sourceFile(abs)
    if (source === null) return { bindings, files: [], unresolved: [] }

    for (const statement of source.statements) {
      if (!api.isImportDeclaration(statement) || !api.isStringLiteral(statement.moduleSpecifier)) continue

      const file = resolveModule(abs, statement.moduleSpecifier.text)
      if (file === null) {
        unresolved.push(statement.moduleSpecifier.text)
        continue
      }
      files.add(file)

      const clause = statement.importClause
      if (clause === undefined) continue
      if (clause.name !== undefined) bindings.set(clause.name.text, { file, imported: "default" })
      if (clause.namedBindings === undefined) continue
      if (api.isNamespaceImport(clause.namedBindings))
        bindings.set(clause.namedBindings.name.text, { file, imported: "*" })
      if (api.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements)
          bindings.set(element.name.text, {
            file,
            imported: element.propertyName?.text ?? element.name.text,
          })
    }

    return {
      bindings,
      files: [...files].sort(byCodepoint),
      unresolved: stableUnique(unresolved).sort(byCodepoint),
    }
  }

  const importResults = new Map<string, ImportsResult>()

  const imports = (abs: string): ImportsResult => {
    const cached = importResults.get(abs)
    if (cached !== undefined) return cached
    const result = collectImports(abs)
    importResults.set(abs, result)
    return result
  }

  const reExports = (source: ts.SourceFile) =>
    source.statements.filter(api.isExportDeclaration).filter((statement) => statement.moduleSpecifier !== undefined)

  const findDeclaration = (abs: string, name: string, hops: number): DeclaredExport => {
    const here = { file: abs, exportName: name }
    if (hops > MAX_REEXPORT_HOPS) return here

    const source = sourceFile(abs)
    if (source === null) return here

    const origin = ast.exportOrigin(source, name)
    if (origin?.kind === "declared") return { file: abs, exportName: origin.name }
    if (origin?.kind === "imported") {
      const target = resolveModule(abs, origin.module)
      return target === null ? here : findDeclaration(target, origin.imported, hops + 1)
    }

    for (const statement of reExports(source)) {
      const specifier = statement.moduleSpecifier
      if (specifier === undefined || !api.isStringLiteral(specifier)) continue

      const target = resolveModule(abs, specifier.text)
      if (target === null) continue

      const clause = statement.exportClause
      if (clause !== undefined && api.isNamedExports(clause)) {
        const element = clause.elements.find((candidate) => candidate.name.text === name)
        if (element !== undefined)
          return findDeclaration(target, element.propertyName?.text ?? element.name.text, hops + 1)
        continue
      }

      if (clause === undefined && name !== "default") {
        const targetSource = sourceFile(target)
        if (targetSource !== null && ast.declarationOf(targetSource, name) !== null)
          return { file: target, exportName: name }
        const deeper = findDeclaration(target, name, hops + 1)
        if (deeper.file !== target) return deeper
      }
    }

    return here
  }

  const declaredExport = (abs: string, name: string): DeclaredExport => {
    const key = `${abs}#${name}`
    const cached = declarations.get(key)
    if (cached !== undefined) return cached

    const resolved = findDeclaration(abs, name, 0)
    declarations.set(key, resolved)
    return resolved
  }

  const declarationFile = (abs: string, name: string): string => declaredExport(abs, name).file

  const matchesAlias = (spec: string): boolean =>
    aliases.some((alias) =>
      alias.wildcard ? spec.startsWith(alias.prefix) && spec.endsWith(alias.suffix) : spec === alias.prefix,
    )

  const isProjectSpecifier = (spec: string): boolean =>
    !spec.includes("?") && (spec.startsWith(".") || matchesAlias(spec))

  const hasDeclarationFile = (fromAbs: string, spec: string): boolean =>
    basesFor(fromAbs, spec).some((base) => DECLARATION_SUFFIXES.some((suffix) => host.isFile(`${base}${suffix}`)))

  const unresolvedReason = (fromAbs: string, spec: string): UnresolvedImport["reason"] | null => {
    const existing = probeTrace(fromAbs, spec).find((candidate) => host.isFile(candidate))
    if (existing !== undefined) return isSourceFile(existing) ? "outside-sources" : null
    return hasDeclarationFile(fromAbs, spec) ? null : "missing"
  }

  const unresolvedImports = (abs: string): readonly UnresolvedImport[] => {
    const source = sourceFile(abs)
    if (source === null) return []
    const specifiers = ast
      .moduleReferences(source)
      .filter((reference) => !reference.typeOnly && isProjectSpecifier(reference.specifier))
      .map((reference) => reference.specifier)
      .filter((spec) => resolveModule(abs, spec) === null)
    return sortedUniqueBy(
      specifiers.flatMap((specifier) => {
        const reason = unresolvedReason(abs, specifier)
        return reason === null ? [] : [{ specifier, reason }]
      }),
      (entry) => entry.specifier,
    )
  }

  const unresolvedImportDiagnostics = (absFiles: readonly string[]): readonly DiagnosticInput[] =>
    absFiles.flatMap((abs) =>
      unresolvedImports(abs).map((entry) => unresolvedImportDiagnostic(project.rel(abs), entry)),
    )

  const componentName = (abs: string): string => {
    const base = stripSourceExtension(path.basename(abs))
    if (base !== "index") return base
    return path.basename(path.dirname(abs))
  }

  return {
    root: project.root,
    options: {
      candidateSuffixes,
      extensionRewrites,
      sourceRoots: project.sourceRoots,
    },
    aliases,
    relative: project.rel,
    sourceFile,
    resolveModule,
    probeTrace,
    declarationFile,
    declaredExport,
    imports,
    unresolvedImports,
    unresolvedImportDiagnostics,
    componentName,
    releaseSources: () => {
      sources.clear()
    },
  }
}
