import type { Activation, AncestorRef, SlotBranch } from "../core/model.js"
import { sortBy, sortStrings } from "../core/order.js"
import { convertNextAppPath } from "../core/url.js"
import type {
  DetectResult,
  DiscoverContext,
  EntryContext,
  ProjectContext,
  ScreenDraft,
  ScreenShape,
  ScreenSource,
} from "./types.js"
import { isFileEntry } from "./types.js"
import { conventionChain, isGroupSegment, joinDir, partsOf as filePartsOf, type FileParts } from "./file-routes.js"
import {
  findConventionFile,
  hasNextDependency,
  isPresent,
  memoPerRun,
  NEXT_APP_CONVENTION,
} from "./next-conventions.js"

const NAME = "next-app"

const PAGE_GLOB = "**/app/**/page.{tsx,jsx,ts,js}"
const ROUTE_GLOB = "**/app/**/route.{ts,js}"
const SLOT_GLOB = "**/app/**/@*/**/{page,default}.{tsx,jsx,ts,js}"

/** `(.)`, `(..)`, `(..)(..)`, `(...)` — Next's intercepting-route markers, followed by the segment they intercept. */
const MARKER_RE = /^(\(\.\.\.\)|(?:\(\.\.\))+|\(\.\))(.+)$/
const ROOT_MARKER = "(...)"
const SAME_LEVEL_MARKER = "(.)"
const CLIMB_MARKER_LENGTH = "(..)".length

type Marker = { readonly text: string; readonly rest: string; readonly climbs: number }

const climbsOf = (text: string): number => {
  if (text === ROOT_MARKER) return Number.POSITIVE_INFINITY
  return text === SAME_LEVEL_MARKER ? 0 : text.length / CLIMB_MARKER_LENGTH
}

const markerOf = (segment: string): Marker | null => {
  const match = MARKER_RE.exec(segment)
  const text = match?.[1]
  const rest = match?.[2]
  if (text === undefined || rest === undefined) return null
  return { text, rest, climbs: climbsOf(text) }
}

const isSlotSegment = (segment: string): boolean => segment.startsWith("@")

const slotNameOf = (segment: string): string => segment.slice(1)

const routedSegments = (segments: readonly string[]): readonly string[] =>
  segments.filter((segment) => !isSlotSegment(segment) && !isGroupSegment(segment))

/** The canonical URL of a directory chain below `app`, `@slot` segments dropped. */
const urlOfSegments = (segments: readonly string[]): string =>
  convertNextAppPath(["app", ...segments.filter((segment) => !isSlotSegment(segment)), "page"].join("/")).url

/** A URL with its param names erased: `(.)replays/[sessionId]` intercepts `replays/[replayId]`. */
const shapeOf = (url: string): string => url.replace(/:[^/]+/g, ":")

const partsOf = (file: string): FileParts => filePartsOf(file, NEXT_APP_CONVENTION.root)

const lastSlotIndex = (dirs: readonly string[]): number =>
  dirs.reduce((found, segment, index) => (isSlotSegment(segment) ? index : found), -1)

const isPlainFile = (file: string): boolean =>
  !partsOf(file).dirs.some((segment) => isSlotSegment(segment) || markerOf(segment) !== null)

type Intercept = {
  readonly file: string
  readonly marker: string
  readonly slot: string | null
  readonly layoutDir: string | null
  readonly from: string
  /** `null` = the marker climbs above `app`. */
  readonly target: string | null
}

const baseOf = (level: readonly string[], climbs: number): readonly string[] | null => {
  if (climbs === Number.POSITIVE_INFINITY) return []
  return climbs > level.length ? null : level.slice(0, level.length - climbs)
}

const interceptOf = (file: string): Intercept | null => {
  const { rootPrefix, dirs } = partsOf(file)
  const markerIndex = dirs.findIndex((segment) => markerOf(segment) !== null)
  const marker = markerOf(dirs[markerIndex] ?? "")
  if (marker === null) return null

  const levelDirs = dirs.slice(0, markerIndex)
  const slotAt = lastSlotIndex(levelDirs)
  const level = routedSegments(levelDirs)
  const base = baseOf(level, marker.climbs)

  return {
    file,
    marker: marker.text,
    slot: slotAt === -1 ? null : slotNameOf(levelDirs[slotAt] ?? ""),
    layoutDir: slotAt === -1 ? null : joinDir(rootPrefix, levelDirs.slice(0, slotAt)),
    from: urlOfSegments(level),
    target: base === null ? null : urlOfSegments([...base, marker.rest, ...dirs.slice(markerIndex + 1)]),
  }
}

