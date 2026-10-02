import { sortedUnique } from "../../core/order.js"
import type {
  TagResolution,
  TagResolutionVia,
  TemplateAttribute,
  TemplateDoc,
  TemplateElement,
  TemplateTagResolverFn,
} from "../../core/template-doc.js"
import type { DiscoverContext } from "../types.js"
import { classKey } from "./project.js"
import type { AngularProject, ClassRef } from "./project.js"
import { alternativeMatches, createSelectorIndex } from "./selectors.js"
import type { SelectorEntry, SelectorIndex } from "./selectors.js"

type Candidates = {
  readonly entries: readonly SelectorEntry[]
  readonly via: TagResolutionVia
}

const FRAMEWORK = "angular"

const DEFAULT_OWNER = "default"

const CANDIDATE_KINDS: ReadonlySet<TemplateElement["kind"]> = new Set(["element", "component"])

const MATCHED_ATTRIBUTE_KINDS: ReadonlySet<TemplateAttribute["kind"]> = new Set(["static", "bound"])

const isComponentEntry = (entry: SelectorEntry): boolean => entry.kind === "component"

const ownerRefOf = (project: AngularProject, doc: TemplateDoc): ClassRef | null => {
  if (doc.owner === null) return null
  const file = doc.ownerFile ?? doc.file
  const name = doc.owner === DEFAULT_OWNER ? project.defaultClassName(file) : doc.owner
  return name === null ? null : { file, name }
}

const matchedAttributesOf = (element: TemplateElement): ReadonlySet<string> =>
  new Set(element.attributes.filter((attribute) => MATCHED_ATTRIBUTE_KINDS.has(attribute.kind)).map((attribute) => attribute.name))

const elementMatcher = (element: TemplateElement): ((entry: SelectorEntry) => boolean) => {
  const attributes = matchedAttributesOf(element)
  return (entry) => entry.alternatives.some((alternative) => alternativeMatches(alternative, element.tag, attributes))
}

const resolutionOf = (project: AngularProject, candidates: Candidates): TagResolution | null => {
  const [only, ...rest] = candidates.entries
  if (only === undefined) return null
  if (rest.length === 0)
    return { kind: "file", file: only.ref.file, exportName: project.exportNameOf(only.ref), via: candidates.via }
  return { kind: "ambiguous", files: sortedUnique(candidates.entries.map((entry) => entry.ref.file)) }
}

const createScopeCache = (index: SelectorIndex) => {
  const cache = new Map<string, readonly SelectorEntry[] | null>()
  return (ref: ClassRef): readonly SelectorEntry[] | null => {
    const key = classKey(ref)
    if (cache.has(key)) return cache.get(key) ?? null
    const scope = index.scopeOf(ref)
    const entries = scope === null ? null : scope.flatMap((member) => index.entryOf(member) ?? []).filter(isComponentEntry)
    cache.set(key, entries)
    return entries
  }
}

const candidatesOf = (index: SelectorIndex, scope: readonly SelectorEntry[] | null, element: TemplateElement): Candidates => {
  const matches = elementMatcher(element)
  if (scope !== null) return { entries: scope.filter(matches), via: "selector" }
  return { entries: index.entries.filter((entry) => isComponentEntry(entry) && matches(entry)), via: "selector-global" }
}

const createIndexState = (project: AngularProject, ctx: DiscoverContext) => {
  let state: { readonly index: SelectorIndex; readonly scopeOf: ReturnType<typeof createScopeCache> } | null = null
  return () => {
    if (state !== null) return state
    const index = createSelectorIndex(project, ctx)
    state = { index, scopeOf: createScopeCache(index) }
    return state
  }
}

export const createAngularTagResolver = (project: AngularProject, ctx: DiscoverContext): TemplateTagResolverFn => {
  const stateOf = createIndexState(project, ctx)
  return (doc, element) => {
    if (doc.framework !== FRAMEWORK || !CANDIDATE_KINDS.has(element.kind)) return null
    const owner = ownerRefOf(project, doc)
    if (owner === null) return null
    const { index, scopeOf } = stateOf()
    return resolutionOf(project, candidatesOf(index, scopeOf(owner), element))
  }
}
