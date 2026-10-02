import type ts from "typescript"
import { isComponentTag, walk } from "../ast.js"
import type { AncestorRef } from "../model.js"
import type { GraphContext } from "./context.js"
import { locatorKey } from "./keys.js"
import type { SpliceCandidate } from "./model.js"

export const describeSplice = (ancestor: Pick<AncestorRef, "splice">): string => {
  const splice = ancestor.splice
  if (splice.kind === "outlet") return splice.name === undefined ? `<${splice.tag}/>` : `<${splice.tag} name="${splice.name}"/>`
  if (splice.kind === "children") return "{children}"
  if (splice.kind === "slot") return `{${splice.name}}`
  return `locator ${locatorKey(splice.locator)}`
}

export const createSpliceScanner = ({ providers, ast, api }: GraphContext) => {
  const lineOf = (source: ts.SourceFile, node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  /**
   * `export default LoginLayout` declares the export on a statement whose whole subtree is one
   * identifier, so searching it for a splice point finds nothing. The alias is followed here rather
   * than in `ast.declarationOf`, because `locate` anchors nodes inside that statement on the export
   * name `default` and `resolveLocator` must keep addressing the same node.
   */
  const scopeOf = (source: ts.SourceFile, exportName: string): ts.Node => {
    const declaration = ast.declarationOf(source, exportName)
    if (declaration === null) return source
    if (!api.isExportAssignment(declaration)) return declaration

    const aliased = ast.asIdentifier(declaration.expression)
    if (aliased === null) return declaration
    return ast.declarationOf(source, aliased.text) ?? declaration
  }

  const initializerOf = (scope: ts.Node): ts.Node | null => {
    if (api.isVariableDeclaration(scope)) return scope.initializer === undefined ? null : ast.unwrap(scope.initializer)
    if (api.isExportAssignment(scope)) return ast.unwrap(scope.expression)
    return null
  }

  const MAX_WRAPPED_DEPTH = 4

  // `withAuth(Content)`, `memo(forwardRef(Content))` and `const Shell = Content` render `Content`: the
  // same-file declarations an initializer wraps or aliases are searched too.
  const wrappedScopesOf = (source: ts.SourceFile, expression: ts.Node | null, depth: number): readonly ts.Node[] => {
    if (expression === null || depth >= MAX_WRAPPED_DEPTH) return []
    const inner = ast.unwrap(expression)
    if (api.isCallExpression(inner))
      return inner.arguments.flatMap((argument) => wrappedScopesOf(source, argument, depth + 1))
    if (!api.isIdentifier(inner)) return []
    const declaration = ast.declarationOf(source, inner.text)
    if (declaration === null) return []
    return [declaration, ...wrappedScopesOf(source, initializerOf(declaration), depth + 1)]
  }

  const exportScopesOf = (source: ts.SourceFile, exportName: string): readonly ts.Node[] => {
    const scope = scopeOf(source, exportName)
    return [scope, ...wrappedScopesOf(source, initializerOf(scope), 0)]
  }

  const LOGICAL_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
    api.SyntaxKind.QuestionQuestionToken,
    api.SyntaxKind.BarBarToken,
    api.SyntaxKind.AmpersandAmpersandToken,
  ])

  const CHILDREN = "children"
  const PROPS = "props"

  const propertyNameOf = (element: ts.BindingElement): string | null => {
    const name = element.propertyName ?? element.name
    return api.isIdentifier(name) ? name.text : null
  }

  // `({ children: content }) => <main>{content}</main>` renders the slot under a local alias.
  const propAliasesIn = (scope: ts.Node, prop: string): ReadonlySet<string> => {
    const aliases = new Set([prop])
    walk(scope, (node) => {
      if (!api.isBindingElement(node) || node.propertyName === undefined || !api.isIdentifier(node.name))
        return
      if (propertyNameOf(node) === prop) aliases.add(node.name.text)
    })
    return aliases
  }

  // `<Shell {...props} />` forwards `children` wholesale, as does a parameter's rest binding — unless the
  // same pattern pulled `children` out first (`({ children, ...rest })`), which leaves `rest` without it.
  const forwardingNamesIn = (scope: ts.Node): ReadonlySet<string> => {
    const included = new Set([PROPS])
    const excluded = new Set<string>()
    walk(scope, (node) => {
      if (!api.isObjectBindingPattern(node)) return
      const bindsChildren = node.elements.some((element) => propertyNameOf(element) === CHILDREN)
      for (const element of node.elements) {
        if (element.dotDotDotToken === undefined || !api.isIdentifier(element.name)) continue
        if (bindsChildren) excluded.add(element.name.text)
        else if (api.isParameter(node.parent)) included.add(element.name.text)
      }
    })
    return new Set([...included].filter((name) => !excluded.has(name)))
  }

  const isPropsObject = (node: ts.Node): boolean => {
    const inner = ast.unwrap(node)
    if (api.isIdentifier(inner)) return inner.text === PROPS
    return api.isPropertyAccessExpression(inner) && inner.name.text === PROPS
  }

  // `{children ?? <Outlet />}` and `{hasChildren ? children : <Outlet />}` are children splices: the
  // default is what renders when nothing is spliced, so the slot is still the `children` operand. Inside
  // JSX any `x.children` counts; in a bare `return` only `props.children` does, so a tree helper's
  // `return node.children` is not mistaken for a slot.
  const referencesProp = (
    node: ts.Node,
    prop: string,
    aliases: ReadonlySet<string>,
    inJsx: boolean,
  ): boolean => {
    const inner = ast.unwrap(node)
    const recurse = (next: ts.Node): boolean => referencesProp(next, prop, aliases, inJsx)
    if (api.isIdentifier(inner)) return aliases.has(inner.text)
    if (api.isPropertyAccessExpression(inner))
      return inner.name.text === prop && (inJsx || isPropsObject(inner.expression))
    if (api.isBinaryExpression(inner) && LOGICAL_OPERATORS.has(inner.operatorToken.kind))
      return recurse(inner.left) || recurse(inner.right)
    if (api.isConditionalExpression(inner)) return recurse(inner.whenTrue) || recurse(inner.whenFalse)
    if (api.isCallExpression(inner)) return inner.arguments.some(recurse)
    return false
  }

  // `return children` and `=> children` render the slot without any JSX around it.
  const renderedExpressionOf = (
    node: ts.Node,
  ): { readonly expression: ts.Node; readonly inJsx: boolean } | null => {
    if (api.isJsxExpression(node))
      return node.expression === undefined ? null : { expression: node.expression, inJsx: true }
    if (api.isReturnStatement(node))
      return node.expression === undefined ? null : { expression: node.expression, inJsx: false }
    if (api.isArrowFunction(node) && !api.isBlock(node.body)) return { expression: node.body, inJsx: false }
    return null
  }

  const isForwardingSpread = (node: ts.Node, forwarding: ReadonlySet<string>): boolean => {
    if (!api.isJsxSpreadAttribute(node)) return false
    const inner = ast.unwrap(node.expression)
    return api.isIdentifier(inner) && forwarding.has(inner.text)
  }

  const propertyTagName = (element: ts.JsxOpeningLikeElement): string | null => {
    const tag = element.tagName
    return api.isPropertyAccessExpression(tag) ? tag.name.text : null
  }

  // `<Outlet/>` is matched three ways, in order: the tag as written; the name the tag was IMPORTED
  // under, so `import { Outlet as Slot }` still splices; and the member of a namespace import, so
  // `import * as Router` + `<Router.Outlet/>` splices too (`tagName` yields the namespace root).
  const memberPathOf = (tag: ts.Node): string | null => {
    if (api.isIdentifier(tag)) return tag.text
    if (!api.isPropertyAccessExpression(tag)) return null
    const root = memberPathOf(tag.expression)
    return root === null ? null : `${root}.${tag.name.text}`
  }

  const matchesMemberOutlet = (file: string, element: ts.JsxOpeningLikeElement, tag: string): boolean => {
    if (memberPathOf(element.tagName) === tag) return true
    const name = ast.tagName(element)
    if (name === null) return false
    return providers.importedNameOf?.(file, name)?.imported === "*" && propertyTagName(element) === tag
  }

  const matchesOutlet = (file: string, element: ts.JsxOpeningLikeElement, tag: string): boolean => {
    if (api.isPropertyAccessExpression(element.tagName)) return matchesMemberOutlet(file, element, tag)
    const name = ast.tagName(element)
    if (name === null) return false
    if (name === tag) return true
    return providers.importedNameOf?.(file, name)?.imported === tag
  }

  // react-router's `useOutlet()` returns the same element `<Outlet/>` renders.
  const callsOutletHook = (file: string, node: ts.Node, tag: string): boolean => {
    if (!api.isCallExpression(node)) return false
    const callee = ast.asIdentifier(node.expression)
    if (callee === null) return false
    const hook = `use${tag}`
    return callee.text === hook || providers.importedNameOf?.(file, callee.text)?.imported === hook
  }

  const isJsxOpening = (node: ts.Node): node is ts.JsxOpeningLikeElement =>
    api.isJsxOpeningElement(node) || api.isJsxSelfClosingElement(node)

  const candidateAt = (source: ts.SourceFile, node: ts.Node): SpliceCandidate => ({
    node,
    pos: node.pos,
    line: lineOf(source, node),
  })

  const byPosition = (candidates: readonly SpliceCandidate[]): readonly SpliceCandidate[] =>
    [...candidates].sort((a, b) => a.pos - b.pos)

  const uniqueByPosition = (candidates: readonly SpliceCandidate[]): readonly SpliceCandidate[] =>
    byPosition([...new Map(candidates.map((candidate) => [candidate.pos, candidate])).values()])

  // Only `children` is forwarded by a `{...props}` spread: a named slot prop is found where it renders.
  const propCandidatesIn = (
    scope: ts.Node,
    source: ts.SourceFile,
    prop: string,
  ): readonly SpliceCandidate[] => {
    const aliases = propAliasesIn(scope, prop)
    const forwarding = prop === CHILDREN ? forwardingNamesIn(scope) : new Set<string>()
    const found: SpliceCandidate[] = []
    walk(scope, (node) => {
      const rendered = renderedExpressionOf(node)
      const isSlot =
        rendered === null
          ? isForwardingSpread(node, forwarding)
          : referencesProp(rendered.expression, prop, aliases, rendered.inJsx)
      if (isSlot) found.push(candidateAt(source, node))
    })
    return byPosition(found)
  }

  const outletCandidatesIn = (
    file: string,
    scope: ts.Node,
    source: ts.SourceFile,
    tag: string,
  ): readonly SpliceCandidate[] => {
    const found: SpliceCandidate[] = []
    walk(scope, (node) => {
      const isSlot = isJsxOpening(node) ? matchesOutlet(file, node, tag) : callsOutletHook(file, node, tag)
      if (isSlot) found.push(candidateAt(source, node))
    })
    return byPosition(found)
  }

  const componentScopesOf = (source: ts.SourceFile, declaration: ts.Node): readonly ts.Node[] => [
    declaration,
    ...wrappedScopesOf(source, initializerOf(declaration), 0),
  ]

  const renderedComponentOf = (source: ts.SourceFile, node: ts.Node): ts.Node | null => {
    if (!isJsxOpening(node) || !api.isIdentifier(node.tagName)) return null
    const tag = node.tagName.text
    return isComponentTag(tag) ? ast.declarationOf(source, tag) : null
  }

  const renderedScopesIn = (source: ts.SourceFile, scope: ts.Node): readonly ts.Node[] => {
    const found: ts.Node[] = []
    walk(scope, (node) => {
      const declaration = renderedComponentOf(source, node)
      if (declaration !== null) found.push(...componentScopesOf(source, declaration))
    })
    return found
  }

  const MAX_RENDERED_DEPTH = 4

  const renderedOutletsAmong = (
    file: string,
    source: ts.SourceFile,
    scopes: readonly ts.Node[],
    seen: ReadonlySet<ts.Node>,
    tag: string,
    depth: number,
  ): readonly SpliceCandidate[] => {
    const next = [...new Set(scopes.flatMap((scope) => renderedScopesIn(source, scope)))]
      .filter((scope) => !seen.has(scope))
      .sort((a, b) => a.pos - b.pos)
    if (depth >= MAX_RENDERED_DEPTH || next.length === 0) return []
    const found = next.flatMap((scope) => outletCandidatesIn(file, scope, source, tag))
    if (found.length > 0) return found
    return renderedOutletsAmong(file, source, next, new Set([...seen, ...next]), tag, depth + 1)
  }

  const exportOutletsIn = (
    file: string,
    source: ts.SourceFile,
    scopes: readonly ts.Node[],
    tag: string,
  ): readonly SpliceCandidate[] => {
    const direct = scopes.flatMap((scope) => outletCandidatesIn(file, scope, source, tag))
    if (direct.length > 0 || scopes.includes(source)) return direct
    return renderedOutletsAmong(file, source, scopes, new Set(scopes), tag, 0)
  }

  const spliceCandidatesIn = (ancestor: AncestorRef, source: ts.SourceFile): readonly SpliceCandidate[] => {
    const splice = ancestor.splice

    if (splice.kind === "at") {
      const node = ast.resolveLocator(source, splice.locator)
      return node === null ? [] : [candidateAt(source, node)]
    }

    const scopes = exportScopesOf(source, ancestor.exportName)
    if (splice.kind === "outlet") return uniqueByPosition(exportOutletsIn(ancestor.file, source, scopes, splice.tag))
    const prop = splice.kind === "children" ? CHILDREN : splice.name
    return uniqueByPosition(scopes.flatMap((scope) => propCandidatesIn(scope, source, prop)))
  }

  return {
    CHILDREN,
    scopeOf,
    initializerOf,
    wrappedScopesOf,
    propertyTagName,
    isJsxOpening,
    byPosition,
    propCandidatesIn,
    outletCandidatesIn,
    spliceCandidatesIn,
  }
}
