import type ts from "typescript"
import { navigationKey } from "../../core/graph.js"
import { kindOf } from "../../core/kinds.js"
import { toPosix } from "../../core/host.js"
import type { Diagnostic, Endpoint, FactChannel, FileFacts, KindRule, Navigation, NodeLocator, RenderEdge } from "../../core/model.js"
import { by, sortStrings, sortedUnique, sortedUniqueBy } from "../../core/order.js"
import type { TemplateDoc } from "../../core/template-doc.js"
import type { ExtractionResult } from "../../extractors/registry.js"
import { createExtractContext, createRegistry } from "../../extractors/registry.js"
import type { Fact, FactExtractor, FactSpan } from "../../extractors/types.js"
import { channelValues } from "../../extractors/types.js"
import type { PipelineEnv } from "../context.js"
import { asMaskedComponentFact, emptyFacts, extraChannelsOf, spanInside } from "./fact-channels.js"
import type { UnsupportedTemplate } from "./unsupported-templates.js"
import { scriptFeaturesOf, templateFeaturesOf, unsupportedKey, unsupportedTemplateDiagnostics } from "./unsupported-templates.js"

export type MaskedComponent = {
  readonly file: string
  readonly tag: string
  readonly reason: string
  readonly from: string
}

export type FactSource = {
  readonly factsOf: (file: string) => FileFacts
  readonly subtreeFactsOf: (file: string, locator: NodeLocator) => FileFacts | null
  readonly maskedComponents: () => readonly MaskedComponent[]
  readonly extractedFiles: () => readonly string[]
  readonly diagnostics: () => readonly Diagnostic[]
  readonly channelCount: (channel: FactChannel) => number
  readonly extractorCount: (extractor: string) => number
}

export type ExtractInput = {
  readonly env: PipelineEnv
  readonly extractors: readonly FactExtractor[]
  readonly kindRules: readonly KindRule[]
}

