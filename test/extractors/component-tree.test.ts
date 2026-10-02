import { describe, expect, it } from "vitest"
import {
  AMBIGUOUS_COMPONENT_NAME_CODE,
  DEFAULT_TRAVERSABLE,
  REFERENCE_CONDITION,
  createComponentTreeExtractor,
} from "../../src/extractors/component-tree.js"
import type { RenderEdge } from "../../src/core/model.js"
import { deriveDefaultKindRules } from "../../src/core/kinds.js"
import ts from "typescript"
import { createExtractContext, createRegistry } from "../../src/extractors/registry.js"
import { createScriptSource } from "../../src/core/source-file.js"
import { templateDocOf, toPascal } from "../../src/core/vue-template.js"
import type { TemplateTagResolver, TemplateTagsOf } from "../../src/extractors/types.js"
import type { TagResolution, TemplateDoc, TemplateElement } from "../../src/core/template-doc.js"
import { EMPTY_TEMPLATE_TAGS } from "../../src/core/template-doc.js"
import { VUE_TEMPLATE_TAGS } from "../../src/core/vue-compiler.js"
import { ROOT, localModules, parse, realVueCompiler, relative, run, valuesOf } from "./harness.js"

const extractor = createComponentTreeExtractor()

const renders = (code: string, custom = extractor): readonly RenderEdge[] =>
  valuesOf(run([custom], code, { resolveModule: localModules }), "renders")

describe("component-tree — renders edges", () => {
  it("records an unguarded usage as alwaysRendered", () => {
    expect(renders(["import { Row } from './Row'", "export const A = () => <Row />"].join("\n"))).toEqual([
      { file: "src/Row.tsx", conditions: [], alwaysRendered: true, repeated: false },
    ])
  })

  it("records the guard text of a conditional usage", () => {
    const code = [
      "import { Row } from './Row'",
      "export const A = () => <div>{isReady && <Row />}</div>",
    ].join("\n")

    expect(renders(code)).toEqual([
      { file: "src/Row.tsx", conditions: ["isReady"], alwaysRendered: false, repeated: false },
    ])
  })

  it("OR-unions conditions from different usage sites and never conjoins them", () => {
    const code = [
      "import { Row } from './Row'",
      "export const A = () => (",
      "  <div>",
      "    {isReady && <Row />}",
      "    {isLoading ? <Row /> : null}",
      "  </div>",
      ")",
    ].join("\n")

    expect(renders(code)[0]?.conditions).toEqual(["isLoading", "isReady"])
  })

  it("sets alwaysRendered when ANY usage site is unguarded", () => {
    const code = [
      "import { Row } from './Row'",
      "export const A = () => (",
      "  <div>",
      "    {isReady && <Row />}",
      "    <Row />",
      "  </div>",
      ")",
    ].join("\n")

    expect(renders(code)[0]).toMatchObject({ alwaysRendered: true, conditions: ["isReady"] })
  })

  it("sets repeated when ANY usage site is inside a .map", () => {
    const code = [
      "import { Row } from './Row'",
      "export const A = () => <div>{items.map((item) => <Row key={item.id} />)}</div>",
    ].join("\n")

    expect(renders(code)[0]).toMatchObject({ repeated: true, alwaysRendered: true })
  })

  it("merges two locals that resolve to the same file", () => {
    const code = [
      "import { Row } from './Row'",
      "import RowDefault from './Row'",
      "export const A = () => (<div><Row />{flag && <RowDefault />}</div>)",
    ].join("\n")

    expect(renders(code)).toHaveLength(1)
    expect(renders(code)[0]).toMatchObject({ alwaysRendered: true, conditions: ["flag"] })
  })

  it("ignores host elements and unbound component tags", () => {
    const code = ["export const A = () => (<div><span /><Unbound /></div>)"].join("\n")
    expect(renders(code)).toEqual([])
  })

  it("resolves a lazily imported component", () => {
    const code = [
      "const load = async () => {",
      "  const { default: Orders } = await import('./Orders')",
      "  return <Orders />",
      "}",
    ].join("\n")

    expect(renders(code)).toEqual([
      { file: "src/Orders.tsx", conditions: [], alwaysRendered: true, repeated: false, via: "lazy" },
    ])
  })

  const lazyEdge = (file: string) => [{ file, conditions: [], alwaysRendered: true, repeated: false, via: "lazy" }]

  it.each([
    ["React.lazy", "import React from 'react'", "const Orders = React.lazy(() => import('./Orders'))"],
    ["namespace React.lazy", "import * as R from 'react'", "const Orders = R.lazy(() => import('./Orders'))"],
    ["lazy from react", "import { lazy } from 'react'", "const Orders = lazy(() => import('./Orders'))"],
    ["aliased lazy", "import { lazy as load } from 'react'", "const Orders = load(() => import('./Orders'))"],
    ["block-bodied factory", "import { lazy } from 'react'", "const Orders = lazy(() => { return import('./Orders') })"],
    ["next/dynamic", "import dynamic from 'next/dynamic'", "const Orders = dynamic(() => import('./Orders'))"],
    [
      "next/dynamic with options",
      "import dynamic from 'next/dynamic'",
      "const Orders = dynamic(() => import('./Orders'), { ssr: false })",
    ],
    ["@loadable/component", "import loadable from '@loadable/component'", "const Orders = loadable(() => import('./Orders'))"],
  ])("resolves %s to the imported module", (_label, importLine, declaration) => {
    const code = [importLine, declaration, "export const A = () => <Orders />"].join("\n")
    expect(renders(code)).toEqual(lazyEdge("src/Orders.tsx"))
  })

  it.each([
    ["react `{ default: m.Named }`", "import { lazy } from 'react'", "lazy(() => import('./Orders').then((m) => ({ default: m.OrdersPage })))"],
    ["next/dynamic `m => m.Named`", "import dynamic from 'next/dynamic'", "dynamic(() => import('./Orders').then((m) => m.OrdersPage), { ssr: false })"],
  ])("resolves a named export picked with %s", (_label, importLine, initializer) => {
    const code = [importLine, `const Orders = ${initializer}`, "export const A = () => <Orders />"].join("\n")
    const result = run([extractor], code, { resolveModule: localModules })
    expect(valuesOf(result, "renders")).toEqual(lazyEdge("src/Orders.tsx"))
  })

  it.each([
    ["export default lazy(...)", ["export default lazy(() => import('./Orders'))"]],
    ["a lazy const exported as default", ["const LazyOrders = lazy(() => import('./Orders'))", "export default LazyOrders"]],
    ["export const lazy(...)", ["export const LazyOrders = lazy(() => import('./Orders'))"]],
    ["a lazy const in an export list", ["const LazyOrders = lazy(() => import('./Orders'))", "export { LazyOrders as Orders }"]],
    [
      "an exported `.then` named pick",
      ["export const LazyOrders = lazy(() => import('./Orders').then((m) => ({ default: m.OrdersPage })))"],
    ],
  ])("renders the target of %s", (_label, lines) => {
    const code = ["import { lazy } from 'react'", ...lines].join("\n")
    expect(renders(code)).toEqual(lazyEdge("src/Orders.tsx"))
  })

  it.each([
    ["next/dynamic", "import dynamic from 'next/dynamic'", "export default dynamic(() => import('./Orders'), { ssr: false })"],
    ["@loadable/component", "import loadable from '@loadable/component'", "export const Orders = loadable(() => import('./Orders'))"],
  ])("renders the target of an exported %s value", (_label, importLine, declaration) => {
    expect(renders([importLine, declaration].join("\n"))).toEqual(lazyEdge("src/Orders.tsx"))
  })

  it("leaves a non-exported lazy const used in JSX as a single guarded edge", () => {
    const code = [
      "import { lazy } from 'react'",
      "const Orders = lazy(() => import('./Orders'))",
      "export const A = () => <div>{flag && <Orders />}</div>",
    ].join("\n")

    expect(renders(code)).toEqual([
      { file: "src/Orders.tsx", conditions: ["flag"], alwaysRendered: false, repeated: false, via: "lazy" },
    ])
  })

  it("ignores a non-exported lazy const that is never rendered", () => {
    const code = ["import { lazy } from 'react'", "const Orders = lazy(() => import('./Orders'))"].join("\n")
    expect(renders(code)).toEqual([])
  })

  it("leaves a lazy factory it cannot read unbound", () => {
    const code = [
      "import { lazy } from 'react'",
      "const Orders = lazy(() => import('./Orders').then(pick))",
      "const Other = lazy(async () => { const m = await import('./Other'); return { default: m.Other } })",
      "export const A = () => <div><Orders /><Other /></div>",
    ].join("\n")

    expect(renders(code)).toEqual([])
  })

  it("does not treat a same-named local `lazy` as React.lazy", () => {
    const code = [
      "const lazy = (load) => load",
      "const Orders = lazy(() => import('./Orders'))",
      "export const A = () => <Orders />",
    ].join("\n")

    expect(renders(code)).toEqual([])
  })

  it("emits render edges in codepoint order", () => {
    const code = [
      "import { B } from './B'",
      "import { A } from './A'",
      "export const X = () => (<div><B /><A /></div>)",
    ].join("\n")

    expect(renders(code).map((edge) => edge.file)).toEqual(["src/A.tsx", "src/B.tsx"])
  })
})

