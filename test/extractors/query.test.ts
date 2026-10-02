import { describe, expect, it } from "vitest"
import { createQueryExtractor } from "../../src/extractors/query.js"
import { ROOT, run, valuesOf } from "./harness.js"

const extractor = createQueryExtractor()

const keys = (code: string) => valuesOf(run([extractor], code), "queryKeys")
const mutations = (code: string) => valuesOf(run([extractor], code), "mutations")

describe("query — binding-aware hook detection, NEGATIVE direction", () => {
  it("ignores a local function named useQuery that is not imported", () => {
    const code = [
      "function useQuery(options) { return options }",
      "useQuery({ queryKey: ['orders'] })",
    ].join("\n")

    expect(keys(code)).toEqual([])
  })

  it("ignores a local function named useMutation", () => {
    const code = ["function useMutation() { return null }", "useMutation()"].join("\n")
    expect(mutations(code)).toEqual([])
  })

  it("ignores a same-named hook imported from an unrelated module", () => {
    const code = [
      "import { useQuery } from 'some-other-lib'",
      "useQuery({ queryKey: ['orders'] })",
    ].join("\n")

    expect(keys(code)).toEqual([])
  })
})

describe("query — POSITIVE direction: aliased imports are still found", () => {
  it("finds useQuery aliased on import", () => {
    const code = [
      "import { useQuery as useQ } from '@tanstack/react-query'",
      "useQ({ queryKey: ['orders'] })",
    ].join("\n")

    expect(keys(code)).toEqual(["orders"])
  })

  it("finds the older react-query package too", () => {
    const code = ["import { useQuery } from 'react-query'", "useQuery({ queryKey: ['orders'] })"].join("\n")
    expect(keys(code)).toEqual(["orders"])
  })

  it("counts an aliased useMutation", () => {
    const code = [
      "import { useMutation as useM } from '@tanstack/react-query'",
      "useM({ mutationFn: save })",
    ].join("\n")

    expect(mutations(code)).toEqual([1])
  })
})

describe("query — key extraction generalises beyond a plain string element", () => {
  it("strips the leading spread of a key-factory reference", () => {
    const code = [
      "import { useQuery } from '@tanstack/react-query'",
      "useQuery({ queryKey: [...invoicesQueryKeys.all, 'infinite'] })",
    ].join("\n")

    expect(keys(code)).toEqual(["invoicesQueryKeys.all"])
  })

  it("resolves a template-literal element through folded constants", () => {
    const code = [
      "import { useQuery } from '@tanstack/react-query'",
      "const id = '42'",
      "useQuery({ queryKey: [`order-${id}`] })",
    ].join("\n")

    expect(keys(code)).toEqual(["order-42"])
  })

  it("marks a long non-literal element as truncated with a trailing ellipsis", () => {
    const code = [
      "import { useQuery } from '@tanstack/react-query'",
      "useQuery({ queryKey: [{ deeply: { nested: { computed: someHelperFunctionCallThatIsVeryLong() } } }] })",
    ].join("\n")

    const [only] = keys(code)
    expect(only?.endsWith("…")).toBe(true)
    expect((only ?? "").length).toBeLessThanOrEqual(61)
  })

  it("deduplicates identical keys", () => {
    const code = [
      "import { useQuery } from '@tanstack/react-query'",
      "useQuery({ queryKey: ['orders'] })",
      "useQuery({ queryKey: ['orders'] })",
    ].join("\n")

    expect(keys(code)).toEqual(["orders"])
  })
})

describe("query — SWR", () => {
  it("finds a plain string key on useSWR", () => {
    expect(keys(["import useSWR from 'swr'", "useSWR('/api/orders', fetcher)"].join("\n"))).toEqual([
      "/api/orders",
    ])
  })

  it("finds an array key's first element on useSWR", () => {
    expect(keys(["import useSWR from 'swr'", "useSWR(['/api/orders', userId], fetcher)"].join("\n"))).toEqual([
      "/api/orders",
    ])
  })

  it("counts useSWRMutation as a mutation and still records its key", () => {
    const code = [
      "import useSWRMutation from 'swr/mutation'",
      "useSWRMutation('/api/orders', updateOrder)",
    ].join("\n")

    expect(mutations(code)).toEqual([1])
  })

  it("does not count a plain useSWR call as a mutation", () => {
    expect(mutations(["import useSWR from 'swr'", "useSWR('/api/orders', fetcher)"].join("\n"))).toEqual([])
  })

  it("skips a function key it cannot flatten, without throwing", () => {
    const code = ["import useSWR from 'swr'", "useSWR(() => (ready ? '/api/orders' : null), fetcher)"].join("\n")
    expect(keys(code)).toEqual([])
  })
})

