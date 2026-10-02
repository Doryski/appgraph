import { describe, expect, it } from "vitest"
import { resolveAppName } from "../../src/core/app-name.js"

describe("resolveAppName", () => {
  it("prefers the manifest name, scope included", () => {
    expect(resolveAppName({ manifest: '{"name":"@acme/frontend"}', rootLabel: "frontend" })).toBe(
      "@acme/frontend",
    )
  })

  it("falls back to the root label when there is no manifest", () => {
    expect(resolveAppName({ manifest: null, rootLabel: "admin" })).toBe("admin")
  })

  it("falls back to the root label on malformed JSON instead of throwing", () => {
    expect(resolveAppName({ manifest: "{ not json", rootLabel: "admin" })).toBe("admin")
  })

  it("falls back on a manifest with no name, a non-string name, or a blank name", () => {
    expect(resolveAppName({ manifest: "{}", rootLabel: "repo" })).toBe("repo")
    expect(resolveAppName({ manifest: '{"name":42}', rootLabel: "repo" })).toBe("repo")
    expect(resolveAppName({ manifest: '{"name":"   "}', rootLabel: "repo" })).toBe("repo")
    expect(resolveAppName({ manifest: "null", rootLabel: "repo" })).toBe("repo")
    expect(resolveAppName({ manifest: '"a string manifest"', rootLabel: "repo" })).toBe("repo")
  })

  it("trims a padded manifest name", () => {
    expect(resolveAppName({ manifest: '{"name":"  frontend  "}', rootLabel: "repo" })).toBe("frontend")
  })

  it("is null only when neither a name nor a root label exists", () => {
    expect(resolveAppName({ manifest: "{}", rootLabel: "" })).toBeNull()
    expect(resolveAppName({ manifest: null, rootLabel: "  " })).toBeNull()
  })
})
