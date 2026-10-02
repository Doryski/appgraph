import { by, thenBy } from "../core/order.js"
import { SOURCE_PRECEDENCE } from "../core/sources.js"
import type { Adapter } from "./types.js"

const precedenceOf = (adapter: Adapter): number => {
  const names = (adapter.screens ?? []).map((source) => source.name)
  const ranks = names
    .map((name) => (SOURCE_PRECEDENCE as readonly string[]).indexOf(name))
    .filter((rank) => rank !== -1)
  return ranks.length === 0 ? SOURCE_PRECEDENCE.length : Math.min(...ranks)
}

export const byAdapterPrecedence = thenBy<Adapter>(
  (a, b) => precedenceOf(a) - precedenceOf(b),
  by((adapter) => adapter.name),
)
