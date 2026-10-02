import type ts from "typescript"
import { SCRIPT_GLOB } from "../core/extensions.js"
import type { PathTableSpec } from "../core/model.js"
import { EXCLUDED_FILE, NON_APP_PATH } from "../core/project.js"
import { convertReactRouterPath } from "../core/url.js"
import { LOOKUP_LIMITS } from "../extractors/navigation-lookup.js"
import type { Located, UnreadableItem } from "./array-values.js"
import { createArrayFolder, createValueResolver } from "./array-values.js"
import type { DiscoverContext, TsNode } from "./types.js"
import { createStringValueReader } from "./values.js"

export type RouteTable = {
  readonly paths: ReadonlyMap<string, readonly string[]>
  readonly unreadable: readonly UnreadableItem[]
}

export type LinkingTable = RouteTable & {
  readonly auto: boolean
}

type NamedPath = {
  readonly name: string
  readonly path: string
}

type Collected = {
  readonly entries: readonly NamedPath[]
  readonly unreadable: readonly UnreadableItem[]
}

type Owned = Collected & {
  readonly own: string | null
}

type Member = Located & {
  readonly name: string
}

type Members = {
  readonly members: readonly Member[]
  readonly unreadable: readonly UnreadableItem[]
}

type Strings = {
  readonly values: readonly string[]
  readonly unreadable: readonly UnreadableItem[]
}

const NAVIGATOR_FACTORY = /^create\w*Navigator$/

const SCREEN_FACTORY = /^create\w*Screen$/

const AUTO_LINKING = "auto"

const EMPTY: Collected = { entries: [], unreadable: [] }

const combine = (parts: readonly Collected[]): Collected => ({
  entries: parts.flatMap((part) => part.entries),
  unreadable: parts.flatMap((part) => part.unreadable),
})

const tableOf = ({ entries, unreadable }: Collected): RouteTable => {
  const paths = new Map<string, string[]>()
  for (const { name, path } of entries) {
    const known = paths.get(name) ?? []
    if (!known.includes(path) && known.length < LOOKUP_LIMITS.maxValues) paths.set(name, [...known, path])
  }
  return { paths, unreadable }
}

const toUrl = (raw: string): string => convertReactRouterPath(raw.startsWith("/") ? raw : `/${raw}`).url

const joinPath = (parent: string, child: string): string => (child === "" ? parent : `${parent}/${child}`)

export const kebabCaseName = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()

export const autoLinkingPaths = (
  names: readonly string[],
  explicit: ReadonlyMap<string, readonly string[]> = new Map(),
): ReadonlyMap<string, readonly string[]> =>
  new Map(names.filter((name) => !explicit.has(name)).map((name) => [name, [toUrl(kebabCaseName(name))]]))

