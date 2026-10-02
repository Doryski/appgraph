import type { PeerLoad } from "./peer-loader.js"
import { loadPeerSync, memberOf, projectMajorOf } from "./peer-loader.js"
import type { TemplateCompilerSource, TemplateFrameworkSpec } from "./template-frameworks.js"
import { judgeTemplateCompiler } from "./template-frameworks.js"
import type { TemplateTags } from "./template-doc.js"
import { createVueTemplateProducer } from "./vue-template.js"
import type { VueCompiler } from "./vue-ast.js"

export { ElementTypes, NodeTypes, type VueCompiler } from "./vue-ast.js"

export const SUPPORTED_VUE_RANGE = ">=3.4.0 <4.0.0"

export const VUE_PACKAGE = "vue"

const SUPPORTED_MAJOR = 3
const MIN_SUPPORTED_MINOR = 4

export type VueModuleLoad = PeerLoad

export type VueCompilerResult =
  | {
      readonly kind: "loaded"
      readonly api: VueCompiler
      readonly version: string
      readonly from: TemplateCompilerSource
    }
  | { readonly kind: "missing"; readonly detail: string }
  | {
      readonly kind: "unsupported"
      readonly version: string
      readonly reason: string
    }

export type LoadVueCompilerOptions = {
  readonly root: string
  readonly load?: VueModuleLoad
}

const VUE_DEPENDENCIES = ["vue", "nuxt"] as const

const COMPILER_PACKAGES = [
  { specifier: "vue/compiler-sfc", manifest: "vue/package.json" },
  {
    specifier: "@vue/compiler-sfc",
    manifest: "@vue/compiler-sfc/package.json",
  },
] as const

const VERSION_PATTERN = /^v?(\d+)\.(\d+)/

export const isSupportedVueVersion = (version: string): boolean => {
  const match = VERSION_PATTERN.exec(version.trim())
  if (!match) return false
  return Number(match[1]) === SUPPORTED_MAJOR && Number(match[2]) >= MIN_SUPPORTED_MINOR
}

export const projectVueMajor = (manifestText: string): number | null => projectMajorOf(manifestText, VUE_PACKAGE)

const OUTSIDE_RANGE = `outside the supported range ${SUPPORTED_VUE_RANGE}`

const checkVueVersion = (version: string | null, projectMajor: number | null): string | null => {
  if (projectMajor !== null && projectMajor < SUPPORTED_MAJOR) return OUTSIDE_RANGE
  if (version === null) return null
  return isSupportedVueVersion(version) ? null : OUTSIDE_RANGE
}

const isVueCompiler = (module: unknown): module is VueCompiler => typeof memberOf(module, "parse") === "function"

const adaptVueCompiler = (module: unknown): VueCompiler | null => (isVueCompiler(module) ? module : null)

export const VUE_TEMPLATE_TAGS: TemplateTags = {
  outlets: [
    ["RouterView", "router-view"],
    ["NuxtPage", "nuxt-page"],
    ["NuxtLayout", "nuxt-layout"],
  ],
  outletNameAttribute: "name",
  childrenSlot: { tag: "slot", selectAttribute: "name" },
  namedSlot: { tag: "slot", nameAttribute: "name" },
  builtins: [
    "RouterView",
    "RouterLink",
    "NuxtPage",
    "NuxtLayout",
    "NuxtLink",
    "Transition",
    "TransitionGroup",
    "KeepAlive",
    "Teleport",
    "Suspense",
    "Component",
    "Slot",
    "Template",
  ],
  linkTags: ["RouterLink", "NuxtLink"],
  linkAttributes: [],
  targetAttributes: ["to", "href"],
}

export const VUE_TEMPLATE_FRAMEWORK: TemplateFrameworkSpec<VueCompiler> = {
  id: "vue",
  label: "Vue",
  packages: COMPILER_PACKAGES,
  moduleKind: "cjs",
  installHint: `install vue in the project (e.g. \`pnpm add -D vue@^3.4\`, supported: ${SUPPORTED_VUE_RANGE})`,
  skippedNote: "<script> blocks of .vue files are still analyzed.",
  appliesTo: ({ dependencies }) => VUE_DEPENDENCIES.some((name) => dependencies.has(name)),
  projectMajor: projectVueMajor,
  checkVersion: checkVueVersion,
  fallbackOnUnsupported: false,
  adapt: adaptVueCompiler,
  producer: (compiler, env) => (compiler === null ? null : createVueTemplateProducer({ compiler, env, tags: VUE_TEMPLATE_TAGS })),
  tags: VUE_TEMPLATE_TAGS,
}

export const loadVueCompiler = (options: LoadVueCompilerOptions): VueCompilerResult => {
  const spec = VUE_TEMPLATE_FRAMEWORK
  const peer = loadPeerSync({
    root: options.root,
    packages: spec.packages,
    ...(options.load === undefined ? {} : { load: options.load }),
  })
  if (peer.kind === "missing") return peer
  return judgeTemplateCompiler(spec, peer, null)
}
