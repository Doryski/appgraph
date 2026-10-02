import { memberOf, projectMajorOf } from "./peer-loader.js"
import type { TemplateFrameworkSpec } from "./template-frameworks.js"
import type { TemplateProducer, TemplateProducerEnv, TemplateTags } from "./template-doc.js"

export const ANGULAR_COMPILER_PACKAGE = "@angular/compiler"

export const ANGULAR_CORE_PACKAGE = "@angular/core"

export const MIN_ANGULAR_COMPILER_MAJOR = 14

export const SUPPORTED_ANGULAR_RANGE = `>=${String(MIN_ANGULAR_COMPILER_MAJOR)}.0.0`

const BLOCK_SYNTAX_MAJOR = 17


export type AngularParseOptions = {
  readonly preserveWhitespaces: boolean
  readonly enableBlockSyntax: boolean
  readonly enableLetSyntax: boolean
}

export type AngularParseError = { readonly msg: string }

export type AngularParsedTemplate = {
  readonly errors: readonly AngularParseError[] | null
  readonly nodes: readonly unknown[]
}

export type AngularParseTemplate = (template: string, templateUrl: string, options: AngularParseOptions) => AngularParsedTemplate

export type AngularCssSelector = object

export type AngularCssSelectorClass = {
  parse(selector: string): AngularCssSelector[]
}

export type AngularSelectorMatcher<Context> = {
  addSelectables(selectors: readonly AngularCssSelector[], context: Context): void
  match(selector: AngularCssSelector, callback: (selector: AngularCssSelector, context: Context) => void): boolean
}

export type AngularSelectorMatcherClass = new <Context>() => AngularSelectorMatcher<Context>

export type AngularCreateCssSelectorFromNode = (node: unknown) => AngularCssSelector

export type AngularCompiler = {
  readonly parseTemplate: AngularParseTemplate
  readonly CssSelector: AngularCssSelectorClass
  readonly SelectorMatcher: AngularSelectorMatcherClass
  readonly createCssSelectorFromNode: AngularCreateCssSelectorFromNode | null
  readonly VERSION?: { readonly full: string }
}

const isParseTemplate = (value: unknown): value is AngularParseTemplate => typeof value === "function"

const isCssSelectorClass = (value: unknown): value is AngularCssSelectorClass =>
  typeof value === "function" && "parse" in value && typeof value.parse === "function"

const isSelectorMatcherClass = (value: unknown): value is AngularSelectorMatcherClass => typeof value === "function"

const isCreateCssSelectorFromNode = (value: unknown): value is AngularCreateCssSelectorFromNode => typeof value === "function"

const isVersionInfo = (value: unknown): value is { readonly full: string } => typeof memberOf(value, "full") === "string"

const versionInfoOf = (module: unknown): Pick<AngularCompiler, "VERSION"> => {
  const version = memberOf(module, "VERSION")
  return isVersionInfo(version) ? { VERSION: { full: version.full } } : {}
}

export const adaptAngularCompiler = (module: unknown): AngularCompiler | null => {
  const parseTemplate = memberOf(module, "parseTemplate")
  const cssSelector = memberOf(module, "CssSelector")
  const selectorMatcher = memberOf(module, "SelectorMatcher")
  if (!isParseTemplate(parseTemplate) || !isCssSelectorClass(cssSelector) || !isSelectorMatcherClass(selectorMatcher)) return null
  const createCssSelectorFromNode = memberOf(module, "createCssSelectorFromNode")
  return {
    parseTemplate,
    CssSelector: cssSelector,
    SelectorMatcher: selectorMatcher,
    createCssSelectorFromNode: isCreateCssSelectorFromNode(createCssSelectorFromNode) ? createCssSelectorFromNode : null,
    ...versionInfoOf(module),
  }
}

const MAJOR_PATTERN = /^v?(\d+)\./

const majorOfVersion = (version: string): number | null => {
  const match = MAJOR_PATTERN.exec(version.trim())
  return match ? Number(match[1]) : null
}

const BELOW_MINIMUM = `outside the supported range ${SUPPORTED_ANGULAR_RANGE}`

export const checkAngularVersion = (version: string | null): string | null => {
  if (version === null) return null
  const major = majorOfVersion(version)
  if (major === null) return null
  return major < MIN_ANGULAR_COMPILER_MAJOR ? BELOW_MINIMUM : null
}

export const projectAngularMajor = (manifestText: string): number | null => projectMajorOf(manifestText, ANGULAR_CORE_PACKAGE)

const atLeast = (projectMajor: number | null, minimum: number): boolean => projectMajor === null || projectMajor >= minimum

export const angularParseOptions = (projectMajor: number | null): AngularParseOptions => {
  const blockSyntax = atLeast(projectMajor, BLOCK_SYNTAX_MAJOR)
  return { preserveWhitespaces: false, enableBlockSyntax: blockSyntax, enableLetSyntax: blockSyntax }
}

export const ANGULAR_TEMPLATE_TAGS: TemplateTags = {
  outlets: [["router-outlet", "RouterOutlet"]],
  outletNameAttribute: "name",
  childrenSlot: { tag: "ng-content", selectAttribute: "select" },
  namedSlot: { tag: "ng-content", nameAttribute: "select" },
  builtins: ["ng-container", "ng-template", "ng-content", "router-outlet", "RouterOutlet"],
  linkTags: [],
  linkAttributes: ["routerLink"],
  targetAttributes: ["routerLink"],
}

const COMPILER_PACKAGES = [
  { specifier: ANGULAR_COMPILER_PACKAGE, manifest: `${ANGULAR_COMPILER_PACKAGE}/package.json` },
] as const

export type AngularTemplateProducerFactory = (compiler: AngularCompiler | null, env: TemplateProducerEnv) => TemplateProducer | null

export const createAngularTemplateFramework = (
  producer: AngularTemplateProducerFactory,
): TemplateFrameworkSpec<AngularCompiler> => ({
  id: "angular",
  label: "Angular",
  packages: COMPILER_PACKAGES,
  moduleKind: "esm",
  installHint: `install @angular/compiler in the project (e.g. \`pnpm add -D @angular/compiler\`, supported: ${SUPPORTED_ANGULAR_RANGE})`,
  skippedNote: "Routes and <router-outlet> layouts are still mapped.",
  appliesTo: ({ dependencies }) => dependencies.has(ANGULAR_CORE_PACKAGE),
  projectMajor: projectAngularMajor,
  checkVersion: checkAngularVersion,
  fallbackOnUnsupported: true,
  adapt: adaptAngularCompiler,
  producer,
  tags: ANGULAR_TEMPLATE_TAGS,
})

export const ANGULAR_TEMPLATE_FRAMEWORK = createAngularTemplateFramework(() => null)
