import * as path from "node:path"
import type ts from "typescript"
import type { Diagnostic, ExtensionRewrite, TsconfigChain } from "./model.js"
import type { FileHost } from "./host.js"
import { toPosix } from "./host.js"
import { DEFAULT_EXCLUDED_DIRS, createProjectPaths } from "./project.js"
import { byCodepoint, sortedEntries, sortedRecord } from "./order.js"
import { SCRIPT_EXTENSIONS } from "./extensions.js"
import { hasNuxtDependency, resolveNuxtDirs } from "./nuxt-project.js"

export type TypeScriptApi = typeof ts

export type TsconfigLoadOptions = {
  readonly ts: TypeScriptApi
  readonly host: FileHost
  readonly root: string
  readonly configPath?: string
  readonly isExcludedDir?: (relDir: string) => boolean
}

export type TsconfigLoadResult = {
  readonly chain: TsconfigChain
  readonly diagnostics: readonly Diagnostic[]
}

export const EMPTY_TSCONFIG_CHAIN: TsconfigChain = {
  files: [],
  baseUrl: null,
  paths: {},
  include: [],
  moduleResolution: null,
  jsx: null,
}

export const NODE_STYLE_MODULE_RESOLUTIONS = ["node16", "nodenext"] as const

export const DEFAULT_EXTENSION_REWRITES: readonly ExtensionRewrite[] = [
  { from: ".js", to: [".ts", ".tsx"] },
  { from: ".jsx", to: [".tsx"] },
  { from: ".mjs", to: [".mts", ".ts"] },
]

export const isNodeStyleModuleResolution = (moduleResolution: string | null): boolean =>
  moduleResolution !== null &&
  (NODE_STYLE_MODULE_RESOLUTIONS as readonly string[]).includes(moduleResolution)

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")

const readIncludes = (raw: unknown): readonly string[] => {
  if (typeof raw !== "object" || raw === null) return []
  const include = (raw as Record<string, unknown>)["include"]
  return isStringArray(include) ? include : []
}

const enumName = (enumObject: Readonly<Record<number, string>>, value: number | undefined): string | null => {
  if (value === undefined) return null
  const name = enumObject[value]
  return name === undefined ? null : name.toLowerCase()
}

type LoadEnv = {
  readonly options: TsconfigLoadOptions
  readonly root: string
  readonly rel: (abs: string) => string
  readonly isExcludedDir: (absDir: string) => boolean
  readonly realFile: (abs: string) => string
  readonly nuxt: boolean
  readonly fileLists: Map<string, readonly string[]>
}

const FILE_NOT_FOUND = 6053

const CANNOT_READ_FILE = 5083

const NUXT_GENERATED_DIR = ".nuxt"

const QUOTED_FILE = /'([^']+)'/

const NUXT_SRC_ALIASES = ["~/*", "@/*"] as const

const NUXT_ROOT_ALIASES = ["~~/*", "@@/*"] as const

const NODE_MODULES_PACKAGE = /^(.*?)\/node_modules\/((?:@[^/]+\/)?[^/]+)(\/.*)?$/

const PNPM_PACKAGE_ENTRY = /^\s*-\s*["']?([^"'#\s]+)["']?/

const readJson = (host: FileHost, file: string): unknown => {
  const text = host.readFile(file)
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

const pnpmWorkspacePatterns = (text: string): readonly string[] => {
  const patterns: string[] = []
  let inPackages = false
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) inPackages = /^packages\s*:/.test(line)
    const entry = inPackages ? PNPM_PACKAGE_ENTRY.exec(line) : null
    if (entry?.[1] !== undefined) patterns.push(entry[1])
  }
  return patterns
}

const manifestWorkspacePatterns = (manifest: unknown): readonly string[] | null => {
  const workspaces = rawField(manifest, "workspaces")
  if (isStringArray(workspaces)) return workspaces
  const nested = rawField(workspaces, "packages")
  return isStringArray(nested) ? nested : null
}

