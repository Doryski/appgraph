import { describe, expect, it } from "vitest"
import { ANGULAR_HTTP_PACKAGE, HTTP_CLIENT_PACKAGES, createHttpClientExtractor } from "../../src/extractors/http-client.js"
import { LIBRARY_SIGNALS } from "../../src/detect/conventions.js"
import type { Endpoint } from "../../src/core/model.js"
import { ROOT, run, valuesOf } from "./harness.js"

const endpoints = (code: string, extractor = createHttpClientExtractor()): readonly Endpoint[] =>
  valuesOf(run([extractor], code), "endpoints")

describe("http-client — no phantom endpoints from look-alike method calls", () => {
  it("emits nothing for someMap.get('/x')", () => {
    expect(endpoints(["const someMap = new Map()", "someMap.get('/x')"].join("\n"))).toEqual([])
  })

  it("emits nothing for params.delete('/y') on URLSearchParams", () => {
    expect(endpoints(["const params = new URLSearchParams()", "params.delete('/y')"].join("\n"))).toEqual([])
  })

  it("emits nothing for a cache-like local or an entirely unbound receiver", () => {
    expect(endpoints(["const cache = createCache()", "cache.get('/z')"].join("\n"))).toEqual([])
    expect(endpoints("unknownThing.get('/z')")).toEqual([])
  })

  it("emits nothing when a local shadows a client module name", () => {
    expect(endpoints(["const axios = { get: () => null }", "axios.get('/orders')"].join("\n"))).toEqual([])
  })

  it("emits nothing when a local shadows global fetch", () => {
    expect(endpoints(["const fetch = (url) => url", "fetch('/orders')"].join("\n"))).toEqual([])
  })
})

/**
 * The shape most real projects have: the client is `axios.create()` in a project-local module,
 * imported by name, so no call-site root binds to `axios`. Recognising a binding whose module is the
 * project's own api-client module requires proving the factory chain across the file boundary.
 */
describe("http-client — a project-local client created by a client factory", () => {
  const CLIENT_FILE = `${ROOT}/src/services/api/client.ts`

  const localModules = (specifier: string): string | null =>
    specifier === "../client" || specifier === "@/services/api/client" ? CLIENT_FILE : null

  const withClient = (source: string, code: string): readonly Endpoint[] =>
    valuesOf(
      run([createHttpClientExtractor()], code, {
        file: "src/services/api/invoices/fetchers.ts",
        resolveModule: localModules,
        sources: { [CLIENT_FILE]: source },
      }),
      "endpoints",
    )

  it("emits for a named export assigned axios.create()", () => {
    expect(
      withClient(
        "import axios from 'axios'\nexport const apiClient = axios.create({ baseURL: '/api' })",
        "import { apiClient } from '../client'\nexport const f = () => apiClient.get('/invoices')",
      ),
    ).toEqual([
      { method: "GET", url: "/invoices", transport: "http", client: "../client" },
    ])
  })

  it("emits when the declaration is separate from the `export { … }` statement", () => {
    expect(
      withClient(
        "import axios from 'axios'\nconst apiClient = axios.create()\nexport { apiClient }",
        "import { apiClient } from '@/services/api/client'\napiClient.patch(`/invoices/${id}/documents`)",
      ),
    ).toEqual([
      { method: "PATCH", url: "/invoices/:param/documents", transport: "http", client: "@/services/api/client" },
    ])
  })

  it("does NOT promote a local module export that is not built by a client factory", () => {
    expect(
      withClient(
        "export const apiClient = new Map<string, string>()",
        "import { apiClient } from '../client'\napiClient.get('/invoices')",
      ),
    ).toEqual([])
  })

  it("does NOT promote a local module export the resolver cannot read", () => {
    expect(
      valuesOf(
        run([createHttpClientExtractor()], "import { apiClient } from '../client'\napiClient.get('/invoices')", {
          file: "src/services/api/invoices/fetchers.ts",
          resolveModule: localModules,
        }),
        "endpoints",
      ),
    ).toEqual([])
  })
})

