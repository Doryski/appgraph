import type ts from "typescript"
import type { Diagnostic, FactChannel } from "../core/model.js"
import type { DiagnosticInput } from "../core/diagnostics.js"
import type { TypeScriptApi } from "../core/tsconfig.js"
import type { TemplateDoc } from "../core/template-doc.js"
import { EMPTY_TEMPLATE_TAGS } from "../core/template-doc.js"
import type {
  CrossFileResolve,
  ExtractContext,
  ExtractInput,
  ExtractStage,
  Fact,
  FactAnchor,
  FactExtractor,
  FactSpan,
  FileHandle,
  MaskRecord,
  MaskedFact,
  TemplateTagResolver,
  TemplateTagsOf,
} from "./types.js"
import { CORE_PREPASS_CHANNELS, compareMasksInnermostFirst, maskContains, maskCoversChannel, stageOf } from "./types.js"
import { createAst, walk } from "../core/ast.js"
import { createBindingTable } from "../core/bindings.js"
import { fileStrings } from "../core/strings.js"
import { bindingTableFor } from "./imported-declaration.js"
import { normalizeUrl } from "../core/url.js"

export type RegistryOptions = {
  readonly extractors: readonly FactExtractor[]
  readonly enabled?: readonly string[]
  readonly disabled?: readonly string[]
  readonly disabledChannels?: readonly FactChannel[]
}

export type ExtractionResult = {
  readonly file: string
  readonly facts: readonly Fact[]
  readonly masked: readonly MaskedFact[]
  readonly masks: readonly MaskRecord[]
  readonly diagnostics: readonly Diagnostic[]
}

export type ExtractorRegistry = {
  readonly extractors: readonly FactExtractor[]
  readonly stage: (stage: ExtractStage) => readonly FactExtractor[]
  readonly channels: readonly FactChannel[]
  readonly diagnostics: readonly Diagnostic[]
  readonly run: (input: ExtractInput) => ExtractionResult
}

export type ContextOptions = {
  readonly ts: TypeScriptApi
  readonly file: string
  readonly absFile?: string
  readonly source: ts.SourceFile
  readonly resolve?: CrossFileResolve
  readonly resolveModule?: (specifier: string) => string | null
  readonly normalizeUrl?: (raw: string) => string
  readonly members?: ReadonlyMap<string, string>
  readonly templates?: readonly TemplateDoc[]
  readonly resolveTag?: TemplateTagResolver
  readonly tagsOf?: TemplateTagsOf
}

const TEMPLATE_EXPRESSION_FILE = "__appgraph_template_expression.ts"

const parseTemplateExpression = (api: TypeScriptApi, text: string): ts.Expression | null => {
  const source = api.createSourceFile(
    TEMPLATE_EXPRESSION_FILE,
    `(${text})`,
    api.ScriptTarget.ESNext,
    true,
    api.ScriptKind.TS,
  )
  const statement = source.statements[0]
  if (source.statements.length !== 1 || statement === undefined || !api.isExpressionStatement(statement)) return null
  const wrapped = statement.expression
  if (!api.isParenthesizedExpression(wrapped) || wrapped.end !== source.text.length) return null
  return wrapped.expression
}

const createTemplateExpressions = (api: TypeScriptApi): ((text: string) => ts.Expression | null) => {
  const cache = new Map<string, ts.Expression | null>()
  return (text) => {
    if (cache.has(text)) return cache.get(text) ?? null
    const parsed = parseTemplateExpression(api, text)
    cache.set(text, parsed)
    return parsed
  }
}

const noTagResolution: TemplateTagResolver = () => null

const noTemplateTags: TemplateTagsOf = () => EMPTY_TEMPLATE_TAGS

const lazy = <T>(compute: () => T): (() => T) => {
  let cell: { readonly value: T } | null = null
  return () => {
    cell ??= { value: compute() }
    return cell.value
  }
}

