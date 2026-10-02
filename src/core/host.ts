import * as fs from "node:fs"
import * as path from "node:path"
import { byCodepoint } from "./order.js"

export type DirEntryKind = "file" | "directory" | "symlink" | "other"

export type DirEntry = {
  readonly name: string
  readonly kind: DirEntryKind
}

export type GlobOptions = {
  readonly excludeDirs?: readonly string[]
  readonly skipDir?: (relDir: string) => boolean
  readonly maxDepth?: number
}

export type FileHost = {
  readonly readFile: (abs: string) => string | null
  readonly exists: (abs: string) => boolean
  readonly isFile: (abs: string) => boolean
  readonly isDirectory: (abs: string) => boolean
  readonly mtimeMs: (abs: string) => number | null
  readonly readDir: (abs: string) => readonly DirEntry[]
  readonly glob: (rootAbs: string, pattern: string, options?: GlobOptions) => readonly string[]
  readonly symlinksSeen: () => readonly string[]
}

export const toPosix = (value: string): string => value.split(path.sep).join("/")

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const globToRegExp = (pattern: string): RegExp => {
  let out = ""
  let index = 0

  while (index < pattern.length) {
    const char = pattern.charAt(index)

    if (char === "*") {
      if (pattern.charAt(index + 1) === "*") {
        if (pattern.charAt(index + 2) === "/") {
          out += "(?:[^/]+/)*"
          index += 3
          continue
        }
        out += ".*"
        index += 2
        continue
      }
      out += "[^/]*"
      index += 1
      continue
    }

    if (char === "?") {
      out += "[^/]"
      index += 1
      continue
    }

    if (char === "{") {
      const end = pattern.indexOf("}", index)
      if (end === -1) {
        out += "\\{"
        index += 1
        continue
      }
      const alternatives = pattern.slice(index + 1, end).split(",")
      out += `(?:${alternatives.map(escapeRegExp).join("|")})`
      index = end + 1
      continue
    }

    out += escapeRegExp(char)
    index += 1
  }

  return new RegExp(`^${out}$`)
}

