import type ts from "typescript"
import type { Located } from "../array-values.js"
import type { DiscoverContext, TsNode } from "../types.js"
import { importedBindingOf } from "../values.js"
import { SCRIPT_GLOB } from "../../core/extensions.js"
import { byCodepoint } from "../../core/order.js"
import { isNonAppFile } from "../../core/project.js"
import { ANGULAR_CORE_PACKAGE, projectAngularMajor } from "../../core/angular-compiler.js"
import { createAngularValues } from "./values.js"
import type { AngularElement, AngularUnreadable, Env } from "./values.js"

export type ClassRef = { readonly file: string; readonly name: string }

export type AngularDecorator = "Component" | "NgModule" | "Directive" | "Pipe"

export type RouteSourceKind = "forRoot" | "forChild" | "provideRouter"

export type RouteSource = {
  readonly kind: RouteSourceKind
  readonly node: Located
  readonly env: Env
  readonly owner: ClassRef | null
}

export type ModuleItem =
  | { readonly kind: "class"; readonly ref: ClassRef }
  | { readonly kind: "routes"; readonly source: RouteSource }

export type NgModuleInfo = {
  readonly imports: readonly ClassRef[]
  readonly exports: readonly ClassRef[]
  readonly declarations: readonly ClassRef[]
  readonly bootstrap: readonly ClassRef[]
  readonly routes: readonly RouteSource[]
  readonly importItems: readonly ModuleItem[]
  readonly exportItems: readonly ModuleItem[]
  readonly unreadable: readonly AngularUnreadable[]
}

export type RouteModules = {
  readonly routes: readonly RouteSource[]
  readonly unreadable: readonly AngularUnreadable[]
}

export type ComponentInfo = {
  readonly selector: string | null
  readonly templateUrl: string | null
  readonly inlineTemplate: Located | null
  readonly standalone: boolean | null
  readonly imports: readonly ClassRef[] | null
}

export type AngularBootstrap = {
  readonly kind: "standalone" | "module"
  readonly rootComponent: ClassRef | null
  readonly rootModule: ClassRef | null
  readonly routes: readonly RouteSource[]
}

type ItemFold = {
  readonly items: readonly ModuleItem[]
  readonly unreadable: readonly AngularUnreadable[]
}

type ClassLookup =
  | { readonly kind: "class"; readonly ref: ClassRef }
  | { readonly kind: "external" }
  | { readonly kind: "unknown" }

type Walk = {
  readonly seen: ReadonlySet<string>
  readonly routes: readonly RouteSource[]
  readonly unreadable: readonly AngularUnreadable[]
}

const ROUTER_PACKAGE = "@angular/router"

const PLATFORM_BROWSER_PACKAGE = "@angular/platform-browser"

const ROUTER_MODULE_METHODS = ["forRoot", "forChild"] as const

const MODULE_WITH_PROVIDERS_METHODS = ["forRoot", "forChild"] as const

const STANDALONE_DECORATORS = ["Component", "Directive", "Pipe"] as const satisfies readonly AngularDecorator[]

const STANDALONE_DEFAULT_MAJOR = 19

const BOOTSTRAP_MARKERS = ["bootstrapApplication(", "bootstrapModule("] as const

const MAX_NESTING = 16

const DEFAULT_EXPORT = "default"

const EXTERNAL: ClassLookup = { kind: "external" }

const UNKNOWN: ClassLookup = { kind: "unknown" }

const EMPTY_ITEMS: ItemFold = { items: [], unreadable: [] }

const EMPTY_WALK: Walk = { seen: new Set(), routes: [], unreadable: [] }

export const classKey = (ref: ClassRef): string => `${ref.file}#${ref.name}`

const combineItems = (folds: readonly ItemFold[]): ItemFold => ({
  items: folds.flatMap((fold) => fold.items),
  unreadable: folds.flatMap((fold) => fold.unreadable),
})

const classesOf = (items: readonly ModuleItem[]): readonly ClassRef[] =>
  items.flatMap((item) => (item.kind === "class" ? [item.ref] : []))

const routesOf = (items: readonly ModuleItem[]): readonly RouteSource[] =>
  items.flatMap((item) => (item.kind === "routes" ? [item.source] : []))

const isOneOf = <T extends string>(values: readonly T[], value: string): value is T =>
  values.some((candidate) => candidate === value)

