import { walk } from "../../core/ast.js"
import type { EntryRef, TsNode } from "../types.js"
import { importedBindingOf } from "../values.js"
import type { GuardAuth, ItemScope } from "./model.js"
import type { ResolveApi } from "./resolve.js"
import type { DiscoveryState } from "./state.js"
import type ts from "typescript"

export const createItemScope = (deps: DiscoveryState & ResolveApi) => {
  const { ctx, stringValue, memberValue } = deps

  // ---- mapped route data: `routes.map((route) => <Route path={route.path} …/>)` ----

  const scopedName = (scope: ItemScope | null, name: string): { scope: ItemScope; member: string | null } | null => {
    if (scope === null) return null
    const member = scope.names.get(name)
    return member === undefined ? scopedName(scope.outer, name) : { scope, member }
  }

  /** What a scoped expression reads of the item: the whole item (`route`, member `null`) or one member. */
  const itemReadOf = (
    node: TsNode | undefined,
    scope: ItemScope | null,
  ): { scope: ItemScope; member: string | null } | null => {
    if (node === undefined || scope === null) return null
    const inner = ctx.ts.isJsxExpression(node) ? node.expression : node
    if (inner === undefined) return null
    const target = ctx.unwrap(inner)

    const identifier = ctx.ast.asIdentifier(target)
    if (identifier !== null) return scopedName(scope, identifier.text)

    const access = ctx.ast.asPropertyAccess(target)
    const root = access === null ? null : ctx.ast.asIdentifier(access.expression)
    const item = root === null ? null : scopedName(scope, root.text)
    if (access === null || item === null || item.member !== null) return null
    return { scope: item.scope, member: access.name.text }
  }

  /** The item member a scoped expression reads (`route.path`, or a destructured `path`), else `null`. */
  const itemValue = (
    node: TsNode | undefined,
    scope: ItemScope | null,
  ): { value: TsNode | undefined; file: string } | null => {
    const read = itemReadOf(node, scope)
    if (read === null || read.member === null) return null
    const value = memberValue(read.scope.item, read.member)?.value
    if (value !== undefined) return { value, file: read.scope.file }
    return read.scope.defaults.get(read.member) ?? { value, file: read.scope.file }
  }

  const mentionsItem = (node: TsNode | undefined, scope: ItemScope | null): boolean => {
    if (node === undefined || scope === null) return false
    let found = false
    walk(node, (candidate) => {
      const parent = candidate.parent
      const isMemberName = parent !== undefined && ctx.ts.isPropertyAccessExpression(parent) && parent.name === candidate
      if (ctx.ts.isIdentifier(candidate) && !isMemberName && scopedName(scope, candidate.text) !== null) found = true
    })
    return found
  }

  const readString = (node: TsNode | undefined, file: string, scope: ItemScope | null): string | null => {
    const item = itemValue(node, scope)
    return item === null ? stringValue(node, file) : stringValue(item.value, item.file)
  }

  const attributeOf = (
    element: ts.JsxOpeningLikeElement,
    name: string | undefined,
    file: string,
    scope: ItemScope | null,
  ): string | null =>
    name === undefined ? null : readString(ctx.ast.attributeByName(element, name)?.initializer, file, scope)

  const entryOf = (file: string, tag: string): EntryRef => {
    const binding = ctx.bindingsFor(file).get(tag)
    if (importedBindingOf(binding) !== null) return { kind: "binding", from: file, local: tag }

    const source = ctx.sourceFile(file)
    const declared = source === null ? null : ctx.ast.declarationOf(source, tag)
    if (declared !== null) return { kind: "file", file, exportName: tag }
    return { kind: "binding", from: file, local: tag }
  }

  const attributeValue = (attribute: ts.JsxAttributeLike): TsNode | undefined =>
    ctx.ts.isJsxAttribute(attribute) ? attribute.initializer : attribute.expression

  /** `<ProtectedRoute route={route}/>`: an attribute value reads the mapped item, or a member of it. */
  const receivesItem = (element: ts.JsxOpeningLikeElement | null, scope: ItemScope | null): boolean =>
    element !== null &&
    element.attributes.properties.some((attribute) => mentionsItem(attributeValue(attribute), scope))

  /** One guard that decides nothing per item protects the screen whatever the others do. */
  const guardAuth = (current: GuardAuth | null, perItem: boolean): GuardAuth =>
    current === "protected" || !perItem ? "protected" : "per-item"

  const attributeName = (attribute: ts.JsxAttributeLike): string | null =>
    ctx.ts.isJsxAttribute(attribute) ? (ctx.ast.asIdentifier(attribute.name)?.text ?? null) : null

  return { itemReadOf, itemValue, mentionsItem, attributeOf, entryOf, attributeValue, receivesItem, guardAuth, attributeName }
}

export type ItemScopeApi = ReturnType<typeof createItemScope>
