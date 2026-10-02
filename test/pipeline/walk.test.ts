import { describe, expect, it } from "vitest"
import type { Adapter, Emitter, ScreenSource } from "../../src/adapters/types.js"
import { createPipelineRegistry } from "../../src/pipeline/registry.js"
import { expandFormats } from "../../src/pipeline/phases.js"
import { adapterFor, codes, run } from "./harness.js"

const FILES = {
  "src/routes/RootLayout.tsx": `
import Header from "./Header"

export default function RootLayout({ children }) {
  return (
    <div>
      <Header />
      {children}
    </div>
  )
}
`,
  "src/routes/Header.tsx": `export default function Header() { return <header /> }`,
  "src/pages/Orders.tsx": `
import Table from "./Table"

export default function Orders() { return <Table /> }
`,
  "src/pages/Table.tsx": `export default function Table() { return <table /> }`,
  "src/content/Content.tsx": `
import Login from "./Login"
import Main from "./Main"

export default function Content() {
  const authed = true
  return authed ? <Main /> : <Login />
}
`,
  "src/content/Login.tsx": `export default function Login() { return <form /> }`,
  "src/content/Main.tsx": `export default function Main() { return <main /> }`,
}

const layoutSource: ScreenSource = {
  name: "test-layout",
  detect: () => ({ score: 100, evidence: [] }),
  discover: () => [
    {
      localId: "src/pages/Orders.tsx",
      activations: [{ kind: "url", template: "/orders", params: [] }],
      entries: [{ kind: "file", file: "src/pages/Orders.tsx", exportName: "default" }],
      evidence: [],
    },
  ],
  // The chain depends on a resolved entry, which is exactly what `ancestorsOf` exists for.
  ancestorsOf: () => [
    {
      file: "src/routes/RootLayout.tsx",
      exportName: "default",
      splice: { kind: "children" },
      role: "layout",
    },
  ],
}

