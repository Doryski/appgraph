import type ts from "typescript"
import type { Binding, BindingTable } from "./model.js"
import type { TypeScriptApi } from "./tsconfig.js"
import { createAst, walk } from "./ast.js"
import { sortedUnique } from "./order.js"

export type ModulePattern = string | RegExp

// Widens `BindingTable`'s `string` module parameters to accept a RegExp, so one call covers
// react-router v6/v7 and the HTTP-client family. The widened signatures stay assignable to
// `BindingTable` (parameters are contravariant), which `test/core/bindings.test.ts` asserts.
export type FileBindingTable = Omit<BindingTable, "isHookResult" | "rootsInModule"> & {
  readonly isHookResult: (local: string, hook: string, module?: ModulePattern, index?: number) => boolean
  readonly rootsInModule: (local: string, module: ModulePattern) => boolean
  readonly rootIdentifier: (expr: ts.Node) => string | null
  readonly rootsIn: (expr: ts.Node, module: ModulePattern) => boolean
  readonly memberBinding: (expr: ts.Expression) => MemberBinding | null
  readonly classMemberBinding: (owner: ts.ClassLikeDeclaration, name: string) => MemberBinding | null
  readonly importedFiles: readonly string[]
  readonly importedModules: readonly string[]
  readonly locals: readonly string[]
  readonly lazyExports: readonly LazyTarget[]
}

export type MemberBinding = { readonly module: string; readonly imported: string }

export type LazyTarget = Extract<Binding, { readonly kind: "dynamic-import" }>

export type BindingTableOptions = {
  readonly ts: TypeScriptApi
  readonly source: ts.SourceFile
  readonly resolveModule?: (specifier: string) => string | null
}

const LAZY_FACTORIES = [
  { module: "react", imported: "lazy" },
  { module: "next/dynamic", imported: "default" },
  { module: "@loadable/component", imported: "default" },
  { module: "vue", imported: "defineAsyncComponent" },
] as const

const INJECT_FUNCTION = { module: "@angular/core", imported: "inject" } as const

const matchesModule = (module: string | null, pattern: ModulePattern): boolean => {
  if (module === null) return false
  return typeof pattern === "string" ? module === pattern : pattern.test(module)
}

const moduleOfBinding = (binding: Binding | null): string | null => {
  if (binding === null) return null
  if (binding.kind === "import" || binding.kind === "dynamic-import") return binding.module
  if (binding.kind === "hook-result") return binding.module
  return null
}

