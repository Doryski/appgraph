import type { RenderEdge } from "../model.js"

export type Via = RenderEdge["via"]

const VIA_RANK = { reference: 0, jsx: 1, "selector-global": 2, selector: 3, lazy: 4 } as const

const rankOf = (via: Via): number => VIA_RANK[via ?? "jsx"]

// One file reached several ways keeps the strongest provenance: a lazy load over a plain tag, and
// any tag over a value reference.
export const strongerVia = (left: Via, right: Via): Via => (rankOf(right) > rankOf(left) ? right : left)

export const withVia = <T extends object>(value: T, via: Via): T | (T & { readonly via: NonNullable<Via> }) =>
  via === undefined ? value : { ...value, via }
