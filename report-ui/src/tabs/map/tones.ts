export const EDGE_TONE = {
  base: "stroke-muted-foreground",
  out: "stroke-sky-600 dark:stroke-sky-400",
  in: "stroke-amber-600 dark:stroke-amber-400",
} as const

export const MARKER_TONE = {
  base: "fill-muted-foreground",
  out: "fill-sky-600 dark:fill-sky-400",
  in: "fill-amber-600 dark:fill-amber-400",
} as const

export const TONES = ["base", "out", "in"] as const satisfies readonly (keyof typeof EDGE_TONE)[]

export type Tone = (typeof TONES)[number]

export const DASH = { dynamic: "4 3", incoming: "1.5 3", unknownRing: "2 2" } as const
