import { tmpdir } from "node:os"
import ts from "typescript"
import { createScriptSource } from "../../src/core/source-file.js"
import type { VueCompiler } from "../../src/core/vue-compiler.js"
import { VUE_TEMPLATE_TAGS, loadVueCompiler } from "../../src/core/vue-compiler.js"
import { templateDocOf } from "../../src/core/vue-template.js"
import type { TemplateTagResolver } from "../../src/extractors/types.js"
import { createExtractContext, createRegistry } from "../../src/extractors/registry.js"
import type { ExtractionResult, RegistryOptions } from "../../src/extractors/registry.js"
import type { FactChannel } from "../../src/core/model.js"
import type { FactExtractor, FactValue } from "../../src/extractors/types.js"
import { channelValues } from "../../src/extractors/types.js"

export const ROOT = "/repo"

export type RunOptions = {
  readonly file?: string
  readonly resolveModule?: (specifier: string) => string | null
  readonly normalizeUrl?: (raw: string) => string
  readonly registry?: Omit<RegistryOptions, "extractors">
  /**
   * Other modules an extractor may read through `ctx.resolve.sourceFile`, keyed by ABSOLUTE path.
   * They exist only here — nothing is written to disk — which is what proves a cross-file extractor
   * goes through the injected capability rather than the real filesystem.
   */
  readonly sources?: Readonly<Record<string, string>>
}

export const parse = (code: string, file = "src/File.tsx"): ts.SourceFile =>
  ts.createSourceFile(`${ROOT}/${file}`, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)

export const relative = (abs: string): string =>
  abs.startsWith(`${ROOT}/`) ? abs.slice(ROOT.length + 1) : abs

export const run = (
  extractors: readonly FactExtractor[],
  code: string,
  options: RunOptions = {},
): ExtractionResult => {
  const file = options.file ?? "src/File.tsx"
  const source = parse(code, file)
  const registry = createRegistry({ extractors, ...(options.registry ?? {}) })
  const sources = options.sources ?? {}

  const input = createExtractContext({
    ts,
    file,
    source,
    resolve: {
      declarationFile: (abs) => abs,
      relative,
      resolveModule: () => null,
      sourceFile: (abs) => {
        const text = sources[abs]
        return text === undefined
          ? null
          : ts.createSourceFile(
              abs,
              text,
              ts.ScriptTarget.ESNext,
              true,
              abs.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
            )
      },
    },
    ...(options.resolveModule === undefined ? {} : { resolveModule: options.resolveModule }),
    ...(options.normalizeUrl === undefined ? {} : { normalizeUrl: options.normalizeUrl }),
  })

  return registry.run(input)
}

export const valuesOf = <C extends FactChannel>(
  result: ExtractionResult,
  channel: C,
): readonly FactValue<C>[] => channelValues(result.facts, channel)

export const maskedValuesOf = <C extends FactChannel>(
  result: ExtractionResult,
  channel: C,
): readonly FactValue<C>[] => channelValues(result.masked.map((entry) => entry.fact), channel)

// Local modules resolve to `<ROOT>/<specifier-without-alias>.tsx`, which is enough for the
// component-tree extractor to produce project-relative render edges in tests.
export const localModules = (specifier: string): string | null =>
  specifier.startsWith(".") || specifier.startsWith("@/")
    ? `${ROOT}/src/${specifier.replace(/^\.\//, "").replace(/^@\//, "")}.tsx`
    : null

export type RunVueOptions = {
  readonly file?: string
  readonly compiler?: VueCompiler | null
  readonly resolveModule?: (specifier: string) => string | null
  readonly resolveTag?: TemplateTagResolver
  readonly registry?: Omit<RegistryOptions, "extractors">
}

export const realVueCompiler = (): VueCompiler => {
  const loaded = loadVueCompiler({ root: tmpdir() })
  if (loaded.kind !== "loaded") throw new Error(`vue devDependency did not load: ${loaded.kind}`)
  return loaded.api
}

const compilerOf = (options: RunVueOptions): VueCompiler | null =>
  options.compiler === undefined ? realVueCompiler() : options.compiler

export const runVue = (
  extractors: readonly FactExtractor[],
  sfcText: string,
  options: RunVueOptions = {},
): ExtractionResult => {
  const file = options.file ?? "src/File.vue"
  const source = createScriptSource(ts, `${ROOT}/${file}`, sfcText)
  const compiler = compilerOf(options)
  const registry = createRegistry({ extractors, ...(options.registry ?? {}) })

  const input = createExtractContext({
    ts,
    file,
    source,
    templates: compiler === null ? [] : [templateDocOf(compiler, sfcText, file)],
    tagsOf: () => VUE_TEMPLATE_TAGS,
    ...(options.resolveModule === undefined ? {} : { resolveModule: options.resolveModule }),
    ...(options.resolveTag === undefined ? {} : { resolveTag: options.resolveTag }),
  })

  return registry.run(input)
}
