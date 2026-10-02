import type { AppGraph } from "../../core/model.js"
import { by, byNumber, thenBy } from "../../core/order.js"
import { toYaml } from "../../emit/yaml.js"
import { EXIT_USAGE, UNKNOWN_SCREEN_CODE } from "../../pipeline/exit-codes.js"
import { optionAttribute } from "../args.js"
import type { CommandSpec, OptionSpec, OptionValue, QueryContext } from "../commands.js"
import { DEFAULT_LIMIT } from "../commands.js"
import { CliError } from "../index.js"
import { sanitizeForTerminal } from "../print.js"
import type { LoadedGraph } from "./runtime.js"

export const QUERY_SCHEMA_VERSION = 2

export type Row = Readonly<Record<string, unknown>>

export type Page<T> = {
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly truncated: boolean
  readonly nextOffset: number | null
  readonly items: readonly T[]
}

export type PageWindow = {
  readonly limit: number
  readonly offset: number
}

export const paginate = <T>(items: readonly T[], window: PageWindow): Page<T> => {
  const end = window.offset + window.limit
  const truncated = end < items.length
  return {
    total: items.length,
    offset: window.offset,
    limit: window.limit,
    truncated,
    nextOffset: truncated ? end : null,
    items: items.slice(window.offset, end),
  }
}

const fieldNames = (spec: CommandSpec): readonly string[] => spec.fields.map((field) => field.name)

export const unknownFieldError = (spec: CommandSpec, unknown: readonly string[]): CliError =>
  new CliError(`unknown field${unknown.length === 1 ? "" : "s"} for ${spec.name}: ${unknown.join(", ")}`, EXIT_USAGE, {
    code: "usage/unknown-field",
    hint: `valid fields: ${fieldNames(spec).join(", ")}`,
  })

export const selectedFields = (spec: CommandSpec, requested: readonly string[] | null): readonly string[] | null => {
  if (requested === null) return null
  const known = fieldNames(spec)
  const unknown = requested.filter((name) => !known.includes(name))
  if (unknown.length > 0) throw unknownFieldError(spec, unknown)
  return requested
}

export const projectFields = (row: Row, fields: readonly string[] | null): Row =>
  fields === null ? row : Object.fromEntries(fields.filter((name) => name in row).map((name) => [name, row[name]]))

export type EmptyResultField = { readonly emptyResult: true; readonly emptyReason: string | null } | Record<string, never>

export const emptyResultOf = (graph: AppGraph | null): EmptyResultField =>
  graph?.meta.emptyResult === true ? { emptyResult: true, emptyReason: graph.meta.emptyReason ?? null } : {}

export const emptyResultNotice = (graph: AppGraph | null): string | null => {
  if (graph?.meta.emptyResult !== true) return null
  const reason = graph.meta.emptyReason === undefined ? "" : `: ${graph.meta.emptyReason}`
  return `appgraph: the graph has no screens (empty result)${reason}`
}

type EnvelopeHead = {
  readonly command: string
  readonly loaded?: LoadedGraph | null
  readonly extra?: Row
}

const envelopeHead = (input: EnvelopeHead) => ({
  schemaVersion: QUERY_SCHEMA_VERSION,
  command: input.command,
  ...(input.loaded === undefined || input.loaded === null ? {} : { cache: input.loaded.cache }),
  ...emptyResultOf(input.loaded?.graph ?? null),
  ...(input.extra ?? {}),
})

export type ListEnvelopeInput = EnvelopeHead & {
  readonly page: Page<Row>
  readonly fields: readonly string[] | null
}

export const listEnvelope = (input: ListEnvelopeInput) => ({
  ...envelopeHead(input),
  total: input.page.total,
  offset: input.page.offset,
  limit: input.page.limit,
  truncated: input.page.truncated,
  ...(input.page.nextOffset === null ? {} : { nextOffset: input.page.nextOffset }),
  items: input.page.items.map((item) => projectFields(item, input.fields)),
})

export type ItemEnvelopeInput = EnvelopeHead & {
  readonly item: Row
  readonly fields: readonly string[] | null
}

export const itemEnvelope = (input: ItemEnvelopeInput) => ({
  ...envelopeHead(input),
  item: projectFields(input.item, input.fields),
})

export const formatJson = (value: unknown): string => JSON.stringify(value)