// Stage `prepass` (§5.4): string folding, string members and the BindingTable must be complete
// file-wide before any consumer looks at an identifier. `flattenString` returns null both for "not a
// string" and for "not folded yet"; running a consumer early drops the fact with no diagnostic.
export const createExtractContext = (options: ContextOptions): ExtractInput => {
  const api = options.ts
  const ast = createAst(api)
  const source = options.source
  const absFile = options.absFile ?? source.fileName

  const scoped = lazy(() => fileStrings(api, source, options.members ?? new Map<string, string>()))
  const resolveModule = options.resolveModule
  const bindings = lazy(() =>
    resolveModule === undefined ? createBindingTable({ ts: api, source }) : bindingTableFor(api, source, resolveModule),
  )
  const nullGuards = lazy(() => ast.nullGuardsIn(source))

  const extension = /\.[^./]+$/.exec(options.file)?.[0] ?? ""

  const handle: FileHandle = {
    file: options.file,
    absFile,
    extension,
    text: source.text,
  }

  return {
    ts: api,
    ast,
    file: options.file,
    absFile,
    source,
    handle,
    get strings() {
      return scoped().context
    },
    get bindings() {
      return bindings()
    },
    get nullGuards() {
      return nullGuards()
    },
    flattenString: (node) => ast.flattenString(node, scoped().contextAt(node)),
    guardOf: (node, stopAt) => (stopAt === undefined ? ast.guardOf(node) : ast.guardOf(node, stopAt)),
    normalizeUrl: options.normalizeUrl ?? normalizeUrl,
    lineOf: (node) => api.getLineAndCharacterOfPosition(source, node.getStart(source)).line + 1,
    resolve: options.resolve ?? null,
    templates: options.templates ?? [],
    templateExpression: createTemplateExpressions(api),
    resolveTag: options.resolveTag ?? noTagResolution,
    tagsOf: options.tagsOf ?? noTemplateTags,
  }
}

const isNode = (at: ts.Node | FactAnchor): at is ts.Node => "kind" in at

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const failedExtraction = (file: string, error: unknown): ExtractionResult => ({
  file,
  facts: [],
  masked: [],
  masks: [],
  diagnostics: [
    {
      severity: "error",
      code: "plugin/threw",
      message: `extract: ${errorMessage(error)}; the file's facts are dropped`,
      plugin: null,
      file,
    },
  ],
})

const resolveExtractors = (
  options: RegistryOptions,
  report: (input: DiagnosticInput, plugin: string) => void,
): readonly FactExtractor[] => {
  const seen = new Set<string>()
  const unique: FactExtractor[] = []

  for (const extractor of options.extractors) {
    if (seen.has(extractor.name)) {
      report(
        {
          severity: "error",
          code: "plugin/duplicate-name",
          message: "Duplicate extractor name; the later registration is skipped.",
        },
        extractor.name,
      )
      continue
    }
    seen.add(extractor.name)
    unique.push(extractor)
  }

  const allow = options.enabled === undefined ? null : new Set(options.enabled)
  const deny = new Set(options.disabled ?? [])
  const deadChannels = new Set<string>(options.disabledChannels ?? [])

  const kept: FactExtractor[] = []
  const available = new Set<string>(CORE_PREPASS_CHANNELS)

  for (const extractor of unique) {
    if (allow !== null && !allow.has(extractor.name)) continue
    if (deny.has(extractor.name)) continue
    if (extractor.provides.length > 0 && extractor.provides.every((channel) => deadChannels.has(channel))) continue

    const missing = (extractor.requires ?? []).filter((channel) => !available.has(channel))
    if (missing.length > 0) {
      report(
        {
          severity: "error",
          code: "plugin/missing-requirement",
          message: `Requires channel(s) no prepass provides: ${missing.join(", ")}. The extractor is skipped.`,
        },
        extractor.name,
      )
      continue
    }

    if (stageOf(extractor) === "prepass") for (const channel of extractor.provides) available.add(channel)
    kept.push(extractor)
  }

  return kept
}

