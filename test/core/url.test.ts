import { describe, expect, it } from "vitest"
import {
  convertAdminJsUrl,
  convertAngularPath,
  convertExpoRoutePath,
  convertFlatRouteName,
  convertNextAppPath,
  convertNextPagesFile,
  convertNextPagesPath,
  convertNextRedirectPath,
  convertPathToRegexpPath,
  convertReactRouterPath,
  convertTanStackCodePath,
  convertTanStackRoutePath,
  convertVueFileRoutePath,
  convertVueRouterPath,
  convertWouterPath,
  createRouteMatcher,
  expandAdminJsTemplate,
  expoHrefToUrl,
  isRequiredNextCatchAll,
  joinUrl,
  normalizeUrl,
  paramsOf,
  patternToRegex,
  splitFlatRouteName,
} from "../../src/core/url.js"
import { adminjsCases } from "../fixtures/route-dialects/adminjs.js"
import { adversarialCases } from "../fixtures/route-dialects/adversarial.js"
import { expoHrefCases, expoRouteCases } from "../fixtures/route-dialects/expo-router.js"
import { nextjsCases } from "../fixtures/route-dialects/nextjs.js"
import { reactRouterCases } from "../fixtures/route-dialects/react-router.js"
import { tanstackRouterCases } from "../fixtures/route-dialects/tanstack-router.js"

describe("normalizeUrl", () => {
  it("strips query and hash, collapses repeated slashes, drops a trailing slash", () => {
    expect(normalizeUrl("/orders?tab=open")).toBe("/orders")
    expect(normalizeUrl("/orders#section")).toBe("/orders")
    expect(normalizeUrl("/orders//1")).toBe("/orders/1")
    expect(normalizeUrl("/orders/")).toBe("/orders")
  })

  it("keeps the root '/' as-is rather than collapsing it to empty", () => {
    expect(normalizeUrl("/")).toBe("/")
  })

  it("does not lowercase and does not decode", () => {
    expect(normalizeUrl("/Orders/%2Fid")).toBe("/Orders/%2Fid")
  })

  it("keeps an optional-param marker and everything after it", () => {
    expect(normalizeUrl("users/:id?/edit")).toBe("users/:id?/edit")
    expect(normalizeUrl("/users/:id?")).toBe("/users/:id?")
    expect(normalizeUrl("/users/:id?/edit#tab")).toBe("/users/:id?/edit")
  })

  it("still strips a query that follows a param segment", () => {
    expect(normalizeUrl("/users/:id?tab=open")).toBe("/users/:id")
    expect(normalizeUrl("/users/:id?/edit?tab=open")).toBe("/users/:id?/edit")
  })
})

describe("joinUrl", () => {
  it("keeps the path after an optional segment (react-router `:id?`)", () => {
    expect(joinUrl("/users", ":id?/edit")).toBe("/users/:id?/edit")
  })

  it("returns the parent unchanged when the child contributes no own path (index route)", () => {
    expect(joinUrl("/dashboard", null)).toBe("/dashboard")
  })

  it("an absolute child path wins outright, regardless of parent (pathless layout route)", () => {
    expect(joinUrl(null, "/settings")).toBe("/settings")
    expect(joinUrl("/anything", "/settings")).toBe("/settings")
  })

  it("joins a relative child under its parent and normalizes the result", () => {
    expect(joinUrl("/orders", "edit")).toBe("/orders/edit")
    expect(joinUrl(null, "orders")).toBe("/orders")
  })
})

describe("paramsOf", () => {
  it("extracts every :param token", () => {
    expect(paramsOf("/orders/:orderId/lines/:lineId")).toEqual(["orderId", "lineId"])
    expect(paramsOf("/orders")).toEqual([])
  })

  it("names an optional param without its marker", () => {
    expect(paramsOf("/users/:id?/edit")).toEqual(["id"])
  })

  it("does not treat a bare '*' as a named param", () => {
    expect(paramsOf("/docs/*")).toEqual([])
  })
})

