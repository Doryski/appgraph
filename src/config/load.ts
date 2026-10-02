import * as fs from "node:fs"
import * as nodeModule from "node:module"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import type { AppgraphConfig, Diagnostic, ExtensionRewrite, KindRule, MenuSpec, NavFieldMap } from "../core/model.js"
import { ROUTE_DIALECT_FIELDS } from "../core/model.js"
import type { FileHost } from "../core/host.js"
import { createNodeHost, toPosix } from "../core/host.js"
import { byNumber, sortStrings } from "../core/order.js"
import type { TypeScriptApi } from "../core/tsconfig.js"
import { loadCompiler } from "../core/compiler-support.js"

/** Probed in this order; the first that exists wins (§15.2). */
export const CONFIG_BASENAMES = [
  "appgraph.config.ts",
  "appgraph.config.mts",
  "appgraph.config.mjs",
  "appgraph.config.js",
] as const

/**
 * The limitation §15.2 requires to be stated wherever it bites: `transpileModule` is a single-file
 * transform with NO module resolution. The transpiled file is written NEXT TO the config, so relative
 * and bare imports resolve exactly as they would from the config itself.
 */
export const CONFIG_IMPORT_LIMITATION =
  "an appgraph config may import only 'appgraph', node builtins and plain .js/.mjs files — not other .ts files, path-aliased modules, or JSON"

export const TRANSPILED_EXTENSIONS = [".ts", ".mts", ".cts"] as const

export type ConfigLoaderIo = {
  readonly writeFile: (abs: string, content: string) => void
  readonly rm: (abs: string) => void
  readonly importModule: (specifier: string) => Promise<unknown>
}

export const nodeConfigLoaderIo: ConfigLoaderIo = {
  writeFile: (abs, content) => {
    fs.writeFileSync(abs, content, { encoding: "utf8", flag: "wx" })
  },
  rm: (abs) => {
    fs.rmSync(abs, { force: true, recursive: true })
  },
  importModule: (specifier) => import(specifier) as Promise<unknown>,
}

export const findConfigFile = (host: FileHost, root: string): string | null => {
  for (const basename of CONFIG_BASENAMES) if (host.isFile(path.join(root, basename))) return basename
  return null
}

// ---------------------------------------------------------------------------
// Structural validation. The module comes back as `unknown`; every field crosses in behind a guard.
// ---------------------------------------------------------------------------

type Issue = { readonly field: string; readonly message: string }

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")

const KIND_MATCH_FIELDS = ["pathPrefix", "pathRegex", "fileRegex"] as const

const KIND_REGEX_FIELDS = ["pathRegex", "fileRegex"] as const

const isOptionalFiniteNumber = (value: unknown): boolean =>
  value === undefined || (typeof value === "number" && Number.isFinite(value))

const isKindRule = (value: unknown): value is KindRule => {
  const record = asRecord(value)
  if (record === null) return false
  const match = asRecord(record["match"])
  return (
    match !== null &&
    optionalStrings(match, KIND_MATCH_FIELDS) &&
    typeof record["kind"] === "string" &&
    typeof record["traversable"] === "boolean" &&
    typeof record["screenEntry"] === "boolean" &&
    isOptionalFiniteNumber(record["priority"])
  )
}

