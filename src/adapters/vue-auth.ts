import { sortedUnique } from "../core/order.js"
import type { AppgraphConfig } from "../core/model.js"

export const DEFAULT_PROTECTED_MIDDLEWARE = ["auth", "authenticated", "admin", "permission", "moderator"] as const

export const DEFAULT_PUBLIC_MIDDLEWARE = ["guest"] as const

export const DEFAULT_AUTH_META_KEYS = ["requiresAuth", "requireAuth", "auth"] as const

export type VueAuthRules = {
  readonly protectedMiddleware: readonly string[]
  readonly publicMiddleware: readonly string[]
  readonly authMetaKeys: readonly string[]
}

export type VueAuthSignals = {
  readonly middleware: readonly string[]
  readonly flags: Readonly<Record<string, boolean>>
}

export type VueAuthVerdict = "protected" | "public" | null

export const resolveVueAuthRules = (config: Pick<AppgraphConfig, "vueAuth">): VueAuthRules => ({
  protectedMiddleware: sortedUnique([...DEFAULT_PROTECTED_MIDDLEWARE, ...(config.vueAuth?.protectedMiddleware ?? [])]),
  publicMiddleware: sortedUnique([...DEFAULT_PUBLIC_MIDDLEWARE, ...(config.vueAuth?.publicMiddleware ?? [])]),
  authMetaKeys: sortedUnique([...DEFAULT_AUTH_META_KEYS, ...(config.vueAuth?.authMetaKeys ?? [])]),
})

const flagValues = (signals: VueAuthSignals, rules: VueAuthRules): readonly boolean[] =>
  rules.authMetaKeys.flatMap((key) => {
    const value = signals.flags[key]
    return value === undefined ? [] : [value]
  })

export const authOf = (signals: VueAuthSignals, rules: VueAuthRules): VueAuthVerdict => {
  const flags = flagValues(signals, rules)
  const isProtected =
    signals.middleware.some((name) => rules.protectedMiddleware.includes(name)) || flags.includes(true)
  const isPublic = signals.middleware.some((name) => rules.publicMiddleware.includes(name)) || flags.includes(false)
  if (isProtected && isPublic) return null
  if (isProtected) return "protected"
  if (isPublic) return "public"
  return null
}
