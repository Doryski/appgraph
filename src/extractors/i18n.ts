import type ts from "typescript"
import type { ModulePattern } from "../core/bindings.js"
import type { ExtractContext, FactAnchor, FactExtractor } from "./types.js"
import { anchorOf } from "./types.js"
import type { TemplateAttribute, TemplateDoc, TemplateExpression } from "../core/template-doc.js"
import { SCRIPT_EXTENSION_PATTERN, SCRIPT_FILE } from "../core/extensions.js"

export const DEFAULT_I18NEXT_MODULE: ModulePattern = /^react-i18next$/
export const DEFAULT_NEXT_INTL_MODULE: ModulePattern = /^next-intl(\/.*)?$/
export const DEFAULT_I18NEXT_CORE_MODULE: ModulePattern = /^i18next$/
export const DEFAULT_REACT_INTL_MODULE: ModulePattern = /^react-intl$/
export const DEFAULT_VUE_I18N_MODULE: ModulePattern = /^vue-i18n$/
export const DEFAULT_LINGUI_MODULE: ModulePattern = /^@lingui\/(core|react|macro)(\/.*)?$/

// The library's own default namespace, which this pass cannot name: i18next's `defaultNS` is runtime
// configuration, and react-intl has no namespaces at all — one flat catalog per locale. Recording it
// keeps "this screen is translated" visible without inventing a namespace from a message-id prefix.
export const DEFAULT_NAMESPACE = "default"

