import type ts from "typescript"
import { isComponentTag, walk } from "../core/ast.js"
import type { AncestorRef, Binding, Evidence, PathlessRole, PathlessRoles, SpliceMode } from "../core/model.js"
import { DEFAULT_PATHLESS_ROLES } from "../core/model.js"
import { sortedUnique } from "../core/order.js"
import { convertTanStackCodePath } from "../core/url.js"
import { guardOfFunction, type LoaderGuard } from "./loader-guards.js"
import { importedBindingOf } from "./values.js"
import { objectMembers, type ObjectMember } from "./source-utils.js"
import type { DiscoverContext, EntryRef, TsNode } from "./types.js"

/**
 * TanStack composes EVERY level of the route tree through `<Outlet/>` — there is no `children` prop
 * anywhere in the convention — so one ancestor carries the same splice mode in every chain it appears
 * in. `tag` is the EXPORTED name, not the written one: the splice detector resolves
 * `import { Outlet as Slot }` and `import * as Router` + `<Router.Outlet/>` itself.
 */
export const OUTLET_SPLICE: SpliceMode = { kind: "outlet", tag: "Outlet" }

const LAZY_ROUTE_COMPONENT = "lazyRouteComponent"

const TANSTACK_SCOPE = "@tanstack/"

const OWN_BINDING_KINDS = ["local", "hook-result"] as const

const isOwnBinding = (binding: Binding | null): boolean =>
  binding !== null && OWN_BINDING_KINDS.some((kind) => kind === binding.kind)

const TANSTACK_ROUTE_FACTORIES: readonly string[] = [
  "createFileRoute",
  "createLazyFileRoute",
  "createRoute",
  "createLazyRoute",
  "createRootRoute",
  "createRootRouteWithContext",
]

const isTanStackModule = (module: string): boolean => module.startsWith(TANSTACK_SCOPE)

/** An app-declared function named like a TanStack route factory, whose declaring module calls the real one. */
export type RouteFactoryWrapper = {
  readonly name: string
  readonly file: string
  readonly factory: string
}

type Declared = {
  readonly name: string
  readonly file: string
}

export type { PathlessRole, PathlessRoles }
export { DEFAULT_PATHLESS_ROLES }

/** The first pathless layer, outermost first, whose role names an auth state. */
export const authOfLayers = (
  roles: PathlessRoles,
  layers: readonly string[],
): NonNullable<PathlessRole["auth"]> | null =>
  layers.map((layer) => roles[layer]?.auth).find((auth) => auth !== undefined) ?? null

export type RouteGuardOptions = {
  /** Config `redirects.unauthenticated`: narrows `beforeLoad` guards to redirects aimed at it. */
  readonly unauthenticatedTarget: string | null
}

const NO_GUARD_SCOPE: RouteGuardOptions = { unauthenticatedTarget: null }

/** The nearest conditional `beforeLoad` guard on a route or above it; `owner` names the ancestor, null for the route's own. */
export type InheritedGuard = {
  readonly guard: LoaderGuard
  readonly owner: string | null
}

export const ownGuard = (guard: LoaderGuard | null): InheritedGuard | null =>
  guard?.kind === "conditional" ? { guard, owner: null } : null

/** The guard a child inherits from `parent` (described as `owner`): the parent's own, else what it inherited. */
export const passedGuard = (inherited: InheritedGuard | null, owner: string): InheritedGuard | null =>
  inherited === null ? null : { guard: inherited.guard, owner: inherited.owner ?? owner }

/**
 * A conditional guard on the route or any ancestor makes it protected, whatever a pathless role says:
 * the redirect runs at runtime, a role is only a naming convention.
 */
export const guardedAuth = (
  layerAuth: NonNullable<PathlessRole["auth"]> | null,
  inherited: InheritedGuard | null,
): NonNullable<PathlessRole["auth"]> | null => (inherited === null ? layerAuth : "protected")

/** Evidence texts for the inherited half of a guard (the route's own guard is already option evidence). */
export const guardAuthTexts = (
  layerAuth: NonNullable<PathlessRole["auth"]> | null,
  inherited: InheritedGuard | null,
): readonly string[] => {
  if (inherited === null) return []
  const ancestor = inherited.owner === null ? [] : [`protected by the beforeLoad guard of '${inherited.owner}': ${inherited.guard.label}`]
  const override = layerAuth === "public" ? ["the beforeLoad guard wins over the pathless role's auth 'public'"] : []
  return [...ancestor, ...override]
}

