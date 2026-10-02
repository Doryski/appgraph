import type ts from "typescript"
import type { DiscoverContext } from "../types.js"
import { SCRIPT_GLOB } from "../../core/extensions.js"
import { by, byCodepoint, thenBy, uniqueBy } from "../../core/order.js"
import { isNonAppFile } from "../../core/project.js"
import { classKey } from "./project.js"
import type { AngularProject, ClassRef } from "./project.js"

export const SELECTOR_KINDS = ["component", "directive"] as const

export type SelectorKind = (typeof SELECTOR_KINDS)[number]

export type SelectorAlternative = {
  readonly element: string | null
  readonly attributes: readonly string[]
  readonly classes: readonly string[]
}

export type SelectorEntry = {
  readonly ref: ClassRef
  readonly kind: SelectorKind
  readonly selector: string
  readonly alternatives: readonly SelectorAlternative[]
}

type Split = {
  readonly parts: readonly string[]
  readonly current: string
  readonly depth: number
}

type ExportWalk = {
  readonly seen: ReadonlySet<string>
  readonly refs: readonly ClassRef[]
}

const DECORATOR_OF = { component: "Component", directive: "Directive" } as const satisfies Record<
  SelectorKind,
  string
>

const SELECTOR_MARKERS = ["Component", "Directive"] as const

const OPENERS = new Set(["(", "["])

const CLOSERS = new Set([")", "]"])

const NEGATION = /:not\([^)]*\)/g

const ATTRIBUTE = /\[\s*([^\]=~|^$*\s]+)[^\]]*\]/g

const BRACKETED = /\[[^\]]*\]/g

const ELEMENT = /^[A-Za-z][\w-]*/

const CLASS_NAME = /\.([\w-]+)/g

const EMPTY_SPLIT: Split = { parts: [], current: "", depth: 0 }

const byRef = thenBy<ClassRef>(
  by((ref) => ref.file),
  by((ref) => ref.name),
)

const sortRefs = (refs: readonly ClassRef[]): readonly ClassRef[] => [...uniqueBy(refs, classKey)].sort(byRef)

const depthAfter = (char: string, depth: number): number => {
  if (OPENERS.has(char)) return depth + 1
  if (CLOSERS.has(char)) return Math.max(0, depth - 1)
  return depth
}

const splitStep = (state: Split, char: string): Split => {
  if (char === "," && state.depth === 0) return { ...state, parts: [...state.parts, state.current], current: "" }
  return { ...state, current: state.current + char, depth: depthAfter(char, state.depth) }
}

const splitTopLevel = (selector: string): readonly string[] => {
  const split = [...selector].reduce(splitStep, EMPTY_SPLIT)
  return [...split.parts, split.current].map((part) => part.trim()).filter((part) => part !== "")
}

const captures = (text: string, pattern: RegExp): readonly string[] =>
  [...text.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))

const parseAlternative = (raw: string): SelectorAlternative => {
  const text = raw.replace(NEGATION, "")
  return {
    element: ELEMENT.exec(text)?.[0] ?? null,
    attributes: captures(text, ATTRIBUTE),
    classes: captures(text.replace(BRACKETED, ""), CLASS_NAME),
  }
}

export const parseSelector = (selector: string): readonly SelectorAlternative[] =>
  splitTopLevel(selector).map(parseAlternative)

const isMatchable = (alternative: SelectorAlternative): boolean =>
  alternative.classes.length === 0 && (alternative.element !== null || alternative.attributes.length > 0)

export const alternativeMatches = (
  alternative: SelectorAlternative,
  tag: string,
  attributes: ReadonlySet<string>,
): boolean =>
  isMatchable(alternative) &&
  (alternative.element === null || alternative.element === tag) &&
  alternative.attributes.every((attribute) => attributes.has(attribute))

const appScripts = (ctx: DiscoverContext): readonly string[] =>
  ctx
    .glob(SCRIPT_GLOB)
    .filter((file) => !isNonAppFile(file) && !ctx.isGenerated(file))
    .sort(byCodepoint)

const declarableFiles = (ctx: DiscoverContext): readonly string[] =>
  appScripts(ctx).filter((file) => {
    const text = ctx.readFile(file)
    return text !== null && SELECTOR_MARKERS.some((marker) => text.includes(marker))
  })

