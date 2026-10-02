import { describe, expect, it } from "vitest"
import {
  type AngularGuardInput,
  type AngularRouteAuthInput,
  angularAuthOf,
  resolveAngularAuthRules,
} from "../../src/adapters/angular/auth.js"

const rules = resolveAngularAuthRules({})

const guard = (
  name: string | null,
  kind: AngularGuardInput["kind"] = "canActivate",
  trivial = false,
): AngularGuardInput => ({ kind, name, trivial })

const route = (guards: readonly AngularGuardInput[] = [], data: AngularRouteAuthInput["data"] = {}) => ({
  guards,
  data,
})

describe("resolveAngularAuthRules", () => {
  it("returns the sorted defaults without config", () => {
    expect(rules).toEqual({
      protectedGuards: [
        "AuthGuard",
        "AuthenticatedGuard",
        "AuthenticationGuard",
        "LoginGuard",
        "authGuard",
        "isAuthenticatedGuard",
        "loginGuard",
      ],
      publicGuards: ["AnonymousGuard", "GuestGuard", "NoAuthGuard", "UnloggedGuard", "guestGuard", "noAuthGuard"],
      authDataKeys: ["auth", "authorities", "permissions", "roles"],
      publicData: [
        { key: "isPublic", value: true },
        { key: "module", value: "public" },
        { key: "public", value: true },
      ],
      redirectDataKeys: ["redirectTo"],
    })
  })

  it("unions config with defaults, deduplicated and sorted", () => {
    const merged = resolveAngularAuthRules({
      angular: {
        protectedGuards: ["UserRightGuard", "AuthGuard"],
        publicGuards: ["OpenGuard"],
        authDataKeys: ["scope"],
        publicData: [
          { key: "anon", value: "yes" },
          { key: "public", value: true },
        ],
        redirectDataKeys: ["to"],
      },
    })
    expect(merged.protectedGuards).toContain("UserRightGuard")
    expect(merged.protectedGuards.filter((name) => name === "AuthGuard")).toHaveLength(1)
    expect(merged.publicGuards).toContain("OpenGuard")
    expect(merged.authDataKeys).toEqual(["auth", "authorities", "permissions", "roles", "scope"])
    expect(merged.publicData).toEqual([
      { key: "anon", value: "yes" },
      { key: "isPublic", value: true },
      { key: "module", value: "public" },
      { key: "public", value: true },
    ])
    expect(merged.redirectDataKeys).toEqual(["redirectTo", "to"])
  })
})

describe("angularAuthOf", () => {
  it("thingsboard /login: public data beats the AuthGuard on the route", () => {
    const verdict = angularAuthOf([route([guard("AuthGuard")], { module: "public" })], rules)
    expect(verdict).toEqual({ auth: "public", evidence: ["data.module=public"] })
  })

  it("thingsboard home: AuthGuard on the parent protects a child with data.auth", () => {
    const parent = route([guard("AuthGuard"), guard("AuthGuard", "canActivateChild")])
    const child = route([], { auth: ["TENANT_ADMIN"] })
    expect(angularAuthOf([parent, child], rules)).toEqual({ auth: "protected", evidence: ["AuthGuard"] })
  })

  it("public data on an ancestor makes the route public", () => {
    const verdict = angularAuthOf([route([], { public: true }), route([guard("AuthGuard")])], rules)
    expect(verdict.auth).toBe("public")
  })

  it("PeerTube MetaGuard, trivial only, is public", () => {
    expect(angularAuthOf([route([guard("MetaGuard", "canActivate", true)])], rules)).toEqual({
      auth: "public",
      evidence: [],
    })
  })

  it("a lone UserRightGuard is null, and protected once configured", () => {
    const chain = [route([guard("UserRightGuard")])]
    expect(angularAuthOf(chain, rules)).toEqual({ auth: null, evidence: [] })
    const configured = resolveAngularAuthRules({ angular: { protectedGuards: ["UserRightGuard"] } })
    expect(angularAuthOf(chain, configured)).toEqual({ auth: "protected", evidence: ["UserRightGuard"] })
  })

  it("UnloggedGuard is public", () => {
    expect(angularAuthOf([route([guard("UnloggedGuard")])], rules)).toEqual({
      auth: "public",
      evidence: ["UnloggedGuard"],
    })
  })

  it("a protected guard wins over a public guard", () => {
    expect(angularAuthOf([route([guard("GuestGuard"), guard("AuthGuard")])], rules).auth).toBe("protected")
  })

  it("an auth data key with an unknown non-trivial guard is protected", () => {
    const verdict = angularAuthOf([route([guard("UserRightGuard")], { roles: ["admin"] })], rules)
    expect(verdict).toEqual({ auth: "protected", evidence: ["data.roles"] })
  })

  it("an auth data key without any guard stays public", () => {
    expect(angularAuthOf([route([], { auth: ["x"] })], rules).auth).toBe("public")
  })

  it("canActivateChild on the route itself is ignored", () => {
    expect(angularAuthOf([route([guard("AuthGuard", "canActivateChild")])], rules).auth).toBe("public")
  })

  it("canActivateChild on an ancestor applies", () => {
    const chain = [route([guard("AuthGuard", "canActivateChild")]), route()]
    expect(angularAuthOf(chain, rules).auth).toBe("protected")
  })

  it("canMatch and canLoad apply on the route", () => {
    expect(angularAuthOf([route([guard("AuthGuard", "canMatch")])], rules).auth).toBe("protected")
    expect(angularAuthOf([route([guard("AuthGuard", "canLoad")])], rules).auth).toBe("protected")
  })

  it("canDeactivate is ignored", () => {
    expect(angularAuthOf([route([guard("AuthGuard", "canDeactivate")])], rules).auth).toBe("public")
  })

  it("an inline null-name guard is null", () => {
    expect(angularAuthOf([route([guard(null)])], rules)).toEqual({ auth: null, evidence: [] })
  })
})
