import type { DiagnosticInput } from "../core/diagnostics.js"
import type { AncestorRef, AncestorRole, SlotBranch } from "../core/model.js"
import { NEXT_DEFAULT_PAGE_EXTENSIONS, NEXT_PAGES_ROOTS } from "../core/url.js"
import { createValueResolver } from "./array-values.js"
import { configFileOf, createConfigFileReader, type LiteralStringArray } from "./config-file.js"
import {
  ancestorAt as fileRouteAncestorAt,
  findConventionFile as findFileRouteConventionFile,
  type FileRouteConvention,
} from "./file-routes.js"
import { NEXT_CONFIG_FILES } from "./next-config.js"
import type { DiscoverContext, FileEntryRef, ProjectContext } from "./types.js"

/**
 * File conventions the Next.js App and Pages Router sources share: the default page extensions, the
 * `layout.*`/`_app.*` probe, the page entry behind a re-export, the active `pages/` root and the
 * project's `pageExtensions`.
 */

export { NEXT_DEFAULT_PAGE_EXTENSIONS }

const PAGE_EXTENSIONS_MEMBER = "pageExtensions"

export const isPresent = <T>(value: T | null): value is T => value !== null

/** One computation per run: the run's string table is the per-run identity every phase shares. */
export const memoPerRun = <C extends Pick<DiscoverContext, "strings">, T>(compute: (ctx: C) => T) => {
  const cache = new WeakMap<object, { readonly value: T }>()
  return (ctx: C): T => {
    const cached = cache.get(ctx.strings)
    if (cached !== undefined) return cached.value
    const value = compute(ctx)
    cache.set(ctx.strings, { value })
    return value
  }
}

export const NEXT_APP_CONVENTION: FileRouteConvention = {
  root: { kind: "segment", name: "app" },
  extensions: NEXT_DEFAULT_PAGE_EXTENSIONS,
}

export const hasNextDependency = (ctx: Pick<ProjectContext, "hasDependency">): boolean => ctx.hasDependency("next")

export const findConventionFile = (
  ctx: Pick<ProjectContext, "exists">,
  dir: string,
  base: string,
  extensions: readonly string[] = NEXT_DEFAULT_PAGE_EXTENSIONS,
): string | null => findFileRouteConventionFile(ctx, dir, base, extensions)

export const ancestorAt = (
  ctx: Pick<ProjectContext, "exists">,
  dir: string,
  base: string,
  role: AncestorRole,
  branches: readonly SlotBranch[],
): AncestorRef | null => fileRouteAncestorAt(ctx, dir, base, { role, extensions: NEXT_DEFAULT_PAGE_EXTENSIONS, branches })

/** The page's default export followed through re-exports (`export { default } from "@/features/…"`). */
export const pageEntryOf = (ctx: DiscoverContext, file: string): FileEntryRef => {
  const declared = ctx.declaredExport(file, "default")
  if (ctx.sourceFile(declared.file) === null) return { kind: "file", file, exportName: "default" }
  return { kind: "file", file: declared.file, exportName: declared.exportName }
}

/** A convention read plus the diagnostics it owes; the caller reports them once per run. */
export type ConventionRead<T> = { readonly value: T; readonly notices: readonly DiagnosticInput[] }

const hasFiles = (ctx: Pick<ProjectContext, "glob">, root: string): boolean => ctx.glob(`${root}/**/*`).length > 0

/** Next reads `pages/` and ignores `src/pages/` once a root `pages/` exists. */
export const pagesRootsIn = (ctx: Pick<ProjectContext, "glob">): ConventionRead<string | null> => {
  const present = NEXT_PAGES_ROOTS.filter((root) => hasFiles(ctx, root))
  const [root = null, ...ignored] = present
  return {
    value: root,
    notices: ignored.map((dir) => ({
      severity: "info",
      code: "screens/unsupported-next-convention",
      message: `Next.js reads '${root ?? ""}/' and ignores '${dir}/' when both exist; no screen comes from '${dir}/'`,
      file: dir,
    })),
  }
}

export const nextPagesRootOf = memoPerRun((ctx: DiscoverContext) => pagesRootsIn(ctx))

const isScriptExtension = (extension: string): boolean =>
  NEXT_DEFAULT_PAGE_EXTENSIONS.some((script) => extension === script || extension.endsWith(`.${script}`))

const normalizedExtensions = (values: readonly string[]): readonly string[] =>
  values.map((value) => value.replace(/^\./, "")).filter(isScriptExtension)

const configArraysOf = (ctx: DiscoverContext, configFile: string): readonly LiteralStringArray[] => {
  const source = ctx.sourceFile(configFile)
  const reader = createConfigFileReader(ctx, createValueResolver(ctx))
  const exported = source === null ? null : reader.exportedOf(source)
  if (exported === null) return []
  return reader
    .uniqueObjects(reader.configObjectsOf(exported, configFile, 0))
    .flatMap((object) => {
      const literal = ctx.ast.asObjectLiteral(object.node)
      return literal === null ? [] : [reader.literalStringArray(literal, PAGE_EXTENSIONS_MEMBER)]
    })
}

const literalKey = (values: readonly string[]): string => values.join("\u0000")

const DEFAULT_EXTENSIONS_READ: ConventionRead<readonly string[]> = { value: NEXT_DEFAULT_PAGE_EXTENSIONS, notices: [] }

const dynamicExtensionsRead = (
  ctx: DiscoverContext,
  configFile: string,
  array: LiteralStringArray,
): ConventionRead<readonly string[]> => ({
  value: NEXT_DEFAULT_PAGE_EXTENSIONS,
  notices: [
    {
      severity: "info",
      code: "screens/dynamic-registry",
      message: `'${PAGE_EXTENSIONS_MEMBER}' in ${configFile} is not one literal string array; the Next.js default (${NEXT_DEFAULT_PAGE_EXTENSIONS.join(", ")}) is used`,
      file: configFile,
      ...(array.kind === "dynamic" ? { line: ctx.lineOf(configFile, array.node) } : {}),
    },
  ],
})

/** `pageExtensions` from a literal in `next.config`, script extensions only; anything else falls back to the default. */
export const nextPageExtensions = memoPerRun((ctx: DiscoverContext): ConventionRead<readonly string[]> => {
  const configFile = configFileOf(ctx, NEXT_CONFIG_FILES)
  if (configFile === null) return DEFAULT_EXTENSIONS_READ
  const arrays = configArraysOf(ctx, configFile).filter((array) => array.kind !== "absent")
  const dynamic = arrays.find((array) => array.kind === "dynamic")
  const literals = arrays.flatMap((array) => (array.kind === "literal" ? [array.values] : []))
  const distinct = new Set(literals.map(literalKey))
  const [only] = literals
  if (dynamic !== undefined || distinct.size > 1) return dynamicExtensionsRead(ctx, configFile, dynamic ?? arrays[0] ?? { kind: "absent" })
  if (only === undefined) return DEFAULT_EXTENSIONS_READ
  return { value: normalizedExtensions(only), notices: [] }
})
