/**
 * A reader for the exact YAML dialect the golden is written in, which is also the dialect
 * `src/emit/yaml.ts` produces: block mappings, block sequences, `[]` / `{}` for empty
 * containers, and scalars that are either plain or `JSON.stringify`d. No anchors, no flow
 * collections, no block scalars, no multi-document streams, no comments.
 *
 * Why a reader lives in the test tree rather than being imported from `src/`: `src/emit/yaml.ts`
 * keeps its round-trip parser private (it is an emit-path self-check, and it deliberately returns
 * every scalar as a string). The parity gate needs typed scalars so that `line: 12` compares as a
 * number on both sides, and it must never be able to make the gate pass by sharing a bug with the
 * emitter. A separate reader is the independent oracle.
 *
 * `scripts/`-free by design: `test/parity/oracle.mts` cross-checks this reader against `js-yaml`
 * when that package happens to be reachable, so `js-yaml` is never a dependency of appgraph.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

export class YamlReadError extends Error {
  constructor(message: string, line: number) {
    super(`${message} (line ${String(line + 1)})`)
    this.name = "YamlReadError"
  }
}

type Line = {
  readonly indent: number
  readonly text: string
  /** 0-based index in the source, for error messages only. */
  readonly at: number
}

const toLines = (text: string): readonly Line[] =>
  text
    .split("\n")
    .map((raw, at) => ({ raw, at }))
    .filter(({ raw }) => raw.trim() !== "")
    .map(({ raw, at }) => ({ indent: raw.length - raw.trimStart().length, text: raw.trimStart(), at }))

const LOOKS_NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

const parseScalar = (token: string, at: number): YamlValue => {
  if (token.startsWith('"')) {
    const parsed: unknown = JSON.parse(token)
    if (typeof parsed !== "string") throw new YamlReadError(`quoted scalar is not a string: ${token}`, at)
    return parsed
  }
  if (token === "null" || token === "~") return null
  if (token === "true") return true
  if (token === "false") return false
  if (LOOKS_NUMERIC.test(token)) return Number(token)
  return token
}

/**
 * Splits `key: value` — or `key:` with the value in the block below — honouring a JSON-quoted key.
 * The emitter only ever writes `: ` as the separator, so a bare `:` at end-of-line means "block
 * follows" and `: ` means "inline value follows".
 */
const splitEntry = (text: string, at: number): { readonly key: string; readonly rest: string | null } => {
  if (text.startsWith('"')) {
    let i = 1
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2
        continue
      }
      if (text[i] === '"') break
      i += 1
    }
    if (i >= text.length) throw new YamlReadError(`unterminated quoted key: ${text}`, at)
    const key = parseScalar(text.slice(0, i + 1), at)
    if (typeof key !== "string") throw new YamlReadError(`quoted key is not a string: ${text}`, at)
    const after = text.slice(i + 1)
    if (!after.startsWith(":")) throw new YamlReadError(`expected ':' after quoted key: ${text}`, at)
    const rest = after.slice(1)
    return { key, rest: rest === "" ? null : rest.replace(/^ /, "") }
  }

  const separator = text.search(/:(?: |$)/)
  if (separator === -1) throw new YamlReadError(`not a mapping entry: ${text}`, at)
  const key = text.slice(0, separator)
  const rest = text.slice(separator + 1)
  return { key, rest: rest === "" ? null : rest.replace(/^ /, "") }
}

const inlineValue = (token: string, at: number): YamlValue => {
  if (token === "[]") return []
  if (token === "{}") return {}
  return parseScalar(token, at)
}

const at = (lines: readonly Line[], index: number): Line => {
  const line = lines[index]
  if (line === undefined) throw new YamlReadError("unexpected end of document", index)
  return line
}

/** Consumes every line at `indent` or deeper starting at `start`, returning [value, nextIndex]. */
const parseBlock = (lines: readonly Line[], start: number, indent: number): readonly [YamlValue, number] => {
  const first = at(lines, start)
  return first.text.startsWith("- ") || first.text === "-"
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent)
}

const childRange = (lines: readonly Line[], start: number, minIndent: number): number => {
  let i = start
  while (i < lines.length && at(lines, i).indent >= minIndent) i += 1
  return i
}

const parseSequence = (lines: readonly Line[], start: number, indent: number): readonly [YamlValue, number] => {
  const items: YamlValue[] = []
  let i = start
  while (i < lines.length) {
    const line = at(lines, i)
    if (line.indent < indent) break
    if (line.indent > indent) throw new YamlReadError(`unexpected indent in sequence: ${line.text}`, line.at)
    if (!line.text.startsWith("- ") && line.text !== "-") break

    const head = line.text === "-" ? "" : line.text.slice(2)
    const childIndent = indent + 2
    const end = childRange(lines, i + 1, childIndent)

    if (head === "" || head === "[]" || head === "{}") {
      // Empty containers are inlined by the emitter; a bare `-` never occurs but is tolerated.
      items.push(head === "" ? null : inlineValue(head, line.at))
      i = i + 1
      continue
    }

    // A quoted head is always a scalar: the emitter quotes any string that would otherwise look like
    // structure, which is exactly the `"a: b"` case that must not be read back as a mapping.
    const isEntryHead = !head.startsWith('"') && (head.startsWith("- ") || /:(?: |$)/.test(head))
    if (end > i + 1 || isEntryHead) {
      // A container item: its first line was hoisted onto the `- ` line by the emitter, so re-indent
      // it back into the child block and parse the whole thing as one value.
      const hoisted: Line = { indent: childIndent, text: head, at: line.at }
      const [value] = parseBlock([hoisted, ...lines.slice(i + 1, end)], 0, childIndent)
      items.push(value)
      i = end
      continue
    }

    items.push(parseScalar(head, line.at))
    i += 1
  }
  return [items, i] as const
}

const parseMapping = (lines: readonly Line[], start: number, indent: number): readonly [YamlValue, number] => {
  const result: Record<string, YamlValue> = {}
  let i = start
  while (i < lines.length) {
    const line = at(lines, i)
    if (line.indent < indent) break
    if (line.indent > indent) throw new YamlReadError(`unexpected indent in mapping: ${line.text}`, line.at)
    if (line.text.startsWith("- ")) break

    const { key, rest } = splitEntry(line.text, line.at)
    if (rest === null) {
      const childIndent = indent + 2
      const end = childRange(lines, i + 1, childIndent)
      if (end === i + 1) throw new YamlReadError(`key '${key}' has no value and no block`, line.at)
      const [value] = parseBlock(lines.slice(i + 1, end), 0, childIndent)
      result[key] = value
      i = end
      continue
    }
    result[key] = inlineValue(rest, line.at)
    i += 1
  }
  return [result, i] as const
}

export const readYaml = (text: string): YamlValue => {
  const lines = toLines(text)
  if (lines.length === 0) return null
  const [value, consumed] = parseBlock(lines, 0, 0)
  if (consumed !== lines.length) {
    throw new YamlReadError(`trailing content not consumed: ${at(lines, consumed).text}`, at(lines, consumed).at)
  }
  return value
}
