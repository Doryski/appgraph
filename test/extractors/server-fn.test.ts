import { describe, expect, it } from "vitest"
import { createServerFnExtractor, routeHandlerUrl } from "../../src/extractors/server-fn.js"
import type { Endpoint } from "../../src/core/model.js"
import { run, valuesOf } from "./harness.js"

const extractor = createServerFnExtractor()

const endpoints = (code: string, file?: string): readonly Endpoint[] =>
  valuesOf(run([extractor], code, file === undefined ? {} : { file }), "endpoints")

describe("server-fn — createServerFn (@tanstack/react-start)", () => {
  it("emits an rpc endpoint named after the exported binding", () => {
    const code = [
      "import { createServerFn } from '@tanstack/react-start'",
      "export const listOrders = createServerFn({ method: 'GET' }).handler(async () => [])",
    ].join("\n")

    expect(endpoints(code, "src/server/orders.ts")).toEqual([
      { method: "GET", url: "src/server/orders.ts#listOrders", transport: "rpc", client: null },
    ])
  })

  it("reads the method option and defaults to GET", () => {
    const code = [
      "import { createServerFn } from '@tanstack/react-start'",
      "export const createOrder = createServerFn({ method: 'POST' }).handler(async () => null)",
      "export const readOrder = createServerFn().handler(async () => null)",
    ].join("\n")

    expect(endpoints(code, "src/server/orders.ts").map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "POST src/server/orders.ts#createOrder",
      "GET src/server/orders.ts#readOrder",
    ])
  })

  it("ignores a same-named local factory that does not come from the start package", () => {
    const code = [
      "const createServerFn = () => ({ handler: (fn) => fn })",
      "export const listOrders = createServerFn().handler(async () => [])",
    ].join("\n")

    expect(endpoints(code, "src/server/orders.ts")).toEqual([])
  })

  it("accepts an aliased import of createServerFn", () => {
    const code = [
      "import { createServerFn as serverFn } from '@tanstack/react-start'",
      "export const listOrders = serverFn().handler(async () => [])",
    ].join("\n")

    expect(endpoints(code, "src/server/orders.ts")).toHaveLength(1)
  })
})

describe('server-fn — "use server"', () => {
  it("treats every exported function of a `use server` module as an action", () => {
    const code = [
      "'use server'",
      "export async function createOrder(form) { return null }",
      "export const deleteOrder = async (id) => null",
      "const helper = () => null",
    ].join("\n")

    expect(endpoints(code, "src/actions/orders.ts").map((entry) => entry.url)).toEqual([
      "src/actions/orders.ts#createOrder",
      "src/actions/orders.ts#deleteOrder",
    ])
  })

  it("treats a function-level directive as an action", () => {
    const code = [
      "export const Form = () => {",
      "  const save = async (data) => {",
      "    'use server'",
      "    return null",
      "  }",
      "  return save",
      "}",
    ].join("\n")

    expect(endpoints(code, "src/Form.tsx")).toEqual([
      { method: "POST", url: "src/Form.tsx#save", transport: "rpc", client: null },
    ])
  })

  it("does not fire on a file that merely mentions the phrase", () => {
    expect(endpoints("const label = 'use server to continue'", "src/label.ts")).toEqual([])
  })
})

describe("server-fn — Next route handlers", () => {
  it("emits one http endpoint per exported HTTP verb, with the app-router path", () => {
    const code = [
      "export async function GET(request) { return Response.json([]) }",
      "export const POST = async (request) => Response.json({})",
      "export const dynamic = 'force-dynamic'",
    ].join("\n")

    expect(endpoints(code, "src/app/api/orders/route.ts")).toEqual([
      { method: "GET", url: "/api/orders", transport: "http", client: null },
      { method: "POST", url: "/api/orders", transport: "http", client: null },
    ])
  })

  // A route handler is reachable by a plain browser HTTP request — unlike `createServerFn` and
  // `"use server"`, which are genuinely not. Only the client is unknown (null), never the transport.
  it("is http, not rpc — unlike a createServerFn action defined in the same file", () => {
    const code = [
      "import { createServerFn } from '@tanstack/react-start'",
      "export async function GET(request) { return Response.json([]) }",
      "export const listOrders = createServerFn({ method: 'POST' }).handler(async () => [])",
    ].join("\n")

    const all = endpoints(code, "src/app/api/orders/route.ts")
    const route = all.find((entry) => entry.url === "/api/orders")
    const rpc = all.find((entry) => entry.url !== "/api/orders")

    expect(route).toMatchObject({ method: "GET", transport: "http", client: null })
    expect(rpc).toMatchObject({ method: "POST", transport: "rpc", client: null })
  })

  it("derives dynamic segments, catch-alls, route groups and parallel slots", () => {
    expect(routeHandlerUrl("src/app/api/orders/[id]/route.ts")).toBe("/api/orders/:id")
    expect(routeHandlerUrl("src/app/api/docs/[...slug]/route.ts")).toBe("/api/docs/*")
    expect(routeHandlerUrl("src/app/api/docs/[[...slug]]/route.ts")).toBe("/api/docs/*")
    expect(routeHandlerUrl("app/(marketing)/api/leads/route.ts")).toBe("/api/leads")
    expect(routeHandlerUrl("src/app/@modal/api/x/route.ts")).toBe("/api/x")
    expect(routeHandlerUrl("src/server/route.ts")).toBeNull()
  })

  it("falls back to file#VERB when the file is not under an app segment", () => {
    expect(endpoints("export async function GET() {}", "src/server/route.ts")).toEqual([
      { method: "GET", url: "src/server/route.ts#GET", transport: "http", client: null },
    ])
  })

  it("ignores verb-named exports in a file that is not a route file", () => {
    expect(endpoints("export async function GET() {}", "src/lib/http.ts")).toEqual([])
  })
})