const EMPTY_CELL = "-"

const COLUMN_GAP = "  "

export const formatCell = (value: unknown): string => {
  if (value === null || value === undefined) return EMPTY_CELL
  if (typeof value === "string") return sanitizeForTerminal(value.replace(/\r?\n/g, "\\n"))
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.length === 0 ? EMPTY_CELL : value.map(formatCell).join(",")
  return sanitizeForTerminal(JSON.stringify(value))
}

const widthsOf = (table: readonly (readonly string[])[], columns: number): readonly number[] =>
  Array.from({ length: columns }, (_, index) => Math.max(...table.map((cells) => (cells[index] ?? "").length)))

const alignRow = (cells: readonly string[], widths: readonly number[]): string =>
  cells
    .map((cell, index) => cell.padEnd(widths[index] ?? 0))
    .join(COLUMN_GAP)
    .trimEnd()

export const formatTable = (rows: readonly Row[], columns: readonly string[]): readonly string[] => {
  const table = [columns, ...rows.map((row) => columns.map((column) => formatCell(row[column])))]
  const widths = widthsOf(table, columns.length)
  return table.map((cells) => alignRow(cells, widths))
}

const SAFE_SHELL_WORD = /^[\w@%+=:,./-]+$/

export const shellQuote = (word: string): string => (SAFE_SHELL_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)

const longFlagOf = (option: OptionSpec): string => option.flags.split(/[\s,]+/).find((part) => part.startsWith("--")) ?? option.flags

const isNegated = (flag: string): boolean => flag.startsWith("--no-")

const optionWords = (option: OptionSpec, value: OptionValue | undefined): readonly string[] => {
  if (value === undefined || value === option.defaultValue) return []
  const flag = longFlagOf(option)
  if (typeof value === "boolean") return value !== isNegated(flag) ? [flag] : []
  if (typeof value === "number") return [flag, String(value)]
  if (typeof value === "string") return [flag, shellQuote(value)]
  return [flag, shellQuote(value.join(","))]
}

const argWords = (context: QueryContext): readonly string[] =>
  context.spec.args.flatMap((arg) => {
    const value = context.args[arg.key]
    return value === undefined ? [] : [shellQuote(value)]
  })

const ownWords = (context: QueryContext): readonly string[] =>
  context.spec.options.flatMap((option) => optionWords(option, context.own[optionAttribute(option)]))

const queryWords = (context: QueryContext, offset: number): readonly string[] => [
  ...(context.query.fields === null ? [] : ["--fields", shellQuote(context.query.fields.join(","))]),
  ...(context.query.limit === DEFAULT_LIMIT ? [] : ["--limit", String(context.query.limit)]),
  "--offset",
  String(offset),
]

export const nextPageCommand = (context: QueryContext, offset: number): string =>
  ["appgraph", context.command, ...argWords(context), ...ownWords(context), ...queryWords(context, offset)].join(" ")

export const listFooter = (context: QueryContext, page: Page<unknown>): string | null => {
  if (page.nextOffset === null) return null
  const range = `${String(page.offset + 1)}-${String(page.offset + page.items.length)}`
  return `${range} of ${String(page.total)} — next: ${nextPageCommand(context, page.nextOffset)}`
}

const emptyPageLine = (page: Page<unknown>): string =>
  page.total === 0
    ? "(no matches)"
    : `(offset ${String(page.offset)} is past the last of ${String(page.total)} items)`

export type ListText = {
  readonly page: Page<Row>
  readonly columns: readonly string[]
}

export const formatListText = (context: QueryContext, input: ListText): readonly string[] => {
  if (input.page.items.length === 0) return [emptyPageLine(input.page)]
  const footer = listFooter(context, input.page)
  return [...formatTable(input.page.items, input.columns), ...(footer === null ? [] : [footer])]
}

export const formatItemText = (item: Row): readonly string[] =>
  toYaml(item)
    .replace(/\n$/, "")
    .split("\n")
    .map(sanitizeForTerminal)

const humanSink = (context: QueryContext): ((line: string) => void) =>
  context.options.json ? context.writer.err : context.writer.out

const emitLines = (sink: (line: string) => void, lines: readonly string[]): void => {
  for (const line of lines) sink(line)
}