describe("patternToRegex", () => {
  it("turns :param into a single-segment wildcard and * into a multi-segment wildcard", () => {
    expect(patternToRegex("/orders/:id").test("/orders/42")).toBe(true)
    expect(patternToRegex("/orders/:id").test("/orders/42/lines")).toBe(false)
    expect(patternToRegex("/docs/*").test("/docs/a/b/c")).toBe(true)
    expect(patternToRegex("/docs/*").test("/docsx")).toBe(false)
  })

  it("matches a param embedded in a segment and keeps the literal around it", () => {
    expect(patternToRegex("/users-:group/:id").test("/users-admins/7")).toBe(true)
    expect(patternToRegex("/users-:group/:id").test("/members-admins/7")).toBe(false)
    expect(patternToRegex("/a.b-:id").test("/aXb-1")).toBe(false)
  })

  it("lets a catch-all match its base path unless it is marked required", () => {
    expect(patternToRegex("/docs/*").test("/docs")).toBe(true)
    expect(patternToRegex("/docs/*", { catchAllOptional: true }).test("/docs")).toBe(true)
    expect(patternToRegex("/docs/*", { catchAllOptional: false }).test("/docs")).toBe(false)
    expect(patternToRegex("/docs/*", { catchAllOptional: false }).test("/docs/a/b")).toBe(true)
  })

  it("matches an optional `:param?` segment present or absent", () => {
    expect(patternToRegex("/users/:id?/edit").test("/users/42/edit")).toBe(true)
    expect(patternToRegex("/users/:id?/edit").test("/users/edit")).toBe(true)
    expect(patternToRegex("/users/:id?/edit").test("/users/42/43/edit")).toBe(false)
  })

  it("escapes literal regex-special characters in static segments", () => {
    expect(patternToRegex("/files/v1.2").test("/files/v1x2")).toBe(false)
    expect(patternToRegex("/files/v1.2").test("/files/v1.2")).toBe(true)
  })
})

describe("createRouteMatcher — exact, static, dynamic and catch-all tiers", () => {
  it("matches an exact URL before consulting any pattern", () => {
    const match = createRouteMatcher([{ url: "/orders/:id" }, { url: "/orders/new" }])
    expect(match("/orders/new")).toBe("/orders/new")
  })

  it("prefers a static route over a dynamic one that would also match", () => {
    const match = createRouteMatcher([{ url: "/orders/:id" }, { url: "/orders/new" }])
    expect(match("/orders/new-but-not-exact")).toBe("/orders/:id")
  })

  it("substitutes the :param placeholder in the probe before testing", () => {
    const match = createRouteMatcher([{ url: "/orders/:id" }])
    expect(match("/orders/:param")).toBe("/orders/:id")
  })

  it("orders static before single-param dynamic before catch-all", () => {
    const match = createRouteMatcher([{ url: "/docs/*" }, { url: "/docs/:id" }, { url: "/docs/intro" }])
    expect(match("/docs/intro")).toBe("/docs/intro")
    expect(match("/docs/guide")).toBe("/docs/:id")
    expect(match("/docs/guide/nested")).toBe("/docs/*")
  })

  it("excludes a bare top-level '/*' catch-all from the candidate set entirely", () => {
    const match = createRouteMatcher([{ url: "/*" }, { url: "/orders" }])
    expect(match("/orders")).toBe("/orders")
    expect(match("/anything-else")).toBeNull()
    expect(match("/*")).toBeNull()
  })

  it("returns null when nothing matches", () => {
    const match = createRouteMatcher([{ url: "/orders" }])
    expect(match("/invoices")).toBeNull()
  })

  it("resolves a catch-all's base path to it, except for a required catch-all", () => {
    const match = createRouteMatcher([
      { url: "/app-store/*" },
      { url: "/shop/*", catchAllOptional: true },
      { url: "/docs/*", catchAllOptional: false },
    ])
    expect(match("/app-store")).toBe("/app-store/*")
    expect(match("/shop")).toBe("/shop/*")
    expect(match("/docs")).toBeNull()
    expect(match("/docs/intro")).toBe("/docs/*")
  })
})

