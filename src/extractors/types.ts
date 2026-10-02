import type ts from "typescript"
import type { Ast, GuardResult, StringContext } from "../core/ast.js"
import type { FileBindingTable } from "../core/bindings.js"
import type { DiagnosticInput } from "../core/diagnostics.js"
import type { Endpoint, FactChannel, FlatString, Navigation, RenderEdge } from "../core/model.js"
import type { TypeScriptApi } from "../core/tsconfig.js"
import type { TagResolution, TemplateDoc, TemplateNode, TemplateTags } from "../core/template-doc.js"
import type { TemplateFrameworkId } from "../core/template-frameworks.js"
import { byCodepoint, byNumber } from "../core/order.js"

export const EXTRACT_STAGES = ["prepass", "main", "finalize"] as const

export type ExtractStage = (typeof EXTRACT_STAGES)[number]

// Channels the driver establishes before any extractor runs (§5.4 prepass row). An extractor may
// name them in `requires` without a prepass extractor providing them.
export const CORE_PREPASS_CHANNELS = ["stringConstants", "stringMembers", "bindings", "nullGuards"] as const

export type CorePrepassChannel = (typeof CORE_PREPASS_CHANNELS)[number]

export type ChannelValues = {
  readonly endpoints: Endpoint
  readonly navigations: Navigation
  readonly renders: RenderEdge
  readonly nullGuards: string
  readonly uses: string
  readonly stores: string
  readonly queryKeys: string
  readonly mutations: number
  readonly i18nNamespaces: string
  readonly testIds: string
  readonly formSchemas: string
  readonly formFields: string
  readonly featureGates: string
  readonly hooks: string
  readonly messages: string
}

export type KnownChannel = keyof ChannelValues

export type FactValue<C extends FactChannel> = C extends KnownChannel ? ChannelValues[C] : unknown

export type FactSpan = {
  readonly pos: number
  readonly end: number
}

export type Fact = {
  readonly channel: FactChannel
  readonly value: unknown
  readonly extractor: string
  readonly file: string
  readonly line: number | null
  readonly span: FactSpan | null
  readonly origin?: string
}

// `at` defaults to the node the main walk is currently visiting, which is what makes subtree masking
// automatic: an extractor emitting from `enter` never has to remember where it was.
export type FactAnchor = FactSpan & {
  readonly file?: string
  readonly line?: number
}

export type FactSink = <C extends FactChannel>(channel: C, value: FactValue<C>, at?: ts.Node | FactAnchor) => void

// `sourceFile` is the ONLY way an extractor may look at another module's text: it goes through the
// injected `FileHost` behind the resolver (and its parse cache), so a run against a virtual
// filesystem sees exactly the files the resolver saw. No extractor may reach for `ts.sys`.
export type CrossFileResolve = {
  readonly declarationFile: (absFile: string, exportName: string) => string
  readonly relative: (absFile: string) => string
  readonly resolveModule: (fromAbsFile: string, specifier: string) => string | null
  readonly sourceFile: (absFile: string) => ts.SourceFile | null
}

export type FileHandle = {
  readonly file: string
  readonly absFile: string
  readonly extension: string
  readonly text: string
}

export type ExtractContext = {
  readonly ts: TypeScriptApi
  readonly ast: Ast
  readonly file: string
  readonly absFile: string
  readonly source: ts.SourceFile
  readonly handle: FileHandle
  readonly strings: StringContext
  readonly bindings: FileBindingTable
  readonly nullGuards: readonly string[]
  readonly flattenString: (node: ts.Node | undefined) => FlatString | null
  readonly guardOf: (node: ts.Node, stopAt?: ts.Node) => GuardResult
  readonly normalizeUrl: (raw: string) => string
  readonly lineOf: (node: ts.Node) => number
  // Cross-file work is confined to `finish` (§5.4): during `main` an extractor records the unresolved
  // binding and resolves it here, so the shared walk never re-enters the parser.
  readonly resolve: CrossFileResolve | null
  readonly templates: readonly TemplateDoc[]
  readonly templateExpression: (text: string) => ts.Expression | null
  readonly resolveTag: TemplateTagResolver
  readonly tagsOf: TemplateTagsOf
  readonly emitFact: FactSink
  readonly diagnostic: (input: DiagnosticInput) => void
}

export type ExtractInput = Omit<ExtractContext, "emitFact" | "diagnostic">

export type TemplateTagResolver = (doc: TemplateDoc, element: TemplateDoc["elements"][number]) => TagResolution | null

