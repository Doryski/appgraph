import type { TypeScriptApi } from "./tsconfig.js"

/**
 * The compiler is a PEER dependency, so the version that actually loads is the host project's, not
 * ours. TypeScript 7 removed the JS API surface this package is written against (`readJsonConfigFile`
 * and `createSourceFile` are both `undefined` on 7.0.2), and an unbounded `>=5.0.0` range let npm's
 * peer auto-install resolve exactly that. The range below is the verified one: 5.0.4 and 6.0.3 both
 * produce byte-identical output.
 */
export const SUPPORTED_TYPESCRIPT_RANGE = ">=5.0.0 <7.0.0"

export const TYPESCRIPT_PACKAGE = "typescript"

/**
 * Every member this package reads off the injected api, so the guard fails on the same surface the
 * analysis would have failed on — not on a version string, which a fork or a nightly can carry
 * without meaning anything.
 *
 * Ordered by WHEN the run reaches them, not alphabetically: the message truncates, and the four
 * entry points below are the ones a user has already seen fail (`api.readJsonConfigFile is not a
 * function` is the reported symptom), so they have to survive the truncation.
 */
export const REQUIRED_COMPILER_FUNCTIONS = [
  "readJsonConfigFile",
  "parseJsonSourceFileConfigFileContent",
  "createSourceFile",
  "transpileModule",
  "canHaveDecorators",
  "canHaveModifiers",
  "flattenDiagnosticMessageText",
  "forEachChild",
  "getDecorators",
  "getLeadingCommentRanges",
  "getLineAndCharacterOfPosition",
  "getModifiers",
  "isArrayBindingPattern",
  "isArrayLiteralExpression",
  "isArrowFunction",
  "isAsExpression",
  "isAwaitExpression",
  "isBinaryExpression",
  "isBindingElement",
  "isBlock",
  "isCallExpression",
  "isCaseClause",
  "isClassDeclaration",
  "isConditionalExpression",
  "isElementAccessExpression",
  "isEnumDeclaration",
  "isExportAssignment",
  "isExpressionStatement",
  "isFunctionDeclaration",
  "isFunctionExpression",
  "isIdentifier",
  "isIfStatement",
  "isImportDeclaration",
  "isJsxAttribute",
  "isJsxElement",
  "isJsxExpression",
  "isJsxFragment",
  "isJsxOpeningElement",
  "isJsxSelfClosingElement",
  "isMethodDeclaration",
  "isNamedImports",
  "isNamespaceImport",
  "isNewExpression",
  "isNoSubstitutionTemplateLiteral",
  "isNonNullExpression",
  "isNumericLiteral",
  "isObjectBindingPattern",
  "isObjectLiteralExpression",
  "isParameter",
  "isParenthesizedExpression",
  "isPropertyAccessExpression",
  "isPropertyAssignment",
  "isReturnStatement",
  "isSatisfiesExpression",
  "isShorthandPropertyAssignment",
  "isSourceFile",
  "isSpreadElement",
  "isStringLiteral",
  "isStringLiteralLike",
  "isSwitchStatement",
  "isTemplateExpression",
  "isVariableDeclaration",
  "isVariableStatement",
] as const

/** The enum objects the code indexes by numeric value (`ModuleResolutionKind`, `JsxEmit`, …). */
export const REQUIRED_COMPILER_NAMESPACES = [
  "JsxEmit",
  "ModuleKind",
  "ModuleResolutionKind",
  "ScriptKind",
  "ScriptTarget",
  "SyntaxKind",
] as const

export type CompilerCheck =
  | { readonly kind: "supported"; readonly version: string }
  | { readonly kind: "not-installed"; readonly detail: string }
  | { readonly kind: "unsupported"; readonly version: string; readonly missing: readonly string[] }

const memberOf = (api: unknown, name: string): unknown =>
  typeof api === "object" && api !== null ? (api as Record<string, unknown>)[name] : undefined

export const UNKNOWN_VERSION = "unknown"

