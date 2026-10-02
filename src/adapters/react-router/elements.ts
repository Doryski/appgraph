import { condense, isComponentTag } from "../../core/ast.js"
import type { AncestorRef, Evidence, SpliceMode } from "../../core/model.js"
import { uniqueBy } from "../../core/order.js"
import type { EntryRef, TsNode } from "../types.js"
import { CHILDREN_SPLICE, NO_LAYOUTS } from "./constants.js"
import type { ItemScopeApi } from "./item-scope.js"
import type { ComponentRef, ElementInfo, GuardAuth, ItemScope, PropEntry, TagUse } from "./model.js"
import { entryKey, layoutAncestor } from "./model.js"
import type { ResolveApi } from "./resolve.js"
import type { DiscoveryState } from "./state.js"
import { ANCESTOR_ROLES, matchesRule, within } from "./wrappers.js"
import type ts from "typescript"

export const createElements = (deps: DiscoveryState & ResolveApi & ItemScopeApi) => {
  const { ctx, rules, flags, report, reportedEntries, memberValue, lastChild, rootFlavourOf, looseFlavourOf, isFunctionLike, fileOfTag, itemReadOf, itemValue, attributeOf, entryOf, attributeValue, receivesItem, guardAuth, attributeName } = deps

  /** The attribute handing a guard the item's `entryFrom` member; the whole item wins over a lone member. */
  const propEntryOf = (
    element: ts.JsxOpeningLikeElement | null,
    tag: string,
    entryFrom: string,
    scope: ItemScope | null,
  ): PropEntry | null => {
    if (element === null || scope === null) return null
    const handed = element.attributes.properties.flatMap((attribute): readonly PropEntry[] => {
      const name = attributeName(attribute)
      const read = itemReadOf(attributeValue(attribute), scope)
      if (name === null || read === null || (read.member !== null && read.member !== entryFrom)) return []
      const value = memberValue(read.scope.item, entryFrom)?.value
      return value === undefined ? [] : [{ element, tag, attribute: name, whole: read.member === null, value, file: read.scope.file }]
    })
    return handed.find((entry) => entry.whole) ?? handed[0] ?? null
  }

  const propEntryName = (entry: PropEntry): string | null => ctx.ast.asIdentifier(ctx.unwrap(entry.value))?.text ?? null

  const propEntryEvidence = (entry: PropEntry | null, file: string): Evidence | null => {
    const name = entry === null ? null : propEntryName(entry)
    if (entry === null || name === null) return null
    const what = `page component '${name}' from <${entry.tag} ${entry.attribute}={…}> (via ${entry.attribute} prop)`
    return ctx.evidence(what, file, entry.element)
  }

  const propEntryRef = (entry: PropEntry): EntryRef => {
    const name = propEntryName(entry)
    if (name !== null) return entryOf(entry.file, name)
    return { kind: "opaque", expr: condense(entry.value.getText()), file: entry.file, line: ctx.lineOf(entry.file, entry.value) }
  }

  /** A component declared as a function, or as the first argument of a wrapper call (`memo(…)`). */
  const componentFunction = (target: ComponentRef): (ts.SignatureDeclaration & { readonly body?: ts.Node }) | null => {
    const source = ctx.sourceFile(target.file)
    const declared = source === null ? null : ctx.ast.declarationOf(source, target.exportName)
    if (declared === null) return null
    if (isFunctionLike(declared)) return declared
    const initializer = lastChild(declared)
    const value = initializer === null ? null : ctx.unwrap(initializer)
    if (value === null || isFunctionLike(value)) return value
    const wrapped = ctx.ast.asCallExpression(value)?.arguments[0]
    const inner = wrapped === undefined ? null : ctx.unwrap(wrapped)
    return inner !== null && isFunctionLike(inner) ? inner : null
  }

  /** `({ route }) => <route.component/>`, `(props) => <props.route.component/>`, `({ route: { component: Page } })`. */
  const renderedTagsOf = (parameter: ts.ParameterDeclaration, entry: PropEntry, entryFrom: string): readonly string[] => {
    const suffix = entry.whole ? `.${entryFrom}` : ""
    const named = ctx.ast.asIdentifier(parameter.name)
    if (named !== null) return [`${named.text}.${entry.attribute}${suffix}`]
    if (!ctx.ts.isObjectBindingPattern(parameter.name)) return []
    const bound = parameter.name.elements.find(
      (element) => ctx.ast.asIdentifier(element.propertyName ?? element.name)?.text === entry.attribute,
    )
    if (bound === undefined) return []
    const local = ctx.ast.asIdentifier(bound.name)
    if (local !== null) return [`${local.text}${suffix}`]
    if (!entry.whole || !ctx.ts.isObjectBindingPattern(bound.name)) return []
    const inner = bound.name.elements.find(
      (element) => ctx.ast.asIdentifier(element.propertyName ?? element.name)?.text === entryFrom,
    )
    const page = inner === undefined ? null : ctx.ast.asIdentifier(inner.name)
    return page === null ? [] : [page.text]
  }

  /** Where the guard renders the handed component, or `null` when this source cannot find that site. */
  const renderSiteOf = (target: ComponentRef | null, entry: PropEntry, entryFrom: string): SpliceMode | null => {
    const fn = target === null ? null : componentFunction(target)
    const parameter = fn?.parameters[0]
    if (fn?.body === undefined || parameter === undefined) return null
    const tags = renderedTagsOf(parameter, entry, entryFrom)
    const rendered = ctx.ast
      .jsxElementsIn(fn.body)
      .find((element) => tags.includes(condense(element.tagName.getText())))
    if (rendered === undefined) return null
    const node = ctx.ts.isJsxOpeningElement(rendered) ? rendered.parent : rendered
    return { kind: "at", locator: ctx.locatorOf(node) }
  }

  const reportUnrenderedEntry = (entry: PropEntry, target: ComponentRef | null, from: string, entryFrom: string): void => {
    if (flags.dryRun || flags.echo || reportedEntries.has(entry.element)) return
    reportedEntries.add(entry.element)
    const where = target === null ? "an unresolved file" : `'${target.file}'`
    report({
      severity: "info",
      code: "screens/entry-from-unresolved",
      message: `guard <${entry.tag}> (${where}) is handed the route item's '${entryFrom}' through '${entry.attribute}', but no render site of it was found in the guard; the handed component is not taken as the page, and the element's own children stay the entries`,
      file: from,
      line: ctx.lineOf(from, entry.element),
    })
  }

  const analyzeTags = (
    uses: readonly TagUse[],
    file: string,
    scope: ItemScope | null,
    layouts: ReadonlySet<TsNode> = NO_LAYOUTS,
  ): ElementInfo => {
    let redirectTo: string | null = null
    let routeName: string | null = null
    let auth: GuardAuth | null = null
    let itemGuard: ts.JsxOpeningLikeElement | null = null
    let featureFlag: string | null = null
    let title: string | null = null
    const wrappers: AncestorRef[] = []
    const entries: EntryRef[] = []
    const entryAncestors: AncestorRef[] = []
    let propEntry: PropEntry | null = null

    for (const { tag, element, from } of uses) {
      if (!isComponentTag(tag)) continue

      const binding = ctx.bindingsFor(from).get(tag)
      const rule = rules.find((candidate) => matchesRule(candidate, tag, binding)) ?? null

      if (rule === null) {
        const target = fileOfTag(from, tag)
        if (target !== null && element !== null && layouts.has(element)) {
          wrappers.push(layoutAncestor(target))
          continue
        }
        entries.push(entryOf(from, tag))
        if (target !== null)
          entryAncestors.push(layoutAncestor(target))
        continue
      }

      const attribute = element === null ? null : attributeOf(element, rule.reads, file, scope)

      if (rule.role === "redirect") {
        if (attribute !== null) redirectTo = ctx.normalizeUrl(attribute)
        continue
      }
      if (rule.role === "transparent") continue

      const perItem = rule.role === "guard" && receivesItem(element, scope)
      if (rule.role === "guard") auth = guardAuth(auth, perItem)
      if (perItem) itemGuard = itemGuard ?? element
      if (rule.role === "guard") featureFlag = featureFlag ?? attribute
      if (rule.role === "errorBoundary") routeName = routeName ?? attribute
      if (rule.role === "layout") title = title ?? attribute

      const role = ANCESTOR_ROLES[rule.role]
      const target = role === null ? null : fileOfTag(from, tag)
      const entryFrom = rule.role === "guard" ? rule.entryFrom : undefined
      const offered = entryFrom === undefined ? null : propEntryOf(element, tag, entryFrom, scope)
      const site = offered === null || entryFrom === undefined ? null : renderSiteOf(target, offered, entryFrom)
      const handed = site === null ? null : offered
      if (offered !== null && handed === null && entryFrom !== undefined)
        reportUnrenderedEntry(offered, target, from, entryFrom)
      if (handed !== null) {
        entries.push(propEntryRef(handed))
        const name = propEntryName(handed)
        const page = name === null ? null : fileOfTag(handed.file, name)
        if (page !== null) entryAncestors.push(layoutAncestor(page))
        propEntry = propEntry ?? handed
      }

      if (target !== null && role !== null) wrappers.push({ ...target, splice: site ?? CHILDREN_SPLICE, role })
    }

    return { redirectTo, routeName, auth, itemGuard, featureFlag, title, wrappers, entries, entryAncestors, propEntry }
  }

  type TagRead = { readonly kind: "use"; readonly use: TagUse } | { readonly kind: "opaque"; readonly entry: EntryRef }

  /** `<route.component/>` or a destructured `<Page/>` names whatever component the mapped item holds. */
  const tagOf = (element: ts.JsxOpeningLikeElement, file: string, scope: ItemScope | null): TagRead | null => {
    const tag = ctx.ast.tagName(element)
    if (tag === null) return null
    const item = itemValue(element.tagName, scope)
    if (item === null) return { kind: "use", use: { tag, element, from: file } }

    const named = item.value === undefined ? null : ctx.ast.asIdentifier(item.value)
    if (named !== null) return { kind: "use", use: { tag: named.text, element, from: item.file } }
    return {
      kind: "opaque",
      entry: { kind: "opaque", expr: condense(element.tagName.getText()), file, line: ctx.lineOf(file, element) },
    }
  }

  /** A loose route inside `node` (wouter) is a descendant route, not part of what `node` renders itself. */
  const looseBoundaryOf = (element: ts.JsxOpeningLikeElement, node: TsNode, file: string): readonly TsNode[] => {
    if (looseFlavourOf(file, element) === null) return []
    const boundary = ctx.ts.isJsxOpeningElement(element) ? element.parent : element
    return boundary === node ? [] : [boundary]
  }

  /**
   * The JSX a route's element renders ITSELF. An inline `<Routes>`/`<Switch>` and everything inside it belong to
   * its descendant routes, so their guards and wrappers must not be read as this route's own.
   */
  const ownElements = (node: TsNode, file: string): readonly ts.JsxOpeningLikeElement[] => {
    const elements = ctx.ast.jsxElementsIn(node)
    const boundaries = elements.flatMap((element) =>
      ctx.ts.isJsxOpeningElement(element) && rootFlavourOf(file, element) !== null
        ? [element.parent]
        : looseBoundaryOf(element, node, file),
    )
    return elements.filter((element) => !boundaries.some((boundary) => within(element, boundary)))
  }

  /** The tags whose JSX element encloses `inner`: with a prop entry they frame the page rather than being it. */
  const enclosingTags = (uses: readonly TagUse[], inner: ts.JsxOpeningLikeElement): ReadonlySet<TsNode> =>
    new Set(
      uses.flatMap(({ element }) =>
        element !== null && ctx.ts.isJsxOpeningElement(element) && within(inner, element.parent) ? [element] : [],
      ),
    )

  const analyzeElement = (node: TsNode, file: string, scope: ItemScope | null): ElementInfo => {
    const reads = ownElements(node, file).flatMap((element) => {
      const read = tagOf(element, file, scope)
      return read === null ? [] : [read]
    })
    const uses = reads.flatMap((read) => (read.kind === "use" ? [read.use] : []))
    const tagged = analyzeTags(uses, file, scope)
    const layouts = tagged.propEntry === null ? NO_LAYOUTS : enclosingTags(uses, tagged.propEntry.element)
    const info = layouts.size === 0 ? tagged : analyzeTags(uses, file, scope, layouts)
    const opaque = reads.flatMap((read) => (read.kind === "opaque" ? [read.entry] : []))
    return opaque.length === 0 ? info : { ...info, entries: uniqueBy([...info.entries, ...opaque], entryKey) }
  }

  return { propEntryEvidence, analyzeTags, tagOf, ownElements, analyzeElement }
}

export type ElementsApi = ReturnType<typeof createElements>
