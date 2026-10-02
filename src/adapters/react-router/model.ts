import type { AncestorRef, Evidence, RoutePrefixRule } from "../../core/model.js"
import { uniqueBy } from "../../core/order.js"
import type { RouteMode } from "../route-dialects.js"
import type { RouteFlavour } from "../route-flavours.js"
import type { EntryRef, ScreenDraft, TsNode } from "../types.js"
import { CHILDREN_SPLICE } from "./constants.js"
import type ts from "typescript"

export type ObjectMember = {
  readonly name: string
  readonly value: TsNode
  readonly node: TsNode
}

/**
 * The ONE intermediate route model. An object-literal route array and a JSX `<Routes>`/`<Route>` tree both
 * read into it, so every rule about paths, elements, wrappers and outlets lives in `parseRoute` once.
 */
export type RouteList =
  | {
      readonly kind: "array"
      readonly array: ts.ArrayLiteralExpression
      readonly file: string
      readonly anchor: TsNode
      readonly mode: RouteMode
      readonly bindings: Bindings
    }
  | {
      readonly kind: "unreadable"
      readonly file: string
      readonly anchor: TsNode
      readonly reason: string
    }
  | {
      readonly kind: "jsx"
      readonly nodes: readonly TsNode[]
      readonly file: string
      readonly anchor: TsNode
      readonly scope: ItemScope | null
      readonly flavour: RouteFlavour
    }

export type ParamBinding = {
  readonly scope: TsNode
  readonly name: string
  readonly value: TsNode
}

export type Bindings = readonly ParamBinding[]

export const NO_BINDINGS: Bindings = []

/**
 * The names a `.map` callback binds to ONE object of a literal route-data array: `null` is the whole
 * item (`(route) => …`), a string is the member a destructured name reads (`({ path }) => …`).
 */
export type ItemScope = {
  readonly names: ReadonlyMap<string, string | null>
  readonly item: ts.ObjectLiteralExpression
  readonly file: string
  readonly outer: ItemScope | null
  readonly gate: RuntimeGate | null
  /** A destructured member's default (`({ Fallback = Loading }) => …`), read where the item lacks the member. */
  readonly defaults: ReadonlyMap<string, ItemDefault>
}

export type ItemDefault = {
  readonly value: TsNode
  readonly file: string
}

/** A `.filter` or conditional over route data whose condition reads more than the item: registration is runtime. */
export type RuntimeGate = {
  readonly node: TsNode
  readonly file: string
}

/** `file` is where `value` is read: a member substituted out of a mapped item lives in the item's file. */
export type RouteValue = {
  readonly value: TsNode | undefined
  readonly node: TsNode
  readonly file: string
}

/** Something a route declares that is recorded as evidence and decides nothing (v5 `exact`). */
export type RouteNote = {
  readonly what: string
  readonly node: TsNode
  readonly file: string
}

export type RouteSpec = {
  readonly node: TsNode
  readonly what: string
  readonly path: RouteValue | null
  readonly isIndex: boolean
  readonly element: RouteValue | null
  readonly component: RouteValue | null
  readonly lazy: RouteValue | null
  readonly children: RouteList | null
  readonly scope: ItemScope | null
  /** A mapped `path` computed FROM the item (`\`/p/${page.slug}\``) rather than one member of it. */
  readonly derivedPath: boolean
  readonly mode: RouteMode
  readonly redirect: RouteValue | null
  /** The dialect's prefix rules this route is flagged with; `prefix` is the one this reading applies. */
  readonly prefixes: readonly RoutePrefixRule[]
  readonly prefix: RoutePrefixRule | null
  readonly flavour: RouteFlavour
  readonly notes: readonly RouteNote[]
  /** A root child with no path under a flavour without pathless routes: it matches every url below its list. */
  readonly catchAll: boolean
  /** A route matching by prefix (v5 without `exact`): the route lists its element renders nest under it. */
  readonly prefixMatch: boolean
}

export type RouteItem =
  | { readonly kind: "route"; readonly spec: RouteSpec; readonly file: string; readonly devOnly: boolean }
  | { readonly kind: "list"; readonly list: RouteList; readonly devOnly: boolean }
  | { readonly kind: "unreadable"; readonly node: TsNode; readonly file: string; readonly reason: string }

export type RouteRoot = {
  readonly file: string
  readonly node: TsNode
  readonly label: string
  readonly kind: "factory" | "hook" | "element"
  readonly list: RouteList | null
  /** What enclosing `<Router base>` elements prefix to every url in the list, relative (no leading slash). */
  readonly base: string | null
}