describe("Next.js App Router conversion — driven from the fixture table", () => {
  it.each(nextjsCases)("$description", (testCase) => {
    expect(convertNextAppPath(testCase.input).url).toBe(testCase.expected)
  })

  it("reports [...slug] as a required catch-all param", () => {
    const result = convertNextAppPath("src/app/docs/[...slug]/page.tsx")
    expect(result.extras.params).toEqual([{ name: "slug", catchAll: true, optional: false }])
  })

  it("recognises only a Next [...slug] entry whose conversion is the screen's template as a required catch-all", () => {
    expect(isRequiredNextCatchAll("/docs/*", "src/app/docs/[...slug]/page.tsx")).toBe(true)
    expect(isRequiredNextCatchAll("/shop/*", "src/app/shop/[[...slug]]/page.tsx")).toBe(false)
    expect(isRequiredNextCatchAll("/other/*", "src/app/docs/[...slug]/page.tsx")).toBe(false)
    expect(isRequiredNextCatchAll("/app-store/*", "src/pages/AppStore.tsx")).toBe(false)
  })

  it("reports [[...slug]] as an optional catch-all param", () => {
    const result = convertNextAppPath("src/app/shop/[[...slug]]/page.tsx")
    expect(result.extras.params).toEqual([{ name: "slug", catchAll: true, optional: true }])
  })

  it("reports a plain [id] as a required, non-catch-all param", () => {
    const result = convertNextAppPath("src/app/users/[id]/page.tsx")
    expect(result.extras.params).toEqual([{ name: "id", catchAll: false, optional: false }])
  })

  it("reports a private `_folder` as opting its subtree out of routing", () => {
    const result = convertNextAppPath("src/app/dashboard/_components/widgets/page.tsx")
    expect(result.extras.privateFolders).toEqual(["_components"])
    expect(convertNextAppPath("src/app/users/[id]/page.tsx").extras.privateFolders).toEqual([])
  })

  it("reads `%5Ffolder` as a real segment starting with an underscore", () => {
    const result = convertNextAppPath("src/app/%5Finternal/page.tsx")
    expect(result.url).toBe("/_internal")
    expect(result.extras.privateFolders).toEqual([])
  })

  it("reports every (group) segment as dropped rather than silently discarding it", () => {
    const result = convertNextAppPath("src/app/(app)/(authenticated)/dashboard/page.tsx")
    expect(result.extras.droppedGroups).toEqual(["app", "authenticated"])
  })
})

describe("TanStack Router conversion — driven from the fixture table", () => {
  it.each(tanstackRouterCases)("$description", (testCase) => {
    expect(convertTanStackRoutePath(testCase.input).url).toBe(testCase.expected)
  })

  it("reports $param as a named, non-catch-all param", () => {
    const result = convertTanStackRoutePath("src/routes/users.$userId.tsx")
    expect(result.extras.params).toEqual([{ name: "userId", catchAll: false, optional: false }])
  })

  it("reports a bare $ as an unnamed, optional catch-all param (it also matches its base path)", () => {
    const result = convertTanStackRoutePath("src/routes/files.$.tsx")
    expect(result.extras.params).toEqual([{ name: "", catchAll: true, optional: true }])
  })

  it("reports every leading-underscore segment as a pathless layer, not a dropped group", () => {
    const result = convertTanStackRoutePath("src/routes/_authed.orders.$orderId.edit.tsx")
    expect(result.extras.pathlessLayers).toEqual(["_authed"])
    expect(result.extras.droppedGroups).toEqual([])
  })

  it("reports a (group) directory as dropped, contributing no segment", () => {
    const result = convertTanStackRoutePath("src/routes/(marketing)/about.tsx")
    expect(result.url).toBe("/about")
    expect(result.extras.droppedGroups).toEqual(["marketing"])
  })

  it("keeps an optional {-$lang} param as `:lang?` and records it optional", () => {
    const result = convertTanStackRoutePath("src/routes/{-$lang}/about.tsx")
    expect(result.url).toBe("/:lang?/about")
    expect(result.extras.params).toEqual([{ name: "lang", catchAll: false, optional: true }])
  })

  it("does not read the reserved `route` / `lazy` tail as a URL segment", () => {
    expect(convertTanStackRoutePath("src/routes/posts/route.tsx").url).toBe("/posts")
    expect(convertTanStackRoutePath("src/routes/posts/route.lazy.tsx").url).toBe("/posts")
    expect(convertTanStackRoutePath("src/routes/posts.lazy.tsx").url).toBe("/posts")
  })

  it("strips a configured routes directory as an exact project-relative prefix", () => {
    const result = convertTanStackRoutePath("src/pages/users.$id.tsx", "src/pages")
    expect(result.url).toBe("/users/:id")
    expect(result.extras.params).toEqual([{ name: "id", catchAll: false, optional: false }])
  })

  it("keeps a `routes` directory below a configured routes directory as a URL segment", () => {
    expect(convertTanStackRoutePath("app/pages/routes/list.tsx", "app/pages").url).toBe("/routes/list")
  })
})