describe("component-tree — nullGuards", () => {
  it("emits the condition of an early `return null` inside a rendering function", () => {
    const code = [
      "export const A = ({ order }) => {",
      "  if (!order) {",
      "    return null",
      "  }",
      "  return <div />",
      "}",
    ].join("\n")

    expect(valuesOf(run([extractor], code), "nullGuards")).toEqual(["!order"])
  })
})

describe("component-tree — uses, and the classification seam", () => {
  it("uses the injected predicate, not a hardcoded src/(services|stores|shared/hooks) path", () => {
    const code = ["import { orderService } from '@/services/orders'", "export const A = () => <div />"].join("\n")

    expect(valuesOf(run([extractor], code, { resolveModule: localModules }), "uses")).toEqual([])

    const configured = createComponentTreeExtractor({ isTraversable: (file) => file.startsWith("src/services/") })
    expect(valuesOf(run([configured], code, { resolveModule: localModules }), "uses")).toEqual([
      "src/services/orders.tsx",
    ])
  })

  it("reads KindRule.traversable from core/kinds.ts when rules are supplied", () => {
    const configured = createComponentTreeExtractor({ kindRules: deriveDefaultKindRules() })
    const code = ["import { orderService } from '@/services/orders'", "export const A = () => <div />"].join("\n")

    expect(valuesOf(run([configured], code, { resolveModule: localModules }), "uses")).toEqual([
      "src/services/orders.tsx",
    ])
  })

  it("defaults to the React hook-naming rule only", () => {
    expect(DEFAULT_TRAVERSABLE("src/anything/useOrders.ts")).toBe(true)
    expect(DEFAULT_TRAVERSABLE("src/services/orders.ts")).toBe(false)

    const code = ["import { useOrders } from './hooks/useOrders'", "export const A = () => <div />"].join("\n")
    expect(valuesOf(run([extractor], code, { resolveModule: localModules }), "uses")).toEqual([
      "src/hooks/useOrders.tsx",
    ])
  })

  it("never lists a file that is already a render edge", () => {
    const code = [
      "import { OrdersProvider } from './hooks/useOrders'",
      "export const A = () => <OrdersProvider />",
    ].join("\n")

    const result = run([extractor], code, { resolveModule: localModules })
    expect(valuesOf(result, "renders").map((edge) => edge.file)).toEqual(["src/hooks/useOrders.tsx"])
    expect(valuesOf(result, "uses")).toEqual([])
  })
})

