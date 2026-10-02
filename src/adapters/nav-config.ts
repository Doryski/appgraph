import type ts from "typescript"
import type { MenuSpec, NavFieldMap } from "../core/model.js"
import { by, sortedUnique } from "../core/order.js"
import { isNonAppFile } from "../core/project.js"
import { isInNestedPackage, nestedPackagesOf } from "../detect/project.js"
import type { Adapter, DiscoverContext, NavEntryDraft, NavGroupDraft, NavSource, TsNode } from "./types.js"
import type { StringValueReader } from "./values.js"
import { createStringValueReader } from "./values.js"
import { SCRIPT_GLOB } from "../core/extensions.js"
import { objectMembers, type ObjectMember } from "./source-utils.js"

export const NAV_CONFIG_SOURCE = "nav-config"

export const NAV_AUTO_SOURCE = "nav-auto"

const PACKAGE_GLOB = "**/package.json"

/** §10.6, in order: the first of these present on an element is its target. */
export const NAV_TARGET_FIELDS = ["path", "to", "href", "url", "route", "link"] as const

export const NAV_LABEL_FIELDS = ["title", "label", "menuLabel", "labelKey", "name", "text"] as const

export const NAV_LABEL_KEY_FIELDS = ["labelKey", "menuLabel", "i18nKey", "translationKey"] as const

export const NAV_PARENT_FIELDS = ["parentPath", "parent", "parentId"] as const

export const NAV_FLAG_FIELDS = ["featureFlag", "flag", "feature"] as const

export const NAV_ICON_FIELDS = ["icon", "iconName", "Icon"] as const

/** The section label of a CONTAINER element — one holding an array of items. */
export const NAV_SECTION_FIELDS = ["group", "groupKey", "section", "heading", "label", "title", "name"] as const

/** The section key of a FLAT element. `label`/`title` are excluded: they are the item's own name. */
export const NAV_GROUP_KEY_FIELDS = ["group", "groupKey", "section", "category"] as const

/**
 * A react-router or TanStack route object also carries a target, and every route resolves to a screen by
 * construction — so scoring alone would report the router itself as a menu. These fields are what tells
 * the two apart: a route object mounts a component, a menu item names one for a human.
 */
export const ROUTE_TABLE_FIELDS = [
  "element",
  "Component",
  "component",
  "lazy",
  "loader",
  "errorElement",
  "redirect",
  "beforeEnter",
] as const

export const AMBIGUOUS_ROUTE_FIELDS = ["action", "handle", "index"] as const

const TARGET_PROBE = /\b(?:path|to|href|url|route|link)\s*:/

const LABEL_PROBE = /\b(?:title|label|menuLabel|labelKey|name|text|icon)\s*:/

export type NavConfigOptions = {
  readonly menus?: readonly MenuSpec[]
}

type Fields = {
  readonly target: readonly string[]
  readonly label: readonly string[]
  readonly labelKey: readonly string[]
  readonly parent: readonly string[]
  readonly flag: readonly string[]
  readonly icon: readonly string[]
  readonly section: readonly string[]
  readonly groupKey: readonly string[]
}

const listOf = (...names: readonly (string | undefined)[]): readonly string[] =>
  names.filter((name): name is string => name !== undefined)

const fieldsOf = (map: NavFieldMap | undefined): Fields => {
  const labels = listOf(map?.label, map?.title)
  const keys = listOf(map?.labelKey)
  const sections = listOf(map?.group)

  return {
    target: map?.target === undefined ? NAV_TARGET_FIELDS : [map.target],
    label: labels.length > 0 ? labels : NAV_LABEL_FIELDS,
    labelKey: keys.length > 0 ? keys : NAV_LABEL_KEY_FIELDS,
    parent: map?.parent === undefined ? NAV_PARENT_FIELDS : [map.parent],
    flag: map?.flag === undefined ? NAV_FLAG_FIELDS : [map.flag],
    icon: map?.icon === undefined ? NAV_ICON_FIELDS : [map.icon],
    section: sections.length > 0 ? sections : NAV_SECTION_FIELDS,
    groupKey: sections.length > 0 ? sections : NAV_GROUP_KEY_FIELDS,
  }
}

const AUTO_FIELDS = fieldsOf(undefined)

type Reader = {
  readonly ctx: DiscoverContext
  readonly stringValue: StringValueReader
  /** An auto-discovered candidate must LOOK like a menu; a named one was already asserted to be one. */
  readonly requireMenuShape: boolean
}

const createReader = (ctx: DiscoverContext, requireMenuShape: boolean): Reader => ({
  ctx,
  stringValue: createStringValueReader(ctx),
  requireMenuShape,
})

const memberOf = (members: readonly ObjectMember[], names: readonly string[]): ObjectMember | null => {
  for (const name of names) {
    const found = members.find((member) => member.name === name)
    if (found !== undefined) return found
  }
  return null
}

