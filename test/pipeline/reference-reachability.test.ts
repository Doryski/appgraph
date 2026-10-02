import { describe, expect, it } from "vitest"
import { nextAppSource } from "../../src/adapters/next-app.js"
import { adapterFor, run } from "./harness.js"

const NEXT_PACKAGE_JSON = JSON.stringify({ name: "fixture", dependencies: { react: "19.0.0", next: "15.0.0" } })

const graphOf = (files: Readonly<Record<string, string>>) =>
  run({ files: { "package.json": NEXT_PACKAGE_JSON, ...files }, adapters: [adapterFor(nextAppSource)] }).graph

const navigationPairs = (graph: ReturnType<typeof graphOf>) =>
  graph.navigation.map((edge) => [edge.from, edge.to])

describe("reference reachability — files reached only by a value reference are walked", () => {
  it("walks a column-definitions module passed as a prop and keeps its window.open navigation", () => {
    const graph = graphOf({
      "src/app/page.tsx": [
        "import { Table } from '@/components/Table'",
        "import { columns } from '@/components/columns'",
        "export default function Home() { return <Table columns={columns} /> }",
      ].join("\n"),
      "src/components/Table.tsx": "export const Table = ({ columns }) => <table>{columns.length}</table>",
      "src/components/columns.tsx": [
        "export const columns = [",
        "  { id: 'open', cell: ({ id }) => <button onClick={() => window.open(`/details/${id}`)}>Open</button> },",
        "]",
      ].join("\n"),
      "src/app/details/[id]/page.tsx": "export default function Details() { return <div /> }",
    })

    expect(navigationPairs(graph)).toContainEqual(["/", "/details/:id"])
    expect(graph.orphanScreens).not.toContain("/details/:id")
  })

  it("walks a registry of next/dynamic views picked by key and keeps the lazily loaded view's link", () => {
    const graph = graphOf({
      "src/app/page.tsx": [
        "import { Shell } from '@/components/Shell'",
        "import { VIEWS } from '@/config/views'",
        "export default function Home({ kind }) { return <Shell View={VIEWS[kind]} /> }",
      ].join("\n"),
      "src/components/Shell.tsx": "export const Shell = ({ View }) => <main><View /></main>",
      "src/config/views.ts": [
        "import dynamic from 'next/dynamic'",
        "export const VIEWS = { a: dynamic(() => import('./A')) }",
      ].join("\n"),
      "src/config/A.tsx": [
        "import Link from 'next/link'",
        "export default function A() { return <Link href=\"/target\">Go</Link> }",
      ].join("\n"),
      "src/app/target/page.tsx": "export default function Target() { return <div /> }",
    })

    expect(navigationPairs(graph)).toContainEqual(["/", "/target"])
    expect(graph.orphanScreens).not.toContain("/target")
  })
})