/**
 * A redirect target in canonical URL syntax: TanStack's `$id` / `{-$id}` / `$` become `:id` / `:id?` / `*`.
 * A relative `to` (`./x`, `..`) resolves against the router's `from`, unknown statically, so it is no URL.
 */
const canonicalTarget = (to: string): string | null => (to.startsWith("/") ? convertTanStackCodePath(to).url : null)

/** An unconditional `beforeLoad` redirect makes the route a redirect, never a guard. */
export const redirectOfGuard = (guard: LoaderGuard | null): string | null =>
  guard?.kind === "unconditional" && guard.to !== null ? canonicalTarget(guard.to) : null

const UNREADABLE_TARGET = "redirect (target is not a readable literal)"

/**
 * Where a route's `component` option points. `none` is load-bearing: TanStack renders an implicit
 * `<Outlet/>` for a route without one, so such a route is a TRANSPARENT ancestor, never a missing
 * splice point.
 */
export type ComponentRef =
  | { readonly kind: "none" }
  | { readonly kind: "local"; readonly file: string; readonly name: string }
  | { readonly kind: "imported"; readonly file: string; readonly local: string }
  | { readonly kind: "inline"; readonly file: string; readonly node: TsNode }
  | { readonly kind: "lazy-module"; readonly file: string; readonly spec: string; readonly exported: string }
  | { readonly kind: "opaque"; readonly file: string; readonly node: TsNode }

type ScopeRef = {
  readonly file: string
  readonly exportName: string
}

const transparentAt = (file: string, exportName: string): AncestorRef => ({
  file,
  exportName,
  splice: OUTLET_SPLICE,
  role: "transparent",
})

const layoutAt = (scope: ScopeRef): AncestorRef => ({ ...scope, splice: OUTLET_SPLICE, role: "layout" })

