import type ts from "typescript"
import type { ModulePattern } from "../core/bindings.js"
import type { ExtractContext, FactExtractor } from "./types.js"

export const DEFAULT_RESOLVER_MODULE: ModulePattern = /^@hookform\/resolvers\/(zod|yup|valibot)$/
export const DEFAULT_FORMIK_MODULE: ModulePattern = /^formik$/
export const DEFAULT_FINAL_FORM_MODULE: ModulePattern = /^react-final-form$/
export const DEFAULT_FORMIK_ADAPTER_MODULE: ModulePattern = /^zod-formik-adapter$/

// The default tag test, configurable rather than hardcoded:
// `*Field` components (`TextField`, `SelectField`, …) and RHF's own `Controller`.
export const DEFAULT_FIELD_TAG_PATTERN = /Field$|^Controller$/

const RESOLVER_NAMES = new Set(["zodResolver", "yupResolver", "valibotResolver"])
const FORMIK_ADAPTERS = new Set(["toFormikValidationSchema"])
const FIELD_HOOKS = new Set(["useField"])

// A validator on its own is never a form (zod also validates API payloads); a schema is recorded only
// where a form library consumes it: an RHF resolver, or formik's `validationSchema`.
type FormLibrary = {
  readonly module: "formik" | "finalForm"
  readonly hook: string | null
  readonly tag: string
}

const FORM_LIBRARIES: readonly FormLibrary[] = [
  { module: "formik", hook: "useFormik", tag: "Formik" },
  { module: "finalForm", hook: null, tag: "Form" },
]

export type FormsOptions = {
  readonly resolverModule?: ModulePattern
  readonly formikModule?: ModulePattern
  readonly finalFormModule?: ModulePattern
  readonly formikAdapterModule?: ModulePattern
  readonly fieldTagPattern?: RegExp
  readonly fieldNameAttribute?: string
}

const importedName = (local: string, module: ModulePattern, ctx: ExtractContext): string | null => {
  const binding = ctx.bindings.get(local)
  if (binding === null || (binding.kind !== "import" && binding.kind !== "dynamic-import")) return null
  if (!ctx.bindings.rootsInModule(local, module)) return null
  return binding.imported === "default" || binding.imported === "*" ? local : binding.imported
}

