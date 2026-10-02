import type { DiagnosticCollector } from "../diagnostics.js"
import type { Navigation, ScreenId } from "../model.js"
import { uniqueBy } from "../order.js"
import { createRouteMatcher, expoHrefToUrl, normalizeUrl } from "../url.js"
import { MAX_REDIRECT_HOPS } from "./constants.js"
import type { MergedDraft } from "./conflicts.js"
import { conditionTerms } from "./redirect-conditions.js"
import type { RedirectHop, RedirectPath, ResolvedTarget } from "./redirects.js"
import {
  UNRESOLVED_TARGET,
  allConditional,
  applicableHops,
  createRedirectStep,
  redirectResolutionOf,
  viaRedirectOf,
  withAlternatives,
} from "./redirects.js"
import { routeNameTable, targetsByRouteName, unknownRouteNameTarget } from "./route-names.js"
import { hasRequiredCatchAllEntry, urlActivationOf } from "./screens.js"
import type { BuildGraphInput } from "./types.js"

const GROUP_SEGMENT = /\/\([^/()]+\)(?=\/|$)/
const GROUP_NAME_SEGMENT = /^\([^/()]+\)$/

const nameSegments = (name: string): readonly string[] => name.split("/")

const groupsOf = (name: string): readonly string[] =>
  nameSegments(name).filter((segment) => GROUP_NAME_SEGMENT.test(segment))

const groupFreePathOf = (name: string): string =>
  nameSegments(name)
    .filter((segment) => !GROUP_NAME_SEGMENT.test(segment))
    .join("/")

const containsInOrder = (outer: readonly string[], inner: readonly string[]): boolean =>
  outer.reduce((matched, group) => (group === inner[matched] ? matched + 1 : matched), 0) === inner.length

const groupedNameFor = (names: readonly string[], href: string): string | null => {
  const path = groupFreePathOf(href)
  const groups = groupsOf(href)
  const candidates = names.filter((name) => groupFreePathOf(name) === path && containsInOrder(groupsOf(name), groups))
  return candidates.length === 1 ? (candidates[0] ?? null) : null
}

const urlTemplatesOf = (draft: MergedDraft): readonly string[] =>
  draft.activations.flatMap((activation) => (activation.kind === "url" ? [normalizeUrl(activation.template)] : []))

const addressableOf = (primary: boolean) => (draft: MergedDraft) => {
  const templates = urlTemplatesOf(draft)
  const urls = primary ? templates.slice(0, 1) : templates.slice(1)
  return urls.map((url) => ({ url, id: draft.id, catchAllOptional: !hasRequiredCatchAllEntry(draft, url) }))
}

const HOST_REWRITE_SOURCE = "next-app"
const HOSTNAME_SEGMENT = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i

const isLiteralSegment = (segment: string): boolean => !segment.startsWith(":") && !segment.startsWith("*")

const hostlessUrlOf = (url: string): string | null => {
  const [, first = "", ...rest] = url.split("/")
  if (!HOSTNAME_SEGMENT.test(first)) return null
  const [next] = rest
  return next === undefined || next === "" || isLiteralSegment(next) ? normalizeUrl(`/${rest.join("/")}`) : null
}

/**
 * A Next.js app that serves several hosts keeps one folder per hostname (`app/app.acme.com/…`) and
 * has middleware rewrite `/settings` on that host to `/app.acme.com/settings`. Its links are written
 * host-relative, so they match the screen only with the hostname segment taken off. The alias ranks
 * after every real URL: it never shadows a screen that owns the same path. A path that opens with a
 * param gets no alias: `/:program/:group` would swallow every two-segment link of every other host.
 */
const hostAliasesOf = (draft: MergedDraft) => {
  if (draft.source !== HOST_REWRITE_SOURCE) return []
  return urlTemplatesOf(draft).flatMap((url) => {
    const alias = hostlessUrlOf(url)
    return alias === null ? [] : [{ url: alias, id: draft.id, catchAllOptional: !hasRequiredCatchAllEntry(draft, url) }]
  })
}