describe("component-tree — components referenced as values", () => {
  const COMPONENT_SOURCES = {
    [`${ROOT}/src/TablePanel.tsx`]: "export const TablePanel = () => <section />",
    [`${ROOT}/src/ChartPanel.tsx`]: "export function ChartPanel() { return <ul /> }",
    [`${ROOT}/src/ListView.tsx`]: "const ListView = () => <ol />\nexport default ListView",
    [`${ROOT}/src/GridView.tsx`]: "import { memo } from 'react'\nconst Inner = () => <table />\nexport const GridView = memo(Inner)",
    [`${ROOT}/src/Legacy.tsx`]: "export default class Legacy extends Component { render() { return <div /> } }",
    [`${ROOT}/src/Status.tsx`]: "export const Status = { Open: 'open' } as const",
    [`${ROOT}/src/Body.tsx`]: "export const Body = () => <tbody />",
  }

  const referenced = (code: string): readonly RenderEdge[] =>
    valuesOf(run([extractor], code, { resolveModule: localModules, sources: COMPONENT_SOURCES }), "renders")

  const referenceEdge = (file: string): RenderEdge => ({
    file,
    conditions: [REFERENCE_CONDITION],
    alwaysRendered: false,
    repeated: false,
    via: "reference",
  })

  it("links components held in a config array and picked at runtime", () => {
    const code = [
      "import { ChartPanel } from './ChartPanel'",
      "import { TablePanel } from './TablePanel'",
      "const TABS = [{ id: 'table', Panel: TablePanel }, { id: 'chart', Panel: ChartPanel }] as const",
      "export const Reports = ({ id }) => { const { Panel } = TABS.find((tab) => tab.id === id); return <Panel /> }",
    ].join("\n")

    expect(referenced(code)).toEqual([referenceEdge("src/ChartPanel.tsx"), referenceEdge("src/TablePanel.tsx")])
  })

  it.each([
    ["a record map", "const VIEWS = { list: ListView, grid: GridView } as const"],
    ["shorthand properties", "const VIEWS = { ListView, GridView }"],
    ["a ternary initializer", "const View = mode === 'grid' ? GridView : ListView"],
    ["JSX attribute values", "export const A = () => <Switch list={ListView} grid={GridView ?? null} />"],
  ])("follows %s", (_label, line) => {
    const code = ["import ListView from './ListView'", "import { GridView } from './GridView'", line].join("\n")
    expect(referenced(code)).toEqual([referenceEdge("src/GridView.tsx"), referenceEdge("src/ListView.tsx")])
  })

  it("accepts a class component and a `component:` route-style option", () => {
    const code = ["import Legacy from './Legacy'", "export const Route = createRoute({ component: Legacy })"].join("\n")
    expect(referenced(code)).toEqual([referenceEdge("src/Legacy.tsx")])
  })

  it("never links library components, non-component values, call arguments or type positions", () => {
    const code = [
      "import { ChartColumn } from 'lucide-react'",
      "import { Status } from './Status'",
      "import { TablePanel } from './TablePanel'",
      "import { Missing } from './Missing'",
      "type Props = { Panel: typeof TablePanel }",
      "const TABS = [{ icon: ChartColumn, status: Status.Open, missing: Missing }]",
      "register(TablePanel)",
    ].join("\n")

    expect(referenced(code)).toEqual([])
  })

  it("keeps the JSX semantics when the same component is also rendered as a tag", () => {
    const code = [
      "import { TablePanel } from './TablePanel'",
      "const TABS = [{ Panel: TablePanel }]",
      "export const A = () => <TablePanel />",
    ].join("\n")

    expect(referenced(code)).toEqual([
      { file: "src/TablePanel.tsx", conditions: [], alwaysRendered: true, repeated: false },
    ])
  })

  it("does not treat an Object.assign compound namespace as the root's children", () => {
    const code = [
      "import { Body } from './Body'",
      "const Root = ({ children }) => <table>{children}</table>",
      "export const Table = Object.assign(Root, { Body })",
    ].join("\n")

    expect(referenced(code)).toEqual([])
  })

  describe("lowercase values and registries whose declarations render", () => {
    const chainOf = (length: number): string =>
      [
        ...Array.from({ length }, (_, index) => `const link${String(index)} = [...link${String(index + 1)}]`),
        `const link${String(length)} = [{ cell: () => <b /> }]`,
        "export const deep = [...link0]",
      ].join("\n")

    const VALUE_SOURCES: Readonly<Record<string, string>> = {
      [`${ROOT}/src/cols.tsx`]: "export const cols = [{ id: 'name', cell: ({ row }) => <b>{row.name}</b> }]",
      [`${ROOT}/src/buildColumns.tsx`]: "export const buildColumns = (cfg) => cfg.map((id) => ({ id, cell: () => <i /> }))",
      [`${ROOT}/src/chained.tsx`]: "import { shared } from './shared'\nexport const chained = [...shared]",
      [`${ROOT}/src/shared.tsx`]: "export const shared = [{ id: 'x', cell: () => <b /> }]",
      [`${ROOT}/src/renderCell.tsx`]: "export const renderCell = (row) => <td>{row.id}</td>",
      [`${ROOT}/src/views.tsx`]: "import ListView from './ListView'\nexport const VIEWS = { list: ListView }",
      [`${ROOT}/src/ListView.tsx`]: "const ListView = () => <ol />\nexport default ListView",
      [`${ROOT}/src/dashboards.ts`]: [
        "import dynamic from 'next/dynamic'",
        "export const DASHBOARDS = { a: dynamic(() => import('./A').then((m) => m.A)) }",
      ].join("\n"),
      [`${ROOT}/src/A.tsx`]: "export const A = () => <section />",
      [`${ROOT}/src/status.ts`]: "export const status = { open: 'open' } as const",
      [`${ROOT}/src/formatDate.ts`]: "export const formatDate = (date) => date.toISOString()",
      [`${ROOT}/src/useThing.tsx`]: "export const useThing = () => <div />",
      [`${ROOT}/src/loaders.ts`]: "export const loaders = { plain: () => import('./plain') }",
      [`${ROOT}/src/plain.ts`]: "export const plain = 1",
      [`${ROOT}/src/near.tsx`]: chainOf(3),
      [`${ROOT}/src/far.tsx`]: chainOf(4),
      [`${ROOT}/src/cycleA.tsx`]: "import { cycleB } from './cycleB'\nexport const cycleA = [...cycleB]",
      [`${ROOT}/src/cycleB.tsx`]: "import { cycleA } from './cycleA'\nexport const cycleB = [...cycleA]",
      [`${ROOT}/src/useOrderModal.tsx`]: [
        "import { lazy } from 'react'",
        "const Container = lazy(() => import('./A'))",
        "export const preloadOrder = Container.preload",
        "export const useOrderModal = () => null",
      ].join("\n"),
    }

    const resolveFrom = (from: string, specifier: string): string | null => {
      if (!specifier.startsWith("./")) return null
      const base = `${from.slice(0, from.lastIndexOf("/"))}/${specifier.slice(2)}`
      return [".tsx", ".ts"].map((extension) => `${base}${extension}`).find((abs) => abs in VALUE_SOURCES) ?? null
    }

    const referencedValues = (code: string): readonly RenderEdge[] => {
      const file = "src/screen.tsx"
      const input = createExtractContext({
        ts,
        file,
        source: parse(code, file),
        resolveModule: (specifier) => resolveFrom(`${ROOT}/${file}`, specifier),
        resolve: {
          declarationFile: (abs) => abs,
          relative,
          resolveModule: resolveFrom,
          sourceFile: (abs) => {
            const text = VALUE_SOURCES[abs]
            return text === undefined
              ? null
              : ts.createSourceFile(abs, text, ts.ScriptTarget.ESNext, true, abs.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
          },
        },
      })
      return valuesOf(createRegistry({ extractors: [extractor] }).run(input), "renders")
    }

    it.each([
      ["a shorthand property slot", "import { cols } from './cols'", "useTable({ cols })", "src/cols.tsx"],
      ["a named property slot", "import { cols } from './cols'", "useTable({ columns: cols })", "src/cols.tsx"],
      ["a JSX attribute", "import { cols } from './cols'", "export const A = () => <Table columns={cols} />", "src/cols.tsx"],
      ["a call callee", "import { buildColumns } from './buildColumns'", "const columns = buildColumns(cfg)", "src/buildColumns.tsx"],
      ["a member receiver", "import { cols } from './cols'", "const ids = cols.map((col) => col.id)", "src/cols.tsx"],
      ["a spread", "import { cols } from './cols'", "const columns = [...cols]", "src/cols.tsx"],
      ["a cross-file chain", "import { chained } from './chained'", "useTable({ columns: chained })", "src/chained.tsx"],
      ["an exported render-prop function", "import { renderCell } from './renderCell'", "export const A = () => <Table renderCell={renderCell} />", "src/renderCell.tsx"],
      ["a chain within the hop cap", "import { deep } from './near'", "useTable({ columns: deep })", "src/near.tsx"],
      ["an uppercase registry element access", "import { VIEWS } from './views'", "export const A = ({ kind }) => <Shell Dashboard={VIEWS[kind]} />", "src/views.tsx"],
      ["a registry of lazy imports", "import { DASHBOARDS } from './dashboards'", "export const A = ({ kind }) => <Shell Dashboard={DASHBOARDS[kind]} />", "src/dashboards.ts"],
    ])("links a renderable value used through %s", (_label, importLine, usage, file) => {
      expect(referencedValues([importLine, usage].join("\n"))).toEqual([referenceEdge(file)])
    })

    it.each([
      ["a constant without JSX", "import { status } from './status'", "useTable({ status })"],
      ["a util function without JSX", "import { formatDate } from './formatDate'", "const label = formatDate(x)"],
      ["a hook call whose file has JSX", "import { useThing } from './useThing'", "const thing = useThing()"],
      ["a type-only use", "import { cols } from './cols'", "type Props = { columns: typeof cols }"],
      ["a lazy import of a module without JSX", "import { loaders } from './loaders'", "useTable({ loaders })"],
      ["a chain longer than the hop cap", "import { deep } from './far'", "useTable({ columns: deep })"],
      ["an import cycle without JSX", "import { cycleA } from './cycleA'", "useTable({ rows: cycleA })"],
      [
        "a lowercase value from a hook file the walk reaches as `uses`",
        "import { preloadOrder } from './useOrderModal'",
        "export const A = () => <Button onMouseEnter={preloadOrder} />",
      ],
    ])("never links %s", (_label, importLine, usage) => {
      expect(referencedValues([importLine, usage].join("\n"))).toEqual([])
    })
  })
})

describe("component-tree — via provenance", () => {
  it("keeps the lazy marker when the same file is also rendered through a static tag", () => {
    const code = [
      "import { lazy } from 'react'",
      "import { Orders as Eager } from './Orders'",
      "const Orders = lazy(() => import('./Orders'))",
      "export const A = () => <div>{flag ? <Orders /> : <Eager />}</div>",
    ].join("\n")

    expect(renders(code)).toEqual([
      { file: "src/Orders.tsx", conditions: ["!(flag)", "flag"], alwaysRendered: false, repeated: false, via: "lazy" },
    ])
  })
})

describe("component-tree — compound component member tags", () => {
  const SOURCES: Readonly<Record<string, string>> = {
    [`${ROOT}/src/table/body.tsx`]: "export const Body = () => <tbody />",
    [`${ROOT}/src/table/header.tsx`]: "export const Header = () => <thead />",
    [`${ROOT}/src/table/assign.tsx`]: [
      "import { Body } from './body'",
      "import { Header as TableHeader } from './header'",
      "const Root = ({ children }) => <table>{children}</table>",
      "const Footer = () => <tfoot />",
      "export const Table = Object.assign(Root, { Body, Header: TableHeader, Footer })",
    ].join("\n"),
    [`${ROOT}/src/table/static.tsx`]: [
      "import { Body } from './body'",
      "export function Table({ children }) { return <table>{children}</table> }",
      "Table.Body = Body",
    ].join("\n"),
    [`${ROOT}/src/table/literal.tsx`]: [
      "import * as Parts from './parts'",
      "export const Table = { Body: Parts.Body, Header: Parts.Header }",
    ].join("\n"),
    [`${ROOT}/src/table/parts.tsx`]: "export { Body } from './body'\nexport { Header } from './header'",
    [`${ROOT}/src/table/index.tsx`]: "export * as Table from './parts'\nexport * as Dialog from '@radix-ui/react-dialog'",
  }

  const PARTS: Readonly<Record<string, string>> = {
    [`${ROOT}/src/table/parts.tsx#Body`]: `${ROOT}/src/table/body.tsx`,
    [`${ROOT}/src/table/parts.tsx#Header`]: `${ROOT}/src/table/header.tsx`,
  }

  const resolveFrom = (from: string, specifier: string): string | null => {
    if (!specifier.startsWith(".")) return null
    return `${from.slice(0, from.lastIndexOf("/"))}/${specifier.slice(2)}.tsx`
  }

  const memberRenders = (code: string): readonly string[] => {
    const file = "src/screen.tsx"
    const source = parse(code, file)
    const input = createExtractContext({
      ts,
      file,
      source,
      resolveModule: (specifier) => resolveFrom(`${ROOT}/${file}`, specifier),
      resolve: {
        declarationFile: (abs, name) => PARTS[`${abs}#${name}`] ?? abs,
        relative,
        resolveModule: resolveFrom,
        sourceFile: (abs) => {
          const text = SOURCES[abs]
          return text === undefined
            ? null
            : ts.createSourceFile(abs, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
        },
      },
    })
    return valuesOf(createRegistry({ extractors: [extractor] }).run(input), "renders").map((edge) => edge.file)
  }

  const usage = (importLine: string): string =>
    [importLine, "export const Screen = () => <Table.Body />"].join("\n")

  it.each([
    ["Object.assign(Root, { Body })", "import { Table } from './table/assign'"],
    ["a static `Table.Body = Body` assignment", "import { Table } from './table/static'"],
    ["an object literal namespace", "import { Table } from './table/literal'"],
    ["`export * as Table from './parts'`", "import { Table } from './table/index'"],
    ["`import * as Table from './parts'`", "import * as Table from './table/parts'"],
  ])("links <Table.Body/> to the part for %s", (_label, importLine) => {
    expect(memberRenders(usage(importLine))).toEqual(["src/table/body.tsx"])
  })

  it("follows a renamed part and keeps a part declared in the namespace file on that file", () => {
    const code = [
      "import { Table } from './table/assign'",
      "export const Screen = () => <Table><Table.Header /><Table.Footer /></Table>",
    ].join("\n")

    expect(memberRenders(code)).toEqual(["src/table/assign.tsx", "src/table/header.tsx"])
  })

  it("never links a library namespace, directly or through a project re-export", () => {
    const code = [
      "import * as Radix from '@radix-ui/react-dialog'",
      "import { Dialog } from './table/index'",
      "export const Screen = () => <div><Radix.Root /><Dialog.Root /></div>",
    ].join("\n")

    expect(memberRenders(code)).toEqual([])
  })

  it("falls back to the namespace file when the member cannot be read", () => {
    expect(memberRenders(usage("import { Table } from './table/missing'"))).toEqual(["src/table/missing.tsx"])
  })
})

describe("component-tree — per-file isolation", () => {
  it("does not leak state between files", () => {
    const first = renders(["import { Row } from './Row'", "export const A = () => <Row />"].join("\n"))
    const second = renders(["import { Cell } from './Cell'", "export const B = () => <Cell />"].join("\n"))

    expect(first.map((edge) => edge.file)).toEqual(["src/Row.tsx"])
    expect(second.map((edge) => edge.file)).toEqual(["src/Cell.tsx"])
  })
})

describe("component-tree — Vue template edges", () => {
  const vueModules = (specifier: string): string | null =>
    specifier.startsWith("./") ? `${ROOT}/src/${specifier.slice(2)}` : null

  const AMBIENT: Readonly<Record<string, string>> = { Map: "components/Map.vue", Card: "components/Card.vue" }

  const ambientOf = (tag: string): TagResolution | null => {
    const name = toPascal(tag)
    const direct = AMBIENT[name]
    if (direct !== undefined) return { kind: "file", file: direct, exportName: "default", via: "ambient" }
    const lazy = name.startsWith("Lazy") ? AMBIENT[name.slice(4)] : undefined
    return lazy === undefined ? null : { kind: "file", file: lazy, exportName: "default", via: "lazy" }
  }

  const ambientTag: TemplateTagResolver = (_doc, element) => ambientOf(element.tag)

  const vueTags: TemplateTagsOf = () => VUE_TEMPLATE_TAGS

  type VueRun = {
    readonly resolveTag?: TemplateTagResolver
    readonly tagsOf?: TemplateTagsOf
    readonly docOf?: (doc: TemplateDoc) => TemplateDoc
  }

  const vueRun = (sfc: string, options: VueRun = {}) => {
    const file = "src/Page.vue"
    const doc = templateDocOf(realVueCompiler(), sfc, file)
    const input = createExtractContext({
      ts,
      file,
      source: createScriptSource(ts, `${ROOT}/${file}`, sfc),
      templates: [options.docOf?.(doc) ?? doc],
      resolveTag: options.resolveTag ?? ambientTag,
      tagsOf: options.tagsOf ?? vueTags,
      resolveModule: vueModules,
      resolve: {
        declarationFile: (abs) => abs,
        relative,
        resolveModule: (_from, specifier) => vueModules(specifier),
        sourceFile: () => null,
      },
    })
    return createRegistry({ extractors: [extractor] }).run(input)
  }

  const vueRenders = (sfc: string, options: VueRun = {}): readonly RenderEdge[] =>
    valuesOf(vueRun(sfc, options), "renders")

  const resolvedBy =
    (table: Readonly<Record<string, TagResolution>>): TemplateTagResolver =>
    (_doc, element) =>
      table[element.tag] ?? null

  const edge = (file: string, extra: Partial<RenderEdge> = {}): RenderEdge => ({
    file,
    conditions: [],
    alwaysRendered: true,
    repeated: false,
    ...extra,
  })

  const setup = (lines: readonly string[], template: string): string =>
    ['<script setup lang="ts">', ...lines, "</script>", `<template>${template}</template>`].join("\n")

  it("links a <script setup> import used as a kebab-case tag", () => {
    const sfc = setup(["import UserCard from './UserCard.vue'"], "<div><user-card /></div>")
    expect(vueRenders(sfc)).toEqual([edge("src/UserCard.vue")])
  })

  it("links Options API components, including renamed and string keys", () => {
    const sfc = [
      "<script>",
      "import { defineComponent } from 'vue'",
      "import Baz from './Baz.vue'",
      "import Qux from './Qux.vue'",
      "import Plain from './Plain.vue'",
      "export default defineComponent({ components: { Bar: Baz, 'my-qux': Qux, Plain } })",
      "</script>",
      "<template><div><Bar /><my-qux /><plain /></div></template>",
    ].join("\n")
    expect(vueRenders(sfc).map((entry) => entry.file)).toEqual(["src/Baz.vue", "src/Plain.vue", "src/Qux.vue"])
  })

  it("merges a script value reference and a template use into one rendered edge", () => {
    const sfc = setup(
      ["import Panel from './Panel.vue'", "const views = { panel: Panel }"],
      '<div><Panel v-if="open" /></div>',
    )
    expect(vueRenders(sfc)).toEqual([edge("src/Panel.vue", { conditions: ["open"], alwaysRendered: false })])
  })

  it("carries v-if / v-else conditions and ORs them across usages", () => {
    const sfc = setup(
      ["import Row from './Row.vue'"],
      '<div><Row v-if="ready" /><span v-else-if="loading" /><Row v-else /></div>',
    )
    expect(vueRenders(sfc)).toEqual([
      edge("src/Row.vue", { conditions: ["!(ready) && !(loading)", "ready"], alwaysRendered: false }),
    ])
  })

  it("marks a v-for usage as repeated", () => {
    const sfc = setup(["import Row from './Row.vue'"], '<ul><Row v-for="item in items" :key="item.id" /></ul>')
    expect(vueRenders(sfc)).toEqual([edge("src/Row.vue", { repeated: true })])
  })

  it("marks a defineAsyncComponent binding as lazy", () => {
    const sfc = setup(
      ["import { defineAsyncComponent } from 'vue'", "const Chart = defineAsyncComponent(() => import('./Chart.vue'))"],
      "<Chart />",
    )
    expect(vueRenders(sfc)).toEqual([edge("src/Chart.vue", { via: "lazy" })])
  })

  it("links ambient components, a Lazy prefix becoming a lazy edge", () => {
    const sfc = setup([], '<div><LazyMap /><card v-if="ok" /></div>')
    expect(vueRenders(sfc)).toEqual([
      edge("components/Card.vue", { conditions: ["ok"], alwaysRendered: false }),
      edge("components/Map.vue", { via: "lazy" }),
    ])
  })

  it("links <component :is> targets as references", () => {
    const sfc = setup(
      ["import GridView from './GridView.vue'", "import ListView from './ListView.vue'"],
      '<component :is="grid ? GridView : ListView" />',
    )
    expect(vueRenders(sfc)).toEqual([
      { file: "src/GridView.vue", conditions: [REFERENCE_CONDITION], alwaysRendered: false, repeated: false, via: "reference" },
      { file: "src/ListView.vue", conditions: [REFERENCE_CONDITION], alwaysRendered: false, repeated: false, via: "reference" },
    ])
  })

  it("never links built-in tags, even when a same-named binding exists", () => {
    const sfc = setup(
      ["import RouterView from './RouterView.vue'", "import Transition from './Transition.vue'"],
      "<div><router-view /><RouterLink to='/' /><NuxtPage /><transition /><keep-alive /><teleport to='body' /><slot /></div>",
    )
    expect(vueRenders(sfc)).toEqual([])
  })

  it("takes the built-in skip list from the framework's tags, not a fixed list", () => {
    const sfc = setup(["import UserCard from './UserCard.vue'"], "<div><router-view /><user-card /></div>")
    const tagsOf: TemplateTagsOf = () => ({ ...EMPTY_TEMPLATE_TAGS, builtins: ["UserCard"] })
    expect(vueRenders(sfc, { tagsOf })).toEqual([])
    expect(vueRenders(sfc, { tagsOf: () => EMPTY_TEMPLATE_TAGS })).toEqual([edge("src/UserCard.vue")])
  })

  it("puts an authoritative tag resolution ahead of a same-named script binding and never re-filters it", () => {
    const sfc = setup(["import UserCard from './UserCard.vue'"], "<div><user-card /></div>")
    const resolveTag = resolvedBy({
      "user-card": { kind: "file", file: "src/cards/user.ts", exportName: "UserCardComponent", via: "selector" },
    })
    expect(vueRenders(sfc, { resolveTag })).toEqual([edge("src/cards/user.ts", { via: "selector" })])
  })

  it("carries a selector-global resolution through to the edge's via", () => {
    const sfc = setup([], "<div><user-card /></div>")
    const resolveTag = resolvedBy({
      "user-card": { kind: "file", file: "src/cards/user.ts", exportName: "UserCardComponent", via: "selector-global" },
    })
    expect(vueRenders(sfc, { resolveTag })).toEqual([edge("src/cards/user.ts", { via: "selector-global" })])
  })

  it("lets a lazy guard win over a selector resolution", () => {
    const sfc = setup([], "<div><user-card /><app-chip /></div>")
    const resolveTag = resolvedBy({
      "user-card": { kind: "file", file: "src/cards/user.ts", exportName: "UserCardComponent", via: "selector" },
      "app-chip": { kind: "file", file: "src/chip.ts", exportName: "ChipComponent", via: "selector-global" },
    })
    const lazyElement = (element: TemplateElement): TemplateElement =>
      element.kind === "component" ? { ...element, guard: { ...element.guard, lazy: true } } : element
    const docOf = (doc: TemplateDoc): TemplateDoc => ({ ...doc, elements: doc.elements.map(lazyElement) })
    expect(vueRenders(sfc, { resolveTag, docOf })).toEqual([
      edge("src/cards/user.ts", { via: "lazy" }),
      edge("src/chip.ts", { via: "lazy" }),
    ])
  })

  it("keeps the strongest via when one file is reached by selector and by lazy tag", () => {
    const sfc = setup([], "<div><user-card /><lazy-user-card /></div>")
    const resolveTag = resolvedBy({
      "user-card": { kind: "file", file: "src/cards/user.ts", exportName: "UserCardComponent", via: "selector" },
      "lazy-user-card": { kind: "file", file: "src/cards/user.ts", exportName: "UserCardComponent", via: "lazy" },
    })
    expect(vueRenders(sfc, { resolveTag })).toEqual([edge("src/cards/user.ts", { via: "lazy" })])
  })

  it("lets a script binding shadow an ambient auto-import of the same name", () => {
    const sfc = setup(["import Card from './Card.vue'"], "<div><card /></div>")
    expect(vueRenders(sfc)).toEqual([edge("src/Card.vue")])
  })

  it("marks a lazily guarded element as a lazy edge", () => {
    const sfc = setup(["import Row from './Row.vue'"], "<div><Row /><card /></div>")
    const lazyElement = (element: TemplateElement): TemplateElement =>
      element.kind === "component" ? { ...element, guard: { ...element.guard, lazy: true } } : element
    const docOf = (doc: TemplateDoc): TemplateDoc => ({ ...doc, elements: doc.elements.map(lazyElement) })
    expect(vueRenders(sfc, { docOf })).toEqual([
      edge("components/Card.vue", { via: "lazy" }),
      edge("src/Row.vue", { via: "lazy" }),
    ])
  })

  it("draws no edge for an ambiguous tag and reports it once per file, naming each tag and its files", () => {
    const sfc = setup(
      ["import Panel from './Panel.vue'"],
      "<div>\n<Panel />\n<Widget />\n<Button v-if='a' />\n<Button />\n<Widget />\n</div>",
    )
    const resolveTag = resolvedBy({
      Button: { kind: "ambiguous", files: ["src/z/Button.vue", "src/a/Button.vue"] },
      Widget: { kind: "ambiguous", files: ["src/b/Widget.vue", "src/a/Widget.vue"] },
      Panel: { kind: "ambiguous", files: ["src/x/Panel.vue", "src/y/Panel.vue"] },
    })
    const result = vueRun(sfc, { resolveTag })
    expect(valuesOf(result, "renders")).toEqual([edge("src/Panel.vue")])
    expect(result.diagnostics.map(({ severity, code, file, line, message }) => ({ severity, code, file, line, message }))).toEqual([
      {
        severity: "info",
        code: AMBIGUOUS_COMPONENT_NAME_CODE,
        file: "src/Page.vue",
        line: 6,
        message:
          "2 template tag(s) match more than one component file; no render edge is drawn for them: <Button> (src/a/Button.vue, src/z/Button.vue); <Widget> (src/a/Widget.vue, src/b/Widget.vue)",
      },
    ])
  })

  it("never links native HTML or SVG tags", () => {
    const sfc = setup(["import Button from './Button.vue'"], "<div><button /><svg><circle /></svg></div>")
    expect(vueRenders(sfc)).toEqual([])
  })
})

describe("component-tree — custom hook calls on the hooks channel (C13)", () => {
  const hooks = (code: string) => valuesOf(run([extractor], code, { resolveModule: localModules }), "hooks")

  it("records imported and local custom hooks once each and skips React built-ins", () => {
    const code = [
      "import { useState, useEffect } from 'react'",
      "import { useOrders } from './hooks/useOrders'",
      "const useLocalFilter = () => useState('')",
      "export const Page = () => {",
      "  const [open] = useState(false)",
      "  useEffect(() => {}, [])",
      "  const orders = useOrders()",
      "  const again = useOrders()",
      "  const filter = useLocalFilter()",
      "  return <div />",
      "}",
    ].join("\n")

    expect(hooks(code)).toEqual(["useOrders", "useLocalFilter"])
  })

  it("ignores names that only start with `use`, member calls and the bare `use` API", () => {
    const code = [
      "import { use } from 'react'",
      "export const Page = () => { user(); useful(); React.useState(0); use(promise); return null }",
    ].join("\n")

    expect(hooks(code)).toEqual([])
  })
})

describe("component-tree — uses edges point at the declaring file, not the barrel", () => {
  const BARREL = `${ROOT}/src/lib/index.tsx`
  const DECLARED: Readonly<Record<string, string>> = {
    [`${BARREL}#useCart`]: `${ROOT}/src/lib/useCart.tsx`,
    [`${BARREL}#useUsers`]: `${ROOT}/src/lib/useUsers.tsx`,
  }
  const SOURCES: Readonly<Record<string, string>> = {
    [`${ROOT}/src/ui/table.tsx`]: [
      "import { Body } from './body'",
      "const Root = () => <table />",
      "Root.Body = Body",
      "export { Root as Table }",
    ].join("\n"),
  }

  const runWith = (code: string) => {
    const file = "src/screen.tsx"
    const resolveFrom = (from: string, specifier: string): string | null => {
      if (specifier === "./lib") return BARREL
      if (!specifier.startsWith(".")) return null
      return `${from.slice(0, from.lastIndexOf("/"))}/${specifier.slice(2)}.tsx`
    }
    const input = createExtractContext({
      ts,
      file,
      source: parse(code, file),
      resolveModule: (specifier) => resolveFrom(`${ROOT}/${file}`, specifier),
      resolve: {
        declarationFile: (abs, name) => DECLARED[`${abs}#${name}`] ?? abs,
        relative,
        resolveModule: resolveFrom,
        sourceFile: (abs) => {
          const text = SOURCES[abs]
          return text === undefined ? null : ts.createSourceFile(abs, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
        },
      },
    })
    return createRegistry({ extractors: [extractor] }).run(input)
  }

  it("follows a named import through a non-traversable barrel to the hook that declares it", () => {
    const result = runWith(["import { useCart } from './lib'", "export const Screen = () => { useCart(); return null }"].join("\n"))
    expect(valuesOf(result, "uses")).toEqual(["src/lib/useCart.tsx"])
  })

  it("does not make the barrel's other re-exports reachable", () => {
    const result = runWith(["import { useCart } from './lib'", "useCart()"].join("\n"))
    expect(valuesOf(result, "uses")).not.toContain("src/lib/useUsers.tsx")
  })

  it("reads a compound part off a namespace exported under an alias (`export { Root as Table }`)", () => {
    const result = runWith(["import { Table } from './ui/table'", "export const Screen = () => <Table.Body />"].join("\n"))
    expect(valuesOf(result, "renders").map((edge) => edge.file)).toEqual(["src/ui/body.tsx"])
  })
})