describe("pipeline/walk inputs", () => {
  it("splices the adapter-supplied ancestor chain and derives the shell", () => {
    const result = run({ files: FILES, adapters: [adapterFor(layoutSource)] })
    const screen = result.graph.screens[0]

    expect(screen?.shell).toBe("src/routes/RootLayout.tsx")
    expect(screen?.tree[0]?.file).toBe("src/routes/RootLayout.tsx")
    expect(screen?.tree[0]?.children.map((child) => child.file)).toEqual([
      "src/routes/Header.tsx",
      "src/pages/Orders.tsx",
    ])
    expect(Object.keys(result.graph.shells)).toEqual(["src/routes/RootLayout.tsx"])
  })

  it("reports a missing splice point and keeps the ancestor reachable", () => {
    const broken: ScreenSource = {
      ...layoutSource,
      ancestorsOf: () => [
        {
          file: "src/routes/Header.tsx",
          exportName: "default",
          splice: { kind: "outlet", tag: "Outlet" },
          role: "layout",
        },
      ],
    }

    const result = run({ files: FILES, adapters: [adapterFor(broken)] })
    expect(codes(result)).toContain("walk/no-splice-point")
    expect(result.graph.screens[0]?.reachable).toContain("src/routes/Header.tsx")
  })

  it("gives two sub-file roots in one file two different trees", () => {
    const stateSource: ScreenSource = {
      name: "test-states",
      detect: () => ({ score: 50, evidence: [] }),
      discover: (ctx) => {
        const file = "src/content/Content.tsx"
        const source = ctx.sourceFile(file)
        if (source === null) return []

        const elements = ctx.ast.jsxElementsIn(source)
        return elements.map((element, ordinal) => ({
          localId: ctx.localId(file, { ordinal, node: element }),
          activations: [
            { kind: "state" as const, holder: "Content", expr: ctx.guardOf(element).condition ?? "" },
          ],
          entries: [
            {
              kind: "file" as const,
              file,
              exportName: "default",
              at: ctx.locatorOf(element),
            },
          ],
          evidence: [],
        }))
      },
    }

    const result = run({ files: FILES, adapters: [adapterFor(stateSource)] })
    expect(result.graph.screens).toHaveLength(2)

    const roots = result.graph.screens.map((screen) => screen.tree[0]?.component)
    expect(new Set(roots).size).toBe(2)
    expect(roots.every((root) => root?.startsWith("Content#"))).toBe(true)

    const rendered = result.graph.screens.map((screen) =>
      screen.tree[0]?.children.map((child) => child.file).join(","),
    )
    expect(rendered).toEqual(["src/content/Main.tsx", "src/content/Login.tsx"])
  })

  /**
   * The producer of `uses` (the component-tree extractor) and its consumer (the walk's reachability
   * closure) must apply ONE predicate. A walk that re-gates on `KindRule.traversable` alone emits a
   * `useX` file under a `traversable: false` prefix and then silently discards it, along with
   * everything reachable only through it.
   */
  it("keeps a useX file reachable through `uses` even under a non-traversable kind rule", () => {
    const files = {
      "src/pages/Orders.tsx": `
import { useOrdersData } from "../modules/Orders/hooks/useOrdersData"

export default function Orders() {
  useOrdersData()
  return <table />
}
`,
      "src/modules/Orders/hooks/useOrdersData.ts": `
import { fetchOrders } from "../../../services/orders"

export const useOrdersData = () => fetchOrders()
`,
      "src/services/orders.ts": `export const fetchOrders = () => []`,
    }

    const result = run({
      files,
      adapters: [adapterFor({ ...layoutSource, ancestorsOf: () => [] })],
      config: {
        kindRules: [
          { match: { pathPrefix: "src/modules/" }, kind: "module", traversable: false, screenEntry: true },
          { match: { pathPrefix: "src/services/" }, kind: "service", traversable: true, screenEntry: false },
        ],
      },
    })

    const screen = result.graph.screens[0]
    expect(screen?.reachable).toContain("src/modules/Orders/hooks/useOrdersData.ts")
    expect(screen?.reachable).toContain("src/services/orders.ts")
    expect(Object.keys(result.graph.components)).toContain("src/modules/Orders/hooks/useOrdersData.ts")
  })

  it("splices a <Stack> outlet once and does not match its <Stack.Screen> members", () => {
    const files = {
      ...FILES,
      "src/routes/StackLayout.tsx": `
import { Stack } from "expo-router"

export default function StackLayout() {
  return (
    <Stack>
      <Stack.Screen name="a" />
      <Stack.Screen name="b" />
    </Stack>
  )
}
`,
    }
    const stackSource: ScreenSource = {
      ...layoutSource,
      ancestorsOf: () => [
        {
          file: "src/routes/StackLayout.tsx",
          exportName: "default",
          splice: { kind: "outlet", tag: "Stack" },
          role: "layout",
        },
      ],
    }

    const result = run({ files, adapters: [adapterFor(stackSource)] })
    const screen = result.graph.screens[0]

    expect(codes(result)).not.toContain("walk/ambiguous-splice")
    expect(codes(result)).not.toContain("walk/no-splice-point")
    expect(screen?.tree[0]?.file).toBe("src/routes/StackLayout.tsx")
    expect(screen?.tree[0]?.children.map((child) => child.file)).toEqual(["src/pages/Orders.tsx"])
  })

  const runStackLayout = (layout: string) => {
    const stackSource: ScreenSource = {
      ...layoutSource,
      ancestorsOf: () => [
        {
          file: "src/routes/StackLayout.tsx",
          exportName: "default",
          splice: { kind: "outlet", tag: "Stack" },
          role: "layout",
        },
      ],
    }
    return run({ files: { ...FILES, "src/routes/StackLayout.tsx": layout }, adapters: [adapterFor(stackSource)] })
  }

  const nestedLayers = (count: number): string =>
    Array.from({ length: count }, (_, index) =>
      index === count - 1
        ? `function Layer${String(index)}() { return <Stack><Stack.Screen name="a" /></Stack> }`
        : `function Layer${String(index)}() { return <Layer${String(index + 1)} /> }`,
    ).join("\n")

  it("splices a <Stack> rendered by a same-file component of a wrapped default export", () => {
    const result = runStackLayout(`
import { Stack } from "expo-router"
import { wrap } from "./reporting"

function RootLayout() {
  return <Inner />
}

function Inner() {
  return (
    <Stack>
      <Stack.Screen name="a" />
    </Stack>
  )
}

export default wrap(RootLayout)
`)
    const screen = result.graph.screens[0]

    expect(codes(result)).not.toContain("walk/no-splice-point")
    expect(codes(result)).not.toContain("walk/ambiguous-splice")
    expect(screen?.tree[0]?.file).toBe("src/routes/StackLayout.tsx")
    expect(screen?.tree[0]?.children.map((child) => child.file)).toEqual(["src/pages/Orders.tsx"])
  })

  it("keeps the export's own <Stack> and ignores one in a same-file component it renders", () => {
    const result = runStackLayout(`
import { Stack } from "expo-router"

function Inner() {
  return <Stack />
}

export default function StackLayout() {
  return (
    <>
      <Inner />
      <Stack />
    </>
  )
}
`)

    expect(codes(result)).not.toContain("walk/ambiguous-splice")
    expect(codes(result)).not.toContain("walk/no-splice-point")
  })

  it("bounds the same-file descent for a rendered <Stack>", () => {
    const within = runStackLayout(`
import { Stack } from "expo-router"
${nestedLayers(4)}
export default wrapper(Layer0)
`)
    const beyond = runStackLayout(`
import { Stack } from "expo-router"
${nestedLayers(6)}
export default wrapper(Layer0)
`)

    expect(codes(within)).not.toContain("walk/no-splice-point")
    expect(codes(beyond)).toContain("walk/no-splice-point")
  })
})