export const createSelectorIndex = (project: AngularProject, ctx: DiscoverContext) => {
  const literalSelector = (object: ts.ObjectLiteralExpression, file: string): string | null => {
    const member = project.values.membersOf(object, file).members.find((candidate) => candidate.name === "selector")
    return ctx.ast.asStringLiteralLike(member?.value.node)?.text ?? null
  }

  const entryOf = (declaration: ts.ClassDeclaration, file: string, name: string): SelectorEntry | null =>
    SELECTOR_KINDS.flatMap((kind): readonly SelectorEntry[] => {
      const object = ctx.ast.decoratorArgument(declaration, project.decoratorLocalName(file, DECORATOR_OF[kind]))
      const selector = object === null ? null : literalSelector(object, file)
      if (selector === null) return []
      return [{ ref: { file, name }, kind, selector, alternatives: parseSelector(selector) }]
    })[0] ?? null

  const entriesIn = (file: string): readonly SelectorEntry[] =>
    (ctx.sourceFile(file)?.statements ?? [])
      .flatMap((statement) => (ctx.ts.isClassDeclaration(statement) && statement.name !== undefined ? [statement] : []))
      .flatMap((statement) => {
        const entry = entryOf(statement, file, statement.name?.text ?? "")
        return entry === null ? [] : [entry]
      })
      .sort(by((entry) => entry.ref.name))

  const entries: readonly SelectorEntry[] = declarableFiles(ctx).flatMap(entriesIn)

  const entryByKey: ReadonlyMap<string, SelectorEntry> = new Map(entries.map((entry) => [classKey(entry.ref), entry]))

  const isDeclarable = (ref: ClassRef): boolean => entryByKey.has(classKey(ref))

  const isModule = (ref: ClassRef): boolean => project.ngModuleOf(ref) !== null

  const completed = new Map<string, readonly ClassRef[]>()

  const walkExport = (walk: ExportWalk, ref: ClassRef): ExportWalk => {
    if (isModule(ref)) return walkModule(walk, ref)
    if (!isDeclarable(ref)) return walk
    return { ...walk, refs: [...walk.refs, ref] }
  }

  const walkModule = (walk: ExportWalk, module: ClassRef): ExportWalk => {
    const key = classKey(module)
    if (walk.seen.has(key)) return walk
    const entered: ExportWalk = { ...walk, seen: new Set([...walk.seen, key]) }
    const done = completed.get(key)
    if (done !== undefined) return { ...entered, refs: [...entered.refs, ...done] }
    return (project.ngModuleOf(module)?.exports ?? []).reduce(walkExport, entered)
  }

  const exportedScopeOf = (module: ClassRef): readonly ClassRef[] => {
    const key = classKey(module)
    const done = completed.get(key)
    if (done !== undefined) return done
    const scope = sortRefs(walkModule({ seen: new Set(), refs: [] }, module).refs)
    completed.set(key, scope)
    return scope
  }

  const contributionOf = (ref: ClassRef): readonly ClassRef[] => {
    if (isModule(ref)) return exportedScopeOf(ref)
    return isDeclarable(ref) ? [ref] : []
  }

  const standaloneScope = (imports: readonly ClassRef[] | null): readonly ClassRef[] | null =>
    imports === null ? null : sortRefs(imports.flatMap(contributionOf))

  const declaredScope = (ref: ClassRef): readonly ClassRef[] | null => {
    const module = project.declaringModuleOf(ref)
    const info = module === null ? null : project.ngModuleOf(module)
    if (info === null || info.unreadable.length > 0) return null
    return sortRefs([...info.declarations.filter(isDeclarable), ...info.imports.flatMap(contributionOf)])
  }

  const scopeOf = (ref: ClassRef): readonly ClassRef[] | null => {
    const component = project.componentOf(ref)
    if (component === null) return null
    return project.isStandalone(ref) ? standaloneScope(component.imports) : declaredScope(ref)
  }

  const globalMatches = (tag: string, attributes: readonly string[]): readonly SelectorEntry[] => {
    const present = new Set(attributes)
    return entries.filter((entry) =>
      entry.alternatives.some((alternative) => alternativeMatches(alternative, tag, present)),
    )
  }

  return {
    entries,
    entryOf: (ref: ClassRef): SelectorEntry | null => entryByKey.get(classKey(ref)) ?? null,
    exportedScopeOf,
    scopeOf,
    globalMatches,
  }
}

export type SelectorIndex = ReturnType<typeof createSelectorIndex>
