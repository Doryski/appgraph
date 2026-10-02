import { SCRIPT_FILE, stripSourceExtension } from "../core/extensions.js"
import { sortBy, sortedUnique, thenBy, by } from "../core/order.js"
import { splitPlatform } from "../core/platform.js"
import { convertExpoRoutePath, type ExpoRouteOptions } from "../core/url.js"
import { isGroupSegment } from "./file-routes.js"

export const EXPO_KIND_TAGS = { apiRoute: "apiRoute", notFound: "notFound" } as const

export type ExpoKindTag = (typeof EXPO_KIND_TAGS)[keyof typeof EXPO_KIND_TAGS]

export const EXPO_ISSUE_KINDS = [
  "orphan-platform-variant",
  "route-conflict",
  "shadowed-not-found",
  "shared-route",
] as const

export type ExpoIssueKind = (typeof EXPO_ISSUE_KINDS)[number]

export type ExpoRouteEntry = { readonly file: string; readonly platform: string | null }

export type ExpoRouteName = { readonly name: string; readonly navigator: string }

export type ExpoScreenPlan = {
  readonly file: string
  readonly url: string | null
  readonly params: readonly string[]
  readonly routes: readonly ExpoRouteName[]
  readonly entries: readonly ExpoRouteEntry[]
  readonly kindTag: ExpoKindTag | null
}

export type ExpoLayoutPlan = {
  readonly file: string
  readonly dir: string
  readonly navigator: string
  readonly entries: readonly ExpoRouteEntry[]
}

export type ExpoRouteIssue = {
  readonly kind: ExpoIssueKind
  readonly file: string
  readonly message: string
  readonly related: readonly string[]
}

export type ExpoRoutePlan = {
  readonly screens: readonly ExpoScreenPlan[]
  readonly layouts: readonly ExpoLayoutPlan[]
  readonly issues: readonly ExpoRouteIssue[]
}

const LAYOUT_NAME = "_layout"

const NOT_FOUND_NAME = "+not-found"

const API_SUFFIX = "+api"

const SKIPPED_NAMES: ReadonlySet<string> = new Set(["+html", "+native-intent", "+middleware", "_sitemap"])

type Role = "layout" | "route" | "skip"

type VariantGroup = {
  readonly base: string
  readonly entries: readonly ExpoRouteEntry[]
  readonly hasBase: boolean
}

type Candidate = {
  readonly file: string
  readonly url: string
  readonly shape: string
  readonly params: readonly string[]
  readonly routeNames: readonly string[]
  readonly groupPath: string
  readonly entries: readonly ExpoRouteEntry[]
  readonly kindTag: ExpoKindTag | null
}

type Resolution = {
  readonly owners: readonly Candidate[]
  readonly routeOnly: readonly Candidate[]
  readonly issues: readonly ExpoRouteIssue[]
}

const leafOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

const dirOf = (path: string): string => {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? "" : path.slice(0, slash)
}

const stemOf = (base: string): string => stripSourceExtension(leafOf(base))

const roleOf = (base: string): Role => {
  const stem = stemOf(base)
  if (stem === LAYOUT_NAME) return "layout"
  if (SKIPPED_NAMES.has(stem)) return "skip"
  return "route"
}

const kindTagOf = (base: string): ExpoKindTag | null => {
  const stem = stemOf(base)
  if (stem === NOT_FOUND_NAME) return EXPO_KIND_TAGS.notFound
  if (stem.endsWith(API_SUFFIX)) return EXPO_KIND_TAGS.apiRoute
  return null
}

const shapeOf = (url: string): string => url.replace(/:[^/]+/g, ":")

const groupPathOf = (file: string): string => dirOf(file).split("/").filter(isGroupSegment).join("/")

const variantGroupsOf = (files: readonly string[], platforms: readonly string[]): readonly VariantGroup[] => {
  const byBase = new Map<string, ExpoRouteEntry[]>()
  for (const file of files) {
    const { base, platform } = splitPlatform(file, platforms)
    byBase.set(base, [...(byBase.get(base) ?? []), { file, platform }])
  }
  return sortBy(
    [...byBase].map(([base, entries]) => ({
      base,
      entries: sortBy(entries, (entry) => (entry.platform === null ? "" : entry.file)),
      hasBase: entries.some((entry) => entry.platform === null),
    })),
    (group) => group.base,
  )
}