describe("pipeline/registry", () => {
  const sourceNamed = (name: string): ScreenSource => ({
    name,
    detect: () => ({ score: 100, evidence: [] }),
    discover: () => [],
  })

  const adapterNamed = (name: string, source: string): Adapter => ({
    name,
    screens: [sourceNamed(source)],
  })

  it("orders adapters by detection precedence, then name — never registration order", () => {
    const registry = createPipelineRegistry({
      adapters: [
        adapterNamed("z-adapter", "react-router"),
        adapterNamed("a-adapter", "next-app"),
        adapterNamed("m-adapter", "state-screens"),
        adapterNamed("b-adapter", "custom-source"),
      ],
    })

    expect(registry.screenSources.map((owned) => owned.source.name)).toEqual([
      "next-app",
      "react-router",
      "state-screens",
      "custom-source",
    ])
  })

  it("skips a duplicate adapter name with a diagnostic", () => {
    const registry = createPipelineRegistry({
      adapters: [adapterNamed("dup", "next-app"), adapterNamed("dup", "react-router")],
    })

    expect(registry.adapters).toHaveLength(1)
    expect(registry.diagnostics.map((entry) => entry.code)).toEqual(["plugin/duplicate-name"])
  })

  it("expands the `all` format and de-duplicates", () => {
    expect(expandFormats(["all", "index"])).toEqual(["full", "graph", "html", "index"])
  })

  it("rejects an emitter path that escapes the output dir", () => {
    const escaping: Emitter = {
      name: "full",
      emit: () => [{ path: "../outside.yaml", content: "x" }],
    }

    const source: ScreenSource = {
      name: "test-emit",
      detect: () => ({ score: 100, evidence: [] }),
      discover: () => [
        {
          localId: "src/pages/Orders.tsx",
          activations: [{ kind: "url", template: "/orders", params: [] }],
          entries: [],
          evidence: [],
        },
      ],
    }

    const result = run({
      files: FILES,
      adapters: [{ name: "escaping", screens: [source], emitters: [escaping] }],
    })

    expect(result.files).toEqual([])
    expect(codes(result)).toContain("emit/unwritable-output")
  })
})
