import * as path from "node:path"
import type ts from "typescript"
import type { Ast } from "../core/ast.js"
import { createAst } from "../core/ast.js"
import type { FileHost } from "../core/host.js"
import { createNodeHost, globToRegExp } from "../core/host.js"
import type { Diagnostic, ExtensionRewrite, TsconfigChain } from "../core/model.js"
import { byCodepoint, sortedUnique } from "../core/order.js"
import type { ProjectPaths } from "../core/project.js"
import { createProjectPaths, isGeneratedContent } from "../core/project.js"
import type { TypeScriptApi } from "../core/tsconfig.js"
import {
  DEFAULT_EXTENSION_REWRITES,
  EMPTY_TSCONFIG_CHAIN,
  isNodeStyleModuleResolution,
  loadTsconfig,
} from "../core/tsconfig.js"
import type { ProjectContext } from "../adapters/types.js"
import { isReactNativeProject, platformCandidateSuffixes } from "../core/platform.js"
import { DEFAULT_CANDIDATE_SUFFIXES } from "../core/resolver.js"
import { SOURCE_EXTENSIONS, globOf } from "../core/extensions.js"
import { createScriptSource } from "../core/source-file.js"

export const SOURCE_FILE_GLOB = globOf(SOURCE_EXTENSIONS)

const MANIFEST_KEYS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const

const NODE_NEXT_CANDIDATE_SUFFIXES = ["/index.ts", "/index.tsx", "/index.js"] as const

const candidateSuffixesOf = (
  tsconfig: TsconfigChain,
  dependencies: ReadonlySet<string>,
): readonly string[] => {
  const nodeStyle = isNodeStyleModuleResolution(tsconfig.moduleResolution)
  const nodeSuffixes = nodeStyle ? [...NODE_NEXT_CANDIDATE_SUFFIXES] : []
  const reactNative = isReactNativeProject(dependencies)
  if (!reactNative && tsconfig.moduleSuffixes === undefined) return nodeSuffixes
  const base = [...new Set([...DEFAULT_CANDIDATE_SUFFIXES, ...nodeSuffixes])]
  return platformCandidateSuffixes(base, tsconfig.moduleSuffixes ?? null, reactNative)
}

const DOT_SEGMENT = /^\./

export type GlobAttempt = {
  readonly pattern: string
  readonly matches: number
}

/**
 * §10.7: `"typescript": "npm:@typescript/typescript6@^6.0.2"` is a common host pin, so
 * the alias target is split off the LAST `@` — the first one belongs to the scope.
 */
export const parseNpmAlias = (spec: string): { readonly target: string; readonly range: string } | null => {
  if (!spec.startsWith("npm:")) return null

  const rest = spec.slice("npm:".length)
  const at = rest.lastIndexOf("@")
  if (at <= 0) return { target: rest, range: "*" }
  return { target: rest.slice(0, at), range: rest.slice(at + 1) }
}

export type DependencyAlias = {
  readonly name: string
  readonly manifest: string
  readonly spec: string
  readonly target: string
  readonly range: string
}

export type DependencyUnion = {
  readonly names: ReadonlySet<string>
  readonly aliases: readonly DependencyAlias[]
  readonly manifests: readonly string[]
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null

/**
 * Dependency PRESENCE keys on the manifest key and never on the value (§10.7). The values are read
 * only to report the `npm:` alias form, never to interpret a range as semver.
 */
export const readDependencyUnion = (
  host: FileHost,
  root: string,
  manifests: readonly string[],
): DependencyUnion => {
  const names = new Set<string>()
  const aliases: DependencyAlias[] = []
  const found: string[] = []

  for (const manifest of manifests) {
    const text = host.readFile(path.resolve(root, manifest))
    if (text === null) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }

    const record = asRecord(parsed)
    if (record === null) continue
    found.push(manifest)

    for (const key of MANIFEST_KEYS) {
      const section = asRecord(record[key])
      if (section === null) continue

      for (const [name, spec] of Object.entries(section)) {
        names.add(name)
        if (typeof spec !== "string") continue
        const alias = parseNpmAlias(spec)
        if (alias !== null) aliases.push({ name, manifest, spec, target: alias.target, range: alias.range })
      }
    }
  }

  return {
    names,
    aliases: [...aliases].sort((a, b) => byCodepoint(`${a.name}|${a.manifest}`, `${b.name}|${b.manifest}`)),
    manifests: sortedUnique(found),
  }
}

