import * as path from "node:path"
import type ts from "typescript"
import type { FileHost } from "./host.js"
import { toPosix } from "./host.js"

export type NuxtComponentDir = {
  readonly path: string
  readonly pathPrefix: boolean
  readonly prefix?: string
}

export type NuxtDirs = {
  readonly srcDir: string
  readonly pagesDir: string
  readonly layoutsDir: string
  readonly middlewareDir: string
  readonly componentDirs: readonly NuxtComponentDir[]
  readonly extends: readonly string[]
  readonly unreadable: readonly string[]
}

export type NuxtDirsInput = {
  readonly ts: typeof ts
  readonly host: FileHost
  readonly root: string
}

export const NUXT_CONFIG_FILES = ["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.mts"] as const

export const NUXT_PACKAGE = "nuxt"

const NUXT_DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies"] as const

const NUXT4_APP_DIR = "app"

const DEFAULT_DIRS = {
  pages: "pages",
  layouts: "layouts",
  middleware: "middleware",
  components: "components",
} as const

type DirKey = Exclude<keyof typeof DEFAULT_DIRS, "components">

const SRC_ALIAS = /^(?:~|@)\/?/

const ROOT_ALIAS = /^(?:~~|@@)\/?/

const MAX_UNWRAP_DEPTH = 8

type ConfigObject = ts.ObjectLiteralExpression

type Reader = {
  readonly api: typeof ts
  readonly source: ts.SourceFile
}

const memberOf = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined

