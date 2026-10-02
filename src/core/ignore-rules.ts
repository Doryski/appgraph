import * as path from "node:path"
import type { FileHost } from "./host.js"
import { toPosix } from "./host.js"
import { byCodepoint } from "./order.js"

/**
 * A parser-only reading of `.gitignore` (gitignore(5)): comments, escaped `#`/`!`/trailing spaces,
 * negation, directory-only patterns, anchoring (a slash anywhere but the end), `*`, `?`, `[...]` and
 * `**`. Git is never spawned and the index is never read, so a TRACKED file that matches an ignore
 * pattern is treated as ignored — the price of staying a pure filesystem reader.
 */
export type IgnoreRule = {
  readonly negate: boolean
  readonly dirOnly: boolean
  readonly matcher: RegExp
}

export type IgnoreFile = {
  /** Repository-relative POSIX directory the patterns are relative to; `""` for the repository root. */
  readonly base: string
  /** Display path of the file, relative to the project root. */
  readonly display: string
  readonly rules: readonly IgnoreRule[]
}

export type IgnoreMatcher = {
  /** `relPath` is project-relative POSIX. Ancestors are NOT consulted — the caller prunes top-down. */
  readonly isIgnored: (relPath: string, isDirectory: boolean) => boolean
  /** Every ignore file read so far that contributed at least one rule, sorted. */
  readonly files: () => readonly string[]
}

const IGNORE_FILE = ".gitignore"
const REPO_EXCLUDE = ".git/info/exclude"

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const classEnd = (pattern: string, start: number): number => {
  let index = start + 1
  if (pattern.charAt(index) === "!" || pattern.charAt(index) === "^") index += 1
  if (pattern.charAt(index) === "]") index += 1
  while (index < pattern.length && pattern.charAt(index) !== "]") index += 1
  return index < pattern.length ? index : -1
}

const classBody = (body: string): string => {
  const negated = body.startsWith("!") || body.startsWith("^")
  const rest = (negated ? body.slice(1) : body).replace(/\\/g, "\\\\")
  return `[${negated ? "^" : ""}${rest}]`
}

const isSegmentStart = (pattern: string, index: number): boolean => index === 0 || pattern.charAt(index - 1) === "/"

export const ignoreGlobToRegExp = (pattern: string): RegExp => {
  let out = ""
  let index = 0

  while (index < pattern.length) {
    const char = pattern.charAt(index)

    if (char === "\\" && index + 1 < pattern.length) {
      out += escapeRegExp(pattern.charAt(index + 1))
      index += 2
      continue
    }

    if (char === "*" && pattern.charAt(index + 1) === "*" && isSegmentStart(pattern, index)) {
      if (pattern.charAt(index + 2) === "/") {
        out += "(?:.*/)?"
        index += 3
        continue
      }
      if (index + 2 === pattern.length) {
        out += ".*"
        index += 2
        continue
      }
    }

    if (char === "*") {
      out += "[^/]*"
      index += 1
      continue
    }

    if (char === "?") {
      out += "[^/]"
      index += 1
      continue
    }

    if (char === "[") {
      const end = classEnd(pattern, index)
      if (end !== -1) {
        out += classBody(pattern.slice(index + 1, end))
        index = end + 1
        continue
      }
    }

    out += escapeRegExp(char)
    index += 1
  }

  return new RegExp(`^${out}$`)
}

const trimTrailingSpaces = (line: string): string => {
  let end = line.length
  while (end > 0 && line.charAt(end - 1) === " " && line.charAt(end - 2) !== "\\") end -= 1
  return line.slice(0, end)
}

