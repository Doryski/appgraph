import type { NodeKind, TreeNode } from "../core/model.js"

export const TREE_DEFAULTS = {
  conditions: [],
  alwaysRendered: true,
  repeated: false,
  nullGuards: [],
  children: [],
  truncated: false,
  repeat: false,
} as const

export const TREE_INTERN_THRESHOLDS = {
  full: { minSize: 1, minCount: 1 },
  yaml: { minSize: 3, minCount: 2 },
} as const

type DefaultKey = keyof typeof TREE_DEFAULTS

export type TreeRef = number | EncodedTreeNode

type ExpandedEncodedNode = {
  readonly file: string | number
  readonly component: string
  readonly kind: NodeKind
  readonly conditions: readonly string[]
  readonly alwaysRendered: boolean
  readonly repeated: boolean
  readonly nullGuards: readonly string[]
  readonly via?: NonNullable<TreeNode["via"]>
  readonly children: readonly TreeRef[]
  readonly truncated: boolean
  readonly repeat: boolean
}

export type EncodedTreeNode = Omit<ExpandedEncodedNode, DefaultKey> & Partial<Pick<ExpandedEncodedNode, DefaultKey>>

export type InternedForests = {
  readonly subtrees: readonly EncodedTreeNode[]
  readonly forests: readonly (readonly TreeRef[])[]
}

export type PathTable = {
  readonly paths: readonly string[]
  readonly index: ReadonlyMap<string, number>
}

export type InternOptions = {
  readonly minSize?: number
  readonly minCount?: number
  readonly paths?: PathTable
}

type CanonicalNode = {
  readonly node: TreeNode
  readonly children: readonly number[]
  readonly size: number
}

type HashConsed = {
  readonly canonical: readonly CanonicalNode[]
  readonly roots: readonly (readonly number[])[]
}

const fail = (message: string): never => {
  throw new Error(`emit/tree-intern: ${message}`)
}

const defaultsByKey: Readonly<Record<string, unknown>> = TREE_DEFAULTS

const isDefault = (key: string, value: unknown): boolean => {
  if (!Object.hasOwn(defaultsByKey, key)) return false
  const fallback = defaultsByKey[key]
  if (Array.isArray(fallback)) return Array.isArray(value) && value.length === 0
  return value === fallback
}

const omitDefaults = (record: ExpandedEncodedNode): EncodedTreeNode =>
  Object.fromEntries(Object.entries(record).filter(([key, value]) => !isDefault(key, value))) as EncodedTreeNode

const valueOr = <K extends DefaultKey>(node: EncodedTreeNode, key: K): NonNullable<EncodedTreeNode[K]> | (typeof TREE_DEFAULTS)[K] =>
  node[key] ?? TREE_DEFAULTS[key]

const structuralKey = (node: TreeNode, children: readonly number[]): string =>
  JSON.stringify([
    node.file,
    node.component,
    node.kind,
    node.conditions,
    node.alwaysRendered,
    node.repeated,
    node.nullGuards,
    node.via ?? null,
    children,
    node.truncated,
    node.repeat,
  ])

const subtreeSize = (canonical: readonly CanonicalNode[], children: readonly number[]): number =>
  children.reduce((total, child) => total + (canonical[child]?.size ?? 0), 1)

const hashCons = (forests: readonly (readonly TreeNode[])[]): HashConsed => {
  const idsByKey = new Map<string, number>()
  const idsByRef = new Map<TreeNode, number>()
  const canonical: CanonicalNode[] = []

  const visit = (node: TreeNode): number => {
    const seen = idsByRef.get(node)
    if (seen !== undefined) return seen
    const children = node.children.map(visit)
    const key = structuralKey(node, children)
    const existing = idsByKey.get(key)
    const id = existing ?? canonical.length
    if (existing === undefined) {
      idsByKey.set(key, id)
      canonical.push({ node, children, size: subtreeSize(canonical, children) })
    }
    idsByRef.set(node, id)
    return id
  }

  const roots = forests.map((forest) => forest.map(visit))
  return { canonical, roots }
}

const internedMask = ({ canonical, roots }: HashConsed, minSize: number, minCount: number): readonly boolean[] => {
  const occurrences = canonical.map(() => 0)
  for (const id of roots.flat()) occurrences[id] = (occurrences[id] ?? 0) + 1
  const interned = canonical.map(() => false)
  for (let id = canonical.length - 1; id >= 0; id -= 1) {
    const count = occurrences[id] ?? 0
    const entry = canonical[id]
    if (entry === undefined) continue
    const keep = entry.size >= minSize && count >= minCount
    interned[id] = keep
    const weight = keep ? 1 : count
    for (const child of entry.children) occurrences[child] = (occurrences[child] ?? 0) + weight
  }
  return interned
}

