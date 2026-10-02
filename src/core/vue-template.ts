import { CONDITION_MAX, condense } from "./ast.js"
import { isSfcFile } from "./extensions.js"
import type {
  TemplateAttribute,
  TemplateAttributeKind,
  TemplateDoc,
  TemplateElement,
  TemplateElementKind,
  TemplateExpression,
  TemplateExpressionOrigin,
  TemplateProducer,
  TemplateProducerEnv,
  TemplateTags,
  TemplateUnsupportedFeature,
} from "./template-doc.js"
import { DEFAULT_SLOT_NAME } from "./template-doc.js"
import {
  ElementTypes,
  NodeTypes,
  type AttributeNode,
  type DirectiveNode,
  type ElementNode,
  type ElementType,
  type ExpressionNode,
  type SfcTemplateBlock,
  type TemplateChildNode,
  type VueCompiler,
} from "./vue-ast.js"

type Scope = {
  readonly conditions: readonly string[]
  readonly repeated: boolean
}

type ChainStep = {
  readonly own: readonly string[]
  readonly chain: readonly string[]
}

type VueProp = AttributeNode | DirectiveNode

const ROOT_SCOPE: Scope = { conditions: [], repeated: false }

const HTML_LANG = "html"

const VUE_FRAMEWORK = "vue"

const BIND_DIRECTIVE = "bind"

const ON_DIRECTIVE = "on"

const FRAGMENT_TAG = "template"

const MUSTACHE_WIDTH = 2

export const toPascal = (tag: string): string =>
  tag
    .split("-")
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")

const kindOfType = (type: ElementType): TemplateElementKind => {
  if (type === ElementTypes.COMPONENT) return "component"
  if (type === ElementTypes.SLOT) return "slot"
  if (type === ElementTypes.TEMPLATE) return "fragment"
  return "element"
}

const conditionText = (text: string): string => condense(text).slice(0, CONDITION_MAX)

const negated = (condition: string): string => `!(${condition})`

const expressionText = (node: ExpressionNode | undefined): string | null => {
  if (node === undefined) return null
  return node.type === NodeTypes.SIMPLE_EXPRESSION ? node.content : node.loc.source
}

const isDirective = (prop: VueProp): prop is DirectiveNode => prop.type === NodeTypes.DIRECTIVE

const isElement = (node: TemplateChildNode): node is ElementNode => node.type === NodeTypes.ELEMENT

const directiveKindOf = (name: string): TemplateAttributeKind => {
  if (name === BIND_DIRECTIVE) return "bound"
  if (name === ON_DIRECTIVE) return "event"
  return "directive"
}

const directiveAttributeOf = (prop: DirectiveNode): TemplateAttribute => {
  const kind = directiveKindOf(prop.name)
  const arg = expressionText(prop.arg)
  return {
    name: kind === "directive" ? prop.name : (arg ?? ""),
    kind,
    arg,
    static: null,
    expression: expressionText(prop.exp),
    pos: prop.loc.start.offset,
    line: prop.loc.start.line,
  }
}

const attributeOf = (prop: VueProp): TemplateAttribute => {
  if (isDirective(prop)) return directiveAttributeOf(prop)
  return {
    name: prop.name,
    kind: "static",
    arg: null,
    static: prop.value?.content ?? "",
    expression: null,
    pos: prop.loc.start.offset,
    line: prop.loc.start.line,
  }
}

const directiveOf = (element: ElementNode, name: string): DirectiveNode | undefined =>
  element.props.filter(isDirective).find((prop) => prop.name === name)

const directiveCondition = (element: ElementNode, name: string): string | null => {
  const text = expressionText(directiveOf(element, name)?.exp)
  return text === null ? null : conditionText(text)
}

const chainStep = (element: ElementNode, chain: readonly string[]): ChainStep => {
  const ifCondition = directiveCondition(element, "if")
  if (ifCondition !== null) return { own: [ifCondition], chain: [ifCondition] }
  const elseIfCondition = directiveCondition(element, "else-if")
  if (elseIfCondition !== null)
    return {
      own: [...chain.map(negated), elseIfCondition],
      chain: [...chain, elseIfCondition],
    }
  if (directiveOf(element, "else") !== undefined) return { own: chain.map(negated), chain: [] }
  return { own: [], chain: [] }
}

const kindOf = (element: ElementNode): TemplateElementKind =>
  element.tag === FRAGMENT_TAG ? "fragment" : kindOfType(element.tagType)

const slotNameOf = (attributes: readonly TemplateAttribute[], kind: TemplateElementKind): string | null => {
  if (kind !== "slot") return null
  const named = attributes.find((attribute) => attribute.kind === "static" && attribute.name === "name")
  if (named !== undefined) return named.static
  return attributes.some((attribute) => attribute.kind === "bound" && attribute.name === "name") ? null : DEFAULT_SLOT_NAME
}

