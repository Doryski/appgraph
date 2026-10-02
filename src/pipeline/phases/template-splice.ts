import type { SplicePoint, SpliceRef } from "../../core/graph.js"
import type { SpliceMode } from "../../core/model.js"
import type { TemplateAttribute, TemplateDoc, TemplateElement, TemplateTags } from "../../core/template-doc.js"
import { DEFAULT_SLOT_NAME } from "../../core/template-doc.js"
import { sortedUnique } from "../../core/order.js"
import type { PipelineEnv } from "../context.js"

const outletAliasesOf = (tags: TemplateTags, tag: string): readonly string[] =>
  tags.outlets.find((group) => group.includes(tag)) ?? [tag]

const isNonEmptyAttribute = (attribute: TemplateAttribute): boolean =>
  (attribute.static ?? "") !== "" || (attribute.expression ?? "") !== ""

const isNamedOutlet = (tags: TemplateTags, element: TemplateElement): boolean =>
  element.attributes.some((attribute) => attribute.name === tags.outletNameAttribute && isNonEmptyAttribute(attribute))

const isOutletNamed = (tags: TemplateTags, element: TemplateElement, name: string): boolean =>
  element.attributes.some((attribute) => attribute.name === tags.outletNameAttribute && attribute.static === name)

const isSlotNamed = (element: TemplateElement, name: string): boolean =>
  element.kind === "slot" && element.slotName === name

const templateSpliceMatcherOf = (
  tags: TemplateTags,
  splice: SpliceMode,
): ((element: TemplateElement) => boolean) | null => {
  if (splice.kind === "outlet") {
    const aliases = outletAliasesOf(tags, splice.tag)
    const isOutlet = (element: TemplateElement): boolean => element.names.some((name) => aliases.includes(name))
    const { name } = splice
    if (name !== undefined) return (element) => isOutlet(element) && isOutletNamed(tags, element, name)
    return (element) => isOutlet(element) && !isNamedOutlet(tags, element)
  }
  if (splice.kind === "children")
    return (element) => tags.childrenSlot !== null && isSlotNamed(element, DEFAULT_SLOT_NAME)
  if (splice.kind === "slot") return (element) => isSlotNamed(element, splice.name)
  return null
}

const isOwnedBy = (doc: TemplateDoc, exportName: string | null): boolean =>
  exportName === null || doc.owner === null || doc.owner === exportName

const templateSplicePointsIn = (env: PipelineEnv, doc: TemplateDoc, splice: SpliceMode): readonly SplicePoint[] => {
  const matches = templateSpliceMatcherOf(env.templates.tagsOf(doc.framework), splice)
  if (matches === null) return []
  return doc.elements.filter(matches).map(({ pos, line }) => ({ pos, line }))
}

export const templateSpliceCandidatesOf = (env: PipelineEnv, ref: SpliceRef): readonly SplicePoint[] | null => {
  if (ref.splice.kind === "at" || !env.templates.claims(ref.file)) return null
  const docs = env.templates.templatesOf(ref.file).filter((doc) => isOwnedBy(doc, ref.exportName))
  if (docs.length === 0) return null
  return docs.flatMap((doc) => templateSplicePointsIn(env, doc, ref.splice))
}

const ownedTargetsOf = (env: PipelineEnv, doc: TemplateDoc): readonly string[] =>
  doc.elements.flatMap((element) => {
    const resolution = env.templates.resolveTag(doc, element)
    return resolution?.kind === "file" ? [resolution.file] : []
  })

export const templateTargetsOf = (env: PipelineEnv, file: string, exportName: string): readonly string[] | null => {
  if (!env.templates.claims(file)) return null
  const docs = env.templates.templatesOf(file).filter((doc) => doc.owner === exportName)
  if (docs.length === 0) return null
  return sortedUnique(docs.flatMap((doc) => ownedTargetsOf(env, doc)))
}