export type TemplateTagsOf = (framework: TemplateFrameworkId) => TemplateTags

export const anchorOf = (doc: Pick<TemplateDoc, "file">, node: TemplateNode): FactAnchor => ({
  pos: node.pos,
  end: node.end,
  file: doc.file,
  line: node.line,
})

export type MaskDecision = {
  readonly channels: readonly FactChannel[] | "all"
  readonly reason: string
}

export type FactExtractor = {
  readonly name: string
  readonly provides: readonly FactChannel[]
  readonly enablingDependency?: string | readonly string[]
  readonly requires?: readonly FactChannel[]
  readonly stage?: ExtractStage
  readonly accepts?: (file: FileHandle) => boolean
  readonly start?: (ctx: ExtractContext) => void
  readonly enter?: (node: ts.Node, ctx: ExtractContext) => void
  readonly mask?: (node: ts.Node, ctx: ExtractContext) => MaskDecision | null
  readonly template?: (doc: TemplateDoc, ctx: ExtractContext) => void
  readonly finish?: (ctx: ExtractContext) => void
}

// Masking suppresses facts, never structure (§5.4): a masked subtree's components stay in the tree and
// in `reachable`, so an agent still sees that the component exists.
export const UNMASKABLE_CHANNELS = ["renders", "uses", "nullGuards", "maskedComponents"] as const

export type MaskRecord = {
  readonly extractor: string
  readonly reason: string
  readonly channels: readonly FactChannel[] | "all"
  readonly span: FactSpan
  readonly line: number
}

export type MaskedFact = {
  readonly fact: Fact
  readonly reasons: readonly string[]
}

export const dependenciesOf = (extractor: FactExtractor): readonly string[] => {
  const dependency = extractor.enablingDependency
  if (dependency === undefined) return []
  return typeof dependency === "string" ? [dependency] : dependency
}

export const stageOf = (extractor: FactExtractor): ExtractStage => extractor.stage ?? "main"

export const isUnmaskable = (channel: FactChannel): boolean =>
  (UNMASKABLE_CHANNELS as readonly string[]).includes(channel)

export const maskCoversChannel = (mask: MaskRecord, channel: FactChannel): boolean => {
  if (isUnmaskable(channel)) return false
  return mask.channels === "all" || mask.channels.includes(channel)
}

export const maskContains = (mask: MaskRecord, span: FactSpan): boolean =>
  span.pos >= mask.span.pos && span.end <= mask.span.end

// Innermost first, so `--explain` reads the most specific reason a fact was dropped before the
// broader one. Ties break on extractor name to stay deterministic without `localeCompare`.
export const compareMasksInnermostFirst = (a: MaskRecord, b: MaskRecord): number =>
  byNumber(a.span.end - a.span.pos, b.span.end - b.span.pos) ||
  byNumber(b.span.pos, a.span.pos) ||
  byCodepoint(a.extractor, b.extractor)

export const channelValues = <C extends FactChannel>(
  facts: readonly Fact[],
  channel: C,
): readonly FactValue<C>[] =>
  facts.filter((fact) => fact.channel === channel).map((fact) => fact.value as FactValue<C>)

export type TagMaskOptions = {
  readonly name: string
  readonly tags: readonly string[]
  readonly reason: string
  readonly channels?: readonly FactChannel[] | "all"
}

// The DevStatesPreview case (§5.4): a dev-only preview whose data-testids are real JSX strings that
// must not be advertised to an agent as selectors for the shipping UI. Also emits the masked tag on
// `maskedComponents` so a consumer can suppress the component's own file from screen aggregates —
// subtree masking alone only reaches JSX written inline in the masking file.
export const createTagMask = (options: TagMaskOptions): FactExtractor => {
  const tags = new Set(options.tags)
  const channels = options.channels ?? "all"

  return {
    name: options.name,
    provides: ["maskedComponents"],
    mask: (node, ctx) => {
      const api = ctx.ts
      // The subtree that holds the children is the JsxElement, not its opening tag.
      const opening = api.isJsxElement(node)
        ? node.openingElement
        : api.isJsxSelfClosingElement(node)
          ? node
          : null
      if (opening === null) return null

      const tag = ctx.ast.tagName(opening)
      if (tag === null || !tags.has(tag)) return null

      ctx.emitFact("maskedComponents", { tag, reason: options.reason, channels }, node)
      return { channels, reason: options.reason }
    },
  }
}