describe("query — queryOptions and QueryClient methods", () => {
  it("reads queryOptions / infiniteQueryOptions from react-query and query-core", () => {
    const code = [
      "import { queryOptions } from '@tanstack/react-query'",
      "import { infiniteQueryOptions } from '@tanstack/query-core'",
      "export const ordersQuery = queryOptions({ queryKey: ['orders', id], queryFn })",
      "export const feedQuery = infiniteQueryOptions({ queryKey: ['feed'], queryFn })",
    ].join("\n")

    expect(keys(code)).toEqual(["orders", "feed"])
  })

  it("reads fetch/prefetch/ensure on a useQueryClient() result and on a same-file new QueryClient", () => {
    const code = [
      "import { useQueryClient, QueryClient } from '@tanstack/react-query'",
      "const client = new QueryClient()",
      "client.fetchQuery({ queryKey: ['config'], queryFn })",
      "function Row() {",
      "  const queryClient = useQueryClient()",
      "  queryClient.prefetchQuery({ queryKey: ['clients', id], queryFn })",
      "  useQueryClient().ensureQueryData({ queryKey: ['plans'], queryFn })",
      "}",
    ].join("\n")

    expect(keys(code)).toEqual(["config", "clients", "plans"])
  })

  it("ignores the same methods on a receiver it cannot prove is a QueryClient", () => {
    const code = [
      "import { QueryClient } from 'some-cache'",
      "const client = new QueryClient()",
      "client.fetchQuery({ queryKey: ['x'] })",
      "context.queryClient.ensureQueryData({ queryKey: ['y'] })",
      "cache.prefetchQuery({ queryKey: ['z'] })",
    ].join("\n")

    expect(keys(code)).toEqual([])
  })

  it("does not read options passed by reference or spread", () => {
    const code = [
      "import { useQueryClient } from '@tanstack/react-query'",
      "const queryClient = useQueryClient()",
      "queryClient.prefetchQuery(ordersQuery)",
      "queryClient.fetchQuery({ ...ordersQuery, staleTime: 0 })",
    ].join("\n")

    expect(keys(code)).toEqual([])
  })

  const CLIENT_FILE = `${ROOT}/src/shared/queryClient.ts`
  const withClient = (client: string, code: string) =>
    valuesOf(
      run([createQueryExtractor()], code, {
        file: "src/services/api/orders/hooks.ts",
        resolveModule: (specifier) => (specifier === "@/shared/queryClient" ? CLIENT_FILE : null),
        sources: { [CLIENT_FILE]: client },
      }),
      "queryKeys",
    )

  it("reads an imported project queryClient once its declaration resolves to new QueryClient", () => {
    expect(
      withClient(
        "import { QueryClient } from '@tanstack/react-query'\nexport const queryClient = new QueryClient({ defaultOptions })",
        "import { queryClient } from '@/shared/queryClient'\nqueryClient.prefetchQuery({ queryKey: ['orders'], queryFn })",
      ),
    ).toEqual(["orders"])
  })

  it("ignores an imported receiver declared as something else", () => {
    expect(
      withClient(
        "export const queryClient = createCache()",
        "import { queryClient } from '@/shared/queryClient'\nqueryClient.prefetchQuery({ queryKey: ['orders'] })",
      ),
    ).toEqual([])
  })
})

describe("query — a whole queryKey that is a key-factory member", () => {
  it("records the factory reference without its arguments", () => {
    const code = [
      "import { useQuery, useQueryClient } from '@tanstack/react-query'",
      "useQuery({ queryKey: ordersKeys.detail(orderId), queryFn })",
      "const queryClient = useQueryClient()",
      "queryClient.prefetchQuery({ queryKey: mailboxKeys.all, queryFn })",
    ].join("\n")

    expect(keys(code)).toEqual(["ordersKeys.detail", "mailboxKeys.all"])
  })

  it("does not record a bare identifier key", () => {
    expect(keys("import { useQuery } from '@tanstack/react-query'\nuseQuery({ queryKey: key, queryFn })")).toEqual([])
  })
})

describe("query — @tanstack/vue-query", () => {
  it("reads the queryKey of a vue-query useQuery", () => {
    const code = ["import { useQuery } from '@tanstack/vue-query'", "useQuery({ queryKey: ['orders'] })"].join("\n")
    expect(keys(code)).toEqual(["orders"])
  })
})

describe("query — react-query v3 positional keys (C15)", () => {
  it("reads a bare string key", () => {
    expect(keys(["import { useQuery } from 'react-query'", "useQuery('todos', fetchTodos)"].join("\n"))).toEqual([
      "todos",
    ])
  })

  it("reads the first element of a positional array key", () => {
    expect(
      keys(["import { useQuery } from 'react-query'", "useQuery(['todo', id], () => fetchTodo(id))"].join("\n")),
    ).toEqual(["todo"])
  })

  it("still prefers the object form's queryKey", () => {
    expect(
      keys(["import { useQuery } from '@tanstack/react-query'", "useQuery({ queryKey: ['orders'], queryFn })"].join("\n")),
    ).toEqual(["orders"])
  })
})