const orphanUseOf = (group: VariantGroup): string =>
  roleOf(group.base) === "layout" ? "it is used as the layout" : "it still maps to a screen"

const orphanIssuesOf = (group: VariantGroup): readonly ExpoRouteIssue[] =>
  group.hasBase
    ? []
    : group.entries.map((entry) => ({
        kind: "orphan-platform-variant",
        file: entry.file,
        message: `Expo Router platform variant '${entry.file}' has no base file '${group.base}'; ${orphanUseOf(group)}`,
        related: [],
      }))

const firstFileOf = (group: VariantGroup): string => group.entries[0]?.file ?? group.base

const routeDirsOf = (routeName: string): readonly string[] => {
  const segments = routeName.split("/").slice(0, -1)
  return segments.map((_, index) => segments.slice(0, segments.length - index).join("/")).concat("")
}

const layoutDirIndex = (layouts: readonly ExpoLayoutPlan[], options: ExpoRouteOptions): ReadonlyMap<string, string> =>
  new Map(
    layouts.flatMap((layout) =>
      convertExpoRoutePath(layout.file, options).routeNames.map((name) => [dirOf(name), layout.dir] as const),
    ),
  )

const navigatorOf = (layoutDirs: ReadonlyMap<string, string>, routeName: string): string =>
  routeDirsOf(routeName)
    .map((dir) => layoutDirs.get(dir))
    .find((dir) => dir !== undefined) ?? ""

const candidateOf = (group: VariantGroup, options: ExpoRouteOptions): Candidate => {
  const conversion = convertExpoRoutePath(group.base, options)
  return {
    file: firstFileOf(group),
    url: conversion.url,
    shape: shapeOf(conversion.url),
    params: conversion.params.map((param) => param.name),
    routeNames: sortedUnique(conversion.routeNames),
    groupPath: groupPathOf(group.base),
    entries: group.entries,
    kindTag: kindTagOf(group.base),
  }
}

type Ranked = Pick<Candidate, "file" | "routeNames">

const firstRouteNameOf = (candidate: Ranked): string => candidate.routeNames[0] ?? candidate.file

const sharedRouteOrder = thenBy<Ranked>(
  by(firstRouteNameOf),
  by((candidate) => candidate.file),
)

export const sharedRouteWinner = <T extends Ranked>(candidates: readonly T[]): T | null =>
  [...candidates].sort(sharedRouteOrder)[0] ?? null

const conflictIssue = (loser: Candidate, winner: Candidate, reason: string): ExpoRouteIssue => ({
  kind: "route-conflict",
  file: loser.file,
  message: `Expo Router ${reason} '${loser.file}' conflicts with '${winner.file}' on '${loser.url}'; '${winner.file}' wins`,
  related: [winner.file],
})

const sharedIssue = (loser: Candidate, owner: Candidate): ExpoRouteIssue => ({
  kind: "shared-route",
  file: loser.file,
  message: `Expo Router shared route '${loser.file}' matches '${loser.url}', which '${owner.file}' owns on a cold link; it is addressable by route name only`,
  related: [owner.file],
})

const shadowedNotFoundIssue = (notFound: Candidate, owner: Candidate): ExpoRouteIssue => ({
  kind: "shadowed-not-found",
  file: notFound.file,
  message: `Expo Router '${notFound.file}' shares '${notFound.url}' with the explicit route '${owner.file}', which handles every unmatched path there; '${notFound.file}' never renders for a URL and is dropped`,
  related: [owner.file],
})

const partitionBy = <T>(values: readonly T[], key: (value: T) => string): readonly (readonly T[])[] => {
  const groups = new Map<string, T[]>()
  for (const value of values) groups.set(key(value), [...(groups.get(key(value)) ?? []), value])
  return sortBy([...groups], ([name]) => name).map(([, members]) => members)
}

const firstByFile = (candidates: readonly Candidate[]): readonly Candidate[] => sortBy(candidates, (candidate) => candidate.file)

const resolveSameSpecificity = (candidates: readonly Candidate[]): Resolution => {
  const [winner, ...losers] = firstByFile(candidates)
  if (winner === undefined) return { owners: [], routeOnly: [], issues: [] }
  return {
    owners: [winner],
    routeOnly: [],
    issues: losers.map((loser) => conflictIssue(loser, winner, "route")),
  }
}