type SlotFile = {
  readonly file: string
  readonly slot: string
  readonly layoutDir: string
  readonly isDefault: boolean
  readonly url: string
}

const slotFileOf = (file: string): SlotFile | null => {
  const { rootPrefix, dirs, name } = partsOf(file)
  const slotAt = lastSlotIndex(dirs)
  if (slotAt === -1) return null

  const isDefault = name.startsWith("default.")
  if (isDefault && slotAt !== dirs.length - 1) return null

  return {
    file,
    slot: slotNameOf(dirs[slotAt] ?? ""),
    layoutDir: joinDir(rootPrefix, dirs.slice(0, slotAt)),
    isDefault,
    url: urlOfSegments(dirs),
  }
}

type SlotIndex = { readonly slotFiles: readonly SlotFile[]; readonly intercepts: readonly Intercept[] }

const slotIndexFrom = (files: readonly string[]): SlotIndex => {
  const intercepts = files.map(interceptOf).filter(isPresent)
  const interceptFiles = new Set(intercepts.map((intercept) => intercept.file))
  return {
    slotFiles: files.filter((file) => !interceptFiles.has(file)).map(slotFileOf).filter(isPresent),
    intercepts: intercepts.filter((intercept) => intercept.slot !== null),
  }
}

/** One slot-index glob per run, shared by discovery and the ancestor walk. */
const slotIndexOf = memoPerRun((ctx: Pick<DiscoverContext, "glob" | "isGenerated" | "strings">) =>
  slotIndexFrom(ctx.glob(SLOT_GLOB).filter((file) => !ctx.isGenerated(file))),
)

const detectNextApp = (ctx: ProjectContext): DetectResult => {
  if (!hasNextDependency(ctx)) return { score: 0, evidence: [] }

  const pages = ctx.glob(PAGE_GLOB)
  const first = pages[0]
  if (first === undefined) return { score: 0, evidence: [] }

  return {
    score: 100,
    evidence: [{ what: "next.js dependency with an app-router page.tsx", file: first, line: 1 }],
  }
}

type Candidate = { readonly file: string; readonly isRoute: boolean; readonly url: string }

type PageTarget = Pick<Candidate, "file" | "url">

type InterceptOutcome =
  | { readonly kind: "above-app"; readonly intercept: Intercept }
  | { readonly kind: "missing"; readonly intercept: Intercept; readonly target: string }
  | { readonly kind: "matched"; readonly intercept: Intercept; readonly targetFile: string }

const soleOf = <T>(values: readonly T[]): T | null => (values.length === 1 ? (values[0] ?? null) : null)

const targetPageOf = (target: string, pages: readonly PageTarget[]): PageTarget | null =>
  pages.find((page) => page.url === target) ??
  soleOf(pages.filter((page) => shapeOf(page.url) === shapeOf(target)))

const outcomeOf = (intercept: Intercept, pages: readonly PageTarget[]): InterceptOutcome => {
  if (intercept.target === null) return { kind: "above-app", intercept }
  const page = targetPageOf(intercept.target, pages)
  if (page === null) return { kind: "missing", intercept, target: intercept.target }
  return { kind: "matched", intercept, targetFile: page.file }
}

const reportIntercept = (ctx: DiscoverContext, outcome: InterceptOutcome): void => {
  const { intercept } = outcome
  if (outcome.kind === "above-app") {
    ctx.diagnostic({
      severity: "warning",
      code: "screens/unsupported-next-convention",
      message: `Next.js intercepting marker '${intercept.marker}' in '${intercept.file}' climbs above the app directory; no screen gets the intercept activation`,
      file: intercept.file,
    })
    return
  }
  if (outcome.kind === "missing") {
    ctx.diagnostic({
      severity: "warning",
      code: "screens/unsupported-next-convention",
      message: `Next.js intercepting route '${intercept.file}' targets '${outcome.target}', but no single page has that shape; no screen gets the intercept activation`,
      file: intercept.file,
    })
    return
  }
  if (intercept.slot !== null) return
  ctx.diagnostic({
    severity: "info",
    code: "screens/unsupported-next-convention",
    message: `Next.js intercepting route '${intercept.file}' is outside any @slot; its target gets the intercept activation, but the intercepting page joins no tree`,
    file: intercept.file,
  })
}

