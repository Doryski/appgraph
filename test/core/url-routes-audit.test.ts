import { describe, expect, it } from "vitest"
import {
  convertNextAppPath,
  convertTanStackCodePath,
  convertTanStackRoutePath,
  createRouteMatcher,
  normalizeUrl,
  paramsOf,
  patternToRegex,
} from "../../src/core/url.js"

describe("C5 — a route segment literally named `app` is not the Next app root", () => {
  it.each([
    ["app/app/settings/page.tsx", "/app/settings"],
    ["src/app/app/dashboard/page.tsx", "/app/dashboard"],
    ["app/(marketing)/app/page.tsx", "/app"],
    ["apps/web/app/app/page.tsx", "/app"],
    ["app/page.tsx", "/"],
  ])("%s → %s", (file, url) => {
    expect(convertNextAppPath(file).url).toBe(url)
  })
})

describe("the default TanStack routes directory is the outermost `routes` folder", () => {
  it.each([
    ["src/routes/admin/routes/index.tsx", "/admin/routes"],
    ["src/routes/docs/routes/list.tsx", "/docs/routes/list"],
    ["apps/web/src/routes/posts.tsx", "/posts"],
  ])("%s → %s", (file, url) => {
    expect(convertTanStackRoutePath(file).url).toBe(url)
  })

  it("a configured routes directory is used as the prefix", () => {
    expect(convertTanStackRoutePath("src/pages/posts.$id.tsx", "src/pages").url).toBe("/posts/:id")
  })
})

describe("A6 — hyphenated params and optional static segments survive normalization", () => {
  it("keeps the path after a hyphenated optional param", () => {
    expect(normalizeUrl("/users/:user-id?/edit")).toBe("/users/:user-id?/edit")
  })

  it("names a hyphenated whole-segment param in full", () => {
    expect(paramsOf("/users/:user-id?/edit")).toEqual(["user-id"])
    expect(paramsOf("/users/:user-id")).toEqual(["user-id"])
  })

  it("keeps an embedded param name to word characters", () => {
    expect(paramsOf("/files/foo-:id-bar")).toEqual(["id"])
  })

  it("keeps an optional static segment", () => {
    expect(normalizeUrl("/en?/contact")).toBe("/en?/contact")
    expect(normalizeUrl("en?/contact")).toBe("en?/contact")
  })

  it("still strips a real query string", () => {
    expect(normalizeUrl("/search?q=1")).toBe("/search")
    expect(normalizeUrl("/users/:id?tab=1")).toBe("/users/:id")
  })

  it("matches an optional static segment with and without it", () => {
    const regex = patternToRegex("/en?/contact")
    expect(regex.test("/en/contact")).toBe(true)
    expect(regex.test("/contact")).toBe(true)
    expect(regex.test("/de/contact")).toBe(false)
  })

  it("resolves a target through an optional static segment", () => {
    const match = createRouteMatcher([{ url: "/en?/contact" }])
    expect(match("/contact")).toBe("/en?/contact")
  })
})

describe("TanStack braced params with a prefix or suffix", () => {
  it("embeds a prefixed braced param from a filename", () => {
    const result = convertTanStackRoutePath("src/routes/user/file-{$id}.tsx")
    expect(result.url).toBe("/user/file-:id")
    expect(result.extras.params).toEqual([{ name: "id", catchAll: false, optional: false }])
  })

  it("converts a literal braced param inside a segment", () => {
    const result = convertTanStackCodePath("/posts/post-{$postId}")
    expect(result.url).toBe("/posts/post-:postId")
    expect(result.extras.params).toEqual([{ name: "postId", catchAll: false, optional: false }])
  })

  it("converts a whole-segment braced param", () => {
    expect(convertTanStackRoutePath("src/routes/user.{$id}.tsx").url).toBe("/user/:id")
  })

  it("marks an embedded optional braced param optional", () => {
    const result = convertTanStackCodePath("/posts/post-{-$postId}")
    expect(result.url).toBe("/posts/post-:postId")
    expect(result.extras.params).toEqual([{ name: "postId", catchAll: false, optional: true }])
  })

  it("reads a braced splat as a catch-all", () => {
    expect(convertTanStackCodePath("/files/{$}").url).toBe("/files/*")
  })

  it("a prefixed param segment matches a concrete URL", () => {
    expect(patternToRegex("/posts/post-:postId").test("/posts/post-42")).toBe(true)
  })
})

describe("C16 — equal-tier matching prefers earlier static segments", () => {
  it("matches /blog/about to /blog/:slug, whatever the input order", () => {
    expect(createRouteMatcher([{ url: "/:lang/about" }, { url: "/blog/:slug" }])("/blog/about")).toBe("/blog/:slug")
    expect(createRouteMatcher([{ url: "/blog/:slug" }, { url: "/:lang/about" }])("/blog/about")).toBe("/blog/:slug")
  })

  it("prefers more static segments", () => {
    const routes = [{ url: "/:a/:b/c" }, { url: "/x/:b/:c" }, { url: "/x/y/:c" }]
    expect(createRouteMatcher(routes)("/x/y/c")).toBe("/x/y/:c")
  })

  it("breaks a full tie deterministically by URL", () => {
    const forward = createRouteMatcher([{ url: "/:b/x" }, { url: "/:a/x" }])
    const backward = createRouteMatcher([{ url: "/:a/x" }, { url: "/:b/x" }])
    expect(forward("/q/x")).toBe("/:a/x")
    expect(backward("/q/x")).toBe("/:a/x")
  })
})