const nestedItems = (
  ctx: DiscoverContext,
  members: readonly ObjectMember[],
): readonly ts.ArrayLiteralExpression[] =>
  members.flatMap((member) => {
    const array = ctx.ast.asArrayLiteral(member.value)
    if (array === null) return []
    return array.elements.some((element) => ctx.ast.asObjectLiteral(element) !== null) ? [array] : []
  })

const joinBase = (basePath: string | undefined, target: string): string =>
  basePath === undefined || basePath === "" || target.startsWith("/")
    ? target
    : `${basePath.replace(/\/$/, "")}/${target.replace(/^\//, "")}`

type Element = {
  readonly key: string | null
  readonly object: ts.ObjectLiteralExpression
}

const elementsOf = (ctx: DiscoverContext, node: TsNode): readonly Element[] => {
  const array = ctx.ast.asArrayLiteral(node)
  if (array !== null)
    return array.elements.flatMap((element) => {
      const object = ctx.ast.asObjectLiteral(element)
      return object === null ? [] : [{ key: null, object }]
    })

  const record = ctx.ast.asObjectLiteral(node)
  if (record === null) return []

  return objectMembers(ctx.ast, record).flatMap((member) => {
    const object = ctx.ast.asObjectLiteral(member.value)
    return object === null ? [] : [{ key: member.name, object }]
  })
}

type GroupInput = {
  readonly file: string
  readonly source: string
  readonly name: string
  readonly fields: Fields
  readonly spec: MenuSpec | null
  readonly auto: boolean
  readonly parentTarget?: string
}

type Labels = {
  readonly label: string | null
  readonly labelKey: string | null
}

const labelsOf = (reader: Reader, members: readonly ObjectMember[], file: string, fields: Fields): Labels => {
  const keyMember = memberOf(members, fields.labelKey)
  const labelMember = memberOf(
    members.filter((member) => member !== keyMember),
    fields.label,
  )

  const key = keyMember === null ? null : reader.stringValue(keyMember.value, file)
  const value = labelMember === null ? null : reader.stringValue(labelMember.value, file)

  // §10.6: a label field that does not flatten to a literal is an expression, not prose — it is recorded
  // as a KEY, so no report ever prints `t(...)` where a human-readable name belongs.
  const unflattened =
    labelMember !== null && value === null ? reader.ctx.ast.conditionText(labelMember.value) : null

  return { label: value, labelKey: key ?? unflattened }
}

const stringMember = (
  reader: Reader,
  members: readonly ObjectMember[],
  names: readonly string[],
  file: string,
): string | null => {
  const member = memberOf(members, names)
  return member === null ? null : reader.stringValue(member.value, file)
}

const hasNamedViews = (ctx: DiscoverContext, members: readonly ObjectMember[]): boolean => {
  const views = memberOf(members, ["components"])
  return views !== null && ctx.ast.asObjectLiteral(views.value) !== null
}

const isRouteRecord = (ctx: DiscoverContext, members: readonly ObjectMember[]): boolean =>
  memberOf(members, ROUTE_TABLE_FIELDS) !== null || hasNamedViews(ctx, members)

const isRouteShaped = (ctx: DiscoverContext, members: readonly ObjectMember[]): boolean =>
  isRouteRecord(ctx, members) || memberOf(members, AMBIGUOUS_ROUTE_FIELDS) !== null

const objectsOf = (ctx: DiscoverContext, node: TsNode): readonly (readonly ObjectMember[])[] =>
  ctx.ast.asArrayLiteral(node)?.elements.flatMap((element) => {
    const object = ctx.ast.asObjectLiteral(element)
    return object === null ? [] : [objectMembers(ctx.ast, object)]
  }) ?? []

const isRouteTree = (ctx: DiscoverContext, members: readonly ObjectMember[]): boolean => {
  if (isRouteRecord(ctx, members)) return true
  const children = memberOf(members, ["children"])
  return children !== null && isRouteTable(ctx, children.value)
}

const isRouteTable = (ctx: DiscoverContext, node: TsNode): boolean =>
  objectsOf(ctx, node).some((members) => isRouteTree(ctx, members))

const isMenuShaped = (
  ctx: DiscoverContext,
  members: readonly ObjectMember[],
  fields: Fields,
  keyed: boolean,
): boolean => {
  if (isRouteShaped(ctx, members)) return false
  return keyed || memberOf(members, fields.label) !== null || memberOf(members, fields.icon) !== null
}

const hasBasePath = (spec: MenuSpec | null): boolean => spec?.basePath !== undefined && spec.basePath !== ""

