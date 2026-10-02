import { describe, expect, it } from "vitest"
import { authOf, resolveVueAuthRules } from "../../src/adapters/vue-auth.js"

const rules = resolveVueAuthRules({})
const verdict = (middleware: readonly string[], flags: Readonly<Record<string, boolean>> = {}) =>
  authOf({ middleware, flags }, rules)

describe("resolveVueAuthRules", () => {
  it("returns the sorted defaults without config", () => {
    expect(rules).toEqual({
      protectedMiddleware: ["admin", "auth", "authenticated", "moderator", "permission"],
      publicMiddleware: ["guest"],
      authMetaKeys: ["auth", "requireAuth", "requiresAuth"],
    })
  })

  it("unions config with defaults, deduplicated and sorted", () => {
    const merged = resolveVueAuthRules({
      vueAuth: { protectedMiddleware: ["staff", "auth"], publicMiddleware: ["anon"], authMetaKeys: ["needsLogin"] },
    })
    expect(merged.protectedMiddleware).toEqual(["admin", "auth", "authenticated", "moderator", "permission", "staff"])
    expect(merged.publicMiddleware).toEqual(["anon", "guest"])
    expect(merged.authMetaKeys).toEqual(["auth", "needsLogin", "requireAuth", "requiresAuth"])
  })
})

describe("authOf", () => {
  it("is null without signals", () => {
    expect(verdict([])).toBeNull()
    expect(verdict(["logger"], { unrelated: true })).toBeNull()
  })

  it("protects on a protected middleware", () => {
    expect(verdict(["auth"])).toBe("protected")
    expect(verdict(["logger", "admin"])).toBe("protected")
  })

  it("is public on a public middleware", () => {
    expect(verdict(["guest"])).toBe("public")
  })

  it("reads meta flags", () => {
    expect(verdict([], { requiresAuth: true })).toBe("protected")
    expect(verdict([], { requireAuth: false })).toBe("public")
    expect(verdict([], { auth: true })).toBe("protected")
  })

  it("is null when signals contradict", () => {
    expect(verdict(["auth", "guest"])).toBeNull()
    expect(verdict(["guest"], { requiresAuth: true })).toBeNull()
    expect(verdict(["auth"], { requiresAuth: false })).toBeNull()
    expect(verdict([], { requiresAuth: true, auth: false })).toBeNull()
  })

  it("honours configured names", () => {
    const custom = resolveVueAuthRules({ vueAuth: { protectedMiddleware: ["staff"], authMetaKeys: ["needsLogin"] } })
    expect(authOf({ middleware: ["staff"], flags: {} }, custom)).toBe("protected")
    expect(authOf({ middleware: [], flags: { needsLogin: true } }, custom)).toBe("protected")
    expect(authOf({ middleware: [], flags: { needsLogin: true } }, rules)).toBeNull()
  })
})