const resolveShared = (candidates: readonly Candidate[]): Resolution => {
  const owner = sharedRouteWinner(candidates)
  if (owner === null) return { owners: [], routeOnly: [], issues: [] }
  const losers = [...candidates].sort(sharedRouteOrder).filter((candidate) => candidate !== owner)
  return { owners: [owner], routeOnly: losers, issues: losers.map((loser) => sharedIssue(loser, owner)) }
}

const mergeResolutions = (resolutions: readonly Resolution[]): Resolution => ({
  owners: resolutions.flatMap((resolution) => resolution.owners),
  routeOnly: resolutions.flatMap((resolution) => resolution.routeOnly),
  issues: resolutions.flatMap((resolution) => resolution.issues),
})

const resolvePages = (candidates: readonly Candidate[]): Resolution => {
  const bySpecificity = partitionBy(candidates, (candidate) => candidate.groupPath).map(resolveSameSpecificity)
  const merged = mergeResolutions(bySpecificity)
  const shared = resolveShared(merged.owners)
  return { ...shared, issues: [...merged.issues, ...shared.issues] }
}

type Tier = {
  readonly matches: (candidate: Candidate) => boolean
  readonly loses: (loser: Candidate, owner: Candidate) => ExpoRouteIssue
}

const RESOLUTION_TIERS: readonly Tier[] = [
  { matches: (candidate) => candidate.kindTag === null, loses: (loser, owner) => conflictIssue(loser, owner, "route") },
  { matches: (candidate) => candidate.kindTag === EXPO_KIND_TAGS.notFound, loses: shadowedNotFoundIssue },
  {
    matches: (candidate) => candidate.kindTag === EXPO_KIND_TAGS.apiRoute,
    loses: (loser, owner) => conflictIssue(loser, owner, "API route"),
  },
]

const resolveShape = (candidates: readonly Candidate[]): Resolution => {
  const tiers = RESOLUTION_TIERS.map((tier) => ({ tier, members: candidates.filter(tier.matches) })).filter(
    (entry) => entry.members.length > 0,
  )
  const [top, ...lower] = tiers
  if (top === undefined) return { owners: [], routeOnly: [], issues: [] }
  const resolved = resolvePages(top.members)
  const owner = resolved.owners[0]
  if (owner === undefined) return resolved
  const lowerIssues = lower.flatMap((entry) => entry.members.map((loser) => entry.tier.loses(loser, owner)))
  return { ...resolved, issues: [...resolved.issues, ...lowerIssues] }
}

const screenOf = (candidate: Candidate, owns: boolean, layoutDirs: ReadonlyMap<string, string>): ExpoScreenPlan => ({
  file: candidate.file,
  url: owns ? candidate.url : null,
  params: owns ? candidate.params : [],
  routes: candidate.routeNames.map((name) => ({ name, navigator: navigatorOf(layoutDirs, name) })),
  entries: candidate.entries,
  kindTag: candidate.kindTag,
})

const layoutOf = (group: VariantGroup): ExpoLayoutPlan => ({
  file: firstFileOf(group),
  dir: dirOf(group.base),
  navigator: dirOf(group.base),
  entries: group.entries,
})

const issueOrder = thenBy<ExpoRouteIssue>(
  by((issue) => issue.file),
  by((issue) => issue.kind),
)

export const planExpoRoutes = (files: readonly string[], options: ExpoRouteOptions): ExpoRoutePlan => {
  const groups = variantGroupsOf(
    files.filter((file) => SCRIPT_FILE.test(file)),
    options.platforms,
  )
  const routeGroups = groups.filter((group) => roleOf(group.base) === "route")
  const layouts = groups.filter((group) => roleOf(group.base) === "layout").map(layoutOf)
  const layoutDirs = layoutDirIndex(layouts, options)
  const candidates = routeGroups.map((group) => candidateOf(group, options))
  const resolution = mergeResolutions(partitionBy(candidates, (candidate) => candidate.shape).map(resolveShape))
  const screens = [
    ...resolution.owners.map((candidate) => screenOf(candidate, true, layoutDirs)),
    ...resolution.routeOnly.map((candidate) => screenOf(candidate, false, layoutDirs)),
  ]
  return {
    screens: sortBy(screens, (screen) => screen.file),
    layouts: sortBy(layouts, (layout) => layout.file),
    issues: [...groups.flatMap(orphanIssuesOf), ...resolution.issues].sort(issueOrder),
  }
}
