import { scanTags } from "./tag-scan.js"

export const SCRIPT_LANGS = ["ts", "tsx", "js", "jsx"] as const

export type ScriptLang = (typeof SCRIPT_LANGS)[number]

export const UNSUPPORTED_SCRIPT_FEATURES = ["script-src"] as const

export type UnsupportedScriptFeature = (typeof UNSUPPORTED_SCRIPT_FEATURES)[number]

export type SfcAttrs = Readonly<Record<string, string | true>>

export type SfcBlock = {
  readonly type: string
  readonly attrs: SfcAttrs
  readonly start: number
  readonly contentStart: number
  readonly contentEnd: number
  readonly end: number
}

export type VirtualScript = {
  readonly text: string
  readonly lang: ScriptLang
  readonly unsupported: readonly UnsupportedScriptFeature[]
}

export type TemplateBlock = {
  readonly start: number
  readonly end: number
  readonly lang: string
  readonly src: string | null
}

type Tag = {
  readonly name: string
  readonly attrs: SfcAttrs
  readonly end: number
  readonly selfClosing: boolean
}

type Close = { readonly contentEnd: number; readonly end: number }

const TAG_NAME = /[A-Za-z][^\s/>]*/y
const ATTR_NAME = /[^\s=/>][^\s=>]*/y
const UNQUOTED_VALUE = /[^\s>]+/y
const WHITESPACE = /\s*/y
const BOUNDARY = /[\s/>]/

const matchAt = (pattern: RegExp, text: string, at: number): string => {
  pattern.lastIndex = at
  return pattern.exec(text)?.[0] ?? ""
}

const skipWhitespace = (text: string, at: number): number => at + matchAt(WHITESPACE, text, at).length

const indexAfter = (text: string, needle: string, from: number): number => {
  const found = text.indexOf(needle, from)
  return found === -1 ? text.length : found + needle.length
}

const readValue = (text: string, at: number): { readonly value: string; readonly end: number } => {
  const quote = text[at]
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, at + 1)
    const end = close === -1 ? text.length : close
    return { value: text.slice(at + 1, end), end: Math.min(end + 1, text.length) }
  }
  const value = matchAt(UNQUOTED_VALUE, text, at)
  return { value, end: at + value.length }
}

const readAttrs = (text: string, from: number): Omit<Tag, "name"> => {
  const attrs: [string, string | true][] = []
  let at = from
  while (at < text.length) {
    at = skipWhitespace(text, at)
    if (text[at] === ">") return { attrs: Object.fromEntries(attrs), end: at + 1, selfClosing: false }
    if (text.startsWith("/>", at)) return { attrs: Object.fromEntries(attrs), end: at + 2, selfClosing: true }
    if (text[at] === "/") {
      at += 1
      continue
    }
    const name = matchAt(ATTR_NAME, text, at)
    if (name === "") break
    at = skipWhitespace(text, at + name.length)
    if (text[at] !== "=") {
      attrs.push([name, true])
      continue
    }
    const { value, end } = readValue(text, skipWhitespace(text, at + 1))
    attrs.push([name, value])
    at = end
  }
  return { attrs: Object.fromEntries(attrs), end: text.length, selfClosing: false }
}

const readTag = (text: string, at: number): Tag | null => {
  const name = matchAt(TAG_NAME, text, at + 1)
  if (name === "") return null
  return { name: name.toLowerCase(), ...readAttrs(text, at + 1 + name.length) }
}

const isTagAt = (text: string, at: number, prefix: string): boolean =>
  text.slice(at, at + prefix.length).toLowerCase() === prefix &&
  (at + prefix.length >= text.length || BOUNDARY.test(text[at + prefix.length] ?? ""))

const closeAt = (text: string, at: number): Close => ({ contentEnd: at, end: indexAfter(text, ">", at) })

const findRawClose = (text: string, name: string, from: number): Close => {
  const prefix = `</${name}`
  const lower = text.toLowerCase()
  let at = lower.indexOf(prefix, from)
  while (at !== -1) {
    if (isTagAt(text, at, prefix)) return closeAt(text, at)
    at = lower.indexOf(prefix, at + 1)
  }
  return { contentEnd: text.length, end: text.length }
}

const skipMarkup = (text: string, at: number): number | null => {
  if (text.startsWith("<!--", at)) return indexAfter(text, "-->", at + 4)
  if (text.startsWith("{{", at)) return indexAfter(text, "}}", at + 2)
  return null
}

const findTemplateClose = (text: string, from: number): Close => {
  let depth = 1
  let at = from
  while (at < text.length) {
    const skipped = skipMarkup(text, at)
    if (skipped !== null) {
      at = skipped
      continue
    }
    if (text[at] !== "<") {
      at += 1
      continue
    }
    if (isTagAt(text, at, "</template")) {
      depth -= 1
      if (depth === 0) return closeAt(text, at)
      at = indexAfter(text, ">", at)
      continue
    }
    const tag = readTag(text, at)
    if (tag === null) {
      at += 1
      continue
    }
    if (tag.name === "template" && !tag.selfClosing) depth += 1
    at = tag.end
  }
  return { contentEnd: text.length, end: text.length }
}

