import type { Binding } from "../core/model.js"
import { collectStringMembers } from "../core/strings.js"
import type { DiscoverContext, TsNode } from "./types.js"

export type ImportedBinding = {
  readonly module: string
  readonly imported: string
}

export const importedBindingOf = (binding: Binding | null): ImportedBinding | null =>
  binding !== null && (binding.kind === "import" || binding.kind === "dynamic-import")
    ? { module: binding.module, imported: binding.imported }
    : null

export type StringValueReader = (node: TsNode | undefined, file: string) => string | null

/**
 * `Paths.LOGIN` and `ROUTES.home` fold through the shared `StringTable` only when the declaring file was
 * configured as a string source; the member-table fallback below reads the enum or `as const` map out of
 * whichever file actually declares it, so a zero-config run folds the same constants a pinned one does.
 */
export const createStringValueReader = (ctx: DiscoverContext): StringValueReader => {
  const memberTables = new Map<string, ReadonlyMap<string, string>>()

  const membersFor = (file: string): ReadonlyMap<string, string> => {
    const cached = memberTables.get(file)
    if (cached !== undefined) return cached

    const source = ctx.sourceFile(file)
    const table = source === null ? new Map<string, string>() : collectStringMembers(ctx.ts, source)
    memberTables.set(file, table)
    return table
  }

  const memberChainOf = (node: TsNode): MemberChain | null => {
    const access = ctx.ast.asPropertyAccess(node)
    if (access === null) return null
    const root = ctx.ast.asIdentifier(access.expression)
    if (root !== null) return { root: root.text, path: access.name.text }
    const parent = memberChainOf(access.expression)
    return parent === null ? null : { root: parent.root, path: `${parent.path}.${access.name.text}` }
  }

  return (node, file) => {
    if (node === undefined) return null

    const flat = ctx.flattenString(node, file)
    if (flat !== null) return flat.value

    const chain = memberChainOf(node)
    if (chain === null) return null

    const own = membersFor(file).get(`${chain.root}.${chain.path}`)
    if (own !== undefined) return own

    const imported = importedBindingOf(ctx.bindingsFor(file).get(chain.root))
    if (imported === null) return null
    const declaring = ctx.resolveModule(file, imported.module)
    if (declaring === null) return null
    return membersFor(declaring).get(`${imported.imported}.${chain.path}`) ?? null
  }
}

type MemberChain = { readonly root: string; readonly path: string }
