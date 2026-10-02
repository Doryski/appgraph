export type ScannedAttribute = {
  readonly name: string
  readonly value: string | null
}

export type ScannedTag = {
  readonly tag: string
  readonly pos: number
  readonly end: number
  readonly line: number
  readonly attributes: readonly ScannedAttribute[]
}

export type ScanTagsOptions = {
  readonly tags: readonly string[]
  readonly from?: number
  readonly to?: number
}

type Cursor = {
  readonly at: number
  readonly line: number
}

type ReadTag = {
  readonly attributes: readonly ScannedAttribute[]
  readonly end: number
}

const COMMENT_OPEN = "<!--"
const COMMENT_CLOSE = "-->"
const TAG_NAME = /[A-Za-z][^\s/>]*/y
const ATTR_NAME = /[^\s=/>][^\s=>]*/y
const UNQUOTED_VALUE = /[^\s>]+/y
const WHITESPACE = /\s*/y
const LINE_BREAK = /\r\n?|\n/g
const QUOTES = new Set(["\"", "'"])

const matchAt = (pattern: RegExp, text: string, at: number): string => {
  pattern.lastIndex = at
  return pattern.exec(text)?.[0] ?? ""
}

const skipWhitespace = (text: string, at: number): number => at + matchAt(WHITESPACE, text, at).length

const breaksIn = (text: string, from: number, to: number): number => text.slice(from, to).match(LINE_BREAK)?.length ?? 0

const advance = (text: string, cursor: Cursor, to: number): Cursor => ({
  at: to,
  line: cursor.line + breaksIn(text, cursor.at, to),
})

const readValue = (text: string, at: number): { readonly value: string; readonly end: number } => {
  const quote = text.charAt(at)
  if (!QUOTES.has(quote)) {
    const value = matchAt(UNQUOTED_VALUE, text, at)
    return { value, end: at + value.length }
  }
  const close = text.indexOf(quote, at + 1)
  const end = close === -1 ? text.length : close
  return { value: text.slice(at + 1, end), end: Math.min(end + 1, text.length) }
}

const readAttributes = (text: string, start: number): ReadTag => {
  const attributes: ScannedAttribute[] = []
  let at = start
  while (at < text.length) {
    at = skipWhitespace(text, at)
    if (text.charAt(at) === ">") return { attributes, end: at + 1 }
    const name = matchAt(ATTR_NAME, text, at)
    if (name === "") {
      at += 1
      continue
    }
    const afterName = skipWhitespace(text, at + name.length)
    if (text.charAt(afterName) !== "=") {
      attributes.push({ name, value: null })
      at = at + name.length
      continue
    }
    const read = readValue(text, skipWhitespace(text, afterName + 1))
    attributes.push({ name, value: read.value })
    at = read.end
  }
  return { attributes, end: text.length }
}

const commentEnd = (text: string, at: number): number => {
  const close = text.indexOf(COMMENT_CLOSE, at + COMMENT_OPEN.length)
  return close === -1 ? text.length : close + COMMENT_CLOSE.length
}

const lineAt = (text: string, at: number): number => 1 + breaksIn(text, 0, at)

export const scanTags = (text: string, options: ScanTagsOptions): readonly ScannedTag[] => {
  const wanted = new Set(options.tags.filter((tag) => tag !== ""))
  if (wanted.size === 0) return []
  const to = Math.min(options.to ?? text.length, text.length)
  const bounded = text.slice(0, to)
  const from = Math.max(options.from ?? 0, 0)
  const found: ScannedTag[] = []
  let cursor: Cursor = { at: from, line: lineAt(bounded, from) }
  for (;;) {
    const open = bounded.indexOf("<", cursor.at)
    if (open === -1) return found
    cursor = advance(bounded, cursor, open)
    if (bounded.startsWith(COMMENT_OPEN, open)) {
      cursor = advance(bounded, cursor, commentEnd(bounded, open))
      continue
    }
    const tag = matchAt(TAG_NAME, bounded, open + 1)
    if (!wanted.has(tag)) {
      cursor = { at: open + 1, line: cursor.line }
      continue
    }
    const read = readAttributes(bounded, open + 1 + tag.length)
    found.push({ tag, pos: open, end: read.end, line: cursor.line, attributes: read.attributes })
    cursor = advance(bounded, cursor, read.end)
  }
}
