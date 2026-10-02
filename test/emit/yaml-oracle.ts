export type TruncatedString = {
  readonly __brand: "TruncatedString"
  readonly value: string
}

export const markTruncated = (value: string): TruncatedString => ({
  __brand: "TruncatedString",
  value,
})

const isTruncatedString = (value: unknown): value is TruncatedString =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly __brand?: unknown }).__brand === "TruncatedString"

export class YamlEmitError extends Error {
  constructor(message: string) {
    super(`emit/unparseable-yaml: ${message}`)
    this.name = "YamlEmitError"
  }
}

const BACKSLASH = String.fromCharCode(0x5c)
const NEXT_LINE = String.fromCharCode(0x85)
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

const LEADING_INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/
const COLON_SPACE = /: /
const TRAILING_COLON = /:$/
const SPACE_HASH = /\s#/
const LEADING_HASH = /^#/
const LEADING_OR_TRAILING_WS = /^\s|\s$/
const NEWLINE_OR_SEPARATOR = new RegExp("[\\n\\r" + LINE_SEPARATOR + PARAGRAPH_SEPARATOR + "]")
const YAML_KEYWORD = /^(true|false|null|yes|no|on|off|y|n|~|<<|=)$/i
const YAML_NUMBER =
  /^[+-]?(0x[0-9a-fA-F]+|0o[0-7]+|0[0-7]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)$|^[+-]?\.inf$|^\.nan$/i
// eslint-disable-next-line no-control-regex -- intentional: detects raw C0 bytes real YAML parsers reject
const CONTROL_CHAR = /[\x00-\x1f]/
const NON_PRINTABLE = /[\x7f-\x9f\ud800-\udfff\ufeff\ufffe\uffff]/u
const YAML_PREFIXED_INT = /^[+-]?0(b[01_]+|o?[0-7_]+|x[\da-f_]+)$/i
const YAML_UNDERSCORED_NUMBER = /^[+-]?(\d[\d_]*\.?[\d_]*|\.[\d_]+)(e[+-]?\d+)?$/i
const YAML_SEXAGESIMAL = /^[+-]?\d[\d_]*(:[0-5]?\d)+(\.[\d_]*)?$/
const YAML_TIMESTAMP =
  /^\d{4}-\d{1,2}-\d{1,2}(([Tt]|[ \t]+)\d{1,2}:\d{2}:\d{2}(\.\d*)?([ \t]*(Z|[+-]\d{1,2}(:\d{2})?))?)?$/

const IMPLICIT_TYPE_PATTERNS = [
  YAML_KEYWORD,
  YAML_NUMBER,
  YAML_PREFIXED_INT,
  YAML_UNDERSCORED_NUMBER,
  YAML_SEXAGESIMAL,
  YAML_TIMESTAMP,
] as const

const resolvesToImplicitType = (text: string): boolean => IMPLICIT_TYPE_PATTERNS.some((pattern) => pattern.test(text))

const needsQuoting = (text: string, truncated: boolean): boolean =>
  truncated ||
  text.length === 0 ||
  LEADING_INDICATOR.test(text) ||
  COLON_SPACE.test(text) ||
  TRAILING_COLON.test(text) ||
  SPACE_HASH.test(text) ||
  LEADING_HASH.test(text) ||
  LEADING_OR_TRAILING_WS.test(text) ||
  NEWLINE_OR_SEPARATOR.test(text) ||
  CONTROL_CHAR.test(text) ||
  NON_PRINTABLE.test(text) ||
  resolvesToImplicitType(text)

const toUnicodeEscape = (codePoint: number): string => BACKSLASH + "u" + codePoint.toString(16).padStart(4, "0")

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  [BACKSLASH]: BACKSLASH + BACKSLASH,
  '"': BACKSLASH + '"',
  "\n": BACKSLASH + "n",
  "\t": BACKSLASH + "t",
  "\r": BACKSLASH + "r",
  [NEXT_LINE]: toUnicodeEscape(0x85),
  [LINE_SEPARATOR]: toUnicodeEscape(0x2028),
  [PARAGRAPH_SEPARATOR]: toUnicodeEscape(0x2029),
}

const escapeChar = (char: string): string => {
  const known = SIMPLE_ESCAPES[char]
  if (known !== undefined) return known
  const codePoint = char.codePointAt(0) ?? 0
  if (codePoint <= 0x1f || NON_PRINTABLE.test(char)) return toUnicodeEscape(codePoint)
  return char
}

const quoteScalar = (text: string): string => `"${Array.from(text).map(escapeChar).join("")}"`

const scalarText = (value: unknown): { readonly text: string; readonly truncated: boolean } => {
  if (isTruncatedString(value)) return { text: value.value, truncated: true }
  if (value === null || value === undefined) return { text: "null", truncated: false }
  return { text: String(value), truncated: false }
}

const scalar = (value: unknown): string => {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return scalarText(value).text
  }
  const { text, truncated } = scalarText(value)
  return needsQuoting(text, truncated) ? quoteScalar(text) : text
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !isTruncatedString(value)

