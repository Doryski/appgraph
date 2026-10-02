import type { DiagnosticInput } from "../../core/diagnostics.js"
import type { WrapperRule } from "../../core/model.js"
import { DEFAULT_WRAPPER_RULES, REACT_ROUTER_MODULE } from "../../core/model.js"
import type { RouteFlavour } from "../route-flavours.js"
import { FLAVOUR_ORDER, ROUTE_FLAVOURS } from "../route-flavours.js"
import type { ProjectContext, ScreenSource } from "../types.js"
import {
  ELEMENT_ROUTE_FACTORIES,
  ROUTER_ELEMENTS,
  ROUTER_FACTORIES,
  ROUTE_HOOKS,
  SOURCE_NAME,
  WOUTER_DEPENDENCY,
  WOUTER_MODULE,
  WOUTER_ROUTER_ELEMENTS,
  WOUTER_SOURCE_NAME,
} from "./constants.js"
import { detectReactRouter, detectWouter } from "./detect.js"
import { unsupportedSetupDiagnostics } from "./warnings.js"
import { retargetRules } from "./wrappers.js"

/**
 * One router library read by the react-router reader (AS19): where its exports come from, which flavours
 * its roots take, and the library-level calls and elements around them. Everything the reader would
 * otherwise hardcode about react-router lives here, so wouter is a second profile, not a second reader.
 */
export type RouterProfile = {
  readonly name: string
  /** The module the router's components and hooks are imported from (a regex source). */
  readonly module: string
  readonly flavours: readonly RouteFlavour[]
  readonly detect: ScreenSource["detect"]
  /** `discover` reads nothing unless one of these is a dependency (AS1); empty: ungated. */
  readonly dependencies: readonly string[]
  /** Router components that host the WHOLE route tree: a list rendered under one is top-level. */
  readonly routerElements: readonly string[]
  readonly factories: readonly string[]
  readonly hooks: readonly string[]
  readonly elementFactories: readonly string[]
  readonly wrappers: readonly WrapperRule[]
  readonly setupDiagnostics: (ctx: ProjectContext, rootCount: number) => readonly DiagnosticInput[]
}

export const REACT_ROUTER_PROFILE: RouterProfile = {
  name: SOURCE_NAME,
  module: REACT_ROUTER_MODULE,
  flavours: FLAVOUR_ORDER,
  detect: detectReactRouter,
  dependencies: [],
  routerElements: ROUTER_ELEMENTS,
  factories: ROUTER_FACTORIES,
  hooks: ROUTE_HOOKS,
  elementFactories: ELEMENT_ROUTE_FACTORIES,
  wrappers: DEFAULT_WRAPPER_RULES,
  setupDiagnostics: unsupportedSetupDiagnostics,
}

export const WOUTER_PROFILE: RouterProfile = {
  name: WOUTER_SOURCE_NAME,
  module: WOUTER_MODULE,
  flavours: [ROUTE_FLAVOURS.wouter],
  detect: detectWouter,
  dependencies: [WOUTER_DEPENDENCY],
  routerElements: WOUTER_ROUTER_ELEMENTS,
  factories: [],
  hooks: [],
  elementFactories: [],
  wrappers: retargetRules(DEFAULT_WRAPPER_RULES, REACT_ROUTER_MODULE, WOUTER_MODULE),
  setupDiagnostics: () => [],
}

export const hasProfileDependency = (ctx: ProjectContext, profile: RouterProfile): boolean =>
  profile.dependencies.length === 0 || profile.dependencies.some((name) => ctx.hasDependency(name))
