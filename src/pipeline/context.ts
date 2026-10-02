import * as path from "node:path"
import type ts from "typescript"
import type { Ast } from "../core/ast.js"
import { createAst } from "../core/ast.js"
import type { FileBindingTable } from "../core/bindings.js"
import { createBindingTable } from "../core/bindings.js"
import type { DiagnosticCollector, DiagnosticInput } from "../core/diagnostics.js"
import { createDiagnosticCollector } from "../core/diagnostics.js"
import type { FileHost } from "../core/host.js"
import { createNodeHost, toPosix } from "../core/host.js"
import { readDependencies } from "../core/dependencies.js"
import type { Evidence, NodeLocator, TsconfigChain } from "../core/model.js"
import { sortedUnique } from "../core/order.js"
import type { ProjectPaths } from "../core/project.js"
import { createProjectPaths } from "../core/project.js"
import type { Resolver } from "../core/resolver.js"
import { createResolver } from "../core/resolver.js"
import type { StringTable } from "../core/strings.js"
import { createStringTable } from "../core/strings.js"
import { EMPTY_TSCONFIG_CHAIN, loadTsconfig } from "../core/tsconfig.js"
import type { TypeScriptApi } from "../core/tsconfig.js"
import { normalizeUrl } from "../core/url.js"
import type { TemplateCompilerApis, TemplateFrameworkSpec } from "../core/template-frameworks.js"
import type { TagResolution, TemplateSource, TemplateTagResolverFn } from "../core/template-doc.js"
import { lookupAmbient } from "../adapters/nuxt-components.js"
import type {
  AmbientComponent,
  DiscoverContext,
  EntryContext,
  LocalIdOptions,
  OpaqueEntryRef,
  ProjectContext,
  ScreenShape,
} from "../adapters/types.js"
import type { ResolvedConfig } from "../config/types.js"
import { bindingTableFor } from "../extractors/imported-declaration.js"
import { createTemplateSource } from "./template-frameworks.js"

export { readDependencies }

export const LOCAL_ID_PRAGMA = /@appgraph-id\s+([A-Za-z0-9_-]{1,64})/

export type GlobAttempt = {
  readonly pattern: string
  readonly matches: number
}

export type NearMiss = {
  readonly file: string
  readonly probe: string
}

export type PipelineEnv = {
  readonly ts: TypeScriptApi
  readonly ast: Ast
  readonly host: FileHost
  readonly paths: ProjectPaths
  readonly resolver: Resolver
  readonly strings: StringTable
  readonly tsconfig: TsconfigChain
  readonly config: ResolvedConfig
  readonly diagnostics: DiagnosticCollector
  readonly dependencies: ReadonlySet<string>
  /** Raw text of `<root>/package.json`, or null. The same read the dependency union already performs. */
  readonly rootManifest: string | null
  readonly globs: () => readonly GlobAttempt[]
  readonly nearMisses: () => readonly NearMiss[]
  readonly bindingsFor: (relPath: string) => FileBindingTable
  readonly sourceOf: (relPath: string) => ts.SourceFile | null
  readonly templates: TemplateSource
  readonly ambientComponents: () => readonly AmbientComponent[]
  readonly recordAmbientComponents: (entries: readonly AmbientComponent[]) => void
  readonly templateTagResolvers: () => readonly TemplateTagResolverFn[]
  readonly recordTemplateTagResolver: (resolver: TemplateTagResolverFn) => void
  readonly recordGlob: (pattern: string, matches: number) => void
  readonly recordNearMiss: (file: string, probe: string) => void
  readonly release: () => void
}

export type EnvInput = {
  readonly ts: TypeScriptApi
  readonly templates?: TemplateCompilerApis
  readonly frameworks?: readonly TemplateFrameworkSpec<unknown>[]
  readonly config: ResolvedConfig
  readonly host?: FileHost
  readonly tsconfig?: TsconfigChain
  readonly diagnostics?: DiagnosticCollector
  readonly dependencies?: Iterable<string>
}

