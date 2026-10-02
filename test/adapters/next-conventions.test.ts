import { describe, expect, it } from "vitest"
import {
  NEXT_DEFAULT_PAGE_EXTENSIONS,
  findConventionFile,
  nextPageExtensions,
  nextPagesRootOf,
  pageEntryOf,
} from "../../src/adapters/next-conventions.js"
import { discoverBench } from "./discover-harness.js"

const PAGE = "export default function Page() { return <div /> }\n"

describe("adapters/next-conventions nextPagesRootOf", () => {
  it("prefers the root pages/ and owes one info for the ignored src/pages/", () => {
    const { ctx } = discoverBench({ "pages/index.tsx": PAGE, "src/pages/index.tsx": PAGE })
    const read = nextPagesRootOf(ctx)

    expect(read.value).toBe("pages")
    expect(read.notices).toEqual([
      expect.objectContaining({ severity: "info", code: "screens/unsupported-next-convention", file: "src/pages" }),
    ])
  })

  it("falls back to src/pages/ with no notice", () => {
    const { ctx } = discoverBench({ "src/pages/index.tsx": PAGE })
    expect(nextPagesRootOf(ctx)).toEqual({ value: "src/pages", notices: [] })
  })

  it("has no root without either directory", () => {
    const { ctx } = discoverBench({ "src/main.tsx": PAGE })
    expect(nextPagesRootOf(ctx).value).toBeNull()
  })

  it("memoises the read per run", () => {
    const { ctx } = discoverBench({ "pages/index.tsx": PAGE })
    expect(nextPagesRootOf(ctx)).toBe(nextPagesRootOf(ctx))
  })
})

describe("adapters/next-conventions nextPageExtensions", () => {
  it("defaults without a next.config", () => {
    const { ctx } = discoverBench({ "pages/index.tsx": PAGE })
    expect(nextPageExtensions(ctx)).toEqual({ value: NEXT_DEFAULT_PAGE_EXTENSIONS, notices: [] })
  })

  it("defaults when next.config sets no pageExtensions", () => {
    const { ctx } = discoverBench({ "next.config.js": "module.exports = { reactStrictMode: true }\n" })
    expect(nextPageExtensions(ctx)).toEqual({ value: NEXT_DEFAULT_PAGE_EXTENSIONS, notices: [] })
  })

  it("reads a literal array through a config wrapper, keeping script extensions only", () => {
    const { ctx } = discoverBench({
      "next.config.mjs": `const config = { pageExtensions: ["page.tsx", ".page.ts", "mdx"] }
export default withSentryConfig(config, {})
`,
    })
    expect(nextPageExtensions(ctx)).toEqual({ value: ["page.tsx", "page.ts"], notices: [] })
  })

  it("falls back to the default with an info for a non-literal value", () => {
    const { ctx } = discoverBench({
      "next.config.ts": `const extensions = process.env.MDX ? ["tsx", "mdx"] : ["tsx"]
export default { pageExtensions: extensions }
`,
    })
    const read = nextPageExtensions(ctx)

    expect(read.value).toEqual(NEXT_DEFAULT_PAGE_EXTENSIONS)
    expect(read.notices).toEqual([
      expect.objectContaining({ severity: "info", code: "screens/dynamic-registry", file: "next.config.ts", line: 2 }),
    ])
  })
})

describe("adapters/next-conventions pageEntryOf", () => {
  it("follows a re-exported default to the declaring feature file", () => {
    const { ctx } = discoverBench({
      "src/pages/traces.tsx": 'export { default } from "../features/traces/TracesPage"\n',
      "src/features/traces/TracesPage.tsx": "export default function TracesPage() { return <div /> }\n",
    })
    expect(pageEntryOf(ctx, "src/pages/traces.tsx")).toEqual({
      kind: "file",
      file: "src/features/traces/TracesPage.tsx",
      exportName: "default",
    })
  })

  it("keeps the page file for a page declaring its own default", () => {
    const { ctx } = discoverBench({ "pages/index.tsx": PAGE })
    expect(pageEntryOf(ctx, "pages/index.tsx")).toEqual({ kind: "file", file: "pages/index.tsx", exportName: "default" })
  })
})

describe("adapters/next-conventions findConventionFile", () => {
  it("probes the given extensions in order", () => {
    const { ctx } = discoverBench({ "pages/_app.page.tsx": PAGE, "pages/_app.tsx": PAGE })
    expect(findConventionFile(ctx, "pages", "_app")).toBe("pages/_app.tsx")
    expect(findConventionFile(ctx, "pages", "_app", ["page.tsx"])).toBe("pages/_app.page.tsx")
    expect(findConventionFile(ctx, "pages", "_document")).toBeNull()
  })
})