const isContainer = (value: unknown): boolean => Array.isArray(value) || isRecord(value)

const isEmptyContainer = (lines: readonly string[]): boolean =>
  lines.length === 1 && (lines[0] === "[]" || lines[0] === "{}")

const serialize = (value: unknown, indent: string): readonly string[] => {
  if (Array.isArray(value)) {
    if (value.length === 0) return ["[]"]

    return value.flatMap((item) => {
      if (!isContainer(item)) return [`${indent}- ${scalar(item)}`]

      const lines = serialize(item, `${indent}  `)
      if (isEmptyContainer(lines)) return [`${indent}- ${lines[0]}`]

      const [head, ...tail] = lines
      return [`${indent}- ${(head ?? "").trimStart()}`, ...tail]
    })
  }

  if (isRecord(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return ["{}"]

    return entries.flatMap(([key, item]) => {
      const keyText = scalar(key)
      if (!isContainer(item)) return [`${indent}${keyText}: ${scalar(item)}`]

      const lines = serialize(item, `${indent}  `)
      if (isEmptyContainer(lines)) return [`${indent}${keyText}: ${lines[0]}`]

      return [`${indent}${keyText}:`, ...lines]
    })
  }

  return [scalar(value)]
}

type Line = { readonly indent: number; readonly text: string }

const toLines = (yaml: string): readonly Line[] =>
  yaml
    .split("\n")
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      const trimmed = raw.trimStart()
      return { indent: raw.length - trimmed.length, text: trimmed }
    })

const requireLine = (lines: readonly Line[], index: number): Line => {
  const line = lines[index]
  if (line === undefined) throw new YamlEmitError(`unexpected end of input at line ${index}`)
  return line
}

const findClosingQuoteIndex = (text: string, from: number): number => {
  let i = from
  while (i < text.length) {
    const char = text[i]
    if (char === BACKSLASH) {
      i += 2
      continue
    }
    if (char === '"') return i
    i += 1
  }
  return -1
}

const unescapeDoubleQuoted = (token: string): string => {
  const inner = token.slice(1, -1)
  let result = ""
  let i = 0
  while (i < inner.length) {
    const char = inner[i]
    if (char !== BACKSLASH) {
      result += char
      i += 1
      continue
    }
    const next = inner[i + 1]
    switch (next) {
      case "n":
        result += "\n"
        i += 2
        break
      case "t":
        result += "\t"
        i += 2
        break
      case "r":
        result += "\r"
        i += 2
        break
      case '"':
        result += '"'
        i += 2
        break
      case BACKSLASH:
        result += BACKSLASH
        i += 2
        break
      case "u": {
        const hex = inner.slice(i + 2, i + 6)
        result += String.fromCharCode(Number.parseInt(hex, 16))
        i += 6
        break
      }
      default:
        throw new YamlEmitError(`unsupported escape sequence '${BACKSLASH}${next ?? ""}' in ${token}`)
    }
  }
  return result
}

const quotedKeyBoundary = (
  text: string,
): { readonly closeIndex: number; readonly after: string } | null => {
  if (!text.startsWith('"')) return null
  const closeIndex = findClosingQuoteIndex(text, 1)
  if (closeIndex === -1) throw new YamlEmitError(`unterminated quoted scalar: ${text}`)
  return { closeIndex, after: text.slice(closeIndex + 1) }
}

const looksLikeMappingKey = (text: string): boolean => {
  const boundary = quotedKeyBoundary(text)
  if (boundary !== null) return boundary.after === ":" || boundary.after.startsWith(": ")
  if (text.indexOf(": ") !== -1) return true
  return text.endsWith(":") && text !== ":"
}

const splitKeyValue = (text: string): { readonly key: string; readonly rest: string | undefined } => {
  const boundary = quotedKeyBoundary(text)
  if (boundary !== null) {
    const key = unescapeDoubleQuoted(text.slice(0, boundary.closeIndex + 1))
    if (boundary.after === ":") return { key, rest: undefined }
    return { key, rest: boundary.after.slice(2) }
  }
  const colonSpaceIndex = text.indexOf(": ")
  if (colonSpaceIndex !== -1) {
    return { key: text.slice(0, colonSpaceIndex), rest: text.slice(colonSpaceIndex + 2) }
  }
  return { key: text.slice(0, -1), rest: undefined }
}

const parseScalarToken = (token: string): string => (token.startsWith('"') ? unescapeDoubleQuoted(token) : token)

const parseInlineValue = (token: string): unknown => {
  if (token === "[]") return []
  if (token === "{}") return {}
  return parseScalarToken(token)
}

const parseBlock = (lines: readonly Line[], index: number, indent: number): readonly [unknown, number] => {
  const first = requireLine(lines, index)
  if (first.indent !== indent) throw new YamlEmitError(`indentation mismatch at line ${index}`)
  if (first.text === "[]") return [[], index + 1]
  if (first.text === "{}") return [{}, index + 1]
  if (first.text === "-" || first.text.startsWith("- ")) return parseSequence(lines, index, indent)
  if (looksLikeMappingKey(first.text)) return parseMapping(lines, index, indent)
  return [parseScalarToken(first.text), index + 1]
}

