import type { TsNode } from "../types.js"
import type { DiscoverJsxApi } from "./discover-jsx.js"
import type { DiscoverObjectsApi } from "./discover-objects.js"
import type { RouteItem, RouteList } from "./model.js"

export const createRouteLists = (deps: DiscoverObjectsApi & DiscoverJsxApi) => {
  const { arrayItems, jsxItems } = deps

  const itemsOf = (list: RouteList): readonly RouteItem[] => {
    if (list.kind === "array") return arrayItems(list.array, list.file, list.mode, list.bindings)
    if (list.kind === "jsx") return jsxItems(list.nodes, list.file, list.scope, list.flavour)
    return [{ kind: "unreadable", node: list.anchor, file: list.file, reason: list.reason }]
  }

  const hasIndexChild = (list: RouteList, seen: Set<TsNode>): boolean => {
    if (seen.has(list.anchor)) return false
    seen.add(list.anchor)
    return itemsOf(list).some((item) => {
      if (item.kind === "route") return item.spec.isIndex
      return item.kind === "list" && hasIndexChild(item.list, seen)
    })
  }

  return { itemsOf, hasIndexChild }
}

export type RouteListsApi = ReturnType<typeof createRouteLists>
