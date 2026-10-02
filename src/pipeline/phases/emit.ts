import * as path from "node:path"
import type { AppGraph } from "../../core/model.js"
import { by, sortedUnique } from "../../core/order.js"
import type { EmitFile } from "../../adapters/types.js"
import type { PipelineEnv } from "../context.js"
import type { PipelineRegistry } from "../registry.js"
import { safeCall } from "../registry.js"
import { pluginReport } from "./shared.js"

export type EmitPhaseInput = {
  readonly env: PipelineEnv
  readonly registry: PipelineRegistry
  readonly graph: AppGraph
  readonly formats: readonly string[]
  readonly options?: Readonly<Record<string, unknown>>
}

export const ALL_FORMATS = ["full", "index", "html", "graph"] as const

export const expandFormats = (formats: readonly string[]): readonly string[] =>
  sortedUnique(formats.flatMap((format) => (format === "all" ? [...ALL_FORMATS] : [format])))

const isOutsideOutputDir = (file: string): boolean =>
  path.isAbsolute(file) || path.win32.isAbsolute(file) || file.split(/[\\/]/).includes("..")

export const emit = (input: EmitPhaseInput): readonly EmitFile[] => {
  const { env, registry } = input
  const files: EmitFile[] = []
  const report = pluginReport(env)

  for (const format of expandFormats(input.formats)) {
    const owned = registry.emitterFor(format)
    if (owned === null) {
      env.diagnostics.warning("emit/unknown-format", `no emitter is registered for format '${format}'`)
      continue
    }

    const produced = safeCall<readonly EmitFile[]>(
      owned.emitter.name,
      "emit",
      [],
      () =>
        owned.emitter.emit(input.graph, {
          format,
          timestamp: env.config.timestamp,
          options: input.options ?? {},
          asset: (name) => env.host.readFile(name) ?? "",
        }),
      report,
    )

    for (const file of produced) {
      if (isOutsideOutputDir(file.path)) {
        env.diagnostics.error(
          "emit/unwritable-output",
          `emitter '${owned.emitter.name}' returned a path outside the output dir: ${file.path}`,
        )
        continue
      }
      files.push(file)
    }
  }

  return [...files].sort(by((file) => file.path))
}
