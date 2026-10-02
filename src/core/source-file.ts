import type ts from "typescript"
import type { TypeScriptApi } from "./tsconfig.js"
import type { ScriptLang, VirtualScript } from "./sfc.js"
import { virtualScript } from "./sfc.js"
import type { SFC_EXTENSIONS } from "./extensions.js"
import type { TemplateFrameworkId } from "./template-frameworks.js"

export type ScriptRegionSplitter = {
  readonly framework: TemplateFrameworkId
  readonly split: (text: string) => VirtualScript
}

export const SCRIPT_REGION_SPLITTERS: Readonly<Record<(typeof SFC_EXTENSIONS)[number], ScriptRegionSplitter>> = {
  ".vue": { framework: "vue", split: virtualScript },
}

export const scriptRegionSplitterOf = (file: string): ScriptRegionSplitter | null =>
  Object.entries(SCRIPT_REGION_SPLITTERS).find(([extension]) => file.endsWith(extension))?.[1] ?? null

export type ScriptSourceOptions = {
  readonly inferKind?: boolean
}

const kindOfLang = (api: TypeScriptApi, lang: ScriptLang): ts.ScriptKind => {
  const kinds = {
    ts: api.ScriptKind.TS,
    tsx: api.ScriptKind.TSX,
    js: api.ScriptKind.JS,
    jsx: api.ScriptKind.JSX,
  } as const satisfies Record<ScriptLang, ts.ScriptKind>
  return kinds[lang]
}

export const scriptKindFor = (api: TypeScriptApi, file: string): ts.ScriptKind => {
  if (file.endsWith("x")) return api.ScriptKind.TSX
  if (file.endsWith(".json")) return api.ScriptKind.JSON
  return api.ScriptKind.TS
}

const parse = (api: TypeScriptApi, abs: string, text: string, kind: ts.ScriptKind | undefined): ts.SourceFile =>
  api.createSourceFile(abs, text, api.ScriptTarget.ESNext, true, kind)

export const createScriptSource = (
  api: TypeScriptApi,
  abs: string,
  text: string,
  options: ScriptSourceOptions = {},
): ts.SourceFile => {
  const splitter = scriptRegionSplitterOf(abs)
  if (splitter !== null) {
    const script = splitter.split(text)
    return parse(api, abs, script.text, kindOfLang(api, script.lang))
  }
  return parse(api, abs, text, options.inferKind === true ? undefined : scriptKindFor(api, abs))
}
