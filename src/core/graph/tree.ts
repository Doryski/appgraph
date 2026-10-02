import type { TreeNode } from "../model.js"
import type { Placed } from "./model.js"

export const appendChildren = (node: TreeNode, subtree: readonly TreeNode[]): TreeNode =>
  subtree.length === 0 ? node : { ...node, children: [...node.children, ...subtree] }

/**
 * Each placed subtree goes inside the host's child node for its `wrapper`; one without a wrapper, or
 * whose wrapper has no node there, is appended to the host itself, in the order given.
 */
export const placeInto = (host: TreeNode, placed: readonly Placed[]): TreeNode => {
  const indexOf = (wrapper: string | undefined): number =>
    wrapper === undefined ? -1 : host.children.findIndex((child) => child.file === wrapper)
  const placedAt = (index: number): readonly TreeNode[] =>
    placed.filter((item) => indexOf(item.wrapper) === index).map((item) => item.node)
  const children = host.children.map((child, index) => appendChildren(child, placedAt(index)))
  return appendChildren({ ...host, children }, placedAt(-1))
}

/**
 * Places the next level into the first expanded node for `host` in reading order. `null` when the
 * host never made it into the tree (cut at `maxDepth`); the caller then splices at the ancestor itself.
 */
export const graft = (node: TreeNode, host: string, place: (hostNode: TreeNode) => TreeNode): TreeNode | null => {
  if (node.file === host && !node.repeat) return place(node)
  for (const [index, child] of node.children.entries()) {
    const grafted = graft(child, host, place)
    if (grafted !== null)
      return {
        ...node,
        children: node.children.map((sibling, at) => (at === index ? grafted : sibling)),
      }
  }
  return null
}
