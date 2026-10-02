import type ts from "typescript"
import type { ModulePattern } from "../core/bindings.js"
import type { ExtractContext, FactExtractor } from "./types.js"

// Flag lookups have no canonical npm package (`getConfiguration` is typically a project-local util,
// not an installed dependency), so there is no module to bind against —
// unlike every other extractor in this file set. The configured name IS the contract here; binding
// discipline still applies everywhere a module CAN disambiguate (see `store.ts`, `query.ts`).
export const DEFAULT_LOOKUP_FUNCTIONS = ["getConfiguration", "useFlag", "isEnabled", "useFeatureFlag"] as const

const DEFAULT_LOOKUP_SET: ReadonlySet<string> = new Set(DEFAULT_LOOKUP_FUNCTIONS)

// Matches both the `FEATURE_FLAG_CONFIG` object and enum-shaped flag tables.
export const DEFAULT_CONFIG_TABLE_PATTERN = /FEATURE.?FLAGS?/i

const GROWTHBOOK_MODULE: ModulePattern = /^@growthbook\/growthbook(-react)?$/
const GROWTHBOOK_HOOKS = new Set(["useFeatureIsOn", "useFeatureValue", "useFeature"])
const GROWTHBOOK_METHODS = new Set(["isOn", "getFeatureValue"])
const GROWTHBOOK_CLASS = "GrowthBook"
const GROWTHBOOK_CLIENT_HOOK = "useGrowthBook"
const GROWTHBOOK_JSX = new Map([
  ["IfFeatureEnabled", "feature"],
  ["FeatureString", "feature"],
])

export type FeatureFlagOptions = {
  readonly lookupFunctions?: readonly string[]
  readonly configTablePattern?: RegExp
  readonly attributeName?: string
}