const regexError = (pattern: unknown): string | null => {
  if (typeof pattern !== "string") return null
  try {
    new RegExp(pattern)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const invalidRegexIssue = (location: string, pattern: unknown): string | null => {
  const error = regexError(pattern)
  return error === null ? null : `${location} to be a valid regular expression (${error})`
}

const kindRuleRegexIssue = (rule: KindRule, index: number): string | null =>
  KIND_REGEX_FIELDS.map((key) => invalidRegexIssue(`kindRules[${String(index)}].match.${key}`, rule.match[key])).find(
    (issue) => issue !== null,
  ) ?? null

const isExtensionRewrite = (value: unknown): value is ExtensionRewrite => {
  const record = asRecord(value)
  return record !== null && typeof record["from"] === "string" && isStringArray(record["to"])
}

const NAV_FIELD_KEYS = ["target", "title", "label", "labelKey", "group", "parent", "flag", "icon"] as const satisfies readonly (keyof NavFieldMap)[]

const isNavFieldMap = (value: unknown): boolean => {
  const record = asRecord(value)
  return record !== null && unknownKeys(record, NAV_FIELD_KEYS).length === 0 && optionalStrings(record, NAV_FIELD_KEYS)
}

const isMenuSpec = (value: unknown): value is MenuSpec => {
  const record = asRecord(value)
  return (
    record !== null &&
    typeof record["file"] === "string" &&
    typeof record["export"] === "string" &&
    optionalStrings(record, ["name", "basePath"]) &&
    (record["fields"] === undefined || isNavFieldMap(record["fields"]))
  )
}

const isRedirectRuleSpec = (value: unknown): boolean => {
  const record = asRecord(value)
  return record !== null && typeof record["source"] === "string" && typeof record["destination"] === "string"
}

const CONFLICT_POLICIES = ["merge", "first", "error"] as const

const isConflictPolicy = (value: unknown): value is (typeof CONFLICT_POLICIES)[number] =>
  typeof value === "string" && (CONFLICT_POLICIES as readonly string[]).includes(value)

type FieldReader = (value: unknown) => { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly expected: string }

const ok = (value: unknown) => ({ ok: true, value }) as const

const fail = (expected: string) => ({ ok: false, expected }) as const

const stringField: FieldReader = (value) => (typeof value === "string" ? ok(value) : fail("a string"))

const booleanField: FieldReader = (value) => (typeof value === "boolean" ? ok(value) : fail("a boolean"))

const numberField: FieldReader = (value) =>
  typeof value === "number" && Number.isFinite(value) ? ok(value) : fail("a finite number")

const stringArrayField: FieldReader = (value) => (isStringArray(value) ? ok(value) : fail("an array of strings"))

const arrayOf =
  (guard: (entry: unknown) => boolean, expected: string): FieldReader =>
  (value) =>
    Array.isArray(value) && value.every(guard) ? ok(value) : fail(expected)

const checkedArrayOf =
  <T>(guard: (entry: unknown) => entry is T, expected: string, issueOf: (entry: T, index: number) => string | null): FieldReader =>
  (value) => {
    if (!Array.isArray(value) || !value.every(guard)) return fail(expected)
    const issue = value.map((entry: T, index) => issueOf(entry, index)).find((entry) => entry !== null) ?? null
    return issue === null ? ok(value) : fail(issue)
  }

const redirectsField: FieldReader = (value) => {
  const record = asRecord(value)
  if (record === null) return fail("an object")
  for (const key of ["unauthenticated", "flagOff"])
    if (record[key] !== undefined && typeof record[key] !== "string") return fail(`'${key}' to be a string`)
  return ok(record)
}

const WRAPPER_ROLE_KINDS = ["layout", "guard", "errorBoundary", "redirect", "transparent"] as const

const PATHLESS_AUTH = ["protected", "public"] as const

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value)

const optionalStrings = (record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  keys.every((key) => record[key] === undefined || typeof record[key] === "string")

const isWrapperRule = (value: unknown): value is Readonly<Record<string, unknown>> => {
  const record = asRecord(value)
  return (
    record !== null &&
    typeof record["name"] === "string" &&
    isOneOf(WRAPPER_ROLE_KINDS, record["role"]) &&
    optionalStrings(record, ["tagRegex", "exported", "importedFrom", "reads", "entryFrom"])
  )
}

const wrapperRuleRegexIssue = (rule: Readonly<Record<string, unknown>>, index: number): string | null =>
  invalidRegexIssue(`wrapperRoles[${String(index)}].tagRegex`, rule["tagRegex"])

const isHolderSpec = (value: unknown): boolean => {
  const record = asRecord(value)
  return record !== null && typeof record["file"] === "string" && optionalStrings(record, ["exportName"])
}

const isPathlessRole = (value: unknown): boolean => {
  const record = asRecord(value)
  return record !== null && (record["auth"] === undefined || isOneOf(PATHLESS_AUTH, record["auth"]))
}

const pathlessRolesField: FieldReader = (value) => {
  const record = asRecord(value)
  const expected = "a record of { auth?: 'protected' | 'public' } keyed by pathless segment"
  if (record === null) return fail(expected)
  return Object.values(record).every(isPathlessRole) ? ok(record) : fail(expected)
}

export const ADMINJS_FIELDS = ["optionsFile", "componentLoaderFile"] as const

const quoted = (keys: readonly string[]): readonly string[] => keys.map((key) => `'${key}'`)

const quotedList = (keys: readonly string[]): string => {
  const all = quoted(keys)
  const last = all.at(-1) ?? ""
  return all.length < 2 ? last : `${all.slice(0, -1).join(", ")} and ${last}`
}

const unknownKeys = (record: Readonly<Record<string, unknown>>, known: readonly string[]): readonly string[] =>
  Object.keys(record).filter((key) => !isOneOf(known, key))

const onlyKeysMessage = (known: readonly string[], unknown: readonly string[]): string =>
  `only ${quotedList(known)} (got ${quoted(unknown).join(", ")})`

const adminjsField: FieldReader = (value) => {
  const record = asRecord(value)
  if (record === null) return fail("an object")
  const unknown = unknownKeys(record, ADMINJS_FIELDS)
  if (unknown.length > 0) return fail(onlyKeysMessage(ADMINJS_FIELDS, unknown))
  return optionalStrings(record, ADMINJS_FIELDS) ? ok(record) : fail("string paths")
}

export const VUE_AUTH_FIELDS = ["protectedMiddleware", "publicMiddleware", "authMetaKeys"] as const

const stringListsField =
  (fields: readonly string[]): FieldReader =>
  (value) => {
    const record = asRecord(value)
    if (record === null) return fail("an object")
    const unknown = unknownKeys(record, fields)
    if (unknown.length > 0) return fail(onlyKeysMessage(fields, unknown))
    const valid = fields.every((key) => record[key] === undefined || isStringArray(record[key]))
    return valid ? ok(record) : fail("arrays of strings")
  }

const vueAuthField = stringListsField(VUE_AUTH_FIELDS)

export const EXPO_ROUTER_FIELDS = ["root"] as const

const expoRouterField: FieldReader = (value) => {
  const record = asRecord(value)
  if (record === null) return fail("an object")
  const unknown = unknownKeys(record, EXPO_ROUTER_FIELDS)
  if (unknown.length > 0) return fail(onlyKeysMessage(EXPO_ROUTER_FIELDS, unknown))
  return optionalStrings(record, EXPO_ROUTER_FIELDS) ? ok(record) : fail("'root' to be a string")
}

export const REACT_NAVIGATION_FIELDS = ["pathTables", "authOptionKeys"] as const

const PATH_TABLE_FIELDS = ["callee", "argument"] as const

const isPathTableSpec = (value: unknown): boolean => {
  const record = asRecord(value)
  if (record === null || unknownKeys(record, PATH_TABLE_FIELDS).length > 0) return false
  const argument = record["argument"]
  return typeof record["callee"] === "string" && Number.isInteger(argument) && Number(argument) >= 0
}

const reactNavigationField: FieldReader = (value) => {
  const record = asRecord(value)
  if (record === null) return fail("an object")
  const unknown = unknownKeys(record, REACT_NAVIGATION_FIELDS)
  if (unknown.length > 0) return fail(onlyKeysMessage(REACT_NAVIGATION_FIELDS, unknown))
  const keys = record["authOptionKeys"]
  if (keys !== undefined && !isStringArray(keys)) return fail("'authOptionKeys' to be an array of strings")
  const tables = record["pathTables"]
  const tablesValid = tables === undefined || (Array.isArray(tables) && tables.every(isPathTableSpec))
  return tablesValid ? ok(record) : fail("'pathTables' to be an array of { callee: string, argument: non-negative integer }")
}

export const NATIVE_AUTH_FIELDS = ["signedIn"] as const

export const FEATURE_FLAGS_FIELDS = ["lookupFunctions"] as const

export const ANGULAR_FIELDS = [
  "protectedGuards",
  "publicGuards",
  "authDataKeys",
  "publicData",
  "redirectDataKeys",
] as const

const ANGULAR_STRING_LIST_FIELDS = ["protectedGuards", "publicGuards", "authDataKeys", "redirectDataKeys"] as const

const isAngularPublicData = (value: unknown): boolean => {
  const record = asRecord(value)
  if (record === null || typeof record["key"] !== "string") return false
  return typeof record["value"] === "string" || typeof record["value"] === "boolean"
}

const angularField: FieldReader = (value) => {
  const record = asRecord(value)
  if (record === null) return fail("an object")
  const unknown = unknownKeys(record, ANGULAR_FIELDS)
  if (unknown.length > 0) return fail(onlyKeysMessage(ANGULAR_FIELDS, unknown))
  const lists = ANGULAR_STRING_LIST_FIELDS.every((key) => record[key] === undefined || isStringArray(record[key]))
  if (!lists) return fail("arrays of strings")
  const data = record["publicData"]
  const dataValid = data === undefined || (Array.isArray(data) && data.every(isAngularPublicData))
  return dataValid ? ok(record) : fail("publicData as an array of { key: string, value: string | boolean }")
}

export const REACT_ROUTER_FIELDS = ["routeDialect"] as const

export const ROUTE_DIALECT_KEYS = ["name", "fields", "translators", "unwrapCalls", "prefixRules"] as const

const PREFIX_RULE_SHAPE = "{ flag: string, prefix: string, keepPlain: boolean }"

const isPrefixRule = (value: unknown): boolean => {
  const record = asRecord(value)
  return (
    record !== null &&
    typeof record["flag"] === "string" &&
    typeof record["prefix"] === "string" &&
    typeof record["keepPlain"] === "boolean"
  )
}

const dialectFieldsIssue = (value: unknown): string | null => {
  const record = asRecord(value)
  if (record === null) return "'routeDialect.fields' to be an object"
  const unknown = unknownKeys(record, ROUTE_DIALECT_FIELDS)
  if (unknown.length > 0) return `'routeDialect.fields' to have ${onlyKeysMessage(ROUTE_DIALECT_FIELDS, unknown)}`
  return optionalStrings(record, ROUTE_DIALECT_FIELDS) ? null : "'routeDialect.fields' values to be strings"
}

const dialectMemberIssue = (record: Readonly<Record<string, unknown>>, key: (typeof ROUTE_DIALECT_KEYS)[number]): string | null => {
  const value = record[key]
  if (value === undefined) return null
  if (key === "name") return typeof value === "string" ? null : "'routeDialect.name' to be a string"
  if (key === "fields") return dialectFieldsIssue(value)
  if (key === "prefixRules")
    return Array.isArray(value) && value.every(isPrefixRule) ? null : `'routeDialect.prefixRules' to be an array of ${PREFIX_RULE_SHAPE}`
  return isStringArray(value) ? null : `'routeDialect.${key}' to be an array of strings`
}

const routeDialectIssue = (value: unknown): string | null => {
  const record = asRecord(value)
  if (record === null) return "'routeDialect' to be an object"
  const unknown = unknownKeys(record, ROUTE_DIALECT_KEYS)
  if (unknown.length > 0) return `'routeDialect' to have ${onlyKeysMessage(ROUTE_DIALECT_KEYS, unknown)}`
  return ROUTE_DIALECT_KEYS.map((key) => dialectMemberIssue(record, key)).find((issue) => issue !== null) ?? null
}

const reactRouterField: FieldReader = (value) => {
  const record = asRecord(value)
  if (record === null) return fail("an object")
  const unknown = unknownKeys(record, REACT_ROUTER_FIELDS)
  if (unknown.length > 0) return fail(onlyKeysMessage(REACT_ROUTER_FIELDS, unknown))
  if (record["routeDialect"] === undefined) return ok(record)
  const issue = routeDialectIssue(record["routeDialect"])
  return issue === null ? ok(record) : fail(issue)
}

const FIELD_READERS: Readonly<Record<string, FieldReader>> = {
  root: stringField,
  sourceRoots: stringArrayField,
  screenSource: stringField,
  screenSources: stringArrayField,
  depth: numberField,
  out: stringField,
  formats: stringArrayField,
  conflicts: (value) => (isConflictPolicy(value) ? ok(value) : fail("'merge', 'first' or 'error'")),
  kindRules: checkedArrayOf(isKindRule, "an array of kind rules", kindRuleRegexIssue),
  navSources: stringArrayField,
  menus: arrayOf(isMenuSpec, "an array of { file, export, name?, basePath?, fields? } with string values"),
  stringSources: stringArrayField,
  testIdAttribute: stringField,
  redirects: redirectsField,
  redirectRules: arrayOf(isRedirectRuleSpec, "an array of { source, destination }"),
  strict: booleanField,
  allowEmpty: booleanField,
  extensionRewrites: arrayOf(isExtensionRewrite, "an array of { from, to[] }"),
  candidateSuffixes: stringArrayField,
  exclude: stringArrayField,
  generated: stringArrayField,
  wrapperRoles: checkedArrayOf(isWrapperRule, `an array of { name, role: ${WRAPPER_ROLE_KINDS.join(" | ")}, tagRegex?, exported?, importedFrom?, reads?, entryFrom? }`, wrapperRuleRegexIssue),
  pathlessRoles: pathlessRolesField,
  entryComponents: arrayOf(isHolderSpec, "an array of { file, exportName? }"),
  adminjs: adminjsField,
  reactRouter: reactRouterField,
  vueAuth: vueAuthField,
  angular: angularField,
  expoRouter: expoRouterField,
  reactNavigation: reactNavigationField,
  nativeAuth: stringListsField(NATIVE_AUTH_FIELDS),
  featureFlags: stringListsField(FEATURE_FLAGS_FIELDS),
  extractors: stringArrayField,
}

export const CONFIG_FIELDS = Object.keys(FIELD_READERS)

/** Names that are not config fields but are what a reader of the adapter source or an older doc would try. */
const FIELD_ALIASES: Readonly<Record<string, string>> = {
  pathless: "pathlessRoles",
  wrappers: "wrapperRoles",
  holders: "entryComponents",
  optionsFile: "adminjs.optionsFile",
  componentLoaderFile: "adminjs.componentLoaderFile",
  routeDialect: "reactRouter.routeDialect",
  pathTables: "reactNavigation.pathTables",
  authOptionKeys: "reactNavigation.authOptionKeys",
  signedIn: "nativeAuth.signedIn",
  signedInPattern: "nativeAuth.signedIn",
  lookupFunctions: "featureFlags.lookupFunctions",
}

const editDistance = (left: string, right: string): number => {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0] ?? 0
    row[0] = i
    for (let j = 1; j <= right.length; j += 1) {
      const above = row[j] ?? 0
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      row[j] = Math.min(above + 1, (row[j - 1] ?? 0) + 1, diagonal + cost)
      diagonal = above
    }
  }
  return row[right.length] ?? 0
}