/** Root manifest plus the nearest ancestor manifest of every source root (§10.5). */
export const manifestCandidates = (sourceRootsRel: readonly string[]): readonly string[] => {
  const candidates = ["package.json"]

  for (const root of sourceRootsRel) {
    if (root === "." || root === "") continue
    const segments = root.split("/")
    for (let index = segments.length; index > 0; index -= 1)
      candidates.push(`${segments.slice(0, index).join("/")}/package.json`)
  }

  return sortedUnique(candidates)
}

const firstSegment = (value: string): string => {
  const cleaned = value.replace(/^\.\//, "")
  const segment = cleaned.split("/")[0] ?? ""
  return segment
}

const isUsableRootSegment = (segment: string): boolean =>
  segment !== "" &&
  segment !== "." &&
  segment !== ".." &&
  segment !== "*" &&
  !segment.includes("*") &&
  !DOT_SEGMENT.test(segment)

const ROOT_SOURCE_ROOTS = ["."] as const

const coversRoot = (pattern: string): boolean => firstSegment(pattern).includes("*")

/**
 * §10.5: `include` patterns, `baseUrl` and **all** `paths` targets each contribute their first path
 * segment. A segment only survives if it is a real directory, so a `paths` entry pointing into
 * `node_modules` or into a sibling package that is not checked out cannot invent a source root.
 * An `include` that starts with a wildcard (the Next.js template's `**` globs) covers the whole root,
 * so the root joins the narrow roots: imports anywhere resolve, and the narrow roots keep anchoring
 * the directory-vocabulary kind rules (`app/hooks/` stays traversable).
 */
export const deriveSourceRoots = (options: {
  readonly paths: ProjectPaths
  readonly tsconfig: TsconfigChain
}): readonly string[] => {
  const { tsconfig } = options
  const candidates: string[] = []

  for (const pattern of tsconfig.include) candidates.push(firstSegment(pattern))
  if (tsconfig.baseUrl !== null && tsconfig.baseUrl !== "") candidates.push(firstSegment(tsconfig.baseUrl))
  for (const targets of Object.values(tsconfig.paths)) for (const target of targets) candidates.push(firstSegment(target))

  const kept = sortedUnique(candidates.filter(isUsableRootSegment)).filter((segment) => {
    const abs = options.paths.abs(segment)
    return !options.paths.isExcluded(abs) && options.paths.rel(abs) === segment
  })

  const existing = kept.filter((segment) => options.paths.abs(segment) !== options.paths.root)
  if (existing.length === 0) return ROOT_SOURCE_ROOTS
  return tsconfig.include.some(coversRoot) ? sortedUnique([...ROOT_SOURCE_ROOTS, ...existing]) : existing
}

export type GeneratedReason = "config-glob" | "generated-marker" | "generated-basename"

export type GeneratedFile = {
  readonly file: string
  readonly reason: GeneratedReason
}

const PACKAGE_MANIFEST = "/package.json"

export const isInNestedPackage = (file: string, dirs: readonly string[]): boolean =>
  dirs.some((dir) => file.startsWith(`${dir}/`))

const ROOT_MANIFEST = "package.json"

export const nestedPackagesOf = (files: readonly string[]): readonly string[] => {
  if (!files.includes(ROOT_MANIFEST)) return []
  return files
    .filter((file) => file.endsWith(PACKAGE_MANIFEST))
    .map((file) => file.slice(0, -PACKAGE_MANIFEST.length))
    .sort(byCodepoint)
    .reduce<readonly string[]>((outermost, dir) => (isInNestedPackage(dir, outermost) ? outermost : [...outermost, dir]), [])
}

export type TreeScan = {
  readonly files: readonly string[]
  readonly skippedDirs: readonly string[]
  readonly symlinks: readonly string[]
}

export type ProjectProbeInput = {
  readonly ts: TypeScriptApi
  readonly root: string
  readonly host?: FileHost
  readonly sourceRoots?: readonly string[]
  readonly exclude?: readonly string[]
  readonly generated?: readonly string[]
  readonly tsconfig?: TsconfigChain
}

export type ProjectProbe = {
  readonly ts: TypeScriptApi
  readonly ast: Ast
  readonly host: FileHost
  readonly paths: ProjectPaths
  readonly context: ProjectContext
  readonly tsconfig: TsconfigChain
  readonly tsconfigDiagnostics: readonly Diagnostic[]
  readonly dependencies: DependencyUnion
  readonly derivedSourceRoots: readonly string[]
  readonly extensionRewrites: readonly ExtensionRewrite[]
  readonly candidateSuffixes: readonly string[]
  readonly excludedDirs: readonly string[]
  readonly scan: () => TreeScan
  readonly glob: (pattern: string) => readonly string[]
  readonly readFile: (relPath: string) => string | null
  readonly parse: (relPath: string) => ts.SourceFile | null
  /** Source files under the source roots with generated files removed (§10.7). */
  readonly probeFiles: () => readonly string[]
  /**
   * Directories below the root holding their OWN `package.json` — separate packages, outermost only.
   * Their files are evidence for that package, never for the app at the root.
   */
  readonly nestedPackages: () => readonly string[]
  readonly generatedFiles: () => readonly GeneratedFile[]
  readonly globs: () => readonly GlobAttempt[]
}

/**
 * Phase 0's own view of the project. It cannot reuse `pipeline/context.ts`, which needs a
 * `ResolvedConfig` that phase 0 is what produces — so the probe walks the tree itself, once, and every
 * later probe filters that one index instead of re-walking.
 */
export const createProjectProbe = (input: ProjectProbeInput): ProjectProbe => {
  const api = input.ts
  const host = input.host ?? createNodeHost()
  const root = path.resolve(input.root)

  const bootstrapPaths = createProjectPaths({
    host,
    root,
    ...(input.exclude === undefined ? {} : { exclude: input.exclude }),
    ...(input.generated === undefined ? {} : { generated: input.generated }),
  })

  const loaded = input.tsconfig === undefined ? loadTsconfig({ ts: api, host, root }) : null
  const tsconfig = input.tsconfig ?? loaded?.chain ?? EMPTY_TSCONFIG_CHAIN

  const derivedSourceRoots = deriveSourceRoots({ paths: bootstrapPaths, tsconfig })
  const sourceRoots = input.sourceRoots ?? derivedSourceRoots

  const paths = createProjectPaths({
    host,
    root,
    sourceRoots,
    ...(input.exclude === undefined ? {} : { exclude: input.exclude }),
    ...(input.generated === undefined ? {} : { generated: input.generated }),
  })

  const manifests = manifestCandidates(paths.sourceRootsRel)
  const dependencies = readDependencyUnion(host, root, manifests)

  let scanned: TreeScan | null = null

  const scan = (): TreeScan => {
    if (scanned !== null) return scanned

    const files: string[] = []
    const skippedDirs: string[] = []
    const symlinks: string[] = []

    const visit = (dirAbs: string, prefix: string): void => {
      for (const entry of host.readDir(dirAbs)) {
        const abs = path.join(dirAbs, entry.name)
        const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`

        // Never followed and never stat-ed through: pnpm's store layout makes symlink cycles the
        // normal case, and `node_modules/` exclusion alone does not cover a workspace link (§10.7).
        if (entry.kind === "symlink") {
          symlinks.push(rel)
          continue
        }
        if (entry.kind === "directory") {
          if (paths.isExcludedDir(rel)) {
            skippedDirs.push(rel)
            continue
          }
          visit(abs, rel)
          continue
        }
        if (entry.kind !== "file") continue
        files.push(rel)
      }
    }

    visit(root, "")
    scanned = {
      files: files.sort(byCodepoint),
      skippedDirs: skippedDirs.sort(byCodepoint),
      symlinks: symlinks.sort(byCodepoint),
    }
    return scanned
  }

  const globAttempts: GlobAttempt[] = []
  const matcherCache = new Map<string, RegExp>()
  const globCache = new Map<string, readonly string[]>()
  const textCache = new Map<string, string | null>()
  const sourceCache = new Map<string, ts.SourceFile | null>()

  const matcherFor = (pattern: string): RegExp => {
    const cached = matcherCache.get(pattern)
    if (cached !== undefined) return cached
    const created = globToRegExp(pattern)
    matcherCache.set(pattern, created)
    return created
  }

  const glob = (pattern: string): readonly string[] => {
    const cached = globCache.get(pattern)
    if (cached !== undefined) {
      globAttempts.push({ pattern, matches: cached.length })
      return cached
    }

    const matcher = matcherFor(pattern)
    const matches = scan().files.filter((file) => matcher.test(file))
    globCache.set(pattern, matches)
    globAttempts.push({ pattern, matches: matches.length })
    return matches
  }

  const readFile = (relPath: string): string | null => {
    const cached = textCache.get(relPath)
    if (cached !== undefined) return cached
    const text = host.readFile(paths.abs(relPath))
    textCache.set(relPath, text)
    return text
  }

  const parse = (relPath: string): ts.SourceFile | null => {
    const cached = sourceCache.get(relPath)
    if (cached !== undefined) return cached

    const text = readFile(relPath)
    const source = text === null ? null : createScriptSource(api, paths.abs(relPath), text, { inferKind: true })
    sourceCache.set(relPath, source)
    return source
  }

  const generatedMatchers = (input.generated ?? []).map(globToRegExp)

  const reasonFor = (relPath: string): GeneratedReason => {
    if (generatedMatchers.some((matcher) => matcher.test(relPath))) return "config-glob"
    if (isGeneratedContent(readFile(relPath))) return "generated-marker"
    return "generated-basename"
  }

  let generated: readonly GeneratedFile[] | null = null
  let probes: readonly string[] | null = null

  const partitionSources = (): void => {
    const inScope = glob(SOURCE_FILE_GLOB).filter((file) => paths.contains(paths.abs(file)))
    const kept: string[] = []
    const found: GeneratedFile[] = []

    for (const file of inScope) {
      if (paths.isGenerated(paths.abs(file))) {
        found.push({ file, reason: reasonFor(file) })
        continue
      }
      kept.push(file)
    }

    generated = found
    probes = kept
  }

  const context: ProjectContext = {
    ts: api,
    root: paths.root,
    rootLabel: paths.label,
    sourceRoots: paths.sourceRootsRel,
    dependencies: dependencies.names,
    hasDependency: (name) =>
      typeof name === "string"
        ? dependencies.names.has(name)
        : [...dependencies.names].some((entry) => name.test(entry)),
    tsconfig,
    glob,
    readFile,
    exists: (relPath) => host.exists(paths.abs(relPath)),
    isGenerated: (relPath) => paths.isGenerated(paths.abs(relPath)),
  }

  return {
    ts: api,
    ast: createAst(api),
    host,
    paths,
    context,
    tsconfig,
    tsconfigDiagnostics: loaded?.diagnostics ?? [],
    dependencies,
    derivedSourceRoots,
    extensionRewrites: isNodeStyleModuleResolution(tsconfig.moduleResolution) ? DEFAULT_EXTENSION_REWRITES : [],
    candidateSuffixes: candidateSuffixesOf(tsconfig, dependencies.names),
    excludedDirs: paths.excludedDirs,
    scan,
    glob,
    readFile,
    parse,
    nestedPackages: () => nestedPackagesOf(scan().files),
    probeFiles: () => {
      if (probes === null) partitionSources()
      return probes ?? []
    },
    generatedFiles: () => {
      if (generated === null) partitionSources()
      return generated ?? []
    },
    globs: () => [...globAttempts],
  }
}