const scopeOf = (element: ElementNode, parent: Scope, own: readonly string[]): Scope => {
  const show = directiveCondition(element, "show")
  return {
    conditions: [...parent.conditions, ...own, ...(show === null ? [] : [show])],
    repeated: parent.repeated || directiveOf(element, "for") !== undefined,
  }
}

const namesOf = (tag: string): readonly string[] => [...new Set([toPascal(tag), tag])]

const elementOf = (element: ElementNode, scope: Scope): TemplateElement => {
  const kind = kindOf(element)
  const attributes = element.props.map(attributeOf)
  return {
    tag: element.tag,
    names: namesOf(element.tag),
    kind,
    pos: element.loc.start.offset,
    end: element.loc.end.offset,
    line: element.loc.start.line,
    attributes,
    guard: {
      condition: scope.conditions.length > 0 ? scope.conditions.join(" && ") : null,
      repeated: scope.repeated,
      lazy: false,
    },
    slotName: slotNameOf(attributes, kind),
  }
}

const elementsIn = (children: readonly TemplateChildNode[], parent: Scope): readonly TemplateElement[] => {
  const elements: TemplateElement[] = []
  let chain: readonly string[] = []
  for (const element of children.filter(isElement)) {
    const step = chainStep(element, chain)
    chain = step.chain
    const scope = scopeOf(element, parent, step.own)
    elements.push(elementOf(element, scope), ...elementsIn(element.children, scope))
  }
  return elements
}

const originOf = (prop: DirectiveNode): TemplateExpressionOrigin => (prop.name === ON_DIRECTIVE ? "event" : "attribute")

const propExpression = (prop: VueProp): readonly TemplateExpression[] => {
  if (!isDirective(prop) || prop.exp === undefined) return []
  const text = expressionText(prop.exp)
  if (text === null) return []
  const { start, end } = prop.exp.loc
  return [
    {
      text,
      pos: start.offset,
      end: end.offset,
      line: start.line,
      origin: originOf(prop),
      pipes: [],
    },
  ]
}

const expressionsIn = (children: readonly TemplateChildNode[], source: string): readonly TemplateExpression[] =>
  children.flatMap((node): readonly TemplateExpression[] => {
    if (node.type === NodeTypes.ELEMENT) return [...node.props.flatMap(propExpression), ...expressionsIn(node.children, source)]
    if (node.type !== NodeTypes.INTERPOLATION) return []
    const { start, end } = node.loc
    const text = source.slice(start.offset + MUSTACHE_WIDTH, end.offset - MUSTACHE_WIDTH).trim()
    return [
      {
        text,
        pos: start.offset,
        end: end.offset,
        line: start.line,
        origin: "interpolation",
        pipes: [],
      },
    ]
  })

const parsedTemplate = (compiler: VueCompiler, text: string, filename: string) => {
  try {
    const { descriptor, errors } = compiler.parse(text, { filename })
    return { template: descriptor.template, failed: errors.length > 0 }
  } catch {
    return { template: null, failed: true }
  }
}

const unsupportedOf = (template: SfcTemplateBlock | null, failed: boolean): readonly TemplateUnsupportedFeature[] => {
  const lang = template?.lang?.trim().toLowerCase() ?? HTML_LANG
  return [
    ...(lang === HTML_LANG ? [] : (["pug"] as const)),
    ...(template?.src === undefined ? [] : (["template-src"] as const)),
    ...(failed ? (["parse-error"] as const) : []),
  ]
}

const markupOf = (template: SfcTemplateBlock | null, unsupported: readonly TemplateUnsupportedFeature[]) => {
  if (unsupported.includes("pug") || unsupported.includes("template-src")) return null
  return template?.ast ?? null
}

export const templateDocOf = (compiler: VueCompiler, text: string, file: string): TemplateDoc => {
  const { template, failed } = parsedTemplate(compiler, text, file)
  const unsupported = unsupportedOf(template, failed)
  const markup = markupOf(template, unsupported)
  const base = {
    framework: VUE_FRAMEWORK,
    file,
    owner: null,
    partial: false,
    unsupported,
  } as const
  if (markup === null) return { ...base, elements: [], expressions: [] }
  return {
    ...base,
    elements: elementsIn(markup.children, ROOT_SCOPE),
    expressions: expressionsIn(markup.children, text),
  }
}

export type VueTemplateProducerInput = {
  readonly compiler: VueCompiler
  readonly env: TemplateProducerEnv
  readonly tags: TemplateTags
}

export const createVueTemplateProducer = (input: VueTemplateProducerInput): TemplateProducer => ({
  framework: VUE_FRAMEWORK,
  tags: input.tags,
  claims: isSfcFile,
  docsOf: (file) => {
    const text = input.env.readFile(file)
    return text === null ? [] : [templateDocOf(input.compiler, text, file)]
  },
})