const workspaceOf = (host: FileHost, startDir: string): { dir: string; patterns: readonly string[] } | null => {
  let current = startDir
  for (;;) {
    const pnpm = host.readFile(path.join(current, "pnpm-workspace.yaml"))
    if (pnpm !== null) return { dir: current, patterns: pnpmWorkspacePatterns(pnpm) }
    const patterns = manifestWorkspacePatterns(readJson(host, path.join(current, "package.json")))
    if (patterns !== null) return { dir: current, patterns }
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

const WORKSPACE_MAX_DEPTH = 6

const childDirs = (host: FileHost, dir: string): readonly string[] =>
  host
    .readDir(dir)
    .filter((entry) => entry.kind === "directory" && !OUT_OF_ROOT_EXCLUDED.has(entry.name) && !entry.name.startsWith("."))
    .map((entry) => path.join(dir, entry.name))

const descendantDirs = (host: FileHost, dir: string, depth: number): readonly string[] => {
  if (depth > WORKSPACE_MAX_DEPTH) return []
  return childDirs(host, dir).flatMap((child) => [child, ...descendantDirs(host, child, depth + 1)])
}

const expandWorkspaceGlob = (host: FileHost, workspaceDir: string, pattern: string): readonly string[] => {
  const trimmed = pattern.replace(/\/+$/, "")
  if (!trimmed.endsWith("/*") && !trimmed.endsWith("/**")) return [path.join(workspaceDir, trimmed)]
  const parent = path.join(workspaceDir, trimmed.replace(/\/\*\*?$/, ""))
  if (GLOB_SEGMENT.test(parent)) return []
  return trimmed.endsWith("/**") ? descendantDirs(host, parent, 1) : childDirs(host, parent)
}

const expandWorkspacePatterns = (host: FileHost, workspaceDir: string, patterns: readonly string[]): readonly string[] => {
  const negated = new Set(
    patterns
      .filter((pattern) => pattern.startsWith("!"))
      .flatMap((pattern) => expandWorkspaceGlob(host, workspaceDir, pattern.slice(1))),
  )
  return patterns
    .filter((pattern) => !pattern.startsWith("!"))
    .flatMap((pattern) => expandWorkspaceGlob(host, workspaceDir, pattern))
    .filter((dir) => !negated.has(dir))
}

/**
 * A package `extends` (`@acme/tsconfig/react.json`) resolves through `node_modules`. In a workspace
 * checkout without an install the package exists only under its workspace directory, so a
 * `node_modules/<name>/…` probe that misses on disk is answered from the workspace package of that name.
 */
const createWorkspacePackages = (host: FileHost, startDir: string): ((name: string) => string | null) => {
  let packages: ReadonlyMap<string, string> | null = null

  const load = (): ReadonlyMap<string, string> => {
    const workspace = workspaceOf(host, startDir)
    const found = new Map<string, string>()
    if (workspace === null) return found
    const dirs = expandWorkspacePatterns(host, workspace.dir, workspace.patterns)
    for (const dir of [...dirs].sort(byCodepoint)) {
      const name = rawField(readJson(host, path.join(dir, "package.json")), "name")
      if (typeof name === "string" && !found.has(name)) found.set(name, dir)
    }
    return found
  }

  return (name) => {
    packages ??= load()
    return packages.get(name) ?? null
  }
}

const createRealFile = (host: FileHost, startDir: string): ((abs: string) => string) => {
  const packageDir = createWorkspacePackages(host, startDir)
  return (abs) => {
    if (host.isFile(abs)) return abs
    const match = NODE_MODULES_PACKAGE.exec(toPosix(abs))
    const name = match?.[2]
    if (name === undefined) return abs
    const dir = packageDir(name)
    return dir === null ? abs : path.join(dir, match?.[3] ?? "")
  }
}

const OUT_OF_ROOT_EXCLUDED = new Set<string>(DEFAULT_EXCLUDED_DIRS)

const createDirFilter = (options: TsconfigLoadOptions, root: string): ((absDir: string) => boolean) => {
  const isProjectExcluded = options.isExcludedDir ?? createProjectPaths({ host: options.host, root }).isExcludedDir
  return (absDir) => {
    const relDir = toPosix(path.relative(root, absDir))
    if (relDir === ".." || relDir.startsWith("../") || path.isAbsolute(relDir))
      return OUT_OF_ROOT_EXCLUDED.has(path.basename(absDir))
    return isProjectExcluded(relDir)
  }
}

const scanFiles = (
  env: LoadEnv,
  rootDir: string,
  extensions: readonly string[],
  depth: number | undefined,
): readonly string[] => {
  const host = env.options.host
  const found: string[] = []

  const visit = (dir: string, level: number): void => {
    if (depth !== undefined && level > depth) return
    for (const entry of host.readDir(dir)) {
      if (entry.kind === "symlink") continue
      const abs = path.join(dir, entry.name)
      if (entry.kind === "directory") {
        if (env.isExcludedDir(abs)) continue
        visit(abs, level + 1)
        continue
      }
      if (entry.kind !== "file") continue
      if (extensions.length > 0 && !extensions.some((extension) => entry.name.endsWith(extension))) continue
      found.push(toPosix(abs))
    }
  }

  visit(rootDir, 0)
  return found.sort(byCodepoint)
}

const listFiles = (
  env: LoadEnv,
  rootDir: string,
  extensions: readonly string[],
  depth: number | undefined,
): readonly string[] => {
  const key = [rootDir, String(depth), ...extensions].join("\0")
  const cached = env.fileLists.get(key)
  if (cached !== undefined) return cached
  const files = scanFiles(env, rootDir, extensions, depth)
  env.fileLists.set(key, files)
  return files
}

const createParseConfigHost = (env: LoadEnv): ts.ParseConfigHost => ({
  useCaseSensitiveFileNames: true,
  fileExists: (fileName) => env.options.host.isFile(env.realFile(fileName)),
  readFile: (fileName) => env.options.host.readFile(env.realFile(fileName)) ?? undefined,
  readDirectory: (rootDir, extensions, _excludes, _includes, depth) => [...listFiles(env, rootDir, extensions, depth)],
})

type ParsedConfig = {
  readonly configPath: string
  readonly chain: TsconfigChain
  readonly diagnostics: readonly Diagnostic[]
  readonly raw: unknown
  readonly references: readonly string[]
}

const MAX_REFERENCE_DEPTH = 4

const GLOB_SEGMENT = /[*?{[]/

const rawField = (raw: unknown, key: string): unknown =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[key] : undefined

const isSolutionStyle = (parsed: ParsedConfig): boolean => {
  const files = rawField(parsed.raw, "files")
  return (
    parsed.references.length > 0 &&
    Array.isArray(files) &&
    files.length === 0 &&
    rawField(parsed.raw, "include") === undefined
  )
}

const referencedConfigPath = (host: FileHost, referencePath: string): string =>
  host.isFile(referencePath) ? referencePath : path.join(referencePath, "tsconfig.json")

const coveragePatterns = (configPath: string, raw: unknown): readonly string[] => {
  const include = rawField(raw, "include")
  const files = rawField(raw, "files")
  const declared = [...(isStringArray(include) ? include : []), ...(isStringArray(files) ? files : [])]
  const patterns = include === undefined && files === undefined ? ["**/*"] : declared
  return patterns.map((pattern) => toPosix(path.resolve(path.dirname(configPath), pattern)))
}

const TSC_WILDCARD = /[*?]/

const isImplicitDirectory = (segment: string): boolean => !TSC_WILDCARD.test(segment) && !/\.[^.]+$/.test(segment)

const segmentPattern = (segment: string): string =>
  segment
    .split("")
    .map((char) => {
      if (char === "*") return "[^/]*"
      if (char === "?") return "[^/]"
      return char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    })
    .join("")

const includeRegExp = (pattern: string): RegExp => {
  const segments = pattern.split("/")
  const body = segments
    .map((segment, index) => {
      if (segment === "**") return index === segments.length - 1 ? "(?:/.*)?" : "(?:/[^/]+)*"
      return `${index === 0 ? "" : "/"}${segmentPattern(segment)}`
    })
    .join("")
  const tail = isImplicitDirectory(segments.at(-1) ?? "") ? "(?:/.*)?" : ""
  return new RegExp(`^${body}${tail}$`)
}

const covers = (pattern: string, file: string): boolean => includeRegExp(pattern).test(file)

const coverageOf = (patterns: readonly string[], sources: readonly string[]): number =>
  sources.filter((file) => patterns.some((pattern) => covers(pattern, file))).length

const rebaseIncludes = (root: string, configPath: string, include: readonly string[]): readonly string[] => {
  const configDir = path.dirname(configPath)
  if (configDir === root) return include
  return include.map((pattern) => toPosix(path.relative(root, path.resolve(configDir, pattern))))
}

const optionalModuleSuffixes = (moduleSuffixes: readonly string[] | undefined) =>
  moduleSuffixes === undefined ? {} : { moduleSuffixes }

const mergeReferenced = (solution: TsconfigChain, referenced: TsconfigChain): TsconfigChain => {
  const ownsPaths = Object.keys(referenced.paths).length > 0
  return {
    files: ownsPaths ? [...solution.files, ...referenced.files] : [...referenced.files, ...solution.files],
    baseUrl: ownsPaths ? referenced.baseUrl : solution.baseUrl,
    paths: ownsPaths ? referenced.paths : solution.paths,
    include: referenced.include,
    moduleResolution: referenced.moduleResolution ?? solution.moduleResolution,
    jsx: referenced.jsx ?? solution.jsx,
    ...optionalModuleSuffixes(referenced.moduleSuffixes ?? solution.moduleSuffixes),
  }
}

const nuxtGeneratedFile = (env: LoadEnv, error: ts.Diagnostic): string | null => {
  if (!env.nuxt || error.code !== CANNOT_READ_FILE) return null
  const message = env.options.ts.flattenDiagnosticMessageText(error.messageText, " ")
  const file = QUOTED_FILE.exec(message)?.[1]
  if (file === undefined) return null
  return toPosix(file).split("/").includes(NUXT_GENERATED_DIR) ? env.rel(path.resolve(file)) : null
}

const diagnosticOf = (env: LoadEnv, configPath: string, error: ts.Diagnostic): Diagnostic => {
  const base = { code: "project/tsconfig-error", plugin: null, file: env.rel(configPath) }
  const message = env.options.ts.flattenDiagnosticMessageText(error.messageText, " ")
  const generated = nuxtGeneratedFile(env, error)
  if (generated !== null)
    return {
      ...base,
      severity: "info",
      message: `${generated} is generated by \`nuxi prepare\`; default aliases applied.`,
    }
  if (error.code === FILE_NOT_FOUND)
    return {
      ...base,
      severity: "warning",
      message: `${message} Continuing with the options this config resolves without it.`,
    }
  return { ...base, severity: "error", message }
}

const declaredPathsBase = (compilerOptions: ts.CompilerOptions): string | null => {
  const declared = compilerOptions["pathsBasePath"]
  return typeof declared === "string" ? path.resolve(declared) : null
}

const relativeTarget = (fromDir: string, target: string): string => {
  const relative = toPosix(path.relative(fromDir, target))
  return relative.startsWith("../") || relative === ".." ? relative : `./${relative}`
}

const pathsRebaser = (compilerOptions: ts.CompilerOptions, configDir: string): ((target: string) => string) => {
  const declaredBase = declaredPathsBase(compilerOptions)
  if (compilerOptions.baseUrl !== undefined || declaredBase === null || declaredBase === configDir) return (target) => target
  return (target) => relativeTarget(configDir, path.resolve(declaredBase, target))
}

const parseConfig = (env: LoadEnv, configPath: string): ParsedConfig => {
  const { options, root, rel } = env
  const api = options.ts
  const parseHost = createParseConfigHost(env)
  const configFile = api.readJsonConfigFile(configPath, (file) => options.host.readFile(file) ?? undefined)
  const parsed = api.parseJsonSourceFileConfigFileContent(configFile, parseHost, path.dirname(configPath))

  const diagnostics = parsed.errors.map((error) => diagnosticOf(env, configPath, error))

  const extended = configFile.extendedSourceFiles ?? []
  const files = [...extended.map((file) => rel(env.realFile(path.resolve(file)))), rel(configPath)]

  const rebase = pathsRebaser(parsed.options, path.dirname(configPath))
  const paths = Object.fromEntries(
    sortedEntries(parsed.options.paths ?? {}).map(([key, targets]) => [key, targets.map(rebase)] as const),
  )

  return {
    configPath,
    chain: {
      files,
      baseUrl: parsed.options.baseUrl === undefined ? null : rel(path.resolve(parsed.options.baseUrl)),
      paths,
      include: rebaseIncludes(root, configPath, readIncludes(parsed.raw)),
      moduleResolution: enumName(
        api.ModuleResolutionKind as unknown as Readonly<Record<number, string>>,
        parsed.options.moduleResolution,
      ),
      jsx: enumName(api.JsxEmit as unknown as Readonly<Record<number, string>>, parsed.options.jsx),
      ...optionalModuleSuffixes(parsed.options.moduleSuffixes),
    },
    diagnostics,
    raw: parsed.raw,
    references: (parsed.projectReferences ?? []).map((reference) =>
      referencedConfigPath(options.host, path.resolve(reference.path)),
    ),
  }
}

/**
 * A solution-style root (`files: []` plus `references`, the Vite template) compiles nothing itself:
 * the app's `paths` live in a referenced config. The one covering the most source files under the
 * root wins; ties keep reference order, so the pick is deterministic.
 */
const pickReference = (env: LoadEnv, references: readonly string[]): ParsedConfig | null => {
  const sources = listFiles(env, env.root, SCRIPT_EXTENSIONS, undefined).filter(
    (file) => !file.endsWith(".d.ts"),
  )

  let best: { parsed: ParsedConfig; coverage: number } | null = null
  for (const configPath of references) {
    if (!env.options.host.isFile(configPath)) continue
    const parsed = parseConfig(env, configPath)
    const coverage = coverageOf(coveragePatterns(configPath, parsed.raw), sources)
    if (coverage > 0 && (best === null || coverage > best.coverage)) best = { parsed, coverage }
  }
  return best?.parsed ?? null
}

const uniqueDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] => [
  ...new Map(diagnostics.map((diagnostic) => [`${diagnostic.file ?? ""} ${diagnostic.message}`, diagnostic])).values(),
]

const followReferences = (env: LoadEnv, parsed: ParsedConfig, visited: ReadonlySet<string>): TsconfigLoadResult => {
  const own = { chain: parsed.chain, diagnostics: parsed.diagnostics }
  if (!isSolutionStyle(parsed) || visited.size > MAX_REFERENCE_DEPTH) return own

  const references = parsed.references.filter((reference) => !visited.has(reference))
  const picked = pickReference(env, references)
  if (picked === null) return own

  const resolved = followReferences(env, picked, new Set([...visited, picked.configPath]))
  return {
    chain: mergeReferenced(parsed.chain, resolved.chain),
    diagnostics: uniqueDiagnostics([...parsed.diagnostics, ...resolved.diagnostics]),
  }
}

export const loadTsconfig = (options: TsconfigLoadOptions): TsconfigLoadResult => {
  const root = path.resolve(options.root)
  const configPath = path.resolve(options.configPath ?? path.join(root, "tsconfig.json"))
  const rel = (abs: string) => toPosix(path.relative(root, abs))

  if (!options.host.isFile(configPath)) {
    return {
      chain: EMPTY_TSCONFIG_CHAIN,
      diagnostics: [
        {
          severity: "error",
          code: "project/no-tsconfig",
          message: `No tsconfig.json found. Searched: ${rel(configPath)}`,
          plugin: null,
          file: rel(configPath),
        },
      ],
    }
  }

  const env = {
    options,
    root,
    rel,
    isExcludedDir: createDirFilter(options, root),
    realFile: createRealFile(options.host, root),
    nuxt: hasNuxtDependency(options.host, root),
    fileLists: new Map<string, readonly string[]>(),
  }
  const loaded = followReferences(env, parseConfig(env, configPath), new Set([configPath]))
  return env.nuxt ? { ...loaded, chain: withNuxtAliases(options, root, loaded.chain) } : loaded
}

const aliasTarget = (baseDir: string, targetDir: string): string => {
  const relative = toPosix(path.relative(baseDir, targetDir))
  return relative === "" ? "./*" : `./${relative}/*`
}

const withNuxtAliases = (options: TsconfigLoadOptions, root: string, chain: TsconfigChain): TsconfigChain => {
  const baseDir = pathsBaseDir(root, chain)
  const srcDir = path.resolve(root, resolveNuxtDirs({ ts: options.ts, host: options.host, root }).srcDir)
  const defaults = [
    ...NUXT_SRC_ALIASES.map((alias) => [alias, [aliasTarget(baseDir, srcDir)]] as const),
    ...NUXT_ROOT_ALIASES.map((alias) => [alias, [aliasTarget(baseDir, root)]] as const),
  ].filter(([alias]) => chain.paths[alias] === undefined)
  if (defaults.length === 0) return chain
  return { ...chain, paths: sortedRecord({ ...chain.paths, ...Object.fromEntries(defaults) }) }
}

// `paths` targets are resolved against `baseUrl` when set, otherwise against the directory of the
// entry tsconfig. `parseConfig` rebases targets an extended config declared without `baseUrl` from
// TypeScript's `pathsBasePath` onto that directory, so the two agree.
export const pathsBaseDir = (root: string, chain: TsconfigChain): string => {
  if (chain.baseUrl !== null) return path.resolve(root, chain.baseUrl)
  const entryConfig = chain.files[chain.files.length - 1]
  if (entryConfig === undefined) return path.resolve(root)
  return path.dirname(path.resolve(root, entryConfig))
}
