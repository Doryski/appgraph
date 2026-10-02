import * as path from "node:path"
import type { FileHost, GlobOptions } from "./host.js"
import { globToRegExp, toPosix } from "./host.js"
import { isDotDirectory, readNextDistDirs } from "./ignore-build-dirs.js"
import { createIgnoreMatcher } from "./ignore-rules.js"
import { byCodepoint, sortedUnique, sortedUniqueBy } from "./order.js"
import { SCRIPT_EXTENSION_PATTERN, SOURCE_EXTENSIONS, extensionPatternOf } from "./extensions.js"

export const DEFAULT_EXCLUDED_DIRS = [
  ".cache",
  ".claude",
  ".git",
  ".idea",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".vscode",
  "build",
  "builds",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "storybook-static",
] as const

export const MANDATORY_EXCLUDED_DIRS = ["node_modules", ".git"] as const

export const OUTPUT_DIR_NAMES = ["build", "builds", "coverage", "dist", "out", "storybook-static"] as const

const OUTPUT_DIR_SET = new Set<string>(OUTPUT_DIR_NAMES)

export const RESTORE_EXCLUDE_PREFIX = "!"

export const EXCLUSION_REASONS = ["mandatory", "default", "config", "next-dist-dir", "dot-directory", "gitignore"] as const

export type ExclusionReason = (typeof EXCLUSION_REASONS)[number]

export type Exclusion = {
  readonly pattern: string
  readonly reason: ExclusionReason
  readonly source?: string
}

export const DOT_DIRECTORY_PATTERN = ".*/"

const basenameOf = (posixPath: string): string => posixPath.slice(posixPath.lastIndexOf("/") + 1)

/**
 * Files that sit inside a source root but are not part of the app: tests, specs, stories and
 * ambient declarations. The rule lives here, next to the directory exclusions, so that screen
 * DISCOVERY (`ProjectPaths.glob`) and module resolution (`ProjectPaths.isExcluded`) share one
 * definition — a per-adapter filter would leave every future source free to forget it.
 */
export const EXCLUDED_FILE = new RegExp(
  `\\.(?:test|spec|stories|cy)\\.${extensionPatternOf(SOURCE_EXTENSIONS)}$|\\.story\\.vue$|\\.d\\.[cm]?ts$`,
)

export const NON_APP_PATH =
  /(?:^|\/)(?:test-utils|test|tests|__tests__|__mocks__|mocks|\.storybook|storybook)\/|^(?:\.\/)?(?:cypress|e2e|playwright)\//

const TEST_UTILS_FILE = new RegExp(`(?:^|/)test-utils\\.${extensionPatternOf(SOURCE_EXTENSIONS)}$`)

export const isNonAppFile = (file: string): boolean =>
  NON_APP_PATH.test(toPosix(file)) || TEST_UTILS_FILE.test(toPosix(file)) || isExcludedFile(file)

export const isExcludedFile = (file: string): boolean => EXCLUDED_FILE.test(basenameOf(toPosix(file)))

const GENERATED_BASENAME = new RegExp(`\\.gen\\.${SCRIPT_EXTENSION_PATTERN}$|\\.generated\\.[^./]+$|\\.g\\.ts$`)

const GENERATED_DIRECTIVE = /@ts-nocheck|eslint-disable/
const GENERATED_MARKER = /generated|auto-?generated|do not edit/i

export type ProjectPathsOptions = {
  readonly host: FileHost
  readonly root: string
  readonly sourceRoots?: readonly string[]
  readonly exclude?: readonly string[]
  readonly generated?: readonly string[]
}

export type ProjectPaths = {
  readonly root: string
  readonly label: string
  readonly sourceRoots: readonly string[]
  readonly sourceRootsRel: readonly string[]
  readonly excludedDirs: readonly string[]
  /**
   * Every rule `isExcludedDir` applies, with its reason. `excludedDirs` is names only and cannot express
   * the dot-directory rule, a nested `distDir` or `.gitignore`, so `doctor` needs this to stay honest.
   */
  readonly exclusions: () => readonly Exclusion[]
  /** `relDir` is project-relative POSIX; an excluded ancestor excludes it too. */
  readonly isExcludedDir: (relDir: string) => boolean
  readonly rel: (abs: string) => string
  readonly abs: (rel: string) => string
  readonly contains: (abs: string) => boolean
  readonly isExcluded: (abs: string) => boolean
  readonly isGenerated: (abs: string) => boolean
  readonly glob: (pattern: string, options?: GlobOptions) => readonly string[]
  readonly globAbs: (pattern: string, options?: GlobOptions) => readonly string[]
}

