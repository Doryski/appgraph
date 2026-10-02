import type { TypeScriptApi } from "./tsconfig.js"

export const TEMPLATE_FRAMEWORK_IDS = ["vue", "angular"] as const

export type TemplateFrameworkId = (typeof TEMPLATE_FRAMEWORK_IDS)[number]

export const TEMPLATE_UNSUPPORTED_FEATURES = [
  "pug",
  "template-src",
  "script-src",
  "parse-error",
  "template-url-missing",
  "interpolated-inline-template",
] as const

export type TemplateUnsupportedFeature = (typeof TEMPLATE_UNSUPPORTED_FEATURES)[number]

export const TEMPLATE_ELEMENT_KINDS = ["element", "component", "slot", "fragment"] as const

export type TemplateElementKind = (typeof TEMPLATE_ELEMENT_KINDS)[number]

export const TEMPLATE_ATTRIBUTE_KINDS = ["static", "bound", "event", "directive", "structural"] as const

export type TemplateAttributeKind = (typeof TEMPLATE_ATTRIBUTE_KINDS)[number]

export const TEMPLATE_EXPRESSION_ORIGINS = ["interpolation", "attribute", "event"] as const

export type TemplateExpressionOrigin = (typeof TEMPLATE_EXPRESSION_ORIGINS)[number]

export const TAG_RESOLUTION_VIAS = ["selector", "selector-global", "ambient", "lazy"] as const

export type TagResolutionVia = (typeof TAG_RESOLUTION_VIAS)[number]

export const DEFAULT_SLOT_NAME = "default"

export type TemplateAttribute = {
  readonly name: string
  readonly kind: TemplateAttributeKind
  readonly arg: string | null
  readonly static: string | null
  readonly expression: string | null
  readonly pos: number
  readonly line: number
}

export type TemplateGuard = {
  readonly condition: string | null
  readonly repeated: boolean
  readonly lazy: boolean
}

export type TemplateElement = {
  readonly tag: string
  readonly names: readonly string[]
  readonly kind: TemplateElementKind
  readonly pos: number
  readonly end: number
  readonly line: number
  readonly attributes: readonly TemplateAttribute[]
  readonly guard: TemplateGuard
  readonly slotName: string | null
}

export type TemplateExpression = {
  readonly text: string
  readonly pos: number
  readonly end: number
  readonly line: number
  readonly origin: TemplateExpressionOrigin
  readonly pipes: readonly string[]
}

export type TemplateDoc = {
  readonly framework: TemplateFrameworkId
  readonly file: string
  readonly owner: string | null
  readonly ownerFile?: string
  readonly partial: boolean
  readonly elements: readonly TemplateElement[]
  readonly expressions: readonly TemplateExpression[]
  readonly unsupported: readonly TemplateUnsupportedFeature[]
}

export type TemplateNode = {
  readonly pos: number
  readonly end: number
  readonly line: number
}

export type TagResolution =
  | {
      readonly kind: "file"
      readonly file: string
      readonly exportName: string
      readonly via: TagResolutionVia
    }
  | { readonly kind: "ambiguous"; readonly files: readonly string[] }

export type TemplateTagResolverFn = (doc: TemplateDoc, element: TemplateElement) => TagResolution | null

export type TemplateSlotTag = {
  readonly tag: string
  readonly selectAttribute: string | null
}

export type TemplateNamedSlotTag = {
  readonly tag: string
  readonly nameAttribute: string
}

export type TemplateTags = {
  readonly outlets: readonly (readonly string[])[]
  readonly outletNameAttribute: string | null
  readonly childrenSlot: TemplateSlotTag | null
  readonly namedSlot: TemplateNamedSlotTag | null
  readonly builtins: readonly string[]
  readonly linkTags: readonly string[]
  readonly linkAttributes: readonly string[]
  readonly targetAttributes: readonly string[]
}

export const EMPTY_TEMPLATE_TAGS: TemplateTags = {
  outlets: [],
  outletNameAttribute: null,
  childrenSlot: null,
  namedSlot: null,
  builtins: [],
  linkTags: [],
  linkAttributes: [],
  targetAttributes: [],
}

export type TemplateProducerEnv = {
  readonly readFile: (file: string) => string | null
  readonly ts?: TypeScriptApi
  readonly projectMajor?: number | null
}

export type TemplateProducer = {
  readonly framework: TemplateFrameworkId
  readonly tags: TemplateTags
  readonly claims: (file: string) => boolean
  readonly docsOf: (file: string) => readonly TemplateDoc[]
  readonly resolveTag?: (doc: TemplateDoc, element: TemplateElement) => TagResolution | null
  readonly componentNameOf?: (file: string) => string | null
}

export type TemplateSource = {
  readonly templatesOf: (file: string) => readonly TemplateDoc[]
  readonly resolveTag: (doc: TemplateDoc, element: TemplateElement) => TagResolution | null
  readonly componentNameOf: (file: string) => string | null
  readonly tagsOf: (framework: TemplateFrameworkId) => TemplateTags
  readonly labelOf: (framework: TemplateFrameworkId) => string
  readonly claims: (file: string) => boolean
}

export const primaryNameOf = (element: Pick<TemplateElement, "names" | "tag">): string => element.names[0] ?? element.tag

export const expressionsFrom = (
  doc: Pick<TemplateDoc, "expressions">,
  origin: TemplateExpressionOrigin,
): readonly TemplateExpression[] => doc.expressions.filter((expression) => expression.origin === origin)