const keyTarget = (element: Element, spec: MenuSpec | null, container: boolean): string | null => {
  if (element.key === null || container) return null
  if (element.key.startsWith("/") || hasBasePath(spec)) return element.key
  return null
}

const entryOf = (reader: Reader, element: Element, input: GroupInput, container: boolean): NavEntryDraft | null => {
  const { ctx } = reader
  const { file, fields, spec } = input
  const members = objectMembers(ctx.ast, element.object)

  if (reader.requireMenuShape && !isMenuShaped(ctx, members, fields, element.key !== null)) return null

  const targetMember = memberOf(members, fields.target)
  const raw =
    targetMember === null ? keyTarget(element, spec, container) : reader.stringValue(targetMember.value, file)
  if (raw === null || raw === "" || EXTERNAL_TARGET.test(raw) || raw.startsWith("#")) return null

  const parent = stringMember(reader, members, fields.parent, file)
  const labels = labelsOf(reader, members, file, fields)

  return {
    path: ctx.normalizeUrl(joinBase(input.parentTarget ?? spec?.basePath, raw)),
    parentPath: parent === null ? null : ctx.normalizeUrl(joinBase(spec?.basePath, parent)),
    label: labels.label,
    labelKey: labels.labelKey,
    featureFlag: stringMember(reader, members, fields.flag, file),
    source: input.source,
    file,
    line: ctx.lineOf(file, targetMember?.node ?? element.object),
  }
}

type FlatEntry = {
  readonly group: string
  readonly entry: NavEntryDraft
}

const draftOf = (name: string, input: GroupInput, entries: readonly NavEntryDraft[]): NavGroupDraft => ({
  name,
  source: input.source,
  entries,
  ...(input.auto ? { auto: true as const } : {}),
})

const groupsFrom = (reader: Reader, node: TsNode, input: GroupInput): readonly NavGroupDraft[] => {
  const { ctx } = reader
  if (reader.requireMenuShape && isRouteTable(ctx, node)) return []
  const flat: FlatEntry[] = []
  const nested: NavGroupDraft[] = []

  for (const element of elementsOf(ctx, node)) {
    const members = objectMembers(ctx.ast, element.object)
    const items = nestedItems(ctx, members)
    const entry = entryOf(reader, element, input, items.length > 0)

    if (items.length === 0) {
      if (entry !== null)
        flat.push({
          group: stringMember(reader, members, input.fields.groupKey, input.file) ?? input.name,
          entry,
        })
      continue
    }

    // A grouped config: the container names the section, its array holds the items. A container that is
    // itself clickable (a group header with a path) leads the section it opens, not the flat list.
    const section =
      stringMember(reader, members, input.fields.section, input.file) ??
      element.key ??
      input.name
    const nestedInput = entry === null ? { ...input, name: section } : { ...input, name: section, parentTarget: entry.path }
    const subgroups = items.flatMap((items0) => groupsFrom(reader, items0, nestedInput))
    const [first, ...rest] = subgroups

    if (first === undefined) {
      if (entry !== null) nested.push(draftOf(section, input, [entry]))
      continue
    }
    nested.push(entry === null ? first : { ...first, entries: [entry, ...first.entries] }, ...rest)
  }

  const names = sortedUnique(flat.map((row) => row.group))
  const grouped = names.map((name) =>
    draftOf(
      name,
      input,
      flat.filter((row) => row.group === name).map((row) => row.entry),
    ),
  )

  return [...grouped, ...nested]
}

const sortGroups = (groups: readonly NavGroupDraft[]): readonly NavGroupDraft[] =>
  [...groups].sort(by((group) => `${group.source}|${group.name}`))

// ---------------------------------------------------------------------------
// The named source: file + export + field map (§5.3)
// ---------------------------------------------------------------------------

const walkOutsideRoutes = (ctx: DiscoverContext, node: TsNode, visit: (node: TsNode) => void): void => {
  const object = ctx.ast.asObjectLiteral(node)
  if (object !== null && isRouteShaped(ctx, objectMembers(ctx.ast, object))) return
  if (isRouteTable(ctx, node)) return
  visit(node)
  node.forEachChild((child) => {
    walkOutsideRoutes(ctx, child, visit)
  })
}

const configNode = (ctx: DiscoverContext, file: string, exportName: string): TsNode | null => {
  const source = ctx.sourceFile(file)
  const declaration = source === null ? null : ctx.ast.declarationOf(source, exportName)
  if (declaration === null) return null

  let found: TsNode | null = null
  declaration.forEachChild((child) => {
    const literal = ctx.ast.asArrayLiteral(child) ?? ctx.ast.asObjectLiteral(child)
    if (literal !== null) found = literal
  })
  return found
}