const SUGGESTION_DISTANCE = 3

/** The field an unknown key most plausibly meant, or `null` when nothing is close. */
export const suggestField = (field: string): string | null => {
  const alias = FIELD_ALIASES[field]
  if (alias !== undefined) return alias
  const lower = field.toLowerCase()
  const ranked = CONFIG_FIELDS.map((known) => ({ known, distance: editDistance(lower, known.toLowerCase()) }))
    .filter((entry) => entry.distance <= SUGGESTION_DISTANCE)
    .sort((a, b) => byNumber(a.distance, b.distance))
  return ranked[0]?.known ?? null
}

export const unknownFieldMessage = (field: string): string => {
  const suggestion = suggestField(field)
  const hint = suggestion === null ? `Known fields: ${CONFIG_FIELDS.join(", ")}` : `Did you mean '${suggestion}'?`
  return `unknown config field '${field}' ignored. ${hint}`
}

export type ConfigValidation = {
  readonly config: AppgraphConfig
  readonly issues: readonly Issue[]
  readonly unknownFields: readonly string[]
}

/** Field-by-field, dropping what does not typecheck rather than trusting the module wholesale. */
export const validateConfig = (value: unknown): ConfigValidation => {
  const record = asRecord(value)
  if (record === null)
    return { config: {}, issues: [{ field: "default", message: "expected the default export to be an object" }], unknownFields: [] }

  const accepted: Record<string, unknown> = {}
  const issues: Issue[] = []
  const unknownFields: string[] = []

  for (const [field, raw] of Object.entries(record)) {
    if (raw === undefined) continue

    const reader = FIELD_READERS[field]
    if (reader === undefined) {
      unknownFields.push(field)
      continue
    }

    const result = reader(raw)
    if (!result.ok) {
      issues.push({ field, message: `expected ${result.expected}` })
      continue
    }
    accepted[field] = result.value
  }

  return { config: accepted as AppgraphConfig, issues, unknownFields: sortStrings(unknownFields) }
}

