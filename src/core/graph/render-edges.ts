import type ts from "typescript"
import { isComponentTag } from "../ast.js"
import type { FileFacts, RenderEdge } from "../model.js"
import { by, sortedUnique } from "../order.js"
import type { GraphContext } from "./context.js"
import type { Via } from "./via.js"
import { strongerVia, withVia } from "./via.js"

export const createRenderEdges = ({ providers, ast, api, factsOf }: GraphContext) => {
  const mergeRenderEdges = (edges: readonly RenderEdge[]): readonly RenderEdge[] => {
    type Accumulated = {
      conditions: string[]
      alwaysRendered: boolean
      repeated: boolean
      via: Via
    }
    const merged = new Map<string, Accumulated>()

    for (const edge of edges) {
      const existing = merged.get(edge.file)
      if (existing === undefined) {
        merged.set(edge.file, {
          conditions: [...edge.conditions],
          alwaysRendered: edge.alwaysRendered,
          repeated: edge.repeated,
          via: edge.via,
        })
        continue
      }
      existing.conditions.push(...edge.conditions)
      existing.alwaysRendered = existing.alwaysRendered || edge.alwaysRendered
      existing.repeated = existing.repeated || edge.repeated
      existing.via = strongerVia(existing.via, edge.via)
    }

    return [...merged.entries()]
      .map(([file, value]) =>
        withVia(
          {
            file,
            conditions: sortedUnique(value.conditions),
            alwaysRendered: value.alwaysRendered,
            repeated: value.repeated,
          },
          value.via,
        ),
      )
      .sort(by((edge) => edge.file))
  }

  const spans = (outer: ts.Node, inner: ts.Node): boolean => outer.pos <= inner.pos && inner.end <= outer.end

  /**
   * §6.3.2: render edges for a sub-file root come from the LOCATED NODE's subtree only, and every
   * guard is clamped, so a state screen's conditions are the guards BETWEEN the root and the JSX —
   * never the screen's own activation guard repeated on every node.
   *
   * The clamp is the located node's outermost JSX element (`origin`) rather than the node itself,
   * because an adapter may address either the branch (`<Dialog>…</Dialog>`) or its wrapper
   * (`{state === 'ready' && <Dialog>…</Dialog>}`); clamping at the node alone would let the second
   * form collect the activation guard it is supposed to strip. Elements outside `origin` — sibling
   * branches under one located container — clamp at the node instead, so their own branch guard
   * survives (it distinguishes them WITHIN the screen) while everything above the node does not.
   */
  const lazyTargetsCache = new WeakMap<FileFacts, ReadonlySet<string>>()
  const lazyTargetsOf = (facts: FileFacts): ReadonlySet<string> => {
    const cached = lazyTargetsCache.get(facts)
    if (cached !== undefined) return cached
    const targets = new Set(facts.renders.filter((edge) => edge.via === "lazy").map((edge) => edge.file))
    lazyTargetsCache.set(facts, targets)
    return targets
  }

  const lazyVia = (file: string, target: string): Via =>
    lazyTargetsOf(factsOf(file)).has(target) ? "lazy" : undefined

  const subtreeRenderEdges = (file: string, node: ts.Node): readonly RenderEdge[] | null => {
    const declaring = providers.declaringFileOf
    if (declaring === undefined) return null

    const elements = ast.jsxElementsIn(node)
    const first = elements[0]
    // An opening element spans only its own tag, never the children it opens; the enclosing
    // JsxElement is the real subtree boundary.
    const origin =
      first === undefined
        ? node
        : api.isJsxOpeningElement(first) && first.parent !== undefined
          ? first.parent
          : first
    const edges: RenderEdge[] = []

    for (const element of elements) {
      const tag = ast.tagName(element)
      if (tag === null || !isComponentTag(tag)) continue
      const target = declaring(file, tag)
      if (target === null) continue

      const guard =
        element === first
          ? { condition: null, repeated: false }
          : ast.guardOf(element, spans(origin, element) ? origin : node)

      edges.push(
        withVia(
          {
            file: target,
            conditions: guard.condition === null ? [] : [guard.condition],
            alwaysRendered: guard.condition === null,
            repeated: guard.repeated,
          },
          lazyVia(file, target),
        ),
      )
    }

    return mergeRenderEdges(edges)
  }

  return { mergeRenderEdges, subtreeRenderEdges }
}
