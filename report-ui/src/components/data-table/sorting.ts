import { byCodepoint } from "@appgraph/emit/html-util.js"
import type { StringKey } from "@appgraph/emit/strings.js"
import type { CellValue, SortKind } from "./columns"

export type SortState = false | "asc" | "desc"

export const compareText = (a: CellValue, b: CellValue): number => byCodepoint(String(a ?? ""), String(b ?? ""))

const toNumber = (value: CellValue): number => {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export const compareNumber = (a: CellValue, b: CellValue): number => {
  const delta = toNumber(a) - toNumber(b)
  return Math.sign(delta)
}

export const SORT_COMPARATORS = {
  text: compareText,
  num: compareNumber,
} as const satisfies Record<SortKind, (a: CellValue, b: CellValue) => number>

export const SORT_DESC_FIRST = {
  text: false,
  num: true,
} as const satisfies Record<SortKind, boolean>

export const toSortValue = (value: CellValue): string | number | undefined => value ?? undefined

const ARIA_SORT = {
  asc: "ascending",
  desc: "descending",
} as const

export const ariaSortOf = (state: SortState) => (state === false ? "none" : ARIA_SORT[state])

export const SORT_LABEL_KEYS = {
  asc: "sortAscending",
  desc: "sortDescending",
} as const satisfies Record<"asc" | "desc", StringKey>

export const sortLabelKeyOf = (state: SortState): StringKey => (state === false ? "sortNone" : SORT_LABEL_KEYS[state])
