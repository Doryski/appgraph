import * as path from "node:path"
import type { FileHost } from "./host.js"
import { sortedUnique } from "./order.js"

export const NEXT_CONFIG_FILES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
  "next.config.mts",
] as const

const COMMENT = /\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/.*$/gm
const DIST_DIR_ASSIGNMENT = /\bdistDir\b\s*[:=]\s*([^,;}\n]+)/g
const STRING_LITERAL = /(["'`])((?:(?!\1)[^\\$]|\\.)*)\1/g

/**
 * `cond ? "a" : "b"` names two candidate directories and one operand that is not a directory, so only
 * the branches after `?` count. Anything not a plain string literal (a template with `${}`, a call, a
 * variable) contributes nothing — the default list still applies.
 */
const valueLiterals = (expression: string): readonly string[] => {
  const question = expression.indexOf("?")
  const branches = question === -1 ? expression : expression.slice(question + 1)
  return [...branches.matchAll(STRING_LITERAL)].map((match) => match[2] ?? "")
}

export const normalizeDistDir = (value: string): string | null => {
  const posix = path.posix.normalize(value.trim().replace(/\\/g, "/")).replace(/\/+$/, "")
  if (posix === "" || posix === "." || posix.startsWith("../") || posix === ".." || path.posix.isAbsolute(posix))
    return null
  return posix
}

export const distDirsInNextConfig = (text: string): readonly string[] =>
  sortedUnique(
    [...text.replace(COMMENT, "$1").matchAll(DIST_DIR_ASSIGNMENT)]
      .flatMap((match) => valueLiterals(match[1] ?? ""))
      .flatMap((value) => {
        const normalized = normalizeDistDir(value)
        return normalized === null ? [] : [normalized]
      }),
  )

export type NextDistDir = {
  readonly dir: string
  readonly config: string
}

export const readNextDistDirs = (host: Pick<FileHost, "readFile">, rootAbs: string): readonly NextDistDir[] =>
  NEXT_CONFIG_FILES.flatMap((config) => {
    const text = host.readFile(path.join(rootAbs, config))
    return text === null ? [] : distDirsInNextConfig(text).map((dir) => ({ dir, config }))
  })

export const isDotDirectory = (name: string): boolean => name.startsWith(".")