export const findProjectRoot = (host: FileHost, startDir: string): string | null => {
  let current = path.resolve(startDir)

  for (;;) {
    const hasPackage = host.isFile(path.join(current, "package.json"))
    const hasTsconfig = host.isFile(path.join(current, "tsconfig.json"))
    if (hasPackage && hasTsconfig) return current

    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export const isGeneratedContent = (text: string | null): boolean => {
  if (text === null) return false
  const head = text.split("\n", 5).join("\n")
  return GENERATED_DIRECTIVE.test(head) && GENERATED_MARKER.test(head)
}

type ExcludeEntries = {
  readonly names: readonly string[]
  readonly paths: readonly string[]
  readonly restored: ReadonlySet<string>
}

const GLOB_CHARACTER = /[*?{[]/

const isRestoreEntry = (entry: string): boolean => entry.startsWith(RESTORE_EXCLUDE_PREFIX)

const isPathEntry = (entry: string): boolean => entry.includes("/")

const withForwardSlashes = (entry: string): string => entry.replaceAll("\\", "/")

export const partitionExcludes = (exclude: readonly string[]): ExcludeEntries => {
  const plain = exclude.map(withForwardSlashes).filter((entry) => !isRestoreEntry(entry))
  return {
    names: plain.filter((entry) => !isPathEntry(entry)),
    paths: plain.filter(isPathEntry),
    restored: new Set(exclude.filter(isRestoreEntry).map((entry) => entry.slice(RESTORE_EXCLUDE_PREFIX.length))),
  }
}

export const normalizePathEntry = (entry: string): string =>
  toPosix(entry)
    .replace(/\/\*\*\/?$/, "")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "")

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const pathEntryMatcher = (entry: string): RegExp =>
  GLOB_CHARACTER.test(entry) ? globToRegExp(entry) : new RegExp(`^${escapeRegExp(entry)}(?:/|$)`)

export const createProjectPaths = (options: ProjectPathsOptions): ProjectPaths => {
  const { host } = options
  const root = path.resolve(options.root)

  const distDirs = readNextDistDirs(host, root)
  const ignore = createIgnoreMatcher(host, root)
  const entries = partitionExcludes(options.exclude ?? [])
  const configured = new Set(entries.names)
  const pathRules = entries.paths.map(normalizePathEntry).filter((entry) => entry !== "").map(pathEntryMatcher)
  const outputNames = OUTPUT_DIR_NAMES.filter((name) => !entries.restored.has(name) && !configured.has(name))

  const excludedDirs = sortedUnique([
    ...DEFAULT_EXCLUDED_DIRS.filter((name) => !OUTPUT_DIR_SET.has(name) && !entries.restored.has(name)),
    ...configured,
    ...distDirs.map((entry) => entry.dir).filter((dir) => !dir.includes("/")),
    ...MANDATORY_EXCLUDED_DIRS,
  ])
  const distDirPaths = new Set(distDirs.map((entry) => entry.dir))

  const matchesPathRule = (relPath: string): boolean => pathRules.some((rule) => rule.test(relPath))

  const isPackageDir = (relDir: string): boolean =>
    relDir === "." || host.isFile(path.join(root, relDir, "package.json"))

  const isOutputDir = (relDir: string): boolean =>
    outputNames.some((name) => name === basenameOf(relDir)) &&
    (isPackageDir(path.posix.dirname(relDir)) || !contains(absOf(relDir)))

  const ownRuleExcludes = (relDir: string): boolean => {
    const name = basenameOf(relDir)
    if (excludedDirs.includes(name)) return true
    if (isDotDirectory(name)) return true
    if (distDirPaths.has(relDir)) return true
    if (isOutputDir(relDir) || matchesPathRule(relDir)) return true
    return ignore.isIgnored(relDir, true)
  }

  const dirVerdicts = new Map<string, boolean>()

  const isExcludedDir = (relDir: string): boolean => {
    if (relDir === "" || relDir === ".") return false
    const cached = dirVerdicts.get(relDir)
    if (cached !== undefined) return cached
    const parent = path.posix.dirname(relDir)
    const verdict = (parent !== "." && isExcludedDir(parent)) || ownRuleExcludes(relDir)
    dirVerdicts.set(relDir, verdict)
    return verdict
  }

  const mandatory = new Set<string>(MANDATORY_EXCLUDED_DIRS)
  const defaults = new Set<string>(DEFAULT_EXCLUDED_DIRS)

  const reasonOf = (dir: string): ExclusionReason | null => {
    if (mandatory.has(dir)) return "mandatory"
    if (defaults.has(dir)) return "default"
    if (configured.has(dir)) return "config"
    return null
  }

  const exclusions = (): readonly Exclusion[] =>
    sortedUniqueBy(
      [
        ...excludedDirs.flatMap((dir): Exclusion[] => {
          const reason = reasonOf(dir)
          return reason === null ? [] : [{ pattern: `${dir}/`, reason }]
        }),
        ...outputNames.map((name): Exclusion => ({ pattern: `/${name}/`, reason: "default" })),
        ...entries.paths.map((entry): Exclusion => ({ pattern: entry, reason: "config" })),
        ...distDirs.map((entry): Exclusion => ({ pattern: `/${entry.dir}/`, reason: "next-dist-dir", source: entry.config })),
        { pattern: DOT_DIRECTORY_PATTERN, reason: "dot-directory" },
        ...ignore.files().map((file): Exclusion => ({ pattern: file, reason: "gitignore", source: file })),
      ],
      (entry) => `${String(EXCLUSION_REASONS.indexOf(entry.reason))}:${entry.pattern}`,
    )

  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  const relatives = new Map<string, string>()

  const computeRel = (abs: string): string => {
    const resolved = path.resolve(abs)
    if (resolved.startsWith(rootPrefix)) return toPosix(resolved.slice(rootPrefix.length))
    return toPosix(path.relative(root, resolved))
  }

  const rel = (abs: string): string => {
    const cached = relatives.get(abs)
    if (cached !== undefined) return cached
    const computed = computeRel(abs)
    relatives.set(abs, computed)
    return computed
  }
  const absOf = (relPath: string) => path.resolve(root, relPath)

  const sourceRoots = (
    options.sourceRoots === undefined || options.sourceRoots.length === 0
      ? [root]
      : options.sourceRoots.map((entry) => absOf(entry))
  )
    .map((entry) => path.resolve(entry))
    .sort(byCodepoint)

  const generatedMatchers = (options.generated ?? []).map(globToRegExp)

  const contains = (abs: string) => {
    const resolved = path.resolve(abs)
    return sourceRoots.some((sourceRoot) => resolved === sourceRoot || resolved.startsWith(`${sourceRoot}${path.sep}`))
  }

  const isExcluded = (abs: string) => {
    const relPath = rel(abs)
    if (relPath.startsWith("../")) return true
    if (isExcludedFile(relPath)) return true
    if (relPath === "") return false
    if (relPath.split("/").some((segment) => excludedDirs.includes(segment))) return true
    if (matchesPathRule(relPath)) return true
    if (host.isDirectory(abs)) return isExcludedDir(relPath)
    const parent = path.posix.dirname(relPath)
    if (parent !== "." && isExcludedDir(parent)) return true
    return ignore.isIgnored(relPath, false)
  }

  const isGenerated = (abs: string) => {
    const relPath = rel(abs)
    if (GENERATED_BASENAME.test(basenameOf(relPath))) return true
    if (generatedMatchers.some((matcher) => matcher.test(relPath))) return true
    return isGeneratedContent(host.readFile(abs))
  }

  const glob = (pattern: string, globOptions?: GlobOptions) =>
    host
      .glob(root, pattern, {
        excludeDirs: [...excludedDirs, ...(globOptions?.excludeDirs ?? [])],
        skipDir: (relDir) => isExcludedDir(relDir) || globOptions?.skipDir?.(relDir) === true,
        ...(globOptions?.maxDepth !== undefined ? { maxDepth: globOptions.maxDepth } : {}),
      })
      .filter((entry) => !isExcludedFile(entry) && !matchesPathRule(entry) && !ignore.isIgnored(entry, false))

  return {
    root,
    label: path.basename(root),
    sourceRoots,
    sourceRootsRel: sourceRoots.map(rel).map((entry) => (entry === "" ? "." : entry)),
    excludedDirs,
    exclusions,
    isExcludedDir,
    rel,
    abs: absOf,
    contains,
    isExcluded,
    isGenerated,
    glob,
    globAbs: (pattern, globOptions) => glob(pattern, globOptions).map((entry) => absOf(entry)),
  }
}