const createReaders = (ctx: DiscoverContext) => {
  const resolver = createValueResolver(ctx)
  const folder = createArrayFolder(ctx, resolver)
  const stringValue = createStringValueReader(ctx)

  const unreadable = (node: TsNode, file: string): UnreadableItem => resolver.unreadableAt(node, file)

  const resolved = (node: TsNode, file: string, depth = 0): Located => {
    const inner = ctx.unwrap(node)
    const identifier = ctx.ast.asIdentifier(inner)
    const bound = identifier === null || depth >= LOOKUP_LIMITS.maxDepth ? null : resolver.valueOf(identifier, file)
    return bound === null ? { node: inner, file } : resolved(bound.node, bound.file, depth + 1)
  }

  const stringOf = (node: TsNode, file: string): string | null => {
    const flat = ctx.flattenString(node, file)
    if (flat !== null) return flat.dynamic ? null : flat.value
    const target = resolved(node, file)
    const literal = ctx.ast.asStringLiteralLike(target.node)
    return literal === null ? stringValue(node, file) : literal.text
  }

  const stringsOf = (node: TsNode, file: string, depth = 0): Strings => {
    const single = stringOf(node, file)
    if (single !== null) return { values: [single], unreadable: [] }
    const target = resolved(node, file)
    if (depth >= LOOKUP_LIMITS.maxDepth) return { values: [], unreadable: [unreadable(node, file)] }
    if (ctx.ts.isConditionalExpression(target.node))
      return combineStrings([
        stringsOf(target.node.whenTrue, target.file, depth + 1),
        stringsOf(target.node.whenFalse, target.file, depth + 1),
      ])
    if (ctx.ast.asArrayLiteral(target.node) === null) return { values: [], unreadable: [unreadable(node, file)] }
    const fold = folder(target.node, target.file)
    return combineStrings([
      { values: [], unreadable: fold.unreadable },
      ...fold.elements.map((element) => stringsOf(element.node, element.file, depth + 1)),
    ])
  }

  const objectOf = (node: TsNode, file: string): (Located & { readonly node: ts.ObjectLiteralExpression }) | null => {
    const target = resolved(node, file)
    const object = ctx.ast.asObjectLiteral(target.node)
    return object === null ? null : { node: object, file: target.file }
  }

  const propertyName = (name: ts.PropertyName, file: string): string | null => {
    if (ctx.ts.isComputedPropertyName(name)) return stringOf(name.expression, file)
    if (ctx.ts.isNumericLiteral(name)) return name.text
    return ctx.ast.asIdentifier(name)?.text ?? ctx.ast.asStringLiteralLike(name)?.text ?? null
  }

  const membersOf = (object: ts.ObjectLiteralExpression, file: string, depth = 0): Members => {
    const parts = object.properties.map((property): Members => {
      if (ctx.ts.isSpreadAssignment(property)) {
        const spread = depth < LOOKUP_LIMITS.maxDepth ? objectOf(property.expression, file) : null
        return spread === null
          ? { members: [], unreadable: [unreadable(property, file)] }
          : membersOf(spread.node, spread.file, depth + 1)
      }
      const name = property.name === undefined ? null : propertyName(property.name, file)
      if (name === null) return { members: [], unreadable: [unreadable(property, file)] }
      if (ctx.ts.isPropertyAssignment(property))
        return { members: [{ name, node: property.initializer, file }], unreadable: [] }
      if (ctx.ts.isShorthandPropertyAssignment(property))
        return { members: [{ name, node: property.name, file }], unreadable: [] }
      return { members: [], unreadable: [] }
    })
    return { members: parts.flatMap((part) => part.members), unreadable: parts.flatMap((part) => part.unreadable) }
  }

  const memberNamed = (members: readonly Member[], name: string): Member | null =>
    members.find((member) => member.name === name) ?? null

  return { resolved, stringOf, stringsOf, objectOf, membersOf, memberNamed, unreadable }
}

type Readers = ReturnType<typeof createReaders>

const combineStrings = (parts: readonly Strings[]): Strings => ({
  values: parts.flatMap((part) => part.values),
  unreadable: parts.flatMap((part) => part.unreadable),
})

const calleeName = (ctx: DiscoverContext, expression: TsNode): string | null => {
  const inner = ctx.unwrap(expression)
  return ctx.ast.asIdentifier(inner)?.text ?? ctx.ast.asPropertyAccess(inner)?.name.text ?? null
}

const sourceFiles = (ctx: DiscoverContext): readonly string[] =>
  ctx
    .glob(SCRIPT_GLOB)
    .filter((file) => !NON_APP_PATH.test(file) && !EXCLUDED_FILE.test(file) && !ctx.isGenerated(file))

const callsIn = (ctx: DiscoverContext, source: ts.SourceFile): readonly (ts.CallExpression | ts.NewExpression)[] => {
  const found: (ts.CallExpression | ts.NewExpression)[] = []
  const visit = (node: TsNode): void => {
    if (ctx.ts.isCallExpression(node) || ctx.ts.isNewExpression(node)) found.push(node)
    node.forEachChild(visit)
  }
  visit(source)
  return found
}

