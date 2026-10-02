import { byCodepoint, sortedUnique } from "../../core/order.js"
import type { AngularPublicData, AppgraphConfig } from "../../core/model.js"

export const DEFAULT_PROTECTED_GUARDS = [
  "AuthGuard",
  "authGuard",
  "LoginGuard",
  "loginGuard",
  "AuthenticatedGuard",
  "AuthenticationGuard",
  "isAuthenticatedGuard",
] as const

export const DEFAULT_PUBLIC_GUARDS = [
  "UnloggedGuard",
  "GuestGuard",
  "guestGuard",
  "NoAuthGuard",
  "noAuthGuard",
  "AnonymousGuard",
] as const

export const DEFAULT_AUTH_DATA_KEYS = ["auth", "authorities", "roles", "permissions"] as const

export const DEFAULT_PUBLIC_DATA = [
  { key: "module", value: "public" },
  { key: "public", value: true },
  { key: "isPublic", value: true },
] as const satisfies readonly AngularPublicData[]

export const DEFAULT_REDIRECT_DATA_KEYS = ["redirectTo"] as const

export type AngularAuthRules = {
  readonly protectedGuards: readonly string[]
  readonly publicGuards: readonly string[]
  readonly authDataKeys: readonly string[]
  readonly publicData: readonly AngularPublicData[]
  readonly redirectDataKeys: readonly string[]
}

export const ANGULAR_GUARD_KINDS = ["canActivate", "canActivateChild", "canMatch", "canDeactivate", "canLoad"] as const

export type AngularGuardKind = (typeof ANGULAR_GUARD_KINDS)[number]

export type AngularGuardInput = {
  readonly kind: AngularGuardKind
  readonly name: string | null
  readonly trivial: boolean
}

export type AngularDataValue = string | boolean | readonly string[]

export type AngularRouteAuthInput = {
  readonly guards: readonly AngularGuardInput[]
  readonly data: Readonly<Record<string, AngularDataValue>>
}

export type AngularAuthVerdict = {
  readonly auth: "protected" | "public" | null
  readonly evidence: readonly string[]
}

const publicDataId = (entry: AngularPublicData): string => `${entry.key}\u0000${String(entry.value)}`

const uniquePublicData = (entries: readonly AngularPublicData[]): readonly AngularPublicData[] => {
  const byId = new Map(entries.map((entry) => [publicDataId(entry), entry]))
  return [...byId.entries()].sort(([a], [b]) => byCodepoint(a, b)).map(([, entry]) => entry)
}

export const resolveAngularAuthRules = (config: Pick<AppgraphConfig, "angular">): AngularAuthRules => ({
  protectedGuards: sortedUnique([...DEFAULT_PROTECTED_GUARDS, ...(config.angular?.protectedGuards ?? [])]),
  publicGuards: sortedUnique([...DEFAULT_PUBLIC_GUARDS, ...(config.angular?.publicGuards ?? [])]),
  authDataKeys: sortedUnique([...DEFAULT_AUTH_DATA_KEYS, ...(config.angular?.authDataKeys ?? [])]),
  publicData: uniquePublicData([...DEFAULT_PUBLIC_DATA, ...(config.angular?.publicData ?? [])]),
  redirectDataKeys: sortedUnique([...DEFAULT_REDIRECT_DATA_KEYS, ...(config.angular?.redirectDataKeys ?? [])]),
})

const appliesAt = (kind: AngularGuardKind, isRoute: boolean): boolean => {
  if (kind === "canDeactivate") return false
  if (kind === "canActivateChild") return !isRoute
  return true
}

const applicableGuards = (chain: readonly AngularRouteAuthInput[]): readonly AngularGuardInput[] =>
  chain.flatMap((route, index) =>
    route.guards.filter((guard) => appliesAt(guard.kind, index === chain.length - 1) && !guard.trivial),
  )

const dataMatches = (data: AngularRouteAuthInput["data"], entry: AngularPublicData): boolean =>
  data[entry.key] === entry.value

const nearestPublicData = (
  chain: readonly AngularRouteAuthInput[],
  rules: AngularAuthRules,
): string | null => {
  for (const route of [...chain].reverse()) {
    const hit = rules.publicData.find((entry) => dataMatches(route.data, entry))
    if (hit !== undefined) return `data.${hit.key}=${String(hit.value)}`
  }
  return null
}

const authDataKeyOf = (chain: readonly AngularRouteAuthInput[], rules: AngularAuthRules): string | null => {
  for (const route of [...chain].reverse()) {
    const key = rules.authDataKeys.find((candidate) => route.data[candidate] !== undefined)
    if (key !== undefined) return key
  }
  return null
}

const guardNamed = (guards: readonly AngularGuardInput[], names: readonly string[]): string | null =>
  guards.find((guard) => guard.name !== null && names.includes(guard.name))?.name ?? null

export const angularAuthOf = (
  chain: readonly AngularRouteAuthInput[],
  rules: AngularAuthRules,
): AngularAuthVerdict => {
  const publicData = nearestPublicData(chain, rules)
  if (publicData !== null) return { auth: "public", evidence: [publicData] }
  const guards = applicableGuards(chain)
  const protectedGuard = guardNamed(guards, rules.protectedGuards)
  if (protectedGuard !== null) return { auth: "protected", evidence: [protectedGuard] }
  const publicGuard = guardNamed(guards, rules.publicGuards)
  if (publicGuard !== null) return { auth: "public", evidence: [publicGuard] }
  if (guards.length === 0) return { auth: "public", evidence: [] }
  const dataKey = authDataKeyOf(chain, rules)
  if (dataKey !== null) return { auth: "protected", evidence: [`data.${dataKey}`] }
  return { auth: null, evidence: [] }
}