export const encodePath = (table: PathTable, path: string): number =>
  table.index.get(path) ?? fail(`path not in table: ${path}`)

export const decodePath = (paths: readonly string[], id: number): string =>
  paths[id] ?? fail(`path id out of range: ${id}`)

export const encodePaths = (table: PathTable, paths: readonly string[]): readonly number[] =>
  paths.map((path) => encodePath(table, path))

export const decodePaths = (paths: readonly string[], ids: readonly number[]): readonly string[] =>
  ids.map((id) => decodePath(paths, id))

export const buildPathTable = (paths: Iterable<string>): PathTable => {
  const index = new Map<string, number>()
  for (const path of paths) if (!index.has(path)) index.set(path, index.size)
  return { paths: [...index.keys()], index }
}

export const treeFiles = (forests: readonly (readonly TreeNode[])[]): readonly string[] => {
  const files = new Set<string>()
  const visited = new Set<TreeNode>()
  const visit = (node: TreeNode): void => {
    if (visited.has(node)) return
    visited.add(node)
    files.add(node.file)
    node.children.forEach(visit)
  }
  forests.forEach((forest) => forest.forEach(visit))
  return [...files]
}

const encodeFile = (file: string, paths: PathTable | undefined): string | number =>
  paths === undefined ? file : encodePath(paths, file)

export const internForests = (
  forests: readonly (readonly TreeNode[])[],
  options: InternOptions = {},
): InternedForests => {
  const consed = hashCons(forests)
  const { minSize, minCount } = { ...TREE_INTERN_THRESHOLDS.full, ...options }
  const interned = internedMask(consed, minSize, minCount)
  const tableIds = new Map<number, number>()
  interned.forEach((keep, id) => {
    if (keep) tableIds.set(id, tableIds.size)
  })
  const inline = new Map<number, EncodedTreeNode>()

  const encodeNode = (id: number): EncodedTreeNode => {
    const entry = consed.canonical[id] ?? fail(`unknown subtree ${id}`)
    const { node } = entry
    return omitDefaults({
      file: encodeFile(node.file, options.paths),
      component: node.component,
      kind: node.kind,
      conditions: node.conditions,
      alwaysRendered: node.alwaysRendered,
      repeated: node.repeated,
      nullGuards: node.nullGuards,
      ...(node.via === undefined ? {} : { via: node.via }),
      children: entry.children.map(encodeRef),
      truncated: node.truncated,
      repeat: node.repeat,
    })
  }

  const encodeInline = (id: number): EncodedTreeNode => {
    const cached = inline.get(id)
    if (cached !== undefined) return cached
    const encoded = encodeNode(id)
    inline.set(id, encoded)
    return encoded
  }

  const encodeRef = (id: number): TreeRef => tableIds.get(id) ?? encodeInline(id)

  return {
    subtrees: [...tableIds.keys()].map(encodeNode),
    forests: consed.roots.map((roots) => roots.map(encodeRef)),
  }
}

const decodeFile = (file: string | number, paths: readonly string[] | undefined): string => {
  if (typeof file === "string") return file
  return decodePath(paths ?? fail(`path id ${file} without a path table`), file)
}

export const createTreeHydrator = (
  subtrees: readonly EncodedTreeNode[],
  paths?: readonly string[],
): ((ref: TreeRef) => TreeNode) => {
  const hydrated = new Map<number, TreeNode>()

  const build = (node: EncodedTreeNode): TreeNode => ({
    file: decodeFile(node.file, paths),
    component: node.component,
    kind: node.kind,
    conditions: valueOr(node, "conditions"),
    alwaysRendered: valueOr(node, "alwaysRendered"),
    repeated: valueOr(node, "repeated"),
    nullGuards: valueOr(node, "nullGuards"),
    ...(node.via === undefined ? {} : { via: node.via }),
    children: valueOr(node, "children").map(hydrate),
    truncated: valueOr(node, "truncated"),
    repeat: valueOr(node, "repeat"),
  })

  const fromTable = (id: number): TreeNode => {
    const cached = hydrated.get(id)
    if (cached !== undefined) return cached
    const node = build(subtrees[id] ?? fail(`subtree id out of range: ${id}`))
    hydrated.set(id, node)
    return node
  }

  const hydrate = (ref: TreeRef): TreeNode => (typeof ref === "number" ? fromTable(ref) : build(ref))

  return hydrate
}

export const hydrateForests = (interned: InternedForests, paths?: readonly string[]): readonly (readonly TreeNode[])[] => {
  const hydrate = createTreeHydrator(interned.subtrees, paths)
  return interned.forests.map((forest) => forest.map(hydrate))
}