describe("TanStack Router code-route path conversion", () => {
  it("converts $param, bare $ and {-$param} the same way the file convention does", () => {
    expect(convertTanStackCodePath("/projects/$projectId").url).toBe("/projects/:projectId")
    expect(convertTanStackCodePath("files/$").url).toBe("/files/*")
    expect(convertTanStackCodePath("{-$lang}/about").url).toBe("/:lang?/about")
  })

  it("reads '/' and '' as the parent's own URL", () => {
    expect(convertTanStackCodePath("/").url).toBe("/")
    expect(convertTanStackCodePath("").url).toBe("/")
  })
})

describe("react-router conversion — driven from the fixture table", () => {
  it("converts every parseable native-path row of the fixture table", () => {
    for (const testCase of reactRouterCases.filter((entry) => entry.input.startsWith("/"))) {
      expect(convertReactRouterPath(testCase.input).url).toBe(testCase.expected)
    }
  })

  it("keeps the optional '?' marker in the URL and records optionality in extras", () => {
    const result = convertReactRouterPath("/users/:id?")
    expect(result.url).toBe("/users/:id?")
    expect(result.extras.params).toEqual([{ name: "id", catchAll: false, optional: true }])
  })

  it("records a splat as an optional catch-all (it also matches its base path)", () => {
    const result = convertReactRouterPath("/app-store/*")
    expect(result.url).toBe("/app-store/*")
    expect(result.extras.params).toEqual([{ name: "", catchAll: true, optional: true }])
  })

  it("keeps every segment after an optional one", () => {
    const result = convertReactRouterPath("users/:id?/edit")
    expect(result.url).toBe("users/:id?/edit")
    expect(result.extras.params).toEqual([{ name: "id", catchAll: false, optional: true }])
  })

  // The remaining two fixture rows describe join-time behaviour (index routes, pathless layout
  // routes) rather than a parseable native path string — driven through joinUrl instead, which is
  // the mechanism that implements them.
  it("an index route inherits the parent path with no own segment", () => {
    expect(joinUrl("/dashboard", null)).toBe("/dashboard")
  })

  it("a pathless layout route contributes no segment to its children", () => {
    expect(joinUrl(null, "/settings")).toBe("/settings")
  })
})

describe("AdminJS template expansion — driven from the fixture table", () => {
  it.each(adminjsCases)("$description", (testCase) => {
    expect(
      convertAdminJsUrl({
        templateKind: testCase.templateKind,
        rootPath: testCase.rootPath,
        substitution: testCase.substitution,
      }).url,
    ).toBe(testCase.expected)
  })

  it("expands an arbitrary template against a value map, per the spec's own wording", () => {
    expect(expandAdminJsTemplate("${rootPath}resources/${id}", { rootPath: "/admin/", id: "users" }).url).toBe(
      "/admin/resources/users",
    )
  })
})

describe("adversarial cases — must not be mistaken for a different dialect's syntax", () => {
  it.each(adversarialCases)("$description", (testCase) => {
    expect(convertReactRouterPath(testCase.input).url).toBe(testCase.expected)
    expect(normalizeUrl(testCase.input)).toBe(testCase.expected)
  })
})