/** `file` is the config file's project-relative path, or `null` for a config handed to `analyze()` in code. */
export const validationDiagnostics = (validated: ConfigValidation, file: string | null): readonly Diagnostic[] => {
  const prefix = file === null ? "config" : file
  const located = file === null ? {} : { file }
  return [
    ...validated.issues.map((issue) => ({
      severity: "error" as const,
      code: "config/invalid-field",
      message: `${prefix}: '${issue.field}' ${issue.message}`,
      plugin: null,
      ...located,
    })),
    ...validated.unknownFields.map((field) => ({
      severity: "error" as const,
      code: "config/unknown-field",
      message: `${prefix}: ${unknownFieldMessage(field)}`,
      plugin: null,
      ...located,
    })),
  ]
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export type StripTypes = (code: string) => string

export type LoadConfigInput = {
  readonly ts?: TypeScriptApi
  readonly loadTs?: () => Promise<TypeScriptApi>
  readonly stripTypes?: StripTypes | null
  readonly root: string
  readonly host?: FileHost
  /** Project-relative or absolute. Omit to probe `CONFIG_BASENAMES`. */
  readonly file?: string
  readonly io?: ConfigLoaderIo
  readonly required?: boolean
}

export type LoadedConfig = {
  /** Project-relative POSIX, or `null` when no config file was found. */
  readonly file: string | null
  readonly config: AppgraphConfig | null
  readonly diagnostics: readonly Diagnostic[]
  readonly unknownFields: readonly string[]
}

const RESOLUTION_ERROR = /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_ESM_URL_SCHEME|Cannot find (?:module|package)/

const SPECIFIER = /'([^']+)'|"([^"]+)"/