const AMBIENT_EXPORT = "default"

const unambiguousAmbient = (entries: readonly AmbientComponent[]): ReadonlyMap<string, string> => {
  const claims = new Map<string, Set<string>>()
  for (const entry of entries) claims.set(entry.name, (claims.get(entry.name) ?? new Set()).add(entry.file))
  return new Map(
    [...claims].flatMap(([name, files]): [string, string][] => (files.size === 1 ? [[name, [...files][0] ?? ""]] : [])),
  )
}

const ambientResolutionOf = (byName: ReadonlyMap<string, string>, name: string): TagResolution | null => {
  const found = lookupAmbient({ byName, collisions: [] }, name)
  if (found === undefined) return null
  return { kind: "file", file: found.file, exportName: AMBIENT_EXPORT, via: found.lazy ? "lazy" : "ambient" }
}

const createAmbientResolver = (
  entries: () => readonly AmbientComponent[],
): ((names: readonly string[]) => TagResolution | null) => {
  let table: { readonly size: number; readonly byName: ReadonlyMap<string, string> } | null = null
  const byNameOf = (): ReadonlyMap<string, string> => {
    const current = entries()
    if (table === null || table.size !== current.length) table = { size: current.length, byName: unambiguousAmbient(current) }
    return table.byName
  }
  return (names) => {
    const byName = byNameOf()
    return names.reduce<TagResolution | null>((found, name) => found ?? ambientResolutionOf(byName, name), null)
  }
}

export const createEnv = (input: EnvInput): PipelineEnv => {
  const api = input.ts
  const ast = createAst(api)
  const host = input.host ?? createNodeHost()
  const config = input.config
  const diagnostics = input.diagnostics ?? createDiagnosticCollector()

  const paths = createProjectPaths({
    host,
    root: config.root,
    sourceRoots: config.sourceRoots,
    exclude: config.exclude,
    generated: config.generated,
  })

  const loaded = input.tsconfig === undefined ? loadTsconfig({ ts: api, host, root: paths.root, isExcludedDir: paths.isExcludedDir }) : null
  if (loaded !== null) for (const diagnostic of loaded.diagnostics) diagnostics.report(diagnostic)
  const tsconfig = input.tsconfig ?? loaded?.chain ?? EMPTY_TSCONFIG_CHAIN

  const resolver = createResolver({
    ts: api,
    host,
    paths,
    tsconfig,
    ...(config.candidateSuffixes.length > 0 ? { candidateSuffixes: config.candidateSuffixes } : {}),
    ...(config.extensionRewrites.length > 0 ? { extensionRewrites: config.extensionRewrites } : {}),
  })

  const strings = createStringTable(api)
  for (const relPath of config.stringSources) {
    const source = resolver.sourceFile(paths.abs(relPath))
    if (source !== null) strings.add(source)
  }

  const rootManifestPath = path.join(paths.root, "package.json")

  const manifests = sortedUnique([
    rootManifestPath,
    ...paths.sourceRoots.map((root) => path.join(root, "package.json")),
    ...paths.sourceRoots.map((root) => path.join(path.dirname(root), "package.json")),
  ])

  const dependencies =
    input.dependencies === undefined ? readDependencies(host, manifests) : new Set(input.dependencies)

  const globAttempts: GlobAttempt[] = []
  const nearMisses: NearMiss[] = []
  const bindingCache = new Map<string, FileBindingTable>()
  const ambient: AmbientComponent[] = []
  const tagResolvers: TemplateTagResolverFn[] = []

  const sourceOf = (relPath: string): ts.SourceFile | null => resolver.sourceFile(paths.abs(relPath))

  const templates = createTemplateSource({
    apis: input.templates,
    readFile: (relPath) => host.readFile(paths.abs(relPath)),
    ts: api,
    manifest: host.readFile(rootManifestPath),
    ambient: createAmbientResolver(() => ambient),
    resolvers: () => tagResolvers,
    ...(input.frameworks === undefined ? {} : { frameworks: input.frameworks }),
  })

  const bindingsFor = (relPath: string): FileBindingTable => {
    const cached = bindingCache.get(relPath)
    if (cached !== undefined) return cached

    const abs = paths.abs(relPath)
    const source = resolver.sourceFile(abs)
    const table =
      source === null
        ? createBindingTable({ ts: api, source: api.createSourceFile(abs, "", api.ScriptTarget.ESNext, true) })
        : bindingTableFor(api, source, (spec) => resolver.resolveModule(abs, spec))
    bindingCache.set(relPath, table)
    return table
  }

  return {
    ts: api,
    ast,
    host,
    paths,
    resolver,
    strings,
    tsconfig,
    config,
    diagnostics,
    dependencies,
    rootManifest: host.readFile(rootManifestPath),
    globs: () => [...globAttempts],
    nearMisses: () => [...nearMisses],
    bindingsFor,
    sourceOf,
    templates,
    ambientComponents: () => [...ambient],
    recordAmbientComponents: (entries) => {
      ambient.push(...entries)
    },
    templateTagResolvers: () => [...tagResolvers],
    recordTemplateTagResolver: (resolver) => {
      tagResolvers.push(resolver)
    },
    recordGlob: (pattern, matches) => {
      globAttempts.push({ pattern, matches })
    },
    recordNearMiss: (file, probe) => {
      nearMisses.push({ file, probe })
    },
    release: () => {
      bindingCache.clear()
      resolver.releaseSources()
    },
  }
}