describe("convertNextRedirectPath", () => {
  it.each([
    { source: "/org/:slug", url: "/org/:slug", catchAllOptional: true, params: [{ name: "slug", catchAll: false, optional: false }] },
    { source: "/org/:slug?", url: "/org/:slug?", catchAllOptional: true, params: [{ name: "slug", catchAll: false, optional: true }] },
    { source: "/docs/:path*", url: "/docs/*", catchAllOptional: true, params: [{ name: "path", catchAll: true, optional: true }] },
    { source: "/docs/:path+", url: "/docs/*", catchAllOptional: false, params: [{ name: "path", catchAll: true, optional: false }] },
    { source: "/feed.xml/", url: "/feed.xml", catchAllOptional: true, params: [] },
    { source: "/", url: "/", catchAllOptional: true, params: [] },
  ])("$source → $url", ({ source, url, catchAllOptional, params }) => {
    const converted = convertNextRedirectPath(source)
    expect(converted?.url).toBe(url)
    expect(converted?.catchAllOptional).toBe(catchAllOptional)
    expect(converted?.extras.params).toEqual(params)
  })

  it.each(["/post/:slug(\\d+)", "/(.*)", "/:path((?!api).*)", "/blog{-:slug}?", "/blog-:slug", "docs/:path", "/a/*"])(
    "refuses %s",
    (source) => {
      expect(convertNextRedirectPath(source)).toBeNull()
    },
  )
})

const catchAll = (name: string, optional: boolean) => ({ name, catchAll: true, optional })
const plain = (name: string, optional = false) => ({ name, catchAll: false, optional })

const vueRouterCases = [
  ["/", "/", []],
  ["/users/:id", "/users/:id", [plain("id")]],
  ["/users/:id?", "/users/:id?", [plain("id", true)]],
  ["/users/:id(\\d+)", "/users/:id", [plain("id")]],
  ["/users/:id(\\d+)?/edit", "/users/:id?/edit", [plain("id", true)]],
  ["/files/:id(a/b)", "/files/:id", [plain("id")]],
  ["/docs/:id+", "/docs/*", [catchAll("id", false)]],
  ["/docs/:id*", "/docs/*", [catchAll("id", true)]],
  ["/docs/:path(.*)", "/docs/*", [catchAll("path", true)]],
  ["/:pathMatch(.*)*", "/*", [catchAll("pathMatch", true)]],
  ["/lists:pathMatch(.*)*", "/lists/*", [catchAll("pathMatch", true)]],
  ["/foo-:id", "/foo-:id", [plain("id")]],
  ["/static/path", "/static/path", []],
] as const

describe("Vue Router path conversion", () => {
  it.each(vueRouterCases)("%s -> %s", (raw, url, params) => {
    const result = convertVueRouterPath(raw)
    expect(result.url).toBe(url)
    expect(result.extras.params).toEqual(params)
  })
})

const vueFileCases = [
  ["index.vue", "/", [], []],
  ["about.vue", "/about", [], []],
  ["users/index.vue", "/users", [], []],
  ["users/[id].vue", "/users/:id", [plain("id")], []],
  ["users/[[id]].vue", "/users/:id?", [plain("id", true)], []],
  ["[...slug].vue", "/*", [catchAll("slug", true)], []],
  ["docs/[...slug].vue", "/docs/*", [catchAll("slug", true)], []],
  ["(marketing)/about.vue", "/about", [], ["marketing"]],
  ["users-[group]/[id].vue", "/users-:group/:id", [plain("group"), plain("id")], []],
  ["[id]-edit.vue", "/:id-edit", [plain("id")], []],
  ["users.create.vue", "/users.create", [], []],
] as const

describe("Nuxt pages conversion", () => {
  it.each(vueFileCases)("%s -> %s", (file, url, params, groups) => {
    const result = convertVueFileRoutePath(file, { dialect: "nuxt" })
    expect(result.url).toBe(url)
    expect(result.extras.params).toEqual(params)
    expect(result.extras.droppedGroups).toEqual(groups)
  })
})

