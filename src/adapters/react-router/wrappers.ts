import type { AncestorRole, Binding, RouteDialect, WrapperRoleKind, WrapperRule } from "../../core/model.js"
import type { TsNode } from "../types.js"
import { importedBindingOf } from "../values.js"

export type ReactRouterOptions = {
  readonly wrappers?: readonly WrapperRule[]
  readonly factories?: readonly string[]
  readonly routeDialect?: RouteDialect
}

export const ANCESTOR_ROLES: Readonly<Record<WrapperRoleKind, AncestorRole | null>> = {
  layout: "layout",
  guard: "guard",
  errorBoundary: "errorBoundary",
  redirect: null,
  transparent: null,
}

export const regexCache = new Map<string, RegExp>()

export const within = (node: TsNode, scope: TsNode): boolean => node.pos >= scope.pos && node.end <= scope.end

export const regexOf = (pattern: string): RegExp => {
  const cached = regexCache.get(pattern)
  if (cached !== undefined) return cached
  const created = new RegExp(pattern)
  regexCache.set(pattern, created)
  return created
}

export const matchesRule = (rule: WrapperRule, tag: string, binding: Binding | null): boolean => {
  const imported = importedBindingOf(binding)
  const keyedOnBinding = rule.exported !== undefined || rule.importedFrom !== undefined
  const byBinding =
    keyedOnBinding &&
    imported !== null &&
    (rule.exported === undefined || imported.imported === rule.exported) &&
    (rule.importedFrom === undefined || regexOf(rule.importedFrom).test(imported.module))
  const byTag = rule.tagRegex !== undefined && regexOf(rule.tagRegex).test(tag)
  return byBinding || byTag
}

/** The same rules for a router published from another module: a rule keyed on `from` origin keys on `to`. */
export const retargetRules = (rules: readonly WrapperRule[], from: string, to: string): readonly WrapperRule[] =>
  rules.map((rule) => (rule.importedFrom === from ? { ...rule, importedFrom: to } : rule))
