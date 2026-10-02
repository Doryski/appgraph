import type { GraphRedirect, RedirectAlternative, RedirectResolution, RedirectRule, ScreenId } from "../model.js"
import { by, thenBy, uniqueBy } from "../order.js"
import type { RedirectPathConversion } from "../url.js"
import { convertNextRedirectPath, normalizeUrl } from "../url.js"
import { CONJUNCTION, conditionTerms, contradictsAny, shadows } from "./redirect-conditions.js"

type RulePiece =
  | { readonly kind: "literal"; readonly value: string }
  | {
      readonly kind: "param" | "rest"
      readonly name: string
      readonly optional: boolean
    }

type CompiledRule = {
  readonly rule: RedirectRule
  readonly pieces: readonly RulePiece[]
}

/** A rule that matches a URL and where it sends it (`null` = off-site or unreadable destination). */
export type RedirectHop = {
  readonly rule: RedirectRule
  readonly to: string | null
}

type RedirectStep = (url: string) => readonly RedirectHop[]

const urlParts = (url: string): readonly string[] => url.split("/").filter((part) => part !== "")

const piecesOf = (conversion: RedirectPathConversion): readonly RulePiece[] => {
  const params = [...conversion.extras.params]
  return urlParts(conversion.url).map((segment): RulePiece => {
    if (!segment.startsWith(":") && segment !== "*") return { kind: "literal", value: segment }
    const param = params.shift()
    return {
      kind: param?.catchAll === true ? "rest" : "param",
      name: param?.name ?? "",
      optional: param?.optional ?? false,
    }
  })
}

/** Every segment a param and one of them a catch-all: the rule matches (nearly) any URL, like `/*`. */
const swallowsEverything = (pieces: readonly RulePiece[]): boolean =>
  pieces.every((piece) => piece.kind !== "literal") && pieces.some((piece) => piece.kind === "rest")

const compileRule = (rule: RedirectRule): readonly CompiledRule[] => {
  if (rule.conditional) return []
  const conversion = convertNextRedirectPath(rule.source)
  if (conversion === null) return []
  const pieces = piecesOf(conversion)
  return swallowsEverything(pieces) ? [] : [{ rule, pieces }]
}

const bindPieces = (
  pieces: readonly RulePiece[],
  parts: readonly string[],
): Readonly<Record<string, string>> | null => {
  const [head, ...rest] = pieces
  if (head === undefined) return parts.length === 0 ? {} : null
  if (head.kind === "literal") return parts[0] === head.value ? bindPieces(rest, parts.slice(1)) : null
  const most = head.kind === "rest" ? parts.length : Math.min(1, parts.length)
  const least = head.optional ? 0 : 1
  for (let take = most; take >= least; take -= 1) {
    const bound = bindPieces(rest, parts.slice(take))
    if (bound !== null) return { ...bound, [head.name]: parts.slice(0, take).join("/") }
  }
  return null
}

const DESTINATION_PARAM = /:([A-Za-z0-9_]+)(?:[*+]|\?(?=\/|$))?/g

const substituteDestination = (
  destination: string,
  params: Readonly<Record<string, string>>,
): string | null => {
  if (!destination.startsWith("/")) return null
  return normalizeUrl(destination.replace(DESTINATION_PARAM, (whole, name: string) => params[name] ?? whole))
}

/**
 * One redirect step: every eligible rule that matches, in declaration order (config rules, then the
 * discovered ones as read). Which of them applies is decided by `applicableHops`.
 */
export const createRedirectStep = (rules: readonly RedirectRule[]): RedirectStep => {
  const compiled = rules.flatMap(compileRule)
  return (url) => {
    const parts = urlParts(url)
    return compiled.flatMap(({ rule, pieces }) => {
      const params = bindPieces(pieces, parts)
      return params === null ? [] : [{ rule, to: substituteDestination(rule.destination, params) }]
    })
  }
}

/**
 * The matching rules that can apply given the branch conditions `held` so far: a rule contradicting
 * them belongs to another deployment, and a rule that an earlier possible match always beats never
 * applies. The rest are tried in declaration order.
 */
export const applicableHops = (hops: readonly RedirectHop[], held: readonly string[]): readonly RedirectHop[] =>
  hops
    .map((hop) => ({ hop, terms: conditionTerms(hop.rule.condition) }))
    .filter(({ terms }) => !contradictsAny(terms, held))
    .filter(({ terms }, index, possible) =>
      possible.slice(0, index).every((earlier) => !shadows(earlier.terms, terms, held)),
    )
    .map(({ hop }) => hop)

/** A redirect chain in progress: where it started, the URLs seen, the conditions held, the first rule. */
export type RedirectPath = {
  readonly origin: string
  readonly seen: ReadonlySet<string>
  readonly held: readonly string[]
  readonly first: RedirectRule | null
}

export const redirectResolutionOf = (path: RedirectPath, to: string, rule: RedirectRule): RedirectResolution => ({
  from: path.origin,
  to,
  declaredAt: (path.first ?? rule).declaredAt,
  ...(path.held.length === 0 ? {} : { condition: path.held.join(CONJUNCTION) }),
})

export const graphRedirectOf = (rule: RedirectRule): GraphRedirect => ({
  from: rule.source,
  to: rule.destination,
  declaredAt: rule.declaredAt,
  ...(rule.condition === null ? {} : { condition: rule.condition }),
  ...(rule.conditional ? { conditional: true as const } : {}),
})

export const graphRedirectKey = (redirect: GraphRedirect): string =>
  `${redirect.from}|${redirect.to}|${redirect.declaredAt ?? ""}|${redirect.condition ?? ""}|${String(redirect.conditional ?? false)}`

export const graphRedirectOrder = thenBy<GraphRedirect>(
  by((redirect) => `${redirect.from}|${redirect.to}`),
  by((redirect) => redirect.declaredAt ?? ""),
  by((redirect) => redirect.condition ?? ""),
  by((redirect) => String(redirect.conditional ?? false)),
)

export type ResolvedTarget = {
  readonly screen: ScreenId | null
  readonly viaRedirect: RedirectResolution | null
}

export const UNRESOLVED_TARGET: ResolvedTarget = { screen: null, viaRedirect: null }

export const viaRedirectOf = (target: ResolvedTarget) =>
  target.viaRedirect === null ? {} : { viaRedirect: target.viaRedirect }

export const allConditional = (hops: readonly RedirectHop[]): boolean =>
  hops.length > 1 && hops.every((hop) => hop.rule.condition !== null)

const alternativesOf = ({ viaRedirect: via }: ResolvedTarget): readonly RedirectAlternative[] => {
  if (via === null) return []
  if (via.alternatives !== undefined) return via.alternatives
  return via.condition === undefined ? [] : [{ to: via.to, condition: via.condition }]
}

const alternativeKey = (alternative: RedirectAlternative): string => `${alternative.to}|${alternative.condition}`

export const withAlternatives = (resolved: readonly ResolvedTarget[]): ResolvedTarget => {
  const [primary] = resolved
  if (primary === undefined) return UNRESOLVED_TARGET
  if (primary.viaRedirect === null) return primary
  const alternatives = uniqueBy(resolved.flatMap(alternativesOf), alternativeKey)
  if (alternatives.length < 2) return primary
  return { screen: primary.screen, viaRedirect: { ...primary.viaRedirect, alternatives } }
}