const unpluginFileCases = [
  ["index.vue", "/", []],
  ["users.create.vue", "/users/create", []],
  ["users.[id].vue", "/users/:id", [plain("id")]],
  ["users/[[id]].vue", "/users/:id?", [plain("id", true)]],
  ["tags/[slugs]+.vue", "/tags/*", [catchAll("slugs", false)]],
  ["tags/[[slugs]]+.vue", "/tags/*", [catchAll("slugs", true)]],
  ["[...path].vue", "/*", [catchAll("path", true)]],
  ["(admin)/dashboard.vue", "/dashboard", []],
  ["a.b/index.vue", "/a.b", []],
] as const

describe("unplugin-vue-router file conversion", () => {
  it.each(unpluginFileCases)("%s -> %s", (file, url, params) => {
    const result = convertVueFileRoutePath(file, { dialect: "unplugin" })
    expect(result.url).toBe(url)
    expect(result.extras.params).toEqual(params)
  })
})

describe("convertAngularPath", () => {
  it.each([
    ["", ""],
    ["users", "users"],
    ["users/:id", "users/:id"],
    ["**", "*"],
    ["p/**", "p/*"],
    ["a//b/", "a/b"],
  ])("%j → %j", (raw, url) => {
    expect(convertAngularPath(raw).url).toBe(url)
  })

  it("records params and the catch-all", () => {
    expect(convertAngularPath("videos/:uuid/**").extras.params).toEqual([
      { name: "uuid", catchAll: false, optional: false },
      { name: "", catchAll: true, optional: true },
    ])
  })

  it("joins under a parent", () => {
    expect(joinUrl("/admin", convertAngularPath("users/:id").url)).toBe("/admin/users/:id")
    expect(joinUrl("/admin", convertAngularPath("").url)).toBe("/admin")
  })
})

const nextPagesCases = [
  ["org/_/[[...routeSlug]]", "/org/_/*", [catchAll("routeSlug", true)]],
  ["api/v1/[id]", "/api/v1/:id", [plain("id")]],
  ["index", "/", []],
  ["blog/index", "/blog", []],
  ["index/index", "/index", []],
  ["(group)/x", "/(group)/x", []],
  ["_app", "/_app", []],
  ["docs/[...slug]", "/docs/*", [catchAll("slug", false)]],
] as const

describe("Next.js Pages Router conversion", () => {
  it.each(nextPagesCases)("%s -> %s", (rel, url, params) => {
    const result = convertNextPagesPath(rel)
    expect(result.url).toBe(url)
    expect(result.extras.params).toEqual(params)
    expect(result.extras.droppedGroups).toEqual([])
    expect(result.extras.privateFolders).toEqual([])
  })

  it.each([
    ["pages/about.tsx", undefined, "/about"],
    ["src/pages/blog/index.jsx", undefined, "/blog"],
    ["pages/about.page.tsx", ["page.tsx"], "/about"],
    ["pages/about.page.tsx", ["tsx", ".page.tsx"], "/about"],
    ["pages/about.tsx", ["page.tsx"], null],
    ["app/about/page.tsx", undefined, null],
    ["lib/pages/about.tsx", undefined, null],
    ["pages/styles.css", undefined, null],
  ] as const)("file %s (%j) -> %s", (file, extensions, url) => {
    expect(convertNextPagesFile(file, extensions)?.url ?? null).toBe(url)
  })

  it("recognises a Pages [...slug] as a required catch-all and [[...slug]] as optional", () => {
    expect(isRequiredNextCatchAll("/docs/*", "pages/docs/[...slug].tsx")).toBe(true)
    expect(isRequiredNextCatchAll("/docs/*", "src/pages/docs/[...slug].tsx")).toBe(true)
    expect(isRequiredNextCatchAll("/docs/*", "pages/docs/[[...slug]].tsx")).toBe(false)
  })

  it("keeps the App Router private-folder rule out of Pages", () => {
    expect(convertNextAppPath("app/org/_/[[...routeSlug]]/page.tsx").url).toBe("/org/*")
    expect(convertNextPagesFile("pages/org/_/[[...routeSlug]].tsx")?.url).toBe("/org/_/*")
  })
})

