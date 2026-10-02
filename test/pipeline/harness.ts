import ts from "typescript"
import { createMemoryHost } from "../../src/core/host.js"
import type { AppgraphConfig, Evidence } from "../../src/core/model.js"
import { resolveConfig } from "../../src/config/types.js"
import type { SourceDetection } from "../../src/config/types.js"
import type { Adapter, ScreenDraft, ScreenSource } from "../../src/adapters/types.js"
import type { FactExtractor } from "../../src/extractors/types.js"
import type { PipelineResult } from "../../src/pipeline/run.js"
import type { TemplateCompilerSet } from "../../src/core/template-frameworks.js"
import { runPipeline } from "../../src/pipeline/run.js"

export const ROOT = "/repo"

export const TSCONFIG = JSON.stringify({
  compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
  include: ["src"],
})

export const PACKAGE_JSON = JSON.stringify({
  name: "fixture",
  dependencies: { react: "19.0.0", "react-router-dom": "6.0.0" },
})

export const withProject = (files: Readonly<Record<string, string>>): Record<string, string> => ({
  [`${ROOT}/package.json`]: PACKAGE_JSON,
  [`${ROOT}/tsconfig.json`]: TSCONFIG,
  ...Object.fromEntries(Object.entries(files).map(([file, content]) => [`${ROOT}/${file}`, content])),
})

export type RunOptions = {
  readonly files: Readonly<Record<string, string>>
  readonly adapters?: readonly Adapter[]
  readonly extractors?: readonly FactExtractor[]
  readonly config?: AppgraphConfig
  readonly detections?: readonly SourceDetection[]
  readonly formats?: readonly string[]
  readonly refusal?: string | null
  readonly templates?: TemplateCompilerSet
}

export const run = (options: RunOptions): PipelineResult =>
  runPipeline({
    ts,
    host: createMemoryHost({ files: withProject(options.files) }),
    config: resolveConfig({
      root: ROOT,
      appgraphVersion: "0.1.0-test",
      formats: options.formats ?? ["full"],
      ...(options.config === undefined ? {} : { config: options.config }),
      ...(options.detections === undefined ? {} : { detections: options.detections }),
    }),
    adapters: options.adapters ?? [],
    ...(options.extractors === undefined ? {} : { extractors: options.extractors }),
    ...(options.refusal === undefined ? {} : { refusal: options.refusal }),
    ...(options.templates === undefined ? {} : { templates: options.templates }),
  })

export const evidence = (file: string): Evidence => ({ what: "fixture", file, line: 1 })

/** A screen source that hands back a fixed list of drafts — for normalize/conflict tests. */
export const staticSource = (name: string, drafts: readonly ScreenDraft[]): ScreenSource => ({
  name,
  detect: () => ({ score: 100, evidence: [] }),
  discover: () => drafts,
})

export const adapterFor = (...sources: readonly ScreenSource[]): Adapter => ({
  name: sources[0]?.name ?? "test-adapter",
  screens: sources,
})

export const fileOf = (result: PipelineResult, path: string): string =>
  result.files.find((file) => file.path === path)?.content ?? ""

export const codes = (result: PipelineResult): readonly string[] =>
  result.diagnostics.map((diagnostic) => diagnostic.code)
