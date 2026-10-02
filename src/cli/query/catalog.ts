import { matchesTokens, queryTokens } from "../../emit/report-derive.js"
import { EXIT_USAGE } from "../../pipeline/exit-codes.js"
import type { OptionValue, QueryContext } from "../commands.js"
import { CliError } from "../index.js"
import { nearestMatches } from "./output.js"

export const CATALOG_LOCALE = "en"

export type RowFilter<T> = (row: T) => boolean

export const stringOption = (value: OptionValue | undefined): string | null => (typeof value === "string" ? value : null)

export const isFlagSet = (value: OptionValue | undefined): boolean => value === true

export const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  values.some((candidate) => candidate === value)

export const ownString = (context: QueryContext, key: string): string | null => stringOption(context.own[key])

export const applyFilters = <T>(rows: readonly T[], filters: readonly (RowFilter<T> | null)[]): readonly T[] => {
  const active = filters.filter((filter): filter is RowFilter<T> => filter !== null)
  return active.length === 0 ? rows : rows.filter((row) => active.every((filter) => filter(row)))
}

export const tokenFilter = <T>(query: string | null, haystack: (row: T) => string): RowFilter<T> | null => {
  if (query === null) return null
  const tokens = queryTokens(query)
  return (row) => matchesTokens(haystack(row), tokens)
}

export const searchText = (...parts: readonly (string | null)[]): string =>
  parts
    .filter((part): part is string => part !== null)
    .join(" ")
    .toLowerCase()

export type UnknownValue = {
  readonly what: string
  readonly value: string
  readonly valid: readonly string[]
  readonly code: string
}

const validHint = (input: UnknownValue): string => {
  const suggestions = nearestMatches(input.valid, input.value)
  if (suggestions.length > 0) return `did you mean: ${suggestions.join(", ")}`
  return input.valid.length === 0 ? `there are no ${input.what}s in this graph` : `valid ${input.what}s: ${input.valid.join(", ")}`
}

export const unknownValueError = (input: UnknownValue): CliError =>
  new CliError(`unknown ${input.what} '${input.value}'`, EXIT_USAGE, { code: input.code, hint: validHint(input) })

export const requireKnown = (input: UnknownValue): void => {
  if (!input.valid.includes(input.value)) throw unknownValueError(input)
}
