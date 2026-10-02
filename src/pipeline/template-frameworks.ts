import * as path from "node:path"
import type { FileHost } from "../core/host.js"
import type { Diagnostic } from "../core/model.js"
import type { PeerLoad, PeerSource } from "../core/peer-loader.js"
import { loadPeer, memberOf, nonEmptyString } from "../core/peer-loader.js"
import type {
  TemplateCompilerApis,
  TemplateCompilerResult,
  TemplateCompilerSet,
  TemplateCompilerStatus,
  TemplateFrameworkId,
  TemplateFrameworkSpec,
} from "../core/template-frameworks.js"
import type {
  TagResolution,
  TemplateDoc,
  TemplateElement,
  TemplateProducer,
  TemplateProducerEnv,
  TemplateSource,
  TemplateTagResolverFn,
} from "../core/template-doc.js"
import type { TypeScriptApi } from "../core/tsconfig.js"
import { EMPTY_TEMPLATE_TAGS } from "../core/template-doc.js"
import { judgeTemplateCompiler } from "../core/template-frameworks.js"
import { applicableFrameworks } from "../core/template-framework-ids.js"
import { VUE_TEMPLATE_FRAMEWORK } from "../core/vue-compiler.js"
import { createAngularTemplateFramework } from "../core/angular-compiler.js"
import { createAngularTemplateProducer } from "../adapters/angular/template.js"

const ANGULAR_TEMPLATE_FRAMEWORK = createAngularTemplateFramework((api, producerEnv) => {
  const { ts } = producerEnv
  const projectMajor = producerEnv.projectMajor ?? null
  if (ts === undefined) return null
  if (api === null && projectMajor === null) return null
  return createAngularTemplateProducer({ api, env: { ...producerEnv, ts }, projectMajor })
})

export const TEMPLATE_FRAMEWORKS: readonly TemplateFrameworkSpec<unknown>[] = [VUE_TEMPLATE_FRAMEWORK, ANGULAR_TEMPLATE_FRAMEWORK]

export const TEMPLATE_COMPILER_MISSING_CODE = "project/template-compiler-missing"

export const TEMPLATE_COMPILER_UNSUPPORTED_CODE = "project/template-compiler-unsupported"

export const EMPTY_TEMPLATE_COMPILERS: TemplateCompilerSet = { apis: {}, statuses: [], diagnostics: [] }

export type LoadTemplateCompilersInput = {
  readonly root: string
  readonly host: FileHost
  readonly dependencies: ReadonlySet<string>
  readonly files: readonly string[]
  readonly inject?: TemplateCompilerApis
  readonly frameworks?: readonly TemplateFrameworkSpec<unknown>[]
}

type ReplacedCompiler = { readonly version: string; readonly reason: string }

type Outcome = {
  readonly result: TemplateCompilerResult
  readonly api: unknown
  readonly replaced?: ReplacedCompiler
}

type SpecInput = {
  readonly root: string
  readonly projectMajor: number | null
  readonly option: unknown
}

const DISABLED: Outcome = { result: { kind: "missing", detail: "disabled by the caller" }, api: null }

const majorLabel = (major: number | null): string => (major === null ? "unknown" : `${String(major)}.x`)

const outcomeOfJudged = <Api>(judged: ReturnType<typeof judgeTemplateCompiler<Api>>): Outcome =>
  judged.kind === "loaded"
    ? { result: { kind: "loaded", version: judged.version, from: judged.from }, api: judged.api }
    : { result: judged, api: null }

const injectedOutcome = <Api>(spec: TemplateFrameworkSpec<Api>, input: SpecInput): Outcome =>
  outcomeOfJudged(
    judgeTemplateCompiler(
      spec,
      { module: input.option, version: nonEmptyString(memberOf(input.option, "version")), from: "project" },
      input.projectMajor,
    ),
  )

const isPeerLoad = (option: unknown): option is PeerLoad => typeof option === "function"

const loadedOutcome = async <Api>(
  spec: TemplateFrameworkSpec<Api>,
  input: SpecInput,
  sources: readonly PeerSource[] | undefined,
): Promise<Outcome> => {
  const peer = await loadPeer({
    root: input.root,
    packages: spec.packages,
    moduleKind: spec.moduleKind,
    ...(isPeerLoad(input.option) ? { load: input.option } : {}),
    ...(sources === undefined ? {} : { sources }),
  })
  if (peer.kind === "missing") return { result: peer, api: null }
  return outcomeOfJudged(judgeTemplateCompiler(spec, peer, input.projectMajor))
}