export const parseIgnoreLine = (raw: string): IgnoreRule | null => {
  const line = trimTrailingSpaces(raw.replace(/\r$/, ""))
  if (line === "" || line.startsWith("#")) return null

  const negate = line.startsWith("!")
  const unprefixed = negate ? line.slice(1) : line
  const body = /^\\[#!]/.test(unprefixed) ? unprefixed.slice(1) : unprefixed

  const dirOnly = body.endsWith("/")
  const trimmed = body.replace(/\/+$/, "")
  if (trimmed === "") return null

  const anchored = trimmed.includes("/")
  const relative = trimmed.replace(/^\/+/, "")
  if (relative === "") return null

  return {
    negate,
    dirOnly,
    matcher: ignoreGlobToRegExp(anchored ? relative : `**/${relative}`),
  }
}

export const parseIgnoreFile = (text: string): readonly IgnoreRule[] =>
  text.split("\n").flatMap((line) => {
    const rule = parseIgnoreLine(line)
    return rule === null ? [] : [rule]
  })

/** `true` ignored, `false` re-included by a negation, `undefined` no rule spoke. Last match wins. */
export const matchIgnoreRules = (
  rules: readonly IgnoreRule[],
  relPath: string,
  isDirectory: boolean,
): boolean | undefined =>
  rules.reduce<boolean | undefined>((verdict, rule) => {
    if (rule.dirOnly && !isDirectory) return verdict
    return rule.matcher.test(relPath) ? !rule.negate : verdict
  }, undefined)

const findRepoRoot = (host: Pick<FileHost, "exists">, rootAbs: string): string | null => {
  let current = rootAbs
  for (;;) {
    if (host.exists(path.join(current, ".git"))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

const ancestorsFrom = (repoRoot: string, rootAbs: string): readonly string[] => {
  const chain: string[] = []
  let current = rootAbs
  while (current !== repoRoot) {
    chain.unshift(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return [repoRoot, ...chain]
}

const joinRel = (prefix: string, rel: string): string => {
  if (prefix === "") return rel
  if (rel === "") return prefix
  return `${prefix}/${rel}`
}

const relativeTo = (base: string, repoRel: string): string => (base === "" ? repoRel : repoRel.slice(base.length + 1))

export const createIgnoreMatcher = (host: Pick<FileHost, "exists" | "readFile">, root: string): IgnoreMatcher => {
  const rootAbs = path.resolve(root)
  const repoRoot = findRepoRoot(host, rootAbs) ?? rootAbs
  const prefix = toPosix(path.relative(repoRoot, rootAbs))
  const loaded: IgnoreFile[] = []

  const load = (abs: string, base: string): readonly IgnoreFile[] => {
    const text = host.readFile(abs)
    if (text === null) return []
    const rules = parseIgnoreFile(text)
    if (rules.length === 0) return []
    const file = { base, display: toPosix(path.relative(rootAbs, abs)), rules }
    loaded.push(file)
    return [file]
  }

  const outer = [
    ...load(path.join(repoRoot, REPO_EXCLUDE), ""),
    ...ancestorsFrom(repoRoot, rootAbs).flatMap((dir) =>
      load(path.join(dir, IGNORE_FILE), toPosix(path.relative(repoRoot, dir))),
    ),
  ]

  const chains = new Map<string, readonly IgnoreFile[]>([["", outer]])

  const chainFor = (dirRel: string): readonly IgnoreFile[] => {
    const cached = chains.get(dirRel)
    if (cached !== undefined) return cached
    const parent = path.posix.dirname(dirRel)
    const own = load(path.join(rootAbs, dirRel, IGNORE_FILE), joinRel(prefix, dirRel))
    const chain = [...chainFor(parent === "." ? "" : parent), ...own]
    chains.set(dirRel, chain)
    return chain
  }

  const isIgnored = (relPath: string, isDirectory: boolean): boolean => {
    if (relPath === "" || relPath.startsWith("../")) return false
    const parent = path.posix.dirname(relPath)
    const repoRel = joinRel(prefix, relPath)

    const verdict = chainFor(parent === "." ? "" : parent).reduce<boolean | undefined>((current, file) => {
      const local = matchIgnoreRules(file.rules, relativeTo(file.base, repoRel), isDirectory)
      return local ?? current
    }, undefined)
    return verdict === true
  }

  return {
    isIgnored,
    files: () => loaded.map((file) => file.display).sort(byCodepoint),
  }
}