export const createFormsExtractor = (options: FormsOptions = {}): FactExtractor => {
  const resolverModule = options.resolverModule ?? DEFAULT_RESOLVER_MODULE
  const fieldTagPattern = options.fieldTagPattern ?? DEFAULT_FIELD_TAG_PATTERN
  const fieldNameAttribute = options.fieldNameAttribute ?? "name"
  const modules = {
    formik: options.formikModule ?? DEFAULT_FORMIK_MODULE,
    finalForm: options.finalFormModule ?? DEFAULT_FINAL_FORM_MODULE,
  } as const
  const formikAdapterModule = options.formikAdapterModule ?? DEFAULT_FORMIK_ADAPTER_MODULE

  const seenSchemas = new Set<string>()
  const seenFields = new Set<string>()

  const emitSchema = (name: string, node: ts.Node, ctx: ExtractContext): void => {
    if (seenSchemas.has(name)) return
    seenSchemas.add(name)
    ctx.emitFact("formSchemas", name, node)
  }

  const emitField = (name: string, node: ts.Node, ctx: ExtractContext): void => {
    if (seenFields.has(name)) return
    seenFields.add(name)
    ctx.emitFact("formFields", name, node)
  }

  const formImport = (local: string, ctx: ExtractContext): { library: FormLibrary; imported: string } | null => {
    for (const library of FORM_LIBRARIES) {
      const imported = importedName(local, modules[library.module], ctx)
      if (imported !== null) return { library, imported }
    }
    return null
  }

  const propertyNamed = (object: ts.ObjectLiteralExpression | null, name: string, ctx: ExtractContext): ts.Node | null => {
    const property = object?.properties.find(
      (candidate) => candidate.name !== undefined && ctx.ts.isIdentifier(candidate.name) && candidate.name.text === name,
    )
    if (property === undefined) return null
    if (ctx.ts.isPropertyAssignment(property)) return property.initializer
    return ctx.ts.isShorthandPropertyAssignment(property) ? property.name : null
  }

  const visitInitialValues = (node: ts.Node | null, at: ts.Node, ctx: ExtractContext): void => {
    const object = ctx.ast.asObjectLiteral(node ?? undefined)
    if (object === null) return
    for (const property of object.properties) {
      if (!ctx.ts.isPropertyAssignment(property) && !ctx.ts.isShorthandPropertyAssignment(property)) continue
      const name = property.name
      if (ctx.ts.isIdentifier(name) || ctx.ts.isStringLiteral(name)) emitField(name.text, at, ctx)
    }
  }

  const visitValidationSchema = (node: ts.Node | null, at: ts.Node, ctx: ExtractContext): void => {
    const direct = ctx.ast.asIdentifier(node ?? undefined)
    if (direct !== null) {
      emitSchema(direct.text, at, ctx)
      return
    }

    const call = ctx.ast.asCallExpression(node ?? undefined)
    const adapter = call === null ? null : ctx.ast.asIdentifier(call.expression)
    if (call === null || adapter === null) return
    const imported = importedName(adapter.text, formikAdapterModule, ctx)
    const schema = ctx.ast.asIdentifier(call.arguments[0])
    if (imported !== null && FORMIK_ADAPTERS.has(imported) && schema !== null) emitSchema(schema.text, at, ctx)
  }

  const visitFormConfig = (
    read: (name: string) => ts.Node | null,
    library: FormLibrary,
    at: ts.Node,
    ctx: ExtractContext,
  ): void => {
    visitInitialValues(read("initialValues"), at, ctx)
    if (library.module === "formik") visitValidationSchema(read("validationSchema"), at, ctx)
  }

  const visitResolverCall = (call: ts.CallExpression, ctx: ExtractContext): void => {
    const identifier = ctx.ast.asIdentifier(call.expression)
    if (identifier === null) return

    const imported = importedName(identifier.text, resolverModule, ctx)
    if (imported === null || !RESOLVER_NAMES.has(imported)) return

    const schema = ctx.ast.asIdentifier(call.arguments[0])
    if (schema !== null) emitSchema(schema.text, call, ctx)
  }

  const visitFormLibraryCall = (call: ts.CallExpression, ctx: ExtractContext): void => {
    const identifier = ctx.ast.asIdentifier(call.expression)
    const found = identifier === null ? null : formImport(identifier.text, ctx)
    if (found === null) return

    if (FIELD_HOOKS.has(found.imported)) {
      const flat = ctx.flattenString(call.arguments[0])
      if (flat !== null) emitField(flat.value, call, ctx)
      return
    }

    if (found.imported !== found.library.hook) return
    const config = ctx.ast.asObjectLiteral(call.arguments[0])
    visitFormConfig((name) => propertyNamed(config, name, ctx), found.library, call, ctx)
  }

  const visitFormTag = (node: ts.JsxOpeningLikeElement, tag: string, ctx: ExtractContext): void => {
    const found = formImport(tag, ctx)
    if (found === null || found.imported !== found.library.tag) return

    const read = (name: string): ts.Node | null => {
      const initializer = ctx.ast.attributeByName(node, name)?.initializer
      if (initializer === undefined) return null
      return ctx.ts.isJsxExpression(initializer) ? initializer.expression ?? null : initializer
    }
    visitFormConfig(read, found.library, node, ctx)
  }

  const visitField = (node: ts.JsxOpeningLikeElement, ctx: ExtractContext): void => {
    const tag = ctx.ast.tagName(node)
    if (tag === null) return
    visitFormTag(node, tag, ctx)
    if (!fieldTagPattern.test(tag)) return

    const flat = ctx.flattenString(ctx.ast.attributeByName(node, fieldNameAttribute)?.initializer)
    if (flat !== null) emitField(flat.value, node, ctx)
  }

  return {
    name: "forms",
    provides: ["formSchemas", "formFields"],
    enablingDependency: "react-hook-form",
    requires: ["bindings", "stringConstants"],
    stage: "main",

    start: () => {
      seenSchemas.clear()
      seenFields.clear()
    },

    enter: (node, ctx) => {
      const api = ctx.ts
      if (api.isJsxOpeningElement(node) || api.isJsxSelfClosingElement(node)) {
        visitField(node, ctx)
        return
      }

      const call = ctx.ast.asCallExpression(node)
      if (call === null || call !== node) return
      visitResolverCall(call, ctx)
      visitFormLibraryCall(call, ctx)
    },
  }
}
