import type ts from "typescript"
import { walk } from "../ast.js"
import { isSfcFile } from "../extensions.js"
import type { AncestorRef, EntryRef, NodeLocator, RenderEdge, ScreenId } from "../model.js"
import { by, sortStrings } from "../order.js"
import type { GraphContext } from "./context.js"
import type { ResolvedRoot } from "./model.js"
import { wholeFileRoot } from "./model.js"
import type { createRenderEdges } from "./render-edges.js"
import { localIdSuffix } from "./screens.js"
import type { createSpliceScanner } from "./splice-scan.js"
import type { BuildGraphInput } from "./types.js"

type RouteExport = Pick<AncestorRef, "file" | "exportName">

export const createRoots = (
  { providers, ast, api, diagnostics, factsOf }: GraphContext,
  input: Pick<BuildGraphInput, "contributions">,
  { scopeOf }: ReturnType<typeof createSpliceScanner>,
  { mergeRenderEdges, subtreeRenderEdges }: ReturnType<typeof createRenderEdges>,
) => {
  const resolveRoot = (
    entry: Extract<EntryRef, { kind: "file" }>,
    localId: string,
    screenId: ScreenId,
  ): ResolvedRoot => {
    if (isSfcFile(entry.file)) return wholeFileRoot(entry.file)
    if (entry.at === undefined) return entryExportRootOf(entry)

    const source = providers.sourceOf?.(entry.file) ?? null
    const node = source === null ? null : ast.resolveLocator(source, entry.at)
    if (node === null) {
      diagnostics.error(
        "screens/unresolvable-locator",
        `entry '${entry.file}' export '${entry.at.export}' has no node at path [${entry.at.path.join(", ")}]`,
        { file: entry.file, screenId },
      )
      return wholeFileRoot(entry.file)
    }

    return subFileRoot({
      file: entry.file,
      locator: entry.at,
      renders: subtreeRenderEdges(entry.file, node),
      expandKey: `${entry.file}#${localIdSuffix(localId)}`,
      label: `${factsOf(entry.file).component}#${localIdSuffix(localId)}`,
    })
  }

  const subFileRoot = (root: {
    readonly file: string
    readonly locator: NodeLocator
    readonly renders: readonly RenderEdge[] | null
    readonly expandKey: string
    readonly label: string
  }): ResolvedRoot => {
    const whole = factsOf(root.file)
    const scoped = providers.subtreeFacts?.(root.file, root.locator) ?? null
    return {
      file: root.file,
      expandKey: root.expandKey,
      label: root.label,
      facts: {
        ...(scoped ?? whole),
        file: root.file,
        renders: root.renders ?? scoped?.renders ?? whole.renders,
        // A module-level import is file-level; there is no honest way to attribute it to one branch
        // (§6.3.2), so `uses` stays whole-file for every sub-file root.
        uses: whole.uses,
      },
    }
  }

  const routeExportRefsOf = (contribution: BuildGraphInput["contributions"][number]): readonly RouteExport[] => [
    ...(contribution.draft.ancestors ?? []).filter((ancestor) => ancestor.role !== "transparent"),
    ...contribution.draft.entries.flatMap((entry) => (entry.kind === "file" && entry.at === undefined ? [entry] : [])),
  ]

  /**
   * Every non-transparent ancestor export and whole-export entry per file, across all contributions.
   * A file several route levels name by different exports (`RootLayout` and `AppLayout` side by side) is not one node:
   * each export gets its own, built from its own declaration.
   */
  const routeExportsByFile = ((): ReadonlyMap<string, ReadonlySet<string>> => {
    const byFile = new Map<string, Set<string>>()
    for (const { file, exportName } of input.contributions.flatMap(routeExportRefsOf)) {
      if (exportName === "") continue
      byFile.set(file, new Set([...(byFile.get(file) ?? []), exportName]))
    }
    return byFile
  })()

  const declaredNamesOf = (statement: ts.Statement): readonly string[] => {
    if (api.isClassDeclaration(statement) || api.isFunctionDeclaration(statement))
      return statement.name === undefined ? [] : [statement.name.text]
    if (!api.isVariableStatement(statement)) return []
    return statement.declarationList.declarations.flatMap((declaration) =>
      api.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    )
  }

  /**
   * The exports an ancestor shares its file with, or `null` when the ancestor IS its file: the only
   * route export there, and either the file's main component or an export that cannot be told apart
   * from it (`default`, the whole file). Any other export is also scoped away from every component
   * export that renders components of its own, `default` included.
   */
  const siblingExportsOf = (ancestor: RouteExport, source: ts.SourceFile): readonly string[] | null => {
    const { file, exportName } = ancestor
    if (exportName === "" || ast.declarationOf(source, exportName) === null) return null

    const main = factsOf(file).component
    const isMainExport = exportName === "default" || exportName === main
    const shared = new Set([
      ...(routeExportsByFile.get(file) ?? []),
      ...templateOwnersOf(file, source),
      ...(isMainExport ? [] : renderingSiblingsOf(file, source, exportName)),
    ])
    shared.delete(exportName)
    if (shared.size > 0) return sortStrings(shared)

    const isOtherComponent = !isMainExport && ast.declarationOf(source, main) !== null
    return isOtherComponent ? [main] : null
  }

  const isTemplateOwner = (file: string, name: string): boolean =>
    (providers.templateTargetsOf?.(file, name) ?? null) !== null

  const templateOwnersOf = (file: string, source: ts.SourceFile): readonly string[] =>
    source.statements.flatMap(declaredNamesOf).filter((name) => isTemplateOwner(file, name))

  const hasModifier = (statement: ts.Statement, kind: ts.SyntaxKind): boolean =>
    api.canHaveModifiers(statement) && (api.getModifiers(statement) ?? []).some((modifier) => modifier.kind === kind)

  const isNamedExportStatement = (statement: ts.Statement): boolean =>
    hasModifier(statement, api.SyntaxKind.ExportKeyword) && !hasModifier(statement, api.SyntaxKind.DefaultKeyword)

  const localExportNamesOf = (statement: ts.Statement): readonly string[] => {
    if (!api.isExportDeclaration(statement) || statement.moduleSpecifier !== undefined || statement.isTypeOnly) return []
    const clause = statement.exportClause
    if (clause === undefined || !api.isNamedExports(clause)) return []
    return clause.elements.filter((element) => !element.isTypeOnly).map((element) => element.name.text)
  }

  const exportedNamesOf = (source: ts.SourceFile): readonly string[] => [
    ...source.statements.filter(isNamedExportStatement).flatMap(declaredNamesOf),
    ...source.statements.flatMap(localExportNamesOf),
    ...(ast.declarationOf(source, "default") === null ? [] : ["default"]),
  ]

  const isComponentName = (name: string): boolean => name === "default" || /^[A-Z]/.test(name)

  const rendersComponents = (file: string, scope: ts.Node): boolean =>
    (subtreeRenderEdges(file, scope) ?? []).length > 0

  const isJsxTagName = (node: ts.Identifier): boolean => {
    const parent = node.parent
    if (!api.isJsxOpeningElement(parent) && !api.isJsxSelfClosingElement(parent) && !api.isJsxClosingElement(parent))
      return false
    return parent.tagName === node
  }

  const wrapsByValue = (scope: ts.Node, name: string): boolean => {
    let found = false
    walk(scope, (node) => {
      if (api.isIdentifier(node) && node.text === name && !isJsxTagName(node)) found = true
    })
    return found
  }

  const renderingSiblingsOf = (file: string, source: ts.SourceFile, exportName: string): readonly string[] => {
    const own = scopeOf(source, exportName)
    const ownNames = new Set(ownScopesOf(file, source, own).flatMap(identifiersIn))
    const isSeparate = (name: string, scope: ts.Node): boolean =>
      scope !== source &&
      scope !== own &&
      !ownNames.has(ownNameOf(scope) ?? name) &&
      !wrapsByValue(scope, exportName)
    return exportedNamesOf(source)
      .filter((name) => name !== exportName && isComponentName(name))
      .filter((name) => {
        const scope = scopeOf(source, name)
        return isSeparate(name, scope) && rendersComponents(file, scope)
      })
  }

  const ownNameOf = (scope: ts.Node): string | null => {
    if (api.isFunctionDeclaration(scope) || api.isClassDeclaration(scope)) return scope.name?.text ?? null
    if (api.isVariableDeclaration(scope) && api.isIdentifier(scope.name)) return scope.name.text
    return null
  }

  const labelOf = (exportName: string, scope: ts.Node, main: string): string => {
    if (exportName !== "default") return exportName
    return ownNameOf(scope) ?? main
  }

  const templateTargetsOf = (file: string, exportNames: readonly string[]): readonly string[] =>
    exportNames.flatMap((name) => providers.templateTargetsOf?.(file, name) ?? [])

  const identifiersIn = (scope: ts.Node): readonly string[] => {
    const names = new Set<string>()
    walk(scope, (node) => {
      if (api.isIdentifier(node)) names.add(node.text)
    })
    return sortStrings(names)
  }

  const localDeclarationsIn = (
    file: string,
    source: ts.SourceFile,
    scope: ts.Node,
  ): ReadonlyMap<string, ts.Node> =>
    new Map(
      identifiersIn(scope)
        .filter((name) => providers.declaringFileOf?.(file, name) === null)
        .flatMap((name): readonly [string, ts.Node][] => {
          const declaration = ast.declarationOf(source, name)
          return declaration === null || declaration === scope ? [] : [[name, declaration]]
        }),
    )

  /**
   * A scope plus the top-level declarations it references, transitively: a layout's `<Frame>` declared
   * beside it is part of what the layout renders, though it has no node of its own.
   */
  const ownScopesOf = (file: string, source: ts.SourceFile, scope: ts.Node): readonly ts.Node[] => {
    const found = new Map<string, ts.Node>()
    const pending = [scope]
    for (let next = pending.shift(); next !== undefined; next = pending.shift())
      for (const [name, declaration] of localDeclarationsIn(file, source, next)) {
        if (found.has(name) || declaration === scope) continue
        found.set(name, declaration)
        pending.push(declaration)
      }
    return [scope, ...found.values()]
  }

  const referencedFilesOf = (file: string, scopes: readonly ts.Node[]): ReadonlySet<string> =>
    new Set(
      scopes
        .flatMap(identifiersIn)
        .map((name) => providers.declaringFileOf?.(file, name) ?? null)
        .filter((target): target is string => target !== null),
    )

  /**
   * An export's render edges: those its own JSX (and its same-file helpers') renders, with the guards
   * found there, and whole-file edges to a file it references by name (a value reference). A whole-file
   * edge no export can be shown to reference (a `lazy(() => import(…))` binding) stays with the file's
   * main component when that is one of the route exports, and with every export otherwise — never
   * dropped. What only a sibling export references is dropped.
   */
  const exportRenderEdges = (scoped: {
    readonly file: string
    readonly source: ts.SourceFile
    readonly scope: ts.Node
    readonly exportName: string
    readonly siblings: readonly string[]
    readonly keepsUnattributed: boolean
  }): readonly RenderEdge[] | null => {
    const { file, source, siblings } = scoped
    if (providers.declaringFileOf === undefined) return null
    const scopes = ownScopesOf(file, source, scoped.scope)
    const own = mergeRenderEdges(scopes.flatMap((node) => subtreeRenderEdges(file, node) ?? []))
    const ownFiles = new Set(own.map((edge) => edge.file))
    const ownReferences = new Set([...referencedFilesOf(file, scopes), ...templateTargetsOf(file, [scoped.exportName])])
    const siblingReferences = new Set([
      ...referencedFilesOf(
        file,
        siblings.flatMap((name) => {
          const declaration = scopeOf(source, name)
          return declaration === source ? [] : ownScopesOf(file, source, declaration)
        }),
      ),
      ...templateTargetsOf(file, siblings),
    ])
    const isUnattributed = (target: string): boolean =>
      !siblingReferences.has(target) && scoped.keepsUnattributed
    const borrowed = factsOf(file).renders.filter(
      (edge) => !ownFiles.has(edge.file) && (ownReferences.has(edge.file) || isUnattributed(edge.file)),
    )
    return [...own, ...borrowed].sort(by((edge) => edge.file))
  }

  const ancestorRootOf = (ancestor: AncestorRef, source: ts.SourceFile): ResolvedRoot =>
    isSfcFile(ancestor.file) ? wholeFileRoot(ancestor.file) : exportRootOf(ancestor, source)

  const entryExportRootOf = (entry: RouteExport): ResolvedRoot => {
    const source = providers.sourceOf?.(entry.file) ?? null
    return source === null ? wholeFileRoot(entry.file) : exportRootOf(entry, source)
  }

  const exportRootOf = (ancestor: RouteExport, source: ts.SourceFile): ResolvedRoot => {
    const siblings = siblingExportsOf(ancestor, source)
    if (siblings === null) return wholeFileRoot(ancestor.file)

    const main = factsOf(ancestor.file).component
    const scope = scopeOf(source, ancestor.exportName)
    const label = labelOf(ancestor.exportName, scope, main)
    const isMain = ancestor.exportName === "default" || label === main
    const routeExports = routeExportsByFile.get(ancestor.file) ?? new Set<string>()
    const mainIsRouteExport = routeExports.has(main) || routeExports.has("default")
    return subFileRoot({
      file: ancestor.file,
      locator: ast.locate(scope),
      renders: exportRenderEdges({
        file: ancestor.file,
        source,
        scope,
        exportName: ancestor.exportName,
        siblings,
        keepsUnattributed: isMain || !mainIsRouteExport,
      }),
      expandKey: `${ancestor.file}#${label}`,
      label,
    })
  }

  return { resolveRoot, ancestorRootOf }
}
