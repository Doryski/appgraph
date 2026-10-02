import { createDiagnosticCollector } from "../diagnostics.js"
import { isTraversable } from "../kinds.js"
import type { FileFacts } from "../model.js"
import { DEFAULT_MAX_DEPTH } from "./constants.js"
import type { BuildGraphInput } from "./types.js"

export const createGraphContext = (input: BuildGraphInput) => {
  const { providers } = input
  const { ast } = providers
  const api = ast.ts
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH
  const diagnostics = input.diagnostics ?? createDiagnosticCollector()

  const factsCache = new Map<string, FileFacts>()
  const factsOf = (file: string): FileFacts => {
    const cached = factsCache.get(file)
    if (cached !== undefined) return cached
    const facts = providers.facts(file)
    factsCache.set(file, facts)
    return facts
  }

  const traversableCache = new WeakMap<FileFacts, readonly string[]>()
  const filterTraversable = (facts: FileFacts): readonly string[] => {
    const rules = input.kindRules
    if (rules === undefined) return facts.uses
    return facts.uses.filter((file) => isTraversable(rules, { file }))
  }
  const traversableUses = (facts: FileFacts): readonly string[] => {
    const cached = traversableCache.get(facts)
    if (cached !== undefined) return cached
    const uses = filterTraversable(facts)
    traversableCache.set(facts, uses)
    return uses
  }

  return { providers, ast, api, maxDepth, diagnostics, factsCache, factsOf, traversableUses }
}

export type GraphContext = ReturnType<typeof createGraphContext>