const readTable = (readers: Readers, argument: TsNode, file: string): Collected => {
  const object = readers.objectOf(argument, file)
  if (object === null) return { entries: [], unreadable: [readers.unreadable(argument, file)] }
  const { members, unreadable } = readers.membersOf(object.node, object.file)
  return combine([
    { entries: [], unreadable },
    ...members.map((member): Collected => {
      const strings = readers.stringsOf(member.node, member.file)
      return {
        entries: strings.values.map((value) => ({ name: member.name, path: toUrl(value) })),
        unreadable: strings.unreadable,
      }
    }),
  ])
}

const tablesInFile = (
  ctx: DiscoverContext,
  readers: Readers,
  file: string,
  specs: readonly PathTableSpec[],
): Collected => {
  const source = ctx.sourceFile(file)
  if (source === null) return EMPTY
  return combine(
    callsIn(ctx, source).flatMap((call) => {
      const name = calleeName(ctx, call.expression)
      return specs
        .filter((spec) => spec.callee === name)
        .flatMap((spec) => {
          const argument = call.arguments?.[spec.argument]
          return argument === undefined ? [] : [readTable(readers, argument, file)]
        })
    }),
  )
}

const mentionsCallee = (text: string | null, specs: readonly PathTableSpec[]): boolean =>
  text !== null && specs.some((spec) => text.includes(spec.callee))

export const readPathTables = (ctx: DiscoverContext, specs: readonly PathTableSpec[]): RouteTable => {
  if (specs.length === 0) return tableOf(EMPTY)
  const readers = createReaders(ctx)
  return tableOf(
    combine(
      sourceFiles(ctx)
        .filter((file) => mentionsCallee(ctx.readFile(file), specs))
        .map((file) => tablesInFile(ctx, readers, file, specs)),
    ),
  )
}

const isStringShaped = (ctx: DiscoverContext, node: TsNode): boolean =>
  ctx.ts.isTemplateExpression(node) || ctx.ts.isBinaryExpression(node) || ctx.ts.isConditionalExpression(node)

const factoryArgument = (
  ctx: DiscoverContext,
  readers: Readers,
  located: Located,
  factory: RegExp,
): Located | null => {
  const target = readers.resolved(located.node, located.file)
  const call = ctx.ast.asCallExpression(target.node)
  if (call === null) return null
  const name = calleeName(ctx, call.expression)
  const argument = call.arguments[0]
  if (name === null || !factory.test(name) || argument === undefined) return null
  return { node: argument, file: target.file }
}

