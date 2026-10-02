import { posix } from "node:path"
import type ts from "typescript"
import type { AngularCompiler } from "../../core/angular-compiler.js"
import { ANGULAR_CORE_PACKAGE, ANGULAR_TEMPLATE_TAGS } from "../../core/angular-compiler.js"
import { SCRIPT_FILE } from "../../core/extensions.js"
import { scanTags } from "../../core/tag-scan.js"
import type { ScannedTag } from "../../core/tag-scan.js"
import type {
  TemplateDoc,
  TemplateElement,
  TemplateProducer,
  TemplateProducerEnv,
  TemplateUnsupportedFeature,
} from "../../core/template-doc.js"
import type { TypeScriptApi } from "../../core/tsconfig.js"
import type { AngularTemplateContent, AngularTemplateFrame } from "./template-ast.js"
import { angularNamesOf, angularSlotNameOf, angularTemplateContentOf } from "./template-ast.js"

export type AngularTemplateProducerEnv = TemplateProducerEnv & { readonly ts: TypeScriptApi }

export type AngularTemplateProducerInput = {
  readonly api: AngularCompiler | null
  readonly env: AngularTemplateProducerEnv
  readonly projectMajor: number | null
}

export type AngularTemplateRef =
  | { readonly kind: "url"; readonly url: string | null }
  | { readonly kind: "inline"; readonly text: string; readonly base: number; readonly firstLine: number }
  | { readonly kind: "interpolated" }
  | { readonly kind: "none" }

export type AngularComponentDecl = {
  readonly className: string | null
  readonly owner: string
  readonly template: AngularTemplateRef
}

type DecoratorNames = {
  readonly locals: ReadonlySet<string>
  readonly namespaces: ReadonlySet<string>
  readonly bare: boolean
}

const FRAMEWORK = "angular"

const COMPONENT_DECORATOR = "Component"

const DECORATOR_MARKER = "@"

const DEFAULT_OWNER = "default"

const OUTLET_TAG = "router-outlet"

const SLOT_TAG = "ng-content"

const SCAN_TAGS = [OUTLET_TAG, SLOT_TAG] as const

const SELECT_ATTRIBUTE = "select"

const TEMPLATE_URL_KEY = "templateUrl"

const TEMPLATE_KEY = "template"

const QUOTE_WIDTH = 1

const NO_GUARD: TemplateElement["guard"] = { condition: null, repeated: false, lazy: false }

const EMPTY_CONTENT: AngularTemplateContent = { elements: [], expressions: [], failed: false }

const isComponentCandidate = (file: string, text: string): boolean => SCRIPT_FILE.test(file) && text.includes(DECORATOR_MARKER) && text.includes(COMPONENT_DECORATOR)

const importsOf = (api: TypeScriptApi, source: ts.SourceFile): readonly ts.ImportDeclaration[] =>
  source.statements.filter((statement): statement is ts.ImportDeclaration => api.isImportDeclaration(statement))

