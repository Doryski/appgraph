import { describe, expect, it } from "vitest"
import { convexPath, createConvexExtractor, UNKNOWN_FUNCTION_CODE } from "../../src/extractors/convex.js"
import { createQueryExtractor } from "../../src/extractors/query.js"
import type { RunOptions } from "./harness.js"
import { ROOT, run, valuesOf } from "./harness.js"

const extractor = createConvexExtractor()

const API = "import { api, internal } from '../convex/_generated/api'"
const REACT = "import { useQuery, useMutation, useAction, usePaginatedQuery, useConvex } from 'convex/react'"

const runOn = (lines: readonly string[], options: RunOptions = {}) =>
  run([extractor], lines.join("\n"), { file: "src/Page.tsx", ...options })

const endpointsOf = (lines: readonly string[], options?: RunOptions) =>
  valuesOf(runOn(lines, options), "endpoints").map((entry) => `${entry.method} ${entry.url}`)

const SERVER = {
  [`${ROOT}/convex/schema.ts`]: "export default defineSchema({})",
  [`${ROOT}/convex/files.ts`]: [
    "import { query, mutation, action } from './_generated/server'",
    "export const list = query({ handler: async () => [] })",
    "export const generateUploadUrl = mutation({ handler: async () => '' })",
    "export const ingest = action({ handler: async () => null })",
  ].join("\n"),
  [`${ROOT}/convex/tasks/tasks.ts`]: "export const updateStep = authedMutation({ handler: async () => null })",
}

describe("convex — function reference paths", () => {
  it("maps api.module.fn to module:fn and nested directories to a slash path", () => {
    expect(convexPath({ module: "files", name: "generateUploadUrl" })).toBe("files:generateUploadUrl")
    expect(
      endpointsOf([API, "import { useMutation } from 'convex/react'", "useMutation(api.tasks.tasks.updateStep)"]),
    ).toEqual(["MUTATION tasks/tasks:updateStep"])
  })
})

describe("convex — client hooks from convex/react", () => {
  it("emits rpc endpoints with the hook's kind and the convex client", () => {
    const result = runOn([
      API,
      REACT,
      "const rows = useQuery(api.files.list, { limit: 5 })",
      "const skipped = useQuery(api.files.list, 'skip')",
      "const upload = useMutation(api.files.generateUploadUrl)",
      "const ingest = useAction(api.files.ingest)",
      "const page = usePaginatedQuery(api.messages.list, {}, { initialNumItems: 10 })",
    ])

    expect(valuesOf(result, "endpoints")).toEqual([
      { method: "QUERY", url: "files:list", transport: "rpc", client: "convex" },
      { method: "MUTATION", url: "files:generateUploadUrl", transport: "rpc", client: "convex" },
      { method: "ACTION", url: "files:ingest", transport: "rpc", client: "convex" },
      { method: "QUERY", url: "messages:list", transport: "rpc", client: "convex" },
    ])
    expect(valuesOf(result, "queryKeys")).toEqual(["files:list", "messages:list"])
    expect(valuesOf(result, "mutations")).toEqual([1, 1])
  })

  it("counts every mutation call site while deduplicating the endpoint", () => {
    const result = runOn([
      API,
      REACT,
      "const a = useMutation(api.files.generateUploadUrl)",
      "const b = useMutation(api.files.generateUploadUrl)",
    ])

    expect(valuesOf(result, "endpoints")).toHaveLength(1)
    expect(valuesOf(result, "mutations")).toEqual([1, 1])
  })

  it("reads useConvex() client methods and an inline useConvex().query", () => {
    expect(
      endpointsOf([
        API,
        REACT,
        "const convex = useConvex()",
        "await convex.mutation(api.files.generateUploadUrl, {})",
        "await convex.action(api.files.ingest)",
        "await useConvex().query(api.files.list)",
      ]),
    ).toEqual(["MUTATION files:generateUploadUrl", "ACTION files:ingest", "QUERY files:list"])
  })

  it("follows a top-level const alias of a function reference", () => {
    expect(
      endpointsOf([API, REACT, "const listFiles = api.files.list", "useQuery(listFiles)"]),
    ).toEqual(["QUERY files:list"])
  })

  it("accepts aliased hook imports, an aliased api import and a tsconfig path alias", () => {
    expect(
      endpointsOf([
        "import { api as backend } from '@convex/_generated/api'",
        "import { useMutation as useConvexWrite } from 'convex/react'",
        "useConvexWrite(backend.files.generateUploadUrl)",
      ]),
    ).toEqual(["MUTATION files:generateUploadUrl"])
  })

  it("reads convex-helpers' drop-in hooks", () => {
    expect(
      endpointsOf([API, "import { useQuery } from 'convex-helpers/react/cache'", "useQuery(api.files.list)"]),
    ).toEqual(["QUERY files:list"])
  })
})

