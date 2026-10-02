import { walk } from "../core/ast.js"
import type { DiscoverContext, EntryRef, TsNode } from "./types.js"

export type LazyTarget = {
  readonly file: string
  readonly exportName: string
}

export type LazyModuleEntry = {
  readonly entry: EntryRef
  readonly target: LazyTarget | null
}

const DEFAULT_EXPORT = "default"

export const dynamicImportsIn = (ctx: Pick<DiscoverContext, "ast" | "ts">, node: TsNode): readonly string[] => {
  const specs: string[] = []
  walk(node, (candidate) => {
    const call = ctx.ast.asCallExpression(candidate)
    if (call === null || call.expression.kind !== ctx.ts.SyntaxKind.ImportKeyword) return
    const spec = ctx.ast.asStringLiteralLike(call.arguments[0])
    if (spec !== null) specs.push(spec.text)
  })
  return specs
}

/**
 * `() => import("./X")` names the module's `preferredExport`, falling back to its default export. An
 * unresolvable module stays a `module` ref, which the kernel turns into a visible opaque entry rather
 * than a silent entryless screen.
 */
export const lazyModuleEntry = (
  ctx: DiscoverContext,
  file: string,
  spec: string,
  preferredExport: string = DEFAULT_EXPORT,
): LazyModuleEntry => {
  const declaring = ctx.resolveModule(file, spec)
  if (declaring === null) return { entry: { kind: "module", from: file, spec, exported: preferredExport }, target: null }
  const source = ctx.sourceFile(declaring)
  const exportName =
    source !== null && ctx.ast.declarationOf(source, preferredExport) !== null ? preferredExport : DEFAULT_EXPORT
  const target = ctx.declaredExport(declaring, exportName)
  return { entry: { kind: "file", ...target }, target }
}
