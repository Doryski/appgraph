import type { KindRule } from "../../core/model.js"
import type { PipelineEnv } from "../context.js"
import { createDiscoverContext } from "../context.js"
import type { PipelineRegistry } from "../registry.js"
import { safeCall } from "../registry.js"
import { pluginReport } from "./shared.js"

export type ConfigureInput = {
  readonly env: PipelineEnv
  readonly registry: PipelineRegistry
}

export type ConfigureOutput = {
  readonly kindRules: readonly KindRule[]
}

export const configure = (input: ConfigureInput): ConfigureOutput => {
  const { env, registry } = input
  const added: KindRule[] = []

  for (const adapter of registry.adapters) {
    const configureHook = adapter.configure
    if (configureHook === undefined) continue

    const sink = env.diagnostics.forPlugin(adapter.name)
    safeCall(
      adapter.name,
      "configure",
      undefined,
      () =>
        configureHook({
          ...createDiscoverContext({ env, plugin: adapter.name }),
          config: env.config,
          addKindRule: (rule) => added.push(rule),
          diagnostic: (diagnostic) => sink.report(diagnostic),
        }),
      pluginReport(env),
    )
  }

  return { kindRules: [...env.config.kindRules, ...registry.kindRules, ...added] }
}
