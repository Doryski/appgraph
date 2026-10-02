import type { AncestorRef, AncestorRole, SlotBranch, SpliceMode } from "../core/model.js"
import type { ProjectContext } from "./types.js"

export type RootLocator =
  | { readonly kind: "dir"; readonly dir: string }
  | { readonly kind: "segment"; readonly name: string }

export type FileRouteConvention = { readonly root: RootLocator; readonly extensions: readonly string[] }

export type FileParts = {
  readonly rootPrefix: readonly string[]
  readonly dirs: readonly string[]
  readonly name: string
}

export type AncestorOptions = {
  readonly role: AncestorRole
  readonly extensions: readonly string[]
  readonly splice?: SpliceMode
  readonly branches?: readonly SlotBranch[]
}

export type ConventionLevel = {
  readonly base: string
  readonly role: AncestorRole
  readonly splice?: SpliceMode
  readonly branchesAt?: (dir: string) => readonly SlotBranch[]
}

type ExistsContext = Pick<ProjectContext, "exists">

const CHILDREN_SPLICE: SpliceMode = { kind: "children" }

const GROUP_SEPARATOR = ","

const startsWithAll = (segments: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= segments.length && prefix.every((segment, index) => segments[index] === segment)

const dirRootIndex = (dirSegments: readonly string[], dir: string): number => {
  const prefix = dir.split("/").filter((segment) => segment !== "")
  return startsWithAll(dirSegments, prefix) ? prefix.length - 1 : -1
}

export const rootIndexOf = (dirSegments: readonly string[], root: RootLocator): number =>
  root.kind === "dir" ? dirRootIndex(dirSegments, root.dir) : dirSegments.indexOf(root.name)

export const joinDir = (prefix: readonly string[], rest: readonly string[]): string => [...prefix, ...rest].join("/")

export const partsOf = (file: string, root: RootLocator): FileParts => {
  const segments = file.split("/")
  const dirSegments = segments.slice(0, -1)
  const rootIndex = rootIndexOf(dirSegments, root)
  return {
    rootPrefix: dirSegments.slice(0, rootIndex + 1),
    dirs: dirSegments.slice(rootIndex + 1),
    name: segments[segments.length - 1] ?? "",
  }
}

export const isGroupSegment = (segment: string): boolean => segment.startsWith("(") && segment.endsWith(")")

export const groupNamesOf = (segment: string): readonly string[] => {
  if (!isGroupSegment(segment)) return []
  return segment
    .slice(1, -1)
    .split(GROUP_SEPARATOR)
    .map((name) => name.trim())
    .filter((name) => name !== "")
}

export const routeDirsFor = (file: string, root: RootLocator): readonly string[] => {
  const dirSegments = file.split("/").slice(0, -1)
  const start = Math.max(rootIndexOf(dirSegments, root), 0)
  return dirSegments.slice(start).map((_, index) => dirSegments.slice(0, start + index + 1).join("/"))
}

export const findConventionFile = (
  ctx: ExistsContext,
  dir: string,
  base: string,
  extensions: readonly string[],
): string | null => {
  for (const extension of extensions) {
    const candidate = `${dir}/${base}.${extension}`
    if (ctx.exists(candidate)) return candidate
  }
  return null
}

export const ancestorAt = (ctx: ExistsContext, dir: string, base: string, options: AncestorOptions): AncestorRef | null => {
  const file = findConventionFile(ctx, dir, base, options.extensions)
  if (file === null) return null
  const branches = options.branches ?? []
  return {
    file,
    exportName: "default",
    splice: options.splice ?? CHILDREN_SPLICE,
    role: options.role,
    ...(branches.length > 0 ? { branches } : {}),
  }
}

const levelAncestorAt = (
  ctx: ExistsContext,
  dir: string,
  level: ConventionLevel,
  extensions: readonly string[],
): AncestorRef | null =>
  ancestorAt(ctx, dir, level.base, {
    role: level.role,
    extensions,
    ...(level.splice === undefined ? {} : { splice: level.splice }),
    ...(level.branchesAt === undefined ? {} : { branches: level.branchesAt(dir) }),
  })

export const conventionChain = (
  ctx: ExistsContext,
  file: string,
  convention: FileRouteConvention,
  levels: readonly ConventionLevel[],
): readonly AncestorRef[] =>
  routeDirsFor(file, convention.root).flatMap((dir) =>
    levels.flatMap((level) => levelAncestorAt(ctx, dir, level, convention.extensions) ?? []),
  )
