import type { NavGroupDraft } from "../../core/graph.js"
import type { RedirectRule } from "../../core/model.js"
import type { TemplateTagResolverFn } from "../../core/template-doc.js"
import type { Adapter, AdapterResult, AmbientComponent, ScreenContributionDraft, ScreenDraft } from "../../adapters/types.js"
import type { PipelineEnv } from "../context.js"
import { createDiscoverContext } from "../context.js"
import { safeCall } from "../registry.js"
import type { ConfigureInput } from "./configure.js"
import { pluginReport } from "./shared.js"

type Report = ReturnType<typeof pluginReport>

const TAG_RESOLVER_HOOK = "templateTagResolver"

const guardedResolver = (plugin: string, resolver: TemplateTagResolverFn, report: Report): TemplateTagResolverFn =>
  (doc, element) => safeCall(plugin, TAG_RESOLVER_HOOK, null, () => resolver(doc, element), report)

const recordTagResolver = (env: PipelineEnv, adapter: Adapter, report: Report): void => {
  const hook = adapter.templateTagResolver
  if (hook === undefined) return
  const resolver = safeCall<TemplateTagResolverFn | null>(
    adapter.name,
    TAG_RESOLVER_HOOK,
    null,
    () => hook(createDiscoverContext({ env, plugin: adapter.name })),
    report,
  )
  if (resolver !== null) env.recordTemplateTagResolver(guardedResolver(adapter.name, resolver, report))
}

export type DiscoverOutput = {
  readonly results: readonly AdapterResult[]
  readonly contributions: readonly ScreenContributionDraft[]
  readonly navGroups: readonly NavGroupDraft[]
  readonly redirectRules: readonly RedirectRule[]
}

export const discover = (input: ConfigureInput): DiscoverOutput => {
  const { env, registry } = input
  const report = pluginReport(env)

  const byAdapter = new Map<string, { screens: ScreenContributionDraft[]; navGroups: NavGroupDraft[] }>()
  for (const adapter of registry.adapters) recordTagResolver(env, adapter, report)

  for (const adapter of registry.adapters) {
    const ambientHook = adapter.ambientComponents
    if (ambientHook === undefined) continue
    env.recordAmbientComponents(
      safeCall<readonly AmbientComponent[]>(
        adapter.name,
        "ambientComponents",
        [],
        () => ambientHook(createDiscoverContext({ env, plugin: adapter.name })),
        report,
      ),
    )
  }

  const bucket = (adapter: string) => {
    const existing = byAdapter.get(adapter)
    if (existing !== undefined) return existing
    const created = { screens: [], navGroups: [] }
    byAdapter.set(adapter, created)
    return created
  }

  for (const owned of registry.screenSources) {
    const ctx = createDiscoverContext({ env, plugin: owned.source.name })
    const drafts = safeCall<readonly ScreenDraft[]>(
      owned.source.name,
      "discover",
      [],
      () => owned.source.discover(ctx),
      report,
    )
    bucket(owned.adapter).screens.push(
      ...drafts.map((draft) => ({ source: owned.source.name, draft })),
    )
  }

  for (const owned of registry.navSources) {
    const ctx = createDiscoverContext({ env, plugin: owned.source.name })
    const groups = safeCall<readonly NavGroupDraft[]>(
      owned.source.name,
      "discover",
      [],
      () => owned.source.discover(ctx),
      report,
    )
    bucket(owned.adapter).navGroups.push(...groups)
  }

  const redirectRules = registry.redirectSources.flatMap((owned) =>
    safeCall<readonly RedirectRule[]>(
      owned.source.name,
      "discover",
      [],
      () => owned.source.discover(createDiscoverContext({ env, plugin: owned.source.name })),
      report,
    ),
  )

  const results = [...byAdapter.entries()].map(([adapter, value]) => ({
    adapter,
    screens: value.screens,
    navGroups: value.navGroups,
  }))

  return {
    results,
    contributions: results.flatMap((result) => result.screens),
    navGroups: results.flatMap((result) => result.navGroups),
    redirectRules,
  }
}
