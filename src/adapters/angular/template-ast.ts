import { CONDITION_MAX, condense } from "../../core/ast.js"
import type { AngularCompiler } from "../../core/angular-compiler.js"
import { angularParseOptions } from "../../core/angular-compiler.js"
import { memberOf } from "../../core/peer-loader.js"
import type {
  TemplateAttribute,
  TemplateElement,
  TemplateElementKind,
  TemplateExpression,
  TemplateExpressionOrigin,
} from "../../core/template-doc.js"
import { DEFAULT_SLOT_NAME } from "../../core/template-doc.js"
import { toPascal } from "../../core/vue-template.js"

export type AngularTemplateFrame = {
  readonly text: string
  readonly url: string
  readonly base: number
  readonly firstLine: number
}

export type AngularTemplateContent = {
  readonly elements: readonly TemplateElement[]
  readonly expressions: readonly TemplateExpression[]
  readonly failed: boolean
}

type Scope = {
  readonly conditions: readonly string[]
  readonly repeated: boolean
  readonly lazy: boolean
}

type Walk = {
  readonly frame: AngularTemplateFrame
  readonly lineAt: (offset: number) => number
  readonly refConditions: ReadonlyMap<string, readonly string[]>
}

type Collected = {
  readonly elements: readonly TemplateElement[]
  readonly expressions: readonly TemplateExpression[]
}

type Span = { readonly start: number; readonly end: number }

type SwitchGroup = {
  readonly cases: readonly (string | null)[]
  readonly children: readonly unknown[]
}

type NodeKind = "element" | "template" | "content" | "if" | "for" | "switch" | "defer" | "text" | "container" | "ignored"

const ROOT_SCOPE: Scope = { conditions: [], repeated: false, lazy: false }

const EMPTY: Collected = { elements: [], expressions: [] }

const FRAGMENT_TAGS: ReadonlySet<string> = new Set(["ng-container", "ng-template"])

const SLOT_TAG = "ng-content"

const SELECT_ATTRIBUTE = "select"

const I18N_ATTRIBUTE = "i18n"

const I18N_ATTRIBUTE_PREFIX = "i18n-"

const I18N_MEANING_SEPARATOR = "|"

const I18N_ID_SEPARATOR = "@@"

const ANY_SELECTOR = "*"

const NAMESPACE_PREFIX = /^:[^:]+:/

const NG_IF = "ngIf"

const NG_IF_ELSE = "ngIfElse"

const NG_IF_THEN = "ngIfThen"

const REPEAT_ATTRIBUTES: ReadonlySet<string> = new Set(["ngFor", "ngForOf"])

const DEFER_SUB_BLOCKS = ["placeholder", "loading", "error"] as const

const CHILD_KEYS = ["children", "branches", "groups", "cases", "empty", ...DEFER_SUB_BLOCKS] as const

const SPAN_KEYS: ReadonlySet<string> = new Set(["span", "sourceSpan", "nameSpan", "keySpan", "valueSpan", "location", "source"])

const HTML_ELEMENTS: ReadonlySet<string> = new Set([
  "a", "abbr", "address", "area", "article", "aside", "audio", "b", "base", "bdi", "bdo", "blockquote", "body", "br",
  "button", "canvas", "caption", "cite", "code", "col", "colgroup", "data", "datalist", "dd", "del", "details", "dfn",
  "dialog", "div", "dl", "dt", "em", "embed", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "i", "iframe", "img", "input", "ins", "kbd", "label",
  "legend", "li", "link", "main", "map", "mark", "menu", "meta", "meter", "nav", "noscript", "object", "ol",
  "optgroup", "option", "output", "p", "param", "picture", "pre", "progress", "q", "rp", "rt", "ruby", "s", "samp",
  "script", "search", "section", "select", "slot", "small", "source", "span", "strong", "style", "sub", "summary",
  "sup", "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time", "title", "tr", "track", "u",
  "ul", "var", "video", "wbr", "svg", "math", "center", "font", "big", "tt", "strike", "marquee", "frame", "frameset",
  "noframes", "acronym", "applet", "dir", "image",
])

const conditionText = (text: string): string => condense(text).slice(0, CONDITION_MAX)

const negated = (condition: string): string => `!(${condition})`

const stringOf = (value: unknown, key: string): string | null => {
  const found = memberOf(value, key)
  return typeof found === "string" ? found : null
}

