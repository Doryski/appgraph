import type { Diagnostic } from "../../core/model.js"
import { by } from "../../core/order.js"
import { scriptRegionSplitterOf } from "../../core/source-file.js"
import type { TemplateDoc } from "../../core/template-doc.js"
import type { TemplateFrameworkId } from "../../core/template-frameworks.js"
import { TEMPLATE_FRAMEWORK_IDS } from "../../core/template-frameworks.js"
import type { PipelineEnv } from "../context.js"

const UNSUPPORTED_TEMPLATE_SHOWN = 5

export type UnsupportedTemplate = {
  readonly framework: TemplateFrameworkId
  readonly file: string
  readonly features: readonly string[]
}

type UnsupportedFeatureAt = {
  readonly framework: TemplateFrameworkId
  readonly file: string
  readonly feature: string
}

export const scriptFeaturesOf = (env: PipelineEnv, file: string): readonly UnsupportedFeatureAt[] => {
  const splitter = scriptRegionSplitterOf(file)
  const text = splitter === null ? null : env.host.readFile(env.paths.abs(file))
  if (splitter === null || text === null) return []
  return splitter.split(text).unsupported.map((feature) => ({ framework: splitter.framework, file, feature }))
}

export const templateFeaturesOf = (docs: readonly TemplateDoc[]): readonly UnsupportedFeatureAt[] =>
  docs.flatMap((doc) => doc.unsupported.map((feature) => ({ framework: doc.framework, file: doc.file, feature })))

export const unsupportedKey = (entry: Pick<UnsupportedTemplate, "framework" | "file">): string => `${entry.framework}\u0000${entry.file}`

const unsupportedTemplateDiagnostic = (label: string, entries: readonly UnsupportedTemplate[]): Diagnostic => {
  const sorted = [...entries].sort(by((entry) => entry.file))
  const shown = sorted
    .slice(0, UNSUPPORTED_TEMPLATE_SHOWN)
    .map((entry) => `${entry.file} (${entry.features.join(", ")})`)
    .join(", ")
  const more =
    sorted.length > UNSUPPORTED_TEMPLATE_SHOWN ? ` (+${String(sorted.length - UNSUPPORTED_TEMPLATE_SHOWN)} more)` : ""
  return {
    severity: "info",
    code: "facts/unsupported-template",
    message: `${label} templates in ${String(sorted.length)} file(s) use features appgraph cannot read; their facts are partial: ${shown}${more}`,
    plugin: null,
  }
}

export const unsupportedTemplateDiagnostics = (
  env: PipelineEnv,
  entries: readonly UnsupportedTemplate[],
): readonly Diagnostic[] =>
  TEMPLATE_FRAMEWORK_IDS.flatMap((framework) => {
    const own = entries.filter((entry) => entry.framework === framework)
    return own.length === 0 ? [] : [unsupportedTemplateDiagnostic(env.templates.labelOf(framework), own)]
  })