const peerOutcome = async <Api>(spec: TemplateFrameworkSpec<Api>, input: SpecInput): Promise<Outcome> => {
  const first = await loadedOutcome(spec, input, undefined)
  const retry = spec.fallbackOnUnsupported && first.result.kind === "unsupported"
  if (!retry) return first
  const fallback = await loadedOutcome(spec, input, ["appgraph"])
  if (fallback.result.kind !== "loaded" || first.result.kind !== "unsupported") return first
  return { ...fallback, replaced: { version: first.result.version, reason: first.result.reason } }
}

const outcomeOf = async <Api>(spec: TemplateFrameworkSpec<Api>, input: SpecInput): Promise<Outcome> => {
  const legacy = spec.checkVersion(null, input.projectMajor)
  if (legacy !== null) return { result: { kind: "unsupported", version: majorLabel(input.projectMajor), reason: legacy }, api: null }
  if (input.option === null) return DISABLED
  if (input.option !== undefined && !isPeerLoad(input.option)) return injectedOutcome(spec, input)
  return peerOutcome(spec, input)
}

const statusOf = (spec: TemplateFrameworkSpec<unknown>, result: TemplateCompilerResult): TemplateCompilerStatus => ({
  framework: spec.id,
  status: result.kind,
  version: result.kind === "missing" ? null : result.version,
  from: result.kind === "loaded" ? result.from : null,
})

const warning = (code: string, message: string): Diagnostic => ({ severity: "warning", code, message, plugin: null })

const skippedSuffix = (spec: TemplateFrameworkSpec<unknown>): string => (spec.skippedNote === "" ? "" : ` ${spec.skippedNote}`)

const missingMessage = (spec: TemplateFrameworkSpec<unknown>): string =>
  `${spec.label} compiler (${spec.packages[0]?.specifier ?? spec.id}) could not be loaded: template facts skipped; ${spec.installHint}.${skippedSuffix(spec)}`

const unsupportedMessage = (spec: TemplateFrameworkSpec<unknown>, version: string, reason: string): string =>
  `${spec.label} ${version} is ${reason}: template facts skipped.${skippedSuffix(spec)}`

const replacedMessage = (spec: TemplateFrameworkSpec<unknown>, replaced: ReplacedCompiler, version: string): string =>
  `${spec.label} ${replaced.version} in the project is ${replaced.reason}: templates are parsed with appgraph's own ${spec.label} compiler ${version} instead.`

const diagnosticsOf = (
  spec: TemplateFrameworkSpec<unknown>,
  result: TemplateCompilerResult,
  replaced: ReplacedCompiler | undefined,
): readonly Diagnostic[] => {
  if (result.kind === "loaded" && replaced !== undefined)
    return [warning(TEMPLATE_COMPILER_UNSUPPORTED_CODE, replacedMessage(spec, replaced, result.version))]
  if (result.kind === "loaded") return []
  if (result.kind === "missing") return [warning(TEMPLATE_COMPILER_MISSING_CODE, missingMessage(spec))]
  return [warning(TEMPLATE_COMPILER_UNSUPPORTED_CODE, unsupportedMessage(spec, result.version, result.reason))]
}

type FrameworkOutcome = Outcome & { readonly spec: TemplateFrameworkSpec<unknown> }

const setOf = (outcomes: readonly FrameworkOutcome[]): TemplateCompilerSet => ({
  apis: Object.fromEntries(outcomes.flatMap(({ spec, api }) => (api === null ? [] : [[spec.id, api]]))),
  statuses: outcomes.map(({ spec, result }) => statusOf(spec, result)),
  diagnostics: outcomes.flatMap(({ spec, result, replaced }) => diagnosticsOf(spec, result, replaced)),
})

export type ApplicableFrameworksInput = Pick<LoadTemplateCompilersInput, "dependencies" | "files" | "frameworks">