const numberOf = (value: unknown, key: string): number | null => {
  const found = memberOf(value, key)
  return typeof found === "number" ? found : null
}

const listOf = (value: unknown, key: string): readonly unknown[] => {
  const found = memberOf(value, key)
  return Array.isArray(found) ? found : []
}

const isList = (value: unknown, key: string): boolean => Array.isArray(memberOf(value, key))

const hasKey = (value: unknown, key: string): boolean => typeof value === "object" && value !== null && key in value

const constructorNameOf = (node: unknown): string | null => stringOf(memberOf(node, "constructor"), "name")

const startOffsetOf = (span: unknown): number | null => numberOf(memberOf(span, "start"), "offset")

const endOffsetOf = (span: unknown): number | null => numberOf(memberOf(span, "end"), "offset")

const startLineOf = (span: unknown): number | null => numberOf(memberOf(span, "start"), "line")

const absoluteSpanOf = (value: unknown): Span | null => {
  const start = numberOf(value, "start")
  const end = numberOf(value, "end")
  return start === null || end === null ? null : { start, end }
}

const lineIndexOf = (text: string): ((offset: number) => number) => {
  const starts = [0, ...[...text.matchAll(/\r\n?|\n/g)].map((match) => match.index + match[0].length)]
  return (offset) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if ((starts[middle] ?? 0) <= offset) low = middle
      else high = middle - 1
    }
    return low
  }
}

const absolutePos = (walk: Walk, offset: number): number => walk.frame.base + offset

const absoluteLine = (walk: Walk, line: number): number => walk.frame.firstLine + line

const nodeStart = (node: unknown): number => startOffsetOf(memberOf(node, "sourceSpan")) ?? 0

const nodeLine = (walk: Walk, node: unknown): number => {
  const span = memberOf(node, "sourceSpan")
  return absoluteLine(walk, startLineOf(span) ?? walk.lineAt(startOffsetOf(span) ?? 0))
}

const sourceOf = (expression: unknown): string | null => stringOf(expression, "source")

const isExpressionNode = (value: unknown): value is object => typeof value === "object" && value !== null

const isPipe = (node: unknown): boolean =>
  constructorNameOf(node) === "BindingPipe" ||
  (stringOf(node, "name") !== null && isList(node, "args") && isExpressionNode(memberOf(node, "exp")))

