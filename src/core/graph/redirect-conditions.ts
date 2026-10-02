export const CONJUNCTION = " && "

/** Each character's parenthesis depth, so operators inside `!(a || b)` are told from top-level ones. */
const depthsOf = (text: string): readonly number[] =>
  [...text].reduce<number[]>((depths, char, index) => {
    const before = index === 0 ? 0 : (depths[index - 1] ?? 0) + (text[index - 1] === "(" ? 1 : 0)
    return [...depths, char === ")" ? before - 1 : before]
  }, [])

const LOOSER_THAN_AND = /\|\||\?/

/**
 * The conjuncts of a rule's `condition` (branch texts joined with ` && ` by the config reader). A text
 * whose top level also holds a looser operator (`||`, `??`, `?:`) cannot be split safely and stays one term.
 */
export const conditionTerms = (condition: string | null): readonly string[] => {
  if (condition === null) return []
  const depths = depthsOf(condition)
  const topLevel = [...condition].map((char, index) => (depths[index] === 0 ? char : " ")).join("")
  if (LOOSER_THAN_AND.test(topLevel)) return [condition]
  return topLevel
    .split(CONJUNCTION)
    .reduce<{ readonly terms: readonly string[]; readonly at: number }>(
      (state, part) => ({
        terms: [...state.terms, condition.slice(state.at, state.at + part.length).trim()],
        at: state.at + part.length + CONJUNCTION.length,
      }),
      { terms: [], at: 0 },
    ).terms
}

const negationsOf = (term: string): readonly string[] => [`!${term}`, `!(${term})`]

const contradicts = (left: string, right: string): boolean =>
  negationsOf(left).includes(right) || negationsOf(right).includes(left)

export const contradictsAny = (terms: readonly string[], held: readonly string[]): boolean =>
  terms.some((term) => held.some((other) => contradicts(term, other)))

/** In every deployment where `later` applies (and `held` holds), `earlier` matches first. */
export const shadows = (earlier: readonly string[], later: readonly string[], held: readonly string[]): boolean =>
  earlier.every((term) => later.includes(term) || held.includes(term))