const createLinkingReader = (ctx: DiscoverContext, readers: Readers, strict: boolean) => {
  const factoryOf = (located: Located, factory: RegExp): Located | null =>
    factoryArgument(ctx, readers, located, factory)

  const isExact = (members: readonly Member[]): boolean => {
    const exact = readers.memberNamed(members, "exact")
    return exact !== null && ctx.unwrap(exact.node).kind === ctx.ts.SyntaxKind.TrueKeyword
  }

  const pathEntry = (name: string, path: Member | null, parent: string, exact: boolean): Owned => {
    if (path === null) return { ...EMPTY, own: null }
    const value = readers.stringOf(path.node, path.file)
    if (value === null) return { entries: [], unreadable: [readers.unreadable(path.node, path.file)], own: null }
    const own = joinPath(exact ? "" : parent, value)
    return { entries: [{ name, path: toUrl(own) }], unreadable: [], own }
  }

  const pathObjectEntry = (name: string, members: readonly Member[], parent: string): Owned =>
    pathEntry(name, readers.memberNamed(members, "path"), parent, isExact(members))

  const readPathObject = (name: string, members: readonly Member[], parent: string): Collected => {
    const path = pathObjectEntry(name, members, parent)
    const screens = readers.memberNamed(members, "screens")
    return combine([path, screens === null ? EMPTY : readScreens(screens, path.own ?? parent)])
  }

  const readLinkingField = (name: string, linking: Member, parent: string): Owned => {
    const object = readers.objectOf(linking.node, linking.file)
    if (object === null) return pathEntry(name, linking, parent, false)
    const { members, unreadable } = readers.membersOf(object.node, object.file)
    const path = pathObjectEntry(name, members, parent)
    return { ...path, unreadable: [...unreadable, ...path.unreadable] }
  }

  const readStaticScreen = (name: string, members: readonly Member[], parent: string): Collected => {
    const linking = readers.memberNamed(members, "linking")
    const field = linking === null ? null : readLinkingField(name, linking, parent)
    const screen = readers.memberNamed(members, "screen")
    const nested = screen === null ? null : factoryOf(screen, NAVIGATOR_FACTORY)
    return combine([field ?? EMPTY, nested === null ? EMPTY : readContainer(nested, field?.own ?? parent)])
  }

  const readScreen = (member: Member, parent: string): Collected => {
    const nested = factoryOf(member, NAVIGATOR_FACTORY)
    if (nested !== null) return readContainer(nested, parent)
    const screenConfig = factoryOf(member, SCREEN_FACTORY)
    const object = readers.objectOf(screenConfig?.node ?? member.node, screenConfig?.file ?? member.file)
    if (object !== null) {
      const { members, unreadable } = readers.membersOf(object.node, object.file)
      const read =
        readers.memberNamed(members, "screen") === null
          ? readPathObject(member.name, members, parent)
          : readStaticScreen(member.name, members, parent)
      return combine([{ entries: [], unreadable }, read])
    }
    const value = readers.stringOf(member.node, member.file)
    if (value !== null) return { entries: [{ name: member.name, path: toUrl(joinPath(parent, value)) }], unreadable: [] }
    const target = readers.resolved(member.node, member.file)
    if (!strict && !isStringShaped(ctx, target.node)) return EMPTY
    return { entries: [], unreadable: [readers.unreadable(member.node, member.file)] }
  }

  const readScreens = (screens: Located, parent: string): Collected => {
    const object = readers.objectOf(screens.node, screens.file)
    if (object === null) return { entries: [], unreadable: [readers.unreadable(screens.node, screens.file)] }
    const { members, unreadable } = readers.membersOf(object.node, object.file)
    return combine([{ entries: [], unreadable }, ...members.map((member) => readScreen(member, parent))])
  }

  const readGroups = (groups: Located, parent: string): Collected => {
    const object = readers.objectOf(groups.node, groups.file)
    if (object === null) return { entries: [], unreadable: [readers.unreadable(groups.node, groups.file)] }
    const { members, unreadable } = readers.membersOf(object.node, object.file)
    return combine([{ entries: [], unreadable }, ...members.map((group) => readContainer(group, parent))])
  }

  const readContainer = (container: Located, parent: string): Collected => {
    const object = readers.objectOf(container.node, container.file)
    if (object === null) return { entries: [], unreadable: [readers.unreadable(container.node, container.file)] }
    const { members, unreadable } = readers.membersOf(object.node, object.file)
    const screens = readers.memberNamed(members, "screens")
    const groups = readers.memberNamed(members, "groups")
    return combine([
      { entries: [], unreadable },
      screens === null ? EMPTY : readScreens(screens, parent),
      groups === null ? EMPTY : readGroups(groups, parent),
    ])
  }

  return readContainer
}

const readRoot = (ctx: DiscoverContext, readers: Readers, root: Located): Collected & { readonly auto: boolean } => {
  const navigator = factoryArgument(ctx, readers, root, NAVIGATOR_FACTORY)
  if (navigator !== null) return { ...createLinkingReader(ctx, readers, false)(navigator, ""), auto: false }
  const object = readers.objectOf(root.node, root.file)
  if (object === null) return { entries: [], unreadable: [readers.unreadable(root.node, root.file)], auto: false }
  const { members, unreadable } = readers.membersOf(object.node, object.file)
  const enabled = readers.memberNamed(members, "enabled")
  const auto = enabled !== null && readers.stringOf(enabled.node, enabled.file) === AUTO_LINKING
  const config = readers.memberNamed(members, "config")
  const read = createLinkingReader(ctx, readers, true)(config ?? object, "")
  return { ...combine([{ entries: [], unreadable }, read]), auto }
}

export const readLinking = (ctx: DiscoverContext, file: string, node: TsNode): LinkingTable => {
  const { auto, ...collected } = readRoot(ctx, createReaders(ctx), { node, file })
  return { ...tableOf(collected), auto }
}