const pipesIn = (root: unknown): readonly string[] => {
  const found: string[] = []
  const seen = new Set<unknown>()
  const visit = (node: unknown): void => {
    if (!isExpressionNode(node) || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    Object.entries(node)
      .filter(([key]) => !SPAN_KEYS.has(key))
      .forEach(([, value]) => {
        visit(value)
      })
    const name = isPipe(node) ? stringOf(node, "name") : null
    if (name !== null) found.push(name)
  }
  visit(root)
  return [...new Set(found)]
}

const astOf = (expression: unknown): unknown => memberOf(expression, "ast") ?? expression

const nodeKindOf = (node: unknown): NodeKind => {
  if (isList(node, "branches")) return "if"
  if (hasKey(node, "item") && hasKey(node, "trackBy")) return "for"
  if (isList(node, "groups") || (isList(node, "cases") && hasKey(node, "expression"))) return "switch"
  if (DEFER_SUB_BLOCKS.every((key) => hasKey(node, key))) return "defer"
  if (isList(node, "templateAttrs")) return "template"
  if (constructorNameOf(node) === "Content" || (stringOf(node, "selector") !== null && isList(node, "children"))) return "content"
  const named = stringOf(node, "name") ?? stringOf(node, "tagName") ?? stringOf(node, "componentName")
  if (named !== null && isList(node, "children") && isList(node, "attributes")) return "element"
  if (isList(node, "children")) return "container"
  return isExpressionNode(memberOf(node, "value")) && hasKey(memberOf(node, "value"), "ast") ? "text" : "ignored"
}

const localTagOf = (raw: string): string => raw.replace(NAMESPACE_PREFIX, "")

const elementKindOf = (raw: string): TemplateElementKind => {
  const tag = localTagOf(raw)
  if (tag === SLOT_TAG) return "slot"
  if (FRAGMENT_TAGS.has(tag)) return "fragment"
  if (NAMESPACE_PREFIX.test(raw)) return "element"
  return tag.includes("-") || !HTML_ELEMENTS.has(tag.toLowerCase()) ? "component" : "element"
}

export const angularNamesOf = (tag: string, componentName: string | null): readonly string[] => [
  ...new Set([tag, componentName ?? toPascal(tag)]),
]

const guardOf = (scope: Scope): TemplateElement["guard"] => ({
  condition: scope.conditions.length > 0 ? scope.conditions.join(" && ") : null,
  repeated: scope.repeated,
  lazy: scope.lazy,
})

const expressionSpanOf = (value: unknown, fallback: unknown): Span => {
  const own = absoluteSpanOf(memberOf(value, "sourceSpan"))
  if (own !== null) return own
  const start = startOffsetOf(fallback) ?? 0
  return { start, end: endOffsetOf(fallback) ?? start }
}

const expressionTextOf = (walk: Walk, value: unknown, fallback: unknown): string => {
  const source = sourceOf(value)
  if (source !== null) return source
  const span = expressionSpanOf(value, fallback)
  return walk.frame.text.slice(span.start, span.end)
}

const attributeBase = (walk: Walk, node: unknown) => ({
  pos: absolutePos(walk, nodeStart(node)),
  line: nodeLine(walk, node),
})

const staticAttributeOf = (walk: Walk, node: unknown): TemplateAttribute => ({
  name: stringOf(node, "name") ?? "",
  kind: "static",
  arg: null,
  static: stringOf(node, "value") ?? "",
  expression: null,
  ...attributeBase(walk, node),
})

const boundExpressionOf = (node: unknown): unknown => memberOf(node, "value") ?? memberOf(node, "handler")

const dynamicAttributeOf = (walk: Walk, node: unknown, kind: TemplateAttribute["kind"]): TemplateAttribute => {
  const name = stringOf(node, "name") ?? ""
  return {
    name,
    kind,
    arg: name,
    static: null,
    expression: expressionTextOf(walk, boundExpressionOf(node), memberOf(node, "valueSpan") ?? memberOf(node, "handlerSpan")),
    ...attributeBase(walk, node),
  }
}

const isBound = (node: unknown): boolean => isExpressionNode(memberOf(node, "value")) && hasKey(memberOf(node, "value"), "ast")

const structuralAttributeOf = (walk: Walk, node: unknown): TemplateAttribute =>
  isBound(node) ? dynamicAttributeOf(walk, node, "structural") : { ...staticAttributeOf(walk, node), kind: "structural" }

const byPos = (left: TemplateAttribute, right: TemplateAttribute): number => left.pos - right.pos

const i18nMessageOf = (node: unknown): unknown => {
  const message = memberOf(node, "i18n")
  return stringOf(message, "meaning") !== null && stringOf(message, "description") !== null ? message : null
}

const prefixed = (prefix: string, value: string): string => (value === "" ? "" : `${prefix}${value}`)

const suffixed = (value: string, suffix: string): string => (value === "" ? "" : `${value}${suffix}`)

const i18nValueOf = (message: unknown): string =>
  [
    suffixed(stringOf(message, "meaning") ?? "", I18N_MEANING_SEPARATOR),
    stringOf(message, "description") ?? "",
    prefixed(I18N_ID_SEPARATOR, stringOf(message, "customId") ?? ""),
  ].join("")

const i18nMarkerOf = (walk: Walk, node: unknown, name: string): readonly TemplateAttribute[] => {
  const message = i18nMessageOf(node)
  if (message === null) return []
  return [{ name, kind: "static", arg: null, static: i18nValueOf(message), expression: null, ...attributeBase(walk, node) }]
}

const i18nAttributesOf = (walk: Walk, node: unknown): readonly TemplateAttribute[] => [
  ...i18nMarkerOf(walk, node, I18N_ATTRIBUTE),
  ...listOf(node, "attributes").flatMap((attribute) =>
    i18nMarkerOf(walk, attribute, `${I18N_ATTRIBUTE_PREFIX}${stringOf(attribute, "name") ?? ""}`),
  ),
]

const ownAttributesOf = (walk: Walk, node: unknown): readonly TemplateAttribute[] =>
  [
    ...i18nAttributesOf(walk, node),
    ...listOf(node, "attributes").map((attribute) => staticAttributeOf(walk, attribute)),
    ...listOf(node, "inputs").map((input) => dynamicAttributeOf(walk, input, "bound")),
    ...listOf(node, "outputs").map((output) => dynamicAttributeOf(walk, output, "event")),
  ].sort(byPos)

const expressionOf = (walk: Walk, value: unknown, fallback: unknown, origin: TemplateExpressionOrigin): TemplateExpression => {
  const span = expressionSpanOf(value, fallback)
  return {
    text: expressionTextOf(walk, value, fallback),
    pos: absolutePos(walk, span.start),
    end: absolutePos(walk, span.end),
    line: absoluteLine(walk, walk.lineAt(span.start)),
    origin,
    pipes: pipesIn(astOf(value)),
  }
}

const boundExpressionsOf = (walk: Walk, nodes: readonly unknown[], origin: TemplateExpressionOrigin): readonly TemplateExpression[] =>
  nodes.flatMap((node) => {
    const value = boundExpressionOf(node)
    if (!isExpressionNode(value)) return []
    return [expressionOf(walk, value, memberOf(node, "valueSpan") ?? memberOf(node, "handlerSpan") ?? memberOf(node, "sourceSpan"), origin)]
  })

const attributeExpressionsOf = (walk: Walk, node: unknown): readonly TemplateExpression[] => [
  ...boundExpressionsOf(walk, listOf(node, "inputs"), "attribute"),
  ...boundExpressionsOf(walk, listOf(node, "outputs"), "event"),
]

const interpolationOf = (walk: Walk, part: unknown): TemplateExpression | null => {
  const span = absoluteSpanOf(memberOf(part, "sourceSpan"))
  if (span === null) return null
  return {
    text: walk.frame.text.slice(span.start, span.end).trim(),
    pos: absolutePos(walk, span.start),
    end: absolutePos(walk, span.end),
    line: absoluteLine(walk, walk.lineAt(span.start)),
    origin: "interpolation",
    pipes: pipesIn(part),
  }
}

const textExpressionsOf = (walk: Walk, node: unknown): readonly TemplateExpression[] => {
  const value = memberOf(node, "value")
  const parts = listOf(astOf(value), "expressions")
  return parts.flatMap((part) => {
    const found = interpolationOf(walk, part)
    return found === null ? [] : [found]
  })
}

const merge = (parts: readonly Collected[]): Collected => ({
  elements: parts.flatMap((part) => part.elements),
  expressions: parts.flatMap((part) => part.expressions),
})

const withScope = (scope: Scope, conditions: readonly string[], patch: Partial<Omit<Scope, "conditions">> = {}): Scope => ({
  ...scope,
  ...patch,
  conditions: [...scope.conditions, ...conditions],
})

export const angularSlotNameOf = (selector: string | null): string =>
  selector === null || selector === "" || selector === ANY_SELECTOR ? DEFAULT_SLOT_NAME : selector

const slotNameOf = (attributes: readonly TemplateAttribute[], node: unknown): string => {
  const select = attributes.find((attribute) => attribute.kind === "static" && attribute.name === SELECT_ATTRIBUTE)?.static
  return angularSlotNameOf(select ?? stringOf(node, "selector"))
}

type ElementSeed = {
  readonly tag: string
  readonly names: readonly string[]
  readonly kind: TemplateElementKind
  readonly attributes: readonly TemplateAttribute[]
}

const elementOf = (walk: Walk, node: unknown, seed: ElementSeed, scope: Scope): TemplateElement => {
  const span = memberOf(node, "sourceSpan")
  const start = startOffsetOf(span) ?? 0
  return {
    ...seed,
    pos: absolutePos(walk, start),
    end: absolutePos(walk, endOffsetOf(span) ?? start),
    line: nodeLine(walk, node),
    guard: guardOf(scope),
    slotName: seed.kind === "slot" ? slotNameOf(seed.attributes, node) : null,
  }
}

const rawTagOf = (node: unknown): string =>
  stringOf(node, "name") ?? stringOf(node, "tagName") ?? stringOf(node, "componentName") ?? ""

const visitElement = (walk: Walk, node: unknown, scope: Scope, inherited: readonly TemplateAttribute[]): Collected => {
  const raw = rawTagOf(node)
  const tag = localTagOf(raw)
  const componentName = stringOf(node, "componentName")
  const seed: ElementSeed = {
    tag,
    names: angularNamesOf(tag, componentName),
    kind: componentName === null ? elementKindOf(raw) : "component",
    attributes: [...inherited, ...ownAttributesOf(walk, node)].sort(byPos),
  }
  return merge([
    { elements: [elementOf(walk, node, seed, scope)], expressions: attributeExpressionsOf(walk, node) },
    visitAll(walk, listOf(node, "children"), scope),
  ])
}

const visitContent = (walk: Walk, node: unknown, scope: Scope): Collected => {
  const seed: ElementSeed = {
    tag: SLOT_TAG,
    names: angularNamesOf(SLOT_TAG, null),
    kind: "slot",
    attributes: ownAttributesOf(walk, node),
  }
  return merge([{ elements: [elementOf(walk, node, seed, scope)], expressions: [] }, visitAll(walk, listOf(node, "children"), scope)])
}

const templateAttributeNamed = (node: unknown, name: string): unknown =>
  listOf(node, "templateAttrs").find((attribute) => stringOf(attribute, "name") === name)

const ngIfConditionOf = (node: unknown): string | null => {
  const source = sourceOf(memberOf(templateAttributeNamed(node, NG_IF), "value"))
  return source === null ? null : conditionText(source)
}

const referenceNamesOf = (node: unknown): readonly string[] =>
  listOf(node, "references").flatMap((reference) => {
    const name = stringOf(reference, "name")
    return name === null ? [] : [name]
  })

const referencedConditionsOf = (walk: Walk, node: unknown): readonly string[] =>
  referenceNamesOf(node)
    .map((name) => walk.refConditions.get(name))
    .find((conditions) => conditions !== undefined) ?? []

const isExplicitTemplate = (node: unknown): boolean => {
  const tag = stringOf(node, "tagName")
  return tag === null || localTagOf(tag) === "ng-template"
}

const visitTemplate = (walk: Walk, node: unknown, scope: Scope): Collected => {
  const ngIf = ngIfConditionOf(node)
  const repeated = listOf(node, "templateAttrs").some((attribute) => REPEAT_ATTRIBUTES.has(stringOf(attribute, "name") ?? ""))
  const inner = withScope(scope, [...referencedConditionsOf(walk, node), ...(ngIf === null ? [] : [ngIf])], {
    repeated: scope.repeated || repeated,
  })
  const structural = listOf(node, "templateAttrs").map((attribute) => structuralAttributeOf(walk, attribute))
  const structuralExpressions = boundExpressionsOf(walk, listOf(node, "templateAttrs").filter(isBound), "attribute")
  if (!isExplicitTemplate(node))
    return merge([
      { elements: [], expressions: structuralExpressions },
      visitAll(walk, listOf(node, "children"), inner, structural),
    ])
  const seed: ElementSeed = {
    tag: "ng-template",
    names: angularNamesOf("ng-template", null),
    kind: "fragment",
    attributes: [...structural, ...ownAttributesOf(walk, node)].sort(byPos),
  }
  return merge([
    { elements: [elementOf(walk, node, seed, inner)], expressions: [...structuralExpressions, ...attributeExpressionsOf(walk, node)] },
    visitAll(walk, listOf(node, "children"), inner),
  ])
}

const branchConditionOf = (branch: unknown): string | null => {
  const source = sourceOf(memberOf(branch, "expression"))
  return source === null ? null : conditionText(source)
}

const visitIf = (walk: Walk, node: unknown, scope: Scope): Collected => {
  const parts: Collected[] = []
  let chain: readonly string[] = []
  for (const branch of listOf(node, "branches")) {
    const condition = branchConditionOf(branch)
    const own = [...chain.map(negated), ...(condition === null ? [] : [condition])]
    chain = condition === null ? [] : [...chain, condition]
    parts.push(visitAll(walk, listOf(branch, "children"), withScope(scope, own)))
  }
  return merge(parts)
}

const visitFor = (walk: Walk, node: unknown, scope: Scope): Collected =>
  merge([
    visitAll(walk, listOf(node, "children"), withScope(scope, [], { repeated: true })),
    visitAll(walk, listOf(memberOf(node, "empty"), "children"), scope),
  ])

const caseValueOf = (node: unknown): string | null => sourceOf(memberOf(node, "expression"))

const switchGroupsOf = (node: unknown): readonly SwitchGroup[] => {
  if (isList(node, "groups"))
    return listOf(node, "groups").map((group) => ({ cases: listOf(group, "cases").map(caseValueOf), children: listOf(group, "children") }))
  return listOf(node, "cases").map((entry) => ({ cases: [caseValueOf(entry)], children: listOf(entry, "children") }))
}

const caseConditionOf = (subject: string, values: readonly string[]): string | null => {
  const conditions = values.map((value) => conditionText(`${subject} === ${value}`))
  if (conditions.length === 0) return null
  return conditions.length === 1 ? (conditions[0] ?? null) : `(${conditions.join(" || ")})`
}

const visitSwitch = (walk: Walk, node: unknown, scope: Scope): Collected => {
  const subject = sourceOf(memberOf(node, "expression")) ?? ""
  const groups = switchGroupsOf(node)
  const caseConditions = groups.map((group) =>
    caseConditionOf(
      subject,
      group.cases.filter((value): value is string => value !== null),
    ),
  )
  const explicit = caseConditions.filter((condition): condition is string => condition !== null)
  return merge(
    groups.map((group, index) => {
      const condition = caseConditions[index] ?? null
      const own = condition === null ? explicit.map(negated) : [condition]
      return visitAll(walk, group.children, withScope(scope, own))
    }),
  )
}

const visitDefer = (walk: Walk, node: unknown, scope: Scope): Collected => {
  const lazy = withScope(scope, [], { lazy: true })
  return merge([
    visitAll(walk, listOf(node, "children"), lazy),
    ...DEFER_SUB_BLOCKS.map((key) => visitAll(walk, listOf(memberOf(node, key), "children"), lazy)),
  ])
}

const visitNode = (walk: Walk, node: unknown, scope: Scope, inherited: readonly TemplateAttribute[]): Collected => {
  const kind = nodeKindOf(node)
  if (kind === "element") return visitElement(walk, node, scope, inherited)
  if (kind === "template") return visitTemplate(walk, node, scope)
  if (kind === "content") return visitContent(walk, node, scope)
  if (kind === "if") return visitIf(walk, node, scope)
  if (kind === "for") return visitFor(walk, node, scope)
  if (kind === "switch") return visitSwitch(walk, node, scope)
  if (kind === "defer") return visitDefer(walk, node, scope)
  if (kind === "text") return { elements: [], expressions: textExpressionsOf(walk, node) }
  if (kind === "container") return visitAll(walk, listOf(node, "children"), scope)
  return EMPTY
}

function visitAll(walk: Walk, nodes: readonly unknown[], scope: Scope, inherited: readonly TemplateAttribute[] = []): Collected {
  return merge(nodes.map((node) => visitNode(walk, node, scope, inherited)))
}

const childNodesOf = (node: unknown): readonly unknown[] =>
  CHILD_KEYS.flatMap((key) => {
    const value = memberOf(node, key)
    if (Array.isArray(value)) return value
    return isExpressionNode(value) ? [value] : []
  })

const refTargetOf = (node: unknown, name: string): string | null => sourceOf(memberOf(templateAttributeNamed(node, name), "value"))

const refEntriesOf = (node: unknown): readonly (readonly [string, readonly string[]])[] => {
  const condition = ngIfConditionOf(node)
  if (condition === null) return []
  const elseTarget = refTargetOf(node, NG_IF_ELSE)
  const thenTarget = refTargetOf(node, NG_IF_THEN)
  return [
    ...(thenTarget === null ? [] : [[thenTarget.trim(), [condition]] as const]),
    ...(elseTarget === null ? [] : [[elseTarget.trim(), [negated(condition)]] as const]),
  ]
}

const refConditionsOf = (nodes: readonly unknown[]): ReadonlyMap<string, readonly string[]> => {
  const found = new Map<string, readonly string[]>()
  const visit = (node: unknown): void => {
    for (const [name, conditions] of refEntriesOf(node)) if (!found.has(name)) found.set(name, conditions)
    childNodesOf(node).forEach(visit)
  }
  nodes.forEach(visit)
  return found
}

const parseOf = (compiler: AngularCompiler, frame: AngularTemplateFrame, projectMajor: number | null) => {
  try {
    const parsed = compiler.parseTemplate(frame.text, frame.url, { ...angularParseOptions(projectMajor), preserveWhitespaces: true })
    return { nodes: parsed.nodes, failed: (parsed.errors ?? []).length > 0 }
  } catch {
    return { nodes: [], failed: true }
  }
}

export const angularTemplateContentOf = (
  compiler: AngularCompiler,
  frame: AngularTemplateFrame,
  projectMajor: number | null,
): AngularTemplateContent => {
  const { nodes, failed } = parseOf(compiler, frame, projectMajor)
  const walk: Walk = { frame, lineAt: lineIndexOf(frame.text), refConditions: refConditionsOf(nodes) }
  return { ...visitAll(walk, nodes, ROOT_SCOPE), failed }
}