type MemoStore<K, V> = {
  readonly get: (key: K) => V | undefined
  readonly set: (key: K, value: V) => unknown
}

const memoIn = <K, V>(cache: MemoStore<K, V>, key: K, create: () => V): V => {
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const created = create()
  cache.set(key, created)
  return created
}

const globCaches = new WeakMap<PipelineEnv, Map<string, readonly string[]>>()

const dependencyLists = new WeakMap<ReadonlySet<string>, readonly string[]>()

const globOnce = (env: PipelineEnv, pattern: string): readonly string[] =>
  memoIn(memoIn(globCaches, env, () => new Map<string, readonly string[]>()), pattern, () => env.paths.glob(pattern))

const dependencyListOf = (dependencies: ReadonlySet<string>): readonly string[] =>
  memoIn(dependencyLists, dependencies, () => [...dependencies])

export const createProjectContext = (env: PipelineEnv): ProjectContext => {
  const { paths } = env

  return {
    ts: env.ts,
    root: paths.root,
    rootLabel: paths.label,
    sourceRoots: paths.sourceRootsRel,
    dependencies: env.dependencies,
    hasDependency: (name) =>
      typeof name === "string"
        ? env.dependencies.has(name)
        : dependencyListOf(env.dependencies).some((entry) => name.test(entry)),
    tsconfig: env.tsconfig,
    glob: (pattern) => {
      const matches = globOnce(env, pattern)
      env.recordGlob(pattern, matches.length)
      return matches
    },
    readFile: (relPath) => env.host.readFile(paths.abs(relPath)),
    exists: (relPath) => env.host.exists(paths.abs(relPath)),
    isGenerated: (relPath) => paths.isGenerated(paths.abs(relPath)),
  }
}

type PragmaState = {
  readonly names: Map<string, Set<string>>
}

const pragmaTextAround = (api: TypeScriptApi, node: ts.Node): string => {
  const source = node.getSourceFile()
  if (source === undefined) return ""

  const leading = api.getLeadingCommentRanges(source.text, node.getFullStart()) ?? []
  const comments = leading.map((range) => source.text.slice(range.pos, range.end)).join("\n")

  const start = node.getStart(source)
  const { character } = api.getLineAndCharacterOfPosition(source, start)
  const lineEnd = source.text.indexOf("\n", start)
  const ownLine = source.text.slice(start - character, lineEnd === -1 ? undefined : lineEnd)

  return `${comments}\n${ownLine}`
}

