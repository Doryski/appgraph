export const NodeTypes = {
  ROOT: 0,
  ELEMENT: 1,
  TEXT: 2,
  COMMENT: 3,
  SIMPLE_EXPRESSION: 4,
  INTERPOLATION: 5,
  ATTRIBUTE: 6,
  DIRECTIVE: 7,
  COMPOUND_EXPRESSION: 8,
} as const

export const ElementTypes = {
  ELEMENT: 0,
  COMPONENT: 1,
  SLOT: 2,
  TEMPLATE: 3,
} as const

export type ElementType = (typeof ElementTypes)[keyof typeof ElementTypes]

export type SourcePosition = {
  readonly offset: number
  readonly line: number
  readonly column: number
}

export type SourceLocation = {
  readonly start: SourcePosition
  readonly end: SourcePosition
  readonly source: string
}

export type SimpleExpression = {
  readonly type: typeof NodeTypes.SIMPLE_EXPRESSION
  readonly content: string
  readonly isStatic: boolean
  readonly loc: SourceLocation
}

export type CompoundExpression = {
  readonly type: typeof NodeTypes.COMPOUND_EXPRESSION
  readonly loc: SourceLocation
}

export type ExpressionNode = SimpleExpression | CompoundExpression

export type TextNode = {
  readonly type: typeof NodeTypes.TEXT
  readonly content: string
  readonly loc: SourceLocation
}

export type CommentNode = {
  readonly type: typeof NodeTypes.COMMENT
  readonly content: string
  readonly loc: SourceLocation
}

export type InterpolationNode = {
  readonly type: typeof NodeTypes.INTERPOLATION
  readonly content: ExpressionNode
  readonly loc: SourceLocation
}

export type AttributeNode = {
  readonly type: typeof NodeTypes.ATTRIBUTE
  readonly name: string
  readonly value: TextNode | undefined
  readonly loc: SourceLocation
}

export type DirectiveNode = {
  readonly type: typeof NodeTypes.DIRECTIVE
  readonly name: string
  readonly rawName?: string
  readonly exp: ExpressionNode | undefined
  readonly arg: ExpressionNode | undefined
  readonly modifiers: readonly (string | SimpleExpression)[]
  readonly loc: SourceLocation
}

export type ElementNode = {
  readonly type: typeof NodeTypes.ELEMENT
  readonly tag: string
  readonly tagType: ElementType
  readonly props: readonly (AttributeNode | DirectiveNode)[]
  readonly children: readonly TemplateChildNode[]
  readonly loc: SourceLocation
}

export type TemplateChildNode = ElementNode | TextNode | CommentNode | InterpolationNode

export type TemplateRootNode = {
  readonly type: typeof NodeTypes.ROOT
  readonly children: readonly TemplateChildNode[]
  readonly loc: SourceLocation
}

export type SfcBlock = {
  readonly content: string
  readonly loc: SourceLocation
  readonly lang?: string
  readonly src?: string
}

export type SfcTemplateBlock = SfcBlock & {
  readonly ast?: TemplateRootNode
}

export type SfcDescriptor = {
  readonly filename: string
  readonly template: SfcTemplateBlock | null
  readonly script: SfcBlock | null
  readonly scriptSetup: SfcBlock | null
}

export type SfcParseResult = {
  readonly descriptor: SfcDescriptor
  readonly errors: readonly unknown[]
}

export type VueCompiler = {
  readonly parse: (source: string, options: { readonly filename: string }) => SfcParseResult
  readonly version?: string
}
