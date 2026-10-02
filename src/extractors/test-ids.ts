import type ts from "typescript"
import type { ExtractContext, FactAnchor, FactExtractor } from "./types.js"
import type { TemplateAttribute, TemplateElement } from "../core/template-doc.js"
import { byNumber } from "../core/order.js"
import { importedConstOf } from "./imported-declaration.js"

// The conventional four, in priority order for a tie. `data-testid` is first because it is the
// Testing Library convention, so it must win a 0-0 tie against a candidate the app happens not to
// use.
export const DEFAULT_CANDIDATE_ATTRIBUTES = ["data-testid", "data-test", "data-cy", "data-qa", "data-test-id", "testID"] as const

// Not a `KnownChannel` in `ChannelValues` (`src/extractors/types.ts`), so `FactValue` is `unknown` here — the
// escape hatch that lets this channel carry a structured histogram entry instead of a bare test-id
// string. Many apps have ZERO test-ids; this channel is what makes
// "the attribute is configured wrong" distinguishable from "this app genuinely has none" — the
// `testIds` channel alone cannot: an empty channel looks identical in both cases.
export type TestIdAttributeUsage = {
  readonly attribute: string
  readonly count: number
  readonly winner: boolean
}

export type TestIdOptions = {
  // Pins the attribute outright — no histogram-based winner selection, no other candidate emits to
  // `testIds`. The histogram still reports every candidate, pinned one included, so a config that
  // picked the wrong attribute is still visible in `doctor`.
  readonly attribute?: string
  readonly candidates?: readonly string[]
}

type Occurrence = {
  readonly value: string | null
  readonly at: ts.Node | FactAnchor
  /** An identifier the file cannot fold (`data-testid={CREATE_BUTTON}` imported from a test-id module), read in `finish`. */
  readonly imported?: string
}

export const createTestIdsExtractor = (options: TestIdOptions = {}): FactExtractor => {
  const candidates =
    options.attribute !== undefined
      ? [options.attribute]
      : [...(options.candidates ?? DEFAULT_CANDIDATE_ATTRIBUTES)]
  const pinned = options.attribute ?? null

  let occurrences = new Map<string, Occurrence[]>()

  const record = (attribute: string, occurrence: Occurrence): void => {
    const list = occurrences.get(attribute) ?? []
    list.push(occurrence)
    occurrences.set(attribute, list)
  }

  const identifierOf = (initializer: ts.Node, ctx: ExtractContext): string | null => {
    const expression = ctx.ts.isJsxExpression(initializer) ? initializer.expression : initializer
    return expression === undefined ? null : (ctx.ast.asIdentifier(ctx.ast.unwrap(expression))?.text ?? null)
  }

  /** `export const CREATE_BUTTON = "create-button"` in the module the identifier is imported from. */
  const importedValue = (occurrence: Occurrence, ctx: ExtractContext): string | null => {
    if (occurrence.imported === undefined) return null
    const exported = importedConstOf(occurrence.imported, ctx)
    return exported === null ? null : (ctx.flattenString(exported.initializer)?.value ?? null)
  }

  const visitJsx = (node: ts.JsxOpeningLikeElement, ctx: ExtractContext): void => {
    for (const attribute of candidates) {
      const initializer = ctx.ast.attributeByName(node, attribute)?.initializer
      if (initializer === undefined) continue
      const flat = ctx.flattenString(initializer)
      const imported = flat === null ? identifierOf(initializer, ctx) : null
      record(attribute, { value: flat?.value ?? null, at: node, ...(imported === null ? {} : { imported }) })
    }
  }

  const templateValue = (attribute: TemplateAttribute, ctx: ExtractContext): string | null => {
    if (attribute.kind === "static") return attribute.static
    if (attribute.kind !== "bound" || attribute.expression === null) return null
    const expression = ctx.templateExpression(attribute.expression)
    if (expression === null) return null
    return ctx.flattenString(expression)?.value ?? null
  }

  const isValueKind = (attribute: TemplateAttribute): boolean =>
    attribute.kind === "static" || attribute.kind === "bound"

  const visitTemplateElement = (element: TemplateElement, ctx: ExtractContext): void => {
    for (const attribute of element.attributes) {
      if (!isValueKind(attribute) || !candidates.includes(attribute.name)) continue
      record(attribute.name, {
        value: templateValue(attribute, ctx),
        at: { pos: element.pos, end: element.end },
      })
    }
  }

  return {
    name: "test-ids",
    provides: ["testIds", "testIdAttributeHistogram"],
    requires: ["bindings", "stringConstants"],
    stage: "main",

    start: () => {
      occurrences = new Map()
    },

    enter: (node, ctx) => {
      const api = ctx.ts
      if (api.isJsxOpeningElement(node) || api.isJsxSelfClosingElement(node)) visitJsx(node, ctx)
    },

    template: (doc, ctx) => {
      for (const element of doc.elements) visitTemplateElement(element, ctx)
    },

    // Deferred to `finish` only for the histogram-winner computation, which needs every candidate's
    // total count first. Each `testIds` fact is still emitted with its ORIGINAL node as `at` (§5.4:
    // "do NOT pass `at` unless emitting from finish, because that is what makes masking automatic"),
    // so a masked subtree's test-ids are correctly dropped even though the emission itself happens
    // here — masking is evaluated on the recorded span, not on when `emitFact` was called.
    finish: (ctx) => {
      const counted = candidates.map((attribute) => ({
        attribute,
        list: occurrences.get(attribute) ?? [],
      }))

      const winner =
        pinned ??
        [...counted].sort((a, b) => byNumber(b.list.length, a.list.length))[0]?.attribute ??
        null

      for (const entry of counted) {
        const histogram: TestIdAttributeUsage = {
          attribute: entry.attribute,
          count: entry.list.length,
          winner: entry.attribute === winner,
        }
        ctx.emitFact("testIdAttributeHistogram", histogram, ctx.source)
      }

      if (winner === null) return
      const seen = new Set<string>()
      for (const occurrence of occurrences.get(winner) ?? []) {
        const value = occurrence.value ?? importedValue(occurrence, ctx)
        if (value === null || seen.has(value)) continue
        seen.add(value)
        ctx.emitFact("testIds", value, occurrence.at)
      }
    },
  }
}