const moduleOf = (api: TypeScriptApi, declaration: ts.ImportDeclaration): string | null =>
  api.isStringLiteral(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : null

const namedImportsOf = (api: TypeScriptApi, declaration: ts.ImportDeclaration): readonly ts.ImportSpecifier[] => {
  const bindings = declaration.importClause?.namedBindings
  return bindings !== undefined && api.isNamedImports(bindings) ? bindings.elements : []
}

const localNamesOf = (api: TypeScriptApi, declaration: ts.ImportDeclaration): readonly string[] => {
  const clause = declaration.importClause
  const bindings = clause?.namedBindings
  return [
    ...(clause?.name === undefined ? [] : [clause.name.text]),
    ...(bindings !== undefined && api.isNamespaceImport(bindings) ? [bindings.name.text] : []),
    ...namedImportsOf(api, declaration).map((specifier) => specifier.name.text),
  ]
}

const decoratorNamesOf = (api: TypeScriptApi, source: ts.SourceFile): DecoratorNames => {
  const imports = importsOf(api, source)
  const angular = imports.filter((declaration) => moduleOf(api, declaration) === ANGULAR_CORE_PACKAGE)
  const locals = angular.flatMap((declaration) =>
    namedImportsOf(api, declaration)
      .filter((specifier) => (specifier.propertyName ?? specifier.name).text === COMPONENT_DECORATOR)
      .map((specifier) => specifier.name.text),
  )
  const namespaces = angular.flatMap((declaration) => {
    const bindings = declaration.importClause?.namedBindings
    return bindings !== undefined && api.isNamespaceImport(bindings) ? [bindings.name.text] : []
  })
  const bound = imports.some((declaration) => localNamesOf(api, declaration).includes(COMPONENT_DECORATOR))
  return { locals: new Set(locals), namespaces: new Set(namespaces), bare: !bound }
}

const isComponentCallee = (api: TypeScriptApi, callee: ts.Expression, names: DecoratorNames): boolean => {
  if (api.isIdentifier(callee))
    return names.locals.has(callee.text) || (names.bare && callee.text === COMPONENT_DECORATOR)
  return (
    api.isPropertyAccessExpression(callee) &&
    api.isIdentifier(callee.expression) &&
    names.namespaces.has(callee.expression.text) &&
    callee.name.text === COMPONENT_DECORATOR
  )
}

const componentCallOf = (api: TypeScriptApi, node: ts.ClassDeclaration, names: DecoratorNames): ts.CallExpression | null => {
  const decorators = api.canHaveDecorators(node) ? (api.getDecorators(node) ?? []) : []
  const call = decorators
    .map((decorator) => decorator.expression)
    .find(
      (expression): expression is ts.CallExpression =>
        api.isCallExpression(expression) && isComponentCallee(api, expression.expression, names),
    )
  return call ?? null
}

const propertyNameOf = (api: TypeScriptApi, name: ts.PropertyName): string | null => {
  if (api.isIdentifier(name) || api.isStringLiteral(name)) return name.text
  return null
}

const propertyValueOf = (api: TypeScriptApi, literal: ts.ObjectLiteralExpression, key: string): ts.Expression | null => {
  const found = literal.properties.find(
    (property): property is ts.PropertyAssignment => api.isPropertyAssignment(property) && propertyNameOf(api, property.name) === key,
  )
  return found === undefined ? null : found.initializer
}

const unwrapped = (api: TypeScriptApi, node: ts.Expression): ts.Expression =>
  api.isParenthesizedExpression(node) ? unwrapped(api, node.expression) : node

const inlineRefOf = (api: TypeScriptApi, source: ts.SourceFile, node: ts.Expression): AngularTemplateRef => {
  if (api.isTemplateExpression(node)) return { kind: "interpolated" }
  if (!api.isStringLiteral(node) && !api.isNoSubstitutionTemplateLiteral(node)) return { kind: "none" }
  const base = node.getStart(source) + QUOTE_WIDTH
  return {
    kind: "inline",
    text: source.text.slice(base, node.end - QUOTE_WIDTH),
    base,
    firstLine: source.getLineAndCharacterOfPosition(base).line + 1,
  }
}

const templateRefOf = (api: TypeScriptApi, source: ts.SourceFile, argument: ts.Expression | null): AngularTemplateRef => {
  const literal = argument === null ? null : unwrapped(api, argument)
  if (literal === null || !api.isObjectLiteralExpression(literal)) return { kind: "none" }
  const url = propertyValueOf(api, literal, TEMPLATE_URL_KEY)
  if (url !== null) {
    const value = unwrapped(api, url)
    return { kind: "url", url: api.isStringLiteralLike(value) ? value.text : null }
  }
  const inline = propertyValueOf(api, literal, TEMPLATE_KEY)
  return inline === null ? { kind: "none" } : inlineRefOf(api, source, unwrapped(api, inline))
}

const isDefaultExported = (api: TypeScriptApi, node: ts.ClassDeclaration): boolean =>
  node.modifiers?.some((modifier) => modifier.kind === api.SyntaxKind.DefaultKeyword) === true

const defaultExportNameOf = (api: TypeScriptApi, source: ts.SourceFile): string | null => {
  const assignment = source.statements.find(
    (statement): statement is ts.ExportAssignment => api.isExportAssignment(statement) && !statement.isExportEquals,
  )
  return assignment !== undefined && api.isIdentifier(assignment.expression) ? assignment.expression.text : null
}

const ownerOf = (api: TypeScriptApi, node: ts.ClassDeclaration, defaultName: string | null): string => {
  const name = node.name?.text ?? null
  if (isDefaultExported(api, node) || name === null || name === defaultName) return DEFAULT_OWNER
  return name
}

export const angularComponentsIn = (api: TypeScriptApi, file: string, text: string): readonly AngularComponentDecl[] => {
  const source = api.createSourceFile(file, text, api.ScriptTarget.Latest, false)
  const names = decoratorNamesOf(api, source)
  const defaultName = defaultExportNameOf(api, source)
  return source.statements.flatMap((statement) => {
    if (!api.isClassDeclaration(statement)) return []
    const call = componentCallOf(api, statement, names)
    if (call === null) return []
    return [
      {
        className: statement.name?.text ?? null,
        owner: ownerOf(api, statement, defaultName),
        template: templateRefOf(api, source, call.arguments[0] ?? null),
      },
    ]
  })
}

export const resolveTemplateUrl = (file: string, url: string): string => posix.normalize(posix.join(posix.dirname(file), url))

const scannedElementOf = (tag: ScannedTag): TemplateElement => {
  const attributes = tag.attributes.map((attribute) => ({
    name: attribute.name,
    kind: "static" as const,
    arg: null,
    static: attribute.value ?? "",
    expression: null,
    pos: tag.pos,
    line: tag.line,
  }))
  const isSlot = tag.tag === SLOT_TAG
  const select = tag.attributes.find((attribute) => attribute.name === SELECT_ATTRIBUTE)?.value ?? null
  return {
    tag: tag.tag,
    names: angularNamesOf(tag.tag, null),
    kind: isSlot ? "slot" : "element",
    pos: tag.pos,
    end: tag.end,
    line: tag.line,
    attributes,
    guard: NO_GUARD,
    slotName: isSlot ? angularSlotNameOf(select) : null,
  }
}

const shiftedTag = (frame: AngularTemplateFrame, tag: ScannedTag): ScannedTag => ({
  ...tag,
  pos: frame.base + tag.pos,
  end: frame.base + tag.end,
  line: frame.firstLine - 1 + tag.line,
})

const scannedContentOf = (frame: AngularTemplateFrame): AngularTemplateContent => ({
  elements: scanTags(frame.text, { tags: SCAN_TAGS }).map((tag) => scannedElementOf(shiftedTag(frame, tag))),
  expressions: [],
  failed: false,
})

type DocBase = Pick<TemplateDoc, "file" | "owner" | "ownerFile" | "partial">

const docOf = (base: DocBase, content: AngularTemplateContent, unsupported: readonly TemplateUnsupportedFeature[] = []): TemplateDoc => ({
  framework: FRAMEWORK,
  ...base,
  elements: content.elements,
  expressions: content.expressions,
  unsupported: content.failed ? [...unsupported, "parse-error"] : unsupported,
})

const frameOf = (template: AngularTemplateRef, file: string, readFile: (file: string) => string | null): AngularTemplateFrame | null => {
  if (template.kind === "inline") return { text: template.text, url: file, base: template.base, firstLine: template.firstLine }
  if (template.kind !== "url" || template.url === null) return null
  const url = resolveTemplateUrl(file, template.url)
  const text = readFile(url)
  return text === null ? null : { text, url, base: 0, firstLine: 1 }
}

const unsupportedOf = (template: AngularTemplateRef): readonly TemplateUnsupportedFeature[] => {
  if (template.kind === "interpolated") return ["interpolated-inline-template"]
  return template.kind === "url" ? ["template-url-missing"] : []
}

export const createAngularTemplateProducer = (input: AngularTemplateProducerInput): TemplateProducer => {
  const { api, env, projectMajor } = input
  const cache = new Map<string, readonly AngularComponentDecl[]>()
  const partial = api === null

  const contentOf = (frame: AngularTemplateFrame): AngularTemplateContent =>
    api === null ? scannedContentOf(frame) : angularTemplateContentOf(api, frame, projectMajor)

  const componentsOf = (file: string): readonly AngularComponentDecl[] => {
    const cached = cache.get(file)
    if (cached !== undefined) return cached
    const text = env.readFile(file)
    const found = text === null || !isComponentCandidate(file, text) ? [] : angularComponentsIn(env.ts, file, text)
    cache.set(file, found)
    return found
  }

  const docOfComponent = (file: string, component: AngularComponentDecl): TemplateDoc => {
    const frame = frameOf(component.template, file, env.readFile)
    const owned = { owner: component.owner, ownerFile: file, partial }
    if (frame === null) return docOf({ file, ...owned }, EMPTY_CONTENT, unsupportedOf(component.template))
    return docOf({ file: component.template.kind === "url" ? frame.url : file, ...owned }, contentOf(frame))
  }

  return {
    framework: FRAMEWORK,
    tags: ANGULAR_TEMPLATE_TAGS,
    claims: (file) => componentsOf(file).length > 0,
    docsOf: (file) => componentsOf(file).map((component) => docOfComponent(file, component)),
    componentNameOf: (file) => {
      const components = componentsOf(file)
      return components.length === 1 ? (components[0]?.className ?? null) : null
    },
  }
}