const memoize = <K, V>(compute: (key: K) => V): ((key: K) => V) => {
  const cache = new Map<K, { readonly value: V }>()
  return (key) => {
    const hit = cache.get(key)
    if (hit !== undefined) return hit.value
    const value = compute(key)
    cache.set(key, { value })
    return value
  }
}

const once = <V>(compute: () => V): (() => V) => {
  const cached = memoize(compute)
  return () => cached(undefined)
}

const memoizeByClass = <V>(compute: (ref: ClassRef) => V): ((ref: ClassRef) => V) => {
  const cached = memoize((key: string) => {
    const at = key.lastIndexOf("#")
    return compute({ file: key.slice(0, at), name: key.slice(at + 1) })
  })
  return (ref) => cached(classKey(ref))
}

const appScripts = (ctx: DiscoverContext): readonly string[] =>
  ctx.glob(SCRIPT_GLOB).filter((file) => !isNonAppFile(file) && !ctx.isGenerated(file))

const filesContaining = (ctx: DiscoverContext, markers: readonly string[]): readonly string[] =>
  appScripts(ctx).filter((file) => {
    const text = ctx.readFile(file)
    return text !== null && markers.some((marker) => text.includes(marker))
  })

export const createAngularProject = (ctx: DiscoverContext) => {
  const values = createAngularValues(ctx)

  const importsOf = (file: string): readonly ts.ImportDeclaration[] =>
    ctx.sourceFile(file)?.statements.filter((statement) => ctx.ts.isImportDeclaration(statement)) ?? []

  const fromPackage = (declaration: ts.ImportDeclaration, module: string): boolean =>
    ctx.ast.asStringLiteralLike(declaration.moduleSpecifier)?.text === module

  const namedImports = (declaration: ts.ImportDeclaration): readonly ts.ImportSpecifier[] => {
    const bindings = declaration.importClause?.namedBindings
    return bindings !== undefined && ctx.ts.isNamedImports(bindings) ? bindings.elements : []
  }

  const localNameOf = (file: string, module: string, exported: string): string =>
    importsOf(file)
      .filter((declaration) => fromPackage(declaration, module))
      .flatMap(namedImports)
      .find((specifier) => (specifier.propertyName ?? specifier.name).text === exported)?.name.text ?? exported

  const decoratorLocalName = (file: string, exported: AngularDecorator): string =>
    localNameOf(file, ANGULAR_CORE_PACKAGE, exported)

  const refersTo = (identifier: ts.Identifier, file: string, module: string, exported: string): boolean => {
    const binding = ctx.bindingsFor(file).get(identifier.text)
    const imported = importedBindingOf(binding)
    if (imported !== null) return imported.module === module && imported.imported === exported
    return binding === null && identifier.text === exported
  }

  const topLevelClass = (file: string, name: string): ts.ClassDeclaration | null =>
    ctx
      .sourceFile(file)
      ?.statements.find(
        (statement): statement is ts.ClassDeclaration =>
          ctx.ts.isClassDeclaration(statement) && statement.name?.text === name,
      ) ?? null

  const defaultClassName = (file: string): string | null => {
    const source = ctx.sourceFile(file)
    const declaration = source === null ? null : ctx.ast.declarationOf(source, DEFAULT_EXPORT)
    if (declaration === null) return null
    if (ctx.ts.isClassDeclaration(declaration)) return declaration.name?.text ?? null
    if (!ctx.ts.isExportAssignment(declaration) || declaration.isExportEquals === true) return null
    return ctx.ast.asIdentifier(declaration.expression)?.text ?? null
  }

  const exportNameOf = (ref: ClassRef): string => (defaultClassName(ref.file) === ref.name ? DEFAULT_EXPORT : ref.name)

  const classIn = (file: string, exported: string): ClassLookup => {
    const declaring = ctx.declarationFile(file, exported)
    const name = exported === DEFAULT_EXPORT ? defaultClassName(declaring) : exported
    if (name === null || topLevelClass(declaring, name) === null) return UNKNOWN
    return { kind: "class", ref: { file: declaring, name } }
  }

  const lookupClass = (identifier: ts.Identifier, file: string): ClassLookup => {
    const imported = importedBindingOf(ctx.bindingsFor(file).get(identifier.text))
    if (imported === null) {
      return topLevelClass(file, identifier.text) === null
        ? UNKNOWN
        : { kind: "class", ref: { file, name: identifier.text } }
    }
    const target = ctx.resolveModule(file, imported.module)
    return target === null ? EXTERNAL : classIn(target, imported.imported)
  }

  const classRef = (identifier: ts.Identifier, file: string): ClassRef | null => {
    const found = lookupClass(identifier, file)
    return found.kind === "class" ? found.ref : null
  }

  const classDeclaration = memoizeByClass((ref) => topLevelClass(ref.file, ref.name))

  const decoratorObject = (ref: ClassRef, decorator: AngularDecorator): ts.ObjectLiteralExpression | null => {
    const declaration = classDeclaration(ref)
    if (declaration === null) return null
    return ctx.ast.decoratorArgument(declaration, decoratorLocalName(ref.file, decorator))
  }

  const unreadableItem = (node: TsNode, file: string): ItemFold => ({
    items: [],
    unreadable: [values.resolver.unreadableAt(node, file)],
  })

  const classItem = (ref: ClassRef): ItemFold => ({ items: [{ kind: "class", ref }], unreadable: [] })

  const routerModuleItem = (
    call: ts.CallExpression,
    kind: RouteSourceKind,
    element: AngularElement,
    owner: ClassRef | null,
  ): ItemFold => {
    const argument = call.arguments[0]
    if (argument === undefined) return unreadableItem(call, element.file)
    const node = { node: ctx.unwrap(argument), file: element.file }
    return { items: [{ kind: "routes", source: { kind, node, env: element.env, owner } }], unreadable: [] }
  }

  const callItem = (call: ts.CallExpression, element: AngularElement, owner: ClassRef | null): ItemFold => {
    const callee = ctx.ast.asPropertyAccess(call.expression)
    const receiver = ctx.ast.asIdentifier(callee?.expression)
    if (callee === null || receiver === null) return unreadableItem(call, element.file)
    const method = callee.name.text
    if (isOneOf(ROUTER_MODULE_METHODS, method) && refersTo(receiver, element.file, ROUTER_PACKAGE, "RouterModule"))
      return routerModuleItem(call, method, element, owner)
    const found = lookupClass(receiver, element.file)
    if (found.kind === "class") return classItem(found.ref)
    if (found.kind === "external" && isOneOf(MODULE_WITH_PROVIDERS_METHODS, method)) return EMPTY_ITEMS
    return unreadableItem(call, element.file)
  }

  const nestedItems = (identifier: ts.Identifier, element: AngularElement, owner: ClassRef | null, depth: number) => {
    const bound = values.valueOf(identifier, element.file, element.env)
    if (bound === null || ctx.ast.asArrayLiteral(bound.node) === null) return unreadableItem(identifier, element.file)
    return foldItems(bound.node, bound.file, element.env, owner, depth + 1)
  }

  const identifierItem = (
    identifier: ts.Identifier,
    element: AngularElement,
    owner: ClassRef | null,
    depth: number,
  ): ItemFold => {
    const found = lookupClass(identifier, element.file)
    if (found.kind === "class") return classItem(found.ref)
    if (found.kind === "external") return EMPTY_ITEMS
    return nestedItems(identifier, element, owner, depth)
  }

  const elementItems = (element: AngularElement, owner: ClassRef | null, depth: number): ItemFold => {
    const identifier = ctx.ast.asIdentifier(element.node)
    if (identifier !== null) return identifierItem(identifier, element, owner, depth)
    const call = ctx.ast.asCallExpression(element.node)
    if (call !== null) return callItem(call, element, owner)
    if (ctx.ast.asArrayLiteral(element.node) !== null)
      return foldItems(element.node, element.file, element.env, owner, depth + 1)
    return unreadableItem(element.node, element.file)
  }

  const foldItems = (node: TsNode, file: string, env: Env, owner: ClassRef | null, depth: number): ItemFold => {
    if (depth > MAX_NESTING) return unreadableItem(node, file)
    const fold = values.arrayOf(node, file, env)
    return combineItems([
      ...fold.elements.map((element) => elementItems(element, owner, depth)),
      { items: [], unreadable: fold.unreadable },
    ])
  }

  const memberItems = (object: ts.ObjectLiteralExpression, file: string, name: string, owner: ClassRef | null) => {
    const member = values.membersOf(object, file).members.find((candidate) => candidate.name === name)
    if (member === undefined) return EMPTY_ITEMS
    return foldItems(member.value.node, member.value.file, member.env, owner, 0)
  }

  const ngModuleOf = memoizeByClass((ref): NgModuleInfo | null => {
    const object = decoratorObject(ref, "NgModule")
    if (object === null) return null
    const imports = memberItems(object, ref.file, "imports", ref)
    const exports = memberItems(object, ref.file, "exports", ref)
    const declarations = memberItems(object, ref.file, "declarations", ref)
    const bootstrap = memberItems(object, ref.file, "bootstrap", ref)
    return {
      imports: classesOf(imports.items),
      exports: classesOf(exports.items),
      declarations: classesOf(declarations.items),
      bootstrap: classesOf(bootstrap.items),
      routes: routesOf(imports.items),
      importItems: imports.items,
      exportItems: exports.items,
      unreadable: [...imports.unreadable, ...exports.unreadable, ...declarations.unreadable, ...bootstrap.unreadable],
    }
  })

  const walkModule = (state: Walk, ref: ClassRef): Walk => {
    const key = classKey(ref)
    if (state.seen.has(key)) return state
    const entered: Walk = { ...state, seen: new Set([...state.seen, key]) }
    const info = ngModuleOf(ref)
    if (info === null) return entered
    const withOwn: Walk = { ...entered, unreadable: [...entered.unreadable, ...info.unreadable] }
    return [...info.importItems, ...info.exportItems].reduce(walkItem, withOwn)
  }

  const walkItem = (state: Walk, item: ModuleItem): Walk =>
    item.kind === "routes" ? { ...state, routes: [...state.routes, item.source] } : walkModule(state, item.ref)

  const routeModules = (rootModule: ClassRef): RouteModules => {
    const walked = walkModule(EMPTY_WALK, rootModule)
    return { routes: walked.routes, unreadable: walked.unreadable }
  }

  const childNodes = (node: TsNode): readonly TsNode[] => {
    const children: TsNode[] = []
    node.forEachChild((child) => {
      children.push(child)
    })
    return children
  }

  const callsIn = (node: TsNode): readonly ts.CallExpression[] => {
    const nested = childNodes(node).flatMap(callsIn)
    return ctx.ts.isCallExpression(node) ? [node, ...nested] : nested
  }

  const provideRouterSource = (element: AngularElement): readonly RouteSource[] => {
    const call = ctx.ast.asCallExpression(element.node)
    const callee = ctx.ast.asIdentifier(call?.expression)
    const argument = call?.arguments[0]
    if (callee === null || argument === undefined) return []
    if (!refersTo(callee, element.file, ROUTER_PACKAGE, "provideRouter")) return []
    return [{ kind: "provideRouter", node: { node: ctx.unwrap(argument), file: element.file }, env: element.env, owner: null }]
  }

  const providerRoutes = (config: TsNode | undefined, file: string): readonly RouteSource[] => {
    if (config === undefined) return []
    const providers = values.membersOf(config, file).members.find((member) => member.name === "providers")
    if (providers === undefined) return []
    return values.arrayOf(providers.value.node, providers.value.file, providers.env).elements.flatMap(provideRouterSource)
  }

  const standaloneBootstrap = (call: ts.CallExpression, file: string): AngularBootstrap | null => {
    const callee = ctx.ast.asIdentifier(call.expression)
    if (callee === null || !refersTo(callee, file, PLATFORM_BROWSER_PACKAGE, "bootstrapApplication")) return null
    const root = ctx.ast.asIdentifier(call.arguments[0])
    return {
      kind: "standalone",
      rootComponent: root === null ? null : classRef(root, file),
      rootModule: null,
      routes: providerRoutes(call.arguments[1], file),
    }
  }

  const moduleBootstrap = (call: ts.CallExpression, file: string): AngularBootstrap | null => {
    const callee = ctx.ast.asPropertyAccess(call.expression)
    if (callee === null || callee.name.text !== "bootstrapModule") return null
    const argument = ctx.ast.asIdentifier(call.arguments[0])
    const rootModule = argument === null ? null : classRef(argument, file)
    if (rootModule === null) return { kind: "module", rootComponent: null, rootModule: null, routes: [] }
    return {
      kind: "module",
      rootComponent: ngModuleOf(rootModule)?.bootstrap[0] ?? null,
      rootModule,
      routes: routeModules(rootModule).routes,
    }
  }

  const bootstrapIn = (file: string): AngularBootstrap | null => {
    const source = ctx.sourceFile(file)
    if (source === null) return null
    return (
      callsIn(source)
        .map((call) => standaloneBootstrap(call, file) ?? moduleBootstrap(call, file))
        .find((found) => found !== null) ?? null
    )
  }

  const bootstrap = once((): AngularBootstrap | null =>
    filesContaining(ctx, BOOTSTRAP_MARKERS).reduce<AngularBootstrap | null>(
      (found, file) => found ?? bootstrapIn(file),
      null,
    ),
  )

  const literalString = (node: TsNode | undefined): string | null => ctx.ast.asStringLiteralLike(node)?.text ?? null

  const literalBoolean = (node: TsNode | undefined): boolean | null => {
    if (node === undefined) return null
    const inner = ctx.unwrap(node)
    if (inner.kind === ctx.ts.SyntaxKind.TrueKeyword) return true
    if (inner.kind === ctx.ts.SyntaxKind.FalseKeyword) return false
    return null
  }

  const memberValue = (object: ts.ObjectLiteralExpression, file: string, name: string): Located | null =>
    values.membersOf(object, file).members.find((member) => member.name === name)?.value ?? null

  const componentImports = (object: ts.ObjectLiteralExpression, ref: ClassRef): readonly ClassRef[] | null => {
    const fold = memberItems(object, ref.file, "imports", ref)
    return fold.unreadable.length === 0 ? classesOf(fold.items) : null
  }

  const componentOf = memoizeByClass((ref): ComponentInfo | null => {
    const object = decoratorObject(ref, "Component")
    if (object === null) return null
    return {
      selector: literalString(memberValue(object, ref.file, "selector")?.node),
      templateUrl: literalString(memberValue(object, ref.file, "templateUrl")?.node),
      inlineTemplate: memberValue(object, ref.file, "template"),
      standalone: literalBoolean(memberValue(object, ref.file, "standalone")?.node),
      imports: componentImports(object, ref),
    }
  })

  const standaloneLiteral = (ref: ClassRef): boolean | null =>
    STANDALONE_DECORATORS.map((decorator) => decoratorObject(ref, decorator))
      .filter((object) => object !== null)
      .map((object) => literalBoolean(memberValue(object, ref.file, "standalone")?.node))
      .find((value) => value !== null) ?? null

  const projectMajor = once((): number | null => {
    const manifest = ctx.readFile("package.json")
    return manifest === null ? null : projectAngularMajor(manifest)
  })

  const isStandalone = (ref: ClassRef, major: number | null = projectMajor()): boolean =>
    standaloneLiteral(ref) ?? (major === null || major >= STANDALONE_DEFAULT_MAJOR)

  const moduleClassesIn = (file: string): readonly ClassRef[] => {
    const local = decoratorLocalName(file, "NgModule")
    return (ctx.sourceFile(file)?.statements ?? [])
      .flatMap((statement) => (ctx.ts.isClassDeclaration(statement) ? [statement] : []))
      .filter((statement) => ctx.ast.decoratorArgument(statement, local) !== null)
      .flatMap((statement) => (statement.name === undefined ? [] : [statement.name.text]))
      .sort(byCodepoint)
      .map((name) => ({ file, name }))
  }

  const ngModules = once((): readonly ClassRef[] =>
    filesContaining(ctx, ["NgModule"]).flatMap(moduleClassesIn),
  )

  const declarationIndex = once((): ReadonlyMap<string, ClassRef> => {
    const pairs = ngModules().flatMap((module) =>
      (ngModuleOf(module)?.declarations ?? []).map((declared) => [classKey(declared), module] as const),
    )
    return new Map([...pairs].reverse())
  })

  return {
    classKey,
    classRef,
    defaultClassName,
    exportNameOf,
    decoratorLocalName,
    ngModuleOf,
    routeModules,
    bootstrap,
    componentOf,
    isStandalone,
    projectMajor,
    ngModules,
    declaringModuleOf: (ref: ClassRef): ClassRef | null => declarationIndex().get(classKey(ref)) ?? null,
    values,
  }
}

export type AngularProject = ReturnType<typeof createAngularProject>