const flatRouteCases = [
  { name: "o.$orgUrl.settings._layout", url: "/o/:orgUrl/settings", params: [plain("orgUrl")], pathless: ["_layout"], index: false, breaks: [], statics: [] },
  { name: "[_].$", url: "/_/*", params: [catchAll("", true)], pathless: [], index: false, breaks: [], statics: [] },
  { name: "($lang)._index", url: "/:lang?", params: [plain("lang", true)], pathless: [], index: true, breaks: [], statics: [] },
  { name: "concerts_.mine", url: "/concerts/mine", params: [], pathless: [], index: false, breaks: [0], statics: [] },
  { name: "sitemap[.]xml", url: "/sitemap.xml", params: [], pathless: [], index: false, breaks: [], statics: [] },
  { name: "_auth.login", url: "/login", params: [], pathless: ["_auth"], index: false, breaks: [], statics: [] },
  { name: "$", url: "/*", params: [catchAll("", true)], pathless: [], index: false, breaks: [], statics: [] },
  { name: "_index", url: "/", params: [], pathless: [], index: true, breaks: [], statics: [] },
  { name: "[$]price", url: "/$price", params: [], pathless: [], index: false, breaks: [], statics: [] },
  { name: "users.$id_.edit", url: "/users/:id/edit", params: [plain("id")], pathless: [], index: false, breaks: [1], statics: [] },
  { name: "(en).about", url: "/about", params: [], pathless: [], index: false, breaks: [], statics: ["en"] },
] as const

describe("React Router / Remix flat route conversion", () => {
  it.each(flatRouteCases)("$name -> $url", ({ name, url, params, pathless, index, breaks, statics }) => {
    const result = convertFlatRouteName(name)
    expect(result.url).toBe(url)
    expect(result.extras.params).toEqual(params)
    expect(result.extras.pathlessLayers).toEqual(pathless)
    expect(result.extras.optionalStatics).toEqual(statics)
    expect(result.index).toBe(index)
    expect(result.nestingBreaks).toEqual(breaks)
  })

  it("splits a flat name on unescaped dots only, keeping the escapes", () => {
    expect(splitFlatRouteName("sitemap[.]xml")).toEqual(["sitemap[.]xml"])
    expect(splitFlatRouteName("o.$orgUrl.settings._layout")).toEqual(["o", "$orgUrl", "settings", "_layout"])
    expect(splitFlatRouteName("[_].$")).toEqual(["[_]", "$"])
  })
})

describe("wouter path conversion", () => {
  it.each([
    { raw: "/orders/*?", url: "/orders/*", catchAllOptional: true, params: [catchAll("", true)] },
    { raw: "/orders/*", url: "/orders/*", catchAllOptional: false, params: [catchAll("", false)] },
    { raw: "/u/:id?", url: "/u/:id?", catchAllOptional: true, params: [plain("id", true)] },
    { raw: "/u/:id/", url: "/u/:id", catchAllOptional: true, params: [plain("id")] },
    { raw: "/about?tab=1", url: "/about", catchAllOptional: true, params: [] },
  ])("$raw -> $url", ({ raw, url, catchAllOptional, params }) => {
    const result = convertWouterPath(raw)
    expect(result.url).toBe(url)
    expect(result.catchAllOptional).toBe(catchAllOptional)
    expect(result.extras.params).toEqual(params)
  })
})

describe("path-to-regexp neutral export", () => {
  it("is the Vue Router converter under a neutral name", () => {
    expect(convertPathToRegexpPath).toBe(convertVueRouterPath)
    expect(convertPathToRegexpPath("/users/:id(\\d+)?").url).toBe("/users/:id?")
  })
})

describe("Expo Router conversion — driven from the fixture table", () => {
  it.each(expoRouteCases)("$description: $input", ({ input, platforms, expected }) => {
    expect(convertExpoRoutePath(input, { platforms })).toEqual(expected)
  })

  it.each(expoHrefCases)("expoHrefToUrl $description: $input", ({ input, expected }) => {
    expect(expoHrefToUrl(input)).toEqual(expected)
  })
})