// Monotonic, not a clock: two loads in one process must not share a module cache entry, and §5.5 keeps
// the only legitimate clock in the emit layer.
let loadCounter = 0

const bust = (url: string): string => {
  loadCounter += 1
  return `${url}?appgraph=${String(loadCounter)}`
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const transpile = (api: TypeScriptApi, text: string, fileName: string): string =>
  api.transpileModule(text, {
    fileName: fileName.replace(/\.cts$/, ".mts"),
    compilerOptions: {
      module: api.ModuleKind.ESNext,
      target: api.ScriptTarget.ES2022,
      moduleResolution: api.ModuleResolutionKind.Bundler,
      jsx: api.JsxEmit.Preserve,
      isolatedModules: true,
    },
  }).outputText

type StripTypesModule = {
  readonly stripTypeScriptTypes?: (code: string, options?: { readonly mode?: "strip" }) => string
}

const stripTypesModule: StripTypesModule = nodeModule

export const nodeStripTypes = (): StripTypes | null => {
  const strip = stripTypesModule.stripTypeScriptTypes
  return strip === undefined ? null : (code) => strip(code, { mode: "strip" })
}

const EXPERIMENTAL_WARNING = "ExperimentalWarning"

const warningTypeOf = (warning: string | Error, rest: readonly unknown[]): unknown => {
  if (warning instanceof Error) return warning.name
  const [type] = rest
  return asRecord(type)?.["type"] ?? type
}

const withoutExperimentalWarnings = <T>(run: () => T): T => {
  const original = process.emitWarning
  const filtered: typeof process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
    if (warningTypeOf(warning, rest) === EXPERIMENTAL_WARNING) return
    Reflect.apply(original, process, [warning, ...rest])
  }
  process.emitWarning = filtered
  try {
    return run()
  } finally {
    process.emitWarning = original
  }
}