export type DiscoverContextInput = {
  readonly env: PipelineEnv
  readonly plugin: string
}

export const createDiscoverContext = (input: DiscoverContextInput): DiscoverContext => {
  const { env } = input
  const { paths, resolver, ast } = env
  const api = env.ts
  const sink = env.diagnostics.forPlugin(input.plugin)
  const pragmas: PragmaState = { names: new Map() }

  const contextFor = (relPath: string) => {
    const source = env.sourceOf(relPath)
    return source === null ? null : env.strings.contextFor(source)
  }

  /**
   * §4.1: identity is STRUCTURAL. The pragma wins, then the ordinal; expression text is never
   * consulted, because a rename or a Prettier reflow would otherwise delete one screen and add
   * another.
   */
  const localId = (relPath: string, options?: LocalIdOptions): string => {
    const node = options?.node
    const pragma = node === undefined ? null : LOCAL_ID_PRAGMA.exec(pragmaTextAround(api, node))?.[1] ?? null

    if (pragma !== null) {
      const used = pragmas.names.get(relPath) ?? new Set<string>()
      if (used.has(pragma))
        sink.error(
          "screens/duplicate-id",
          `two '@appgraph-id ${pragma}' pragmas in '${relPath}'; falling back to the structural ordinal`,
          { file: relPath },
        )
      else {
        used.add(pragma)
        pragmas.names.set(relPath, used)
        return `${relPath}#${pragma}`
      }
    }

    return options?.ordinal === undefined ? relPath : `${relPath}#${String(options.ordinal)}`
  }

  const lineOf = (node: ts.Node): number => {
    const source = node.getSourceFile()
    if (source === undefined) return 1
    return api.getLineAndCharacterOfPosition(source, node.getStart(source)).line + 1
  }

  return {
    ...createProjectContext(env),
    ast,
    unwrap: ast.unwrap,
    sourceFile: env.sourceOf,
    resolveModule: (fromRel, spec) => {
      const resolved = resolver.resolveModule(paths.abs(fromRel), spec)
      return resolved === null ? null : toPosix(paths.rel(resolved))
    },
    declarationFile: (relPath, exportName) => toPosix(paths.rel(resolver.declarationFile(paths.abs(relPath), exportName))),
    declaredExport: (relPath, exportName) => {
      const declared = resolver.declaredExport(paths.abs(relPath), exportName)
      return { file: toPosix(paths.rel(declared.file)), exportName: declared.exportName }
    },
    bindingsFor: env.bindingsFor,
    strings: env.strings,
    locate: (relPath, at) => {
      const source = env.sourceOf(relPath)
      return source === null ? null : ast.resolveLocator(source, at)
    },
    locatorOf: (node) => ast.locate(node),
    flattenString: (node, relPath) => {
      const context = contextFor(relPath)
      return context === null ? null : ast.flattenString(node, context)
    },
    guardOf: (node, stopAt) => (stopAt === undefined ? ast.guardOf(node) : ast.guardOf(node, stopAt)),
    normalizeUrl,
    lineOf: (_relPath, node) => lineOf(node),
    localId,
    evidence: (what, relPath, node): Evidence => ({
      what,
      file: relPath,
      line: node === undefined ? 1 : lineOf(node),
    }),
    nearMiss: (relPath, probe) => env.recordNearMiss(relPath, probe),
    diagnostic: (diagnostic: DiagnosticInput) => sink.report(diagnostic),
  }
}

export const createEntryContext = (discover: DiscoverContext, screen: ScreenShape): EntryContext => ({
  ...discover,
  screen,
  opaque: (expr, relPath, line): OpaqueEntryRef => ({ kind: "opaque", expr, file: relPath, line }),
})

export const locatorKey = (locator: NodeLocator | undefined): string =>
  locator === undefined ? "" : `${locator.export}:${locator.path.join(".")}`