const globWith = (
  host: Pick<FileHost, "readDir">,
  onSymlink: (abs: string) => void,
  rootAbs: string,
  pattern: string,
  options?: GlobOptions,
): readonly string[] => {
  const matcher = globToRegExp(pattern)
  const excluded = new Set(options?.excludeDirs ?? [])
  const maxDepth = options?.maxDepth ?? Number.MAX_SAFE_INTEGER
  const matches: string[] = []

  const visit = (dirAbs: string, relPrefix: string, depth: number): void => {
    if (depth > maxDepth) return

    for (const entry of [...host.readDir(dirAbs)].sort((a, b) => byCodepoint(a.name, b.name))) {
      const abs = path.join(dirAbs, entry.name)
      const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`

      if (entry.kind === "symlink") {
        onSymlink(abs)
        continue
      }
      if (entry.kind === "directory") {
        if (excluded.has(entry.name) || options?.skipDir?.(rel) === true) continue
        visit(abs, rel, depth + 1)
        continue
      }
      if (entry.kind !== "file") continue
      if (matcher.test(rel)) matches.push(rel)
    }
  }

  visit(rootAbs, "", 0)
  return matches.sort(byCodepoint)
}

export const createNodeHost = (): FileHost => {
  const symlinks = new Set<string>()

  const statOf = (abs: string): fs.Stats | null => {
    try {
      return fs.lstatSync(abs)
    } catch {
      return null
    }
  }

  const readDir = (abs: string): readonly DirEntry[] => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return []
    }

    return entries
      .map((entry) => ({
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? ("symlink" as const)
          : entry.isDirectory()
            ? ("directory" as const)
            : entry.isFile()
              ? ("file" as const)
              : ("other" as const),
      }))
      .sort((a, b) => byCodepoint(a.name, b.name))
  }

  const host: FileHost = {
    readFile: (abs) => {
      const stat = statOf(abs)
      if (stat === null || !stat.isFile()) return null
      try {
        return fs.readFileSync(abs, "utf8")
      } catch {
        return null
      }
    },
    exists: (abs) => statOf(abs) !== null,
    isFile: (abs) => statOf(abs)?.isFile() === true,
    isDirectory: (abs) => statOf(abs)?.isDirectory() === true,
    mtimeMs: (abs) => statOf(abs)?.mtimeMs ?? null,
    readDir,
    glob: (rootAbs, pattern, options) =>
      globWith({ readDir }, (abs) => symlinks.add(abs), rootAbs, pattern, options),
    symlinksSeen: () => [...symlinks].sort(byCodepoint),
  }

  return host
}

const memoByPath = <T>(compute: (abs: string) => T): ((abs: string) => T) => {
  const cache = new Map<string, { readonly value: T }>()
  return (abs) => {
    const cached = cache.get(abs)
    if (cached !== undefined) return cached.value
    const value = compute(abs)
    cache.set(abs, { value })
    return value
  }
}

export const createCachingHost = (inner: FileHost): FileHost => {
  const symlinks = new Set<string>()
  const readDir = memoByPath(inner.readDir)

  return {
    readFile: memoByPath(inner.readFile),
    exists: memoByPath(inner.exists),
    isFile: memoByPath(inner.isFile),
    isDirectory: memoByPath(inner.isDirectory),
    mtimeMs: memoByPath(inner.mtimeMs),
    readDir,
    glob: (rootAbs, pattern, options) =>
      globWith({ readDir }, (abs) => symlinks.add(abs), rootAbs, pattern, options),
    symlinksSeen: () => [...new Set([...inner.symlinksSeen(), ...symlinks])].sort(byCodepoint),
  }
}

export type MemoryHostInput = {
  readonly files: Readonly<Record<string, string>>
  readonly symlinks?: readonly string[]
  readonly mtimes?: Readonly<Record<string, number>>
}

export const createMemoryHost = (input: MemoryHostInput): FileHost => {
  const normalize = (value: string) => toPosix(path.resolve(value))
  const files = new Map<string, string>()
  const directories = new Set<string>(["/"])
  const symlinkPaths = new Set(Array.from(input.symlinks ?? [], normalize))
  const mtimes = new Map<string, number>()
  const symlinksSeen = new Set<string>()

  const addDirectories = (abs: string) => {
    let current = path.posix.dirname(abs)
    while (current !== "/" && current !== ".") {
      directories.add(current)
      current = path.posix.dirname(current)
    }
  }

  for (const [rawPath, content] of Object.entries(input.files)) {
    const abs = normalize(rawPath)
    files.set(abs, content)
    addDirectories(abs)
  }
  for (const linkPath of symlinkPaths) addDirectories(linkPath)
  for (const [rawPath, value] of Object.entries(input.mtimes ?? {})) mtimes.set(normalize(rawPath), value)

  const isFile = (abs: string) => {
    const key = normalize(abs)
    return !symlinkPaths.has(key) && files.has(key)
  }

  const isDirectory = (abs: string) => {
    const key = normalize(abs)
    return !symlinkPaths.has(key) && directories.has(key)
  }

  const readDir = (abs: string): readonly DirEntry[] => {
    const key = normalize(abs)
    const prefix = key === "/" ? "/" : `${key}/`
    const names = new Map<string, DirEntryKind>()

    const record = (fullPath: string, kind: DirEntryKind) => {
      if (!fullPath.startsWith(prefix) || fullPath === key) return
      const rest = fullPath.slice(prefix.length)
      const name = rest.split("/")[0] ?? ""
      if (name === "") return
      const isLeaf = rest === name
      const existing = names.get(name)
      if (existing === "symlink") return
      names.set(name, isLeaf ? kind : "directory")
    }

    for (const linkPath of symlinkPaths) record(linkPath, "symlink")
    for (const filePath of files.keys()) if (!symlinkPaths.has(filePath)) record(filePath, "file")
    for (const dirPath of directories) if (!symlinkPaths.has(dirPath)) record(dirPath, "directory")

    return [...names.entries()]
      .map(([name, kind]) => ({ name, kind }))
      .sort((a, b) => byCodepoint(a.name, b.name))
  }

  return {
    readFile: (abs) => (isFile(abs) ? (files.get(normalize(abs)) ?? null) : null),
    exists: (abs) => isFile(abs) || isDirectory(abs),
    isFile,
    isDirectory,
    mtimeMs: (abs) => mtimes.get(normalize(abs)) ?? (isFile(abs) ? 0 : null),
    readDir,
    glob: (rootAbs, pattern, options) =>
      globWith({ readDir }, (abs) => symlinksSeen.add(abs), normalize(rootAbs), pattern, options),
    symlinksSeen: () => [...symlinksSeen].sort(byCodepoint),
  }
}