const parseJson = (text: string | null): unknown => {
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export const hasNuxtDependency = (host: FileHost, root: string): boolean => {
  const manifest = parseJson(host.readFile(path.join(root, "package.json")))
  return NUXT_DEPENDENCY_FIELDS.some((field) => typeof memberOf(memberOf(manifest, field), NUXT_PACKAGE) === "string")
}

const normalizeDir = (value: string): string => {
  const normalized = path.posix.normalize(toPosix(value)).replace(/\/+$/, "")
  return normalized === "" ? "." : normalized
}

const DEFINE_NUXT_CONFIG = "defineNuxtConfig"

const isDefineNuxtConfig = (api: typeof ts, node: ts.Expression): node is ts.CallExpression =>
  api.isCallExpression(node) && api.isIdentifier(node.expression) && node.expression.text === DEFINE_NUXT_CONFIG

const unwrap = (reader: Reader, node: ts.Expression, depth = 0): ts.Expression => {
  const { api } = reader
  if (depth > MAX_UNWRAP_DEPTH) return node
  if (api.isParenthesizedExpression(node) || api.isAsExpression(node) || api.isSatisfiesExpression(node))
    return unwrap(reader, node.expression, depth + 1)
  if (isDefineNuxtConfig(api, node) && node.arguments[0] !== undefined) return unwrap(reader, node.arguments[0], depth + 1)
  if (api.isIdentifier(node)) {
    const bound = constInitializer(reader, node.text)
    return bound === null ? node : unwrap(reader, bound, depth + 1)
  }
  return node
}

const constInitializer = (reader: Reader, name: string): ts.Expression | null => {
  const { api, source } = reader
  for (const statement of source.statements) {
    if (!api.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (api.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer !== undefined)
        return declaration.initializer
    }
  }
  return null
}

const isModuleExports = (api: typeof ts, node: ts.Expression): boolean =>
  api.isPropertyAccessExpression(node) &&
  api.isIdentifier(node.expression) &&
  node.expression.text === "module" &&
  node.name.text === "exports"

const exportedExpression = (reader: Reader): ts.Expression | null => {
  const { api, source } = reader
  for (const statement of source.statements) {
    if (api.isExportAssignment(statement)) return statement.expression
    if (!api.isExpressionStatement(statement) || !api.isBinaryExpression(statement.expression)) continue
    const assignment = statement.expression
    if (assignment.operatorToken.kind === api.SyntaxKind.EqualsToken && isModuleExports(api, assignment.left))
      return assignment.right
  }
  return null
}

const configObject = (reader: Reader): ConfigObject | null => {
  const exported = exportedExpression(reader)
  if (exported === null) return null
  const value = unwrap(reader, exported)
  return reader.api.isObjectLiteralExpression(value) ? value : null
}

const propertyName = (api: typeof ts, name: ts.PropertyName): string | null => {
  if (api.isIdentifier(name) || api.isStringLiteral(name) || api.isNoSubstitutionTemplateLiteral(name)) return name.text
  return null
}

const property = (reader: Reader, object: ConfigObject, key: string): ts.Expression | null => {
  const { api } = reader
  for (const member of object.properties) {
    if (api.isPropertyAssignment(member) && propertyName(api, member.name) === key) return member.initializer
    if (api.isShorthandPropertyAssignment(member) && member.name.text === key) return member.name
  }
  return null
}

type Literal<T> = { readonly value: T } | { readonly unreadable: true } | null

const stringOf = (reader: Reader, node: ts.Expression | null): Literal<string> => {
  if (node === null) return null
  const value = unwrap(reader, node)
  const { api } = reader
  if (api.isStringLiteral(value) || api.isNoSubstitutionTemplateLiteral(value)) return { value: value.text }
  return { unreadable: true }
}

const booleanOf = (reader: Reader, node: ts.Expression | null): Literal<boolean> => {
  if (node === null) return null
  const value = unwrap(reader, node)
  const { api } = reader
  if (value.kind === api.SyntaxKind.TrueKeyword) return { value: true }
  if (value.kind === api.SyntaxKind.FalseKeyword) return { value: false }
  return { unreadable: true }
}

type Collected<T> = {
  readonly values: readonly T[]
  readonly unreadable: readonly string[]
}

const readSrcDir = (reader: Reader, config: ConfigObject | null): Collected<string> => {
  const literal = config === null ? null : stringOf(reader, property(reader, config, "srcDir"))
  if (literal === null) return { values: [], unreadable: [] }
  if ("unreadable" in literal) return { values: [], unreadable: ["srcDir"] }
  return { values: [normalizeDir(literal.value)], unreadable: [] }
}

const defaultSrcDir = (host: FileHost, root: string): string =>
  host.isDirectory(path.join(root, NUXT4_APP_DIR, DEFAULT_DIRS.pages)) || host.isFile(path.join(root, NUXT4_APP_DIR, "app.vue"))
    ? NUXT4_APP_DIR
    : "."

const readDir = (reader: Reader, config: ConfigObject | null, key: DirKey): Collected<string> => {
  const dirNode = config === null ? null : property(reader, config, "dir")
  if (dirNode === null) return { values: [], unreadable: [] }
  const dirObject = unwrap(reader, dirNode)
  if (!reader.api.isObjectLiteralExpression(dirObject)) return { values: [], unreadable: [`dir.${key}`] }
  const literal = stringOf(reader, property(reader, dirObject, key))
  if (literal === null) return { values: [], unreadable: [] }
  if ("unreadable" in literal) return { values: [], unreadable: [`dir.${key}`] }
  return { values: [literal.value], unreadable: [] }
}

const resolveConfigPath = (srcDir: string, value: string): string => {
  const posix = toPosix(value)
  if (ROOT_ALIAS.test(posix)) return normalizeDir(posix.replace(ROOT_ALIAS, ""))
  if (SRC_ALIAS.test(posix)) return normalizeDir(path.posix.join(srcDir, posix.replace(SRC_ALIAS, "")))
  return normalizeDir(path.posix.join(srcDir, posix))
}

const defaultComponentDirs = (srcDir: string): readonly NuxtComponentDir[] => [
  {
    path: normalizeDir(path.posix.join(srcDir, DEFAULT_DIRS.components)),
    pathPrefix: true,
  },
]

const componentEntry = (reader: Reader, srcDir: string, node: ts.Expression, label: string): Collected<NuxtComponentDir> => {
  const value = unwrap(reader, node)
  const direct = stringOf(reader, value)
  if (direct !== null && "value" in direct)
    return {
      values: [{ path: resolveConfigPath(srcDir, direct.value), pathPrefix: true }],
      unreadable: [],
    }
  if (!reader.api.isObjectLiteralExpression(value)) return { values: [], unreadable: [label] }
  const dirPath = stringOf(reader, property(reader, value, "path"))
  const pathPrefix = booleanOf(reader, property(reader, value, "pathPrefix"))
  const prefix = stringOf(reader, property(reader, value, "prefix"))
  if (dirPath === null || "unreadable" in dirPath) return { values: [], unreadable: [label] }
  const unreadable = [
    ...(pathPrefix !== null && "unreadable" in pathPrefix ? [`${label}.pathPrefix`] : []),
    ...(prefix !== null && "unreadable" in prefix ? [`${label}.prefix`] : []),
  ]
  const entry: NuxtComponentDir = {
    path: resolveConfigPath(srcDir, dirPath.value),
    pathPrefix: pathPrefix !== null && "value" in pathPrefix ? pathPrefix.value : true,
    ...(prefix !== null && "value" in prefix ? { prefix: prefix.value } : {}),
  }
  return { values: [entry], unreadable }
}

const componentArray = (
  reader: Reader,
  srcDir: string,
  array: ts.ArrayLiteralExpression,
  label: string,
): Collected<NuxtComponentDir> => {
  const entries = array.elements.map((element, index) =>
    reader.api.isSpreadElement(element)
      ? { values: [], unreadable: [`${label}[${String(index)}]`] }
      : componentEntry(reader, srcDir, element, `${label}[${String(index)}]`),
  )
  return {
    values: entries.flatMap((entry) => entry.values),
    unreadable: entries.flatMap((entry) => entry.unreadable),
  }
}

const readComponents = (reader: Reader, config: ConfigObject | null, srcDir: string): Collected<NuxtComponentDir> => {
  const node = config === null ? null : property(reader, config, "components")
  if (node === null) return { values: defaultComponentDirs(srcDir), unreadable: [] }
  const value = unwrap(reader, node)
  const { api } = reader
  if (value.kind === api.SyntaxKind.FalseKeyword) return { values: [], unreadable: [] }
  if (value.kind === api.SyntaxKind.TrueKeyword) return { values: defaultComponentDirs(srcDir), unreadable: [] }
  if (api.isArrayLiteralExpression(value)) return componentArray(reader, srcDir, value, "components")
  if (!api.isObjectLiteralExpression(value)) return { values: defaultComponentDirs(srcDir), unreadable: ["components"] }
  const dirs = property(reader, value, "dirs")
  if (dirs === null) return { values: defaultComponentDirs(srcDir), unreadable: [] }
  const dirsValue = unwrap(reader, dirs)
  if (!api.isArrayLiteralExpression(dirsValue))
    return {
      values: defaultComponentDirs(srcDir),
      unreadable: ["components.dirs"],
    }
  return componentArray(reader, srcDir, dirsValue, "components.dirs")
}

const readExtends = (reader: Reader, config: ConfigObject | null): Collected<string> => {
  const node = config === null ? null : property(reader, config, "extends")
  if (node === null) return { values: [], unreadable: [] }
  const value = unwrap(reader, node)
  const elements = reader.api.isArrayLiteralExpression(value) ? [...value.elements] : [value]
  const reads = elements.map((element, index) => ({
    index,
    literal: stringOf(reader, element),
  }))
  return {
    values: reads.flatMap(({ literal }) => (literal !== null && "value" in literal ? [literal.value] : [])),
    unreadable: reads.flatMap(({ index, literal }) =>
      literal !== null && "unreadable" in literal ? [`extends[${String(index)}]`] : [],
    ),
  }
}

const loadConfig = (input: NuxtDirsInput, root: string): Reader | null => {
  const file = NUXT_CONFIG_FILES.map((name) => path.join(root, name)).find((candidate) => input.host.isFile(candidate))
  const text = file === undefined ? null : input.host.readFile(file)
  if (file === undefined || text === null) return null
  const source = input.ts.createSourceFile(file, text, input.ts.ScriptTarget.Latest, false, input.ts.ScriptKind.TS)
  return { api: input.ts, source }
}

const EMPTY_SOURCE_NAME = "nuxt.config.ts"

const emptyReader = (api: typeof ts): Reader => ({
  api,
  source: api.createSourceFile(EMPTY_SOURCE_NAME, "", api.ScriptTarget.Latest, false, api.ScriptKind.TS),
})

const joinDir = (srcDir: string, read: Collected<string>, key: DirKey): string =>
  normalizeDir(path.posix.join(srcDir, read.values[0] ?? DEFAULT_DIRS[key]))

export const resolveNuxtDirs = (input: NuxtDirsInput): NuxtDirs => {
  const root = path.resolve(input.root)
  const loaded = loadConfig(input, root)
  const reader = loaded ?? emptyReader(input.ts)
  const config = loaded === null ? null : configObject(loaded)
  const srcDirRead = readSrcDir(reader, config)
  const srcDir = srcDirRead.values[0] ?? defaultSrcDir(input.host, root)
  const pages = readDir(reader, config, "pages")
  const layouts = readDir(reader, config, "layouts")
  const middleware = readDir(reader, config, "middleware")
  const components = readComponents(reader, config, srcDir)
  const extendsRead = readExtends(reader, config)
  return {
    srcDir,
    pagesDir: joinDir(srcDir, pages, "pages"),
    layoutsDir: joinDir(srcDir, layouts, "layouts"),
    middlewareDir: joinDir(srcDir, middleware, "middleware"),
    componentDirs: components.values,
    extends: extendsRead.values,
    unreadable: [
      ...(loaded !== null && config === null ? ["nuxt.config"] : []),
      ...srcDirRead.unreadable,
      ...pages.unreadable,
      ...layouts.unreadable,
      ...middleware.unreadable,
      ...components.unreadable,
      ...extendsRead.unreadable,
    ],
  }
}
