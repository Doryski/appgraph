import type ts from "typescript"
import type { FileBindingTable } from "../core/bindings.js"
import type { CrossFileResolve, ExtractContext } from "./types.js"
import type { TypeScriptApi } from "../core/tsconfig.js"
import { createBindingTable } from "../core/bindings.js"

// The one shape every cross-file proof in `finish` reads: `export const name = <initializer>` in the
// module that declares the export, plus that module's own binding table so the initializer's roots
// can be checked against package patterns exactly as a same-file binding would be.
export type ExportedConst = {
  readonly declaring: string
  readonly initializer: ts.Expression
  readonly table: FileBindingTable
}

const bindingTables = new WeakMap<ts.SourceFile, FileBindingTable>()

export const bindingTableFor = (
  api: TypeScriptApi,
  source: ts.SourceFile,
  resolveModule: (specifier: string) => string | null,
): FileBindingTable => {
  const cached = bindingTables.get(source)
  if (cached !== undefined) return cached
  const table = createBindingTable({ ts: api, source, resolveModule })
  bindingTables.set(source, table)
  return table
}

export const exportedConstIn = (
  resolve: CrossFileResolve,
  absFile: string,
  exportName: string,
  ctx: ExtractContext,
): ExportedConst | null => {
  const declaring = resolve.declarationFile(absFile, exportName)
  const source = resolve.sourceFile(declaring)
  if (source === null) return null

  const declaration = ctx.ast.declarationOf(source, exportName)
  if (declaration === null || !ctx.ts.isVariableDeclaration(declaration)) return null

  const initializer = declaration.initializer
  if (initializer === undefined) return null

  const table = bindingTableFor(ctx.ts, source, (specifier) => resolve.resolveModule(declaring, specifier))

  return { declaring, initializer, table }
}

export const importedConstOf = (local: string, ctx: ExtractContext): ExportedConst | null => {
  const resolve = ctx.resolve
  if (resolve === null) return null

  const binding = ctx.bindings.get(local)
  if (binding === null || binding.kind !== "import" || binding.file === null) return null

  return exportedConstIn(resolve, binding.file, binding.imported, ctx)
}