export const createBindingTable = (options: BindingTableOptions): FileBindingTable => {
  const api = options.ts
  const source = options.source
  const ast = createAst(api)
  const resolveModule = options.resolveModule ?? (() => null)

  const bindings = new Map<string, Binding>()
  const importedFiles: string[] = []
  const importedModules: string[] = []
  const locals: string[] = []
  // Element index of an array-destructured hook result: wouter's `const [, navigate] = useLocation()`.
  const hookIndexes = new Map<string, number>()

  const set = (local: string, binding: Binding): void => {
    if (bindings.has(local)) return
    bindings.set(local, binding)
    if (binding.kind === "local") locals.push(local)
  }

  const bindNames = (name: ts.BindingName, binding: (property: string | null) => Binding): void => {
    if (api.isIdentifier(name)) {
      set(name.text, binding(null))
      return
    }

    if (api.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        if (!api.isIdentifier(element.name)) continue
        const property = element.propertyName === undefined ? element.name.text : element.propertyName.getText()
        set(element.name.text, binding(property))
      }
      return
    }

    for (const element of name.elements) {
      if (!api.isBindingElement(element) || !api.isIdentifier(element.name)) continue
      set(element.name.text, binding(element.name.text))
    }
  }

  const collectModuleReferences = (): void => {
    for (const reference of ast.moduleReferences(source)) {
      if (reference.typeOnly) continue
      const file = resolveModule(reference.specifier)
      importedModules.push(reference.specifier)
      if (file !== null) importedFiles.push(file)
    }
  }

  const collectImports = (): void => {
    for (const statement of source.statements) {
      if (!api.isImportDeclaration(statement) || !api.isStringLiteral(statement.moduleSpecifier)) continue

      const module = statement.moduleSpecifier.text
      const file = resolveModule(module)

      const clause = statement.importClause
      if (clause === undefined) continue
      if (clause.name !== undefined) set(clause.name.text, { kind: "import", module, imported: "default", file })
      if (clause.namedBindings === undefined) continue
      if (api.isNamespaceImport(clause.namedBindings))
        set(clause.namedBindings.name.text, { kind: "import", module, imported: "*", file })
      if (api.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements)
          set(element.name.text, {
            kind: "import",
            module,
            imported: element.propertyName?.text ?? element.name.text,
            file,
          })
    }
  }

  const withoutAwait = (node: ts.Node): ts.Node => {
    const inner = ast.unwrap(node)
    return api.isAwaitExpression(inner) ? ast.unwrap(inner.expression) : inner
  }

  const dynamicModuleOf = (node: ts.Node | undefined): { module: string; file: string | null } | null => {
    if (node === undefined) return null
    const call = ast.asCallExpression(withoutAwait(node))
    if (call === null || call.expression.kind !== api.SyntaxKind.ImportKeyword) return null

    const specifier = ast.asStringLiteralLike(call.arguments[0])
    if (specifier === null) return null
    return { module: specifier.text, file: resolveModule(specifier.text) }
  }

  const isLazyFactory = (callee: ts.Node): boolean => {
    const identifier = ast.asIdentifier(callee)
    if (identifier !== null) {
      const bound = bindings.get(identifier.text)
      if (bound === undefined || bound.kind !== "import") return false
      return LAZY_FACTORIES.some((factory) => factory.module === bound.module && factory.imported === bound.imported)
    }

    const access = ast.asPropertyAccess(callee)
    const root = access === null ? null : ast.asIdentifier(access.expression)
    if (access === null || root === null) return false
    const bound = bindings.get(root.text)
    if (bound === undefined || bound.kind !== "import") return false
    if (bound.imported !== "default" && bound.imported !== "*") return false
    return LAZY_FACTORIES.some((factory) => factory.module === bound.module && factory.imported === access.name.text)
  }

  const returnedExpression = (fn: ts.Node | undefined): ts.Node | null => {
    if (fn === undefined) return null
    const inner = ast.unwrap(fn)
    if (!api.isArrowFunction(inner) && !api.isFunctionExpression(inner)) return null
    if (!api.isBlock(inner.body)) return ast.unwrap(inner.body)

    const [only] = inner.body.statements
    if (inner.body.statements.length !== 1 || only === undefined || !api.isReturnStatement(only)) return null
    return only.expression === undefined ? null : ast.unwrap(only.expression)
  }

  const memberOfParameter = (expr: ts.Node | null, parameter: string): string | null => {
    const access = ast.asPropertyAccess(expr ?? undefined)
    if (access === null) return null
    const root = ast.asIdentifier(access.expression)
    return root !== null && root.text === parameter ? access.name.text : null
  }

  const defaultPropertyOf = (expr: ts.Node | null): ts.Node | null => {
    const object = ast.asObjectLiteral(expr ?? undefined)
    if (object === null || object.properties.length !== 1) return null
    const [property] = object.properties
    if (property === undefined || !api.isPropertyAssignment(property)) return null
    if (!api.isIdentifier(property.name) || property.name.text !== "default") return null
    return ast.unwrap(property.initializer)
  }

  const pickedExport = (callback: ts.Node | undefined): string | null => {
    const fn = callback === undefined ? null : ast.unwrap(callback)
    if (fn === null || (!api.isArrowFunction(fn) && !api.isFunctionExpression(fn))) return null
    const [parameter] = fn.parameters
    if (fn.parameters.length !== 1 || parameter === undefined || !api.isIdentifier(parameter.name)) return null

    const body = returnedExpression(fn)
    const name = parameter.name.text
    return memberOfParameter(body, name) ?? memberOfParameter(defaultPropertyOf(body), name)
  }

  const lazyModuleOf = (node: ts.Node): { module: string; file: string | null; imported: string } | null => {
    const call = ast.asCallExpression(node)
    if (call === null || !isLazyFactory(call.expression)) return null

    const loaded = returnedExpression(call.arguments[0])
    if (loaded === null) return null

    const direct = dynamicModuleOf(loaded)
    if (direct !== null) return { ...direct, imported: "default" }

    const then = ast.asCallExpression(loaded)
    const access = then === null ? null : ast.asPropertyAccess(then.expression)
    if (then === null || access === null || access.name.text !== "then") return null

    const target = dynamicModuleOf(access.expression)
    const imported = pickedExport(then.arguments[0])
    if (target === null || imported === null) return null
    return { ...target, imported }
  }

  const collectDynamicImports = (): void => {
    walk(source, (node) => {
      if (!api.isVariableDeclaration(node) || !node.initializer) return
      const initializer = withoutAwait(node.initializer)

      const lazy = lazyModuleOf(initializer)
      if (lazy !== null && api.isIdentifier(node.name)) {
        set(node.name.text, { kind: "dynamic-import", module: lazy.module, imported: lazy.imported, file: lazy.file })
        return
      }

      const single = dynamicModuleOf(initializer)
      if (single !== null && api.isObjectBindingPattern(node.name)) {
        bindNames(node.name, (property) => ({
          kind: "dynamic-import",
          module: single.module,
          imported: property ?? "default",
          file: single.file,
        }))
        return
      }

      const call = ast.asCallExpression(initializer)
      if (call === null || !api.isArrayBindingPattern(node.name)) return

      const list = ast.asArrayLiteral(call.arguments[0])
      if (list === null) return

      node.name.elements.forEach((element, index) => {
        if (!api.isBindingElement(element) || !api.isObjectBindingPattern(element.name)) return
        const entry = dynamicModuleOf(list.elements[index])
        if (entry === null) return
        bindNames(element.name, (property) => ({
          kind: "dynamic-import",
          module: entry.module,
          imported: property ?? "default",
          file: entry.file,
        }))
      })
    })
  }

  const requiredModuleOf = (node: ts.Node): string | null => {
    const call = ast.asCallExpression(node)
    const callee = call === null ? null : ast.asIdentifier(call.expression)
    if (call === null || callee === null || callee.text !== "require" || call.arguments.length !== 1) return null
    if (bindings.has("require")) return null
    const specifier = call.arguments[0]
    return specifier !== undefined && api.isStringLiteralLike(specifier) ? specifier.text : null
  }

  const requiredOf = (initializer: ts.Node): { module: string; member: string | null } | null => {
    const inner = ast.unwrap(initializer)
    const direct = requiredModuleOf(inner)
    if (direct !== null) return { module: direct, member: null }

    const access = ast.asPropertyAccess(inner)
    const module = access === null ? null : requiredModuleOf(ast.unwrap(access.expression))
    return access === null || module === null ? null : { module, member: access.name.text }
  }

  const collectRequires = (): void => {
    walk(source, (node) => {
      if (!api.isVariableDeclaration(node) || !node.initializer) return
      const required = requiredOf(node.initializer)
      if (required === null) return

      const module = required.module
      const file = resolveModule(module)
      importedModules.push(module)
      if (file !== null) importedFiles.push(file)

      if (api.isArrayBindingPattern(node.name)) return
      if (required.member !== null && !api.isIdentifier(node.name)) return
      bindNames(node.name, (property) => ({
        kind: "import",
        module,
        imported: required.member ?? property ?? "default",
        file,
      }))
    })
  }

  const calleeOf = (call: ts.CallExpression): { hook: string; module: string | null } | null => {
    const identifier = ast.asIdentifier(call.expression)
    if (identifier !== null) {
      const bound = bindings.get(identifier.text)
      if (bound === undefined) return { hook: identifier.text, module: null }
      if (bound.kind !== "import" && bound.kind !== "dynamic-import")
        return { hook: identifier.text, module: null }
      return {
        hook: bound.imported === "default" || bound.imported === "*" ? identifier.text : bound.imported,
        module: bound.module,
      }
    }

    const access = ast.asPropertyAccess(call.expression)
    if (access === null) return null

    const root = ast.asIdentifier(access.expression)
    if (root === null) return null
    const bound = bindings.get(root.text)
    if (bound === undefined || (bound.kind !== "import" && bound.kind !== "dynamic-import")) return null
    return { hook: access.name.text, module: bound.module }
  }

  const bindTuple = (pattern: ts.ArrayBindingPattern, binding: Binding): void => {
    pattern.elements.forEach((element, index) => {
      if (!api.isBindingElement(element) || !api.isIdentifier(element.name)) return
      const local = element.name.text
      if (bindings.has(local)) return
      set(local, binding)
      if (element.dotDotDotToken === undefined) hookIndexes.set(local, index)
    })
  }

  const collectCallResults = (): void => {
    walk(source, (node) => {
      if (!api.isVariableDeclaration(node) || !node.initializer) return
      const call = ast.asCallExpression(node.initializer)
      if (call === null || call.expression.kind === api.SyntaxKind.ImportKeyword) return

      const callee = calleeOf(call)
      if (callee === null) return

      const binding: Binding = { kind: "hook-result", hook: callee.hook, module: callee.module }
      if (api.isArrayBindingPattern(node.name)) {
        bindTuple(node.name, binding)
        return
      }
      bindNames(node.name, () => binding)
    })
  }

  const collectLocals = (): void => {
    walk(source, (node) => {
      if (api.isVariableDeclaration(node) || api.isBindingElement(node) || api.isParameter(node)) {
        if (api.isIdentifier(node.name)) set(node.name.text, { kind: "local", declaredAt: node.getStart(source) })
        return
      }
      if (api.isFunctionDeclaration(node) || api.isClassDeclaration(node)) {
        if (node.name !== undefined) set(node.name.text, { kind: "local", declaredAt: node.getStart(source) })
      }
    })
  }

  const hasExportModifier = (node: ts.Node): boolean =>
    api.canHaveModifiers(node) && (api.getModifiers(node) ?? []).some((m) => m.kind === api.SyntaxKind.ExportKeyword)

  const lazyTargetOf = (node: ts.Node | undefined): LazyTarget | null => {
    const lazy = node === undefined ? null : lazyModuleOf(withoutAwait(node))
    return lazy === null ? null : { kind: "dynamic-import", ...lazy }
  }

  // `export const VIEWS = { list: lazy(() => import('./List')) }`: a registry of lazy components is as
  // much a lazy export as `export const List = lazy(...)`.
  const registryMembersOf = (initializer: ts.Node): readonly ts.Node[] => {
    const inner = ast.unwrap(initializer)
    if (api.isArrayLiteralExpression(inner)) return [...inner.elements]
    if (!api.isObjectLiteralExpression(inner)) return []
    return inner.properties.flatMap((property) => (api.isPropertyAssignment(property) ? [property.initializer] : []))
  }

  const lazyTargetsOf = (initializer: ts.Node | undefined): readonly LazyTarget[] => {
    if (initializer === undefined) return []
    const direct = lazyTargetOf(initializer)
    if (direct !== null) return [direct]
    return registryMembersOf(initializer).flatMap((member) => {
      const target = lazyTargetOf(member)
      return target === null ? [] : [target]
    })
  }

  const moduleLazyDeclarations = (): ReadonlyMap<string, readonly LazyTarget[]> =>
    new Map(
      source.statements
        .filter(api.isVariableStatement)
        .flatMap((statement) => [...statement.declarationList.declarations])
        .flatMap((declaration) => {
          const targets = lazyTargetsOf(declaration.initializer)
          return targets.length > 0 && api.isIdentifier(declaration.name)
            ? [[declaration.name.text, targets] as const]
            : []
        }),
    )

  const exportedLocals = (statement: ts.Statement): readonly string[] => {
    if (api.isVariableStatement(statement))
      return hasExportModifier(statement)
        ? statement.declarationList.declarations.flatMap((d) => (api.isIdentifier(d.name) ? [d.name.text] : []))
        : []
    if (api.isExportAssignment(statement)) {
      const identifier = ast.asIdentifier(ast.unwrap(statement.expression))
      return identifier === null ? [] : [identifier.text]
    }
    if (!api.isExportDeclaration(statement) || statement.moduleSpecifier !== undefined) return []
    const clause = statement.exportClause
    if (clause === undefined || !api.isNamedExports(clause)) return []
    return clause.elements.map((element) => (element.propertyName ?? element.name).text)
  }

  const directLazyExport = (statement: ts.Statement): readonly LazyTarget[] => {
    const target = api.isExportAssignment(statement) ? lazyTargetOf(statement.expression) : null
    return target === null ? [] : [target]
  }

  const collectLazyExports = (): readonly LazyTarget[] => {
    const declared = moduleLazyDeclarations()
    return source.statements.flatMap((statement) => [
      ...directLazyExport(statement),
      ...exportedLocals(statement).flatMap((local) => declared.get(local) ?? []),
    ])
  }

  collectModuleReferences()
  collectImports()
  collectDynamicImports()
  collectRequires()
  collectCallResults()
  collectLocals()

  const get = (local: string): Binding | null => bindings.get(local) ?? null

  const moduleOf = (local: string): string | null => moduleOfBinding(get(local))

  const rootsInModule = (local: string, pattern: ModulePattern): boolean =>
    matchesModule(moduleOf(local), pattern)

  const isHookResult = (local: string, hook: string, module?: ModulePattern, index?: number): boolean => {
    const binding = get(local)
    if (binding === null || binding.kind !== "hook-result" || binding.hook !== hook) return false
    if (index !== undefined && hookIndexes.get(local) !== index) return false
    return module === undefined || matchesModule(binding.module, module)
  }

  const rootIdentifier = (expr: ts.Node): string | null => {
    let current = ast.unwrap(expr)

    for (;;) {
      if (api.isPropertyAccessExpression(current) || api.isElementAccessExpression(current)) {
        current = ast.unwrap(current.expression)
        continue
      }
      if (api.isCallExpression(current)) {
        current = ast.unwrap(current.expression)
        continue
      }
      break
    }

    return api.isIdentifier(current) ? current.text : null
  }

  const rootsIn = (expr: ts.Node, module: ModulePattern): boolean => {
    const root = rootIdentifier(expr)
    return root !== null && rootsInModule(root, module)
  }

  const parameterPropertyKinds: readonly ts.SyntaxKind[] = [
    api.SyntaxKind.PrivateKeyword,
    api.SyntaxKind.PublicKeyword,
    api.SyntaxKind.ProtectedKeyword,
    api.SyntaxKind.ReadonlyKeyword,
  ]

  const isThis = (node: ts.Node): boolean => ast.unwrap(node).kind === api.SyntaxKind.ThisKeyword

  const thisMemberOf = (node: ts.Node): ts.PropertyAccessExpression | null => {
    const current = ast.unwrap(node)
    if (api.isPropertyAccessExpression(current))
      return isThis(current.expression) ? current : thisMemberOf(current.expression)
    if (api.isElementAccessExpression(current) || api.isCallExpression(current)) return thisMemberOf(current.expression)
    return null
  }

  const isObjectLiteralMember = (node: ts.Node): boolean =>
    (api.isMethodDeclaration(node) || api.isGetAccessorDeclaration(node) || api.isSetAccessorDeclaration(node)) &&
    api.isObjectLiteralExpression(node.parent)

  const enclosingClass = (node: ts.Node | undefined): ts.ClassLikeDeclaration | null => {
    if (node === undefined) return null
    if (api.isClassLike(node)) return node
    if (api.isFunctionDeclaration(node) || api.isFunctionExpression(node) || isObjectLiteralMember(node)) return null
    return enclosingClass(node.parent)
  }

  const memberName = (name: ts.Node): string | null =>
    api.isIdentifier(name) || api.isPrivateIdentifier(name) ? name.text : null

  const isParameterProperty = (parameter: ts.ParameterDeclaration): boolean =>
    (api.getModifiers(parameter) ?? []).some((modifier) => parameterPropertyKinds.includes(modifier.kind))

  const parameterPropertyNamed = (
    owner: ts.ClassLikeDeclaration,
    name: string,
  ): ts.ParameterDeclaration | undefined =>
    owner.members
      .filter(api.isConstructorDeclaration)
      .flatMap((constructor) => [...constructor.parameters])
      .find((parameter) => isParameterProperty(parameter) && memberName(parameter.name) === name)

  const propertyNamed = (owner: ts.ClassLikeDeclaration, name: string): ts.PropertyDeclaration | undefined =>
    owner.members.filter(api.isPropertyDeclaration).find((property) => memberName(property.name) === name)

  const importedBinding = (local: string): MemberBinding | null => {
    const binding = get(local)
    if (binding === null || binding.kind !== "import") return null
    return { module: binding.module, imported: binding.imported }
  }

  const typeBinding = (type: ts.TypeNode | undefined): MemberBinding | null => {
    if (type === undefined || !api.isTypeReferenceNode(type) || !api.isIdentifier(type.typeName)) return null
    return importedBinding(type.typeName.text)
  }

  const isInjectFunction = (callee: ts.Node): boolean => {
    const identifier = ast.asIdentifier(callee)
    const bound = identifier === null ? null : importedBinding(identifier.text)
    return bound !== null && bound.module === INJECT_FUNCTION.module && bound.imported === INJECT_FUNCTION.imported
  }

  const injectBinding = (initializer: ts.Expression | undefined): MemberBinding | null => {
    const call = ast.asCallExpression(initializer)
    if (call === null || !isInjectFunction(call.expression)) return null
    const token = ast.asIdentifier(call.arguments[0])
    return token === null ? null : importedBinding(token.text)
  }

  const declarationBinding = (declaration: ts.ParameterDeclaration | ts.PropertyDeclaration): MemberBinding | null =>
    typeBinding(declaration.type) ?? injectBinding(declaration.initializer)

  const classMemberBinding = (owner: ts.ClassLikeDeclaration, name: string): MemberBinding | null => {
    const declaration = parameterPropertyNamed(owner, name) ?? propertyNamed(owner, name)
    return declaration === undefined ? null : declarationBinding(declaration)
  }

  const memberBinding = (expr: ts.Expression): MemberBinding | null => {
    const access = thisMemberOf(expr)
    const owner = access === null ? null : enclosingClass(access)
    if (access === null || owner === null) return null
    return classMemberBinding(owner, access.name.text)
  }

  return {
    get,
    moduleOf,
    rootsInModule,
    isHookResult,
    rootIdentifier,
    rootsIn,
    memberBinding,
    classMemberBinding,
    importedFiles: sortedUnique(importedFiles),
    importedModules: sortedUnique(importedModules),
    locals: sortedUnique(locals),
    lazyExports: collectLazyExports(),
  }
}
