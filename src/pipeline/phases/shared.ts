import type { Diagnostic } from "../../core/model.js"
import type { PipelineEnv } from "../context.js"

// A `plugin/threw` diagnostic must keep naming its author, so the report is routed through the
// collector's per-plugin sink rather than the kernel one.
export const pluginReport =
  (env: PipelineEnv) =>
  (diagnostic: Diagnostic): void => {
    const sink = diagnostic.plugin === null ? env.diagnostics : env.diagnostics.forPlugin(diagnostic.plugin)
    sink.report(diagnostic)
  }