export const createNavConfigSource = (options: NavConfigOptions = {}): NavSource => ({
  name: NAV_CONFIG_SOURCE,
  discover: (ctx): readonly NavGroupDraft[] => {
    const reader = createReader(ctx, false)
    const groups: NavGroupDraft[] = []

    for (const spec of options.menus ?? []) {
      const source = `${spec.file}#${spec.export}`
      const node = configNode(ctx, spec.file, spec.export)

      if (node === null) {
        ctx.diagnostic({
          severity: "warning",
          code: "nav/config-unreadable",
          message: `menu config '${source}' is not an array or record of object literals this source can read`,
          file: spec.file,
        })
        continue
      }

      const found = groupsFrom(reader, node, {
        file: spec.file,
        source,
        name: spec.name ?? (spec.export === "" ? spec.file : spec.export),
        fields: fieldsOf(spec.fields),
        spec,
        auto: false,
      })

      if (found.length === 0)
        ctx.diagnostic({
          severity: "warning",
          code: "nav/config-empty",
          message: `menu config '${source}' yielded no entries: no element carries a readable target field`,
          file: spec.file,
        })

      groups.push(...found)
    }

    return sortGroups(groups)
  },
})

// ---------------------------------------------------------------------------
// Auto-discovery by scoring (§10.6). The SCORE is the KERNEL's: a nav source may not resolve screens
// (§9.1), so every candidate is emitted carrying `auto` and phase 7 drops the ones that resolve too
// poorly. A sidebar and a topbar both survive — picking one would throw away half the map.
// ---------------------------------------------------------------------------

const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

export const NAV_AUTO_SCAN_LIMITS = {
  maxBytes: 512_000,
  maxAverageLineLength: 400,
} as const

const averageLineLength = (text: string): number => text.length / (text.split("\n").length || 1)

const skipReason = (file: string, text: string, ctx: { readonly isGenerated: (relPath: string) => boolean }): string | null => {
  if (isNonAppFile(file)) return "skipped: test, mock or Storybook file"
  if (ctx.isGenerated(file)) return "skipped: generated file"
  if (text.length > NAV_AUTO_SCAN_LIMITS.maxBytes) return `skipped: larger than ${NAV_AUTO_SCAN_LIMITS.maxBytes} bytes`
  if (averageLineLength(text) > NAV_AUTO_SCAN_LIMITS.maxAverageLineLength) return "skipped: looks minified"
  return null
}

export const createNavAutoSource = (options: NavConfigOptions = {}): NavSource => ({
  name: NAV_AUTO_SOURCE,
  discover: (ctx): readonly NavGroupDraft[] => {
    const reader = createReader(ctx, true)
    const groups: NavGroupDraft[] = []
    // A config the user NAMED is already reported by `nav-config`, with that spec's field map. Scoring it
    // a second time would report the same menu twice, under a worse mapping.
    const named = new Set((options.menus ?? []).map((spec) => `${spec.file}#${spec.export}`))
    // A directory with its own package.json is another app (an extension, a docs site): its menus link
    // to ITS screens, never this root's, so it is not scored here — the same rule detection applies.
    const nestedPackages = nestedPackagesOf(ctx.glob(PACKAGE_GLOB))

    for (const file of ctx.glob(SCRIPT_GLOB)) {
      if (isInNestedPackage(file, nestedPackages)) continue
      const text = ctx.readFile(file)
      if (text === null || !TARGET_PROBE.test(text)) continue
      if (!LABEL_PROBE.test(text)) {
        ctx.nearMiss(file, "object literals carry a target field but no label or icon field")
        continue
      }
      const skipped = skipReason(file, text, ctx)
      if (skipped !== null) {
        ctx.nearMiss(file, skipped)
        continue
      }

      const source = ctx.sourceFile(file)
      if (source === null) {
        ctx.nearMiss(file, "file carries a menu-shaped literal but did not parse")
        continue
      }

      // One candidate per declaration, OUTERMOST literal first: a nested `items: [...]` array is reached
      // by recursion, and claiming it again on its own would double-count every entry it holds.
      const claimed = new Set<string>()

      walkOutsideRoutes(ctx, source, (node) => {
        const literal = ctx.ast.asArrayLiteral(node) ?? ctx.ast.asObjectLiteral(node)
        if (literal === null) return

        const declared = ctx.locatorOf(literal).export
        if (declared === "" || claimed.has(declared) || named.has(`${file}#${declared}`)) return

        const found = groupsFrom(reader, literal, {
          file,
          source: `${file}#${declared}`,
          name: declared,
          fields: AUTO_FIELDS,
          spec: null,
          auto: true,
        })
        if (found.length === 0) return

        claimed.add(declared)
        groups.push(...found)
      })
    }

    return sortGroups(groups)
  },
})

export const createNavAdapter = (options: NavConfigOptions = {}): Adapter => ({
  name: "nav",
  nav: [createNavConfigSource(options), createNavAutoSource(options)],
})