export const createRegistry = (options: RegistryOptions): ExtractorRegistry => {
  const diagnostics: Diagnostic[] = []

  const report = (input: DiagnosticInput, plugin: string): void => {
    diagnostics.push({
      severity: input.severity,
      code: input.code,
      message: input.message,
      plugin,
      ...(input.file !== undefined ? { file: input.file } : {}),
      ...(input.line !== undefined ? { line: input.line } : {}),
      ...(input.screenId !== undefined ? { screenId: input.screenId } : {}),
    })
  }

  const extractors = resolveExtractors(options, report)

  const byStage = (stage: ExtractStage): readonly FactExtractor[] =>
    extractors.filter((extractor) => stageOf(extractor) === stage)

  const prepass = byStage("prepass")
  const main = byStage("main")
  const finalize = byStage("finalize")

  const channels = [...new Set(extractors.flatMap((extractor) => [...extractor.provides]))]

  const extract = (input: ExtractInput): ExtractionResult => {
    const facts: Fact[] = []
    const masks: MaskRecord[] = []
    const runDiagnostics: Diagnostic[] = []

    let currentExtractor = ""
    let currentNode: ts.Node | null = null
    let currentFile = input.file

    const anchored = new Set<Fact>()

    const spanOf = (at: ts.Node | FactAnchor | undefined): FactSpan | null =>
      at === undefined ? null : { pos: at.pos, end: at.end }

    const lineAt = (at: ts.Node | FactAnchor | undefined): number | null => {
      if (at === undefined) return null
      if (isNode(at)) return input.lineOf(at)
      if (at.line !== undefined) return at.line
      return input.ts.getLineAndCharacterOfPosition(input.source, at.pos).line + 1
    }

    const originOf = (at: ts.Node | FactAnchor | undefined): { readonly origin?: string } => {
      if (at === undefined || isNode(at) || at.file === undefined || at.file === input.file) return {}
      return { origin: at.file }
    }

    const ctx: ExtractContext = {
      ...input,
      emitFact: (channel, value, at) => {
        const target = at ?? currentNode ?? undefined
        const fact: Fact = {
          channel,
          value,
          extractor: currentExtractor,
          file: input.file,
          line: lineAt(target),
          span: spanOf(target),
          ...originOf(target),
        }
        facts.push(fact)
        if (target !== undefined && !isNode(target)) anchored.add(fact)
      },
      diagnostic: (entry) => {
        runDiagnostics.push({
          severity: entry.severity,
          code: entry.code,
          message: entry.message,
          plugin: currentExtractor,
          file: entry.file ?? currentFile,
          ...(entry.line !== undefined ? { line: entry.line } : {}),
          ...(entry.screenId !== undefined ? { screenId: entry.screenId } : {}),
        })
      },
    }

    // §6.5: a throwing extractor degrades one fact channel, never the report.
    const safely = (extractor: FactExtractor, hook: string, body: () => void): void => {
      currentExtractor = extractor.name
      try {
        body()
      } catch (error) {
        runDiagnostics.push({
          severity: "error",
          code: "plugin/threw",
          message: `${hook}: ${errorMessage(error)}`,
          plugin: extractor.name,
          file: currentFile,
        })
      }
    }

    const active = extractors.filter((extractor) => extractor.accepts?.(input.handle) ?? true)
    const activeIn = (stage: ExtractStage) => active.filter((extractor) => stageOf(extractor) === stage)

    for (const extractor of active) safely(extractor, "start", () => extractor.start?.(ctx))

    for (const extractor of activeIn("prepass")) {
      const enter = extractor.enter
      if (enter !== undefined)
        safely(extractor, "enter", () => {
          walk(input.source, (node) => {
            currentNode = node
            enter(node, ctx)
          })
          currentNode = null
        })
      safely(extractor, "finish", () => extractor.finish?.(ctx))
    }

    const mainActive = activeIn("main")
    const maskers = mainActive.filter((extractor) => extractor.mask !== undefined)

    walk(input.source, (node) => {
      currentNode = node

      for (const extractor of maskers)
        safely(extractor, "mask", () => {
          const decision = extractor.mask?.(node, ctx) ?? null
          if (decision === null) return
          masks.push({
            extractor: extractor.name,
            reason: decision.reason,
            channels: decision.channels,
            span: { pos: node.pos, end: node.end },
            line: input.lineOf(node),
          })
        })

      for (const extractor of mainActive) {
        const enter = extractor.enter
        if (enter === undefined) continue
        currentNode = node
        safely(extractor, "enter", () => {
          enter(node, ctx)
        })
      }
    })

    currentNode = null

    for (const doc of input.templates) {
      currentFile = doc.file
      for (const extractor of mainActive) {
        const hook = extractor.template
        if (hook === undefined) continue
        safely(extractor, "template", () => {
          hook(doc, ctx)
        })
      }
    }
    currentFile = input.file

    for (const extractor of [...mainActive, ...activeIn("finalize")])
      safely(extractor, "finish", () => extractor.finish?.(ctx))

    currentExtractor = ""

    const ordered = [...masks].sort(compareMasksInnermostFirst)
    const kept: Fact[] = []
    const masked: MaskedFact[] = []

    for (const fact of facts) {
      const span = fact.span
      const hits =
        span === null || anchored.has(fact)
          ? []
          : ordered.filter((mask) => maskCoversChannel(mask, fact.channel) && maskContains(mask, span))
      if (hits.length === 0) {
        kept.push(fact)
        continue
      }
      masked.push({ fact, reasons: hits.map((mask) => mask.reason) })
    }

    for (const mask of ordered)
      runDiagnostics.push({
        severity: "info",
        code: "facts/masked",
        message: `${mask.reason} (channels: ${mask.channels === "all" ? "all" : mask.channels.join(", ")})`,
        plugin: mask.extractor,
        file: input.file,
        line: mask.line,
      })

    return { file: input.file, facts: kept, masked, masks: ordered, diagnostics: runDiagnostics }
  }

  const run = (input: ExtractInput): ExtractionResult => {
    try {
      return extract(input)
    } catch (error) {
      return failedExtraction(input.file, error)
    }
  }

  return {
    extractors,
    stage: (stage) => (stage === "prepass" ? prepass : stage === "main" ? main : finalize),
    channels,
    diagnostics,
    run,
  }
}
