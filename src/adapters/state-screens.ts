import type { Ast } from "../core/ast.js"
import { createAst, walk } from "../core/ast.js"
import type { Activation, Evidence, HolderSpec, NodeLocator } from "../core/model.js"
import { by, byNumber, thenBy, uniqueBy } from "../core/order.js"
import type { TypeScriptApi } from "../core/tsconfig.js"
import type { Mv3Manifest } from "./manifest-activation.js"
import {
  findMv3Manifests,
  followPopupChain,
  mv3Evidence,
  resolveManifestScript,
} from "./manifest-activation.js"
import type {
  Adapter,
  DetectResult,
  DiscoverContext,
  EntryRef,
  ProjectContext,
  ScreenDraft,
  ScreenSource,
  TsNode,
} from "./types.js"
import { globOf, JSX_EXTENSIONS, stripSourceExtension } from "../core/extensions.js"

export const SOURCE_NAME = "state-screens"

/** Always applicable, never live on its own: a router-less app must be selected, not guessed into. */
export const DETECT_SCORE_LAST_RESORT = 1

export const DETECT_SCORE_MV3_BONUS = 50

export type { HolderSpec }

export type StateScreensOptions = {
  readonly entryComponents?: readonly HolderSpec[]
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const SOURCE_GLOB = globOf(JSX_EXTENSIONS)

const asts = new WeakMap<TypeScriptApi, Ast>()

const astFor = (api: TypeScriptApi): Ast => {
  const cached = asts.get(api)
  if (cached !== undefined) return cached
  const created = createAst(api)
  asts.set(api, created)
  return created
}

const functionOwnerOf = (ctx: ProjectContext, node: TsNode): TsNode | null => {
  let current: TsNode | undefined = node.parent
  while (current !== undefined) {
    if (
      ctx.ts.isFunctionDeclaration(current) ||
      ctx.ts.isFunctionExpression(current) ||
      ctx.ts.isArrowFunction(current) ||
      ctx.ts.isMethodDeclaration(current)
    )
      return current
    current = current.parent
  }
  return null
}

/** The §10.1 last-resort signal: one function returning JSX down more than one branch. */
const guardedJsxAlternatives = (ctx: ProjectContext, file: string, text: string): Evidence | null => {
  const source = ctx.ts.createSourceFile(file, text, ctx.ts.ScriptTarget.Latest, true)
  const returnsByFunction = new Map<TsNode, number>()
  let found: Evidence | null = null

  walk(source, (node) => {
    if (found !== null) return
    if (!ctx.ts.isReturnStatement(node)) return
    const { expression } = node
    if (expression === undefined) return
    if (!astFor(ctx.ts).containsJsx(expression)) return

    const owner = functionOwnerOf(ctx, node)
    if (owner === null) return

    const seen = (returnsByFunction.get(owner) ?? 0) + 1
    returnsByFunction.set(owner, seen)
    if (seen < 2) return

    found = {
      what: "component with guarded top-level JSX alternatives",
      file,
      line: ctx.ts.getLineAndCharacterOfPosition(source, node.getStart(source)).line + 1,
    }
  })

  return found
}

const lastResortEvidence = (ctx: ProjectContext): readonly Evidence[] => {
  for (const file of ctx.glob(SOURCE_GLOB)) {
    if (ctx.isGenerated(file)) continue
    const text = ctx.readFile(file)
    if (text === null) continue
    const evidence = guardedJsxAlternatives(ctx, file, text)
    if (evidence !== null) return [evidence]
  }
  return []
}

export const detectStateScreens = (ctx: ProjectContext): DetectResult => {
  // §10.1: `manifest_version: 3` alone is not the signal — the bonus needs a real MV3 SURFACE, which
  // is exactly what `findMv3Manifests` filters for.
  const manifests = findMv3Manifests(ctx)

  if (manifests.length === 0)
    return { score: DETECT_SCORE_LAST_RESORT, evidence: lastResortEvidence(ctx) }
  return {
    score: DETECT_SCORE_LAST_RESORT + DETECT_SCORE_MV3_BONUS,
    evidence: manifests.map(mv3Evidence),
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

type Holder = {
  readonly file: string
  readonly exportName: string
  readonly name: string
  readonly declaration: TsNode
}

type ReturnSite = {
  readonly root: TsNode
  readonly guard: readonly string[]
}

type Branch = {
  readonly node: TsNode
  readonly condition: string
}

const componentNameOf = (file: string): string => {
  const base = stripSourceExtension(file.slice(file.lastIndexOf("/") + 1))
  if (base !== "index") return base
  const withoutFile = file.slice(0, file.lastIndexOf("/"))
  return withoutFile.slice(withoutFile.lastIndexOf("/") + 1)
}

const runDiscovery = (ctx: DiscoverContext, options: StateScreensOptions): readonly ScreenDraft[] => {
  const kind = ctx.ts.SyntaxKind

  const childrenOf = (node: TsNode): readonly TsNode[] => {
    const children: TsNode[] = []
    node.forEachChild((child) => {
      children.push(child)
    })
    return children
  }

  const lastChildOf = (node: TsNode): TsNode | undefined => {
    const children = childrenOf(node)
    return children[children.length - 1]
  }

  const FUNCTION_KINDS: readonly number[] = [
    kind.ArrowFunction,
    kind.FunctionExpression,
    kind.FunctionDeclaration,
    kind.MethodDeclaration,
  ]

  const spans = (outer: TsNode, inner: TsNode): boolean =>
    outer !== inner && outer.pos <= inner.pos && inner.end <= outer.end

  // ---- holders -------------------------------------------------------------

  const holderFor = (spec: HolderSpec): Holder | null => {
    const source = ctx.sourceFile(spec.file)
    if (source === null) return null

    const wanted = spec.exportName ?? null
    const names = wanted === null ? ["default", componentNameOf(spec.file)] : [wanted]

    for (const name of names) {
      const declaration = ctx.ast.declarationOf(source, name)
      if (declaration === null) continue
      const declaredName =
        childrenOf(declaration).flatMap((child) => {
          const identifier = ctx.ast.asIdentifier(child)
          return identifier === null ? [] : [identifier.text]
        })[0] ?? null
      return {
        file: spec.file,
        exportName: name,
        name: name === "default" ? (declaredName ?? componentNameOf(spec.file)) : name,
        declaration,
      }
    }

    return null
  }

  const holdersFromModule = (file: string): readonly HolderSpec[] => {
    const source = ctx.sourceFile(file)
    if (source === null) return []

    const bindings = ctx.bindingsFor(file)
    const specs: HolderSpec[] = [{ file }]

    for (const element of ctx.ast.jsxElementsIn(source)) {
      const tag = ctx.ast.tagName(element)
      if (tag === null) continue

      const binding = bindings.get(tag)
      if (binding === null || (binding.kind !== "import" && binding.kind !== "dynamic-import")) continue

      const declaring = ctx.resolveModule(file, binding.module)
      if (declaring === null) continue
      specs.push(ctx.declaredExport(declaring, binding.imported))
    }

    return uniqueBy(specs, (spec) => `${spec.file}|${spec.exportName ?? ""}`)
  }

  /** A manifest surface names a BUILT script, so every link is probed and a broken one is reported. */
  const holdersFromManifest = (manifest: Mv3Manifest): readonly HolderSpec[] => {
    const chain = followPopupChain(ctx, manifest)
    const roots: string[] = chain.module === null ? [] : [chain.module]

    for (const script of manifest.contentScripts)
      for (const js of script.js) {
        const resolved = resolveManifestScript(ctx, manifest, js).file
        if (resolved !== null) roots.push(resolved)
      }

    const derived = uniqueBy(roots, (root) => root).flatMap(holdersFromModule)
    if (derived.length > 0) return derived

    ctx.diagnostic({
      severity: "warning",
      code: "screens/no-entry-component",
      message: `no entry component could be derived from '${manifest.file}' (popup chain broke at the ${chain.brokeAt ?? "module"} link); set \`entryComponents: [{ file, exportName }]\` in appgraph.config instead`,
      file: manifest.file,
      line: mv3Evidence(manifest).line,
    })
    return []
  }

  const bodyOf = (declaration: TsNode): TsNode | null => {
    const last = lastChildOf(declaration)
    const arrow = ctx.ast.asArrowFunction(last)
    if (arrow !== null) return arrow.body
    if (last === undefined) return null
    if (last.kind === kind.Block || ctx.ast.containsJsx(last)) return last
    return null
  }

  // ---- branches ------------------------------------------------------------

  const returnStatementsIn = (body: TsNode): readonly TsNode[] => {
    const found: TsNode[] = []
    const visit = (node: TsNode): void => {
      node.forEachChild((child) => {
        if (FUNCTION_KINDS.includes(child.kind)) return
        if (child.kind === kind.ReturnStatement) found.push(child)
        visit(child)
      })
    }
    visit(body)
    return found
  }

  const conditionOf = (ifStatement: TsNode): string | null => {
    const test = childrenOf(ifStatement)[0]
    return test === undefined ? null : ctx.ast.conditionText(test)
  }

  const returnsDirectly = (statement: TsNode): boolean =>
    statement.kind === kind.ReturnStatement ||
    (statement.kind === kind.Block && childrenOf(statement).some((child) => child.kind === kind.ReturnStatement))

  /**
   * `if (x) return <A/>` then `return <B/>` makes B's state `!(x)`, exactly as a ternary's else branch
   * is negated — without it the fall-through return would carry no condition and stop being a state.
   */
  const fallThroughGuards = (anchor: TsNode, body: TsNode): readonly string[] => {
    const statements = childrenOf(body)
    const index = statements.indexOf(anchor)
    if (index <= 0) return []

    return statements.slice(0, index).flatMap((statement) => {
      if (statement.kind !== kind.IfStatement) return []
      const [, thenPart, elsePart] = childrenOf(statement)
      if (thenPart === undefined || elsePart !== undefined || !returnsDirectly(thenPart)) return []
      const condition = conditionOf(statement)
      return condition === null ? [] : [`!(${condition})`]
    })
  }

  const enclosingGuards = (statement: TsNode, body: TsNode): { guards: readonly string[]; anchor: TsNode } => {
    const conditions: string[] = []
    let child: TsNode = statement
    let current: TsNode | undefined = statement.parent

    while (current !== undefined && current !== body) {
      if (current.kind === kind.IfStatement) {
        const [, thenPart, elsePart] = childrenOf(current)
        const condition = conditionOf(current)
        if (condition !== null && child === thenPart) conditions.push(condition)
        if (condition !== null && elsePart !== undefined && child === elsePart)
          conditions.push(`!(${condition})`)
      }
      child = current
      current = current.parent
    }

    return { guards: conditions.reverse(), anchor: child }
  }

  const returnSitesIn = (body: TsNode): readonly ReturnSite[] => {
    if (body.kind !== kind.Block) {
      const root = ctx.unwrap(body)
      return ctx.ast.containsJsx(root) ? [{ root, guard: [] }] : []
    }

    return returnStatementsIn(body).flatMap((statement): readonly ReturnSite[] => {
      const returned = lastChildOf(statement)
      if (returned === undefined) return []
      const root = ctx.unwrap(returned)
      if (!ctx.ast.containsJsx(root)) return []

      const enclosing = enclosingGuards(statement, body)
      return [
        { root, guard: [...fallThroughGuards(enclosing.anchor, body), ...enclosing.guards] },
      ]
    })
  }

  const branchNodeOf = (element: TsNode): TsNode => {
    if (element.kind !== kind.JsxOpeningElement) return element
    const parent = element.parent
    return parent !== undefined && parent.kind === kind.JsxElement ? parent : element
  }

  /**
   * The OUTERMOST guarded alternatives under one return: a guard nested inside an already-guarded
   * branch describes that branch's internals, not another state of the holder.
   */
  const inlineBranchesIn = (root: TsNode): readonly Branch[] => {
    const found: Branch[] = []
    // `guardOf` collects conditions strictly BELOW `stopAt`, so the clamp sits one level above the
    // returned expression: `return a ? <X/> : <Y/>` has its selector AT the root, not inside it.
    const stopAt = root.parent ?? root

    for (const element of ctx.ast.jsxElementsIn(root)) {
      const node = branchNodeOf(element)
      if (node === root) continue
      if (found.some((previous) => spans(previous.node, node))) continue

      const guard = ctx.guardOf(node, stopAt)
      if (guard.condition === null) continue
      found.push({ node, condition: guard.condition })
    }

    return found
  }

  const branchesOf = (holder: Holder): readonly Branch[] => {
    const body = bodyOf(holder.declaration)
    if (body === null) return []

    return returnSitesIn(body).flatMap((site): readonly Branch[] => {
      const inline = inlineBranchesIn(site.root)
      if (inline.length > 0)
        return inline.map((branch) => ({
          node: branch.node,
          condition: [...site.guard, branch.condition].join(" && "),
        }))

      if (site.guard.length === 0) return []
      return [{ node: site.root, condition: site.guard.join(" && ") }]
    })
  }

  // ---- drafts --------------------------------------------------------------

  const configured = options.entryComponents ?? null
  const manifests = configured === null ? findMv3Manifests(ctx) : []
  const specs = configured ?? manifests.flatMap(holdersFromManifest)

  const holders = uniqueBy(specs, (spec) => `${spec.file}|${spec.exportName ?? ""}`)
    .flatMap((spec) => {
      const holder = holderFor(spec)
      if (holder !== null) return [holder]
      if (configured !== null)
        ctx.diagnostic({
          severity: "warning",
          code: "screens/no-entry-component",
          message: `entry component '${spec.exportName ?? "default"}' was not found in '${spec.file}'`,
          file: spec.file,
        })
      return []
    })
    // Declaration order inside a file, so the branch ordinals a localId is built from follow the
    // source (§4.1) rather than the order the specs happened to arrive in.
    .sort(thenBy(by((holder: Holder) => holder.file), (a, b) => byNumber(a.declaration.pos, b.declaration.pos)))

  if (configured === null && manifests.length === 0)
    ctx.diagnostic({
      severity: "warning",
      code: "screens/no-entry-component",
      message:
        "state-screens ran with no entry component configured and no MV3 manifest to derive one from; set `entryComponents: [{ file, exportName }]` in appgraph.config",
    })

  const drafts: ScreenDraft[] = []
  const ordinals = new Map<string, number>()

  for (const holder of holders) {
    const branches = branchesOf(holder)
    if (branches.length === 0) {
      ctx.nearMiss(holder.file, `no guarded top-level JSX branch in '${holder.name}'`)
      continue
    }

    for (const branch of branches) {
      const ordinal = ordinals.get(holder.file) ?? 0
      ordinals.set(holder.file, ordinal + 1)

      const at: NodeLocator = ctx.locatorOf(branch.node)
      const activation: Activation = { kind: "state", holder: holder.name, expr: branch.condition }
      const entry: EntryRef = { kind: "file", file: holder.file, exportName: at.export, at }
      const evidence: Evidence = ctx.evidence(`state branch of '${holder.name}'`, holder.file, branch.node)

      drafts.push({
        // Structural (§4.1): the ordinal, or an `@appgraph-id` pragma on the branch. NEVER the guard
        // text — renaming the guard variable would delete one screen and add another.
        localId: ctx.localId(holder.file, { ordinal, node: branch.node }),
        activations: [activation],
        entries: [entry],
        evidence: [evidence],
      })
    }
  }

  return drafts
}

export const createStateScreensSource = (options: StateScreensOptions = {}): ScreenSource => ({
  name: SOURCE_NAME,
  detect: detectStateScreens,
  discover: (ctx) => runDiscovery(ctx, options),
})

export const createStateScreensAdapter = (options: StateScreensOptions = {}): Adapter => ({
  name: SOURCE_NAME,
  screens: [createStateScreensSource(options)],
})