const I18NEXT_HOOKS = new Set(["useTranslation"])
const NEXT_INTL_HOOKS = new Set(["getTranslations", "useTranslations"])
const REACT_INTL_CALLS = new Set(["useIntl", "injectIntl", "defineMessages", "defineMessage"])
const REACT_INTL_TAGS = new Set(["FormattedMessage"])
const LINGUI_CALLS = new Set(["t", "msg", "defineMessage", "useLingui"])
const LINGUI_TAGS = new Set(["t", "msg", "defineMessage"])
const LINGUI_COMPONENTS = new Set(["Trans"])
const LINGUI_INSTANCE = "i18n"
const LINGUI_INSTANCE_METHOD = "_"
const VUE_I18N_CALLS = new Set(["useI18n"])
const GLOBAL_TRANSLATE_CALL = /(?:^|[^\w$.])\$t\s*\(/
const SCRIPT_TRANSLATE_CALL = /(?:^|[^\w$.])\$?t\s*\(/
const I18NEXT_NS_SEPARATOR = ":"

export const NGX_TRANSLATE_SERVICE = { module: "@ngx-translate/core", imported: "TranslateService" } as const
export const ANGULAR_LOCALIZE_MODULE: ModulePattern = /^@angular\/localize(\/.*)?$/

const NGX_TRANSLATE_METHODS = new Set(["instant", "get", "stream"])
const NGX_TRANSLATE_PIPE = "translate"
const NGX_TRANSLATE_ATTRIBUTE = "translate"
const NGX_TRANSLATE_ATTRIBUTE_KINDS = new Set<TemplateAttribute["kind"]>(["static", "bound"])
const HTML_TRANSLATE_VALUES = new Set(["yes", "no"])
const LOCALIZE_TAG = "$localize"
const ANGULAR_I18N_ATTRIBUTE = "i18n"
const ANGULAR_I18N_ATTRIBUTE_PREFIX = "i18n-"

// No i18next at all: namespaces come from a language-code aggregator file
// (`locale/en.ts`) whose relative imports enumerate the per-domain namespace files
// (`locale/orders.ts`, `locale/users.ts`, …). Reading THIS file's own import specifiers is enough —
// no cross-file resolution needed, because the namespace name is the specifier's basename, not
// anything declared in the file it points at.
const DEFAULT_LOCALE_DIR = /(^|\/)locale\//
const DEFAULT_LOCALE_AGGREGATOR_FILE = new RegExp(`(^|/)([a-z]{2}(-[A-Z]{2})?)\\.${SCRIPT_EXTENSION_PATTERN}$`)

export type I18nOptions = {
  readonly i18nextModule?: ModulePattern
  readonly nextIntlModule?: ModulePattern
  readonly i18nextCoreModule?: ModulePattern
  readonly reactIntlModule?: ModulePattern
  readonly vueI18nModule?: ModulePattern
  readonly linguiModule?: ModulePattern
  readonly localeDir?: RegExp
  readonly localeAggregatorFile?: RegExp
}

const importedName = (local: string, module: ModulePattern, ctx: ExtractContext): string | null => {
  const binding = ctx.bindings.get(local)
  if (binding === null || (binding.kind !== "import" && binding.kind !== "dynamic-import")) return null
  if (!ctx.bindings.rootsInModule(local, module)) return null
  return binding.imported === "default" || binding.imported === "*" ? local : binding.imported
}

export const createI18nExtractor = (options: I18nOptions = {}): FactExtractor => {
  const i18nextModule = options.i18nextModule ?? DEFAULT_I18NEXT_MODULE
  const nextIntlModule = options.nextIntlModule ?? DEFAULT_NEXT_INTL_MODULE
  const i18nextCoreModule = options.i18nextCoreModule ?? DEFAULT_I18NEXT_CORE_MODULE
  const reactIntlModule = options.reactIntlModule ?? DEFAULT_REACT_INTL_MODULE
  const vueI18nModule = options.vueI18nModule ?? DEFAULT_VUE_I18N_MODULE
  const linguiModule = options.linguiModule ?? DEFAULT_LINGUI_MODULE
  const localeDir = options.localeDir ?? DEFAULT_LOCALE_DIR
  const localeAggregatorFile = options.localeAggregatorFile ?? DEFAULT_LOCALE_AGGREGATOR_FILE

  const seen = new Set<string>()
  let scriptUsesVueI18n = false

  const emit = (namespace: string, node: ts.Node | FactAnchor, ctx: ExtractContext): void => {
    if (seen.has(namespace)) return
    seen.add(namespace)
    ctx.emitFact("i18nNamespaces", namespace, node)
  }

  const visitNamespaceArgument = (argument: ts.Node | undefined, node: ts.Node, ctx: ExtractContext): void => {
    const array = ctx.ast.asArrayLiteral(argument)
    if (array !== null) {
      for (const element of array.elements) {
        const flat = ctx.flattenString(element)
        if (flat !== null) emit(flat.value, node, ctx)
      }
      return
    }

    const flat = ctx.flattenString(argument)
    if (flat !== null) emit(flat.value, node, ctx)
  }

  const nsOption = (argument: ts.Node | undefined, ctx: ExtractContext): string | null => {
    const property = ctx.ast
      .asObjectLiteral(argument)
      ?.properties.find(
        (candidate): candidate is ts.PropertyAssignment =>
          ctx.ts.isPropertyAssignment(candidate) && ctx.ts.isIdentifier(candidate.name) && candidate.name.text === "ns",
      )
    const flat = ctx.flattenString(property?.initializer)
    return flat === null || flat.dynamic ? null : flat.value
  }

  // i18next core `t('orders:title')` / `t('title', { ns: 'orders' })` / `t('title')`. A key that does
  // not fold says nothing about its namespace, so it records nothing rather than `default`.
  const visitCoreT = (call: ts.CallExpression, ctx: ExtractContext): void => {
    const option = nsOption(call.arguments[1], ctx)
    if (option !== null) {
      emit(option, call, ctx)
      return
    }

    const key = ctx.flattenString(call.arguments[0])
    if (key === null) return
    const separator = key.value.indexOf(I18NEXT_NS_SEPARATOR)
    emit(separator > 0 ? key.value.slice(0, separator) : DEFAULT_NAMESPACE, call, ctx)
  }

  const isCoreInstance = (local: string, ctx: ExtractContext): boolean => {
    const binding = ctx.bindings.get(local)
    if (binding === null || binding.kind !== "import") return false
    return (binding.imported === "default" || binding.imported === "*") && ctx.bindings.rootsInModule(local, i18nextCoreModule)
  }

  const isTranslateService = (receiver: ts.Expression, ctx: ExtractContext): boolean => {
    const member = ctx.bindings.memberBinding(receiver)
    return member !== null && member.module === NGX_TRANSLATE_SERVICE.module && member.imported === NGX_TRANSLATE_SERVICE.imported
  }

  const visitTranslateServiceCall = (call: ts.CallExpression, access: ts.PropertyAccessExpression, ctx: ExtractContext): void => {
    if (!NGX_TRANSLATE_METHODS.has(access.name.text) || !isTranslateService(access.expression, ctx)) return
    emit(DEFAULT_NAMESPACE, call, ctx)
  }

  const visitLinguiInstanceCall = (call: ts.CallExpression, access: ts.PropertyAccessExpression, ctx: ExtractContext): void => {
    if (access.name.text !== LINGUI_INSTANCE_METHOD) return
    const receiver = ctx.ast.asIdentifier(access.expression)
    if (receiver === null || importedName(receiver.text, linguiModule, ctx) !== LINGUI_INSTANCE) return
    emit(DEFAULT_NAMESPACE, call, ctx)
  }

  const visitMethodCall = (call: ts.CallExpression, ctx: ExtractContext): void => {
    const access = ctx.ast.asPropertyAccess(call.expression)
    if (access !== null) visitTranslateServiceCall(call, access, ctx)
    if (access !== null) visitLinguiInstanceCall(call, access, ctx)
    const receiver = access === null ? null : ctx.ast.asIdentifier(access.expression)
    if (access === null || receiver === null || access.name.text !== "t") return
    if (isCoreInstance(receiver.text, ctx)) visitCoreT(call, ctx)
  }

  const visitCall = (call: ts.CallExpression, ctx: ExtractContext): void => {
    const identifier = ctx.ast.asIdentifier(call.expression)
    if (identifier === null) {
      visitMethodCall(call, ctx)
      return
    }
    const local = identifier.text

    const i18nextName = importedName(local, i18nextModule, ctx)
    if (i18nextName !== null && I18NEXT_HOOKS.has(i18nextName)) {
      if (call.arguments[0] === undefined) emit(DEFAULT_NAMESPACE, call, ctx)
      else visitNamespaceArgument(call.arguments[0], call, ctx)
      return
    }

    const nextIntlName = importedName(local, nextIntlModule, ctx)
    if (nextIntlName !== null && NEXT_INTL_HOOKS.has(nextIntlName)) {
      visitNamespaceArgument(call.arguments[0], call, ctx)
      return
    }

    if (importedName(local, i18nextCoreModule, ctx) === "t") {
      visitCoreT(call, ctx)
      return
    }

    const reactIntlName = importedName(local, reactIntlModule, ctx)
    if (reactIntlName !== null && REACT_INTL_CALLS.has(reactIntlName)) {
      emit(DEFAULT_NAMESPACE, call, ctx)
      return
    }

    const linguiName = importedName(local, linguiModule, ctx)
    if (linguiName !== null && LINGUI_CALLS.has(linguiName)) {
      emit(DEFAULT_NAMESPACE, call, ctx)
      return
    }

    const vueI18nName = importedName(local, vueI18nModule, ctx)
    if (vueI18nName === null || !VUE_I18N_CALLS.has(vueI18nName)) return
    scriptUsesVueI18n = true
    emit(DEFAULT_NAMESPACE, call, ctx)
  }

  const callsTranslate = (expression: string): boolean =>
    (scriptUsesVueI18n ? SCRIPT_TRANSLATE_CALL : GLOBAL_TRANSLATE_CALL).test(expression)

  const visitTemplateExpression = (expression: TemplateExpression, ctx: ExtractContext): void => {
    if (callsTranslate(expression.text)) emit(DEFAULT_NAMESPACE, { pos: expression.pos, end: expression.end }, ctx)
  }

  const isTranslatePipe = (expression: TemplateExpression): boolean => expression.pipes.includes(NGX_TRANSLATE_PIPE)

  const isTranslateDirective = (attribute: TemplateAttribute): boolean =>
    attribute.name === NGX_TRANSLATE_ATTRIBUTE &&
    NGX_TRANSLATE_ATTRIBUTE_KINDS.has(attribute.kind) &&
    !HTML_TRANSLATE_VALUES.has((attribute.static ?? "").trim().toLowerCase())

  const isI18nMarker = (attribute: TemplateAttribute): boolean =>
    attribute.name === ANGULAR_I18N_ATTRIBUTE || attribute.name.startsWith(ANGULAR_I18N_ATTRIBUTE_PREFIX)

  const isAngularTranslation = (attribute: TemplateAttribute): boolean =>
    isTranslateDirective(attribute) || isI18nMarker(attribute)

  const angularTemplateAnchor = (doc: TemplateDoc): FactAnchor | null => {
    const expression = doc.expressions.find(isTranslatePipe)
    if (expression !== undefined) return anchorOf(doc, expression)
    const element = doc.elements.find((candidate) => candidate.attributes.some(isAngularTranslation))
    return element === undefined ? null : anchorOf(doc, element)
  }

  const visitAngularTemplate = (doc: TemplateDoc, ctx: ExtractContext): void => {
    if (doc.framework !== "angular") return
    const anchor = angularTemplateAnchor(doc)
    if (anchor !== null) emit(DEFAULT_NAMESPACE, anchor, ctx)
  }

  const isLocalizeTag = (tag: ts.Expression, ctx: ExtractContext): boolean => {
    const identifier = ctx.ast.asIdentifier(tag)
    if (identifier === null || identifier.text !== LOCALIZE_TAG) return false
    return ctx.bindings.get(LOCALIZE_TAG) === null || ctx.bindings.rootsInModule(LOCALIZE_TAG, ANGULAR_LOCALIZE_MODULE)
  }

  const isLinguiTag = (tag: ts.Expression, ctx: ExtractContext): boolean => {
    const identifier = ctx.ast.asIdentifier(tag)
    if (identifier === null) return false
    const imported = importedName(identifier.text, linguiModule, ctx)
    return imported !== null && LINGUI_TAGS.has(imported)
  }

  const visitTaggedTemplate = (node: ts.TaggedTemplateExpression, ctx: ExtractContext): void => {
    if (isLocalizeTag(node.tag, ctx) || isLinguiTag(node.tag, ctx)) emit(DEFAULT_NAMESPACE, node, ctx)
  }

  const visitTag = (node: ts.JsxOpeningLikeElement, ctx: ExtractContext): void => {
    const tag = ctx.ast.tagName(node)
    if (tag === null) return
    const imported = importedName(tag, reactIntlModule, ctx)
    if (imported !== null && REACT_INTL_TAGS.has(imported)) emit(DEFAULT_NAMESPACE, node, ctx)
    const linguiImported = importedName(tag, linguiModule, ctx)
    if (linguiImported !== null && LINGUI_COMPONENTS.has(linguiImported)) emit(DEFAULT_NAMESPACE, node, ctx)
  }

  const visitLocaleAggregatorImport = (node: ts.ImportDeclaration, ctx: ExtractContext): void => {
    if (!localeDir.test(ctx.file) || !localeAggregatorFile.test(ctx.file)) return
    if (!ctx.ts.isStringLiteral(node.moduleSpecifier)) return

    const specifier = node.moduleSpecifier.text
    if (!specifier.startsWith(".")) return

    const namespace = specifier.replace(/^\.\//, "").replace(SCRIPT_FILE, "")
    if (namespace === "" || namespace.includes("/")) return
    if (localeAggregatorFile.test(`${namespace}.ts`)) return

    emit(namespace, node, ctx)
  }

  return {
    name: "i18n",
    provides: ["i18nNamespaces"],
    enablingDependency: ["react-i18next", "vue-i18n", "@nuxtjs/i18n", "@ngx-translate/core", "@angular/localize", "@lingui/core", "@lingui/react", "@lingui/macro"],
    requires: ["bindings", "stringConstants"],
    stage: "main",

    start: () => {
      seen.clear()
      scriptUsesVueI18n = false
    },

    template: (doc, ctx) => {
      for (const expression of doc.expressions) visitTemplateExpression(expression, ctx)
      visitAngularTemplate(doc, ctx)
    },

    enter: (node, ctx) => {
      if (ctx.ts.isImportDeclaration(node)) {
        visitLocaleAggregatorImport(node, ctx)
        return
      }

      if (ctx.ts.isJsxOpeningElement(node) || ctx.ts.isJsxSelfClosingElement(node)) {
        visitTag(node, ctx)
        return
      }

      if (ctx.ts.isTaggedTemplateExpression(node)) {
        visitTaggedTemplate(node, ctx)
        return
      }

      const call = ctx.ast.asCallExpression(node)
      if (call !== null && call === node) visitCall(call, ctx)
    },
  }
}