export const applicableTemplateFrameworks = (input: ApplicableFrameworksInput): readonly TemplateFrameworkSpec<unknown>[] =>
  applicableFrameworks(input.frameworks ?? TEMPLATE_FRAMEWORKS, { dependencies: input.dependencies, files: input.files })

export const loadTemplateCompilers = async (input: LoadTemplateCompilersInput): Promise<TemplateCompilerSet> => {
  const applicable = applicableTemplateFrameworks(input)
  if (applicable.length === 0) return EMPTY_TEMPLATE_COMPILERS
  const manifest = input.host.readFile(path.join(input.root, "package.json"))
  const outcomes = await Promise.all(
    applicable.map(async (spec) => ({
      spec,
      ...(await outcomeOf(spec, {
        root: input.root,
        projectMajor: manifest === null ? null : spec.projectMajor(manifest),
        option: input.inject?.[spec.id],
      })),
    })),
  )
  return setOf(outcomes)
}

export const templateApiOf = <Api>(apis: TemplateCompilerApis | undefined, spec: TemplateFrameworkSpec<Api>): Api | null => {
  const raw = apis?.[spec.id]
  return raw === undefined ? null : spec.adapt(raw)
}

export type TemplateSourceInput = {
  readonly apis: TemplateCompilerApis | undefined
  readonly readFile: (file: string) => string | null
  readonly ts?: TypeScriptApi
  readonly manifest?: string | null
  readonly ambient: (names: readonly string[]) => TagResolution | null
  readonly resolvers?: () => readonly TemplateTagResolverFn[]
  readonly frameworks?: readonly TemplateFrameworkSpec<unknown>[]
}

const projectMajorOf = (input: TemplateSourceInput, spec: TemplateFrameworkSpec<unknown>): number | null =>
  input.manifest === undefined || input.manifest === null ? null : spec.projectMajor(input.manifest)

const producerEnvOf = (input: TemplateSourceInput, spec: TemplateFrameworkSpec<unknown>): TemplateProducerEnv => ({
  readFile: input.readFile,
  ...(input.ts === undefined ? {} : { ts: input.ts }),
  projectMajor: projectMajorOf(input, spec),
})

const producersOf = (input: TemplateSourceInput): readonly TemplateProducer[] =>
  (input.frameworks ?? TEMPLATE_FRAMEWORKS).flatMap((spec) => {
    const producer = spec.producer(templateApiOf(input.apis, spec), producerEnvOf(input, spec))
    return producer === null ? [] : [producer]
  })

export const createTemplateSource = (input: TemplateSourceInput): TemplateSource => {
  const specs = input.frameworks ?? TEMPLATE_FRAMEWORKS
  const producers = producersOf(input)
  const cache = new Map<string, readonly TemplateDoc[]>()
  const claimantsOf = (file: string): readonly TemplateProducer[] => producers.filter((producer) => producer.claims(file))
  const specOf = (framework: TemplateFrameworkId) => specs.find((spec) => spec.id === framework)

  const templatesOf = (file: string): readonly TemplateDoc[] => {
    const cached = cache.get(file)
    if (cached !== undefined) return cached
    const docs = claimantsOf(file).flatMap((producer) => producer.docsOf(file))
    cache.set(file, docs)
    return docs
  }

  const componentNameOf = (file: string): string | null =>
    claimantsOf(file).reduce<string | null>((found, producer) => found ?? producer.componentNameOf?.(file) ?? null, null)

  const recordedResolution = (doc: TemplateDoc, element: TemplateElement): TagResolution | null =>
    (input.resolvers?.() ?? []).reduce<TagResolution | null>((found, resolver) => found ?? resolver(doc, element), null)

  const resolveTag = (doc: TemplateDoc, element: TemplateElement): TagResolution | null => {
    const producer = producers.find((candidate) => candidate.framework === doc.framework)
    return recordedResolution(doc, element) ?? producer?.resolveTag?.(doc, element) ?? input.ambient(element.names)
  }

  return {
    templatesOf,
    resolveTag,
    componentNameOf,
    tagsOf: (framework) => specOf(framework)?.tags ?? EMPTY_TEMPLATE_TAGS,
    labelOf: (framework) => specOf(framework)?.label ?? framework,
    claims: (file) => claimantsOf(file).length > 0,
  }
}