const isHtmlTemplate = (tag: Tag): boolean => {
  const lang = tag.attrs["lang"]
  return tag.name === "template" && (lang === undefined || lang === true || lang === "html")
}

const findClose = (text: string, tag: Tag): Close => {
  if (tag.selfClosing) return { contentEnd: tag.end, end: tag.end }
  if (isHtmlTemplate(tag)) return findTemplateClose(text, tag.end)
  return findRawClose(text, tag.name, tag.end)
}

const readBlock = (text: string, at: number): SfcBlock | null => {
  const tag = readTag(text, at)
  if (tag === null) return null
  const close = findClose(text, tag)
  return { type: tag.name, attrs: tag.attrs, start: at, contentStart: tag.end, ...close }
}

const skipTopLevel = (text: string, at: number): number => {
  if (text.startsWith("<!--", at)) return indexAfter(text, "-->", at + 4)
  if (text.startsWith("</", at) || text.startsWith("<!", at) || text.startsWith("<?", at)) {
    return indexAfter(text, ">", at)
  }
  return at + 1
}

export const splitSfc = (text: string): readonly SfcBlock[] => {
  const blocks: SfcBlock[] = []
  let at = text.indexOf("<")
  while (at !== -1 && at < text.length) {
    const block = /[A-Za-z]/.test(text[at + 1] ?? "") ? readBlock(text, at) : null
    if (block !== null) blocks.push(block)
    const next = block === null ? skipTopLevel(text, at) : block.end
    at = text.indexOf("<", Math.max(next, at + 1))
  }
  return blocks
}

const attrString = (attrs: SfcAttrs, name: string): string | null => {
  const value = attrs[name]
  return typeof value === "string" ? value : null
}

const toScriptLang = (lang: string | null): ScriptLang | null => {
  if (lang === null) return null
  return SCRIPT_LANGS.find((candidate) => candidate === lang.trim().toLowerCase()) ?? "js"
}

const scriptBlocks = (blocks: readonly SfcBlock[]): readonly SfcBlock[] =>
  blocks.filter((block) => block.type === "script")

const isSetup = (block: SfcBlock): boolean => block.attrs["setup"] !== undefined

const pickLang = (scripts: readonly SfcBlock[]): ScriptLang => {
  const setup = scripts.find(isSetup)
  const plain = scripts.find((block) => !isSetup(block))
  const langOf = (block: SfcBlock | undefined) => (block === undefined ? null : toScriptLang(attrString(block.attrs, "lang")))
  return langOf(setup) ?? langOf(plain) ?? "js"
}

const blankRange = (text: string, start: number, end: number): string => text.slice(start, end).replace(/[^\r\n]/g, " ")

const keptRanges = (scripts: readonly SfcBlock[]): readonly (readonly [number, number])[] =>
  scripts
    .filter((block) => block.attrs["src"] === undefined)
    .map((block) => [block.contentStart, block.contentEnd] as const)
    .sort((left, right) => left[0] - right[0])

const composeVirtual = (text: string, ranges: readonly (readonly [number, number])[]): string => {
  const parts: string[] = []
  let cursor = 0
  for (const [start, end] of ranges) {
    parts.push(blankRange(text, cursor, start), text.slice(start, end))
    cursor = end
  }
  parts.push(blankRange(text, cursor, text.length))
  return parts.join("")
}

export const virtualScript = (text: string): VirtualScript => {
  const scripts = scriptBlocks(splitSfc(text))
  const unsupported: UnsupportedScriptFeature[] = scripts.some((block) => block.attrs["src"] !== undefined)
    ? ["script-src"]
    : []
  return { text: composeVirtual(text, keptRanges(scripts)), lang: pickLang(scripts), unsupported }
}

export const templateBlock = (text: string): TemplateBlock | null => {
  const block = splitSfc(text).find((candidate) => candidate.type === "template")
  if (block === undefined) return null
  return {
    start: block.contentStart,
    end: block.contentEnd,
    lang: attrString(block.attrs, "lang")?.trim().toLowerCase() ?? "html",
    src: attrString(block.attrs, "src"),
  }
}

const toKebab = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()

const tagNamesOf = (tags: readonly string[]): readonly string[] => [...new Set(tags.flatMap((tag) => [tag, toKebab(tag)]))]

export const mentionsTag = (text: string, tags: readonly string[]): boolean => {
  const block = templateBlock(text)
  if (block === null) return false
  return scanTags(text, { tags: tagNamesOf(tags), from: block.start, to: block.end }).length > 0
}
