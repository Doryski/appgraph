import type { MergedDraft } from "../../core/graph.js"
import { toPosix } from "../../core/host.js"
import type { AncestorRef } from "../../core/model.js"
import { sortedUniqueBy } from "../../core/order.js"
import type { EntryRef, ResolvedEntryRef, ScreenShape } from "../../adapters/types.js"
import type { PipelineEnv } from "../context.js"
import { createDiscoverContext, createEntryContext } from "../context.js"
import type { PipelineRegistry } from "../registry.js"
import { safeCall } from "../registry.js"
import type { NormalizedScreen } from "./normalize.js"
import { pluginReport } from "./shared.js"

export type ResolvedScreen = {
  readonly merged: MergedDraft
  readonly shape: ScreenShape
  readonly entries: readonly ResolvedEntryRef[]
  readonly ancestors: readonly AncestorRef[]
}

export type ResolveEntriesInput = {
  readonly env: PipelineEnv
  readonly registry: PipelineRegistry
  readonly screens: readonly NormalizedScreen[]
}

const entryKey = (entry: ResolvedEntryRef): string =>
  entry.kind === "file"
    ? `file|${entry.file}|${entry.exportName}|${entry.at === undefined ? "" : `${entry.at.export}:${entry.at.path.join(".")}`}`
    : `opaque|${entry.file}|${String(entry.line)}|${entry.expr}`

const describeRef = (ref: EntryRef): string => {
  if (ref.kind === "module") return `${ref.spec} (from ${ref.from})`
  if (ref.kind === "binding") return `${ref.local} (in ${ref.from})`
  if (ref.kind === "opaque") return ref.expr
  return `${ref.file}#${ref.exportName}`
}

export const resolveEntries = (input: ResolveEntriesInput): readonly ResolvedScreen[] => {
  const { env, registry } = input
  const sourceByName = new Map(registry.screenSources.map((owned) => [owned.source.name, owned.source]))
  const report = pluginReport(env)

  return input.screens.map((screen): ResolvedScreen => {
    const source = sourceByName.get(screen.shape.source) ?? null
    const plugin = screen.shape.source
    const sink = env.diagnostics.forPlugin(plugin)
    const discoverCtx = createDiscoverContext({ env, plugin })
    const ctx = createEntryContext(discoverCtx, screen.shape)

    const supplied =
      source?.resolveEntries === undefined
        ? screen.pending
        : safeCall<readonly EntryRef[]>(
            plugin,
            "resolveEntries",
            screen.pending,
            () => source.resolveEntries?.(screen.pending, ctx) ?? screen.pending,
            report,
          )

    const resolved: ResolvedEntryRef[] = []

    for (const ref of supplied) {
      if (ref.kind === "file") {
        resolved.push(ref)
        continue
      }

      if (ref.kind === "opaque") {
        sink.error("screens/opaque-entry", `unresolvable screen entry: ${ref.expr}`, {
          file: ref.file,
          line: ref.line,
          screenId: screen.shape.id,
        })
        resolved.push(ref)
        continue
      }

      const hole = (): ResolvedEntryRef => {
        const expr = describeRef(ref)
        sink.error("screens/opaque-entry", `unresolvable screen entry: ${expr}`, {
          file: ref.from,
          line: 1,
          screenId: screen.shape.id,
        })
        return { kind: "opaque", expr, file: ref.from, line: 1 }
      }

      if (ref.kind === "module") {
        const file = ctx.resolveModule(ref.from, ref.spec)
        if (file === null) {
          resolved.push(hole())
          continue
        }
        resolved.push({
          kind: "file",
          ...ctx.declaredExport(file, ref.exported ?? "default"),
          ...(ref.at === undefined ? {} : { at: ref.at }),
        })
        continue
      }

      const binding = ctx.bindingsFor(ref.from).get(ref.local)
      if (binding === null || binding.kind === "local" || binding.kind === "hook-result" || binding.file === null) {
        resolved.push(hole())
        continue
      }

      const file = toPosix(env.paths.rel(binding.file))
      resolved.push({
        kind: "file",
        ...ctx.declaredExport(file, binding.imported),
        ...(ref.at === undefined ? {} : { at: ref.at }),
      })
    }

    const entries = sortedUniqueBy(resolved, entryKey)

    const ancestors =
      source?.ancestorsOf === undefined
        ? screen.merged.ancestors
        : safeCall<readonly AncestorRef[]>(
            plugin,
            "ancestorsOf",
            screen.merged.ancestors,
            () => source.ancestorsOf?.({ ...screen.shape, entries }, ctx) ?? screen.merged.ancestors,
            report,
          )

    return { merged: screen.merged, shape: { ...screen.shape, entries }, entries, ancestors }
  })
}
