import type { AncestorRef } from "../../core/model.js"
import type { Adapter, ScreenDraft, ScreenShape, ScreenSource } from "../types.js"
import { runDiscovery } from "./discover.js"
import type { RouterProfile } from "./profile.js"
import { REACT_ROUTER_PROFILE, WOUTER_PROFILE, hasProfileDependency } from "./profile.js"
import type { ReactRouterOptions } from "./wrappers.js"

export { DEFAULT_WRAPPER_RULES } from "../../core/model.js"
export type { WrapperRoleKind, WrapperRule } from "../../core/model.js"
export {
  ELEMENT_ROUTE_FACTORIES,
  ROUTE_HOOKS,
  ROUTER_ELEMENTS,
  ROUTER_FACTORIES,
  SOURCE_NAME,
  WOUTER_SOURCE_NAME,
} from "./constants.js"
export { detectReactRouter, detectWouter } from "./detect.js"
export type { RouterProfile } from "./profile.js"
export type { ReactRouterOptions } from "./wrappers.js"

const createRouterSource = (profile: RouterProfile, options: ReactRouterOptions): ScreenSource => {
  const chains = new Map<string, readonly AncestorRef[]>()

  return {
    name: profile.name,
    detect: profile.detect,
    discover: (ctx): readonly ScreenDraft[] => {
      if (!hasProfileDependency(ctx, profile)) return []
      const discovery = runDiscovery(ctx, options, profile)
      for (const [localId, chain] of discovery.ancestors) chains.set(localId, chain)
      return discovery.drafts
    },
    ancestorsOf: (screen: ScreenShape): readonly AncestorRef[] =>
      chains.get(screen.localId) ?? screen.ancestors,
  }
}

const createRouterAdapter = (profile: RouterProfile, options: ReactRouterOptions): Adapter => ({
  name: profile.name,
  screens: [createRouterSource(profile, options)],
})

export const createReactRouterSource = (options: ReactRouterOptions = {}): ScreenSource =>
  createRouterSource(REACT_ROUTER_PROFILE, options)

export const createReactRouterAdapter = (options: ReactRouterOptions = {}): Adapter =>
  createRouterAdapter(REACT_ROUTER_PROFILE, options)

export const createWouterSource = (options: ReactRouterOptions = {}): ScreenSource =>
  createRouterSource(WOUTER_PROFILE, options)

export const createWouterAdapter = (options: ReactRouterOptions = {}): Adapter =>
  createRouterAdapter(WOUTER_PROFILE, options)
