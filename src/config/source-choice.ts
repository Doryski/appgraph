import { SOURCE_PRECEDENCE } from "../core/sources.js"
import { by, byNumber, thenBy } from "../core/order.js"
import type { SourceDetection } from "./types.js"

export const MULTIPLE_SOURCES_CODE = "project/multiple-screen-sources"

const precedenceOf = (name: string): number => {
  const index = (SOURCE_PRECEDENCE as readonly string[]).indexOf(name)
  return index === -1 ? SOURCE_PRECEDENCE.length : index
}

/** Score DESC, then §11 rule 7's precedence, then name. Display order only (§10.1). */
export const byDisplayOrder = thenBy<SourceDetection>(
  (a, b) => byNumber(b.score, a.score),
  (a, b) => byNumber(precedenceOf(a.source), precedenceOf(b.source)),
  by((entry) => entry.source),
)

export type SourceChoiceOptions = {
  readonly binName?: string
  readonly rootLabel?: string
}

/**
 * The §10.1 refusal text. Every live source, its score, its evidence at `file:line`, and the exact flag
 * that selects it — a trace, not a tiebreak.
 */
export const formatSourceChoice = (
  detections: readonly SourceDetection[],
  options: SourceChoiceOptions = {},
): string => {
  const bin = options.binName ?? "appgraph"
  const live = [...detections].filter((entry) => entry.live).sort(byDisplayOrder)
  const lines: string[] = [
    `${String(live.length)} screen sources matched in ${options.rootLabel ?? "."}. ${bin} will not guess which one you meant.`,
    "",
  ]

  for (const entry of live) {
    lines.push(`    ${entry.source}   ${String(entry.score)}`)
    for (const evidence of entry.evidence)
      lines.push(`      ${evidence.file}:${String(evidence.line)}  ${evidence.what}`)
  }

  lines.push("")
  lines.push(`  Pick one:            ${bin} --source=${live[0]?.source ?? "<name>"}`)
  lines.push(`  Or analyse all:      ${bin} --all-sources`)
  lines.push(`  Or narrow the root:  ${bin} --root=./src`)

  return lines.join("\n")
}