describe("server-fn — rpc is distinguishable and call sites are never falsely linked", () => {
  it("marks every endpoint transport:'rpc' with a null client", () => {
    const code = [
      "import { createServerFn } from '@tanstack/react-start'",
      "export const listOrders = createServerFn().handler(async () => [])",
    ].join("\n")

    const all = endpoints(code, "src/server/orders.ts")
    expect(all.every((entry) => entry.transport === "rpc" && entry.client === null)).toBe(true)
  })

  it("emits the definition plus an info diagnostic instead of linking a client call site", () => {
    const code = [
      "import { createServerFn } from '@tanstack/react-start'",
      "export const listOrders = createServerFn().handler(async () => [])",
      "const rows = await listOrders()",
    ].join("\n")

    const result = run([extractor], code, { file: "src/server/orders.ts" })
    const diagnostic = result.diagnostics.find((entry) => entry.code === "facts/needs-typechecker")

    expect(valuesOf(result, "endpoints")).toHaveLength(1)
    expect(diagnostic).toMatchObject({ severity: "info", plugin: "server-fn", file: "src/server/orders.ts" })
    expect(diagnostic?.message).toContain("cross-file type flow")
  })

  it("says nothing about a file that defines no rpc endpoint", () => {
    const result = run([extractor], "export const x = 1", { file: "src/plain.ts" })
    expect(result.diagnostics).toEqual([])
  })
})

describe("server-fn — needs-typechecker diagnostic counts only rpc endpoints", () => {
  const diagnosticsOf = (code: string, file: string) =>
    run([extractor], code, { file }).diagnostics.filter((entry) => entry.code === "facts/needs-typechecker")

  it.each([
    ["a function declaration handler", ["export async function GET(request) { return Response.json([]) }"], ["GET"]],
    ["an arrow function handler", ["export const POST = async () => Response.json({})"], ["POST"]],
    [
      "multiple verbs",
      [
        "export async function GET() { return Response.json([]) }",
        "export const POST = async () => Response.json({})",
        "export async function DELETE() { return new Response(null) }",
      ],
      ["GET", "POST", "DELETE"],
    ],
    [
      "handlers beside a non-verb export",
      ["export async function GET() { return Response.json([]) }", "export const dynamic = 'force-dynamic'"],
      ["GET"],
    ],
  ])("emits http endpoints and no diagnostic for a route file with %s", (_name, lines, methods) => {
    const code = lines.join("\n")
    const file = "src/app/api/orders/route.ts"
    const all = endpoints(code, file)

    expect(all.map((entry) => entry.method)).toEqual(methods)
    expect(all.every((entry) => entry.transport === "http")).toBe(true)
    expect(diagnosticsOf(code, file)).toEqual([])
  })

  it("counts only the rpc endpoint in a route file that also has an http handler", () => {
    const code = [
      "export async function GET() { return Response.json([]) }",
      "export const Form = () => {",
      "  const save = async (data) => {",
      "    'use server'",
      "    return null",
      "  }",
      "  return save",
      "}",
    ].join("\n")
    const found = diagnosticsOf(code, "src/app/api/orders/route.ts")

    expect(found).toHaveLength(1)
    expect(found[0]?.message.startsWith("1 rpc endpoint(s)")).toBe(true)
  })

  it.each([
    [
      "a use server module with two actions",
      [
        "'use server'",
        "export async function createOrder(form) { return null }",
        "export const deleteOrder = async (id) => null",
      ],
      "src/actions/orders.ts",
      "2 rpc endpoint(s)",
    ],
    [
      "a createServerFn file",
      [
        "import { createServerFn } from '@tanstack/react-start'",
        "export const listOrders = createServerFn().handler(async () => [])",
      ],
      "src/server/orders.ts",
      "1 rpc endpoint(s)",
    ],
  ])("still diagnoses %s", (_name, lines, file, prefix) => {
    const found = diagnosticsOf(lines.join("\n"), file)

    expect(found).toHaveLength(1)
    expect(found[0]?.message.startsWith(prefix)).toBe(true)
  })
})