export const createRouteOptionsReader = (ctx: DiscoverContext, guardOptions: RouteGuardOptions = NO_GUARD_SCOPE) => {
  const localName = (node: TsNode | undefined): string | null =>
    ctx.ast.asIdentifier(node)?.text ?? ctx.ast.asPropertyAccess(node)?.name.text ?? null

  const isAppDeclared = (imported: { module: string; imported: string }, file: string): boolean => {
    const resolved = ctx.resolveModule(file, imported.module)
    if (resolved === null) return !imported.module.startsWith(TANSTACK_SCOPE)
    const declared = ctx.declaredExport(resolved, imported.imported)
    return isOwnBinding(ctx.bindingsFor(declared.file).get(declared.exportName))
  }

  /**
   * The IMPORTED name when the callee is an import, so `import { createRoute as route }` still matches.
   * A bare callee the app declares itself — a local, a destructured hook result, a non-TanStack package
   * export, or a project module's own function — is never a TanStack factory, whatever its name.
   */
  const calleeName = (call: ts.CallExpression, file: string): string | null => {
    const written = localName(call.expression)
    if (written === null) return null
    const binding = ctx.bindingsFor(file).get(written)
    if (ctx.ast.asIdentifier(call.expression) === null || binding === null) return written
    if (isOwnBinding(binding)) return null
    const imported = importedBindingOf(binding)
    if (imported === null || isAppDeclared(imported, file)) return null
    return imported.imported
  }

  const declaredOf = (binding: Binding, written: string, file: string): Declared | null => {
    if (binding.kind === "local") return { name: written, file }
    const imported = importedBindingOf(binding)
    if (imported === null || isTanStackModule(imported.module)) return null
    const resolved = ctx.resolveModule(file, imported.module)
    if (resolved === null) return null
    const declared = ctx.declaredExport(resolved, imported.imported)
    return { name: declared.exportName, file: declared.file }
  }

  const tanstackFactoryOf = (call: ts.CallExpression, file: string): string | null => {
    const imported = importedBindingOf(ctx.bindingsFor(file).get(ctx.ast.asIdentifier(call.expression)?.text ?? ""))
    if (imported === null || !isTanStackModule(imported.module)) return null
    return TANSTACK_ROUTE_FACTORIES.includes(imported.imported) ? imported.imported : null
  }

  const calledFactories = new Map<string, string | null>()

  const calledFactoryIn = (file: string): string | null => {
    const cached = calledFactories.get(file)
    if (cached !== undefined) return cached
    const source = ctx.sourceFile(file)
    let found: string | null = null
    if (source !== null)
      walk(source, (node) => {
        const call = ctx.ast.asCallExpression(node)
        if (found === null && call !== null) found = tanstackFactoryOf(call, file)
      })
    calledFactories.set(file, found)
    return found
  }

  /**
   * The app wrapper a rejected factory-named callee is: declared by the app (locally or in a project
   * module) in a module that imports a TanStack route factory and calls it. An unrelated app function
   * of the same name — a store action, an OpenAPI helper — is no wrapper.
   */
  const wrappedFactoryOf = (call: ts.CallExpression, file: string): RouteFactoryWrapper | null => {
    const written = ctx.ast.asIdentifier(call.expression)?.text
    const binding = written === undefined ? null : ctx.bindingsFor(file).get(written)
    if (written === undefined || binding === null || calleeName(call, file) !== null) return null
    const declared = declaredOf(binding, written, file)
    if (declared === null || !TANSTACK_ROUTE_FACTORIES.includes(declared.name)) return null
    const factory = calledFactoryIn(declared.file)
    return factory === null ? null : { ...declared, factory }
  }

  const membersOf = (node: TsNode | null): readonly ObjectMember[] => {
    const object = ctx.ast.asObjectLiteral(node ?? undefined)
    if (object === null) return []

    return objectMembers(ctx.ast, object)
  }

  const memberNamed = (node: TsNode | null, name: string): ObjectMember | null =>
    membersOf(node).find((member) => member.name === name) ?? null

  const firstObjectLiteral = (node: TsNode): ts.ObjectLiteralExpression | null => {
    let found: ts.ObjectLiteralExpression | null = null
    walk(node, (candidate) => {
      if (found !== null) return
      found = ctx.ast.asObjectLiteral(candidate)
    })
    return found
  }

  /**
   * A `validateSearch` schema yields the search-param NAMES and nothing
   * else. `z.string()` vs `z.string().optional()` is a type question, so required-ness is reported as
   * unknown rather than guessed.
   */
  const searchParamsOf = (options: TsNode | null): readonly string[] => {
    const member = memberNamed(options, "validateSearch")
    if (member === null) return []

    const shape = firstObjectLiteral(member.value)
    return shape === null ? [] : sortedUnique(membersOf(shape).map((entry) => entry.name))
  }

  const scope = guardOptions.unauthenticatedTarget === null ? null : ctx.normalizeUrl(guardOptions.unauthenticatedTarget)

  /** The loader-guard reader keeps literal targets only; a direct `redirect({ to: paths.login })` is flattened here. */
  const flattenedTarget = (guard: LoaderGuard): string | null => {
    const call = guard.via === null && guard.node !== null ? ctx.ast.asCallExpression(guard.node) : null
    const target = call === null ? null : memberNamed(call.arguments[0] ?? null, "to")
    const flat = target === null || guard.file === null ? null : ctx.flattenString(target.value, guard.file)
    return flat === null || flat.dynamic ? null : ctx.normalizeUrl(flat.value)
  }

  const withFlattenedTarget = (guard: LoaderGuard): LoaderGuard => {
    const to = guard.to === null ? flattenedTarget(guard) : null
    if (to === null) return guard
    const label = guard.label.replace(UNREADABLE_TARGET, `redirect to '${to}'`)
    const located = { ...guard, to, label }
    return guard.scopedOut && to === scope ? { ...located, kind: "conditional", scopedOut: false } : located
  }

  /**
   * A bare `redirect` callee the app declares itself is no router redirect; the loader-guard reader
   * accepts any unbound `redirect`, so a direct site is re-checked against the TanStack callee rule.
   */
  const isRouterRedirect = (guard: LoaderGuard): boolean => {
    const call = guard.node === null ? null : ctx.ast.asCallExpression(guard.node)
    return guard.via !== null || call === null || guard.file === null || calleeName(call, guard.file) !== null
  }

  /** The route's `beforeLoad` classified by AS21 (`loader-guards`), scoped by `redirects.unauthenticated`. */
  const beforeLoadGuardOf = (options: TsNode | null, file: string): LoaderGuard | null => {
    const beforeLoad = memberNamed(options, "beforeLoad")
    if (beforeLoad === null) return null
    const guard = guardOfFunction(ctx, beforeLoad.value, file, { ...guardOptions, subject: "beforeLoad" })
    return guard.label === "" || !isRouterRedirect(guard) ? null : withFlattenedTarget(guard)
  }

  const guardText = (guard: LoaderGuard): string =>
    guard.scopedOut && scope !== null
      ? `${guard.label}; evidence only: not the unauthenticated target '${scope}'`
      : guard.label

  /** A conditional guard protects the route (and its descendants); an unconditional one is its `redirectTo`. */
  const optionEvidence = (options: TsNode | null, file: string, at: TsNode): readonly Evidence[] => {
    const evidence: Evidence[] = []
    const guard = beforeLoadGuardOf(options, file)
    if (guard !== null) evidence.push(ctx.evidence(guardText(guard), guard.file ?? file, guard.node ?? at))

    const searchParams = searchParamsOf(options)
    if (searchParams.length > 0)
      evidence.push(ctx.evidence(`validateSearch params: ${searchParams.join(", ")}`, file, options ?? at))
    return evidence
  }

  const reportSearchParams = (options: TsNode | null, file: string, subject: string, at: TsNode): void => {
    const searchParams = searchParamsOf(options)
    if (searchParams.length === 0) return
    ctx.diagnostic({
      severity: "info",
      code: "facts/needs-typechecker",
      message: `validateSearch on '${subject}' declares search params (${searchParams.join(", ")}); required-ness is NOT determined — telling z.string() from z.string().optional() needs a type checker, so treat every listed param as possibly optional`,
      file,
      line: ctx.lineOf(file, options ?? at),
    })
  }

  const dynamicImportSpec = (node: TsNode): string | null => {
    let spec: string | null = null
    walk(node, (candidate) => {
      if (spec !== null) return
      const call = ctx.ast.asCallExpression(candidate)
      if (call === null || call.expression.kind !== ctx.ts.SyntaxKind.ImportKeyword) return
      spec = ctx.ast.asStringLiteralLike(call.arguments[0])?.text ?? null
    })
    return spec
  }

  const isInlineComponent = (node: TsNode): boolean =>
    node.kind === ctx.ts.SyntaxKind.ArrowFunction || node.kind === ctx.ts.SyntaxKind.FunctionExpression

  /** `lazyRouteComponent(() => import('./Page'), 'Page')` names a module and an export (default `default`). */
  const lazyModuleOf = (call: ts.CallExpression, file: string): ComponentRef | null => {
    if (calleeName(call, file) !== LAZY_ROUTE_COMPONENT) return null
    const loader = call.arguments[0]
    const spec = loader === undefined ? null : dynamicImportSpec(loader)
    if (spec === null) return null
    const exported = ctx.ast.asStringLiteralLike(call.arguments[1])?.text ?? "default"
    return { kind: "lazy-module", file, spec, exported }
  }

  const componentOf = (options: TsNode | null, file: string): ComponentRef => {
    const member = memberNamed(options, "component")
    if (member === null) return { kind: "none" }

    const value = ctx.unwrap(member.value)
    if (isInlineComponent(value)) return { kind: "inline", file, node: value }

    const call = ctx.ast.asCallExpression(value)
    const lazy = call === null ? null : lazyModuleOf(call, file)
    if (lazy !== null) return lazy

    const identifier = ctx.ast.asIdentifier(value)
    if (identifier === null) return { kind: "opaque", file, node: value }

    if (importedBindingOf(ctx.bindingsFor(file).get(identifier.text)) !== null)
      return { kind: "imported", file, local: identifier.text }

    const source = ctx.sourceFile(file)
    const declared = source === null ? null : ctx.ast.declarationOf(source, identifier.text)
    return declared === null ? { kind: "opaque", file, node: value } : { kind: "local", file, name: identifier.text }
  }

  const entryOf = (ref: ComponentRef): EntryRef | null => {
    switch (ref.kind) {
      case "none":
        return null
      case "local":
        return { kind: "file", file: ref.file, exportName: ref.name }
      case "imported":
        return { kind: "binding", from: ref.file, local: ref.local }
      case "lazy-module":
        return { kind: "module", from: ref.file, spec: ref.spec, exported: ref.exported }
      case "inline": {
        const at = ctx.locatorOf(ref.node)
        return { kind: "file", file: ref.file, exportName: at.export, at }
      }
      case "opaque":
        return { kind: "opaque", expr: ref.node.getText(), file: ref.file, line: ctx.lineOf(ref.file, ref.node) }
    }
  }

  const scopeIn = (file: string, module: string, exportName: string): ScopeRef | null => {
    const declaring = ctx.resolveModule(file, module)
    return declaring === null ? null : ctx.declaredExport(declaring, exportName)
  }

  const scopeOf = (ref: ComponentRef, anchor: string): ScopeRef | null => {
    switch (ref.kind) {
      case "local":
        return { file: ref.file, exportName: ref.name }
      case "imported": {
        const imported = importedBindingOf(ctx.bindingsFor(ref.file).get(ref.local))
        return imported === null ? null : scopeIn(ref.file, imported.module, imported.imported)
      }
      case "lazy-module":
        return scopeIn(ref.file, ref.spec, ref.exported)
      case "inline":
        return { file: ref.file, exportName: anchor }
      case "none":
      case "opaque":
        return null
    }
  }

  /**
   * The route's page component as a screen entry — only when it resolves to a declaration this
   * source can read, so a caller can fall back to the route module instead of minting an opaque hole.
   */
  const pageEntryOf = (ref: ComponentRef): EntryRef | null => {
    if (ref.kind === "none" || ref.kind === "opaque") return null
    return scopeOf(ref, "") === null ? null : entryOf(ref)
  }

  const declarationScope = (source: ts.SourceFile, exportName: string): TsNode | null => {
    const declaration = ctx.ast.declarationOf(source, exportName)
    if (declaration === null || !ctx.ts.isExportAssignment(declaration)) return declaration
    const aliased = ctx.ast.asIdentifier(declaration.expression)
    return aliased === null ? declaration : (ctx.ast.declarationOf(source, aliased.text) ?? declaration)
  }

  const jsxIn = (scope: ScopeRef): readonly ts.JsxOpeningLikeElement[] => {
    const source = ctx.sourceFile(scope.file)
    const node = source === null ? null : declarationScope(source, scope.exportName)
    return node === null ? [] : ctx.ast.jsxElementsIn(node)
  }

  /**
   * Matched the same three ways the walk's splice detector matches it (`core/graph.ts`): the tag as
   * written, the name it was IMPORTED under, and the member of a namespace import.
   */
  const isOutlet = (file: string, element: ts.JsxOpeningLikeElement): boolean => {
    const written = ctx.ast.tagName(element)
    if (written === null) return false
    if (written === OUTLET_SPLICE.tag) return true
    const imported = importedBindingOf(ctx.bindingsFor(file).get(written))?.imported ?? null
    if (imported === OUTLET_SPLICE.tag) return true
    return imported === "*" && ctx.ast.asPropertyAccess(element.tagName)?.name.text === OUTLET_SPLICE.tag
  }

  const rendersOutlet = (scope: ScopeRef): boolean => jsxIn(scope).some((element) => isOutlet(scope.file, element))

  /** One imported component the scope renders that itself renders `<Outlet/>` — the route's real layout. */
  const delegatedOutlet = (scope: ScopeRef): ScopeRef | null => {
    const delegates = jsxIn(scope).flatMap((element): readonly ScopeRef[] => {
      const tag = ctx.ast.tagName(element)
      if (tag === null || !isComponentTag(tag)) return []
      const imported = importedBindingOf(ctx.bindingsFor(scope.file).get(tag))
      const target = imported === null ? null : scopeIn(scope.file, imported.module, imported.imported)
      return target !== null && rendersOutlet(target) ? [target] : []
    })
    const unique = [...new Map(delegates.map((target) => [`${target.file}|${target.exportName}`, target])).values()]
    return unique.length === 1 ? (unique[0] ?? null) : null
  }

  /**
   * The chain links one route contributes for its descendants. A scope that renders `<Outlet/>` is a
   * layout; one that delegates to exactly one imported layout rendering it splices THERE (the route's
   * own file stays reachable as a transparent link); otherwise the scope is handed over as-is and the
   * walk reports the missing splice point.
   */
  const outletAncestors = (scope: ScopeRef): readonly AncestorRef[] => {
    if (rendersOutlet(scope)) return [layoutAt(scope)]
    const delegate = delegatedOutlet(scope)
    if (delegate === null) return [layoutAt(scope)]
    return [transparentAt(scope.file, scope.exportName), layoutAt(delegate)]
  }

  return {
    calleeName,
    wrappedFactoryOf,
    membersOf,
    memberNamed,
    beforeLoadGuardOf,
    optionEvidence,
    reportSearchParams,
    dynamicImportSpec,
    componentOf,
    entryOf,
    pageEntryOf,
    scopeOf,
    rendersOutlet,
    outletAncestors,
    transparentAt,
  }
}

export type RouteOptionsReader = ReturnType<typeof createRouteOptionsReader>