describe("convex — TanStack Query adapter and Next.js helpers", () => {
  it("reads convexQuery / convexAction / useConvexMutation from @convex-dev/react-query", () => {
    const code = [
      API,
      "import { useQuery, useMutation } from '@tanstack/react-query'",
      "import { convexQuery, convexAction, useConvexMutation } from '@convex-dev/react-query'",
      "useQuery({ ...convexQuery(api.files.list, {}) })",
      "useQuery(convexAction(api.files.ingest, {}))",
      "useMutation({ mutationFn: useConvexMutation(api.files.generateUploadUrl) })",
    ]
    const result = run([createQueryExtractor(), extractor], code.join("\n"), { file: "src/Page.tsx" })

    expect(valuesOf(result, "endpoints").map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "QUERY files:list",
      "ACTION files:ingest",
      "MUTATION files:generateUploadUrl",
    ])
    expect(valuesOf(result, "queryKeys")).toEqual(["files:list"])
  })

  it("reads fetchQuery / preloadQuery / fetchMutation / fetchAction from convex/nextjs", () => {
    expect(
      endpointsOf([
        API,
        "import { fetchQuery, preloadQuery, fetchMutation, fetchAction } from 'convex/nextjs'",
        "await fetchQuery(api.files.list)",
        "await preloadQuery(api.messages.list)",
        "await fetchMutation(api.files.generateUploadUrl)",
        "await fetchAction(api.files.ingest)",
      ]),
    ).toEqual(["QUERY files:list", "QUERY messages:list", "MUTATION files:generateUploadUrl", "ACTION files:ingest"])
  })
})

describe("convex — binding-aware, NEGATIVE direction", () => {
  it("ignores an `api` object that does not come from the generated api module", () => {
    expect(endpointsOf(["import { api } from './lib/api'", REACT, "useQuery(api.files.list)"])).toEqual([])
  })

  it("ignores a local `api` const", () => {
    expect(endpointsOf(["const api = { files: { list: 1 } }", REACT, "useQuery(api.files.list)"])).toEqual([])
  })

  it("ignores a bare module reference with no function segment", () => {
    expect(endpointsOf([API, REACT, "useQuery(api.files)"])).toEqual([])
  })

  it("skips a reference whose kind neither the callee nor the server module names", () => {
    expect(endpointsOf([API, "import { useCached } from './hooks'", "useCached(api.files.list)"])).toEqual([])
  })

  it("does not visit a file that never mentions convex or the generated api", () => {
    expect(endpointsOf(["import { useQuery } from '@tanstack/react-query'", "useQuery(api.files.list)"])).toEqual(
      [],
    )
  })
})

describe("convex — server index cross-check", () => {
  it("takes the kind from the server builder when the callee is an unknown wrapper", () => {
    expect(
      endpointsOf(
        [
          API,
          "import { useStableQuery } from './hooks'",
          "useStableQuery(api.files.list)",
          "useStableQuery(api.tasks.tasks.updateStep)",
        ],
        { sources: SERVER },
      ),
    ).toEqual(["QUERY files:list", "MUTATION tasks/tasks:updateStep"])
  })

  it("reports an info diagnostic for a function the module does not export", () => {
    const result = runOn([API, REACT, "useQuery(api.files.list)", "useQuery(api.files.removed)"], {
      sources: SERVER,
    })
    const diagnostics = result.diagnostics.filter((entry) => entry.code === UNKNOWN_FUNCTION_CODE)

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ severity: "info", plugin: "convex", file: "src/Page.tsx", line: 4 })
    expect(diagnostics[0]?.message).toContain("files:removed")
    expect(valuesOf(result, "endpoints")).toHaveLength(2)
  })

  it("reports a module that does not exist once the convex directory is anchored", () => {
    const result = runOn([API, REACT, "useQuery(api.ghost.list)"], { sources: SERVER })
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([UNKNOWN_FUNCTION_CODE])
  })

  it("stays silent when the convex directory cannot be located", () => {
    const result = runOn([API, REACT, "useQuery(api.ghost.list)"])
    expect(result.diagnostics).toEqual([])
    expect(valuesOf(result, "endpoints")).toHaveLength(1)
  })

  it("does not guess about a module that re-exports with `export *`", () => {
    const sources = { ...SERVER, [`${ROOT}/convex/files.ts`]: "export * from './impl'" }
    const result = runOn([API, REACT, "useQuery(api.files.anything)"], { sources })
    expect(result.diagnostics).toEqual([])
  })
})