const strippedSource = (strip: StripTypes | null, text: string): string | null => {
  if (strip === null) return null
  try {
    return withoutExperimentalWarnings(() => strip(text))
  } catch {
    return null
  }
}

const compiledSource = async (input: LoadConfigInput, text: string, abs: string): Promise<string> =>
  transpile(input.ts ?? (await (input.loadTs ?? loadCompiler)()), text, abs)

const isSyntaxError = (error: unknown): boolean => error instanceof Error && error.name === "SyntaxError"

const defaultExportOf = (module: unknown): unknown => {
  const record = asRecord(module)
  return record === null ? undefined : record["default"]
}

const tempPathFor = (abs: string): string =>
  path.join(path.dirname(abs), `.${path.basename(abs)}.${String(process.pid)}-${String(loadCounter)}.mjs`)

const failure = (file: string | null, diagnostic: Diagnostic): ImportedConfig => ({
  file,
  exported: undefined,
  diagnostics: [diagnostic],
})

const importFailure = (rel: string, error: unknown): ImportedConfig => {
  const message = messageOf(error)
  const resolution = RESOLUTION_ERROR.test(message)
  const match = SPECIFIER.exec(message)
  const specifier = match?.[1] ?? match?.[2] ?? null

  return failure(rel, {
    severity: "error",
    code: resolution ? "config/unresolvable-import" : "config/load-failed",
    message: resolution
      ? `${rel} could not resolve ${specifier === null ? "an import" : `'${specifier}'`}: ${CONFIG_IMPORT_LIMITATION}`
      : `${rel} failed to load: ${message}`,
    plugin: null,
    file: rel,
  })
}

