import type { DiagnosticInput } from "../../core/diagnostics.js"
import { REACT_ROUTER_MODULE, type AncestorRef, type RouteDialect } from "../../core/model.js"
import { dialectFor, modeOf, outerModeOf, overriddenPreset } from "../route-dialects.js"
import type { DiscoverContext, ScreenDraft, TsNode } from "../types.js"
import type { RouteRoot } from "./model.js"
import type { RouterProfile } from "./profile.js"
import { retargetRules, type ReactRouterOptions } from "./wrappers.js"

export const reportOverriddenPreset = (ctx: DiscoverContext, configured: RouteDialect | undefined): void => {
  const preset = overriddenPreset(ctx, configured)
  if (preset === null || configured === undefined) return
  const name = configured.name === undefined ? "" : ` '${configured.name}'`
  ctx.diagnostic({
    severity: "info",
    code: "config/dialect-overrides-preset",
    message: `the configured reactRouter.routeDialect${name} replaces the built-in '${preset.name ?? ""}' preset as a whole; the preset's fields, translators, unwrapCalls and prefixRules apply only where the configured dialect repeats them`,
  })
}

export const createDiscoveryState = (ctx: DiscoverContext, options: ReactRouterOptions, profile: RouterProfile) => {
  const rules =
    options.wrappers === undefined ? profile.wrappers : retargetRules(options.wrappers, REACT_ROUTER_MODULE, profile.module)
  const factories = options.factories ?? profile.factories
  const { hooks, elementFactories } = profile

  const dialect = dialectFor(ctx, options.routeDialect)
  reportOverriddenPreset(ctx, options.routeDialect)
  const outerMode = outerModeOf(dialect)
  const innerMode = modeOf(dialect)
  const translators = dialect.translators ?? []
  const unwrapCalls = dialect.unwrapCalls ?? []

  const drafts: ScreenDraft[] = []
  const ancestors = new Map<string, readonly AncestorRef[]>()
  const ordinals = new Map<string, number>()
  // An IN-PROGRESS stack, not a seen-set: the same imported `childRoutes` array may legitimately be
  // the `children` of two parents, and a seen-set would silently drop the second one.
  const openLists = new Set<TsNode>()
  const openRoots = new Set<RouteRoot>()
  const parsedRoots = new Set<RouteRoot>()

  const nextOrdinal = (file: string): number => {
    const ordinal = ordinals.get(file) ?? 0
    ordinals.set(file, ordinal + 1)
    return ordinal
  }

  const flags = {
    /** A dry run reads a list only for the urls it would claim: it reports nothing and mints no ids. */
    dryRun: false,
    /** A dual route's second reading re-reads one subtree: its findings were reported by the first. */
    echo: false,
  }

  const report = (input: DiagnosticInput): void => {
    if (!flags.dryRun && !flags.echo) ctx.diagnostic(input)
  }

  const reportedEntries = new Set<TsNode>()

  const echoed = (read: () => void): void => {
    const outer = flags.echo
    flags.echo = true
    read()
    flags.echo = outer
  }


  return {
    ctx,
    profile,
    rules,
    factories,
    hooks,
    elementFactories,
    dialect,
    outerMode,
    innerMode,
    translators,
    unwrapCalls,
    drafts,
    ancestors,
    ordinals,
    openLists,
    openRoots,
    parsedRoots,
    nextOrdinal,
    flags,
    report,
    reportedEntries,
    echoed,
  }
}

export type DiscoveryState = ReturnType<typeof createDiscoveryState>
