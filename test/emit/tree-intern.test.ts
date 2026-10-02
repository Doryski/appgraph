import { describe, expect, it } from "vitest"
import type { TreeNode } from "../../src/core/model.js"
import {
  buildPathTable,
  createTreeHydrator,
  decodePaths,
  encodePaths,
  hydrateForests,
  internForests,
  TREE_DEFAULTS,
  TREE_INTERN_THRESHOLDS,
  treeFiles,
} from "../../src/emit/tree-intern.js"

const node = (file: string, children: readonly TreeNode[] = [], overrides: Partial<TreeNode> = {}): TreeNode => {
  const { via, ...rest } = overrides
  const base = {
    file,
    component: file.replace(/^.*\//, "").replace(/\.tsx$/, ""),
    kind: "component",
    conditions: [],
    alwaysRendered: true,
    repeated: false,
    nullGuards: [],
    ...(via === undefined ? {} : { via }),
    children,
    truncated: false,
    repeat: false,
  }
  return { ...base, ...rest }
}

const leaf = (name: string): TreeNode => node(`src/${name}.tsx`)

const card = (): TreeNode => node("src/Card.tsx", [leaf("Title"), leaf("Body"), leaf("Footer")])

const sample = (): readonly (readonly TreeNode[])[] => [
  [
    node("src/Layout.tsx", [
      node("src/Page.tsx", [card(), card(), leaf("Title")], {
        conditions: ["user !== null"],
        alwaysRendered: false,
        via: "lazy",
      }),
      node("src/List.tsx", [card()], { repeated: true, nullGuards: ["items"] }),
      node("src/Deep.tsx", [], { truncated: true }),
      node("src/Page.tsx", [], { repeat: true }),
    ]),
  ],
  [node("src/Shell.tsx", [card()])],
  [],
]

const chainOf = (depth: number, name: string): TreeNode =>
  depth === 0 ? leaf(name) : node(`src/${name}${depth}.tsx`, [chainOf(depth - 1, name)])

const repeatedFixture = (): { forests: readonly (readonly TreeNode[])[]; nodes: number; distinct: number } => {
  const block = (): TreeNode => node("src/Block.tsx", Array.from({ length: 9 }, (_, index) => leaf(`Cell${index % 3}`)))
  const screens = Array.from({ length: 100 }, () => [node("src/Screen.tsx", Array.from({ length: 10 }, block)), chainOf(9, "Chain")])
  return { forests: screens, nodes: 100 * (1 + 10 * 10 + 10), distinct: 3 + 1 + 1 + 10 }
}

const countNodes = (nodes: readonly TreeNode[]): number =>
  nodes.reduce((total, item) => total + 1 + countNodes(item.children), 0)

describe("internForests", () => {
  it("round-trips to deep-equal trees", () => {
    const forests = sample()
    expect(hydrateForests(internForests(forests))).toStrictEqual(forests)
  })

  it("round-trips with byte-identical JSON key order", () => {
    const forests = sample()
    expect(JSON.stringify(hydrateForests(internForests(forests)))).toBe(JSON.stringify(forests))
  })

  it("round-trips through a JSON string", () => {
    const forests = sample()
    const wire = JSON.parse(JSON.stringify(internForests(forests)))
    expect(hydrateForests(wire)).toStrictEqual(forests)
  })

  it("is deterministic and idempotent", () => {
    const first = JSON.stringify(internForests(sample()))
    expect(JSON.stringify(internForests(sample()))).toBe(first)
    const again = internForests(hydrateForests(internForests(sample())))
    expect(JSON.stringify(again)).toBe(first)
  })

  it("assigns ids first-seen in post-order", () => {
    const { subtrees, forests } = internForests([[node("src/A.tsx", [leaf("B"), leaf("C")])], [leaf("B")]])
    expect(subtrees.map((item) => item.file)).toEqual(["src/B.tsx", "src/C.tsx", "src/A.tsx"])
    expect(forests).toEqual([[2], [0]])
  })

  it("shares structurally identical subtrees", () => {
    const { subtrees } = internForests(sample())
    expect(subtrees.filter((item) => item.file === "src/Card.tsx")).toHaveLength(1)
    const hydrated = hydrateForests(internForests(sample()))
    const [layout] = hydrated[0] ?? []
    const page = layout?.children[0]
    expect(page?.children[0]).toBe(page?.children[1])
  })

  it("omits defaults and keeps non-defaults", () => {
    const { subtrees } = internForests(sample())
    const title = subtrees.find((item) => item.file === "src/Title.tsx")
    expect(title).toEqual({ file: "src/Title.tsx", component: "Title", kind: "component" })
    for (const key of Object.keys(TREE_DEFAULTS)) expect(title).not.toHaveProperty(key)
    const page = subtrees.find((item) => item.file === "src/Page.tsx" && item.via === "lazy")
    expect(page).toMatchObject({ conditions: ["user !== null"], alwaysRendered: false, via: "lazy" })
    expect(page).not.toHaveProperty("repeated")
    expect(subtrees.find((item) => item.file === "src/List.tsx")).toMatchObject({ repeated: true, nullGuards: ["items"] })
    expect(subtrees.find((item) => item.file === "src/Deep.tsx")).toMatchObject({ truncated: true })
    expect(subtrees.find((item) => item.repeat === true)).toMatchObject({ file: "src/Page.tsx" })
  })

  it("collapses a 10k-node repeated fixture to its distinct subtrees", () => {
    const { forests, nodes, distinct } = repeatedFixture()
    expect(forests.reduce((total, forest) => total + countNodes(forest), 0)).toBe(nodes)
    const interned = internForests(forests)
    expect(interned.subtrees).toHaveLength(distinct)
    expect(hydrateForests(interned)).toStrictEqual(forests)
  })

  it("keeps small or rare subtrees inline in threshold mode", () => {
    const forests = sample()
    const interned = internForests(forests, TREE_INTERN_THRESHOLDS.yaml)
    expect(interned.subtrees.map((item) => item.file)).toEqual(["src/Card.tsx"])
    const card = interned.subtrees[0]
    expect(card?.children?.every((child) => typeof child === "object")).toBe(true)
    expect(typeof interned.forests[0]?.[0]).toBe("object")
    expect(interned.forests[1]).toEqual([{ file: "src/Shell.tsx", component: "Shell", kind: "component", children: [0] }])
    expect(hydrateForests(interned)).toStrictEqual(forests)
  })

  it("counts emitted occurrences, not occurrences inside an interned parent", () => {
    const pair = (): TreeNode => node("src/Pair.tsx", [chainOf(3, "Inner")])
    const forests = [[pair()], [pair()]]
    const interned = internForests(forests, TREE_INTERN_THRESHOLDS.yaml)
    expect(interned.subtrees.map((item) => item.file)).toEqual(["src/Pair.tsx"])
    expect(interned.forests).toEqual([[0], [0]])
    expect(hydrateForests(interned)).toStrictEqual(forests)
  })

  it("encodes node files through a path table", () => {
    const forests = sample()
    const table = buildPathTable(treeFiles(forests))
    const interned = internForests(forests, { paths: table })
    expect(interned.subtrees.every((item) => typeof item.file === "number")).toBe(true)
    expect(hydrateForests(interned, table.paths)).toStrictEqual(forests)
    expect(() => hydrateForests(interned)).toThrow(/without a path table/)
  })

  it("rejects an out-of-range subtree id", () => {
    expect(() => createTreeHydrator([])(0)).toThrow(/out of range/)
  })
})

describe("path table", () => {
  it("dedupes first-seen and round-trips", () => {
    const table = buildPathTable(["b.ts", "a.ts", "b.ts", "c.ts"])
    expect(table.paths).toEqual(["b.ts", "a.ts", "c.ts"])
    const ids = encodePaths(table, ["c.ts", "b.ts", "c.ts"])
    expect(ids).toEqual([2, 0, 2])
    expect(decodePaths(table.paths, ids)).toEqual(["c.ts", "b.ts", "c.ts"])
  })

  it("rejects unknown paths and ids", () => {
    const table = buildPathTable(["a.ts"])
    expect(() => encodePaths(table, ["z.ts"])).toThrow(/not in table/)
    expect(() => decodePaths(table.paths, [3])).toThrow(/out of range/)
  })

  it("lists tree files in pre-order first-seen", () => {
    expect(treeFiles([[node("src/A.tsx", [leaf("B"), leaf("A")])], [leaf("C")]])).toEqual([
      "src/A.tsx",
      "src/B.tsx",
      "src/C.tsx",
    ])
  })
})