export const createFeatureFlagsExtractor = (options: FeatureFlagOptions = {}): FactExtractor => {
  const lookupFunctions = new Set(options.lookupFunctions ?? DEFAULT_LOOKUP_FUNCTIONS)
  const configTablePattern = options.configTablePattern ?? DEFAULT_CONFIG_TABLE_PATTERN
  const attributeName = options.attributeName ?? "featureFlag"

  const seen = new Set<string>()
  const localClients = new Set<string>()

  const growthBookImport = (local: string, ctx: ExtractContext): string | null => {
    const binding = ctx.bindings.get(local)
    if (binding === null || binding.kind !== "import") return null
    if (!ctx.bindings.rootsInModule(local, GROWTHBOOK_MODULE)) return null
    return binding.imported === "default" || binding.imported === "*" ? local : binding.imported
  }

  const flagKey = (node: ts.Node | undefined, ctx: ExtractContext): string | null => {
    const flat = ctx.flattenString(node)
    if (flat !== null) return flat.value
    const target = node !== undefined && ctx.ts.isJsxExpression(node) ? node.expression : node
    const access = ctx.ast.asPropertyAccess(target)
    if (access === null || ctx.ast.asIdentifier(access.expression) === null) return null
    return access.name.text
  }

  const emit = (flag: string, node: ts.Node, ctx: ExtractContext): void => {
    if (seen.has(flag)) return
    seen.add(flag)
    ctx.emitFact("featureGates", flag, node)
  }

  const visitLookupCall = (call: ts.CallExpression, ctx: ExtractContext): void => {
    const callee = ctx.ast.asIdentifier(call.expression) ?? ctx.ast.asPropertyAccess(call.expression)?.name ?? null
    if (callee === null || !lookupFunctions.has(callee.text)) return

    const flat = ctx.flattenString(call.arguments[0])
    if (flat !== null) {
      emit(flat.value, call, ctx)
      return
    }
    const argument = call.arguments[0]
    if (argument === undefined || DEFAULT_LOOKUP_SET.has(callee.text)) return
    const member = ctx.ast.asPropertyAccess(ctx.ast.unwrap(argument))
    if (member !== null) emit(member.name.text, call, ctx)
  }

  const isGrowthBookClient = (receiver: ts.Expression, ctx: ExtractContext): boolean => {
    const identifier = ctx.ast.asIdentifier(ctx.ast.unwrap(receiver))
    if (identifier === null) return false
    return (
      localClients.has(identifier.text) ||
      ctx.bindings.isHookResult(identifier.text, GROWTHBOOK_CLIENT_HOOK, GROWTHBOOK_MODULE)
    )
  }

  const visitGrowthBookCall = (call: ts.CallExpression, ctx: ExtractContext): void => {
    const callee = ctx.ast.asIdentifier(call.expression)
    const hook = callee === null ? null : growthBookImport(callee.text, ctx)
    const access = ctx.ast.asPropertyAccess(call.expression)
    const isHook = hook !== null && GROWTHBOOK_HOOKS.has(hook)
    const isMethod =
      access !== null && GROWTHBOOK_METHODS.has(access.name.text) && isGrowthBookClient(access.expression, ctx)
    if (!isHook && !isMethod) return

    const key = flagKey(call.arguments[0], ctx)
    if (key !== null) emit(key, call, ctx)
  }

  const visitGrowthBookClient = (node: ts.VariableDeclaration, ctx: ExtractContext): void => {
    if (!ctx.ts.isIdentifier(node.name)) return
    const created = ctx.ast.asNewExpression(node.initializer)
    const constructor = created === null ? null : ctx.ast.asIdentifier(created.expression)
    if (constructor === null || growthBookImport(constructor.text, ctx) !== GROWTHBOOK_CLASS) return
    localClients.add(node.name.text)
  }

  const visitGrowthBookJsx = (node: ts.JsxOpeningLikeElement, ctx: ExtractContext): void => {
    const tag = ctx.ast.asIdentifier(node.tagName)
    const component = tag === null ? null : growthBookImport(tag.text, ctx)
    const attribute = component === null ? undefined : GROWTHBOOK_JSX.get(component)
    if (attribute === undefined) return
    const key = flagKey(ctx.ast.attributeByName(node, attribute)?.initializer, ctx)
    if (key !== null) emit(key, node, ctx)
  }

  const visitJsxFlag = (node: ts.JsxOpeningLikeElement, ctx: ExtractContext): void => {
    const flat = ctx.flattenString(ctx.ast.attributeByName(node, attributeName)?.initializer)
    if (flat !== null) emit(flat.value, node, ctx)
  }

  const flagsFromEnum = (declaration: ts.EnumDeclaration, ctx: ExtractContext): void => {
    for (const member of declaration.members) {
      const flat = member.initializer === undefined ? null : ctx.flattenString(member.initializer)
      emit(flat?.value ?? member.name.getText(), member, ctx)
    }
  }

  const flagsFromArray = (array: ts.ArrayLiteralExpression, ctx: ExtractContext): void => {
    for (const element of array.elements) {
      const object = ctx.ast.asObjectLiteral(element)
      if (object !== null) {
        const key = object.properties.find(
          (candidate): candidate is ts.PropertyAssignment =>
            ctx.ts.isPropertyAssignment(candidate) &&
            ctx.ts.isIdentifier(candidate.name) &&
            ["key", "name", "id"].includes(candidate.name.text),
        )
        const flat = key === undefined ? null : ctx.flattenString(key.initializer)
        if (flat !== null) emit(flat.value, element, ctx)
        continue
      }

      const flat = ctx.flattenString(element)
      if (flat !== null) emit(flat.value, element, ctx)
    }
  }

  const flagsFromObject = (object: ts.ObjectLiteralExpression, ctx: ExtractContext): void => {
    for (const property of object.properties) {
      if (!ctx.ts.isPropertyAssignment(property) && !ctx.ts.isShorthandPropertyAssignment(property)) continue
      const name = property.name
      if (name === undefined) continue
      const text = ctx.ts.isIdentifier(name) || ctx.ts.isStringLiteral(name) ? name.text : null
      if (text !== null) emit(text, property, ctx)
    }
  }

  const visitConfigTable = (node: ts.Node, ctx: ExtractContext): void => {
    if (ctx.ts.isEnumDeclaration(node)) {
      if (configTablePattern.test(node.name.text)) flagsFromEnum(node, ctx)
      return
    }

    if (!ctx.ts.isVariableDeclaration(node) || !ctx.ts.isIdentifier(node.name) || node.initializer === undefined)
      return
    if (!configTablePattern.test(node.name.text)) return

    const array = ctx.ast.asArrayLiteral(node.initializer)
    if (array !== null) {
      flagsFromArray(array, ctx)
      return
    }

    const object = ctx.ast.asObjectLiteral(node.initializer)
    if (object !== null) flagsFromObject(object, ctx)
  }

  return {
    name: "feature-flags",
    provides: ["featureGates"],
    requires: ["bindings", "stringConstants"],
    stage: "main",

    start: () => {
      seen.clear()
      localClients.clear()
    },

    enter: (node, ctx) => {
      const api = ctx.ts
      if (api.isJsxOpeningElement(node) || api.isJsxSelfClosingElement(node)) {
        visitJsxFlag(node, ctx)
        visitGrowthBookJsx(node, ctx)
        return
      }

      if (api.isVariableDeclaration(node)) visitGrowthBookClient(node, ctx)

      if (api.isEnumDeclaration(node) || api.isVariableDeclaration(node)) {
        visitConfigTable(node, ctx)
        return
      }

      const call = ctx.ast.asCallExpression(node)
      if (call === null || call !== node) return
      visitLookupCall(call, ctx)
      visitGrowthBookCall(call, ctx)
    },
  }
}