const isMatchedSlotPage = (slotFile: SlotFile, pages: readonly PageTarget[]): boolean =>
  pages.some(
    (page) => page.file.startsWith(`${slotFile.layoutDir}/`) && shapeOf(page.url) === shapeOf(slotFile.url),
  )

const reportUnmatchedSlotPage = (ctx: DiscoverContext, slotFile: SlotFile): void =>
  ctx.diagnostic({
    severity: "info",
    code: "screens/unsupported-next-convention",
    message: `Next.js slot page '${slotFile.file}' matches no page below '${slotFile.layoutDir}'; it joins no tree`,
    file: slotFile.file,
  })

type SlotDir = { readonly layoutDir: string; readonly slot: string; readonly file: string }

const slotDirsOf = (index: SlotIndex): readonly SlotDir[] => {
  const all = [
    ...index.slotFiles,
    ...index.intercepts.flatMap((intercept) =>
      intercept.slot === null || intercept.layoutDir === null
        ? []
        : [{ layoutDir: intercept.layoutDir, slot: intercept.slot, file: intercept.file }],
    ),
  ]
  const firstByDir = new Map<string, SlotDir>()
  for (const entry of sortBy(all, (item) => item.file)) {
    const key = `${entry.layoutDir}/@${entry.slot}`
    if (!firstByDir.has(key)) firstByDir.set(key, { layoutDir: entry.layoutDir, slot: entry.slot, file: entry.file })
  }
  return sortBy([...firstByDir.values()], (entry) => `${entry.layoutDir}/@${entry.slot}`)
}

const reportLayoutlessSlot = (ctx: DiscoverContext, slotDir: SlotDir): void =>
  ctx.diagnostic({
    severity: "info",
    code: "screens/unsupported-next-convention",
    message: `Next.js slot '@${slotDir.slot}' in '${slotDir.layoutDir}' has no layout.* beside it to render it; its pages join no tree`,
    file: slotDir.file,
  })

const reportSlots = (ctx: DiscoverContext, index: SlotIndex, pages: readonly PageTarget[]): void => {
  for (const slotFile of index.slotFiles) {
    if (!slotFile.isDefault && !isMatchedSlotPage(slotFile, pages)) reportUnmatchedSlotPage(ctx, slotFile)
  }
  for (const slotDir of slotDirsOf(index)) {
    if (findConventionFile(ctx, slotDir.layoutDir, "layout") === null) reportLayoutlessSlot(ctx, slotDir)
  }
}

const interceptActivation = (intercept: Intercept): Activation => ({
  kind: "intercept",
  from: intercept.from,
  slot: intercept.slot,
  file: intercept.file,
})

const draftOf = (ctx: DiscoverContext, candidate: Candidate, intercepts: readonly Intercept[]): ScreenDraft => {
  const conversion = convertNextAppPath(candidate.file)
  return {
    localId: ctx.localId(candidate.file),
    activations: [
      {
        kind: "url",
        template: conversion.url,
        params: conversion.extras.params.map((param) => param.name),
      },
      ...intercepts.map(interceptActivation),
    ],
    entries: [{ kind: "file", file: candidate.file, exportName: "default" }],
    evidence: [
      ctx.evidence(candidate.isRoute ? "next.js route handler" : "next.js page", candidate.file),
      ...intercepts.map((intercept) => ctx.evidence(`intercepted from ${intercept.from}`, intercept.file)),
    ],
    ...(candidate.isRoute ? { kindTag: "apiRoute" } : {}),
  }
}

const interceptsByTarget = (outcomes: readonly InterceptOutcome[]): ReadonlyMap<string, readonly Intercept[]> => {
  const byTarget = new Map<string, Intercept[]>()
  for (const outcome of outcomes) {
    if (outcome.kind !== "matched") continue
    byTarget.set(outcome.targetFile, [...(byTarget.get(outcome.targetFile) ?? []), outcome.intercept])
  }
  return byTarget
}

const sourceFilesOf = (ctx: Pick<ProjectContext, "glob" | "isGenerated">, pattern: string): readonly string[] =>
  ctx.glob(pattern).filter((file) => !ctx.isGenerated(file))

