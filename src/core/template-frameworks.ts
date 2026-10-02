import type { Diagnostic } from "./model.js"
import type { PeerModuleKind, PeerPackage, PeerSource } from "./peer-loader.js"
import { UNKNOWN_PEER_VERSION } from "./peer-loader.js"
import type { TemplateFrameworkId, TemplateProducer, TemplateProducerEnv, TemplateTags } from "./template-doc.js"

export { TEMPLATE_FRAMEWORK_IDS, type TemplateFrameworkId } from "./template-doc.js"

export type TemplateCompilerSource = PeerSource

export type TemplateCompilerResult =
  | {
      readonly kind: "loaded"
      readonly version: string
      readonly from: TemplateCompilerSource
    }
  | { readonly kind: "missing"; readonly detail: string }
  | {
      readonly kind: "unsupported"
      readonly version: string
      readonly reason: string
    }

export type TemplateCompilerStatus = {
  readonly framework: TemplateFrameworkId
  readonly status: TemplateCompilerResult["kind"]
  readonly version: string | null
  readonly from: TemplateCompilerSource | null
}

export type TemplateApplicability = {
  readonly dependencies: ReadonlySet<string>
  readonly files: readonly string[]
}

export type TemplateFrameworkSpec<Api> = {
  readonly id: TemplateFrameworkId
  readonly label: string
  readonly packages: readonly PeerPackage[]
  readonly moduleKind: PeerModuleKind
  readonly installHint: string
  readonly skippedNote: string
  readonly appliesTo: (input: TemplateApplicability) => boolean
  readonly projectMajor: (manifestText: string) => number | null
  readonly checkVersion: (version: string | null, projectMajor: number | null) => string | null
  readonly fallbackOnUnsupported: boolean
  readonly adapt: (module: unknown) => Api | null
  producer(api: Api | null, env: TemplateProducerEnv): TemplateProducer | null
  readonly tags: TemplateTags
}

export type TemplateCompilerApis = Partial<Record<TemplateFrameworkId, unknown>>

export type TemplateCompilerSet = {
  readonly apis: TemplateCompilerApis
  readonly statuses: readonly TemplateCompilerStatus[]
  readonly diagnostics: readonly Diagnostic[]
}

export type CandidateCompiler = {
  readonly module: unknown
  readonly version: string | null
  readonly from: TemplateCompilerSource
}

export type JudgedCompiler<Api> =
  | {
      readonly kind: "loaded"
      readonly api: Api
      readonly version: string
      readonly from: TemplateCompilerSource
    }
  | {
      readonly kind: "unsupported"
      readonly version: string
      readonly reason: string
    }

export const judgeTemplateCompiler = <Api>(
  spec: TemplateFrameworkSpec<Api>,
  candidate: CandidateCompiler,
  projectMajor: number | null,
): JudgedCompiler<Api> => {
  const version = candidate.version ?? UNKNOWN_PEER_VERSION
  const api = spec.adapt(candidate.module)
  if (api === null)
    return {
      kind: "unsupported",
      version,
      reason: `missing the expected ${spec.label} compiler API`,
    }
  const reason = spec.checkVersion(candidate.version, projectMajor)
  if (reason !== null) return { kind: "unsupported", version, reason }
  return { kind: "loaded", api, version, from: candidate.from }
}
