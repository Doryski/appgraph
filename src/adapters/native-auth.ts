import { sortedUnique } from "../core/order.js"
import type { AppgraphConfig } from "../core/model.js"

export const DEFAULT_SIGNED_IN = [
  "isSignedIn",
  "isLoggedIn",
  "isAuthenticated",
  "hasSession",
  "session",
  "user",
  "currentUser",
] as const

export const DEFAULT_AUTH_OPTION_KEYS = ["requireAuth"] as const

export type NativeAuthRules = {
  readonly signedIn: readonly string[]
  readonly authOptionKeys: readonly string[]
}

export type NativeAuthVerdict = "protected" | "public" | null

export const resolveNativeAuthRules = (
  config: Pick<AppgraphConfig, "nativeAuth" | "reactNavigation">,
): NativeAuthRules => ({
  signedIn: sortedUnique([...DEFAULT_SIGNED_IN, ...(config.nativeAuth?.signedIn ?? [])]),
  authOptionKeys: sortedUnique([...DEFAULT_AUTH_OPTION_KEYS, ...(config.reactNavigation?.authOptionKeys ?? [])]),
})

const NEGATING_SUFFIXES = ["===false", "==false", "===null", "==null", "===undefined", "==undefined"] as const

const AFFIRMING_SUFFIXES = ["===true", "==true", "!==null", "!=null", "!==undefined", "!=undefined"] as const

type Guard = {
  readonly subject: string
  readonly negated: boolean
}

const unwrapParens = (text: string): string =>
  text.startsWith("(") && text.endsWith(")") ? unwrapParens(text.slice(1, -1)) : text

const suffixOf = (text: string, suffixes: readonly string[]): string | null =>
  suffixes.find((suffix) => text.endsWith(suffix) && text.length > suffix.length) ?? null

const comparedGuard = (text: string): Guard => {
  const negating = suffixOf(text, NEGATING_SUFFIXES)
  if (negating !== null) return { subject: text.slice(0, -negating.length), negated: true }
  const affirming = suffixOf(text, AFFIRMING_SUFFIXES)
  if (affirming !== null) return { subject: text.slice(0, -affirming.length), negated: false }
  return { subject: text, negated: false }
}

const guardOf = (text: string): Guard => {
  const bare = unwrapParens(text)
  if (bare.startsWith("!!")) return guardOf(bare.slice(2))
  if (bare.startsWith("!")) {
    const inner = guardOf(bare.slice(1))
    return { subject: inner.subject, negated: !inner.negated }
  }
  return comparedGuard(bare)
}

const SUBJECT_PATTERN = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*(?:\(\))?$/

const lastSegmentOf = (subject: string): string | null => {
  if (!SUBJECT_PATTERN.test(subject)) return null
  const path = subject.endsWith("()") ? subject.slice(0, -2) : subject
  return path.split(".").at(-1) ?? null
}

const hookNameOf = (identifier: string): string => `use${identifier.charAt(0).toUpperCase()}${identifier.slice(1)}`

const matchesSignedIn = (segment: string, rules: NativeAuthRules): boolean =>
  rules.signedIn.some((identifier) => segment === identifier || segment === hookNameOf(identifier))

export const authFromGuard = (exprText: string, rules: NativeAuthRules): NativeAuthVerdict => {
  const guard = guardOf(exprText.replace(/\s+/g, ""))
  const segment = lastSegmentOf(guard.subject)
  if (segment === null || !matchesSignedIn(segment, rules)) return null
  return guard.negated ? "public" : "protected"
}

export const authFromOptions = (
  options: Readonly<Record<string, boolean>>,
  rules: NativeAuthRules,
): NativeAuthVerdict => {
  const values = rules.authOptionKeys.flatMap((key) => {
    const value = options[key]
    return value === undefined ? [] : [value]
  })
  const isProtected = values.includes(true)
  const isPublic = values.includes(false)
  if (isProtected === isPublic) return null
  return isProtected ? "protected" : "public"
}
