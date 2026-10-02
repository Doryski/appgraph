import type { Activation, EntryRef, Screen } from "../model.js"
import { isRequiredNextCatchAll } from "../url.js"
import type { ChainLink } from "./model.js"

export const urlActivationOf = (activations: readonly Activation[]): Extract<Activation, { kind: "url" }> | null => {
  for (const activation of activations) if (activation.kind === "url") return activation
  return null
}

const localIdFile = (localId: string): string => {
  const hash = localId.indexOf("#")
  return hash === -1 ? localId : localId.slice(0, hash)
}

export const hasRequiredCatchAllEntry = (
  draft: { readonly entries: readonly EntryRef[]; readonly localId: string },
  url: string,
): boolean =>
  isRequiredNextCatchAll(url, localIdFile(draft.localId)) ||
  draft.entries.some((entry) => entry.kind === "file" && isRequiredNextCatchAll(url, entry.file))

/**
 * §6.3.1: the shell is the INNERMOST ancestor whose role is `layout` — a guard or error boundary
 * between it and the screen does not replace the frame the screen is drawn in. With no layout in
 * the chain, the nearest ancestor stands in.
 */
export const shellOf = (chain: readonly ChainLink[]): string | null => {
  const innermostFirst = [...chain].reverse()
  const layout = innermostFirst.find((link) => link.ancestor.role === "layout")
  return (layout ?? innermostFirst[0])?.ancestor.file ?? null
}

const API_ROUTE_KIND_TAGS: ReadonlySet<string> = new Set(["apiRoute", "api"])

export const isApiRouteScreen = (screen: Pick<Screen, "kindTag">): boolean =>
  screen.kindTag !== null && API_ROUTE_KIND_TAGS.has(screen.kindTag)

/**
 * The one definition behind every "screens" count (`meta.counts.screens`, the report header): an
 * entry of `screens[]` that is neither a redirect nor an API route — addressable and state screens
 * alike. Redirects and API routes are counted on their own (`redirects`, `apiRoutes`).
 */
export const countsAsScreen = (screen: Pick<Screen, "kindTag" | "redirectTo">): boolean =>
  screen.redirectTo === null && !isApiRouteScreen(screen)

export const hasPageScreens = (screens: readonly Pick<Screen, "kindTag" | "redirectTo">[]): boolean =>
  screens.some(countsAsScreen)

export const localIdSuffix = (localId: string): string => {
  const hash = localId.lastIndexOf("#")
  return hash === -1 ? localId : localId.slice(hash + 1)
}