const parseSequence = (lines: readonly Line[], start: number, indent: number): readonly [unknown, number] => {
  const items: unknown[] = []
  let i = start
  while (i < lines.length) {
    const line = requireLine(lines, i)
    if (line.indent !== indent || !(line.text === "-" || line.text.startsWith("- "))) break

    const remainder = line.text === "-" ? "" : line.text.slice(2)
    const itemIndent = indent + 2
    const itemLines: Line[] = [{ indent: itemIndent, text: remainder }]

    let j = i + 1
    while (j < lines.length) {
      const next = requireLine(lines, j)
      if (next.indent < itemIndent) break
      itemLines.push(next)
      j += 1
    }

    const [value] = parseBlock(itemLines, 0, itemIndent)
    items.push(value)
    i = j
  }
  return [items, i] as const
}

const parseMapping = (lines: readonly Line[], start: number, indent: number): readonly [unknown, number] => {
  const result: Record<string, unknown> = {}
  let i = start
  while (i < lines.length) {
    const line = requireLine(lines, i)
    if (line.indent !== indent || line.text === "-" || line.text.startsWith("- ")) break
    if (!looksLikeMappingKey(line.text)) break

    const { key, rest } = splitKeyValue(line.text)
    if (rest === undefined) {
      const nestedIndent = indent + 2
      const nestedLines: Line[] = []
      let j = i + 1
      while (j < lines.length) {
        const next = requireLine(lines, j)
        if (next.indent < nestedIndent) break
        nestedLines.push(next)
        j += 1
      }
      const [value] = parseBlock(nestedLines, 0, nestedIndent)
      result[key] = value
      i = j
    } else {
      result[key] = parseInlineValue(rest)
      i += 1
    }
  }
  return [result, i] as const
}

const parseYamlDocument = (text: string): unknown => {
  const lines = toLines(text)
  if (lines.length === 0) return null
  const [value] = parseBlock(lines, 0, 0)
  return value
}

const toComparableScalar = (value: unknown): string => {
  if (isTruncatedString(value)) return value.value
  if (value === null || value === undefined) return "null"
  return String(value)
}

const formatPath = (path: readonly (string | number)[]): string =>
  path.length === 0
    ? "<root>"
    : path.map((segment) => (typeof segment === "number" ? `[${segment}]` : segment)).join(".")

const compareRoundTrip = (
  original: unknown,
  parsed: unknown,
  path: readonly (string | number)[],
): string | null => {
  if (Array.isArray(original)) {
    if (!Array.isArray(parsed)) return `expected sequence at ${formatPath(path)}`
    if (original.length !== parsed.length) return `sequence length mismatch at ${formatPath(path)}`
    for (let i = 0; i < original.length; i += 1) {
      const mismatch = compareRoundTrip(original[i], parsed[i], [...path, i])
      if (mismatch !== null) return mismatch
    }
    return null
  }

  if (isRecord(original)) {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return `expected mapping at ${formatPath(path)}`
    }
    const parsedRecord = parsed as Record<string, unknown>
    const keys = Object.keys(original)
    if (keys.length !== Object.keys(parsedRecord).length) {
      return `mapping key count mismatch at ${formatPath(path)}`
    }
    for (const key of keys) {
      if (!(key in parsedRecord)) return `missing key '${key}' at ${formatPath(path)}`
      const mismatch = compareRoundTrip(original[key], parsedRecord[key], [...path, key])
      if (mismatch !== null) return mismatch
    }
    return null
  }

  const expected = toComparableScalar(original)
  if (typeof parsed !== "string" || parsed !== expected) {
    return `scalar mismatch at ${formatPath(path)}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(parsed)}`
  }
  return null
}

const findNonPrintable = (text: string): string | null => {
  const match = text.replaceAll("\n", "").match(CONTROL_CHAR) ?? text.match(NON_PRINTABLE)
  return match === null ? null : `non-printable character ${toUnicodeEscape(match[0].codePointAt(0) ?? 0)} in output`
}

export const toYaml = (value: unknown): string => {
  const text = `${serialize(value, "").join("\n")}\n`
  const nonPrintable = findNonPrintable(text)
  if (nonPrintable !== null) throw new YamlEmitError(nonPrintable)
  const parsed = parseYamlDocument(text)
  const mismatch = compareRoundTrip(value, parsed, [])
  if (mismatch !== null) throw new YamlEmitError(mismatch)
  return text
}

export type YamlOutcome =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "error"; readonly name: string; readonly message: string }

export const outcomeOf = (emit: (value: unknown) => string, value: unknown): YamlOutcome => {
  try {
    return { kind: "text", text: emit(value) }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return { kind: "error", name: error.name, message: error.message }
  }
}

export const oracleOutcome = (value: unknown): YamlOutcome => outcomeOf(toYaml, value)