export const createFactSource = (input: ExtractInput): FactSource => {
  const { env } = input
  const api = env.ts
  const { paths, resolver } = env

  const registry = createRegistry({
    extractors: input.extractors,
    ...(env.config.disabledChannels.length > 0 ? { disabledChannels: env.config.disabledChannels } : {}),
  })

  const results = new Map<string, ExtractionResult | null>()
  const projections = new Map<string, FileFacts>()
  const masked = new Map<string, MaskedComponent>()
  const diagnostics: Diagnostic[] = [...registry.diagnostics]
  const unsupportedTemplates = new Map<string, UnsupportedTemplate>()

  const recordUnsupportedTemplates = (file: string, docs: readonly TemplateDoc[]): void => {
    for (const found of [...scriptFeaturesOf(env, file), ...templateFeaturesOf(docs)]) {
      const key = unsupportedKey(found)
      const features = unsupportedTemplates.get(key)?.features ?? []
      unsupportedTemplates.set(key, { framework: found.framework, file: found.file, features: sortedUnique([...features, found.feature]) })
    }
  }

  const runFile = (file: string): ExtractionResult | null => {
    const cached = results.get(file)
    if (cached !== undefined) return cached

    const abs = paths.abs(file)
    const source = resolver.sourceFile(abs)
    if (source === null) {
      results.set(file, null)
      return null
    }

    const templates = env.templates.templatesOf(file)
    recordUnsupportedTemplates(file, templates)

    const extractInput = createExtractContext({
      ts: api,
      file,
      absFile: abs,
      source,
      members: env.strings.members,
      templates,
      resolveTag: env.templates.resolveTag,
      tagsOf: env.templates.tagsOf,
      resolveModule: (spec) => resolver.resolveModule(abs, spec),
      resolve: {
        declarationFile: (absFile, exportName) => resolver.declarationFile(absFile, exportName),
        relative: (absFile) => toPosix(paths.rel(absFile)),
        resolveModule: (fromAbs, spec) => resolver.resolveModule(fromAbs, spec),
        sourceFile: (absFile) => resolver.sourceFile(absFile),
      },
    })

    const result = registry.run(extractInput)
    results.set(file, result)
    diagnostics.push(...result.diagnostics)
    diagnostics.push(...resolver.unresolvedImportDiagnostics([abs]).map((entry) => ({ ...entry, plugin: null })))

    // §5.4 cross-file mask closure: subtree masking only reaches JSX written INLINE in this file, so
    // the masked component's own file must also have its facts suppressed. Resolve the masked tag to
    // its declaring file here; aggregation drops that file's fact channels.
    for (const value of channelValues(result.facts, "maskedComponents")) {
      const decision = asMaskedComponentFact(value)
      if (decision === null) continue

      const binding = extractInput.bindings.get(decision.tag)
      if (binding === null || binding.kind === "local" || binding.kind === "hook-result") continue
      if (binding.file === null) continue

      const declaring = toPosix(paths.rel(resolver.declarationFile(binding.file, binding.imported)))
      if (!masked.has(declaring))
        masked.set(declaring, { file: declaring, tag: decision.tag, reason: decision.reason, from: file })
    }

    return result
  }

  const project = (file: string, facts: readonly Fact[]): FileFacts => {
    const suppressed = masked.has(file)
    const component = env.templates.componentNameOf(file) ?? resolver.componentName(paths.abs(file))
    const base = emptyFacts(file, component, kindOf(input.kindRules, { file }))

    const structural: FileFacts = {
      ...base,
      renders: sortedUniqueBy(channelValues(facts, "renders") as readonly RenderEdge[], (edge) => edge.file),
      nullGuards: sortedUnique(channelValues(facts, "nullGuards")),
      uses: sortedUnique(channelValues(facts, "uses")),
    }

    // Masking suppresses FACTS, never structure: the component stays in the tree and in `reachable`
    // so an agent still sees that it exists (§5.4).
    if (suppressed) return structural

    return {
      ...structural,
      hooks: sortedUnique(channelValues(facts, "hooks")),
      stores: sortedUnique(channelValues(facts, "stores")),
      queryKeys: sortedUnique(channelValues(facts, "queryKeys")),
      mutations: channelValues(facts, "mutations").reduce((total, value) => total + value, 0),
      endpoints: sortedUniqueBy(
        channelValues(facts, "endpoints") as readonly Endpoint[],
        (endpoint) => `${endpoint.method} ${endpoint.url}`,
      ),
      navigations: sortedUniqueBy(
        channelValues(facts, "navigations") as readonly Navigation[],
        navigationKey,
      ),
      i18nNamespaces: sortedUnique(channelValues(facts, "i18nNamespaces")),
      testIds: sortedUnique(channelValues(facts, "testIds")),
      formSchemas: sortedUnique(channelValues(facts, "formSchemas")),
      formFields: sortedUnique(channelValues(facts, "formFields")),
      featureGates: sortedUnique(channelValues(facts, "featureGates")),
      messages: sortedUnique(channelValues(facts, "messages")),
      extra: extraChannelsOf(facts),
    }
  }

  const factsOf = (file: string): FileFacts => {
    const key = `${file}|${masked.has(file) ? "masked" : "plain"}`
    const cached = projections.get(key)
    if (cached !== undefined) return cached

    const result = runFile(file)
    const projected = project(file, result?.facts ?? [])
    projections.set(key, projected)
    return projected
  }

  const subtreeFactsOf = (file: string, locator: NodeLocator): FileFacts | null => {
    const result = runFile(file)
    if (result === null) return null

    const source = env.sourceOf(file)
    const node: ts.Node | null = source === null ? null : env.ast.resolveLocator(source, locator)
    if (node === null) return null

    const outer: FactSpan = { pos: node.pos, end: node.end }
    return project(
      file,
      result.facts.filter((fact) => fact.origin === undefined && spanInside(fact.span, outer)),
    )
  }

  const countFacts = (matches: (fact: Fact) => boolean): number =>
    [...results.values()].reduce((total, result) => total + (result?.facts.filter(matches).length ?? 0), 0)

  return {
    factsOf,
    subtreeFactsOf,
    maskedComponents: () => [...masked.values()].sort(by((entry) => entry.file)),
    extractedFiles: () => sortStrings([...results.keys()]),
    diagnostics: () => [...diagnostics, ...unsupportedTemplateDiagnostics(env, [...unsupportedTemplates.values()])],
    channelCount: (channel) => countFacts((fact) => fact.channel === channel),
    extractorCount: (extractor) => countFacts((fact) => fact.extractor === extractor),
  }
}
