/**
 * Gate 4 (§12.3): parse both sides, compare the resulting object graphs with keys sorted by codepoint
 * at every level, and never diff text.
 *
 * The point is separation of concerns. `deepDiff` answers "is the content the same" and is blind to
 * key order by construction, so a change in emission order can never masquerade as a content change.
 * Ordering is a separate question, answered by `orderDiff` on explicit ordered lists (component keys,
 * menu paths) and by the determinism tests in `test/emit/`. A gate that mixes the two cannot fix either
 * without breaking the other (§12.2).
 */

export type Difference = {
  readonly path: string
  readonly left: string
  readonly right: string
  readonly note: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const show = (value: unknown): string => {
  if (value === undefined) return "<absent>"
  const text = JSON.stringify(value)
  return text === undefined ? String(value) : text.length > 200 ? `${text.slice(0, 197)}...` : text
}

const join = (path: string, segment: string): string => (path === "" ? segment : `${path}.${segment}`)

/** Sorted by codepoint — `Array.prototype.sort` with no comparator is exactly codepoint order. */
const sortedKeys = (value: Record<string, unknown>): readonly string[] => Object.keys(value).sort()

export const deepDiff = (left: unknown, right: unknown, path = ""): readonly Difference[] => {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return [{ path, left: show(left), right: show(right), note: "one side is a sequence" }]
    }
    const differences: Difference[] = []
    if (left.length !== right.length) {
      differences.push({
        path,
        left: String(left.length),
        right: String(right.length),
        note: "sequence length",
      })
    }
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      differences.push(...deepDiff(left[i], right[i], join(path, `[${String(i)}]`)))
    }
    return differences
  }

  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) {
      return [{ path, left: show(left), right: show(right), note: "one side is a mapping" }]
    }
    const keys = [...new Set([...sortedKeys(left), ...sortedKeys(right)])].sort()
    return keys.flatMap((key) => deepDiff(left[key], right[key], join(path, key)))
  }

  if (left === right) return []
  return [{ path, left: show(left), right: show(right), note: "value" }]
}

export const setDiff = (
  left: readonly string[],
  right: readonly string[],
): { readonly onlyLeft: readonly string[]; readonly onlyRight: readonly string[] } => {
  const rightSet = new Set(right)
  const leftSet = new Set(left)
  return {
    onlyLeft: [...leftSet].filter((value) => !rightSet.has(value)).sort(),
    onlyRight: [...rightSet].filter((value) => !leftSet.has(value)).sort(),
  }
}

/** The first index at which two ordered lists of the same set diverge, or -1 when they agree. */
export const firstOrderDivergence = (left: readonly string[], right: readonly string[]): number => {
  const limit = Math.min(left.length, right.length)
  for (let i = 0; i < limit; i += 1) if (left[i] !== right[i]) return i
  return left.length === right.length ? -1 : limit
}

export const formatDifferences = (differences: readonly Difference[], limit = 40): string =>
  differences
    .slice(0, limit)
    .map((difference) => `  ${difference.path}: golden=${difference.left} observed=${difference.right} (${difference.note})`)
    .concat(differences.length > limit ? [`  ... and ${String(differences.length - limit)} more`] : [])
    .join("\n")
