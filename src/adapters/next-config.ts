import type ts from "typescript"
import type { RedirectRule } from "../core/model.js"
import { by, thenBy } from "../core/order.js"
import { convertNextRedirectPath } from "../core/url.js"
import type { ArrayElement, ArrayFold, Located, UnreadableItem, ValueResolver } from "./array-values.js"
import { configFileOf, createConfigFileReader } from "./config-file.js"
import { createArrayFolder, createValueResolver } from "./array-values.js"
import type { Adapter, DiscoverContext, RedirectSource } from "./types.js"

/**
 * Reads the static `redirects()` table of the project's root `next.config`. It runs whatever the screen
 * source is (a TanStack app can still ship a Next config), never evaluates the config, and counts every
 * entry it cannot read instead of guessing it.
 */

export const NEXT_CONFIG_SOURCE = "next-config"

export const NEXT_CONFIG_FILES = ["next.config.ts", "next.config.mts", "next.config.js", "next.config.mjs"] as const

export const UNREADABLE_SITE_LIMIT = 5

const REDIRECTS_MEMBER = "redirects"

const CONDITIONAL_FIELDS = ["has", "missing"] as const

type RuleRead = { readonly rule: RedirectRule } | { readonly unreadable: UnreadableItem }

const siteOf = (item: UnreadableItem): string => `${item.file}:${String(item.line)}`

const siteOrder = thenBy<UnreadableItem>(
  by((item) => item.file),
  (a, b) => a.line - b.line,
)

export const unreadableMessage = (configFile: string, items: readonly UnreadableItem[]): string => {
  const sites = [...items].sort(siteOrder).map(siteOf)
  const listed = sites.slice(0, UNREADABLE_SITE_LIMIT).join(", ")
  const rest = sites.length - UNREADABLE_SITE_LIMIT
  const more = rest > 0 ? ` and ${String(rest)} more` : ""
  return `${String(items.length)} redirect entr${items.length === 1 ? "y" : "ies"} in ${configFile} could not be read statically and never resolve a link: ${listed}${more}.`
}

const createReader = (ctx: DiscoverContext) => {
  const resolver: ValueResolver = createValueResolver(ctx)
  const foldArray = createArrayFolder(ctx, resolver)
  const { exportedOf, configObjectsOf, memberNamed, literalField, uniqueObjects } = createConfigFileReader(ctx, resolver)

  const redirectsFunctionOf = (member: ts.ObjectLiteralElementLike, file: string): Located | null => {
    if (ctx.ts.isMethodDeclaration(member)) return { node: member, file }
    if (ctx.ts.isPropertyAssignment(member)) return resolver.functionOf(member.initializer, file)
    if (ctx.ts.isShorthandPropertyAssignment(member)) return resolver.functionOf(member.name, file)
    return null
  }

  const readRedirects = (object: Located): ArrayFold | null => {
    const literal = ctx.ast.asObjectLiteral(object.node)
    const member = literal === null ? null : memberNamed(literal, REDIRECTS_MEMBER)
    if (member === null) return null
    const fn = redirectsFunctionOf(member, object.file)
    const returned = fn === null ? null : resolver.returnedBy(fn.node)
    if (fn === null || returned === null) return { elements: [], unreadable: [resolver.unreadableAt(member, object.file)] }
    return foldArray(returned, fn.file)
  }

  const ruleOf = (element: ArrayElement): RuleRead => {
    const unreadable = { unreadable: resolver.unreadableAt(element.node, element.file) }
    const object = ctx.ast.asObjectLiteral(element.node)
    if (object === null) return unreadable
    const source = literalField(object, "source")
    const destination = literalField(object, "destination")
    if (source === null || destination === null || convertNextRedirectPath(source) === null) return unreadable
    return {
      rule: {
        source,
        destination,
        declaredAt: `${element.file}:${String(ctx.lineOf(element.file, object))}`,
        condition: element.conditions.length === 0 ? null : element.conditions.join(" && "),
        conditional: CONDITIONAL_FIELDS.some((field) => memberNamed(object, field) !== null),
      },
    }
  }

  return (): readonly RedirectRule[] => {
    const configFile = configFileOf(ctx, NEXT_CONFIG_FILES)
    const source = configFile === null ? null : ctx.sourceFile(configFile)
    if (configFile === null || source === null) return []
    const exported = exportedOf(source)
    if (exported === null) return []

    const folds = uniqueObjects(configObjectsOf(exported, configFile, 0)).flatMap(
      (object) => readRedirects(object) ?? [],
    )
    const reads = folds.flatMap((fold) => fold.elements.map(ruleOf))
    const unreadable = [
      ...folds.flatMap((fold) => fold.unreadable),
      ...reads.flatMap((read) => ("unreadable" in read ? [read.unreadable] : [])),
    ]

    if (unreadable.length > 0)
      ctx.diagnostic({
        severity: "warning",
        code: "nav/redirect-unreadable",
        message: unreadableMessage(configFile, unreadable),
        file: configFile,
      })

    return reads.flatMap((read) => ("rule" in read ? [read.rule] : []))
  }
}

export const nextConfigRedirectSource: RedirectSource = {
  name: NEXT_CONFIG_SOURCE,
  discover: (ctx) => createReader(ctx)(),
}

export const nextConfigAdapter: Adapter = {
  name: NEXT_CONFIG_SOURCE,
  redirects: [nextConfigRedirectSource],
}
