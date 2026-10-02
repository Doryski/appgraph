import type ts from "typescript"
import { isComponentTag } from "../ast.js"
import type { AncestorRef, RenderEdge } from "../model.js"
import type { GraphContext } from "./context.js"
import type {
  Placement,
  PlacementDecision,
  SpliceCandidate,
  SpliceHost,
  SpliceProblem,
  SpliceWrapper,
} from "./model.js"
import type { createSpliceScanner } from "./splice-scan.js"
import { describeSplice } from "./splice-scan.js"

export const createPlacement = (
  { providers, ast, api }: GraphContext,
  { CHILDREN, scopeOf, initializerOf, wrappedScopesOf, propertyTagName, isJsxOpening, propCandidatesIn }: ReturnType<typeof createSpliceScanner>,
) => {
  const ownElementOf = (node: ts.Node): ts.Node => (api.isJsxOpeningElement(node) ? node.parent : node)

  const hasFunctionBetween = (node: ts.Node | undefined, scope: ts.Node): boolean => {
    if (node === undefined || node === scope) return false
    return api.isFunctionLike(node) || hasFunctionBetween(node.parent, scope)
  }

  const nearestFunctionOf = (node: ts.Node | undefined): ts.Node | undefined => {
    if (node === undefined || api.isFunctionLike(node)) return node
    return nearestFunctionOf(node.parent)
  }

  // JSX content and a forwarding spread render where they stand; `return children` / `=> children` only
  // count in the component's own function, so `useEffect(() => hoist(children))` is no splice.
  const rendersInComponent = (candidate: SpliceCandidate, scope: ts.Node): boolean => {
    const node = candidate.node
    if (node === undefined) return false
    if (api.isJsxExpression(node) || api.isJsxSpreadAttribute(node)) return true
    const own = nearestFunctionOf(node)
    return own !== undefined && (own === scope || !hasFunctionBetween(own.parent, scope))
  }

  const wrapperExportOf = (file: string, element: ts.JsxOpeningLikeElement, tag: string): string => {
    const member = propertyTagName(element)
    const imported = providers.importedNameOf?.(file, tag)?.imported ?? null
    if (member !== null) return member
    return imported === null || imported === "*" ? tag : imported
  }

  const isProviderMember = (node: ts.Node | null): boolean =>
    node !== null && api.isPropertyAccessExpression(node) && node.name.text === "Provider"

  /**
   * A `<Ctx.Provider>` (or an alias of one) renders its children; any other wrapper must splice `children`
   * in its own declaration or in the component it wraps.
   */
  const wrapperSplices = (file: string, element: ts.JsxOpeningLikeElement, tag: string, target: string): boolean => {
    if (propertyTagName(element) === "Provider") return true
    const source = providers.sourceOf?.(target) ?? null
    if (source === null) return false
    const scope = scopeOf(source, wrapperExportOf(file, element, tag))
    if (isProviderMember(initializerOf(scope))) return true
    return [scope, ...wrappedScopesOf(source, initializerOf(scope), 0)].some((candidateScope) =>
      propCandidatesIn(candidateScope, source, CHILDREN).some((candidate) =>
        rendersInComponent(candidate, candidateScope),
      ),
    )
  }

  const wrapperAt = (file: string, rendered: ReadonlySet<string>, node: ts.Node): SpliceWrapper | null => {
    const element = api.isJsxElement(node) ? node.openingElement : node
    if (!isJsxOpening(element)) return null
    const tag = ast.tagName(element)
    if (tag === null || !isComponentTag(tag)) return null
    const target = providers.declaringFileOf?.(file, tag) ?? null
    if (target === null || !rendered.has(target)) return null
    return { file: target, component: tag, splices: wrapperSplices(file, element, tag, target) }
  }

  /**
   * The nearest component element the splice point sits in as children (JSX content, or a `{...props}`
   * spread), skipping elements the host renders no node for. A named prop (`show={children}`) is handed
   * to a component that may render it anywhere, so it places nothing.
   */
  const enclosingWrapperOf = (
    file: string,
    rendered: ReadonlySet<string>,
    node: ts.Node | undefined,
  ): SpliceWrapper | null => {
    if (node === undefined || api.isSourceFile(node) || api.isJsxAttribute(node)) return null
    return wrapperAt(file, rendered, node) ?? enclosingWrapperOf(file, rendered, node.parent)
  }

  const placementsIn = (
    file: string,
    renders: readonly RenderEdge[],
    candidates: readonly SpliceCandidate[],
  ): readonly Placement[] => {
    const rendered = new Set(renders.map((edge) => edge.file))
    return candidates.map((candidate) => ({
      candidate,
      wrapper:
        candidate.node === undefined ? null : enclosingWrapperOf(file, rendered, ownElementOf(candidate.node).parent),
    }))
  }

  const isOpaque = (placement: Placement): boolean => placement.wrapper?.splices === false

  /**
   * Inside a wrapper only when every candidate is inside that same splicing wrapper: candidates that
   * disagree (a bare site and a wrapped one, two different wrappers) are runtime branches the walk cannot
   * pick between, so the next level goes directly under the host — imprecise, never confidently wrong.
   */
  const decidePlacement = (placements: readonly Placement[]): PlacementDecision => {
    const files = new Set(placements.map((placement) => placement.wrapper?.file ?? null))
    const ambiguous = files.size > 1 || placements.some(isOpaque)
    return { wrapper: ambiguous ? null : (placements[0]?.wrapper ?? null), ambiguous }
  }

  const wrapperFields = (decision: PlacementDecision) =>
    decision.wrapper === null ? {} : { wrapper: decision.wrapper.file }

  const describePlacement = (placement: Placement): string => {
    const wrapper = placement.wrapper
    if (wrapper === null) return "directly under the ancestor"
    return wrapper.splices
      ? `inside <${wrapper.component}>`
      : `inside <${wrapper.component}>, not seen rendering its {children}`
  }

  const placementSite = (placement: Placement): string =>
    `line ${String(placement.candidate.line)} (${describePlacement(placement)})`

  const placementOutcome = (decision: PlacementDecision, placements: readonly Placement[]): string => {
    const first = placements[0]
    if (!decision.ambiguous && first !== undefined)
      return `every site gives the same tree: the page is placed ${describePlacement(first)}`
    return `no single placement holds (${placements.map(placementSite).join(", ")}), so the tree places the page directly under the ancestor and marks the screen placementAmbiguous`
  }

  const plural = (count: number, word: string): string => (count === 1 ? word : `${word}s`)

  const directAmbiguity = (
    ancestor: AncestorRef,
    placements: readonly Placement[],
    decision: PlacementDecision,
  ): SpliceProblem | null => {
    const first = placements[0]
    if (first === undefined || (placements.length < 2 && !decision.ambiguous)) return null
    return {
      severity: "warning",
      code: "walk/ambiguous-splice",
      message: `ancestor '${ancestor.file}' renders ${placements.length} ${describeSplice(ancestor)} splice ${plural(placements.length, "point")} at ${plural(placements.length, "line")} ${placements
        .map((placement) => placement.candidate.line)
        .join(", ")}; ${placementOutcome(decision, placements)}`,
      line: first.candidate.line,
    }
  }

  const hostedAmbiguity = (
    ancestor: AncestorRef,
    hosts: readonly SpliceHost[],
    decision: PlacementDecision,
  ): SpliceProblem | null => {
    const sites = hosts.flatMap((host) => host.candidates.map((candidate) => `${host.file}:${candidate.line}`))
    if (sites.length < 2 && !decision.ambiguous) return null
    const wrapper = decision.wrapper
    const inside = wrapper === null ? "" : ` inside <${wrapper.component}>`
    const uncertain = decision.ambiguous ? "; its sites disagree, so the page is placed directly under it" : ""
    return {
      severity: "warning",
      code: "walk/ambiguous-splice",
      message: `ancestor '${ancestor.file}' renders ${describeSplice(ancestor)} only through rendered components, at ${sites.join(", ")}; spliced under '${hosts[0]?.file ?? ""}'${inside}${uncertain}`,
    }
  }

  return { placementsIn, decidePlacement, wrapperFields, directAmbiguity, hostedAmbiguity }
}