const candidatesOf = (pageFiles: readonly string[], routeFiles: readonly string[]): readonly Candidate[] =>
  sortBy<Candidate>(
    [
      ...pageFiles.filter(isPlainFile).map((file) => ({ file, isRoute: false })),
      ...routeFiles.filter(isPlainFile).map((file) => ({ file, isRoute: true })),
    ]
      .filter((candidate) => convertNextAppPath(candidate.file).extras.privateFolders.length === 0)
      .map((candidate) => ({ ...candidate, url: convertNextAppPath(candidate.file).url })),
    (candidate) => candidate.file,
  )

/** URL → first App Router page file claiming it, matched exactly as discovery matches pages. */
export const nextAppPageUrls = (ctx: Pick<ProjectContext, "glob" | "isGenerated">): ReadonlyMap<string, string> => {
  const byUrl = new Map<string, string>()
  for (const candidate of candidatesOf(sourceFilesOf(ctx, PAGE_GLOB), [])) {
    if (!byUrl.has(candidate.url)) byUrl.set(candidate.url, candidate.file)
  }
  return byUrl
}

const discoverNextApp = (ctx: DiscoverContext): readonly ScreenDraft[] => {
  if (!hasNextDependency(ctx)) return []
  const pageFiles = sourceFilesOf(ctx, PAGE_GLOB)
  const candidates = candidatesOf(pageFiles, sourceFilesOf(ctx, ROUTE_GLOB))
  const pages = candidates.filter((candidate) => !candidate.isRoute)

  const outcomes = sortBy(pageFiles.map(interceptOf).filter(isPresent), (intercept) => intercept.file).map(
    (intercept) => outcomeOf(intercept, pages),
  )
  for (const outcome of outcomes) reportIntercept(ctx, outcome)
  reportSlots(ctx, slotIndexOf(ctx), pages)

  const byTarget = interceptsByTarget(outcomes)
  return candidates.map((candidate) => draftOf(ctx, candidate, byTarget.get(candidate.file) ?? []))
}

const slotBranch = (file: string, slot: string, conditions: readonly string[]): SlotBranch => ({
  file,
  exportName: "default",
  splice: { kind: "slot", name: slot },
  conditions,
})

const interceptFilesOf = (screen: ScreenShape): ReadonlySet<string> =>
  new Set(screen.activations.flatMap((activation) => (activation.kind === "intercept" ? [activation.file] : [])))

/**
 * Per slot of the layout in `dir`: the slot page matching the screen's remainder below the layout,
 * else the slot's `default.*`, plus every intercepting page of that slot whose target is this screen.
 */
const branchesAt = (index: SlotIndex, dir: string, screen: ScreenShape): readonly SlotBranch[] => {
  if (screen.url === null) return []
  const shape = shapeOf(screen.url)
  const interceptFiles = interceptFilesOf(screen)
  const slotFiles = index.slotFiles.filter((slotFile) => slotFile.layoutDir === dir)
  const intercepts = index.intercepts.filter(
    (intercept) => intercept.layoutDir === dir && interceptFiles.has(intercept.file),
  )
  const slots = sortStrings(
    new Set([...slotFiles.map((slotFile) => slotFile.slot), ...intercepts.flatMap((intercept) => intercept.slot ?? [])]),
  )

  return slots.flatMap((slot) => {
    const own = slotFiles.filter((slotFile) => slotFile.slot === slot)
    const page =
      own.find((slotFile) => !slotFile.isDefault && shapeOf(slotFile.url) === shape) ??
      own.find((slotFile) => slotFile.isDefault)
    return [
      ...(page === undefined ? [] : [slotBranch(page.file, slot, [`slot ${slot}`])]),
      ...intercepts
        .filter((intercept) => intercept.slot === slot)
        .map((intercept) => slotBranch(intercept.file, slot, [`slot ${slot}`, `intercepted from ${intercept.from}`])),
    ]
  })
}

const ancestorsOfNextApp = (screen: ScreenShape, ctx: EntryContext): readonly AncestorRef[] => {
  if (screen.kindTag === "apiRoute") return []

  const fileEntry = screen.entries.find(isFileEntry)
  if (fileEntry === undefined) return []

  const index = slotIndexOf(ctx)
  return conventionChain(ctx, fileEntry.file, NEXT_APP_CONVENTION, [
    { base: "layout", role: "layout", branchesAt: (dir) => branchesAt(index, dir, screen) },
    { base: "template", role: "transparent" },
  ])
}

export const nextAppSource: ScreenSource = {
  name: NAME,
  detect: detectNextApp,
  discover: discoverNextApp,
  ancestorsOf: ancestorsOfNextApp,
}
