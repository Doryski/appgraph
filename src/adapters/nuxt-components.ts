import { byCodepoint, sortBy } from "../core/order"
import { toPascal } from "../core/vue-template"

export type NuxtComponentDir = {
  readonly path: string
  readonly pathPrefix: boolean
  readonly prefix?: string
}

export type NuxtComponentCollision = {
  readonly name: string
  readonly files: readonly string[]
}

export type NuxtComponentIndex = {
  readonly byName: ReadonlyMap<string, string>
  readonly collisions: readonly NuxtComponentCollision[]
}

export type AmbientLookup = {
  readonly file: string
  readonly lazy: boolean
}

const LAZY_PREFIX = "Lazy"
const ROOT_DIR = "."
const MODE_SUFFIX = /\.(client|server|global)$/
const EXTENSION = /\.[^./]+$/

const wordsOf = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_\s.]+/)
    .filter((word) => word !== "")

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)

const pascalOf = (words: readonly string[]): string => words.map(capitalize).join("")

const dirMatcher =
  (dir: NuxtComponentDir) =>
  (file: string): boolean =>
    dir.path === ROOT_DIR || file.startsWith(`${dir.path}/`)

const relativeToDir = (dir: NuxtComponentDir, file: string): string =>
  dir.path === ROOT_DIR ? file : file.slice(dir.path.length + 1)

const stripExtensions = (name: string): string => name.replace(EXTENSION, "").replace(MODE_SUFFIX, "")

const splitRelative = (relative: string): { dirs: string[]; fileName: string } => {
  const segments = relative.split("/")
  const file = segments[segments.length - 1] ?? ""
  return { dirs: segments.slice(0, -1), fileName: stripExtensions(file) }
}

const groupingFree = (dirs: readonly string[]): string[] =>
  dirs.filter((dir) => !(dir.startsWith("(") && dir.endsWith(")")))

const fileWords = (dir: NuxtComponentDir, dirs: readonly string[], fileName: string): string[] => {
  if (fileName.toLowerCase() !== "index") return wordsOf(fileName)
  if (dir.pathPrefix) return []
  const owner = dirs[dirs.length - 1]
  return owner === undefined ? [] : wordsOf(owner)
}

const prefixWords = (dir: NuxtComponentDir, dirs: readonly string[]): string[] => [
  ...wordsOf(dir.prefix ?? ""),
  ...(dir.pathPrefix ? groupingFree(dirs).flatMap(wordsOf) : []),
]

const leadingUnmatched = (prefix: readonly string[], fileHead: string | undefined): string[] => {
  const target = (fileHead ?? "").toLowerCase()
  const matchAt = prefix.findIndex((word) => word.toLowerCase() === target)
  return matchAt === -1 ? [...prefix] : prefix.slice(0, matchAt)
}

const componentNameOf = (dir: NuxtComponentDir, file: string): string => {
  const { dirs, fileName } = splitRelative(relativeToDir(dir, file))
  const own = fileWords(dir, dirs, fileName)
  const kept = leadingUnmatched(prefixWords(dir, dirs), own[0])
  return pascalOf([...kept, ...own])
}

const owningDir = (
  matchers: readonly { dir: NuxtComponentDir; matches: (file: string) => boolean }[],
  file: string,
): NuxtComponentDir | undefined => matchers.find(({ matches }) => matches(file))?.dir

const groupByName = (
  componentDirs: readonly NuxtComponentDir[],
  files: readonly string[],
): Map<string, string[]> => {
  const matchers = componentDirs.map((dir) => ({ dir, matches: dirMatcher(dir) }))
  const groups = new Map<string, string[]>()
  for (const file of files) {
    const dir = owningDir(matchers, file)
    if (dir === undefined) continue
    const name = componentNameOf(dir, file)
    if (name === "") continue
    const claimed = groups.get(name) ?? []
    if (!claimed.includes(file)) claimed.push(file)
    groups.set(name, claimed)
  }
  return groups
}

const VARIANT_SUFFIX = /\.(client|server)(?=\.[^./]+$)/
const VARIANT_PREFERENCE = ["", ".client", ".server"]

const variantBase = (file: string): string => file.replace(VARIANT_SUFFIX, "")

const variantRank = (file: string): string =>
  String(VARIANT_PREFERENCE.indexOf(VARIANT_SUFFIX.exec(file)?.[0] ?? ""))

const variantOwner = (files: readonly string[]): string | undefined =>
  new Set(files.map(variantBase)).size === 1 ? sortBy(files, variantRank)[0] : undefined

export const buildNuxtComponentIndex = (
  componentDirs: readonly NuxtComponentDir[],
  files: readonly string[],
): NuxtComponentIndex => {
  const groups = groupByName(componentDirs, files)
  const entries = [...groups].sort(([a], [b]) => byCodepoint(a, b))
  const byName = new Map<string, string>()
  const collisions: NuxtComponentCollision[] = []
  for (const [name, claimed] of entries) {
    const sorted = [...claimed].sort(byCodepoint)
    const chosen = variantOwner(sorted)
    if (chosen !== undefined) byName.set(name, chosen)
    if (chosen === undefined) collisions.push({ name, files: sorted })
  }
  return { byName, collisions: sortBy(collisions, (collision) => collision.name) }
}

export const lookupAmbient = (index: NuxtComponentIndex, tag: string): AmbientLookup | undefined => {
  const name = toPascal(tag)
  const direct = index.byName.get(name)
  if (direct !== undefined) return { file: direct, lazy: false }
  if (!name.startsWith(LAZY_PREFIX)) return undefined
  const lazy = index.byName.get(name.slice(LAZY_PREFIX.length))
  return lazy === undefined ? undefined : { file: lazy, lazy: true }
}