export const createTargetResolver = (
  drafts: readonly MergedDraft[],
  input: Pick<BuildGraphInput, "redirectRules">,
  diagnostics: DiagnosticCollector,
) => {
  const addressableUrls = uniqueBy(
    [...drafts.flatMap(addressableOf(true)), ...drafts.flatMap(addressableOf(false)), ...drafts.flatMap(hostAliasesOf)],
    (entry) => entry.url,
  )

  const matchRoute = createRouteMatcher(addressableUrls)
  const screenByPattern = new Map(addressableUrls.map((entry) => [entry.url, entry.id]))
  function matchScreen(url: string): ScreenId | null {
    const matched = matchRoute(normalizeUrl(url))
    return matched === null ? null : (screenByPattern.get(matched) ?? null)
  }

  const redirectStep = createRedirectStep(input.redirectRules ?? [])

  function takeHop(path: RedirectPath, hop: RedirectHop): ResolvedTarget {
    const next = hop.to
    if (next === null || path.seen.has(next)) return UNRESOLVED_TARGET
    const taken: RedirectPath = {
      origin: path.origin,
      seen: new Set([...path.seen, next]),
      held: [...new Set([...path.held, ...conditionTerms(hop.rule.condition)])],
      first: path.first ?? hop.rule,
    }
    const screen = matchScreen(next)
    if (screen !== null) return { screen, viaRedirect: redirectResolutionOf(taken, next, hop.rule) }
    return followRedirects(taken, next)
  }

  /**
   * Tries the rules that can apply to `current` in declaration order and keeps the first chain that
   * reaches a screen: when a conditional rule leads nowhere, a rule for another deployment may still
   * resolve the link, and its `condition` travels on the resolution.
   */
  function firstResolved(path: RedirectPath, hops: readonly RedirectHop[]): ResolvedTarget {
    for (const hop of hops) {
      const target = takeHop(path, hop)
      if (target.screen !== null) return target
    }
    return UNRESOLVED_TARGET
  }

  function followRedirects(path: RedirectPath, current: string): ResolvedTarget {
    if (path.seen.size > MAX_REDIRECT_HOPS) return UNRESOLVED_TARGET
    const hops = applicableHops(redirectStep(current), path.held)
    if (!allConditional(hops)) return firstResolved(path, hops)
    return withAlternatives(hops.map((hop) => takeHop(path, hop)).filter((target) => target.screen !== null))
  }

  const targetCache = new Map<string, ResolvedTarget>()

  /** A direct match first; otherwise the screen the redirect rules lead to, recording the redirect. */
  function resolveTarget(url: string): ResolvedTarget {
    const cached = targetCache.get(url)
    if (cached !== undefined) return cached
    const direct = matchScreen(url)
    const origin = normalizeUrl(url)
    const resolved =
      direct === null
        ? followRedirects({ origin, seen: new Set([origin]), held: [], first: null }, origin)
        : { screen: direct, viaRedirect: null }
    targetCache.set(url, resolved)
    return resolved
  }

  function targetFields(url: string) {
    const target = resolveTarget(url)
    return { matchedRoute: target.screen, ...viaRedirectOf(target) }
  }

  const routeNames = routeNameTable(drafts, diagnostics)

  function namedTarget(routeName: string) {
    const named = routeNames.get(routeName)
    if (named === undefined) return { to: unknownRouteNameTarget(routeName), matchedRoute: null }
    const url = urlActivationOf(named.activations)
    if (url === null) return { to: named.id, matchedRoute: named.id }
    const to = normalizeUrl(url.template)
    return { to, ...targetFields(to) }
  }

  const resolvesByName = (navigation: Navigation): navigation is Navigation & { readonly routeName: string } =>
    targetsByRouteName(navigation) || (navigation.routeName !== undefined && routeNames.has(navigation.routeName))

  const groupedNames = [...routeNames.keys()].filter((name) => groupsOf(name).length > 0)

  function groupedRouteNameOf(routeName: string | null): string | null {
    if (routeName === null) return null
    return routeNames.has(routeName) ? routeName : groupedNameFor(groupedNames, routeName)
  }

  function groupQualifiedTarget(to: string) {
    const { url, routeName } = expoHrefToUrl(to)
    const named = groupedRouteNameOf(routeName)
    if (named !== null) return namedTarget(named)
    return { to: url, ...targetFields(url) }
  }

  function navigationTarget(navigation: Navigation) {
    if (resolvesByName(navigation)) return namedTarget(navigation.routeName)
    const direct = { to: navigation.to, ...targetFields(navigation.to) }
    if (direct.matchedRoute !== null || groupedNames.length === 0 || !GROUP_SEGMENT.test(navigation.to)) return direct
    const grouped = groupQualifiedTarget(navigation.to)
    return grouped.matchedRoute === null ? direct : grouped
  }

  return { resolveTarget, navigationTarget, routeNames }
}