export const compilerVersionOf = (api: unknown): string => {
  const version = memberOf(api, "version")
  return typeof version === "string" && version !== "" ? version : UNKNOWN_VERSION
}

export const missingCompilerApis = (api: unknown): readonly string[] => [
  ...REQUIRED_COMPILER_FUNCTIONS.filter((name) => typeof memberOf(api, name) !== "function"),
  ...REQUIRED_COMPILER_NAMESPACES.filter((name) => typeof memberOf(api, name) !== "object"),
]

export const checkCompilerApi = (api: unknown): CompilerCheck => {
  const missing = missingCompilerApis(api)
  const version = compilerVersionOf(api)
  return missing.length === 0 ? { kind: "supported", version } : { kind: "unsupported", version, missing }
}

const INSTALL_LINES = [
  `  npm  install --save-dev "${TYPESCRIPT_PACKAGE}@${SUPPORTED_TYPESCRIPT_RANGE}"`,
  `  pnpm add -D "${TYPESCRIPT_PACKAGE}@${SUPPORTED_TYPESCRIPT_RANGE}"`,
  `  yarn add -D "${TYPESCRIPT_PACKAGE}@${SUPPORTED_TYPESCRIPT_RANGE}"`,
] as const

/** How many missing members to name before the message stops being readable. */
const MISSING_SHOWN = 5

const missingSummary = (missing: readonly string[]): string => {
  const shown = missing.slice(0, MISSING_SHOWN).join(", ")
  return missing.length <= MISSING_SHOWN ? shown : `${shown} (+${String(missing.length - MISSING_SHOWN)} more)`
}

export const compilerSupportMessage = (check: CompilerCheck): string | null => {
  if (check.kind === "supported") return null

  const head =
    check.kind === "not-installed"
      ? [
          `${TYPESCRIPT_PACKAGE} is a required peer dependency and could not be loaded from this project.`,
          `  required: ${TYPESCRIPT_PACKAGE}@${SUPPORTED_TYPESCRIPT_RANGE}`,
          `  found:    (not installed) — ${check.detail}`,
          "pnpm and yarn do not auto-install peer dependencies; add it explicitly:",
        ]
      : [
          `the loaded ${TYPESCRIPT_PACKAGE} does not expose the compiler API appgraph is written against.`,
          `  required: ${TYPESCRIPT_PACKAGE}@${SUPPORTED_TYPESCRIPT_RANGE}`,
          `  found:    ${TYPESCRIPT_PACKAGE}@${check.version}`,
          `  missing:  ${missingSummary(check.missing)}`,
          "Install a supported compiler in this project:",
        ]

  return [...head, ...INSTALL_LINES].join("\n")
}

export class UnsupportedCompilerError extends Error {
  readonly check: CompilerCheck

  constructor(check: CompilerCheck) {
    super(compilerSupportMessage(check) ?? "unsupported typescript")
    this.name = "UnsupportedCompilerError"
    this.check = check
  }
}

/**
 * Asserts before any analysis runs. A degraded compiler must never be worked around silently: the
 * output would be a map with holes in it and no way to tell which holes are the app's.
 */
export const assertCompilerSupported = (api: unknown): TypeScriptApi => {
  const check = checkCompilerApi(api)
  if (check.kind !== "supported") throw new UnsupportedCompilerError(check)
  return api as TypeScriptApi
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error"

export const importTypeScript = async (): Promise<unknown> => (await import("typescript")).default

export type LoadCompilerOptions = {
  readonly load?: () => Promise<unknown>
}

/** The single door the compiler enters through: import failure and API failure get one message shape. */
export const loadCompiler = async (options: LoadCompilerOptions = {}): Promise<TypeScriptApi> => {
  const load = options.load ?? importTypeScript
  const loaded = await load().catch((error: unknown) => {
    throw new UnsupportedCompilerError({ kind: "not-installed", detail: messageOf(error) })
  })
  return assertCompilerSupported(loaded)
}