const writeNotice = (context: QueryContext, loaded: LoadedGraph | null | undefined): void => {
  const notice = emptyResultNotice(loaded?.graph ?? null)
  if (notice !== null && !context.options.quiet) humanSink(context)(notice)
}

export type ListOutput = {
  readonly loaded?: LoadedGraph | null
  readonly items: readonly Row[]
  readonly columns: readonly string[]
  readonly extra?: Row
}

export const writeList = (context: QueryContext, output: ListOutput): void => {
  const fields = selectedFields(context.spec, context.query.fields)
  const page = paginate(output.items, context.query)
  writeNotice(context, output.loaded)
  if (context.options.json) {
    context.writer.out(
      formatJson(listEnvelope({ command: context.command, page, fields, ...optionalHead(output.loaded, output.extra) })),
    )
    return
  }
  const projected = { ...page, items: page.items.map((item) => projectFields(item, fields)) }
  emitLines(context.writer.out, formatListText(context, { page: projected, columns: fields ?? output.columns }))
}

export type ItemOutput = {
  readonly loaded?: LoadedGraph | null
  readonly item: Row
  readonly extra?: Row
}

export const writeItem = (context: QueryContext, output: ItemOutput): void => {
  const fields = selectedFields(context.spec, context.query.fields)
  writeNotice(context, output.loaded)
  if (context.options.json) {
    context.writer.out(
      formatJson(itemEnvelope({ command: context.command, item: output.item, fields, ...optionalHead(output.loaded, output.extra) })),
    )
    return
  }
  emitLines(context.writer.out, formatItemText(projectFields(output.item, fields)))
}

const optionalHead = (loaded: LoadedGraph | null | undefined, extra: Row | undefined) => ({
  ...(loaded === undefined ? {} : { loaded }),
  ...(extra === undefined ? {} : { extra }),
})

const editDistance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0] ?? 0
    previous[0] = row
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column] ?? 0
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      previous[column] = Math.min(above + 1, (previous[column - 1] ?? 0) + 1, diagonal + cost)
      diagonal = above
    }
  }
  return previous[right.length] ?? 0
}

type Scored = {
  readonly candidate: string
  readonly tier: number
  readonly distance: number
}

const MATCH_TIERS = { exact: 0, prefix: 1, substring: 2, similar: 3 } as const

const tierOf = (candidate: string, query: string): number => {
  if (candidate === query) return MATCH_TIERS.exact
  if (candidate.startsWith(query)) return MATCH_TIERS.prefix
  if (candidate.includes(query) || query.includes(candidate)) return MATCH_TIERS.substring
  return MATCH_TIERS.similar
}

const similarityLimit = (query: string): number => Math.max(2, Math.ceil(query.length / 2))

const scoreOf = (candidate: string, query: string): Scored => {
  const folded = candidate.toLowerCase()
  return { candidate, tier: tierOf(folded, query), distance: editDistance(folded, query) }
}

const isNear = (scored: Scored, query: string): boolean =>
  scored.tier < MATCH_TIERS.similar || scored.distance <= similarityLimit(query)

const byScore = thenBy<Scored>(
  (a, b) => byNumber(a.tier, b.tier),
  (a, b) => byNumber(a.distance, b.distance),
  by((scored) => scored.candidate),
)

export const DEFAULT_SUGGESTIONS = 5

export const nearestMatches = (candidates: Iterable<string>, query: string, n: number = DEFAULT_SUGGESTIONS): readonly string[] => {
  const folded = query.toLowerCase()
  if (folded === "") return []
  return [...new Set(candidates)]
    .map((candidate) => scoreOf(candidate, folded))
    .filter((scored) => isNear(scored, folded))
    .sort(byScore)
    .slice(0, n)
    .map((scored) => scored.candidate)
}

export type UnknownTarget = {
  readonly kind: string
  readonly target: string
  readonly candidates: Iterable<string>
  readonly code?: string
}

export const unknownTargetError = (input: UnknownTarget): CliError => {
  const suggestions = nearestMatches(input.candidates, input.target)
  return new CliError(`unknown ${input.kind} '${input.target}'`, EXIT_USAGE, {
    code: input.code ?? UNKNOWN_SCREEN_CODE,
    hint: suggestions.length === 0 ? `run appgraph ${input.kind}s to list them` : `did you mean: ${suggestions.join(", ")}`,
  })
}