describe("http-client — POSITIVE direction: a proven client always yields an endpoint", () => {
  it("emits for axios.get('/api/orders')", () => {
    expect(endpoints(["import axios from 'axios'", "axios.get('/api/orders')"].join("\n"))).toEqual([
      { method: "GET", url: "/api/orders", transport: "http", client: "axios" },
    ])
  })

  it("emits for a call-result binding: const client = axios.create()", () => {
    expect(
      endpoints(
        ["import axios from 'axios'", "const client = axios.create()", "client.post('/orders')"].join("\n"),
      ),
    ).toEqual([{ method: "POST", url: "/orders", transport: "http", client: "axios" }])
  })

  it("emits for an aliased project-local api client supplied by config", () => {
    const extractor = createHttpClientExtractor({ wrappers: [/^@\/services\//] })
    const code = ["import { apiClient as api } from '@/services/api'", "api.patch('/orders/1')"].join("\n")

    expect(endpoints(code)).toEqual([])
    expect(endpoints(code, extractor)).toEqual([
      { method: "PATCH", url: "/orders/1", transport: "http", client: "@/services/api" },
    ])
  })

  it("emits for ky and got out of the box", () => {
    expect(endpoints(["import ky from 'ky'", "ky.get('/a')"].join("\n"))[0]?.client).toBe("ky")
    expect(endpoints(["import got from 'got'", "got.put('/b')"].join("\n"))[0]?.client).toBe("got")
  })

  it("emits for a bare global fetch, reading the method out of the options object", () => {
    expect(endpoints("fetch('/api/orders', { method: 'post' })")).toEqual([
      { method: "POST", url: "/api/orders", transport: "http", client: "fetch" },
    ])
    expect(endpoints("fetch('/api/orders')")[0]?.method).toBe("GET")
  })

  it("walks a deep receiver chain to its leftmost identifier", () => {
    expect(
      endpoints(["import axios from 'axios'", "axios.instances[0].withAuth().get('/orders')"].join("\n")),
    ).toEqual([{ method: "GET", url: "/orders", transport: "http", client: "axios" }])
  })

  it("sees through a wrapped receiver — `as`, `satisfies`, parentheses", () => {
    expect(
      endpoints(["import axios from 'axios'", "(axios as unknown as Client).get('/orders')"].join("\n")),
    ).toHaveLength(1)
  })

  it("resolves a url built from a constant declared below the call", () => {
    expect(
      endpoints(["import axios from 'axios'", "axios.get(ORDERS)", "const ORDERS = '/api/orders'"].join("\n")),
    ).toEqual([{ method: "GET", url: "/api/orders", transport: "http", client: "axios" }])
  })

  it("keeps :param for a dynamic template segment", () => {
    expect(
      endpoints(["import axios from 'axios'", "axios.get(`/api/orders/${id}`)"].join("\n"))[0]?.url,
    ).toBe("/api/orders/:param")
  })

  it("rejects a first argument that is not a url-shaped string", () => {
    expect(endpoints(["import axios from 'axios'", "axios.get('not a url')"].join("\n"))).toEqual([])
    expect(endpoints(["import axios from 'axios'", "axios.get(someObject)"].join("\n"))).toEqual([])
  })

  it("accepts an absolute http url, which the receiver gate makes safe", () => {
    expect(endpoints(["import axios from 'axios'", "axios.get('https://api.example.com/v1')"].join("\n"))).toEqual(
      [{ method: "GET", url: "https://api.example.com/v1", transport: "http", client: "axios" }],
    )
  })

  it("deduplicates identical method+url+client pairs", () => {
    expect(
      endpoints(["import axios from 'axios'", "axios.get('/a')", "axios.get('/a')"].join("\n")),
    ).toHaveLength(1)
  })

  it("marks every endpoint transport:'http'", () => {
    const all = endpoints(
      ["import axios from 'axios'", "axios.get('/a')", "fetch('/b')"].join("\n"),
    )
    expect(all.every((endpoint) => endpoint.transport === "http")).toBe(true)
  })

  it("can be switched off entirely through the clients option", () => {
    const extractor = createHttpClientExtractor({ clients: [], allowGlobalFetch: false })
    expect(endpoints(["import axios from 'axios'", "axios.get('/a')"].join("\n"), extractor)).toEqual([])
  })
})

describe("http-client — superagent, undici, node-fetch", () => {
  it("reads superagent method calls on a default import under any local name", () => {
    expect(endpoints("import request from 'superagent'\nrequest.get('/api/orders')")).toEqual([
      { method: "GET", url: "/api/orders", transport: "http", client: "superagent" },
    ])
    expect(endpoints("import superagent from 'superagent'\nsuperagent.post('/api/orders').send(body)")).toEqual([
      { method: "POST", url: "/api/orders", transport: "http", client: "superagent" },
    ])
  })

  it("reads undici request and fetch, taking the method from the options", () => {
    const code = [
      "import { request, fetch } from 'undici'",
      "await request('https://api.example.com/users', { method: 'PUT' })",
      "await fetch('/api/health')",
    ].join("\n")

    expect(endpoints(code)).toEqual([
      { method: "PUT", url: "https://api.example.com/users", transport: "http", client: "undici" },
      { method: "GET", url: "/api/health", transport: "http", client: "undici" },
    ])
  })

  it("reads node-fetch's default export", () => {
    expect(endpoints("import fetch from 'node-fetch'\nfetch('/api/x', { method: 'DELETE' })")).toEqual([
      { method: "DELETE", url: "/api/x", transport: "http", client: "node-fetch" },
    ])
  })

  it("does not read a same-named request from an unrelated module", () => {
    expect(endpoints("import { request } from './graphql'\nrequest('/graphql')")).toEqual([])
  })
})

describe("http-client — one package list for detection and extraction", () => {
  it("detects exactly the packages the extractor reads, plus Angular's HttpClient package", () => {
    const http = LIBRARY_SIGNALS.find((signal) => signal.group === "http")
    expect(http?.packages).toEqual([...HTTP_CLIENT_PACKAGES, ANGULAR_HTTP_PACKAGE])
    expect(HTTP_CLIENT_PACKAGES).not.toContain(ANGULAR_HTTP_PACKAGE)
    expect(HTTP_CLIENT_PACKAGES).toContain("node-fetch")
  })
})

describe("http-client — Nuxt auto-imported $fetch / useFetch / useLazyFetch", () => {
  it("emits a POST endpoint for $fetch with a literal method", () => {
    expect(endpoints("$fetch('/api/orders', { method: 'post' })")).toEqual([
      { method: "POST", url: "/api/orders", transport: "http", client: "$fetch" },
    ])
  })

  it("defaults useFetch and useLazyFetch to GET", () => {
    expect(endpoints("useFetch('/api/a')\nuseLazyFetch('/api/b')")).toEqual([
      { method: "GET", url: "/api/a", transport: "http", client: "useFetch" },
      { method: "GET", url: "/api/b", transport: "http", client: "useLazyFetch" },
    ])
  })

  it("ignores a local function named useFetch", () => {
    expect(endpoints("function useFetch(url) { return url }\nuseFetch('/api/a')")).toEqual([])
  })

  it("emits no endpoint for a getter URL", () => {
    expect(endpoints("useFetch(() => `/api/${id}`)")).toEqual([])
  })
})

describe("http-client — SWR keys are the URL the fetcher GETs", () => {
  it("emits a GET endpoint for useSWR and useSWRImmutable string keys", () => {
    expect(
      endpoints(
        [
          "import useSWR from 'swr'",
          "import useSWRImmutable from 'swr/immutable'",
          "useSWR('/api/a', fetcher)",
          "useSWRImmutable(`/api/b/${id}`, fetcher)",
        ].join("\n"),
      ),
    ).toEqual([
      { method: "GET", url: "/api/a", transport: "http", client: "swr" },
      { method: "GET", url: "/api/b/:param", transport: "http", client: "swr" },
    ])
  })

  it("reads the key behind a `cond &&` guard and drops a query string glued onto the path", () => {
    expect(endpoints("import useSWR from 'swr'\nuseSWR(workspaceId && `/api/domains${qs}`, fetcher)")).toEqual([
      { method: "GET", url: "/api/domains", transport: "http", client: "swr" },
    ])
  })

  it("keeps a placeholder that is its own path segment", () => {
    expect(endpoints("import useSWR from 'swr'\nuseSWR(`/api/links/${id}`, fetcher)")).toEqual([
      { method: "GET", url: "/api/links/:param", transport: "http", client: "swr" },
    ])
  })

  it("ignores a function key, a non-url key and a local useSWR", () => {
    expect(endpoints("import useSWR from 'swr'\nuseSWR(() => '/api/a', fetcher)\nuseSWR(['user', id], fetcher)")).toEqual([])
    expect(endpoints("function useSWR(key) { return key }\nuseSWR('/api/a')")).toEqual([])
  })
})

describe("http-client — scope-aware URL constants (C6)", () => {
  it("keeps each function's own `const url` instead of the first one declared in the file", () => {
    const code = [
      "import axios from 'axios'",
      "function loadOrders() { const url = '/api/orders'; return axios.get(url) }",
      "function deleteUser() { const url = '/api/users'; return axios.delete(url) }",
    ].join("\n")

    expect(endpoints(code).map((endpoint) => `${endpoint.method} ${endpoint.url}`)).toEqual([
      "GET /api/orders",
      "DELETE /api/users",
    ])
  })
})

describe("http-client — a URL behind an interpolated base (C10)", () => {
  it("keeps fetch(`${API}/items`) with the base as a :param placeholder", () => {
    const code = ["const API = process.env.API", "fetch(`${API}/items`)"].join("\n")
    expect(endpoints(code)).toEqual([{ method: "GET", url: ":param/items", transport: "http", client: "fetch" }])
  })

  it("keeps axios.get(`${BASE}/x`) once the receiver is proven a client", () => {
    const code = ["import axios from 'axios'", "axios.get(`${config.base}/x`)"].join("\n")
    expect(endpoints(code)).toEqual([{ method: "GET", url: ":param/x", transport: "http", client: "axios" }])
  })

  it("still drops the same template on a receiver that is not a client", () => {
    expect(endpoints(["const cache = new Map()", "cache.get(`${API}/items`)"].join("\n"))).toEqual([])
  })

  it("does not accept an interpolation glued to a path without a slash", () => {
    expect(endpoints("fetch(`${API}items`)")).toEqual([])
  })
})

describe("http-client — Angular HttpClient reached through `this` (G16)", () => {
  const service = (members: string, body: string): string =>
    [
      "import { Injectable, inject } from '@angular/core'",
      "import { HttpClient } from '@angular/common/http'",
      "const API = '/api'",
      "@Injectable()",
      `export class DataService { ${members} load(id: string) { ${body} } }`,
    ].join("\n")

  it("emits for a constructor-injected client", () => {
    expect(endpoints(service("constructor(private http: HttpClient) {}", "return this.http.get('/api/x')"))).toEqual([
      { method: "GET", url: "/api/x", transport: "http", client: "@angular/common/http" },
    ])
  })

  it("emits a POST for an inject(HttpClient) field", () => {
    expect(endpoints(service("private readonly http = inject(HttpClient);", "return this.http.post('/api/items', {})"))).toEqual([
      { method: "POST", url: "/api/items", transport: "http", client: "@angular/common/http" },
    ])
  })

  it("takes the method of request() from its string-literal first argument", () => {
    expect(endpoints(service("constructor(private http: HttpClient) {}", "return this.http.request('PATCH', `/api/items/${id}`)"))).toEqual([
      { method: "PATCH", url: "/api/items/:param", transport: "http", client: "@angular/common/http" },
    ])
  })

  it("resolves a template-literal URL with a constant base", () => {
    expect(endpoints(service("constructor(private http: HttpClient) {}", "return this.http.delete(`${API}/users/${id}`)"))).toEqual([
      { method: "DELETE", url: "/api/users/:param", transport: "http", client: "@angular/common/http" },
    ])
  })

  it("emits nothing for a `this.http` typed as a local class", () => {
    const code = [
      "class LocalHttp { get(url: string) { return url } }",
      "export class DataService { constructor(private http: LocalHttp) {} load() { return this.http.get('/api/x') } }",
    ].join("\n")
    expect(endpoints(code)).toEqual([])
  })
})

describe("http-client — Angular URLs held in class statics and locals (GR8)", () => {
  const service = (members: string, body: string): string =>
    [
      "import { HttpClient } from '@angular/common/http'",
      "import { environment } from '../environments/environment'",
      `export class DataService { ${members} constructor(private http: HttpClient) {} load(id: string, flag: boolean) { ${body} } }`,
    ].join("\n")

  const urls = (code: string): readonly string[] => endpoints(code).map((endpoint) => `${endpoint.method} ${endpoint.url}`)

  it("keeps a static base field's literal path behind its unknown prefix", () => {
    const code = service(
      "static BASE_USER_URL = environment.apiUrl + '/api/v1/users/me/blocklist'; static BASE_SERVER_URL = environment.apiUrl + '/api/v1/server/blocklist';",
      "this.http.get(DataService.BASE_USER_URL + '/accounts'); return this.http.get(DataService.BASE_SERVER_URL + '/accounts')",
    )
    expect(urls(code)).toEqual(["GET :param/api/v1/users/me/blocklist/accounts", "GET :param/api/v1/server/blocklist/accounts"])
  })

  it("resolves a local const URL", () => {
    expect(urls(service("", "const url = `/api/user/${id}`; return this.http.delete(url)"))).toEqual(["DELETE /api/user/:param"])
  })

  it("keeps the path of a let whose later appends only add a query string", () => {
    const body = "let url = `/api/userInfos/all?page=${id}`; if (flag) { url += `&includeCustomers=true` } return this.http.get(url)"
    expect(urls(service("", body))).toEqual(["GET /api/userInfos/all?page=:param"])
  })

  it("marks the tail unknown with :param when a later append may change the path", () => {
    const body = "let url = '/api/plugins/telemetry'; if (flag) { url += `/${id}` } return this.http.post(url, {})"
    expect(urls(service("", body))).toEqual(["POST /api/plugins/telemetry:param"])
  })

  it("emits every branch's value when the let is reassigned in a branch", () => {
    const body = "let url; if (flag) { url = `/api/devices/count/${id}/a` } else { url = `/api/devices/count/${id}` } return this.http.get(url)"
    expect(urls(service("", body))).toEqual(["GET /api/devices/count/:param/a", "GET /api/devices/count/:param"])
  })

  it("keeps the path when a self-referencing reassignment only adds a query string", () => {
    const body = "let url = '/api/agent/profile'; if (flag) { url = id ? `${url}?ids=${id}` : url + '?ids=' } return this.http.post(url, {})"
    expect(urls(service("", body))).toEqual(["POST /api/agent/profile"])
  })

  it("never reports the initializer alone when a reassignment reads the variable itself", () => {
    const body = "let url = '/api/a'; url = normalize(url); return this.http.get(url)"
    expect(urls(service("", body))).toEqual(["GET /api/a:param"])
  })

  it("does not take a same-named local from another function or a shadowing parameter", () => {
    const code = service(
      "other() { const url = '/api/other'; return url }",
      "return [this.http.get(url), ((url: string) => this.http.get(url))('/x')]",
    )
    expect(urls(code)).toEqual([])
  })
})