const notFound = (input: LoadConfigInput, rel: string | null): ImportedConfig => ({
  file: null,
  exported: undefined,
  diagnostics:
    input.required === true || rel !== null
      ? [
          {
            severity: "error",
            code: "config/not-found",
            message:
              rel === null
                ? `No config file found. Searched: ${CONFIG_BASENAMES.join(", ")}`
                : `Config file not found: ${rel}`,
            plugin: null,
          },
        ]
      : [],
})

const importSource = async (io: ConfigLoaderIo, abs: string, code: string): Promise<unknown> => {
  const temp = tempPathFor(abs)
  try {
    io.writeFile(temp, code)
    return await io.importModule(bust(pathToFileURL(temp).href))
  } finally {
    io.rm(temp)
  }
}

const importTranspiled = async (input: LoadConfigInput, io: ConfigLoaderIo, text: string, abs: string): Promise<unknown> => {
  const stripped = strippedSource(input.stripTypes === undefined ? nodeStripTypes() : input.stripTypes, text)
  if (stripped !== null) {
    try {
      return await importSource(io, abs, stripped)
    } catch (error) {
      if (!isSyntaxError(error)) throw error
    }
  }
  return importSource(io, abs, await compiledSource(input, text, abs))
}

export type ImportedConfig = {
  /** Project-relative POSIX, or `null` when no config file was found. */
  readonly file: string | null
  /** The module's raw default export; `undefined` whenever `diagnostics` explains why there is none. */
  readonly exported: unknown
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * §15.2. `pathToFileURL` is mandatory, not cosmetic: a bare Windows path as an import specifier throws
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`. A `.ts`/`.mts` config is transpiled to a sibling `.mjs` so its own
 * relative and bare imports resolve from the config's directory; the file is removed in `finally`, so
 * a config that throws on evaluation does not leak one. Nothing here validates the export's shape.
 */
export const importConfigFile = async (input: LoadConfigInput): Promise<ImportedConfig> => {
  const host = input.host ?? createNodeHost()
  const io = input.io ?? nodeConfigLoaderIo
  const root = path.resolve(input.root)

  const found = input.file ?? findConfigFile(host, root)
  if (found === null) return notFound(input, null)

  const abs = path.resolve(root, found)
  const rel = toPosix(path.relative(root, abs))
  if (input.file !== undefined && !host.isFile(abs)) return notFound(input, rel)

  const text = host.readFile(abs)
  if (text === null)
    return failure(rel, { severity: "error", code: "config/unreadable", message: `Cannot read ${rel}`, plugin: null, file: rel })

  const transpiled = (TRANSPILED_EXTENSIONS as readonly string[]).includes(path.extname(abs))

  try {
    const module = transpiled ? await importTranspiled(input, io, text, abs) : await io.importModule(bust(pathToFileURL(abs).href))
    return { file: rel, exported: defaultExportOf(module), diagnostics: [] }
  } catch (error) {
    return importFailure(rel, error)
  }
}

export const loadConfigFile = async (input: LoadConfigInput): Promise<LoadedConfig> => {
  const imported = await importConfigFile(input)
  if (imported.diagnostics.length > 0 || imported.file === null)
    return { file: imported.file, config: null, diagnostics: imported.diagnostics, unknownFields: [] }

  const rel = imported.file
  if (imported.exported === undefined)
    return {
      file: rel,
      config: null,
      diagnostics: [
        {
          severity: "error",
          code: "config/no-default-export",
          message: `${rel} has no default export; use 'export default defineConfig({...})'`,
          plugin: null,
          file: rel,
        },
      ],
      unknownFields: [],
    }

  const validated = validateConfig(imported.exported)
  return { file: rel, config: validated.config, diagnostics: validationDiagnostics(validated, rel), unknownFields: validated.unknownFields }
}