export type ComponentRef = {
  readonly file: string
  readonly exportName: string
}

export type RouteElement = ts.JsxElement | ts.JsxSelfClosingElement

/** `from` is the file whose bindings name `tag`; a tag substituted out of a mapped item binds there. */
export type TagUse = {
  readonly tag: string
  readonly element: ts.JsxOpeningLikeElement | null
  readonly from: string
}

export const layoutAncestor = (target: ComponentRef): AncestorRef => ({ ...target, splice: CHILDREN_SPLICE, role: "layout" })

/**
 * `per-item`: every guard in a mapped route's element is handed the `.map` item (`route={route}`), so
 * whether it guards is decided per item at runtime — this source cannot tell which items it protects.
 */
export type GuardAuth = "protected" | "per-item"

/**
 * A guard rule's `entryFrom` member of the mapped item, handed to the guard through `attribute` — the whole
 * item (`route={route}`) or that member itself. `value` is read in `file`, where the item is declared.
 */
export type PropEntry = {
  readonly element: ts.JsxOpeningLikeElement
  readonly tag: string
  readonly attribute: string
  readonly whole: boolean
  readonly value: TsNode
  readonly file: string
}

export type ElementInfo = {
  readonly redirectTo: string | null
  readonly routeName: string | null
  readonly auth: GuardAuth | null
  readonly itemGuard: ts.JsxOpeningLikeElement | null
  readonly featureFlag: string | null
  readonly title: string | null
  readonly wrappers: readonly AncestorRef[]
  readonly entries: readonly EntryRef[]
  readonly entryAncestors: readonly AncestorRef[]
  readonly propEntry: PropEntry | null
}

export const EMPTY_ELEMENT: ElementInfo = {
  redirectTo: null,
  routeName: null,
  auth: null,
  itemGuard: null,
  featureFlag: null,
  title: null,
  wrappers: [],
  entries: [],
  entryAncestors: [],
  propEntry: null,
}

/**
 * Route lists rendered side by side at one mount — sibling `<Routes>` in one component, or every
 * descendant list under one splat route — render TOGETHER at a shared url, so a url claimed by two of
 * them is one screen whose entries are merged, not two screens.
 */
export type MergeScope = Map<string, { readonly index: number; readonly root: RouteRoot }>

export type RouteContext = {
  readonly file: string
  readonly url: string | null
  readonly lineage: readonly Evidence[]
  readonly auth: "protected" | "public" | null
  readonly featureFlag: string | null
  readonly title: string | null
  readonly devOnly: boolean
  readonly ancestors: readonly AncestorRef[]
  readonly merge: MergeScope | null
  readonly root: RouteRoot | null
  /** Items of a descendant list: under a flavour whose splats nest (v6 `<Routes>`) they match the remaining pathname, so `/x` is relative. */
  readonly descendantList?: boolean
}

/** `guards` is what the wrappers enclosing THIS mount decide — never the element's other branches. */
export type Descendant = {
  readonly root: RouteRoot
  readonly mount: readonly AncestorRef[]
  readonly guards: ElementInfo
}

export const entryKey = (ref: EntryRef): string =>
  ref.kind === "file"
    ? `file|${ref.file}|${ref.exportName}`
    : ref.kind === "binding"
      ? `binding|${ref.from}|${ref.local}`
      : ref.kind === "module"
        ? `module|${ref.from}|${ref.spec}|${ref.exported ?? ""}`
        : `opaque|${ref.file}|${ref.expr}`

/** `inner` wins every scalar — a lazy route's resolved element overrides the static one. */
export const mergeInfo = (outer: ElementInfo, inner: ElementInfo): ElementInfo => ({
  redirectTo: inner.redirectTo ?? outer.redirectTo,
  routeName: inner.routeName ?? outer.routeName,
  auth: inner.auth ?? outer.auth,
  itemGuard: inner.itemGuard ?? outer.itemGuard,
  featureFlag: inner.featureFlag ?? outer.featureFlag,
  title: inner.title ?? outer.title,
  wrappers: [...outer.wrappers, ...inner.wrappers],
  entries: uniqueBy([...inner.entries, ...outer.entries], entryKey),
  entryAncestors: [...outer.entryAncestors, ...inner.entryAncestors],
  propEntry: inner.propEntry ?? outer.propEntry,
})

export const ancestorKey = (ref: AncestorRef): string => `${ref.file}|${ref.exportName}|${ref.role}|${ref.splice.kind}`

export type Discovery = {
  readonly drafts: readonly ScreenDraft[]
  readonly ancestors: ReadonlyMap<string, readonly AncestorRef[]>
}
