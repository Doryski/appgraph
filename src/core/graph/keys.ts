import type { Activation, Endpoint, EntryRef, Evidence, Navigation, NodeLocator } from "../model.js"
import { routeNameSuffix } from "../model.js"

export const activationKey = (activation: Activation): string => {
  if (activation.kind === "host") return `0host|${activation.pattern}`
  if (activation.kind === "message") return `1message|${activation.messageType}`
  if (activation.kind === "state") return `2state|${activation.holder}|${activation.expr}`
  if (activation.kind === "url") return `3url|${activation.template}`
  if (activation.kind === "intercept") return `4intercept|${activation.from}|${activation.slot ?? ""}|${activation.file}`
  return `5route|${activation.name}|${activation.navigator ?? ""}`
}

export const locatorKey = (locator: NodeLocator | undefined): string =>
  locator === undefined ? "" : `${locator.export}:${locator.path.join(".")}`

const platformSuffix = (platform: string | undefined): string => (platform === undefined ? "" : `|${platform}`)

export const entryKey = (entry: EntryRef): string =>
  entry.kind === "file"
    ? `file|${entry.file}|${entry.exportName}|${locatorKey(entry.at)}${platformSuffix(entry.platform)}`
    : `opaque|${entry.file}|${entry.line}|${entry.expr}`

export const evidenceKey = (evidence: Evidence): string => `${evidence.file}|${evidence.line}|${evidence.what}`

export const endpointKey = (endpoint: Endpoint): string => `${endpoint.method} ${endpoint.url}`

export const endpointOrder = (endpoint: Endpoint): string => `${endpoint.url}${endpoint.method}`

export const navigationKey = (navigation: Navigation): string =>
  `${navigation.to}|${navigation.trigger}|${String(navigation.dynamic)}${routeNameSuffix(navigation)}`
