import { describe, expect, it } from "vitest"
import {
  DEFAULT_AUTH_OPTION_KEYS,
  DEFAULT_SIGNED_IN,
  authFromGuard,
  authFromOptions,
  resolveNativeAuthRules,
} from "../../src/adapters/native-auth.js"

const rules = resolveNativeAuthRules({})

describe("resolveNativeAuthRules", () => {
  it("starts from the defaults", () => {
    expect(rules.signedIn).toEqual(expect.arrayContaining([...DEFAULT_SIGNED_IN]))
    expect(rules.signedIn).toHaveLength(DEFAULT_SIGNED_IN.length)
    expect(rules.authOptionKeys).toEqual([...DEFAULT_AUTH_OPTION_KEYS])
  })

  it("unions configured names over the defaults without duplicates", () => {
    const configured = resolveNativeAuthRules({
      nativeAuth: { signedIn: ["isAuthed", "user"] },
      reactNavigation: { authOptionKeys: ["needsLogin", "requireAuth"] },
    })
    expect(configured.signedIn).toEqual(expect.arrayContaining([...DEFAULT_SIGNED_IN, "isAuthed"]))
    expect(configured.signedIn).toHaveLength(DEFAULT_SIGNED_IN.length + 1)
    expect(configured.authOptionKeys).toEqual(["needsLogin", "requireAuth"])
  })
})

describe("authFromGuard", () => {
  it.each(["isSignedIn", "auth.isLoggedIn", "!!session", "state?.user", "isAuthenticated === true", "user != null", "useIsSignedIn", "useSession()", "( isSignedIn )", "!isLoggedIn === false"])(
    "reads the non-negated guard %s as protected",
    (expr) => {
      expect(authFromGuard(expr, rules)).toBe("protected")
    },
  )

  it.each(["!isSignedIn", "!auth.user", "isLoggedIn === false", "currentUser == null", "!(hasSession)", "! session"])(
    "reads the negated guard %s as public",
    (expr) => {
      expect(authFromGuard(expr, rules)).toBe("public")
    },
  )

  it.each(["isAdmin", "user.isAdmin", "isSignedIn && isAdmin", "isSignedIn ? a : b", "featureEnabled", "", "isSignedInSomewhere", "user !== false"])(
    "gives null for the unrelated or compound guard %s",
    (expr) => {
      expect(authFromGuard(expr, rules)).toBeNull()
    },
  )

  it("honours a configured signed-in identifier", () => {
    expect(authFromGuard("isAuthed", rules)).toBeNull()
    const configured = resolveNativeAuthRules({ nativeAuth: { signedIn: ["isAuthed"] } })
    expect(authFromGuard("isAuthed", configured)).toBe("protected")
    expect(authFromGuard("!store.isAuthed", configured)).toBe("public")
  })
})

describe("authFromOptions", () => {
  it("is protected when a configured key is true", () => {
    expect(authFromOptions({ requireAuth: true }, rules)).toBe("protected")
  })

  it("is public when a configured key is explicitly false", () => {
    expect(authFromOptions({ requireAuth: false }, rules)).toBe("public")
  })

  it("is null when no configured key is present", () => {
    expect(authFromOptions({}, rules)).toBeNull()
    expect(authFromOptions({ headerShown: false }, rules)).toBeNull()
  })

  it("is null when configured keys disagree", () => {
    const configured = resolveNativeAuthRules({ reactNavigation: { authOptionKeys: ["needsLogin"] } })
    expect(authFromOptions({ requireAuth: true, needsLogin: false }, configured)).toBeNull()
    expect(authFromOptions({ needsLogin: true }, configured)).toBe("protected")
    expect(authFromOptions({ needsLogin: true }, rules)).toBeNull()
  })
})
